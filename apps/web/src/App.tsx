import { CircleAlert, FolderOpen, Terminal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentStatus, ApprovalDecision, ExtensionState, LiveTool, Project, ProviderInfo, Settings, Thread } from '@extendo/contracts';
import { api, json } from './api';
import { createExtension, loadExtensions, pluginToolOwners, removeExtension, saveExtension } from './extensions';
import { ChatSurface } from './chat';
import { createWorktree } from './git/client';
import { Shell } from './chrome';
import { RunBar } from './console/threadHeader';
import { useNow } from './console/useNow';
import { CommandPalette, Inspector, OpenProjectDialog, SettingsDialog, type InspectorTab } from './studio';
import { stressData, stressMode } from './stress';
import { useSession } from './useSession';
import { Workshop } from './workshop';
import './workshop/workshop.css';

const emptySettings: Settings = { provider: 'demo' };
const emptyExtensions: ExtensionState = { extensions: [], mounts: [] };
const sampleProvider: ProviderInfo = { id: 'demo', name: 'Demo', model: 'extendo-demo', configured: true };
const suggestions = [
  'Propose a clearer empty search state',
  'Show how tool approvals work',
  'Say hello',
];

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Extendo could not complete the action.';
}

function initialTheme(): 'dark' | 'light' {
  try { if (localStorage.getItem('extendo-theme') === 'light') return 'light'; }
  catch {}
  return 'dark';
}

