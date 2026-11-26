import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The demo workspace is a real git repository — a bare origin, real branches, a real worktree per
 * thread, and a working tree with work in it — so the source surface can be driven and asserted the
 * same way it is on a person's own project. Nothing in the demo is a picture of git.
 */
export interface DemoCheckout {
  root: string;
  remote: string;
  worktrees: Record<string, string>;
}

const files: Record<string, string> = {
  'README.md': `# Northstar UI

The search interface for the Northstar documentation site. One input, three surfaces:
the results list, the empty state, and the recent-searches shelf.
`,
  '.gitignore': `node_modules/
.DS_Store
`,
  'package.json': `{
  "name": "northstar-ui",
  "private": true,
  "type": "module"
}
`,
  'apps/web/src/search/useSearch.ts': `import { useCallback, useState } from 'react';

export interface SearchState {
  query: string;
  filters: string[];
}

export function useSearch(initial: SearchState) {
  const [state, setState] = useState(initial);
  const setQuery = useCallback((query: string) => {
    setState((current) => ({ ...current, query }));
  }, []);
  return { state, setQuery };
}
`,
  'apps/web/src/search/SearchResults.tsx': `import { EmptyState } from './EmptyState';
import { useSearch } from './useSearch';

export function SearchResults({ initial }) {
  const { state } = useSearch(initial);
  if (!state.query) return <EmptyState />;
  return <ol className="results">{state.query}</ol>;
}
`,
  'apps/web/src/search/EmptyState.tsx': `export function EmptyState() {
  return (
    <section className="empty">
      <p>No results</p>
    </section>
  );
}
`,
  'docs/CHANGELOG.md': `# Changelog

## Unreleased

- Search keeps its filters when you switch tabs.
`,
};

const editedEmptyState = `export function EmptyState({ query }: { query?: string }) {
  return (
    <section className="empty">
      <p>{query ? \`No results for \u201c\${query}\u201d\` : 'No results'}</p>
      <a href="/search?filters=">Clear filters</a>
    </section>
  );
}
`;

const editedUseSearch = `import { useCallback, useState } from 'react';

export interface SearchState {
  query: string;
  filters: string[];
}

export function useSearch(initial: SearchState) {
  const [state, setState] = useState(initial);
  const setQuery = useCallback((query: string) => {
    setState((current) => ({ ...current, query }));
  }, []);
  const clearFilters = useCallback(() => {
    setState((current) => ({ ...current, filters: [] }));
  }, []);
  return { state, setQuery, clearFilters };
}
`;

const newTest = `import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';

it('names the query that found nothing', () => {
  render(<EmptyState query="regional rollout" />);
  expect(screen.getByText(/No results for/)).toBeTruthy();
});
`;

const editedReadme = `# Northstar UI

The search interface for the Northstar documentation site. One input, three surfaces:
the results list, the empty state, and the recent-searches shelf.

The empty state names the query that found nothing, so a person can see what was searched
for rather than a blank page.
`;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout;
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

/**
 * Builds the demo repository. The order matters: `main` is published, one branch is published and
 * then carries a local commit in its own worktree (so the surface shows a true "1 ahead"), and the
 * working tree is left with a staged file, an unstaged file, an untracked test, and an `.env.local`
 * the secret rail refuses.
 */
