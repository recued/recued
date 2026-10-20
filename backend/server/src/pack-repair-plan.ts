/** Installation integrity is read from local evidence, never a newer catalog.
 * The only writer removes proven local leftovers; it installs no authority. */
import { RpcError, regressionBytes, type PackRepairEntry, type PackRepairInspection, type PackRepairPlan } from '@recued/contracts';
import type { PackUninstallRpcDeps } from './pack-uninstall-handler.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import { dependencyPack, packDependencyGraph, readPackDependencies } from './pack-dependencies.js';
import { privateByoDropIds, removePackInventory } from './pack-inventory.js';
import { createLocalManifestStore } from './ingredient-authoring/local-manifest-store.js';
import { createMcpBodyVisibilityStore } from './storage/mcp-body-visibility-store.js';
import { retirePackUpdates } from './storage/pack-update-authority.js';
import { packRemovalActive, readPackRemovalEvidence } from './storage/pack-removal-store.js';
import { recipeReleaseDigest as digest } from './storage/recipe-release-authority.js';
import { recordsCatalogSlug } from '@recued/ingredient-authoring';
import { resolveBundledPackManifest, isCoreFeaturePack } from './bundled-pack-source.js';
import { recipeOwnedStateOf } from './recipe-owned-state.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const SCOPES = ['installed_pack', 'installed_ingredient', 'grant', 'connection_catalog_binding', 'pack_connection_default',
  'pack_connection_holder', 'installed_reception_template', 'contract_grant'] as const;
