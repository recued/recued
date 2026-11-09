import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { PURSUIT_CLASS_ID, type AssetRule, type ExecutionSource, type YoursReadRequest } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService, type AssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createSphereStore, type SphereStore } from '../storage/sphere-store.js';

// D-342 slice 1 — the Pursuit type, the Pursuits/Assets split of Yours, and ending a pursuit.
const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

const fixture = (spheres?: (db: Database.Database, work: ReturnType<typeof createWorkEntityStore>) => SphereStore) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  let time = Date.parse('2026-11-06T12:00Z'); let occurrences: AssetOccurrenceService;
  // The retirement hook the server composes, so ending a pursuit walks its parts.
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => time,
    onAssetChanged: async asset => { if (['sold', 'lost', 'retired'].includes(asset.status)) await occurrences.retireAsset(asset.id); else await occurrences.reconcileAsset(asset.id); },
    onAssetDeleted: async asset => { await occurrences.retireAsset(asset.id); } });
  occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC', now: () => time });
  const service = createYoursService({ db, work, dispatchers, occurrences, situations: createSituationStore(db), now: () => time, timeZone: () => 'UTC',
    ...(spheres ? { spheres: spheres(db, work) } : {}) });
  disposals.push(async () => { await service.stop(); db.close(); });
  const command = (input: Parameters<typeof service.command>[0]) => service.command(input, owner);
  const pursuit = async (name: string, input: Record<string, unknown> = {}) =>
    (await command({ action: 'asset.create', class_id: PURSUIT_CLASS_ID, input: { name, ...input } })).id!;
  const names = async (input: YoursReadRequest) => (await service.snapshot(input)).assets.map(asset => asset.name).sort();
  return { db, work, service, command, pursuit, names, advance: () => { time += 60_000; return time; } };
};

/** Two pursuits (one part of the other) beside two things: a passport whose expiry is
 * unknown (so it is missing a fact), and an unclassified bike. */
const seeded = async (spheres?: Parameters<typeof fixture>[0]) => {
  const f = fixture(spheres);
  const spanish = await f.pursuit('Learn Spanish', { attributes: { horizon: 'ongoing' } });
  const b1 = await f.pursuit('B1 by December', { belongs_to: spanish, dates: { target_on: '2026-12-31' } });
  await f.command({ action: 'asset.create', class_id: 'passport', input: { name: 'Passport', holder_contact: 'ana@example.test' } });
  await f.command({ action: 'asset.create', input: { name: 'Bike' } });
  return { ...f, spanish, b1 };
};

describe('D-342 the Pursuit type', () => {
  it('is a built-in class: personal, not private, owned by the owner, with no rules and its target date and progress unknown', async () => {
    const f = fixture();
    // Not private (ruling 9): the daily suggestions are what a pursuit is for, and they leave a private one out.
    expect((await f.service.snapshot({})).classes.find(preset => preset.id === PURSUIT_CLASS_ID)).toEqual({
      id: 'pursuit', name: 'Pursuit', version: 1, origin: 'builtin', sphere: 'personal', audience: 'owner', retirement: 'part', rules: [],
      fields: { dates: { target_on: null }, readings: { progress: null }, observations: {}, settings: {} },
    });
  });
  it('creates a pursuit in the owner’s words, keeps each progress reading with its time, and puts nothing under Due', async () => {
    const f = fixture(); const at = Date.parse('2026-11-06T09:00Z');
    const id = await f.pursuit('Learn Spanish', { attributes: { horizon: 'ongoing', why: 'To talk with Ana’s family', where_i_am: 'Finished unit 4' },
      readings: { progress: { value: 4, unit: 'units', as_of: at, evidence: [] } }, dates: { target_on: '2026-12-31' } });
    const created = f.work.readAsset(id)!;
    expect(created).toMatchObject({ class_id: 'pursuit', sphere: 'personal', status: 'active', rules: [],
      attributes: { horizon: 'ongoing', why: 'To talk with Ana’s family', where_i_am: 'Finished unit 4' },
      dates: { target_on: '2026-12-31' }, readings: { progress: { value: 4, unit: 'units', as_of: at } } });
    expect(created.settings).not.toHaveProperty('sensitive');
    expect(created.field_sources['attributes.where_i_am']).toMatchObject({ kind: 'owner' });
    // Private can be turned on when it is made.
    expect(f.work.readAsset(await f.pursuit('Read more', { settings: { sensitive: true } }))!.settings.sensitive).toBe(true);
    await f.command({ action: 'asset.update', id, patch: { readings: { progress: { value: 5, unit: 'units', as_of: f.advance(), evidence: [] } },
      attributes: { where_i_am: 'Finished unit 5' } } });
    expect(f.work.assetReadingHistory(id, 'progress').map(row => row.value)).toEqual([5, 4]);
    expect(f.work.readAsset(id)!.attributes).toEqual({ horizon: 'ongoing', why: 'To talk with Ana’s family', where_i_am: 'Finished unit 5' });
    const snapshot = await f.service.snapshot({});
    expect(snapshot.occurrences).toEqual([]);
    expect(f.work.listCommitments()).toEqual([]);
  });
});

