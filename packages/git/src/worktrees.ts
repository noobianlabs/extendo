import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { WorktreeInfo } from '@extendo/contracts';
import type { Exec } from './exec.js';

/** `git worktree list --porcelain`, whose blank-line-separated blocks are one worktree each. */
export function parseWorktreeList(output: string): Omit<WorktreeInfo, 'current'>[] {
  const worktrees: Omit<WorktreeInfo, 'current'>[] = [];
  for (const block of output.split(/\n\n+/)) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length || !lines[0]?.startsWith('worktree ')) continue;
    const entry: Omit<WorktreeInfo, 'current'> = { path: lines[0].slice('worktree '.length), main: worktrees.length === 0 };
    for (const line of lines.slice(1)) {
      if (line === 'bare' || line === 'detached') continue;
      if (line.startsWith('HEAD ')) entry.head = line.slice(5);
      else if (line.startsWith('branch ')) entry.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line.startsWith('locked')) entry.locked = line.slice(7).trim() || 'locked';
    }
    worktrees.push(entry);
  }
  return worktrees;
}

export async function listWorktrees(exec: Exec, cwd: string, current?: string): Promise<WorktreeInfo[]> {
  const result = await exec('git', ['worktree', 'list', '--porcelain'], { cwd });
  if (result.code !== 0) return [];
  const here = current === undefined ? undefined : await realpath(current).catch(() => resolve(current));
  return parseWorktreeList(result.stdout).map((entry) => ({
    ...entry,
    current: here !== undefined && resolve(entry.path) === here,
  }));
}

/** A worktree created from a base branch, on a new branch, beside the repository rather than inside it. */
export async function addWorktree(exec: Exec, cwd: string, options: { path: string; branch: string; base: string }): Promise<{ code: number; stderr: string }> {
  const result = await exec('git', ['worktree', 'add', '-b', options.branch, options.path, options.base], { cwd });
  return { code: result.code, stderr: (result.stderr || result.stdout).trim() };
}

export async function removeWorktree(exec: Exec, cwd: string, path: string, force: boolean): Promise<{ code: number; message: string }> {
  const result = await exec('git', ['worktree', 'remove', ...(force ? ['--force'] : []), path], { cwd });
  return { code: result.code, message: (result.stderr || result.stdout).trim() };
}

export async function pruneWorktrees(exec: Exec, cwd: string): Promise<void> {
  await exec('git', ['worktree', 'prune'], { cwd });
}

/** Where a thread's worktree lives: beside the checkout, so it never shows up in its own status. */
export function worktreePath(root: string, slug: string): string {
  return join(dirname(root), `${root.split(/[\\/]/).at(-1)}.worktrees`, slug);
}
