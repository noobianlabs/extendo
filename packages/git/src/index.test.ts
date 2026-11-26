import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitError, GitService, nodeExec, parseStatus, parseWorktreeList, secretReason, slug, type Exec } from './index.js';

const execFileAsync = promisify(execFile);
const created: string[] = [];
const git = new GitService();

async function run(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  created.push(path);
  return path;
}

async function repository(): Promise<string> {
  const path = await directory('extendo-git-');
  await run(path, ['init', '-b', 'main']);
  await run(path, ['config', 'user.email', 'test@extendo.local']);
  await run(path, ['config', 'user.name', 'Extendo Test']);
  await writeFile(join(path, 'README.md'), '# Northstar\n');
  await writeFile(join(path, '.gitignore'), 'node_modules\n');
  await mkdir(join(path, 'src'));
  await writeFile(join(path, 'src/app.ts'), 'export const answer = 41;\n');
  await run(path, ['add', '.']);
  await run(path, ['commit', '-m', 'Initial commit']);
  return path;
}

async function bareRemote(path: string): Promise<string> {
  const remote = await directory('extendo-remote-');
  await run(remote, ['init', '--bare', '-b', 'main']);
  await run(path, ['remote', 'add', 'origin', remote]);
  await run(path, ['push', '-u', 'origin', 'main']);
  return remote;
}

const real = nodeExec();

function stub(answers: Record<string, { code?: number; stdout?: string; stderr?: string }>): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (command: string, args: string[], options: { cwd: string; timeoutMs?: number }) => {
    calls.push([command, ...args]);
    const key = [command, ...args].join(' ');
    const answer = Object.entries(answers).find(([prefix]) => key.startsWith(prefix))?.[1];
    return answer === undefined
      ? real(command, args, options)
      : { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
  }) as Exec & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('status', () => {
  it('reads the branch, the upstream, and ahead/behind from a real checkout', async () => {
    const path = await repository();
    const remote = await bareRemote(path);
    const tracked = await git.status(path);
    expect(tracked.repo).toBe(true);
    expect(tracked.branch).toBe('main');
    expect(tracked.upstream).toBe('origin/main');
    expect([tracked.ahead, tracked.behind]).toEqual([0, 0]);
    expect(tracked.remote).toMatchObject({ name: 'origin', url: remote, github: false });

    await writeFile(join(path, 'README.md'), '# Northstar\n\nA search UI.\n');
    await run(path, ['commit', '-am', 'Describe the project']);
    expect((await git.status(path)).ahead).toBe(1);

    await run(remote, ['update-ref', 'refs/heads/main', 'refs/heads/main']);
    await writeFile(join(path, 'README.md'), '# Northstar\n\nA search UI for everyone.\n');
    await run(path, ['commit', '-am', 'Name the audience']);
    const ahead = await git.status(path);
    expect(ahead.ahead).toBe(2);
    expect(ahead.headSubject).toBe('Name the audience');
  });

  it('groups staged, unstaged and untracked changes', async () => {
    const path = await repository();
    await writeFile(join(path, 'src/app.ts'), 'export const answer = 42;\n');
    await writeFile(join(path, 'src/new.ts'), 'export const extra = true;\n');
    await writeFile(join(path, 'README.md'), '# Northstar\n\nEdited.\n');
    await run(path, ['add', 'README.md']);
    const status = await git.status(path);
    const byPath = new Map(status.files.map((file) => [file.path, file]));
    expect(byPath.get('README.md')).toMatchObject({ staged: 'modified', untracked: false });
    expect(byPath.get('README.md')!.unstaged).toBe('none');
    expect(byPath.get('src/app.ts')).toMatchObject({ staged: 'none', unstaged: 'modified' });
    expect(byPath.get('src/new.ts')).toMatchObject({ untracked: true, staged: 'none' });
    expect(byPath.get('src/app.ts')!.additions).toBeGreaterThan(0);
  });

  it('says a plain directory is not a repository instead of guessing', async () => {
    const path = await directory('extendo-plain-');
    const status = await git.status(path);
    expect(status.repo).toBe(false);
    expect(status.error).toBe('This workspace is not a git repository');
  });

  it('parses porcelain v2 with spaces and renames in file names', () => {
    const output = [
      '# branch.oid abc123',
      '# branch.head feature/two words',
      '# branch.upstream origin/feature/two words',
      '# branch.ab +3 -2',
      '1 .M N... 100644 100644 100644 aaa bbb src/a file with spaces.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 src/renamed.ts',
      'src/original name.ts',
      '? notes/todo list.md',
    ].join('\0') + '\0';
    const parsed = parseStatus(output);
    expect(parsed).toMatchObject({ branch: 'feature/two words', ahead: 3, behind: 2, detached: false });
    expect(parsed.files.map((file) => file.path)).toEqual(['src/a file with spaces.ts', 'src/renamed.ts', 'notes/todo list.md']);
    expect(parsed.files[1]).toMatchObject({ staged: 'renamed', origPath: 'src/original name.ts' });
    expect(parsed.files[2]!.untracked).toBe(true);
  });

  it('reports a missing git binary as a checkout it cannot read, not as an empty one', async () => {
    const missing = new GitService({
      exec: async (command, args) => command === 'git' && args[0] === '--version'
        ? { code: 127, stdout: '', stderr: '' }
        : { code: 128, stdout: '', stderr: 'fatal: not a git repository' },
    });
    const path = await directory('extendo-nogit-');
    expect(await missing.status(path)).toMatchObject({ repo: false, error: 'git is not installed on this machine' });
    await expect(missing.stage(path, ['a.txt'])).rejects.toMatchObject({
      code: 'not-a-repo', message: expect.stringContaining('not installed'),
    });
    expect(nodeExec).toBeTypeOf('function');
  });
});

