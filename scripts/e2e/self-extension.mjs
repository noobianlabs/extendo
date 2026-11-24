import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { boot, launch, outDir, root, session, settle, shot } from './app.mjs';

const SOURCE = `export default ({ tool, z }) => ({
  name: 'Word count',
  apply(ctx) {
    const count = tool({
      name: 'word_count',
      description: 'Count words, characters and the longest word in a piece of text.',
      input: z.object({ text: z.string().min(1).max(20000) }),
      readOnly: true,
      async execute({ text }) {
        const words = text.trim().split(/\\s+/).filter(Boolean);
        return { words: words.length, characters: text.length, longest: words.sort((a, b) => b.length - a.length)[0] ?? '' };
      },
    });
    ctx.get('tools').register(ctx, count.name, count);
    ctx.emit('tools/register', { name: count.name });
  },
});
`;

const PROMPT = 'Use the word_count plugin tool on this sentence: the harness, the editor and the extensions are one substrate.';

function check(condition, message) {
  if (!condition) throw new Error('Assertion failed: ' + message);
  console.log('  ✓ ' + message);
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
}

/** The panel is a sibling of the header, not a cover over it. */
async function doesNotCoverChrome(page) {
  const header = await page.locator('header').first().boundingBox();
  const panel = await page.getByTestId('workshop').boundingBox();
  check(Boolean(header && panel) && panel.y >= header.y + header.height - 1, 'the workshop starts below the header');
  const occluded = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="open-workshop"]');
    if (!button) return 'missing';
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === button || button.contains(hit) ? null : String(hit?.className ?? hit?.tagName ?? 'unknown');
  });
  check(occluded === null, 'the workshop toggle stays clickable while the workshop is open' + (occluded ? ': ' + occluded : ''));
}

async function sideBySide(page) {
  const panel = await page.getByTestId('workshop').boundingBox();
  const composer = await page.getByRole('form', { name: 'Compose a message' }).boundingBox();
  check(Boolean(panel && composer), 'the panel and the composer both have a box');
  check(panel.x >= composer.x + composer.width - 1, 'the workshop takes its own column; the composer is not under it');
}

async function openWorkshop(page) {
  await page.getByTestId('open-workshop').click();
  await page.locator('[data-testid="workshop"][data-open="true"]').waitFor();
  await settle(page, 320);
}

async function closeWorkshop(page) {
  await page.getByRole('button', { name: 'Close the workshop' }).click();
  await settle(page, 320);
}

async function runFlow(page, url, { capture }) {
  const beat = (ms) => capture ? page.waitForTimeout(ms) : Promise.resolve();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByTestId('open-workshop').waitFor();
  await beat(600);

  await openWorkshop(page);
  await page.getByRole('button', { name: 'Write your first plugin' }).waitFor();
  if (capture) await shot(page, '01-workshop-empty');

  await page.getByRole('button', { name: 'Write your first plugin' }).click();
  await page.getByTestId('plugin-name').fill('Word count');
  await page.getByTestId('create-plugin').click();
  await page.getByTestId('plugin-editor').waitFor();
  await settle(page, 420);
  await beat(900);
  await doesNotCoverChrome(page);
  if (capture) await shot(page, '02-editor');

  const editor = page.getByTestId('plugin-editor');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await beat(300);
  await page.keyboard.insertText(SOURCE);
  await beat(500);
  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForFunction(() => /revision\s*2/i.test(document.querySelector('[data-testid="workshop"]')?.textContent ?? ''));
  await page.waitForFunction(() => document.querySelector('[data-testid="save-plugin"]')?.disabled === true);
  await settle(page, 420);
  await beat(900);
  const revision = await page.locator('[data-testid="workshop"]').innerText();
  check(/revision\s*2/i.test(revision), 'the save wrote revision 2 and remounted it');
  const stored = await (await fetch(new URL('/api/extensions', page.url()).href)).json();
  check(stored.extensions[0]?.source === SOURCE, 'the editor round-tripped the source exactly, with no auto-indent drift');
  check((await page.getByTestId('live-tool-word_count').count()) === 1, 'the plugin tool appears in the capability strip');
  if (capture) await shot(page, '03-saved');

  await beat(400);
  await page.getByRole('textbox', { name: 'Message' }).fill(PROMPT);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByTestId('plugin-seam').waitFor({ timeout: 25_000 });
  await page.getByText(/word_count answered/).waitFor({ timeout: 25_000 });
  await settle(page, 500);
  const answer = await page.getByRole('region', { name: 'Message history' }).innerText();
  check(answer.includes('{"words":'), 'the tool result reaches the transcript intact, opening brace and all');
  const asked = PROMPT.split(':').slice(1).join(':').trim();
  check(answer.includes(`"words": ${asked.split(/\s+/).length}`), 'the tool counted the sentence the person asked about, not a canned one');
  check((await page.getByTestId('plugin-seam').count()) === 1, 'the seam marks where the plugin joined this thread');
  check(/plugin\/word-count joined/.test(await page.getByTestId('plugin-seam').innerText()), 'the seam names the plugin that joined');
  const call = await page.getByText('word_count', { exact: false }).count();
  check(call > 0, 'the transcript shows the tool the plugin registered');
  await sideBySide(page);
  await layout(page, '1440');
  if (capture) await shot(page, '04-agent-call');

  await page.getByTestId('open-tools').click();
  await page.getByTestId('tool-list').waitFor();
  const listed = await page.getByTestId('tool-list').innerText();
  check(/word_count/.test(listed) && /plugin\/word-count/.test(listed), 'the tool list attributes the new tool to its plugin');
  check(/demo_read/.test(listed), 'the tool list still shows the tools that ship with Extendo');
  await settle(page, 260);
  await beat(900);
  if (capture) await shot(page, '04b-tool-list');
  await page.keyboard.press('Escape');
  await page.getByTestId('tool-list').waitFor({ state: 'detached' });
}

