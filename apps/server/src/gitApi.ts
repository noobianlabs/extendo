import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { GitCapabilities, GitView, WorktreeInfo, WorktreeView, WorkspaceStatus } from '@extendo/contracts';
import { GitError, type GitService } from '@extendo/git';
import { decideOrigin, isAllowedOrigin, resolveOriginPolicy, type OriginPolicy } from './origin.js';
import type { Runtime } from './runtime.js';
import type { ThreadRow } from './state.js';

const selection = z.string().trim().min(1).max(128);
const checkoutInput = z.object({ sessionId: selection.optional(), projectId: selection.optional() });
const paths = z.array(z.string().min(1).max(4096)).min(1).max(500);
const stageInput = checkoutInput.extend({ paths, allowSecrets: z.boolean().optional() });
const commitInput = checkoutInput.extend({ message: z.string().trim().min(1).max(2_000) });
const pullInput = checkoutInput.extend({ title: z.string().trim().max(240).optional(), body: z.string().max(20_000).optional() });
const worktreeInput = z.object({ sessionId: selection, base: z.string().trim().max(255).optional() });

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

export interface SourceApiOptions {
  origin?: OriginPolicy;
  git?: GitService;
}

/**
 * The source surface's HTTP app: a checkout's state, its diffs, staging, committing, pushing, pull
 * requests, and the worktree a thread can own. It is its own Hono app, dispatched ahead of the
 * console app, so it inherits the same origin policy without editing the console's routes.
 *
 * Thread deletion lives here too: deleting a thread has to release and remove its worktree, and that
 * is the only destructive action in the product that spans both records.
 */