describe('the secret rail', () => {
  it('refuses .env files but keeps their templates', () => {
    expect(secretReason('.env')).toMatch(/environment files/);
    expect(secretReason('apps/web/.env.local')).toMatch(/environment files/);
    expect(secretReason('.env.production')).toMatch(/environment files/);
    expect(secretReason('.env.example')).toBeUndefined();
    expect(secretReason('.env.template')).toBeUndefined();
    expect(secretReason('deploy/id_ed25519')).toMatch(/private key/);
    expect(secretReason('certs/server.pem')).toMatch(/private key/);
    expect(secretReason('.aws/credentials')).toBeDefined();
    expect(secretReason('src/app.ts')).toBeUndefined();
  });

  it('refuses to stage a secret path and says why, without staging it', async () => {
    const path = await repository();
    await writeFile(join(path, '.env.local'), 'NORTHSTAR_TOKEN=do-not-ship\n');
    const before = await git.status(path);
    expect(before.files.find((file) => file.path === '.env.local')?.blocked).toMatch(/environment files/);
    await expect(git.stage(path, ['.env.local'])).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('will not stage .env.local') });
    expect(await run(path, ['diff', '--cached', '--name-only'])).toBe('');
    const staged = await git.stage(path, ['.env.local'], true);
    expect(staged.files.find((file) => file.path === '.env.local')?.staged).toBe('added');
  });

  it('refuses to commit when a secret was staged outside Extendo', async () => {
    const path = await repository();
    await writeFile(join(path, '.env.local'), 'NORTHSTAR_TOKEN=do-not-ship\n');
    await run(path, ['add', '-f', '.env.local']);
    await expect(git.commit(path, 'Ship the token')).rejects.toMatchObject({ code: 'blocked' });
    expect(await run(path, ['log', '-1', '--format=%s'])).toBe('Initial commit\n');
  });
});

