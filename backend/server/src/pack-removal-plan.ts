/** Local, read-only removal impact. The fence covers installed inventory, owned
 * recipes/settings, the displayed runtime impact and pack protection metadata. */
import { RpcError,parseDependsOn,regressionBytes,type PackRemovalPack,type PackRemovalPlan,type PackRemovalReview,type PackRemovalStop } from '@recued/contracts';
import type { PackUninstallRpcDeps } from './pack-uninstall-handler.js';
import { packDependencyGraph } from './pack-dependencies.js';
import { createPackConnectionHolderStore } from './storage/pack-connection-holder-store.js';
import { recipeReleaseDigest as digest } from './storage/recipe-release-authority.js';
import { recipeOwnedStateOf } from './recipe-owned-state.js';
import { resolveBundledPackManifest,isCoreFeaturePack } from './bundled-pack-source.js';
import { recordsCatalogSlug } from '@recued/ingredient-authoring';
import type { StoredRecipe } from './types.js';

type Impact = Omit<PackRemovalPlan,'review_id' | 'expires_at' | 'prior_attempt_unconfirmed'>;
const object = (v: unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** D-346 B — what removing this pack stops (ruling 2: a pack other packs use can be
 *  removed after a warning). The actions, of every pack but this one and of the
 *  owner's own recipes, whose `depends_on` names it: the rule a run's refusal applies
 *  (`missingPackDependencies`), so the warning names exactly the actions that will be
 *  refused before they start. Grouped by pack, by name where this server has its
 *  manifest; a pack that lists it as a dependency (`dependants`) without such an
 *  action is listed with none. */
export const removalStops = (input: {
  stored: readonly StoredRecipe[];
  removed: { pack_slug: string; publisher?: string; keys: readonly string[] };
  /** `graph.dependants`: `direct` lists this pack itself. One that needs it only
   *  through a pack that stays installed loses nothing, and is not a stop. */
  dependants: ReadonlyArray<PackRemovalPack & { direct: boolean }>;
  /** The authored slug of an installed pack, by its inventory key. */
  authoredOf: (key: string) => string | undefined;
  nameOfPack: (slug: string) => string | undefined;
}): PackRemovalStop[] => {
  const { removed } = input;
  const namesRemoved = (declared: unknown): boolean => Array.isArray(declared) && declared.some((entry) => {
    const parsed = typeof entry === 'string' ? parseDependsOn(entry) : null;
    return parsed !== null && parsed.pack === removed.pack_slug
      && (removed.publisher === undefined || parsed.publisher === removed.publisher);
  });
  const byPack = new Map<string | null,Array<{ recipe_id: string; name?: string }>>();
  for (const row of input.stored) {
    if (row.pack_slug !== null && removed.keys.includes(row.pack_slug)) continue;
    let recipe: { depends_on?: unknown; metadata?: { name?: unknown } };
    try { recipe = JSON.parse(row.recipe_json) as typeof recipe; } catch { continue; }
    if (!object(recipe) || !namesRemoved(recipe.depends_on)) continue;
    const name = typeof recipe.metadata?.name === 'string' && recipe.metadata.name.trim() !== '' ? recipe.metadata.name : undefined;
    const pack = row.pack_slug === null ? null : input.authoredOf(row.pack_slug) ?? row.pack_slug;
    byPack.set(pack,[...(byPack.get(pack) ?? []),{ recipe_id: row.recipe_id,...(name !== undefined ? { name } : {}) }]);
  }
  for (const dependant of input.dependants) if (dependant.direct && !byPack.has(dependant.pack_slug)) byPack.set(dependant.pack_slug,[]);
  return [...byPack].map(([pack_slug,actions]): PackRemovalStop => {
    const name = pack_slug === null ? undefined : input.nameOfPack(pack_slug);
    return { pack_slug,...(name !== undefined ? { name } : {}),actions: actions.sort((a,b) => a.recipe_id.localeCompare(b.recipe_id)) };
  }).sort((a,b) => (a.pack_slug === null ? 1 : b.pack_slug === null ? -1 : a.pack_slug.localeCompare(b.pack_slug)));
};
export const preparePackRemoval = async (deps: PackUninstallRpcDeps, request: Pick<PackRemovalReview,'pack_slug' | 'publisher'>) => {
  const contracts = deps.contractStore, db = deps.recipeStore.realmDatabase;
  if (!contracts || !db || contracts.realmDatabase !== db) throw new RpcError('pack_removal_unsupported','Reviewed removal requires the built-in stores on the same realm.',409);
  const inventory = contracts.scan('installed_pack');
  if (inventory.length > 2000) throw new RpcError('pack_removal_limit','Review at most 2000 installed packs at once.',409);
  const aliases = new Set([request.pack_slug,...packDependencyGraph(contracts).packs.filter(item => item.pack.inventory_key === request.pack_slug
    && (request.publisher === undefined || item.pack.publisher === request.publisher)).map(item => item.pack.pack_slug)]);
  const matchingNamespaces = () => (deps.recordsStore?.listNamespaces() ?? []).filter(ns => aliases.has(ns.owner.pack_slug)
    && (request.publisher === undefined || ns.owner.publisher === request.publisher));
  const namespaces = matchingNamespaces();
  const recordKeys = await Promise.all(namespaces.map(ns => recordsCatalogSlug(ns.owner)));
  const read = () => {
    const records = matchingNamespaces();
    if (digest(contracts.scan('installed_pack')) !== digest(inventory)
      || digest(records.map(ns => ns.owner)) !== digest(namespaces.map(ns => ns.owner))) {
      throw new RpcError('pack_removal_conflict','The installed identity changed. Review removal again.',409);
    }
    const graph = packDependencyGraph(contracts), selected = graph.packs.filter(({ pack }) => (pack.inventory_key === request.pack_slug
      || pack.pack_slug === request.pack_slug || recordKeys.includes(pack.inventory_key)) && (request.publisher === undefined || pack.publisher === request.publisher));
    const identities = [...new Set([...selected.map(item => item.pack.inventory_key),...recordKeys])].sort();
    const keys = identities.length ? identities : [request.pack_slug];
    const namespace = records.length === 1 ? records[0] : undefined;
    const recordsVersion = namespace?.state.state === 'ready' ? namespace.state.version
      : namespace?.state.state === 'orphaned' ? namespace.state.last_version : undefined;
    const pack = selected[0]?.pack ?? { inventory_key: keys[0]!,pack_slug: namespace?.owner.pack_slug ?? request.pack_slug,
      ...(namespace ? { publisher: namespace.owner.publisher } : request.publisher ? { publisher: request.publisher } : {}),
      ...(recordsVersion !== undefined ? { version: recordsVersion } : {}) };
    const manifest = resolveBundledPackManifest(deps.packDir,request.pack_slug), blockers: Impact['blockers'] = [];
    // D-346 B — packs that list this one no longer block: the plan names them and the
    // actions that stop (`stops`), and the reviewed removal goes ahead after that
    // warning. Every other way to uninstall still keeps them intact.
    const dependants = graph.dependants(keys);
    const nameOfPack = (slug: string): string | undefined => {
      try {
        const name = resolveBundledPackManifest(deps.packDir,slug)?.name;
        return typeof name === 'string' && name.trim() !== '' ? name : undefined;
      } catch { return undefined; }
    };
    const stops = removalStops({ stored: deps.recipeStore.listStored(),removed: { pack_slug: pack.pack_slug,...(pack.publisher ? { publisher: pack.publisher } : {}),keys },
      dependants,authoredOf: key => graph.packs.find(item => item.pack.inventory_key === key)?.pack.pack_slug,nameOfPack });
    const borrowers = createPackConnectionHolderStore(contracts).borrowersOf(request.pack_slug).filter(slug => slug !== request.pack_slug
      && graph.packs.some(item => item.pack.pack_slug === slug || item.pack.inventory_key === slug));
    if (borrowers.length) blockers.push({ code: 'connection_borrowers',message: `Remove packs sharing this sign-in first: ${borrowers.join(', ')}.` });
    if (identities.length > 1 || selected.length > 1 || records.length > 1) blockers.push({ code: 'ambiguous',message: 'Choose the installed publisher before reviewing removal.' });
    if (request.publisher && !selected.length && !records.length && graph.packs.some(item => aliases.has(item.pack.pack_slug) || aliases.has(item.pack.inventory_key))) {
      blockers.push({ code: 'publisher_mismatch',message: 'The selected publisher does not match the installed pack. Review its installed identity.' });
    }
    if (records.some(ns => ns.state.state === 'migrating')) blockers.push({ code: 'records_migrating',message: 'Wait for the Records migration before reviewing removal.' });
    if (manifest && isCoreFeaturePack(manifest)) blockers.push({ code: 'core_feature',message: 'Recued maintains this core feature.' });
    const recipes = [...new Set(keys.flatMap(key => deps.recipeStore.listForPack(key)))].sort();
    if (request.publisher && !selected.length && recipes.some(id => deps.recipeStore.getStored(id)?.publisher_id !== request.publisher)) {
      blockers.push({ code: 'recipe_publisher_mismatch',message: 'A stored recipe belongs to another publisher. Review the installed ownership first.' });
    }
    if (!selected.length && !recipes.length && !records.some(ns => ns.state.state === 'ready')) blockers.push({ code: 'not_installed',message: 'This pack is no longer installed.' });
    const bundled = recipes.filter(id => deps.recipeStore.getBundled(id) != null), owned = deps.getRecipeOwnedState?.();
    const ownedRows = recipes.map(id => ({ id,dishes: owned?.dishes?.listByRecipe(id) ?? [],schedules: owned?.schedules?.listByRecipe(id) ?? [],
      timers: (owned?.autoRun?.list() ?? []).filter(timer => timer.recipe_id === id),
      triggers: (owned?.triggers?.list() ?? []).filter(trigger => trigger.recipe_id === id && trigger.origin !== 'recipe') }));
    const counts = { schedules: 0,automations: 0,recipes_with_settings: 0 };
    if (owned) for (const id of recipes) { const state = recipeOwnedStateOf(id,owned); counts.schedules += state.schedules;
      counts.automations += state.automations; if (state.settings) counts.recipes_with_settings++; }
    const transitions = (deps.computeWouldWorsen?.(request.pack_slug) ?? []).filter(item => !recipes.includes(item.recipe_id));
    const ids = new Set(selected.flatMap(item => object(item.row.value) && Array.isArray(item.row.value.ingredient_ids)
      ? item.row.value.ingredient_ids.filter((id): id is string => typeof id === 'string') : []));
    const shared = new Set(graph.packs.filter(item => !keys.includes(item.pack.inventory_key)).flatMap(item => object(item.row.value) && Array.isArray(item.row.value.ingredient_ids)
      ? item.row.value.ingredient_ids.filter((id): id is string => typeof id === 'string') : []));
    const table = (name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const protectedRows = table('pack_update_tracks') ? db.prepare('SELECT * FROM pack_update_tracks ORDER BY pack_slug').all() : [];
    const reservations = table('pack_update_plan_packs') ? db.prepare('SELECT * FROM pack_update_plan_packs ORDER BY pack_slug').all() as Array<{ pack_slug: string; plan_slug: string }> : [];
    const releaseRows = table('pack_release_history') ? db.prepare('SELECT * FROM pack_release_history ORDER BY pack_slug').all() as Array<{ pack_slug: string }> : [];
    const roots = [...new Set(reservations.filter(row => keys.includes(row.pack_slug)).map(row => row.plan_slug))];
    if (table('pack_update_tracks')) for (const key of keys) if (db.prepare('SELECT 1 FROM pack_update_tracks WHERE pack_slug=? AND deleted=0').get(key)) roots.push(key);
    const publisher_choices = [...new Set([...graph.packs.filter(item => aliases.has(item.pack.pack_slug) || aliases.has(item.pack.inventory_key)).flatMap(item => item.pack.publisher ? [item.pack.publisher] : []),
      ...(deps.recordsStore?.listNamespaces() ?? []).filter(ns => aliases.has(ns.owner.pack_slug)).map(ns => ns.owner.publisher)])].sort();
    const impact: Impact = { pack,publisher_choices,blockers,dependants,unknown_dependencies: graph.unknown.filter(item => !keys.includes(item.inventory_key)),
      dependencies_kept: graph.packs.filter(item => keys.some(key => graph.edges.get(key)?.has(item.pack.inventory_key)) && !keys.includes(item.pack.inventory_key)).map(item => item.pack),
      ingredients: { removed: [...ids].filter(id => !shared.has(id)).sort(),shared: [...ids].filter(id => shared.has(id)).sort() },recipes,bundled_recipes_kept: bundled,
      owned: counts,runtime: { would_disable: transitions.filter(item => item.after === 'blocked').map(item => item.recipe_id).sort(),
        would_degrade: transitions.filter(item => item.after === 'degraded').map(item => item.recipe_id).sort() },
      protection: { roots: [...new Set(roots)].sort(),release_history: releaseRows.some(row => keys.includes(row.pack_slug)) },
      ...(records.length === 1 ? { records: { disposition: 'retain',...records[0]!.owner } as const } : {}),stops };
    const snapshot = { inventory: contracts.scan('installed_pack'),ingredients: contracts.scan('installed_ingredient'),
      recipes: recipes.map(id => ({ stored: deps.recipeStore.getStored(id),bundled: deps.recipeStore.getBundled(id) })),ownedRows,impact,borrowers,
      records: records.map(ns => ({ owner: ns.owner,state: ns.state,state_generation: ns.state_generation,activation_generation: ns.activation_generation })),
      holders: contracts.scan('pack_connection_holder'),protectedRows,reservations,releaseRows,
      webhooks: deps.webhookConsumerStore?.listBindings({ consumer_kind: 'pack_install',consumer_id: request.pack_slug }) ?? [] };
    if (regressionBytes(snapshot) > 8_000_000 || regressionBytes(impact) > 500_000) throw new RpcError('pack_removal_limit','This removal review exceeds its local size limit.',409);
    return { impact,fingerprint: digest(snapshot) };
  };
  const initial = read();
  return { ...initial,assertCurrent() { if (read().fingerprint !== initial.fingerprint) throw new RpcError('pack_removal_conflict','The installed state or removal impact changed. Review removal again.',409); } };
};
