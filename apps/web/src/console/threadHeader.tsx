import { CircleCheck, CircleX, Clock3, GitMerge, GitPullRequest, MonitorPlay } from 'lucide-react';
import type { PullRequest, Thread } from '@extendo/contracts';
import styles from './console.module.css';

const number = new Intl.NumberFormat();

type PullState = 'merged' | 'closed' | 'draft' | 'failing' | 'changes' | 'review' | 'ready' | 'open';

function pullState(pr: PullRequest): { state: PullState; label: string } {
  if (pr.state === 'merged' || pr.merged) return { state: 'merged', label: 'Merged' };
  if (pr.state === 'closed') return { state: 'closed', label: 'Closed' };
  if (pr.draft) return { state: 'draft', label: 'Draft' };
  if (pr.checks === 'failing') return { state: 'failing', label: 'Checks failing' };
  if (pr.review === 'changes-requested') return { state: 'changes', label: 'Changes requested' };
  if (pr.checks === 'pending' || pr.review === 'pending') return { state: 'review', label: 'Waiting on review' };
  if (pr.checks === 'passing' && pr.review === 'approved') return { state: 'ready', label: 'Ready to merge' };
  return { state: 'open', label: 'Open' };
}

function StateIcon({ state }: { state: PullState }) {
  if (state === 'merged') return <GitMerge size={12} aria-hidden="true" />;
  if (state === 'ready') return <CircleCheck size={12} aria-hidden="true" />;
  if (state === 'failing' || state === 'changes' || state === 'closed') return <CircleX size={12} aria-hidden="true" />;
  return <Clock3 size={12} aria-hidden="true" />;
}

/** The pull request on this branch, as one inline chip rather than a card. */
export function PullChip({ pr, merging, onMerge }: { pr: PullRequest; merging: boolean; onMerge: () => void }) {
  const { state, label } = pullState(pr);
  const canMerge = state === 'ready' || (state === 'open' && pr.mergeable !== false);
  return <span className={styles.pullChip} data-state={state}>
    <GitPullRequest size={12} aria-hidden="true" />
    <a className={styles.pullNumber} href={pr.url} target="_blank" rel="noreferrer" title={pr.title} dir="auto">
      #{pr.number}
    </a>
    <span className={styles.pullState} title={label}>
      <StateIcon state={state} />{label}
    </span>
    <span className={styles.stats} aria-label={`${number.format(pr.additions)} added, ${number.format(pr.deletions)} removed`}>
      <span className={styles.added}>+{number.format(pr.additions)}</span>
      <span className={styles.removed}>−{number.format(pr.deletions)}</span>
    </span>
    {canMerge && <button type="button" className={styles.mergeButton} disabled={merging} onClick={onMerge}>
      {merging ? 'Merging…' : 'Merge'}
    </button>}
  </span>;
}

export function RunBar({
  thread, previewOpen, merging, onMerge, onTogglePreview,
}: {
  thread: Thread;
  previewOpen: boolean;
  merging: boolean;
  onMerge: () => void;
  onTogglePreview: () => void;
}) {
  const pr = thread.pullRequest;
  if (!pr && !thread.preview) return null;
  return <div className={styles.runBar}>
    <div className={styles.runBarInner}>
      {pr ? <PullChip pr={pr} merging={merging} onMerge={onMerge} />
        : <span className={styles.runNote}>No pull request on {thread.branch ?? 'this branch'} yet</span>}
      <span className={styles.spacer} />
      {thread.preview && <button type="button" className={styles.quietButton} data-active={previewOpen}
        aria-pressed={previewOpen} onClick={onTogglePreview}>
        <MonitorPlay size={12} aria-hidden="true" />Preview
      </button>}
    </div>
  </div>;
}
