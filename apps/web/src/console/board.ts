import { subagentCounts, type Thread, type ThreadState } from '@extendo/contracts';

export const boardOrder: ThreadState[] = [
  'waiting-approval', 'working', 'queued', 'waiting-review', 'failed', 'done', 'idle',
];

export const boardLabels: Record<ThreadState, string> = {
  'waiting-approval': 'Waiting on you',
  working: 'Working',
  queued: 'Queued',
  'waiting-review': 'In review',
  failed: 'Failed',
  done: 'Done',
  idle: 'Idle',
};

const statusFallback: Record<Thread['status'], ThreadState> = {
  idle: 'idle', working: 'working', waiting: 'waiting-approval', failed: 'failed',
};

export function threadState(thread: Thread): ThreadState {
  return thread.state ?? statusFallback[thread.status];
}

export function groupBoard(threads: Thread[]) {
  const groups = new Map<ThreadState, Thread[]>();
  for (const thread of threads) {
    const state = threadState(thread);
    const rows = groups.get(state) ?? [];
    rows.push(thread);
    groups.set(state, rows);
  }
  return boardOrder.flatMap((state) => {
    const rows = groups.get(state);
    return rows?.length ? [{ state, threads: rows }] : [];
  });
}

const number = new Intl.NumberFormat();
const minutes = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });

export function elapsed(since: string | undefined, now: number): string | undefined {
  if (!since) return;
  const started = new Date(since).getTime();
  if (!Number.isFinite(started) || started <= 0) return;
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

export function relativeTime(value: string | undefined, now: number): string | undefined {
  if (!value) return;
  const at = new Date(value).getTime();
  if (!Number.isFinite(at) || at <= 0) return;
  const delta = Math.round((at - now) / 60_000);
  if (Math.abs(delta) < 60) return minutes.format(delta, 'minute');
  return minutes.format(Math.round(delta / 60), 'hour');
}

/** The one line under a board title: what the swarm is doing, or what the pull request needs. */
export function threadSummary(thread: Thread): string | undefined {
  const swarm = thread.subagents ?? [];
  const waiting = thread.state === 'waiting-approval'
    ? swarm.some(({ state }) => state === 'waiting-approval') ? 'approval needed' : 'approval pending'
    : undefined;
  if (waiting) return waiting;
  if (swarm.length) {
    const counts = subagentCounts(swarm);
    const parts = [
      counts.running ? `${counts.running} running` : undefined,
      counts.waiting ? `${counts.waiting} waiting` : undefined,
      counts.queued ? `${counts.queued} queued` : undefined,
      counts.failed ? `${counts.failed} failed` : undefined,
      counts.done ? `${counts.done} done` : undefined,
    ].filter(Boolean);
    return `${number.format(swarm.length)} subagent${swarm.length === 1 ? '' : 's'}${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
  }
  const pr = thread.pullRequest;
  if (pr && thread.state === 'waiting-review') {
    return pr.checks === 'failing' ? `#${pr.number} · checks failing`
      : pr.review === 'changes-requested' ? `#${pr.number} · changes requested`
      : `#${pr.number} · waiting on review`;
  }
  return undefined;
}
