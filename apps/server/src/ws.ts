import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { rpcRequestSchema, type RpcEventName, type RpcId, type RpcServerFrame, type Thread } from '@extendo/contracts';
import { decideOrigin, describeOrigin, resolveOriginPolicy, type OriginPolicy } from './origin.js';
import type { Runtime } from './runtime.js';

const liveEvents: RpcEventName[] = ['session/event', 'agent/status', 'agent/error', 'assistant/delta', 'tool/approval', 'tool/approval-answered', 'pull-request/updated'];

/**
 * Wires the browser client to the runtime: session-scoped live events, coalesced thread snapshots
 * for the status board, and the steering, stopping, and merging the console needs.
 */
export function attachRpc(server: Server, runtime: Runtime, policy: OriginPolicy = resolveOriginPolicy()): () => Promise<void> {
  const { sessions, workspace, agent, swarm, viewer } = runtime;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  const subscriptions = new Map<WebSocket, Set<string>>();
  const timers = new Set<NodeJS.Timeout>();

  function send(peer: WebSocket, frame: RpcServerFrame) {
    if (peer.readyState !== WebSocket.OPEN) return;
    if (peer.bufferedAmount > 4 * 1024 * 1024) {
      peer.close(1013, 'Reconnect and resubscribe');
      return;
    }
    peer.send(JSON.stringify(frame));
  }

  const listeners = liveEvents.map((name) => runtime.ctx.on(name, (data) => {
    if (!('sessionId' in data)) return;
    const { sessionId } = data as { sessionId: string };
    for (const [peer, sessionIds] of subscriptions) {
      if (sessionIds.has(sessionId)) send(peer, { event: name, data } as RpcServerFrame);
    }
    if (name === 'session/event') refresh(sessionId);
  }));

  let scheduled: NodeJS.Timeout | undefined;
  const dirty = new Set<string>();

  /**
   * Snapshots the threads a change touches. A worker's turn moves what its captain's crew row shows,
   * so the captain's snapshot goes out with it: without that, a captain sitting on its own page would
   * never see a worker start, finish, or take a steer without reloading.
   */
  async function snapshotsFor(ids: string[]): Promise<Map<string, Thread>> {
    const snapshots = new Map<string, Thread>();
    for (const id of ids) {
      const thread = await viewer.get(id).catch(() => undefined);
      if (!thread) continue;
      snapshots.set(id, thread);
      if (thread.role !== 'worker' || !thread.captainId) continue;
      const captain = workspace.thread(thread.captainId);
      if (!captain || snapshots.has(captain.sessionId)) continue;
      const snapshot = await viewer.get(captain.sessionId).catch(() => undefined);
      if (snapshot) snapshots.set(captain.sessionId, snapshot);
    }
    return snapshots;
  }

  function refresh(sessionId: string) {
    dirty.add(sessionId);
    if (scheduled) return;
    scheduled = setTimeout(() => {
      timers.delete(scheduled!);
      scheduled = undefined;
      const ids = [...dirty];
      dirty.clear();
      void snapshotsFor(ids).then((snapshots) => {
        for (const [target, thread] of snapshots) {
          for (const [peer, sessionIds] of subscriptions) {
            if (sessionIds.has(target)) send(peer, { event: 'thread/updated', data: { thread } });
          }
        }
      }).catch(() => {});
    }, 120);
    timers.add(scheduled);
  }

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const decision = decideOrigin(request.headers, policy);
    if (request.url?.split('?')[0] !== '/ws' || !decision.allowed) {
      if (request.url?.split('?')[0] === '/ws') runtime.ctx.logger.debug(`Rejected /ws upgrade from ${describeOrigin(decision)}`);
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
    peer.on('message', async (raw, binary) => {
      let value: unknown;
      let id: RpcId | null = null;
      const fail = (code: string, message: string) => send(peer, { id, error: { code, message } });
      if (binary) return fail('INVALID_REQUEST', 'Text frames only');
      try { value = JSON.parse(String(raw)); } catch { return fail('INVALID_JSON', 'Expected a JSON object'); }
      const parsed = rpcRequestSchema.safeParse(value);
      if (!parsed.success) return fail('INVALID_REQUEST', 'Unknown method or parameters');
      const request = parsed.data;
      id = request.id;
      const sessionId = request.params.sessionId;
      try {
        switch (request.method) {
          case 'subscribe': {
            listening.add(sessionId);
            send(peer, { id, result: { lastSeq: sessions.lastSeq(sessionId), status: agent.status(sessionId), approvals: agent.approvals(sessionId) } });
            for (const event of sessions.replay(sessionId, request.params.afterSeq)) send(peer, { event: 'session/event', data: { sessionId, event } });
            void viewer.get(sessionId).then((thread) => { if (thread) send(peer, { event: 'thread/updated', data: { thread } }); }).catch(() => {});
            return;
          }
          case 'unsubscribe': {
            listening.delete(sessionId);
            send(peer, { id, result: { ok: true } });
            return;
          }
          case 'send-message': {
            const thread = workspace.threadBySession(sessionId);
            const settings = workspace.settings();
            const provider = request.params.provider ?? thread?.provider ?? settings.provider;
            const model = request.params.model ?? (thread?.provider === provider ? thread.model : settings.provider === provider ? settings.model : undefined);
            const selection = runtime.model(provider, model);
            if (thread && (thread.provider !== selection.provider || thread.model !== selection.model)) {
              workspace.updateThreadModel(sessionId, selection.provider, selection.model);
            }
            const mode = request.params.mode ?? 'auto';
            const text = request.params.content;
            if (mode === 'steer' || (mode === 'auto' && agent.status(sessionId) === 'working')) {
              if (agent.steer(sessionId, text)) {
                send(peer, { id, result: { mode: 'steered' } });
                refresh(sessionId);
                return;
              }
            }
            if (mode === 'queue' || agent.status(sessionId) === 'working') {
              const queued = agent.queue(sessionId, text, { ...selection, interactive: true });
              send(peer, { id, result: { mode: queued ? 'queued' : 'steered' } });
              refresh(sessionId);
              return;
            }
            const handle = agent.start(sessionId, text, { ...selection, interactive: true });
            send(peer, { id, result: { mode: 'started', turnId: handle.turnId } });
            refresh(sessionId);
            return;
          }
          case 'cancel': {
            send(peer, { id, result: { cancelled: agent.cancel(sessionId) } });
            refresh(sessionId);
            return;
          }
          case 'answer-approval': {
            const accepted = agent.answer(sessionId, request.params.requestId, request.params.decision);
            send(peer, { id, result: { accepted } });
            refresh(sessionId);
            return;
          }
          case 'subagent-steer': {
            const steered = swarm.steer(sessionId, request.params.subagentId, request.params.message);
            send(peer, { id, result: { steered } });
            refresh(sessionId);
            return;
          }
          case 'subagent-stop': {
            const stopped = swarm.stop(sessionId, request.params.subagentId);
            send(peer, { id, result: { stopped } });
            refresh(sessionId);
            return;
          }
          case 'pull-request-merge': {
            const thread = workspace.threadBySession(sessionId);
            const reader = runtime.pullRequests;
            if (!thread?.branch || typeof reader.merge !== 'function') {
              return fail('UNSUPPORTED', 'This thread cannot be merged from Extendo');
            }
            const merged = await reader.merge(thread.branch, thread.cwd);
            if (!merged) return fail('FAILED', 'The pull request could not be merged');
            viewer.invalidate(sessionId);
            send(peer, { id, result: { merged: true, pullRequest: merged } });
            refresh(sessionId);
            return;
          }
        }
      } catch (error) {
        fail('FAILED', error instanceof Error ? error.message : 'Extendo could not complete the request');
      }
    });
  });

  return () => new Promise<void>((resolve) => {
    for (const timer of timers) clearTimeout(timer);
    for (const dispose of listeners) dispose();
    server.off('upgrade', upgrade);
    for (const peer of wss.clients) peer.terminate();
    wss.close(() => resolve());
  });
}
