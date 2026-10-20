import { expect, it, vi } from 'vitest';
import { packRemovalFixture, installRemovalRecords } from './pack-removal-fixture.js';
import { createPackRepairStore } from '../storage/pack-repair-store.js';
import { createMcpBodyVisibilityStore } from '../storage/mcp-body-visibility-store.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import type { PackRepairApply } from '@recued/contracts';
import { recordsCatalogSlug } from '@recued/ingredient-authoring';
import { createScheduleStore } from '../schedule-store.js';
const orphan = (f: Awaited<ReturnType<typeof packRemovalFixture>>, key = 'orphan-pack') => {
  f.contracts.put('grant', [key, 'fixture-catalog', 'fixture-connection', 'read'], { allowed: true });
  f.contracts.put('connection_catalog_binding', ['fixture-connection', key + '-catalog'], { catalog_slug: key + '-catalog', installed_pack_id: key });
  f.contracts.put('pack_connection_default', [key, 'account'], { connection_name: 'fixture-connection' });
  f.contracts.put('pack_connection_holder', [key], { holder_pack_id: 'provider-pack' });
};
const fixture = async () => {
  const f = await packRemovalFixture(), repairs = createPackRepairStore(f.db, f.codec, f.deps, f.deps.now);
  f.deps.reconcileConnectionProfile = vi.fn();
  const review = (key = 'orphan-pack') => repairs.review({ inventory_key: key, request_id: crypto.randomUUID() }, f.actor, f.check);
  const applyRequest = (review_id: string): PackRepairApply => ({ review_id, request_id: crypto.randomUUID(), acknowledge_local_cleanup: true, acknowledge_unknown_dependencies: true });
  return { ...f, repairs, reviewRepair: review, applyRequest, applyRepair: (request: PackRepairApply) => repairs.apply(request, f.actor, f.check) };
};

it('inspects installed and orphan identities without changing local evidence or reading newer catalog dependencies', async () => {
  const f = await fixture();try {
    orphan(f);const local = createLocalManifestStore(f.db);
    f.db.prepare('INSERT INTO local_manifest VALUES(?,1,?,?)').run('unattributed-body', '{}', '[]');
    const before = f.db.serialize();
    const result = await f.repairs.inspect(f.actor, f.check);
    expect(result.entries.find(entry => entry.pack.inventory_key === 'orphan-pack')).toMatchObject({ inventory: false, next_step: 'review_cleanup', metadata: { grants: 1, bindings: 1 } });
    expect(result.entries.find(entry => entry.pack.inventory_key === f.manifest.slug)).toMatchObject({ inventory: true, recipes: ['update-first', 'update-second'] });
    expect(result.unattributed_manifests).toEqual(['unattributed-body']);expect(f.db.serialize()).toEqual(before);expect(local.slugs()).toEqual(['unattributed-body']);
  } finally { f.close(); }
});

