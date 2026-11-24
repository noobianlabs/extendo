import type { ModelChunk, ModelRequest } from '@extendo/contracts';
import { describe, expect, it } from 'vitest';
import { anthropicProvider, deepSeekProvider, demoProvider, fragment, openAIProvider, pluginTools, providerInfos, synthesizeInput } from './index.js';

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

  it('calls a plugin tool only when the model was actually offered it', async () => {
    const plugin = {
      model: 'model', system: ['System notes'], signal: new AbortController().signal,
      messages: [{ role: 'user', content: 'Run the word_count plugin tool on this sentence.' }],
      tools: [{ name: 'word_count', description: 'Count words', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
    } satisfies ModelRequest;
    expect(pluginTools(plugin.tools).map(({ name }) => name)).toEqual(['word_count']);
    expect(await collect(demoProvider(0).stream(plugin))).toContainEqual({
      type: 'tool-call', call: expect.objectContaining({ name: 'word_count', input: { text: expect.any(String) } }),
    });

    const unoffered = { ...plugin, tools: [] };
    expect(await collect(demoProvider(0).stream(unoffered))).not.toContainEqual(
      expect.objectContaining({ type: 'tool-call', call: expect.objectContaining({ name: 'word_count' }) }),
    );
  });

  it('quotes what the plugin tool answered on the following step', async () => {
    const request: ModelRequest = {
      model: 'model', system: ['System notes'], signal: new AbortController().signal,
      tools: [{ name: 'word_count', description: 'Count words', inputSchema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'Run the word_count plugin tool.' },
        { role: 'assistant', content: 'Calling it.' },
        { role: 'tool', result: { callId: 'call-1', name: 'word_count', output: { words: 5 }, isError: false } },
      ],
    };
    const output = await collect(demoProvider(0).stream(request));
    const text = output.flatMap((chunk) => chunk.type === 'text-delta' ? [chunk.delta] : []).join('');
    expect(text).toContain('{"words": 5}');
    expect(output).not.toContainEqual(expect.objectContaining({ type: 'tool-call' }));
  });

  it('never drops a character while streaming, even inside an unbroken run', () => {
    const payload = 'word_count answered {"words":26,"characters":127,"longest":"Extendo"}. That is all.';
    expect(fragment(payload).join('')).toBe(payload);
    expect(fragment(payload, 12).join('')).toBe(payload);
    expect(fragment('x'.repeat(140), 16).join('')).toBe('x'.repeat(140));
    expect(fragment('')).toEqual(['']);
  });

  it('operates on the sentence the person actually asked about', async () => {
    const request: ModelRequest = {
      model: 'model', system: [], signal: new AbortController().signal,
      tools: [{ name: 'word_count', description: 'Count words', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
      messages: [{ role: 'user', content: 'Use the word_count plugin tool on this sentence: the harness, the editor and the extensions are one substrate.' }],
    };
    const output = await collect(demoProvider(0).stream(request));
    const call = output.find((chunk) => chunk.type === 'tool-call');
    expect(call).toMatchObject({ call: { name: 'word_count', input: { text: 'the harness, the editor and the extensions are one substrate.' } } });
  });

  it('reads a JSON payload back as a sentence so it can wrap', async () => {
    const request: ModelRequest = {
      model: 'model', system: [], signal: new AbortController().signal,
      tools: [{ name: 'word_count', description: 'Count words', inputSchema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'Run the word_count plugin tool.' },
        { role: 'tool', result: { callId: 'call-1', name: 'word_count', output: { words: 10, characters: 62, longest: 'extensions' }, isError: false } },
      ],
    };
    const text = (await collect(demoProvider(0).stream(request)))
      .flatMap((chunk) => chunk.type === 'text-delta' ? [chunk.delta] : []).join('');
    expect(text).toContain('`{"words": 10, "characters": 62, "longest": "extensions"}`');
  });

  it('streams the plugin answer with the payload it was given, intact', async () => {
    const request: ModelRequest = {
      model: 'model', system: [], signal: new AbortController().signal,
      tools: [{ name: 'word_count', description: 'Count words', inputSchema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'Run the word_count plugin tool.' },
        { role: 'tool', result: { callId: 'call-1', name: 'word_count', output: { words: 26, characters: 127, longest: 'Extendo' }, isError: false } },
      ],
    };
    const text = (await collect(demoProvider(0).stream(request)))
      .flatMap((chunk) => chunk.type === 'text-delta' ? [chunk.delta] : []).join('');
    expect(text).toContain('`{"words": 26, "characters": 127, "longest": "Extendo"}`');
  });

  it('builds a tool input from the schema the model was shown', () => {
    expect(synthesizeInput({
      type: 'object',
      properties: { text: { type: 'string' }, limit: { type: 'integer', minimum: 2 }, path: { type: 'string' }, dry: { type: 'boolean' } },
    })).toEqual({ text: expect.any(String), limit: 2, path: 'src/search/EmptyState.tsx', dry: true });
    expect(synthesizeInput({ type: 'object' })).toEqual({});
  });

  it('streams the local scripted provider without external credentials', async () => {
    expect(providerInfos({}).filter(({ configured }) => configured).map(({ id }) => id)).toEqual(['demo']);
    const output = await collect(demoProvider(0).stream(request));
    expect(output).toContainEqual(expect.objectContaining({ type: 'tool-call', call: expect.objectContaining({ name: 'demo_read' }) }));
    expect(output.at(-1)).toEqual({ type: 'done' });
  });
});
