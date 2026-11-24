import { useEffect, useRef, useState } from 'react';
import type { AgentStatus, ApprovalRequest, Message, RpcEvent, SessionEvent, SessionSnapshot } from '@extendo/contracts';
import type { Thread } from '@extendo/contracts';
import { api, RpcSocket } from './api';

type Assistant = Extract<Message, { role: 'assistant' }>;

export interface SessionView {
  sessionId?: string;
  messages: Message[];
  approvals: ApprovalRequest[];
  draft?: Assistant;
  status?: AgentStatus;
  error?: string;
  connected: boolean;
  loading: boolean;
  lastSeq: number;
  tokens: number;
  /** Bumps on every file this session writes, so a surface showing the working tree can re-read it. */
  revision: number;
}

function empty(sessionId?: string): SessionView {
  return { sessionId, messages: [], approvals: [], connected: false, loading: Boolean(sessionId), lastSeq: 0, tokens: 0, revision: 0 };
}

function modifyStep(messages: Message[], stepId: string, update: (message: Assistant) => Assistant) {
  const index = messages.findLastIndex((message) => message.role === 'assistant' && message.stepId === stepId);
  if (index < 0) return messages;
  const copy = messages.slice();
  copy[index] = update(messages[index] as Assistant);
  return copy;
}

function settle(state: SessionView, event: SessionEvent): SessionView {
  if (event.seq <= state.lastSeq) return state;
  const next = { ...state, lastSeq: event.seq };
  switch (event.type) {
    case 'turn/start':
      return { ...next, error: undefined, tokens: 0, draft: undefined };
    case 'user/message':
      return { ...next, messages: [...next.messages, { role: 'user', id: event.data.messageId, turnId: event.data.turnId, content: event.data.content }] };
    case 'assistant/message':
      return { ...next, draft: undefined, messages: [...next.messages, {
        role: 'assistant', id: event.data.messageId, turnId: event.data.turnId, stepId: event.data.stepId,
        content: event.data.content, reasoning: event.data.reasoning, tools: [],
      }] };
    case 'tool/call': {
      const { call, stepId } = event.data;
      return { ...next, messages: modifyStep(next.messages, stepId, (message) => ({ ...message, tools: [...message.tools, { call }] })) };
    }
    case 'tool/result': {
      const { result, stepId } = event.data;
      return {
        ...next,
        revision: next.revision + (writesFiles(result) ? 1 : 0),
        messages: modifyStep(next.messages, stepId, (message) => ({
          ...message, tools: message.tools.map((tool) => tool.call.id === result.callId ? { ...tool, result } : tool),
        })),
      };
    }
    case 'step/end':
      return { ...next, tokens: next.tokens + (event.data.usage?.inputTokens ?? 0) + (event.data.usage?.outputTokens ?? 0),
        draft: next.draft?.stepId === event.data.stepId ? undefined : next.draft };
    case 'turn/end':
      return { ...next, draft: undefined, approvals: next.approvals.filter((request) => request.turnId !== event.data.turnId),
        error: event.data.outcome === 'failed' ? event.data.error : next.error };
    default: return next;
  }
}

/** A tool that can change the working tree, so the surface showing it knows to re-read. */
function writesFiles(result: { name: string; isError: boolean }): boolean {
  return !result.isError && /(^|[_-])(write|edit|patch|shell|bash|exec)([_-]|$)/i.test(result.name);
}

export function written(messages: Message[]): number {
  return messages.reduce((count, message) => message.role !== 'assistant' ? count
    : count + message.tools.filter((tool) => tool.result && writesFiles(tool.result)).length, 0);
}

export function reduceSession(state: SessionView, frame: RpcEvent): SessionView {
  if (!('sessionId' in frame.data) || frame.data.sessionId !== state.sessionId) return state;
  switch (frame.event) {
    case 'session/event': return settle(state, frame.data.event);
    case 'agent/status':
      return { ...state, status: frame.data.status, draft: frame.data.status === 'idle' || frame.data.status === 'failed' ? undefined : state.draft };
    case 'agent/error':
      return { ...state, error: frame.data.message, draft: undefined };
    case 'tool/approval':
      return { ...state, approvals: [...state.approvals.filter(({ requestId }) => requestId !== frame.data.requestId), frame.data] };
    case 'tool/approval-answered':
      return { ...state, approvals: state.approvals.filter(({ requestId }) => requestId !== frame.data.requestId) };
    case 'assistant/delta':
    case 'assistant/tool-call': {
      const { messageId, stepId, turnId } = frame.data;
      const draft = state.draft?.id === messageId ? state.draft : { role: 'assistant' as const, id: messageId, stepId, turnId, content: '', tools: [] };
      return { ...state, draft: frame.event === 'assistant/tool-call'
        ? { ...draft, tools: [...draft.tools, { call: frame.data.call }] }
        : frame.data.kind === 'text'
          ? { ...draft, content: draft.content + frame.data.delta }
          : { ...draft, reasoning: (draft.reasoning ?? '') + frame.data.delta } };
    }
    default: return state;
  }
}

export function useSession(
  sessionId: string | undefined,
  onStatus: (sessionId: string, status: AgentStatus) => void,
  onThread?: (thread: Thread) => void,
  paused = false,
) {
  const [view, setView] = useState<SessionView>(() => empty(sessionId));
  const socket = useRef<RpcSocket | undefined>(undefined);

  useEffect(() => {
    let state = empty(sessionId);
    let stopped = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const update = (reduce: (value: SessionView) => SessionView) => {
      if (stopped) return;
      state = reduce(state);
      setView(state);
    };
    setView(state);
    if (!sessionId || paused) return;

    const connect = () => {
      if (stopped) return;
      const peer = new RpcSocket((event) => {
        if (event.event === 'thread/updated') {
          onThread?.(event.data.thread);
          return;
        }
        update((current) => reduceSession(current, event));
        if (event.event === 'agent/status' && event.data.sessionId === sessionId) onStatus(sessionId, event.data.status);
      }, () => {
        if (stopped) return;
        if (socket.current === peer) socket.current = undefined;
        update((current) => ({ ...current, connected: false, draft: undefined }));
        timer = setTimeout(connect, Math.min(350 * 2 ** attempts++, 4_000));
      });
      socket.current = peer;
      void peer.call('subscribe', { sessionId, afterSeq: state.lastSeq }).then((result) => {
        if (stopped) return;
        attempts = 0;
        update((current) => ({ ...current, connected: true, status: result.status, approvals: result.approvals }));
        onStatus(sessionId, result.status);
      }).catch(() => { if (!stopped) peer.close(); });
    };

    void api<SessionSnapshot>('/sessions/' + encodeURIComponent(sessionId), { signal: abort.signal }).then((snapshot) => {
      update((current) => ({
        ...current, messages: snapshot.messages, lastSeq: snapshot.lastSeq, loading: false, revision: written(snapshot.messages),
      }));
      connect();
    }).catch((error: unknown) => {
      if (!stopped) update((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : 'Could not load the session.' }));
    });
    return () => {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
      socket.current?.close();
      socket.current = undefined;
    };
  }, [sessionId, onStatus, onThread, paused]);

  return { view: view.sessionId === sessionId ? view : empty(sessionId), socket };
}
