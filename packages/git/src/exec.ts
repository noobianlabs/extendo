import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (command: string, args: string[], options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<CommandResult>;

/** Variables that would point git at a different repository or hang it on a credential prompt. */
const SCRUBBED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'];

function environment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of SCRUBBED) delete env[key];
  env.GIT_TERMINAL_PROMPT ??= '0';
  env.GIT_OPTIONAL_LOCKS ??= '0';
  return env;
}

function exitCode(error: unknown): number {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' && Number.isInteger(code)) return code;
  return code === 'ENOENT' ? 127 : 1;
}

function stream(error: unknown, key: 'stdout' | 'stderr'): string {
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Runs a command without a shell and without the terminal prompts that would hang a background
 * server: git can never ask for a password through Extendo, it fails and says so.
 */
export function nodeExec(): Exec {
  return async (command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env }) => {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, timeout: timeoutMs,
        windowsHide: true, env: environment(env),
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: exitCode(error), stdout: stream(error, 'stdout'), stderr: stream(error, 'stderr') };
    }
  };
}

/** True when the binary is missing entirely, so the UI can say "git is not installed" rather than guess. */
export function missingBinary(result: CommandResult): boolean {
  return result.code === 127 && result.stdout.trim() === '' && result.stderr.trim() === '';
}
