import { z } from 'zod';
import type { Plugin, Registry, Tool } from '@extendo/contracts';
import { fileDiff, fileMatches, readText, workingPath, writeText } from './files.js';
import { runShell } from './shell.js';
import { fetchPublicText } from './web.js';

const path = z.string().min(1).max(2048);
const text = z.string().max(65_536);
const workspaceGlob = z.string().min(1).max(512);

export const builtInTools = [
  {
    name: 'read', description: 'Read a UTF-8 text file in the workspace.', input: z.object({ path }), readOnly: true,
    async execute(input, { cwd, signal, ctx, sessionId }) {
      const file = await workingPath(cwd, input.path);
      await ctx.serial('fs/read', { sessionId, path: file });
      signal.throwIfAborted();
      return { path: input.path, ...await readText(file) };
    },
  } satisfies Tool<{ path: string }>,
  {
    name: 'write', description: 'Create or replace a UTF-8 workspace file. Existing parent directories are required.',
    input: z.object({ path, content: text }), readOnly: false, needsApproval: true,
    async execute(input, { cwd, signal, ctx, sessionId }) {
      const file = await workingPath(cwd, input.path, true);
      let before: string | undefined;
      try { before = (await readText(file, true)).content; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await ctx.serial('fs/write', { sessionId, path: file });
      signal.throwIfAborted();
      await writeText(file, input.content, before === undefined);
      return fileDiff(input.path, before ?? '', input.content);
    },
  } satisfies Tool<{ path: string; content: string }>,
  {
    name: 'edit', description: 'Replace one exact, unique string in a UTF-8 workspace file.',
    input: z.object({ path, oldString: text.min(1), newString: text }), readOnly: false, needsApproval: true,
    async execute(input, { cwd, signal, ctx, sessionId }) {
      const file = await workingPath(cwd, input.path);
      await ctx.serial('fs/read', { sessionId, path: file });
      const { content: before } = await readText(file, true);
      const index = before.indexOf(input.oldString);
      if (index < 0) throw new Error('The exact old string was not found');
      if (index !== before.lastIndexOf(input.oldString)) throw new Error('The exact old string appears more than once');
      const after = before.slice(0, index) + input.newString + before.slice(index + input.oldString.length);
      await ctx.serial('fs/write', { sessionId, path: file });
      signal.throwIfAborted();
      if (after !== before) await writeText(file, after, false);
      return fileDiff(input.path, before, after);
    },
  } satisfies Tool<{ path: string; oldString: string; newString: string }>,
  {
    name: 'glob', description: 'Find workspace file paths by glob, up to 500 matches.',
    input: z.object({ pattern: workspaceGlob }), readOnly: true,
    async execute(input, { cwd, signal }) {
      const paths: string[] = [];
      for await (const file of fileMatches(cwd, input.pattern, signal)) {
        if (paths.length === 500) return { paths: paths.sort(), truncated: true };
        paths.push(file);
      }
      return { paths: paths.sort(), truncated: false };
    },
  } satisfies Tool<{ pattern: string }>,
  {
    name: 'grep', description: 'Search UTF-8 workspace text files for a literal string and return matching lines.',
    input: z.object({ query: z.string().min(1).max(512), pattern: workspaceGlob.optional(), ignoreCase: z.boolean().optional() }), readOnly: true,
    async execute(input, { cwd, signal, ctx, sessionId }) {
      const matches: { path: string; line: number; text: string }[] = [];
      const query = input.ignoreCase ? input.query.toLowerCase() : input.query;
      let files = 0;
      let truncated = false;
      for await (const path of fileMatches(cwd, input.pattern ?? '**/*', signal)) {
        if (++files > 1_000) return { matches, truncated: true };
        const file = await workingPath(cwd, path);
        await ctx.serial('fs/read', { sessionId, path: file });
        let data: Awaited<ReturnType<typeof readText>>;
        try { data = await readText(file); }
        catch (error) {
          if (error instanceof TypeError || (error instanceof Error && error.message === 'Binary files are not supported')) continue;
          throw error;
        }
        truncated ||= data.truncated;
        for (const [index, line] of data.content.split(/\r?\n/).entries()) {
          if (!(input.ignoreCase ? line.toLowerCase() : line).includes(query)) continue;
          if (matches.length === 100) return { matches, truncated: true };
          matches.push({ path, line: index + 1, text: line.slice(0, 1_000) });
        }
      }
      return { matches, truncated };
    },
  } satisfies Tool<{ query: string; pattern?: string; ignoreCase?: boolean }>,
  {
    name: 'shell', description: 'Run a local development command with explicit approval. No inherited API credentials.',
    input: z.object({ command: z.string().min(1).max(8192), cwd: path.optional(), timeoutMs: z.number().int().min(50).max(120_000).optional() }),
    readOnly: false, needsApproval: true,
    async execute(input, context) {
      return runShell(input.command, await workingPath(context.cwd, input.cwd ?? '.'), input.timeoutMs ?? 30_000, context);
    },
  } satisfies Tool<{ command: string; cwd?: string; timeoutMs?: number }>,
  {
    name: 'web-fetch', description: 'Fetch public HTTP(S) text with explicit approval. Does not follow redirects.',
    input: z.object({ url: z.url().max(2048) }), readOnly: true, needsApproval: true,
    async execute(input, { signal }) { return fetchPublicText(input.url, signal); },
  } satisfies Tool<{ url: string }>,
] as const;

export function workspaceToolsPlugin(): Plugin {
  return { name: 'workspace-tools', apply(ctx) {
    const registry = ctx.get<Registry<Tool>>('tools');
    for (const tool of builtInTools) {
      registry.register(ctx, tool.name, tool);
      ctx.emit('tools/register', { name: tool.name });
    }
  } };
}