export function createSourceApp(runtime: Runtime, options: SourceApiOptions = {}): Hono {
  const app = new Hono();
  const policy = options.origin ?? resolveOriginPolicy();
  const git = options.git ?? runtime.git;
  const { workspace, sessions, agent } = runtime;

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
  app.use('*', cors({ origin: (origin) => isAllowedOrigin(origin, policy) ? origin : null, allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowHeaders: ['Content-Type'] }));
  app.use('*', bodyLimit({
    maxSize: 128 * 1024,
    onError: (c) => c.json({ error: 'Request body is too large' }, 413),
  }));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof GitError) {
      const status = error.code === 'blocked' || error.code === 'unsafe' ? 409 : error.code === 'failed' ? 422 : 400;
      return c.json({ error: error.message, code: error.code, ...error.detail }, status);
    }
    return c.json({ error: error instanceof Error ? error.message : 'Extendo could not complete the request' }, 500);
  });

  function checkout(input: { sessionId?: string; projectId?: string }): { row?: ThreadRow; path: string; sessionId?: string; projectPath: string } {
    if (input.sessionId) {
      const row = workspace.threadBySession(input.sessionId);
      if (!row) throw new HTTPException(404, { message: 'Unknown thread' });
      const project = workspace.project(row.projectId);
      return { row, path: row.cwd, sessionId: row.sessionId, projectPath: project?.path ?? row.cwd };
    }
    const project = input.projectId ? workspace.project(input.projectId) : workspace.projects()[0];
    if (!project) throw new HTTPException(404, { message: 'Open a project before reading its changes' });
    return { path: project.path, projectPath: project.path };
  }

  async function view(input: { sessionId?: string; projectId?: string }): Promise<GitView> {
    const target = checkout(input);
    const status: WorkspaceStatus = await git.status(target.path);
    const [worktrees, capabilities] = await Promise.all([
      git.worktrees(target.path, target.path).catch((): WorktreeInfo[] => []),
      git.capabilities(target.path).catch((): GitCapabilities => ({ gh: { available: false, authenticated: false, detail: 'Could not check for the GitHub CLI' } })),
    ]);
    return {
      checkout: { path: target.path, worktree: target.row?.worktree, sessionId: target.sessionId },
      status,
      worktrees,
      capabilities,
    };
  }

  async function worktreeView(sessionId: string): Promise<WorktreeView> {
    const thread = await runtime.viewer.get(sessionId);
    if (!thread) throw new HTTPException(404, { message: 'Unknown thread' });
    return { ...await view({ sessionId }), thread };
  }

  function requireIdle(sessionId: string): void {
    if (agent.status(sessionId) === 'working') {
      throw new HTTPException(409, { message: 'This thread is working. Wait for the turn to finish before moving or removing its checkout.' });
    }
  }

  app.get('/api/git/status', async (c) => {
    const parsed = checkoutInput.safeParse({ sessionId: c.req.query('sessionId') ?? undefined, projectId: c.req.query('projectId') ?? undefined });
    if (!parsed.success) return c.json({ error: 'Invalid checkout' }, 400);
    return c.json(await view(parsed.data));
  });

  app.get('/api/git/diff', async (c) => {
    const parsed = checkoutInput.safeParse({ sessionId: c.req.query('sessionId') ?? undefined, projectId: c.req.query('projectId') ?? undefined });
    const path = c.req.query('path');
    if (!parsed.success || !path) return c.json({ error: 'Name a file in the checkout' }, 400);
    const target = checkout(parsed.data);
    return c.json(await git.change(target.path, path, c.req.query('staged') === '1'));
  });

  app.post('/api/git/stage', async (c) => {
    const input = await body(() => c.req.json(), stageInput);
    const target = checkout(input);
    await git.stage(target.path, input.paths, input.allowSecrets ?? false);
    return c.json(await view(input));
  });

  app.post('/api/git/unstage', async (c) => {
    const input = await body(() => c.req.json(), stageInput);
    const target = checkout(input);
    await git.unstage(target.path, input.paths);
    return c.json(await view(input));
  });

  app.post('/api/git/discard', async (c) => {
    const input = await body(() => c.req.json(), stageInput);
    const target = checkout(input);
    await git.discard(target.path, input.paths);
    return c.json(await view(input));
  });

  app.post('/api/git/commit', async (c) => {
    const input = await body(() => c.req.json(), commitInput);
    const target = checkout(input);
    const commit = await git.commit(target.path, input.message);
    return c.json({ commit, view: await view(input) });
  });

  app.post('/api/git/push', async (c) => {
    const input = await body(() => c.req.json(), checkoutInput);
    const target = checkout(input);
    const push = await git.push(target.path);
    return c.json({ push, view: await view(input) });
  });

  app.post('/api/git/pull-request', async (c) => {
    const input = await body(() => c.req.json(), pullInput);
    const target = checkout(input);
    const pullRequest = await git.pullRequest(target.path, { title: input.title, body: input.body });
    return c.json({ pullRequest, view: await view(input) });
  });

  app.post('/api/git/worktree', async (c) => {
    const input = await body(() => c.req.json(), worktreeInput);
    const row = workspace.threadBySession(input.sessionId);
    if (!row) return c.json({ error: 'Unknown thread' }, 404);
    if (row.worktree) return c.json({ error: 'This thread already has its own worktree' }, 409);
    requireIdle(row.sessionId);
    const project = workspace.project(row.projectId);
    if (!project) return c.json({ error: 'The thread has no project to branch from' }, 400);
    const created = await git.createWorktree(project.path, { title: row.title, base: input.base });
    workspace.setThreadCheckout(row.sessionId, { cwd: created.path, branch: created.branch, worktree: created.path });
    sessions.move(row.sessionId, created.path);
    return c.json({ ...await worktreeView(row.sessionId), branch: created.branch, base: created.base }, 201);
  });

  app.delete('/api/git/worktree', async (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ error: 'Name the thread whose worktree to remove' }, 400);
    const row = workspace.threadBySession(sessionId);
    if (!row) return c.json({ error: 'Unknown thread' }, 404);
    if (!row.worktree) return c.json({ error: 'This thread runs in the project checkout, not a worktree' }, 400);
    requireIdle(row.sessionId);
    const project = workspace.project(row.projectId);
    if (!project) return c.json({ error: 'The thread has no project to return to' }, 400);
    const branch = row.branch;
    await git.removeWorktree(project.path, row.worktree, c.req.query('force') === '1');
    let warning: string | undefined;
    if (c.req.query('branch') === '1' && branch) {
      await git.deleteBranch(project.path, branch, true).catch((error: unknown) => {
        warning = error instanceof Error ? error.message : `Could not delete ${branch}`;
      });
    }
    const base = await git.baseBranch(project.path).catch(() => undefined);
    workspace.setThreadCheckout(row.sessionId, { cwd: project.path, branch: base });
    sessions.move(row.sessionId, project.path);
    return c.json({ ...await worktreeView(row.sessionId), warning });
  });

  app.delete('/api/threads/:id', async (c) => {
    const row = workspace.thread(c.req.param('id'));
    if (!row) return c.json({ error: 'Unknown thread' }, 404);
    requireIdle(row.sessionId);
    if (row.worktree) {
      const project = workspace.project(row.projectId);
      if (project) await git.removeWorktree(project.path, row.worktree, c.req.query('force') === '1');
    }
    sessions.remove(row.sessionId);
    workspace.deleteThread(row.id);
    return c.json({ removed: true });
  });

  app.all('/api/*', (c) => c.json({ error: 'Unknown source route' }, 404));
  return app;
}
