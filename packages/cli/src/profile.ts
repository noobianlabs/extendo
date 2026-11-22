import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JsonValue, Plugin } from '@extendo/contracts';
import type { PluginCatalog, Profile, ProfilePatch } from '@extendo/kernel';
import { defaultProfile, type RuntimeMode } from '@extendo/server';
import { z } from 'zod';

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const names = z.array(z.string().regex(packageName));
const json: z.ZodType<JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(json), z.record(z.string(), json)]));
const rows = z.array(z.union([
  z.object({ id: z.string().min(1), remove: z.literal(true) }).strict(),
  z.object({ id: z.string().min(1), plugin: z.string().min(1), config: json.optional(), enabled: z.boolean().optional() }).strict(),
]));

function data(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Could not read JSON configuration: ${path}`); }
}

function extensionPaths(dataDir: string) {
  const dir = join(dataDir, 'extensions');
  return { dir, active: join(dir, 'active.json') };
}

function activePackages(file: string): string[] {
  return existsSync(file) ? names.parse(data(file)) : [];
}

export function loadProfile(mode: RuntimeMode, dataDir: string, overlays: string[]): Profile {
  const { active } = extensionPaths(dataDir);
  const profile = defaultProfile(mode);
  const user = join(dataDir, 'profile.json');
  const activation: ProfilePatch[] = activePackages(active).map((name) => ({ id: name, plugin: name }));
  const patches = [user, ...overlays].filter((path) => path !== user || existsSync(path)).map((path) => rows.parse(data(path)));
  return { ...profile, bundles: [...profile.bundles, { name: 'extensions', rows: activation }], patches };
}

export async function extensionCatalog(dataDir: string, namesToLoad: readonly string[]): Promise<PluginCatalog> {
  const { dir, active } = extensionPaths(dataDir);
  const configured = new Set(activePackages(active));
  const entries = new Map<string, (config: JsonValue | undefined) => Plugin>();
  for (const name of namesToLoad) {
    if (!configured.has(name) || entries.has(name)) continue;
    const root = realpathSync(join(dir, 'node_modules', name));
    const manifest = z.object({ extendo: z.object({ server: z.string().min(1) }) }).parse(data(join(root, 'package.json')));
    const entry = realpathSync(join(root, manifest.extendo.server));
    const inside = relative(root, entry);
    if (isAbsolute(inside) || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\')) {
      throw new Error(`Plugin entry must be inside its package: ${name}`);
    }
    const module: { default?: unknown } = await import(pathToFileURL(entry).href);
    const shape = (value: unknown): Plugin => {
      if (!value || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string' || !('apply' in value) || typeof value.apply !== 'function') {
        throw new Error(`Invalid Extendo plugin export: ${name}`);
      }
      return value as Plugin;
    };
    const entryPoint = module.default;
    entries.set(name, typeof entryPoint === 'function' ? (config) => shape(entryPoint(config)) : () => shape(entryPoint));
  }
  return entries;
}

export async function addPlugin(dataDir: string, name: string) {
  if (!packageName.test(name)) throw new Error('Expected a bare npm package name');
  const { dir, active } = extensionPaths(dataDir);
  const installed = activePackages(active);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const packageJson = join(dir, 'package.json');
  if (!existsSync(packageJson)) writeFileSync(packageJson, '{"name":"extendo-user-extensions","private":true}\n', { mode: 0o600 });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['add', '--ignore-scripts', '--save-exact', name], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('pnpm could not install the plugin')));
  });
  const manifest = join(dir, 'node_modules', name, 'package.json');
  z.object({ extendo: z.object({ server: z.string().min(1) }) }).parse(data(manifest));
  mkdirSync(dirname(active), { recursive: true });
  writeFileSync(active + '.tmp', JSON.stringify([...new Set([...installed, name])], null, 2) + '\n', { mode: 0o600 });
  renameSync(active + '.tmp', active);
}
