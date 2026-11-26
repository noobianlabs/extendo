import type { Message, ModelMessage, SessionEvent } from '@extendo/contracts';

export function projectMessages(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = [];
  const assistantByStep = new Map<string, Extract<Message, { role: 'assistant' }>>();
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const { messageId: id, turnId, content } = event.data;
        messages.push({ role: 'user', id, turnId, content });
        break;
      }
      case 'assistant/message': {
        const { messageId: id, turnId, stepId, content, reasoning } = event.data;
        const entry: Extract<Message, { role: 'assistant' }> = { role: 'assistant', id, turnId, stepId, content, reasoning, tools: [] };
        messages.push(entry);
        assistantByStep.set(stepId, entry);
        break;
      }
      case 'tool/call':
        assistantByStep.get(event.data.stepId)?.tools.push({ call: event.data.call });
        break;
      case 'tool/result': {
        const result = event.data.result;
        const tool = assistantByStep.get(event.data.stepId)?.tools.find(({ call }) => call.id === result.callId);
        if (tool) tool.result = result;
        break;
      }
      case 'crew/wake': {
        const { workerId, title, outcome, report } = event.data;
        messages.push({
          role: 'notice', id: `wake-${event.seq}`, kind: 'crew-wake',
          workerId, title, outcome, content: report, at: event.ts,
        });
        break;
      }
    }
  }
  return messages;
}

export function projectModelMessages(events: readonly SessionEvent[]): ModelMessage[] {
  return projectMessages(events).flatMap((message): ModelMessage[] => {
    if (message.role === 'user') return [{ role: 'user', content: message.content }];
    if (message.role === 'notice') {
      return [{ role: 'user', content: `[crew notice] ${message.title} ${message.outcome === 'completed' ? 'finished' : message.outcome}: ${message.content}` }];
    }
    return [
      { role: 'assistant', content: message.content, reasoning: message.reasoning, toolCalls: message.tools.map(({ call }) => call) },
      ...message.tools.flatMap(({ result }): ModelMessage[] => result ? [{ role: 'tool', result }] : []),
    ];
  });
}
