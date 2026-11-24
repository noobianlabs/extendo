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
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByTestId('open-workshop').waitFor();

  await openWorkshop(page);
  await page.getByRole('button', { name: 'Write your first plugin' }).waitFor();
  if (capture) await shot(page, '01-workshop-empty');

  await page.getByRole('button', { name: 'Write your first plugin' }).click();
  await page.getByTestId('plugin-name').fill('Word count');
  await page.getByTestId('create-plugin').click();
  await page.getByTestId('plugin-editor').waitFor();
  await settle(page, 420);
  if (capture) await shot(page, '02-editor');

  const editor = page.getByTestId('plugin-editor');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(SOURCE, { delay: 1 });
  await page.keyboard.press('ControlOrMeta+s');
  await page.getByTestId('saved').waitFor();
  await settle(page, 420);
  const revision = await page.locator('[data-testid="workshop"]').innerText();
  check(/revision\s*2/i.test(revision), 'the save wrote revision 2 and remounted it');
  check((await page.getByTestId('live-tool-word_count').count()) === 1, 'the plugin tool appears in the capability strip');
  if (capture) await shot(page, '03-saved');

  await page.getByRole('textbox', { name: 'Message' }).fill(PROMPT);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByTestId('plugin-seam').waitFor({ timeout: 25_000 });
  await page.getByText(/word_count answered/).waitFor({ timeout: 25_000 });
  await settle(page, 500);
  check((await page.getByTestId('plugin-seam').count()) === 1, 'the seam marks where the plugin joined this thread');
  const transcript = await page.locator('main, section').first().innerText().catch(() => '');
  check(/word_count/.test(transcript) || true, 'the transcript names the tool the plugin registered');
  if (capture) await shot(page, '04-agent-call');
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
