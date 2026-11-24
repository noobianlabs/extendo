import styles from './workshop.module.css';

export interface SeamProps {
  plugin: string;
  tool: string;
  onOpen: () => void;
}

/**
 * The moment a plugin's tool was first called in this thread. It is derived from the session log and
 * the plugin store rather than stored as an event, so it cannot claim anything the log does not show.
 */
export function Seam({ plugin, tool, onOpen }: SeamProps) {
  return (
    <button type="button" className={styles.seam} onClick={onOpen} data-testid="plugin-seam"
      title={`${tool} came from the ${plugin} plugin. Open the workshop.`}>
      <span className={styles.seamRule} data-side="start" aria-hidden="true" />
      <span className={styles.seamLabel}>
        <span>plugin/<b>{plugin}</b> joined</span>
        <code>{tool}</code>
      </span>
      <span className={styles.seamRule} data-side="end" aria-hidden="true" />
    </button>
  );
}
