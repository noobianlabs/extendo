import { RotateCw, SquareArrowOutUpRight } from 'lucide-react';
import { useState } from 'react';
import type { Thread } from '@extendo/contracts';
import { relativeTime } from './board';
import styles from './console.module.css';

/** The branch's page, rendered by the local server, shown beside the review it belongs to. */
export function PreviewPane({ thread, now }: { thread?: Thread; now: number }) {
  const [nonce, setNonce] = useState(0);
  const preview = thread?.preview;
  if (!thread) return <p className={styles.empty}>Open a thread to preview its branch.</p>;
  if (!preview) return <p className={styles.empty}>
    No preview for this branch yet. A thread with a branch and a rendered page shows it here once it exists.
  </p>;
  const updated = relativeTime(preview.updatedAt, now);
  return <div className={styles.previewBody}>
    <div className={styles.previewMeta}>
      <span>{preview.label ?? 'Preview'}</span>
      <span aria-hidden="true">·</span>
      <code title={preview.title} dir="ltr">{preview.title}</code>
      {updated && <span title={preview.updatedAt}>Updated {updated}</span>}
      <button type="button" className={styles.quietButton} onClick={() => setNonce((value) => value + 1)}
        title="Reload the preview"><RotateCw size={11} aria-hidden="true" />Reload</button>
      <a className={styles.quietButton} href={preview.url} target="_blank" rel="noreferrer">
        <SquareArrowOutUpRight size={11} aria-hidden="true" />Open
      </a>
    </div>
    <div className={styles.frameWrap}>
      <iframe key={`${preview.url}-${nonce}`} className={styles.frame} src={preview.url} title={`${preview.title} preview`}
        sandbox="allow-scripts allow-same-origin" loading="lazy" />
    </div>
  </div>;
}
