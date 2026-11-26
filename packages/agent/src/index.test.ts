import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelChunk, ModelRequest, Provider, Registry, Tool } from '@extendo/contracts';
import { PluginLoader } from '@extendo/kernel';
import { sessionPlugin, type SessionStore } from '@extendo/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agentPlugin, capabilitiesPlugin, type AgentRuntime, type SystemSection } from './index.js';

let directory: string;
let loader: PluginLoader;
let store: SessionStore;
let agent: AgentRuntime;
let sessionId: string;
let seen: ModelRequest[];

async function provider(steps: ModelChunk[][]) {
  let next = 0;
  await loader.mount({ name: 'scripted', apply(ctx) {
    ctx.get<Registry<Provider>>('providers').register(ctx, 'scripted', {
      id: 'scripted',
      async *stream(request) {
        seen.push(request);
        yield* steps[next++] ?? [{ type: 'error', message: 'Unexpected model request' }];
      },
    });
  } });
}

const options = { provider: 'scripted', model: 'test' };
const done = { type: 'done' } as const;
const text = (delta: string) => ({ type: 'text-delta', delta }) as const;
const call = { type: 'tool-call', call: { id: 'call-1', name: 'sample', input: { path: 'notes.md' } } } as const;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'extendo-agent-'));
  loader = new PluginLoader();
  await loader.mountAll([agentPlugin({ contextChars: 600 }), capabilitiesPlugin(), sessionPlugin(directory)]);
  agent = loader.ctx.get('agent');
  store = loader.ctx.get('sessions');
  sessionId = store.create({ title: 'Example', cwd: directory }).id;
  seen = [];
});

afterEach(async () => {
  await agent.shutdown();
  loader.dispose();
  rmSync(directory, { recursive: true, force: true });
});

interface Gate<T> { promise: Promise<T>; release(value: T): void }

function gate<T = void>(): Gate<T> {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}

/** A provider whose stream blocks on a gate, so a test can steer a turn that is genuinely running. */
async function holdableProvider(name: string, first: (request: ModelRequest) => AsyncGenerator<ModelChunk>, rest: () => ModelChunk[]) {
  await loader.mount({ name, apply(ctx) {
    let requests = 0;
    ctx.get<Registry<Provider>>('providers').register(ctx, name, {
      id: name,
      async *stream(request) {
        seen.push(request);
        requests += 1;
        if (requests === 1) { yield* first(request); return; }
        yield* rest();
      },
    });
  } });
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new Error('Turn cancelled'));
    signal.addEventListener('abort', () => reject(new Error('Turn cancelled')), { once: true });
  });
}

