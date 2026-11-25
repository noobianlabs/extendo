/**
 * Records the v0.4 demo videos: the same real server and real demo repository the test harness uses,
 * driven at a human pace with a cursor dot and a one-line caption, so a viewer can follow what the
 * product did rather than watch a page re-render. Each video boots its own server, so each starts from
 * the pristine seeded repository.
 *
 *   node scripts/e2e/git-demo.mjs [name…]
 *
 * Output: artifacts/videos/<name>.mp4 (H.264, yuv420p) and the raw .webm beside it.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { boot, root } from './app.mjs';

const execFileAsync = promisify(execFile);
const outDir = process.env.EXTENDO_DEMO_OUT ?? join(root, 'artifacts', 'videos');

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** A cursor and a caption, drawn over the app so a recording has a pointer and a reason. */
function installOverlay() {
  const style = document.createElement('style');
  style.textContent = `
    #demo-cursor { position: fixed; inset-block-start: 0; inset-inline-start: 0; z-index: 2147483000;
      inline-size: 13px; block-size: 13px; margin: -6.5px 0 0 -6.5px; border-radius: 50%;
      padding: 0; border: 0; background: #fff; box-shadow: 0 0 0 1.5px rgba(0,0,0,.72), 0 2px 10px rgba(0,0,0,.45);
      pointer-events: none; transition: transform 90ms ease-out; overflow: visible; }
    #demo-cursor[data-press="true"] { transform: scale(.62); }
    #demo-caption { position: fixed; inset: auto 0 22px 0; z-index: 2147483000; margin: 0 auto; padding: 0;
      border: 0; background: transparent; inline-size: fit-content; max-inline-size: 78%;
      display: flex; justify-content: center; pointer-events: none; opacity: 0;
      transition: opacity 220ms ease; }
    #demo-caption[data-open="true"] { opacity: 1; }
    #demo-caption span { display: inline-flex; align-items: center; gap: 9px; max-inline-size: 78%;
      padding: 8px 13px; border-radius: 7px; background: rgba(10,10,11,.93); color: #ededec;
      font: 450 13px/19px Inter, system-ui, sans-serif; letter-spacing: -.008em; text-wrap: pretty;
      box-shadow: 0 0 0 1px rgba(255,250,245,.14), 0 12px 32px rgba(0,0,0,.35); }
    #demo-caption b { flex: none; color: #ee9a3c; font: 560 10px/1 "Geist Mono", ui-monospace, monospace;
      letter-spacing: .08em; text-transform: uppercase; }
  `;
  const cursor = document.createElement('div');
  cursor.id = 'demo-cursor';
  cursor.setAttribute('aria-hidden', 'true');
  cursor.setAttribute('popover', 'manual');
  const caption = document.createElement('div');
  caption.id = 'demo-caption';
  caption.setAttribute('aria-hidden', 'true');
  caption.setAttribute('popover', 'manual');
  const text = document.createElement('span');
  caption.append(text);
  // A native <dialog> paints in the top layer, above any z-index; a popover is the only way to keep the
  // caption and the pointer visible over a confirmation, which is exactly when a viewer needs them.
  const raise = () => {
    for (const element of [cursor, caption]) {
      // Re-showing puts the element last in the top layer, which is the only way to sit above a
      // modal <dialog> that opened after it.
      if (element.matches(':popover-open')) element.hidePopover();
      element.showPopover?.();
    }
  };
  window.__demoRaise = raise;
  const mount = () => {
    document.documentElement.append(style, cursor, caption);
    raise();
  };
  if (document.documentElement) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
  window.__demoSay = (line) => {
    text.innerHTML = '<b>demo</b>';
    text.append(document.createTextNode(line));
    caption.dataset.open = 'true';
    raise();
  };
  window.addEventListener('mousemove', (event) => {
    cursor.style.translate = `${event.clientX}px ${event.clientY}px`;
  }, { passive: true });
  window.addEventListener('mousedown', () => { cursor.dataset.press = 'true'; });
  window.addEventListener('mouseup', () => { cursor.dataset.press = 'false'; });
}

async function say(page, line) {
  await page.evaluate((value) => window.__demoSay(value), line);
  await pause(380);
}

async function glide(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Nothing to point at');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 22 });
  await pause(240);
  return box;
}

async function press(page, locator) {
  await glide(page, locator);
  await page.mouse.down();
  await pause(90);
  await page.mouse.up();
  await pause(360);
}

async function openChanges(page, { mobile = false } = {}) {
  if (mobile) {
    await press(page, page.getByLabel('Show workspace panel'));
    await pause(360);
  }
  await press(page, page.getByRole('tab', { name: 'Changes' }));
  await page.getByLabel('Commit message').waitFor();
  await pause(620);
}

const surface = (page) => page.locator('[data-testid="source-surface"]');
const row = (page, path) => page.locator(`[data-testid="change-row"][data-path="${path}"]`);