describe('D-342 §7 the Pursuits and Assets tabs split Yours', () => {
  it('reads pursuits alone, or every asset but them, with the count to match and the filter echoed', async () => {
    const f = await seeded();
    const only = await f.service.snapshot({ pursuits: 'only' });
    expect(only.assets.map(asset => asset.name).sort()).toEqual(['B1 by December', 'Learn Spanish']);
    expect(only).toMatchObject({ total_assets: 2, pursuits: 'only' });
    const others = await f.service.snapshot({ pursuits: 'exclude' });
    expect(others.assets.map(asset => asset.name).sort()).toEqual(['Bike', 'Passport']);
    expect(others).toMatchObject({ total_assets: 2, pursuits: 'exclude' });
    // A read that names no filter still has everything, as the asset picker needs.
    const all = await f.service.snapshot({});
    expect(all.assets).toHaveLength(4); expect(all.pursuits).toBeUndefined();
  });
  it('keeps the split under a search, a sphere, and an attention filter', async () => {
    const f = await seeded();
    // The search also matches a class id, so "pursuit" finds both pursuits, and never on the Assets tab.
    expect(await f.names({ search: 'pursuit' })).toEqual(['B1 by December', 'Learn Spanish']);
    expect(await f.names({ search: 'pursuit', pursuits: 'exclude' })).toEqual([]);
    expect(await f.names({ search: 'spanish', pursuits: 'only' })).toEqual(['Learn Spanish']);
    // Pursuits are personal by their type; the passport and bike are unsorted.
    expect(await f.names({ asset_sphere: 'personal' })).toEqual(['B1 by December', 'Learn Spanish']);
    expect(await f.names({ asset_sphere: 'personal', pursuits: 'exclude' })).toEqual([]);
    expect(await f.names({ asset_sphere: 'unsorted', pursuits: 'exclude' })).toEqual(['Bike', 'Passport']);
    // A pursuit the owner gave a rule can be missing a fact like any asset.
    const deadline: AssetRule = { id: 'deadline', title: 'Check the deadline', enabled: true, muted: false, pinned: false, consequence: 'routine',
      expiry_policy: 'strict_expire', when: { kind: 'expiry', field: 'target_on' }, reaction: { notify: false, occurrence: 'notice', emit: false },
      schedule: { before: [], on_day: true } };
    await f.command({ action: 'rule.save', asset_id: f.spanish, rule: deadline });
    expect(await f.names({ asset_filter: 'missing_facts' })).toEqual(['Learn Spanish', 'Passport']);
    expect(await f.names({ asset_filter: 'missing_facts', pursuits: 'exclude' })).toEqual(['Passport']);
    expect(await f.names({ asset_filter: 'missing_facts', pursuits: 'only' })).toEqual(['Learn Spanish']);
    expect(await f.names({ asset_filter: 'missing_facts', asset_sphere: 'personal', pursuits: 'exclude' })).toEqual([]);
    expect(await f.names({ asset_filter: 'missing_facts', asset_sphere: 'personal' })).toEqual(['Learn Spanish']);
  });
  it('keeps the split on the scan a read falls back to when the sphere selector cannot answer', async () => {
    const f = await seeded((db, work) => {
      const real = createSphereStore(db, work);
      return { ...real, assetPage: () => undefined, assetCandidates: () => undefined, withAssetReadingHistories: (_sphere, _query, read) => read() };
    });
    expect(await f.names({ asset_sphere: 'personal', pursuits: 'exclude' })).toEqual([]);
    expect(await f.names({ asset_sphere: 'personal', pursuits: 'only' })).toEqual(['B1 by December', 'Learn Spanish']);
    expect((await f.service.snapshot({ asset_sphere: 'unsorted', pursuits: 'exclude' })).total_assets).toBe(2);
  });
  it('refuses an unknown filter, and a filter on one asset’s page', async () => {
    const f = await seeded();
    await expect(f.service.snapshot({ pursuits: 'all' as never })).rejects.toThrow('Unknown pursuits filter');
    await expect(f.service.snapshot({ asset_id: f.spanish, pursuits: 'only' })).rejects.toThrow('Asset filters apply to the asset list');
    expect(() => f.work.listByKind('asset', { asset_class: { id: '', match: 'only' } })).toThrow('invalid asset class scope');
  });
});

describe('D-342 §3 ending a pursuit', () => {
  it('keeps Reached on the pursuit, ends its parts with it, and lists both as ended pursuits', async () => {
    const f = await seeded();
    await f.command({ action: 'asset.update', id: f.spanish, patch: { status: 'retired', attributes: { ended_as: 'reached' } }, confirm_retirement: true });
    expect(f.work.readAsset(f.spanish)).toMatchObject({ status: 'retired', attributes: { horizon: 'ongoing', ended_as: 'reached' } });
    // A part ends with its parent and keeps no ending of its own.
    const b1 = f.work.readAsset(f.b1)!;
    expect(b1.status).toBe('retired'); expect(b1.attributes.ended_as).toBeUndefined();
    expect((await f.service.snapshot({ pursuits: 'only' })).assets.map(asset => [asset.name, asset.status]).sort())
      .toEqual([['B1 by December', 'retired'], ['Learn Spanish', 'retired']]);
  });
  it('lets a pursuit be let go alone, and brought back with its ending cleared', async () => {
    const f = await seeded();
    await f.command({ action: 'asset.update', id: f.b1, patch: { status: 'retired', attributes: { ended_as: 'let_go' } }, confirm_retirement: true });
    expect(f.work.readAsset(f.b1)).toMatchObject({ status: 'retired', attributes: { ended_as: 'let_go' } });
    expect(f.work.readAsset(f.spanish)!.status).toBe('active');
    await f.command({ action: 'asset.update', id: f.b1, patch: { status: 'active', attributes: { ended_as: null } } });
    expect(f.work.readAsset(f.b1)).toMatchObject({ status: 'active', attributes: { ended_as: null } });
  });
});
