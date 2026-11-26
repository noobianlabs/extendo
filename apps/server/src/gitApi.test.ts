import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GitView, Thread, WorktreeView } from '@extendo/contracts';
import { GitService } from '@extendo/git';
import { startServer, type ExtendoServer } from './index.js';

interface Booted {
  url: string;
  dataDir: string;
  server: ExtendoServer;
  close(): Promise<void>;
}

async function boot(git?: GitService): Promise<Booted> {
  const dataDir = await mkdtemp(join(tmpdir(), 'extendo-gitapi-'));
  const server = await startServer({ dataDir, port: 0, env: {}, git });
  return {
    url: server.url, dataDir, server,
    async close() {
      await server.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function get<T>(booted: Booted, path: string): Promise<T> {
  const response = await fetch(booted.url + path);
  expect(response.status, `${path} answered ${response.status}`).toBe(200);
  return response.json() as Promise<T>;
}

async function send<T>(booted: Booted, path: string, init: RequestInit & { body?: string }): Promise<{ status: number; body: T }> {
  const response = await fetch(booted.url + path, { ...init, headers: { 'content-type': 'application/json' } });
  return { status: response.status, body: await response.json() as T };
}

async function demoThread(booted: Booted, title: string): Promise<Thread> {
  const threads = await get<Thread[]>(booted, '/api/threads');
  const thread = threads.find((entry) => entry.title === title);
  if (!thread) throw new Error(`The demo thread ${title} was not seeded`);
  return thread;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

describe('the demo checkout', () => {
  let app: Booted;
  let thread: Thread;

  beforeAll(async () => {
    app = await boot(new GitService({ gh: join(tmpdir(), 'extendo-no-gh') }));
    thread = await demoThread(app, 'Make empty search results useful');
  });
  afterAll(async () => { await app.close(); });

  it('seeds a real repository with a worktree per thread', async () => {
    expect(thread.worktree).toBeTruthy();
    expect(thread.branch).toBe('feat/empty-state-copy');
    const view = await get<GitView>(app, `/api/git/status?sessionId=${thread.sessionId}`);
    expect(view.checkout).toMatchObject({ path: thread.worktree, worktree: thread.worktree, sessionId: thread.sessionId });
    expect(view.status).toMatchObject({
      repo: true, branch: 'feat/empty-state-copy', upstream: 'origin/feat/empty-state-copy', ahead: 1, behind: 0,
    });
    expect(view.status.headSubject).toBe('Extract the empty-state copy');
    expect(view.status.remote).toMatchObject({ name: 'origin', url: join(app.dataDir, 'demo', 'northstar.git') });
    expect(view.worktrees.length).toBe(8);
    expect(view.worktrees.find((entry) => entry.current)?.path).toBe(thread.worktree);
    expect(view.worktrees.some((entry) => entry.path.endsWith('crew-empty-state-copy'))).toBe(true);
    expect(view.worktrees.some((entry) => entry.path.endsWith('crew-changelog'))).toBe(true);
  });

  it('lists staged, unstaged and untracked work, and marks the secret path', async () => {
    const view = await get<GitView>(app, `/api/git/status?sessionId=${thread.sessionId}`);
    const byPath = new Map(view.status.files.map((file) => [file.path, file]));
    expect(byPath.get('apps/web/src/search/EmptyState.tsx')).toMatchObject({ staged: 'modified' });
    expect(byPath.get('README.md')).toMatchObject({ staged: 'none', unstaged: 'modified' });
    expect(byPath.get('apps/web/src/search/useSearch.ts')).toMatchObject({ unstaged: 'modified' });
    expect(byPath.get('apps/web/src/search/EmptyState.test.tsx')).toMatchObject({ untracked: true });
    expect(byPath.get('.env.local')).toMatchObject({ untracked: true, blocked: expect.stringContaining('environment files') });
  });

  it('renders the real before and after of a changed file', async () => {
    const change = await get<{ before: string; after: string; additions: number }>(app,
      `/api/git/diff?sessionId=${thread.sessionId}&path=${encodeURIComponent('apps/web/src/search/EmptyState.tsx')}&staged=1`);
    expect(change.before).toContain('<a href="/search?filters=">Clear filters</a>');
    expect(change.after).toContain('<button type="button"');
    expect(change.additions).toBeGreaterThan(0);
  });

  it('refuses to stage the secret path, and says why', async () => {
    const refused = await send<{ error: string; code: string; paths: { path: string; reason: string }[] }>(app, '/api/git/stage', {
      method: 'POST', body: JSON.stringify({ sessionId: thread.sessionId, paths: ['.env.local'] }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('blocked');
    expect(refused.body.error).toContain('.env.local');
    expect(refused.body.paths[0]?.reason).toContain('environment files');
    const view = await get<GitView>(app, `/api/git/status?sessionId=${thread.sessionId}`);
    expect(view.status.files.find((file) => file.path === '.env.local')?.staged).toBe('none');
  });

  it('says gh is missing instead of offering a pull request it cannot open', async () => {
    const view = await get<GitView>(app, `/api/git/status?sessionId=${thread.sessionId}`);
    expect(view.capabilities.gh).toMatchObject({ available: false, authenticated: false });
    expect(view.capabilities.gh.detail).toMatch(/not installed/);
    const refused = await send<{ error: string; code: string }>(app, '/api/git/pull-request', {
      method: 'POST', body: JSON.stringify({ sessionId: thread.sessionId }),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('gh-missing');
  });

  it('never commits without a message or discards a staged change', async () => {
    const empty = await send<{ error: string }>(app, '/api/git/commit', {
      method: 'POST', body: JSON.stringify({ sessionId: thread.sessionId, message: '   ' }),
    });
    expect(empty.status).toBe(400);
    const discard = await send<{ code: string; error: string }>(app, '/api/git/discard', {
      method: 'POST', body: JSON.stringify({ sessionId: thread.sessionId, paths: ['apps/web/src/search/EmptyState.tsx'] }),
    });
    expect(discard.status).toBe(409);
    expect(discard.body.error).toContain('Unstage');
  });
});

describe('committing and pushing from the app', () => {
  let app: Booted;
  let thread: Thread;

  beforeAll(async () => {
    app = await boot();
    thread = await demoThread(app, 'Make empty search results useful');
  });
  afterAll(async () => { await app.close(); });

  it('writes a commit that git log reads back, then pushes it to the remote', async () => {
    const staged = await send<GitView>(app, '/api/git/stage', {
      method: 'POST', body: JSON.stringify({ sessionId: thread.sessionId, paths: ['apps/web/src/search/EmptyState.test.tsx'] }),
    });
    expect(staged.status).toBe(200);
    expect(staged.body.status.files.find((file) => file.path === 'apps/web/src/search/EmptyState.test.tsx')?.staged).toBe('added');

    const committed = await send<{ commit: { sha: string; subject: string }; view: GitView }>(app, '/api/git/commit', {
      method: 'POST', body: JSON.stringify({ sessionId: thread.sessionId, message: 'Cover the empty state with a test' }),
    });
    expect(committed.status).toBe(200);
    expect(committed.body.commit.subject).toBe('Cover the empty state with a test');
    expect(await git(thread.worktree!, ['log', '-1', '--format=%H'])).toBe(committed.body.commit.sha + '\n');
    expect(await git(thread.worktree!, ['log', '-1', '--format=%s'])).toBe('Cover the empty state with a test\n');
    expect(committed.body.view.status.files.some((file) => file.path === 'apps/web/src/search/EmptyState.test.tsx')).toBe(false);
    expect(committed.body.view.status.ahead).toBe(2);

    const pushed = await send<{ push: { summary: string }; view: GitView }>(app, '/api/git/push', {
      method: 'POST', body: JSON.stringify({ sessionId: thread.sessionId }),
    });
    expect(pushed.status).toBe(200);
    const remote = join(thread.worktree!, '..', '..', 'northstar.git');
    expect(await git(remote, ['log', '-1', '--format=%s', 'feat/empty-state-copy'])).toBe('Cover the empty state with a test\n');
    expect(pushed.body.view.status.ahead).toBe(0);
  });

  it('discards an unstaged file back to the index, when it is asked to', async () => {
    const discarded = await send<GitView>(app, '/api/git/discard', {
      method: 'POST', body: JSON.stringify({ sessionId: thread.sessionId, paths: ['README.md'] }),
    });
    expect(discarded.status).toBe(200);
    expect(discarded.body.status.files.some((file) => file.path === 'README.md')).toBe(false);
    expect(await git(thread.worktree!, ['status', '--porcelain', 'README.md'])).toBe('');
  });
});

describe('a thread in its own worktree', () => {
  let app: Booted;
  let thread: Thread;

  beforeAll(async () => {
    app = await boot();
    thread = await demoThread(app, 'Trace the keyboard shortcut');
  });
  afterAll(async () => { await app.close(); });

  it('creates a worktree from the shared checkout and moves the thread into it', async () => {
    expect(thread.worktree).toBeUndefined();
    const created = await send<WorktreeView & { branch: string; base: string }>(app, '/api/git/worktree', {
      method: 'POST', body: JSON.stringify({ sessionId: thread.sessionId }),
    });
    expect(created.status).toBe(201);
    expect(created.body.branch).toBe('extendo/trace-the-keyboard-shortcut');
    expect(created.body.base).toBe('main');
    expect(created.body.status).toMatchObject({ repo: true, branch: created.body.branch, ahead: 0, behind: 0 });
    expect(created.body.status.files).toEqual([]);
    expect(created.body.thread.worktree).toBe(created.body.checkout.path);
    expect(await git(created.body.checkout.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(created.body.branch + '\n');

    const listed = await get<Thread[]>(app, '/api/threads');
    expect(listed.find((entry) => entry.id === thread.id)?.worktree).toBe(created.body.checkout.path);
  });

  it('moves the thread back when its worktree is removed', async () => {
    const removed = await send<WorktreeView>(app, `/api/git/worktree?sessionId=${thread.sessionId}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(removed.body.thread.worktree).toBeUndefined();
    expect(removed.body.checkout.path).toBe(join(app.dataDir, 'demo', 'northstar-ui'));
    expect(removed.body.status.branch).toBe('main');
    const listed = await get<Thread[]>(app, '/api/threads');
    expect(listed.find((entry) => entry.id === thread.id)?.cwd).toBe(join(app.dataDir, 'demo', 'northstar-ui'));
  });

  it('names the uncommitted work before it removes a dirty worktree', async () => {
    const other = await demoThread(app, 'Fix the flaky search test');
    const created = await send<WorktreeView>(app, '/api/git/worktree', {
      method: 'POST', body: JSON.stringify({ sessionId: other.sessionId }),
    });
    expect(created.status).toBe(201);
    await (await import('node:fs/promises')).writeFile(join(created.body.checkout.path, 'README.md'), '# Northstar UI\n\nMine.\n');

    const refused = await send<{ code: string; error: string; worktree: { clean: boolean; total: number; uncommitted: { path: string }[] } }>(
      app, `/api/git/worktree?sessionId=${other.sessionId}`, { method: 'DELETE' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('unsafe');
    expect(refused.body.worktree.clean).toBe(false);
    expect(refused.body.worktree.uncommitted.map((file) => file.path)).toContain('README.md');
    expect(refused.body.error).toContain('uncommitted change');
    expect(await (await import('node:fs/promises')).stat(created.body.checkout.path)).toBeTruthy();

    const forced = await send<WorktreeView>(app, `/api/git/worktree?sessionId=${other.sessionId}&force=1`, { method: 'DELETE' });
    expect(forced.status).toBe(200);
    expect(forced.body.thread.worktree).toBeUndefined();
  });
});

describe('deleting a thread', () => {
  let app: Booted;

  beforeAll(async () => { app = await boot(); });
  afterAll(async () => { await app.close(); });

  it('removes the thread, its session and its worktree', async () => {
    const thread = await demoThread(app, 'Audit empty-state copy across search surfaces');
    expect(thread.worktree).toBeTruthy();
    const removed = await send<{ removed: boolean }>(app, `/api/threads/${thread.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ removed: true });
    const threads = await get<Thread[]>(app, '/api/threads');
    expect(threads.some((entry) => entry.id === thread.id)).toBe(false);
    const session = await fetch(`${app.url}/api/sessions/${thread.sessionId}`);
    expect(session.status).toBe(404);
    const stillThere = await (await import('node:fs/promises')).stat(thread.worktree!).then(() => true, () => false);
    expect(stillThere).toBe(false);
  });

  it('refuses to delete a thread whose worktree holds uncommitted work, until told twice', async () => {
    const thread = await demoThread(app, 'Make empty search results useful');
    const refused = await send<{ code: string; worktree: { uncommitted: { path: string }[] } }>(app, `/api/threads/${thread.id}`, { method: 'DELETE' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('unsafe');
    expect(refused.body.worktree.uncommitted.length).toBeGreaterThan(0);
    const forced = await send<{ removed: boolean }>(app, `/api/threads/${thread.id}?force=1`, { method: 'DELETE' });
    expect(forced.status).toBe(200);
    const threads = await get<Thread[]>(app, '/api/threads');
    expect(threads.some((entry) => entry.id === thread.id)).toBe(false);
  });
});
