/** Current installed requirements drive reminders; an acknowledgement grants nothing. */
import { createHash } from 'node:crypto';
import { scopeCoverage, UNECHOED_AUTHORIZATION_SCOPES, RpcError,
  type PackReconnectGroup, type PackReconnectItem,
  type PackReconnectRequest, type PackReconnectResponse } from '@recued/contracts';
import type { PackInstallRpcDeps } from './pack-install-handler.js';
import { scanInstalledPackRowsBySegment, packIngredientIds } from './pack-inventory.js';
import { createConnectionCatalogBindingStore } from './storage/connection-catalog-binding-store.js';
import { oauthScopesCover } from './managed-oauth-service.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const union = (...lists: readonly (readonly string[])[]): string[] => [...new Set(lists.flat().map(s => s.trim()).filter(Boolean))].sort();
const scope = 'pack_reconnect_review';
const origin = (value: string | undefined): string | undefined => {
  try { return value ? new URL(value).origin : undefined; } catch { return undefined; }
};
type InternalItem = PackReconnectItem & { connection_name?: string; authentication: PackReconnectGroup['authentication'];
  display_name: string; requirement_fingerprint: string; source_id?: string; compatible: boolean };

export const createPackReconnectWorklist = (deps: PackInstallRpcDeps) => {
  const read = async () => {
    if (!deps.contractStore || !deps.localManifestStore || !deps.getVendorPermissionConnections) {
      throw new RpcError('not_configured', 'Reconnect later is unavailable on this server. Update the server and try again.');
    }
    const store = deps.contractStore;
    const installedSnapshot = (): string => hash([
      [...scanInstalledPackRowsBySegment(store)], createConnectionCatalogBindingStore(store).list(),
      [...scanInstalledPackRowsBySegment(store).keys()].map(slug => [slug, packIngredientIds(store, slug).map(id =>
        [id, deps.localManifestStore!.getManifest(id) ?? deps.getManifest?.(id) ?? deps.registry?.get(id)])]),
    ]);
    const installedSignature = installedSnapshot();
    const before = deps.getVendorPermissionSnapshot?.();
    const views = await deps.getVendorPermissionConnections();
    const byName = new Map(views.filter(v => v.kind === 'api').map(v => [v.name, v]));
    const bindings = createConnectionCatalogBindingStore(store).list();
    const items: InternalItem[] = [];
    const unresolved = new Map<string, { slug: string; name: string; message: string }>();
    for (const [packSlug, row] of scanInstalledPackRowsBySegment(store)) {
      const value = row.value;
      if (!record(value) || typeof value.version !== 'string' || !/^[1-9]\d*$/.test(value.version)
        || !Number.isSafeInteger(Number(value.version))) {
        unresolved.set(packSlug, { slug: packSlug, name: packSlug, message: 'The installed Pack version could not be read. Review this Pack.' }); continue;
      }
      if (!Array.isArray(value.ingredient_ids) || !value.ingredient_ids.every(id => typeof id === 'string' && id.trim().length > 0)) {
        unresolved.set(packSlug, { slug: packSlug, name: packSlug,
          message: 'Installed permission requirements could not be read. Refresh or review this Pack.' }); continue;
      }
      const version = Number(value.version);
      const ownBindings = bindings.filter(b => b.installed_pack_id === packSlug);
      const ids = packIngredientIds(store, packSlug);
      const grouped = new Map<string, { slot: string; name?: string; scopes: string[]; bases: string[] }>();
      const uncertain = (): void => { unresolved.set(packSlug, { slug: packSlug, name: packSlug,
        message: 'Installed permission requirements could not be read. Refresh or review this Pack.' }); };
      for (const id of ids) {
        const catalog = deps.localManifestStore.getManifest(id) ?? deps.getManifest?.(id) ?? deps.registry?.get(id);
        if (!catalog) { uncertain(); continue; }
        if (!catalog.operations) {
          if (catalog.surfaces?.api || ['http', 'connection', 'mcp'].includes(catalog.kind)) uncertain();
          continue;
        }
        const needs = union(...Object.values(catalog.operations).map(op => op.required_scopes ?? []));
        if (!needs.length) continue;
        const assigned = ownBindings.filter(b => b.catalog_slug === id);
        const targets = assigned.length ? assigned.map(b => ({ slot: b.slot ?? id, name: b.connection_name })) : [{ slot: id }];
        for (const target of targets) {
          const name = 'name' in target ? target.name : undefined;
          const key = JSON.stringify([target.slot, name]);
          const current = grouped.get(key) ?? { slot: target.slot, ...(name ? { name } : {}), scopes: [], bases: [] };
          current.scopes = union(current.scopes, needs);
          if (catalog.surfaces?.api?.default_base_url) current.bases.push(catalog.surfaces.api.default_base_url);
          grouped.set(key, current);
        }
      }
      for (const current of grouped.values()) {
        const view = current.name ? byName.get(current.name) : undefined;
        const authentication = view?.auth_type === 'oauth2_refresh' ? 'direct_oauth' : view?.auth_type === 'managed_oauth' ? 'broker'
          : view?.auth_type ? 'other' : 'unknown';
        const api = typeof view?.base_url === 'string' ? view.base_url : undefined;
        const apiOrigin = origin(api);
        const compatible = !!apiOrigin && current.bases.every(b => !origin(b) || origin(b) === apiOrigin);
        const evidence = scopeCoverage(current.scopes, view?.granted_scopes);
        const missing = evidence.known && api && compatible ? current.scopes.filter(s =>
          !UNECHOED_AUTHORIZATION_SCOPES.has(s) && !oauthScopesCover(api, view!.granted_scopes!, [s])) : [];
        if (evidence.known && compatible && !missing.length) continue;
        const coverage = evidence.known && compatible ? 'missing' : 'unknown';
        const sourceId = current.name ? deps.getVendorPermissionSourceId?.(current.name) : undefined;
        const requirement = hash([packSlug, version, value.installed_at, current.slot, current.name, current.scopes,
          union(current.bases), api, view?.vendor, authentication]);
        const saved = current.name ? store.get(scope, [packSlug, current.slot, current.name])?.value : undefined;
        const reviewed = coverage === 'unknown' && sourceId !== undefined && record(saved)
          && saved.requirement_fingerprint === requirement && saved.source_id === sourceId;
        items.push({ id: hash([packSlug, current.slot, current.name]), pack_slug: packSlug, pack_name: packSlug, version,
          slot: current.slot, required_scopes: current.scopes, missing_scopes: missing, coverage, reviewed,
          ...(current.name ? { connection_name: current.name } : {}), authentication,
          display_name: view?.display_name ?? current.name ?? 'Connection needed', requirement_fingerprint: requirement,
          ...(sourceId ? { source_id: sourceId } : {}), compatible });
      }
    }
    const assertCurrent = (): void => {
      if (before !== deps.getVendorPermissionSnapshot?.() || installedSignature !== installedSnapshot()) {
        throw new RpcError('conflict', 'Installed permissions or saved accounts changed. Refresh Reconnect later.');
      }
    };
    assertCurrent();
    const byConnection = new Map<string, InternalItem[]>();
    for (const item of items) {
      const key = item.connection_name ? 'account:' + item.connection_name : 'unbound:' + item.id;
      byConnection.set(key, [...byConnection.get(key) ?? [], item]);
    }
    const groups: PackReconnectGroup[] = [...byConnection].map(([key, members]) => {
      const first = members[0]!;
      members.sort((a, b) => a.pack_slug.localeCompare(b.pack_slug) || a.slot.localeCompare(b.slot));
      const available = !!first.connection_name && !!first.source_id && members.every(m => m.compatible && !unresolved.has(m.pack_slug));
      return { id: hash(key), fingerprint: hash(members.map(m => [m.id, m.requirement_fingerprint, m.source_id, m.coverage, m.missing_scopes])),
        ...(first.connection_name ? { name: first.connection_name } : {}), display_name: first.display_name, authentication: first.authentication,
        required_scopes: union(...members.map(m => m.required_scopes)), reviewed: members.every(m => m.reviewed),
        can_reconnect: available && ['direct_oauth', 'broker'].includes(first.authentication),
        can_mark_reviewed: available && first.authentication !== 'unknown' && members.every(m => m.coverage === 'unknown'),
        items: members.map(m => ({ id: m.id, pack_slug: m.pack_slug, pack_name: m.pack_name, version: m.version,
          slot: m.slot, required_scopes: m.required_scopes, missing_scopes: m.missing_scopes, coverage: m.coverage, reviewed: m.reviewed })),
      };
    }).sort((a, b) => a.display_name.localeCompare(b.display_name) || a.id.localeCompare(b.id));
    return { groups, unresolved_packs: [...unresolved.values()], items, assertCurrent, store };
  };
  return async (args: PackReconnectRequest): Promise<PackReconnectResponse> => {
    if (!args || !['list', 'mark_reviewed', 'restore_review'].includes(args.action)) throw new RpcError('bad_request', 'Choose a Reconnect later action.');
    const current = await read();
    if (args.action !== 'list') {
      if (!/^[a-f0-9]{64}$/.test(args.group_id) || !/^[a-f0-9]{64}$/.test(args.fingerprint)) throw new RpcError('bad_request', 'Refresh Reconnect later before reviewing.');
      const group = current.groups.find(g => g.id === args.group_id);
      if (!group || group.fingerprint !== args.fingerprint || !group.name
        || args.action === 'mark_reviewed' && !group.can_mark_reviewed) throw new RpcError('conflict', 'Permissions or accounts changed, or grants are still missing. Refresh and review again.');
      current.store.transaction(() => {
        current.assertCurrent();
        for (const item of current.items.filter(i => i.connection_name === group.name)) {
          const segments = [item.pack_slug, item.slot, group.name!];
          if (args.action === 'restore_review') current.store.delete(scope, segments);
          else current.store.put(scope, segments, { requirement_fingerprint: item.requirement_fingerprint,
            source_id: item.source_id!, reviewed_at: (deps.now ?? Date.now)() });
        }
      });
      const after = await read(); return { action: args.action, groups: after.groups, unresolved_packs: after.unresolved_packs };
    }
    return { action: 'list', groups: current.groups, unresolved_packs: current.unresolved_packs };
  };
};
