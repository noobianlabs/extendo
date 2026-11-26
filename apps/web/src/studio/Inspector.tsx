import { lazy, Suspense, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  ChevronRight, Circle, CircleCheck, CircleDot, CircleX, FileCode2, FilePenLine,
  FileSearch, FlaskConical, PanelRight, SquareTerminal, Wrench, X,
} from 'lucide-react';
import type { AgentStatus, ApprovalDecision, JsonValue, Message, Project, Thread } from '@extendo/contracts';
import { SourceSurface } from '../git/Source';
import { boardLabels } from '../console/board';
import { humanizeTool } from '../chat/messages';
import { PreviewPane } from '../console/preview';
import { SubagentsPanel } from '../console/subagents';
import { CrewPanel } from '../console/crew';
import board from '../console/console.module.css';
import styles from './inspector.module.css';

const DiffView = lazy(() => import('../chat/diff'));

const tabs = ['Overview', 'Crew', 'Subagents', 'Changes', 'Terminal', 'Preview'] as const;
/** The order tabs leave the strip in when the panel cannot hold them all. */
const hiddenOrder: readonly InspectorTab[] = ['Terminal', 'Preview'];
export type InspectorTab = typeof tabs[number];
type WorkState = 'done' | 'running' | 'failed' | 'queued';
type ToolKind = 'read' | 'edit' | 'test' | 'shell' | 'other';
type ToolEntry = Extract<Message, { role: 'assistant' }>['tools'][number];
type Activity = ToolEntry & { kind: ToolKind; state: WorkState; target?: string };
type Change = {
  path: string; before?: string; after?: string; additions?: number; deletions?: number; summary?: string; simulated: boolean;
};
type PlanStep = { text: string; state: WorkState };

const statusLabel: Record<AgentStatus, string> = {
  idle: 'Idle', working: 'Working', waiting: 'Waiting', failed: 'Failed',
};
const stateLabel: Record<WorkState, string> = {
  done: 'Done', running: 'In progress', failed: 'Failed', queued: 'To do',
};
const planMilestone = {
  read: 'Inspect the workspace', edit: 'Apply changes', test: 'Run checks',
};
const toolUI = {
  read: { icon: FileSearch, title: 'Read file' },
  edit: { icon: FilePenLine, title: 'Edit file' },
  test: { icon: FlaskConical, title: 'Run checks' },
  shell: { icon: SquareTerminal, title: 'Run command' },
  other: { icon: Wrench, title: 'Use tool' },
};
const formatNumber = new Intl.NumberFormat();

function record(value?: JsonValue) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value?: JsonValue) {
  return typeof value === 'string' ? value : undefined;
}

function count(value?: JsonValue) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function activityFor(entry: ToolEntry, pending: WorkState): Activity {
  const input = record(entry.call.input);
  const output = record(entry.result?.output);
  const name = entry.call.name;
  const command = text(input.command) ?? text(output.command);
  const terminal = /(^|[_-])(shell|bash|exec|terminal)([_-]|$)/i.test(name);
  const kind = /(^|[_-])(test|check)([_-]|$)/i.test(name) ||
    (terminal && /\b(test|vitest|jest|pytest|typecheck|lint|check)\b/.test(command ?? '')) ? 'test'
    : terminal ? 'shell'
    : /(^|[_-])(edit|write|patch|replace)([_-]|$)/i.test(name) ? 'edit'
    : /(^|[_-])(read|list|search|grep|glob)([_-]|$)/i.test(name) ? 'read'
    : 'other';
  const exitCode = output.exitCode ?? output.code;
  const state = entry.result
    ? entry.result.isError || output.timedOut === true || (typeof exitCode === 'number' && exitCode !== 0) ? 'failed' : 'done'
    : pending;
  return {
    ...entry, kind, state,
    target: text(output.path) ?? text(input.path) ?? text(input.file) ?? command
      ?? text(input.query) ?? text(input.pattern) ?? text(input.suite),
  };
}

