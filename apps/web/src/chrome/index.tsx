import type { ProviderInfo } from '@extendo/contracts';
import {
  ChevronLeft, ChevronRight, ChevronsUpDown, CircleCheck, CircleX, Clock3, Command, Cpu, Folder,
  FolderOpen, GitBranch, Merge, MessagesSquare, PanelLeft, PanelLeftClose, PanelRight, Plus,
  Search, Settings, X, type LucideIcon,
} from 'lucide-react';
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type ReactNode, type RefObject,
} from 'react';
import { subagentCounts, type Project, type Thread } from '@extendo/contracts';
import { boardLabels, elapsed, groupBoard, threadState, threadSummary } from '../console/board';
import { ModelPicker } from '../console/modelPicker';
import board from '../console/console.module.css';
import './shell.css';

const defaultLabels = {
  newThread: 'New thread',
  commands: 'Command palette',
  threads: 'Threads',
  filterThreads: 'Filter threads',
  settings: 'Settings',
  openProject: 'Open folder',
};

export type ShellLabels = { [K in keyof typeof defaultLabels]: string };

export interface ShellProps {
  projects: Project[];
  threads: Thread[];
  providers: ProviderInfo[];
  selection: { provider: string; model?: string };
  onSelectModel: (provider: string, model: string) => void;
  projectId?: string;
  thread?: Thread;
  providerLabel: string;
  loading: boolean;
  now: number;
  rightOpen: boolean;
  onToggleRight: () => void;
  onSelectProject: (id: string) => void;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onOpenProject: () => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  children: ReactNode;
  rail: ReactNode;
  labels?: Partial<ShellLabels>;
  usageLabel?: string;
}

const pageSize = 40;
const countFormat = new Intl.NumberFormat();
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dateYearFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fullDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' });
const relativeDateFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const projectName = (project: Project) => project.name?.trim() || 'Untitled project';
const threadName = (thread: Thread) => thread.title?.trim() || 'Untitled thread';
const normalizeSearch = (value: string) => value.normalize('NFKD').replace(/\p{Mark}/gu, '').toLocaleLowerCase();

function formatThreadDate(value: string, now: number) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime()) || date.getTime() === 0) return;
  const today = new Date(now);
  const isToday = date.toDateString() === today.toDateString();
  return {
    short: isToday ? relativeDateFormat.format(0, 'day')
      : (date.getFullYear() === today.getFullYear() ? dateFormat : dateYearFormat).format(date),
    full: fullDateFormat.format(date),
  };
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

function useDrawerFocus(
  open: boolean,
  initial: RefObject<HTMLElement | null>,
  opener: RefObject<HTMLButtonElement | null>,
) {
  const previouslyOpen = useRef(false);
  useLayoutEffect(() => {
    if (open && !previouslyOpen.current && initial.current) {
      const node = initial.current;
      (node.matches('button') ? node : drawerFocusables(node)[0] ?? node).focus({ preventScroll: true });
    }
    if (!open && previouslyOpen.current && !document.activeElement?.closest('dialog[open]')) {
      opener.current?.focus({ preventScroll: true });
    }
    previouslyOpen.current = open;
  }, [open, initial, opener]);
}

function drawerFocusables(panel: HTMLElement) {
  return Array.from(panel.querySelectorAll<HTMLElement>(
    'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex], [contenteditable="true"]',
  )).filter(element => element.tabIndex >= 0 && !element.matches(':disabled') &&
    !element.closest('[inert]') && element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === 'visible');
}

function onDrawerKeyDown(event: KeyboardEvent<HTMLElement>, close: () => void) {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = drawerFocusables(event.currentTarget);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
  } else if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function Icon({ icon: Glyph, size = 15 }: { icon: LucideIcon; size?: number }) {
  return <Glyph size={size} className="extendo-chrome-icon" aria-hidden="true" />;
}

function Mark() {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M2.75 3.5h15l-2.7 2.75H5.5v2.4h9.55l-2.7 2.7H5.5v2.4h9.55l-2.7 2.75h-9.6z" />
      <path d="M15.75 13.75h2.75v2.75h-2.75z" />
    </svg>
  );
}

