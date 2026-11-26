import type { BranchCommit, BranchDiff, FileChange, FileStatus } from '@extendo/contracts';

/** A refusal a person can act on: what was stopped, and why. */
export type GitErrorCode =
  | 'no-git' | 'not-a-repo' | 'blocked' | 'unsafe' | 'nothing-staged' | 'no-remote' | 'detached'
  | 'gh-missing' | 'gh-unauthenticated' | 'conflict' | 'failed';

export class GitError extends Error {
  constructor(readonly code: GitErrorCode, message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = 'GitError';
  }
}

/** The newest state of a branch pair, shared by the compare and integrate paths. */
export function firstLine(value: string): string {
  return value.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}