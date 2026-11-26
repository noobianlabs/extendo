import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, PullRequest, SubagentActivity } from '@extendo/contracts';
import type { SessionStore } from '@extendo/session';
import type { WorkspaceState } from './state.js';
import { seedDemoRepo, type DemoCheckout } from './demoRepo.js';

/**
 * The keyless demo workspace. Every thread below is a real session in the event log, so the console
 * derives its state the same way it does for a live one. Nothing here is a static mock in the UI.
 */
export const demoPullRequests = (): Record<string, PullRequest> => ({
  'feat/empty-state-copy': {
    number: 214, title: 'Name the query in the empty state', url: 'https://github.com/northstar/web/pull/214',
    branch: 'feat/empty-state-copy', base: 'main', additions: 7, deletions: 2, changedFiles: 2,
    checks: 'passing', checksSummary: '5 checks passed', review: 'approved',
    draft: false, merged: false, mergeable: true, state: 'open',
  },
  'extendo/crew-empty-state-copy': {
    number: 226, title: 'Name the query in the empty state', url: 'https://github.com/northstar/extendo/pull/226',
    branch: 'extendo/crew-empty-state-copy', base: 'main', additions: 9, deletions: 2, changedFiles: 2,
    checks: 'passing', checksSummary: '4 checks passed', review: 'approved',
    draft: false, merged: false, mergeable: true, state: 'open',
  },
  'extendo/crew-changelog': {
    number: 227, title: 'Note the empty-state copy in the changelog', url: 'https://github.com/northstar/extendo/pull/227',
    branch: 'extendo/crew-changelog', base: 'main', additions: 1, deletions: 0, changedFiles: 1,
    checks: 'passing', checksSummary: '4 checks passed', review: 'pending',
    draft: false, merged: false, mergeable: true, state: 'open',
  },
  'feat/swarm-audit': {
    number: 219, title: 'Audit empty-state copy across search surfaces', url: 'https://github.com/northstar/web/pull/219',
    branch: 'feat/swarm-audit', base: 'main', additions: 31, deletions: 12, changedFiles: 4,
    checks: 'failing', checksSummary: '2 failing', review: 'changes-requested',
    draft: false, merged: false, mergeable: false, state: 'open',
  },
  'chore/release-notes': {
    number: 221, title: 'Draft the regional search release notes', url: 'https://github.com/northstar/web/pull/221',
    branch: 'chore/release-notes', base: 'main', additions: 18, deletions: 0, changedFiles: 1,
    checks: 'pending', checksSummary: '3 pending', review: 'pending',
    draft: true, merged: false, mergeable: true, state: 'open',
  },
});

const now = () => Date.now();
const iso = (offsetMs: number) => new Date(now() - offsetMs).toISOString();

function activity(overrides: SubagentActivity): SubagentActivity {
  return overrides;
}

export interface DemoSeed {
  workspace: WorkspaceState;
  sessions: SessionStore;
  dataDir: string;
}

export async function seedDemo({ workspace, sessions, dataDir }: DemoSeed): Promise<void> {
  if (workspace.projects().length) return;
  const root = join(dataDir, 'demo', 'northstar-ui');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const checkout = await seedDemoRepo(root, join(dataDir, 'demo', 'northstar.git')).catch(() => undefined);
  const project = workspace.openProject(root, 'Northstar UI');

  seedFinishedThread(workspace, sessions, project, checkout);
  seedSwarmThread(workspace, sessions, project, checkout);
  seedHistoryThread(workspace, sessions, project, checkout, {
    title: 'Trace the keyboard shortcut',
    branch: 'main',
    question: 'Where does the search shortcut get registered?',
    answer: 'The toolbar and the results list both register it through the command palette, so the shortcut keeps working while the empty state is showing.',
  });
  seedHistoryThread(workspace, sessions, project, checkout, {
    title: 'Draft the regional search release notes',
    branch: 'chore/release-notes',
    question: 'What should the release notes say about the search update?',
    answer: 'Lead with the empty-state change, then the filter persistence fix. Keep the regional rollout to one paragraph and link the tracking issue.',
  });
  seedFailedThread(workspace, sessions, project);
  seedCrew(workspace, sessions, project, checkout);
}

