/** Plans contain only explicit local-reference edits. Inspection never calls a
 * provider or moves a webhook door. The receipt store owns the write lock. */
import type Database from 'better-sqlite3';
import { RpcError, connectionViewFromRow, endpointHost, findEndpointCandidates, regressionBytes,
  type ConnectionReplacementSelection as Selection, type ConnectionReplacementPlan as Plan,
  type ConnectionReplacementIdentity as Identity, type ConnectionReplacementPack as Pack,
  type ConnectionReplacementDish as DishView, type ConnectionReplacementIssue as Issue,
  type ConnectionReplacementImpact as Impact, type Dish, type RecipeDefinition,
} from '@recued/contracts';
import { packConnectionsView, type PackConnectionsDeps } from './pack-connections-handler.js';
import type { DishStore } from './dish-store.js';
import type { RecipeStore } from './recipe-store.js';
import { recipeConnectionSlots } from './recipe-connection-choices.js';
import type { ContractRow } from './storage/contract-store.js';
import { createPackConnectionHolderStore } from './storage/pack-connection-holder-store.js';
import { allCatalogBindings } from './storage/connection-catalog-binding-store.js';
import { effectiveSlotDefault } from './pack-connection-outcomes.js';
import { recipeReleaseDigest as digest } from './storage/recipe-release-authority.js';

export interface ConnectionReplacementDeps {
  packs: PackConnectionsDeps; dishes: DishStore; recipes: RecipeStore;
}
interface Value { value: unknown }
export interface ReferenceEdit { scope: string; segments: string[]; before: Value | null; after: Value | null }
export interface DishEdit { before: Dish; after: Dish }
export interface ReplacementEdits { references: ReferenceEdit[]; dishes: DishEdit[] }
export type ReplacementBody = Omit<Plan, 'review_id' | 'expires_at'>;
const SCOPES = ['installed_pack', 'installed_ingredient', 'connection_catalog_binding', 'pack_connection_default', 'pack_connection_holder', 'grant', 'override'];
const TABLES = ['schedules', 'event_triggers', 'auto_run_timers', 'dish_groups', 'dish_context_recipe',
  'webhook_ingresses', 'webhook_consumer_bindings', 'webhook_recipe_triggers'];
const ownObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonempty = (value: unknown): boolean => value !== undefined && value !== null && value !== ''
  && (!Array.isArray(value) || value.length > 0) && (!ownObject(value) || Object.keys(value as object).length > 0);
const contains = (value: unknown, names: ReadonlySet<string>): boolean => {
  if (typeof value === 'string') {
    if (names.has(value) || value.startsWith('api:') && names.has(value.slice(4))) return true;
    // Persisted JSON columns and namespace expressions, without substring name matches.
    if (value.startsWith('{') || value.startsWith('[')) { try { return contains(JSON.parse(value), names); } catch { /* ordinary text */ } }
    return [...names].some(name => value.includes(`connection.api.${name}.`) || value.includes(`connection.api.${name}}`));
  }
  if (Array.isArray(value)) return value.some(item => contains(item, names));
  return Object.values(ownObject(value) ?? {}).some(item => contains(item, names));
};
const hasWebhook = (value: unknown): boolean => Array.isArray(value) ? value.some(hasWebhook)
  : Object.entries(ownObject(value) ?? {}).some(([key, item]) => /^(webhook_requirements|webhook_bindings|webhook_triggers|webhook_ingress|ingress_binding|webhooks)$/.test(key) && nonempty(item) || hasWebhook(item));
export const replacementConflict = (message = 'The reviewed account references changed. Inspect and review again.'): never => {
  throw new RpcError('connection_replacement_conflict', message, 409);
};
const limited = (value: unknown) => { if (regressionBytes(value) > 8_000_000) throw new RpcError('connection_replacement_limit', 'Keep replacement evidence under 8 MB.', 409); };
const rowKey = (scope: string, segments: readonly string[]) => JSON.stringify([scope, segments]);

