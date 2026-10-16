import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { D165_CONTRACT_SCHEMA, type BulkPackManifest, type ConnectionView } from '@recued/contracts';
import { buildPackVendorPermissionReview } from '../pack-vendor-permissions.js';
import { makePackInstallHandlers, handlePacksInstall, type PackInstallRpcDeps } from '../pack-install-handler.js';
import { createRecipeStore } from '../recipe-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); });
const pack = (scopes = ['Mail.Read'], version = 1, slug = 'mail-permissions'): BulkPackManifest => ({
  manifest_version: 2, slug, publisher: 'recued-core', name: slug, description: 'Fixture only.',
  version, recipes: [], requires: ['install_bulk_pack'], tags: [], pack_kind: 'app_pack',
  contents: [{ type: 'composition', composition: { schema_version: 1, slug: slug + '-tools', catalog_kind: 'private_byo',
    ingredients: [{ slug: slug + '-tools', kind: 'http', http: { base: 'https://graph.microsoft.com/v1.0', connection: 'graph' } }],
    operations: ['read', 'list'].map(op => ({ op: 'mail.' + op, ingredient: slug + '-tools', risk: 'read', approval: 'never',
      bind: { kind: 'rest', method: 'GET', path_template: '/me/messages' }, required_scopes: scopes })) } }],
});
const fixture = (granted?: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-reconnect-worklist-')); let db = new Database(join(dir, 'test.sqlite'));
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const contractStore = createContractStore(db); contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  let connections = createConnectionStore(db);
  connections.upsert({ kind: 'api', name: 'native', display_name: 'Saved mail', enrolled_at: 1, updated_at: 2,
    config_json: '{"base_url":"https://graph.microsoft.com/v1.0"}', auth_ciphertext: 'fixture-opaque-cipher',
    ...(granted ? { granted_scopes_json: JSON.stringify(granted) } : {}) });
  let auth: 'oauth2_refresh' | 'managed_oauth' = 'oauth2_refresh';
  const deps: PackInstallRpcDeps = { recipeStore: createRecipeStore(dir, db), contractStore, packDir: dir,
    localManifestStore: createLocalManifestStore(db), registry: createManifestRegistry(dir),
    getVendorPermissionSourceId: name => connections.getAuthSourceId!('api', name),
    getVendorPermissionSnapshot: () => JSON.stringify(connections.list()),
    getVendorPermissionConnections: async () => connections.list().map(row => ({
      kind: 'api', name: row.name, display_name: row.display_name, updated_at: row.updated_at,
      base_url: 'https://graph.microsoft.com/v1.0', auth_type: auth,
      ...(row.granted_scopes_json ? { granted_scopes: JSON.parse(row.granted_scopes_json) } : {}),
    } satisfies ConnectionView)) };
  let rpc = makePackInstallHandlers(deps)!.handlers['packs.reconnect_later'];
  const call = (args: Parameters<typeof rpc>[0]) => rpc(args, undefined as never);
  const install = async (manifest: BulkPackManifest) => {
    const review = await buildPackVendorPermissionReview(deps, [manifest], manifest);
    const result = await handlePacksInstall(deps, { manifest, granted_permissions: ['install_bulk_pack'], chosen_connection: 'native',
      vendor_permission_consent: { fingerprint: review!.fingerprint, reconnect_later: true } });
    expect(result).toMatchObject({ result: { ok: true } });
  };
  return { dir, get db() { return db; }, deps, get connections() { return connections; }, call, install,
    restart: () => {
      db.close(); db = new Database(join(dir, 'test.sqlite')); connections = createConnectionStore(db);
      deps.contractStore = createContractStore(db); deps.localManifestStore = createLocalManifestStore(db);
      deps.recipeStore = createRecipeStore(dir, db); rpc = makePackInstallHandlers(deps)!.handlers['packs.reconnect_later'];
    }, broker: () => { auth = 'managed_oauth'; } };
};