describe('agent loop', () => {
  it('assembles prompt and tools, then runs a multi-step turn in durable order', async () => {
    await provider([[{ type: 'reasoning-delta', delta: 'inspect' }, text('Looking.'), call, done], [text('Found the notes.'), { type: 'usage', usage: { outputTokens: 3 } }, done]]);
    const order: string[] = [];
    const ctx = loader.ctx;
    ctx.get<Registry<SystemSection>>('system').register(ctx, 'base', { name: 'base', text: () => 'Use tools when needed.' });
    ctx.get<Registry<Tool>>('tools').register(ctx, 'sample', {
      name: 'sample', description: 'Read a note', input: z.object({ path: z.string() }), readOnly: true,
      async execute(input) { order.push('tool'); return input; },
    });
    ctx.onWaterfall('tools/pre-execute', (value, next) => { order.push('pre'); return next(value); });
    ctx.onWaterfall('tools/execute', (value, next) => { order.push('execute'); return next(value); });
    ctx.onWaterfall('tools/post-execute', (value, next) => { order.push('post'); return next(value); });
    const deltas: string[] = [];
    ctx.on('assistant/delta', ({ kind, delta }) => { deltas.push(kind + ':' + delta); });
    const turn = agent.start(sessionId, 'Find the notes', options);
    expect(() => agent.start(sessionId, 'Another task', options)).toThrow('active turn');
    expect(await turn.done).toMatchObject({ outcome: 'completed', final: 'Found the notes.' });
    expect(agent.status(sessionId)).toBe('idle');
    expect(order).toEqual(['pre', 'execute', 'tool', 'post']);
    expect(deltas).toEqual(['reasoning:inspect', 'text:Looking.', 'text:Found the notes.']);
    expect(seen[0]).toMatchObject({ system: ['Use tools when needed.'], tools: [{ name: 'sample', inputSchema: { type: 'object' } }], messages: [{ role: 'user', content: 'Find the notes' }] });
    expect(seen[1]?.messages).toMatchObject([{ role: 'user' }, { role: 'assistant', toolCalls: [call.call] }, { role: 'tool', result: { output: { path: 'notes.md' } } }]);
    expect(store.replay(sessionId).map(({ type }) => type)).toEqual([
      'session/created', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'step/end', 'turn/end',
    ]);
  });

  it('pauses before mutating, accepts answers only for the owning session, and honours denial', async () => {
    await provider([[call, done], [text('The tool was skipped.'), done]]);
    let writes = 0;
    const ctx = loader.ctx;
    ctx.get<Registry<Tool>>('tools').register(ctx, 'sample', {
      name: 'sample', description: 'Write a note', input: z.object({ path: z.string() }), needsApproval: true,
      async execute() { return ++writes; },
    });
    ctx.on('tool/approval', ({ requestId }) => {
      expect(agent.status(sessionId)).toBe('waiting');
      expect(writes).toBe(0);
      expect(agent.answer('another', requestId, 'allow')).toBe(false);
      expect(agent.approvals(sessionId)).toHaveLength(1);
      expect(agent.answer(sessionId, requestId, 'deny')).toBe(true);
      expect(agent.answer(sessionId, requestId, 'allow')).toBe(false);
    });
    expect(await agent.start(sessionId, 'Change the notes', { ...options, interactive: true }).done).toMatchObject({ outcome: 'completed' });
    expect(writes).toBe(0);
    expect(seen[1]?.messages.at(-1)).toMatchObject({ role: 'tool', result: { isError: true } });
  });

  it('cancels a pending approval and settles the interrupted tool call', async () => {
    await provider([[call, done]]);
    const ctx = loader.ctx;
    ctx.get<Registry<Tool>>('tools').register(ctx, 'sample', {
      name: 'sample', description: 'Write a note', input: z.unknown(),
      async execute() { throw new Error('Unapproved tool ran'); },
    });
    ctx.on('tool/approval', () => { expect(agent.cancel(sessionId)).toBe(true); });
    expect(await agent.start(sessionId, 'Change the notes', { ...options, interactive: true }).done).toMatchObject({ outcome: 'cancelled' });
    expect(agent.approvals(sessionId)).toEqual([]);
    expect(store.snapshot(sessionId).messages.at(-1)).toMatchObject({ tools: [{ result: { isError: true, output: 'Turn cancelled' } }] });
  });

  it('seals a failed stream attempt without adding it to the message projection', async () => {
    await provider([[text('Draft'), { type: 'error', message: 'Stream broke' }]]);
    expect(await agent.start(sessionId, 'Test a broken stream', options).done).toMatchObject({ outcome: 'failed', error: 'Stream broke' });
    expect(agent.status(sessionId)).toBe('failed');
    expect(store.replay(sessionId).find(({ type }) => type === 'assistant/attempt')).toMatchObject({ data: { content: 'Draft', error: 'Stream broke' } });
    expect(store.snapshot(sessionId).messages).toHaveLength(1);
  });

  it('compacts older completed turns without removing their visible messages', async () => {
    await provider([[text('First answer. '.repeat(100)), done], [text('Follow-up'), done]]);
    await agent.start(sessionId, 'First question', options).done;
    await agent.start(sessionId, 'Second question', options).done;
    expect(seen[1]?.system[0]).toContain('First question');
    expect(seen[1]?.messages).toEqual([{ role: 'user', content: 'Second question' }]);
    expect(store.replay(sessionId).some(({ type }) => type === 'context/compacted')).toBe(true);
    expect(store.snapshot(sessionId).messages).toHaveLength(4);
  });

  it('allows a pre-step policy to close a turn without a model request', async () => {
    await provider([]);
    loader.ctx.onWaterfall('agent/pre-step', (value) => ({ ...value, skip: true }));
    expect(await agent.start(sessionId, 'Skip', options).done).toMatchObject({ outcome: 'completed', final: '' });
    expect(seen).toHaveLength(0);
    expect(store.replay(sessionId).map(({ type }) => type)).toEqual(['session/created', 'turn/start', 'turn/end']);
  });
});

