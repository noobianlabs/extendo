import type { ModelChunk, ModelRequest } from '@extendo/contracts';
import { describe, expect, it } from 'vitest';
import { anthropicProvider, deepSeekProvider, demoProvider, openAIProvider, providerInfos } from './index.js';

const request: ModelRequest = {
  model: 'model',
  system: ['System notes'],
  messages: [{ role: 'user', content: 'Find the README' }],
  tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }],
  signal: new AbortController().signal,
};

async function collect(chunks: AsyncIterable<ModelChunk>) {
  const result: ModelChunk[] = [];
  for await (const chunk of chunks) result.push(chunk);
  return result;
}

function sse(...frames: unknown[]): Response {
  const encoded = new TextEncoder().encode(frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\r\n\r\n').join('') + 'data: [DONE]\n\n');
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7));
      controller.close();
    },
  }));
}

describe('provider adapters', () => {
  it('sends OpenAI wire messages and assembles fragmented function arguments', async () => {
    const provider = openAIProvider({ apiKey: 'test-fixture', baseUrl: 'https://example.test/compat/', fetch: async (url, init) => {
      expect(String(url)).toBe('https://example.test/compat/chat/completions');
      expect(init?.signal).toBe(request.signal);
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true,
        messages: [{ role: 'system', content: 'System notes' }, ...request.messages], tools: [{ function: { name: 'read' } }] });
      return sse(
        { choices: [{ delta: { content: 'Reading Español.' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'read', arguments: '{"path":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: 'tool_calls' }] },
        { usage: { prompt_tokens: 9, completion_tokens: 4 } },
      );
    } });
    expect(await collect(provider.stream(request))).toEqual([
      { type: 'text-delta', delta: 'Reading Español.' }, { type: 'usage', usage: { inputTokens: 9, outputTokens: 4 } },
      { type: 'tool-call', call: { id: 'a', name: 'read', input: { path: 'README.md' } } }, { type: 'done' },
    ]);
  });

  it('keeps DeepSeek reasoning inside the active tool turn', async () => {
    const provider = deepSeekProvider({ apiKey: 'test-fixture', fetch: async (_, init) => {
      const sent = JSON.parse(String(init?.body)).messages;
      expect(sent[2]).not.toHaveProperty('reasoning_content');
      expect(sent[4]).toMatchObject({ role: 'assistant', reasoning_content: 'current thinking' });
      return sse({ choices: [{ delta: { reasoning_content: 'reason', content: 'done' }, finish_reason: 'stop' }] });
    } });
    const assistant = { role: 'assistant', content: '', reasoning: 'current thinking' } as const;
    const messages = [...request.messages, { ...assistant, reasoning: 'old' }, ...request.messages, assistant];
    expect(await collect(provider.stream({ ...request, messages }))).toContainEqual({ type: 'reasoning-delta', delta: 'reason' });
  });

  it('encodes Anthropic tools, streams blocks, and reports usage', async () => {
    const provider = anthropicProvider({ apiKey: 'test-fixture', fetch: async (url, init) => {
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
      expect(JSON.parse(String(init?.body))).toMatchObject({ system: 'System notes', tools: [{ name: 'read', input_schema: { type: 'object' } }] });
      return sse(
        { type: 'message_start', message: { usage: { input_tokens: 8 } } },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'x', name: 'read' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"test"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      );
    } });
    expect(await collect(provider.stream(request))).toEqual([
      { type: 'usage', usage: { inputTokens: 8 } }, { type: 'tool-call', call: { id: 'x', name: 'read', input: { path: 'test' } } },
      { type: 'usage', usage: { outputTokens: 2 } }, { type: 'done' },
    ]);
  });

  it('rejects partial streams and does not include HTTP error bodies', async () => {
    const stream = openAIProvider({ apiKey: 'fixture', fetch: async () => sse({ choices: [{ delta: { content: 'partial' } }] }) });
    await expect(collect(stream.stream(request))).rejects.toThrow('ended before completion');
    const unavailable = anthropicProvider({ apiKey: 'fixture', fetch: async () => new Response('private response', { status: 403 }) });
    await expect(collect(unavailable.stream(request))).rejects.toThrow(/^Anthropic returned HTTP 403$/);
  });

  it('streams the local scripted provider without external credentials', async () => {
    expect(providerInfos({}).filter(({ configured }) => configured).map(({ id }) => id)).toEqual(['demo']);
    const output = await collect(demoProvider(0).stream(request));
    expect(output).toContainEqual(expect.objectContaining({ type: 'tool-call', call: expect.objectContaining({ name: 'demo_read' }) }));
    expect(output.at(-1)).toEqual({ type: 'done' });
  });
});
