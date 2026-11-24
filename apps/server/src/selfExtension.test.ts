import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Extension, ExtensionState, LiveTool, SessionSnapshot, Thread } from '@extendo/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type ExtendoServer } from './index.js';

let directory: string;
let server: ExtendoServer;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'extendo-self-'));
  const webRoot = join(directory, 'web');
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><p>Extendo</p>');
  server = await startServer({ dataDir: directory, port: 0, env: {}, webRoot });
});

afterEach(async () => {
  await server.close();
  rmSync(directory, { recursive: true, force: true });
});

async function boot(instance: ExtendoServer) {
  const threads = await (await fetch(instance.url + '/api/threads')).json() as Thread[];
  return threads[0]!;
}

async function post(path: string, body: unknown, method = 'POST') {
  return fetch(server.url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function calledTools(snapshot: SessionSnapshot) {
  return snapshot.messages.flatMap((message) => message.role === 'assistant' ? message.tools : []);
}

describe('self-extension loop', () => {
  it('lets the agent call a tool that exists only because a plugin was saved', async () => {
    const thread = await boot(server);
    const prompt = 'Use the word_count plugin tool on this sentence.';

    await server.runtime.agent.start(thread.sessionId, prompt, { provider: 'demo', model: 'demo', interactive: true }).done;
    expect(calledTools(server.runtime.sessions.snapshot(thread.sessionId)).map(({ call }) => call.name)).not.toContain('word_count');

    const created = await (await post('/api/extensions', { name: 'Word count' })).json() as { extension: Extension; state: ExtensionState };
    expect(created.extension.error).toBeUndefined();
    expect(created.extension.tools.map(({ name }) => name)).toEqual(['word_count']);

    const live = await (await fetch(server.url + '/api/extensions/tools')).json() as { tools: LiveTool[] };
    expect(live.tools.find(({ name }) => name === 'word_count')?.extensionId).toBe('word-count');
    expect(live.tools.find(({ name }) => name === 'demo_read')?.extensionId).toBeUndefined();

    const turn = await server.runtime.agent.start(thread.sessionId, prompt, { provider: 'demo', model: 'demo', interactive: true }).done;
    expect(turn.outcome).toBe('completed');

    const call = calledTools(server.runtime.sessions.snapshot(thread.sessionId)).find(({ call }) => call.name === 'word_count');
    expect(call?.result?.isError).toBe(false);
    expect(call?.result?.output).toMatchObject({ words: expect.any(Number), characters: expect.any(Number) });
  });

  it('keeps the running revision live when a save does not load, and says why', async () => {
    const created = await (await post('/api/extensions', { name: 'Word count' })).json() as { extension: Extension };
    expect(created.extension.id).toBe('word-count');

    const failed = await post('/api/extensions/word-count', { source: 'export default ({' }, 'PUT');
    expect(failed.status).toBe(422);
    const body = await failed.json() as { extension: Extension; error: string };
    expect(body.error).toBeTruthy();
    expect(body.extension.revision).toBe(1);

    const live = await (await fetch(server.url + '/api/extensions/tools')).json() as { tools: LiveTool[] };
    expect(live.tools.find(({ name }) => name === 'word_count')?.extensionId).toBe('word-count');

    const repaired = await post('/api/extensions/word-count', { source: (body.extension.source).replaceAll('word_count', 'word_tally') }, 'PUT');
    expect(repaired.status).toBe(200);
    const saved = await repaired.json() as { extension: Extension; state: ExtensionState };
    expect(saved.extension.revision).toBe(3);
    expect(saved.extension.tools.map(({ name }) => name)).toEqual(['word_tally']);
    expect(saved.state.mounts.map(({ revision }) => revision)).toEqual([1, 3]);
  });

  it('mounts the plugins already on disk when the server starts again', async () => {
    await post('/api/extensions', { name: 'Word count' });
    await server.close();

    server = await startServer({ dataDir: directory, port: 0, env: {}, webRoot: join(directory, 'web') });
    const live = await (await fetch(server.url + '/api/extensions/tools')).json() as { tools: LiveTool[] };
    expect(live.tools.find(({ name }) => name === 'word_count')?.extensionId).toBe('word-count');
    const state = await (await fetch(server.url + '/api/extensions')).json() as ExtensionState;
    expect(state.mounts.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a plugin request from a foreign origin', async () => {
    const response = await fetch(server.url + '/api/extensions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://example.test' },
      body: JSON.stringify({ name: 'Word count' }),
    });
    expect(response.status).toBe(403);
  });
});
