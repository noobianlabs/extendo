import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEventInput, StepRef, ToolCall, ToolResult } from '@extendo/contracts';
import { demoBefore, demoDiff, demoPath, demoTest } from '@extendo/providers';
import type { Runtime } from './runtime.js';

const provider = 'demo';
const model = 'extendo-demo';

export function seedDemo(runtime: Runtime, dataDir: string): void {
  const { workspace, sessions } = runtime;
  if (workspace.projects().length) return;
  const root = join(dataDir, 'demo', 'northstar-ui');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const project = workspace.openProject(root, 'Northstar UI');
  const smallerThreads = [
    { title: 'Trace the keyboard shortcut', question: 'Where should we register the shortcut for search?', answer: 'Keep the shortcut next to the search entry point so it follows the same focus rules as opening search from the toolbar.' },
    { title: 'Map the release checklist', question: 'What should we check before shipping the search update?', answer: 'Check filtered results, the empty state, keyboard navigation, and the small-screen layout. Keep the notes in the release checklist.' },
  ];
  for (const item of smallerThreads) {
    const thread = workspace.createThread(sessions, project, { title: item.title, provider, model, branch: 'main' });
    sessions.appendMany(thread.sessionId, episode('history', item.question, [{ content: item.answer }]));
  }
  const thread = workspace.createThread(sessions, project, { title: 'Make empty search results useful', provider, model, branch: 'main' });
  const read: ToolCall = { id: 'demo-read', name: 'demo_read', input: { path: demoPath } };
  const edit: ToolCall = { id: 'demo-edit', name: 'demo_edit', input: { path: demoPath } };
  const test: ToolCall = { id: 'demo-test', name: 'demo_test', input: { command: demoTest.command } };
  sessions.appendMany(thread.sessionId, [
    ...episode('explore', 'Can we make the empty search state useful when filters hide every result?', [
      { content: 'I’ll inspect the empty state, then check whether we can offer a way out without resetting the search.', call: read,
        result: { callId: read.id, name: read.name, output: { path: demoPath, content: demoBefore, simulated: true }, isError: false } },
      { content: 'The current state only says “No results.” A short explanation and a **Clear filters** action would give people a next step.' },
    ]),
    ...episode('improve', 'Go ahead. Keep the search text, and make sure the action works from the keyboard.', [
      { content: 'I’ll keep the query intact and use a native button for the filter reset.', call: edit,
        result: { callId: edit.id, name: edit.name, output: { ...demoDiff, simulated: true }, isError: false } },
      { content: '', call: test,
        result: { callId: test.id, name: test.name, output: demoTest, isError: false } },
      { content: 'The empty state now explains what happened and offers a **Clear filters** action. The query stays put, and all three demo checks passed.' },
    ]),
  ]);
}

function episode(turnId: string, input: string, messages: { content: string; call?: ToolCall; result?: ToolResult }[]): SessionEventInput[] {
  const events: SessionEventInput[] = [
    { type: 'turn/start', data: { turnId, provider, model } },
    { type: 'user/message', data: { turnId, messageId: `${turnId}-user`, content: input } },
  ];
  for (const [index, message] of messages.entries()) {
    const ref: StepRef = { turnId, stepId: `${turnId}-step-${index}` };
    events.push({ type: 'step/start', data: ref }, { type: 'assistant/message', data: { ...ref, messageId: ref.stepId, content: message.content } });
    if (message.call) events.push({ type: 'tool/call', data: { ...ref, call: message.call } });
    if (message.result) events.push({ type: 'tool/result', data: { ...ref, result: message.result } });
    events.push({ type: 'step/end', data: { ...ref, outcome: 'completed' } });
  }
  events.push({ type: 'turn/end', data: { turnId, outcome: 'completed' } });
  return events;
}
