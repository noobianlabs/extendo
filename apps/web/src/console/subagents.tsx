import { ArrowUpRight, CircleCheck, CircleDashed, CircleX, Clock3, Octagon, Send } from 'lucide-react';
import { useId, useState } from 'react';
import type { ApprovalDecision, Subagent, SubagentActivity, SubagentState, Thread } from '@extendo/contracts';
import { activityDuration } from '@extendo/contracts';
import styles from './console.module.css';

const groups: { state: SubagentState; label: string }[] = [
  { state: 'running', label: 'Running' },
  { state: 'waiting-approval', label: 'Waiting on you' },
  { state: 'queued', label: 'Queued' },
  { state: 'failed', label: 'Failed' },
  { state: 'stopped', label: 'Stopped' },
  { state: 'done', label: 'Done' },
];

const number = new Intl.NumberFormat();

function duration(subagent: Subagent, now: number) {
  const start = subagent.startedAt ? new Date(subagent.startedAt).getTime() : NaN;
  if (!Number.isFinite(start)) return;
  const end = subagent.endedAt ? new Date(subagent.endedAt).getTime() : now;
  const seconds = Math.max(0, (end - start) / 1000);
  if (seconds < 0.1) return;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

function StateMark({ state }: { state: SubagentState }) {
  const Icon = state === 'done' ? CircleCheck : state === 'failed' ? CircleX
    : state === 'queued' || state === 'stopped' ? CircleDashed
    : state === 'waiting-approval' ? Clock3 : CircleDashed;
  return <Icon size={12} data-state={state} className={styles.stateDot} aria-hidden="true" />;
}

function ActivityLine({ activity }: { activity: SubagentActivity }) {
  return <li className={styles.activityLine} data-state={activity.state}>
    <bdi className={styles.activityLabel} dir="auto" title={activity.label}>{activity.label}</bdi>
    <span className={styles.duration}>{activityDuration(activity)}</span>
  </li>;
}

function Steer({ subagent, onSteer, onStop }: {
  subagent: Subagent;
  onSteer: (id: string, message: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const fieldId = useId();
  const live = subagent.state === 'running' || subagent.state === 'waiting-approval';
  if (!live) return null;
  async function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await onSteer(subagent.id, text);
      setDraft('');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return <div className={styles.steer}>
    <label htmlFor={fieldId} className="extendo-chrome-sr-only">Steer {subagent.title}</label>
    <input id={fieldId} className={styles.steerInput} value={draft} dir="auto" placeholder="Steer this subagent…"
      aria-invalid={failed || undefined} aria-describedby={failed ? `${fieldId}-error` : undefined}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          void submit();
        }
      }} />
    <button type="button" className={styles.quietButton} disabled={busy || !draft.trim()} onClick={() => void submit()}
      title="Send this steer note to the subagent">
      <Send size={11} aria-hidden="true" />Steer
    </button>
    <button type="button" className={styles.quietButton} onClick={() => void onStop(subagent.id)} title={`Stop ${subagent.title}`}>
      <Octagon size={11} aria-hidden="true" />Stop
    </button>
    {failed && <span id={`${fieldId}-error`} role="alert" className={styles.error}>The steer did not reach the subagent.</span>}
  </div>;
}

