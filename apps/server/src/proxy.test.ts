import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@extendo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type ExtendoServer } from './index.js';

const proxiedOrigin = 'https://4320-abc.capysandbox.net';
const proxiedHost = '4320-abc.capysandbox.net';

let directory: string | undefined;
let server: ExtendoServer | undefined;
let sockets: WebSocket[] = [];

async function start(options: { allowedOrigins?: string[]; trustProxy?: boolean; logger?: Logger } = {}) {
  directory = mkdtempSync(join(tmpdir(), 'extendo-proxy-'));
  const webRoot = join(directory, 'web');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><p>Extendo fixture</p>');
  server = await startServer({ dataDir: directory, port: 0, env: {}, webRoot, ...options });
  return server;
}

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets = [];
  await server?.close();
  server = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function get(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(server!.url + path, { headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(options: { origin?: string; headers?: Record<string, string> } = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(server!.url.replace('http', 'ws') + '/ws', options);
    sockets.push(socket);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
  });
}

describe('proxied HTTP requests', () => {
  it('accepts a configured public origin behind a rewritten Host', async () => {
    await start({ allowedOrigins: [proxiedOrigin] });
    const response = await get('/api/health', { host: 'localhost:4320', origin: proxiedOrigin });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  });

  it('still rejects an origin that is not configured', async () => {
    await start({ allowedOrigins: [proxiedOrigin] });
    expect((await get('/api/health', { host: 'localhost:4320', origin: 'https://evil.example' })).status).toBe(403);
  });

  it('logs the rejection reason at debug level', async () => {
    const lines: string[] = [];
    const logger: Logger = {
      debug: (message) => { lines.push(message); },
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    await start({ logger });
    expect((await get('/api/health', { host: 'localhost:4320', origin: 'https://evil.example' })).status).toBe(403);
    expect(lines.some((line) => line.includes('origin-not-allowed')
      && line.includes('host=localhost:4320')
      && line.includes('origin=https://evil.example')
      && line.includes('forwarded-host=(none)'))).toBe(true);
  });

  it('honors x-forwarded-host when trust-proxy is on', async () => {
    await start({ trustProxy: true });
    const response = await get('/api/health', {
      host: 'localhost:4320',
      origin: proxiedOrigin,
      'x-forwarded-host': proxiedHost,
      'x-forwarded-proto': 'https',
    });
    expect(response.status).toBe(200);
  });

  it('ignores x-forwarded-host when trust-proxy is off', async () => {
    await start();
    const response = await get('/api/health', {
      host: 'localhost:4320',
      origin: proxiedOrigin,
      'x-forwarded-host': proxiedHost,
      'x-forwarded-proto': 'https',
    });
    expect(response.status).toBe(403);
  });

  it('serves the SPA shell to a proxied request that carries no Origin', async () => {
    await start();
    const response = await get('/', { host: 'localhost:4320' });
    expect(response.status).toBe(200);
    expect(response.body).toContain('Extendo fixture');
  });
});

describe('proxied /ws upgrades', () => {
  it('accepts an upgrade from a configured origin', async () => {
    await start({ allowedOrigins: [proxiedOrigin] });
    await expect(connect({ origin: proxiedOrigin, headers: { host: 'localhost:4320' } })).resolves.toBeDefined();
  });

  it('rejects an upgrade from a foreign origin', async () => {
    await start();
    await expect(connect({ origin: 'https://evil.example', headers: { host: 'localhost:4320' } })).rejects.toThrow(/403/);
  });

  it('accepts a proxied upgrade when trust-proxy is on', async () => {
    await start({ trustProxy: true });
    await expect(connect({
      origin: proxiedOrigin,
      headers: { host: 'localhost:4320', 'x-forwarded-host': proxiedHost, 'x-forwarded-proto': 'https' },
    })).resolves.toBeDefined();
  });

  it('rejects the same proxied upgrade when trust-proxy is off', async () => {
    await start();
    await expect(connect({
      origin: proxiedOrigin,
      headers: { host: 'localhost:4320', 'x-forwarded-host': proxiedHost, 'x-forwarded-proto': 'https' },
    })).rejects.toThrow(/403/);
  });
});
