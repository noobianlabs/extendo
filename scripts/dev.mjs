import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const options = { cwd, stdio: 'inherit', shell: process.platform === 'win32' };
const build = spawn('pnpm', ['-r', '--filter', '!@extendo/web', 'run', 'build'], options);
const stopBuild = () => build.kill('SIGTERM');
process.once('SIGINT', stopBuild);
process.once('SIGTERM', stopBuild);
build.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
build.once('exit', (code) => {
  process.off('SIGINT', stopBuild);
  process.off('SIGTERM', stopBuild);
  if (code !== 0) { process.exitCode = code ?? 1; return; }
  const api = spawn(process.execPath, ['packages/cli/dist/index.js', 'web', '--no-open'], options);
  const web = spawn(process.execPath, ['apps/web/node_modules/vite/bin/vite.js', 'apps/web'], options);
  const stop = () => {
    api.kill('SIGTERM');
    web.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  for (const child of [api, web]) {
    child.once('error', (error) => { console.error(error.message); process.exitCode = 1; stop(); });
    child.once('exit', (code) => { if (code) process.exitCode = code; stop(); });
  }
});
