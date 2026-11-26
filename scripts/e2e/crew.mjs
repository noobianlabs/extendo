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

async function strip(page, label) {
  const read = () => page.evaluate(() => {
    const tabs = document.querySelector('[aria-label="Inspector views"]');
    const panel = document.querySelector('[aria-label="Inspector"]');
    const style = getComputedStyle(tabs);
    const box = tabs.getBoundingClientRect();
    const start = box.left + parseFloat(style.paddingLeft);
    const end = box.right - parseFloat(style.paddingRight);
    return {
      scrollable: tabs.scrollWidth > tabs.clientWidth + 1,
      fade: tabs.dataset.overflow ?? null,
      panelRight: panel.getBoundingClientRect().right - parseFloat(getComputedStyle(panel).paddingRight),
      stripRight: box.right,
      tabs: [...tabs.querySelectorAll('button')].map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          name: button.textContent.trim(),
          role: button.getAttribute('role'),
          scrollWidth: button.scrollWidth,
          clientWidth: button.clientWidth,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          inside: rect.left >= start - 0.5 && rect.right <= end + 0.5,
          selected: button.getAttribute('aria-selected') === 'true',
        };
      }),
    };
  });
  const first = await read();
  for (const tab of first.tabs) {
    check(tab.scrollWidth <= tab.clientWidth + 1, `${label}: "${tab.name}" does not clip its own label (${tab.scrollWidth} ≤ ${tab.clientWidth} + 1)`);
    check(tab.inside, `${label}: "${tab.name}" sits inside the strip's padding box`);
    check(tab.height >= 28 && tab.width >= 28, `${label}: "${tab.name}" keeps a ${tab.width}×${tab.height} tap target`);
  }
  check(Math.abs(first.stripRight - first.panelRight) <= 4, `${label}: the strip's right edge is within 4px of the panel's content box (${first.stripRight} vs ${first.panelRight})`);
  check(Boolean(first.fade) === first.scrollable, `${label}: the strip fades only if it genuinely overflows (fade "${first.fade}", ${first.scrollable ? 'overflows' : 'fits'})`);
  const selected = first.tabs.find((tab) => tab.selected);
  check(Boolean(selected), `${label}: one tab is selected`);
  return first;
}

async function stripFallback(page, width) {
  const compact = await strip(page, '320 dark');
  check(compact.tabs.length === 5, `320 dark: four tabs and More, not six (${compact.tabs.map(({ name }) => name).join(', ')})`);
  check(!compact.scrollable && compact.fade === null, '320 dark: the tabs that remain fit without a fade');
  const more = page.getByRole('button', { name: /^(More|Terminal|Preview)$/ }).last();
  check(await more.getAttribute('aria-haspopup') === 'menu', '320 dark: More is a menu trigger');
  await more.click();
  const menu = page.getByRole('menu', { name: 'More inspector views' });
  await menu.waitFor();
  const items = await menu.getByRole('menuitemradio').allTextContents();
  check(items.join(',') === 'Terminal,Preview', `320 dark: the menu holds the tabs that did not fit (${items.join(', ')})`);
  await menu.getByRole('menuitemradio', { name: 'Terminal' }).click();
  await page.getByRole('tabpanel', { name: 'Terminal' }).waitFor();
  await page.waitForTimeout(150);
  check(await page.getByRole('button', { name: 'Terminal' }).isVisible(), '320 dark: the trigger names the open hidden tab');
  await page.getByRole('button', { name: 'Terminal' }).click();
  const reopened = page.getByRole('menu', { name: 'More inspector views' });
  await reopened.waitFor();
  check(await reopened.getByRole('menuitemradio', { name: 'Terminal' }).getAttribute('aria-checked') === 'true', '320 dark: the menu marks the open tab');
  await page.keyboard.press('Escape');
  check(await reopened.count() === 0, '320 dark: Escape closes the menu');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.waitForTimeout(120);
  check(await page.getByRole('tabpanel', { name: 'Overview' }).isVisible(), `320 dark: Overview is back at ${width}px`);
}

async function crewPanel(page, panel) {
  for (const text of ['Rework the empty-state copy', 'Draft the changelog entry', 'Wrap the empty state in a status region', 'Tighten the search filters']) {
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
  check(await notices.count() === 4, 'the captain transcript carries four crew report notes');
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
    check(captain.crew?.length === 4, 'the captain has four workers');
    check(captain.crew.every(({ branch }) => branch?.startsWith('extendo/crew-')), 'each worker runs on its own branch');
    check(captain.crew.every(({ report }) => Boolean(report)), 'each worker carries its last report on the thread, not just in its transcript');
    check(captain.crew.filter(({ pullRequest }) => Boolean(pullRequest?.number)).length === 3, 'the three workers with commits carry their pull request');
    check(captain.crew.filter(({ pullRequest }) => !pullRequest).length === 1, 'the worker with nothing committed carries no pull request');
    check(captain.crew.every(({ base }) => base === 'main'), 'each worker records the branch it was cut from');
    check(captain.issues?.length === 1 && captain.issues[0].state === 'needs-you', 'the captain filed one needs-you issue');
    const standalone = threads.find(({ role, title }) => role !== 'captain' && role !== 'worker' && title === 'Make empty search results useful');
    check(Boolean(standalone), 'the demo also seeds a standalone thread');

    console.log('captain crew at 1440×900, dark');
    const dark = await session(browser, { theme: 'dark' });
    const panel = await openCaptain(dark.page, app.url);
    await strip(dark.page, '1440 dark');
    await dark.page.getByRole('tab', { name: 'Crew' }).click();
    await crewPanel(dark.page, dark.page.getByRole('tabpanel', { name: 'Crew' }));
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
    const lightPanel = await openCaptain(light.page, app.url);
    await strip(light.page, '1440 light');
    await light.page.getByRole('tab', { name: 'Crew' }).click();
    await crewPanel(light.page, light.page.getByRole('tabpanel', { name: 'Crew' }));
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
    await strip(phone.page, '390 dark');
    await phone.page.getByRole('tab', { name: 'Crew' }).click();
    check(await phone.page.getByRole('tabpanel', { name: 'Crew' }).getByText('extendo/crew-changelog').isVisible(), 'the crew panel opens as a drawer on a phone');
    await layout(phone.page, '390 dark');
    await shot(phone.page, '05-crew-390-drawer-dark');
    check(phone.problems.length === 0, 'no console errors on a phone: ' + (phone.problems.join(' | ') || 'none'));

    console.log('320×700, dark — the panel is genuinely too narrow for six tabs');
    const narrow = await session(browser, { width: 320, height: 700, theme: 'dark' });
    await narrow.page.goto(app.url, { waitUntil: 'load' });
    await narrow.page.getByRole('button', { name: 'Open navigation' }).click();
    await narrow.page.getByRole('dialog', { name: 'Extendo navigation' }).getByRole('button', { name: /Run the empty-state copy crew/ }).click();
    await narrow.page.getByRole('button', { name: 'Show workspace panel' }).click();
    await narrow.page.getByRole('tab', { name: 'Crew' }).waitFor();
    await narrow.page.waitForTimeout(400);
    await stripFallback(narrow.page, 320);
    await layout(narrow.page, '320 dark');
    await shot(narrow.page, '06-crew-320-dark');
    check(narrow.problems.length === 0, 'no console errors at 320: ' + (narrow.problems.join(' | ') || 'none'));

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