/** Puts a thread in the worktree its branch really has, so its checkout and its label agree. */
function useCheckout(workspace: WorkspaceState, sessions: SessionStore, thread: { sessionId: string }, branch: string, checkout?: DemoCheckout): void {
  const path = checkout?.worktrees[branch];
  if (!path) return;
  workspace.setThreadCheckout(thread.sessionId, { cwd: path, branch, worktree: path });
  sessions.move(thread.sessionId, path);
}

function seedFinishedThread(workspace: WorkspaceState, sessions: SessionStore, project: Project, checkout?: DemoCheckout): void {
  const thread = workspace.createThread(sessions, project, {
    title: 'Make empty search results useful', provider: 'demo', model: 'demo', branch: 'feat/empty-state-copy',
  });
  useCheckout(workspace, sessions, thread, 'feat/empty-state-copy', checkout);
  sessions.appendMany(thread.sessionId, [
    { type: 'turn/start', data: { turnId: 'turn-1', provider: 'demo', model: 'demo' } },
    { type: 'user/message', data: { turnId: 'turn-1', messageId: 'message-1', content: 'Make the empty search results useful.' } },
    { type: 'step/start', data: { turnId: 'turn-1', stepId: 'step-1' } },
    { type: 'assistant/message', data: { turnId: 'turn-1', stepId: 'step-1', messageId: 'assistant-1', content: 'Reading the empty-state component first.' } },
    { type: 'tool/call', data: { turnId: 'turn-1', stepId: 'step-1', call: { id: 'call-1', name: 'demo_read', input: { path: 'packages/web/src/search/EmptyState.tsx' } } } },
    { type: 'tool/result', data: { turnId: 'turn-1', stepId: 'step-1', result: { callId: 'call-1', name: 'demo_read', output: { path: 'packages/web/src/search/EmptyState.tsx', content: 'export function EmptyState() { return <p>No results</p>; }' }, isError: false } } },
    { type: 'step/end', data: { turnId: 'turn-1', stepId: 'step-1', outcome: 'completed' } },
    { type: 'step/start', data: { turnId: 'turn-1', stepId: 'step-2' } },
    { type: 'assistant/message', data: { turnId: 'turn-1', stepId: 'step-2', messageId: 'assistant-2', content: 'Patching the empty state to name the query and offer a clear action.' } },
    { type: 'tool/call', data: { turnId: 'turn-1', stepId: 'step-2', call: { id: 'call-2', name: 'demo_edit', input: { path: 'packages/web/src/search/EmptyState.tsx' } } } },
    { type: 'tool/result', data: { turnId: 'turn-1', stepId: 'step-2', result: { callId: 'call-2', name: 'demo_edit', output: { path: 'packages/web/src/search/EmptyState.tsx', additions: 7, deletions: 2, summary: 'Name the query and add a clear action.' }, isError: false } } },
    { type: 'step/end', data: { turnId: 'turn-1', stepId: 'step-2', outcome: 'completed' } },
    { type: 'step/start', data: { turnId: 'turn-1', stepId: 'step-3' } },
    { type: 'assistant/message', data: { turnId: 'turn-1', stepId: 'step-3', messageId: 'assistant-3', content: 'Running the search checks.' } },
    { type: 'tool/call', data: { turnId: 'turn-1', stepId: 'step-3', call: { id: 'call-3', name: 'demo_check', input: { command: 'pnpm vitest run packages/web/src/search' } } } },
    { type: 'tool/result', data: { turnId: 'turn-1', stepId: 'step-3', result: { callId: 'call-3', name: 'demo_check', output: { stdout: '5 passed', exitCode: 0 }, isError: false } } },
    { type: 'step/end', data: { turnId: 'turn-1', stepId: 'step-3', outcome: 'completed' } },
    { type: 'turn/end', data: { turnId: 'turn-1', outcome: 'completed' } },
  ]);
}

