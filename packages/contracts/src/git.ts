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
}
