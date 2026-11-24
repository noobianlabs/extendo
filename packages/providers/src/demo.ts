import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { JsonValue, ModelChunk, ModelRequest, Plugin, Provider, Registry, Tool } from '@extendo/contracts';
import { z } from 'zod';

export const demoPath = 'src/search/EmptyState.tsx';
export const demoSearchPath = 'src/search/SearchResults.tsx';

export const demoBefore = `export function EmptyState() {
  return <p>No results</p>;
}
`;

export const demoAfter = `export function EmptyState({ query }: { query: string }) {
  return (
    <div role="status">
      <p>No results for “{query}”</p>
      <button type="button" onClick={clearFilters}>Clear filters</button>
    </div>
  );
}
`;

export const demoDiff = {
  path: demoPath,
  before: demoBefore,
  after: demoAfter,
  additions: 7,
  deletions: 3,
  summary: 'Name the query and offer a clear action in the empty state.',
};

export const demoFixtures: Record<string, string> = {
  [demoPath]: demoBefore,
  [demoSearchPath]: `import { EmptyState } from './EmptyState';

export function SearchResults({ query, results }: { query: string; results: string[] }) {
  if (results.length === 0) return <EmptyState />;
  return <ul>{results.map((result) => <li key={result}>{result}</li>)}</ul>;
}
`,
};

export const demoCheck = {
  command: 'pnpm vitest run src/search',
  stdout: '✓ src/search/EmptyState.test.tsx (3 tests)\n✓ src/search/SearchResults.test.tsx (2 tests)\n\n5 passed',
  exitCode: 0,
};

export interface DemoProviderOptions {
  /** Milliseconds between streamed text fragments. */
  delay?: number;
}

export interface DemoToolOptions {
  /** Milliseconds each demo tool takes before it answers. */
  delay?: number;
}

export const DEMO_TOOL_DELAY = 220;

const DEFAULT_DELAY = 55;

interface ScriptStep {
  text: string;
  call?: { name: string; input: JsonValue };
}

interface Script {
  steps: ScriptStep[];
}

const emptyStateScript: Script = {
  steps: [
    { text: 'Looking at the empty state first.', call: { name: 'demo_read', input: { path: demoPath } } },
    { text: 'The empty state only says “No results”, so the query and the next step are both missing.', call: { name: 'demo_edit', input: { path: demoPath } } },
    { text: 'Running the search checks.', call: { name: 'demo_check', input: { command: demoCheck.command } } },
    { text: 'The empty state now names the query and offers a clear action. Five checks pass. Nothing outside the demo fixture was touched.' },
  ],
};

const swarmScript: Script = {
  steps: [
    {
      text: 'Splitting this into three tracks: an audit of the empty-state components, the copy patch, and a verification pass. They run one at a time, so each report lands before the next starts.',
      call: {
        name: 'delegate',
        input: {
          concurrency: 1,
          tasks: [
            { title: 'Audit empty-state components', role: 'auditor', prompt: 'Audit the empty-state components for duplicated copy and unreachable branches.' },
            { title: 'Patch the empty state', role: 'patcher', prompt: 'Patch the empty state so it names the query and offers a clear action.' },
            { title: 'Verify the empty-state change', role: 'verifier', prompt: 'Verify the empty-state change against the search checks.' },
          ],
        },
      },
    },
    { text: 'Three tracks are queued. The audit runs now; the patch waits for your approval before it edits, and verification follows once the patch reports.' },
  ],
};

const auditScript: Script = {
  steps: [
    { text: 'Reading the empty-state component.', call: { name: 'demo_read', input: { path: demoPath } } },
    { text: 'Searching for the copy strings across the search folder.', call: { name: 'demo_search', input: { query: 'No results' } } },
    { text: 'Two components repeat the copy, and the empty state never receives the query. The patch track should pass the query through and add a clear action.' },
  ],
};

const patchScript: Script = {
  steps: [
    { text: 'Reading the component before editing.', call: { name: 'demo_read', input: { path: demoPath } } },
    { text: 'Passing the query into the empty state and adding a clear action.', call: { name: 'demo_edit', input: { path: demoPath } } },
    { text: 'Running the search checks against the patched component.', call: { name: 'demo_check', input: { command: demoCheck.command } } },
    { text: 'The empty state now names the query and offers a clear action. Five checks pass.' },
  ],
};

const verifyScript: Script = {
  steps: [
    { text: 'Reading the patched component to confirm the change landed.', call: { name: 'demo_read', input: { path: demoPath } } },
    { text: 'Running the full search suite.', call: { name: 'demo_check', input: { command: demoCheck.command } } },
    { text: 'Verified: the empty state names the query, the clear action is present, and all five checks pass.' },
  ],
};

