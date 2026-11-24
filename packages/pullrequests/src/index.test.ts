import type { Ctx, PullRequest } from '@extendo/contracts';
import { describe, expect, it } from 'vitest';
import { gitPullRequestReader, pullRequestPlugin, scriptedPullRequestReader } from './index.js';
import type { CommandResult, Exec } from './index.js';

const CWD = '/repo';
const FIELDS = 'number,title,url,state,isDraft,mergeable,headRefName,baseRefName,additions,deletions,changedFiles,reviewDecision,statusCheckRollup';

interface Call {
  command: string;
  args: string[];
  cwd: string;
}

interface FakeExec {
  exec: Exec;
  calls: Call[];
}

function ok(stdout: string): CommandResult {
  return { code: 0, stdout };
}

function fakeExec(respond: (command: string, args: string[], cwd: string) => CommandResult): FakeExec {
  const calls: Call[] = [];
  return {
    calls,
    async exec(command, args, { cwd }) {
      calls.push({ command, args, cwd });
      return respond(command, args, cwd);
    },
  };
}

function readingGit(gh: CommandResult, branch = 'feature/reader'): FakeExec {
  return fakeExec((command) => command === 'git' ? ok(`${branch}\n`) : gh);
}

function view(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 42,
    title: 'Add the reader',
    url: 'https://github.com/extendo/extendo/pull/42',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    headRefName: 'feature/reader',
    baseRefName: 'main',
    additions: 120,
    deletions: 8,
    changedFiles: 5,
    reviewDecision: 'APPROVED',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    ...overrides,
  });
}

function reading(gh: CommandResult): ReturnType<typeof gitPullRequestReader> {
  return gitPullRequestReader({ exec: readingGit(gh).exec });
}

async function read(gh: CommandResult): Promise<PullRequest | undefined> {
  return reading(gh).read({ cwd: CWD });
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 3,
    title: 'Demo pull request',
    url: 'https://example.test/pull/3',
    branch: 'demo',
    base: 'main',
    additions: 4,
    deletions: 1,
    changedFiles: 2,
    checks: 'passing',
    checksSummary: '2 checks passed',
    review: 'pending',
    draft: false,
    merged: false,
    state: 'open',
    ...overrides,
  };
}

