/** Read-only scope changes for the exact packs an install will touch. */
import { createHash } from 'node:crypto';
import { declaredConnectionSlots, scopeCoverage, UNECHOED_AUTHORIZATION_SCOPES,
  type BulkPackManifest, type ConnectionView, type PackVendorPermissionReview,
  type PackVendorPermissionConnection } from '@recued/contracts';
import type { PackInstallRpcDeps } from './pack-install-handler.js';
import { installedCompositionCatalogs } from './pack-operation-update-diff.js';
import { getInstalledPack, packIngredientIds } from './pack-inventory.js';
import { createConnectionCatalogBindingStore } from './storage/connection-catalog-binding-store.js';
import { oauthScopesCover } from './managed-oauth-service.js';

const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const base = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  try { const url = new URL(v); if (url.username || url.password) return undefined;
    url.hash = ''; return url.toString().replace(/\/+$/, ''); } catch { return undefined; }
};
const authentication = (view: ConnectionView): PackVendorPermissionConnection['authentication'] =>
  view.auth_type === 'oauth2_refresh' ? 'direct_oauth' : view.auth_type === 'managed_oauth' ? 'broker'
    : view.auth_type === undefined ? 'unknown' : 'other';
const origin = (pack: BulkPackManifest): string | undefined => {
  try { return new URL(pack.connection_requirements?.[0]?.api_base ?? '').origin; }
  catch { return undefined; }
};
const reviewFromConnections = (deps: PackInstallRpcDeps,
  touched: readonly BulkPackManifest[] | null, root: BulkPackManifest,
  connections: readonly ConnectionView[], accountsResolved: boolean): PackVendorPermissionReview => {
  let resolved = touched !== null && accountsResolved;
  const bindings = deps.contractStore ? createConnectionCatalogBindingStore(deps.contractStore).list() : [];
  const changes: PackVendorPermissionReview['changes'] = [];
  const installedMaterial: unknown[] = [];
  const relevantConnections = new Set<ConnectionView>();
  for (const pack of touched ?? [root]) {
    const installed = deps.contractStore ? getInstalledPack(deps.contractStore, pack.slug) : null;
    const ownBindings = bindings.filter(b => b.installed_pack_id === pack.slug);
    const previous = new Map<string, Set<string>>();
    let known = !installed;
    if (installed && deps.contractStore && deps.localManifestStore) {
      const catalogs = installedCompositionCatalogs(deps.contractStore, deps.localManifestStore, pack.slug);
      known = catalogs.size === packIngredientIds(deps.contractStore, pack.slug).length;
      for (const [id, catalog] of catalogs) {
        const slot = ownBindings.find(b => b.catalog_slug === id)?.slot;
        if (catalog.operations === undefined) { known = false; continue; }
        const scopes = Object.values(catalog.operations ?? {}).flatMap(op => op.required_scopes ?? []).map(scope => scope.trim()).filter(Boolean);
        if (scopes.length && !slot) { known = false; continue; }
        if (slot) previous.set(slot, new Set([...(previous.get(slot) ?? []), ...scopes]));
      }
      installedMaterial.push([pack.slug, installed, [...catalogs], ownBindings]);
    } else if (installed) installedMaterial.push([pack.slug, installed, ownBindings]);
    const required = declaredConnectionSlots(pack);
    const referencedBases = new Map<string, string>();
    // Referenced catalogs carry their scopes on the resolved operation body.
    // A missing body is unknown, never evidence that the pack needs no scopes.
    for (const content of pack.contents ?? []) {
      if (content.type !== 'ingredient') continue;
      const id = content.slug ?? content.ingredient_id;
      // Runtime op lowering resolves referenced catalogs through the live registry.
      const catalog = id ? deps.registry ? deps.registry.get(id)
        : deps.getManifest?.(id) ?? deps.localManifestStore?.getManifest(id) : undefined;
      if (!id || !catalog) { resolved = false; continue; }
      if (catalog.operations === undefined) {
        if (catalog.surfaces?.api || ['http', 'connection', 'mcp'].includes(catalog.kind)) resolved = false;
        continue;
      }
      const scopes = Object.values(catalog.operations ?? {}).flatMap(op => op.required_scopes ?? []).map(scope => scope.trim()).filter(Boolean);
      if (!scopes.length) continue;
      const apiBase = catalog.surfaces?.api?.default_base_url;
      const requirement = pack.connection_requirements?.find(r => base(apiBase) !== undefined && base(r.api_base) === base(apiBase));
      const slot = ownBindings.find(b => b.catalog_slug === id)?.slot ?? requirement?.vendor ?? id;
      if (apiBase) referencedBases.set(slot, apiBase);
      Object.defineProperty(required, slot, { value: [...new Set([...(Object.hasOwn(required, slot) ? required[slot] : []), ...scopes])].sort(),
        configurable: true, enumerable: true, writable: true });
    }
    for (const slot of [...new Set([...Object.keys(required), ...previous.keys()])].sort()) {
      const needs = Object.hasOwn(required, slot) ? required[slot]! : [];
      const before = known ? [...previous.get(slot) ?? []].sort() : undefined;
      if (!needs.length && !before?.length) continue;
      const ingredientBases = (pack.contents ?? []).flatMap(content => content.type === 'composition'
        ? content.composition.ingredients.filter(ing => ing.http?.connection === slot).map(ing => ing.http?.base) : []);
      const requirement = pack.connection_requirements?.find(r => r.vendor === slot
        || base(ingredientBases[0]) !== undefined && base(r.api_base) === base(ingredientBases[0]))
        ?? (Object.keys(required).length === 1 ? pack.connection_requirements?.[0] : undefined);
      const apiBase = requirement?.api_base ?? ingredientBases[0] ?? referencedBases.get(slot);
      const current = [...new Set(ownBindings.filter(b => b.slot === slot).map(b => b.connection_name))].sort();
      const candidates = connections.filter(view => view.kind === 'api'
        && (requirement?.per_org ? view.vendor === requirement.vendor : base(apiBase) !== undefined
          ? base(view.base_url) === base(apiBase) : view.name === slot || current.includes(view.name)));
      const projected = candidates.map(view => {
        relevantConnections.add(view);
        const granted = view.granted_scopes; const coverage = scopeCoverage(needs, granted);
        const api = typeof view.base_url === 'string' && base(view.base_url) ? view.base_url : undefined;
        const missing = coverage.known && api ? needs.filter(scope =>
          !UNECHOED_AUTHORIZATION_SCOPES.has(scope) && !oauthScopesCover(api, granted!, [scope])) : coverage.missing;
        return { name: view.name, display_name: view.display_name, authentication: authentication(view),
          coverage: !resolved || !coverage.known || !api ? 'unknown' as const : missing.length ? 'missing' as const : 'covered' as const,
          ...(granted ? { granted_scopes: [...granted] } : {}), missing_scopes: resolved && coverage.known && api ? missing : [] };
      }).sort((a, b) => (a.authentication === 'direct_oauth' ? 0 : a.authentication === 'broker' ? 1 : 2)
        - (b.authentication === 'direct_oauth' ? 0 : b.authentication === 'broker' ? 1 : 2) || a.name.localeCompare(b.name));
      changes.push({ pack_slug: pack.slug, pack_name: pack.name, slot,
        uses_selected_connection: pack.slug === root.slug || origin(root) !== undefined && origin(root) === origin(pack),
        ...(requirement?.vendor ? { vendor: requirement.vendor } : {}), ...(apiBase ? { api_base: apiBase } : {}),
        ...(before ? { previous_scopes: before, added_scopes: needs.filter(s => !before.includes(s)), removed_scopes: before.filter(s => !needs.includes(s)) } : {}),
        required_scopes: needs, current_connections: current, connections: projected });
    }
  }
  // A missing catalog discovered late makes the entire review conservative.
  if (!resolved) for (const change of changes) for (const connection of change.connections) {
    connection.coverage = 'unknown'; connection.missing_scopes = [];
  }
  const fingerprint = hash([touched ?? [root], installedMaterial, changes, resolved,
    [...relevantConnections].sort((a, b) => a.name.localeCompare(b.name))
      .map(view => [view.name, view.updated_at, view.auth_type, view.base_url, view.granted_scopes])]);
  return { fingerprint, resolved, changes };
};