function seedSwarmThread(workspace: WorkspaceState, sessions: SessionStore, project: Project, checkout?: DemoCheckout): void {
  const thread = workspace.createThread(sessions, project, {
    title: 'Audit empty-state copy across search surfaces', provider: 'demo', model: 'demo', branch: 'feat/swarm-audit',
  });
  useCheckout(workspace, sessions, thread, 'feat/swarm-audit', checkout);
  const audit = activity({
    id: 'activity-audit', kind: 'search', label: 'search "No results"', state: 'done', startedAt: iso(96_000), durationMs: 1_400,
  });
  const patch = activity({
    id: 'activity-patch', kind: 'patch', label: 'patch EmptyState.tsx', detail: '+7 −2', state: 'done', startedAt: iso(72_000), durationMs: 2_900,
  });
  sessions.appendMany(thread.sessionId, [
    { type: 'turn/start', data: { turnId: 'turn-audit', provider: 'demo', model: 'demo' } },
    { type: 'user/message', data: { turnId: 'turn-audit', messageId: 'message-audit', content: 'Audit the empty-state copy across the search surfaces and patch what is duplicated.' } },
    { type: 'step/start', data: { turnId: 'turn-audit', stepId: 'step-audit' } },
    { type: 'assistant/message', data: { turnId: 'turn-audit', stepId: 'step-audit', messageId: 'assistant-audit', content: 'Splitting the audit into two tracks: copy and patch.' } },
    { type: 'tool/call', data: { turnId: 'turn-audit', stepId: 'step-audit', call: { id: 'call-audit', name: 'delegate', input: { tasks: [{ title: 'Audit copy', prompt: 'Audit empty-state copy.' }, { title: 'Patch copy', prompt: 'Patch the duplicated copy.' }] } } } },
    { type: 'tool/result', data: { turnId: 'turn-audit', stepId: 'step-audit', result: { callId: 'call-audit', name: 'delegate', output: { subagents: 2 }, isError: false } } },
    { type: 'step/end', data: { turnId: 'turn-audit', stepId: 'step-audit', outcome: 'completed' } },
    { type: 'turn/end', data: { turnId: 'turn-audit', outcome: 'completed' } },
    { type: 'subagent/spawned', data: { subagentId: 'sub-audit', title: 'Audit copy', role: 'auditor', sessionId: 'session-audit', parentTurnId: 'turn-audit', position: 1 } },
    { type: 'subagent/spawned', data: { subagentId: 'sub-patch', title: 'Patch copy', role: 'patcher', sessionId: 'session-patch', parentTurnId: 'turn-audit', position: 2 } },
    { type: 'subagent/started', data: { subagentId: 'sub-audit' } },
    { type: 'subagent/started', data: { subagentId: 'sub-patch' } },
    { type: 'subagent/activity', data: { subagentId: 'sub-audit', activity: audit } },
    { type: 'subagent/activity', data: { subagentId: 'sub-patch', activity: patch } },
    { type: 'subagent/report', data: { subagentId: 'sub-audit', outcome: 'completed', report: 'Two components repeat the copy. EmptyState owns the string; SearchResults only passes the query.' } },
    { type: 'subagent/report', data: { subagentId: 'sub-patch', outcome: 'completed', report: 'Patched EmptyState to name the query and added a clear action. Checks pass.' } },
  ]);
}

function seedHistoryThread(
  workspace: WorkspaceState,
  sessions: SessionStore,
  project: Project,
  checkout: DemoCheckout | undefined,
  options: { title: string; branch: string; question: string; answer: string },
): void {
  const thread = workspace.createThread(sessions, project, {
    title: options.title, provider: 'demo', model: 'demo', branch: options.branch,
  });
  useCheckout(workspace, sessions, thread, options.branch, checkout);
  sessions.appendMany(thread.sessionId, [
    { type: 'turn/start', data: { turnId: 'turn-history', provider: 'demo', model: 'demo' } },
    { type: 'user/message', data: { turnId: 'turn-history', messageId: 'message-history', content: options.question } },
    { type: 'step/start', data: { turnId: 'turn-history', stepId: 'step-history' } },
    { type: 'assistant/message', data: { turnId: 'turn-history', stepId: 'step-history', messageId: 'assistant-history', content: options.answer } },
    { type: 'step/end', data: { turnId: 'turn-history', stepId: 'step-history', outcome: 'completed' } },
    { type: 'turn/end', data: { turnId: 'turn-history', outcome: 'completed' } },
  ]);
}