function planFor(messages: Message[], activity: Activity[]): PlanStep[] {
  const kindState = (kind: keyof typeof planMilestone) => {
    const states = activity.filter((item) => item.kind === kind).map((item) => item.state);
    if (states.includes('running')) return 'running';
    return states.at(-1) ?? 'queued';
  };
  const milestone = (line: string): keyof typeof planMilestone | undefined => {
    if (/\b(test\w*|verify\w*|validat\w*|check\w*|lint\w*|typecheck)\b/i.test(line)) return 'test';
    if (/\b(edit\w*|updat\w*|implement\w*|add\w*|patch\w*|fix\w*|refactor\w*)\b/i.test(line)) return 'edit';
    if (/\b(read\w*|inspect\w*|review\w*|find\w*|examin\w*|trac\w*)\b/i.test(line)) return 'read';
  };
  for (const message of messages.toReversed()) {
    if (message.role !== 'assistant') continue;
    const checkboxes: PlanStep[] = [];
    const list: PlanStep[] = [];
    let inPlan = false;
    let inFence = false;
    for (const source of message.content.split('\n')) {
      const line = source.trim();
      if (/^(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const heading = line.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').replace(/:$/, '');
      if (/^(plan|approach|next steps|todo)$/i.test(heading)) {
        inPlan = true;
        continue;
      }
      const item = line.match(/^(?:[-*+]|\d+[.)])\s+(?:\[([xX ])\]\s+)?(.+)/);
      if (!item?.[2]) {
        if (line) inPlan = false;
        continue;
      }
      const label = item[2].replace(/\*\*/g, '').replace(/`/g, '').trim();
      if (!label) continue;
      if (item[1]) {
        checkboxes.push({ text: label, state: item[1].trim() ? 'done' : 'queued' });
      } else if (inPlan) {
        const kind = milestone(label);
        list.push({ text: label, state: kind ? kindState(kind) : 'queued' });
      }
    }
    if (checkboxes.length) return checkboxes;
    if (list.length) return list;
  }
  return (Object.keys(planMilestone) as (keyof typeof planMilestone)[])
    .filter((kind) => activity.some((item) => item.kind === kind))
    .map((kind) => ({
      text: activity.filter((item) => item.kind === kind).every((item) => item.call.name.startsWith('demo_'))
        ? { read: 'Inspect demo files', edit: 'Preview the edit', test: 'Run demo checks' }[kind]
        : planMilestone[kind],
      state: kindState(kind),
    }));
}

function changesFor(activity: Activity[]) {
  const changes = new Map<string, Change>();
  for (const item of activity) {
    if (!item.result || item.result.isError) continue;
    const output = record(item.result.output);
    const path = text(output.path) ?? item.target;
    if (!path) continue;
    const before = text(output.before);
    const after = text(output.after);
    const additions = count(output.additions);
    const deletions = count(output.deletions);
    if (item.kind !== 'edit' && before === undefined && after === undefined &&
      additions === undefined && deletions === undefined) continue;
    if (before !== undefined && before === after) continue;
    changes.set(path, {
      path, before, after, additions, deletions,
      summary: text(output.summary), simulated: output.simulated === true,
    });
  }
  return [...changes.values()];
}

function StateIcon({ state }: { state: WorkState }) {
  const Icon = state === 'done' ? CircleCheck : state === 'running' ? CircleDot : state === 'failed' ? CircleX : Circle;
  return <Icon size={14} data-state={state} role="img" aria-label={stateLabel[state]} />;
}

function Section({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return <section className={styles.section}>
    <h3 className={styles.sectionHeader}>{title}{meta && <span>{meta}</span>}</h3>
    {children}
  </section>;
}

function Stats({ additions, deletions }: Pick<Change, 'additions' | 'deletions'>) {
  if (additions === undefined && deletions === undefined) return null;
  return <span className={styles.stats}>
    {additions !== undefined && <span className={styles.addition}>+{formatNumber.format(additions)}</span>}
    {deletions !== undefined && <span className={styles.deletion}>−{formatNumber.format(deletions)}</span>}
  </span>;
}

function FileRow({ path, additions, deletions, simulated }: Change) {
  const name = path.split(/[\\/]/).at(-1) || path;
  const parent = path.slice(0, -name.length);
  return <>
    <FileCode2 size={14} />
    <span className={styles.path} title={path} dir="ltr">
      <span className={styles.pathParent}>{parent}</span><span className={styles.fileName}>{name}</span>
    </span>
    {simulated && <span className={styles.preview}>Preview</span>}
    <Stats additions={additions} deletions={deletions} />
  </>;
}

function changeLabel({ path, additions, deletions, simulated }: Change) {
  return [
    simulated ? `Preview: ${path}` : path,
    additions !== undefined && `${formatNumber.format(additions)} added`,
    deletions !== undefined && `${formatNumber.format(deletions)} removed`,
  ].filter(Boolean).join(', ');
}

function Diff({ change }: { change: Change }) {
  const { path, before, after, additions, deletions, summary } = change;
  return <div className={styles.diff}>
    {summary && <p>{summary}</p>}
    {before !== undefined && after !== undefined
      ? <Suspense fallback={<p role="status">Loading diff…</p>}>
        <DiffView diff={{ path, before, after, additions: additions ?? 0, deletions: deletions ?? 0 }} />
      </Suspense>
      : !summary && <p>No line diff was returned.</p>}
  </div>;
}

function Terminal({ activity }: { activity: Activity[] }) {
  const entries = activity.filter(({ kind }) => kind === 'test' || kind === 'shell');
  if (!entries.length) return <p className={styles.empty}>No commands run yet.</p>;
  return <div className={styles.terminalList}>
    {entries.map((entry) => {
      const input = record(entry.call.input);
      const output = record(entry.result?.output);
      const command = text(input.command) ?? text(output.command) ?? entry.target ?? entry.call.name;
      const exitCode = count(output.exitCode ?? output.code);
      const plain = text(entry.result?.output) ?? ([
        text(output.stdout), text(output.stderr),
      ].filter(Boolean).join('\n') || text(output.output) || text(output.message) || text(output.summary) || text(output.error));
      const result = plain ?? (entry.result && (
        Array.isArray(entry.result.output) || Object.keys(output).some(
          (key) => !['stdout', 'stderr', 'exitCode', 'code', 'command', 'truncated', 'timedOut', 'simulated'].includes(key),
        )
      ) ? JSON.stringify(entry.result.output, null, 2) : undefined);
      return <article className={styles.terminalCard} key={entry.call.id}>
        <div className={styles.terminalCommand}>
          <span className={styles.prompt} aria-hidden="true">$</span>
          <code dir="ltr">{command}</code>
          <StateIcon state={entry.state} />
        </div>
        {result && <pre tabIndex={0} aria-label="Command output" dir="ltr">{result}</pre>}
        {entry.result && (exitCode !== undefined || output.truncated === true || output.timedOut === true || output.simulated === true || !result) &&
          <div className={styles.terminalFoot}>
            {exitCode !== undefined ? `Exit ${exitCode}` : !result ? 'No output' : null}
            {output.simulated === true && <span>Simulated</span>}
            {output.timedOut === true && <span>Timed out</span>}
            {output.truncated === true && <span>Output truncated</span>}
          </div>}
      </article>;
    })}
  </div>;
}

export function Inspector({
  thread, project, messages, status, now, tab: controlled, onTabChange, onClose, onSteer, onStop, onApproval,
  revision, onThread, onDeleted,
}: {
  thread?: Thread;
  project?: Project;
  messages: Message[];
  status: AgentStatus;
  now: number;
  tab?: InspectorTab;
  onTabChange?: (tab: InspectorTab) => void;
  onClose: () => void;
  onSteer: (subagentId: string, message: string) => Promise<void>;
  onStop: (subagentId: string) => Promise<void>;
  onApproval: (sessionId: string, requestId: string, decision: ApprovalDecision) => Promise<void>;
  /** Bumps when the thread writes a file, so the working tree can be re-read. */
  revision: number;
  onThread: (thread: Thread) => void;
  onDeleted: (threadId: string) => void;
}) {
  const [ownTab, setTab] = useState<InspectorTab>('Overview');
  const tab = controlled ?? ownTab;
  const visibleTabs: readonly InspectorTab[] = thread?.role === 'captain' ? tabs : tabs.filter((name) => name !== 'Crew');
  const active = visibleTabs.includes(tab) ? tab : 'Overview';
  const selectTab = (next: InspectorTab) => {
    setTab(next);
    onTabChange?.(next);
  };
  const strip = useRef<HTMLDivElement>(null);
  const needed = useRef(0);
  const [compact, setCompact] = useState(0);
  const [overflow, setOverflow] = useState<'' | 'start' | 'end' | 'both'>('');
  const [moreOpen, setMoreOpen] = useState(false);
  const more = useRef<HTMLDivElement>(null);
  const moreId = useId();
  const hiddenTabs: readonly InspectorTab[] = hiddenOrder.slice(0, compact);
  const shown = visibleTabs.filter((name) => !hiddenTabs.includes(name));
  useLayoutEffect(() => {
    const node = strip.current;
    if (!node) return;
    const sync = () => {
      if (compact === 0) needed.current = Math.max(needed.current, node.scrollWidth);
      const room = node.scrollWidth - node.clientWidth;
      if (needed.current <= node.clientWidth + 1) setCompact(0);
      else if (!compact) setCompact(1);
      else if (room > 1 && compact < hiddenOrder.length) setCompact(compact + 1);
      if (room <= 1) return setOverflow('');
      const start = node.scrollLeft > 1;
      const end = node.scrollLeft < room - 1;
      setOverflow(start && end ? 'both' : end ? 'end' : start ? 'start' : '');
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    node.addEventListener('scroll', sync, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener('scroll', sync);
    };
  }, [compact, visibleTabs.length]);
  useLayoutEffect(() => {
    if (!moreOpen) return;
    const menu = more.current?.querySelector<HTMLElement>('[role="menu"]');
    menu?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !more.current?.contains(event.target)) setMoreOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMoreOpen(false);
        more.current?.querySelector<HTMLElement>('button')?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [moreOpen]);
  useLayoutEffect(() => {
    if (!hiddenTabs.length) setMoreOpen(false);
  }, [hiddenTabs.length]);
  useLayoutEffect(() => {
    const node = strip.current;
    const selected = node?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!node || !selected) return;
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    const tab = selected.getBoundingClientRect();
    const start = box.left + parseFloat(style.paddingLeft);
    const end = box.right - parseFloat(style.paddingRight);
    if (tab.right > end) node.scrollLeft += tab.right - end;
    else if (tab.left < start) node.scrollLeft -= start - tab.left;
  }, [active]);
  const [opened, setOpened] = useState<{ threadId?: string; path: string }>();
  const baseId = useId();
  const data = useMemo(() => {
    const currentTurn = messages.findLast((message) => message.role === 'assistant')?.turnId;
    const recentMessages = messages.filter((message) => message.role === 'assistant' && message.turnId === currentTurn);
    const activity: Activity[] = [];
    const recent: Activity[] = [];
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      const current = message.turnId === currentTurn;
      const pending = !current || status === 'idle' ? 'queued' : status === 'failed' ? 'failed' : 'running';
      const items = message.tools.map((tool) => activityFor(tool, pending));
      activity.push(...items);
      if (current) recent.push(...items);
    }
    const changes = changesFor(activity);
    const plan = planFor(recentMessages, recent);
    const state = thread?.state;
    if (plan.length && (state === 'working' || state === 'failed')) {
      const last = plan.at(-1);
      if (last && last.state !== 'failed' && last.state !== 'running') {
        plan[plan.length - 1] = { ...last, state: state === 'failed' ? 'failed' : 'running' };
      }
    }
    return { activity, changes, plan };
  }, [messages, status, thread?.state]);
  const toggleChange = (path: string) => {
    setOpened((current) => current && current.threadId === thread?.id && current.path === path ? undefined : { threadId: thread?.id, path });
  };
  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % shown.length
      : event.key === 'ArrowLeft' ? (index - 1 + shown.length) % shown.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    const button = event.currentTarget.parentElement?.querySelectorAll('button')[next];
    button?.focus();
    button?.click();
  }
  return <section className={styles.inspector} aria-label="Inspector">
    <div className={styles.header}>
      <PanelRight size={15} /><h2>Inspector</h2>
      <button type="button" className={styles.close} title="Close inspector" aria-label="Close inspector" onClick={onClose}>
        <X size={15} />
      </button>
    </div>
    <div className={styles.tabs} ref={strip} role="tablist" aria-label="Inspector views" data-overflow={overflow || undefined}>
      {shown.map((name, index) => <button
        key={name} type="button" role="tab" id={`${baseId}-${name}-tab`}
        aria-selected={active === name} aria-controls={`${baseId}-${name}`} tabIndex={active === name ? 0 : -1}
        onClick={() => selectTab(name)} onKeyDown={(event) => navigateTabs(event, index)}
      >{name}</button>)}
      {hiddenTabs.length > 0 && <div className={styles.more} ref={more}>
        <button type="button" aria-haspopup="menu" aria-expanded={moreOpen} aria-controls={moreId}
          data-selected={hiddenTabs.includes(active) || undefined}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown') return;
            event.preventDefault();
            setMoreOpen(true);
          }}
          onClick={() => setMoreOpen((open) => !open)}
        >{hiddenTabs.includes(active) ? active : 'More'}</button>
        {moreOpen && <div className={styles.moreMenu} id={moreId} role="menu" aria-label="More inspector views"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setMoreOpen(false);
              more.current?.querySelector<HTMLElement>('button')?.focus();
              return;
            }
            const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
            const at = items.indexOf(document.activeElement as HTMLElement);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              items[(at + step + items.length) % items.length]?.focus();
            }
          }}>
          {hiddenTabs.map((name) => <button key={name} type="button" role="menuitemradio" aria-checked={active === name}
            className={styles.moreItem} onClick={() => { selectTab(name); setMoreOpen(false); }}>{name}</button>)}
        </div>}
      </div>}
    </div>
    {visibleTabs.map((name) => <div key={name} id={`${baseId}-${name}`} role="tabpanel"
      aria-labelledby={shown.includes(name) ? `${baseId}-${name}-tab` : undefined}
      aria-label={shown.includes(name) ? undefined : name}
      className={styles.panel} hidden={active !== name} tabIndex={0}>
      {active === name && (!thread && name !== 'Preview' ? <p className={styles.empty}>Open a thread to inspect its work.</p>
        : name === 'Crew' ? <CrewPanel thread={thread} now={now} />
        : name === 'Subagents' ? <SubagentsPanel thread={thread} now={now} onSteer={onSteer} onStop={onStop} onApproval={onApproval} />
        : name === 'Preview' ? <PreviewPane thread={thread} now={now} />
        : !thread ? <p className={styles.empty}>Open a thread to inspect its work.</p>
        : name === 'Overview' ? <>
          <div className={styles.sessionState}>
            <span className={board.boardDot} data-state={thread.state} aria-hidden="true" />
            {thread.state ? boardLabels[thread.state] : statusLabel[status]}</div>
          <Section title="Plan" meta={data.plan.length ? `${formatNumber.format(data.plan.filter((item) => item.state === 'done').length)} of ${formatNumber.format(data.plan.length)}` : undefined}>
            {data.plan.length ? <ol className={styles.plan}>
              {data.plan.map((item, index) => <li key={index}><StateIcon state={item.state} /><span dir="auto">{item.text}</span></li>)}
            </ol> : <p className={styles.empty}>No plan recorded yet.</p>}
          </Section>
          <Section title="Changed files" meta={data.changes.length ? formatNumber.format(data.changes.length) : undefined}>
            {data.changes.length ? <ul className={styles.files}>
              {data.changes.map((change) => {
                const expanded = opened?.threadId === thread.id && opened.path === change.path;
                return <li key={change.path}>
                  <button type="button" className={styles.fileRow} aria-expanded={expanded} aria-label={changeLabel(change)}
                    onClick={() => toggleChange(change.path)}>
                    <FileRow {...change} /><ChevronRight className={styles.chevron} size={13} />
                  </button>
                  {expanded && <Diff change={change} />}
                </li>;
              })}
            </ul> : thread.pullRequest ? <p className={styles.empty}>
              The pull request on {thread.pullRequest.branch} carries {formatNumber.format(thread.pullRequest.changedFiles)} files,
              {' '}+{formatNumber.format(thread.pullRequest.additions)} −{formatNumber.format(thread.pullRequest.deletions)}. Tool-level diffs appear here as this session edits files.
            </p> : <p className={styles.empty}>No file changes yet.</p>}
          </Section>
          <Section title="Activity">
            {data.activity.length ? <ul className={styles.activity}>
              {data.activity.slice(-6).reverse().map((item) => {
                const { icon: Icon, title } = toolUI[item.kind];
                return <li key={item.call.id}>
                  <span className={styles.activityIcon}><Icon size={14} /></span>
                  <div><div className={styles.activityTitle}>{item.kind === 'other' ? item.call.name
                    : item.call.name === 'demo_edit' ? 'Preview edit' : item.call.name === 'demo_check' ? 'Run demo checks' : title}</div>
                    {item.target && <code title={item.target} dir="auto">{item.target}</code>}
                  </div>
                  <StateIcon state={item.state} />
                </li>;
              })}
            </ul> : <p className={styles.empty}>No tools run yet.</p>}
          </Section>
        </> : name === 'Changes' ? <SourceSurface
          thread={thread} project={project} active={active === 'Changes'} agentStatus={status}
          revision={revision} onThread={onThread} onDeleted={onDeleted} />
        : <Terminal activity={data.activity} />)}
    </div>)}
  </section>;
}
