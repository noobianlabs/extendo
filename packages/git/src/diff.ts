import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileChange, FileStatus } from '@extendo/contracts';
import type { Exec } from './exec.js';
import { checkoutPath } from './status.js';

const MAX_BYTES = 256 * 1024;

async function blob(exec: Exec, root: string, revision: string, path: string): Promise<string | undefined> {
  const result = await exec('git', ['cat-file', 'blob', `${revision}:${path}`], { cwd: root });
  if (result.code !== 0) return undefined;
  return result.stdout;
}

async function workingCopy(root: string, path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(checkoutPath(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const size = Math.min(info.size, MAX_BYTES);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function counts(before: string, after: string): { additions: number; deletions: number } {
  const old = before ? before.replace(/\n$/, '').split('\n') : [];
  const next = after ? after.replace(/\n$/, '').split('\n') : [];
  let start = 0;
  let end = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  while (start + end < old.length && start + end < next.length && old.at(-1 - end) === next.at(-1 - end)) end++;
  return { additions: Math.max(0, next.length - start - end), deletions: Math.max(0, old.length - start - end) };
}

/**
 * The two versions of one path the diff view renders: the index against HEAD for a staged file, the
 * working tree against the index for an unstaged one. Nothing here trusts a cached status read —
 * the caller has already decided which side it is looking at.
 */
export async function readChange(exec: Exec, root: string, path: string, staged: boolean): Promise<FileChange> {
  const [head, index, working] = await Promise.all([
    blob(exec, root, 'HEAD', path),
    blob(exec, root, '', path),
    workingCopy(root, path),
  ]);
  const before = (staged ? head : index) ?? '';
  const after = (staged ? index : working) ?? '';
  const binary = before.includes('\0') || after.includes('\0');
  const truncated = (before.length >= MAX_BYTES || after.length >= MAX_BYTES) || undefined;
  const status: FileStatus = staged
    ? (before === '' ? 'added' : after === '' ? 'deleted' : 'modified')
    : (index === undefined ? 'untracked' : after === '' ? 'deleted' : 'modified');
  const { additions, deletions } = binary ? { additions: 0, deletions: 0 } : counts(before, after);
  return binary
    ? { path, before: '', after: '', additions, deletions, status, binary: true, truncated }
    : { path, before, after, additions, deletions, status, truncated };
}