/** The working tree: what changed, the diff, then a real commit and push. */
async function sourceSurface(page) {
  await say(page, 'The Changes panel is the working tree of the checkout this thread is in.');
  await openChanges(page);
  await say(page, 'Branch, its upstream, and how far ahead of origin it is.');
  await glide(page, surface(page).locator('header').first());
  await pause(900);

  await press(page, row(page, 'apps/web/src/search/EmptyState.tsx').locator('button[aria-expanded]'));
  await page.locator('[data-testid="source-surface"] .cm-editor').waitFor();
  await say(page, 'Click a file and the diff is the real one, from the index and the working tree.');
  await pause(1_400);

  await press(page, row(page, 'apps/web/src/search/EmptyState.tsx').locator('button[aria-expanded]'));
  await say(page, 'One control per row stages or unstages it. No confirmation, nothing destructive.');
  await press(page, row(page, 'apps/web/src/search/EmptyState.test.tsx').locator('button[aria-label^="Stage "]'));
  await pause(500);

  await press(page, page.getByLabel('Commit message'));
  await page.keyboard.type('Cover the empty state with a test', { delay: 38 });
  await pause(300);
  await say(page, 'Commit writes a real commit. The SHA and the subject come back from git.');
  await press(page, page.getByRole('button', { name: 'Commit', exact: true }));
  await page.locator('[data-testid="source-report"]').waitFor();
  await pause(1_200);

  await say(page, 'Push sends it to origin; ahead and behind fall back to zero because they were re-read.');
  await press(page, page.getByRole('button', { name: /^Push/ }));
  await page.waitForFunction(() => document.querySelector('[aria-label="0 ahead, 0 behind"]') !== null);
  await pause(1_600);
  await say(page, 'Everything on this panel came from a status read of the repository — nothing is inferred.');
  await pause(1_700);
}

/** Worktrees: a thread gets its own checkout and then gives it back. */
async function worktrees(page) {
  await say(page, 'Threads share a checkout by default. This one can stop doing that.');
  await press(page, page.getByRole('button', { name: /^Trace the keyboard shortcut/ }));
  await pause(620);
  await openChanges(page);
  await glide(page, page.locator('[data-testid="checkout-kind"]'));
  await pause(900);

  await press(page, page.getByRole('button', { name: 'Own worktree' }));
  await page.locator('[data-testid="checkout-kind"][data-kind="worktree"]').waitFor({ timeout: 20_000 });
  await say(page, 'Its own worktree, on its own branch, cut from main — so two threads never edit one tree.');
  await pause(1_800);
  await glide(page, surface(page).locator('header').first());
  await pause(1_000);

  await say(page, 'Removing it puts the thread back in the shared checkout; the branch stays behind.');
  await press(page, page.getByRole('button', { name: 'Remove', exact: true }));
  await page.locator('[data-testid="checkout-kind"][data-kind="shared"]').waitFor({ timeout: 20_000 });
  await pause(1_500);
}

/** The rails: a secret path, and a confirmation that names what it destroys. */
async function rails(page) {
  await say(page, 'The rails. A .env file never gets staged by accident.');
  await openChanges(page);
  await glide(page, row(page, '.env.local'));
  await pause(900);
  await press(page, row(page, '.env.local').locator('button[aria-label="Stage .env.local anyway"]'));
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await pause(500);
  await say(page, 'It says what the file is and why it is refused, and the only way past is this confirmation.');
  await pause(1_800);
  await press(page, dialog.getByRole('button', { name: 'Cancel' }));
  await pause(500);

  await say(page, 'Destructive actions name what they destroy — here, the uncommitted files and the branch.');
  await press(page, page.getByRole('button', { name: 'Delete thread' }));
  const deletion = page.getByRole('dialog');
  await deletion.waitFor();
  await pause(2_000);
  await press(page, deletion.getByRole('button', { name: 'Cancel' }));
  await pause(700);
}

/** The same surface on a phone: the rail becomes a sheet. */
async function phone(page) {
  await say(page, 'The same surface at 390 pixels, where the panel becomes a sheet.');
  await openChanges(page, { mobile: true });
  await pause(800);
  await press(page, row(page, 'apps/web/src/search/EmptyState.tsx').locator('button[aria-expanded]'));
  await page.locator('[data-testid="source-surface"] .cm-editor').waitFor();
  await pause(2_000);
  await say(page, 'Same groups, same diff, same commit box — no second design for small screens.');
  await pause(1_600);
}

const videos = [
  { name: '01-source-surface', width: 1440, height: 900, run: sourceSurface },
  { name: '02-worktrees', width: 1440, height: 900, run: worktrees },
  { name: '03-safety-rails', width: 1440, height: 900, run: rails },
  { name: '04-phone', width: 390, height: 844, run: phone },
];

async function record(browser, entry) {
  const app = await boot();
  const scratch = join(outDir, `.raw-${entry.name}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: entry.width, height: entry.height },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
    recordVideo: { dir: scratch, size: { width: entry.width, height: entry.height } },
  });
  await context.addInitScript(installOverlay);
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  const started = Date.now();
  try {
    await page.goto(app.url, { waitUntil: 'networkidle' });
    await pause(900);
    await entry.run(page);
    await pause(600);
  } finally {
    const video = page.video();
    await context.close();
    await app.close();
    const webm = await video.path();
    const target = join(outDir, `${entry.name}.webm`);
    renameSync(webm, target);
    rmSync(scratch, { recursive: true, force: true });
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', target,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow',
      '-movflags', '+faststart', join(outDir, `${entry.name}.mp4`),
    ]);
    const size = statSync(join(outDir, `${entry.name}.mp4`)).size;
    console.log(`  ${entry.name}: ${((Date.now() - started) / 1000).toFixed(1)}s recorded, ${(size / 1_048_576).toFixed(2)} MB` + (problems.length ? ` · page errors: ${problems.join(' | ')}` : ''));
    if (problems.length) throw new Error(`${entry.name} hit a page error: ${problems[0]}`);
  }
}

async function main() {
  const wanted = process.argv.slice(2);
  const chosen = wanted.length ? videos.filter((video) => wanted.includes(video.name)) : videos;
  if (!chosen.length) throw new Error(`Unknown video. Choose from: ${videos.map((video) => video.name).join(', ')}`);
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const entry of chosen) {
      console.log(`recording ${entry.name} at ${entry.width}×${entry.height}`);
      await record(browser, entry);
    }
  } finally {
    await browser.close();
  }
  console.log('\nvideos in ' + resolve(outDir) + ': ' + readdirSync(outDir).filter((file) => file.endsWith('.mp4')).sort().join(', '));
}

await main();
