import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Plugin, PullRequest, PullRequestCheckState, PullRequestReviewState } from '@extendo/contracts';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;
const GH_FIELDS = 'number,title,url,state,isDraft,headRefName,baseRefName,additions,deletions,changedFiles,reviewDecision,statusCheckRollup';

const FAILURE_CHECKS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED']);
const PENDING_CHECKS = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED', '']);

export interface CommandResult {
  code: number;
  stdout: string;
}

export type Exec = (command: string, args: string[], options: { cwd: string }) => Promise<CommandResult>;

export interface PullRequestReader {
  read(input: { cwd: string; branch?: string }): Promise<PullRequest | undefined>;
  /** Merges the branch's open pull request. A reader without it cannot merge from Extendo. */
  merge?(branch: string, cwd?: string): Promise<PullRequest | undefined> | PullRequest | undefined;
}

export type ScriptedPullRequestReader = PullRequestReader & {
  merge(branch: string): PullRequest | undefined;
};

export interface GitPullRequestReaderOptions {
  exec?: Exec;
  gh?: string;
}

export interface PullRequestPluginOptions {
  reader: PullRequestReader;
}

type CheckTally = { failing: number; pending: number; passing: number };
type CheckState = 'failing' | 'pending' | 'passing' | 'none';

function exitCode(error: unknown): number {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' && Number.isInteger(code) ? code : 127;
}

function capturedStdout(error: unknown): string {
  const stdout = (error as { stdout?: unknown }).stdout;
  return typeof stdout === 'string' ? stdout : '';
}

export function nodeExec(): Exec {
  return async (command, args, { cwd }) => {
    try {
      const { stdout } = await execFileAsync(command, args, {
        cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
      });
      return { code: 0, stdout };
    } catch (error) {
      return { code: exitCode(error), stdout: capturedStdout(error) };
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function checkState(entry: unknown): CheckState {
  if (!isRecord(entry)) return 'none';
  const tokens = [entry.conclusion, entry.state, entry.status].flatMap((value) => {
    if (typeof value === 'string') return [value.toUpperCase()];
    return value === null ? [''] : [];
  });
  if (tokens.length === 0) return 'pending';
  if (tokens.some((token) => FAILURE_CHECKS.has(token))) return 'failing';
  if (tokens.some((token) => PENDING_CHECKS.has(token))) return 'pending';
  if (tokens.includes('SUCCESS')) return 'passing';
  return 'none';
}

function tallyChecks(rollup: unknown): CheckTally {
  const tally: CheckTally = { failing: 0, pending: 0, passing: 0 };
  if (!Array.isArray(rollup)) return tally;
  for (const entry of rollup) {
    const state = checkState(entry);
    if (state !== 'none') tally[state] += 1;
  }
  return tally;
}

function aggregateChecks(tally: CheckTally): PullRequestCheckState {
  if (tally.failing > 0) return 'failing';
  if (tally.pending > 0) return 'pending';
  if (tally.passing > 0) return 'passing';
  return 'none';
}

function checksSummary(tally: CheckTally): string | undefined {
  if (tally.failing > 0) return `${tally.failing} failing`;
  if (tally.pending > 0) return `${tally.pending} pending`;
  if (tally.passing === 1) return '1 check passed';
  if (tally.passing > 1) return `${tally.passing} checks passed`;
  return undefined;
}

function reviewState(value: unknown): PullRequestReviewState {
  switch (value) {
    case 'APPROVED': return 'approved';
    case 'CHANGES_REQUESTED': return 'changes-requested';
    case 'REVIEW_REQUIRED': return 'pending';
    default: return 'none';
  }
}

function pullRequestState(value: unknown): PullRequest['state'] {
  if (value === 'MERGED') return 'merged';
  if (value === 'CLOSED') return 'closed';
  return 'open';
}

function parseView(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toPullRequest(view: Record<string, unknown>, branch: string): PullRequest {
  const tally = tallyChecks(view.statusCheckRollup);
  const state = pullRequestState(view.state);
  return {
    number: count(view.number),
    title: text(view.title),
    url: text(view.url),
    branch: text(view.headRefName) || branch,
    base: text(view.baseRefName),
    additions: count(view.additions),
    deletions: count(view.deletions),
    changedFiles: count(view.changedFiles),
    checks: aggregateChecks(tally),
    checksSummary: checksSummary(tally),
    review: reviewState(view.reviewDecision),
    draft: view.isDraft === true,
    merged: state === 'merged',
    state,
  };
}

async function currentBranch(exec: Exec, cwd: string): Promise<string | undefined> {
  const result = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (result.code !== 0) return undefined;
  const branch = result.stdout.trim();
  return branch === '' || branch === 'HEAD' ? undefined : branch;
}

export function gitPullRequestReader(options: GitPullRequestReaderOptions = {}): PullRequestReader {
  const exec = options.exec ?? nodeExec();
  const gh = options.gh ?? 'gh';
  return {
    async read({ cwd, branch }) {
      const head = branch?.trim() || await currentBranch(exec, cwd);
      if (head === undefined) return undefined;
      const result = await exec(gh, ['pr', 'view', '--json', GH_FIELDS], { cwd });
      if (result.code !== 0) return undefined;
      const view = parseView(result.stdout);
      return view === undefined ? undefined : toPullRequest(view, head);
    },
  };
}

export function scriptedPullRequestReader(entries: Record<string, PullRequest>): ScriptedPullRequestReader {
  const known = new Map(Object.entries(entries).map(([key, pullRequest]) => [key, { ...pullRequest }]));
  const resolve = (input: { cwd: string; branch?: string }): PullRequest | undefined => {
    if (input.branch !== undefined) {
      const byBranch = known.get(input.branch);
      if (byBranch !== undefined) return byBranch;
    }
    return known.get(input.cwd);
  };
  return {
    async read(input) {
      const pullRequest = resolve(input);
      return pullRequest === undefined ? undefined : { ...pullRequest };
    },
    merge(branch) {
      const pullRequest = known.get(branch);
      if (pullRequest === undefined) return undefined;
      const merged: PullRequest = { ...pullRequest, merged: true, state: 'merged' };
      known.set(branch, merged);
      return { ...merged };
    },
  };
}

export function pullRequestPlugin(options: PullRequestPluginOptions): Plugin {
  return {
    name: 'pull-requests',
    apply(ctx) {
      ctx.provide('pullRequests', options.reader);
    },
  };
}
