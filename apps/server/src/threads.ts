import type { AgentRuntime } from '@extendo/agent';
import { deriveThreadState, projectSubagents, type CrewMember, type PullRequest, type Subagent, type Thread } from '@extendo/contracts';
import type { PullRequestReader } from '@extendo/pullrequests';
import type { SessionStore } from '@extendo/session';
import type { ThreadRow, WorkspaceState } from './state.js';

export interface ThreadViewerOptions {
  workspace: WorkspaceState;
  sessions: SessionStore;
  agent: AgentRuntime;
  pullRequests?: PullRequestReader;
  preview?: (thread: ThreadRow) => Thread['preview'];
  pullRequestTtlMs?: number;
}

interface CachedPullRequest {
  at: number;
  value: PullRequest | undefined;
}

interface Derived {
  seq: number;
  state: Thread['state'];
  since: string | undefined;
  subagents: Subagent[];
}

/**
 * Turns stored thread rows into what the console renders: the state a person needs to act on, the
 * swarm behind it, and the pull request attached to its branch. Derived state is cached by the
 * session's last event sequence, so a status board refresh costs one replay per changed thread.
 */
export class ThreadViewer {
  private readonly derived = new Map<string, Derived>();
  private readonly pullRequests = new Map<string, CachedPullRequest>();
  private readonly ttl: number;

  constructor(private readonly options: ThreadViewerOptions) {
    this.ttl = options.pullRequestTtlMs ?? 20_000;
  }

  async list(projectId?: string): Promise<Thread[]> {
    const rows = this.options.workspace.threads(projectId).filter((row) => !row.archived);
    return Promise.all(rows.map((row) => this.view(row)));
  }

  async get(sessionId: string): Promise<Thread | undefined> {
    const row = this.options.workspace.threadBySession(sessionId);
    return row ? this.view(row) : undefined;
  }

  /** Drops cached reads for one thread, or every thread when no session is named. */
  invalidate(sessionId?: string): void {
    if (sessionId) {
      this.derived.delete(sessionId);
      this.pullRequests.delete(sessionId);
      return;
    }
    this.derived.clear();
    this.pullRequests.clear();
  }

  private async view(row: ThreadRow): Promise<Thread> {
    const [pullRequest, derived] = await Promise.all([this.pullRequest(row), this.derive(row)]);
    const captain = row.role === 'captain';
    const [crew, issues] = captain
      ? await Promise.all([this.crew(row), Promise.resolve(this.options.workspace.issues({ captainId: row.id }))])
      : [undefined, undefined];
    return {
      ...row,
      status: this.options.agent.status(row.sessionId),
      state: derived.state,
      stateSince: derived.since,
      subagents: derived.subagents,
      pullRequest,
      crew,
      issues,
      preview: this.options.preview?.(row),
    };
  }

  /** A captain's workers, each with its own state, report, and open pull request. */
  private async crew(captain: ThreadRow): Promise<CrewMember[]> {
    const workers = this.options.workspace.workersOf(captain.id).filter((worker) => !worker.archived);
    return Promise.all(workers.map(async (worker) => {
      const view = await this.view(worker);
      const issue = this.options.workspace.issues({ assigneeId: worker.id })
        .find((candidate) => candidate.state !== 'done' && candidate.state !== 'canceled');
      return {
        threadId: view.id,
        sessionId: view.sessionId,
        title: view.title,
        role: view.role ?? 'worker',
        status: view.status,
        state: view.state,
        branch: view.branch,
        worktree: view.worktree,
        report: view.report,
        reportAt: view.reportAt,
        pullRequest: view.pullRequest,
        issueId: issue?.id,
        archived: view.archived,
      };
    }));
  }

  private async derive(row: ThreadRow): Promise<Derived> {
    const seq = this.options.sessions.lastSeq(row.sessionId);
    const cached = this.derived.get(row.sessionId);
    if (cached && cached.seq === seq) return cached;
    const events = this.options.sessions.replay(row.sessionId);
    const subagents = projectSubagents(events);
    const { state, since } = deriveThreadState({ events, subagents, pullRequest: await this.pullRequest(row) });
    const next: Derived = { seq, state, since, subagents };
    this.derived.set(row.sessionId, next);
    return next;
  }

  private async pullRequest(row: ThreadRow): Promise<PullRequest | undefined> {
    const reader = this.options.pullRequests;
    if (!reader || !row.branch) return undefined;
    const cached = this.pullRequests.get(row.sessionId);
    if (cached && Date.now() - cached.at < this.ttl) return cached.value;
    let value: PullRequest | undefined;
    try {
      value = await reader.read({ cwd: row.cwd, branch: row.branch });
    } catch {
      value = undefined;
    }
    this.pullRequests.set(row.sessionId, { at: Date.now(), value });
    return value;
  }
}
