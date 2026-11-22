import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RpcRequest, RpcServerFrame, Thread } from '@extendo/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type ExtendoServer } from './index.js';

let directory: string;
let server: ExtendoServer;
let sockets: WebSocket[];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'extendo-swarm-'));
  const webRoot = join(directory, 'web');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><p>Extendo fixture</p>');
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
  return { frames, send: (request: RpcRequest) => ws.send(JSON.stringify(request)) };
}

const snapshots = (frames: RpcServerFrame[]) => frames.flatMap((frame) =>
  'event' in frame && frame.event === 'thread/updated' ? [frame.data.thread] : []);

it('runs a delegated swarm: queues tracks, blocks on approval, accepts a steer, and finishes', async () => {
  const threads = await (await fetch(server.url + '/api/threads')).json() as Thread[];
  const thread = threads.find(({ title }) => title.startsWith('Audit empty-state copy'));
  expect(thread).toBeDefined();
  const { send, frames } = await connect();
  send({ id: 1, method: 'subscribe', params: { sessionId: thread!.sessionId } });
  await vi.waitFor(() => expect(frames.some((frame) => 'id' in frame && frame.id === 1)).toBe(true));

  send({ id: 2, method: 'send-message', params: { sessionId: thread!.sessionId, content: 'Run the three tracks in parallel' } });

  const waiting = await vi.waitFor(() => {
    const snapshot = snapshots(frames)
      .map(({ subagents }) => subagents?.find(({ state }) => state === 'waiting-approval'))
      .find(Boolean);
    expect(snapshot).toBeDefined();
    return snapshot!;
  }, 20_000);
  expect(waiting.approval?.call.name).toBe('demo_edit');

  const queued = snapshots(frames).at(-1)?.subagents?.find(({ state }) => state === 'queued');
  expect(queued?.position).toBe(1);

  send({ id: 3, method: 'subagent-steer', params: { sessionId: thread!.sessionId, subagentId: waiting.id, message: 'Keep the clear-filters button' } });
  await vi.waitFor(() => expect(frames).toContainEqual({ id: 3, result: { steered: true } }));

  send({ id: 4, method: 'answer-approval', params: { sessionId: waiting.sessionId, requestId: waiting.approval!.requestId, decision: 'allow' } });
  await vi.waitFor(() => expect(frames).toContainEqual({ id: 4, result: { accepted: true } }));

  await vi.waitFor(() => {
    const swarm = snapshots(frames).at(-1)?.subagents ?? [];
    expect(swarm.length).toBeGreaterThanOrEqual(5);
    expect(swarm.every(({ state }) => state === 'done')).toBe(true);
  }, 25_000);

  expect(frames).toContainEqual(expect.objectContaining({
    event: 'session/event',
    data: expect.objectContaining({ event: expect.objectContaining({ type: 'subagent/steered' }) }),
  }));
  const final = await (await fetch(server.url + '/api/threads')).json() as Thread[];
  expect(final.find(({ id }) => id === thread!.id)?.state).toBe('waiting-review');
}, 40_000);