type PlanBody = Omit<PackRepairPlan, 'review_id' | 'expires_at'>;
export const preparePackRepairs = async (deps: PackUninstallRpcDeps, codec: PreapprovalCodec, check: () => void) => {
  const contracts = deps.contractStore, db = deps.recipeStore.realmDatabase;
  if (!contracts || !db || contracts.realmDatabase !== db) throw new RpcError('pack_repair_unsupported', 'Installation repair requires the built-in stores in the same realm.', 409);
  const hasTable = (name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  // Table names below are closed constants, never request input.
  const table = (name: string): Record<string, unknown>[] => hasTable(name)
    ? db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() as Record<string, unknown>[] : [];
  const capture = () => {
    check();codec.assertUnlocked();
    if (!deps.recordsStore && hasTable('core_record_namespaces') && db.prepare('SELECT 1 FROM core_record_namespaces LIMIT 1').get()) {
      throw new RpcError('pack_repair_unsupported', 'Configure the Records store before inspecting a realm with retained Records namespaces.', 409);
    }
    const scopes = Object.fromEntries(SCOPES.map(scope => [scope, contracts.scan(scope)]));
    const snapshot = { scopes,
      recipes: db.prepare('SELECT recipe_id,pack_slug,publisher_id,recipe_hash FROM recipes ORDER BY recipe_id').all() as Array<{ recipe_id: string; pack_slug: string | null; publisher_id: string; recipe_hash: string }>,
      manifests: table('local_manifest'), body: table('mcp_body_visibility_grants'), tracks: table('pack_update_tracks'),
      members: table('pack_update_members'), reservations: table('pack_update_plan_packs'), history: table('pack_release_history'),
      removals: table('pack_removal_reviews'), webhooks: table('webhook_consumer_bindings'), views: table('saved_data_views'), classes: table('asset_class_presets'),
      namespaces: deps.recordsStore?.listNamespaces() ?? [],
      recipe_state_present: ['schedules', 'dishes', 'auto_run_timers', 'event_triggers'].some(name => hasTable(name) && !!db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get()),
    };
    if (regressionBytes(snapshot) > 8_000_000) throw new RpcError('pack_repair_limit', 'Installation inspection exceeds its 8 MB local evidence limit.', 409);
    return snapshot;
  };
  const snapshot = capture(), localFingerprint = digest(snapshot);
  const records = await Promise.all(snapshot.namespaces.map(async ns => ({ key: await recordsCatalogSlug(ns.owner), ns })));
  const evidence = new Map<string, Awaited<ReturnType<typeof readPackRemovalEvidence>>>();
  const removalKeys = [...new Set(snapshot.removals.filter(row => row.phase === 'applying' || row.phase === 'complete').map(row => String(row.pack_slug)))];
  for (const key of removalKeys) { check();evidence.set(key, await readPackRemovalEvidence(db, codec, key)); }
  const historicalIds = [...new Set([...evidence.values()].flatMap(item => item && !item.unreadable ? item.recipes : []))].sort();
  const storedIds = new Set(snapshot.recipes.map(item => item.recipe_id));
  const readOwned = () => {
    const owned = deps.getRecipeOwnedState?.();
    return { available: !!owned, recipes: historicalIds.map(recipe_id => {
      const retained = storedIds.has(recipe_id) || deps.recipeStore.getBundled(recipe_id) != null;
      return { recipe_id, retained, ...(owned && !retained ? recipeOwnedStateOf(recipe_id, owned) : { schedules: 0, automations: 0, settings: 0 }) };
    }) };
  };
  const ownedSnapshot = readOwned(), ownedFingerprint = digest(ownedSnapshot), fingerprint = digest({ localFingerprint, ownedFingerprint });
  if (regressionBytes({ snapshot, ownedSnapshot }) > 8_000_000) throw new RpcError('pack_repair_limit', 'Installation inspection exceeds its 8 MB local evidence limit.', 409);
  const assertCurrent = () => {
    if (digest(capture()) !== localFingerprint || digest(readOwned()) !== ownedFingerprint) throw new RpcError('pack_repair_conflict', 'The local installation changed. Inspect and review it again.', 409);
  };
  assertCurrent();
  const scope = (name: typeof SCOPES[number]) => snapshot.scopes[name]!;
  const value = (raw: unknown) => object(raw) ? raw : {};
  const bindings = (key: string) => scope('connection_catalog_binding').filter(row => value(row.value).installed_pack_id === key);
  const owned = (name: typeof SCOPES[number], key: string) => scope(name).filter(row => row.segments[0] === key);
  const graph = packDependencyGraph(contracts);
  const keys = new Set(scope('installed_pack').map(row => row.segments[0]!));
  for (const row of snapshot.recipes) if (row.pack_slug) keys.add(row.pack_slug);
  for (const name of ['grant', 'pack_connection_default', 'pack_connection_holder', 'installed_reception_template'] as const) {
    for (const row of scope(name)) keys.add(row.segments[0]!);
  }
  for (const row of scope('connection_catalog_binding')) { const key = text(value(row.value).installed_pack_id);if (key) keys.add(key); }
  for (const row of [...snapshot.body, ...snapshot.history, ...snapshot.members, ...snapshot.reservations, ...snapshot.tracks.filter(row => row.deleted === 0)]) {
    const key = text(row.pack_slug);if (key) keys.add(key);
  }
  for (const key of removalKeys) keys.add(key);
  for (const record of records) keys.add(record.key);
  keys.delete('__user__');keys.delete('');
  if (keys.size > 2000) throw new RpcError('pack_repair_limit', 'Inspect at most 2000 local pack identities at once.', 409);

  const describe = (key: string): PackRepairEntry => {
    const row = scope('installed_pack').find(item => item.segments[0] === key), body = snapshot.body.filter(item => item.pack_slug === key);
    const historical = evidence.get(key), record = records.find(item => item.key === key);
    const publishers = new Set([text(value(row?.value).publisher), ...body.map(item => text(item.publisher)),
      ...owned('installed_reception_template', key).map(item => text(value(item.value).publisher)),
      ...snapshot.recipes.filter(item => item.pack_slug === key).map(item => text(item.publisher_id)), record?.ns.owner.publisher,
      ...(historical && !historical.unreadable ? [historical.pack.publisher] : [])].filter((item): item is string => !!item));
    const pack = row ? dependencyPack(row) : record ? { inventory_key: key, pack_slug: record.ns.owner.pack_slug, publisher: record.ns.owner.publisher }
      : { inventory_key: key, pack_slug: key, ...(publishers.size === 1 ? { publisher: [...publishers][0]! } : {}) };
    const ingredients = strings(value(row?.value).ingredient_ids).map(id => {
      const ingredient = scope('installed_ingredient').find(item => item.segments[0] === id);
      const versions = snapshot.manifests.filter(item => item.slug === id).map(item => Number(item.version));
      return { id, inventory: !!ingredient, local_manifest: value(ingredient?.value).catalog_kind !== 'private_byo' ? 'not_required' as const
        : !versions.length ? 'missing' as const : Math.max(...versions) !== Number(value(ingredient?.value).version) ? 'stale' as const : 'present' as const };
    });
    const entry: PackRepairEntry = { pack, inventory: !!row, recipes: snapshot.recipes.filter(item => item.pack_slug === key).map(item => item.recipe_id), ingredients,
      ...(record ? { records_state: record.ns.state.state } : {}),
      metadata: { grants: owned('grant', key).length, body_grants: body.length, bindings: bindings(key).length,
        defaults: owned('pack_connection_default', key).length, holders: owned('pack_connection_holder', key).length, templates: owned('installed_reception_template', key).length,
        protection: snapshot.tracks.some(item => item.pack_slug === key && item.deleted === 0) || snapshot.members.some(item => item.pack_slug === key)
          || snapshot.reservations.some(item => item.pack_slug === key || item.plan_slug === key),
        history: snapshot.history.some(item => item.pack_slug === key) },
      removal: !historical ? 'none' : historical.unreadable ? 'unreadable' : historical.row.phase === 'applying' ? 'unconfirmed' : 'complete', findings: [], next_step: 'none' };
    const finding = (code: string, message: string) => entry.findings.push({ code, message });
    if (publishers.size > 1 || body.some(item => !text(item.publisher))) finding('ambiguous_publisher', 'Local ownership evidence has conflicting or missing publishers. Inspect it before making changes.');
    if (!row && (entry.recipes.length || record && record.ns.state.state !== 'orphaned')) {
      finding('missing_inventory', 'Stored recipes or an active Records namespace remain, but their installation inventory is missing. Use the normal install review to restore it.');
      entry.next_step = record && record.ns.state.state !== 'ready' && record.ns.state.state !== 'orphaned' ? 'inspect' : 'install';
    }
    for (const ingredient of ingredients) {
      if (!ingredient.inventory) finding('missing_ingredient', `Installed ingredient inventory is missing: ${ingredient.id}.`);
      if (ingredient.local_manifest === 'missing') finding('missing_manifest', `The installed local manifest is missing: ${ingredient.id}.`);
      if (ingredient.local_manifest === 'stale') finding('stale_manifest', `The current local catalog version differs from installed ingredient inventory: ${ingredient.id}. Use the normal install review.`);
    }
    for (const binding of bindings(key)) if (!scope('installed_ingredient').some(item => item.segments[0] === value(binding.value).catalog_slug)) {
      finding('stale_binding', `A catalog binding has no ingredient inventory: ${String(value(binding.value).catalog_slug)}.`);
    }
    for (const stored of owned('pack_connection_default', key)) if (!bindings(key).some(binding => binding.segments[0] === value(stored.value).connection_name)) {
      finding('stale_default', `A saved default has no matching pack catalog binding: ${String(value(stored.value).connection_name)}.`);
    }
    if (row && !readPackDependencies(row)) finding('unknown_dependencies', 'This installation has no valid saved dependency evidence. A newer catalog cannot establish its original dependencies.');
    if (entry.removal === 'unconfirmed') finding('unconfirmed_removal', 'An earlier removal has no confirmed completion. Inspect current local state; provider cleanup may still need attention.');
    if (entry.removal === 'unreadable') finding('unreadable_removal', 'The retained removal evidence cannot be authenticated.');
    if (!row && !entry.recipes.length && (!record || record.ns.state.state === 'orphaned') && Object.values(entry.metadata).some(Boolean)) {
      finding('orphaned_metadata', 'Local grants, bindings or update state remain without an installed pack payload.');entry.next_step = 'review_cleanup';
    }
    if (row && !entry.recipes.length && (!record || record.ns.state.state === 'orphaned') && historical && !historical.unreadable
      && historical.inventory_fingerprint === digest(contracts.get('installed_pack', [key]))) entry.next_step = 'review_cleanup';
    if (entry.findings.some(item => ['missing_ingredient', 'missing_manifest', 'stale_manifest', 'stale_binding'].includes(item.code)) && entry.next_step === 'none') entry.next_step = 'install';
    if (entry.findings.some(item => item.code === 'stale_default') && entry.next_step === 'none') entry.next_step = 'inspect';
    if (entry.findings.some(item => item.code === 'ambiguous_publisher' || item.code === 'unreadable_removal')) entry.next_step = 'inspect';
    if (entry.next_step === 'none' && entry.removal === 'unconfirmed') entry.next_step = 'inspect';
    return entry;
  };
  const plan = (key: string): PlanBody => {
    const entry = describe(key), blockers: PlanBody['blockers'] = [], changes: string[] = [];
    const block = (code: string, message: string) => blockers.push({ code, message });
    const historical = evidence.get(key), row = contracts.get('installed_pack', [key]);
    const proven = historical && !historical.unreadable && historical.inventory_fingerprint === digest(row);
    const action = entry.recipes.length ? 'none' : row && proven ? 'finish_local_cleanup' : !row && Object.values(entry.metadata).some(Boolean) ? 'retire_orphaned_metadata' : 'none';
    if (action === 'none') block('no_supported_repair', entry.recipes.length ? 'Stored recipes remain. Use the existing install or reviewed removal flow.' : 'No supported local cleanup is proven. Use the normal install review for missing content.');
    if (entry.findings.some(item => item.code === 'ambiguous_publisher')) block('ambiguous_publisher', 'Resolve conflicting publisher evidence before local cleanup.');
    if (entry.removal === 'unreadable') block('unreadable_removal', 'Authenticated removal evidence is required before cleanup.');
    const leftoverIds = historical && !historical.unreadable ? ownedSnapshot.recipes.filter(item => historical.recipes.includes(item.recipe_id)
      && (item.schedules || item.automations || item.settings)).map(item => item.recipe_id) : [];
    if (leftoverIds.length) block('recipe_state_cleanup', `Inspect the remaining recipe settings or automations before local metadata cleanup: ${leftoverIds.join(', ')}.`);
    if (historical && !historical.unreadable && historical.recipes.length && !ownedSnapshot.available && snapshot.recipe_state_present) {
      block('recipe_state_unavailable', 'Configure recipe-owned state inspection before cleaning up this interrupted removal.');
    }
    if (packRemovalActive(db, key)) block('removal_active', 'A removal is still running. Wait for its outcome before repair.');
    if (records.some(record => record.key === key && record.ns.state.state !== 'orphaned')) block('records_active', 'Use the Records lifecycle for an active or migrating namespace. Retained data is never repaired or purged here.');
    if (snapshot.webhooks.some(item => item.consumer_kind === 'pack_install' && item.consumer_id === key)) block('webhook_cleanup', 'This pack still owns webhook bindings. Complete the provider cleanup through reviewed removal.');
    if (graph.dependants([key]).length) block('dependants', 'Installed packs still depend on this pack or its last ingredient provider.');
    if (scope('pack_connection_holder').some(item => value(item.value).holder_pack_id === key && item.segments[0] !== key
      && scope('installed_pack').some(pack => pack.segments[0] === item.segments[0]))) block('connection_borrowers', 'Another installed pack still borrows this sign-in.');
    if (snapshot.reservations.some(item => item.pack_slug === key && item.plan_slug !== key || item.plan_slug === key && item.pack_slug !== key)) {
      block('shared_update_plan', 'A retained update plan includes another pack. Release that plan through the update flow first.');
    }
    if (snapshot.members.some(item => item.pack_slug === key && snapshot.recipes.some(recipe => recipe.recipe_id === item.recipe_id && recipe.pack_slug !== key))) {
      block('shared_update_members', 'Update protection still names a stored recipe outside this pack, including manually saved recipes. Inspect its update plan first.');
    }
    const manifest = resolveBundledPackManifest(deps.packDir, key);
    if (manifest && isCoreFeaturePack(manifest)) block('core_feature', 'Recued maintains this core feature.');
    // These stores have their own hooks (alert cleanup and customer grant snapshots).
    // Keep them on the existing removal path rather than skipping those hooks.
    const hasView = snapshot.views.some(item => { try { const view: unknown = JSON.parse(String(item.data));return object(view) && object(view.pack) && view.pack.slug === entry.pack.pack_slug; } catch { return true; } });
    if (hasView || snapshot.classes.some(item => typeof item.origin === 'string' && item.origin.startsWith('pack:') && item.origin.endsWith('/' + entry.pack.pack_slug))
      || scope('contract_grant').some(item => value(item.value).source_pack === key)) block('specialized_cleanup', 'Pack-owned views, classes or customer grants require the existing removal flow and its cleanup hooks.');
    const ids = entry.ingredients.map(item => item.id);
    const shared = new Set(scope('installed_pack').filter(item => item.segments[0] !== key).flatMap(item => strings(value(item.value).ingredient_ids)));
    const removed = action === 'finish_local_cleanup' ? ids.filter(id => !shared.has(id)) : [];
    const manifests = action === 'finish_local_cleanup' ? privateByoDropIds(contracts, key).filter(id => snapshot.manifests.some(item => item.slug === id)) : [];
    if (manifests.length && !deps.registry) block('registry_unavailable', 'Local catalog cleanup requires the live manifest registry.');
    const ownedBindings = bindings(key), grants = owned('grant', key);
    const connections = [...new Set([...ownedBindings.map(item => item.segments[0]!), ...grants.map(item => item.segments[2]).filter((item): item is string => !!item)])].sort();
    if (action === 'finish_local_cleanup') changes.push('Remove the remaining installation inventory and its unshared ingredient inventory.');
    if (entry.metadata.grants) changes.push(`Revoke ${entry.metadata.grants} pack-owned operation grants.`);
    if (entry.metadata.body_grants) changes.push(`Revoke ${entry.metadata.body_grants} pack-owned body visibility grants.`);
    if (entry.metadata.bindings || entry.metadata.defaults || entry.metadata.holders) changes.push(`Remove ${entry.metadata.bindings} catalog bindings, ${entry.metadata.defaults} connection defaults and ${entry.metadata.holders} sign-in holder rows. Connection credentials stay enrolled.`);
    if (entry.metadata.protection || entry.metadata.history) changes.push('Retire this pack’s update protection and retained release history.');
    const templates = owned('installed_reception_template', key);
    if (templates.length) changes.push(`Remove ${templates.length} pack-owned reception templates.`);
    if (manifests.length) changes.push('Remove the listed unshared local catalog bodies.');
    const transitions = deps.computeWouldWorsen?.(key) ?? [];
    return { entry, action, blockers, changes, manifests_removed: manifests, ingredients_removed: removed,
      ingredients_kept: ids.filter(id => shared.has(id)), connections,
      unknown_dependencies: graph.unknown.filter(item => item.inventory_key !== key),
      would_disable: transitions.filter(item => item.after === 'blocked').map(item => item.recipe_id).sort(),
      would_degrade: transitions.filter(item => item.after === 'degraded').map(item => item.recipe_id).sort() };
  };
  const inspection = (now: number): PackRepairInspection => ({ inspected_at: now, entries: [...keys].sort().map(describe),
    unattributed_manifests: [...new Set(snapshot.manifests.map(row => String(row.slug)))].filter(slug => !scope('installed_ingredient').some(row => row.segments[0] === slug)).sort(), recent_repairs: [], unavailable_receipts: 0 });
  const mutate = (body: PlanBody) => {
    const key = body.entry.pack.inventory_key;
    assertCurrent();if (packRemovalActive(db, key)) throw new RpcError('pack_repair_conflict', 'Removal started after this repair review.', 409);
    if (body.action === 'finish_local_cleanup') removePackInventory(contracts, key);
    for (const name of ['grant', 'pack_connection_default', 'pack_connection_holder', 'installed_reception_template'] as const) {
      for (const row of owned(name, key)) contracts.delete(name, row.segments);
    }
    for (const row of bindings(key)) contracts.delete('connection_catalog_binding', row.segments);
    if (body.entry.metadata.body_grants) createMcpBodyVisibilityStore(db).revokeForPack({ pack_slug: key, ...(body.entry.pack.publisher ? { publisher: body.entry.pack.publisher } : {}) });
    if (body.manifests_removed.length) { const local = createLocalManifestStore(db);for (const slug of body.manifests_removed) local.delete(slug); }
    retirePackUpdates(db, key);
  };
  return { fingerprint, inspection, describe, plan, assertCurrent, mutate };
};
