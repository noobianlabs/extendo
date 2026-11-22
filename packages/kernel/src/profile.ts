import type { JsonValue, Plugin } from '@extendo/contracts';

export interface PluginRow {
  id: string;
  plugin: string;
  config?: JsonValue;
  enabled?: boolean;
}

export type ProfilePatch = PluginRow | { id: string; remove: true };

export interface Bundle {
  name: string;
  rows: readonly ProfilePatch[];
}

export interface Profile {
  name: string;
  bundles: readonly Bundle[];
  patches?: readonly (readonly ProfilePatch[])[];
}

export type PluginCatalog = ReadonlyMap<string, (config: JsonValue | undefined) => Plugin>;

export function composeProfile(profile: Profile): PluginRow[] {
  const rows = new Map<string, PluginRow>();
  const layers = [...profile.bundles.map((bundle) => bundle.rows), ...(profile.patches ?? [])];
  for (const layer of layers) {
    for (const row of layer) {
      if (!row.id) throw new Error('Profile row id is required');
      if ('remove' in row) rows.delete(row.id);
      else rows.set(row.id, structuredClone(row));
    }
  }
  return [...rows.values()];
}

export function profileEntries(profile: Profile, catalog: PluginCatalog): [string, Plugin][] {
  return composeProfile(profile).filter((row) => row.enabled !== false).map((row) => {
    const factory = catalog.get(row.plugin);
    if (!factory) throw new Error(`Unknown plugin in profile: ${row.plugin}`);
    return [row.id, factory(row.config)];
  });
}

export function dumpConfig(profile: Profile): string {
  return JSON.stringify({ profile: profile.name, plugins: composeProfile(profile) }, null, 2);
}
