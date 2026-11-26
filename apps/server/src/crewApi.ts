import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Thread } from '@extendo/contracts';
import { GitError } from '@extendo/git';
import { decideOrigin, isAllowedOrigin, resolveOriginPolicy, type OriginPolicy } from './origin.js';
import type { Runtime } from './runtime.js';
import type { ThreadRow } from './state.js';

const selection = z.string().trim().min(1).max(128);
const steerInput = z.object({
  text: z.string().trim().min(1).max(20_000),
  mode: z.enum(['queue', 'interrupt']).default('queue'),
});
const landInput = z.object({ target: z.string().trim().min(1).max(240).optional() });

async function body<T>(read: () => Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try { value = await read(); }
  catch { throw new HTTPException(400, { message: 'Expected a JSON request body' }); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HTTPException(400, { message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid request' });
  }
  return parsed.data;
}

export interface CrewApiOptions {
  origin?: OriginPolicy;
}

/**
 * The crew's HTTP surface: a worker's branch diff, landing it, and steering a running worker. It is
 * its own Hono app dispatched ahead of the console app, so it answers under the same origin policy
 * the console and the `/ws` upgrade already share without changing either.
 *
 * Every mutation answers with the captain's refreshed thread too: landing and steering change what
 * the crew row shows, and the caller should not have to wait for the next socket snapshot to see it.
 */
export function createCrewApp(runtime: Runtime, options: CrewApiOptions = {}): Hono {
  const app = new Hono();
  const policy = options.origin ?? resolveOriginPolicy();
  const { workspace, crew, viewer } = runtime;

  app.use('*', async (c, next) => {
    const decision = decideOrigin({
      host: c.req.header('host') ?? new URL(c.req.url).host,
      origin: c.req.header('origin'),
      'x-forwarded-host': c.req.header('x-forwarded-host'),
      'x-forwarded-proto': c.req.header('x-forwarded-proto'),
    }, policy);
    if (!decision.allowed) return c.json({ error: 'This Extendo server does not accept requests from that origin' }, 403);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    await next();
  });
  app.use('*', cors({ origin: (origin) => isAllowedOrigin(origin, policy) ? origin : null, allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type'] }));
  app.use('*', bodyLimit({
    maxSize: 128 * 1024,
    onError: (c) => c.json({ error: 'Request body is too large' }, 413),
  }));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof GitError) {
      const status = error.code === 'conflict' || error.code === 'unsafe' ? 409 : error.code === 'failed' ? 422 : 400;
      return c.json({ error: error.message, code: error.code, ...error.detail }, status);
    }
    return c.json({ error: error instanceof Error ? error.message : 'Extendo could not complete the request' }, 500);
  });

  /** The captain that owns a worker, and the worker itself, or a refusal that says which part is missing. */
  function pair(threadId: string): { captain: ThreadRow; worker: ThreadRow } {
    const worker = workspace.thread(threadId);
    if (!worker) throw new HTTPException(404, { message: 'Unknown worker' });
    if (worker.role !== 'worker') throw new HTTPException(409, { message: `${worker.title} is not a worker on a crew` });
    const captain = worker.captainId ? workspace.thread(worker.captainId) : undefined;
    if (!captain || captain.role !== 'captain') throw new HTTPException(409, { message: `${worker.title} has no captain to report to` });
    return { captain, worker };
  }

  async function snapshot(captain: ThreadRow): Promise<Thread | undefined> {
    viewer.invalidate(captain.sessionId);
    return viewer.get(captain.sessionId);
  }

  app.get('/api/crew/:threadId/diff', async (c) => {
    const id = selection.safeParse(c.req.param('threadId'));
    if (!id.success) return c.json({ error: 'Invalid worker' }, 400);
    const { captain, worker } = pair(id.data);
    return c.json(await crew.diff(captain, worker.id));
  });

  app.post('/api/crew/:threadId/integrate', async (c) => {
    const id = selection.safeParse(c.req.param('threadId'));
    if (!id.success) return c.json({ error: 'Invalid worker' }, 400);
    const { captain, worker } = pair(id.data);
    const input = await body(() => c.req.json(), landInput);
    const result = await crew.integrate(captain, worker.id, input.target);
    return c.json({ ...result, thread: await snapshot(captain) });
  });

  app.post('/api/crew/:threadId/steer', async (c) => {
    const id = selection.safeParse(c.req.param('threadId'));
    if (!id.success) return c.json({ error: 'Invalid worker' }, 400);
    const { captain, worker } = pair(id.data);
    const input = await body(() => c.req.json(), steerInput);
    const delivered = await crew.message(captain, worker.id, input.text, input.mode);
    return c.json({ ...delivered, thread: await snapshot(captain) });
  });

  return app;
}