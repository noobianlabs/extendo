import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentRuntime, SendOptions, TurnHandle } from '@extendo/agent';
import type { AgentStatus } from '@extendo/contracts';
import { GitService } from '@extendo/git';
import { Context } from '@extendo/kernel';
import { SessionStore } from '@extendo/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrewService } from './crew.js';
import { WorkspaceState, type ThreadRow } from './state.js';
import { ThreadViewer } from './threads.js';

const execFileAsync = promisify(execFile);

let directory: string;
let root: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'extendo-landing-'));
  root = join(directory, 'northstar');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

function write(cwd: string, path: string, content: string): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content, 'utf8');
}

function fakeAgent(status: AgentStatus = 'idle') {
  const cancel = vi.fn();
  const agent = {
    start: (_sessionId: string, _input: string, _options: SendOptions): TurnHandle => ({ turnId: 'turn-fake', done: new Promise(() => {}) }),
    status: () => status,
    cancel,
    steer: () => true,
    async interrupt() { return { turnId: 'turn-fake-2', done: new Promise(() => {}) } as TurnHandle; },
    approvals: () => [],
    answer: () => true,
  };
  return { agent: agent as unknown as AgentRuntime, cancel };
}

interface Bench {
  ctx: Context;
  sessions: SessionStore;
  workspace: WorkspaceState;
  project: ReturnType<WorkspaceState['openProject']>;
  captain: ThreadRow;
  crew: CrewService;
  agent: ReturnType<typeof fakeAgent>;
  git: GitService;
}

/** A real repository with a real worktree per worker, because landing is only proven by git. */
async function bench(): Promise<Bench> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  write(root, 'src/app.ts', "export const empty = 'No results';\nexport const count = 0;\nexport const filters = [];\n");
  write(root, 'docs/CHANGELOG.md', '# Changelog\n\n- Search keeps its filters.\n');
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.email', 'test@extendo.local']);
  await git(root, ['config', 'user.name', 'Extendo Test']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'Scaffold the search surface']);

  const ctx = new Context();
  const sessions = new SessionStore(directory, ctx);
  const workspace = new WorkspaceState(directory);
  const project = workspace.openProject(root);
  const service = new GitService();
  const captain = workspace.createThread(sessions, project, { title: 'Run the crew', provider: 'fake', model: 'fake', branch: 'main', role: 'captain' });
  const agent = fakeAgent();
  const crew = new CrewService({ ctx, workspace, sessions, agent: agent.agent, git: service });
  await crew.whenReady();
  return { ctx, sessions, workspace, project, captain, crew, agent, git: service };
}

/** A worker on a real worktree, with one commit on its branch. */
async function worker(instance: Bench, title: string, path: string, content: string): Promise<ThreadRow> {
  const created = await instance.git.createWorktree(root, { title, base: 'main' });
  write(created.path, path, content);
  await instance.git.commitAll(created.path, `crew: ${title}`);
  const row = instance.workspace.createThread(instance.sessions, instance.project, {
    title, provider: 'fake', model: 'fake', branch: created.branch, base: created.base, role: 'worker', captainId: instance.captain.id,
  });
  instance.workspace.setThreadCheckout(row.sessionId, { cwd: created.path, branch: created.branch, worktree: created.path, base: created.base });
  instance.sessions.move(row.sessionId, created.path);
  return instance.workspace.thread(row.id)!;
}

const viewer = (instance: Bench) => new ThreadViewer({ workspace: instance.workspace, sessions: instance.sessions, agent: instance.agent.agent });

