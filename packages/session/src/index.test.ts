import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEventInput } from '@extendo/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectModelMessages, SessionStore } from './index.js';

let dataDir: string;
let store: SessionStore;
const turn = { turnId: 't' };
const step = { ...turn, stepId: 's' };
const call = { id: 'call', name: 'read', input: { path: 'README.md' } };
const prefix: SessionEventInput[] = [
  { type: 'turn/start', data: { ...turn, provider: 'demo', model: 'demo' } },
  { type: 'user/message', data: { ...turn, messageId: 'user', content: 'Hello' } },
  { type: 'step/start', data: step },
  { type: 'assistant/message', data: { ...step, messageId: 'assistant', content: 'Looking up', reasoning: 'Find docs' } },
  { type: 'tool/call', data: { ...step, call } },
];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'extendo-session-'));
  store = new SessionStore(dataDir);
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('session store', () => {
  it('appends batched events in per-session order and replays after a cursor', () => {
    const { id } = store.create({ title: 'Test', cwd: dataDir });
    const other = store.create({ title: 'Other', cwd: dataDir });
    expect(store.appendMany(id, prefix).map(({ seq }) => seq)).toEqual([2, 3, 4, 5, 6]);
    expect(store.lastSeq(other.id)).toBe(1);
    expect(store.replay(id, 4).map(({ type }) => type)).toEqual(['assistant/message', 'tool/call']);
    expect(readFileSync(store.mirrorPath(id), 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual(store.replay(id));
    expect(() => store.append('unknown', prefix[0]!)).toThrow();
  });

  it('projects visible messages, tool outcomes, and provider history', () => {
    const { id } = store.create({ title: 'Test', cwd: dataDir });
    const result = { callId: call.id, name: call.name, output: 'readme contents', isError: false };
    store.appendMany(id, [...prefix, { type: 'tool/result', data: { ...step, result } },
      { type: 'assistant/attempt', data: { ...step, content: 'partial', error: 'retry' } }]);
    expect(store.snapshot(id)).toMatchObject({
      lastSeq: 8,
      messages: [
        { role: 'user', id: 'user', content: 'Hello' },
        { role: 'assistant', id: 'assistant', content: 'Looking up', reasoning: 'Find docs', tools: [{ call, result }] },
      ],
    });
    expect(projectModelMessages(store.replay(id)).map(({ role }) => role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('repairs a truncated mirror and seals an interrupted turn without rerunning tools', () => {
    const { id } = store.create({ title: 'Test', cwd: dataDir });
    store.appendMany(id, prefix);
    const mirror = store.mirrorPath(id);
    store.close();
    writeFileSync(mirror, '{"truncated":', 'utf8');
    store = new SessionStore(dataDir);
    expect(store.resume(id)).toMatchObject({
      lastSeq: 9,
      messages: [{ role: 'user' }, { tools: [{ result: { isError: true, output: 'Execution interrupted; outcome unknown' } }] }],
    });
    expect(store.replay(id, 6).map(({ type }) => type)).toEqual(['tool/result', 'step/end', 'turn/end']);
    expect(store.resume(id).lastSeq).toBe(9);
    expect(readFileSync(mirror, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual(store.replay(id));
  });
});