describe('gitPullRequestReader', () => {
  it('resolves the branch with git and parses a passing, approved pull request', async () => {
    const fake = readingGit(ok(view()));
    const pr = await gitPullRequestReader({ exec: fake.exec }).read({ cwd: CWD });
    expect(fake.calls).toEqual([
      { command: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: CWD },
      { command: 'gh', args: ['pr', 'view', '--json', FIELDS], cwd: CWD },
    ]);
    expect(pr).toMatchObject({
      number: 42,
      title: 'Add the reader',
      url: 'https://github.com/extendo/extendo/pull/42',
      branch: 'feature/reader',
      base: 'main',
      additions: 120,
      deletions: 8,
      changedFiles: 5,
      checks: 'passing',
      checksSummary: '1 check passed',
      review: 'approved',
      draft: false,
      merged: false,
      state: 'open',
    });
  });

  it('skips git when the caller supplies a branch', async () => {
    const fake = readingGit(ok(view()));
    await gitPullRequestReader({ exec: fake.exec }).read({ cwd: CWD, branch: 'release' });
    expect(fake.calls.map((call) => call.command)).toEqual(['gh']);
    expect(fake.calls[0]?.cwd).toBe(CWD);
  });

  it('resolves through git when the caller branch is blank', async () => {
    const fake = readingGit(ok(view()));
    await gitPullRequestReader({ exec: fake.exec }).read({ cwd: CWD, branch: '  ' });
    expect(fake.calls.map((call) => call.command)).toEqual(['git', 'gh']);
  });

  it('reports the pull request branch and falls back to the resolved branch without one', async () => {
    const titled = await reading(ok(view({ headRefName: 'feature/from-gh' }))).read({ cwd: CWD, branch: 'local' });
    expect(titled?.branch).toBe('feature/from-gh');
    const untitled = await reading(ok(view({ headRefName: null }))).read({ cwd: CWD, branch: 'local' });
    expect(untitled?.branch).toBe('local');
  });

  it('returns undefined when the branch cannot be resolved', async () => {
    const fake = fakeExec(() => ({ code: 128, stdout: '' }));
    expect(await gitPullRequestReader({ exec: fake.exec }).read({ cwd: CWD })).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.command).toBe('git');
  });

  it('treats a detached head and an empty branch name as unresolved', async () => {
    const detached = readingGit(ok(view()), 'HEAD');
    expect(await gitPullRequestReader({ exec: detached.exec }).read({ cwd: CWD })).toBeUndefined();
    const empty = readingGit(ok(view()), '');
    expect(await gitPullRequestReader({ exec: empty.exec }).read({ cwd: CWD })).toBeUndefined();
  });

  it('returns undefined when gh is missing', async () => {
    const fake = fakeExec((command) => command === 'git' ? ok('feature/reader\n') : { code: 127, stdout: '' });
    expect(await gitPullRequestReader({ exec: fake.exec }).read({ cwd: CWD })).toBeUndefined();
    expect(fake.calls.map((call) => call.command)).toEqual(['git', 'gh']);
  });

  it('returns undefined when gh exits non-zero', async () => {
    expect(await read({ code: 1, stdout: '' })).toBeUndefined();
    expect(await read({ code: 4, stdout: view() })).toBeUndefined();
  });

  it('returns undefined for malformed or non-object json', async () => {
    for (const stdout of ['', 'not json', '{', 'null', '[]', '42', '"text"']) {
      expect(await read(ok(stdout))).toBeUndefined();
    }
  });

  it('honors a custom gh executable', async () => {
    const fake = fakeExec((command) => command === 'git' ? ok('main\n') : ok(view()));
    await gitPullRequestReader({ exec: fake.exec, gh: 'gh-custom' }).read({ cwd: '/other' });
    expect(fake.calls[1]).toEqual({ command: 'gh-custom', args: ['pr', 'view', '--json', FIELDS], cwd: '/other' });
  });

  it('maps merged, closed, open, and draft states', async () => {
    expect(await read(ok(view({ state: 'MERGED' })))).toMatchObject({ state: 'merged', merged: true });
    expect(await read(ok(view({ state: 'CLOSED' })))).toMatchObject({ state: 'closed', merged: false });
    expect(await read(ok(view({ state: 'OPEN' })))).toMatchObject({ state: 'open', merged: false });
    expect(await read(ok(view({ state: null, isDraft: true })))).toMatchObject({ state: 'open', merged: false, draft: true });
  });

  it('maps every review decision', async () => {
    const cases: [unknown, PullRequest['review']][] = [
      ['APPROVED', 'approved'],
      ['CHANGES_REQUESTED', 'changes-requested'],
      ['REVIEW_REQUIRED', 'pending'],
      [null, 'none'],
      ['', 'none'],
      [undefined, 'none'],
      ['UNKNOWN', 'none'],
    ];
    for (const [decision, expected] of cases) {
      expect((await read(ok(view({ reviewDecision: decision }))))?.review).toBe(expected);
    }
  });

  it('summarizes a fully passing rollup', async () => {
    const rollup = Array.from({ length: 18 }, () => ({ status: 'COMPLETED', conclusion: 'SUCCESS' }));
    const pr = await read(ok(view({ statusCheckRollup: rollup })));
    expect(pr?.checks).toBe('passing');
    expect(pr?.checksSummary).toBe('18 checks passed');
    expect((await read(ok(view({ statusCheckRollup: [{ state: 'SUCCESS' }] }))))?.checksSummary).toBe('1 check passed');
  });

  it('fails when any check failed, was cancelled, timed out, or needs action', async () => {
    const rollup = [
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'FAILURE' },
      { status: 'COMPLETED', conclusion: 'CANCELLED' },
      { status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      { status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
    ];
    const pr = await read(ok(view({ statusCheckRollup: rollup })));
    expect(pr?.checks).toBe('failing');
    expect(pr?.checksSummary).toBe('4 failing');
    expect((await read(ok(view({ statusCheckRollup: [{ state: 'FAILURE' }] }))))?.checksSummary).toBe('1 failing');
  });

  it('pends while any check is pending, queued, or in progress', async () => {
    const rollup = [
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { state: 'PENDING' },
      { status: 'IN_PROGRESS', conclusion: null },
      { status: 'QUEUED', conclusion: null },
    ];
    const pr = await read(ok(view({ statusCheckRollup: rollup })));
    expect(pr?.checks).toBe('pending');
    expect(pr?.checksSummary).toBe('3 pending');
  });

  it('treats a null conclusion as pending and an empty entry as pending', async () => {
    const nullConclusion = await read(ok(view({ statusCheckRollup: [{ state: 'SUCCESS' }, { status: 'COMPLETED', conclusion: null }] })));
    expect(nullConclusion?.checks).toBe('pending');
    expect((await read(ok(view({ statusCheckRollup: [{}] }))))?.checks).toBe('pending');
  });

  it('reports none for empty, missing, malformed, or unrecognized rollups', async () => {
    const rollups: unknown[] = [[], null, 'none', 42, [{ status: 'COMPLETED', conclusion: 'NEUTRAL' }], [null, 'nope']];
    for (const rollup of rollups) {
      const pr = await read(ok(view({ statusCheckRollup: rollup })));
      expect(pr?.checks).toBe('none');
      expect(pr?.checksSummary).toBeUndefined();
    }
    const missing = await reading(ok(JSON.stringify({ number: 1 }))).read({ cwd: CWD });
    expect(missing?.checks).toBe('none');
    expect(missing?.checksSummary).toBeUndefined();
  });

  it('sanitizes numbers to finite non-negative integers', async () => {
    const raw = '{"number":7,"additions":1e999,"deletions":-3,"changedFiles":2.9,"state":"OPEN"}';
    expect(await read(ok(raw))).toMatchObject({ number: 7, additions: 0, deletions: 0, changedFiles: 2 });
    const strings = await read(ok(view({ number: 9, additions: '12', deletions: null, changedFiles: 0 })));
    expect(strings).toMatchObject({ number: 9, additions: 0, deletions: 0, changedFiles: 0 });
  });

  it('defaults missing fields without throwing', async () => {
    const pr = await read(ok('{"state":"OPEN"}'));
    expect(pr).toMatchObject({
      number: 0,
      title: '',
      url: '',
      branch: 'feature/reader',
      base: '',
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      checks: 'none',
      review: 'none',
      draft: false,
      merged: false,
      state: 'open',
    });
    expect(pr?.checksSummary).toBeUndefined();
  });
});

