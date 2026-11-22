import type { Preview, SessionEvent } from '@extendo/contracts';
import type { ThreadRow } from './state.js';

const patchTools = new Set(['demo_edit', 'edit', 'write', 'apply_patch']);

export function previewPath(sessionId: string): string {
  return `/api/preview/${encodeURIComponent(sessionId)}`;
}

/** The preview a thread offers: the rendered page its branch would produce. */
export function previewFor(thread: ThreadRow): Preview | undefined {
  if (!thread.branch) return undefined;
  return {
    label: 'Preview',
    title: 'Search results',
    url: previewPath(thread.sessionId),
    updatedAt: thread.createdAt,
  };
}

function patched(events: readonly SessionEvent[]): boolean {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'tool/call') names.set(event.data.call.id, event.data.call.name);
    if (event.type === 'tool/result') {
      const name = names.get(event.data.result.callId);
      if (name && patchTools.has(name)) return true;
    }
  }
  return false;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/**
 * A real page, not a screenshot: the demo workspace's search results with the empty state the
 * thread's branch currently produces. It is what the preview tab iframes.
 */
export function renderPreview(thread: ThreadRow, events: readonly SessionEvent[]): string {
  const fixed = patched(events);
  const empty = fixed
    ? `<div class="empty" role="status">
        <h2>No results for “keyboard shortcuts”</h2>
        <p>Nothing in this workspace matches that search. Try a broader term, or clear the filters.</p>
        <button type="button">Clear filters</button>
      </div>`
    : `<div class="empty" role="status">
        <h2>No results</h2>
      </div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(thread.title)} — preview</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #17171a; background: #f6f6f7; }
  header { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-block-end: 1px solid #e2e2e5; background: #fff; }
  header .brand { font-weight: 620; letter-spacing: -0.01em; }
  header .branch { margin-inline-start: auto; font: 12px/1.4 ui-monospace, SFMono-Regular, monospace; color: #6b6b73; }
  main { max-width: 720px; margin: 40px auto; padding: 0 20px; }
  .search { display: flex; gap: 8px; margin-block-end: 28px; }
  .search input { flex: 1; padding: 9px 12px; border: 1px solid #d9d9de; border-radius: 6px; background: #fff; font: inherit; }
  .search button { padding: 9px 14px; border: 1px solid #d9d9de; border-radius: 6px; background: #fff; font: inherit; }
  .empty { padding: 28px 24px; border: 1px solid #e2e2e5; border-radius: 8px; background: #fff; }
  .empty h2 { margin: 0 0 8px; font-size: 16px; font-weight: 620; }
  .empty p { margin: 0 0 16px; color: #5c5c66; }
  .empty button { padding: 8px 14px; border: 1px solid #17171a; border-radius: 6px; background: #17171a; color: #fff; font: inherit; }
  footer { max-width: 720px; margin: 32px auto 0; padding: 0 20px 40px; color: #8a8a93; font-size: 12px; }
</style>
</head>
<body>
<header><span class="brand">Northstar</span><span class="branch">${escape(thread.branch ?? 'main')}</span></header>
<main>
  <form class="search" onsubmit="return false">
    <input aria-label="Search" value="keyboard shortcuts">
    <button type="submit">Search</button>
  </form>
  ${empty}
</main>
<footer>Preview of ${escape(thread.title)} on ${escape(thread.branch ?? 'main')}. Served by Extendo from the demo workspace.</footer>
</body>
</html>`;
}