describe('the working tree', () => {
  it('renders a real diff for an unstaged, a staged and an untracked file', async () => {
    const path = await repository();
    await writeFile(join(path, 'src/app.ts'), 'export const answer = 41;\nexport const question = 7;\n');
    const unstaged = await git.change(path, 'src/app.ts', false);
    expect(unstaged.before).toBe('export const answer = 41;\n');
    expect(unstaged.after).toContain('question = 7');
    expect(unstaged.additions).toBe(1);

    await writeFile(join(path, 'README.md'), '# Northstar UI\n');
    await run(path, ['add', 'README.md']);
    const staged = await git.change(path, 'README.md', true);
    expect(staged.before).toBe('# Northstar\n');
    expect(staged.after).toBe('# Northstar UI\n');

    await writeFile(join(path, 'notes.md'), 'one\ntwo\n');
    const untracked = await git.change(path, 'notes.md', false);
    expect(untracked).toMatchObject({ before: '', status: 'untracked', additions: 2 });
  });

  it('stages, unstages, and discards exactly what it was asked to', async () => {
    const path = await repository();
    await writeFile(join(path, 'src/app.ts'), 'export const answer = 43;\n');
    await writeFile(join(path, 'scratch.md'), 'temporary\n');
    await git.stage(path, ['src/app.ts']);
    expect((await git.status(path)).files.find((file) => file.path === 'src/app.ts')?.staged).toBe('modified');
    await git.unstage(path, ['src/app.ts']);
    expect((await git.status(path)).files.find((file) => file.path === 'src/app.ts')?.staged).toBe('none');

    await git.discard(path, ['src/app.ts']);
    expect(await readFile(join(path, 'src/app.ts'), 'utf8')).toBe('export const answer = 41;\n');
    await git.discard(path, ['scratch.md']);
    await expect(stat(join(path, 'scratch.md'))).rejects.toThrow();

    await writeFile(join(path, 'src/app.ts'), 'export const answer = 44;\n');
    await git.stage(path, ['src/app.ts']);
    await expect(git.discard(path, ['src/app.ts'])).rejects.toMatchObject({ code: 'unsafe', message: expect.stringContaining('Unstage src/app.ts') });
  });

  it('refuses a path that is not in the checkout', async () => {
    const path = await repository();
    await writeFile(join(path, 'src/app.ts'), 'export const answer = 45;\n');
    await expect(git.stage(path, ['../outside.txt'])).rejects.toMatchObject({ code: 'unsafe' });
  });
});

describe('commits and the way out', () => {
  it('makes a commit that a plain git log reads back', async () => {
    const path = await repository();
    await writeFile(join(path, 'src/app.ts'), 'export const answer = 42;\n');
    await expect(git.commit(path, 'Answer the question')).rejects.toMatchObject({ code: 'nothing-staged' });
    await git.stage(path, ['src/app.ts']);
    const commit = await git.commit(path, 'Answer the question');
    expect(commit.subject).toBe('Answer the question');
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await run(path, ['log', '-1', '--format=%s'])).toBe('Answer the question\n');
    expect(await run(path, ['log', '-1', '--format=%H'])).toBe(commit.sha + '\n');
    expect((await git.status(path)).files).toEqual([]);
  });

  it('pushes to a remote and the remote really has the commit', async () => {
    const path = await repository();
    const remote = await bareRemote(path);
    await writeFile(join(path, 'src/app.ts'), 'export const answer = 42;\n');
    await git.stage(path, ['src/app.ts']);
    const commit = await git.commit(path, 'Answer the question');
    const pushed = await git.push(path);
    expect(pushed.upstream).toBe('origin/main');
    expect(await run(remote, ['log', '-1', '--format=%H', 'main'])).toBe(commit.sha + '\n');
    expect((await git.status(path)).ahead).toBe(0);
  });

  it('never force-pushes when the remote has moved on', async () => {
    const path = await repository();
    const remote = await bareRemote(path);
    const other = join(await directory('extendo-other-'), 'work');
    await execFileAsync('git', ['clone', remote, other], { encoding: 'utf8' });
    await run(other, ['config', 'user.email', 'other@extendo.local']);
    await run(other, ['config', 'user.name', 'Other']);
    await writeFile(join(other, 'README.md'), '# Northstar\n\nFrom the other clone.\n');
    await run(other, ['commit', '-am', 'Move the remote on']);
    const remoteHead = (await run(other, ['rev-parse', 'HEAD'])).trim();
    await run(other, ['push', 'origin', 'main']);

    await writeFile(join(path, 'src/app.ts'), 'export const answer = 42;\n');
    await git.stage(path, ['src/app.ts']);
    await git.commit(path, 'Diverge here');
    await expect(git.push(path)).rejects.toThrow(/never force-pushes/);
    expect(await run(remote, ['log', '-1', '--format=%H', 'main'])).toBe(remoteHead + '\n');
  });

  it('says there is no remote instead of pretending to push', async () => {
    const path = await repository();
    await writeFile(join(path, 'src/app.ts'), 'export const answer = 46;\n');
    await git.stage(path, ['src/app.ts']);
    await git.commit(path, 'No remote here');
    await expect(git.push(path)).rejects.toMatchObject({ code: 'no-remote' });
  });
});

