/**
 * Crew integration and steering, driven in a real browser against the real server on the demo
 * provider: review the diff a worker's branch would merge, land it, watch the row change, refuse a
 * conflicting landing, send a queued steer mid-turn and interrupt another turn.
 *
 * Every assertion is a fact read back from the app or from git — the screenshots are the record, not
 * the evidence. The demo provider is slowed through `EXTENDO_DEMO_DELAY` so a turn is genuinely
 * running when the steer is sent, which is the only way to prove the two delivery modes.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { boot, launch, outDir, root, session, settle, shot } from './app.mjs';

const execFileAsync = promisify(execFile);
const MOVING = 'Tighten the search filters';
const COPY = 'Rework the empty-state copy';
const LAYOUT = 'Wrap the empty state in a status region';
const CHANGELOG = 'Draft the changelog entry';
const CONFLICTING_PATH = 'apps/web/src/search/EmptyState.tsx';
const STEER = 'Keep the changelog line to one sentence and leave the search components alone.';

function check(condition, message) {
  if (!condition) throw new Error('Assertion failed: ' + message);
  console.log('  ✓ ' + message);
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
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
  const panel = await page.evaluate(() => {
    const inspector = document.querySelector('[aria-label="Inspector"]');
    return inspector ? inspector.getBoundingClientRect().width : 0;
  });
  check(panel === 0 || panel >= 300, `${label}: the crew panel keeps a ${Math.round(panel)}px column`);
}

function row(panel, title) {
  return panel.getByRole('listitem').filter({ hasText: title }).first();
}

/**
 * Reads the crew surface's text as a person's eye would have to: the computed foreground against the
 * background it actually sits on, composited through the transparent layers above it. This is the
 * substitute for a screenshot review on a route that cannot see one, so it measures real pixels'
 * colours rather than trusting the intent in the stylesheet.
 */
const AUDIT_TARGETS = [
  ['crewTitle', 4.5], ['crewBranch', 4.5], ['crewReport', 4.5], ['crewSeen', 3], ['crewSha', 4.5],
  ['crewSubject', 4.5], ['crewPath', 4.5], ['crewPathParent', 3], ['crewDiffCount', 3], ['crewNote', 4.5],
  ['crewEmptyNote', 4.5], ['crewLanded', 4.5], ['crewKept', 3], ['crewSteerMode', 4.5], ['crewSteerText', 4.5],
  ['crewConflicts', 4.5], ['crewProblem', 4.5],
];

