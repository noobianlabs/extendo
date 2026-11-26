import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Issue, IssueComment, IssueState, Plugin, Project, Settings, Thread, ThreadRole } from '@extendo/contracts';
import type { SessionStore } from '@extendo/session';

/** A stored thread as the console keeps it: the viewer adds the live state on top. */
export type ThreadRow = Omit<Thread, 'status' | 'state' | 'stateSince' | 'pullRequest' | 'subagents' | 'crew' | 'issues' | 'preview'>;

function row(record: unknown): ThreadRow | undefined {
  if (record === undefined) return undefined;
  const stored = record as ThreadRow & { archived?: number | boolean };
  return {
    ...stored,
    branch: stored.branch ?? undefined,
    base: stored.base ?? undefined,
    baseCommit: stored.baseCommit ?? undefined,
    worktree: stored.worktree ?? undefined,
    role: stored.role ?? 'standalone',
    captainId: stored.captainId ?? undefined,
    archived: Boolean(stored.archived),
    report: stored.report ?? undefined,
    reportAt: stored.reportAt ?? undefined,
  };
}

function issueRow(record: unknown): Issue {
  const stored = record as Issue & { number: number };
  return {
    ...stored,
    number: Number(stored.number),
    body: stored.body ?? undefined,
    captainId: stored.captainId ?? undefined,
    assigneeId: stored.assigneeId ?? undefined,
    parentId: stored.parentId ?? undefined,
  };
}

export interface CreateThreadInput {
  title: string;
  provider: string;
  model: string;
  branch?: string;
  /** The branch this thread's branch was cut from, when it owns a worktree of its own. */
  base?: string;
  /** The commit that branch pointed at when this thread's branch was cut. */
  baseCommit?: string;
  role?: ThreadRole;
  captainId?: string;
}

export interface IssuePatch {
  title?: string;
  body?: string;
  state?: IssueState;
  assigneeId?: string | null;
  parentId?: string | null;
}

