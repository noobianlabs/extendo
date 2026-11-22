import { CircleCheck, CircleX, Clock3, GitPullRequest, Merge, MonitorPlay } from 'lucide-react';
import type { PullRequest, Thread } from '@extendo/contracts';
import { boardLabels, elapsed, threadState } from './board';
import { subagentCounts } from '@extendo/contracts';
import styles from './console.module.css';

const number = new Intl.NumberFormat();

function checksLabel(pr: PullRequest) {
  return pr.checks === 'passing' ? 'Checks passing'
    : pr.checks === 'failing' ? 'Checks failing'
    : pr.checks === 'pending' ? 'Checks running'
    : 'No checks';
}

function reviewLabel(pr: PullRequest) {
  return pr.review === 'approved' ? 'Approved'
    : pr.review === 'changes-requested' ? 'Changes requested'
    : pr.review === 'pending' ? 'Review pending'
    : 'No review yet';
}

function CheckIcon({ state }: { state: PullRequest['checks'] }) {
  return state === 'passing' ? <CircleCheck size={12} aria-hidden="true" />
    : state === 'failing' ? <CircleX size={12} aria-hidden="true" />
    : <Clock3 size={12} aria-hidden="true" />;
}

function PullCard({ pr, merging, onMerge }: { pr: PullRequest; merging: boolean; onMerge: () => void }) {
  const open = pr.state === 'open';
  return <div className={styles.pull}>
    <GitPullRequest size={13} aria-hidden="true" />
    <span className={styles.pullNumber}>#{pr.number}</span>
    <a className={styles.pullTitle} href={pr.url} target="_blank" rel="noreferrer" title={pr.title} dir="auto">{pr.title}</a>
    <span className={styles.pullMeta}>
      <span className={`${styles.checkState}`} data-state={pr.checks} title={checksLabel(pr)} aria-label={checksLabel(pr)}>
        <CheckIcon state={pr.checks} />
      </span>
      <span title={reviewLabel(pr)}>{reviewLabel(pr)}</span>
      <span className={styles.stats} aria-label={`${number.format(pr.additions)} added, ${number.format(pr.deletions)} removed`}>
        <span className={styles.added}>+{number.format(pr.additions)}</span>
        <span className={styles.removed}>−{number.format(pr.deletions)}</span>
      </span>
      {open && !pr.draft && <button type="button" className={styles.quietButton} disabled={merging} onClick={onMerge}>
        <Merge size={12} aria-hidden="true" />{merging ? 'Merging…' : 'Merge'}
      </button>}
      {pr.state === 'merged' && <span>Merged</span>}
      {pr.state === 'closed' && <span>Closed</span>}
    </span>
  </div>;
}

export function ThreadHeader({
  thread, now, previewOpen, merging, onMerge, onTogglePreview,
}: {
  thread: Thread;
  now: number;
  previewOpen: boolean;
  merging: boolean;
  onMerge: () => void;
  onTogglePreview: () => void;
}) {
  const state = threadState(thread);
  const swarm = thread.subagents ?? [];
  const counts = subagentCounts(swarm);
  const running = counts.running + counts.waiting;
  const since = elapsed(thread.stateSince ?? thread.updatedAt, now);
  const parts = [
    running ? `${running} running` : undefined,
    counts.queued ? `${counts.queued} queued` : undefined,
    counts.done ? `${counts.done} done` : undefined,
    counts.failed ? `${counts.failed} failed` : undefined,
  ].filter(Boolean);
  return <header className={styles.header}>
    <div className={styles.headerTop}>
      <span className={styles.stateChip} data-state={state}>
        <span className={styles.stateDot} aria-hidden="true" />{boardLabels[state]}
      </span>
      {since && state !== 'idle' && <span className={styles.duration} title="Time in this state">{since}</span>}
      {swarm.length > 0 && <>
        <span className={styles.metaDot}>·</span>
        <span className={styles.headerMeta} title={`${number.format(swarm.length)} subagents`}>
          {swarm.length} subagent{swarm.length === 1 ? '' : 's'}{parts.length ? ` · ${parts.join(' · ')}` : ''}
        </span>
      </>}
      <span className={styles.spacer} />
      {thread.preview && <button type="button" className={styles.quietButton} data-active={previewOpen} onClick={onTogglePreview}
        aria-pressed={previewOpen}>
        <MonitorPlay size={12} aria-hidden="true" />Preview
      </button>}
    </div>
    {thread.pullRequest && <PullCard pr={thread.pullRequest} merging={merging} onMerge={onMerge} />}
  </header>;
}
