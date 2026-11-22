import { randomUUID } from 'node:crypto';
import type { AgentRuntime, TurnResult } from '@extendo/agent';
import type {
  ApprovalRequest, Ctx, JsonValue, Plugin, Registry, SessionEvent,
  Subagent, SubagentActivity, SubagentState, SwarmPlan, Tool, ToolCtx,
} from '@extendo/contracts';
import type { SessionStore } from '@extendo/session';
import { z } from 'zod';

export const DEFAULT_CONCURRENCY = 8;

export interface DelegateInput {
  parentSessionId: string;
  parentTurnId: string;
  cwd: string;
  provider: string;
  model: string;
  interactive: boolean;
  plan: SwarmPlan;
}

export interface DelegateResult {
  subagents: { id: string; title: string; sessionId: string }[];
  queued: number;
}

export interface SwarmRuntime {
  delegate(input: DelegateInput): DelegateResult;
  steer(parentSessionId: string, subagentId: string, input: string): boolean;
  stop(parentSessionId: string, subagentId: string): boolean;
  cancel(parentSessionId: string): number;
  list(parentSessionId: string): Subagent[];
  shutdown(): Promise<void>;
}

interface Run {
  id: string;
  parentSessionId: string;
  parentTurnId: string;
  childSessionId: string;
  title: string;
  role?: string;
  prompt: string;
  cwd: string;
  provider: string;
  model: string;
  interactive: boolean;
  state: SubagentState;
  activity: SubagentActivity[];
}

const readTools = new Set(['read', 'glob', 'grep', 'web_fetch', 'search']);
const patchTools = new Set(['edit', 'write', 'patch']);
const runTools = new Set(['shell', 'run', 'check', 'test']);

function text(value: JsonValue | undefined, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const found = (value as Record<string, JsonValue>)[key];
  return typeof found === 'string' ? found : undefined;
}

function number(value: JsonValue | undefined, key: string): number | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const found = (value as Record<string, JsonValue>)[key];
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined;
}

function shortName(name: string): string {
  return name.split(/[.:]/).at(-1) ?? name;
}

/** Turns a tool call into the one line an operator reads in the swarm view. */
export function describeCall(name: string, input: JsonValue, output?: JsonValue): Pick<SubagentActivity, 'kind' | 'label' | 'detail'> {
  const tool = shortName(name).replace(/^demo_/, '').replace(/[-_]/g, '').toLowerCase();
  const path = text(input, 'path') ?? text(input, 'file_path') ?? text(input, 'filePath');
  const command = text(input, 'command');
  const query = text(input, 'query') ?? text(input, 'pattern');
  if (tool === 'search') return { kind: 'search', label: `search “${query ?? 'workspace'}”` };
  if (readTools.has(tool)) return { kind: 'read', label: `read ${path ?? query ?? 'workspace'}` };
  if (patchTools.has(tool)) {
    const additions = number(output, 'additions');
    const deletions = number(output, 'deletions');
    return {
      kind: 'patch',
      label: `patch ${path ?? 'file'}`,
      detail: additions !== undefined && deletions !== undefined ? `+${additions} −${deletions}` : undefined,
    };
  }
  if (runTools.has(tool)) {
    const exit = number(output, 'exitCode');
    return { kind: 'run', label: `run ${command ?? 'command'}`, detail: exit === undefined ? undefined : exit === 0 ? 'exit 0' : `exit ${exit}` };
  }
  if (tool === 'delegate') return { kind: 'note', label: 'delegate plan' };
  return { kind: 'tool', label: `${shortName(name)}${path ? ` ${path}` : ''}` };
}

/** The summary line a finished call adds to its activity, such as a diff stat or an exit code. */
export function describeResult(name: string, output: JsonValue): string | undefined {
  const tool = shortName(name).replace(/^demo_/, '').replace(/[-_]/g, '').toLowerCase();
  if (patchTools.has(tool)) {
    const additions = number(output, 'additions');
    const deletions = number(output, 'deletions');
    if (additions !== undefined && deletions !== undefined) return `+${additions} −${deletions}`;
  }
  if (runTools.has(tool)) {
    const exit = number(output, 'exitCode');
    if (exit !== undefined) return exit === 0 ? 'exit 0' : `exit ${exit}`;
  }
  return undefined;
}

