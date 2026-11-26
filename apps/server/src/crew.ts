import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  deriveThreadState,
  type AgentStatus, type Ctx, type Issue, type IssueComment, type IssueState, type PullRequest,
  type Registry, type Thread, type ThreadRole, type Tool, type ToolCtx, type TurnOutcome,
} from '@extendo/contracts';
import type { AgentRuntime, SystemSection } from '@extendo/agent';
import { projectMessages, type SessionStore } from '@extendo/session';
import type { GitService } from '@extendo/git';
import type { ThreadRow, WorkspaceState } from './state.js';

export const DEFAULT_MAX_CREW = 4;
export const MAX_WAIT_MS = 120_000;

/** A worker's turn that ended, as the captain's log records it. */
export interface CrewWake {
  workerId: string;
  workerSessionId: string;
  title: string;
  turnId: string;
  outcome: TurnOutcome;
  report: string;
}

export interface CrewWaitResult {
  threadId: string;
  title: string;
  status: AgentStatus;
  outcome?: TurnOutcome;
  report?: string;
  timedOut: boolean;
}

export interface CrewOptions {
  ctx: Ctx;
  workspace: WorkspaceState;
  sessions: SessionStore;
  agent: AgentRuntime;
  git: GitService;
  pullRequests?: { read(input: { cwd: string; branch: string }): Promise<PullRequest | undefined> };
  maxCrew?: number;
}

interface Waiter {
  resolve: (result: CrewWaitResult) => void;
}

const slug = (text: string) => text.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 40).toLowerCase() || 'worker';

function reportOf(events: ReturnType<SessionStore['replay']>): string | undefined {
  const messages = projectMessages(events);
  const last = messages.findLast((message) => message.role === 'assistant');
  return last?.role === 'assistant' ? last.content.trim() || undefined : undefined;
}

function lastTurnEnd(events: ReturnType<SessionStore['replay']>) {
  return events.findLast((event) => event.type === 'turn/end');
}

function wakesIn(events: ReturnType<SessionStore['replay']>) {
  return events.filter((event) => event.type === 'crew/wake');
}

/**
 * The crew's durable spine. A worker's turn end is written to the captain's own log as a
 * `crew/wake` event, so a completion survives a process restart: on boot the service reads every
 * worker's last turn end and appends the wake the captain's log is missing. Nothing here wakes a
 * captain twice: the wake's workerId and turnId are the idempotency key.
 */
export class CrewService {
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly maxCrew: number;
  private closed = false;
  private readonly ready: Promise<void>;

  constructor(private readonly options: CrewOptions) {
    this.maxCrew = options.maxCrew ?? DEFAULT_MAX_CREW;
    options.ctx.on('session/event', ({ sessionId, event }) => {
      if (event.type === 'turn/end' && !this.closed) void this.afterTurn(sessionId, event);
    });
    this.ready = this.reconcile();
  }

