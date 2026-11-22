import type { Message, Project, Subagent, Thread, ThreadState } from '@extendo/contracts';
import type { ShellLabels } from './chrome';

export const stressMode = import.meta.env.DEV ? new URLSearchParams(location.search).get('data') : null;
const project: Project = {
  id: 'stress-project', name: 'Nordstern: Internationalisierung und Produktinfrastruktur',
  path: '/workspaces/northstar/customer-experience/regional-rollout/internationalization/search-components',
};
const longTitle = 'Benachrichtigungseinstellungen für die unternehmensweite regionale Veröffentlichung und Barrierefreiheitsprüfung der Suche';
const longPath = 'packages/customer-experience/internationalization/components/global-search/enterprise-onboarding/search-navigation/empty-filter-result/LocalizedFilterResetButton.integration.test.tsx';
const titles = [longTitle, 'Đặng Thị Ngọc Hân — rechercher les résultats', 'إعدادات البحث والإشعارات', 'J', 'Paramètres de confidentialité et de sécurité'];
const out = Array.from({ length: 600 }, (_, index) =>
  `[check ${index + 1}] Validating localized component and navigation contract at ${longPath}`,
).join('\n');

const labels: Partial<ShellLabels> = {
  newThread: 'Neue Unterhaltung erstellen',
  commands: 'Befehlspalette öffnen',
  threads: 'Unterhaltungen',
  filterThreads: 'Unterhaltungen durchsuchen',
  settings: 'Benachrichtigungseinstellungen',
  openProject: 'Lokalen Projektordner öffnen',
};

const longError = 'The delegated session could not start because the workspace lock is held by another process. ' +
  'Release the lock, then re-run this track. ' + longPath;
const longReport = 'Audited every localized empty state across the regional rollout. Four components repeat the copy, ' +
  'two branches are unreachable, and the filter reset never restores focus. The patch track should pass the query through.';

function subagents(count: number, base: number): Subagent[] {
  return Array.from({ length: count }, (_, index) => {
    const state = (['running', 'queued', 'done', 'failed', 'waiting-approval', 'stopped'] as const)[(index + base) % 6]!;
    return {
      id: `subagent-${base}-${index}`, title: `${titles[index] ?? 'Regional search review'} — track ${index + 1}`,
      role: index % 2 ? 'auditor' : 'patcher', sessionId: `stress-sub-${base}-${index}`,
      state, position: state === 'queued' ? index + 1 : undefined,
      startedAt: new Date(Date.now() - (index + 1) * 61_000).toISOString(),
      endedAt: state === 'running' || state === 'queued' ? undefined : new Date(Date.now() - 5_000).toISOString(),
      activity: Array.from({ length: 6 }, (_, line) => ({
        id: `activity-${base}-${index}-${line}`, kind: (['read', 'patch', 'run'] as const)[line % 3]!,
        label: `${line % 3 === 0 ? 'Read' : line % 3 === 1 ? 'Patch' : 'Run'} ${longPath}`,
        state: line === 5 && state === 'running' ? 'running' : line === 4 && state === 'failed' ? 'failed' : 'done',
        startedAt: new Date(Date.now() - (6 - line) * 9_000).toISOString(),
        durationMs: 9_000 + line * 1_337,
      })),
      report: state === 'done' ? longReport : undefined,
      error: state === 'failed' ? longError : undefined,
    } satisfies Subagent;
  });
}

export function stressData(mode: string) {
  const count = mode === 'empty' ? 0 : mode === 'one' ? 1 : 1_284;
  const states: ThreadState[] = ['working', 'waiting-approval', 'queued', 'waiting-review', 'failed', 'done', 'idle'];
  const threads: Thread[] = Array.from({ length: count }, (_, index) => ({
    id: `stress-${index}`, sessionId: `stress-session-${index}`, projectId: project.id,
    title: titles[index] ?? `Regional search review ${index + 1}: rollout checklist`,
    cwd: `${project.path}/${longPath}`, branch: 'feature/extended-regional-search-language-and-notification-support',
    status: (['idle', 'working', 'waiting', 'failed'] as const)[index % 4]!,
    state: states[index % states.length]!,
    stateSince: new Date(Date.now() - (index + 1) * 47_000).toISOString(),
    updatedAt: new Date(Date.now() - index * 90_000).toISOString(),
    provider: 'demo', model: 'extendo-demo', createdAt: new Date(2025, 11, 31 - index).toISOString(),
    subagents: index % 3 === 0 ? subagents(index === 0 ? 12 : (index % 5) + 1, index) : undefined,
    pullRequest: index % 2 === 0 ? {
      number: 90_412 + index, title: `${titles[index] ?? 'Regional search review'} — widen the empty state and localize the reset`,
      url: `https://github.com/northstar/web/pull/${90_412 + index}`,
      branch: 'feature/extended-regional-search-language-and-notification-support', base: 'main',
      state: index % 6 === 0 ? 'merged' : 'open', draft: index % 5 === 0,
      checks: (['failing', 'pending', 'passing', 'passing'] as const)[index % 4]!, review: (['changes-requested', 'pending', 'approved'] as const)[index % 3]!,
      additions: 128_433 + index, deletions: 98 + index, changedFiles: 214 + index, merged: index % 6 === 0,
    } : undefined,
    preview: index % 4 === 0 ? {
      label: 'Preview', title: 'Empty search results', url: `/api/preview/stress-session-${index}`,
      updatedAt: new Date(Date.now() - index * 90_000).toISOString(),
    } : undefined,
  }));
  const messages: Message[] = [
    { role: 'user', id: 'stress-user', turnId: 'stress-turn', content: 'Aprire i risultati della ricerca sotto un filtro attivo, poi verificare tutta la navigazione da tastiera.' },
    { role: 'assistant', id: 'stress-assistant', turnId: 'stress-turn', stepId: 'stress-step',
      content: 'The verification completed across all localized variants. You can inspect the file path or expand the terminal output below.',
      tools: [
        { call: { name: 'read', id: 'stress-read', input: { path: longPath } }, result: {
          name: 'read', callId: 'stress-read', output: { path: longPath, content: 'export const state = "ready";' }, isError: false,
        } },
        { call: { name: 'shell', id: 'stress-shell', input: { command: 'pnpm test --filter @northstar/localized-search' } }, result: {
          name: 'shell', callId: 'stress-shell', output: { stdout: out, exitCode: 0 }, isError: false,
        } },
      ],
    },
  ];
  return { projects: [project], threads, messages, labels };
}