it('atomically retires exact orphan metadata and preserves peer packs, user grants, local bodies and credentials', async () => {
  const f = await fixture();try {
    orphan(f);orphan(f, 'peer-pack');f.contracts.put('grant', ['__user__', 'fixture-catalog', 'fixture-connection', 'read'], { allowed: true });
    const bodies = createMcpBodyVisibilityStore(f.db);for (const pack_slug of ['orphan-pack', 'peer-pack']) bodies.grant({ pack_slug, publisher: 'publisher', grants: ['data.contact.engagements.body_content'], granted_at: 1 });
    for (const key of ['orphan-pack', 'peer-pack']) {
      f.db.prepare('INSERT INTO pack_update_tracks VALUES(?,1,0,?,?)').run(key, 'sealed fixture', '');
      f.db.prepare('INSERT INTO pack_release_history VALUES(?,1,?)').run(key, 'sealed history');
    }
    const plan = await f.reviewRepair();expect(plan.blockers).toEqual([]);expect(plan.action).toBe('retire_orphaned_metadata');
    const request = f.applyRequest(plan.review_id), result = await f.applyRepair(request);
    expect(result.current?.metadata).toEqual({ grants: 0, body_grants: 0, bindings: 0, defaults: 0, holders: 0, templates: 0, protection: false, history: false });
    expect(f.contracts.scan('grant').map(row => row.segments[0])).toEqual(['__user__', 'peer-pack']);
    expect(bodies.listGrantsForPack({ pack_slug: 'peer-pack', publisher: 'publisher' })).toHaveLength(1);
    expect(f.db.prepare('SELECT deleted FROM pack_update_tracks WHERE pack_slug=?').pluck().get('peer-pack')).toBe(0);
    expect(f.db.prepare('SELECT 1 FROM pack_release_history WHERE pack_slug=?').get('peer-pack')).toBeDefined();
    expect(f.deps.reconcileConnectionProfile).toHaveBeenCalledWith('fixture-connection');
    f.install('orphan-pack', []);const replay = await f.applyRepair(request);
    expect(replay.receipt).toEqual(result.receipt);expect(replay.current?.inventory).toBe(true);
    expect(f.contracts.get('installed_pack', ['orphan-pack'])).not.toBeNull();
    await expect(f.applyRepair({ ...request, request_id: 'different' })).rejects.toMatchObject({ code: 'pack_repair_conflict' });
  } finally { f.close(); }
});

it('keeps stable review IDs private to their originating paired owner', async () => {
  const f = await fixture();try {
    orphan(f);const request = { inventory_key: 'orphan-pack', request_id: 'stable-read' };
    const plan = await f.repairs.review(request, f.actor, f.check);
    expect(await f.repairs.review(request, f.actor, f.check)).toEqual(plan);
    await expect(f.repairs.review({ ...request, inventory_key: 'peer-pack' }, f.actor, f.check)).rejects.toMatchObject({ code: 'pack_repair_conflict' });
    await expect(f.repairs.apply(f.applyRequest(plan.review_id), 'another-owner', f.check)).rejects.toMatchObject({ code: 'not_found' });
    const encrypted = f.db.prepare('SELECT encrypted FROM pack_repair_reviews').pluck().get() as string;expect(encrypted).not.toContain('orphan-pack');
  } finally { f.close(); }
});

it.each(['inventory', 'recipe', 'grant', 'binding', 'default', 'body', 'manifest', 'dependency', 'history'])('holds cleanup when %s evidence changes after review', async kind => {
  const f = await fixture();try {
    orphan(f);const plan = await f.reviewRepair();
    if (kind === 'inventory') f.install('orphan-pack', []);
    if (kind === 'recipe') f.recipes.save({ ...f.active[0]!, recipe_id: 'new-owned' }, 'publisher', 'pair-sync', 2, 'orphan-pack');
    if (kind === 'grant') f.contracts.put('grant', ['orphan-pack', 'fixture-catalog', 'fixture-connection', 'write'], { allowed: true });
    if (kind === 'binding') f.contracts.put('connection_catalog_binding', ['another-connection', 'catalog'], { catalog_slug: 'catalog', installed_pack_id: 'orphan-pack' });
    if (kind === 'default') f.contracts.put('pack_connection_default', ['orphan-pack', 'account'], { connection_name: 'another-connection' });
    if (kind === 'body') createMcpBodyVisibilityStore(f.db).grant({ pack_slug: 'orphan-pack', publisher: 'publisher', grants: ['key'], granted_at: 1 });
    if (kind === 'manifest') { createLocalManifestStore(f.db);f.db.prepare('INSERT INTO local_manifest VALUES(?,1,?,?)').run('local', '{}', '[]'); }
    if (kind === 'dependency') f.install('dependent', [{ type: 'pack', slug: 'orphan-pack' }]);
    if (kind === 'history') f.db.prepare('INSERT INTO pack_release_history VALUES(?,1,?)').run('orphan-pack', 'new history');
    await expect(f.applyRepair(f.applyRequest(plan.review_id))).rejects.toMatchObject({ code: 'pack_repair_conflict' });
    expect(f.contracts.scan('grant', ['orphan-pack'])).not.toHaveLength(0);
  } finally { f.close(); }
});