function Approval({ subagent, onApproval }: {
  subagent: Subagent;
  onApproval: (sessionId: string, requestId: string, decision: ApprovalDecision) => Promise<void>;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const request = subagent.approval;
  if (!request) return null;
  const target = typeof request.call.input === 'object' && request.call.input && 'path' in request.call.input
    ? String((request.call.input as { path: unknown }).path) : undefined;
  async function answer(decision: ApprovalDecision) {
    setState('busy');
    try {
      await onApproval(subagent.sessionId, request!.requestId, decision);
      setState('idle');
    } catch {
      setState('failed');
    }
  }
  return <div className={styles.approval} role="group" aria-label={`Approve ${request.call.name} in ${subagent.title}`}>
    <p className={styles.approvalAsk}>
      Wants to run <code>{request.call.name}</code>{target ? <> on <code dir="ltr" title={target}>{target}</code></> : null}
    </p>
    <div className={styles.approvalActions}>
      <button type="button" className={styles.quietButton} disabled={state === 'busy'}
        onClick={() => void answer('allow')}>Allow once</button>
      <button type="button" className={styles.quietButton} disabled={state === 'busy'}
        onClick={() => void answer('always')}>Always</button>
      <button type="button" className={styles.quietButton} disabled={state === 'busy'}
        onClick={() => void answer('deny')}>Deny</button>
      {state === 'failed' && <span className={styles.error} role="alert">That approval is no longer pending.</span>}
    </div>
  </div>;
}

function SubagentRow({ subagent, now, onSteer, onStop, onApproval }: {
  subagent: Subagent;
  now: number;
  onSteer: (id: string, message: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onApproval: (sessionId: string, requestId: string, decision: ApprovalDecision) => Promise<void>;
}) {
  const time = duration(subagent, now);
  const active = subagent.state === 'running' || subagent.state === 'waiting-approval' || subagent.state === 'queued';
  const lines = subagent.activity.slice(active ? -4 : -2);
  return <article className={styles.subagent}>
    <div className={styles.subagentTop}>
      <StateMark state={subagent.state} />
      <bdi className={styles.subagentTitle} dir="auto" title={subagent.title}>{subagent.title}</bdi>
      {subagent.role && <span className={styles.role}>{subagent.role}</span>}
      {subagent.state === 'queued' && subagent.position !== undefined
        ? <span className={styles.duration}>#{subagent.position} in queue</span>
        : time && <span className={styles.duration} title="Elapsed">{time}</span>}
    </div>
    {lines.length > 0 && <ul className={styles.activity}>
      {lines.map((activity) => <ActivityLine key={activity.id} activity={activity} />)}
    </ul>}
    {subagent.error && <p className={styles.error} role="alert" dir="auto">{subagent.error}</p>}
    {subagent.report && !subagent.error && <p className={styles.report} dir="auto">
      {subagent.report.length > 240 ? `${subagent.report.slice(0, 240)}…` : subagent.report}
    </p>}
    <Approval subagent={subagent} onApproval={onApproval} />
    <Steer subagent={subagent} onSteer={onSteer} onStop={onStop} />
  </article>;
}

export function SubagentsPanel({
  thread, now, onSteer, onStop, onApproval,
}: {
  thread?: Thread;
  now: number;
  onSteer: (id: string, message: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onApproval: (sessionId: string, requestId: string, decision: ApprovalDecision) => Promise<void>;
}) {
  const swarm = thread?.subagents ?? [];
  if (!thread) return <p className={styles.empty}>Open a thread to see its subagents.</p>;
  if (!swarm.length) return <p className={styles.empty}>
    No subagents yet. Ask Extendo to split the work into parallel tracks and delegated runs appear here, one line per session.
  </p>;
  return <div>
    {groups.map(({ state, label }) => {
      const rows = swarm.filter((subagent) => subagent.state === state);
      if (!rows.length) return null;
      return <section className={styles.group} key={state} aria-label={label}>
        <h3 className={styles.groupHeading}>{label}<span>{number.format(rows.length)}</span></h3>
        {rows.map((subagent) => <SubagentRow key={subagent.id} subagent={subagent} now={now}
          onSteer={onSteer} onStop={onStop} onApproval={onApproval} />)}
      </section>;
    })}
  </div>;
}

export function subagentTabLabel(count: number) {
  return count ? `Subagents ${number.format(count)}` : 'Subagents';
}

export function OpenPullRequest({ url }: { url: string }) {
  return <a className={styles.quietButton} href={url} target="_blank" rel="noreferrer">
    Open on GitHub<ArrowUpRight size={11} aria-hidden="true" />
  </a>;
}