function PathText({ path }: { path: string }) {
  const end = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (end < 0 || end === path.length - 1) {
    return <bdi className="extendo-chrome-ellipsis extendo-chrome-mono" title={path}>{path}</bdi>;
  }
  return (
    <span className="extendo-chrome-path extendo-chrome-mono" title={path} dir="ltr">
      <span className="extendo-chrome-sr-only">{path}</span>
      <span className="extendo-chrome-path-start" aria-hidden="true">{path.slice(0, end + 1)}</span>
      <bdi className="extendo-chrome-path-end" aria-hidden="true">{path.slice(end + 1)}</bdi>
    </span>
  );
}

function ProjectPicker({
  projects, project, label, onSelect, onOpen,
}: {
  projects: Project[];
  project?: Project;
  label: string;
  onSelect: (id: string) => void;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const picker = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (open) {
      (panel.current?.querySelector<HTMLButtonElement>('[aria-current="true"]') ??
        panel.current?.querySelector<HTMLButtonElement>('button'))?.focus({ preventScroll: true });
      panel.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !picker.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!projects.length) return;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (!open) {
      setOpen(true);
      return;
    }
    const options = Array.from(panel.current?.querySelectorAll('button') ?? []);
    const index = options.findIndex(option => option === document.activeElement);
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, options.length - 1) : Math.max(index - 1, 0);
    options[next]?.focus();
  }

  const title = project ? projectName(project) : projects.length ? 'Choose a project' : label;
  return (
    <div
      className="extendo-chrome-project"
      ref={picker}
      onKeyDown={onKeyDown}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        className="extendo-chrome-project-trigger"
        type="button"
        ref={trigger}
        title={title}
        aria-label={project ? `Switch project, current: ${title}` : title}
        aria-expanded={projects.length ? open : undefined}
        aria-controls={open && projects.length ? menuId : undefined}
        onClick={() => projects.length ? setOpen(value => !value) : onOpen()}
      >
        <span className="extendo-chrome-project-emblem">
          <Icon icon={projects.length ? Folder : FolderOpen} size={15} />
        </span>
        <span className="extendo-chrome-project-text">
          <bdi className="extendo-chrome-ellipsis">{title}</bdi>
          {project?.path?.trim() && <PathText path={project.path} />}
        </span>
        {!!projects.length && <span className="extendo-chrome-project-chevron"><Icon icon={ChevronsUpDown} size={13} /></span>}
      </button>
      {open && projects.length > 0 && (
        <div className="extendo-chrome-project-menu" id={menuId} ref={panel} role="group" aria-label="Projects">
          <div className="extendo-chrome-project-options">
            {projects.map(item => (
              <button
                className="extendo-chrome-project-option"
                type="button"
                key={item.id}
                title={item.path ? `${projectName(item)} · ${item.path}` : projectName(item)}
                aria-current={item.id === project?.id ? 'true' : undefined}
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus({ preventScroll: true });
                  onSelect(item.id);
                }}
              >
                <Icon icon={Folder} size={14} />
                <span className="extendo-chrome-project-text">
                  <bdi className="extendo-chrome-ellipsis">{projectName(item)}</bdi>
                  {item.path?.trim() && <PathText path={item.path} />}
                </span>
              </button>
            ))}
          </div>
          <button type="button" className="extendo-chrome-add-project" title={label} onClick={() => {
            setOpen(false);
            onOpen();
          }}>
            <Icon icon={Plus} size={15} />
            <span className="extendo-chrome-ellipsis" dir="auto">{label}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ThreadList({
  threads, project, activeId, loading, labels, now, onSelect, searchRef,
}: {
  threads: Thread[];
  project?: Project;
  activeId?: string;
  loading: boolean;
  labels: ShellLabels;
  now: number;
  onSelect: (id: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const [query, setQuery] = useState('');
  const [pageOverride, setPageOverride] = useState<{ page: number; activeId?: string }>();
  const [focusedId, setFocusedId] = useState<string>();
  const headingId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const indexed = useMemo(() => threads
    .filter(item => item.projectId === project?.id)
    .map(item => ({ item, search: normalizeSearch(`${threadName(item)} ${item.branch ?? ''}`) })),
  [threads, project?.id]);
  const words = useMemo(() => normalizeSearch(query).trim().split(/\s+/u).filter(Boolean), [query]);
  const filtered = useMemo(() => words.length
    ? indexed.filter(entry => words.every(word => entry.search.includes(word)))
    : indexed, [indexed, words]);
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const activeIndex = filtered.findIndex(({ item }) => item.id === activeId);
  const activePage = Math.floor(Math.max(0, activeIndex) / pageSize);
  const page = pageOverride && pageOverride.activeId === activeId
    ? Math.min(lastPage, pageOverride.page)
    : activePage;
  const start = page * pageSize;
  const visible = filtered.slice(start, start + pageSize);
  const tabId = [focusedId, activeId].find(id => visible.some(({ item }) => item.id === id)) ?? visible[0]?.item.id;

  function getRows() {
    return Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-thread-row]') ?? []);
  }

  function moveRowFocus(event: KeyboardEvent<HTMLUListElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = getRows();
    const index = rows.findIndex(row => row === document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : event.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, 0);
    rows[next]?.focus();
  }

  function updateQuery(value: string) {
    setQuery(value);
    setPageOverride(value.trim() ? { page: 0, activeId } : undefined);
    setFocusedId(undefined);
    listRef.current?.scrollTo({ top: 0 });
  }

  function goToPage(next: number) {
    setPageOverride({ page: next, activeId });
    setFocusedId(undefined);
    listRef.current?.scrollTo({ top: 0 });
  }

  return (
    <section className="extendo-chrome-threads" aria-labelledby={headingId}>
      <div className="extendo-chrome-thread-heading">
        <h2 id={headingId} className="extendo-chrome-ellipsis" title={labels.threads} dir="auto">{labels.threads}</h2>
        {project && !loading && <span className="extendo-chrome-count" aria-live="polite">{countFormat.format(filtered.length)}</span>}
      </div>
      {project && (
        <div className="extendo-chrome-thread-filter">
          <Icon icon={Search} size={14} />
          <input
            ref={searchRef}
            type="search"
            placeholder={labels.filterThreads}
            aria-label={labels.filterThreads}
            value={query}
            dir="auto"
            onChange={event => updateQuery(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                event.stopPropagation();
                updateQuery('');
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                const rows = getRows();
                const row = event.key === 'ArrowDown' ? rows[0] : rows.at(-1);
                if (row) {
                  event.preventDefault();
                  row.focus();
                }
              }
            }}
          />
          {query && (
            <button type="button" className="extendo-chrome-clear" aria-label="Clear thread filter" onClick={() => {
              updateQuery('');
              searchRef.current?.focus();
            }}>
              <Icon icon={X} size={13} />
            </button>
          )}
        </div>
      )}
      <div className="extendo-chrome-thread-scroll" ref={listRef} aria-busy={loading}>
        {visible.length > 0 ? (
          <ul className="extendo-chrome-thread-list" onKeyDown={moveRowFocus}>
            {groupBoard(visible.map(({ item }) => item)).map(({ state, threads: rows }) => {
              const total = filtered.filter(({ item }) => threadState(item) === state).length;
              return (
                <li key={state} className={board.boardGroup}>
                  <h3 className={board.boardHeading} id={`${headingId}-${state}`}>
                    {boardLabels[state]}<span>{countFormat.format(total)}</span>
                  </h3>
                  <ul className={board.nestedList} aria-labelledby={`${headingId}-${state}`}>
                    {rows.map((item) => {
                      const title = threadName(item);
                      const state = threadState(item);
                      const date = formatThreadDate(item.createdAt, now);
                      const summary = threadSummary(item);
                      const since = elapsed(item.stateSince ?? item.updatedAt, now);
                      const pr = item.pullRequest;
                      const details = [title, boardLabels[state], summary, item.branch, date?.full].filter(Boolean).join(' · ');
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            data-thread-row=""
                            aria-current={item.id === activeId ? 'page' : undefined}
                            tabIndex={item.id === tabId ? 0 : -1}
                            className="extendo-chrome-thread-row"
                            title={details}
                            aria-label={details}
                            onFocus={() => setFocusedId(item.id)}
                            onClick={() => onSelect(item.id)}
                          >
                            <span className={board.boardDot} data-state={state} aria-hidden="true" />
                            <span className="extendo-chrome-thread-label">
                              <bdi className="extendo-chrome-ellipsis extendo-chrome-thread-title">{title}</bdi>
                              <span className="extendo-chrome-thread-meta">
                                <span>{summary ?? boardLabels[state]}</span>
                                {since && state !== 'idle' && <><span className="extendo-chrome-meta-dot">·</span><span>{since}</span></>}
                                {!since && date && <><span className="extendo-chrome-meta-dot">·</span>
                                  <time dateTime={item.createdAt} title={date.full}>{date.short}</time></>}
                              </span>
                            </span>
                            {pr && <span className={board.rowPull} title={`#${pr.number} · ${pr.merged ? 'merged' : pr.checks}`}>
                              {pr.merged ? <Merge size={11} aria-hidden="true" />
                                : pr.checks === 'passing' ? <CircleCheck size={11} aria-hidden="true" />
                                : pr.checks === 'failing' ? <CircleX size={11} aria-hidden="true" />
                                : <Clock3 size={11} aria-hidden="true" />}
                              #{pr.number}
                            </span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="extendo-chrome-list-empty" role="status">
            {loading ? 'Loading threads…' : !project ? 'Open a project to start a thread.'
              : words.length ? 'No threads match your filter.' : 'No threads yet.'}
          </div>
        )}
      </div>
      {lastPage > 0 && (
        <div className="extendo-chrome-page">
          <span aria-live="polite">
            {countFormat.format(start + 1)}–{countFormat.format(Math.min(start + pageSize, filtered.length))} of {countFormat.format(filtered.length)}
          </span>
          <button type="button" className="extendo-chrome-icon-button" title="Previous page" aria-label="Previous page"
            aria-disabled={page === 0} onClick={() => page > 0 && goToPage(page - 1)}>
            <span className="extendo-chrome-page-arrow"><Icon icon={ChevronLeft} size={14} /></span>
          </button>
          <button type="button" className="extendo-chrome-icon-button" title="Next page" aria-label="Next page"
            aria-disabled={page === lastPage} onClick={() => page < lastPage && goToPage(page + 1)}>
            <span className="extendo-chrome-page-arrow"><Icon icon={ChevronRight} size={14} /></span>
          </button>
        </div>
      )}
    </section>
  );
}

export function Shell({
  projects, threads, providers, selection, onSelectModel,
  projectId, thread, providerLabel, loading, now, rightOpen, onToggleRight,
  onSelectProject, onSelectThread, onNewThread, onOpenProject, onOpenPalette, onOpenSettings,
  children, rail, labels: overrides, usageLabel,
}: ShellProps) {
  const labels = { ...defaultLabels, ...overrides };
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobile = useMediaQuery('(max-width: 720px)');
  const railOverlay = useMediaQuery('(max-width: 1060px)');
  const navModal = mobile && mobileNavOpen;
  const railModal = rightOpen && railOverlay && !navModal;
  const project = projects.find(item => item.id === (projectId ?? thread?.projectId));
  const sidebarId = useId();
  const railId = useId();
  const navOpener = useRef<HTMLButtonElement>(null);
  const navClose = useRef<HTMLButtonElement>(null);
  const railOpener = useRef<HTMLButtonElement>(null);
  const railPane = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearch = useRef(false);
  const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.platform);

  useDrawerFocus(navModal, navClose, navOpener);
  useDrawerFocus(railModal, railPane, railOpener);
  useEffect(() => {
    if (!mobile) setMobileNavOpen(false);
  }, [mobile]);
  useLayoutEffect(() => {
    if (!collapsed && focusSearch.current) {
      focusSearch.current = false;
      (searchRef.current ?? navClose.current)?.focus();
    }
  }, [collapsed]);

  function closeNav() {
    if (navModal) setMobileNavOpen(false);
  }

  const title = thread ? threadName(thread) : project ? projectName(project) : 'Extendo';
  const path = thread?.cwd?.trim() || project?.path?.trim();
  const branch = thread?.branch?.trim();
  const model = thread?.model?.trim();
  const provider = providerLabel?.trim();
  const rightToggleLabel = rightOpen ? 'Hide workspace panel' : 'Show workspace panel';
  const navToggleLabel = mobile ? 'Close navigation' : collapsed ? 'Expand sidebar' : 'Collapse sidebar';

  return (
    <div
      className="extendo-chrome"
      data-collapsed={collapsed && !mobile}
      data-nav-open={navModal}
      data-right-open={rightOpen}
    >
      {(navModal || railModal) && (
        <div className="extendo-chrome-scrim" aria-hidden="true"
          onClick={() => navModal ? closeNav() : onToggleRight()} />
      )}
      <aside
        className="extendo-chrome-sidebar"
        id={sidebarId}
        role={navModal ? 'dialog' : undefined}
        aria-modal={navModal ? true : undefined}
        aria-label={navModal ? 'Extendo navigation' : 'Projects and threads'}
        inert={railModal || (mobile && !navModal) ? true : undefined}
        onKeyDown={navModal ? event => onDrawerKeyDown(event, () => closeNav()) : undefined}
      >
        <div className="extendo-chrome-brand">
          <div className="extendo-chrome-wordmark"><Mark /><span>Extendo</span></div>
          <button
            type="button" className="extendo-chrome-icon-button extendo-chrome-nav-close"
            ref={navClose} title={navToggleLabel} aria-label={navToggleLabel}
            onClick={() => mobile ? closeNav() : setCollapsed(value => !value)}
          >
            <span className="extendo-chrome-collapse-glyph"><Icon icon={mobile ? X : PanelLeftClose} size={16} /></span>
            <span className="extendo-chrome-expand-glyph"><Mark /></span>
          </button>
        </div>
        <div className="extendo-chrome-sidebar-top">
          <ProjectPicker
            projects={projects} project={project} label={labels.openProject}
            onSelect={id => { closeNav(); onSelectProject(id); }}
            onOpen={() => { closeNav(); onOpenProject(); }}
          />
          <button
            className="extendo-chrome-new"
            type="button"
            disabled={!project || loading}
            title={!project ? 'Open a project to start a thread' : labels.newThread}
            aria-label={labels.newThread}
            onClick={() => { closeNav(); onNewThread(); }}
          >
            <Icon icon={Plus} size={16} />
            <span className="extendo-chrome-action-label extendo-chrome-ellipsis" dir="auto">{labels.newThread}</span>
          </button>
          <button
            className="extendo-chrome-command"
            type="button"
            title={labels.commands}
            aria-label={labels.commands}
            aria-keyshortcuts={isApple ? 'Meta+K' : 'Control+K'}
            onClick={() => { closeNav(); onOpenPalette(); }}
          >
            <Icon icon={Command} size={15} />
            <span className="extendo-chrome-action-label extendo-chrome-ellipsis" dir="auto">{labels.commands}</span>
            <kbd aria-hidden="true" className="extendo-chrome-shortcut">{isApple ? '⌘ K' : 'Ctrl K'}</kbd>
          </button>
          <button
            className="extendo-chrome-icon-button extendo-chrome-expand-threads"
            type="button"
            title={labels.threads}
            aria-label={labels.threads}
            onClick={() => { focusSearch.current = true; setCollapsed(false); }}
          >
            <Icon icon={MessagesSquare} size={17} />
          </button>
        </div>
        <ThreadList
          key={project?.id ?? ''}
          threads={threads}
          project={project}
          activeId={thread?.id}
          loading={loading}
          labels={labels}
          now={now}
          searchRef={searchRef}
          onSelect={id => { closeNav(); onSelectThread(id); }}
        />
        <div className="extendo-chrome-sidebar-footer">
          <button
            className="extendo-chrome-settings"
            type="button"
            title={provider ? `${labels.settings} · ${provider}` : labels.settings}
            aria-label={provider ? `${labels.settings} · ${provider}` : labels.settings}
            onClick={() => { closeNav(); onOpenSettings(); }}
          >
            <span className="extendo-chrome-settings-leading"><Icon icon={Settings} size={16} /></span>
            <span className="extendo-chrome-action-label extendo-chrome-ellipsis" dir="auto">{labels.settings}</span>
          </button>
          <ModelPicker providers={providers} selection={selection} onSelect={(next) => {
            onSelectModel(next.provider, next.model);
            closeNav();
          }} />
        </div>
      </aside>
      <div className="extendo-chrome-workspace">
        <header className="extendo-chrome-header" inert={navModal || railModal ? true : undefined}>
          <div className="extendo-chrome-header-inner">
          <button
            className="extendo-chrome-icon-button extendo-chrome-mobile-nav"
            type="button"
            ref={navOpener}
            title="Open navigation"
            aria-label="Open navigation"
            aria-expanded={navModal}
            aria-controls={sidebarId}
            onClick={() => setMobileNavOpen(true)}
          >
            <Icon icon={PanelLeft} size={17} />
          </button>
          <div className="extendo-chrome-context">
            <h1 className="extendo-chrome-ellipsis" title={title} dir="auto">{title}</h1>
            {thread && (() => {
              const state = threadState(thread);
              const counts = subagentCounts(thread.subagents ?? []);
              const since = elapsed(thread.stateSince ?? thread.updatedAt, now);
              const swarm = [
                counts.waiting ? `${counts.waiting} subagent${counts.waiting === 1 ? '' : 's'} blocked` : undefined,
                counts.running ? `${counts.running} running` : undefined,
                counts.queued ? `${counts.queued} queued` : undefined,
                !counts.waiting && !counts.running && !counts.queued && counts.done ? `${counts.done} done` : undefined,
              ].filter(Boolean).slice(0, 2);
              return <span className="extendo-chrome-runstate" data-state={state}>
                <span className={board.boardDot} data-state={state} aria-hidden="true" />
                <span>{boardLabels[state]}</span>
                {since && <span className="extendo-chrome-elapsed">{since}</span>}
                {swarm.length > 0 && <span className="extendo-chrome-swarm">{swarm.join(' · ')}</span>}
              </span>;
            })()}
            {branch && <span className="extendo-chrome-branch extendo-chrome-head-item" title={branch}>
              <Icon icon={GitBranch} size={13} />
              <bdi className="extendo-chrome-ellipsis extendo-chrome-mono">{branch}</bdi>
            </span>}
            {path && <span className="extendo-chrome-header-path extendo-chrome-head-item"><PathText path={path} /></span>}
            {(branch || model || path) && <div className="extendo-chrome-mobile-context">
              {branch && <bdi className="extendo-chrome-ellipsis extendo-chrome-mono" title={branch}>{branch}</bdi>}
              {branch && model && <span aria-hidden="true">·</span>}
              {model && <bdi className="extendo-chrome-ellipsis extendo-chrome-mono" title={model}>{model}</bdi>}
              {!branch && !model && path && <PathText path={path} />}
            </div>}
          </div>
          <div className="extendo-chrome-header-actions">
            {model && (
              <span className="extendo-chrome-model extendo-chrome-head-item" title={model}>
                <Icon icon={Cpu} size={13} />
                <bdi className="extendo-chrome-ellipsis extendo-chrome-mono">{model}</bdi>
              </span>
            )}
            {usageLabel?.trim() && <span className="extendo-chrome-usage extendo-chrome-head-item extendo-chrome-mono extendo-chrome-ellipsis" title={usageLabel}>{usageLabel}</span>}
            <button
              className="extendo-chrome-icon-button extendo-chrome-rail-toggle"
              type="button"
              ref={railOpener}
              title={rightToggleLabel}
              aria-label={rightToggleLabel}
              aria-expanded={rightOpen}
              aria-controls={railId}
              onClick={onToggleRight}
            >
              <Icon icon={PanelRight} size={17} />
            </button>
          </div>
          </div>
        </header>
        <div className="extendo-chrome-stage">
          <main className="extendo-chrome-main" inert={navModal || railModal ? true : undefined}>{children}</main>
          <aside
            id={railId}
            className="extendo-chrome-rail"
            ref={railPane}
            hidden={!rightOpen || navModal}
            role={railModal ? 'dialog' : undefined}
            aria-modal={railModal ? true : undefined}
            aria-label="Workspace panel"
            tabIndex={railModal ? -1 : undefined}
            onKeyDown={railModal ? event => onDrawerKeyDown(event, onToggleRight) : undefined}
          >
            <div className="extendo-chrome-rail-content">{rail}</div>
          </aside>
        </div>
      </div>
    </div>
  );
}
