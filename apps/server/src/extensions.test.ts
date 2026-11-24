import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Registry, Tool } from '@extendo/contracts';
import { capabilitiesPlugin } from '@extendo/agent';
import { Context, PluginLoader } from '@extendo/kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExtensionWorkshop, extensionId, templateFor, toolName } from './extensions.js';

let directory: string;
let ctx: Context;
let loader: PluginLoader;
let workshop: ExtensionWorkshop;

const toolNames = () => ctx.get<Registry<Tool>>('tools').list().map(({ name }) => name);

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'extendo-plugins-'));
  ctx = new Context();
  loader = new PluginLoader(ctx);
  await loader.mount(capabilitiesPlugin());
  workshop = new ExtensionWorkshop({ dir: join(directory, 'plugins'), loader, ctx });
});

afterEach(() => {
  loader.dispose();
  rmSync(directory, { recursive: true, force: true });
});

describe('plugin workshop', () => {
  it('writes an authored plugin to disk and mounts its tool into the live registry', async () => {
    const extension = await workshop.create({ name: 'Word count' });

    expect(extension.id).toBe('word-count');
    expect(extension.error).toBeUndefined();
    expect(extension.tools.map(({ name }) => name)).toEqual(['word_count']);
    expect(toolNames()).toContain('word_count');
    expect(readFileSync(join(directory, 'plugins', 'word-count', 'index.mjs'), 'utf8')).toBe(templateFor('Word count'));
    expect(workshop.list().mounts).toEqual([{ id: 'word-count', at: extension.mountedAt, revision: 1, tools: ['word_count'] }]);

    const tool = ctx.get<Registry<Tool>>('tools').get('word_count')!;
    await expect(tool.execute({ text: 'the seam is the product' }, {} as never)).resolves.toMatchObject({ words: 5 });
  });

  it('hot-swaps a saved revision so the next request sees the new tool, not the old one', async () => {
    await workshop.create({ name: 'Word count' });
    const source = templateFor('Word count').replaceAll('word_count', 'word_total');

    const saved = await workshop.save('word-count', source);

    expect(saved.extension.revision).toBe(2);
    expect(saved.extension.tools.map(({ name }) => name)).toEqual(['word_total']);
    expect(toolNames()).toContain('word_total');
    expect(toolNames()).not.toContain('word_count');
    expect(workshop.list().mounts.map(({ revision }) => revision)).toEqual([1, 2]);
  });

  it('keeps attributing a tool when a save only changes its body', async () => {
    await workshop.create({ name: 'Word count' });
    const same = templateFor('Word count').replace('Count the words', 'Count every word');

    const saved = await workshop.save('word-count', same);

    expect(saved.extension.error).toBeUndefined();
    expect(saved.extension.tools.map(({ name }) => name)).toEqual(['word_count']);
    expect(saved.extension.tools[0]?.description).toMatch(/Count every word/);
    expect(workshop.tools().find(({ name }) => name === 'word_count')?.extensionId).toBe('word-count');
  });

  it('keeps the running revision when a new one does not parse', async () => {
    await workshop.create({ name: 'Word count' });

    const saved = await workshop.save('word-count', 'export default ({');

    expect(saved.extension.error).toBeTruthy();
    expect(toolNames()).toContain('word_count');
    expect(readFileSync(join(directory, 'plugins', 'word-count', 'index.mjs'), 'utf8')).toBe(templateFor('Word count'));
  });

  it('keeps the running revision when a new one fails while mounting', async () => {
    await workshop.create({ name: 'Word count' });
    await workshop.create({ name: 'Second' });
    const collision = templateFor('Second').replaceAll('second', 'word_count');

    const saved = await workshop.save('second', collision);

    expect(saved.extension.error).toMatch(/Already registered/);
    expect(toolNames().filter((name) => name === 'word_count')).toHaveLength(1);
    expect(toolNames()).toContain('second');
    expect(workshop.list().extensions.find(({ id }) => id === 'second')?.tools.map(({ name }) => name)).toEqual(['second']);
  });

  it('retries a revision number that already failed, instead of replaying the cached failure', async () => {
    await workshop.create({ name: 'Word count' });
    await workshop.save('word-count', 'export default ({');
    const repaired = await workshop.save('word-count', templateFor('Word count').replaceAll('word_count', 'word_tally'));

    expect(repaired.extension.error).toBeUndefined();
    expect(toolNames()).toContain('word_tally');
  });

  it('mounts plugins from disk on the next start', async () => {
    await workshop.create({ name: 'Word count' });

    const restarted = new Context();
    const restartedLoader = new PluginLoader(restarted);
    await restartedLoader.mount(capabilitiesPlugin());
    const next = new ExtensionWorkshop({ dir: join(directory, 'plugins'), loader: restartedLoader, ctx: restarted });
    await next.mountInstalled();

    expect(restarted.get<Registry<Tool>>('tools').list().map(({ name }) => name)).toContain('word_count');
    expect(next.list().extensions[0]?.name).toBe('Word count');
    restartedLoader.dispose();
  });

  it('never leaves broken code on disk when a save fails', async () => {
    await workshop.create({ name: 'Word count' });
    await workshop.save('word-count', 'export default () => { throw new Error("boom") }');

    expect(readFileSync(join(directory, 'plugins', 'word-count', 'index.mjs'), 'utf8')).toBe(templateFor('Word count'));
  });

  it('reports a plugin that broke outside the app without failing the boot', async () => {
    await workshop.create({ name: 'Word count' });
    const folder = join(directory, 'plugins', 'word-count');
    const manifest = JSON.parse(readFileSync(join(folder, 'plugin.json'), 'utf8')) as { revision: number };
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ ...manifest, revision: manifest.revision + 1 }));
    writeFileSync(join(folder, 'index.mjs'), 'export default () => { throw new Error("boom") }');

    const restarted = new Context();
    const restartedLoader = new PluginLoader(restarted);
    await restartedLoader.mount(capabilitiesPlugin());
    const next = new ExtensionWorkshop({ dir: join(directory, 'plugins'), loader: restartedLoader, ctx: restarted });
    await expect(next.mountInstalled()).resolves.toBeUndefined();

    expect(next.list().extensions[0]?.error).toMatch(/boom/);
    restartedLoader.dispose();
  });

  it('attributes each live tool to the plugin that added it', async () => {
    await workshop.create({ name: 'Word count' });
    const builtin: Tool = {
      name: 'builtin_probe', description: 'Ships with Extendo.', input: {} as never, readOnly: true,
      execute: async () => ({}),
    };
    ctx.get<Registry<Tool>>('tools').register(ctx, builtin.name, builtin);

    const tools = workshop.tools();

    expect(tools.find(({ name }) => name === 'word_count')?.extensionId).toBe('word-count');
    expect(tools.find(({ name }) => name === 'builtin_probe')?.extensionId).toBeUndefined();
  });

  it('unmounts and deletes a plugin', async () => {
    await workshop.create({ name: 'Word count' });

    const state = workshop.remove('word-count');

    expect(state.extensions).toEqual([]);
    expect(toolNames()).not.toContain('word_count');
    expect(existsSync(join(directory, 'plugins', 'word-count'))).toBe(false);
  });

  it('slugs names safely and keeps ids unique', async () => {
    expect(extensionId('Word count')).toBe('word-count');
    expect(extensionId('  Étude — nº 2! ')).toBe('tude-n-2');
    expect(toolName('Word count')).toBe('word_count');
    expect(extensionId('文字化け')).toMatch(/^plugin-[0-9a-f]{8}$/);
    expect(toolName('文字化け')).toMatch(/^plugin_[0-9a-f]{8}$/);
    const first = await workshop.create({ name: 'Word count' });
    const second = await workshop.create({ name: 'Word count' });
    expect(second.id).toBe('word-count-2');
    expect(first.id).not.toBe(second.id);
    expect(second.error).toMatch(/Already registered: word_count/);
    expect(toolNames().filter((name) => name === 'word_count')).toHaveLength(1);
  });
});
