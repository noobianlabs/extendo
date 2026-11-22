import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { ModelChunk, Plugin, Provider, Registry, Tool, ToolCall } from '@extendo/contracts';
import { z } from 'zod';

export const demoPath = 'src/search/EmptyState.tsx';

export const demoBefore = `export function EmptyState() {
  return <p>No results.</p>;
}
`;

export const demoAfter = `export function EmptyState({ onClear }: { onClear: () => void }) {
  return (
    <section aria-live="polite">
      <h2>No matching results</h2>
      <p>Try a different search or clear the active filters.</p>
      <button onClick={onClear}>Clear filters</button>
    </section>
  );
}
`;

export const demoDiff = {
  path: demoPath, before: demoBefore, after: demoAfter, additions: 8, deletions: 2,
  summary: 'Give people a next step when a search returns no matches.',
};

export const demoTest = { command: 'pnpm test src/search', stdout: 'PASS  src/search/EmptyState.test.tsx\n  3 passed (3) · 118 ms', stderr: '', exitCode: 0, simulated: true };

export function demoProvider(delayMs = 55): Provider {
  return {
    id: 'demo',
    async *stream(request) {
      const latest = request.messages.findLastIndex(({ role }) => role === 'user');
      const input = request.messages[latest];
      const tools = request.messages.slice(latest + 1).filter((message) => message.role === 'tool');
      const hello = input?.role === 'user' && /^say hello[.! ]*$/i.test(input.content.trim());
      const scriptedCalls: Omit<ToolCall, 'id'>[] = [
        { name: 'demo_read', input: { path: demoPath } },
        { name: 'demo_edit', input: { path: demoPath } },
        { name: 'demo_test', input: { command: demoTest.command } },
      ];
      const next = scriptedCalls[tools.length];
      let text: string;
      if (hello) text = 'Hello from Extendo. The local demo is running without an API key.';
      else if (!next) {
        const edited = tools[1]?.result.isError === false;
        text = edited
          ? 'The demo patch now explains why there are no matching results and offers a **Clear filters** action. All three scripted checks passed. No files on your machine were changed.'
          : 'I left the proposed edit unapplied. The three scripted checks ran against the demo fixture; nothing on your machine was changed.';
      } else text = [
        'I’ll inspect the empty state first. Then I’ll propose a small change and run the demo checks.',
        'The current state ends at “No results.” I’ll propose a clear next step, without changing anything outside this demo.',
        'Now I’ll run the three scripted checks.',
      ][tools.length]!;
      if (next && !hello && tools.length === 0) {
        yield { type: 'reasoning-delta', delta: 'Locate the empty search state and keep the proposed change focused.' };
      }
      for (const part of text.match(/.{1,16}(?:\s|$)|\S+/gu) ?? [text]) {
        await setTimeout(delayMs, undefined, { signal: request.signal });
        yield { type: 'text-delta', delta: part } satisfies ModelChunk;
      }
      if (next && !hello) yield { type: 'tool-call', call: { id: randomUUID(), ...next } };
      yield { type: 'usage', usage: { inputTokens: 118, outputTokens: Math.ceil(text.length / 4) } };
      yield { type: 'done' };
    },
  };
}

export function demoToolsPlugin(): Plugin {
  return {
    name: 'demo-tools',
    apply(ctx) {
      const tools = ctx.get<Registry<Tool>>('tools');
      const file = z.object({ path: z.literal(demoPath) });
      const definitions: Tool[] = [
        { name: 'demo_read', description: 'Read the isolated demo search component', input: file, readOnly: true,
          async execute() { return { path: demoPath, content: demoBefore, simulated: true }; } },
        { name: 'demo_edit', description: 'Preview the search component patch without writing files', input: file, readOnly: true, needsApproval: true,
          async execute() { return { ...demoDiff, simulated: true }; } },
        { name: 'demo_test', description: 'Replay isolated demo test output without running commands', input: z.object({ command: z.literal(demoTest.command) }), readOnly: true,
          async execute() { return demoTest; } },
      ];
      for (const tool of definitions) {
        tools.register(ctx, tool.name, tool);
        ctx.emit('tools/register', { name: tool.name });
      }
    },
  };
}
