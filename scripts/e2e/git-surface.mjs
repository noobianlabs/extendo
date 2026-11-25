import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { boot, launch, outDir, settle, session, shot } from './app.mjs';

const execFileAsync = promisify(execFile);

function check(condition, message) {
  if (!condition) throw new Error('Assertion failed: ' + message);
  console.log('  ✓ ' + message);
}

async function git(cwd, args) {
  return (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout;
}

async function api(url, path) {
  const response = await fetch(url + '/api' + path);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

async function send(url, path, body, method = 'POST') {
  const response = await fetch(url + '/api' + path, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Layout invariants a screenshot would show but a headless run can prove. */
async function layout(page, label) {
  const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  check(overflow.width <= overflow.viewport + 1, `${label}: nothing overflows the viewport horizontally`);
  const clipped = await page.evaluate(() => Array.from(document.querySelectorAll('body *'))
    .filter((node) => {
      const style = getComputedStyle(node);
      return node.clientWidth > 0 && node.scrollWidth > node.clientWidth + 2 && style.overflowX === 'visible';
    })
    .map((node) => (node.className || node.tagName).toString().slice(0, 60)));
  check(clipped.length === 0, `${label}: no clipped text anywhere` + (clipped.length ? ': ' + clipped.join(', ') : ''));
  const outside = await page.evaluate(() => {
    const surface = document.querySelector('[data-testid="source-surface"]');
    if (!surface) return ['no surface'];
    const edge = surface.getBoundingClientRect().right;
    return Array.from(surface.querySelectorAll('[data-testid="change-row"]'))
      .filter((row) => row.getBoundingClientRect().right > edge + 1)
      .map((row) => row.getAttribute('data-path') ?? 'row');
  });
  check(outside.length === 0, `${label}: every change row stays inside the surface` + (outside.length ? ': ' + outside.join(', ') : ''));
}

/** The design doc's numeric rules, checked against what the browser actually computed. */
async function designRules(page, label) {
  const report = await page.evaluate(() => {
    const surface = document.querySelector('[data-testid="source-surface"]');
    const steps = [11, 12, 13, 15, 19, 26];
    const sizes = new Set();
    const small = [];
    for (const node of surface.querySelectorAll('*')) {
      if (!node.getClientRects().length || !node.textContent.trim()) continue;
      const size = Number.parseFloat(getComputedStyle(node).fontSize);
      sizes.add(size);
      if (!steps.includes(size)) small.push(`${node.className || node.tagName}:${size}`);
    }
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-fill').trim();
    const probe = document.createElement('div');
    probe.style.color = accent;
    document.body.append(probe);
    const accentRgb = getComputedStyle(probe).color;
    probe.remove();
    const filled = Array.from(surface.querySelectorAll('*'))
      .filter((node) => getComputedStyle(node).backgroundColor === accentRgb)
      .map((node) => (node.className || node.tagName).toString());
    // The 28px rule covers controls — toggles, icon buttons, actions, commit. A list row is a row,
    // and an inline text action ("Unstage all") is type, so neither is measured against it.
    const controls = Array.from(surface.querySelectorAll('button'))
      .filter((node) => /(toggle|icon|action|commitButton)/.test(String(node.className)) && !node.closest('.cm-editor'))
      .map((node) => ({ height: node.getBoundingClientRect().height, name: (node.innerText || node.getAttribute('aria-label') || '').slice(0, 20) }))
      .filter((entry) => entry.height > 0);
    const shortest = controls.reduce((worst, entry) => entry.height < worst.height ? entry : worst, { height: Infinity, name: 'none' });
    return {
      sizes: [...sizes], offScale: small, filled, minControl: shortest.height, shortest: shortest.name,
      emoji: /\p{Extended_Pictographic}/u.test(surface.innerText),
    };
  });
  check(report.offScale.length === 0, `${label}: every text size comes from the six-step scale` + (report.offScale.length ? ': ' + report.offScale.slice(0, 6).join(', ') : ''));
  check(report.filled.length === 0, `${label}: no solid accent fill in the surface` + (report.filled.length ? ': ' + report.filled.join(', ') : ''));
  check(report.minControl >= 28, `${label}: every control is at least a 28px target (${report.minControl}px, ${report.shortest})`);
  check(report.emoji === false, `${label}: no emoji in the source surface`);
  return report.sizes;
}

/**
 * A row has to be identifiable at the narrowest width: the file name never truncates (the directory
 * does), and the checkout row always carries the full path in its title. Screening a list of files
 * whose names all end in an ellipsis is the failure this asserts against.
 */
async function legibility(page, label) {
  const report = await page.evaluate(() => ({
    clipped: [...document.querySelectorAll('[data-testid="change-row"]')].flatMap((row) => {
      const name = row.querySelector('[class*="name"]');
      if (!name) return [{ path: row.getAttribute('data-path'), why: 'no name element' }];
      const clipped = name.scrollWidth > name.clientWidth + 1;
      return clipped ? [{ path: row.getAttribute('data-path'), shown: name.clientWidth, needs: name.scrollWidth }] : [];
    }),
    untitled: [...document.querySelectorAll('[data-testid="change-row"] [class*="path"]')]
      .filter((node) => !node.getAttribute('title')).length,
    checkout: (() => {
      const code = document.querySelector('[data-testid="checkout-path"]');
      return { text: code?.textContent?.trim() ?? '', title: code?.getAttribute('title') ?? '', width: code?.clientWidth ?? 0 };
    })(),
  }));
  // The demo's five paths all have short names, so none of them may clip; a pathological name that
  // cannot fit is allowed to clip, and is caught by the worst-case section instead.
  const demo = report.clipped.filter((entry) => entry.path && !/Ünïcödé|unbroken|with-a-very-long|keeps-going|spaces and/.test(entry.path));
  check(demo.length === 0, `${label}: every file name is readable` + (demo.length ? ': ' + JSON.stringify(demo) : ''));
  check(report.untitled === 0, `${label}: every path carries its full value in a title`);
  check(report.checkout.text.length >= 8, `${label}: the checkout row names its directory (${report.checkout.text})`);
  check(report.checkout.title.includes(report.checkout.text.replace(/…$/, '')),
    `${label}: the checkout path's title is the full path (${report.checkout.title})`);
}

const group = (page, name) => page.getByRole('region', { name: new RegExp(`^${name},`) });
const rows = (page, name) => group(page, name).locator('[data-testid="change-row"]');
const row = (page, path) => page.locator(`[data-testid="change-row"][data-path="${path}"]`);
const surface = (page) => page.locator('[data-testid="source-surface"]');

async function openChanges(page) {
  await page.getByRole('tab', { name: 'Changes' }).click();
  await surface(page).waitFor();
  await page.getByLabel('Commit message').waitFor();
  await settle(page, 420);
}

async function counts(page) {
  return {
    staged: await rows(page, 'Staged').count(),
    changes: await rows(page, 'Changes').count(),
    untracked: await rows(page, 'Untracked').count(),
  };
}

async function collapseDiffs(page) {
  const open = page.locator('[data-testid="change-row"] button[aria-expanded="true"]');
  while (await open.count()) await open.first().click();
}

async function runFlow(browser, app) {
  const threads = await api(app.url, '/threads');
  const active = threads.find((thread) => thread.title === 'Make empty search results useful');
  const worktree = active.worktree;
  const remote = join(app.dataDir, 'demo', 'northstar.git');
  const truth = await api(app.url, `/git/status?sessionId=${active.sessionId}`);
  check(Boolean(worktree), 'the demo thread runs in its own worktree');
  check(truth.status.branch === 'feat/empty-state-copy', 'the checkout is on the branch the thread claims');

  const { context, page, problems } = await session(browser, {});
  page.setDefaultTimeout(20_000);
  await page.goto(app.url, { waitUntil: 'networkidle' });
  await settle(page, 700);
  await openChanges(page);
  await page.locator('[data-testid="change-row"]').first().waitFor();

  console.log('the working tree, as git has it');
  check((await surface(page).innerText()).includes('feat/empty-state-copy'), 'the surface names the branch');
  check((await surface(page).innerText()).includes('origin/feat/empty-state-copy'), 'it names the upstream');
  check(await page.locator('[aria-label="1 ahead, 0 behind"]').count() === 1, 'ahead/behind matches the repository');
  check((await surface(page).innerText()).includes('WORKTREE'), 'it says the thread is in its own worktree');
  check((await surface(page).innerText()).includes('feat-empty-state-copy'), 'it names the worktree directory the thread is in');
  const grouped = await counts(page);
  check(grouped.staged === 1 && grouped.changes === 2 && grouped.untracked === 2,
    `files are grouped staged/changes/untracked: ${JSON.stringify(grouped)}`);
  const secret = await row(page, '.env.local').innerText();
  check(/secret/i.test(secret), 'the .env.local path is marked as refused before it is touched');
  check(await row(page, '.env.local').locator('button[aria-label="Stage .env.local anyway"]').count() === 1,
    'its stage control is the deliberate one, not the ordinary one');
  await layout(page, '1440');
  await designRules(page, '1440');
  await legibility(page, '1440');

  console.log('a real diff');
  await row(page, 'apps/web/src/search/EmptyState.tsx').locator('button[aria-expanded]').click();
  await page.locator('[data-testid="source-surface"] .cm-editor').waitFor();
  await settle(page, 700);
  check(await surface(page).locator('.cm-deletedChunk').count() >= 1, 'the CodeMirror diff shows what was removed');
  const diffText = await surface(page).innerText();
  check(diffText.includes('<a href="/search?filters=">Clear filters</a>'), 'the diff carries the staged file before the edit');
  check(diffText.includes('<button type="button"'), 'the diff carries the same file after the edit');
  await shot(page, '01-changes-1440-dark');

  console.log('the secret rail');
  await row(page, '.env.local').locator('button[aria-label="Stage .env.local anyway"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await settle(page, 300);
  const refusal = await dialog.innerText();
  check(refusal.includes('.env.local'), 'the confirmation names the file');
  check(/environment files/.test(refusal), 'it says why Extendo refuses it');
  await shot(page, '02-secret-guard-1440-dark');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await settle(page, 300);
  check((await counts(page)).untracked === 2, 'cancelling leaves the file exactly where it was');

  console.log('light theme, 1440×900');
  const light = await session(browser, { theme: 'light' });
  light.page.setDefaultTimeout(20_000);
  await light.page.goto(app.url, { waitUntil: 'networkidle' });
  await settle(light.page, 600);
  await openChanges(light.page);
  await row(light.page, 'apps/web/src/search/EmptyState.tsx').locator('button[aria-expanded]').click();
  await light.page.locator('[data-testid="source-surface"] .cm-editor').waitFor();
  await settle(light.page, 600);
  await layout(light.page, 'light 1440');
  await designRules(light.page, 'light 1440');
  await legibility(light.page, 'light 1440');
  await shot(light.page, '03-changes-1440-light');
  check(light.problems.length === 0, 'no console errors in the light theme: ' + (light.problems.join(' | ') || 'none'));
  await light.context.close();

  console.log('390×844');
  const phone = await session(browser, { width: 390, height: 844 });
  phone.page.setDefaultTimeout(20_000);
  await phone.page.goto(app.url, { waitUntil: 'networkidle' });
  await settle(phone.page, 500);
  await phone.page.getByLabel('Show workspace panel').click();
  await settle(phone.page, 320);
  await openChanges(phone.page);
  const phoneCounts = await counts(phone.page);
  check(phoneCounts.staged === 1 && phoneCounts.changes === 2, 'the phone sheet lists the same three groups');
  await layout(phone.page, '390');
  await designRules(phone.page, '390');
  await legibility(phone.page, '390');
  await shot(phone.page, '04-changes-390-dark');
  await phone.context.close();

  const lightPhone = await session(browser, { width: 390, height: 844, theme: 'light' });
  await lightPhone.page.goto(app.url, { waitUntil: 'networkidle' });
  await settle(lightPhone.page, 500);
  await lightPhone.page.getByLabel('Show workspace panel').click();
  await settle(lightPhone.page, 320);
  await openChanges(lightPhone.page);
  await layout(lightPhone.page, 'light 390');
  await shot(lightPhone.page, '05-changes-390-light');
  check(lightPhone.problems.length === 0, 'no console errors at 390: ' + (lightPhone.problems.join(' | ') || 'none'));
  await lightPhone.context.close();

  console.log('out of the app');
  await collapseDiffs(page);
  await row(page, 'apps/web/src/search/EmptyState.test.tsx').locator('button[aria-label^="Stage "]').click();
  await group(page, 'Staged').locator(`[data-path="apps/web/src/search/EmptyState.test.tsx"]`).waitFor();
  await settle(page, 400);
  const afterStage = await counts(page);
  check(afterStage.staged === 2 && afterStage.untracked === 1, `staging moves the file to the staged group: ${JSON.stringify(afterStage)}`);
  check(await group(page, 'Staged').locator(`[data-path="apps/web/src/search/EmptyState.test.tsx"]`).count() === 1,
    'the staged file is listed under Staged, not duplicated');

  const message = 'Cover the empty state with a test';
  await page.getByLabel('Commit message').fill(message);
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await page.locator('[data-testid="source-report"]').waitFor();
  const report = await page.locator('[data-testid="source-report"]').innerText();
  check(/Committed\s+[0-9a-f]{7,}/.test(report), 'the surface reports the commit it made: ' + report);
  check(report.includes(message), 'the report names the commit subject');
  check(await page.getByLabel('Commit message').inputValue() === '', 'the message field is cleared');
  check((await counts(page)).staged === 0, 'both staged files left the staged group in one commit');
  const logged = (await git(worktree, ['log', '-1', '--format=%s'])).trim();
  check(logged === message, 'a plain git log in the worktree reads the commit back: ' + logged);
  check((await git(worktree, ['log', '-1', '--format=%B'])).includes(message), 'the commit body carries the message');

  const pushButton = page.getByRole('button', { name: /^Push/ });
  check((await pushButton.innerText()).includes('2'), 'the push control counts the two commits ahead of origin');
  await pushButton.click();
  await page.waitForFunction(() => /Pushed/.test(document.querySelector('[data-testid="source-report"]')?.textContent ?? ''));
  await settle(page, 600);
  check(await page.locator('[aria-label="0 ahead, 0 behind"]').count() === 1, 'after the push the branch is level with its upstream');
  const pushed = (await git(remote, ['log', '-1', '--format=%s', 'feat/empty-state-copy'])).trim();
  check(pushed === message, 'the bare remote really has the commit: ' + pushed);
  await shot(page, '06-committed-1440-dark');

  console.log('discarding names the file');
  await row(page, 'README.md').locator('button[aria-expanded]').click();
  await settle(page, 500);
  await row(page, 'README.md').getByRole('button', { name: 'Discard changes' }).click();
  const discardDialog = page.getByRole('dialog');
  await discardDialog.waitFor();
  await settle(page, 300);
  const discardText = await discardDialog.innerText();
  check(discardText.includes('README.md'), 'the discard confirmation names the file');
  check(await row(page, 'README.md').count() === 1, 'nothing is discarded until the confirmation is accepted');
  await discardDialog.getByRole('button', { name: 'Discard the changes' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="change-row"][data-path="README.md"]'), null, { timeout: 20_000 });
  check(await git(worktree, ['status', '--porcelain', 'README.md']).then((value) => value.trim() === ''), 'git agrees the file is back to its committed content');

  console.log('a thread moves into its own worktree');
  await page.getByRole('button', { name: /^Trace the keyboard shortcut/ }).click();
  await settle(page, 600);
  await openChanges(page);
  check(/\bSHARED\b/.test(await surface(page).innerText()), 'a thread without a worktree says so');
  await page.getByRole('button', { name: 'Own worktree' }).click();
  await page.locator('[data-testid="checkout-kind"][data-kind="worktree"]').waitFor({ timeout: 20_000 });
  await settle(page, 700);
  const text = await surface(page).innerText();
  check(text.includes('extendo/trace-the-keyboard-shortcut'), 'the new worktree is on a branch named after the thread');
  check(/working tree is clean/i.test(text), 'a clean tree says so once, in a sentence');
  check(!/Nothing staged yet|No unstaged changes|No untracked files/.test(text), 'and does not stack three empty groups behind it');
  check(await page.locator('[aria-label="0 ahead, 0 behind"]').count() === 1, 'a fresh worktree is level with the branch it came from');
  const moved = await api(app.url, `/git/status?sessionId=${(await api(app.url, '/threads')).find((t) => t.title === 'Trace the keyboard shortcut').sessionId}`);
  check(moved.checkout.worktree === moved.checkout.path, 'the API agrees the thread now runs in the worktree');
  check((await git(moved.checkout.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() === 'extendo/trace-the-keyboard-shortcut',
    'git says the worktree is on that branch');
  await shot(page, '07-worktree-1440-dark');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.locator('[data-testid="checkout-kind"][data-kind="shared"]').waitFor({ timeout: 20_000 });
  check((await surface(page).innerText()).includes('main'), 'removing it returns the thread to the shared checkout');
  check((await git(join(app.dataDir, 'demo', 'northstar-ui'), ['branch', '--list', 'extendo/trace-the-keyboard-shortcut'])).includes('extendo/trace-the-keyboard-shortcut'),
    'the branch itself survives the worktree removal');

  console.log('deleting a thread names what it destroys');
  await page.getByRole('button', { name: /^Make empty search results useful/ }).click();
  await settle(page, 600);
  await openChanges(page);
  await page.getByRole('button', { name: 'Delete thread' }).click();
  const deleteDialog = page.getByRole('dialog');
  await deleteDialog.waitFor();
  await settle(page, 300);
  const deletion = await deleteDialog.innerText();
  check(deletion.includes('useSearch.ts'), 'the confirmation names an uncommitted file it would destroy');
  check(/uncommitted changes are destroyed/.test(deletion), 'it says they are destroyed, not kept');
  check(await deleteDialog.getByRole('button', { name: 'Delete the thread' }).count() === 1, 'the destructive action has its own button');
  await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
  await settle(page, 300);
  check(await page.getByRole('button', { name: /^Make empty search results useful/ }).count() === 1, 'cancelling keeps the thread');
  // A refusal from the server is a console entry in Chromium; the delete and discard confirmations
  // are fetched on purpose, so only the 409s those two attempts produce are expected here.
  const unexpected = problems.filter((problem) => !/status of 409/.test(problem));
  check(unexpected.length === 0, 'no console errors beyond the refusals the flow asks for: ' + (unexpected.join(' | ') || 'none'));
  await context.close();

  console.log('worst case: the paths real repositories carry');
  const ugly = [
    'apps/web/src/search/Ünïcödé Åssert 文字化けプラグイン.test.tsx',
    'apps/web/src/search/this-is-a-single-unbroken-identifier-with-no-break-opportunities-anywhere.ts',
    'packages/ui/components/primitives/overlays/popovers/filters/advanced/panel/with-a-very-long-file-name/index.tsx',
    'docs/notes with spaces and (parens) in the name.md',
    'docs/2026-11-24-a-very-long-release-note-filename-that-keeps-going-and-going-and-going-and-going.md',
  ];
  for (const path of ugly) {
    const target = join(worktree, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'export const ugly = true;\n');
  }
  try {
    for (const [width, height, theme, name] of [[1440, 900, 'dark', '08-worst-1440-dark'], [390, 844, 'dark', '09-worst-390-dark']]) {
      const worst = await session(browser, { width, height, theme });
      worst.page.setDefaultTimeout(20_000);
      await worst.page.goto(app.url, { waitUntil: 'networkidle' });
      await settle(worst.page, 500);
      if (width === 390) {
        await worst.page.getByLabel('Show workspace panel').click();
        await settle(worst.page, 320);
      }
      await openChanges(worst.page);
      const worstCounts = await counts(worst.page);
      check(worstCounts.untracked === 6, `worst ${width}: all five pathological paths are listed beside .env.local (${worstCounts.untracked} untracked)`);
      check((await surface(worst.page).innerText()).includes('文字化け'), 'worst: a non-Latin path renders as itself');
      await layout(worst.page, `worst ${width}`);
      await shot(worst.page, name);
      check(worst.problems.length === 0, `worst ${width}: no console errors` + (worst.problems.length ? ': ' + worst.problems.join(' | ') : ''));
      await worst.context.close();
    }
  } finally {
    for (const path of ugly) rmSync(join(worktree, path), { force: true });
    rmSync(join(worktree, 'packages'), { recursive: true, force: true });
  }
}

/** Without gh, the surface must say what is missing rather than offer a button that cannot work. */
async function honestWithoutGh(browser) {
  console.log('no gh on this machine');
  const app = await boot({ gh: join(tmpdir(), 'extendo-no-gh-binary') });
  const { context, page, problems } = await session(browser, {});
  try {
    page.setDefaultTimeout(20_000);
    await page.goto(app.url, { waitUntil: 'networkidle' });
    await settle(page, 600);
    await openChanges(page);
    const blocked = page.locator('[data-testid="pull-request-blocked"]');
    await blocked.waitFor();
    const text = await blocked.innerText();
    check(/not installed/.test(text), 'it explains that gh is not installed: ' + text);
    check(await page.getByRole('button', { name: 'Pull request' }).count() === 0, 'and offers no pull request button');
    check(problems.length === 0, 'no console errors without gh');
  } finally {
    await context.close();
    await app.close();
  }
}

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const app = await boot();
  const browser = await launch();
  let failure;
  try {
    await runFlow(browser, app);
    await honestWithoutGh(browser);
  } catch (error) {
    failure = error;
    console.error(error);
  } finally {
    await browser.close();
    await app.close();
  }
  if (failure) process.exit(1);
  console.log('\nartifacts in ' + outDir + ': ' + readdirSync(outDir).sort().join(', '));
}

await main();
