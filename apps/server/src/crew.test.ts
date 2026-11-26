import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntime, SendOptions, TurnHandle } from '@extendo/agent';
import type { AgentStatus, ThreadRole } from '@extendo/contracts';
import type { GitService } from '@extendo/git';
import { Context } from '@extendo/kernel';
import { SessionStore } from '@extendo/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Registry } from '@extendo/contracts';
import type { SystemSection } from '@extendo/agent';
import { CrewService, crewTools, type CrewOptions } from './crew.js';
import { createRuntime } from './runtime.js';
import { ThreadViewer } from './threads.js';
import { WorkspaceState, type ThreadRow } from './state.js';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'extendo-crew-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

interface Started {
  sessionId: string;
  input: string;
  options: SendOptions;
}

function fakeAgent(status: AgentStatus | ((sessionId: string) => AgentStatus) = 'idle') {
  const started: Started[] = [];
  const steered: { sessionId: string; input: string }[] = [];
  const cancelled: string[] = [];
  const agent = {
    start(sessionId: string, input: string, options: SendOptions): TurnHandle {
      started.push({ sessionId, input, options });
      return { turnId: `turn-${started.length}`, done: new Promise(() => {}) };
    },
    status: (sessionId: string) => typeof status === 'function' ? status(sessionId) : status,
    cancel(sessionId: string) {
      cancelled.push(sessionId);
      return true;
    },
    steer(sessionId: string, input: string) {
      steered.push({ sessionId, input });
      return true;
    },
  };
  return { agent: agent as unknown as AgentRuntime, started, steered, cancelled };
}

const git = {
  async createWorktree(_cwd: string, input: { title: string }) {
    const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return { path: join(directory, 'worktrees', slug), branch: `extendo/${slug}`, base: 'main' };
  },
  async commitAll() {
    return undefined;
  },
} as unknown as GitService;

function makeBench() {
  const ctx = new Context();
  const sessions = new SessionStore(directory, ctx);
  const workspace = new WorkspaceState(directory);
  mkdirSync(join(directory, 'repo'), { recursive: true });
  const project = workspace.openProject(join(directory, 'repo'));
  const captain = workspace.createThread(sessions, project, {
    title: 'Ship the empty state', provider: 'fake', model: 'fake', role: 'captain',
  });
  return { ctx, sessions, workspace, project, captain };
}

interface Bench {
  ctx: Context;
  sessions: SessionStore;
  workspace: WorkspaceState;
  project: ReturnType<WorkspaceState['openProject']>;
  captain: ThreadRow;
}

function worker(bench: Bench, title: string, role: ThreadRole = 'worker'): ThreadRow {
  return bench.workspace.createThread(bench.sessions, bench.project, {
    title, provider: 'fake', model: 'fake', role, captainId: bench.captain.id, branch: `extendo/${title}`,
  });
}

function turn(sessions: SessionStore, sessionId: string, turnId: string, content: string) {
  sessions.appendMany(sessionId, [
    { type: 'turn/start', data: { turnId, provider: 'fake', model: 'fake' } },
    { type: 'step/start', data: { turnId, stepId: `${turnId}-step` } },
    { type: 'assistant/message', data: { turnId, stepId: `${turnId}-step`, messageId: `${turnId}-assistant`, content } },
    { type: 'step/end', data: { turnId, stepId: `${turnId}-step`, outcome: 'completed' } },
    { type: 'turn/end', data: { turnId, outcome: 'completed' } },
  ]);
}

const wakes = (sessions: SessionStore, sessionId: string) =>
  sessions.replay(sessionId).filter((event) => event.type === 'crew/wake');

const row = (bench: Bench, id: string) => bench.workspace.thread(id)!;

function crewOf(bench: Bench, options: Partial<CrewOptions> = {}) {
  const agent = fakeAgent();
  const crew = new CrewService({ ctx: bench.ctx, workspace: bench.workspace, sessions: bench.sessions, agent: agent.agent, git, ...options });
  return { crew, ...agent };
}