async function audit(page, label) {
  const report = await page.evaluate((targets) => {
    const parse = (value) => {
      const match = String(value).match(/rgba?\(([^)]+)\)/);
      if (!match) return undefined;
      const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
    };
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const luminance = ({ r, g, b }) => {
      const linear = [r, g, b].map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const ratio = (a, b) => {
      const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left);
      return (high + 0.05) / (low + 0.05);
    };
    const background = (node) => {
      const chain = [];
      for (let element = node; element; element = element.parentElement) {
        const colour = parse(getComputedStyle(element).backgroundColor);
        if (colour && colour.a > 0) chain.push(colour);
      }
      const stack = chain.reverse();
      const opaque = stack.findIndex((colour) => colour.a >= 0.999);
      let base = opaque >= 0 ? stack[opaque] : { r: 255, g: 255, b: 255, a: 1 };
      for (const colour of stack.slice(opaque + 1)) base = over(colour, base);
      return base;
    };
    const findings = [];
    for (const [name, floor] of targets) {
      const node = document.querySelector(`[class*="${name}_"]`);
      if (!node) { findings.push({ name, missing: true }); continue; }
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none' || !node.getClientRects().length) {
        findings.push({ name, hidden: true });
        continue;
      }
      const fg = parse(style.color);
      const bg = background(node);
      const ink = fg.a >= 0.999 ? fg : over(fg, bg);
      findings.push({ name, ratio: Number(ratio(ink, bg).toFixed(2)), floor, text: (node.textContent || '').trim().slice(0, 40) });
    }
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted-3').trim();
    const painted = [...document.querySelectorAll('[aria-label="Crew"] *')].flatMap((node) => {
      const style = getComputedStyle(node);
      if (!node.getClientRects().length) return [];
      const colour = style.color;
      if (colour !== accent) return [];
      return [{ className: String(node.className), text: (node.textContent || '').trim().slice(0, 30) }];
    });
    const controls = [...document.querySelectorAll('[aria-label="Crew"] button, [aria-label="Crew"] input')]
      .filter((node) => node.getClientRects().length)
      .map((node) => ({ label: node.getAttribute('aria-label') || (node.textContent || '').trim().slice(0, 24), height: Math.round(node.getBoundingClientRect().height) }));
    return { findings, painted, controls, accent, muted };
  }, AUDIT_TARGETS);
  const measured = report.findings.filter((finding) => typeof finding.ratio === 'number');
  console.log(`  · ${label}: measured ${measured.length} text elements — ` + measured.map((f) => `${f.name} ${f.ratio}:1`).join(', '));
  const low = measured.filter((finding) => finding.ratio < finding.floor);
  check(low.length === 0, `${label}: every crew text element meets its contrast floor` + (low.length ? ': ' + low.map((f) => `${f.name} ${f.ratio} < ${f.floor}`).join(', ') : ''));
  const short = report.controls.filter((control) => control.height < 28);
  check(short.length === 0, `${label}: every crew control keeps a real target` + (short.length ? ': ' + short.map((c) => `${c.label} ${c.height}px`).join(', ') : ''));
  const stray = report.painted.filter(({ className }) => !/crewPrimary_|crewSteerMode_|crewMode_|crewState_/.test(className));
  check(stray.length === 0, `${label}: the accent is used only where the design allows it` + (stray.length ? ': ' + stray.map((s) => `${s.text} (${s.className})`).join(', ') : ''));
}

