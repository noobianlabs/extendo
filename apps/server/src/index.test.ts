import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { ApprovalRequest, RpcRequest, RpcResponse, RpcServerFrame, SessionSnapshot, Thread } from '@extendo/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type ExtendoServer } from './index.js';

let directory: string;
let server: ExtendoServer;
let sockets: WebSocket[];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'extendo-server-'));
  const webRoot = join(directory, 'web');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><p>Extendo fixture</p>');
  writeFileSync(join(webRoot, 'assets', 'sample.js'), 'console.log("fixture");');
  server = await startServer({ dataDir: directory, port: 0, env: {}, webRoot });
  sockets = [];
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  await server.close();
  rmSync(directory, { recursive: true, force: true });
});

async function connect() {
  const ws = new WebSocket(server.url.replace('http', 'ws') + '/ws', { origin: server.url });
  sockets.push(ws);
  await once(ws, 'open');
  const frames: RpcServerFrame[] = [];
  ws.on('message', (raw) => { frames.push(JSON.parse(String(raw)) as RpcServerFrame); });
  const send = (request: RpcRequest) => ws.send(JSON.stringify(request));
  return { send, frames };
}

async function firstThread() {
  const response = await fetch(server.url + '/api/threads');
  const threads = await response.json() as Thread[];
  expect(threads[0]?.title).toBe('Make empty search results useful');
  return threads[0]!;
}

describe('Extendo transport', () => {
  it('serves health, static files, seeded thread history, and rejects untrusted origins', async () => {
    expect(await (await fetch(server.url + '/api/health')).json()).toEqual({ ok: true });
    expect(await (await fetch(server.url)).text()).toContain('Extendo fixture');
    expect(await (await fetch(server.url + '/assets/sample.js')).text()).toContain('console.log');
    expect((await fetch(server.url + '/api/missing')).status).toBe(404);
    expect((await fetch(server.url + '/api/threads', { headers: { Origin: 'https://example.test' } })).status).toBe(403);
    const thread = await firstThread();
    const snapshot = await (await fetch(server.url + '/api/sessions/' + thread.sessionId)).json() as SessionSnapshot;
    expect(snapshot.messages.some((message) => message.role === 'assistant' && message.tools.some(({ call }) => call.name === 'demo_edit'))).toBe(true);
    expect((await (await fetch(`${server.url}/api/sessions/${thread.sessionId}/events?afterSeq=${snapshot.lastSeq}`)).json())).toEqual({ events: [], lastSeq: snapshot.lastSeq });
  });

  it('replays after a cursor, streams a new turn, and answers an actual approval', async () => {
    const { sessionId } = await firstThread();
    const { send, frames } = await connect();
    const afterSeq = server.runtime.sessions.lastSeq(sessionId) - 1;
    send({ id: 1, method: 'subscribe', params: { sessionId, afterSeq } });
    await vi.waitFor(() => expect(frames[1]).toMatchObject({ event: 'session/event', data: { event: { seq: afterSeq + 1 } } }));
    send({ id: 2, method: 'send-message', params: { sessionId, content: 'Try the demo patch' } });
    await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ event: 'assistant/delta' })));
    const started = frames.find((frame): frame is Extract<RpcResponse<'send-message'>, { result: unknown }> =>
      'id' in frame && frame.id === 2 && 'result' in frame,
    );
    expect(started).toBeDefined();
    const approval = await vi.waitFor(() => {
      const entry = frames.find((frame) => 'event' in frame && frame.event === 'tool/approval');
      expect(entry).toBeDefined();
      return (entry as { data: ApprovalRequest }).data;
    }, 5000);
    const resumed = await connect();
    send({ id: 3, method: 'answer-approval', params: { sessionId, requestId: 'not-pending', decision: 'allow' } });
    resumed.send({ id: 6, method: 'subscribe', params: { sessionId, afterSeq: server.runtime.sessions.lastSeq(sessionId) } });
    await vi.waitFor(() => expect(resumed.frames[0]).toMatchObject({ id: 6, result: { status: 'waiting', approvals: [approval] } }));
    resumed.send({ id: 4, method: 'answer-approval', params: { sessionId, requestId: approval.requestId, decision: 'allow' } });
    await vi.waitFor(() => {
      expect(frames).toContainEqual({ id: 3, result: { accepted: false } });
      expect(resumed.frames).toContainEqual({ id: 4, result: { accepted: true } });
      expect(frames).toContainEqual(expect.objectContaining({ event: 'session/event', data: expect.objectContaining({
        event: expect.objectContaining({ type: 'turn/end', data: expect.objectContaining({ turnId: started?.result.turnId, outcome: 'completed' }) }),
      }) }));
    }, 5000);
    expect(server.runtime.sessions.snapshot(sessionId).messages.at(-1)).toMatchObject({ content: expect.stringContaining('No files on your machine were changed') });
  }, 12_000);

  it('cancels a running stream and emits the durable cancelled turn', async () => {
    const { sessionId } = await firstThread();
    const { send, frames } = await connect();
    send({ id: 1, method: 'subscribe', params: { sessionId, afterSeq: server.runtime.sessions.lastSeq(sessionId) } });
    send({ id: 2, method: 'send-message', params: { sessionId, content: 'Cancel this demonstration' } });
    await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ event: 'assistant/delta' })));
    send({ id: 3, method: 'cancel', params: { sessionId } });
    await vi.waitFor(() => {
      expect(frames).toContainEqual({ id: 3, result: { cancelled: true } });
      expect(frames).toContainEqual(expect.objectContaining({ event: 'session/event', data: expect.objectContaining({
        event: expect.objectContaining({ type: 'turn/end', data: expect.objectContaining({ outcome: 'cancelled' }) }),
      }) }));
    });
  });
});