it('rechecks state and owner authority after sealing the completion receipt', async () => {
  const f = await fixture();try {
    orphan(f);const plan = await f.reviewRepair(), seal = f.codec.seal.bind(f.codec);
    const spy = vi.spyOn(f.codec, 'seal').mockImplementation(async value => { const result = await seal(value);f.install('new-peer', []);return result; });
    await expect(f.applyRepair(f.applyRequest(plan.review_id))).rejects.toMatchObject({ code: 'pack_repair_conflict' });spy.mockRestore();
    const next = await f.reviewRepair();vi.spyOn(f.codec, 'seal').mockImplementation(async value => { const result = await seal(value);f.state.locked = true;return result; });
    await expect(f.applyRepair(f.applyRequest(next.review_id))).rejects.toThrow();f.state.locked = false;
    expect(f.contracts.scan('grant', ['orphan-pack'])).toHaveLength(1);
  } finally { f.close(); }
});

it('rolls every local effect back if storing the atomic receipt fails, then safely retries', async () => {
  const f = await fixture();try {
    orphan(f);const plan = await f.reviewRepair(), request = f.applyRequest(plan.review_id);
    f.db.exec("CREATE TRIGGER fail_repair BEFORE UPDATE ON pack_repair_reviews BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END");
    await expect(f.applyRepair(request)).rejects.toThrow('receipt unavailable');
    expect(f.contracts.scan('grant', ['orphan-pack'])).toHaveLength(1);expect(f.contracts.scan('connection_catalog_binding')).toHaveLength(1);
    f.db.exec('DROP TRIGGER fail_repair');expect((await f.applyRepair(request)).receipt.request_id).toBe(request.request_id);
  } finally { f.close(); }
});

it('finishes an authenticated interrupted local removal and keeps shared ingredient ownership', async () => {
  const f = await fixture();try {
    f.install(f.manifest.slug, [], ['private-catalog', 'shared-catalog']);f.install('peer-pack', [], ['shared-catalog']);
    f.contracts.put('installed_ingredient', ['private-catalog'], { ingredient_id: 'private-catalog', version: '1', installed_at: 1, catalog_kind: 'private_byo', source_pack_slug: f.manifest.slug });
    const local = createLocalManifestStore(f.db);f.db.prepare('INSERT INTO local_manifest VALUES(?,1,?,?)').run('private-catalog', '{"slug":"private-catalog","version":1}', '[]');
    f.deps.registry = { unregister: vi.fn() };
    orphan(f, f.manifest.slug);const removal = await f.review();
    await expect(f.removals.apply({ review_id: removal.review_id, request_id: 'interrupted' }, f.actor, f.check, async () => {
      for (const id of f.recipes.listForPack(f.manifest.slug)) f.recipes.delete(id);throw new Error('crashed before inventory cleanup');
    })).rejects.toThrow('crashed');
    const plan = await f.reviewRepair(f.manifest.slug);expect(plan.action).toBe('finish_local_cleanup');expect(plan.blockers).toEqual([]);
    expect(plan.manifests_removed).toEqual(['private-catalog']);expect(plan.ingredients_kept).toEqual(['shared-catalog']);
    const result = await f.applyRepair(f.applyRequest(plan.review_id));expect(result.current?.inventory).toBe(false);
    expect(f.contracts.get('installed_ingredient', ['shared-catalog'])).not.toBeNull();expect(local.slugs()).toEqual([]);
    expect(f.deps.registry.unregister).toHaveBeenCalledWith('private-catalog');
  } finally { f.close(); }
});

