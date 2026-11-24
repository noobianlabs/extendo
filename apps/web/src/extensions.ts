import type { Extension, ExtensionState, LiveTool } from '@extendo/contracts';
import { api, json } from './api';

export interface Saved {
  extension: Extension;
  state: ExtensionState;
  error?: string;
}

export async function loadExtensions(): Promise<{ state: ExtensionState; tools: LiveTool[] }> {
  const [state, tools] = await Promise.all([
    api<ExtensionState>('/extensions'),
    api<{ tools: LiveTool[] }>('/extensions/tools'),
  ]);
  return { state, tools: tools.tools };
}

export function createExtension(input: { name: string; description?: string }): Promise<Saved> {
  return api<Saved>('/extensions', json('POST', input));
}

/**
 * A save that fails to load answers 422 with the previous revision still running, so the failure is
 * data rather than an exception: the panel shows it beside the editor that caused it.
 */
export async function saveExtension(id: string, source: string): Promise<Saved> {
  const response = await fetch('/api/extensions/' + encodeURIComponent(id), json('PUT', { source }));
  const body = await response.json().catch(() => null) as Saved | { error?: string } | null;
  if (!body || !('extension' in body) || !body.extension) {
    throw new Error(body && 'error' in body && body.error ? body.error : 'Could not save the plugin.');
  }
  return body;
}

export function removeExtension(id: string): Promise<ExtensionState> {
  return api<ExtensionState>('/extensions/' + encodeURIComponent(id), { method: 'DELETE' });
}

/** Tool name to plugin id, which is what the seam in the transcript is derived from. */
export function pluginToolOwners(state: ExtensionState): Map<string, string> {
  const owners = new Map<string, string>();
  for (const extension of state.extensions) {
    for (const tool of extension.tools) owners.set(tool.name, extension.id);
  }
  return owners;
}
