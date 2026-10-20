/** Install-time declarations and reverse dependency reads. Never consult a
 * newer catalog to guess what an installed pack declared. */
import { RpcError, type InstalledPackDependencies, type PackDependency, type PackRemovalPack } from '@recued/contracts';
import type { ContractRow, ContractStore } from './storage/contract-store.js';
const object = (v: unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const version = (v: unknown): number | undefined => typeof v === 'string' && /^[1-9]\d*$/.test(v) && positive(Number(v)) ? Number(v) : undefined;
export const dependencyPack = (row: ContractRow): PackRemovalPack => {
  const value = object(row.value) ? row.value : {};
  return { inventory_key: row.segments[0]!,pack_slug: typeof value.authored_pack_slug === 'string' ? value.authored_pack_slug
    : typeof value.pack_slug === 'string' ? value.pack_slug : row.segments[0]!,
    ...(typeof value.publisher === 'string' ? { publisher: value.publisher } : {}),
    ...(version(value.version) !== undefined ? { version: version(value.version) } : {}) };
};
export const declaredPackDependencies = (manifest: Record<string,unknown>): PackDependency[] | undefined => {
  const raw = manifest.dependencies === undefined ? [] : manifest.dependencies;
  if (!Array.isArray(raw)) return undefined;
  const result: PackDependency[] = [];
  for (const entry of raw) {
    if (!object(entry) || entry.min_version !== undefined && !positive(entry.min_version)) return undefined;
    const min = entry.min_version === undefined ? {} : { min_version: entry.min_version };
    if (entry.type === 'pack' && typeof entry.slug === 'string' && entry.slug) result.push({ type: 'pack',slug: entry.slug,...min });
    else if (entry.type === 'ingredient' && (typeof entry.slug === 'string' && entry.slug || typeof entry.ingredient_id === 'string' && entry.ingredient_id)) {
      if (entry.slug !== undefined && entry.ingredient_id !== undefined) return undefined;
      if (typeof entry.ingredient_id === 'string') result.push({ type: 'ingredient',ingredient_id: entry.ingredient_id,...min });
      else result.push({ type: 'ingredient',slug: String(entry.slug),...min });
    } else return undefined;
  }
  return result;
};
export const capturePackDependencies = (store: ContractStore, dependencies: readonly PackDependency[]): InstalledPackDependencies | null => {
  if (dependencies.length > 256) return null;
  return { schema_version: 1,dependencies: dependencies.map(dependency => {
    const slug = dependency.type === 'pack' ? dependency.slug : dependency.ingredient_id ?? dependency.slug!;
    const installed = dependency.type === 'pack' ? store.scan('installed_pack').map(dependencyPack)
      .filter(pack => pack.inventory_key === slug || pack.pack_slug === slug).map(({ inventory_key,publisher,version }) =>
        ({ inventory_key,...(publisher ? { publisher } : {}),...(version !== undefined ? { version } : {}) }))
      : store.scan('installed_ingredient').filter(row => row.segments[0] === slug).map(row => ({ inventory_key: row.segments[0]!,
        ...(object(row.value) && version(row.value.version) !== undefined ? { version: version(row.value.version) } : {}) }));
    return { type: dependency.type,slug,...(dependency.min_version !== undefined ? { min_version: dependency.min_version } : {}),installed };
  }) };
};
export const readPackDependencies = (row: ContractRow): InstalledPackDependencies | null => {
  const snapshot = object(row.value) ? row.value.dependency_snapshot : undefined;
  if (!object(snapshot) || snapshot.schema_version !== 1 || !Array.isArray(snapshot.dependencies) || snapshot.dependencies.length > 256) return null;
  const dependencies: InstalledPackDependencies['dependencies'] = [];
  for (const entry of snapshot.dependencies) {
    if (!object(entry) || entry.type !== 'pack' && entry.type !== 'ingredient' || typeof entry.slug !== 'string' || !entry.slug
      || entry.min_version !== undefined && !positive(entry.min_version) || !Array.isArray(entry.installed)
      || entry.installed.some(item => !object(item) || typeof item.inventory_key !== 'string' || !item.inventory_key
        || item.publisher !== undefined && typeof item.publisher !== 'string' || item.version !== undefined && !positive(item.version))) return null;
    const installed: InstalledPackDependencies['dependencies'][number]['installed'] = [];
    for (const item of entry.installed) {
      if (!object(item) || typeof item.inventory_key !== 'string') return null;
      installed.push({ inventory_key: item.inventory_key,...(typeof item.publisher === 'string' ? { publisher: item.publisher } : {}),
        ...(positive(item.version) ? { version: item.version } : {}) });
    }
    dependencies.push({ type: entry.type,slug: entry.slug,...(positive(entry.min_version) ? { min_version: entry.min_version } : {}),installed });
  }
  return { schema_version: 1,dependencies };
};
export const packDependencyGraph = (store: ContractStore) => {
  const rows = store.scan('installed_pack');
  const packs = rows.map(row => ({ pack: dependencyPack(row),snapshot: readPackDependencies(row),row }));
  const edges = new Map<string,Set<string>>(), groups = new Map<string,Array<{ keys: Set<string>; shared: boolean }>>();
  for (const { pack,snapshot } of packs) {
    const targets = new Set<string>(), requirements: Array<{ keys: Set<string>; shared: boolean }> = [];
    for (const dependency of snapshot?.dependencies ?? []) {
      const providers = new Set<string>();
      if (dependency.type === 'pack') {
        for (const other of packs) if (dependency.installed.some(observed => observed.inventory_key === other.pack.inventory_key)) providers.add(other.pack.inventory_key);
        if (!providers.size) for (const other of packs) if (other.pack.inventory_key === dependency.slug || other.pack.pack_slug === dependency.slug) providers.add(other.pack.inventory_key);
        if (!providers.size) providers.add(dependency.slug);
      }
      else for (const other of packs) {
        const ids = object(other.row.value) && Array.isArray(other.row.value.ingredient_ids) ? other.row.value.ingredient_ids : [];
        if (ids.includes(dependency.slug)) providers.add(other.pack.inventory_key);
      }
      if (dependency.type === 'ingredient' && providers.has(pack.inventory_key)) continue;
      providers.delete(pack.inventory_key);
      for (const key of providers) targets.add(key);
      if (providers.size) requirements.push({ keys: providers,shared: dependency.type === 'ingredient' });
    }
    targets.delete(pack.inventory_key); edges.set(pack.inventory_key,targets); groups.set(pack.inventory_key,requirements);
  }
  const dependants = (keys: readonly string[]) => {
    const found = new Map<string,{ direct: boolean; via: string[] }>(), selected = new Set(keys), unavailable = new Set(keys);
    let changed = true;
    const lost = (group: { keys: Set<string>; shared: boolean }, absent: Set<string>) => group.shared
      ? [...group.keys].every(key => absent.has(key)) : [...group.keys].some(key => absent.has(key));
    while (changed) {
      changed = false;
      for (const [key,requires] of groups) if (!unavailable.has(key) && requires.some(group => lost(group,unavailable))) {
        const direct = requires.some(group => lost(group,selected));
        const provider = requires.find(group => lost(group,unavailable))!;
        const via = [...provider.keys].find(key => unavailable.has(key))!;
        found.set(key,{ direct,via: [via,...found.get(via)?.via ?? []] }); unavailable.add(key); changed = true;
      }
    }
    return packs.filter(item => found.has(item.pack.inventory_key)).map(item => ({ ...item.pack,...found.get(item.pack.inventory_key)! }));
  };
  return { packs,edges,dependants,unknown: packs.filter(item => item.snapshot === null).map(item => item.pack) };
};
export const assertNoPackDependants = (store: ContractStore,slug: string,publisher?: string): void => {
  const graph = packDependencyGraph(store), keys = graph.packs.filter(item => (item.pack.inventory_key === slug || item.pack.pack_slug === slug)
    && (publisher === undefined || item.pack.publisher === publisher)).map(item => item.pack.inventory_key);
  const dependants = graph.dependants(keys.length ? keys : [slug]);
  if (dependants.length) throw new RpcError('conflict',`Remove dependent packs first: ${dependants.map(item => item.pack_slug).join(', ')}.`,409);
};
