import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentRuntime } from '@extendo/agent';
import type { Plugin, Project, Settings, Thread } from '@extendo/contracts';
import type { SessionStore } from '@extendo/session';

type StoredThread = Omit<Thread, 'status'>;

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
      CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `);
  }

  projects(): Project[] {
    return this.db.prepare('SELECT id, name, path FROM projects ORDER BY rowid').all() as unknown as Project[];
  }

  project(id: string): Project | undefined {
    return this.db.prepare('SELECT id, name, path FROM projects WHERE id = ?').get(id) as Project | undefined;
  }

  openProject(path: string, name?: string): Project {
    const directory = realpathSync(resolve(path));
    if (!statSync(directory).isDirectory()) throw new Error('The workspace path must be a directory');
    const id = randomUUID();
    this.db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, name || basename(directory) || directory, directory);
    const project = this.db.prepare('SELECT id, name, path FROM projects WHERE path = ?').get(directory) as Project | undefined;
    if (!project) throw new Error('Could not open the project');
    return project;
  }

  threads(agent: AgentRuntime, projectId?: string): Thread[] {
    const records = projectId
      ? this.db.prepare('SELECT * FROM threads WHERE projectId = ? ORDER BY rowid DESC').all(projectId)
      : this.db.prepare('SELECT * FROM threads ORDER BY rowid DESC').all();
    return (records as unknown as StoredThread[]).map((row) => ({ ...row, branch: row.branch ?? undefined, status: agent.status(row.sessionId) }));
  }

  threadBySession(agent: AgentRuntime, sessionId: string): Thread | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE sessionId = ?').get(sessionId) as unknown as StoredThread | undefined;
    return row && { ...row, branch: row.branch ?? undefined, status: agent.status(sessionId) };
  }

  createThread(sessions: SessionStore, project: Project, input: { title: string; provider: string; model: string; branch?: string }): Thread {
    const session = sessions.create({ title: input.title, cwd: project.path });
    const thread = { ...input, id: randomUUID(), projectId: project.id, sessionId: session.id, cwd: project.path, createdAt: session.createdAt };
    this.db.prepare('INSERT INTO threads (id, projectId, sessionId, title, cwd, provider, model, createdAt, branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(thread.id, thread.projectId, thread.sessionId, thread.title, thread.cwd, thread.provider, thread.model, thread.createdAt, thread.branch ?? null);
    return { ...thread, status: 'idle' };
  }

  updateThreadModel(sessionId: string, provider: string, model: string): void {
    this.db.prepare('UPDATE threads SET provider = ?, model = ? WHERE sessionId = ?').run(provider, model, sessionId);
  }

  settings(): Settings {
    const row = this.db.prepare("SELECT value FROM preferences WHERE key = 'settings'").get();
    return row ? JSON.parse(String(row.value)) as Settings : { provider: 'demo' };
  }

  saveSettings(settings: Settings): Settings {
    this.db.prepare("INSERT INTO preferences (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(settings));
    return settings;
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
