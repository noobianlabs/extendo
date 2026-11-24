import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { createHttpApp, type HttpOptions } from './http.js';
import { resolveOriginPolicy } from './origin.js';
import { createRuntime, type Runtime, type RuntimeOptions } from './runtime.js';
import { attachRpc } from './ws.js';

export * from './runtime.js';
export { createHttpApp } from './http.js';
export * from './origin.js';

export interface ServerOptions extends RuntimeOptions, HttpOptions {
  port?: number;
}

export interface ExtendoServer {
  url: string;
  runtime: Runtime;
  close(): Promise<void>;
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export async function startServer(options: ServerOptions = {}): Promise<ExtendoServer> {
  const runtime = await createRuntime({ ...options, mode: 'web' });
  const candidates = [resolve('apps/web/dist'), fileURLToPath(new URL('../../web/dist', import.meta.url))];
  const webRoot = options.webRoot ?? candidates.find((candidate) => existsSync(resolve(candidate, 'index.html')));
  const policy = resolveOriginPolicy(options);
  const server = createServer(getRequestListener(createHttpApp(runtime, { ...options, webRoot, origin: policy }).fetch));
  let closeRpc: (() => Promise<void>) | undefined;
  try {
    closeRpc = attachRpc(server, runtime, policy);
    await listen(server, options.port ?? 4310);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not determine the HTTP listener port');
    let closing: Promise<void> | undefined;
    return {
      url: `http://127.0.0.1:${address.port}`,
      runtime,
      close() {
        closing ??= (async () => {
          await closeRpc?.();
          await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
          await runtime.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    if (server.listening) server.close();
    await closeRpc?.();
    await runtime.close();
    throw error;
  }
}