describe('worktrees', () => {
  it('creates a worktree on its own branch from the current base and removes it', async () => {
    const path = await repository();
    const created = await git.createWorktree(path, { title: 'Make empty results useful' });
    expect(created.branch).toBe('extendo/make-empty-results-useful');
    expect(created.base).toBe('main');
    expect(await stat(join(created.path, 'src/app.ts'))).toBeTruthy();
    expect((await git.status(created.path)).branch).toBe(created.branch);

    const listed = await git.worktrees(path, created.path);
    expect(listed.map((entry) => entry.path).sort()).toEqual([path, created.path].sort());
    expect(listed.find((entry) => entry.current)).toMatchObject({ path: created.path, main: false });

    await git.removeWorktree(path, created.path);
    await expect(stat(created.path)).rejects.toThrow();
    expect((await git.worktrees(path)).length).toBe(1);
  });

  it('deduplicates a branch name instead of failing the second thread', async () => {
    const path = await repository();
    const first = await git.createWorktree(path, { title: 'Empty state' });
    const second = await git.createWorktree(path, { title: 'Empty state' });
    expect(second.branch).toBe('extendo/empty-state-2');
    expect(first.path).not.toBe(second.path);
  });

  it('names the uncommitted work before it removes a dirty worktree', async () => {
    const path = await repository();
    const created = await git.createWorktree(path, { title: 'Dirty worktree' });
    await writeFile(join(created.path, 'src/app.ts'), 'export const answer = 0;\n');
    await writeFile(join(created.path, 'notes.txt'), 'half-written\n');
    await expect(git.removeWorktree(path, created.path)).rejects.toMatchObject({
      code: 'unsafe',
      detail: { worktree: { clean: false, branch: 'extendo/dirty-worktree', total: 2 } },
    });
    expect(await readFile(join(created.path, 'src/app.ts'), 'utf8')).toBe('export const answer = 0;\n');
    await git.removeWorktree(path, created.path, true);
    await expect(stat(created.path)).rejects.toThrow();
  });

  it('parses a worktree listing', () => {
    const output = [
      'worktree /repo/main', 'HEAD aaa', 'branch refs/heads/main', '',
      'worktree /repo/wt', 'HEAD bbb', 'branch refs/heads/extendo/x', '',
    ].join('\n');
    expect(parseWorktreeList(output)).toEqual([
      { path: '/repo/main', head: 'aaa', branch: 'main', main: true },
      { path: '/repo/wt', head: 'bbb', branch: 'extendo/x', main: false },
    ]);
  });

  it('slugs a title into a branch name that git accepts', () => {
    expect(slug('Make empty search results useful')).toBe('make-empty-search-results-useful');
    expect(slug('  Fix: the “flaky” test!  ')).toBe('fix-the-flaky-test');
    expect(slug('文字化け')).toBe('work');
    expect(slug('a'.repeat(80)).length).toBeLessThanOrEqual(40);
  });
});