it('holds a newer reinstallation and supports only exact historical inventory evidence', async () => {
  const f = await fixture();try {
    const removal = await f.review();await expect(f.removals.apply({ review_id: removal.review_id, request_id: 'interrupted' }, f.actor, f.check, async () => {
      for (const id of f.recipes.listForPack(f.manifest.slug)) f.recipes.delete(id);throw new Error('interrupted');
    })).rejects.toThrow();
    const installed = f.contracts.get('installed_pack', [f.manifest.slug])!.value;
    if (!installed || typeof installed !== 'object' || Array.isArray(installed)) throw new Error('Missing installed fixture');
    f.contracts.put('installed_pack', [f.manifest.slug], { ...installed, installed_at: 2000 });
    const plan = await f.reviewRepair(f.manifest.slug);expect(plan.action).toBe('none');expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'no_supported_repair' }));
  } finally { f.close(); }
});

it('holds active removals, saved update groups and known dependants', async () => {
  const f = await fixture();try {
    orphan(f);f.db.prepare('INSERT INTO pack_update_tracks VALUES(?,1,0,?,?)').run('root-pack', 'protected', '');
    f.db.prepare('INSERT INTO pack_update_plan_packs VALUES(?,?)').run('orphan-pack', 'root-pack');
    expect((await f.reviewRepair()).blockers).toContainEqual(expect.objectContaining({ code: 'shared_update_plan' }));
    f.db.prepare('DELETE FROM pack_update_plan_packs').run();f.install('dependent', [{ type: 'pack', slug: 'orphan-pack' }]);
    expect((await f.reviewRepair()).blockers).toContainEqual(expect.objectContaining({ code: 'dependants' }));
    const removal = await f.review();let finish!: () => void;
    const running = f.removals.apply({ review_id: removal.review_id, request_id: 'running' }, f.actor, f.check, async () => {
      await new Promise<void>(resolve => { finish = resolve; });return { ok: false, removed: { recipes: [], body_grants: [] } };
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect((await f.reviewRepair(f.manifest.slug)).blockers).toContainEqual(expect.objectContaining({ code: 'removal_active' }));finish();await running;
  } finally { f.close(); }
});

it('keeps Records data and other publishers intact and blocks active namespaces', async () => {
  const f = await fixture();try {
    const first = await installRemovalRecords(f, 'first'), second = await installRemovalRecords(f, 'second');
    orphan(f, first.catalog);for (const id of f.recipes.listForPack(first.catalog)) f.recipes.delete(id);
    f.contracts.delete('installed_pack', [first.catalog]);
    expect((await f.reviewRepair(first.catalog)).blockers).toContainEqual(expect.objectContaining({ code: 'records_active' }));
    // Only the existing Records lifecycle can orphan the namespace.
    first.records.orphanNamespace(first.owner);
    const plan = await f.reviewRepair(first.catalog);expect(plan.blockers).toEqual([]);
    await f.applyRepair(f.applyRequest(plan.review_id));
    expect(first.records.getNamespace(first.owner)?.state.state).toBe('orphaned');expect(second.records.getNamespace(second.owner)?.state.state).toBe('ready');
    expect(f.contracts.get('installed_pack', [second.catalog])).not.toBeNull();
    expect(f.db.prepare('SELECT count(*) FROM core_records').pluck().get()).toBe(2);
  } finally { f.close(); }
});

it('requires fresh approval and preserves the exact request for local reconciliation retries', async () => {
  const f = await fixture();try {
    orphan(f);const plan = await f.reviewRepair(), request = f.applyRequest(plan.review_id);
    await expect(f.applyRepair({ ...request, acknowledge_local_cleanup: false })).rejects.toMatchObject({ code: 'pack_repair_conflict' });
    f.deps.reconcileConnectionProfile = vi.fn(() => { throw new Error('cache unavailable'); });
    const result = await f.applyRepair(request);expect(result.reconciliation_pending).toBe(true);
    f.deps.reconcileConnectionProfile = vi.fn();expect((await f.applyRepair(request)).reconciliation_pending).toBe(false);
    orphan(f, 'expired');const expired = await f.reviewRepair('expired');f.advance(300001);
    await expect(f.applyRepair(f.applyRequest(expired.review_id))).rejects.toMatchObject({ code: 'pack_repair_conflict' });
  } finally { f.close(); }
});

it('holds conflicting publishers and refuses to infer local body ownership from stale provenance', async () => {
  const f = await fixture();try {
    orphan(f);const body = createMcpBodyVisibilityStore(f.db);
    for (const publisher of ['first', 'second']) body.grant({ pack_slug: 'orphan-pack', publisher, grants: ['key'], granted_at: 1 });
    expect((await f.reviewRepair()).blockers).toContainEqual(expect.objectContaining({ code: 'ambiguous_publisher' }));
    createLocalManifestStore(f.db);f.db.prepare('INSERT INTO local_manifest VALUES(?,1,?,?)').run('kept-body', '{}', '[]');
    f.contracts.put('installed_ingredient', ['kept-body'], { ingredient_id: 'kept-body', version: '1', installed_at: 1, source_pack_slug: 'orphan-pack', catalog_kind: 'private_byo' });
    body.revokeForPack({ pack_slug: 'orphan-pack', publisher: 'second' });const plan = await f.reviewRepair();expect(plan.manifests_removed).toEqual([]);
    await f.applyRepair(f.applyRequest(plan.review_id));expect(f.db.prepare('SELECT 1 FROM local_manifest WHERE slug=?').get('kept-body')).toBeDefined();
  } finally { f.close(); }
});

it('discovers retained completions after reopen and isolates an unreadable receipt from inspection', async () => {
  const f = await fixture();try {
    orphan(f);const plan = await f.reviewRepair(), request = f.applyRequest(plan.review_id);await f.applyRepair(request);
    const reopened = createPackRepairStore(f.db, f.codec, f.deps, f.deps.now);
    expect((await reopened.inspect(f.actor, f.check)).recent_repairs[0]?.request).toEqual(request);
    expect((await reopened.inspect('other-owner', f.check)).recent_repairs).toEqual([]);
    f.db.prepare("UPDATE pack_repair_reviews SET encrypted='unreadable' WHERE review_id=?").run(plan.review_id);
    const inspection = await reopened.inspect(f.actor, f.check);expect(inspection.unavailable_receipts).toBe(1);expect(inspection.entries.length).toBeGreaterThan(0);
    await expect(f.applyRepair(request)).rejects.toThrow();expect(f.contracts.scan('grant', ['orphan-pack'])).toHaveLength(0);
  } finally { f.close(); }
});

it('never unregisters a newly installed local body during recovery of an older cleanup receipt', async () => {
  const f = await fixture();try {
    f.install(f.manifest.slug, [], ['local-catalog']);
    f.contracts.put('installed_ingredient', ['local-catalog'], { ingredient_id: 'local-catalog', version: '1', installed_at: 1, catalog_kind: 'private_byo' });
    createLocalManifestStore(f.db);f.db.prepare('INSERT INTO local_manifest VALUES(?,1,?,?)').run('local-catalog', '{"slug":"local-catalog","version":1}', '[]');
    f.deps.registry = { unregister: vi.fn() };
    const removal = await f.review();await expect(f.removals.apply({ review_id: removal.review_id, request_id: 'interrupted' }, f.actor, f.check, async () => {
      for (const id of f.recipes.listForPack(f.manifest.slug)) f.recipes.delete(id);throw new Error('interrupted');
    })).rejects.toThrow();
    const plan = await f.reviewRepair(f.manifest.slug), request = f.applyRequest(plan.review_id);await f.applyRepair(request);
    expect(f.deps.registry.unregister).toHaveBeenCalledTimes(1);
    f.db.prepare('INSERT INTO local_manifest VALUES(?,2,?,?)').run('local-catalog', '{"slug":"local-catalog","version":2}', '[]');
    f.install(f.manifest.slug, [], ['local-catalog']);await f.applyRepair(request);expect(f.deps.registry.unregister).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

it('holds update membership that still protects another pack recipe and requires unknown-dependency acknowledgement', async () => {
  const f = await fixture();try {
    orphan(f);f.db.prepare('INSERT INTO pack_update_members VALUES(?,?)').run(f.active[0]!.recipe_id, 'orphan-pack');
    expect((await f.reviewRepair()).blockers).toContainEqual(expect.objectContaining({ code: 'shared_update_members' }));
    f.db.prepare('DELETE FROM pack_update_members').run();f.install('older-pack');
    const plan = await f.reviewRepair();expect(plan.unknown_dependencies.map(pack => pack.inventory_key)).toContain('older-pack');
    const request = f.applyRequest(plan.review_id);await expect(f.applyRepair({ ...request, acknowledge_unknown_dependencies: false })).rejects.toMatchObject({ code: 'pack_repair_conflict' });
    expect((await f.applyRepair(request)).receipt.request_id).toBe(request.request_id);
  } finally { f.close(); }
});

it('does not treat unreadable removal evidence as proof of an interrupted installation', async () => {
  const f = await fixture();try {
    const removal = await f.review();await expect(f.removals.apply({ review_id: removal.review_id, request_id: 'interrupted' }, f.actor, f.check, async () => {
      for (const id of f.recipes.listForPack(f.manifest.slug)) f.recipes.delete(id);throw new Error('interrupted');
    })).rejects.toThrow();
    f.db.prepare("UPDATE pack_removal_reviews SET encrypted='unreadable' WHERE review_id=?").run(removal.review_id);
    const plan = await f.reviewRepair(f.manifest.slug);expect(plan.action).toBe('none');expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'unreadable_removal' }));
  } finally { f.close(); }
});

it('holds provider and specialized cleanup instead of bypassing their lifecycle hooks', async () => {
  const f = await fixture();try {
    orphan(f);f.db.exec('CREATE TABLE webhook_consumer_bindings (consumer_kind TEXT,consumer_id TEXT)');
    f.db.prepare('INSERT INTO webhook_consumer_bindings VALUES(?,?)').run('pack_install', 'orphan-pack');
    expect((await f.reviewRepair()).blockers).toContainEqual(expect.objectContaining({ code: 'webhook_cleanup' }));
    f.db.exec('DROP TABLE webhook_consumer_bindings');f.db.exec('CREATE TABLE saved_data_views (id TEXT PRIMARY KEY,data TEXT)');
    f.db.prepare('INSERT INTO saved_data_views VALUES(?,?)').run('view', JSON.stringify({ pack: { slug: 'orphan-pack', publisher: 'publisher' } }));
    expect((await f.reviewRepair()).blockers).toContainEqual(expect.objectContaining({ code: 'specialized_cleanup' }));
  } finally { f.close(); }
});

it('bounds retained encrypted repair reviews without changing local metadata', async () => {
  const f = await fixture();try {
    orphan(f);for (let index = 0; index < 202; index++) await f.repairs.review({ inventory_key: 'orphan-pack', request_id: 'bounded-' + index }, f.actor, f.check);
    expect(f.db.prepare('SELECT count(*) FROM pack_repair_reviews').pluck().get()).toBe(200);
    expect(f.contracts.scan('grant', ['orphan-pack'])).toHaveLength(1);
    expect(f.db.prepare('SELECT sum(length(CAST(encrypted AS BLOB))) FROM pack_repair_reviews').pluck().get()).toBeLessThan(8_000_000);
  } finally { f.close(); }
});

it('diagnoses missing and stale local catalog evidence without authorizing reinstall or guessing newer declarations', async () => {
  const f = await fixture();try {
    f.install('drifted-install', [], ['missing-ingredient', 'missing-body', 'stale-body']);
    for (const id of ['missing-body', 'stale-body']) f.contracts.put('installed_ingredient', [id], { ingredient_id: id, version: '1', installed_at: 1, catalog_kind: 'private_byo' });
    f.contracts.delete('installed_ingredient', ['missing-ingredient']);createLocalManifestStore(f.db);
    f.db.prepare('INSERT INTO local_manifest VALUES(?,2,?,?)').run('stale-body', '{"slug":"stale-body","version":2}', '[]');
    f.contracts.put('connection_catalog_binding', ['account', 'absent-catalog'], { catalog_slug: 'absent-catalog', installed_pack_id: 'drifted-install' });
    f.contracts.put('pack_connection_default', ['drifted-install', 'slot'], { connection_name: 'unbound-account' });
    const entry = (await f.repairs.inspect(f.actor, f.check)).entries.find(item => item.pack.inventory_key === 'drifted-install')!;
    expect(entry.next_step).toBe('install');expect(entry.findings.map(item => item.code)).toEqual(expect.arrayContaining(['missing_ingredient', 'missing_manifest', 'stale_manifest', 'stale_binding', 'stale_default']));
    expect((await f.reviewRepair('drifted-install')).action).toBe('none');
  } finally { f.close(); }
});

it('holds update protection for manually saved recipes outside the selected pack ownership', async () => {
  const f = await fixture();try {
    orphan(f);f.recipes.save({ ...f.active[0]!, recipe_id: 'protected-manual' }, 'owner', 'pair-sync', 1);
    f.db.prepare('INSERT INTO pack_update_members VALUES(?,?)').run('protected-manual', 'orphan-pack');
    const plan = await f.reviewRepair();expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'shared_update_members' }));
    await expect(f.applyRepair(f.applyRequest(plan.review_id))).rejects.toMatchObject({ code: 'pack_repair_conflict' });
    expect(f.db.prepare('SELECT pack_slug FROM pack_update_members WHERE recipe_id=?').pluck().get('protected-manual')).toBe('orphan-pack');
    expect(f.contracts.scan('grant', ['orphan-pack'])).toHaveLength(1);
  } finally { f.close(); }
});