export async function seedDemoRepo(root: string, remote: string): Promise<DemoCheckout> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.email', 'harness@northstar.example']);
  await git(root, ['config', 'user.name', 'Northstar Harness']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'Scaffold the search surface']);

  write(root, 'apps/web/src/search/useSearch.ts', files['apps/web/src/search/useSearch.ts']!.replace(
    "const [state, setState] = useState(initial);",
    "const [state, setState] = useState({ ...initial, filters: initial.filters ?? [] });",
  ));
  write(root, 'docs/CHANGELOG.md', files['docs/CHANGELOG.md']!.replace('- Search keeps its filters when you switch tabs.', '- Search keeps its filters when you switch tabs.\n- The results list no longer re-renders on every keystroke.'));
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'Persist search filters across tabs']);

  await mkdirSync(remote, { recursive: true, mode: 0o700 });
  await git(remote, ['init', '--bare', '-b', 'main']);
  await git(root, ['remote', 'add', 'origin', remote]);
  await git(root, ['push', '-u', 'origin', 'main']);

  const branch = 'feat/empty-state-copy';
  await git(root, ['branch', branch, 'main']);
  await git(root, ['push', '-u', 'origin', branch]);

  const worktrees: Record<string, string> = {};
  const parent = join(dirname(root), `${root.split(/[\\/]/).at(-1)}.worktrees`);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const worktree = join(parent, 'feat-empty-state-copy');
  await git(root, ['worktree', 'add', worktree, branch]);
  worktrees[branch] = worktree;

  write(worktree, 'apps/web/src/search/EmptyState.tsx', editedEmptyState);
  write(worktree, 'apps/web/src/search/SearchResults.tsx', files['apps/web/src/search/SearchResults.tsx']!.replace(
    'if (!state.query) return <EmptyState />;',
    'if (!state.query) return <EmptyState />;\n  if (state.query.length < 2) return <p>Keep typing…</p>;',
  ));
  await git(worktree, ['add', '-A']);
  await git(worktree, ['commit', '-m', 'Extract the empty-state copy']);

  write(worktree, 'apps/web/src/search/EmptyState.tsx', editedEmptyState.replace(
    '<a href="/search?filters=">Clear filters</a>',
    '<button type="button" onClick={() => clearFilters()}>Clear filters</button>',
  ));
  await git(worktree, ['add', 'apps/web/src/search/EmptyState.tsx']);
  write(worktree, 'apps/web/src/search/useSearch.ts', editedUseSearch);
  write(worktree, 'README.md', editedReadme);
  write(worktree, 'apps/web/src/search/EmptyState.test.tsx', newTest);
  write(worktree, '.env.local', 'NORTHSTAR_SEARCH_KEY=do-not-commit-this\n');

  for (const other of ['feat/swarm-audit', 'chore/release-notes']) {
    await git(root, ['branch', other, 'main']);
    await git(root, ['push', '-u', 'origin', other]);
    const path = join(parent, other.replaceAll('/', '-'));
    await git(root, ['worktree', 'add', path, other]);
    worktrees[other] = path;
  }

  // The demo crew's two workers each land a real change on their own branch, in their own worktree.
  const crewCopy = 'extendo/crew-empty-state-copy';
  await git(root, ['branch', crewCopy, 'main']);
  await git(root, ['push', '-u', 'origin', crewCopy]);
  const crewCopyPath = join(parent, 'crew-empty-state-copy');
  await git(root, ['worktree', 'add', crewCopyPath, crewCopy]);
  write(crewCopyPath, 'apps/web/src/search/EmptyState.tsx', editedEmptyState);
  await git(crewCopyPath, ['add', '-A']);
  await git(crewCopyPath, ['commit', '-m', 'Name the query in the empty state']);
  worktrees[crewCopy] = crewCopyPath;

  const crewChangelog = 'extendo/crew-changelog';
  await git(root, ['branch', crewChangelog, 'main']);
  await git(root, ['push', '-u', 'origin', crewChangelog]);
  const crewChangelogPath = join(parent, 'crew-changelog');
  await git(root, ['worktree', 'add', crewChangelogPath, crewChangelog]);
  write(crewChangelogPath, 'docs/CHANGELOG.md', files['docs/CHANGELOG.md']!.replace(
    '- Search keeps its filters when you switch tabs.',
    '- Search keeps its filters when you switch tabs.\n- Empty results name the query that found nothing.',
  ));
  await git(crewChangelogPath, ['add', '-A']);
  await git(crewChangelogPath, ['commit', '-m', 'Note the empty-state copy in the changelog']);
  worktrees[crewChangelog] = crewChangelogPath;

  return { root, remote, worktrees };
}
