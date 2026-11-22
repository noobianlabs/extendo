import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { rpcRequestSchema, type RpcEventName, type RpcId, type RpcServerFrame } from '@extendo/contracts';
import { allowsUpgrade } from './http.js';
import type { Runtime } from './runtime.js';

const liveEvents: RpcEventName[] = ['session/event', 'agent/status', 'agent/error', 'assistant/delta', 'assistant/tool-call', 'tool/approval', 'tool/approval-answered'];

export function attachRpc(server: Server, runtime: Runtime, devOrigins?: string[]): () => Promise<void> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  const subscriptions = new Map<WebSocket, Set<string>>();
  const listeners = liveEvents.map((name) =>
    runtime.ctx.on(name, (data) => {
      for (const [peer, sessions] of subscriptions) {
        if (sessions.has(data.sessionId)) send(peer, { event: name, data } as RpcServerFrame);
      }
    }),
  );
  function send(peer: WebSocket, frame: RpcServerFrame) {
    if (peer.readyState !== WebSocket.OPEN) return;
    if (peer.bufferedAmount > 4 * 1024 * 1024) {
      peer.close(1013, 'Reconnect and resume from your last event cursor');
      return;
    }
    peer.send(JSON.stringify(frame));
  }

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url?.split('?')[0] !== '/ws' || !allowsUpgrade(request, devOrigins)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (peer) => wss.emit('connection', peer, request));
  };
  server.on('upgrade', upgrade);
  wss.on('connection', (peer) => {
    const listening = new Set<string>();
    subscriptions.set(peer, listening);
    peer.on('close', () => subscriptions.delete(peer));
    peer.on('error', () => subscriptions.delete(peer));
    peer.on('message', (raw, binary) => {
      let value: unknown;
      let id: RpcId | null = null;
      const error = (code: string, message: string) => send(peer, { id, error: { code, message } });
      if (binary) { error('INVALID_REQUEST', 'Expected a text frame'); return; }
      try { value = JSON.parse(String(raw)); }
      catch { error('INVALID_JSON', 'Expected a JSON object'); return; }
      if (value && typeof value === 'object' && 'id' in value) {
        const candidate = value.id;
        if ((typeof candidate === 'string' && candidate.length <= 128) || (typeof candidate === 'number' && Number.isSafeInteger(candidate))) id = candidate;
      }
      const parsed = rpcRequestSchema.safeParse(value);
      if (!parsed.success) { error('INVALID_REQUEST', 'Invalid RPC method or parameters'); return; }
      const request = parsed.data;
      const sessionId = request.params.sessionId;
      const { sessions, workspace, agent } = runtime;
      if (!sessions.get(sessionId)) { error('NOT_FOUND', 'Unknown session'); return; }
      try {
        switch (request.method) {
          case 'subscribe': {
            const after = request.params.afterSeq ?? 0;
            listening.add(sessionId);
            send(peer, { id: request.id, result: { lastSeq: sessions.lastSeq(sessionId), status: agent.status(sessionId), approvals: agent.approvals(sessionId) } });
            for (const event of sessions.replay(sessionId, after)) send(peer, { event: 'session/event', data: { sessionId, event } });
            break;
          }
          case 'unsubscribe':
            listening.delete(sessionId);
            send(peer, { id: request.id, result: { ok: true } });
            break;
          case 'send-message': {
            const thread = workspace.threadBySession(agent, sessionId);
            const settings = workspace.settings();
            const provider = request.params.provider ?? thread?.provider ?? settings.provider;
            const model = request.params.model ?? (thread?.provider === provider ? thread.model : settings.provider === provider ? settings.model : undefined);
            const selection = runtime.model(provider, model);
            const turn = agent.start(sessionId, request.params.content, { ...selection, interactive: true });
            if (thread && (thread.provider !== selection.provider || thread.model !== selection.model)) workspace.updateThreadModel(sessionId, selection.provider, selection.model);
            void turn.done.catch(() => runtime.ctx.logger.error('Turn could not be settled'));
            send(peer, { id: request.id, result: { turnId: turn.turnId } });
            break;
          }
          case 'cancel':
            send(peer, { id: request.id, result: { cancelled: agent.cancel(sessionId) } });
            break;
          case 'answer-approval':
            send(peer, { id: request.id, result: { accepted: agent.answer(sessionId, request.params.requestId, request.params.decision) } });
            break;
        }
      } catch (failure) {
        error('REQUEST_FAILED', failure instanceof Error ? failure.message : 'Extendo could not complete the request');
      }
    });
  });

  return () => new Promise<void>((resolve, reject) => {
    server.off('upgrade', upgrade);
    for (const dispose of listeners) dispose();
    for (const peer of wss.clients) peer.terminate();
    wss.close((error) => error ? reject(error) : resolve());
  });
}
