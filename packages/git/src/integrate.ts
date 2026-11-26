import type { IntegrationResult } from '@extendo/contracts';
import type { Exec } from './exec.js';
import { firstLine, GitError } from './errors.js';

async function git(exec: Exec, cwd: string, args: string[], timeoutMs?: number) {
  return exec('git', args, { cwd, timeoutMs });
}

async function refExists(exec: Exec, root: string, branch: string): Promise<boolean> {
  const found = await git(exec, root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return found.code === 0;
}

async function head(exec: Exec, root: string, ref: string): Promise<string> {
  const found = await git(exec, root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (found.code !== 0) throw new GitError('failed', `Could not read ${ref}`);
  return found.stdout.trim();
}

interface Conflict {
  tree?: string;
  paths: string[];
  message: string;
}

/**
 * Runs the merge git would run, without touching a branch, an index, or a worktree:
 * `merge-tree --write-tree` builds the result in memory and names the paths it could not settle.
 * Exit code 1 means the merge conflicts; anything else non-zero is a different failure.
 */
async function scratchMerge(exec: Exec, root: string, target: string, branch: string): Promise<Conflict> {
  const result = await git(exec, root, ['merge-tree', '--write-tree', '-z', '--name-only', target, branch], 120_000);
  const parts = result.stdout.split('\0');
  const tree = parts[0]?.trim() || undefined;
  const paths: string[] = [];
  for (const part of parts.slice(1)) {
    if (part === '') break;
    paths.push(part);
  }
  const message = firstLine(result.stderr) || firstLine(parts.slice(paths.length + 2).join('\n'));
  if (result.code === 0) return { tree, paths: [], message };
  if (result.code === 1 && paths.length) return { tree, paths, message };
  throw new GitError('failed', message || `git could not merge ${branch} into ${target}`, { paths });
}

/** The checkout that currently has `branch` checked out, if one does. */
async function checkoutOf(exec: Exec, root: string, branch: string): Promise<string | undefined> {
  const list = await git(exec, root, ['worktree', 'list', '--porcelain']);
  if (list.code !== 0) return undefined;
  for (const block of list.stdout.split(/\n\n+/)) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const path = lines[0]?.startsWith('worktree ') ? lines[0].slice('worktree '.length) : undefined;
    if (path && lines.includes(`branch refs/heads/${branch}`)) return path;
  }
  return undefined;
}

export interface IntegrateInput {
  target: string;
  branch: string;
  /** The merge commit's subject; the fast-forward case has none because it creates no commit. */
  message?: string;
}

/**
 * Lands one branch on another. Nothing here forces a ref, rewrites a commit, or resolves a conflict
 * on its own: the merge is proven clean in git's scratch state first, and the branch is only moved
 * after that. A refusal leaves every branch, index and worktree exactly where it was.
 *
 * A target that is already an ancestor fast-forwards, so the history gains the worker's commits and
 * nothing else; a diverged target gets a real merge commit with both parents.
 */
export async function integrateBranch(exec: Exec, root: string, input: IntegrateInput): Promise<IntegrationResult> {
  const target = input.target.trim();
  const branch = input.branch.trim();
  if (!target || !branch) throw new GitError('failed', 'Name both the branch to land and the branch to land it on');
  if (target === branch) throw new GitError('unsafe', `${target} is already the branch being landed`);
  if (!await refExists(exec, root, target)) throw new GitError('failed', `There is no branch named ${target} to land on`);
  if (!await refExists(exec, root, branch)) throw new GitError('failed', `There is no branch named ${branch} to land`);

  const previous = await head(exec, root, `refs/heads/${target}`);
  const incoming = await head(exec, root, `refs/heads/${branch}`);

  const ancestry = await git(exec, root, ['merge-base', '--is-ancestor', target, branch]);
  const fastForward = ancestry.code === 0;
  if (fastForward && previous === incoming) {
    throw new GitError('unsafe', `${branch} has no commit that ${target} does not already carry`);
  }

  const checkout = await checkoutOf(exec, root, target);
  if (checkout) {
    const status = await git(exec, checkout, ['status', '--porcelain']);
    if (status.code === 0 && status.stdout.trim()) {
      throw new GitError('unsafe', `${checkout} has uncommitted changes on ${target}. Commit or stash them before landing ${branch}.`, { checkout });
    }
  }

  const scratch = fastForward ? { paths: [], tree: undefined, message: '' } as Conflict : await scratchMerge(exec, root, target, branch);
  if (scratch.paths.length) {
    const listed = scratch.paths.slice(0, 20);
    throw new GitError(
      'conflict',
      `Landing ${branch} on ${target} would conflict in ${scratch.paths.length} file${scratch.paths.length === 1 ? '' : 's'}: ${listed.join(', ')}. Nothing was merged.`,
      { paths: scratch.paths, target, branch },
    );
  }

  const subject = input.message?.trim() || `Merge branch '${branch}' into ${target}`;
  let commit = incoming;
  if (checkout) {
    const merged = fastForward
      ? await git(exec, checkout, ['merge', '--ff-only', branch], 120_000)
      : await git(exec, checkout, ['merge', '--no-ff', '--no-edit', '-m', subject, branch], 120_000);
    if (merged.code !== 0) {
      await git(exec, checkout, ['merge', '--abort']);
      throw new GitError('failed', firstLine(merged.stderr || merged.stdout) || `git could not land ${branch} on ${target}`);
    }
    commit = await head(exec, checkout, 'HEAD');
  } else if (fastForward) {
    const moved = await git(exec, root, ['update-ref', '-m', `extendo: land ${branch}`, `refs/heads/${target}`, incoming, previous]);
    if (moved.code !== 0) throw new GitError('failed', firstLine(moved.stderr) || `Could not move ${target}`);
  } else {
    if (!scratch.tree) throw new GitError('failed', `git did not write a merge tree for ${branch}`);
    const created = await git(exec, root, ['commit-tree', scratch.tree, '-p', previous, '-p', incoming, '-m', subject]);
    if (created.code !== 0) throw new GitError('failed', firstLine(created.stderr) || 'Could not create the merge commit');
    commit = created.stdout.trim();
    const moved = await git(exec, root, ['update-ref', '-m', `extendo: land ${branch}`, `refs/heads/${target}`, commit, previous]);
    if (moved.code !== 0) throw new GitError('failed', firstLine(moved.stderr) || `Could not move ${target}`);
  }

  const after = await head(exec, root, `refs/heads/${target}`);
  if (after !== commit) throw new GitError('failed', `${target} did not move to the merge result; it is at ${after}`);
  const subjectResult = await git(exec, root, ['log', '-1', '--format=%s', commit]);
  return {
    target,
    branch,
    commit,
    shortCommit: commit.slice(0, 7),
    mode: fastForward ? 'fast-forward' : 'merge',
    previous,
    subject: subjectResult.code === 0 ? subjectResult.stdout.trim() : subject,
  };
}