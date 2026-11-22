import { describe, expect, it } from 'vitest';
import { rpcRequestSchema } from './index.js';

describe('RPC contract', () => {
  it('validates and normalizes a send request', () => {
    expect(rpcRequestSchema.parse({ id: 1, method: 'send-message', params: { sessionId: 's', content: '  hello  ', extra: false } }))
      .toEqual({ id: 1, method: 'send-message', params: { sessionId: 's', content: 'hello' } });
  });

  it.each([
    { id: 1, method: 'send-message', params: { sessionId: 's', content: ' ' } },
    { id: 1, method: 'subscribe', params: { sessionId: 's', afterSeq: -1 } },
    { id: 1, method: 'answer-approval', params: { sessionId: 's', requestId: 'r', decision: 'bypass' } },
    { id: 1, method: 'missing', params: {} },
  ])('rejects invalid request %j', (request) => {
    expect(rpcRequestSchema.safeParse(request).success).toBe(false);
  });
});
