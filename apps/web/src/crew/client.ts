import type { BranchDiff, Landed, SteerMode, Thread } from '@extendo/contracts';
import { api, json } from '../api';

/** The crew's client: one call per action, and the captain's refreshed thread comes back with it. */

export type Delivery = 'queue' | 'interrupt' | 'turn';

export interface LandResponse {
  landed: Landed;
  worker: { threadId: string };
  thread?: Thread;
}

export interface SteerResponse {
  delivered: Delivery;
  threadId: string;
  turnId?: string;
  thread?: Thread;
}

export function readDiff(threadId: string, signal?: AbortSignal): Promise<BranchDiff> {
  return api<BranchDiff>(`/crew/${encodeURIComponent(threadId)}/diff`, { signal });
}

export function land(threadId: string, target?: string): Promise<LandResponse> {
  return api<LandResponse>(`/crew/${encodeURIComponent(threadId)}/integrate`, json('POST', target ? { target } : {}));
}

export function steer(threadId: string, text: string, mode: SteerMode): Promise<SteerResponse> {
  return api<SteerResponse>(`/crew/${encodeURIComponent(threadId)}/steer`, json('POST', { text, mode }));
}