/** D-325 §4.4 amendment (2026-10-24) — the types of thing an owner keeps, as an AI
 *  is told them, and the extracted create a typed asset goes through.
 *
 *  The owner ruled "reminders on": an asset an AI creates gets its type's own
 *  reminders at once, while a reminder an AI writes itself still waits for the
 *  owner. So these drive the REAL dispatcher, store, occurrence service and Yours
 *  offers: a rule row that reads as enabled proves nothing unless the clock it
 *  feeds starts, and the type's rows must outrank the writer that created them. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetRule, ExecutionSource } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createKernelAdapter } from '@recued/ingredients';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createYoursService } from '../situations/yours-service.js';
import { assetRenewal } from '../situations/asset-rule-timing.js';
import { STARTER_ASSET_CLASSES } from '../situations/asset-classes.js';
import { AssetTypeError, assetTypeIssues, assetTypes, describeAssetType, listAssetTypes } from '../situations/asset-types.js';

const NOW = Date.parse('2026-10-24T09:00:00Z');
const starter = (id: string) => STARTER_ASSET_CLASSES.find(type => type.id === id)!;
const extracted = { kind: 'extracted' as const, ref: 'chat:session-1' };
const typeSource = { kind: 'owner', ref: 'type:passport@1' };

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });

const harness = (opts: { typed?: boolean } = {}) => {
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const bus = createWarehouseEventBus(); const created: unknown[] = [];
  bus.subscribe('data.work.asset.item.created', event => { created.push(event); });
  let occurrences: ReturnType<typeof createAssetOccurrenceService> | undefined;
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), bus, now: () => NOW,
    ...(opts.typed === false ? {} : { assetTypes: assetTypes(db) }),
    onAssetChanged: async asset => { await occurrences?.reconcileAsset(asset.id); } });
  occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => NOW, timeZone: () => 'UTC' });
  const yours = () => createYoursService({ db, work, dispatchers, occurrences: occurrences!, situations: createSituationStore(db), now: () => NOW, timeZone: () => 'UTC' });
  return { work, dispatchers, created, clocks: () => createAssetOccurrenceStore(db), yours };
};
const passport = (patch: Record<string, unknown> = {}) => ({ name: "Maya's passport", class_id: 'passport', holder_contact: 'maya@example.com',
  dates: { expires_on: '2027-03-01' }, source: extracted, ...patch });

describe('D-325 — a type of thing, as an AI is told it', () => {
  it('describes a passport: its dates, that it needs its holder, and the reminders those dates send', () => {
    expect(describeAssetType(starter('passport'))).toEqual({
      type: 'passport', name: 'Passport', dates: ['expires_on', 'issued_on'], holder_required: true,
      reminders: [{ title: 'Renew', due: 'on expires_on', remind: ['6 months before', '3 months before', '1 month before', 'on the day', 'then every 1 month'] }],
    });
  });

  it('words each kind of clock by the field it reads', () => {
    const vehicle = describeAssetType(starter('vehicle'));
    expect(vehicle).toMatchObject({ dates: ['legal_check_on', 'last_serviced_on'], readings: ['odometer'], observations: ['open_recall'] });
    expect(vehicle).not.toHaveProperty('holder_required');
    expect(vehicle.reminders).toEqual([
      { title: 'Book legal check', due: 'on legal_check_on', remind: ['1 month before', 'on the day', 'then every 1 month'] },
      { title: 'Service', due: '12 months after last_serviced_on', remind: ['1 month before', 'on the day'] },
      { title: 'Check vehicle recall', due: 'when open_recall is reported', remind: ['on the day', 'then every 1 month'] },
    ]);
    // The notice deadline is a month before the renewal date, not the date itself.
    expect(describeAssetType(starter('insurance_policy')).reminders[1]).toEqual(
      { title: 'Cancel or renew before notice ends', due: '1 month before renews_on', remind: ['1 month before', 'on the day', 'then every 1 month'] });
  });

  it('marks a reminder that sends nothing as off', () => {
    const quiet: AssetRule = { ...starter('passport').rules[0]!, muted: true };
    expect(describeAssetType({ ...starter('passport'), rules: [quiet] }).reminders[0]).toMatchObject({ off: true });
  });

  it('lists every type the server holds, with its dates', () => {
    harness();
    const listed = listAssetTypes(assetTypes(db).list());
    expect(listed.map(entry => entry.type).sort()).toEqual(STARTER_ASSET_CLASSES.map(type => type.id).sort());
    expect(listed.find(entry => entry.type === 'visa')).toEqual({ type: 'visa', name: 'Visa', dates: ['expires_on', 'issued_on'], holder_required: true });
    expect(listed.find(entry => entry.type === 'heirloom')).toEqual({ type: 'heirloom', name: 'Heirloom or keepsake', dates: [] });
  });

  it('names what a create sent beyond its type', () => {
    const type = starter('passport');
    expect(assetTypeIssues(type, { dates: { expires_on: '2027-03-01' }, holder_contact: 'maya@example.com' })).toBeNull();
    expect(assetTypeIssues(type, { dates: { departure_on: '2027-01-01' }, readings: { pages: null }, holder_contact: 'x' }))
      .toEqual({ unknown: { dates: ['departure_on'], readings: ['pages'] }, holder: false, rules: false, settings: false });
    expect(assetTypeIssues(type, { rules: [type.rules[0]!], settings: { sensitive: false } }))
      .toEqual({ unknown: {}, holder: true, rules: true, settings: true });
    // An empty list or map is nothing sent.
    expect(assetTypeIssues(type, { rules: [], settings: {}, holder_contact: 'x' })).toBeNull();
  });
});

describe('D-325 — an extracted create that names a type', () => {
  it("keeps the writer's facts at its rank and starts the type's own reminders, as the type's", async () => {
    const f = harness();
    const { asset } = await f.dispatchers.assetCreate(passport());
    expect(asset.rules).toEqual([{ ...starter('passport').rules[0]!, pinned: false }]);
    expect(asset.rules[0]!.enabled).toBe(true);
    expect(asset.settings).toEqual({ sensitive: true, class_version: 1, class_rule_ids: ['renew'] });
    expect(asset.dates).toEqual({ expires_on: '2027-03-01', issued_on: null });
    expect(asset.field_sources['dates.expires_on']).toMatchObject(extracted);
    expect(asset.field_sources.holder_contact).toMatchObject(extracted);
    expect(asset.field_sources.name).toMatchObject(extracted);
    for (const path of ['rules.renew', 'class_id', 'settings.sensitive', 'settings.class_version']) {
      expect(asset.field_sources[path], path).toMatchObject(typeSource);
    }
    expect(f.work.readAsset(asset.id)).toEqual(asset);
    // The clock is running: the renewal is the type's own, so it is closed by its
    // new date, and the occurrence service has its occurrence.
    expect(assetRenewal(asset, asset.rules[0]!)).toEqual({ field: 'expires_on', current: '2027-03-01' });
    expect(f.clocks().byAsset(asset.id).map(row => row.rule_id)).toEqual(['renew']);
  });

  it('publishes one created event, and it carries the reminders', async () => {
    const f = harness();
    const { asset } = await f.dispatchers.assetCreate(passport());
    expect(f.created).toHaveLength(1);
    expect(JSON.stringify(f.created[0])).toContain(asset.id);
    expect(JSON.stringify(f.created[0])).toContain('"class_rule_ids":["renew"]');
  });

  it('offers no class update for a type already applied', async () => {
    const f = harness(); const yours = f.yours();
    try {
      const { asset } = await f.dispatchers.assetCreate(passport());
      await yours.tick();
      expect(yours.proposals.list({ state: 'proposed', kind: 'rule', limit: 100 })
        .filter(row => row.payload.asset_id === asset.id)).toEqual([]);
    } finally { await yours.stop(); }
  });

  it("keeps the type's reminders from a later extracted write", async () => {
    const f = harness();
    const { asset } = await f.dispatchers.assetCreate(passport());
    await f.dispatchers.assetUpdate({ id: asset.id, source: { kind: 'extracted', ref: 'chat:session-2' },
      rules: [{ ...asset.rules[0]!, enabled: false }], settings: { class_version: 0 } });
    const after = f.work.readAsset(asset.id)!;
    expect(after.rules[0]!.enabled).toBe(true);
    expect(after.settings.class_version).toBe(1);
    expect(after.field_sources['rules.renew']).toMatchObject(typeSource);
  });

  it('refuses a date its type does not keep, saying which it keeps, and writes nothing', async () => {
    const f = harness();
    const refused = f.dispatchers.assetCreate(passport({ dates: { expires_on: '2027-03-01', departure_on: '2027-01-01' } }));
    await expect(refused).rejects.toBeInstanceOf(AssetTypeError);
    await expect(refused).rejects.toThrow('Type `passport` keeps the dates `expires_on` and `issued_on`, not `departure_on`. work.type describes each type.');
    expect(f.work.listAssets({})).toEqual([]);
    expect(f.created).toEqual([]);
  });

  it('names every problem at once: a missing holder, rules and settings', async () => {
    const f = harness();
    const { holder_contact: _holder, ...noHolder } = passport();
    const refused = f.dispatchers.assetCreate({ ...noHolder, rules: [starter('passport').rules[0]!], settings: { sensitive: false } });
    await expect(refused).rejects.toThrow(/needs its holder: pass `holder_contact`.*leave out rules.*leave out settings/u);
    expect(f.work.listAssets({})).toEqual([]);
  });

  it('refuses a type that does not exist', async () => {
    const f = harness();
    await expect(f.dispatchers.assetCreate(passport({ class_id: 'pasport' }))).rejects.toThrow('There is no asset type `pasport`. work.type lists them.');
    expect(f.work.listAssets({})).toEqual([]);
  });

  it('leaves an asset with no type as it was: a rule it brings waits for the owner', async () => {
    const f = harness();
    const rule = { ...starter('passport').rules[0]!, id: 'own' };
    const { asset } = await f.dispatchers.assetCreate({ name: 'Old camera', dates: { expires_on: '2027-03-01' }, rules: [rule], source: extracted });
    expect(asset.class_id).toBeUndefined();
    expect(asset.rules).toEqual([{ ...rule, enabled: false, pinned: false }]);
    expect(asset.field_sources['rules.own']).toMatchObject(extracted);
  });

  it("holds only an extracted writer: the owner's own create applies its class in Yours", async () => {
    const f = harness();
    const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'token' };
    const { asset } = await f.dispatchers.assetCreate({ name: 'Passport', class_id: 'passport', dates: { departure_on: '2027-01-01' },
      source: { kind: 'owner', ref: 'paired-owner' }, origin_execution_source: owner });
    expect(asset.rules).toEqual([]);
    expect(asset.dates).toEqual({ departure_on: '2027-01-01' });
  });

  it('a server with no types wired creates as before', async () => {
    const f = harness({ typed: false });
    const { asset } = await f.dispatchers.assetCreate(passport({ dates: { departure_on: '2027-01-01' } }));
    expect(asset.rules).toEqual([]);
    expect(asset.class_id).toBe('passport');
  });

  it('keeps one asset when the create is repeated', async () => {
    const f = harness();
    const first = await f.dispatchers.assetCreate(passport({ idempotency_key: 'chat-turn-7' }));
    const again = await f.dispatchers.assetCreate(passport({ idempotency_key: 'chat-turn-7' }));
    expect(again.asset).toEqual(first.asset);
    expect(f.work.listAssets({})).toHaveLength(1);
    expect(f.created).toHaveLength(1);
  });

  it("still creates the asset when its type's reminders cannot be written, and Yours offers them", async () => {
    const f = harness(); const yours = f.yours();
    const write = f.work.writeAsset;
    vi.spyOn(f.work, 'writeAsset').mockImplementation((input, now) => {
      if (input.preset_application) throw new Error('disk full');
      return write(input, now);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { asset } = await f.dispatchers.assetCreate(passport());
      expect(asset).toMatchObject({ class_id: 'passport', rules: [] });
      expect(asset.settings.class_version).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('the reminders of type passport were not applied'), expect.any(Error));
      expect(f.created).toHaveLength(1);
      vi.mocked(f.work.writeAsset).mockRestore();
      await yours.tick();
      expect(yours.proposals.list({ state: 'proposed', kind: 'rule', limit: 100 }).map(row => row.payload))
        .toEqual([expect.objectContaining({ asset_id: asset.id, class_id: 'passport', apply_class: true })]);
    } finally { await yours.stop(); }
  });
});

describe('D-325 — a recipe step, or an AI app\'s inline recipe, through the kernel', () => {
  const step = (f: ReturnType<typeof harness>, input: Record<string, unknown>) =>
    createKernelAdapter(f.dispatchers as unknown as Parameters<typeof createKernelAdapter>[0])({
      slug: 'asset-create', risk_tier: 'write', input, output: {},
    }) as Promise<{ asset_id: string }>;

  it('creates to the type, with its reminders on, and answers with the id only', async () => {
    const f = harness();
    const out = await step(f, passport({ source: { kind: 'extracted', ref: 'recipe:passport-intake' } }));
    expect(Object.keys(out)).toEqual(['asset_id']);
    const asset = f.work.readAsset(out.asset_id)!;
    expect(asset.rules.map(rule => [rule.id, rule.enabled])).toEqual([['renew', true]]);
    expect(asset.field_sources['dates.expires_on']).toMatchObject({ kind: 'extracted', ref: 'recipe:passport-intake' });
  });

  it('refuses a field the type does not keep, pointing at work.type', async () => {
    const f = harness();
    await expect(step(f, passport({ readings: { pages: null } })))
      .rejects.toThrow('Type `passport` keeps no readings, not `pages`. work.type describes each type.');
    expect(f.work.listAssets({})).toEqual([]);
  });

  it('its description tells the writer where the shapes are', () => {
    const manifest = KERNEL_MANIFESTS.find(row => row.slug === 'asset-create')!;
    expect(manifest.description).toContain('call work.type first');
    expect(manifest.description).toContain('its own reminders start at once');
  });
});