describe('scriptedPullRequestReader', () => {
  it('resolves by branch, then by cwd, and is undefined otherwise', async () => {
    const reader = scriptedPullRequestReader({ demo: pullRequest(), [CWD]: pullRequest({ number: 9 }) });
    expect((await reader.read({ cwd: '/elsewhere', branch: 'demo' }))?.number).toBe(3);
    expect((await reader.read({ cwd: CWD }))?.number).toBe(9);
    expect(await reader.read({ cwd: '/unknown', branch: 'missing' })).toBeUndefined();
  });

  it('flips a merged entry and reflects it on later reads', async () => {
    const reader = scriptedPullRequestReader({ demo: pullRequest() });
    expect(reader.merge('missing')).toBeUndefined();
    expect(reader.merge('demo')).toMatchObject({ branch: 'demo', merged: true, state: 'merged' });
    expect(await reader.read({ cwd: '/elsewhere', branch: 'demo' })).toMatchObject({ merged: true, state: 'merged' });
  });

  it('keeps the caller entries untouched and copies on read', async () => {
    const entries = { demo: pullRequest() };
    const reader = scriptedPullRequestReader(entries);
    reader.merge('demo');
    const copy = await reader.read({ cwd: '/elsewhere', branch: 'demo' });
    if (copy === undefined) throw new Error('Expected a scripted pull request');
    copy.title = 'mutated';
    expect(entries.demo).toMatchObject({ merged: false, state: 'open' });
    expect((await reader.read({ cwd: '/elsewhere', branch: 'demo' }))?.title).toBe('Demo pull request');
  });
});

describe('pullRequestPlugin', () => {
  it('provides the reader under pullRequests', () => {
    const provided = new Map<string, unknown>();
    const ctx = {
      provide(key: string, value: unknown) {
        provided.set(key, value);
        return () => { provided.delete(key); };
      },
    } as unknown as Ctx;
    const reader = scriptedPullRequestReader({});
    const plugin = pullRequestPlugin({ reader });
    expect(plugin.name).toBe('pull-requests');
    plugin.apply(ctx);
    expect(provided.get('pullRequests')).toBe(reader);
  });
});