describe('capabilities and pull requests', () => {
  it('reports gh as missing rather than claiming a pull request', async () => {
    const path = await repository();
    const exec = stub({ 'git --version': { stdout: 'git version 2.56.0\n' }, 'gh --version': { code: 127 } });
    const service = new GitService({ exec });
    const capabilities = await service.capabilities(path);
    expect(capabilities).toMatchObject({ git: '2.56.0', gh: { available: false, authenticated: false } });
    expect(capabilities.gh.detail).toMatch(/not installed/);
    await expect(service.pullRequest(path, { title: 'Anything' })).rejects.toMatchObject({ code: 'gh-missing' });
    expect(exec.calls.some((call) => call[0] === 'gh' && call[1] === 'pr')).toBe(false);
  });

  it('reports gh signed out rather than calling it a success', async () => {
    const path = await repository();
    const exec = stub({
      'git --version': { stdout: 'git version 2.56.0\n' },
      'gh --version': { stdout: 'gh version 2.103.3\n' },
      'gh auth status': { code: 1, stderr: 'You are not logged into any GitHub hosts.\n' },
    });
    const service = new GitService({ exec });
    const capabilities = await service.capabilities(path);
    expect(capabilities.gh).toMatchObject({ available: true, authenticated: false });
    expect(capabilities.gh.detail).toMatch(/not signed in/);
    await expect(service.pullRequest(path)).rejects.toMatchObject({ code: 'gh-unauthenticated' });
  });

  it('repeats what gh said when the remote is not a GitHub repository', async () => {
    const path = await repository();
    await bareRemote(path);
    const exec = stub({
      'git --version': { stdout: 'git version 2.56.0\n' },
      'gh --version': { stdout: 'gh version 2.103.3\n' },
      'gh auth status': { stdout: 'Logged in to github.com\n' },
      'gh pr view': { code: 1, stderr: 'no pull requests found\n' },
      'gh pr create': { code: 1, stderr: 'none of the git remotes configured for this repository point to a known GitHub host.\n' },
    });
    const service = new GitService({ exec });
    await expect(service.pullRequest(path)).rejects.toMatchObject({
      code: 'failed',
      message: expect.stringContaining('none of the git remotes'),
    });
  });

  it('creates a pull request through gh when everything is in place', async () => {
    const path = await repository();
    await run(path, ['remote', 'add', 'origin', 'https://github.com/northstar/web.git']);
    const exec = stub({
      'git --version': { stdout: 'git version 2.56.0\n' },
      'gh --version': { stdout: 'gh version 2.103.3\n' },
      'gh auth status': { stdout: 'Logged in to github.com account noobianlabs\n' },
      'gh pr view': { code: 1, stderr: 'no pull requests found\n' },
      'gh pr create': { stdout: 'https://github.com/northstar/web/pull/218\n' },
      'git push': { stdout: 'Everything up-to-date\n' },
    });
    const service = new GitService({ exec });
    const created = await service.pullRequest(path, { title: 'Name the query', body: 'Names it.' });
    expect(created).toEqual({ created: true, url: 'https://github.com/northstar/web/pull/218', number: 218, title: 'Name the query' });
    const create = exec.calls.find((call) => call.join(' ').startsWith('gh pr create'));
    expect(create).toContain('--title');
  });

  it('returns the pull request that already exists instead of opening a second one', async () => {
    const path = await repository();
    await run(path, ['remote', 'add', 'origin', 'git@github.com:northstar/web.git']);
    const exec = stub({
      'git --version': { stdout: 'git version 2.56.0\n' },
      'gh --version': { stdout: 'gh version 2.103.3\n' },
      'gh auth status': { stdout: 'Logged in to github.com\n' },
      'gh pr view': { stdout: JSON.stringify({ url: 'https://github.com/northstar/web/pull/9', number: 9, title: 'Open already' }) },
    });
    const service = new GitService({ exec });
    expect(await service.pullRequest(path)).toMatchObject({ created: false, number: 9 });
    expect(exec.calls.some((call) => call.join(' ').startsWith('gh pr create'))).toBe(false);
  });

  it('marks a GitError with a code the API can map', () => {
    expect(new GitError('blocked', 'no').code).toBe('blocked');
  });
});

