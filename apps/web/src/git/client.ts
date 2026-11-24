import type { FileChange, GitView, WorktreeView } from '@extendo/contracts';
import { api, json } from '../api';

/** The source surface's client: one call per action, and the fresh state comes back with it. */

export interface CheckoutRef {
  sessionId?: string;
  projectId?: string;
}

function query(target: CheckoutRef): URLSearchParams {
  const params = new URLSearchParams();
  if (target.sessionId) params.set('sessionId', target.sessionId);
  else if (target.projectId) params.set('projectId', target.projectId);
  return params;
}

function suffix(params: URLSearchParams): string {
  const value = params.toString();
  return value ? `?${value}` : '';
}

export function readStatus(target: CheckoutRef, signal?: AbortSignal): Promise<GitView> {
  return api<GitView>(`/git/status${suffix(query(target))}`, { signal });
}

export function readChange(target: CheckoutRef, path: string, staged: boolean, signal?: AbortSignal): Promise<FileChange> {
  const params = query(target);
  params.set('path', path);
  params.set('staged', staged ? '1' : '0');
  return api<FileChange>(`/git/diff${suffix(params)}`, { signal });
}

export function stage(target: CheckoutRef, paths: string[], allowSecrets = false): Promise<GitView> {
  return api<GitView>('/git/stage', json('POST', { ...target, paths, allowSecrets }));
}

export function unstage(target: CheckoutRef, paths: string[]): Promise<GitView> {
  return api<GitView>('/git/unstage', json('POST', { ...target, paths }));
}

export function discard(target: CheckoutRef, paths: string[]): Promise<GitView> {
  return api<GitView>('/git/discard', json('POST', { ...target, paths }));
}

export interface CommitResponse {
  commit: { shortSha: string; subject: string };
  view: GitView;
}

export interface PushResponse {
  push: { summary: string; upstream?: string };
  view: GitView;
}

export interface PullRequestResponse {
  pullRequest: { created: boolean; url?: string; number?: number; title?: string };
  view: GitView;
}

export function commit(target: CheckoutRef, message: string): Promise<CommitResponse> {
  return api<CommitResponse>('/git/commit', json('POST', { ...target, message }));
}

export function push(target: CheckoutRef): Promise<PushResponse> {
  return api<PushResponse>('/git/push', json('POST', { ...target }));
}

export function openPullRequest(target: CheckoutRef, input: { title?: string; body?: string }): Promise<PullRequestResponse> {
  return api<PullRequestResponse>('/git/pull-request', json('POST', { ...target, ...input }));
}

export function createWorktree(sessionId: string): Promise<WorktreeView & { branch: string; base?: string }> {
  return api<WorktreeView & { branch: string; base?: string }>('/git/worktree', json('POST', { sessionId }));
}

export function removeWorktree(sessionId: string, options: { force?: boolean; branch?: boolean } = {}): Promise<WorktreeView> {
  const params = new URLSearchParams({ sessionId });
  if (options.force) params.set('force', '1');
  if (options.branch) params.set('branch', '1');
  return api<WorktreeView>(`/git/worktree${suffix(params)}`, { method: 'DELETE' });
}

export function deleteThread(threadId: string, force = false): Promise<{ removed: boolean }> {
  return api<{ removed: boolean }>(`/threads/${encodeURIComponent(threadId)}${force ? '?force=1' : ''}`, { method: 'DELETE' });
}
