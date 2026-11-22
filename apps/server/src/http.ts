import type { IncomingMessage } from 'node:http';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import type { Runtime } from './runtime.js';
import { renderPreview } from './preview.js';

const selection = z.string().trim().min(1).max(256);
const title = z.string().trim().min(1).max(240);
const projectInput = z.object({ path: z.string().trim().min(1).max(4096), name: title.optional() });
const threadInput = z.object({ projectId: selection.optional(), title: title.optional(), provider: selection.optional(), model: selection.optional() });
const settingsInput = z.object({ provider: selection, model: selection.optional() });

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

export interface HttpOptions {
  webRoot?: string;
  devOrigins?: string[];
}

const devDefaults = ['http://127.0.0.1:5173', 'http://localhost:5173'];

export function allowsLocal(host: string | undefined, origin: string | undefined, allowed = devDefaults): boolean {
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) return false;
  return !origin || origin === `http://${host}` || origin === `https://${host}` || allowed.includes(origin);
}

export function allowsUpgrade(request: IncomingMessage, allowed?: string[]): boolean {
  return allowsLocal(request.headers.host, request.headers.origin, allowed);
}

export function createHttpApp(runtime: Runtime, options: HttpOptions = {}): Hono {
  const app = new Hono();
  const { agent, workspace, sessions } = runtime;
  const devOrigins = options.devOrigins ?? devDefaults;

  app.use('*', async (c, next) => {
    if (!allowsLocal(c.req.header('host') ?? new URL(c.req.url).host, c.req.header('origin'), devOrigins)) {
      return c.json({ error: 'Only local Extendo clients are allowed' }, 403);
    }
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    await next();
  });
  app.use('/api/*', cors({ origin: (origin) => devOrigins.includes(origin) ? origin : null, allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'], allowHeaders: ['Content-Type'] }));
  app.use('/api/*', bodyLimit({
    maxSize: 512 * 1024,
    onError: (c) => c.json({ error: 'Request body is too large' }, 413),
  }));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    runtime.ctx.logger.error(`HTTP request failed: ${error.name}`);
    return c.json({ error: 'Extendo could not complete the request' }, 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/providers', (c) => c.json(runtime.providers()));
  app.get('/api/projects', (c) => c.json(workspace.projects()));
  app.post('/api/projects', async (c) => {
    const input = await body(() => c.req.json(), projectInput);
    try { return c.json(workspace.openProject(input.path, input.name), 201); }
    catch { return c.json({ error: 'That local directory could not be opened' }, 400); }
  });
  app.get('/api/threads', async (c) => c.json(await runtime.viewer.list(c.req.query('projectId'))));
  app.post('/api/threads', async (c) => {
    const input = await body(() => c.req.json(), threadInput);
    const project = input.projectId ? workspace.project(input.projectId) : workspace.projects()[0];
    if (!project) return c.json({ error: 'Open a project before creating a thread' }, 404);
    const settings = workspace.settings();
    const provider = input.provider ?? settings.provider;
    try {
      const model = runtime.model(provider, input.model ?? (settings.provider === provider ? settings.model : undefined));
      const created = workspace.createThread(sessions, project, { ...model, title: input.title ?? 'New thread' });
      return c.json(await runtime.viewer.get(created.sessionId), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Could not create thread' }, 400);
    }
  });
  app.get('/api/sessions/:id', (c) => {
    const id = c.req.param('id');
    if (!sessions.get(id)) return c.json({ error: 'Unknown session' }, 404);
    return c.json(sessions.snapshot(id));
  });
  app.get('/api/sessions/:id/events', (c) => {
    const id = c.req.param('id');
    if (!sessions.get(id)) return c.json({ error: 'Unknown session' }, 404);
    const afterSeq = Number(c.req.query('afterSeq') ?? 0);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) return c.json({ error: 'Invalid event cursor' }, 400);
    return c.json({ events: sessions.replay(id, afterSeq), lastSeq: sessions.lastSeq(id) });
  });
  app.get('/api/settings', (c) => c.json(workspace.settings()));
  app.put('/api/settings', async (c) => {
    const input = await body(() => c.req.json(), settingsInput);
    if (!runtime.providers().some(({ id }) => id === input.provider)) return c.json({ error: 'Unknown provider' }, 400);
    return c.json(workspace.saveSettings(input));
  });

  app.get('/api/preview/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId');
    const thread = workspace.threadBySession(sessionId);
    if (!thread) return c.text('Unknown thread', 404);
    return c.html(renderPreview(thread, sessions.replay(sessionId)));
  });
  app.all('/api/*', (c) => c.json({ error: 'Unknown API route' }, 404));
  if (options.webRoot) {
    app.use('/assets/*', serveStatic({ root: options.webRoot }));
    app.get('/favicon.svg', serveStatic({ root: options.webRoot }));
    app.get('*', serveStatic({ root: options.webRoot, path: 'index.html' }));
  }
  app.get('/', (c) => c.text('Extendo is running. Build apps/web to serve the browser workspace.', 503));
  return app;
}
