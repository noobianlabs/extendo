import type { Plugin, PluginManifest } from '@extendo/contracts';
import { z } from 'zod';

export type { Command, Ctx, Disposable, Plugin, PluginManifest, Registry, Tool, ToolCtx } from '@extendo/contracts';

export function definePlugin(plugin: Plugin): Plugin {
  if (!plugin.name.trim()) throw new Error('Plugin name must not be empty');
  return plugin;
}

export const pluginManifestSchema: z.ZodType<PluginManifest> = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  server: z.string().min(1).optional(),
  ui: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).optional(),
});