/** One account snapshot anchors both the public review and each pack's write
 *  fence. Earlier dependency writes must not invalidate an untouched parent's
 *  review, so the recheck compares that pack's own original state. */
export const preparePackVendorPermissionReview = async (deps: PackInstallRpcDeps,
  touched: readonly BulkPackManifest[] | null, root: BulkPackManifest) => {
  if (!deps.getVendorPermissionConnections) return undefined;
  const read = async () => {
    try { return { connections: await deps.getVendorPermissionConnections!(), resolved: true }; }
    catch { return { connections: [] as readonly ConnectionView[], resolved: false }; }
  };
  const snapshot = await read();
  const review = reviewFromConnections(deps, touched, root, snapshot.connections, snapshot.resolved);
  const expected = new Map((touched ?? [root]).map(pack => [pack.slug,
    reviewFromConnections(deps, [pack], pack, snapshot.connections, snapshot.resolved).fingerprint]));
  return { review, checkBeforeWrite: async (pack: BulkPackManifest): Promise<boolean> => {
    const latest = await read();
    return expected.get(pack.slug) === reviewFromConnections(deps, [pack], pack, latest.connections, latest.resolved).fingerprint;
  } };
};

export const buildPackVendorPermissionReview = async (deps: PackInstallRpcDeps,
  touched: readonly BulkPackManifest[] | null, root: BulkPackManifest): Promise<PackVendorPermissionReview | undefined> =>
  (await preparePackVendorPermissionReview(deps, touched, root))?.review;