describe('durable reconnect-later worklist', () => {
  it.each([undefined, 'unreadable', ['mail-permissions-tools', 12]])('keeps unreadable ingredient inventory visible: %j', async ingredientIds => {
    const f = fixture(); await f.install(pack());
    const value = f.deps.contractStore!.get('installed_pack', ['mail-permissions'])!.value as Record<string, unknown>;
    f.db.prepare('UPDATE contract_store SET value_inline = ? WHERE scope = ? AND seg_key = ?')
      .run(JSON.stringify({ ...value, ingredient_ids: ingredientIds }), 'installed_pack', 'mail-permissions');
    const list = await f.call({ action: 'list' });
    expect(list.unresolved_packs).toEqual([expect.objectContaining({ slug: 'mail-permissions' })]);
    expect(list.groups.every(group => !group.can_reconnect && !group.can_mark_reviewed)).toBe(true);
  });
  it('derives a deferred reminder from a real install, groups all pack needs on the account, and never grants permissions', async () => {
    const f = fixture(); await f.install(pack()); await f.install(pack(['Mail.Send'], 1, 'send-permissions'));
    const before = f.connections.list(); const list = await f.call({ action: 'list' });
    expect(list.groups).toHaveLength(1); expect(list.groups[0]).toMatchObject({ name: 'native', authentication: 'direct_oauth',
      required_scopes: ['Mail.Read', 'Mail.Send'], can_reconnect: true, can_mark_reviewed: true, reviewed: false });
    expect(list.groups[0]!.items).toHaveLength(2); expect(f.connections.list()).toEqual(before);
    expect(JSON.stringify(list)).not.toContain('fixture-opaque-cipher');
    const group = list.groups[0]!; const reviewed = await f.call({ action: 'mark_reviewed', group_id: group.id, fingerprint: group.fingerprint });
    expect(reviewed.groups[0]!.reviewed).toBe(true); expect(f.connections.list()).toEqual(before);
    f.restart(); expect((await f.call({ action: 'list' })).groups[0]!.reviewed).toBe(true);
    expect((await f.call({ action: 'restore_review', group_id: group.id, fingerprint: group.fingerprint })).groups[0]!.reviewed).toBe(false);
  });
  it('keeps missing grant evidence pending and removes requirements once actual grants cover them', async () => {
    const f = fixture(['Mail.Read']); await f.install(pack(['Mail.Read', 'Mail.Send']));
    const group = (await f.call({ action: 'list' })).groups[0]!;
    expect(group).toMatchObject({ can_mark_reviewed: false, items: [{ coverage: 'missing', missing_scopes: ['Mail.Send'] }] });
    await expect(f.call({ action: 'mark_reviewed', group_id: group.id, fingerprint: group.fingerprint })).rejects.toMatchObject({ code: 'conflict' });
    const row = f.connections.get('api', 'native')!;
    f.connections.upsert({ ...row, granted_scopes_json: '["Mail.Read","Mail.Send"]' });
    expect((await f.call({ action: 'list' })).groups).toEqual([]);
  });
  it('preserves review through trusted token renewal and restart, but reopens it after replacing credentials', async () => {
    const f = fixture(); await f.install(pack());
    const group = (await f.call({ action: 'list' })).groups[0]!;
    await f.call({ action: 'mark_reviewed', group_id: group.id, fingerprint: group.fingerprint });
    const row = f.connections.get('api', 'native')!;
    expect(f.connections.persistRefreshedAuth!(row, 'fixture-renewed-cipher', 3)).toBe(true);
    expect((await f.call({ action: 'list' })).groups[0]!.reviewed).toBe(true);
    const source = f.connections.getAuthSourceId!('api', 'native'); f.restart();
    expect(f.connections.getAuthSourceId!('api', 'native')).toBe(source);
    f.connections.upsert({ ...f.connections.get('api', 'native')!, auth_ciphertext: 'fixture-other-account', updated_at: 4 });
    expect((await f.call({ action: 'list' })).groups[0]!.reviewed).toBe(false);
  });
  it('rejects a stale scope review, reopens after an update, and stops listing an uninstalled pack', async () => {
    const f = fixture(); await f.install(pack()); const group = (await f.call({ action: 'list' })).groups[0]!;
    await f.call({ action: 'mark_reviewed', group_id: group.id, fingerprint: group.fingerprint });
    await f.install(pack(['Mail.Read', 'Mail.Send'], 2));
    await expect(f.call({ action: 'mark_reviewed', group_id: group.id, fingerprint: group.fingerprint })).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.call({ action: 'list' })).groups[0]).toMatchObject({ reviewed: false, required_scopes: ['Mail.Read', 'Mail.Send'] });
    f.deps.contractStore!.delete('installed_pack', ['mail-permissions']);
    expect((await f.call({ action: 'list' })).groups).toEqual([]);
  });
  it('does not substitute a different compatible account when the installed binding disappears', async () => {
    const f = fixture(); await f.install(pack());
    f.connections.upsert({ ...f.connections.get('api', 'native')!, name: 'different', auth_ciphertext: 'different-cipher' });
    const bindings = createConnectionCatalogBindingStore(f.deps.contractStore!);
    for (const b of bindings.list()) f.deps.contractStore!.delete('connection_catalog_binding', [b.connection_name, b.catalog_slug]);
    const list = await f.call({ action: 'list' });
    expect(list.groups[0]).toMatchObject({ can_reconnect: false, can_mark_reviewed: false }); expect(list.groups[0]!.name).toBeUndefined();
  });
  it('keeps broker grant coverage unknown after manual review and rejects a stale credential source', async () => {
    const f = fixture(); f.broker(); await f.install(pack()); const group = (await f.call({ action: 'list' })).groups[0]!;
    expect(group.authentication).toBe('broker');
    const reviewed = await f.call({ action: 'mark_reviewed', group_id: group.id, fingerprint: group.fingerprint });
    expect(reviewed.groups[0]!.items[0]).toMatchObject({ coverage: 'unknown', reviewed: true });
    const row = f.connections.get('api', 'native')!; f.connections.upsert({ ...row, auth_ciphertext: 'different-broker-account', updated_at: 3 });
    await expect(f.call({ action: 'mark_reviewed', group_id: group.id, fingerprint: group.fingerprint })).rejects.toMatchObject({ code: 'conflict' });
  });
});
