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
export function renderPreview(thread: ThreadRow, events: readonly SessionEvent[], theme?: 'light' | 'dark'): string {
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
<html lang="en"${theme ? ` data-theme="${theme}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(thread.title)} — preview</title>
<style>
  :root {
    color-scheme: light dark;
    --ink: light-dark(#17171a, #ebebec);
    --page: light-dark(#f6f6f7, #121213);
    --surface: light-dark(#ffffff, #1a1a1b);
    --line: light-dark(#e2e2e5, rgba(255, 255, 255, 0.1));
    --field: light-dark(#d9d9de, rgba(255, 255, 255, 0.14));
    --quiet: light-dark(#5c5c66, #a3a3a6);
    --faint: light-dark(#8a8a93, #7f7f82);
    scrollbar-color: light-dark(#c9c9ce, #353537) transparent;
  }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }
  * { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: var(--field) transparent; }
  *::-webkit-scrollbar { width: 8px; height: 8px; }
  *::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: var(--field); background-clip: content-box; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-button { display: none; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--page); }
  header { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-block-end: 1px solid var(--line); background: var(--surface); }
  header .brand { font-weight: 620; letter-spacing: -0.01em; }
  header .branch { margin-inline-start: auto; font: 12px/1.4 ui-monospace, SFMono-Regular, monospace; color: var(--quiet); }
  main { max-width: 720px; margin: 40px auto; padding: 0 20px; }
  .search { display: flex; gap: 8px; margin-block-end: 28px; }
  .search input { flex: 1; padding: 9px 12px; border: 1px solid var(--field); border-radius: 6px; background: var(--surface); color: inherit; font: inherit; }
  .search button { padding: 9px 14px; border: 1px solid var(--field); border-radius: 6px; background: var(--surface); color: inherit; font: inherit; }
  .empty { padding: 28px 24px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
  .empty h2 { margin: 0 0 8px; font-size: 16px; font-weight: 620; }
  .empty p { margin: 0 0 16px; color: var(--quiet); }
  .empty button { padding: 8px 14px; border: 1px solid var(--ink); border-radius: 6px; background: var(--ink); color: light-dark(#ffffff, #121213); font: inherit; }
  footer { max-width: 720px; margin: 32px auto 0; padding: 0 20px 40px; color: var(--faint); font-size: 12px; }
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
