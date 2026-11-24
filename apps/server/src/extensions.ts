import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Ctx, Extension, ExtensionMount, ExtensionState, ExtensionToolInfo, LiveTool, Logger, Plugin, Registry, Tool,
} from '@extendo/contracts';
import type { PluginLoader } from '@extendo/kernel';
import { z } from 'zod';

/** What an authored plugin file receives instead of importing the workspace packages. */
export interface ExtensionSdk {
  z: typeof z;
  tool<I>(definition: Tool<I>): Tool<I>;
  definePlugin(plugin: Plugin): Plugin;
}

const manifestSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(400).default(''),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const mountsSchema = z.array(z.object({
  id: z.string(),
  at: z.string(),
  revision: z.number().int().positive(),
  tools: z.array(z.string()),
}));

const mountPrefix = 'authored:';
const reserved = new Set(['tool', 'z', 'ctx', 'sdk', 'plugin', 'export', 'default', 'const', 'let', 'var', 'await']);

/** A stable id for a name. A name with no Latin letters falls back to a digest, so ids stay distinct. */
export function extensionId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'plugin-' + createHash('sha1').update(name).digest('hex').slice(0, 8);
}

export function toolName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return slug || 'plugin_' + createHash('sha1').update(name).digest('hex').slice(0, 8);
}

function binding(name: string): string {
  const camel = name.toLowerCase().replace(/[^a-z0-9]+(.)?/g, (_, next: string | undefined) => next?.toUpperCase() ?? '')
    .replace(/^[0-9]/, '');
  const safe = camel || 'capability';
  return reserved.has(safe) ? safe + 'Capability' : safe;
}

/** The starting point a new plugin opens with: one read-only tool, no imports, nothing to install. */
export function templateFor(name: string): string {
  const tool = toolName(name);
  return `// A plugin is a factory. It receives the Extendo SDK and returns a plugin.
// Save it and it mounts into the running app: its tool joins the model's tool
// list on the next request, and you can watch the agent call it in this thread.

export default ({ tool, z }) => ({
  name: ${JSON.stringify(name)},
  apply(ctx) {
    const ${binding(name)} = tool({
      name: '${tool}',
      description: 'Count the words and characters in a piece of text.',
      input: z.object({ text: z.string().min(1).max(20000) }),
      readOnly: true,
      async execute({ text }) {
        const words = text.trim().split(/\\s+/).filter(Boolean);
        return {
          words: words.length,
          characters: text.length,
          longest: words.reduce((longest, word) => (word.length > longest.length ? word : longest), ''),
        };
      },
    });
    ctx.get('tools').register(ctx, ${binding(name)}.name, ${binding(name)});
    ctx.emit('tools/register', { name: ${binding(name)}.name });
  },
});
`;
}

function describe(tool: Tool): ExtensionToolInfo {
  return {
    name: tool.name,
    description: tool.description,
    readOnly: tool.readOnly ?? false,
    needsApproval: tool.needsApproval ?? !(tool.readOnly ?? false),
  };
}

function message(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message + (error.cause instanceof Error ? `: ${error.cause.message}` : '');
}

function assertPlugin(value: unknown, fallback: string): Plugin {
  if (!value || typeof value !== 'object') {
    throw new Error('The plugin file must export default a plugin, or a factory that returns one.');
  }
  const candidate = value as Partial<Plugin>;
  if (typeof candidate.apply !== 'function') throw new Error('The plugin needs an apply(ctx) function.');
  const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : fallback;
  return { ...candidate, name } as Plugin;
}

export interface ExtensionWorkshopOptions {
  dir: string;
  loader: PluginLoader;
  ctx: Ctx;
  logger?: Logger;
}

/**
 * Authored plugins on disk, mounted into the running kernel. Saving a plugin writes the file,
 * imports it as a fresh module, and swaps it into the loader, so its tools join the model's tool
 * list on the very next request. A revision that fails to load never takes down the one running.
 */
