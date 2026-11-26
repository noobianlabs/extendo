import {
  ArrowUpRight, Check, ChevronRight, CircleAlert, CircleCheck, CircleDashed, CircleX, Clock3,
  GitBranch, GitCommitHorizontal, RefreshCw,
} from 'lucide-react';
import { Suspense, lazy, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { BranchDiff, CrewMember, FileChange, Issue, IssueState, SteerMode, Thread } from '@extendo/contracts';
import { ApiError } from '../api';
import { ConfirmDialog, type ConfirmRequest } from '../studio/dialogs';
import { land, readDiff, steer } from '../crew/client';
import { boardLabels, relativeTime } from './board';
import styles from './console.module.css';

const DiffView = lazy(() => import('../chat/diff'));
const number = new Intl.NumberFormat();

const issueLabels: Record<IssueState, string> = {
  open: 'Open',
  'in-progress': 'In progress',
  'needs-you': 'Needs you',
  'in-review': 'In review',
  done: 'Done',
  canceled: 'Canceled',
};

const letter: Record<string, string> = {
  added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', conflict: 'U', untracked: '?',
};

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Extendo could not complete that action.';
}

/** The conflicting paths a refusal names, so the row can show what git could not settle. */
function conflictPaths(error: unknown): string[] | undefined {
  const detail = error instanceof ApiError ? error.detail : undefined;
  const paths = detail?.paths;
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : undefined;
}

function StateMark({ member }: { member: CrewMember }) {
  const state = member.state;
  const Icon = state === 'done' ? CircleCheck : state === 'failed' ? CircleX
    : state === 'waiting-approval' ? Clock3 : CircleDashed;
  return <Icon size={13} data-state={state} className={styles.stateMark} aria-hidden="true" />;
}

function nameOf(path: string): { parent: string; name: string } {
  const name = path.split('/').at(-1) ?? path;
  return { parent: path.slice(0, Math.max(0, path.length - name.length)), name };
}

function FileRow({ file, expanded }: { file: FileChange; expanded: boolean }) {
  const { parent, name } = nameOf(file.path);
  return <>
    <span className={styles.crewLetter} data-status={file.status} aria-hidden="true">{letter[file.status] ?? 'M'}</span>
    <span className={styles.crewPath} title={file.path} dir="ltr">
      <span className={styles.crewPathParent}>{parent}</span><span className={styles.crewPathName}>{name}</span>
    </span>
    <span className={styles.crewCounts} data-empty={file.binary ? '' : undefined}>
      {file.binary ? 'binary'
        : <><span className={styles.crewAdd}>+{number.format(file.additions)}</span><span className={styles.crewDelete}>−{number.format(file.deletions)}</span></>}
    </span>
    <ChevronRight className={styles.chevron} size={13} aria-hidden="true" data-open={expanded || undefined} />
  </>;
}

function Commits({ diff }: { diff: BranchDiff }) {
  return <ol className={styles.crewCommits} aria-label="Commits on this branch">
    {diff.commits.map((commit) => <li key={commit.sha}>
      <GitCommitHorizontal size={12} aria-hidden="true" />
      <code className={styles.crewSha} title={commit.sha}>{commit.shortSha}</code>
      <bdi className={styles.crewSubject} dir="auto" title={commit.subject}>{commit.subject}</bdi>
    </li>)}
  </ol>;
}

