import { describe, expect, it } from 'vitest';
import type { RpcEvent, SessionEvent, ToolResult } from '@extendo/contracts';
import type { Message } from '@extendo/contracts';
import { reduceSession, written, type SessionView } from './useSession';

const start = (revision = 0): SessionView => ({
  sessionId: 'session-1', messages: [], approvals: [], connected: true, loading: false, lastSeq: 0, tokens: 0, revision,
});

function step(seq: number, data: SessionEvent): RpcEvent {
  return { event: 'session/event', data: { sessionId: 'session-1', event: { ...data, seq, ts: new Date(seq).toISOString() } as SessionEvent } } as RpcEvent;
}

function result(seq: number, callId: string, name: string, isError = false): RpcEvent {
  const output: ToolResult = { callId, name, output: {}, isError };
  return step(seq, { type: 'tool/result', data: { turnId: 't', stepId: 'step-1', result: output } } as SessionEvent);
}

describe('the working-tree revision', () => {
  it('bumps when a tool that can change files succeeds', () => {
    const first = reduceSession(start(), result(1, 'a', 'write'));
    const second = reduceSession(first, result(2, 'b', 'edit'));
    const third = reduceSession(second, result(3, 'c', 'demo_edit'));
    const fourth = reduceSession(third, result(4, 'd', 'shell'));
    expect([first.revision, second.revision, third.revision, fourth.revision]).toEqual([1, 2, 3, 4]);
  });

  it('does not bump for a read, a failed write, or a repeated event', () => {
    const state = start(4);
    expect(reduceSession(state, result(1, 'a', 'read')).revision).toBe(4);
    expect(reduceSession(state, result(2, 'b', 'write', true)).revision).toBe(4);
    const failed = result(3, 'c', 'write', true);
    const once = reduceSession(start(0), failed);
    expect(once.revision).toBe(0);
    expect(reduceSession(once, failed).revision).toBe(0);
  });

  it('counts the writes a stored transcript already contains', () => {
    const messages = [
      {
        role: 'assistant', id: 'a', turnId: 't', stepId: 's', content: '', tools: [
          { call: { id: '1', name: 'write', input: {} }, result: { callId: '1', name: 'write', output: {}, isError: false } },
          { call: { id: '2', name: 'read', input: {} }, result: { callId: '2', name: 'read', output: {}, isError: false } },
          { call: { id: '3', name: 'edit', input: {} } },
          { call: { id: '4', name: 'edit', input: {} }, result: { callId: '4', name: 'edit', output: {}, isError: true } },
        ],
      },
      { role: 'user', id: 'b', turnId: 't', content: 'a question' },
    ] as Message[];
    expect(written(messages)).toBe(1);
    expect(written([])).toBe(0);
  });
});
