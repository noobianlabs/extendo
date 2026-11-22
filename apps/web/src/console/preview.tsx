import { RotateCw, SquareArrowOutUpRight } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Thread } from '@extendo/contracts';
import { relativeTime } from './board';
import styles from './console.module.css';

const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 800;

/** The branch's page, rendered at desktop width and scaled to fit the rail. */
export function PreviewPane({ thread, now }: { thread?: Thread; now: number }) {
  const [nonce, setNonce] = useState(0);
  const [scale, setScale] = useState(0.25);
  const frame = useRef<HTMLDivElement>(null);
  const preview = thread?.preview;

  useLayoutEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => setScale(Math.min(1, node.clientWidth / FRAME_WIDTH));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [preview?.url]);

  if (!thread) return <p className={styles.empty}>Open a thread to preview its branch.</p>;
  if (!preview) return <p className={styles.empty}>
    No preview for this branch yet. A thread with a branch and a rendered page shows it here once it exists.
  </p>;
  const updated = relativeTime(preview.updatedAt, now);
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const src = `${preview.url}${preview.url.includes('?') ? '&' : '?'}theme=${theme}`;
  const height = Math.round(FRAME_HEIGHT * scale);
  return <div className={styles.previewBody}>
    <div className={styles.previewMeta}>
      <span>{preview.label ?? 'Preview'}</span>
      <span aria-hidden="true">·</span>
      <code title={preview.title} dir="ltr">{preview.title}</code>
      {updated && <span title={preview.updatedAt}>{updated}</span>}
      <button type="button" className={styles.iconButton} onClick={() => setNonce((value) => value + 1)}
        title="Reload the preview" aria-label="Reload the preview"><RotateCw size={13} aria-hidden="true" /></button>
      <a className={styles.iconButton} href={preview.url} target="_blank" rel="noreferrer"
        title="Open the preview in a new tab" aria-label="Open the preview in a new tab">
        <SquareArrowOutUpRight size={13} aria-hidden="true" />
      </a>
    </div>
    <div className={styles.frameWrap} ref={frame}>
      <div className={styles.frameScale} style={{ width: FRAME_WIDTH, height: FRAME_HEIGHT, transform: `scale(${scale})` }}>
        <iframe key={`${src}-${nonce}`} className={styles.frame} src={src} title={`${preview.title} preview`}
          sandbox="allow-scripts allow-same-origin" loading="lazy" width={FRAME_WIDTH} height={FRAME_HEIGHT} />
      </div>
      <div className={styles.frameSpacer} style={{ height }} aria-hidden="true" />
    </div>
  </div>;
}