/** One worker: its branch and report, the review of what it wrote, landing it, and steering it. */
function Worker({ member, now, onThread, onOpenThread }: {
  member: CrewMember;
  now: number;
  onThread: (thread: Thread) => void;
  onOpenThread?: (threadId: string) => void;
}) {
  const id = useId();
  const state = member.state ?? 'idle';
  const pr = member.pullRequest;
  const seen = relativeTime(member.reportAt, now);
  const running = member.status === 'working' || member.status === 'waiting';
  const landed = member.landed;
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<BranchDiff>();
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [conflict, setConflict] = useState<string[]>([]);
  const [opened, setOpened] = useState<string>();
  const [landing, setLanding] = useState(false);
  const [landedHere, setLandedHere] = useState(member.landed);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<SteerMode>('queue');
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string>();
  const [confirm, setConfirm] = useState<ConfirmRequest>();
  const refresh = useRef<AbortController | undefined>(undefined);

  useEffect(() => { if (!landedHere && member.landed) setLandedHere(member.landed); }, [member.landed, landedHere]);

  const load = () => {
    refresh.current?.abort();
    const controller = new AbortController();
    refresh.current = controller;
    setLoading(true);
    setProblem(undefined);
    readDiff(member.threadId, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setDiff(value); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setProblem(messageOf(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  };

  useEffect(() => {
    if (!open) return;
    load();
    return () => refresh.current?.abort();
  }, [open, member.threadId]);

  const integrate = async () => {
    setLanding(true);
    setProblem(undefined);
    setConflict([]);
    try {
      const result = await land(member.threadId);
      setLandedHere(result.landed);
      if (result.thread) onThread(result.thread);
      load();
    } catch (error) {
      setProblem(messageOf(error));
      setConflict(conflictPaths(error) ?? []);
    } finally {
      setLanding(false);
    }
  };

  const deliver = async (content: string, how: SteerMode) => {
    if (sending) return;
    setSending(true);
    setProblem(undefined);
    setNote(undefined);
    try {
      const result = await steer(member.threadId, content, how);
      setNote(result.delivered === 'interrupt' ? 'Interrupted — the turn ended and a new one started with your message.'
        : result.delivered === 'queue' ? 'Queued — delivered at the worker’s next step.'
        : 'Sent — the worker started a turn with it.');
      setText('');
      if (result.thread) onThread(result.thread);
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setSending(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const content = text.trim();
    if (!content || sending) return;
    if (running && mode === 'interrupt') {
      setConfirm({
        title: 'Interrupt the running turn',
        description: <p>The current turn ends now. Anything it already wrote stays in its worktree, uncommitted, and a
          new turn starts with your message. Nothing on the branch is rewritten.</p>,
        confirmLabel: 'Interrupt the turn',
        onConfirm: () => deliver(content, 'interrupt'),
      });
      return;
    }
    void deliver(content, 'queue');
  };

  const base = member.base;
  const canLand = Boolean(diff && !diff.empty) && !landedHere;
  const files = diff?.files ?? [];
  return <li className={styles.crewMember} data-open={open || undefined}>
    <div className={styles.crewTop}>
      <StateMark member={member} />
      {onOpenThread
        ? <button type="button" className={styles.crewTitle} aria-label={`Open ${member.title}`} title={`Open ${member.title}`}
          onClick={() => onOpenThread(member.threadId)}><bdi dir="auto">{member.title}</bdi></button>
        : <bdi className={styles.crewTitleText} dir="auto" title={member.title}>{member.title}</bdi>}
      <span className={styles.crewState} data-state={state}>{boardLabels[state] ?? state}</span>
    </div>
    {member.branch && <p className={styles.crewBranch} title={`${member.branch}${base ? ` → ${base}` : ''}`}>
      <GitBranch size={12} aria-hidden="true" />
      <bdi dir="ltr">{member.branch}</bdi>
      {base && <><span aria-hidden="true">→</span><bdi dir="auto">{base}</bdi></>}
    </p>}
    {member.report && <blockquote className={styles.crewReport} dir="auto">{member.report}</blockquote>}
    <div className={styles.crewMeta}>
      {pr && <a className={styles.crewLink} href={pr.url} target="_blank" rel="noreferrer"
        data-state={pr.checks === 'failing' ? 'failing' : pr.merged ? 'merged' : 'ready'}>
        #{number.format(pr.number)}<ArrowUpRight size={12} aria-hidden="true" />
      </a>}
      {seen && <span className={styles.crewSeen}>Reported {seen}</span>}
      {landedHere && <span className={styles.crewLandedMark} data-mode={landedHere.mode}>
        <Check size={11} aria-hidden="true" />Landed {landedHere.shortCommit}
      </span>}
    </div>
    {member.steer && <p className={styles.crewSteer} data-mode={member.steer.mode} title={member.steer.text}>
      <span className={styles.crewSteerMode}>{member.steer.mode === 'queue' ? 'Queued' : 'Interrupt'}</span>
      <span className={styles.crewSteerText} dir="auto">{member.steer.text}</span>
    </p>}
    <div className={styles.crewActions}>
      <button type="button" className={styles.crewAction} aria-expanded={open} aria-controls={`${id}-diff`}
        onClick={() => setOpen((value) => !value)}>{open ? 'Hide change' : 'Review change'}</button>
      {base && !landedHere && <button type="button" className={styles.crewPrimary} disabled={landing || !canLand}
        title={canLand ? `Land ${member.branch} on ${base}` : diff?.empty ? 'Nothing committed to land' : 'Reading the branch first'}
        onClick={() => setConfirm({
          title: `Land ${member.branch}`,
          description: <p>Extendo will merge <code>{member.branch}</code> into <code>{base}</code> in the project checkout.
            Nothing is force-moved and nothing is rewritten: a conflict is refused with its paths, and the branch and
            its worktree stay afterwards.</p>,
          confirmLabel: 'Land the branch',
          onConfirm: integrate,
        })}>{landing ? 'Landing…' : `Integrate into ${base}`}</button>}
    </div>
    {open && <div className={styles.crewDiff} id={`${id}-diff`}>
      {loading && <p className={styles.crewNote} role="status">Reading {member.branch}…</p>}
      {diff && diff.empty && <p className={styles.crewEmptyNote}>
        No commits on this branch yet, so there is nothing to diff and nothing to land.
      </p>}
      {diff && !diff.empty && <>
        <div className={styles.crewDiffHead}>
          <span className={styles.crewDiffCount}>{diff.commits.length} commit{diff.commits.length === 1 ? '' : 's'}, {files.length} file{files.length === 1 ? '' : 's'}</span>
          <button type="button" className={styles.crewRefresh} title="Re-read the branch" aria-label="Re-read the branch"
            onClick={load}><RefreshCw size={12} aria-hidden="true" /></button>
        </div>
        <Commits diff={diff} />
        <ul className={styles.crewFiles}>
          {files.map((file) => {
            const expanded = opened === file.path;
            const label = `${file.binary ? 'Binary' : `${number.format(file.additions)} added, ${number.format(file.deletions)} removed`}: ${file.path}`;
            return <li key={file.path}>
              <button type="button" className={styles.crewFile} aria-expanded={expanded} aria-label={label}
                onClick={() => setOpened(expanded ? undefined : file.path)}>
                <FileRow file={file} expanded={expanded} />
              </button>
              {expanded && (file.binary
                ? <p className={styles.crewNote}>A binary file. Extendo shows its name and size, not its bytes.</p>
                : <Suspense fallback={<p className={styles.crewNote} role="status">Loading diff…</p>}>
                  <div className={styles.crewDiffBody}>
                    <DiffView diff={{ path: file.path, before: file.before, after: file.after, additions: file.additions, deletions: file.deletions }} />
                    {file.truncated && <p className={styles.crewNote}>The diff was cut at 256 KB.</p>}
                  </div>
                </Suspense>)}
            </li>;
          })}
        </ul>
      </>}
    </div>}
    {landedHere && <p className={styles.crewLanded}>
      <span>Landed in <bdi>{landedHere.target}</bdi> as <code>{landedHere.shortCommit}</code>, {landedHere.mode === 'fast-forward' ? 'fast-forwarded' : 'with a merge commit'}.</span>
      {member.worktree && <span className={styles.crewKept} title={member.worktree}>
        Branch and worktree kept at <code dir="ltr">{member.worktree.split(/[\\/]/).at(-1)}</code>.
      </span>}
    </p>}
    {problem && <div className={styles.crewProblem} role="alert">
      <CircleAlert size={13} aria-hidden="true" />
      <div>
        <p>{problem}</p>
        {conflict.length > 0 && <ul className={styles.crewConflicts} aria-label="Conflicting files">
          {conflict.map((path) => <li key={path}><code dir="ltr">{path}</code></li>)}
        </ul>}
      </div>
    </div>}
    <form className={styles.crewComposer} onSubmit={(event) => void submit(event)}>
      <div className={styles.crewComposerRow}>
        <label className={styles.srOnly} htmlFor={`${id}-message`}>{`Message ${member.title}`}</label>
        <input id={`${id}-message`} className={styles.crewInput} value={text} disabled={sending}
          placeholder={running ? 'Correct it while it runs…' : 'Send a brief or a correction…'}
          onChange={(event) => setText(event.target.value)} />
        <button type="submit" className={styles.crewSend} disabled={sending || !text.trim()}
          aria-label="Send to worker">{sending ? '…' : running ? (mode === 'interrupt' ? 'Interrupt' : 'Queue') : 'Send'}</button>
      </div>
      {running && <div className={styles.crewModes} role="group" aria-label="How to deliver this message">
        <button type="button" aria-pressed={mode === 'queue'} className={styles.crewMode}
          onClick={() => setMode('queue')} title="Delivered at the worker's next step boundary">Queue</button>
        <button type="button" aria-pressed={mode === 'interrupt'} className={styles.crewMode}
          onClick={() => setMode('interrupt')} title="Ends the current turn and starts one with this message">Interrupt</button>
      </div>}
      {note && <p className={styles.crewNote} role="status">{note}</p>}
    </form>
    <ConfirmDialog request={confirm} onClose={() => setConfirm(undefined)} />
  </li>;
}

function IssueRow({ issue }: { issue: Issue }) {
  return <li className={styles.crewIssue} data-state={issue.state}>
    <span className={styles.crewIssueNumber}>#{number.format(issue.number)}</span>
    <div className={styles.crewIssueBody}>
      <bdi className={styles.crewIssueTitle} dir="auto">{issue.title}</bdi>
      {issue.body && <p className={styles.crewIssueText} dir="auto">{issue.body}</p>}
    </div>
    <span className={styles.crewIssueState} data-state={issue.state}>{issueLabels[issue.state]}</span>
  </li>;
}

/** A captain's crew and the issues it filed: what each worker wrote, where it lands, and what needs a person. */
export function CrewPanel({ thread, now, onThread, onOpenThread }: {
  thread?: Thread;
  now: number;
  onThread?: (thread: Thread) => void;
  onOpenThread?: (threadId: string) => void;
}) {
  const crew = thread?.crew ?? [];
  const issues = thread?.issues ?? [];
  const keep = useMemo(() => onThread ?? (() => {}), [onThread]);
  if (thread?.role !== 'captain') {
    return <p className={styles.empty}>This thread is not a captain. Open a captain to see its crew.</p>;
  }
  const needsYou = issues.filter((issue) => issue.state === 'needs-you').length;
  return <div className={styles.crew}>
    <section className={styles.group} aria-label="Crew">
      <h3 className={styles.groupHeading}>Crew<span>{crew.length ? `${number.format(crew.length)} worker${crew.length === 1 ? '' : 's'}` : 'none'}</span></h3>
      {crew.length ? <ul className={styles.crewList}>
        {crew.map((member) => <Worker key={member.threadId} member={member} now={now}
          onThread={keep} onOpenThread={onOpenThread} />)}
      </ul> : <p className={styles.empty}>No workers yet. The captain starts one with crew.create.</p>}
    </section>
    <section className={styles.group} aria-label="Issues">
      <h3 className={styles.groupHeading}>Issues<span>{needsYou ? `${number.format(needsYou)} need you` : issues.length ? number.format(issues.length) : 'none'}</span></h3>
      {issues.length ? <ul className={styles.crewIssues}>
        {issues.map((issue) => <IssueRow key={issue.id} issue={issue} />)}
      </ul> : <p className={styles.empty}>No issues filed. A captain files one when work outlives its turn.</p>}
    </section>
  </div>;
}