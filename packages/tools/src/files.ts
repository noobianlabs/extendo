import { constants } from 'node:fs';
import { glob, lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 65_536;
export const protectedEntry = (name: string) => /^(?:node_modules|\.git|\.extendo|\.env(?:\..*)?|\.npmrc|\.ssh|\.aws|\.gnupg|\.netrc)$/i.test(name) || /\.(?:pem|key|p12)$/i.test(name);

export async function workingPath(cwd: string, path: string, allowMissing = false): Promise<string> {
  if (isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw new Error('Expected a relative workspace path');
  const root = await realpath(cwd);
  const target = resolve(root, path);
  const parts = relative(root, target).split(sep);
  if (parts[0] === '..' || parts.some(protectedEntry)) throw new Error('Path is outside the allowed workspace files');
  let entry = root;
  for (const [index, part] of parts.entries()) {
    entry = resolve(entry, part);
    try {
      const info = await lstat(entry);
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not followed');
    } catch (error) {
      if (!(allowMissing && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
    }
  }
  return target;
}

export async function readText(path: string, requiredWhole = false): Promise<{ content: string; truncated: boolean }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Path is not a regular file');
    const bytes = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, info.size + 1));
    const { bytesRead } = await handle.read(bytes);
    const truncated = bytesRead > MAX_FILE_BYTES || info.size > MAX_FILE_BYTES;
    if (requiredWhole && truncated) throw new Error('File is too large to replace safely');
    if (bytes.subarray(0, bytesRead).includes(0)) throw new Error('Binary files are not supported');
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, Math.min(bytesRead, MAX_FILE_BYTES)), { stream: truncated });
    return { content, truncated };
  } finally { await handle.close(); }
}

export async function writeText(path: string, content: string, create: boolean): Promise<void> {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Result exceeds the file size limit');
  const flags = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, flags | (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o644);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Path is not a regular file');
    await handle.writeFile(content, 'utf8');
    await handle.truncate(Buffer.byteLength(content));
  } finally { await handle.close(); }
}

export async function* fileMatches(cwd: string, patterns: string, signal: AbortSignal): AsyncGenerator<string> {
  if (isAbsolute(patterns) || patterns.replaceAll('\\', '/').split('/').includes('..')) throw new Error('Expected a relative workspace glob');
  const root = await realpath(cwd);
  for await (const entry of glob(patterns, { cwd: root, withFileTypes: true, exclude: (dirent) => dirent.isSymbolicLink() || protectedEntry(dirent.name) })) {
    signal.throwIfAborted();
    if (!entry.isFile()) continue;
    const path = relative(root, resolve(entry.parentPath, entry.name));
    if (path.split(sep).some(protectedEntry)) continue;
    yield path.split(sep).join('/');
  }
}

export function fileDiff(path: string, before: string, after: string) {
  const old = before ? before.replace(/\n$/, '').split('\n') : [];
  const next = after ? after.replace(/\n$/, '').split('\n') : [];
  let start = 0;
  let end = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  while (start + end < old.length && start + end < next.length && old.at(-1 - end) === next.at(-1 - end)) end++;
  return { path, before, after, additions: next.length - start - end, deletions: old.length - start - end };
}
