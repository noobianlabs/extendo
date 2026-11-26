/**
 * The captain's crew, driven in a real browser against the real server on the demo provider.
 *
 * It asserts the durable facts the demo seeds (a captain, two workers on their own branches, one
 * needs-you issue), the Crew tab's contents for a captain and its absence for a standalone thread,
 * and the crew report notes in the captain's own transcript. The screenshots are the visual record.
 */
import { boot, launch, session, settle, shot } from './app.mjs';

function check(condition, message) {
  if (!condition) throw new Error('Assertion failed: ' + message);
  console.log('  ✓ ' + message);
}

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

async function openCaptain(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  await page.getByRole('button', { name: /Run the empty-state copy crew/ }).click();
  await page.getByRole('tab', { name: 'Crew' }).waitFor();
  await page.getByRole('tab', { name: 'Crew' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Crew' });
  await panel.waitFor();
  await settle(page);
  return panel;
}

async function crewPanel(page, panel) {
  for (const text of ['Rework the empty-state copy', 'Draft the changelog entry']) {
    check(await panel.getByText(text, { exact: true }).isVisible(), `the crew lists the worker "${text}"`);
  }
  for (const branch of ['extendo/crew-empty-state-copy', 'extendo/crew-changelog']) {
    check(await panel.getByText(branch, { exact: true }).isVisible(), `the crew shows the worker branch ${branch}`);
  }
  for (const report of ['The empty state now names the query and offers a clear action.', 'The changelog now notes that empty results name the query.']) {
    check(await panel.getByText(report).isVisible(), `the crew shows the last report "${report.slice(0, 32)}…"`);
  }
  check(await panel.getByRole('link', { name: '#226' }).isVisible(), 'the copy worker links its pull request #226');
  check(await panel.getByRole('link', { name: '#227' }).isVisible(), 'the changelog worker links its pull request #227');
  check(await panel.getByText('Confirm the empty-state copy with design').isVisible(), 'the issues list shows the filed issue');
  check(await panel.getByText('Needs you', { exact: true }).isVisible(), 'the issue is marked "Needs you"');
  check(await page.getByRole('heading', { name: /^Crew/ }).isVisible(), 'the Crew tab is the one open');
}

async function transcript(page) {
  const notices = page.getByRole('article', { name: 'Crew report' });
  check(await notices.count() === 2, 'the captain transcript carries two crew report notes');
  check(await notices.nth(0).getByText('Rework the empty-state copy').isVisible(), 'the first report names its worker');
  check(await notices.nth(1).getByText('finished').isVisible(), 'a completed worker reads "finished"');
}

async function run() {
  const app = await boot();
  const browser = await launch();
  try {
    const threads = await (await fetch(app.url + '/api/threads')).json();
    const captain = threads.find(({ role }) => role === 'captain');
    check(Boolean(captain), 'the demo seeds a captain thread');
    check(captain.crew?.length === 2, 'the captain has two workers');
    check(captain.crew.every(({ branch }) => branch?.startsWith('extendo/crew-')), 'each worker runs on its own branch');
    check(captain.crew.every(({ report }) => Boolean(report)), 'each worker carries its last report on the thread, not just in its transcript');
    check(captain.crew.every(({ pullRequest }) => Boolean(pullRequest?.number)), 'each worker carries its pull request');
    check(captain.issues?.length === 1 && captain.issues[0].state === 'needs-you', 'the captain filed one needs-you issue');
    const standalone = threads.find(({ role, title }) => role !== 'captain' && role !== 'worker' && title === 'Make empty search results useful');
    check(Boolean(standalone), 'the demo also seeds a standalone thread');

    console.log('captain crew at 1440×900, dark');
    const dark = await session(browser, { theme: 'dark' });
    const panel = await openCaptain(dark.page, app.url);
    await crewPanel(dark.page, panel);
    await transcript(dark.page);
    await layout(dark.page, '1440 dark');
    check(await dark.page.getByRole('button', { name: 'Show workspace panel' }).count() === 0, 'the crew panel is docked, not hidden');
    await shot(dark.page, '01-crew-1440-dark');

    console.log('a standalone thread has no crew');
    await dark.page.getByRole('button', { name: /Make empty search results useful/ }).click();
    await dark.page.getByRole('tab', { name: 'Overview' }).waitFor();
    check(await dark.page.getByRole('tab', { name: 'Crew' }).count() === 0, 'the Crew tab is not offered on a standalone thread');
    await shot(dark.page, '02-standalone-1440-dark');
    check(dark.problems.length === 0, 'no console errors: ' + (dark.problems.join(' | ') || 'none'));

    console.log('light theme, 1440×900');
    const light = await session(browser, { theme: 'light' });
    await crewPanel(light.page, await openCaptain(light.page, app.url));
    await layout(light.page, '1440 light');
    await shot(light.page, '03-crew-1440-light');
    check(light.problems.length === 0, 'no console errors in the light theme: ' + (light.problems.join(' | ') || 'none'));

    console.log('390×844, dark');
    const phone = await session(browser, { width: 390, height: 844, theme: 'dark' });
    await phone.page.goto(app.url, { waitUntil: 'load' });
    await phone.page.getByRole('button', { name: 'Open navigation' }).click();
    await phone.page.getByRole('dialog', { name: 'Extendo navigation' }).getByRole('button', { name: /Run the empty-state copy crew/ }).click();
    await phone.page.getByRole('region', { name: 'Message history' }).getByRole('article', { name: 'Crew report' }).first().waitFor();
    await transcript(phone.page);
    await shot(phone.page, '04-crew-390-dark');
    await phone.page.getByRole('button', { name: 'Show workspace panel' }).click();
    await phone.page.getByRole('tab', { name: 'Crew' }).click();
    await phone.page.getByRole('tabpanel', { name: 'Crew' }).waitFor();
    await settle(phone.page);
    check(await phone.page.getByRole('tabpanel', { name: 'Crew' }).getByText('extendo/crew-changelog').isVisible(), 'the crew panel opens as a drawer on a phone');
    await layout(phone.page, '390 dark');
    await shot(phone.page, '05-crew-390-drawer-dark');
    check(phone.problems.length === 0, 'no console errors on a phone: ' + (phone.problems.join(' | ') || 'none'));

    console.log('\ncrew flow passed');
  } finally {
    await browser.close();
    await app.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