const summaryScript: Script = {
  steps: [
    { text: 'Reading the search components.', call: { name: 'demo_read', input: { path: demoPath } } },
    { text: 'The empty state is the only place that drops the query. A small patch there covers the case.' },
  ],
};

/** Picks the scripted turn a session runs, based on the newest thing the person asked for. */
export function scriptFor(prompt: string): Script {
  const text = prompt.toLowerCase();
  if (/swarm|delegate|parallel|fan out|three tracks/.test(text)) return swarmScript;
  if (/audit|review the components|dead code/.test(text)) return auditScript;
  if (/verify|verification|check the change|regression/.test(text)) return verifyScript;
  if (/patch|fix|edit|rewrite|empty state/.test(text)) return patchScript;
  return summaryScript;
}

function latestUser(messages: ModelRequest['messages']): { text: string; index: number } {
  const index = messages.findLastIndex((message) => message.role === 'user');
  const message = messages[index];
  return { text: message?.role === 'user' ? message.content : '', index };
}

function toolCount(messages: ModelRequest['messages'], firstIndex: number): number {
  return messages.slice(firstIndex + 1).filter((message) => message.role === 'tool').length;
}

function steer(messages: ModelRequest['messages'], firstIndex: number): string | undefined {
  const last = messages.findLast((message) => message.role === 'user');
  const lastIndex = messages.findLastIndex((message) => message.role === 'user');
  if (lastIndex <= firstIndex || last?.role !== 'user') return undefined;
  return last.content;
}

export function demoProvider(options: number | DemoProviderOptions = {}): Provider {
  const delay = typeof options === 'number' ? options : options.delay ?? DEFAULT_DELAY;
  return {
    id: 'demo',
    async *stream(request) {
      const { text, index } = latestUser(request.messages);
      const script = scriptFor(text);
      const step = script.steps[Math.min(toolCount(request.messages, index), script.steps.length - 1)]!;
      const steered = steer(request.messages, index);
      const body = steered ? `Following your note — ${steered.trim()} ${step.text}` : step.text;
      for (const fragment of body.match(/.{1,48}(\s|$)/g) ?? [body]) {
        await setTimeout(delay, undefined, { signal: request.signal });
        yield { type: 'text-delta', delta: fragment } satisfies ModelChunk;
      }
      if (step.call) yield { type: 'tool-call', call: { id: randomUUID(), ...step.call } } satisfies ModelChunk;
      yield { type: 'usage', usage: { inputTokens: 148, outputTokens: Math.ceil(body.length / 4) } } satisfies ModelChunk;
      yield { type: 'done' } satisfies ModelChunk;
    },
  };
}

export function demoToolsPlugin(options: DemoToolOptions = {}): Plugin {
  const delay = options.delay ?? DEMO_TOOL_DELAY;
  return {
    name: 'demo-tools',
    apply(ctx) {
      const registry = ctx.get<Registry<Tool>>('tools');
      const wait = () => setTimeout(delay, undefined);
      const read: Tool<{ path: string }> = {
        name: 'demo_read',
        description: 'Read a file from the demo workspace. Simulated, never touches the disk.',
        input: z.object({ path: z.string().min(1).max(240) }),
        readOnly: true,
        async execute({ path }) {
          await wait();
          return { path, content: demoFixtures[path] ?? demoBefore, simulated: true } as JsonValue;
        },
      };
      const search: Tool<{ query: string }> = {
        name: 'demo_search',
        description: 'Search the demo workspace for a string. Simulated, never touches the disk.',
        input: z.object({ query: z.string().min(1).max(120) }),
        readOnly: true,
        async execute({ query }) {
          await wait();
          const matches = Object.entries(demoFixtures).flatMap(([path, content]) =>
            content.split('\n').flatMap((line, index) => line.includes(query) ? [{ path, line: index + 1, text: line.trim() }] : []),
          );
          return { query, matches, simulated: true } as JsonValue;
        },
      };
      const edit: Tool<{ path: string }> = {
        name: 'demo_edit',
        description: 'Preview a patch to the demo workspace. Simulated, and needs approval before it runs.',
        input: z.object({ path: z.string().min(1).max(240) }),
        readOnly: true,
        needsApproval: true,
        async execute({ path }) {
          await wait();
          return { ...demoDiff, path, simulated: true } as JsonValue;
        },
      };
      const check: Tool<{ command: string }> = {
        name: 'demo_check',
        description: 'Run the demo checks. Simulated, never touches the disk.',
        input: z.object({ command: z.string().min(1).max(240) }),
        readOnly: true,
        async execute({ command }) {
          await wait();
          return { ...demoCheck, command, simulated: true } as JsonValue;
        },
      };
      for (const tool of [read, search, edit, check]) {
        registry.register(ctx, tool.name, tool);
        ctx.emit('tools/register', { name: tool.name });
      }
    },
  };
}
