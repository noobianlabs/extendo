import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ArrowDown, ArrowUp, ChevronRight, CircleAlert, GitBranch, GitFork, GitPullRequest,
  Lock, Minus, Plus, RefreshCw, Trash2,
} from 'lucide-react';
import type { AgentStatus, ChangedFile, FileChange, GitView, Project, Thread, WorktreeRemoval } from '@extendo/contracts';
import { ApiError } from '../api';
import { ConfirmDialog, type ConfirmRequest } from '../studio/dialogs';
import {
  commit, createWorktree, deleteThread, discard, openPullRequest, push, readChange, readStatus,
  removeWorktree, stage, unstage, type CheckoutRef,
} from './client';
import styles from './source.module.css';

type Group = { id: 'staged' | 'changes' | 'untracked'; title: string; files: ChangedFile[] };

const DiffView = lazy(() => import('../chat/diff'));
const number = new Intl.NumberFormat();

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Extendo could not complete that action.';
}

function detailOf(error: unknown): Record<string, unknown> | undefined {
  return error instanceof ApiError ? error.detail : undefined;
}

function nameOf(path: string): { parent: string; name: string } {
  const name = path.split('/').at(-1) ?? path;
  return { parent: path.slice(0, Math.max(0, path.length - name.length)), name };
}

function shortPath(path: string, segments = 2): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= segments ? path : parts.slice(-segments).join('/');
}

const letter: Record<string, string> = {
  added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', conflict: 'U', untracked: '?', none: '',
};

export interface SourceSurfaceProps {
  thread?: Thread;
  project?: Project;
  /** The Changes tab is the visible one, so it is worth refreshing. */
  active: boolean;
  agentStatus?: AgentStatus;
  /** Bumps whenever this thread writes a file, which is the cue to re-read the working tree. */
  revision: number;
  onThread: (thread: Thread) => void;
  onDeleted: (threadId: string) => void;
}

/**
 * The working tree, as git really has it: the branch and how far it is from its upstream, the three
 * groups a person stages from, the diff behind each file, and the way out — commit, push, pull
 * request. Everything shown here came from a status read of the checkout, never from the transcript.
 */