const WORST_NAMES = [
  'a',
  '文字化けプラグイン',
  'Ünïcödé Åssert',
  'This plugin counts every word in every paragraph of a very long document',
  'Search 2',
  'Release notes',
  'Dead code',
  'Type check',
  'Bundle size',
  'Changelog',
  'Owner lookup',
  'Review findings',
];

async function createWorstCase(url) {
  for (const name of WORST_NAMES) {
    const response = await fetch(url + '/api/extensions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error('Could not create the worst-case plugin ' + name);
  }
}

async function worstCase(browser, url) {
  console.log('worst case: 12 plugins, long and non-Latin names');
  await createWorstCase(url);
  for (const [width, height, theme, name] of [[1440, 900, 'dark', '09-worst-1440'], [390, 844, 'dark', '10-worst-390']]) {
    const { context, page, problems } = await session(browser, { width, height, theme });
    page.setDefaultTimeout(20_000);
    await page.goto(url, { waitUntil: 'networkidle' });
    await openWorkshop(page);
    await page.getByTestId('plugin-editor').waitFor();
    await settle(page, 400);
    await layout(page, `worst ${width}`);
    const tabs = await page.getByRole('tab').count();
    check(tabs === WORST_NAMES.length + 1, `worst ${width}: every plugin has a tab (${tabs})`);
    await shot(page, name);
    check(problems.length === 0, `worst ${width}: no console errors` + (problems.length ? ': ' + problems.join(' | ') : ''));
    await context.close();
  }
}

async function removeAll(browser, url) {
  console.log('teardown: deleting every plugin');
  const { context, page, problems } = await session(browser, {});
  page.setDefaultTimeout(20_000);
  await page.goto(url, { waitUntil: 'networkidle' });
  await openWorkshop(page);
  await page.getByTestId('plugin-editor').waitFor();
  for (let attempt = 0; ; attempt++) {
    const remove = page.getByRole('button', { name: /^Delete / });
    if ((await remove.count()) === 0) break;
    if (attempt > 20) throw new Error('Could not remove every plugin');
    await remove.first().click();
    await settle(page, 160);
  }
  await page.getByRole('button', { name: 'Write your first plugin' }).waitFor();
  check(true, 'deleting every plugin returns the workshop to its empty state');
  await page.getByTestId('open-tools').click();
  await page.getByTestId('tool-list').waitFor();
  const listed = await page.getByTestId('tool-list').innerText();
  check(!/word_count/.test(listed), 'a deleted plugin takes its tool out of the agent’s tool list');
  check(/demo_read/.test(listed), 'the built-in tools are still there after the plugins are gone');
  check(problems.length === 0, 'no console errors while deleting');
  await context.close();
}

async function main() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const video = join(outDir, 'video');
  mkdirSync(video, { recursive: true });
  const app = await boot();
  const browser = await launch();
  let failure;
  try {
    const { context, page, problems } = await session(browser, { video });
    page.setDefaultTimeout(20_000);
    console.log('self-extension flow at 1440×900, dark');
    await runFlow(page, app.url, { capture: true });
    check(problems.length === 0, 'no console errors: ' + (problems.join(' | ') || 'none'));

    const recording = page.video();
    await context.close();
    const webm = await recording.path();
    renameSync(webm, join(outDir, 'self-extension.webm'));
    console.log('  ✓ recording saved');

    console.log('light theme, 1440×900');
    const light = await session(browser, { theme: 'light' });
    light.page.setDefaultTimeout(20_000);
    await light.page.goto(app.url, { waitUntil: 'networkidle' });
    await light.page.getByTestId('plugin-seam').waitFor({ timeout: 25_000 });
    await openWorkshop(light.page);
    await light.page.getByTestId('plugin-editor').waitFor();
    await settle(light.page, 500);
    await shot(light.page, '05-1440-light');
    check(light.problems.length === 0, 'no console errors in the light theme: ' + (light.problems.join(' | ') || 'none'));
    await light.context.close();

    console.log('390×844');
    const phone = await session(browser, { width: 390, height: 844 });
    phone.page.setDefaultTimeout(20_000);
    await phone.page.goto(app.url, { waitUntil: 'networkidle' });
    await phone.page.getByTestId('plugin-seam').waitFor({ timeout: 25_000 });
    await settle(phone.page, 400);
    await layout(phone.page, '390');
    await shot(phone.page, '06-390-dark');
    await openWorkshop(phone.page);
    await phone.page.getByTestId('plugin-editor').waitFor();
    await settle(phone.page, 400);
    await shot(phone.page, '07-390-workshop');
    await closeWorkshop(phone.page);
    const lightPhone = await session(browser, { width: 390, height: 844, theme: 'light' });
    await lightPhone.page.goto(app.url, { waitUntil: 'networkidle' });
    await lightPhone.page.getByTestId('plugin-seam').waitFor({ timeout: 25_000 });
    await settle(lightPhone.page, 400);
    await shot(lightPhone.page, '08-390-light');
    await lightPhone.context.close();
    await phone.context.close();
    check(phone.problems.length === 0, 'no console errors at 390: ' + (phone.problems.join(' | ') || 'none'));
    await worstCase(browser, app.url);
    await removeAll(browser, app.url);
  } catch (error) {
    failure = error;
    console.error(error);
  } finally {
    await browser.close();
    await app.close();
  }
  if (failure) process.exit(1);
  const files = readdirSync(outDir).sort();
  console.log('\nartifacts in ' + outDir + ': ' + files.join(', '));
}

await main();
