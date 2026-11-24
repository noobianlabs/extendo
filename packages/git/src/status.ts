import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangedFile, FileStatus, WorkspaceStatus } from '@extendo/contracts';
import { missingBinary, type Exec } from './exec.js';
import { secretReason } from './secrets.js';

const STATUS: Record<string, FileStatus> = {
  A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', U: 'conflict',
};

const MAX_FILES = 2_000;

export interface ParsedStatus {
  branch?: string;
  detached: boolean;
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  truncated: boolean;
}

function file(path: string, index: string, worktree: string): ChangedFile {
  return {
    path,
    staged: index === '.' ? 'none' : STATUS[index] ?? 'modified',
    unstaged: worktree === '.' ? 'none' : STATUS[worktree] ?? 'modified',
    untracked: false,
    blocked: secretReason(path),
  };
}

/**
 * Reads `git status --porcelain=v2 --branch -z`. The NUL form is the only one that survives a file
 * name with a space, a quote, or a newline in it, which is exactly the name that breaks a listing.
 */
export function parseStatus(output: string): ParsedStatus {
  const tokens = output.split('\0');
  const parsed: ParsedStatus = { detached: false, ahead: 0, behind: 0, files: [], truncated: false };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token.startsWith('# ')) {
      const [key, ...rest] = token.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') parsed.head = value === '(initial)' ? undefined : value;
      else if (key === 'branch.head') {
        if (value === '(detached)') parsed.detached = true;
        else parsed.branch = value;
      } else if (key === 'branch.upstream') parsed.upstream = value;
      else if (key === 'branch.ab') {
        const match = value.match(/^\+(\d+) -(\d+)$/);
        if (match) {
          parsed.ahead = Number(match[1]);
          parsed.behind = Number(match[2]);
        }
      }
      continue;
    }
    const kind = token[0];
    if (kind === '!') continue;
    if (kind === '?') {
      const path = token.slice(2);
      if (parsed.files.length >= MAX_FILES) { parsed.truncated = true; continue; }
      parsed.files.push({ path, staged: 'none', unstaged: 'none', untracked: true, blocked: secretReason(path) });
      continue;
    }
    const fields = token.split(' ');
    if (kind === '1' && fields.length >= 9) {
      const path = fields.slice(8).join(' ');
      if (parsed.files.length >= MAX_FILES) { parsed.truncated = true; continue; }
      parsed.files.push(file(path, fields[1]![0]!, fields[1]![1]!));
      continue;
    }
    if (kind === '2' && fields.length >= 10) {
      const path = fields.slice(9).join(' ');
      const origPath = tokens[index + 1];
      if (origPath !== undefined) index += 1;
      if (parsed.files.length >= MAX_FILES) { parsed.truncated = true; continue; }
      parsed.files.push({ ...file(path, fields[1]![0]!, fields[1]![1]!), origPath });
      continue;
    }
    if (kind === 'u' && fields.length >= 11) {
      const path = fields.slice(10).join(' ');
      if (parsed.files.length >= MAX_FILES) { parsed.truncated = true; continue; }
      parsed.files.push({ path, staged: 'conflict', unstaged: 'conflict', untracked: false, blocked: secretReason(path) });
    }
  }
  return parsed;
}

interface Numstat {
  additions?: number;
  deletions?: number;
}

/**
 * One call for the index, one for the working tree, keyed by path. `--no-renames` keeps every
 * record a plain `add\tdelete\tpath`, which is the only shape that needs no quoting rules.
 */
export function parseNumstat(output: string): Map<string, Numstat> {
  const stats = new Map<string, Numstat>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const [added, removed, ...rest] = record.split('\t');
    const path = rest.join('\t');
    if (!path) continue;
    const additions = added === '-' ? undefined : Number(added);
    const deletions = removed === '-' ? undefined : Number(removed);
    stats.set(path, {
      additions: Number.isFinite(additions) ? additions : undefined,
      deletions: Number.isFinite(deletions) ? deletions : undefined,
    });
  }
  return stats;
}

function github(url: string | undefined): { host?: string; github: boolean } {
  if (!url) return { github: false };
  const match = url.match(/^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)|(?:[^@/]+@)?([^:/]+):)/i);
  const host = match?.[1] ?? match?.[2];
  if (!host) return { github: false };
  return { host, github: /^(?:www\.)?github\.com$/i.test(host) || /^github\./i.test(host) };
}

async function git(exec: Exec, cwd: string, args: string[]) {
  return exec('git', args, { cwd });
}

/**
 * Everything the git surface needs to draw the working tree in one round trip: the branch, how far
 * it is from its upstream, the origin, and every changed path in the three groups a person stages
 * from.
 */
export async function readStatus(exec: Exec, cwd: string, gitVersion?: string): Promise<WorkspaceStatus> {
  const top = await git(exec, cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) {
    const probe = gitVersion === undefined
      ? await git(exec, cwd, ['--version'])
      : { code: 0, stdout: `git version ${gitVersion}`, stderr: '' };
    if (missingBinary(probe)) return { repo: false, error: 'git is not installed on this machine', files: [], ahead: 0, behind: 0 };
    return { repo: false, error: 'This workspace is not a git repository', files: [], ahead: 0, behind: 0 };
  }
  const root = await realpath(top.stdout.trim());
  const status = await git(exec, root, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
  if (status.code !== 0) {
    return { repo: false, error: 'git could not read this workspace', files: [], ahead: 0, behind: 0 };
  }
  const parsed = parseStatus(status.stdout);
  const [cached, unstaged, remote, log, version] = await Promise.all([
    git(exec, root, ['diff', '--cached', '--numstat', '--no-renames', '-z']),
    git(exec, root, ['diff', '--numstat', '--no-renames', '-z']),
    git(exec, root, ['remote', 'get-url', 'origin']),
    git(exec, root, ['log', '-1', '--format=%s']),
    gitVersion === undefined ? git(exec, root, ['--version']) : Promise.resolve({ code: 0, stdout: gitVersion, stderr: '' }),
  ]);
  const staged = parseNumstat(cached.stdout);
  const working = parseNumstat(unstaged.stdout);
  const files = parsed.files.map((entry) => {
    const stats = (entry.staged === 'none' ? undefined : staged.get(entry.path))
      ?? (entry.unstaged === 'none' ? undefined : working.get(entry.path));
    return stats ? { ...entry, additions: stats.additions, deletions: stats.deletions } : entry;
  });
  const url = remote.code === 0 ? remote.stdout.trim() : undefined;
  const host = github(url);
  return {
    repo: true,
    root,
    branch: parsed.branch,
    detached: parsed.detached,
    head: parsed.head,
    headSubject: log.code === 0 ? log.stdout.trim() || undefined : undefined,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    remote: url ? { name: 'origin', url, host: host.host, github: host.github } : undefined,
    files,
    truncatedFiles: parsed.truncated || undefined,
    gitVersion: version.code === 0 ? version.stdout.trim().replace(/^git version\s+/i, '') : undefined,
  };
}

export function checkoutPath(root: string, path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('Expected a path inside the checkout');
  }
  if (normalized.split('/').some((part) => part === '.git')) throw new Error('The git directory is not a workspace path');
  return join(root, normalized);
}