export const prepareConnectionReplacement = async (db: Database.Database, deps: ConnectionReplacementDeps, check: () => void) => {
  const { packs, dishes, recipes } = deps, contracts = packs.contractStore;
  const table = (name: string): Record<string, unknown>[] => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) return [];
    // Names come exclusively from TABLES above. Runtime fire statistics do not
    // change what is being reviewed; configuration, switches and filters do.
    const rows = db.prepare(`SELECT * FROM "${name}" LIMIT 2001`).all() as Record<string, unknown>[];
    if (rows.length > 2000) throw new RpcError('connection_replacement_limit', 'Review fewer local resources at once.', 409);
    return rows.map(raw => {
      const row = { ...raw };
      if (typeof row.data === 'string') row.data = JSON.parse(row.data);
      for (const key of ['last_fired_at', 'last_error', 'updated_at', 'last_run_at', 'run_count', 'next_run_at']) delete row[key];
      if (name === 'schedules' && ownObject(row.data)) {
        const data = { ...ownObject(row.data)! };
        for (const key of ['last_run_at', 'last_error', 'next_run_at', 'run_count', 'last_result']) delete data[key];
        row.data = data;
      }
      return row;
    }).sort((a, b) => digest(a).localeCompare(digest(b)));
  };
  const read = () => {
    check();
    const rows = packs.connectionStore.list().sort((a, b) => a.pk.localeCompare(b.pk));
    const connections = rows.filter(row => row.kind === 'api').map(row => {
      const pins = db.prepare("SELECT kind,key,incarnation,revision,content_hash,present FROM preapproval_resource_identity WHERE key=? AND kind IN ('connection','connection_credential') ORDER BY kind").all(row.pk);
      const view = connectionViewFromRow(row);
      const identity: Identity = { connection_name: row.name, display_name: row.display_name || row.name, host: endpointHost(view.base_url),
        ...(typeof view.vendor === 'string' ? { vendor: view.vendor } : {}),
        identity: digest({ pins, kind: row.kind, name: row.name, config: row.config_json, credential: digest(row.auth_ciphertext),
          enrolled_at: row.enrolled_at, subresource_path: row.subresource_path, scopes: row.granted_scopes_json }) };
      return { identity, pins: pins.length };
    });
    const refs = SCOPES.flatMap(scope => contracts.scan(scope));
    const allDishes = dishes.list();
    const tables = Object.fromEntries(TABLES.map(name => [name, table(name)]));
    const stored = recipes.listStored().map(row => ({ recipe_id: row.recipe_id, pack_slug: row.pack_slug, recipe_hash: digest(row.recipe_json) }));
    const recipeIds = new Set([...stored.map(row => row.recipe_id), ...(packs.listRecipes?.() ?? []).map(recipe => recipe.recipe_id), ...allDishes.map(dish => dish.recipe_id)]);
    for (const name of ['schedules', 'event_triggers', 'auto_run_timers']) {
      for (const row of tables[name]) if (typeof row.recipe_id === 'string') recipeIds.add(row.recipe_id);
    }
    const allRecipes = [...recipeIds].sort().map(id => ({ id, recipe: recipes.get(id) }));
    const profiles = packs.operationProfiles?.list();
    const compositions = packs.localManifestStore?.listManifests();
    const otherKinds = rows.filter(row => row.kind !== 'api').map(row => ({ kind: row.kind, name: row.name }));
    const result = { connections, otherKinds, refs, allDishes, allRecipes, stored, tables, profiles, compositions };
    limited(result);
    if (refs.length > 10000 || allDishes.length > 2000 || allRecipes.length > 2000) throw new RpcError('connection_replacement_limit', 'Review fewer local references at once.', 409);
    return result;
  };
  const snapshot = read(), fingerprint = digest(snapshot);
  const manifests = new Map<string, ReturnType<PackConnectionsDeps['getManifest']>>();
  const packManifests = new Map<string, ReturnType<NonNullable<PackConnectionsDeps['resolvePackManifest']>>>();
  const getManifest = (id: string) => { if (!manifests.has(id)) manifests.set(id, structuredClone(packs.getManifest(id)));return manifests.get(id); };
  const manifestOf = (id: string) => { if (!packManifests.has(id)) packManifests.set(id, structuredClone(packs.resolvePackManifest?.(id) ?? null));return packManifests.get(id)!; };
  const assertCurrent = () => {
    check();if (digest(read()) !== fingerprint) replacementConflict();
    for (const [id, value] of manifests) if (digest(packs.getManifest(id)) !== digest(value)) replacementConflict();
    for (const [id, value] of packManifests) if (digest(packs.resolvePackManifest?.(id) ?? null) !== digest(value)) replacementConflict();
  };
  const auth = new Map<string, ReturnType<NonNullable<PackConnectionsDeps['authTypeOf']>>>();
  const viewDeps: PackConnectionsDeps = { ...packs, getManifest, resolvePackManifest: manifestOf,
    authTypeOf: row => { if (!auth.has(row.pk)) auth.set(row.pk, packs.authTypeOf?.(row) ?? Promise.resolve(undefined));return auth.get(row.pk)!; } };
  const holders = createPackConnectionHolderStore(contracts);
  const slugs = [...new Set(snapshot.refs.filter(row => row.scope === 'connection_catalog_binding')
    .map(row => ownObject(row.value)?.installed_pack_id).filter((id): id is string => typeof id === 'string'))].sort();
  const views = new Map(await Promise.all(slugs.map(async slug => [slug, await packConnectionsView(viewDeps, slug)] as const)));
  const authResults = new Map(await Promise.all([...auth].map(async ([key, value]) => [key, await value] as const)));
  assertCurrent();
  const apiViews = packs.connectionStore.list().filter(row => row.kind === 'api').map(row => ({ ...connectionViewFromRow(row), auth_type: authResults.get(row.pk) }));
  const compatibility = (slug: string, target: string): Issue[] => {
    const requirements = manifestOf(slug)?.connection_requirements;
    if (requirements?.length !== 1) return [{ code: 'compatibility_unavailable', message: 'Inspect the installed pack’s exact connection requirement before moving it.', resource: slug }];
    return findEndpointCandidates(requirements[0]!, apiViews).some(row => row.name === target) ? []
      : [{ code: 'incompatible_connection', message: 'The replacement does not satisfy this pack’s connection requirement.', resource: slug }];
  };
  const scanFor = (rows: ContractRow[]) => (scope: string, prefix: readonly string[]) => rows.filter(row => row.scope === scope && prefix.every((part, index) => row.segments[index] === part));
  const defaultFor = (refs: ContractRow[], catalogs: string[]) => {
    const scan = scanFor(refs), bindings = allCatalogBindings(scan).filter(row => catalogs.includes(row.catalog_slug));
    return effectiveSlotDefault(scan, catalogs, bindings, new Set(snapshot.connections.map(row => row.identity.connection_name)));
  };
  const slotsFor = (refs: ContractRow[]) => recipeConnectionSlots({ contractScan: scanFor(refs), manifests: { get: id => getManifest(id) ?? null },
    enrolled: new Set(snapshot.connections.map(row => row.identity.connection_name)), displayName: name => snapshot.connections.find(row => row.identity.connection_name === name)?.identity.display_name,
    packManifestOf: manifestOf, profiles: packs.operationProfiles, localManifestStore: packs.localManifestStore });
  const identity = (name: string) => {
    const found = snapshot.connections.find(row => row.identity.connection_name === name);
    if (!found || found.pins !== 2) throw new RpcError('connection_replacement_unsupported', 'Use two currently enrolled API connections with durable identities.', 409);
    return found.identity;
  };
  const choices = (from: string, to: string): Pack[] => {
    identity(from);identity(to);
    if (from === to) throw new RpcError('bad_request', 'Choose two different enrolled connections.', 400);
    const out: Pack[] = [];
    for (const [slug, view] of views) for (const slot of view.slots) {
      if (slot.held_by || !slot.connections.some(row => row.connection_name === from)) continue;
      const blockers: Issue[] = compatibility(slug, to);
      if (holders.borrowersOf(slug).some(member => { const requested = holders.get(member)?.slot;return requested !== undefined && !view.slots.some(item => item.slot === requested); })) blockers.push({ code: 'shared_signin_unavailable', message: 'A shared sign-in names an unavailable holder slot. Inspect its ownership first.', resource: slug });
      if (!authResults.get('api:' + from) || !authResults.get('api:' + to)) blockers.push({ code: 'auth_unreadable', message: 'Both enrolled authentication definitions must be readable for a compatibility review.', resource: slug });
      if (slot.catalogs.some(id => getManifest(id)?.surfaces?.api?.transport === 'mcp')) blockers.push({ code: 'unsupported_transport', message: 'This review supports API account references. Inspect this MCP catalog through its existing connection controls.', resource: slug });
      const before = slot.connections.map(row => row.connection_name).sort();
      const after = [...new Set(before.map(name => name === from ? to : name))].sort();
      const current = slot.connections.find(row => row.is_default)?.connection_name;
      const family = new Set([slug, ...holders.borrowersOf(slug)]);
      const projected = snapshot.refs.map(row => row.scope === 'connection_catalog_binding' && row.segments[0] === from
        && family.has(String(ownObject(row.value)?.installed_pack_id)) && slot.catalogs.includes(String(ownObject(row.value)?.catalog_slug))
        ? { ...row, segments: [to, ...row.segments.slice(1)] } : row);
      if (current === from) {
        const prior = projected.findIndex(row => row.scope === 'pack_connection_default' && row.segments[0] === slug && row.segments[1] === slot.slot);
        const nextRow = { scope: 'pack_connection_default', segments: [slug, slot.slot], value: { connection_name: to }, written_at: 0 };
        if (prior < 0) projected.push(nextRow);else projected[prior] = nextRow;
      }
      const next = defaultFor(projected, slot.catalogs);
      out.push({ pack_slug: slug, slot: slot.slot, pack_name: manifestOf(slug)?.name ?? slug, catalogs: slot.catalogs,
        shared_with: (slot.shared_with ?? holders.borrowersOf(slug)).filter(member => { const requested = holders.get(member)?.slot;return requested === undefined ? view.slots[0]?.slot === slot.slot : requested === slot.slot; }), before_connections: before, after_connections: after,
        ...(current ? { before_default: current } : {}), ...(next ? { after_default: next } : {}), blockers });
    }
    return out;
  };
  const dishChoices = (from: string): DishView[] => snapshot.allDishes.flatMap(dish => {
    const slots = Object.entries(dish.connections ?? {}).filter(([, name]) => name === from).map(([slot]) => slot);
    return slots.length ? [{ dish_id: dish.dish_id, recipe_id: dish.recipe_id, name: dish.name || dish.recipe_id, slots }] : [];
  });
  const project = (edits: ReplacementEdits): ContractRow[] => {
    const rows = new Map(snapshot.refs.map(row => [rowKey(row.scope, row.segments), row]));
    for (const edit of edits.references) {
      if (edit.after) rows.set(rowKey(edit.scope, edit.segments), { scope: edit.scope, segments: edit.segments, value: edit.after.value, written_at: 0 });
      else rows.delete(rowKey(edit.scope, edit.segments));
    }
    return [...rows.values()];
  };
  const analyze = (from: Identity, to: Identity, selectedPacks: Pack[], selectedDishes: DishView[], edits: ReplacementEdits, direction: Plan['direction'], parent?: string) => {
    const blockers = selectedPacks.flatMap(pack => pack.blockers), afterRefs = project(edits);
    for (const pack of selectedPacks) {
      const next = defaultFor(afterRefs, pack.catalogs);
      if (next === undefined) delete pack.after_default;else pack.after_default = next;
    }
    const beforeSlots = slotsFor(snapshot.refs), afterSlots = slotsFor(afterRefs), impacts: Impact[] = [];
    const changedDishes = new Map(edits.dishes.map(edit => [edit.before.dish_id, edit.after]));
    const changedPacks = new Set(selectedPacks.flatMap(pack => [pack.pack_slug, ...pack.shared_with]));
    const add = (code: string, message: string, resource?: string) => { blockers.push({ code, message, ...(resource ? { resource } : {}) }); };
    for (const pack of selectedPacks) {
      for (const member of [pack.pack_slug, ...pack.shared_with]) {
        blockers.push(...compatibility(member, to.connection_name));
        if (member !== pack.pack_slug && holders.borrowersOf(member).length) add('nested_shared_signin', 'Nested shared sign-ins need a separate ownership review.', member);
        if (!snapshot.refs.some(row => row.scope === 'installed_pack' && row.segments[0] === member)) add('missing_inventory', 'Inspect this pack’s installation before replacing its connection.', member);
        if (hasWebhook(manifestOf(member)) || pack.catalogs.some(id => hasWebhook(getManifest(id)))) add('provider_webhook', 'Use the existing webhook release or replacement lifecycle first.', member);
      }
    }
    for (const { id, recipe } of snapshot.allRecipes) {
      const savedDishes = snapshot.allDishes.filter(dish => dish.recipe_id === id);
      if (!recipe) { if (savedDishes.some(dish => changedDishes.has(dish.dish_id)) || snapshot.stored.some(row => row.recipe_id === id && row.pack_slug && changedPacks.has(row.pack_slug)) || ['schedules', 'event_triggers', 'auto_run_timers'].some(name => snapshot.tables[name].some(row => row.recipe_id === id))) add('recipe_unavailable', 'Restore or inspect the recipe before moving its saved account choices.', id);continue; }
      const before = beforeSlots(recipe), after = afterSlots(recipe);
      const changedSlots = before.filter(slot => digest(slot) !== digest(after.find(next => next.slot === slot.slot)));
      const explicit = savedDishes.filter(dish => changedDishes.has(dish.dish_id));
      // Literal references do not appear in the configurable slot reader. Keep
      // them in the review: removing a catalog binding can break those runs too.
      const literalSource = contains(recipe, new Set([from.connection_name]));
      if (!changedSlots.length && !explicit.length && !literalSource) continue;
      const rowsFor = (name: string) => snapshot.tables[name].filter(row => row.recipe_id === id);
      impacts.push({ recipe_id: id, name: recipe.metadata.name || id, dish_ids: savedDishes.map(dish => dish.dish_id),
        schedules: rowsFor('schedules').length, triggers: rowsFor('event_triggers').length, timers: rowsFor('auto_run_timers').length });
      if (literalSource) add('recipe_literal', 'This recipe contains a literal source connection. Review its definition instead of rewriting it.', id);
      if (hasWebhook(recipe)) add('provider_webhook', 'This recipe has a webhook. Use its existing release or replacement lifecycle first.', id);
      const opaque = (config: Record<string, unknown>) => Object.values(config).some(nonempty);
      if (opaque(Object.fromEntries(Object.entries(recipe.variables ?? {}).map(([key, value]) => [key, ownObject(value) ? ownObject(value)!.default : value])))) add('account_bound_settings', 'Recipe defaults may contain account-bound values. Clear or review them through the recipe’s normal setup first.', id);
      // Literal operation arguments and executable code cannot be proven portable.
      const stepOpaque = (value: unknown): boolean => {
        if (Array.isArray(value)) return value.some(stepOpaque);
        const row = ownObject(value);if (!row) return false;
        return Object.entries(row).some(([key, item]) => /^(args|inputs|input|code|script|url|path)$/.test(key) && nonempty(item)
          && (typeof item !== 'string' || !/^\{\{[^{}]+\}\}$/.test(item.trim())) || stepOpaque(item));
      };
      if (stepOpaque([recipe.steps, recipe.prefetch_steps, recipe.trigger_steps])) add('opaque_recipe_arguments', 'Literal operation arguments or code need a separate account-portability review.', id);
      for (const dish of savedDishes) {
        const next = changedDishes.get(dish.dish_id) ?? dish;
        for (const [slot, name] of Object.entries(next.connections ?? {})) {
          if (!after.find(item => item.slot === slot)?.connections.some(item => item.connection_name === name)) add('saved_choice_unavailable', 'Include this saved account choice or keep its source on the required pack lists.', dish.dish_id);
        }
        if (opaque(dish.config_overlay)) add('account_bound_settings', 'Saved recipe settings may contain account-bound values. Review them before replacing the connection.', dish.dish_id);
        if (dish.group_id) {
          const group = snapshot.tables.dish_groups.find(row => row.group_id === dish.group_id);
          const data = ownObject(group?.data);
          if (!group || !data || opaque(ownObject(data.config_overlay) ?? {})) add('account_bound_group', 'Shared recipe settings need a separate account-portability review.', dish.dish_id);
        }
      }
      for (const row of rowsFor('schedules')) if (opaque(ownObject(ownObject(row.data)?.config_overlay) ?? {})) add('account_bound_schedule', 'A schedule has account-bound settings that need review.', id);
      for (const row of rowsFor('event_triggers')) if (nonempty(row.filter) || nonempty(row.fields) || contains(row.pattern, new Set([from.connection_name]))) add('account_bound_trigger', 'A trigger has account-bound filters or an explicit source. Review it first.', id);
      if (snapshot.tables.dish_context_recipe.some(row => savedDishes.some(dish => dish.dish_id === row.dish_id) && nonempty(row.data))) add('continuity_state', 'This recipe has saved continuity state. Review or clear it through its normal lifecycle first.', id);
      for (const name of ['webhook_ingresses', 'webhook_consumer_bindings', 'webhook_recipe_triggers']) {
        if (snapshot.tables[name].some(row => contains(row, new Set([id, from.connection_name, ...changedPacks])))) add('provider_webhook', 'A persisted webhook resource needs its existing release or replacement lifecycle first.', id);
      }
    }
    // A known caller can supply opaque IDs to the changed callee. Surface the
    // transitive callers and hold them rather than asserting argument portability.
    const affected = new Set(impacts.map(impact => impact.recipe_id));
    let added = true;
    while (added) {
      added = false;
      for (const { id, recipe } of snapshot.allRecipes) {
        if (!recipe || affected.has(id) || !contains([recipe.steps, recipe.prefetch_steps, recipe.trigger_steps], affected)) continue;
        affected.add(id);added = true;
        add('recipe_caller', 'This recipe refers to a changed recipe. Review its account-bound arguments separately.', id);
        const count = (name: string) => snapshot.tables[name].filter(row => row.recipe_id === id).length;
        impacts.push({ recipe_id: id, name: recipe.metadata.name || id, dish_ids: snapshot.allDishes.filter(dish => dish.recipe_id === id).map(dish => dish.dish_id),
          schedules: count('schedules'), triggers: count('event_triggers'), timers: count('auto_run_timers') });
      }
    }
    for (const row of snapshot.refs.filter(row => row.scope === 'override')) if (contains(row, new Set([from.connection_name])) && contains(row, changedPacks)) add('connection_policy', 'A connection-specific policy needs a separate review.', row.segments.join('/'));
    // Even with no recipe currently installed, an ingress can bind the account.
    if (snapshot.tables.webhook_ingresses.some(row => contains(row, new Set([from.connection_name])))) add('provider_webhook', 'The source connection owns a webhook ingress. Use its existing replacement lifecycle first.');
    if (snapshot.otherKinds.some(row => row.name === from.connection_name || row.name === to.connection_name)) add('ambiguous_connection_kind', 'A selected name is shared with another connection kind. Use unambiguous API connection names for this review.');
    if (!authResults.get('api:' + from.connection_name) || !authResults.get('api:' + to.connection_name)) add('auth_unreadable', 'Inspect both enrolled authentication definitions before moving account references.');
    const unique = [...new Map(blockers.map(issue => [digest(issue), issue])).values()];
    const changes = [...selectedPacks.map(pack => `${pack.pack_name} · ${pack.slot}: ${from.connection_name} → ${to.connection_name}${pack.shared_with.length ? `; shared with ${pack.shared_with.join(', ')}` : ''}`),
      ...selectedDishes.map(dish => `${dish.name}: ${dish.slots.join(', ')} → ${to.connection_name}`),
      ...edits.references.filter(edit => edit.scope === 'grant').map(edit => `${edit.after ? 'Create' : 'Remove'} saved grant ${edit.segments.join(' / ')}${edit.after ? ': ' + JSON.stringify(edit.after.value) : ''}.`),
      `${edits.references.length} local reference rows; ${edits.dishes.length} saved recipe account choices.`,
      'Affected pre-approvals are invalidated through the existing store lifecycle. Ordinary automation switches are retained.'];
    const body: ReplacementBody = { direction, ...(parent ? { parent_receipt_id: parent } : {}), from, to, packs: selectedPacks, dishes: selectedDishes, impacts, blockers: unique, changes };
    limited({ body, edits });return body;
  };
  const plan = (selection: Selection) => {
    const from = identity(selection.from_connection), to = identity(selection.to_connection), available = choices(selection.from_connection, selection.to_connection);
    const packsSelected = selection.targets.map(target => {
      const pack = available.find(item => item.pack_slug === target.pack_slug && item.slot === target.slot);
      if (!pack) replacementConflict('A selected pack no longer holds that source connection.');return structuredClone(pack!);
    });
    const availableDishes = dishChoices(selection.from_connection);
    const dishesSelected = selection.dish_ids.map(id => { const dish = availableDishes.find(item => item.dish_id === id);if (!dish) replacementConflict('A selected recipe no longer holds that source account choice.');return dish!; });
    if (!packsSelected.length && !dishesSelected.length) throw new RpcError('bad_request', 'Select at least one pack or saved recipe account choice.', 400);
    const refs = new Map(snapshot.refs.map(row => [rowKey(row.scope, row.segments), row]));
    const references = new Map<string, ReferenceEdit>();
    const put = (scope: string, segments: string[], value: Value | null) => {
      const key = rowKey(scope, segments), before = refs.get(key);
      const prior = references.get(key);
      references.set(key, { scope, segments, before: prior?.before ?? (before ? { value: before.value } : null), after: value });
    };
    for (const pack of packsSelected) {
      for (const member of [pack.pack_slug, ...pack.shared_with]) {
        const memberView = views.get(member)?.slots.find(slot => slot.slot === pack.slot && (member === pack.pack_slug || slot.held_by === pack.pack_slug));
        if (!memberView) { pack.blockers.push({ code: 'shared_signin_unavailable', message: 'Inspect the shared sign-in before changing its holder.', resource: member });continue; }
        for (const catalog of memberView.catalogs) {
          const bindings = snapshot.refs.filter(row => row.scope === 'connection_catalog_binding' && ownObject(row.value)?.catalog_slug === catalog);
          const mine = bindings.filter(row => row.segments[0] === from.connection_name && ownObject(row.value)?.installed_pack_id === member);
          const target = bindings.find(row => row.segments[0] === to.connection_name);
          const invalidTarget = target && (target.segments.length !== 1 && target.segments.length !== 2
            || target.segments.length === 2 && target.segments[1] !== catalog
            || ownObject(target.value)?.slot !== undefined && ownObject(target.value)?.slot !== memberView.slot);
          if (mine.length !== 1 || invalidTarget || target && ownObject(target.value)?.installed_pack_id !== member) { pack.blockers.push({ code: 'binding_ownership', message: 'Catalog binding ownership is missing or shared with another installation.', resource: catalog });continue; }
          for (const old of mine) put(old.scope, old.segments, null);
          if (!target) put('connection_catalog_binding', [to.connection_name, catalog], { value: { catalog_slug: catalog, installed_pack_id: member, slot: memberView.slot } });
          for (const grant of snapshot.refs.filter(row => row.scope === 'grant' && row.segments[0] === member && row.segments[1] === catalog && row.segments[2] === from.connection_name)) {
            const segments = [...grant.segments];segments[2] = to.connection_name;
            const existing = refs.get(rowKey('grant', segments));
            if (existing && digest(existing.value) !== digest(grant.value)) pack.blockers.push({ code: 'grant_conflict', message: 'The replacement already has a different grant. Review it separately.', resource: member });
            else if (!existing) put('grant', segments, { value: grant.value });
            put('grant', grant.segments, null);
          }
        }
      }
      if (pack.before_default === from.connection_name) put('pack_connection_default', [pack.pack_slug, pack.slot], { value: { connection_name: to.connection_name } });
    }
    const edits: ReplacementEdits = { references: [...references.values()].filter(edit => digest(edit.before) !== digest(edit.after)), dishes: dishesSelected.map(selected => {
      const before = snapshot.allDishes.find(dish => dish.dish_id === selected.dish_id)!;
      return { before, after: { ...before, connections: Object.fromEntries(Object.entries(before.connections ?? {}).map(([slot, name]) => [slot, name === from.connection_name ? to.connection_name : name])) } };
    }) };
    return { body: analyze(from, to, packsSelected, dishesSelected, edits, 'replace'), edits };
  };
  const rollback = (original: ReplacementBody, previous: ReplacementEdits, receiptId: string) => {
    if (digest(identity(original.from.connection_name)) !== digest(original.from) || digest(identity(original.to.connection_name)) !== digest(original.to)) replacementConflict('An enrolled account changed after the original replacement. Review its current identity separately.');
    const edits: ReplacementEdits = { references: previous.references.map(edit => ({ ...edit, before: edit.after, after: edit.before })), dishes: previous.dishes.map(edit => ({ before: edit.after, after: edit.before })) };
    for (const edit of edits.references) { const current = snapshot.refs.find(row => rowKey(row.scope, row.segments) === rowKey(edit.scope, edit.segments));if (digest(current ? { value: current.value } : null) !== digest(edit.before)) replacementConflict('A changed reference was edited after replacement. Rollback cannot overwrite it.'); }
    for (const edit of edits.dishes) if (digest(snapshot.allDishes.find(dish => dish.dish_id === edit.before.dish_id)) !== digest(edit.before)) replacementConflict('Saved recipe settings changed after replacement. Rollback cannot overwrite them.');
    const available = choices(original.to.connection_name, original.from.connection_name);
    const selected = original.packs.map(pack => {
      const current = available.find(item => item.pack_slug === pack.pack_slug && item.slot === pack.slot);
      if (!current || digest([current.catalogs, current.shared_with, current.before_connections, current.before_default])
        !== digest([pack.catalogs, pack.shared_with, pack.after_connections, pack.after_default])) replacementConflict('The pack account list or shared sign-in ownership changed after replacement. Review its current setup separately.');
      return { ...pack, pack_name: current!.pack_name, before_connections: pack.after_connections, after_connections: pack.before_connections,
        before_default: pack.after_default, after_default: pack.before_default, blockers: current!.blockers };
    });
    const dishViews = previous.dishes.map(edit => ({ dish_id: edit.after.dish_id, recipe_id: edit.after.recipe_id, name: edit.after.name || edit.after.recipe_id,
      slots: Object.entries(edit.before.connections ?? {}).filter(([slot, name]) => edit.after.connections?.[slot] !== name).map(([slot]) => slot) }));
    return { body: analyze(original.to, original.from, selected, dishViews, edits, 'rollback', receiptId), edits };
  };
  const mutate = (edits: ReplacementEdits) => {
    for (const edit of edits.references) {
      if (edit.after) contracts.put(edit.scope, edit.segments, edit.after.value);
      else contracts.delete(edit.scope, edit.segments);
    }
    for (const edit of edits.dishes) dishes.set(edit.after);
  };
  return { get fingerprint() { return digest({ snapshot: fingerprint, manifests: [...manifests].sort(([a], [b]) => a.localeCompare(b)), pack_manifests: [...packManifests].sort(([a], [b]) => a.localeCompare(b)) }); }, assertCurrent, plan, rollback, mutate,
    inspect(from?: string, to?: string) {
      return { connections: snapshot.connections.filter(row => row.pins === 2).map(row => row.identity), packs: from && to ? choices(from, to) : [], dishes: from ? dishChoices(from) : [], recent: [], unavailable_receipts: 0 };
    },
  };
};
