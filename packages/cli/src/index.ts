#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { composeProfile, dumpConfig } from '@extendo/kernel';
import { createRuntime, defaultDataDir, startServer, type RuntimeMode } from '@extendo/server';
import { addPlugin, extensionCatalog, loadProfile } from './profile.js';

const usage = `Usage:
  extendo web [--port 4310] [--no-open]
  extendo headless "task" [--provider demo] [--model name] [--cwd path]
  extendo sdk
  extendo plugin add <package>
  extendo --dump-config [--profile web|headless|sdk] [--patch file]`;

function openBrowser(url: string) {
  const [command, ...args] = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url];
  const child = spawn(command!, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

async function runSdk() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let reply: unknown;
    try {
      const request = JSON.parse(line);
      if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        reply = { id: null, error: { code: -32600, message: 'Invalid request' } };
      } else if (!('id' in request)) continue;
      else if (request.method === 'health') reply = { id: request.id, result: { ok: true, version: '0.1.0' } };
      else reply = { id: request.id, error: { code: -32601, message: 'Method not implemented in v0.1' } };
    } catch {
      reply = { id: null, error: { code: -32700, message: 'Parse error' } };
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', ...reply as object }));
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      'dump-config': { type: 'boolean' },
      'no-open': { type: 'boolean' },
      port: { type: 'string' },
      cwd: { type: 'string' },
      profile: { type: 'string' },
      patch: { type: 'string', multiple: true },
      provider: { type: 'string' },
      model: { type: 'string' },
    },
  });
  if (values.help) { console.log(usage); return; }
  if (values.version) { console.log('0.1.0'); return; }
  const [command, ...args] = positionals;
  const dataDir = defaultDataDir();
  if (command === 'plugin' && args.length === 2 && args[0] === 'add' && args[1]) {
    await addPlugin(dataDir, args[1]);
    console.log(`Installed ${args[1]}. Trusted plugin code will run on the next launch.`);
    return;
  }
  const mode = values.profile ?? command ?? 'web';
  if (mode !== 'web' && mode !== 'headless' && mode !== 'sdk') throw new Error(usage);
  const profile = loadProfile(mode as RuntimeMode, dataDir, values.patch ?? []);
  if (values['dump-config']) {
    console.log(dumpConfig(profile));
    return;
  }
  if (mode === 'sdk') { await runSdk(); return; }
  const plugins = await extensionCatalog(dataDir, composeProfile(profile).filter(({ enabled }) => enabled !== false).map(({ plugin }) => plugin));
  const cwd = realpathSync(values.cwd ?? process.cwd());
  if (mode === 'web') {
    if (args.length) throw new Error(usage);
    const port = Number(values.port ?? process.env.EXTENDO_PORT ?? 4310);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid port');
    const server = await startServer({ port, dataDir, cwd, plugins, profile });
    console.log(`Extendo is listening at ${server.url}`);
    if (!values['no-open'] && process.env.EXTENDO_NO_OPEN !== '1') openBrowser(server.url);
    const shutdown = () => {
      void server.close().catch(() => { process.exitCode = 1; });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }
  if (!args.length || !args.join(' ').trim()) throw new Error('Pass a task to extendo headless');
  const runtime = await createRuntime({ mode, dataDir, plugins, profile });
  try {
    const defaults = runtime.workspace.settings();
    const provider = values.provider ?? defaults.provider;
    const selection = runtime.model(provider, values.model ?? (provider === defaults.provider ? defaults.model : undefined));
    const task = args.join(' ');
    const { id } = runtime.sessions.create({ cwd, title: task.slice(0, 120) });
    const cancel = () => { runtime.agent.cancel(id); };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const result = await runtime.agent.start(id, task, selection).done;
      if (result.outcome !== 'completed') throw new Error(result.error);
      console.log(result.final);
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  } finally {
    await runtime.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
