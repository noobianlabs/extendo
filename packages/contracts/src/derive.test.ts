import { describe, expect, it } from 'vitest';
import type { PullRequest, SessionEvent, Subagent } from './index.js';
import { activityDuration, deriveThreadState, openTurn, projectSubagents, subagentCounts } from './derive.js';

let seq = 0;
function event(type: SessionEvent['type'], data: unknown, ts = '2026-01-01T00:00:00.000Z'): SessionEvent {
  seq += 1;
  return { seq, ts, type, data } as SessionEvent;
}

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 12, title: 'Name the query', url: 'https://example.test/pr/12', branch: 'feat/x', base: 'main',
  additions: 4, deletions: 2, changedFiles: 2, checks: 'passing', review: 'approved', draft: false,
  merged: false, state: 'open', ...over,
});

describe('projectSubagents', () => {
  it('folds spawn, activity, approval, steer, and report events into one subagent', () => {
    seq = 0;
    const events = [
      event('subagent/spawned', { subagentId: 'a', title: 'Audit copy', role: 'auditor', sessionId: 's-a', parentTurnId: 't' }),
      event('subagent/spawned', { subagentId: 'b', title: 'Patch copy', sessionId: 's-b', parentTurnId: 't' }),
      event('subagent/queued', { subagentId: 'b', position: 2 }),
      event('subagent/started', { subagentId: 'a' }, '2026-01-01T00:00:01.000Z'),
      event('subagent/activity', { subagentId: 'a', activity: { id: 'c1', kind: 'read', label: 'read EmptyState', state: 'running', startedAt: '2026-01-01T00:00:01.000Z' } }),
      event('subagent/approval', { subagentId: 'b', request: { requestId: 'r1', sessionId: 's-b', turnId: 't', stepId: 's', call: { id: 'c2', name: 'edit', input: { path: 'a.tsx' } } } }),
      event('subagent/approval-answered', { subagentId: 'b', requestId: 'r1', decision: 'allow' }),
      event('subagent/steered', { subagentId: 'a', message: 'Keep the reset button' }),
      event('subagent/report', { subagentId: 'a', outcome: 'completed', report: 'Two components repeat the copy.' }),
    ];
    const swarm = projectSubagents(events);
    expect(swarm.map(({ state }) => state)).toEqual(['done', 'running']);
    expect(swarm[0]).toMatchObject({ title: 'Audit copy', role: 'auditor', startedAt: '2026-01-01T00:00:01.000Z', report: 'Two components repeat the copy.' });
    expect(swarm[0]?.activity.map(({ kind }) => kind)).toEqual(['read', 'note']);
    expect(swarm[1]?.position).toBeUndefined();
    expect(swarm[1]?.approval).toBeUndefined();
    expect(subagentCounts(swarm)).toEqual({ running: 1, queued: 0, waiting: 0, failed: 0, done: 1 });
  });

  it('keeps a pending approval call so the console can answer it', () => {
    seq = 0;
    const swarm = projectSubagents([
      event('subagent/spawned', { subagentId: 'a', title: 'Patch', sessionId: 's-a', parentTurnId: 't' }),
      event('subagent/started', { subagentId: 'a' }),
      event('subagent/approval', { subagentId: 'a', request: { requestId: 'r1', sessionId: 's-a', turnId: 't', stepId: 's', call: { id: 'c1', name: 'edit', input: {} } } }),
    ]);
    expect(swarm[0]).toMatchObject({ state: 'waiting-approval', approval: { requestId: 'r1', call: { name: 'edit' } } });
  });

  it('ignores activity for a subagent it never saw spawn', () => {
    seq = 0;
    expect(projectSubagents([event('subagent/started', { subagentId: 'ghost' })])).toEqual([]);
  });
});

describe('deriveThreadState', () => {
  it('reports the approval before anything else', () => {
    seq = 0;
    const subagents: Subagent[] = [{
      id: 'a', title: 'Patch', sessionId: 's-a', state: 'waiting-approval', activity: [],
      approval: { requestId: 'r1', call: { id: 'c1', name: 'edit', input: {} } },
    }];
    expect(deriveThreadState({ events: [], subagents }).state).toBe('waiting-approval');
  });

  it('follows the open turn, then the swarm, then the pull request, then the last outcome', () => {
    seq = 0;
    expect(openTurn([])).toBeUndefined();
    const open = [event('turn/start', { turnId: 't1' }), event('user/message', { turnId: 't1', messageId: 'm', content: 'hi' })];
    expect(openTurn(open)).toBe('t1');
    expect(deriveThreadState({ events: open, subagents: [] }).state).toBe('working');
    expect(deriveThreadState({ events: [event('turn/end', { turnId: 't1', outcome: 'completed' })], subagents: [{ id: 'q', title: 'Queued', sessionId: 's', state: 'queued', activity: [] }] }).state).toBe('queued');
    expect(deriveThreadState({ events: [], subagents: [], pullRequest: pr({ checks: 'pending' }) }).state).toBe('waiting-review');
    expect(deriveThreadState({ events: [], subagents: [], pullRequest: pr() }).state).toBe('idle');
    expect(deriveThreadState({ events: [event('turn/end', { turnId: 't1', outcome: 'failed', error: 'boom' })], subagents: [] }).state).toBe('failed');
    expect(deriveThreadState({ events: [event('turn/end', { turnId: 't1', outcome: 'completed' })], subagents: [] }).state).toBe('done');
  });

  it('does not count a draft pull request as waiting on review', () => {
    seq = 0;
    expect(deriveThreadState({ events: [], subagents: [], pullRequest: pr({ draft: true }) }).state).toBe('idle');
    expect(deriveThreadState({ events: [], subagents: [], pullRequest: pr({ review: 'changes-requested' }) }).state).toBe('waiting-review');
  });
});

describe('activityDuration', () => {
  it('prints short durations in seconds and long ones rounded', () => {
    expect(activityDuration({ id: 'a', kind: 'read', label: 'read', state: 'done', startedAt: '', durationMs: 1_400 })).toBe('1.4s');
    expect(activityDuration({ id: 'a', kind: 'run', label: 'run', state: 'done', startedAt: '', durationMs: 12_000 })).toBe('12s');
    expect(activityDuration({ id: 'a', kind: 'run', label: 'run', state: 'running', startedAt: '' })).toBe('');
  });
});
