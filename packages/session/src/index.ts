import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Ctx, Plugin, Session, SessionEvent, SessionEventInput, SessionSnapshot, ToolCall } from '@extendo/contracts';
export { projectMessages, projectModelMessages } from './projection.js';
import { projectMessages } from './projection.js';

function decode(row: Record<string, unknown>): SessionEvent {
  return { seq: row.seq, ts: row.ts, type: row.type, data: JSON.parse(String(row.data)) } as SessionEvent;
}

export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly mirrorDir: string;
  private readonly mirrors = new Map<string, { seq: number; size: number }>();

  constructor(dataDir: string, private readonly ctx?: Ctx) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.mirrorDir = join(dataDir, 'sessions');
    mkdirSync(this.mirrorDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'sessions.sqlite'));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL, createdAt TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        sessionId TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL, ts TEXT NOT NULL,
        type TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (sessionId, seq)
      ) STRICT;
    `);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  create(input: Pick<Session, 'title' | 'cwd'>): Session {
    const session = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    const events = this.transaction(() => {
      this.db.prepare('INSERT INTO sessions (id, title, cwd, createdAt) VALUES (?, ?, ?, ?)').run(session.id, session.title, session.cwd, session.createdAt);
      return this.insert(session.id, [{ type: 'session/created', data: session }], session.createdAt);
    });
    this.publish(session.id, events);
    this.ctx?.emit('session/created', session);
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.db.prepare('SELECT id, title, cwd, createdAt FROM sessions WHERE id = ?').get(sessionId) as Session | undefined;
  }

  /** Points a session at a different checkout, for a thread that moved into its own worktree. */
  move(sessionId: string, cwd: string): void {
    const result = this.db.prepare('UPDATE sessions SET cwd = ? WHERE id = ?').run(cwd, sessionId);
    if (Number(result.changes) === 0) throw new Error(`Unknown session: ${sessionId}`);
  }

  /** Deletes a session's log and its mirror. Nothing else in the store refers to it. */
  remove(sessionId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE sessionId = ?').run(sessionId);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    });
    this.mirrors.delete(sessionId);
    rmSync(this.mirrorPath(sessionId), { force: true });
  }

  list(): Session[] {
    return this.db.prepare('SELECT id, title, cwd, createdAt FROM sessions ORDER BY createdAt DESC, rowid DESC').all() as unknown as Session[];
  }

  private insert(sessionId: string, inputs: readonly SessionEventInput[], ts = new Date().toISOString()): SessionEvent[] {
    let seq = this.lastSeq(sessionId);
    const stmt = this.db.prepare('INSERT INTO events (sessionId, seq, ts, type, data) VALUES (?, ?, ?, ?, ?)');
    return inputs.map((input) => {
      const json = JSON.stringify(input.data);
      stmt.run(sessionId, ++seq, ts, input.type, json);
      return { ...input, data: JSON.parse(json), seq, ts } as SessionEvent;
    });
  }

  append(sessionId: string, input: SessionEventInput): SessionEvent {
    return this.appendMany(sessionId, [input])[0]!;
  }

  appendMany(sessionId: string, inputs: readonly SessionEventInput[]): SessionEvent[] {
    if (inputs.some(({ type }) => type === 'session/created')) throw new Error('Use create() to create a session');
    const events = this.transaction(() => this.insert(sessionId, inputs));
    if (events.length) this.publish(sessionId, events);
    return events;
  }

  private publish(sessionId: string, events: SessionEvent[]): void {
    try { this.syncMirror(sessionId); }
    catch (error) {
      this.mirrors.delete(sessionId);
      this.ctx?.logger.warn(`Could not update session mirror for ${sessionId}: ${String(error)}`);
    }
    for (const event of events) this.ctx?.emit('session/event', { sessionId, event });
  }

  syncMirror(sessionId: string): void {
    this.transaction(() => {
      const cursor = this.mirrors.get(sessionId);
      const path = this.mirrorPath(sessionId);
      const line = (event: SessionEvent) => JSON.stringify(event) + '\n';
      if (cursor && statSync(path, { throwIfNoEntry: false })?.size === cursor.size) {
        const events = this.replay(sessionId, cursor.seq);
        if (!events.length) return;
        const tail = events.map(line).join('');
        appendFileSync(path, tail, { mode: 0o600 });
        this.mirrors.set(sessionId, { seq: events.at(-1)!.seq, size: cursor.size + Buffer.byteLength(tail) });
        return;
      }

      const events = this.replay(sessionId);
      if (!events.length) throw new Error(`Unknown session: ${sessionId}`);
      const content = events.map(line).join('');
      let existing: string | undefined;
      try { existing = readFileSync(path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (existing !== content) {
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
          renameSync(temporary, path);
        } finally { rmSync(temporary, { force: true }); }
      }
      this.mirrors.set(sessionId, { seq: events.at(-1)!.seq, size: Buffer.byteLength(content) });
    });
  }

  mirrorPath(sessionId: string): string {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sessionId)) throw new Error('Invalid session ID');
    return join(this.mirrorDir, `${sessionId}.jsonl`);
  }

  replay(sessionId: string, afterSeq = 0): SessionEvent[] {
    return this.db.prepare('SELECT seq, ts, type, data FROM events WHERE sessionId = ? AND seq > ? ORDER BY seq').all(sessionId, afterSeq).map(decode);
  }

  lastSeq(sessionId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE sessionId = ?').get(sessionId);
    return Number(row?.seq ?? 0);
  }

  snapshot(sessionId: string): SessionSnapshot {
    const session = this.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    const events = this.replay(sessionId);
    return { session, messages: projectMessages(events), lastSeq: events.at(-1)?.seq ?? 0 };
  }

  resume(sessionId: string): SessionSnapshot {
    this.syncMirror(sessionId);
    const pending = this.transaction(() => {
      let turnId: string | undefined;
      let stepId: string | undefined;
      const calls = new Map<string, ToolCall>();
      for (const event of this.replay(sessionId)) {
        switch (event.type) {
          case 'turn/start': turnId = event.data.turnId; break;
          case 'step/start': stepId = event.data.stepId; calls.clear(); break;
          case 'tool/call': calls.set(event.data.call.id, event.data.call); break;
          case 'tool/result': calls.delete(event.data.result.callId); break;
          case 'step/end': stepId = undefined; break;
          case 'turn/end': turnId = undefined; break;
        }
      }
      if (!turnId) return [];
      const repair: SessionEventInput[] = [];
      if (stepId) {
        for (const call of calls.values()) {
          repair.push({ type: 'tool/result', data: { turnId, stepId, result: { callId: call.id, name: call.name, output: 'Execution interrupted; outcome unknown', isError: true } } });
        }
        repair.push({ type: 'step/end', data: { turnId, stepId, outcome: 'interrupted' } });
      }
      repair.push({ type: 'turn/end', data: { turnId, outcome: 'interrupted' } });
      return this.insert(sessionId, repair);
    });
    if (pending.length) this.publish(sessionId, pending);
    return this.snapshot(sessionId);
  }

  close(): void {
    this.db.close();
  }
}

export function sessionPlugin(dataDir: string): Plugin {
  return {
    name: 'session',
    apply(ctx) {
      const store = new SessionStore(dataDir, ctx);
      ctx.effect(() => () => store.close());
      ctx.provide('sessions', store);
    },
  };
}
