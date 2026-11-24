import type {
  CommitResult, CreateWorktreeResult, FileChange, GitCapabilities, GitHubCliState, PullRequestResult,
  PushResult, WorktreeInfo, WorktreeRemoval, WorkspaceStatus,
} from '@extendo/contracts';
import { readChange } from './diff.js';
import { missingBinary, nodeExec, type Exec } from './exec.js';
import { readStatus } from './status.js';
import { addWorktree, listWorktrees, removeWorktree, worktreePath } from './worktrees.js';

export { nodeExec, type Exec, type CommandResult } from './exec.js';
export { secretReason } from './secrets.js';
export { parseStatus, type ParsedStatus } from './status.js';
export { parseWorktreeList, worktreePath } from './worktrees.js';

export type GitErrorCode =
  | 'no-git' | 'not-a-repo' | 'blocked' | 'unsafe' | 'nothing-staged' | 'no-remote' | 'detached'
  | 'gh-missing' | 'gh-unauthenticated' | 'failed';

/** A refusal a person can act on: what was stopped, and why. */
export class GitError extends Error {
  constructor(readonly code: GitErrorCode, message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitServiceOptions {
  exec?: Exec;
  gh?: string;
  /** How long a `gh` probe stays warm; it is the only check that leaves the machine's process table. */
  capabilitiesTtlMs?: number;
  now?: () => number;
}

const MESSAGE_LIMIT = 2_000;

export function slug(text: string): string {
  const cleaned = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return cleaned || 'work';
}

/**
 * One interface to a checkout: read its state, move changes between the index and the worktree,
 * commit, push, open a pull request, and give a thread its own worktree. Nothing here force-pushes,
 * stages a credential, or reports success it did not observe.
 */
export class GitService {
  private readonly exec: Exec;
  private readonly gh: string;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly capabilitiesCache = new Map<string, { at: number; value: GitCapabilities }>();
  private version?: string;

  constructor(options: GitServiceOptions = {}) {
    this.exec = options.exec ?? nodeExec();
    this.gh = options.gh ?? 'gh';
    this.ttl = options.capabilitiesTtlMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  private git(cwd: string, args: string[], timeoutMs?: number) {
    return this.exec('git', args, { cwd, timeoutMs });
  }

  async capabilities(cwd: string, refresh = false): Promise<GitCapabilities> {
    const cached = this.capabilitiesCache.get(cwd);
    if (!refresh && cached && this.now() - cached.at < this.ttl) return cached.value;
    const [git, ghVersion, auth, remote] = await Promise.all([
      this.git(cwd, ['--version']),
      this.exec(this.gh, ['--version'], { cwd }),
      this.exec(this.gh, ['auth', 'status'], { cwd }),
      this.git(cwd, ['remote', 'get-url', 'origin']),
    ]);
    const url = remote.code === 0 ? remote.stdout.trim() || undefined : undefined;
    const host = url?.match(/^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)|(?:[^@/]+@)?([^:/]+):)/i);
    const bare = host?.[1] ?? host?.[2];
    const github = Boolean(bare && /^(?:www\.)?github\.com$/i.test(bare));
    const available = ghVersion.code === 0;
    const authenticated = available && auth.code === 0;
    const detail = !available ? 'GitHub CLI (gh) is not installed on this machine'
      : !authenticated ? `gh is installed but not signed in${auth.stderr.trim() ? `: ${firstLine(auth.stderr)}` : ''}`
      : 'Ready to open a pull request';
    const value: GitCapabilities = {
      git: git.code === 0 ? git.stdout.trim().replace(/^git version\s+/i, '') : undefined,
      gh: { available, authenticated, detail } satisfies GitHubCliState,
      remote: url ? { name: 'origin', url, host: bare, github } : undefined,
    };
    this.version ??= value.git;
    this.capabilitiesCache.set(cwd, { at: this.now(), value });
    return value;
  }

  async status(cwd: string): Promise<WorkspaceStatus> {
    const version = this.version ?? (await this.capabilities(cwd)).git;
    return readStatus(this.exec, cwd, version);
  }

  private async requireRepo(cwd: string): Promise<WorkspaceStatus> {
    const status = await this.status(cwd);
    if (!status.repo || !status.root) throw new GitError('not-a-repo', status.error ?? 'This workspace is not a git repository');
    return status;
  }

  private async requireRepoRoot(cwd: string): Promise<{ root: string; status: WorkspaceStatus }> {
    const status = await this.requireRepo(cwd);
    return { root: status.root!, status };
  }

  async change(cwd: string, path: string, staged: boolean): Promise<FileChange> {
    const { root, status } = await this.requireRepoRoot(cwd);
    const entry = status.files.find((file) => file.path === path);
    if (!entry) throw new GitError('unsafe', `${path} is not a changed file in this checkout`);
    return readChange(this.exec, root, path, staged);
  }

  async stage(cwd: string, paths: string[], allowSecrets = false): Promise<WorkspaceStatus> {
    const { root, status } = await this.requireRepoRoot(cwd);
    const known = new Map(status.files.map((file) => [file.path, file]));
    const unknown = paths.filter((path) => !known.has(path));
    if (unknown.length) throw new GitError('unsafe', `${unknown[0]} is not a changed file in this checkout`);
    const blocked = paths.filter((path) => known.get(path)?.blocked !== undefined);
    if (blocked.length && !allowSecrets) {
      const first = known.get(blocked[0]!)!;
      throw new GitError('blocked', `Extendo will not stage ${first.path}: ${first.blocked}`, {
        paths: blocked.map((path) => ({ path, reason: known.get(path)?.blocked })),
      });
    }
    const result = await this.git(root, ['add', '--', ...paths]);
    if (result.code !== 0) throw new GitError('failed', firstLine(result.stderr) || 'git could not stage those paths');
    return this.status(root);
  }

  async unstage(cwd: string, paths: string[]): Promise<WorkspaceStatus> {
    const { root } = await this.requireRepoRoot(cwd);
    const restore = await this.git(root, ['restore', '--staged', '--', ...paths]);
    if (restore.code === 0) return this.status(root);
    const reset = await this.git(root, ['reset', '--quiet', '--', ...paths]);
    if (reset.code !== 0) throw new GitError('failed', firstLine(reset.stderr || restore.stderr) || 'git could not unstage those paths');
    return this.status(root);
  }

  /** Undoes worktree changes only. A staged file has to be unstaged first, and that is said, not done. */
  async discard(cwd: string, paths: string[]): Promise<WorkspaceStatus> {
    const { root, status } = await this.requireRepoRoot(cwd);
    const known = new Map(status.files.map((file) => [file.path, file]));
    const unsafe = paths.filter((path) => {
      const file = known.get(path);
      return !file || (file.staged !== 'none' && !file.untracked);
    });
    if (unsafe.length) throw new GitError('unsafe', `Unstage ${unsafe[0]} before discarding it`, { paths: unsafe });
    const untracked = paths.filter((path) => known.get(path)?.untracked);
    const tracked = paths.filter((path) => !known.get(path)?.untracked);
    if (untracked.length) {
      const clean = await this.git(root, ['clean', '-f', '-d', '--', ...untracked]);
      if (clean.code !== 0) throw new GitError('failed', firstLine(clean.stderr) || 'git could not remove those files');
    }
    if (tracked.length) {
      const restore = await this.git(root, ['restore', '--worktree', '--', ...tracked]);
      if (restore.code !== 0) throw new GitError('failed', firstLine(restore.stderr) || 'git could not restore those files');
    }
    return this.status(root);
  }

  async commit(cwd: string, message: string): Promise<CommitResult> {
    const text = message.trim();
    if (!text) throw new GitError('nothing-staged', 'Write a commit message before committing');
    if (text.length > MESSAGE_LIMIT) throw new GitError('failed', `Keep the commit message under ${MESSAGE_LIMIT} characters`);
    const { root, status } = await this.requireRepoRoot(cwd);
    const staged = status.files.filter((file) => file.staged !== 'none');
    if (!staged.length) throw new GitError('nothing-staged', 'Nothing is staged to commit');
    const blocked = staged.filter((file) => file.blocked !== undefined);
    if (blocked.length) {
      throw new GitError('blocked', `A secret path is staged: unstage ${blocked[0]!.path} before committing`, {
        paths: blocked.map((file) => ({ path: file.path, reason: file.blocked })),
      });
    }
    const commit = await this.git(root, ['commit', '-m', text], 120_000);
    if (commit.code !== 0) throw new GitError('failed', lastLines(commit.stderr || commit.stdout, 6) || 'git could not create the commit');
    const head = await this.git(root, ['log', '-1', '--format=%H%n%h%n%s']);
    const [sha = '', shortSha = '', subject = ''] = head.stdout.trim().split('\n');
    return { sha, shortSha, subject, branch: status.branch };
  }

  async push(cwd: string): Promise<PushResult> {
    const { root, status } = await this.requireRepoRoot(cwd);
    if (!status.branch) throw new GitError('detached', 'This checkout is not on a branch, so there is nothing to push');
    if (!status.remote) throw new GitError('no-remote', 'This checkout has no remote named origin to push to');
    const args = status.upstream
      ? ['push']
      : ['push', '--set-upstream', 'origin', status.branch];
    const pushed = await this.git(root, args, 120_000);
    if (pushed.code !== 0) {
      const raw = (pushed.stderr || pushed.stdout).trim();
      const rejected = /non-fast-forward|fetch first|rejected/i.test(raw);
      throw new GitError('failed', rejected
        ? `The remote has commits this branch does not, and Extendo never force-pushes. Pull or rebase ${status.branch} yourself, then push again. ${summarize(raw)}`
        : summarize(raw) || 'git could not push this branch');
    }
    const after = await this.status(root);
    const output = (pushed.stderr || pushed.stdout).trim();
    const summary = output.split('\n').map((line) => line.trim())
      .find((line) => line.includes('->') || /^Everything up-to-date/i.test(line))
      ?? firstLine(output) ?? `Pushed ${status.branch}`;
    return {
      upstream: after.upstream ?? (status.upstream ?? `origin/${status.branch}`),
      summary,
    };
  }

  async pullRequest(cwd: string, input: { title?: string; body?: string } = {}): Promise<PullRequestResult> {
    const { root, status } = await this.requireRepoRoot(cwd);
    const capabilities = await this.capabilities(root, true);
    if (!capabilities.gh.available) throw new GitError('gh-missing', capabilities.gh.detail);
    if (!capabilities.gh.authenticated) throw new GitError('gh-unauthenticated', capabilities.gh.detail);
    if (!status.branch) throw new GitError('detached', 'Open a pull request from a branch, not a detached checkout');
    const existing = await this.exec(this.gh, ['pr', 'view', '--json', 'url,number,title'], { cwd: root });
    if (existing.code === 0) {
      const view = safeJson(existing.stdout);
      if (isRecord(view)) {
        return { created: false, url: text(view.url), number: number(view.number), title: text(view.title) };
      }
    }
    if (!status.upstream || status.ahead > 0) await this.push(root);
    const title = input.title?.trim();
    const args = ['pr', 'create', '--head', status.branch];
    if (title) args.push('--title', title.slice(0, 240), '--body', (input.body ?? '').slice(0, 20_000) || title);
    else args.push('--fill');
    const created = await this.exec(this.gh, args, { cwd: root });
    if (created.code !== 0) throw new GitError('failed', lastLines(created.stderr || created.stdout, 5) || 'gh could not open a pull request');
    const url = created.stdout.split('\n').map((line) => line.trim()).find((line) => /^https?:\/\/\S+$/.test(line));
    const matched = url?.match(/\/pull\/(\d+)$/);
    return { created: true, url, number: matched ? Number(matched[1]) : undefined, title };
  }

  async worktrees(cwd: string, current?: string): Promise<WorktreeInfo[]> {
    return listWorktrees(this.exec, cwd, current);
  }

  /** The branch a new worktree starts from: whatever the workspace's checkout has checked out now. */
  async baseBranch(cwd: string): Promise<string> {
    const { root } = await this.requireRepoRoot(cwd);
    const head = await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = head.stdout.trim();
    if (head.code !== 0 || !branch || branch === 'HEAD') {
      throw new GitError('detached', 'The workspace checkout is not on a branch, so there is no base to branch from');
    }
    return branch;
  }

  async createWorktree(cwd: string, input: { title: string; base?: string }): Promise<CreateWorktreeResult> {
    const { root } = await this.requireRepoRoot(cwd);
    const base = input.base?.trim() || await this.baseBranch(root);
    const verify = await this.git(root, ['rev-parse', '--verify', `refs/heads/${base}`]);
    if (verify.code !== 0) throw new GitError('failed', `There is no branch named ${base} to start from`);
    const stem = `extendo/${slug(input.title)}`;
    const branch = await this.allocateBranch(root, stem);
    const path = worktreePath(root, branch.replaceAll('/', '-'));
    const added = await addWorktree(this.exec, root, { path, branch, base });
    if (added.code !== 0) throw new GitError('failed', added.stderr || 'git could not create the worktree');
    return { path, branch, base };
  }

  private async allocateBranch(root: string, stem: string): Promise<string> {
    for (let attempt = 1; attempt < 100; attempt++) {
      const candidate = attempt === 1 ? stem : `${stem}-${attempt}`;
      const exists = await this.git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
      if (exists.code !== 0) return candidate;
    }
    throw new GitError('failed', 'Could not find a free branch name');
  }

  /** What removing a worktree would destroy, so the confirmation can name it. */
  async inspectWorktree(path: string): Promise<WorktreeRemoval> {
    const status = await this.status(path);
    if (!status.repo) throw new GitError('not-a-repo', status.error ?? 'That worktree is not a git checkout');
    const uncommitted = status.files.slice(0, 50);
    const unpushed = await this.git(status.root!, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
    return {
      path: status.root!,
      branch: status.branch,
      clean: status.files.length === 0,
      uncommitted,
      total: status.files.length,
      unpushed: unpushed.code === 0 ? Number(unpushed.stdout.trim()) || 0 : 0,
    };
  }

  async removeWorktree(cwd: string, path: string, force = false): Promise<void> {
    const { root } = await this.requireRepoRoot(cwd);
    if (!force) {
      const inspection = await this.inspectWorktree(path);
      if (!inspection.clean) {
        throw new GitError('unsafe', `${inspection.path} has ${inspection.total} uncommitted change${inspection.total === 1 ? '' : 's'}`, {
          worktree: inspection,
        });
      }
    }
    const removed = await removeWorktree(this.exec, root, path, force);
    if (removed.code !== 0) throw new GitError('failed', removed.message || 'git could not remove that worktree');
    await this.git(root, ['worktree', 'prune']);
  }

  async deleteBranch(cwd: string, branch: string, force = false): Promise<void> {
    const { root } = await this.requireRepoRoot(cwd);
    const result = await this.git(root, ['branch', ...(force ? ['-D'] : ['-d']), '--', branch]);
    if (result.code !== 0) throw new GitError('unsafe', lastLines(result.stderr, 3) || `git could not delete ${branch}`);
  }
}

function firstLine(value: string): string {
  return value.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

/** The part of git's output that says what happened, without the trailing advice. */
function summarize(value: string): string {
  const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
  const signal = lines.filter((line) => !/^(?:hint:|warning:)/i.test(line)).join(' ').trim();
  return (signal || lines.join(' ')).slice(0, 400);
}

function lastLines(value: string, count: number): string {
  return value.split('\n').map((line) => line.trimEnd()).filter(Boolean).slice(-count).join('\n').trim();
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export { missingBinary };