function seedFailedThread(workspace: WorkspaceState, sessions: SessionStore, project: Project): void {
  const thread = workspace.createThread(sessions, project, {
    title: 'Fix the flaky search test', provider: 'demo', model: 'demo', branch: 'main',
  });
  sessions.appendMany(thread.sessionId, [
    { type: 'turn/start', data: { turnId: 'turn-failed', provider: 'demo', model: 'demo' } },
    { type: 'user/message', data: { turnId: 'turn-failed', messageId: 'message-failed', content: 'The search results test fails intermittently. Track it down.' } },
    { type: 'step/start', data: { turnId: 'turn-failed', stepId: 'step-failed' } },
    { type: 'assistant/message', data: { turnId: 'turn-failed', stepId: 'step-failed', messageId: 'assistant-failed', content: 'Running the suite five times to reproduce the failure.' } },
    { type: 'tool/call', data: { turnId: 'turn-failed', stepId: 'step-failed', call: { id: 'call-failed', name: 'demo_check', input: { command: 'pnpm vitest run --repeat 5' } } } },
    { type: 'tool/result', data: { turnId: 'turn-failed', stepId: 'step-failed', result: { callId: 'call-failed', name: 'demo_check', output: { stdout: '1 failed', exitCode: 1 }, isError: true } } },
    { type: 'step/end', data: { turnId: 'turn-failed', stepId: 'step-failed', outcome: 'failed' } },
    { type: 'turn/end', data: { turnId: 'turn-failed', outcome: 'failed', error: 'The suite failed on the third repeat.' } },
  ]);
}

