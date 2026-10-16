import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { D165_CONTRACT_SCHEMA, getSeededConnectionRequirements, type BulkPackManifest, type ConnectionView } from '@recued/contracts';
import { buildPackVendorPermissionReview } from '../pack-vendor-permissions.js';
import { makePackInstallHandlers, handlePacksInstall, installPackBySlug, type PackInstallRpcDeps } from '../pack-install-handler.js';
import { createRecipeStore } from '../recipe-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createManifestRegistry } from '../manifest-loader.js';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); });
const pack = (scopes = ['Mail.Read'], version = 1): BulkPackManifest => ({
  manifest_version: 2, slug: 'mail-permissions', publisher: 'recued-core', name: 'Mail permissions', description: 'Fixture only.',
  version, recipes: [], requires: ['install_bulk_pack'], tags: [], pack_kind: 'app_pack',
  contents: [{ type: 'composition', composition: { schema_version: 1, slug: 'mail-tools', catalog_kind: 'private_byo',
    ingredients: [{ slug: 'mail-tools', kind: 'http', http: { base: 'https://graph.microsoft.com/v1.0', connection: 'graph' } }],
    operations: ['read', 'list'].map(op => ({ op: 'mail.' + op, ingredient: 'mail-tools', risk: 'read', approval: 'never',
      bind: { kind: 'rest', method: 'GET', path_template: '/me/messages' }, required_scopes: scopes })) } }],
});
const connection = (name = 'native', granted_scopes: string[] | undefined = ['Mail.Read']): ConnectionView => ({
  kind: 'api', name, display_name: name, updated_at: 1, base_url: 'https://graph.microsoft.com/v1.0', auth_type: 'oauth2_refresh',
  ...(granted_scopes ? { granted_scopes } : {}),
});
const fixture = () => {
  const db = new Database(':memory:'); const dir = mkdtempSync(join(tmpdir(), 'recued-pack-vendor-permissions-'));
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const contractStore = createContractStore(db); contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  let views: ConnectionView[] = [connection()];
  const deps: PackInstallRpcDeps = { recipeStore: createRecipeStore(dir, db), contractStore, packDir: dir,
    localManifestStore: createLocalManifestStore(db), registry: createManifestRegistry(dir),
    getVendorPermissionConnections: vi.fn(async () => views) };
  const preview = (manifest: BulkPackManifest) => buildPackVendorPermissionReview(deps, [manifest], manifest);
  const install = async (manifest: BulkPackManifest, reviewed = true) => {
    const review = await preview(manifest);
    return handlePacksInstall(deps, { manifest, granted_permissions: ['install_bulk_pack'], chosen_connection: 'native',
      ...(reviewed ? { vendor_permission_consent: { fingerprint: review!.fingerprint, reconnect_later: true } } : {}) });
  };
  return { db, deps, preview, install, views: (next: ConnectionView[]) => { views = next; } };
};
describe('vendor permissions before pack installation and updates', () => {
  it('lists exact new requirements and recorded grant coverage without exposing other fields', async () => {
    const f = fixture(); f.views([{ ...connection(), private_secret: 'never-project' },
      { ...connection('broker', []), auth_type: 'managed_oauth' }, { ...connection('unknown'), auth_type: undefined, granted_scopes: undefined }]);
    const review = (await f.preview(pack(['Mail.Read', 'Mail.Send'])))!;
    expect(review.changes[0]).toMatchObject({ previous_scopes: [], added_scopes: ['Mail.Read', 'Mail.Send'],
      required_scopes: ['Mail.Read', 'Mail.Send'], connections: [
        { name: 'native', coverage: 'missing', missing_scopes: ['Mail.Send'] },
        { name: 'broker', authentication: 'broker', coverage: 'missing' },
        { name: 'unknown', coverage: 'unknown', missing_scopes: [] },
      ] });
    expect(JSON.stringify(review)).not.toContain('never-project');
  });
  it('requires explicit review, while allowing installation before reconnecting', async () => {
    const f = fixture(); const manifest = pack(['Mail.Read', 'Mail.Send']);
    expect(await f.install(manifest, false)).toMatchObject({ result: { ok: false, failure: { code: 'review_stale' } } });
    expect(f.deps.contractStore!.scan('installed_pack', [])).toHaveLength(0);
    expect(await f.install(manifest)).toMatchObject({ result: { ok: true } });
    expect(f.deps.contractStore!.scan('installed_pack', [])).toHaveLength(1);
  });
  it('compares an update with installed catalogs and retains removed vendor consent', async () => {
    const f = fixture(); expect(await f.install(pack(['Mail.Read', 'Mail.Send']))).toMatchObject({ result: { ok: true } });
    f.views([connection('native', ['Mail.Read', 'Mail.Send', 'Calendars.Read'])]);
    const incoming = pack(['Mail.Read', 'Calendars.Read'], 2); const review = (await f.preview(incoming))!;
    expect(review.changes[0]).toMatchObject({ previous_scopes: ['Mail.Read', 'Mail.Send'], added_scopes: ['Calendars.Read'],
      removed_scopes: ['Mail.Send'], current_connections: ['native'] });
    expect(await f.install(incoming)).toMatchObject({ result: { ok: true } });
    expect((await f.deps.getVendorPermissionConnections!())[0]!.granted_scopes).toContain('Mail.Send');
  });
  it('rejects changed manifest, account grants, or revision before installing anything', async () => {
    const f = fixture(); const manifest = pack(); const review = (await f.preview(manifest))!;
    for (const change of ['scopes', 'revision', 'manifest']) {
      f.views([connection()]); const current = change === 'manifest' ? pack(['Mail.Read', 'Mail.Send']) : manifest;
      if (change === 'scopes') f.views([connection('native', ['Mail.Send'])]);
      if (change === 'revision') f.views([{ ...connection(), updated_at: 2 }]);
      expect(await handlePacksInstall(f.deps, { manifest: current, granted_permissions: ['install_bulk_pack'],
        vendor_permission_consent: { fingerprint: review.fingerprint, reconnect_later: true } })).toMatchObject({ result: { ok: false, failure: { code: 'review_stale' } } });
      expect(f.deps.contractStore!.scan('installed_pack', [])).toHaveLength(0);
    }
  });
  it('uses documented scope implications, preserves unknown metadata, and excludes different API services', async () => {
    const f = fixture(); f.views([connection('native', ['https://graph.microsoft.com/Mail.ReadWrite']),
      { ...connection('other-service'), base_url: 'https://graph.microsoft.com/beta' }]);
    const review = (await f.preview(pack(['Mail.Read', 'offline_access'])))!;
    expect(review.changes[0]!.connections).toEqual([expect.objectContaining({ name: 'native', coverage: 'covered', missing_scopes: [] })]);
    f.deps.getVendorPermissionConnections = async () => { throw new Error('fixture locked vault'); };
    expect(await f.preview(pack())).toMatchObject({ resolved: false, changes: [expect.objectContaining({ connections: [] })] });
  });
  it('includes dependency scope changes on the production preview method', async () => {
    const f = fixture(); const parent: BulkPackManifest = { ...pack(), slug: 'parent', contents: [], recipes: [{ slug: 'parent-recipe', version: 1 }],
      dependencies: [{ type: 'pack', slug: 'mail-permissions', min_version: 1 }] };
    f.deps.resolveDependencyManifest = slug => slug === 'mail-permissions' ? pack(['Mail.Read', 'Mail.Send']) : null;
    const handlers = makePackInstallHandlers(f.deps)!;
    const result = await handlers.handlers['packs.install_preview']({ manifest: parent }, undefined as never);
    expect(result.vendor_permissions?.changes).toEqual([expect.objectContaining({ pack_slug: 'mail-permissions', required_scopes: ['Mail.Read', 'Mail.Send'] })]);
  });
  it('reads referenced catalog scopes and refuses to invent a baseline for unavailable installed catalogs', async () => {
    const f = fixture(); await f.install(pack());
    const catalog = f.deps.localManifestStore!.getManifest('mail-tools')!;
    f.deps.getManifest = () => ({ ...catalog, operations: Object.fromEntries(Object.entries(catalog.operations!).map(([id, op]) => [id, { ...op, required_scopes: ['Mail.Read', 'Mail.Send'] }])) });
    f.deps.registry!.register(f.deps.getManifest('mail-tools')!);
    const referenced: BulkPackManifest = { ...pack(), version: 2, contents: [{ type: 'ingredient', slug: 'mail-tools', version: 1 }] };
    expect((await f.preview(referenced))!.changes[0]).toMatchObject({ slot: 'graph', added_scopes: ['Mail.Send'], current_connections: ['native'] });
    f.deps.localManifestStore = undefined;
    expect((await f.preview(pack(['Mail.Read', 'Mail.Send'], 2)))!.changes[0]!.previous_scopes).toBeUndefined();
  });
  it('rechecks after asynchronous shared-account resolution, before any install writes', async () => {
    const f = fixture(); const manifest = pack(); const review = (await f.preview(manifest))!;
    f.deps.sharedSignInConnections = async () => {
      await Promise.resolve(); f.views([{ ...connection(), updated_at: 2, granted_scopes: [] }]);
      return [{ connection_name: 'broker', display_name: 'Broker' }];
    };
    expect(await handlePacksInstall(f.deps, { manifest, chosen_connection: 'native', also_connections: ['broker'],
      granted_permissions: ['install_bulk_pack'], vendor_permission_consent: { fingerprint: review.fingerprint, reconnect_later: true } }))
      .toMatchObject({ result: { ok: false, installed: [], failure: { code: 'review_stale' } } });
    expect(f.deps.contractStore!.scan('installed_pack')).toHaveLength(0);
    expect(f.deps.localManifestStore!.getManifest('mail-tools')).toBeNull();
  });
  it('keeps a review valid when an unrelated API account changes', async () => {
    const f = fixture(); const other = { ...connection('unrelated'), base_url: 'https://api.example.org/v1' };
    f.views([connection(), other]); const manifest = pack(); const review = (await f.preview(manifest))!;
    f.views([connection(), { ...other, updated_at: 2, granted_scopes: [] }]);
    expect((await f.preview(manifest))!.fingerprint).toBe(review.fingerprint);
    expect(await handlePacksInstall(f.deps, { manifest, granted_permissions: ['install_bulk_pack'],
      vendor_permission_consent: { fingerprint: review.fingerprint, reconnect_later: true } })).toMatchObject({ result: { ok: true } });
  });
  it('uses the live referenced catalog and its API surface for a new account review', async () => {
    const f = fixture(); await f.install(pack());
    const catalog = f.deps.localManifestStore!.getManifest('mail-tools')!;
    f.deps.registry!.register({ ...catalog, operations: Object.fromEntries(Object.entries(catalog.operations!).map(([id, op]) =>
      [id, { ...op, required_scopes: ['Mail.Read', 'Mail.Send'] }])) });
    f.deps.getManifest = () => catalog;
    const referenced: BulkPackManifest = { ...pack(), slug: 'new-reference',
      connection_requirements: [...getSeededConnectionRequirements('onedrive')],
      contents: [{ type: 'ingredient', slug: 'mail-tools', version: 1 }] };
    expect((await f.preview(referenced))!.changes[0]).toMatchObject({ slot: 'onedrive', required_scopes: ['Mail.Read', 'Mail.Send'],
      api_base: 'https://graph.microsoft.com/v1.0', connections: [expect.objectContaining({ name: 'native', coverage: 'missing', missing_scopes: ['Mail.Send'] })] });
  });
  it('makes every account unknown if a later referenced catalog cannot resolve its operations', async () => {
    const f = fixture(); await f.install(pack());
    const catalog = f.deps.localManifestStore!.getManifest('mail-tools')!;
    const manifest: BulkPackManifest = { ...pack(), contents: [...pack().contents!,
      { type: 'ingredient', slug: 'unknown-catalog', version: 1 }] };
    f.deps.registry!.register({ ...catalog, slug: 'unknown-catalog', operations: undefined });
    expect(await f.preview(manifest)).toMatchObject({ resolved: false,
      changes: [expect.objectContaining({ connections: [expect.objectContaining({ coverage: 'unknown', missing_scopes: [] })] })] });
  });
  it('reports removed scopes on a prototype-like installed slot without reading inherited properties', async () => {
    const f = fixture(); const prototypeSlot = (scopes: string[], version: number): BulkPackManifest => {
      const manifest = pack(scopes, version);
      return { ...manifest, contents: manifest.contents!.map(content => content.type !== 'composition' ? content : {
        ...content, composition: { ...content.composition, ingredients: content.composition.ingredients.map(ingredient => ({
          ...ingredient, http: { ...ingredient.http!, connection: '__proto__' },
        })) },
      }) };
    };
    expect(await f.install(prototypeSlot(['Mail.Read'], 1))).toMatchObject({ result: { ok: true } });
    const incoming: BulkPackManifest = { ...prototypeSlot([], 2), manifest_version: 1, contents: undefined,
      recipes: [{ slug: 'local-task', version: 1 }] };
    const review = (await f.preview(incoming))!;
    expect(review.changes[0]).toMatchObject({ slot: '__proto__', required_scopes: [], removed_scopes: ['Mail.Read'] });
  });
  it('installs a dependency and its parent from one review without treating its own dependency write as stale', async () => {
    const f = fixture(); const child: BulkPackManifest = { ...pack(), connection_requirements: [...getSeededConnectionRequirements('onedrive')] };
    const parent: BulkPackManifest = { ...pack(), slug: 'parent', connection_requirements: [...getSeededConnectionRequirements('onedrive')],
      dependencies: [{ type: 'pack', slug: child.slug, min_version: 1 }],
      contents: pack().contents!.map(content => content.type === 'composition'
        ? { ...content, composition: { ...content.composition, slug: 'parent-tools' } } : content) };
    f.deps.resolveDependencyManifest = slug => slug === child.slug ? child : null;
    const handlers = makePackInstallHandlers(f.deps)!;
    const preview = await handlers.handlers['packs.install_preview']({ manifest: parent }, undefined as never);
    expect(preview.vendor_permissions!.changes.find(change => change.pack_slug === child.slug)!.uses_selected_connection).toBe(true);
    expect(await handlePacksInstall(f.deps, { manifest: parent, chosen_connection: 'native', granted_permissions: ['install_bulk_pack'],
      vendor_permission_consent: { fingerprint: preview.vendor_permissions!.fingerprint, reconnect_later: true } })).toMatchObject({ result: { ok: true } });
    expect(f.deps.contractStore!.scan('installed_pack')).toHaveLength(2);
  });
  it('rejects malformed consent on both install entry points before fetching or writing', async () => {
    const f = fixture();
    const malformed = { fingerprint: 'a'.repeat(64), reconnect_later: 'true' } as never;
    await expect(handlePacksInstall(f.deps, { manifest: pack(), granted_permissions: [], vendor_permission_consent: malformed }))
      .rejects.toMatchObject({ code: 'bad_request' });
    await expect(installPackBySlug(f.deps, { slug: 'mail-permissions', granted_permissions: [], vendor_permission_consent: malformed }))
      .rejects.toMatchObject({ code: 'bad_request' });
    expect(f.deps.contractStore!.scan('installed_pack')).toHaveLength(0);
  });
});