describe('landing a branch', () => {
  /** A repository with `main`, a worker branch cut from it, and a commit on the worker. */
  async function crew(): Promise<{ path: string; worker: Awaited<ReturnType<GitService['createWorktree']>> }> {
    const path = await repository();
    const worker = await git.createWorktree(path, { title: 'Name the empty state' });
    await writeFile(join(worker.path, 'src/app.ts'), 'export const answer = 42;\n');
    await writeFile(join(worker.path, 'src/empty.ts'), "export const empty = 'No results for the query';\n");
    await git.commitAll(worker.path, 'Name the query in the empty state');
    return { path, worker };
  }

  it('fast-forwards when the target has not moved, without a merge commit', async () => {
    const { path, worker } = await crew();
    const before = await run(path, ['rev-parse', 'main']);
    const landed = await git.integrate(path, { target: 'main', branch: worker.branch });
    expect(landed.mode).toBe('fast-forward');
    expect(landed.previous).toBe(before.trim());
    expect(landed.commit).toBe((await run(path, ['rev-parse', worker.branch])).trim());
    expect((await run(path, ['rev-parse', 'main'])).trim()).toBe(landed.commit);
    expect(await run(path, ['log', '-1', '--format=%s', 'main'])).toContain('Name the query');
    expect(await run(path, ['rev-list', '--count', `main~1..main`])).toBe('1\n');
    expect((await run(path, ['log', '--format=%s', '-1', 'main'])).trim()).toBe('Name the query in the empty state');
    expect((await git.status(path)).files).toEqual([]);
  });

  it('creates a real merge commit with both parents when the target moved', async () => {
    const { path, worker } = await crew();
    await writeFile(join(path, 'README.md'), '# Northstar\n\nMoved on.\n');
    await run(path, ['add', '.']);
    await run(path, ['commit', '-m', 'Document the surface']);
    const before = (await run(path, ['rev-parse', 'main'])).trim();
    const landed = await git.integrate(path, { target: 'main', branch: worker.branch });
    expect(landed.mode).toBe('merge');
    expect(landed.previous).toBe(before);
    const parents = (await run(path, ['log', '-1', '--format=%P', 'main'])).trim().split(' ');
    expect(parents).toHaveLength(2);
    expect(parents[0]).toBe(before);
    expect(parents[1]).toBe((await run(path, ['rev-parse', worker.branch])).trim());
    expect(await readFile(join(path, 'src/empty.ts'), 'utf8')).toContain('No results for the query');
    expect(await readFile(join(path, 'README.md'), 'utf8')).toContain('Moved on.');
  });

  it('refuses a conflicting landing and leaves the target at its original commit', async () => {
    const { path, worker } = await crew();
    await writeFile(join(path, 'src/app.ts'), 'export const answer = 0;\n');
    await run(path, ['add', '.']);
    await run(path, ['commit', '-m', 'Change the same line elsewhere']);
    const before = (await run(path, ['rev-parse', 'main'])).trim();
    const head = (await run(path, ['rev-parse', 'HEAD'])).trim();
    await expect(git.integrate(path, { target: 'main', branch: worker.branch })).rejects.toMatchObject({
      code: 'conflict',
      detail: { paths: ['src/app.ts'], target: 'main', branch: worker.branch },
    });
    expect((await run(path, ['rev-parse', 'main'])).trim()).toBe(before);
    expect((await run(path, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect((await git.status(path)).files).toEqual([]);
    expect(await run(path, ['status', '--porcelain'])).toBe('');
    expect(await readFile(join(path, 'src/app.ts'), 'utf8')).toBe('export const answer = 0;\n');
    expect((await git.worktrees(path)).length).toBe(2);
  });

  it('refuses to land into a checkout that has uncommitted work, before anything moves', async () => {
    const { path, worker } = await crew();
    await writeFile(join(path, 'src/app.ts'), 'export const answer = 7;\n');
    const before = (await run(path, ['rev-parse', 'main'])).trim();
    await expect(git.integrate(path, { target: 'main', branch: worker.branch })).rejects.toMatchObject({
      code: 'unsafe',
      message: expect.stringContaining('uncommitted changes'),
    });
    expect((await run(path, ['rev-parse', 'main'])).trim()).toBe(before);
    expect(await readFile(join(path, 'src/app.ts'), 'utf8')).toBe('export const answer = 7;\n');
  });

  it('keeps the worker branch and its worktree after landing', async () => {
    const { path, worker } = await crew();
    await git.integrate(path, { target: 'main', branch: worker.branch });
    expect((await run(path, ['rev-parse', '--verify', `refs/heads/${worker.branch}`])).trim()).toBeTruthy();
    expect(await readFile(join(worker.path, 'src/empty.ts'), 'utf8')).toContain('No results');
    expect((await git.status(worker.path)).branch).toBe(worker.branch);
    expect((await git.worktrees(path)).map((entry) => entry.path)).toContain(worker.path);
  });

  it('refuses to land a branch on itself or one with nothing new', async () => {
    const path = await repository();
    await expect(git.integrate(path, { target: 'main', branch: 'main' })).rejects.toMatchObject({ code: 'unsafe' });
    await run(path, ['branch', 'empty-family', 'main']);
    await expect(git.integrate(path, { target: 'main', branch: 'empty-family' })).rejects.toMatchObject({ code: 'unsafe' });
    expect((await run(path, ['log', '-1', '--format=%s'])).trim()).toBe('Initial commit');
  });
});

describe('comparing a branch with its base', () => {
  it('lists the commits and the merge diff a landing would bring', async () => {
    const path = await repository();
    const worker = await git.createWorktree(path, { title: 'Name the empty state' });
    await writeFile(join(worker.path, 'src/app.ts'), 'export const answer = 42;\nexport const extra = true;\n');
    await writeFile(join(worker.path, 'src/empty.ts'), "export const empty = 'No results for the query';\n");
    await git.commitAll(worker.path, 'Name the query in the empty state');
    await writeFile(join(worker.path, 'src/empty.ts'), "export const empty = 'Nothing found for the query';\n");
    await git.commitAll(worker.path, 'Say nothing found instead of no results');

    const diff = await git.compare(path, { base: 'main', branch: worker.branch });
    expect(diff).toMatchObject({ base: 'main', branch: worker.branch, empty: false });
    expect(diff.commits.map(({ subject }) => subject)).toEqual([
      'Say nothing found instead of no results',
      'Name the query in the empty state',
    ]);
    expect(diff.commits.every(({ sha, shortSha }) => sha.startsWith(shortSha))).toBe(true);
    expect(diff.files.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: 'src/app.ts', status: 'modified' },
      { path: 'src/empty.ts', status: 'added' },
    ]);
    const added = diff.files.find(({ path }) => path === 'src/empty.ts')!;
    expect(added.before).toBe('');
    expect(added.after).toContain('Nothing found for the query');
    expect(added.additions).toBe(1);
    const modified = diff.files.find(({ path }) => path === 'src/app.ts')!;
    expect(modified.before).toBe('export const answer = 41;\n');
    expect(modified.after).toContain('export const extra = true;');
    expect(modified.additions).toBe(2);
  });

  it('measures from the merge base, not from the base tip', async () => {
    const path = await repository();
    const worker = await git.createWorktree(path, { title: 'Sideways' });
    await writeFile(join(worker.path, 'src/side.ts'), 'export const side = 1;\n');
    await git.commitAll(worker.path, 'Add the side file');
    await writeFile(join(path, 'README.md'), '# Northstar\n\nUnrelated work on main.\n');
    await run(path, ['add', '.']);
    await run(path, ['commit', '-m', 'Move main on']);

    const diff = await git.compare(path, { base: 'main', branch: worker.branch });
    expect(diff.files.map(({ path }) => path)).toEqual(['src/side.ts']);
    expect(diff.commits).toHaveLength(1);
    expect(diff.mergeBase).toBe((await run(path, ['merge-base', 'main', worker.branch])).trim());
  });

  it('says a branch with no commits is empty instead of showing a zero-file diff', async () => {
    const path = await repository();
    const worker = await git.createWorktree(path, { title: 'Nothing yet' });
    const diff = await git.compare(path, { base: 'main', branch: worker.branch });
    expect(diff).toEqual({ base: 'main', branch: worker.branch, mergeBase: (await run(path, ['rev-parse', 'main'])).trim(), commits: [], files: [], empty: true });
  });

  it('names a missing branch rather than reporting an empty diff', async () => {
    const path = await repository();
    await expect(git.compare(path, { base: 'main', branch: 'extendo/gone' })).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('reviewing a branch after it landed', () => {
  it('keeps measuring from the fork point, so a landed branch still reviews', async () => {
    const path = await repository();
    const worker = await git.createWorktree(path, { title: 'Name the empty state' });
    expect(worker.baseCommit).toBe((await run(path, ['rev-parse', 'main'])).trim());
    await writeFile(join(worker.path, 'src/empty.ts'), "export const empty = 'No results for the query';\n");
    await git.commitAll(worker.path, 'Name the query in the empty state');

    const before = await git.compare(path, { base: 'main', branch: worker.branch, from: worker.baseCommit });
    expect(before.empty).toBe(false);
    await git.integrate(path, { target: 'main', branch: worker.branch });

    const after = await git.compare(path, { base: 'main', branch: worker.branch, from: worker.baseCommit });
    expect(after.empty).toBe(false);
    expect(after.commits.map(({ subject }) => subject)).toEqual(['Name the query in the empty state']);
    expect(after.files.map(({ path: file, status }) => ({ path: file, status }))).toEqual([{ path: 'src/empty.ts', status: 'added' }]);
    expect(after).toEqual(before);

    // Without a recorded fork point the merge base collapses onto the branch tip, which is why the
    // thread row carries the commit instead of only the branch name.
    const collapsed = await git.compare(path, { base: 'main', branch: worker.branch });
    expect(collapsed.empty).toBe(true);
  });
});
