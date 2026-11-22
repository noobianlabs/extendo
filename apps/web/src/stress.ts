import type { Message, Project, Thread } from '@extendo/contracts';
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

export function stressData(mode: string) {
  const count = mode === 'empty' ? 0 : mode === 'one' ? 1 : 1_284;
  const threads: Thread[] = Array.from({ length: count }, (_, index) => ({
    id: `stress-${index}`, sessionId: `stress-session-${index}`, projectId: project.id,
    title: titles[index] ?? `Regional search review ${index + 1}: rollout checklist`,
    cwd: `${project.path}/${longPath}`, branch: 'feature/extended-regional-search-language-and-notification-support',
    status: (['idle', 'working', 'waiting', 'failed'] as const)[index % 4]!,
    provider: 'demo', model: 'extendo-demo', createdAt: new Date(2025, 11, 31 - index).toISOString(),
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