export class ExtensionWorkshop {
  private readonly records = new Map<string, Extension>();
  private readonly mounts: ExtensionMount[] = [];
  private readonly mounted = new Set<string>();
  private readonly counters = new Map<string, number>();
  private readonly ctx: Ctx;
  private readonly loader: PluginLoader;
  private readonly logger?: Logger;

  constructor(private readonly options: ExtensionWorkshopOptions) {
    this.ctx = options.ctx;
    this.loader = options.loader;
    this.logger = options.logger;
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    this.read();
  }

  private get dir(): string {
    return this.options.dir;
  }

  private dirFor(id: string): string {
    return join(this.dir, id);
  }

  private fileFor(id: string): string {
    return join(this.dirFor(id), 'index.mjs');
  }

  private manifestFor(id: string): string {
    return join(this.dirFor(id), 'plugin.json');
  }

  private mountId(id: string): string {
    return mountPrefix + id;
  }

  private read(): void {
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = manifestSchema.parse(JSON.parse(readFileSync(this.manifestFor(entry.name), 'utf8')));
        const source = readFileSync(this.fileFor(entry.name), 'utf8');
        this.records.set(entry.name, { id: entry.name, ...manifest, source, tools: [] });
        this.counters.set(entry.name, manifest.revision);
      } catch (error) {
        this.logger?.warn(`Skipped an unreadable plugin folder (${entry.name}): ${message(error)}`);
      }
    }
    const log = join(this.dir, 'mounts.jsonl');
    if (!existsSync(log)) return;
    try {
      const entries = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
      this.mounts.push(...mountsSchema.parse(entries).slice(-200));
    } catch (error) {
      this.logger?.warn(`Skipped an unreadable mount log: ${message(error)}`);
    }
  }

  private write(record: Extension): void {
    mkdirSync(this.dirFor(record.id), { recursive: true, mode: 0o700 });
    writeFileSync(this.fileFor(record.id), record.source, { mode: 0o600 });
    const { name, description, revision, createdAt, updatedAt } = record;
    const manifest = { name, description, revision, createdAt, updatedAt };
    writeFileSync(this.manifestFor(record.id), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  }

  /** Revisions only ever move forward, so a module URL is never reused after a failed save. */
  private nextRevision(id: string): number {
    const revision = (this.counters.get(id) ?? 0) + 1;
    this.counters.set(id, revision);
    return revision;
  }

  private sdk(): ExtensionSdk {
    return {
      z,
      tool: (definition) => definition,
      definePlugin: (plugin) => {
        if (!plugin.name.trim()) throw new Error('Plugin name must not be empty');
        return plugin;
      },
    };
  }

  private async instantiate(record: Extension): Promise<Plugin> {
    const url = `${pathToFileURL(this.fileFor(record.id)).href}?revision=${record.revision}`;
    const module: { default?: unknown } = await import(url);
    const exported = module.default;
    if (exported === undefined) throw new Error('The plugin file has no default export.');
    const plugin = typeof exported === 'function' ? await (exported as (sdk: ExtensionSdk) => unknown)(this.sdk()) : exported;
    return assertPlugin(plugin, record.name);
  }

  private registry(): Registry<Tool> {
    return this.ctx.get<Registry<Tool>>('tools');
  }

  private recordMount(record: Extension, tools: string[]): void {
    const mount: ExtensionMount = { id: record.id, at: record.mountedAt ?? new Date().toISOString(), revision: record.revision, tools };
    this.mounts.push(mount);
    if (this.mounts.length > 200) this.mounts.splice(0, this.mounts.length - 200);
    try {
      appendFileSync(join(this.dir, 'mounts.jsonl'), JSON.stringify(mount) + '\n', { mode: 0o600 });
    } catch (error) {
      this.logger?.warn(`Could not append to the mount log: ${message(error)}`);
    }
  }

  /** Mounts a plugin, replacing whatever this id had mounted before. */
  private async mount(record: Extension, plugin?: Plugin): Promise<void> {
    const registry = this.registry();
    const before = new Set(registry.list().map(({ name }) => name));
    this.loader.unmount(this.mountId(record.id));
    this.mounted.delete(record.id);
    await this.loader.mount(plugin ?? await this.instantiate(record), this.mountId(record.id));
    this.mounted.add(record.id);
    const tools = registry.list().filter(({ name }) => !before.has(name));
    record.tools = tools.map(describe);
    record.mountedAt = new Date().toISOString();
    record.error = undefined;
    this.recordMount(record, record.tools.map(({ name }) => name));
  }

  /** Mounts every plugin already on disk. A broken one is reported, never fatal. */
  async mountInstalled(): Promise<void> {
    for (const record of this.records.values()) {
      try {
        await this.mount(record);
      } catch (error) {
        record.error = message(error);
        this.logger?.warn(`Plugin ${record.id} did not load: ${record.error}`);
      }
    }
  }

  list(): ExtensionState {
    const extensions = [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { extensions, mounts: [...this.mounts] };
  }

  get(id: string): Extension | undefined {
    return this.records.get(id);
  }

  /** Every tool the model is offered on the next request, attributed to the plugin that added it. */
  tools(): LiveTool[] {
    const owner = new Map<string, string>();
    for (const record of this.records.values()) for (const tool of record.tools) owner.set(tool.name, record.id);
    return this.registry().list().map((tool) => ({ ...describe(tool), extensionId: owner.get(tool.name) }));
  }

  async create(input: { name: string; description?: string; source?: string }): Promise<Extension> {
    const name = input.name.trim();
    if (!name) throw new Error('Give the plugin a name');
    let id = extensionId(name);
    for (let suffix = 2; this.records.has(id); suffix++) id = `${extensionId(name)}-${suffix}`;
    const now = new Date().toISOString();
    const record: Extension = {
      id, name, description: input.description?.trim() ?? '',
      source: input.source ?? templateFor(name),
      revision: this.nextRevision(id), createdAt: now, updatedAt: now, tools: [],
    };
    this.write(record);
    this.records.set(id, record);
    try {
      await this.mount(record);
    } catch (error) {
      record.error = message(error);
    }
    return record;
  }

  /** Writes a new revision and hot-swaps it. The previous revision keeps running if the new one fails. */
  async save(id: string, source: string): Promise<{ extension: Extension; state: ExtensionState }> {
    const current = this.records.get(id);
    if (!current) throw new Error('Unknown plugin');
    const wasMounted = this.mounted.has(id);
    const next: Extension = {
      ...current, source, revision: this.nextRevision(id), updatedAt: new Date().toISOString(), error: undefined,
    };
    this.write(next);
    this.records.set(id, next);
    let plugin: Plugin;
    try {
      plugin = await this.instantiate(next);
    } catch (error) {
      this.write(current);
      const failed: Extension = { ...current, error: message(error) };
      this.records.set(id, failed);
      return { extension: failed, state: this.list() };
    }
    try {
      await this.mount(next, plugin);
    } catch (error) {
      this.write(current);
      const failed: Extension = { ...current, error: message(error) };
      this.records.set(id, failed);
      if (wasMounted) {
        try { await this.mount(current); }
        catch (restore) { this.logger?.error(`Could not restore plugin ${id}: ${message(restore)}`); }
      }
      return { extension: failed, state: this.list() };
    }
    return { extension: next, state: this.list() };
  }

  remove(id: string): ExtensionState {
    const record = this.records.get(id);
    if (!record) throw new Error('Unknown plugin');
    this.loader.unmount(this.mountId(id));
    this.mounted.delete(id);
    this.records.delete(id);
    this.counters.delete(id);
    rmSync(this.dirFor(id), { recursive: true, force: true });
    return this.list();
  }
}
