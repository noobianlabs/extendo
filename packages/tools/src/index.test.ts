import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ctx, ToolCtx } from '@extendo/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { builtInTools } from './index.js';

const [read, write, edit, glob, grep, shell, fetch] = builtInTools;
let cwd: string;
let ctx: ToolCtx;
const calls: string[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'extendo-tools-'));
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src', 'notes.md'), 'Hello\nSuites are ready.\n');
  await writeFile(join(cwd, '.env'), 'PRIVATE_VALUE=fixture');
  calls.length = 0;
  ctx = {
    cwd, sessionId: 'test', turnId: 't', stepId: 's', signal: new AbortController().signal,
    ctx: { async serial(key: string) { calls.push(key); } } as unknown as Ctx,
  };
});

afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe('local workspace tools', () => {
  it('reads UTF-8 and rejects credentials, symlinks, and paths outside the workspace', async () => {
    await symlink(join(cwd, '.env'), join(cwd, 'alias'));
    expect(await read.execute({ path: 'src/notes.md' }, ctx)).toMatchObject({ content: 'Hello\nSuites are ready.\n', truncated: false });
    expect(calls).toEqual(['fs/read']);
    await expect(read.execute({ path: '.env' }, ctx)).rejects.toThrow('allowed workspace');
    await expect(read.execute({ path: 'alias' }, ctx)).rejects.toThrow('Symbolic links');
    await expect(read.execute({ path: '../outside' }, ctx)).rejects.toThrow('allowed workspace');
  });

  it('writes a new text file and replaces a longer file without residue', async () => {
    expect(write.needsApproval).toBe(true);
    expect(await write.execute({ path: 'src/new.txt', content: 'New\n' }, ctx)).toMatchObject({ additions: 1, deletions: 0 });
    const diff = await write.execute({ path: 'src/notes.md', content: 'Hi' }, ctx);
    expect(diff).toMatchObject({ before: 'Hello\nSuites are ready.\n', after: 'Hi', additions: 1, deletions: 2 });
    expect(await readFile(join(cwd, 'src', 'notes.md'), 'utf8')).toBe('Hi');
    expect(calls).toEqual(['fs/write', 'fs/write']);
  });

  it('edits only one exact match and rejects ambiguous and absent strings', async () => {
    expect(edit.needsApproval).toBe(true);
    expect(await edit.execute({ path: 'src/notes.md', oldString: 'Hello', newString: 'Welcome' }, ctx))
      .toMatchObject({ after: 'Welcome\nSuites are ready.\n', additions: 1, deletions: 1 });
    await expect(edit.execute({ path: 'src/notes.md', oldString: 'e', newString: 'E' }, ctx)).rejects.toThrow('appears more than once');
    await expect(edit.execute({ path: 'src/notes.md', oldString: 'hello', newString: 'Bye' }, ctx)).rejects.toThrow('was not found');
  });

  it('globs relative paths without exposing dependency and credential entries', async () => {
    await mkdir(join(cwd, 'node_modules'));
    await writeFile(join(cwd, 'node_modules', 'private.md'), 'hidden');
    expect(await glob.execute({ pattern: '**/*.md' }, ctx)).toEqual({ paths: ['src/notes.md'], truncated: false });
    expect(await glob.execute({ pattern: '.env' }, ctx)).toEqual({ paths: [], truncated: false });
  });

  it('greps matching lines with stable line numbers and optional case folding', async () => {
    expect(await grep.execute({ pattern: 'src/**/*.md', query: 'suites', ignoreCase: true }, ctx)).toEqual({
      matches: [{ path: 'src/notes.md', line: 2, text: 'Suites are ready.' }], truncated: false,
    });
  });

  it('runs an approved shell capability in the workspace and bounds its time and output', async () => {
    expect(shell.needsApproval).toBe(true);
    expect(await shell.execute({ command: 'node -e "console.log(process.cwd())"', cwd: 'src' }, ctx))
      .toMatchObject({ stdout: join(cwd, 'src') + '\n', exitCode: 0, truncated: false, timedOut: false });
    const big = await shell.execute({ command: 'node -e "process.stdout.write(\'x\'.repeat(80000))"' }, ctx);
    expect(big.stdout.length).toBe(65_536);
    expect(big.truncated).toBe(true);
    const timed = await shell.execute({ command: 'node -e "setTimeout(()=>{}, 5000)"', timeoutMs: 70 }, ctx);
    expect(timed).toMatchObject({ timedOut: true, exitCode: null });
  });

  it('requires web-fetch approval and rejects local or credential-bearing addresses before connecting', async () => {
    expect(fetch.needsApproval).toBe(true);
    for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/']) {
      await expect(fetch.execute({ url }, ctx)).rejects.toThrow('only accepts public IP');
    }
    await expect(fetch.execute({ url: 'https://fixture@example.test/' }, ctx)).rejects.toThrow('without credentials');
    await expect(fetch.execute({ url: 'https://example.test:5243/' }, ctx)).rejects.toThrow('custom port');
  });
});
