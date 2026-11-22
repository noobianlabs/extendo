import type { JsonValue, ModelMessage, Provider } from '@extendo/contracts';
import { events, parseArguments } from './sse.js';

export interface AnthropicOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

function anthropicMessages(messages: ModelMessage[]): { role: 'user' | 'assistant'; content: unknown[] }[] {
  const result: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const last = result.at(-1);
    const target: (typeof result)[number] = last?.role === role ? last : { role, content: [] };
    if (target !== last) result.push(target);
    if (message.role === 'tool') {
      target.content.push({ type: 'tool_result', tool_use_id: message.result.callId, content: JSON.stringify(message.result.output), is_error: message.result.isError });
    } else {
      if (message.content) target.content.push({ type: 'text', text: message.content });
      if (message.role === 'assistant') {
        target.content.push(...(message.toolCalls ?? []).map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })));
      }
    }
  }
  return result.filter(({ content }) => content.length > 0);
}

type AnthropicFrame =
  | { type: 'error' }
  | { type: 'message_start'; message: { usage?: { input_tokens?: number } } }
  | { type: 'content_block_start'; index: number; content_block: { type: string; id?: string; name?: string; input?: JsonValue; text?: string; thinking?: string } }
  | { type: 'content_block_delta'; index: number; delta: { type: string; text?: string; thinking?: string; partial_json?: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta?: { stop_reason?: string }; usage?: { output_tokens?: number } }
  | { type: 'message_stop' };

export function anthropicProvider(options: AnthropicOptions): Provider {
  return {
    id: 'anthropic',
    async *stream(request) {
      if (!options.apiKey) throw new Error('Anthropic API key is not configured');
      const response = await (options.fetch ?? globalThis.fetch)('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        redirect: 'error',
        signal: request.signal,
        headers: { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          max_tokens: 8192,
          system: request.system.join('\n\n') || undefined,
          messages: anthropicMessages(request.messages),
          tools: request.tools.length ? request.tools.map((tool) => ({
            name: tool.name, description: tool.description, input_schema: tool.inputSchema,
          })) : undefined,
          stream: true,
        }),
      });
      const calls = new Map<number, { id: string; name: string; input: JsonValue; args: string }>();
      for await (const frame of events(response, 'Anthropic') as AsyncIterable<AnthropicFrame>) {
        switch (frame.type) {
          case 'error': throw new Error('Anthropic reported a streaming error');
          case 'message_start':
            if (frame.message.usage) yield { type: 'usage', usage: { inputTokens: frame.message.usage.input_tokens } };
            break;
          case 'content_block_start': {
            const block = frame.content_block;
            if (block.type === 'text' && block.text) yield { type: 'text-delta', delta: block.text };
            if (block.type === 'thinking' && block.thinking) yield { type: 'reasoning-delta', delta: block.thinking };
            if (block.type === 'tool_use') calls.set(frame.index, { id: block.id ?? '', name: block.name ?? '', input: block.input ?? {}, args: '' });
            break;
          }
          case 'content_block_delta': {
            const delta = frame.delta;
            if (delta.type === 'text_delta' && delta.text) yield { type: 'text-delta', delta: delta.text };
            if (delta.type === 'thinking_delta' && delta.thinking) yield { type: 'reasoning-delta', delta: delta.thinking };
            const call = calls.get(frame.index);
            if (call && delta.type === 'input_json_delta') call.args += delta.partial_json ?? '';
            break;
          }
          case 'content_block_stop': {
            const call = calls.get(frame.index);
            if (call) {
              calls.delete(frame.index);
              yield { type: 'tool-call', call: { id: call.id, name: call.name, input: call.args ? parseArguments(call.args) as JsonValue : call.input } };
            }
            break;
          }
          case 'message_delta':
            if (frame.delta?.stop_reason === 'max_tokens' || frame.delta?.stop_reason === 'refusal') throw new Error(`Anthropic stopped before completing the answer (${frame.delta.stop_reason})`);
            if (frame.usage) yield { type: 'usage', usage: { outputTokens: frame.usage.output_tokens } };
            break;
          case 'message_stop':
            if (calls.size) throw new Error('Anthropic did not finish a tool call');
            yield { type: 'done' };
            return;
        }
      }
      throw new Error('Anthropic stream ended before completion');
    },
  };
}