it('reports an active Records namespace without inventory on an older receipt without mutating it', async () => {
  const f = await fixture();try {
    const catalog = await recordsCatalogSlug({ publisher: 'first', pack_slug: 'same-records' });orphan(f, catalog);
    const plan = await f.reviewRepair(catalog), request = f.applyRequest(plan.review_id);await f.applyRepair(request);
    const installed = await installRemovalRecords(f, 'first');f.contracts.delete('installed_pack', [catalog]);
    for (const id of f.recipes.listForPack(catalog)) f.recipes.delete(id);
    const before = f.db.serialize(), inspection = await f.repairs.inspect(f.actor, f.check);
    const current = inspection.entries.find(entry => entry.pack.inventory_key === catalog)!;
    expect(current).toMatchObject({ inventory: false, recipes: [], records_state: 'ready', next_step: 'install' });
    expect(current.findings).toContainEqual(expect.objectContaining({ code: 'missing_inventory' }));expect(f.db.serialize()).toEqual(before);
    const replay = await f.applyRepair(request);expect(replay.current?.records_state).toBe('ready');expect(installed.records.getNamespace(installed.owner)?.state.state).toBe('ready');
  } finally { f.close(); }
});

it('holds inspection when persisted Records namespaces cannot be inspected through the configured store', async () => {
  const f = await fixture();try {
    const installed = await installRemovalRecords(f, 'first');orphan(f, installed.catalog);f.deps.recordsStore = undefined;
    await expect(f.repairs.inspect(f.actor, f.check)).rejects.toMatchObject({ code: 'pack_repair_unsupported' });
    await expect(f.reviewRepair(installed.catalog)).rejects.toMatchObject({ code: 'pack_repair_unsupported' });
    expect(f.contracts.scan('grant', [installed.catalog])).toHaveLength(1);
  } finally { f.close(); }
});