  /** Waits for the boot reconciliation so a restart's pending wakes land before the server serves. */
  async whenReady(): Promise<void> {
    await this.ready;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const set of this.waiters.values()) {
      for (const waiter of set) {
        waiter.resolve({ threadId: '', title: '', status: 'idle', timedOut: true });
      }
    }
    this.waiters.clear();
  }

  /** The captain row behind a tool call's session, or a clear refusal. */
  captainFor(sessionId: string): ThreadRow {
    const row = this.options.workspace.threadBySession(sessionId);
    if (!row || row.role !== 'captain') throw new Error('This tool is only available to a captain');
    return row;
  }

  async create(captain: ThreadRow, input: { title: string; brief: string; base?: string }): Promise<CrewMemberSummary> {
    const workers = this.options.workspace.workersOf(captain.id).filter((worker) => !worker.archived);
    if (workers.length >= this.maxCrew) {
      throw new Error(`Crew cap reached: ${this.maxCrew} concurrent workers. Archive a worker or wait for one to finish before starting another.`);
    }
    const project = this.options.workspace.project(captain.projectId);
    if (!project) throw new Error('The captain has no project to start a worker in');
    const worktree = await this.options.git.createWorktree(project.path, { title: input.title, base: input.base ?? captain.branch ?? undefined });
    const row = this.options.workspace.createThread(this.options.sessions, project, {
      title: input.title,
      provider: captain.provider,
      model: captain.model,
      branch: worktree.branch,
      role: 'worker',
      captainId: captain.id,
    });
    this.options.workspace.setThreadCheckout(row.sessionId, { cwd: worktree.path, branch: worktree.branch, worktree: worktree.path });
    this.options.sessions.move(row.sessionId, worktree.path);
    const handle = this.options.agent.start(row.sessionId, input.brief, {
      provider: row.provider,
      model: row.model,
      interactive: false,
      approve: (call, context) => withinWorktree(call, context),
    });
    void handle.done.catch((error) => this.options.ctx.logger.warn(`worker ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`));
    return this.summary(row);
  }

  async list(captain: ThreadRow): Promise<CrewMemberSummary[]> {
    const workers = this.options.workspace.workersOf(captain.id).filter((worker) => !worker.archived);
    return Promise.all(workers.map((worker) => this.summary(worker)));
  }

  async read(captain: ThreadRow, workerId: string, transcript = false): Promise<Record<string, unknown>> {
    const worker = this.worker(captain, workerId);
    const events = this.options.sessions.replay(worker.sessionId);
    const messages = projectMessages(events);
    const summary = await this.summary(worker);
    return {
      ...summary,
      report: summary.report,
      ...(transcript ? { transcript: messages } : {}),
    };
  }

  async message(captain: ThreadRow, workerId: string, text: string): Promise<Record<string, unknown>> {
    const worker = this.worker(captain, workerId);
    const status = this.options.agent.status(worker.sessionId);
    if (status === 'working' || status === 'waiting') {
      this.options.agent.steer(worker.sessionId, text);
      return { threadId: worker.id, delivered: 'steer' };
    }
    const handle = this.options.agent.start(worker.sessionId, text, {
      provider: worker.provider,
      model: worker.model,
      interactive: false,
      approve: (call, context) => withinWorktree(call, context),
    });
    void handle.done.catch((error) => this.options.ctx.logger.warn(`worker ${worker.id} failed: ${error instanceof Error ? error.message : String(error)}`));
    return { threadId: worker.id, delivered: 'turn' };
  }

  async archive(captain: ThreadRow, workerId: string): Promise<Record<string, unknown>> {
    const worker = this.worker(captain, workerId);
    this.options.agent.cancel(worker.sessionId);
    this.options.workspace.setThreadArchived(worker.id, true);
    return { threadId: worker.id, archived: true };
  }

  async wait(captain: ThreadRow, threadIds: string[], timeoutMs: number, signal: AbortSignal): Promise<CrewWaitResult[]> {
    const workers = threadIds.map((id) => this.worker(captain, id));
    const pending = workers.filter((worker) => this.options.agent.status(worker.sessionId) === 'working' || this.options.agent.status(worker.sessionId) === 'waiting');
    if (!pending.length) return Promise.all(workers.map((worker) => this.result(worker, false)));
    const finished = new Promise<CrewWaitResult[]>((resolve) => {
      let remaining = pending.length;
      const results: CrewWaitResult[] = [];
      const done = (result: CrewWaitResult) => {
        results.push(result);
        remaining -= 1;
        if (remaining === 0) resolve(results);
      };
      for (const worker of pending) {
        const set = this.waiters.get(worker.id) ?? new Set<Waiter>();
        set.add({ resolve: done });
        this.waiters.set(worker.id, set);
      }
    });
    const timer = delay(timeoutMs).then(() => 'timeout' as const);
    const signalAbort = new Promise<'timeout'>((resolve) => {
      signal.addEventListener('abort', () => resolve('timeout'), { once: true });
    });
    const outcome = await Promise.race([finished, timer, signalAbort]);
    if (Array.isArray(outcome)) return outcome;
    return Promise.all(workers.map((worker) => this.result(worker, true)));
  }

  async issues(captain: ThreadRow): Promise<Issue[]> {
    return this.options.workspace.issues({ captainId: captain.id });
  }

  async createIssue(captain: ThreadRow, input: { title: string; body?: string; state?: IssueState; assigneeId?: string; parentId?: string }): Promise<Issue> {
    const project = this.options.workspace.project(captain.projectId);
    if (!project) throw new Error('The captain has no project to file an issue in');
    return this.options.workspace.createIssue(project, { ...input, captainId: captain.id });
  }

  async updateIssue(captain: ThreadRow, id: string, patch: { title?: string; body?: string; state?: IssueState; assigneeId?: string | null; parentId?: string | null }): Promise<Issue> {
    const issue = this.options.workspace.issue(id);
    if (!issue || issue.captainId !== captain.id) throw new Error(`Unknown issue ${id}`);
    const updated = this.options.workspace.updateIssue(id, patch);
    if (!updated) throw new Error(`Unknown issue ${id}`);
    return updated;
  }

  async readIssue(captain: ThreadRow, id: string): Promise<Record<string, unknown>> {
    const issue = this.options.workspace.issue(id);
    if (!issue || issue.captainId !== captain.id) throw new Error(`Unknown issue ${id}`);
    return { ...issue, comments: this.options.workspace.issueComments(id) };
  }

  async commentIssue(captain: ThreadRow, id: string, body: string): Promise<IssueComment> {
    const issue = this.options.workspace.issue(id);
    if (!issue || issue.captainId !== captain.id) throw new Error(`Unknown issue ${id}`);
    return this.options.workspace.addIssueComment(id, captain.id, body);
  }

  private worker(captain: ThreadRow, workerId: string): ThreadRow {
    const worker = this.options.workspace.thread(workerId);
    if (!worker || worker.captainId !== captain.id) throw new Error(`Unknown worker ${workerId} for this captain`);
    return worker;
  }

  private async summary(worker: ThreadRow): Promise<CrewMemberSummary> {
    const events = this.options.sessions.replay(worker.sessionId);
    const state = deriveThreadState({ events }).state;
    const pullRequest = worker.branch && this.options.pullRequests
      ? await this.options.pullRequests.read({ cwd: worker.cwd, branch: worker.branch }).catch(() => undefined)
      : undefined;
    const openIssue = this.options.workspace.issues({ assigneeId: worker.id }).find((issue) => issue.state !== 'done' && issue.state !== 'canceled');
    return {
      threadId: worker.id,
      sessionId: worker.sessionId,
      title: worker.title,
      role: worker.role ?? 'worker',
      status: this.options.agent.status(worker.sessionId),
      state,
      branch: worker.branch,
      worktree: worker.worktree,
      report: worker.report,
      reportAt: worker.reportAt,
      pullRequest,
      issueId: openIssue?.id,
      archived: worker.archived,
    };
  }

  private async result(worker: ThreadRow, timedOut: boolean): Promise<CrewWaitResult> {
    const events = this.options.sessions.replay(worker.sessionId);
    const end = lastTurnEnd(events);
    return {
      threadId: worker.id,
      title: worker.title,
      status: this.options.agent.status(worker.sessionId),
      outcome: end?.type === 'turn/end' ? end.data.outcome : undefined,
      report: reportOf(events),
      timedOut,
    };
  }

  private async afterTurn(sessionId: string, event: { type: 'turn/end'; data: { turnId: string; outcome: TurnOutcome }; ts: string; seq: number }): Promise<void> {
    try {
      await this.recordTurnEnd(sessionId, event);
    } catch (error) {
      if (!this.closed) this.options.ctx.logger.warn(`crew could not record ${sessionId}'s turn end: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async recordTurnEnd(sessionId: string, event: { type: 'turn/end'; data: { turnId: string; outcome: TurnOutcome }; ts: string; seq: number }): Promise<void> {
    if (this.closed) return;
    const row = this.options.workspace.threadBySession(sessionId);
    if (!row) return;
    if (row.role === 'worker') {
      await this.workerTurnEnd(row, event);
      return;
    }
    if (row.role === 'captain') {
      this.deliverWakes(row);
      return;
    }
    const waiters = this.waiters.get(row.id);
    if (waiters) {
      this.waiters.delete(row.id);
      for (const waiter of waiters) void waiter.resolve(await this.result(row, false));
    }
  }

  private async workerTurnEnd(worker: ThreadRow, event: { type: 'turn/end'; data: { turnId: string; outcome: TurnOutcome }; ts: string; seq: number }): Promise<void> {
    const events = this.options.sessions.replay(worker.sessionId);
    const report = reportOf(events);
    this.options.workspace.setThreadReport(worker.sessionId, report, event.ts);
    if (event.data.outcome === 'completed' && worker.worktree) {
      await this.options.git.commitAll(worker.worktree, `crew: ${worker.title}`).catch((error) => {
        this.options.ctx.logger.warn(`worker ${worker.id} could not commit its worktree: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (this.closed) return;
    const captain = worker.captainId ? this.options.workspace.thread(worker.captainId) : undefined;
    if (!captain || captain.role !== 'captain') return;
    const captainEvents = this.options.sessions.replay(captain.sessionId);
    const already = wakesIn(captainEvents).some((wake) => wake.type === 'crew/wake' && wake.data.workerId === worker.id && wake.data.turnId === event.data.turnId);
    if (!already) {
      this.options.sessions.append(captain.sessionId, {
        type: 'crew/wake',
        data: {
          workerId: worker.id,
          workerSessionId: worker.sessionId,
          title: worker.title,
          turnId: event.data.turnId,
          outcome: event.data.outcome,
          report: report ?? '',
        },
      });
    }
    this.deliverWakes(captain);
    const waiters = this.waiters.get(worker.id);
    if (waiters) {
      this.waiters.delete(worker.id);
      for (const waiter of waiters) void waiter.resolve(await this.result(worker, false));
    }
  }

  private deliverWakes(captain: ThreadRow): void {
    if (this.closed) return;
    const status = this.options.agent.status(captain.sessionId);
    if (status === 'working' || status === 'waiting') return;
    const events = this.options.sessions.replay(captain.sessionId);
    const boundary = lastTurnEnd(events);
    const pending = wakesIn(events).filter((wake) => !boundary || wake.seq > boundary.seq);
    if (!pending.length) return;
    const handle = this.options.agent.start(captain.sessionId, 'A worker finished. Read its report and decide what happens next.', {
      provider: captain.provider,
      model: captain.model,
      interactive: false,
    });
    void handle.done.catch((error) => this.options.ctx.logger.warn(`captain ${captain.id} failed to wake: ${error instanceof Error ? error.message : String(error)}`));
  }

  /**
   * Reads every worker's last turn end and appends the wake a captain's log is missing. This is the
   * restart path: a completion that happened before the process died still wakes the captain, once.
   */
  private async reconcile(): Promise<void> {
    const workers = this.options.workspace.threads().filter((row) => row.role === 'worker' && !row.archived);
    for (const worker of workers) {
      const events = this.options.sessions.replay(worker.sessionId);
      const end = lastTurnEnd(events);
      if (!end || end.type !== 'turn/end') continue;
      const report = reportOf(events);
      if (report) this.options.workspace.setThreadReport(worker.sessionId, report, end.ts);
      const captain = worker.captainId ? this.options.workspace.thread(worker.captainId) : undefined;
      if (!captain || captain.role !== 'captain') continue;
      const captainEvents = this.options.sessions.replay(captain.sessionId);
      const already = wakesIn(captainEvents).some((wake) => wake.type === 'crew/wake' && wake.data.workerId === worker.id && wake.data.turnId === end.data.turnId);
      if (!already) {
        this.options.sessions.append(captain.sessionId, {
          type: 'crew/wake',
          data: {
            workerId: worker.id,
            workerSessionId: worker.sessionId,
            title: worker.title,
            turnId: end.data.turnId,
            outcome: end.data.outcome,
            report: report ?? '',
          },
        });
      }
    }
    for (const captain of this.options.workspace.threads().filter((row) => row.role === 'captain' && !row.archived)) {
      this.deliverWakes(captain);
    }
  }
}

export interface CrewMemberSummary {
  threadId: string;
  sessionId: string;
  title: string;
  role: ThreadRole;
  status: AgentStatus;
  state: Thread['state'];
  branch?: string;
  worktree?: string;
  report?: string;
  reportAt?: string;
  pullRequest?: PullRequest;
  issueId?: string;
  archived?: boolean;
}

/** A worker's write is approved only when its path stays inside the worker's own worktree. */
function withinWorktree(call: { name: string; input: unknown }, context: ToolCtx): boolean {
  const write = new Set(['demo_write', 'demo_edit', 'write', 'edit', 'apply_patch', 'str_replace_editor']);
  if (!write.has(call.name)) return false;
  const input = call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : {};
  const paths = [input.path, input.file, input.file_path].filter((value): value is string => typeof value === 'string');
  if (!paths.length) return false;
  const root = context.cwd.endsWith('/') ? context.cwd : `${context.cwd}/`;
  return paths.every((path) => {
    if (path.startsWith('/') || path.includes('..')) return false;
    return `${root}${path}`.startsWith(root);
  });
}

export function crewTools(crew: CrewService): Tool[] {
  const captain = (ctx: ToolCtx): ThreadRow => crew.captainFor(ctx.sessionId);
  const createInput = z.object({ title: z.string().min(1).max(240), brief: z.string().min(1).max(20_000), base: z.string().min(1).max(240).optional() });
  const readInput = z.object({ threadId: z.string().min(1).max(128), transcript: z.boolean().optional() });
  const messageInput = z.object({ threadId: z.string().min(1).max(128), text: z.string().min(1).max(20_000) });
  const waitInput = z.object({ threadIds: z.array(z.string().min(1).max(128)).min(1).max(20), timeoutMs: z.number().int().min(1).max(MAX_WAIT_MS).optional() });
  const archiveInput = z.object({ threadId: z.string().min(1).max(128) });
  const issueCreateInput = z.object({
    title: z.string().min(1).max(240),
    body: z.string().max(20_000).optional(),
    state: z.enum(['open', 'in-progress', 'needs-you', 'in-review', 'done', 'canceled']).optional(),
    assigneeId: z.string().min(1).max(128).optional(),
    parentId: z.string().min(1).max(128).optional(),
  });
  const issueUpdateInput = z.object({
    id: z.string().min(1).max(128),
    title: z.string().min(1).max(240).optional(),
    body: z.string().max(20_000).optional(),
    state: z.enum(['open', 'in-progress', 'needs-you', 'in-review', 'done', 'canceled']).optional(),
    assigneeId: z.string().min(1).max(128).nullable().optional(),
    parentId: z.string().min(1).max(128).nullable().optional(),
  });
  const issueReadInput = z.object({ id: z.string().min(1).max(128) });
  const issueCommentInput = z.object({ id: z.string().min(1).max(128), body: z.string().min(1).max(20_000) });

  return [
    {
      name: 'crew.create',
      description: 'Start a worker thread in its own git worktree and branch. The worker runs the brief you give it and reports back when its turn ends.',
      readOnly: false,
      input: createInput,
      async execute(input, ctx) {
        const row = await crew.create(captain(ctx), input as z.infer<typeof createInput>);
        return row as unknown as Record<string, unknown>;
      },
    },
    {
      name: 'crew.list',
      description: 'List your crew: each worker’s title, status, branch, worktree, last report, and open pull request.',
      readOnly: true,
      input: z.object({}),
      async execute(_input, ctx) {
        return { crew: await crew.list(captain(ctx)) } as unknown as Record<string, unknown>;
      },
    },
    {
      name: 'crew.read',
      description: 'Read one worker’s latest report, or its whole transcript when transcript is true.',
      readOnly: true,
      input: readInput,
      async execute(input, ctx) {
        const value = input as z.infer<typeof readInput>;
        return crew.read(captain(ctx), value.threadId, value.transcript);
      },
    },
    {
      name: 'crew.message',
      description: 'Send a worker a correction or a new brief. A worker that is running receives it as a steer; an idle worker starts a new turn.',
      readOnly: false,
      input: messageInput,
      async execute(input, ctx) {
        const value = input as z.infer<typeof messageInput>;
        return crew.message(captain(ctx), value.threadId, value.text);
      },
    },
    {
      name: 'crew.wait',
      description: 'Wait until the named workers finish or the timeout passes. Use this instead of polling.',
      readOnly: true,
      input: waitInput,
      async execute(input, ctx) {
        const value = input as z.infer<typeof waitInput>;
        return { workers: await crew.wait(captain(ctx), value.threadIds, value.timeoutMs ?? 60_000, ctx.signal) } as unknown as Record<string, unknown>;
      },
    },
    {
      name: 'crew.archive',
      description: 'Archive a worker and cancel its turn. The worker’s branch and worktree stay on disk.',
      readOnly: false,
      input: archiveInput,
      async execute(input, ctx) {
        const value = input as z.infer<typeof archiveInput>;
        return crew.archive(captain(ctx), value.threadId);
      },
    },
    {
      name: 'issue.create',
      description: 'File an issue in your project. Use it when work outlives this turn or needs a person’s decision.',
      readOnly: false,
      input: issueCreateInput,
      async execute(input, ctx) {
        return crew.createIssue(captain(ctx), input as z.infer<typeof issueCreateInput>) as unknown as Record<string, unknown>;
      },
    },
    {
      name: 'issue.update',
      description: 'Change an issue’s title, body, state, assignee, or parent.',
      readOnly: false,
      input: issueUpdateInput,
      async execute(input, ctx) {
        const { id, ...patch } = input as z.infer<typeof issueUpdateInput>;
        return crew.updateIssue(captain(ctx), id, patch) as unknown as Record<string, unknown>;
      },
    },
    {
      name: 'issue.read',
      description: 'Read one issue with its comments.',
      readOnly: true,
      input: issueReadInput,
      async execute(input, ctx) {
        return crew.readIssue(captain(ctx), (input as z.infer<typeof issueReadInput>).id);
      },
    },
    {
      name: 'issue.comment',
      description: 'Add a comment to an issue. The comment is authored by the captain thread.',
      readOnly: false,
      input: issueCommentInput,
      async execute(input, ctx) {
        const value = input as z.infer<typeof issueCommentInput>;
        return crew.commentIssue(captain(ctx), value.id, value.body) as unknown as Record<string, unknown>;
      },
    },
  ];
}

export const captainInstructions = `You are a captain. You direct a crew of workers, each in its own git worktree and branch.

- Delegate work to a worker with crew.create. Give it a title and a complete brief; it starts immediately.
- Use crew.wait to block until a worker finishes. Never poll crew.list in a loop.
- Read a worker's report with crew.read. Only ask for its transcript when the report is not enough.
- Send a correction or a new brief with crew.message. Do not send a worker a message just to say you are waiting.
- File an issue when work outlives this turn or needs a person's decision. Move it through its states as the work moves.
- When you report to the person, say what changed: what a worker shipped, what failed, and what needs them. One short paragraph, not a status table.
- A worker completing wakes you once. If you already have its report, do not ask for it again.`;

export const workerInstructions = `You are a worker on a captain's crew. You own one git worktree and one branch. Make the change in your worktree, verify it, and report what you actually did and what you could not verify. Your turn's final message is your report to the captain.`;

export function crewPlugin(options: { git: GitService; maxCrew?: number }) {
  return {
    name: 'crew',
    async apply(ctx: Ctx) {
      const workspace = ctx.get<WorkspaceState>('workspace');
      const sessions = ctx.get<SessionStore>('sessions');
      const agent = ctx.get<AgentRuntime>('agent');
      const pullRequests = ctx.has('pullRequests') ? ctx.get<CrewOptions['pullRequests']>('pullRequests') : undefined;
      const crew = new CrewService({ ctx, workspace, sessions, agent, git: options.git, pullRequests, maxCrew: options.maxCrew });
      ctx.provide('crew', crew);
      const registry = ctx.get<Registry<Tool>>('tools');
      for (const tool of crewTools(crew)) registry.register(ctx, tool.name, tool);
      ctx.get<Registry<SystemSection>>('system').register(ctx, 'crew', {
        name: 'crew',
        text: ({ session }) => {
          const role = workspace.threadBySession(session.id)?.role;
          return role === 'captain' ? captainInstructions : role === 'worker' ? workerInstructions : '';
        },
      });
      ctx.effect(() => () => { void crew.close(); });
    },
  };
}
