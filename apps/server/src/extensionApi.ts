import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { ExtensionWorkshop } from './extensions.js';
import { decideOrigin, isAllowedOrigin, resolveOriginPolicy, type OriginPolicy } from './origin.js';

const source = z.string().min(1).max(64_000);
const createInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).optional(),
  source: source.optional(),
});
const saveInput = z.object({ source });

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

export interface ExtensionApiOptions {
  origin?: OriginPolicy;
}

/**
 * The plugin workshop's HTTP surface. It is its own Hono app, dispatched from the server's request
 * handler before the console app, so it answers under the same origin policy without changing it.
 */
export function createExtensionApp(workshop: ExtensionWorkshop, options: ExtensionApiOptions = {}): Hono {
  const app = new Hono();
  const policy = options.origin ?? resolveOriginPolicy();

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
  app.use('*', cors({ origin: (origin) => isAllowedOrigin(origin, policy) ? origin : null, allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowHeaders: ['Content-Type'] }));
  app.use('*', bodyLimit({
    maxSize: 128 * 1024,
    onError: (c) => c.json({ error: 'Plugin source is too large' }, 413),
  }));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    return c.json({ error: error instanceof Error ? error.message : 'Extendo could not complete the request' }, 500);
  });

  app.get('/api/extensions', (c) => c.json(workshop.list()));
  app.get('/api/extensions/tools', (c) => c.json({ tools: workshop.tools() }));
  app.post('/api/extensions', async (c) => {
    const input = await body(() => c.req.json(), createInput);
    const extension = await workshop.create(input);
    return c.json({ extension, state: workshop.list() }, 201);
  });
  app.put('/api/extensions/:id', async (c) => {
    const input = await body(() => c.req.json(), saveInput);
    const saved = await workshop.save(c.req.param('id'), input.source);
    const failed = saved.extension.error;
    return c.json(failed ? { ...saved, error: failed } : saved, failed ? 422 : 200);
  });
  app.delete('/api/extensions/:id', (c) => c.json(workshop.remove(c.req.param('id'))));
  app.all('*', (c) => c.json({ error: 'Unknown plugin route' }, 404));
  return app;
}
