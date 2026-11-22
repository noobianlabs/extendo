import { spawn } from 'node:child_process';
import type { ToolCtx } from '@extendo/contracts';

const MAX_OUTPUT = 65_536;
const forwarded = new Set(['PATH', 'HOME', 'USER', 'USERPROFILE', 'SYSTEMROOT', 'COMSPEC', 'SHELL', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']);

export async function runShell(command: string, cwd: string, timeoutMs: number, { signal }: ToolCtx) {
  signal.throwIfAborted();
  const posix = process.platform !== 'win32';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => forwarded.has(key.toUpperCase())));
  return new Promise<{ command: string; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean }>((resolve, reject) => {
    const child = spawn(command, [], { cwd, env, shell: true, detached: posix, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let remaining = MAX_OUTPUT;
    let truncated = false;
    let timedOut = false;
    let killed = false;
    let escalation: NodeJS.Timeout | undefined;

    const kill = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (posix) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error); }
    };
    const stop = () => {
      if (killed) return;
      killed = true;
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 350);
      escalation.unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      if (escalation) { clearTimeout(escalation); kill('SIGKILL'); }
      signal.removeEventListener('abort', stop);
    };
    const capture = (chunks: Buffer[], chunk: Buffer) => {
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) {
        const slice = chunk.subarray(0, remaining);
        chunks.push(slice);
        remaining -= slice.length;
      }
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.once('error', (error) => { finish(); reject(error); });
    child.stdout.on('data', (data: Buffer) => capture(out, data));
    child.stderr.on('data', (data: Buffer) => capture(err, data));
    child.once('close', (exitCode) => {
      finish();
      if (signal.aborted) { reject(signal.reason); return; }
      resolve({ command, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exitCode, timedOut, truncated });
    });
  });
}
