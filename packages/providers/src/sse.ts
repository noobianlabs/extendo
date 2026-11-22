export async function* events(response: Response, provider: string): AsyncGenerator<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${provider} returned HTTP ${response.status}`);
  }
  if (!response.body) throw new Error(`${provider} returned an empty stream`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lines: string[] = [];
  let size = 0;
  try {
    for (let done = false; !done;) {
      const next = await reader.read();
      done = next.done;
      buffer += decoder.decode(next.value, { stream: !done });
      if (done) buffer += '\n\n';
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line.startsWith('data:')) {
          const data = line.slice(5).replace(/^ /, '');
          size += data.length;
          if (size > 2_000_000) throw new Error(`${provider} sent an oversized stream event`);
          lines.push(data);
        } else if (!line && lines.length) {
          const data = lines.join('\n');
          lines = [];
          size = 0;
          if (data === '[DONE]') return;
          try {
            const value: unknown = JSON.parse(data);
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
            yield value as Record<string, unknown>;
          } catch (error) {
            if (error instanceof SyntaxError || (error instanceof Error && !error.message)) throw new Error(`${provider} sent invalid stream data`);
            throw error;
          }
        }
      }
      if (buffer.length > 2_000_000) throw new Error(`${provider} sent an oversized stream line`);
    }
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

export function parseArguments(input: string): unknown {
  try { return JSON.parse(input || '{}'); }
  catch { throw new Error('Provider sent invalid tool arguments'); }
}