export function App() {
  const [data, setData] = useState<{ projects: Project[]; threads: Thread[]; providers: ProviderInfo[]; settings: Settings }>({
    projects: [], threads: [], providers: [sampleProvider], settings: emptySettings,
  });
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [activeProject, setActiveProject] = useState<string>();
  const [activeThread, setActiveThread] = useState<string>();
  const [forcedProvider, setForcedProvider] = useState<Settings>();
  const [palette, setPalette] = useState(false);
  const [preferences, setPreferences] = useState(false);
  const [openProject, setOpenProject] = useState(false);
  const [inspector, setInspector] = useState(() => window.matchMedia('(min-width: 1101px)').matches);
  const [panelTab, setPanelTab] = useState<InspectorTab>('Overview');
  const [merging, setMerging] = useState(false);
  const [extensions, setExtensions] = useState<ExtensionState>(emptyExtensions);
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [workshop, setWorkshop] = useState<{ open: boolean; selected?: string }>({ open: false });
  const now = useNow(1000);
  const [theme, setTheme] = useState(initialTheme);
  const pluginTools = useMemo(() => pluginToolOwners(extensions), [extensions]);
  const fixture = useMemo(() => stressMode && stressMode !== 'demo' ? stressData(stressMode) : undefined, []);
  const projects = fixture?.projects ?? data.projects;
  const threads = fixture?.threads ?? data.threads;
  const project = projects.find(({ id }) => id === activeProject) ?? projects[0];
  const projectThreads = threads.filter(({ projectId }) => projectId === project?.id);
  const thread = projectThreads.find(({ id }) => id === activeThread) ?? projectThreads[0];
  const selection = forcedProvider ?? (thread ? { provider: thread.provider, model: thread.model } : data.settings);
  const provider = data.providers.find(({ id }) => id === selection.provider);
  const providerLabel = provider?.name ?? selection.provider;
  const setThreadStatus = useCallback((sessionId: string, status: AgentStatus) => {
    setData((current) => ({
      ...current,
      threads: current.threads.map((item) => item.sessionId === sessionId && item.status !== status ? { ...item, status } : item),
    }));
  }, []);
  const onThread = useCallback((snapshot: Thread) => {
    setData((current) => ({
      ...current,
      threads: current.threads.map((item) => item.id === snapshot.id ? { ...item, ...snapshot } : item),
    }));
  }, []);
  const { view, socket } = useSession(thread?.sessionId, setThreadStatus, onThread, Boolean(fixture));
  const status = view.status ?? thread?.status ?? 'idle';
  const waitingSubagents = thread?.subagents?.filter(({ state }) => state === 'waiting-approval').length ?? 0;
  const messages = fixture?.messages ?? view.messages;
  const tokenLabel = view.tokens ? new Intl.NumberFormat().format(view.tokens) + ' tokens' : undefined;
  const usageLabel = selection.provider === 'demo' ? [tokenLabel, '$0.00'].filter(Boolean).join(' · ') : tokenLabel;
  const isLoading = !fixture && loading;
  const connected = Boolean(fixture) || (view.connected && !view.loading);
  const toggleInspector = useCallback(() => setInspector((open) => {
    setWorkshop((current) => ({ ...current, open: false }));
    return !open;
  }), []);

  const refreshExtensions = useCallback(async () => {
    const next = await loadExtensions();
    setExtensions(next.state);
    setLiveTools(next.tools);
    return next.state;
  }, []);

  useEffect(() => {
    if (fixture) return;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    setLoading(true);
    setFailure(undefined);
    void Promise.all([
      api<Project[]>('/projects', options), api<Thread[]>('/threads', options),
      api<ProviderInfo[]>('/providers', options), api<Settings>('/settings', options),
      loadExtensions(),
    ]).then(([projects, threads, providers, settings, plugins]) => {
      if (controller.signal.aborted) return;
      setData({ projects, threads, providers, settings });
      setExtensions(plugins.state);
      setLiveTools(plugins.tools);
      setLoading(false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setFailure(message(error));
      setLoading(false);
    });
    return () => controller.abort();
  }, [reload, fixture]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('extendo-theme', theme); }
    catch {}
  }, [theme]);

  const selectThread = useCallback((id: string) => {
    const item = threads.find((thread) => thread.id === id);
    if (!item) return;
    setActiveProject(item.projectId);
    setActiveThread(id);
    setForcedProvider(undefined);
    setNotice(undefined);
  }, [threads]);

  const cancelTurn = useCallback(() => {
    if (!thread || !socket.current) return;
    void socket.current.call('cancel', { sessionId: thread.sessionId }).catch((error: unknown) => setNotice(message(error)));
  }, [thread?.sessionId, socket]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
      }
      if (event.key === 'Escape' && !event.defaultPrevented && !palette && !preferences && !openProject && (status === 'working' || status === 'waiting')) {
        event.preventDefault();
        cancelTurn();
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [cancelTurn, palette, preferences, openProject, status]);

  const createThread = async (worktree = false) => {
    if (fixture) return;
    if (!project) { setOpenProject(true); return; }
    try {
      const created = await api<Thread>('/threads', json('POST', { projectId: project.id }));
      setData((current) => ({ ...current, threads: [created, ...current.threads] }));
      setActiveThread(created.id);
      setForcedProvider(undefined);
      setNotice(undefined);
      if (!worktree) return;
      try {
        const moved = await createWorktree(created.sessionId);
        setData((current) => ({
          ...current,
          threads: current.threads.map((item) => item.id === moved.thread.id ? moved.thread : item),
        }));
        setNotice(`This thread runs in its own worktree on ${moved.branch}.`);
      } catch (error) {
        setNotice(`The thread started in the shared checkout: ${message(error)}`);
      }
    } catch (error) { setNotice(message(error)); }
  };
  const forgetThread = useCallback((id: string) => {
    setData((current) => ({ ...current, threads: current.threads.filter((item) => item.id !== id) }));
    setActiveThread((current) => current === id ? undefined : current);
    setNotice(undefined);
  }, []);
  const saveProject = async (path: string) => {
    const created = await api<Project>('/projects', json('POST', { path }));
    setData((current) => ({
      ...current,
      projects: current.projects.some(({ id }) => id === created.id) ? current.projects : [...current.projects, created],
    }));
    setActiveProject(created.id);
    setActiveThread(undefined);
  };
  const saveSettings = async (settings: Settings) => {
    const saved = await api<Settings>('/settings', json('PUT', settings));
    setData((current) => ({ ...current, settings: saved }));
    setForcedProvider(saved);
  };
  const send = async (content: string) => {
    if (fixture) throw new Error('Switch to Demo data to send messages.');
    if (!thread || !socket.current) throw new Error('Open a connected conversation first.');
    await socket.current.call('send-message', { sessionId: thread.sessionId, content, ...selection });
    setData((current) => ({ ...current, threads: current.threads.map((item) => item.id === thread.id
      ? { ...item, provider: selection.provider, model: selection.model ?? provider?.model ?? selection.provider } : item) }));
  };
  const steerSubagent = async (subagentId: string, message: string) => {
    if (!thread || !socket.current) throw new Error('Reconnect before steering.');
    const result = await socket.current.call('subagent-steer', { sessionId: thread.sessionId, subagentId, message });
    if (!result.steered) throw new Error('That subagent is no longer running.');
  };
  const stopSubagent = async (subagentId: string) => {
    if (!thread || !socket.current) throw new Error('Reconnect before stopping a subagent.');
    await socket.current.call('subagent-stop', { sessionId: thread.sessionId, subagentId });
  };
  const mergePullRequest = async () => {
    if (!thread || !socket.current) return;
    setMerging(true);
    setNotice(undefined);
    try {
      const result = await socket.current.call('pull-request-merge', { sessionId: thread.sessionId });
      if (result.pullRequest) onThread({ ...thread, pullRequest: result.pullRequest });
    } catch (error) {
      setNotice(message(error));
    } finally {
      setMerging(false);
    }
  };
  const openWorkshop = useCallback((id?: string) => {
    setWorkshop({ open: true, selected: id });
    setInspector(false);
  }, []);
  const createPlugin = async (name: string) => {
    const created = await createExtension({ name });
    setExtensions(created.state);
    await refreshExtensions();
    setWorkshop({ open: true, selected: created.extension.id });
  };
  const savePlugin = async (id: string, source: string) => {
    const saved = await saveExtension(id, source);
    setExtensions(saved.state);
    await refreshExtensions();
    return { ok: !saved.extension.error, error: saved.extension.error };
  };
  const deletePlugin = async (id: string) => {
    setExtensions(await removeExtension(id));
    await refreshExtensions();
    setWorkshop((current) => ({ ...current, selected: current.selected === id ? undefined : current.selected }));
  };
  const togglePreview = () => {
    if (thread?.preview) {
      setPanelTab('Preview');
      setInspector(true);
      return;
    }
    toggleInspector();
    setPanelTab('Overview');
  };
  const answerFor = async (sessionId: string, requestId: string, decision: ApprovalDecision) => {
    if (!socket.current) throw new Error('Reconnect before answering.');
    const result = await socket.current.call('answer-approval', { sessionId, requestId, decision });
    if (!result.accepted) throw new Error('That approval request is no longer pending.');
  };
  const answer = async (requestId: string, decision: ApprovalDecision) => {
    if (!thread || !socket.current) throw new Error('Reconnect before answering.');
    const result = await socket.current.call('answer-approval', { sessionId: thread.sessionId, requestId, decision });
    if (!result.accepted) throw new Error('That approval request is no longer pending.');
  };

  return <>
    <Shell projects={projects} threads={threads} providers={data.providers} selection={selection}
      onSelectModel={(next, model) => setForcedProvider({ provider: next, model })}
      projectId={project?.id} thread={thread} providerLabel={providerLabel}
      loading={isLoading} now={now} rightOpen={inspector} onToggleRight={toggleInspector} usageLabel={thread ? usageLabel : undefined}
      onOpenWorkshop={() => openWorkshop()} workshopOpen={workshop.open}
      onSelectProject={(id) => { setActiveProject(id); setActiveThread(undefined); setForcedProvider(undefined); setNotice(undefined); }}
      onSelectThread={selectThread} onNewThread={() => { void createThread(); }} onOpenProject={() => setOpenProject(true)}
      onOpenPalette={() => setPalette(true)} onOpenSettings={() => setPreferences(true)} labels={fixture?.labels}
      rail={<Inspector key={thread?.id} thread={thread} project={project} status={status} messages={messages} now={now}
        tab={panelTab} onTabChange={setPanelTab} onClose={toggleInspector}
        onSteer={steerSubagent} onStop={stopSubagent} onApproval={answerFor}
        revision={view.revision} onThread={onThread} onDeleted={forgetThread} />}>
      <div className="extendo-main" data-workshop={workshop.open ? 'open' : undefined}
        style={workshop.open ? { paddingInlineEnd: 'var(--workshop-inset)' } : undefined}>
        {notice && <div className="extendo-notice" role="alert"><CircleAlert size={14} aria-hidden="true" />{notice}<button type="button" onClick={() => setNotice(undefined)}>Dismiss</button></div>}
        {thread && <RunBar thread={thread} previewOpen={inspector && panelTab === 'Preview'}
          merging={merging} onMerge={() => { void mergePullRequest(); }} onTogglePreview={togglePreview} />}
        {thread || isLoading ? (
          <ChatSurface key={thread?.id ?? 'loading'} title={thread?.title} messages={messages} draft={view.draft} approvals={view.approvals} status={status}
            loading={isLoading || (!fixture && view.loading)} error={view.error} providerLabel={providerLabel} connected={connected}
            needsProvider={Boolean(thread && !provider?.configured)} onSend={send} onCancel={cancelTurn} onApproval={answer}
            subagents={thread?.subagents ?? []} waitingSubagents={waitingSubagents}
            onOpenSubagents={() => { setPanelTab('Subagents'); setInspector(true); }}
            onSubagentApproval={answerFor}
            onOpenSettings={() => setPreferences(true)} onOpenPalette={() => setPalette(true)}
            onSelectDemo={() => setForcedProvider({ provider: 'demo', model: sampleProvider.model })} suggestions={suggestions}
            liveTools={liveTools} pluginTools={pluginTools} pluginCount={extensions.extensions.length}
            onOpenWorkshop={() => openWorkshop()} />
        ) : (
          <section className="extendo-home" aria-label="Workspace">
            {failure ? <><CircleAlert size={25} /><h1>Can’t reach Extendo</h1><p>{failure}</p><button onClick={() => setReload((value) => value + 1)}>Try again</button></>
              : project ? <><Terminal size={25} /><h1>Start a new thread</h1><p>Pick a task to work on in {project.name}.</p><button onClick={() => { void createThread(); }}>New thread</button></>
                : <><FolderOpen size={25} /><h1>Open a project</h1><p>Choose a local folder. Your threads and changes stay on this machine.</p><button onClick={() => setOpenProject(true)}>Open folder</button></>}
          </section>
        )}
      </div>
    </Shell>
    <CommandPalette open={palette} threads={threads} onSelectThread={selectThread} onClose={() => setPalette(false)} commands={[
      { id: 'new', title: 'New thread', description: 'Start a conversation in this project', run: () => { void createThread(); } },
      { id: 'worktree', title: 'New thread in its own worktree', description: 'Give the thread its own branch and checkout', run: () => { void createThread(true); } },
      { id: 'project', title: 'Open project folder', run: () => setOpenProject(true) },
      { id: 'inspector', title: inspector ? 'Hide workspace inspector' : 'Show workspace inspector', description: 'Plan, changes, and terminal', run: toggleInspector },
      { id: 'settings', title: 'Settings', description: 'Model and appearance', run: () => setPreferences(true) },
      { id: 'workshop', title: 'Open the workshop', description: 'Write a plugin and hot-load it into this session', run: () => openWorkshop() },
    ]} />
    <SettingsDialog open={preferences} settings={data.settings} providers={data.providers} theme={theme} onTheme={setTheme} onSave={saveSettings} onClose={() => setPreferences(false)} />
    <OpenProjectDialog open={openProject} onSave={saveProject} onClose={() => setOpenProject(false)} />
    <Workshop open={workshop.open} state={extensions} tools={liveTools} selected={workshop.selected}
      onSelect={(id) => setWorkshop((current) => ({ ...current, selected: id }))}
      onCreate={createPlugin} onSave={savePlugin} onRemove={deletePlugin}
      onClose={() => setWorkshop((current) => ({ ...current, open: false }))} />
    {import.meta.env.DEV && stressMode && <nav className="extendo-stress" aria-label="UI test data">
      {[['demo', 'Demo data'], ['worst', 'Worst case'], ['empty', 'Empty'], ['one', 'One']].map(([key, label]) =>
        <a key={key} href={'?data=' + key} aria-current={stressMode === key ? 'page' : undefined}>{label}</a>)}
    </nav>}
  </>;
}
