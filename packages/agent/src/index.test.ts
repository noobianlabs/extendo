import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelChunk, ModelRequest, Provider, Registry, Tool } from '@extendo/contracts';
import { PluginLoader } from '@extendo/kernel';
import { sessionPlugin, type SessionStore } from '@extendo/session';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
