import type { Ctx, Disposable, Events, Listener, Logger, Plugin, Registry, WaterfallListener, Waterfalls } from '@extendo/contracts';
export * from './profile.js';

export function createRegistry<T>(): Registry<T> {
  const entries = new Map<string, T>();
  return {
    register(owner, key, value) {
      return owner.effect(() => {
        if (entries.has(key)) throw new Error(`Already registered: ${key}`);
        entries.set(key, value);
        return () => { entries.delete(key); };
      });
    },
    get: (key) => entries.get(key),
    list: () => [...entries.values()],
  };
}

type Service = { value: unknown };
type Registration = { callback: unknown };
type Injection = { refresh(): void };

class Realm {
  readonly services = new Map<string, Service>();
  readonly events = new Map<keyof Events, Set<Registration>>();
  readonly waterfalls = new Map<keyof Waterfalls, Set<Registration>>();

  constructor(readonly parent?: Realm) {}

  lookup(key: string): Service | undefined {
    return this.services.get(key) ?? this.parent?.lookup(key);
  }
}

const defaultLogger: Logger = {
  debug: () => {},
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

function unwind(disposers: Disposable[]): void {
  const failures: unknown[] = [];
  for (const dispose of disposers.reverse()) {
    try { dispose(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Disposal failed');
}

export class Context implements Ctx {
  private readonly effects = new Set<Disposable>();
  private readonly injections: Set<Injection>;
  private active = true;

  constructor(
    readonly logger: Logger = defaultLogger,
    private readonly realm = new Realm(),
    injections?: Set<Injection>,
  ) {
    this.injections = injections ?? new Set();
  }

  private assertActive(): void {
    if (!this.active) throw new Error('Context is disposed');
  }

  private refresh(): void {
    const failures: unknown[] = [];
    for (const injection of [...this.injections]) {
      try { injection.refresh(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Dependency injection failed');
  }

  provide<T>(key: string, value: T): Disposable {
    this.assertActive();
    if (this.realm.services.has(key)) throw new Error(`Service already provided: ${key}`);
    this.realm.services.set(key, { value });
    const dispose = this.effect(() => () => {
      this.realm.services.delete(key);
      this.refresh();
    });
    try {
      this.refresh();
    } catch (error) {
      try { dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], `Failed to provide ${key}`); }
      throw error;
    }
    return dispose;
  }

  get<T>(key: string): T {
    this.assertActive();
    const service = this.realm.lookup(key);
    if (!service) throw new Error(`Missing service: ${key}`);
    return service.value as T;
  }

  has(key: string): boolean {
    return this.active && this.realm.lookup(key) !== undefined;
  }

  inject(keys: readonly string[], apply: (ctx: Ctx) => void | Disposable): Disposable {
    this.assertActive();
    let previous: readonly (Service | undefined)[] | undefined;
    let scope: Context | undefined;
    const injection: Injection = {
      refresh: () => {
        if (!this.injections.has(injection) || !this.active) return;
        const next = keys.map((key) => this.realm.lookup(key));
        if (previous && next.every((service, index) => service === previous?.[index])) return;
        previous = next;
        scope?.dispose();
        scope = undefined;
        if (next.some((service) => service === undefined)) return;
        const child = this.child(this.realm);
        scope = child;
        try { child.effect(() => apply(child)); }
        catch (error) {
          child.dispose();
          scope = undefined;
          throw error;
        }
      },
    };
    const dispose = this.effect(() => {
      this.injections.add(injection);
      return () => {
        this.injections.delete(injection);
        scope?.dispose();
      };
    });
    try { injection.refresh(); }
    catch (error) { dispose(); throw error; }
    return dispose;
  }

  private listen<K>(listeners: Map<K, Set<Registration>>, key: K, callback: unknown): Disposable {
    return this.effect(() => {
      const entries = listeners.get(key) ?? new Set<Registration>();
      listeners.set(key, entries);
      const entry = { callback };
      entries.add(entry);
      return () => {
        entries.delete(entry);
        if (!entries.size) listeners.delete(key);
      };
    });
  }

  private listeners<K, T>(key: K, select: (realm: Realm) => Map<K, Set<Registration>>): T[] {
    const lineage: Realm[] = [];
    for (let realm: Realm | undefined = this.realm; realm; realm = realm.parent) lineage.unshift(realm);
    return lineage.flatMap((realm) => [...(select(realm).get(key) ?? [])].map(({ callback }) => callback as T));
  }

  on<K extends keyof Events>(key: K, listener: Listener<Events[K]>): Disposable {
    return this.listen(this.realm.events, key, listener);
  }

  emit<K extends keyof Events>(key: K, payload: Events[K]): void {
    this.assertActive();
    const report = (error: unknown) => this.logger.error(`Event listener failed for ${key}: ${String(error)}`);
    for (const listener of this.listeners<keyof Events, Listener<Events[K]>>(key, (realm) => realm.events)) {
      try { Promise.resolve(listener(payload)).catch(report); } catch (error) { report(error); }
    }
  }

  async serial<K extends keyof Events>(key: K, payload: Events[K]): Promise<void> {
    this.assertActive();
    for (const listener of this.listeners<keyof Events, Listener<Events[K]>>(key, (realm) => realm.events)) await listener(payload);
  }

  onWaterfall<K extends keyof Waterfalls>(key: K, listener: WaterfallListener<Waterfalls[K]>): Disposable {
    return this.listen(this.realm.waterfalls, key, listener);
  }

  async waterfall<K extends keyof Waterfalls>(key: K, payload: Waterfalls[K], fallback?: (payload: Waterfalls[K]) => Waterfalls[K] | Promise<Waterfalls[K]>): Promise<Waterfalls[K]> {
    this.assertActive();
    const listeners = this.listeners<keyof Waterfalls, WaterfallListener<Waterfalls[K]>>(key, (realm) => realm.waterfalls);
    const visit = async (index: number, value: Waterfalls[K]): Promise<Waterfalls[K]> => {
      const listener = listeners[index];
      if (!listener) return fallback ? fallback(value) : value;
      let called = false;
      return listener(value, (next) => {
        if (called) return Promise.reject(new Error(`next() already called for ${key}`));
        called = true;
        return visit(index + 1, next);
      });
    };
    return visit(0, payload);
  }

  effect(apply: () => void | Disposable): Disposable {
    this.assertActive();
    const cleanup = apply();
    if (!this.active) {
      cleanup?.();
      return () => {};
    }
    const dispose = () => {
      if (this.effects.delete(dispose)) cleanup?.();
    };
    this.effects.add(dispose);
    return dispose;
  }

  private child(realm: Realm): Context {
    this.assertActive();
    const child = new Context(this.logger, realm, this.injections);
    const detach = this.effect(() => () => child.dispose());
    child.effect(() => detach);
    return child;
  }

  fork(name: string): Context {
    if (!name) throw new Error('Context name is required');
    return this.child(new Realm(this.realm));
  }

  pluginScope(): Context {
    return this.child(this.realm);
  }

  get disposed(): boolean {
    return !this.active;
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    unwind([...this.effects]);
  }
}

export class PluginLoader {
  private readonly mounted = new Map<string, Context>();
  private readonly pending = new Set<string>();

  constructor(readonly ctx: Context = new Context()) {}

  async mount(plugin: Plugin, id = plugin.name): Promise<void> {
    if (!id || this.mounted.has(id) || this.pending.has(id)) throw new Error(`Invalid or duplicate plugin id: ${id}`);
    const scope = this.ctx.pluginScope();
    this.pending.add(id);
    try {
      const dispose = await plugin.apply(scope);
      if (scope.disposed) {
        dispose?.();
        throw new Error(`Context was disposed while mounting ${id}`);
      }
      if (dispose) scope.effect(() => dispose);
      this.mounted.set(id, scope);
    } catch (error) {
      try { scope.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], `Failed to mount ${id}`); }
      throw error;
    } finally {
      this.pending.delete(id);
    }
  }

  async mountAll(plugins: readonly Plugin[]): Promise<void> {
    await this.mountEntries(plugins.map((plugin) => [plugin.name, plugin]));
  }

  async mountEntries(entries: readonly (readonly [string, Plugin])[]): Promise<void> {
    const added: string[] = [];
    try {
      for (const [id, plugin] of entries) {
        await this.mount(plugin, id);
        added.push(id);
      }
    } catch (error) {
      try { unwind(added.map((id) => () => this.unmount(id))); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Failed to mount plugins'); }
      throw error;
    }
  }

  unmount(id: string): boolean {
    if (this.pending.has(id)) throw new Error(`Plugin is still mounting: ${id}`);
    const scope = this.mounted.get(id);
    if (!scope) return false;
    this.mounted.delete(id);
    scope.dispose();
    return true;
  }

  dispose(): void {
    const ids = [...this.mounted.keys()];
    unwind([() => this.ctx.dispose(), ...ids.map((id) => () => this.unmount(id))]);
  }
}