export function SourceSurface({ thread, project, active, agentStatus, revision, onThread, onDeleted }: SourceSurfaceProps) {
  const sessionId = thread?.sessionId;
  const projectId = project?.id;
  const target = useMemo<CheckoutRef>(() => sessionId ? { sessionId } : { projectId }, [sessionId, projectId]);
  const [view, setView] = useState<GitView>();
  const [problem, setProblem] = useState<string>();
  const [report, setReport] = useState<{ tone: 'ok' | 'bad'; text: string; href?: string }>();
  const [busy, setBusy] = useState<string>();
  const [open, setOpen] = useState<{ path: string; staged: boolean }>();
  const [diff, setDiff] = useState<FileChange>();
  const [diffProblem, setDiffProblem] = useState<string>();
  const [text, setText] = useState('');
  const [confirm, setConfirm] = useState<ConfirmRequest>();
  const [refreshed, setRefreshed] = useState<string>();
  const pendingRefresh = useRef<AbortController | undefined>(undefined);
  const diffToken = useRef(0);
  const field = useId();

  const refresh = useCallback(async () => {
    pendingRefresh.current?.abort();
    const controller = new AbortController();
    pendingRefresh.current = controller;
    try {
      const next = await readStatus(target, controller.signal);
      if (controller.signal.aborted) return;
      setView(next);
      setProblem(undefined);
      setRefreshed(new Date().toISOString());
    } catch (error) {
      if (controller.signal.aborted) return;
      setProblem(message(error));
    }
  }, [target]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    return () => pendingRefresh.current?.abort();
  }, [active, refresh, revision]);

  useEffect(() => {
    if (!active || agentStatus !== 'working') return;
    const timer = setInterval(() => { void refresh(); }, 1_500);
    return () => clearInterval(timer);
  }, [active, agentStatus, refresh]);

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setProblem(undefined);
    setReport(undefined);
    try { await action(); }
    catch (error) { setProblem(message(error)); }
    finally { setBusy(undefined); }
  }, []);

  async function showDiff(file: ChangedFile) {
    const staged = file.staged !== 'none';
    if (open?.path === file.path && open.staged === staged) {
      setOpen(undefined);
      return;
    }
    const token = ++diffToken.current;
    setOpen({ path: file.path, staged });
    setDiff(undefined);
    setDiffProblem(undefined);
    try {
      const change = await readChange(target, file.path, staged);
      if (token === diffToken.current) setDiff(change);
    } catch (error) {
      if (token === diffToken.current) setDiffProblem(message(error));
    }
  }

  function toggleStage(file: ChangedFile) {
    if (file.blocked) {
      setConfirm({
        title: `Stage ${file.path}?`,
        description: <>
          Staging {file.path} puts it in the next commit, where a credential becomes part of the branch's
          history. Extendo refuses it by default: {file.blocked}.
        </>,
        confirmLabel: 'Stage it anyway',
        onConfirm: async () => { setView(await stage(target, [file.path], true)); },
      });
      return;
    }
    void run(file.path, async () => {
      setView(file.staged === 'none' ? await stage(target, [file.path]) : await unstage(target, [file.path]));
    });
  }

  function discardOne(file: ChangedFile) {
    setConfirm({
      title: file.untracked ? `Delete ${file.path}?` : `Discard changes to ${file.path}?`,
      description: file.untracked
        ? <>The file is not tracked by git, so it is removed from disk. This cannot be undone.</>
        : <>The file goes back to what the index holds. This cannot be undone.</>,
      confirmLabel: file.untracked ? 'Delete the file' : 'Discard the changes',
      onConfirm: async () => { setView(await discard(target, [file.path])); setOpen(undefined); },
    });
  }

  function submitCommit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim()) return;
    void run('commit', async () => {
      const result = await commit(target, text);
      setView(result.view);
      setText('');
      setReport({ tone: 'ok', text: `Committed ${result.commit.shortSha} · ${result.commit.subject}` });
    });
  }

  function sendPush() {
    void run('push', async () => {
      const result = await push(target);
      setView(result.view);
      setReport({ tone: 'ok', text: `Pushed ${result.push.summary}` });
    });
  }

  function requestPullRequest() {
    void run('pull', async () => {
      const result = await openPullRequest(target, {});
      setView(result.view);
      const pr = result.pullRequest;
      const label = pr.number === undefined ? 'the pull request' : `pull request #${pr.number}`;
      setReport({
        tone: 'ok',
        href: pr.url,
        text: pr.created ? `Opened ${label}` : `${label[0]!.toUpperCase()}${label.slice(1)} is already open`,
      });
    });
  }

  function moveIntoWorktree() {
    if (!thread) return;
    void run('worktree', async () => {
      const next = await createWorktree(thread.sessionId);
      setView(next);
      onThread(next.thread);
      setReport({ tone: 'ok', text: `Worktree on ${next.branch}, from ${next.base ?? 'the current branch'}` });
    });
  }

  function releaseWorktree() {
    if (!thread) return;
    void run('worktree', async () => {
      try {
        const next = await removeWorktree(thread.sessionId);
        setView(next);
        onThread(next.thread);
        setReport(next.warning ? { tone: 'bad', text: next.warning } : { tone: 'ok', text: 'Back in the shared checkout' });
      } catch (error) {
        const worktree = detailOf(error)?.worktree as WorktreeRemoval | undefined;
        if (!(error instanceof ApiError) || error.code !== 'unsafe' || !worktree) throw error;
        setConfirm({
          title: `Remove the worktree on ${worktree.branch ?? 'this branch'}?`,
          description: <>
            {worktree.total} uncommitted {worktree.total === 1 ? 'change' : 'changes'} would be destroyed:
            <ul>{worktree.uncommitted.slice(0, 6).map((file) => <li key={file.path}>
              <span aria-hidden="true">{letter[file.untracked ? 'untracked' : file.staged !== 'none' ? file.staged : file.unstaged]}</span>
              <code>{file.path}</code>
            </li>)}{worktree.total > 6 && <li><code>and {worktree.total - 6} more</code></li>}</ul>
            {worktree.unpushed > 0 && <>The branch also holds {worktree.unpushed} {worktree.unpushed === 1 ? 'commit' : 'commits'} that exist nowhere else.</>}
          </>,
          confirmLabel: 'Discard and remove',
          option: worktree.branch ? `Delete the branch ${worktree.branch} as well` : undefined,
          onConfirm: async ({ checked }) => {
            const next = await removeWorktree(thread.sessionId, { force: true, branch: checked });
            setView(next);
            onThread(next.thread);
            setReport(next.warning ? { tone: 'bad', text: next.warning } : { tone: 'ok', text: 'Back in the shared checkout' });
          },
        });
      }
    });
  }

  function requestDelete() {
    if (!thread) return;
    void run('delete', async () => {
      try {
        await deleteThread(thread.id);
        onDeleted(thread.id);
      } catch (error) {
        const worktree = detailOf(error)?.worktree as WorktreeRemoval | undefined;
        if (!(error instanceof ApiError) || error.code !== 'unsafe' || !worktree) throw error;
        setConfirm({
          title: `Delete this thread and its worktree?`,
          description: <>
            The thread, its transcript, and the worktree on {worktree.branch ?? 'its branch'} are removed.
            {worktree.total > 0 && <ul>{worktree.uncommitted.slice(0, 6).map((file) => <li key={file.path}>
              <span aria-hidden="true">{letter[file.untracked ? 'untracked' : file.staged !== 'none' ? file.staged : file.unstaged]}</span>
              <code>{file.path}</code>
            </li>)}{worktree.total > 6 && <li><code>and {worktree.total - 6} more</code></li>}</ul>}
            {worktree.total > 0 && 'These uncommitted changes are destroyed.'}
            {worktree.unpushed > 0 && <> {worktree.unpushed} {worktree.unpushed === 1 ? 'commit' : 'commits'} on the branch stay in the repository.</>}
          </>,
          confirmLabel: 'Delete the thread',
          onConfirm: async () => {
            await deleteThread(thread.id, true);
            onDeleted(thread.id);
          },
        });
      }
    });
  }

  const status = view?.status;
  const groups = useMemo<Group[]>(() => {
    const files = status?.files ?? [];
    return [
      { id: 'staged', title: 'Staged', files: files.filter((file) => file.staged !== 'none') },
      { id: 'changes', title: 'Changes', files: files.filter((file) => file.staged === 'none' && !file.untracked) },
      { id: 'untracked', title: 'Untracked', files: files.filter((file) => file.untracked) },
    ];
  }, [status]);
  const stagedCount = groups[0]!.files.length;
  const working = agentStatus === 'working';
  const gh = view?.capabilities.gh;
  const canOpenPullRequest = Boolean(gh?.available && gh.authenticated && view?.capabilities.remote?.host && status?.branch);
  const pullRequestBlocker = !gh || !view || !status?.repo ? undefined
    : !gh.available || !gh.authenticated ? gh.detail
    : !view.capabilities.remote ? 'this checkout has no origin remote'
    : !view.capabilities.remote.host ? `${view.capabilities.remote.name} is a local path, so there is no GitHub repository behind it`
    : !status.branch ? 'this checkout is not on a branch'
    : gh.detail;
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;

  if (!thread && !project) {
    return <p className={styles.empty}>Open a project to see its changes.</p>;
  }

  if (!view) {
    return <div className={styles.empty}>
      {problem ? <p role="alert">{problem}</p> : <p>Reading the working tree…</p>}
      <button type="button" className={styles.action} onClick={() => { void refresh(); }}>{problem ? 'Try again' : 'Refresh'}</button>
    </div>;
  }

  return <div className={styles.source} data-testid="source-surface">
    <header className={styles.checkout}>
      <div className={styles.branchRow}>
        <GitBranch size={14} aria-hidden="true" />
        <span className={styles.branch} dir="ltr" title={status?.branch}>{status?.branch ?? (status?.detached ? 'detached HEAD' : 'no branch')}</span>
        {status?.upstream && <span className={styles.upstream} title={`Upstream ${status.upstream}`}>{status.upstream}</span>}
        {!status?.upstream && status?.branch && <span className={styles.upstream}>not published</span>}
        <span className={styles.counts} aria-label={`${ahead} ahead, ${behind} behind`}>
          <span className={styles.count} data-zero={ahead === 0}><ArrowUp size={10} aria-hidden="true" />{number.format(ahead)}</span>
          <span className={styles.count} data-zero={behind === 0}><ArrowDown size={10} aria-hidden="true" />{number.format(behind)}</span>
        </span>
        <button type="button" className={styles.icon} aria-label="Refresh changes" title="Refresh changes"
          disabled={busy === 'refresh'} onClick={() => { void run('refresh', refresh); }}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.worktreeRow}>
        <GitFork size={14} aria-hidden="true" />
        <span className={styles.worktreeLabel} data-testid="checkout-kind" data-kind={view.checkout.worktree ? 'worktree' : 'shared'}>
          {view.checkout.worktree ? 'Worktree' : 'Shared'}
        </span>
        <code className={styles.worktreePath} title={view.checkout.path} dir="ltr" data-testid="checkout-path">
          {shortPath(view.checkout.path, 1)}
        </code>
        {thread && <button type="button" className={styles.textButton}
          disabled={Boolean(busy) || working}
          title={working ? 'Wait for this turn to finish before moving its checkout' : view.checkout.worktree ? 'Move this thread back to the shared checkout' : 'Give this thread its own worktree and branch'}
          onClick={view.checkout.worktree ? releaseWorktree : moveIntoWorktree}>
          {view.checkout.worktree ? 'Remove' : 'Own worktree'}
        </button>}
      </div>
      {refreshed && <p className={styles.meta}>
        <span className={styles.head}>{status?.head ? `HEAD ${status.head.slice(0, 7)}` : 'no commits yet'}</span>
        {status?.headSubject && <span className={styles.subject} title={status.headSubject}>· {status.headSubject}</span>}
      </p>}
    </header>

    {!status?.repo ? <div className={styles.empty}>
      <p><strong>No repository here.</strong> {status?.error ?? problem ?? 'This workspace is not a git checkout.'}</p>
      <p>Extendo can still edit files here. Stage and commit need a checkout: run <code>git init</code> in {shortPath(view.checkout.path, 3)} and refresh.</p>
    </div> : <div className={styles.body}>
      {status.files.length === 0 && <p className={styles.clean}>
        The working tree is clean on {status.branch ?? 'this checkout'}. Nothing to commit.
      </p>}
      {status.files.length > 0 && groups.map((group) => <section key={group.id} className={styles.group} aria-label={`${group.title}, ${group.files.length}`}>
        <div className={styles.groupHead}>
          <h3 className={styles.groupTitle}>{group.title}</h3>
          <span className={styles.groupCount}>{number.format(group.files.length)}</span>
          {group.files.length > 0 && <button type="button" className={styles.textButton}
            disabled={Boolean(busy)}
            onClick={() => {
              const refused = group.id === 'staged' ? [] : group.files.filter((file) => file.blocked).map((file) => file.path);
              const paths = group.files.map((file) => file.path).filter((path) => !refused.includes(path));
              void run(group.id, async () => {
                if (!paths.length) return;
                setView(group.id === 'staged' ? await unstage(target, paths) : await stage(target, paths));
                if (refused.length) {
                  setReport({ tone: 'ok', text: `Skipped ${refused.join(', ')}: Extendo will not stage it without a deliberate confirmation` });
                }
              });
            }}>{group.id === 'staged' ? 'Unstage all' : 'Stage all'}</button>}
        </div>
        {group.files.length === 0 ? <p className={styles.groupEmpty}>
          {group.id === 'staged' ? 'Nothing staged yet.' : group.id === 'changes' ? 'No unstaged changes.' : 'No untracked files.'}
        </p> : <ul className={styles.files}>
          {group.files.map((file) => {
            const expanded = open?.path === file.path && open.staged === (file.staged !== 'none');
            const { parent, name } = nameOf(file.path);
            const change = letter[file.untracked ? 'untracked' : file.staged !== 'none' ? file.staged : file.unstaged];
            return <li key={`${group.id}-${file.path}`} data-testid="change-row" data-path={file.path}>
              <div className={styles.rowWrap} data-expanded={expanded}>
                <button type="button" className={styles.row} aria-expanded={expanded}
                  aria-label={`${file.path}, ${file.untracked ? 'untracked' : file.staged !== 'none' ? 'staged' : 'unstaged'} ${file.staged !== 'none' ? file.staged : file.unstaged}`}
                  onClick={() => { void showDiff(file); }}>
                  <span className={styles.change} data-change={file.untracked ? 'untracked' : file.staged !== 'none' ? file.staged : file.unstaged} aria-hidden="true">{change}</span>
                  <span className={styles.path} dir="ltr" title={file.path}>
                    <span className={styles.parent}>{parent}</span><span className={styles.name}>{name}</span>
                  </span>
                  {file.blocked && <span className={styles.blocked} title={file.blocked}><Lock size={10} aria-hidden="true" />secret</span>}
                  {(file.additions !== undefined || file.deletions !== undefined) && <span className={styles.stats}>
                    <span className={styles.added}>+{number.format(file.additions ?? 0)}</span>
                    <span className={styles.removed}>−{number.format(file.deletions ?? 0)}</span>
                  </span>}
                  <ChevronRight className={styles.chevron} size={12} aria-hidden="true" />
                </button>
                <button type="button" className={styles.toggle}
                  aria-label={file.blocked ? `Stage ${file.path} anyway` : file.staged === 'none' ? `Stage ${file.path}` : `Unstage ${file.path}`}
                  title={file.blocked ? `Refused: ${file.blocked}` : file.staged === 'none' ? 'Stage this file' : 'Unstage this file'}
                  disabled={Boolean(busy)} onClick={() => toggleStage(file)}>
                  {file.blocked ? <Lock size={12} aria-hidden="true" /> : file.staged === 'none' ? <Plus size={13} aria-hidden="true" /> : <Minus size={13} aria-hidden="true" />}
                </button>
              </div>
              {expanded && <div className={styles.diff}>
                {file.blocked && <p className={styles.hint}><Lock size={11} aria-hidden="true" />Extendo will not stage this path: {file.blocked}</p>}
                {diffProblem ? <p className={styles.hint} role="alert">{diffProblem}</p>
                  : diff ? <Suspense fallback={<p className={styles.hint}>Loading the diff…</p>}><DiffView diff={diff} /></Suspense>
                    : <p className={styles.hint}>Reading the diff…</p>}
                <div className={styles.fileActions}>
                  {!file.untracked && <>
                    <button type="button" className={styles.textButton} disabled={Boolean(busy)}
                      onClick={() => { void run(`${file.path}:stage`, async () => {
                        setView(file.staged === 'none' ? await stage(target, [file.path]) : await unstage(target, [file.path]));
                      }); }}>
                      {file.staged === 'none' ? 'Stage file' : 'Unstage file'}
                    </button>
                    <button type="button" className={styles.textButton} disabled={Boolean(busy) || file.staged !== 'none'}
                      onClick={() => discardOne(file)}>Discard changes</button>
                  </>}
                  {file.untracked && <button type="button" className={styles.textButton} disabled={Boolean(busy)}
                    onClick={() => discardOne(file)}>Delete the file</button>}
                  {file.blocked && <button type="button" className={styles.textButton} disabled={Boolean(busy)}
                    onClick={() => toggleStage(file)}>Stage anyway</button>}
                </div>
              </div>}
            </li>;
          })}
        </ul>}
      </section>)}
    </div>}

    <form className={styles.commitBar} onSubmit={submitCommit} aria-label="Commit staged changes">
      <div className={styles.commitRow}>
        <label className={styles.srOnly} htmlFor={`${field}-message`}>Commit message</label>
        <input id={`${field}-message`} className={styles.input} value={text} dir="auto"
          placeholder={stagedCount ? `${stagedCount} staged — describe the change` : 'Nothing staged to commit'}
          autoComplete="off" spellCheck={false} disabled={!status?.repo}
          onChange={(event) => { setText(event.target.value); }} />
        <button type="submit" className={styles.commitButton} disabled={!status?.repo || stagedCount === 0 || !text.trim() || Boolean(busy)}>
          {busy === 'commit' ? 'Committing…' : 'Commit'}
        </button>
      </div>
      <div className={styles.transport}>
        {status?.repo && <button type="button" className={styles.action} disabled={!status.branch || Boolean(busy) || (ahead === 0 && Boolean(status.upstream))}
          title={!status.remote ? 'This checkout has no remote to push to' : `Push ${status.branch} to ${status.remote.name}`}
          onClick={sendPush}>{busy === 'push' ? 'Pushing…' : ahead > 0 ? `Push ${number.format(ahead)}` : 'Push'}</button>}
        {canOpenPullRequest && <button type="button" className={styles.action} disabled={Boolean(busy)}
          title="Open a pull request with the GitHub CLI" onClick={requestPullRequest}>
          <GitPullRequest size={12} aria-hidden="true" />{busy === 'pull' ? 'Opening…' : 'Pull request'}
        </button>}
        {thread && <button type="button" className={styles.danger} disabled={Boolean(busy)} onClick={requestDelete}>
          <Trash2 size={12} aria-hidden="true" />Delete thread
        </button>}
      </div>
      {pullRequestBlocker && !canOpenPullRequest && <p className={styles.hint} data-testid="pull-request-blocked">
        <CircleAlert size={11} aria-hidden="true" />A pull request is not available: {pullRequestBlocker}
      </p>}
      {status?.repo && !status.remote && <p className={styles.hint}>
        <CircleAlert size={11} aria-hidden="true" />This checkout has no remote named origin, so nothing can be pushed yet.
      </p>}
      {report && <p className={styles.report} data-tone={report.tone} data-testid="source-report">
        {report.href ? <a href={report.href} target="_blank" rel="noreferrer">{report.text}</a> : report.text}
      </p>}
      {problem && <p className={styles.report} data-tone="bad" role="alert" data-testid="source-problem">{problem}</p>}
    </form>

    <ConfirmDialog request={confirm} onClose={() => setConfirm(undefined)} />
  </div>;
}
