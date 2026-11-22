import { TriangleAlert } from 'lucide-react';
import type { Thread } from '@extendo/contracts';
import styles from './console.module.css';

/** A delegated run is blocked on a decision. It has to be visible without opening the panel. */
export function BlockingBanner({ thread, count, onReview }: { thread: Thread; count: number; onReview: () => void }) {
  if (!count) return null;
  return <div className={styles.banner} role="alert">
    <TriangleAlert size={14} aria-hidden="true" />
    <p>
      {count === 1 ? 'One subagent is' : `${count} subagents are`} waiting on your approval in <bdi dir="auto">{thread.title || 'this thread'}</bdi>.
    </p>
    <button type="button" className={styles.quietButton} onClick={onReview}>Review</button>
  </div>;
}
