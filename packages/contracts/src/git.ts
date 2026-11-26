/** The shape of a checkout's state, as the git surface and the agent's own edits describe it. */

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflict';

export interface ChangedFile {
  path: string;
  /** The name before a rename or copy. */
  origPath?: string;
  /** The file's status in the index, when it differs from HEAD. */
  staged: FileStatus | 'none';
  /** The file's status in the working tree, when it differs from the index. */
  unstaged: FileStatus | 'none';
  untracked: boolean;
  /** Line counts diffing the index against HEAD (staged) or the worktree against the index. */
  additions?: number;
  deletions?: number;
  /** Extendo refuses to stage this path by default; the reason is shown with the file. */
  blocked?: string;
}

export interface GitRemote {
  name: string;
  url?: string;
  /** The host from the remote URL, when there is one. A local path has none. */
  host?: string;
  github: boolean;
}

export interface GitHubCliState {
  /** The `gh` binary answered. */
  available: boolean;
  authenticated: boolean;
  /** What is missing, in one sentence, when a pull request cannot be opened. */
  detail: string;
}

export interface WorkspaceStatus {
  /** The directory is inside a git worktree. When false, `error` says why. */
  repo: boolean;
  error?: string;
  /** The top of the checkout the thread works in. */
  root?: string;
  branch?: string;
  detached?: boolean;
  head?: string;
  headSubject?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  remote?: GitRemote;
  files: ChangedFile[];
  /** The checkout holds more changed files than Extendo lists at once. */
  truncatedFiles?: boolean;
  gitVersion?: string;
}

/** A file rendered as a before/after pair for the diff view, or as a binary notice. */
export interface FileChange {
  path: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  status: FileStatus;
  binary?: boolean;
  truncated?: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch?: string;
  head?: string;
  /** The repository's main checkout, not a linked worktree. */
  main: boolean;
  /** The checkout the thread currently runs in. */
  current: boolean;
  locked?: string;
}

export interface CommitResult {
  sha: string;
  shortSha: string;
  subject: string;
  branch?: string;
}

export interface PushResult {
  upstream?: string;
  summary: string;
}

export interface PullRequestResult {
  number?: number;
  url?: string;
  title?: string;
  created: boolean;
}

export interface GitCapabilities {
  git?: string;
  gh: GitHubCliState;
  remote?: GitRemote;
}

/** What a thread's own worktree says about itself, for the delete confirmation. */
export interface WorktreeRemoval {
  path: string;
  branch?: string;
  clean: boolean;
  /** The uncommitted paths the person would lose, capped and with a count. */
  uncommitted: ChangedFile[];
  total: number;
  /** Commits on the branch that exist nowhere else. */
  unpushed: number;
}

export interface CreateWorktreeResult {
  path: string;
  branch: string;
  base?: string;
  /** The commit the base branch pointed at when the worktree was cut. */
  baseCommit?: string;
}

export type IntegrationMode = 'fast-forward' | 'merge';

/** What landing one branch on another did: the commit the target now carries and how it got there. */
export interface IntegrationResult {
  target: string;
  branch: string;
  /** The commit the target's branch points at now. */
  commit: string;
  shortCommit: string;
  mode: IntegrationMode;
  /** What the target pointed at before, so a caller can prove it moved. */
  previous: string;
  subject: string;
}

export interface BranchCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  at: string;
}

/**
 * A branch measured against the branch it was cut from: the commits it carries, and the merge diff
 * a person would land. `mergeBase` is what both branches share, so the file pairs are the real merge
 * result rather than everything the base did since.
 */
export interface BranchDiff {
  base: string;
  branch: string;
  /** The commit this diff runs from: the fork point when it is known, else the branches' merge base. */
  mergeBase: string;
  commits: BranchCommit[];
  files: FileChange[];
  /** The branch has no commit the base does not already carry. */
  empty: boolean;
}