it('holds leftover recipe automations and rechecks them after sealing instead of skipping deletion hooks', async () => {
  const f = await fixture();try {
    const schedules = createScheduleStore(f.db), recipe_id = f.active[0]!.recipe_id;
    const schedule = { schedule_id: 'leftover', recipe_id, publisher_id: 'recued-core', cron_expression: '0 9 * * *', enabled: true, created_at: 1, last_run_at: null, next_run_at: null, last_status: null, last_error: null };
    schedules.set(schedule);f.deps.getRecipeOwnedState = () => ({ recipes: f.recipes, schedules });
    const removal = await f.review();await expect(f.removals.apply({ review_id: removal.review_id, request_id: 'partial-hooks' }, f.actor, f.check, async () => {
      for (const id of f.recipes.listForPack(f.manifest.slug)) f.recipes.delete(id);throw new Error('interrupted');
    })).rejects.toThrow();
    const held = await f.reviewRepair(f.manifest.slug);expect(held.blockers).toContainEqual(expect.objectContaining({ code: 'recipe_state_cleanup' }));
    schedules.delete('leftover');const ready = await f.reviewRepair(f.manifest.slug);expect(ready.blockers).toEqual([]);
    const seal = f.codec.seal.bind(f.codec);vi.spyOn(f.codec, 'seal').mockImplementation(async value => { const sealed = await seal(value);schedules.set(schedule);return sealed; });
    await expect(f.applyRepair(f.applyRequest(ready.review_id))).rejects.toMatchObject({ code: 'pack_repair_conflict' });
    expect(f.contracts.get('installed_pack', [f.manifest.slug])).not.toBeNull();expect(schedules.get('leftover')).not.toBeNull();
  } finally { f.close(); }
});