describe('landing a worker branch', () => {
  it('fast-forwards, records the landing on the captain, and keeps the branch and worktree', async () => {
    const instance = await bench();
    const copy = await worker(instance, 'Rework the copy', 'src/app.ts', "export const empty = 'No results for the query';\n");
    const before = (await git(root, ['rev-parse', 'main'])).trim();

    const { landed } = await instance.crew.integrate(instance.captain, copy.id);
    expect(landed).toMatchObject({ target: 'main', mode: 'fast-forward' });
    expect((await git(root, ['rev-parse', 'main'])).trim()).toBe(landed.commit);
    expect(landed.commit).not.toBe(before);
    expect((await git(root, ['log', '-1', '--format=%s', 'main'])).trim()).toBe('crew: Rework the copy');

    const events = instance.sessions.replay(instance.captain.sessionId).filter((event) => event.type === 'crew/land');
    expect(events).toMatchObject([{ data: { workerId: copy.id, branch: copy.branch, target: 'main', commit: landed.commit, mode: 'fast-forward' } }]);

    const captain = await viewer(instance).get(instance.captain.sessionId);
    expect(captain?.crew?.[0]?.landed).toMatchObject({ target: 'main', commit: landed.commit, mode: 'fast-forward' });

    // Landed is not discarded: the branch still points at its commit and its worktree is still there.
    expect((await git(root, ['rev-parse', '--verify', `refs/heads/${copy.branch}`])).trim()).toBe(landed.commit);
    expect(existsSync(copy.worktree!)).toBe(true);
    expect((await instance.git.worktrees(root)).map((entry) => entry.path)).toContain(copy.worktree);
    await instance.crew.close();
  });

  it('merges with a real merge commit when the integration branch has moved on', async () => {
    const instance = await bench();
    const changelog = await worker(instance, 'Draft the changelog entry', 'docs/CHANGELOG.md', '# Changelog\n\n- Search keeps its filters.\n- Empty results name the query.\n');
    const copy = await worker(instance, 'Rework the copy', 'src/app.ts', "export const empty = 'No results for the query';\n");

    const first = await instance.crew.integrate(instance.captain, changelog.id);
    const second = await instance.crew.integrate(instance.captain, copy.id);
    expect(first.landed.mode).toBe('fast-forward');
    expect(second.landed.mode).toBe('merge');
    const parents = (await git(root, ['log', '-1', '--format=%P', 'main'])).trim().split(' ');
    expect(parents).toEqual([first.landed.commit, (await git(root, ['rev-parse', copy.branch!])).trim()]);
    expect(second.landed.commit).toBe((await git(root, ['rev-parse', 'main'])).trim());

    const captain = await viewer(instance).get(instance.captain.sessionId);
    expect(captain?.crew?.map((member) => member.landed?.mode)).toEqual(['fast-forward', 'merge']);
    await instance.crew.close();
  });

  it('refuses a conflicting landing and leaves the target at its original commit', async () => {
    const instance = await bench();
    const copy = await worker(instance, 'Rework the copy', 'src/app.ts', "export const empty = 'No results for the query';\n");
    const layout = await worker(instance, 'Wrap the empty state', 'src/app.ts', "export const empty = 'Nothing found for the query';\n");
    await instance.crew.integrate(instance.captain, copy.id);
    const landed = (await git(root, ['rev-parse', 'main'])).trim();
    const worktrees = (await instance.git.worktrees(root)).length;

    await expect(instance.crew.integrate(instance.captain, layout.id)).rejects.toMatchObject({
      code: 'conflict',
      detail: { paths: ['src/app.ts'] },
    });
    expect((await git(root, ['rev-parse', 'main'])).trim()).toBe(landed);
    expect((await git(root, ['status', '--porcelain']))).toBe('');
    expect((await instance.git.worktrees(root)).length).toBe(worktrees);
    expect(instance.sessions.replay(instance.captain.sessionId).filter((event) => event.type === 'crew/land')).toHaveLength(1);
    expect((await viewer(instance).get(instance.captain.sessionId))?.crew?.find((member) => member.threadId === layout.id)?.landed).toBeUndefined();
    await instance.crew.close();
  });

  it('refuses to land or review a worker that has no branch', async () => {
    const instance = await bench();
    const empty = instance.workspace.createThread(instance.sessions, instance.project, {
      title: 'No branch', provider: 'fake', model: 'fake', role: 'worker', captainId: instance.captain.id,
    });
    await expect(instance.crew.integrate(instance.captain, empty.id)).rejects.toThrow(/has no branch/);
    await expect(instance.crew.diff(instance.captain, empty.id)).rejects.toThrow(/has no branch/);
    await instance.crew.close();
  });
});

describe('a worker turn that ends', () => {
  it('commits a completed turn and does not commit an interrupted one', async () => {
    const instance = await bench();
    const copy = await worker(instance, 'Rework the copy', 'src/app.ts', "export const empty = 'No results for the query';\n");
    const head = (await git(copy.worktree!, ['rev-parse', 'HEAD'])).trim();

    instance.sessions.appendMany(copy.sessionId, [
      { type: 'turn/start', data: { turnId: 'turn-cancelled', provider: 'fake', model: 'fake' } },
      { type: 'step/start', data: { turnId: 'turn-cancelled', stepId: 'step-cancelled' } },
      { type: 'assistant/attempt', data: { turnId: 'turn-cancelled', stepId: 'step-cancelled', content: 'Half-written change.', error: 'Turn cancelled' } },
      { type: 'step/end', data: { turnId: 'turn-cancelled', stepId: 'step-cancelled', outcome: 'cancelled' } },
      { type: 'turn/end', data: { turnId: 'turn-cancelled', outcome: 'cancelled', error: 'Turn cancelled' } },
    ]);
    write(copy.worktree!, 'src/partial.ts', 'export const halfWritten = true;\n');
    await vi.waitFor(() => expect(
      instance.sessions.replay(instance.captain.sessionId).filter((event) => event.type === 'crew/wake' && event.data.turnId === 'turn-cancelled'),
    ).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await git(copy.worktree!, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect((await instance.git.status(copy.worktree!)).files.map((file) => file.path)).toEqual(['src/partial.ts']);

    instance.sessions.appendMany(copy.sessionId, [
      { type: 'turn/start', data: { turnId: 'turn-done', provider: 'fake', model: 'fake' } },
      { type: 'step/start', data: { turnId: 'turn-done', stepId: 'step-done' } },
      { type: 'assistant/message', data: { turnId: 'turn-done', stepId: 'step-done', messageId: 'done-assistant', content: 'The copy is finished.' } },
      { type: 'step/end', data: { turnId: 'turn-done', stepId: 'step-done', outcome: 'completed' } },
      { type: 'turn/end', data: { turnId: 'turn-done', outcome: 'completed' } },
    ]);
    await vi.waitFor(async () => expect((await git(copy.worktree!, ['rev-parse', 'HEAD'])).trim()).not.toBe(head));
    expect((await instance.git.status(copy.worktree!)).files).toEqual([]);
    expect((await git(copy.worktree!, ['log', '-1', '--format=%s'])).trim()).toBe('crew: Rework the copy');
    await instance.crew.close();
  });
});