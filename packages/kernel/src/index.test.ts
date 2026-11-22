import { describe, expect, it } from 'vitest';
import { composeProfile, Context, dumpConfig, PluginLoader, profileEntries } from './index.js';

describe('kernel', () => {
  it('mounts shared services, rebinds injected effects, and unloads registrations', async () => {
    const loader = new PluginLoader();
    const values: string[] = [];
    await loader.mount({ name: 'consumer', apply(ctx) {
      return ctx.inject(['tools'], (scope) => {
        const value = scope.get<string>('tools');
        scope.on('tools/register', ({ name }) => { values.push(value + name); });
        return () => { values.push('cleanup ' + value); };
      });
    } });
    const mount = (value: string) => loader.mount({ name: 'tools', apply(ctx) { ctx.provide('tools', value); } });
    await mount('a');
    loader.ctx.emit('tools/register', { name: 'first' });
    loader.unmount('tools');
    loader.ctx.emit('tools/register', { name: 'ignored' });
    await mount('b');
    loader.ctx.emit('tools/register', { name: 'second' });
    loader.unmount('consumer');
    expect(values).toEqual(['afirst', 'cleanup a', 'bsecond', 'cleanup b']);
    loader.dispose();
  });

  it('isolates fork-local capabilities and unwinds child effects in reverse order', () => {
    const ctx = new Context();
    const child = ctx.fork('thread');
    const sibling = ctx.fork('other');
    const observed: string[] = [];
    ctx.provide('cwd', 'root');
    child.provide('cwd', 'child');
    child.effect(() => () => { observed.push('first'); });
    child.effect(() => () => { observed.push('second'); });
    ctx.on('tools/register', ({ name }) => { observed.push('root ' + name); });
    child.on('tools/register', ({ name }) => { observed.push('child ' + name); });
    child.emit('tools/register', { name: 'one' });
    sibling.emit('tools/register', { name: 'two' });
    expect(child.get('cwd')).toBe('child');
    expect(sibling.get('cwd')).toBe('root');
    ctx.dispose();
    expect(observed).toEqual(['root one', 'child one', 'root two', 'second', 'first']);
    expect(() => child.get('cwd')).toThrow('disposed');
  });

  it('awaits serial hooks and composes delegated waterfalls around the fallback', async () => {
    const ctx = new Context();
    const order: string[] = [];
    ctx.on('tools/register', async () => { await Promise.resolve(); order.push('first'); });
    ctx.on('tools/register', () => { order.push('second'); });
    await ctx.serial('tools/register', { name: 'sample' });
    expect(order).toEqual(['first', 'second']);

    const seed = { turnId: 't', stepId: 's', sessionId: 'session', input: '' };
    ctx.onWaterfall('agent/pre-step', async (value, next) => {
      const result = await next({ ...value, input: 'a' });
      return { ...result, input: result.input + 'd' };
    });
    const second = ctx.onWaterfall('agent/pre-step', (value, next) => next({ ...value, input: value.input + 'b' }));
    const fallback = (value: typeof seed) => ({ ...value, input: value.input + 'c' });
    const run = () => ctx.waterfall('agent/pre-step', seed, (value) => fallback({ ...value, input: value.input ?? '' }));
    expect((await run()).input).toBe('abcd');
    second();
    ctx.onWaterfall('agent/pre-step', (value) => ({ ...value, skip: true }));
    expect(await run()).toMatchObject({ input: 'ad', skip: true });
    ctx.dispose();
  });

  it('rolls back a failed mount batch without unmounting pre-existing plugins', async () => {
    const loader = new PluginLoader();
    await loader.mount({ name: 'one', apply(ctx) { ctx.provide('one', 1); } });
    await expect(loader.mountAll([
      { name: 'two', apply(ctx) { ctx.provide('two', 2); } },
      { name: 'bad', apply(ctx) { ctx.provide('bad', true); throw new Error('failed'); } },
    ])).rejects.toThrow('failed');
    expect(loader.ctx.has('bad')).toBe(false);
    expect(loader.ctx.has('two')).toBe(false);
    expect(loader.ctx.get('one')).toBe(1);
    loader.dispose();
  });

  it('replaces complete rows in order before mounting the composed profile', async () => {
    const profile = {
      name: 'web',
      bundles: [
        { name: 'core', rows: [{ id: 'agent', plugin: 'agent', config: { a: 1, b: 2 } }, { id: 'old', plugin: 'old' }] },
        { name: 'web', rows: [{ id: 'server', plugin: 'server' }] },
      ],
      patches: [[{ id: 'agent', plugin: 'different', config: { b: 3 } }, { id: 'old', remove: true as const }]],
    };
    expect(composeProfile(profile)).toEqual([{ id: 'agent', plugin: 'different', config: { b: 3 } }, { id: 'server', plugin: 'server' }]);
    expect(JSON.parse(dumpConfig(profile)).plugins).toEqual(composeProfile(profile));
    const loader = new PluginLoader();
    await loader.mountEntries(profileEntries(profile, new Map([
      ['different', (config) => ({ name: 'different', apply(ctx) { ctx.provide('config', config); } })],
      ['server', () => ({ name: 'server', apply(ctx) { ctx.provide('server', true); } })],
    ])));
    expect(loader.ctx.get('config')).toEqual({ b: 3 });
    expect(loader.unmount('agent')).toBe(true);
    expect(loader.ctx.has('config')).toBe(false);
    loader.dispose();
  });
});