describe('steering a running turn', () => {
  it('delivers a queued steer exactly once, at the next step boundary', async () => {
    const started = gate();
    const finished = gate();
    await holdableProvider('held', async function* () {
      // Wait until the test has steered before the first step is admitted, then ask for a tool.
      await started.promise;
      yield text('Reading the empty state.');
      yield call;
      yield done;
    }, () => [text('Acted on the note at the boundary.'), done]);
    const ctx = loader.ctx;
    let running = false;
    ctx.get<Registry<Tool>>('tools').register(ctx, 'sample', {
      name: 'sample', description: 'Read a note', input: z.object({ path: z.string() }), readOnly: true,
      async execute(input) { running = true; await finished.promise; return input; },
    });
    const turn = agent.start(sessionId, 'Rework the empty state', { provider: 'held', model: 'test' });
    started.release();
    await vi.waitFor(() => expect(running).toBe(true));
    expect(agent.steer(sessionId, 'Keep the clear-filters action')).toBe(true);
    expect(agent.steer(sessionId, 'Keep the clear-filters action')).toBe(true);
    // Two identical steers are two inputs, so the boundary appends two messages, each of them once.
    finished.release();
    expect(await turn.done).toMatchObject({ outcome: 'completed' });
    const events = store.replay(sessionId);
    const steered = events.filter((event) => event.type === 'user/message' && event.data.content === 'Keep the clear-filters action');
    expect(steered).toHaveLength(2);
    const secondStep = events.findIndex((event) => event.type === 'step/start' && event.seq > steered[0]!.seq);
    expect(secondStep).toBeGreaterThan(-1);
    expect(steered.every((event) => event.seq < events[secondStep]!.seq)).toBe(true);
    expect(seen[1]?.messages.at(-1)).toMatchObject({ role: 'user', content: 'Keep the clear-filters action' });
  });

  it('ends an interrupted turn with a cancelled outcome and starts the new one from the message', async () => {
    await holdableProvider('held', async function* (request) {
      yield text('Reading the component before the change.');
      await aborted(request.signal);
    }, () => [text('Rewrote the copy the captain asked for.'), done]);
    const first = agent.start(sessionId, 'Rework the empty state', { provider: 'held', model: 'test' });
    await vi.waitFor(() => expect(store.replay(sessionId).some((event) => event.type === 'step/start')).toBe(true));
    const second = await agent.interrupt(sessionId, 'Stop and keep the original wording', { provider: 'held', model: 'test' });
    expect(await first.done).toMatchObject({ outcome: 'cancelled' });
    expect(await second.done).toMatchObject({ outcome: 'completed' });
    const events = store.replay(sessionId);
    const turns = events.filter((event) => event.type === 'turn/start').map((event) => event.data.turnId);
    expect(turns).toHaveLength(2);
    expect(events.filter((event) => event.type === 'turn/end').map((event) => event.data.outcome)).toEqual(['cancelled', 'completed']);
    const brief = events.filter((event) => event.type === 'user/message' && event.data.content === 'Stop and keep the original wording');
    expect(brief).toHaveLength(1);
    expect(brief[0]!.seq).toBeGreaterThan(events.find((event) => event.type === 'turn/end')!.seq);
    // The interrupted step's text is retained for diagnostics, not promoted to a completed answer.
    const attempt = events.find((event) => event.type === 'assistant/attempt');
    expect(attempt).toMatchObject({ data: { content: 'Reading the component before the change.' } });
    const firstTurnMessages = store.snapshot(sessionId).messages.filter((message) => message.role === 'assistant' && message.turnId === turns[0]);
    expect(firstTurnMessages).toHaveLength(0);
    expect(agent.status(sessionId)).toBe('idle');
  });

  it('interrupts a turn that is blocked on an approval, then answers the new turn', async () => {
    await holdableProvider('blocked', async function* () {
      yield call;
      yield done;
    }, () => [text('Left the notes alone.'), done]);
    const ctx = loader.ctx;
    ctx.get<Registry<Tool>>('tools').register(ctx, 'sample', {
      name: 'sample', description: 'Write a note', input: z.unknown(), needsApproval: true,
      async execute() { return { written: true }; },
    });
    const selection = { provider: 'blocked', model: 'test', interactive: true };
    const first = agent.start(sessionId, 'Change the notes', selection);
    await vi.waitFor(() => expect(agent.status(sessionId)).toBe('waiting'));
    const second = await agent.interrupt(sessionId, 'Do not change the notes', selection);
    expect(await first.done).toMatchObject({ outcome: 'cancelled' });
    expect(await second.done).toMatchObject({ outcome: 'completed', final: 'Left the notes alone.' });
    expect(agent.approvals(sessionId)).toEqual([]);
    expect(store.replay(sessionId).filter((event) => event.type === 'turn/end').map((event) => event.data.outcome)).toEqual(['cancelled', 'completed']);
  });
});
