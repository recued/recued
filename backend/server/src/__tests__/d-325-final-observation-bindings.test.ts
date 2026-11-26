import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetCreateInput, AssetRule, RecipeDefinition } from '@recued/contracts';
import { canonicalJsonString, canonicalRecipeDefinition } from '@recued/recipes';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel, type NotificationSettings, type PendingAsk } from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createWorkEntityStore, ensureWorkEntitySchema, type AssetObservationBinding } from '../storage/work-entity-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';
import { createRecipeStore } from '../recipe-store.js';

const at = Date.parse('2026-10-17T12:00Z');
const base = { source_id: 'recued.asset', source: { kind: 'owner' as const, ref: 'fixture-owner' } };
const definition = JSON.parse(readFileSync('community/recipes/record-asset-evidence-paperless.json', 'utf8')) as RecipeDefinition;
const digest = (recipe: RecipeDefinition) => createHash('sha256').update(canonicalJsonString(canonicalRecipeDefinition(recipe))).digest('hex');
const rule: AssetRule = { id: 'review', title: 'Review', enabled: true, muted: true, pinned: false, consequence: 'routine', expiry_policy: 'escalate_overdue',
  when: { kind: 'expiry', field: 'review_on' }, reaction: { notify: false, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true } };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const fixture = () => {
  let measured: string[] | undefined;
  const db = new Database(':memory:', { verbose(sql) { measured?.push(String(sql)); } });
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const directory = mkdtempSync(join(tmpdir(), 'd325-final-bindings-'));
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => at, timeZone: () => 'UTC' });
  const service = createYoursService({ db, work, dispatchers, occurrences, situations: createSituationStore(db), now: () => at, timeZone: () => 'UTC' });
  disposals.push(async () => { await service.stop(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const put = (id: string, patch: Partial<AssetCreateInput> = {}, time = at) => work.writeAsset({ ...base, id, name: `Fixture ${id}`,
    observations: { fault: null }, readings: { meter: null }, ...patch }, time);
  const enroll = (id: string, actor = 'a', source = 'a', patch: Partial<AssetObservationBinding> = {}) => {
    const binding: AssetObservationBinding = { id: JSON.stringify([id, actor, source]), asset_id: id, actor_ref: `recipe:${actor}`, source_ref: `device:${source}`,
      fields: ['readings.meter', 'observations.fault'], enabled: true, ...patch };
    work.bindAssetObservations(binding); return binding;
  };
  const seed = (count: number, missing = false) => {
    const ids = Array.from({ length: count }, (_, n) => n === 120 ? "asset-'quoted?" : n === 121 ? 'asset-漢' : `asset-${String(n).padStart(4, '0')}`);
    db.transaction(() => { for (const [index, id] of ids.entries()) {
      put(id, { sphere: index % 2 ? 'personal' : 'professional', ...(missing ? { rules: [rule], dates: { review_on: null } } : {}) }, at + index);
      for (const [actor, source] of [['z', 'z'], ['a', 'z'], ['a', 'a']] as const) enroll(id, actor, source, { enabled: index % 3 !== 0 });
    } })();
    return ids.reverse();
  };
  const install = () => { const recipes = createRecipeStore(directory, db); recipes.save(definition, 'fixture', 'bundled', at); service.bindRecipes(recipes); return recipes; };
  const measure = async <T>(read: () => Promise<T>) => {
    const sql: string[] = []; measured = sql;
    try { return { value: await read(), sql }; } finally { measured = undefined; }
  };
  const pause = () => {
    const destinationsEntered = gate(); const destinationsRelease = gate(); const repliesEntered = gate(); const repliesRelease = gate();
    const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
      channels: [createUiChannel({ busSink: () => {} })] });
    service.bind({ ...block,
      async getReminderDestinations() { destinationsEntered.resolve(); await destinationsRelease.promise; return { destinations: [], issues: [] }; },
      async listUnmatchedAskReplies() { repliesEntered.resolve(); await repliesRelease.promise; return []; },
    });
    return { destinationsEntered, destinationsRelease, repliesEntered, repliesRelease };
  };
  return { db, work, service, put, enroll, seed, install, measure, pause };
};
const bindingSql = (sql: string) => /^SELECT \* FROM asset_observation_binding WHERE asset_id/u.test(sql);
const batchSql = (sql: string) => /^SELECT \* FROM asset_observation_binding WHERE asset_id IN\s*\(/u.test(sql);

describe('batched final observation bindings', () => {
  it('reads only the returned page in one statement, preserving complete binding DTOs and order', async () => {
    const f = fixture(); const all = f.seed(241);
    const batch = vi.spyOn(f.work, 'listAssetObservationBindingsForAssets'); const point = vi.spyOn(f.work, 'listAssetObservationBindings');
    for (const analyzed of [false, true]) for (const limit of [50, 200]) {
      if (analyzed) f.db.exec('ANALYZE');
      const ids = all.slice(31, 31 + limit);
      const expected = ids.flatMap(id => f.work.listAssetObservationBindings(id).map(binding => ({ ...binding, available: true })));
      batch.mockClear(); point.mockClear();
      const read = await f.measure(() => f.service.snapshot({ offset: 31, limit }));
      expect(read.value.assets.map(row => row.id)).toEqual(ids); expect(read.value.total_assets).toBe(241);
      expect(read.value.observation_bindings).toEqual(expected);
      expect(read.sql.filter(bindingSql)).toHaveLength(1); expect(read.sql.filter(batchSql)).toHaveLength(1);
      expect(batch).toHaveBeenCalledExactlyOnceWith(ids); expect(point).not.toHaveBeenCalled();
      read.value.observation_bindings![0]!.fields.push('changed output');
      expect(read.value.observation_bindings![1]!.fields).toEqual(['readings.meter', 'observations.fault']);
    }
  });

  it('limits combined attention and sphere reads to the selected page', async () => {
    const f = fixture(); f.seed(121, true);
    const matched = f.work.listAssets({ limit: 200 }).filter(row => row.sphere === 'professional'); const ids = matched.slice(7, 12).map(row => row.id);
    const expected = ids.flatMap(id => f.work.listAssetObservationBindings(id).map(binding => ({ ...binding, available: true })));
    const batch = vi.spyOn(f.work, 'listAssetObservationBindingsForAssets'); const point = vi.spyOn(f.work, 'listAssetObservationBindings');
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional', limit: 5, offset: 7, include_asset_summaries: true }));
    expect(read.value.total_assets).toBe(matched.length); expect(read.value.assets.map(row => row.id)).toEqual(ids);
    expect(read.value.observation_bindings).toEqual(expected); expect(batch).toHaveBeenCalledExactlyOnceWith(ids); expect(point).not.toHaveBeenCalled();
    expect(read.sql.filter(bindingSql)).toHaveLength(1);
  });

  it('keeps enabled flags separate from availability and uses installed recipe versions and selected asset statuses', async () => {
    const f = fixture(); const recipes = f.install(); const hash = digest(definition); const availability = new Map<string, boolean>();
    for (const id of ['active', 'lent', 'retired']) f.put(id, { status: id === 'active' ? 'active' : id === 'lent' ? 'lent' : 'retired' });
    const active = f.enroll('active', definition.recipe_id, 'matching', { recipe_hash: hash }); availability.set(active.id, true);
    const disabled = f.enroll('active', definition.recipe_id, 'disabled', { recipe_hash: hash, enabled: false }); availability.set(disabled.id, true);
    const changed = f.enroll('active', definition.recipe_id, 'changed', { recipe_hash: 'f'.repeat(64) }); availability.set(changed.id, false);
    const absent = f.enroll('active', 'absent', 'absent', { recipe_hash: hash }); availability.set(absent.id, false);
    const legacy = f.enroll('active', 'absent', 'legacy'); availability.set(legacy.id, true);
    const lent = f.enroll('lent', definition.recipe_id, 'matching', { recipe_hash: hash }); availability.set(lent.id, true);
    const retired = f.enroll('retired', 'absent', 'legacy'); availability.set(retired.id, false);
    const expected = () => f.work.listAssets().flatMap(row => f.work.listAssetObservationBindings(row.id).map(binding => ({ ...binding, available: availability.get(binding.id)! })));
    const first = await f.service.snapshot(); expect(first.observation_bindings).toEqual(expected());
    const updated = structuredClone(definition); updated.metadata.description += ' Updated fixture.'; recipes.save(updated, 'fixture', 'bundled', at + 1);
    for (const binding of [active, disabled, lent]) availability.set(binding.id, false);
    expect((await f.service.snapshot()).observation_bindings).toEqual(expected());
    recipes.delete(definition.recipe_id); expect((await f.service.snapshot()).observation_bindings).toEqual(expected());
    expect(first.observation_bindings?.find(row => row.id === active.id)?.available).toBe(true);
    expect(first.observation_bindings?.find(row => row.id === disabled.id)).toMatchObject({ enabled: false, available: true });
  });

  it('reads binding and recipe changes after both delivery awaits while retaining the selected asset status', async () => {
    const f = fixture(); f.put('a'); const recipes = f.install(); const old = f.enroll('a', definition.recipe_id, 'old', { recipe_hash: digest(definition) });
    const batch = vi.spyOn(f.work, 'listAssetObservationBindingsForAssets'); const p = f.pause(); const reading = f.service.snapshot();
    try {
      await p.destinationsEntered.promise; expect(batch).not.toHaveBeenCalled();
      f.enroll('a', definition.recipe_id, 'old', { recipe_hash: digest(definition), enabled: false });
      p.destinationsRelease.resolve(); await p.repliesEntered.promise; expect(batch).not.toHaveBeenCalled();
      const updated = structuredClone(definition); updated.metadata.description += ' Reply-time fixture.'; recipes.save(updated, 'fixture', 'bundled', at + 1);
      f.db.prepare('DELETE FROM asset_observation_binding WHERE id=?').run(old.id);
      f.enroll('a', definition.recipe_id, 'new', { recipe_hash: digest(updated), fields: ['readings.meter'] }); f.enroll('a', 'late', 'late', { enabled: false });
      f.put('a', { status: 'retired' });
      const expected = f.work.listAssetObservationBindings('a').map(binding => ({ ...binding, available: true }));
      p.repliesRelease.resolve(); const first = await reading;
      expect(first.assets[0]?.status).toBe('active'); expect(first.observation_bindings).toEqual(expected); expect(batch).toHaveBeenCalledExactlyOnceWith(['a']);
      const next = await f.service.snapshot(); expect(next.assets[0]?.status).toBe('retired');
      expect(next.observation_bindings).toEqual(expected.map(binding => ({ ...binding, available: false })));
      expect(first.observation_bindings).toEqual(expected);
    } finally { p.destinationsRelease.resolve(); p.repliesRelease.resolve(); await reading; }
  });

  it('excludes bindings moved off the selected page during reply delivery and reads a move back on the next snapshot', async () => {
    const f = fixture(); f.put('selected', {}, at + 1); f.put('other');
    f.enroll('selected', 'a', 'selected'); f.enroll('other', 'a', 'other');
    const batch = vi.spyOn(f.work, 'listAssetObservationBindingsForAssets'); const p = f.pause(); const reading = f.service.snapshot({ limit: 1 });
    try {
      await p.destinationsEntered.promise; p.destinationsRelease.resolve(); await p.repliesEntered.promise;
      expect(batch).not.toHaveBeenCalled(); f.work.moveAssetObservations('selected', 'other');
      p.repliesRelease.resolve(); const first = await reading;
      expect(first.assets.map(row => row.id)).toEqual(['selected']); expect(first.observation_bindings).toEqual([]);
      expect(batch).toHaveBeenCalledExactlyOnceWith(['selected']);
      f.work.moveAssetObservations('other', 'selected');
      const expected = f.work.listAssetObservationBindings('selected').map(binding => ({ ...binding, available: true }));
      const next = await f.service.snapshot({ limit: 1 }); expect(next.observation_bindings).toEqual(expected);
      expect(next.observation_bindings).toHaveLength(2); expect(first.observation_bindings).toEqual([]);
    } finally { p.destinationsRelease.resolve(); p.repliesRelease.resolve(); await reading; }
  });

  it('returns no bindings for a selected asset deleted while reply delivery is awaited', async () => {
    const f = fixture(); f.put('selected', {}, at + 1); f.put('other');
    f.enroll('selected'); const other = f.enroll('other');
    const batch = vi.spyOn(f.work, 'listAssetObservationBindingsForAssets'); const point = vi.spyOn(f.work, 'listAssetObservationBindings');
    const p = f.pause(); const reading = f.service.snapshot({ limit: 1 });
    try {
      await p.destinationsEntered.promise; p.destinationsRelease.resolve(); await p.repliesEntered.promise;
      expect(batch).not.toHaveBeenCalled(); f.work.deleteAsset('selected');
      p.repliesRelease.resolve(); const first = await reading;
      expect(first.assets.map(row => row.id)).toEqual(['selected']); expect(first.total_assets).toBe(2); expect(first.observation_bindings).toEqual([]);
      expect(batch).toHaveBeenCalledExactlyOnceWith(['selected']); expect(point).not.toHaveBeenCalled();
      const next = await f.service.snapshot({ limit: 1 }); expect(next.assets.map(row => row.id)).toEqual(['other']);
      expect(next.total_assets).toBe(1); expect(next.observation_bindings).toEqual([{ ...other, available: true }]);
      expect(first.observation_bindings).toEqual([]);
    } finally { p.destinationsRelease.resolve(); p.repliesRelease.resolve(); await reading; }
  });

  it('preserves an earlier recipe error when batch decoding also fails on a later asset', async () => {
    const f = fixture(); const ids = f.seed(3); const recipes = f.install();
    f.db.prepare('UPDATE asset_observation_binding SET fields=? WHERE asset_id=?').run('{', ids[1]!);
    const expected = new Error('Fixture earlier recipe lookup failure'); const getStored = recipes.getStored.bind(recipes);
    vi.spyOn(recipes, 'getStored').mockImplementation(id => { if (id === 'a') throw expected; return getStored(id); });
    const point = vi.spyOn(f.work, 'listAssetObservationBindings');
    await expect(f.service.snapshot()).rejects.toBe(expected);
    expect(point.mock.calls.map(([id]) => id)).toEqual([ids[0]!]);
  });

  for (const failure of ['prepare', 'execution'] as const) it(`preserves individual binding reads after a native batch ${failure} failure`, async () => {
    const f = fixture(); const ids = f.seed(3); const expected = ids.flatMap(id => f.work.listAssetObservationBindings(id).map(binding => ({ ...binding, available: true })));
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (!batchSql(sql)) return prepare(sql);
      if (failure === 'prepare') throw new Error('Fixture binding prepare failure');
      const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementation(() => { throw new Error('Fixture binding execution failure'); }); return statement;
    });
    const point = vi.spyOn(f.work, 'listAssetObservationBindings');
    const result = await f.service.snapshot(); expect(result.observation_bindings).toEqual(expected);
    expect(point.mock.calls.map(([id]) => id)).toEqual(ids);
  });

  it('preserves the original individual decoding error and asset order when a binding is unreadable', async () => {
    const f = fixture(); const ids = f.seed(3); f.db.prepare('UPDATE asset_observation_binding SET fields=? WHERE asset_id=?').run('{', ids[1]!);
    const point = vi.spyOn(f.work, 'listAssetObservationBindings');
    await expect(f.service.snapshot()).rejects.toBeInstanceOf(SyntaxError);
    expect(point.mock.calls.map(([id]) => id)).toEqual(ids.slice(0, 2));
  });

  it('does no final binding work for empty or past-the-end pages', async () => {
    const f = fixture(); f.seed(3, true); f.db.prepare('UPDATE asset_observation_binding SET fields=?').run('{');
    const batch = vi.spyOn(f.work, 'listAssetObservationBindingsForAssets'); const point = vi.spyOn(f.work, 'listAssetObservationBindings');
    for (const request of [{ search: 'no-matching-fixture' }, { offset: 999 }, { asset_filter: 'missing_facts' as const, offset: 999 }]) {
      const read = await f.measure(() => f.service.snapshot(request)); expect(read.value.assets).toEqual([]); expect(read.value.observation_bindings).toEqual([]);
      expect(read.sql.filter(bindingSql)).toEqual([]);
    }
    expect(batch).not.toHaveBeenCalled(); expect(point).not.toHaveBeenCalled();
  });
});
