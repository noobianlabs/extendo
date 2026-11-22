import { capabilitiesPlugin } from '@extendo/agent';
import { PluginLoader, Context } from '@extendo/kernel';
import type { Command, Registry, Tool } from '@extendo/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import plugin from './index.js';

describe('hello plugin', () => {
  it('mounts through the loader and removes its tool and command on unload', async () => {
    const info = vi.fn();
    const ctx = new Context({ info, debug: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const loader = new PluginLoader(ctx);
    await loader.mountAll([capabilitiesPlugin(), plugin]);
    const tools = ctx.get<Registry<Tool>>('tools');
    const commands = ctx.get<Registry<Command>>('commands');
    expect(tools.get('hello')?.input.parse({ name: ' Lin ' })).toEqual({ name: 'Lin' });
    await commands.get('hello')?.run(['Lin']);
    expect(info).toHaveBeenCalledWith('Hello, Lin.');
    expect(loader.unmount('hello')).toBe(true);
    expect(tools.get('hello')).toBeUndefined();
    expect(commands.get('hello')).toBeUndefined();
    loader.dispose();
  });
});