it('preserves schedules for bundled recipe fallbacks while finishing only local pack metadata', async () => {
  const f = await fixture();try {
    const schedules = createScheduleStore(f.db), recipe = f.active[0]!;
    schedules.set({ schedule_id: 'retained-bundled', recipe_id: recipe.recipe_id, publisher_id: 'recued-core', cron_expression: '0 9 * * *', enabled: true, created_at: 1, last_run_at: null, next_run_at: null, last_status: null, last_error: null });
    f.deps.getRecipeOwnedState = () => ({ recipes: f.recipes, schedules });
    const removal = await f.review();await expect(f.removals.apply({ review_id: removal.review_id, request_id: 'interrupted-bundled' }, f.actor, f.check, async () => {
      for (const id of f.recipes.listForPack(f.manifest.slug)) f.recipes.delete(id);throw new Error('interrupted');
    })).rejects.toThrow();
    f.recipes.getBundled = id => id === recipe.recipe_id ? recipe : null;
    const plan = await f.reviewRepair(f.manifest.slug);expect(plan.blockers).toEqual([]);await f.applyRepair(f.applyRequest(plan.review_id));
    expect(schedules.get('retained-bundled')).not.toBeNull();expect(f.recipes.getBundled(recipe.recipe_id)).toEqual(recipe);
  } finally { f.close(); }
});

it('holds leftover recipe state when its inspection stores are unavailable', async () => {
  const f = await fixture();try {
    const schedules = createScheduleStore(f.db);schedules.set({ schedule_id: 'uninspected', recipe_id: f.active[0]!.recipe_id, publisher_id: 'recued-core', cron_expression: '0 9 * * *', enabled: true, created_at: 1, last_run_at: null, next_run_at: null, last_status: null, last_error: null });
    const removal = await f.review();await expect(f.removals.apply({ review_id: removal.review_id, request_id: 'uninspected' }, f.actor, f.check, async () => {
      for (const id of f.recipes.listForPack(f.manifest.slug)) f.recipes.delete(id);throw new Error('interrupted');
    })).rejects.toThrow();
    const plan = await f.reviewRepair(f.manifest.slug);expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'recipe_state_unavailable' }));
    expect(schedules.get('uninspected')).not.toBeNull();
  } finally { f.close(); }
});