describe('CrewService', () => {
  it('records a worker turn end as one durable wake and starts the captain once', async () => {
    const bench = makeBench();
    const { crew, started } = crewOf(bench);
    await crew.whenReady();
    const copy = worker(bench, 'Rework the copy');

    turn(bench.sessions, copy.sessionId, 'turn-copy', 'The empty state names the query now.');

    await vi.waitFor(() => expect(wakes(bench.sessions, bench.captain.sessionId)).toHaveLength(1));
    const [wake] = wakes(bench.sessions, bench.captain.sessionId);
    expect(wake?.data).toMatchObject({
      workerId: copy.id, turnId: 'turn-copy', outcome: 'completed', report: 'The empty state names the query now.',
    });
    expect(bench.workspace.thread(copy.id)?.report).toBe('The empty state names the query now.');
    await vi.waitFor(() => expect(started.filter(({ sessionId }) => sessionId === bench.captain.sessionId)).toHaveLength(1));
    await crew.close();
  });

  it('does not record the same worker turn twice', async () => {
    const bench = makeBench();
    const { crew } = crewOf(bench);
    await crew.whenReady();
    const copy = worker(bench, 'Rework the copy');

    turn(bench.sessions, copy.sessionId, 'turn-copy', 'First report.');
    await vi.waitFor(() => expect(wakes(bench.sessions, bench.captain.sessionId)).toHaveLength(1));
    bench.sessions.append(copy.sessionId, { type: 'turn/end', data: { turnId: 'turn-copy', outcome: 'completed' } });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wakes(bench.sessions, bench.captain.sessionId)).toHaveLength(1);
    await crew.close();
  });

  it('delivers a wake on boot when the captain never ran its turn', async () => {
    const first = makeBench();
    const one = crewOf(first);
    await one.crew.whenReady();
    const copy = worker(first, 'Rework the copy');
    turn(first.sessions, copy.sessionId, 'turn-copy', 'The copy is ready.');
    await vi.waitFor(() => expect(wakes(first.sessions, first.captain.sessionId)).toHaveLength(1));
    await one.crew.close();
    first.workspace.close();
    first.sessions.close();

    const ctx = new Context();
    const sessions = new SessionStore(directory, ctx);
    const workspace = new WorkspaceState(directory);
    const agent = fakeAgent();
    const reopened = new CrewService({ ctx, workspace, sessions, agent: agent.agent, git });
    await reopened.whenReady();

    expect(wakes(sessions, first.captain.sessionId)).toHaveLength(1);
    expect(agent.started.filter(({ sessionId }) => sessionId === first.captain.sessionId)).toHaveLength(1);
    await reopened.close();
    workspace.close();
    sessions.close();
  });

  it('does not wake a captain again for a turn its log already consumed', async () => {
    const first = makeBench();
    const one = crewOf(first);
    await one.crew.whenReady();
    const copy = worker(first, 'Rework the copy');
    turn(first.sessions, copy.sessionId, 'turn-copy', 'The copy is ready.');
    await vi.waitFor(() => expect(wakes(first.sessions, first.captain.sessionId)).toHaveLength(1));
    expect(one.started).toHaveLength(1);
    turn(first.sessions, first.captain.sessionId, 'turn-captain', 'I read the report and filed a review.');
    await one.crew.close();
    first.workspace.close();
    first.sessions.close();

    const ctx = new Context();
    const sessions = new SessionStore(directory, ctx);
    const workspace = new WorkspaceState(directory);
    const agent = fakeAgent();
    const reopened = new CrewService({ ctx, workspace, sessions, agent: agent.agent, git });
    await reopened.whenReady();

    expect(wakes(sessions, first.captain.sessionId)).toHaveLength(1);
    expect(agent.started).toHaveLength(0);
    await reopened.close();
    workspace.close();
    sessions.close();
  });

  it('starts a worker in its own worktree and refuses past the crew cap', async () => {
    const bench = makeBench();
    const { crew, started } = crewOf(bench, { maxCrew: 1 });
    await crew.whenReady();

    const created = await crew.create(row(bench, bench.captain.id), { title: 'Rework the empty state', brief: 'Name the query.' });
    const createdRow = row(bench, created.threadId);
    expect(createdRow.role).toBe('worker');
    expect(createdRow.captainId).toBe(bench.captain.id);
    expect(createdRow.worktree).toBe(join(directory, 'worktrees', 'rework-the-empty-state'));
    expect(createdRow.branch).toBe('extendo/rework-the-empty-state');
    expect(createdRow.cwd).toBe(createdRow.worktree);
    expect(started).toHaveLength(1);
    expect(started[0]?.options.interactive).toBe(false);

    await expect(crew.create(row(bench, bench.captain.id), { title: 'Another worker', brief: 'Anything.' }))
      .rejects.toThrow(/Crew cap reached: 1 concurrent worker/);
    await crew.close();
  });

  it('archives a worker without deleting its branch', async () => {
    const bench = makeBench();
    const { crew, agent, cancelled } = crewOf(bench);
    await crew.whenReady();
    const copy = worker(bench, 'Rework the copy');

    const archived = await crew.archive(row(bench, bench.captain.id), copy.id);
    expect(archived).toEqual({ threadId: copy.id, archived: true });
    expect(cancelled).toEqual([copy.sessionId]);
    expect(bench.workspace.thread(copy.id)?.archived).toBe(true);
    expect(bench.workspace.thread(copy.id)?.branch).toBe(copy.branch);
    expect(await crew.list(row(bench, bench.captain.id))).toHaveLength(0);
    const viewer = new ThreadViewer({ workspace: bench.workspace, sessions: bench.sessions, agent });
    expect((await viewer.list()).map(({ id }) => id)).not.toContain(copy.id);
    await crew.close();
  });

  it('files issues with project numbers, moves their state, and keeps them on their own captain', async () => {
    const bench = makeBench();
    const other = worker(bench, 'Another captain', 'captain');
    const { crew } = crewOf(bench);
    await crew.whenReady();
    const captain = row(bench, bench.captain.id);
    const copy = worker(bench, 'Rework the copy');

    const issue = await crew.createIssue(captain, { title: 'Confirm the copy with design', body: 'Design should confirm the wording.' });
    expect(issue).toMatchObject({ number: 1, state: 'open', captainId: captain.id, projectId: bench.project.id });

    const moved = await crew.updateIssue(captain, issue.id, { state: 'needs-you', assigneeId: copy.id });
    expect(moved).toMatchObject({ state: 'needs-you', assigneeId: copy.id });

    const comment = await crew.commentIssue(captain, issue.id, 'Design is booked for Thursday.');
    expect(comment.author).toBe(captain.id);
    const read = await crew.readIssue(captain, issue.id);
    expect(read.comments).toEqual([comment]);

    await expect(crew.updateIssue(row(bench, other.id), issue.id, { state: 'done' })).rejects.toThrow(/Unknown issue/);
    await expect(crew.readIssue(row(bench, other.id), issue.id)).rejects.toThrow(/Unknown issue/);
    expect(await crew.issues(captain)).toHaveLength(1);
    await crew.close();
  });

  it('does not queue another wake when the worker finished during the captain\'s own turn', async () => {
    const bench = makeBench();
    const statuses = new Map<string, AgentStatus>();
    const agent = fakeAgent((sessionId) => statuses.get(sessionId) ?? 'idle');
    const crew = new CrewService({ ctx: bench.ctx, workspace: bench.workspace, sessions: bench.sessions, agent: agent.agent, git });
    await crew.whenReady();
    const copy = worker(bench, 'Rework the copy');

    statuses.set(bench.captain.sessionId, 'working');
    turn(bench.sessions, copy.sessionId, 'turn-copy', 'The copy is ready.');
    await vi.waitFor(() => expect(wakes(bench.sessions, bench.captain.sessionId)).toHaveLength(1));
    expect(agent.started).toHaveLength(0);

    statuses.set(bench.captain.sessionId, 'idle');
    turn(bench.sessions, bench.captain.sessionId, 'turn-captain', 'Both reports read; nothing else needs me.');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wakes(bench.sessions, bench.captain.sessionId)).toHaveLength(1);
    expect(agent.started).toHaveLength(0);
    await crew.close();
  });

  it('steers a running worker and starts a turn for an idle one', async () => {
    const bench = makeBench();
    const statuses = new Map<string, AgentStatus>();
    const agent = fakeAgent((sessionId) => statuses.get(sessionId) ?? 'idle');
    const crew = new CrewService({ ctx: bench.ctx, workspace: bench.workspace, sessions: bench.sessions, agent: agent.agent, git });
    await crew.whenReady();
    const copy = worker(bench, 'Rework the copy');
    const captain = row(bench, bench.captain.id);

    statuses.set(copy.sessionId, 'working');
    expect(await crew.message(captain, copy.id, 'Keep the clear-filters button.')).toEqual({ threadId: copy.id, delivered: 'steer' });
    expect(agent.steered).toEqual([{ sessionId: copy.sessionId, input: 'Keep the clear-filters button.' }]);
    expect(agent.started).toHaveLength(0);

    statuses.set(copy.sessionId, 'idle');
    expect(await crew.message(captain, copy.id, 'Now add the changelog note.')).toEqual({ threadId: copy.id, delivered: 'turn' });
    expect(agent.started).toHaveLength(1);
    expect(agent.started[0]?.sessionId).toBe(copy.sessionId);
    await crew.close();
  });

  it('returns a timed-out result from crew.wait instead of blocking forever', async () => {
    const bench = makeBench();
    const statuses = new Map<string, AgentStatus>();
    const agent = fakeAgent((sessionId) => statuses.get(sessionId) ?? 'idle');
    const crew = new CrewService({ ctx: bench.ctx, workspace: bench.workspace, sessions: bench.sessions, agent: agent.agent, git });
    await crew.whenReady();
    const copy = worker(bench, 'Rework the copy');
    statuses.set(copy.sessionId, 'working');

    const results = await crew.wait(row(bench, bench.captain.id), [copy.id], 10, new AbortController().signal);
    expect(results).toEqual([expect.objectContaining({ threadId: copy.id, timedOut: true, status: 'working' })]);
    await crew.close();
  });

  it('gives a captain and its workers their role instructions in the system prompt', async () => {
    const runtime = await createRuntime({ mode: 'web', dataDir: join(directory, 'runtime') });
    const sections = runtime.ctx.get<Registry<SystemSection>>('system');
    const prompt = async (sessionId: string) => {
      const session = runtime.sessions.get(sessionId)!;
      const texts = await Promise.all(sections.list().map((section) => section.text({ session, turnId: 'turn-1', stepId: 'step-1' })));
      return texts.filter((text) => text.trim()).join('\n\n');
    };
    const rows = runtime.workspace.threads();
    const captain = rows.find(({ role }) => role === 'captain')!;
    const copy = rows.find(({ role, title }) => role === 'worker' && title === 'Rework the empty-state copy')!;
    const standalone = rows.find(({ role }) => role !== 'captain' && role !== 'worker')!;

    expect(await prompt(captain.sessionId)).toContain('You are a captain.');
    expect(await prompt(copy.sessionId)).toContain('You are a worker on a captain');
    expect(await prompt(standalone.sessionId)).not.toContain('You are a captain.');
    await runtime.close();
  });

  it('keeps crew tools captain-only', async () => {
    const bench = makeBench();
    const { crew } = crewOf(bench);
    await crew.whenReady();
    const copy = worker(bench, 'Rework the copy');
    const list = crewTools(crew).find(({ name }) => name === 'crew.list')!;

    await expect(list.execute({}, { sessionId: copy.sessionId } as never)).rejects.toThrow(/only available to a captain/);
    const listed = await list.execute({}, { sessionId: bench.captain.sessionId } as never) as { crew: { threadId: string }[] };
    expect(listed.crew.map(({ threadId }) => threadId)).toEqual([copy.id]);
    await crew.close();
  });
});