function seedCrew(workspace: WorkspaceState, sessions: SessionStore, project: Project, checkout?: DemoCheckout): void {
  const captain = workspace.createThread(sessions, project, {
    title: 'Run the empty-state copy crew', provider: 'demo', model: 'demo', branch: 'main', role: 'captain',
  });
  const copy = workspace.createThread(sessions, project, {
    title: 'Rework the empty-state copy', provider: 'demo', model: 'demo',
    branch: 'extendo/crew-empty-state-copy', role: 'worker', captainId: captain.id,
  });
  const changelog = workspace.createThread(sessions, project, {
    title: 'Draft the changelog entry', provider: 'demo', model: 'demo',
    branch: 'extendo/crew-changelog', role: 'worker', captainId: captain.id,
  });
  useCheckout(workspace, sessions, copy, 'extendo/crew-empty-state-copy', checkout);
  useCheckout(workspace, sessions, changelog, 'extendo/crew-changelog', checkout);

  sessions.appendMany(captain.sessionId, [
    { type: 'turn/start', data: { turnId: 'turn-crew-plan', provider: 'demo', model: 'demo' } },
    { type: 'user/message', data: { turnId: 'turn-crew-plan', messageId: 'crew-plan-user', content: 'Take the empty-state copy and the changelog. Two workers, each in its own worktree.' } },
    { type: 'step/start', data: { turnId: 'turn-crew-plan', stepId: 'crew-plan-step' } },
    { type: 'assistant/message', data: { turnId: 'turn-crew-plan', stepId: 'crew-plan-step', messageId: 'crew-plan-assistant', content: 'Two workers, each in its own worktree: one takes the empty-state copy, one takes the changelog. I will report when both land.' } },
    { type: 'tool/call', data: { turnId: 'turn-crew-plan', stepId: 'crew-plan-step', call: { id: 'crew-call-copy', name: 'crew.create', input: { title: 'Rework the empty-state copy', brief: 'Make the empty state name the query that found nothing.' } } } },
    { type: 'tool/result', data: { turnId: 'turn-crew-plan', stepId: 'crew-plan-step', result: { callId: 'crew-call-copy', name: 'crew.create', output: { threadId: copy.id, branch: 'extendo/crew-empty-state-copy' }, isError: false } } },
    { type: 'tool/call', data: { turnId: 'turn-crew-plan', stepId: 'crew-plan-step', call: { id: 'crew-call-changelog', name: 'crew.create', input: { title: 'Draft the changelog entry', brief: 'Note the empty-state copy in the changelog.' } } } },
    { type: 'tool/result', data: { turnId: 'turn-crew-plan', stepId: 'crew-plan-step', result: { callId: 'crew-call-changelog', name: 'crew.create', output: { threadId: changelog.id, branch: 'extendo/crew-changelog' }, isError: false } } },
    { type: 'step/end', data: { turnId: 'turn-crew-plan', stepId: 'crew-plan-step', outcome: 'completed' } },
    { type: 'turn/end', data: { turnId: 'turn-crew-plan', outcome: 'completed' } },
  ]);

  sessions.appendMany(copy.sessionId, [
    { type: 'turn/start', data: { turnId: 'turn-crew-copy', provider: 'demo', model: 'demo' } },
    { type: 'user/message', data: { turnId: 'turn-crew-copy', messageId: 'crew-copy-user', content: 'Make the empty state name the query that found nothing.' } },
    { type: 'step/start', data: { turnId: 'turn-crew-copy', stepId: 'crew-copy-step' } },
    { type: 'assistant/message', data: { turnId: 'turn-crew-copy', stepId: 'crew-copy-step', messageId: 'crew-copy-assistant', content: 'The empty state now names the query and offers a clear action. The branch is ready for review.' } },
    { type: 'tool/call', data: { turnId: 'turn-crew-copy', stepId: 'crew-copy-step', call: { id: 'crew-copy-edit', name: 'demo_edit', input: { path: 'apps/web/src/search/EmptyState.tsx' } } } },
    { type: 'tool/result', data: { turnId: 'turn-crew-copy', stepId: 'crew-copy-step', result: { callId: 'crew-copy-edit', name: 'demo_edit', output: { path: 'apps/web/src/search/EmptyState.tsx', simulated: true }, isError: false } } },
    { type: 'step/end', data: { turnId: 'turn-crew-copy', stepId: 'crew-copy-step', outcome: 'completed' } },
    { type: 'turn/end', data: { turnId: 'turn-crew-copy', outcome: 'completed' } },
  ]);

  sessions.appendMany(changelog.sessionId, [
    { type: 'turn/start', data: { turnId: 'turn-crew-changelog', provider: 'demo', model: 'demo' } },
    { type: 'user/message', data: { turnId: 'turn-crew-changelog', messageId: 'crew-changelog-user', content: 'Note the empty-state copy in the changelog.' } },
    { type: 'step/start', data: { turnId: 'turn-crew-changelog', stepId: 'crew-changelog-step' } },
    { type: 'assistant/message', data: { turnId: 'turn-crew-changelog', stepId: 'crew-changelog-step', messageId: 'crew-changelog-assistant', content: 'The changelog now notes that empty results name the query. One line, no other changes.' } },
    { type: 'tool/call', data: { turnId: 'turn-crew-changelog', stepId: 'crew-changelog-step', call: { id: 'crew-changelog-edit', name: 'demo_edit', input: { path: 'docs/CHANGELOG.md' } } } },
    { type: 'tool/result', data: { turnId: 'turn-crew-changelog', stepId: 'crew-changelog-step', result: { callId: 'crew-changelog-edit', name: 'demo_edit', output: { path: 'docs/CHANGELOG.md', simulated: true }, isError: false } } },
    { type: 'step/end', data: { turnId: 'turn-crew-changelog', stepId: 'crew-changelog-step', outcome: 'completed' } },
    { type: 'turn/end', data: { turnId: 'turn-crew-changelog', outcome: 'completed' } },
  ]);

  sessions.appendMany(captain.sessionId, [
    { type: 'crew/wake', data: { workerId: copy.id, workerSessionId: copy.sessionId, title: copy.title, turnId: 'turn-crew-copy', outcome: 'completed', report: 'The empty state now names the query and offers a clear action. The branch is ready for review.' } },
    { type: 'crew/wake', data: { workerId: changelog.id, workerSessionId: changelog.sessionId, title: changelog.title, turnId: 'turn-crew-changelog', outcome: 'completed', report: 'The changelog now notes that empty results name the query. One line, no other changes.' } },
    { type: 'turn/start', data: { turnId: 'turn-crew-review', provider: 'demo', model: 'demo' } },
    { type: 'step/start', data: { turnId: 'turn-crew-review', stepId: 'crew-review-step' } },
    { type: 'assistant/message', data: { turnId: 'turn-crew-review', stepId: 'crew-review-step', messageId: 'crew-review-assistant', content: 'Both workers landed. The empty state names the query and the changelog carries the note. I filed the design check as an issue; the copy is ready for review.' } },
    { type: 'step/end', data: { turnId: 'turn-crew-review', stepId: 'crew-review-step', outcome: 'completed' } },
    { type: 'turn/end', data: { turnId: 'turn-crew-review', outcome: 'completed' } },
  ]);

  workspace.createIssue(project, {
    title: 'Confirm the empty-state copy with design',
    body: 'The copy names the query. Design should confirm the wording before the branch merges.',
    state: 'needs-you',
    captainId: captain.id,
  });
}
