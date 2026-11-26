import { noticeFor } from '@extendo/contracts';
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
      case 'crew/wake':
      case 'crew/land': {
        const notice = noticeFor(event);
        if (notice) messages.push(notice);
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
      const lead = message.kind === 'crew-wake'
        ? `${message.title} ${message.outcome === 'completed' ? 'finished' : message.outcome}`
        : `${message.title} on ${message.target}`;
      return [{ role: 'user', content: `[crew notice] ${lead}: ${message.content}` }];
    }
    return [
      { role: 'assistant', content: message.content, reasoning: message.reasoning, toolCalls: message.tools.map(({ call }) => call) },
      ...message.tools.flatMap(({ result }): ModelMessage[] => result ? [{ role: 'tool', result }] : []),
    ];
  });
}
