import type { NoticeMessage, PullRequest, SessionEvent, SteerPin, Subagent, SubagentActivity, ThreadState } from './index.js';

/**
 * Folds the durable subagent events into the live swarm a thread shows. The events are the only
 * source of truth: a subagent's state, its activity lines and its report all come from the log,
 * so a page reload reconstructs exactly what the console showed.
 */
export function projectSubagents(events: readonly SessionEvent[]): Subagent[] {
  const subagents = new Map<string, Subagent>();
  for (const event of events) {
    switch (event.type) {
      case 'subagent/spawned': {
        const { subagentId, title, role, sessionId } = event.data;
        if (subagents.has(subagentId)) break;
        subagents.set(subagentId, {
          id: subagentId, title, role, sessionId, state: 'queued', activity: [],
          position: event.data.position, parentTurnId: event.data.parentTurnId,
        });
        break;
      }
      case 'subagent/queued': {
        const subagent = subagents.get(event.data.subagentId);
        if (!subagent || subagent.state === 'running') break;
        subagent.state = 'queued';
        break;
      }
      case 'subagent/started': {
        const subagent = subagents.get(event.data.subagentId);
        if (!subagent) break;
        subagent.state = 'running';
        subagent.startedAt ??= event.ts;
        subagent.position = undefined;
        break;
      }
      case 'subagent/activity': {
        const subagent = subagents.get(event.data.subagentId);
        if (!subagent) break;
        const activity = event.data.activity;
        const index = subagent.activity.findIndex(({ id }) => id === activity.id);
        if (index === -1) subagent.activity.push(activity);
        else subagent.activity[index] = activity;
        break;
      }
      case 'subagent/report': {
        const subagent = subagents.get(event.data.subagentId);
        if (!subagent) break;
        const { outcome, report, error } = event.data;
        subagent.state = outcome === 'completed' ? 'done' : outcome === 'failed' ? 'failed' : 'stopped';
        subagent.report = report;
        subagent.error = error;
        subagent.endedAt = event.ts;
        subagent.position = undefined;
        delete subagent.approval;
        break;
      }
      case 'subagent/steered': {
        const subagent = subagents.get(event.data.subagentId);
        if (!subagent || subagent.state !== 'running') break;
        subagent.activity.push({
          id: `steer-${event.seq}`,
          kind: 'note',
          label: event.data.message,
          state: 'done',
          startedAt: event.ts,
          durationMs: 0,
        });
        break;
      }
      case 'subagent/approval': {
        const subagent = subagents.get(event.data.subagentId);
        if (!subagent) break;
        const { requestId, call } = event.data.request;
        subagent.state = 'waiting-approval';
        subagent.approval = { requestId, call };
        break;
      }
      case 'subagent/approval-answered': {
        const subagent = subagents.get(event.data.subagentId);
        if (!subagent) break;
        if (subagent.state === 'waiting-approval') subagent.state = 'running';
        delete subagent.approval;
        break;
      }
    }
  }
  const queued = [...subagents.values()].filter(({ state }) => state === 'queued');
  queued.forEach((subagent, index) => { subagent.position = index + 1; });
  return [...subagents.values()];
}

export interface ThreadStateInput {
  events: readonly SessionEvent[];
  pullRequest?: PullRequest;
  subagents?: Subagent[];
}

export interface ThreadStateResult {
  state: ThreadState;
  since?: string;
}

/** The most recent turn/start that has no turn/end after it. */
export function openTurn(events: readonly SessionEvent[]): string | undefined {
  let open: string | undefined;
  for (const event of events) {
    if (event.type === 'turn/start') open = event.data.turnId;
    else if (event.type === 'turn/end' && event.data.turnId === open) open = undefined;
  }
  return open;
}

/**
 * The durable crew notice one session event projects into a transcript. Both the stored projection
 * and the browser's live fold call this, so a wake or a landing looks the same whether it arrived
 * before the page loaded or while it was open.
 */
export function noticeFor(event: SessionEvent): NoticeMessage | undefined {
  if (event.type === 'crew/wake') {
    const { workerId, title, outcome, report } = event.data;
    return { role: 'notice', id: `wake-${event.seq}`, kind: 'crew-wake', workerId, title, outcome, content: report, at: event.ts };
  }
  if (event.type === 'crew/land') {
    const { workerId, branch, target, commit, shortCommit, mode } = event.data;
    return {
      role: 'notice', id: `land-${event.seq}`, kind: 'crew-land', workerId,
      title: `Landed ${branch}`, target, commit, mode, at: event.ts,
      content: `Into ${target} as ${shortCommit}, ${mode === 'fast-forward' ? 'fast-forwarded' : 'merged with a merge commit'}.`,
    };
  }
  return undefined;
}

/** The newest steer a worker's log carries inside the turn that is still open. */
export function steerInOpenTurn(events: readonly SessionEvent[]): SteerPin | undefined {
  const turnId = openTurn(events);
  if (!turnId) return undefined;
  const last = events.filter((event) => event.type === 'crew/steer' && event.data.turnId === turnId).at(-1);
  return last && last.type === 'crew/steer' ? { mode: last.data.mode, text: last.data.text, at: last.ts } : undefined;
}

/**
 * Derives what a thread needs from a person. Approval blocks first, then running work, then the
 * queue, then an open pull request waiting on review. A finished thread reads as done or failed.
 */
export function deriveThreadState({ events, pullRequest, subagents }: ThreadStateInput): ThreadStateResult {
  const swarm = subagents ?? projectSubagents(events);
  const last = events.at(-1);
  if (swarm.some(({ state }) => state === 'waiting-approval')) return { state: 'waiting-approval', since: last?.ts };
  if (openTurn(events)) return { state: 'working', since: last?.ts };
  if (swarm.some(({ state }) => state === 'running')) return { state: 'working', since: last?.ts };
  if (swarm.some(({ state }) => state === 'queued')) return { state: 'queued', since: last?.ts };
  if (pullRequest && pullRequest.state === 'open' && !pullRequest.draft) {
    const waiting = pullRequest.checks === 'pending' || pullRequest.checks === 'failing' ||
      pullRequest.review === 'pending' || pullRequest.review === 'changes-requested';
    if (waiting) return { state: 'waiting-review', since: last?.ts };
  }
  const lastEnd = events.findLast((event) => event.type === 'turn/end');
  if (lastEnd) return { state: lastEnd.data.outcome === 'failed' ? 'failed' : 'done', since: lastEnd.ts };
  if (events.length) return { state: 'done', since: last?.ts };
  return { state: 'idle' };
}

export function subagentCounts(subagents: readonly Subagent[]): Record<'running' | 'queued' | 'waiting' | 'failed' | 'done', number> {
  const counts = { running: 0, queued: 0, waiting: 0, failed: 0, done: 0 };
  for (const subagent of subagents) {
    switch (subagent.state) {
      case 'running': counts.running += 1; break;
      case 'queued': counts.queued += 1; break;
      case 'waiting-approval': counts.waiting += 1; break;
      case 'failed': counts.failed += 1; break;
      case 'done': counts.done += 1; break;
      case 'stopped': break;
    }
  }
  return counts;
}

export function activityDuration(activity: SubagentActivity): string {
  if (activity.durationMs === undefined) return '';
  const seconds = activity.durationMs / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}