export class WorkspaceState {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'workspace.sqlite'));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
        sessionId TEXT NOT NULL UNIQUE, title TEXT NOT NULL, cwd TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, createdAt TEXT NOT NULL, branch TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY, number INTEGER NOT NULL, projectId TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT, state TEXT NOT NULL, captainId TEXT, assigneeId TEXT,
        parentId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS issue_comments (
        id TEXT PRIMARY KEY, issueId TEXT NOT NULL, author TEXT NOT NULL,
        body TEXT NOT NULL, createdAt TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS issues_by_project ON issues (projectId, number);
      CREATE INDEX IF NOT EXISTS issue_comments_by_issue ON issue_comments (issueId, createdAt);
      CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `);
    const names = new Set((this.db.prepare('PRAGMA table_info(threads)').all() as { name: string }[]).map(({ name }) => name));
    for (const [name, definition] of [
      ['worktree', 'TEXT'],
      ['role', "TEXT NOT NULL DEFAULT 'standalone'"],
      ['captainId', 'TEXT'],
      ['archived', 'INTEGER NOT NULL DEFAULT 0'],
      ['report', 'TEXT'],
      ['reportAt', 'TEXT'],
      ['base', 'TEXT'],
      ['baseCommit', 'TEXT'],
    ] as const) {
      if (!names.has(name)) this.db.exec(`ALTER TABLE threads ADD COLUMN ${name} ${definition}`);
    }
  }

  projects(): Project[] {
    return this.db.prepare('SELECT id, name, path FROM projects ORDER BY rowid').all() as unknown as Project[];
  }

  project(id: string): Project | undefined {
    return this.db.prepare('SELECT id, name, path FROM projects WHERE id = ?').get(id) as Project | undefined;
  }

  openProject(path: string, name?: string): Project {
    const directory = realpathSync(resolve(path));
    if (!statSync(directory).isDirectory()) throw new Error('That path is not a directory');
    const id = randomUUID();
    this.db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, name ?? basename(directory), directory);
    const project = this.db.prepare('SELECT id, name, path FROM projects WHERE path = ?').get(directory) as Project | undefined;
    if (!project) throw new Error('The project could not be opened');
    return project;
  }

  threads(projectId?: string): ThreadRow[] {
    const records = projectId
      ? this.db.prepare('SELECT * FROM threads WHERE projectId = ? ORDER BY rowid').all(projectId)
      : this.db.prepare('SELECT * FROM threads ORDER BY rowid').all();
    return (records as unknown[]).flatMap((record) => row(record) ?? []);
  }

  thread(id: string): ThreadRow | undefined {
    return row(this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id));
  }

  threadBySession(sessionId: string): ThreadRow | undefined {
    return row(this.db.prepare('SELECT * FROM threads WHERE sessionId = ?').get(sessionId));
  }

  workersOf(captainId: string): ThreadRow[] {
    return (this.db.prepare('SELECT * FROM threads WHERE captainId = ? ORDER BY rowid').all(captainId) as unknown[])
      .flatMap((record) => row(record) ?? []);
  }

  createThread(sessions: SessionStore, project: Project, input: CreateThreadInput): ThreadRow {
    const session = sessions.create({ title: input.title, cwd: project.path });
    const thread: ThreadRow = {
      ...input,
      id: randomUUID(),
      projectId: project.id,
      sessionId: session.id,
      cwd: project.path,
      createdAt: session.createdAt,
      role: input.role ?? 'standalone',
      archived: false,
    };
    this.db.prepare(
      'INSERT INTO threads (id, projectId, sessionId, title, cwd, provider, model, createdAt, branch, role, captainId, archived, base, baseCommit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      thread.id, thread.projectId, thread.sessionId, thread.title, thread.cwd, thread.provider, thread.model,
      thread.createdAt, thread.branch ?? null, thread.role ?? 'standalone', thread.captainId ?? null, 0,
      thread.base ?? null, thread.baseCommit ?? null,
    );
    return thread;
  }

  /** Moves a thread to another checkout: its own worktree, or back to the shared checkout. */
  setThreadCheckout(sessionId: string, checkout: { cwd: string; branch?: string; worktree?: string; base?: string; baseCommit?: string }): void {
    this.db.prepare('UPDATE threads SET cwd = ?, branch = ?, worktree = ?, base = COALESCE(?, base), baseCommit = COALESCE(?, baseCommit) WHERE sessionId = ?')
      .run(checkout.cwd, checkout.branch ?? null, checkout.worktree ?? null, checkout.base ?? null, checkout.baseCommit ?? null, sessionId);
  }

  setThreadReport(sessionId: string, report: string | undefined, at: string): void {
    this.db.prepare('UPDATE threads SET report = ?, reportAt = ? WHERE sessionId = ?').run(report ?? null, at, sessionId);
  }

  setThreadArchived(id: string, archived: boolean): void {
    this.db.prepare('UPDATE threads SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  }

  updateThreadModel(sessionId: string, provider: string, model: string): void {
    this.db.prepare('UPDATE threads SET provider = ?, model = ? WHERE sessionId = ?').run(provider, model, sessionId);
  }

  deleteThread(id: string): void {
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id);
  }

  settings(): Settings {
    const stored = this.db.prepare("SELECT value FROM preferences WHERE key = 'settings'").get();
    if (!stored) return { provider: 'demo' };
    return JSON.parse(String((stored as { value: string }).value)) as Settings;
  }

  saveSettings(settings: Settings): Settings {
    this.db.prepare("INSERT INTO preferences (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(settings));
    return settings;
  }

  issues(filter: { projectId?: string; captainId?: string; assigneeId?: string; parentId?: string } = {}): Issue[] {
    const clauses: string[] = [];
    const values: string[] = [];
    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined) continue;
      clauses.push(`${key} = ?`);
      values.push(value);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT * FROM issues${where} ORDER BY number DESC`).all(...values) as unknown[]).map(issueRow);
  }

  issue(id: string): Issue | undefined {
    const record = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
    return record === undefined ? undefined : issueRow(record);
  }

  createIssue(project: Project, input: { title: string; body?: string; state?: IssueState; captainId?: string; assigneeId?: string; parentId?: string }): Issue {
    const next = this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS number FROM issues WHERE projectId = ?').get(project.id) as { number: number };
    const issue: Issue = {
      id: randomUUID(),
      number: Number(next.number),
      projectId: project.id,
      title: input.title,
      body: input.body,
      state: input.state ?? 'open',
      captainId: input.captainId,
      assigneeId: input.assigneeId,
      parentId: input.parentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.db.prepare(
      'INSERT INTO issues (id, number, projectId, title, body, state, captainId, assigneeId, parentId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      issue.id, issue.number, issue.projectId, issue.title, issue.body ?? null, issue.state,
      issue.captainId ?? null, issue.assigneeId ?? null, issue.parentId ?? null, issue.createdAt, issue.updatedAt,
    );
    return issue;
  }

  updateIssue(id: string, patch: IssuePatch): Issue | undefined {
    const current = this.issue(id);
    if (!current) return undefined;
    const next: Issue = {
      ...current,
      title: patch.title ?? current.title,
      body: patch.body ?? current.body,
      state: patch.state ?? current.state,
      assigneeId: patch.assigneeId === null ? undefined : patch.assigneeId ?? current.assigneeId,
      parentId: patch.parentId === null ? undefined : patch.parentId ?? current.parentId,
      updatedAt: new Date().toISOString(),
    };
    this.db.prepare('UPDATE issues SET title = ?, body = ?, state = ?, assigneeId = ?, parentId = ?, updatedAt = ? WHERE id = ?')
      .run(next.title, next.body ?? null, next.state, next.assigneeId ?? null, next.parentId ?? null, next.updatedAt, id);
    return next;
  }

  addIssueComment(issueId: string, author: string, body: string): IssueComment {
    const comment: IssueComment = { id: randomUUID(), issueId, author, body, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO issue_comments (id, issueId, author, body, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run(comment.id, comment.issueId, comment.author, comment.body, comment.createdAt);
    return comment;
  }

  issueComments(issueId: string): IssueComment[] {
    return this.db.prepare('SELECT * FROM issue_comments WHERE issueId = ? ORDER BY createdAt, rowid').all(issueId) as unknown as IssueComment[];
  }

  close(): void {
    this.db.close();
  }
}

export function statePlugin(dataDir: string): Plugin {
  return { name: 'workspace-state', apply(ctx) {
    const state = new WorkspaceState(dataDir);
    ctx.effect(() => () => state.close());
    ctx.provide('workspace', state);
  } };
}