async function openCrew(page, url, title = null) {
  await page.goto(url, { waitUntil: 'load' });
  await page.getByRole('button', { name: new RegExp(title ?? 'Run the empty-state copy crew') }).click();
  await page.getByRole('tab', { name: 'Crew' }).waitFor();
  await page.getByRole('tab', { name: 'Crew' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Crew' });
  await panel.waitFor();
  await settle(page);
  return panel;
}

async function review(page, panel, title) {
  const worker = row(panel, title);
  const toggle = worker.getByRole('button', { name: 'Review change' });
  await toggle.click();
  return worker;
}

/** The diff CodeMirror rendered for one file, as text, to prove it is the branch's real change. */
async function renderedDiff(worker) {
  return worker.evaluate((node) => Array.from(node.querySelectorAll('.cm-content')).map((line) => line.textContent).join('\n'));
}

/** Polls until a fact is true, so the assertion after it reads a settled log rather than a race. */
async function until(read, label, timeout = 60_000) {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for ' + label);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function events(app, sessionId) {
  const payload = await (await fetch(`${app.url}/api/sessions/${sessionId}/events?afterSeq=0`)).json();
  return payload.events;
}

async function run() {
  const app = await boot({ env: { EXTENDO_DEMO_DELAY: '900' } });
  const browser = await launch();
  const video = join(outDir, 'video');
  mkdirSync(video, { recursive: true });
  try {
    const threads = await (await fetch(app.url + '/api/threads')).json();
    const captain = threads.find(({ role }) => role === 'captain');
    const project = (await (await fetch(app.url + '/api/projects')).json())[0];
    const repo = project.path;
    check(Boolean(captain) && captain.crew?.length === 4, 'the demo seeds a captain with four workers');
    const workerFor = (title) => captain.crew.find((member) => member.title === title);
    for (const title of [COPY, CHANGELOG, LAYOUT, MOVING]) {
      const member = workerFor(title);
      check(Boolean(member), `the crew carries "${title}"`);
      check(member?.base === 'main', `"${title}" records main as the branch it was cut from`);
      check(Boolean(member?.worktree) && existsSync(member.worktree), `"${title}" runs in a real worktree on disk`);
    }
    const mainStart = await git(repo, ['rev-parse', 'main']);

    console.log('1440×900, dark — review, land, conflict, steer, interrupt');
    const dark = await session(browser, { theme: 'dark', video });
    const panel = await openCrew(dark.page, app.url);
    check(await panel.getByRole('listitem').filter({ hasText: MOVING }).isVisible(), 'the crew lists every worker including the empty one');

    // 1. Reviewing a worker's branch.
    const changelog = await review(dark.page, panel, CHANGELOG);
    await changelog.getByText('Note the empty-state copy in the changelog', { exact: true }).waitFor();
    check(true, 'the review lists the commit the branch carries');
    check(await changelog.getByText('1 commit, 1 file', { exact: true }).isVisible(), 'the review counts one commit and one file');
    check(await changelog.getByRole('button', { name: /1 added, 0 removed: docs\/CHANGELOG.md/ }).isVisible(), 'the review lists the changed file with its line counts');
    await changelog.getByRole('button', { name: /1 added, 0 removed: docs\/CHANGELOG.md/ }).click();
    await changelog.locator('.cm-content').first().waitFor();
    const changelogDiff = await renderedDiff(changelog);
    check(changelogDiff.includes('Empty results name the query that found nothing'), 'the diff shows the line the worker actually added');
    check(changelogDiff.includes('# Changelog'), 'the diff carries the whole file, so the added line reads in context');
    await shot(dark.page, '01-review-1440-dark');

    const empty = await review(dark.page, panel, MOVING);
    await empty.getByText('No commits on this branch yet, so there is nothing to diff and nothing to land.').waitFor();
    check(true, 'a worker that committed nothing says so instead of drawing an empty diff');
    check(await empty.getByRole('button', { name: /Integrate into main/ }).isDisabled(), 'the empty worker cannot be landed');
    await shot(dark.page, '02-empty-branch-1440-dark');

    // 2. Landing the changelog, then the copy, which now needs a real merge commit.
    await changelog.getByRole('button', { name: 'Integrate into main' }).click();
    await dark.page.getByRole('button', { name: 'Land the branch' }).click();
    await changelog.locator('p').filter({ hasText: /Landed in main as [0-9a-f]{7}, fast-forwarded\./ }).waitFor();
    const fastForward = await git(repo, ['rev-parse', 'main']);
    check(fastForward !== mainStart, 'landing moved main');
    check(fastForward === await git(repo, ['rev-parse', 'extendo/crew-changelog']), 'a target that had not moved fast-forwards onto the worker commit');
    check(await git(repo, ['log', '-1', '--format=%s', 'main']) === 'Note the empty-state copy in the changelog', 'main carries the worker commit itself, with no merge commit padding');
    check(existsSync(workerFor(CHANGELOG).worktree), 'the worker worktree is kept after landing');
    check(await git(repo, ['rev-parse', '--verify', 'refs/heads/extendo/crew-changelog']) === fastForward, 'the worker branch still points at its commit');
    check(await changelog.getByText(/Branch and worktree kept at/).isVisible(), 'the row says the worktree was kept');
    check(await changelog.getByText(/^Landed [0-9a-f]{7}$/).isVisible(), 'the crew row shows the landing with its commit');
    const landing = dark.page.getByRole('article', { name: 'Crew landing' });
    check(await landing.count() === 1, 'the captain transcript records the landing');
    check(await landing.first().getByText('Landed extendo/crew-changelog').isVisible(), 'the landing note names the branch it landed');
    await shot(dark.page, '03-landed-1440-dark');

    const copy = await review(dark.page, panel, COPY);
    await copy.getByText('Name the query in the empty state', { exact: true }).waitFor();
    await copy.getByRole('button', { name: 'Integrate into main' }).click();
    await dark.page.getByRole('button', { name: 'Land the branch' }).click();
    await copy.locator('p').filter({ hasText: /Landed in main as [0-9a-f]{7}, with a merge commit\./ }).waitFor();
    const merged = await git(repo, ['rev-parse', 'main']);
    const parents = (await git(repo, ['log', '-1', '--format=%P', 'main'])).split(' ');
    check(parents.length === 2, 'a target that moved gets a real merge commit, not an empty one');
    check(parents[0] === fastForward && parents[1] === await git(repo, ['rev-parse', 'extendo/crew-empty-state-copy']), 'the merge commit has main and the worker branch as its parents');
    check(existsSync(workerFor(COPY).worktree), 'the copy worker worktree is kept too');
    await shot(dark.page, '04-merge-1440-dark');

    // 3. A conflicting landing is refused and nothing moves.
    const layoutWorker = await review(dark.page, panel, LAYOUT);
    await layoutWorker.getByRole('button', { name: new RegExp(CONFLICTING_PATH) }).waitFor();
    check(true, 'the conflicting worker edits the file the copy worker already landed');
    check(await layoutWorker.getByRole('button', { name: /CHANGELOG\.md/ }).count() === 0, 'the review runs from the merge base, so main\'s later changelog commit is not drawn as a change this branch makes');
    await layoutWorker.getByRole('button', { name: 'Integrate into main' }).click();
    await dark.page.getByRole('button', { name: 'Land the branch' }).click();
    const alert = layoutWorker.getByRole('alert');
    await alert.waitFor();
    check((await alert.textContent()).includes('would conflict'), 'a conflicting landing is refused with a sentence, not a half-merge');
    check(await alert.getByRole('list', { name: 'Conflicting files' }).getByText(CONFLICTING_PATH).isVisible(), 'the refusal names the conflicting path');
    check(await git(repo, ['rev-parse', 'main']) === merged, 'the target branch is still at its original commit after the refusal');
    check(await git(repo, ['status', '--porcelain']) === '', 'the project checkout is untouched after the refusal');
    check(await layoutWorker.getByText(/^Landed [0-9a-f]{7}$/).count() === 0, 'the refused worker does not read as landed');
    check(await dark.page.getByRole('article', { name: 'Crew landing' }).count() === 2, 'a refused landing records nothing in the captain log');
    await shot(dark.page, '05-conflict-1440-dark');
    await audit(dark.page, '1440 dark, refused landing');

    // 4. Queue mode: a steer arrives at the next step boundary, exactly once.
    const changelogId = workerFor(CHANGELOG).sessionId;
    const input = changelog.getByRole('textbox', { name: `Message ${CHANGELOG}` });
    await input.fill('Take another pass over the changelog line.');
    await changelog.getByRole('button', { name: 'Send to worker' }).click();
    await changelog.getByText('Working', { exact: true }).waitFor({ timeout: 15_000 });
    check(true, 'a brief sent to an idle worker starts its turn, and the row reads "Working"');
    const modes = changelog.getByRole('group', { name: 'How to deliver this message' });
    check(await modes.isVisible(), 'the steering modes appear only while the worker runs');
    check(await modes.getByRole('button', { name: 'Queue' }).getAttribute('aria-pressed') === 'true', 'queue is the selected mode');
    await input.fill(STEER);
    await changelog.getByRole('button', { name: 'Send to worker' }).click();
    await changelog.getByRole('status').filter({ hasText: /Queued .* delivered at the worker/ }).waitFor();
    check(true, 'a queued steer says it will be delivered at the next step');
    const pin = changelog.locator('[data-mode="queue"]').first();
    await pin.waitFor();
    check((await pin.textContent()).includes(STEER), 'the worker row shows the steering input while it runs');
    await shot(dark.page, '06-queued-steer-1440-dark');
    await audit(dark.page, '1440 dark, queued steer');

    const steered = await until(async () => {
      const list = await events(app, changelogId);
      const ended = list.filter((event) => event.type === 'turn/end').at(-1);
      const found = list.filter((event) => event.type === 'user/message' && event.data.content === STEER);
      // The turn that took the steer has to be over, or the step after it has not finished writing.
      return found.length === 1 && ended && ended.seq > found[0].seq && ended.data.outcome === 'completed' ? list : undefined;
    }, 'the queued turn to finish');
    const delivered = steered.filter((event) => event.type === 'user/message' && event.data.content === STEER);
    check(delivered.length === 1, 'the queued message is delivered exactly once');
    const boundary = steered.find((event) => event.type === 'step/start' && event.seq > delivered[0].seq);
    check(Boolean(boundary), 'the message lands at a step boundary, not at the start of the turn');
    check(steered.filter((event) => event.type === 'crew/steer' && event.data.mode === 'queue').length === 1, 'the worker log records that this steer was queued');
    const followed = steered.find((event) => event.type === 'assistant/message' && event.seq > boundary.seq);
    check(Boolean(followed), 'the worker took another step after the delivery, so the steer really arrived mid-turn');
    check(steered.filter((event) => event.type === 'turn/end').every((event) => event.data.outcome === 'completed'), 'the steered turn still ended as a completed turn');

    // 5. Interrupt mode: the turn ends, and a new one starts with the message.
    await input.fill('Take another pass over the changelog line.');
    await changelog.getByRole('button', { name: 'Send to worker' }).click();
    await changelog.getByText('Working', { exact: true }).waitFor({ timeout: 15_000 });
    await changelog.getByRole('button', { name: 'Interrupt' }).click();
    check(await changelog.getByRole('button', { name: 'Interrupt' }).getAttribute('aria-pressed') === 'true', 'the two delivery modes are distinguishable in the row');
    await input.fill('Stop there and hand the branch back as it is.');
    await changelog.getByRole('button', { name: 'Send to worker' }).click();
    await dark.page.getByRole('button', { name: 'Interrupt the turn' }).click();
    await changelog.getByRole('status').filter({ hasText: 'Interrupted' }).waitFor();
    check(true, 'an interrupt says the turn ended and a new one started');
    const interrupted = await until(async () => {
      const list = await events(app, changelogId);
      const outcomes = list.filter((event) => event.type === 'turn/end').map((event) => event.data.outcome);
      return outcomes.includes('cancelled') && outcomes.at(-1) === 'completed' ? list : undefined;
    }, 'the interrupted turn to be replaced by a completed one');
    const modesLogged = interrupted.filter((event) => event.type === 'crew/steer');
    check(modesLogged.filter((event) => event.data.mode === 'queue').length === 1, 'the worker log still holds exactly one queued steer');
    check(modesLogged.filter((event) => event.data.mode === 'interrupt').length === 1, 'the worker log records that the second steer was an interrupt');
    const outcomes = interrupted.filter((event) => event.type === 'turn/end').map((event) => event.data.outcome);
    check(outcomes.filter((outcome) => outcome === 'cancelled').length === 1, 'the interrupted turn ends with an explicit cancelled outcome');
    check(outcomes.at(-1) === 'completed', 'the turn that replaced it ends as completed');
    const cancelledEnd = interrupted.find((event) => event.type === 'turn/end' && event.data.outcome === 'cancelled');
    const restarted = interrupted.find((event) => event.type === 'turn/start' && event.seq > cancelledEnd.seq);
    check(Boolean(restarted), 'a new turn starts after the interrupted one');
    const interruptMessage = interrupted.find((event) => event.type === 'user/message' && event.data.content === 'Stop there and hand the branch back as it is.');
    check(interruptMessage.seq === interrupted.filter((event) => event.type === 'user/message')
      .filter((event) => event.data.turnId === restarted.data.turnId).at(0).seq, 'the new turn opens with the interrupting message');
    check(await changelog.locator('[data-mode="interrupt"]').count() === 0, 'the row drops the steering pin once the delivery has happened');
    await shot(dark.page, '07-interrupted-1440-dark');

    // 6. Opening the worker from its row shows the message in its own transcript.
    await changelog.getByRole('button', { name: `Open ${CHANGELOG}` }).click();
    await dark.page.getByRole('region', { name: 'Message history' }).waitFor();
    await settle(dark.page, 400);
    check(await dark.page.getByText(STEER, { exact: true }).isVisible(), 'the steer is in the worker transcript, once, as its own message');
    check(await dark.page.getByText(STEER, { exact: true }).count() === 1, 'the worker transcript holds the steer exactly once');
    await shot(dark.page, '08-worker-transcript-1440-dark');
    await layout(dark.page, '1440 dark');
    // The conflicting landing is deliberately refused with a 409, which the browser logs as a failed
    // resource; everything else in the page has to be quiet.
    const problems = dark.problems.filter((line) => !/status of 409/.test(line));
    check(problems.length === 0, 'no console errors besides the refused landing: ' + (problems.join(' | ') || 'none'));
    await dark.context.close();

    console.log('1440×900, light');
    const light = await session(browser, { theme: 'light' });
    const lightPanel = await openCrew(light.page, app.url);
    const landedCopy = await review(light.page, lightPanel, COPY);
    await landedCopy.locator('p').filter({ hasText: /Landed in main as [0-9a-f]{7}, with a merge commit\./ }).waitFor();
    check(true, 'the landing survives a reload, because it is the captain log, not page state');
    check(await lightPanel.getByText(/^Landed [0-9a-f]{7}$/).count() === 2, 'both landed workers read as landed after a reload');
    await layout(light.page, '1440 light');
    await audit(light.page, '1440 light');
    await shot(light.page, '09-review-1440-light');
    check(light.problems.length === 0, 'no console errors in the light theme: ' + (light.problems.join(' | ') || 'none'));
    await light.context.close();

    for (const theme of ['dark', 'light']) {
      console.log(`390×844, ${theme}`);
      const phone = await session(browser, { width: 390, height: 844, theme });
      await phone.page.goto(app.url, { waitUntil: 'load' });
      await phone.page.getByRole('button', { name: 'Open navigation' }).click();
      await phone.page.getByRole('dialog', { name: 'Extendo navigation' })
        .getByRole('button', { name: /Run the empty-state copy crew/ }).click();
      await phone.page.getByRole('button', { name: 'Show workspace panel' }).click();
      const phonePanel = phone.page.getByRole('tabpanel', { name: 'Crew' });
      await phone.page.getByRole('tab', { name: 'Crew' }).click();
      await phonePanel.waitFor();
      await settle(phone.page);
      const worker = await review(phone.page, phonePanel, COPY);
      await worker.getByText('Name the query in the empty state', { exact: true }).waitFor();
      const composer = phonePanel.getByRole('textbox', { name: `Message ${COPY}` });
      check(await composer.isVisible(), `390 ${theme}: the steer composer is reachable in the drawer`);
      await layout(phone.page, `390 ${theme}`);
      await audit(phone.page, `390 ${theme}`);
      await shot(phone.page, `1${theme === 'dark' ? 0 : 1}-review-390-${theme}`);
      check(phone.problems.length === 0, `no console errors at 390 ${theme}: ` + (phone.problems.join(' | ') || 'none'));
      await phone.context.close();
    }

    console.log('\nfinal state');
    check(await git(repo, ['rev-parse', 'main']) === merged, 'main is at the last successful integration, not the refused one');
    check(await git(repo, ['status', '--porcelain']) === '', 'the project checkout is still clean');
    const branches = await git(repo, ['branch', '--list', 'extendo/crew-*']);
    check(branches.split('\n').length === 4, 'every worker branch still exists');
    console.log('\ncrew integration flow passed');
  } finally {
    await browser.close();
    await app.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});