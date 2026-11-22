import type { JsonValue, ModelChunk, ModelMessage, Provider } from '@extendo/contracts';
import { events, parseArguments } from './sse.js';

export interface OpenAIOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

function openAIMessages(messages: ModelMessage[], deepseek: boolean): Record<string, unknown>[] {
  const currentTurn = messages.findLastIndex(({ role }) => role === 'user');
  return messages.map((message, index) => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.result.callId, content: JSON.stringify(message.result.output) };
    if (message.role === 'user') return message;
    return {
      role: 'assistant',
      content: message.content || null,
      ...(deepseek && index > currentTurn && message.reasoning ? { reasoning_content: message.reasoning } : {}),
      tool_calls: message.toolCalls?.length ? message.toolCalls.map((call) => ({
        id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) },
      })) : undefined,
    };
  });
}

interface ChatFrame {
  error?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}

function chatProvider(id: 'openai' | 'deepseek', options: OpenAIOptions): Provider {
  const deepseek = id === 'deepseek';
  const endpoint = new URL((options.baseUrl ?? (deepseek ? 'https://api.deepseek.com' : 'https://api.openai.com/v1')).replace(/\/+$/, '') + '/chat/completions');
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Invalid provider base URL');
  return {
    id,
    async *stream(request) {
      if (!options.apiKey) throw new Error(`${id} API key is not configured`);
      const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: request.signal,
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: [
            ...(request.system.length ? [{ role: 'system', content: request.system.join('\n\n') }] : []),
            ...openAIMessages(request.messages, deepseek),
          ],
          tools: request.tools.length ? request.tools.map((tool) => ({
            type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
          })) : undefined,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });

      const calls = new Map<number, { id: string; name: string; args: string }>();
      let finished = false;
      for await (const frame of events(response, id) as AsyncIterable<ChatFrame>) {
        if (frame.error) throw new Error(`${id} reported a streaming error`);
        const choice = frame.choices?.[0];
        if (choice?.delta?.content) yield { type: 'text-delta', delta: choice.delta.content } satisfies ModelChunk;
        if (choice?.delta?.reasoning_content) yield { type: 'reasoning-delta', delta: choice.delta.reasoning_content };
        for (const part of choice?.delta?.tool_calls ?? []) {
          const call = calls.get(part.index) ?? { id: '', name: '', args: '' };
          if (part.id) call.id = part.id;
          call.name += part.function?.name ?? '';
          call.args += part.function?.arguments ?? '';
          calls.set(part.index, call);
        }
        if (frame.usage) yield { type: 'usage', usage: { inputTokens: frame.usage.prompt_tokens, outputTokens: frame.usage.completion_tokens } };
        if (choice?.finish_reason) {
          if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') throw new Error(`${id} stopped before completing the answer (${choice.finish_reason})`);
          finished = true;
        }
      }
      if (!finished) throw new Error(`${id} stream ended before completion`);
      for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
        yield { type: 'tool-call', call: { id: call.id, name: call.name, input: parseArguments(call.args) as JsonValue } };
      }
      yield { type: 'done' };
    },
  };
}

export const openAIProvider = (options: OpenAIOptions): Provider => chatProvider('openai', options);
export const deepSeekProvider = (options: OpenAIOptions): Provider => chatProvider('deepseek', options);
