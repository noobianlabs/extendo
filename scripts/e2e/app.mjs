import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { GitService } from '../../packages/git/dist/index.js';
import { startServer } from '../../apps/server/dist/index.js';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const outDir = process.env.EXTENDO_E2E_OUT ?? join(root, 'artifacts');

/** Boots the real server on a throwaway home. `gh` can be pointed at a missing binary to test the honest path. */
export async function boot({ gh } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'extendo-e2e-'));
  const server = await startServer({
    dataDir, port: 0, env: {}, webRoot: join(root, 'apps/web/dist'),
    ...(gh ? { git: new GitService({ gh }) } : {}),
  });
  return {
    url: server.url,
    dataDir,
    server,
    async close() {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function session(browser, { width = 1440, height = 900, theme = 'dark', video } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    reducedMotion: 'no-preference',
    ...(video ? { recordVideo: { dir: video, size: { width, height } } } : {}),
  });
  await context.addInitScript((value) => {
    try { localStorage.setItem('extendo-theme', value); } catch {}
  }, theme);
  const page = await context.newPage();
  const problems = [];
  page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
  page.on('pageerror', (error) => problems.push(error.message));
  return { context, page, problems };
}

export async function shot(page, name) {
  const view = page.viewportSize() ?? { width: 1440, height: 900 };
  await page.mouse.move(Math.round(view.width * 0.45), Math.round(view.height * 0.6));
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, name + '.png');
  await page.screenshot({ path });
  return path;
}

export async function settle(page, ms = 240) {
  await page.waitForTimeout(ms);
}

export function launch() {
  return chromium.launch();
}