class Swarm implements SwarmRuntime {
  private readonly runs = new Map<string, Run>();
  private readonly byChild = new Map<string, string>();
  private readonly queues = new Map<string, string[]>();
  private readonly limits = new Map<string, number>();
  private readonly running = new Map<string, number>();
  private readonly handles = new Set<Promise<unknown>>();
  private closed = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly agent: AgentRuntime,
    private readonly sessions: SessionStore,
  ) {}

  delegate(input: DelegateInput): DelegateResult {
    const plan = input.plan;
    const limit = Math.max(1, Math.min(plan.concurrency ?? DEFAULT_CONCURRENCY, 16));
    this.limits.set(input.parentSessionId, limit);
    const queue = this.queues.get(input.parentSessionId) ?? [];
    const spawned: DelegateResult['subagents'] = [];
    for (const task of plan.tasks) {
      const session = this.sessions.create({ title: task.title, cwd: input.cwd });
      const id = randomUUID();
      const run: Run = {
        id, parentSessionId: input.parentSessionId, parentTurnId: input.parentTurnId,
        childSessionId: session.id, title: task.title, role: task.role, prompt: task.prompt,
        cwd: input.cwd, provider: input.provider, model: input.model, interactive: input.interactive,
        state: 'queued', activity: [],
      };
      this.runs.set(id, run);
      this.byChild.set(session.id, id);
      queue.push(id);
      this.append(input.parentSessionId, {
        type: 'subagent/spawned',
        data: { subagentId: id, title: task.title, role: task.role, sessionId: session.id, parentTurnId: input.parentTurnId },
      });
      spawned.push({ id, title: task.title, sessionId: session.id });
    }
    this.queues.set(input.parentSessionId, queue);
    this.pump(input.parentSessionId);
    return { subagents: spawned, queued: queue.length };
  }

  steer(parentSessionId: string, subagentId: string, input: string): boolean {
    const run = this.runs.get(subagentId);
    if (!run || run.parentSessionId !== parentSessionId) return false;
    if (run.state !== 'running' && run.state !== 'waiting-approval') return false;
    if (!this.agent.steer(run.childSessionId, input)) return false;
    this.append(parentSessionId, { type: 'subagent/steered', data: { subagentId, message: input } });
    return true;
  }

  stop(parentSessionId: string, subagentId: string): boolean {
    const run = this.runs.get(subagentId);
    if (!run || run.parentSessionId !== parentSessionId) return false;
    if (run.state === 'queued') {
      const queue = this.queues.get(parentSessionId) ?? [];
      const index = queue.indexOf(subagentId);
      if (index !== -1) queue.splice(index, 1);
      run.state = 'stopped';
      this.append(parentSessionId, { type: 'subagent/report', data: { subagentId, outcome: 'stopped', report: 'Stopped before starting.' } });
      return true;
    }
    if (run.state !== 'running') return false;
    this.agent.cancel(run.childSessionId);
    return true;
  }

  cancel(parentSessionId: string): number {
    let stopped = 0;
    for (const run of this.runs.values()) {
      if (run.parentSessionId !== parentSessionId) continue;
      if (this.stop(parentSessionId, run.id)) stopped += 1;
    }
    return stopped;
  }

  list(parentSessionId: string): Subagent[] {
    const queue = this.queues.get(parentSessionId) ?? [];
    return [...this.runs.values()]
      .filter((run) => run.parentSessionId === parentSessionId)
      .map((run) => ({
        id: run.id, title: run.title, role: run.role, sessionId: run.childSessionId, state: run.state,
        position: run.state === 'queued' ? queue.indexOf(run.id) + 1 : undefined,
        activity: run.activity,
      }));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const run of this.runs.values()) {
      if (run.state === 'running') this.agent.cancel(run.childSessionId);
    }
    await Promise.allSettled([...this.handles]);
  }

  private append(sessionId: string, event: Parameters<SessionStore['append']>[1]): void {
    try {
      this.sessions.append(sessionId, event);
    } catch (error) {
      this.ctx.logger.warn(`Swarm could not record ${event.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private pump(parentSessionId: string): void {
    if (this.closed) return;
    const queue = this.queues.get(parentSessionId) ?? [];
    const limit = this.limits.get(parentSessionId) ?? DEFAULT_CONCURRENCY;
    while (queue.length > 0 && (this.running.get(parentSessionId) ?? 0) < limit) {
      const id = queue.shift();
      if (id) this.start(id);
    }
  }

  private start(id: string): void {
    const run = this.runs.get(id);
    if (!run || run.state !== 'queued' || this.closed) return;
    run.state = 'running';
    this.running.set(run.parentSessionId, (this.running.get(run.parentSessionId) ?? 0) + 1);
    this.append(run.parentSessionId, { type: 'subagent/started', data: { subagentId: id } });
    try {
      const handle = this.agent.start(run.childSessionId, run.prompt, {
        provider: run.provider, model: run.model, interactive: run.interactive,
      });
      const settled = handle.done.then((result) => this.finish(run, result));
      this.handles.add(settled);
      void settled.finally(() => this.handles.delete(settled));
    } catch (error) {
      this.finish(run, { turnId: '', outcome: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }

  private finish(run: Run, result: TurnResult): void {
    const previous = run.state;
    run.state = result.outcome === 'completed' ? 'done' : result.outcome === 'cancelled' ? 'stopped' : 'failed';
    this.running.set(run.parentSessionId, Math.max(0, (this.running.get(run.parentSessionId) ?? 1) - 1));
    const report = result.outcome === 'completed' ? this.lastMessage(run.childSessionId) : result.error;
    this.append(run.parentSessionId, {
      type: 'subagent/report',
      data: {
        subagentId: run.id,
        outcome: run.state === 'done' ? 'completed' : run.state === 'stopped' ? 'stopped' : 'failed',
        report: report || 'No report was produced.',
        ...(run.state === 'failed' ? { error: report || 'The subagent failed.' } : {}),
      },
    });
    if (previous !== 'queued') this.pump(run.parentSessionId);
  }

  private lastMessage(sessionId: string): string {
    try {
      const events = this.sessions.replay(sessionId);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type === 'assistant/message' && event.data.content.trim()) return event.data.content;
      }
    } catch {
      return '';
    }
    return '';
  }

  /** Called for every session event; only child sessions of a run are interesting. */
  observe(sessionId: string, event: SessionEvent): void {
    const runId = this.byChild.get(sessionId);
    if (!runId) return;
    const run = this.runs.get(runId);
    if (!run) return;
    if (event.type === 'tool/call') {
      const activity: SubagentActivity = {
        id: event.data.call.id, ...describeCall(event.data.call.name, event.data.call.input),
        state: 'running', startedAt: event.ts,
      };
      run.activity.push(activity);
      this.append(run.parentSessionId, { type: 'subagent/activity', data: { subagentId: runId, activity } });
      return;
    }
    if (event.type === 'tool/result') {
      const activity = run.activity.find(({ id }) => id === event.data.result.callId);
      if (!activity) return;
      const started = Date.parse(activity.startedAt);
      const duration = Number.isFinite(started) ? Math.max(0, Date.parse(event.ts) - started) : 0;
      const next: SubagentActivity = {
        ...activity,
        detail: describeResult(event.data.result.name, event.data.result.output) ?? activity.detail,
        state: event.data.result.isError ? 'failed' : 'done',
        durationMs: duration,
      };
      const index = run.activity.indexOf(activity);
      run.activity[index] = next;
      this.append(run.parentSessionId, { type: 'subagent/activity', data: { subagentId: runId, activity: next } });
    }
  }

  approval(request: ApprovalRequest): void {
    const runId = this.byChild.get(request.sessionId);
    if (!runId) return;
    const run = this.runs.get(runId);
    if (!run) return;
    run.state = 'waiting-approval';
    this.append(run.parentSessionId, { type: 'subagent/approval', data: { subagentId: runId, request } });
  }

  answered(sessionId: string, requestId: string, decision: 'allow' | 'deny' | 'always'): void {
    const runId = this.byChild.get(sessionId);
    if (!runId) return;
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.state === 'waiting-approval') run.state = 'running';
    this.append(run.parentSessionId, { type: 'subagent/approval-answered', data: { subagentId: runId, requestId, decision } });
  }
}

const delegateInput = z.object({
  tasks: z.array(z.object({
    title: z.string().min(1).max(200),
    role: z.string().max(120).optional(),
    prompt: z.string().min(1).max(8_000),
  })).min(1).max(12),
  concurrency: z.number().int().min(1).max(16).optional(),
});

export type DelegateToolInput = z.infer<typeof delegateInput>;

export interface SwarmOptions {
  concurrency?: number;
}

/** Mounts the swarm service and the delegate tool the main agent calls to fan work out. */
export function swarmPlugin(options: SwarmOptions = {}): Plugin {
  return {
    name: 'swarm',
    apply(ctx) {
      return ctx.inject(['agent', 'sessions', 'tools'], (scope) => {
        const swarm = new Swarm(scope, scope.get<AgentRuntime>('agent'), scope.get<SessionStore>('sessions'));
        scope.provide<SwarmRuntime>('swarm', swarm);
        scope.on('session/event', ({ sessionId, event }) => swarm.observe(sessionId, event));
        scope.on('tool/approval', (request) => swarm.approval(request));
        scope.on('tool/approval-answered', ({ sessionId, requestId, decision }) => swarm.answered(sessionId, requestId, decision));
        const tools = scope.get<Registry<Tool>>('tools');
        const tool: Tool<DelegateToolInput> = {
          name: 'delegate',
          description: 'Delegate independent work to parallel subagents. Each task runs in its own session and reports back. Use it when a plan has several independent pieces.',
          input: delegateInput,
          readOnly: true,
          async execute(input: DelegateToolInput, context: ToolCtx): Promise<JsonValue> {
            const result = swarm.delegate({
              parentSessionId: context.sessionId, parentTurnId: context.turnId, cwd: context.cwd,
              provider: context.provider, model: context.model, interactive: context.interactive,
              plan: { title: 'Delegated plan', concurrency: input.concurrency ?? options.concurrency, tasks: input.tasks },
            });
            return { subagents: result.subagents, queued: result.queued } as JsonValue;
          },
        };
        tools.register(scope, tool.name, tool);
        scope.emit('tools/register', { name: tool.name });
        return () => { void swarm.shutdown(); };
      });
    },
  };
}
