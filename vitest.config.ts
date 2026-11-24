import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      ['contracts', 'kernel', 'session', 'agent', 'providers', 'tools', 'pullrequests', 'server', 'plugin-sdk'].flatMap((name) => {
        const path = fileURLToPath(new URL(`./${name === 'server' ? 'apps' : 'packages'}/${name}/src/index.ts`, import.meta.url));
        return existsSync(path) ? [[`@extendo/${name}`, path]] : [];
      }),
    ),
  },
  test: { include: ['packages/*/src/**/*.test.ts', 'apps/server/src/**/*.test.ts', 'apps/web/src/**/*.test.ts', 'examples/*/src/**/*.test.ts'] },
});
