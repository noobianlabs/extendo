import type { BranchCommit, BranchDiff, FileChange, FileStatus } from '@extendo/contracts';
import type { Exec } from './exec.js';
import { firstLine, GitError } from './errors.js';

const MAX_BYTES = 256 * 1024;
/** `git diff --name-status` letters, mapped to the contract's names. */
const LETTERS: Record<string, FileStatus> = {
  A: 'added', M: 'modified', D: 'deleted', T: 'typechange', U: 'conflict',
};

async function blob(exec: Exec, root: string, revision: string, path: string): Promise<string | undefined> {
  const result = await exec('git', ['cat-file', 'blob', `${revision}:${path}`], { cwd: root });
  if (result.code !== 0) return undefined;
  return result.stdout;
}

/** Commits on one side of a range, newest first, exactly as `git log` lists them. */
export async function commitsIn(exec: Exec, root: string, range: string): Promise<BranchCommit[]> {
  const result = await exec('git', ['log', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI', range], { cwd: root });
  if (result.code !== 0) return [];
  return result.stdout.split('\n').flatMap((line) => {
    const [sha, shortSha, subject, author, at] = line.split('\u001f');
    return sha && shortSha ? [{ sha, shortSha, subject: subject ?? '', author: author ?? '', at: at ?? '' }] : [];
  });
}

/**
 * A branch measured against the branch it was cut from. The file pairs run from the two branches'
 * merge base, so they are the change a merge would actually bring — not everything the base has
 * done since, and not the branch's whole history against an old base.
 */
export async function compareBranches(
  exec: Exec,
  root: string,
  input: { base: string; branch: string; from?: string },
): Promise<BranchDiff> {
  const base = input.base.trim();
  const branch = input.branch.trim();
  const [baseRef, branchRef] = await Promise.all([
    exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], { cwd: root }),
    exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root }),
  ]);
  if (baseRef.code !== 0) throw new GitError('failed', `There is no branch named ${base} to compare against`);
  if (branchRef.code !== 0) throw new GitError('failed', `There is no branch named ${branch}`);
  // A branch is measured from the commit it was cut at when that is known, so landing it does not
  // erase the review: the merge base would collapse onto the branch tip once the target absorbed it.
  let mergeBase = input.from?.trim();
  if (mergeBase) {
    const known = await exec('git', ['rev-parse', '--verify', '--quiet', `${mergeBase}^{commit}`], { cwd: root });
    if (known.code !== 0) mergeBase = undefined;
  }
  if (!mergeBase) {
    const mergeBaseResult = await exec('git', ['merge-base', base, branch], { cwd: root });
    if (mergeBaseResult.code !== 0) {
      throw new GitError('failed', firstLine(mergeBaseResult.stderr) || `${base} and ${branch} have no common commit`);
    }
    mergeBase = mergeBaseResult.stdout.trim();
  }
  const commits = await commitsIn(exec, root, `${mergeBase}..${branch}`);
  if (!commits.length) return { base, branch, mergeBase, commits: [], files: [], empty: true };

  const [names, counts] = await Promise.all([
    exec('git', ['diff', '--name-status', mergeBase, branch], { cwd: root }),
    exec('git', ['diff', '--numstat', mergeBase, branch], { cwd: root }),
  ]);
  const lines = new Map<string, { additions: number; deletions: number }>();
  for (const line of counts.stdout.split('\n')) {
    const [added, removed, path] = line.split('\t');
    if (!path) continue;
    lines.set(path, { additions: Number(added) || 0, deletions: Number(removed) || 0 });
  }

  const files: FileChange[] = [];
  for (const line of names.stdout.split('\n')) {
    const [letter, path] = line.split('\t');
    if (!letter || !path) continue;
    const status = LETTERS[letter.charAt(0)] ?? 'modified';
    const [before, after] = await Promise.all([blob(exec, root, mergeBase, path), blob(exec, root, branch, path)]);
    const binary = (before ?? '').includes('\0') || (after ?? '').includes('\0');
    const truncated = ((before?.length ?? 0) >= MAX_BYTES || (after?.length ?? 0) >= MAX_BYTES) || undefined;
    const change = lines.get(path) ?? { additions: 0, deletions: 0 };
    files.push({
      path,
      before: binary ? '' : before ?? '',
      after: binary ? '' : after ?? '',
      ...change,
      status,
      binary: binary || undefined,
      truncated,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { base, branch, mergeBase, commits, files, empty: false };
}