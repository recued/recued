import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateAssetRuleClock, type AssetCreateInput, type AssetRule, type SituationRef } from '@recued/contracts';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel, type NotificationSettings, type PendingAsk } from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createSphereStore } from '../storage/sphere-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';

const at = Date.parse('2026-10-17T12:00Z');
const base = { source_id: 'recued.asset', source: { kind: 'owner' as const, ref: 'fixture-owner' } };
const noticeRule: AssetRule = { id: 'notice', title: 'Review', enabled: true, muted: true, pinned: false, consequence: 'routine', expiry_policy: 'escalate_overdue',
  when: { kind: 'expiry', field: 'review_on' }, reaction: { notify: false, occurrence: 'notice', emit: false }, schedule: { before: [], on_day: true } };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const fixture = (origin?: Parameters<typeof createSphereStore>[3]) => {
  let measured: string[] | undefined;
  const db = new Database(':memory:', { verbose(sql) { if (measured) measured.push(String(sql)); } });
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const rows = createAssetOccurrenceStore(db); const spheres = createSphereStore(db, work, undefined, origin);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => at, timeZone: () => 'UTC' });
  const service = createYoursService({ db, work, dispatchers, occurrences, spheres, situations: createSituationStore(db), now: () => at, timeZone: () => 'UTC' });
  disposals.push(async () => { await service.stop(); db.close(); });
  const put = (id: string, patch: Partial<AssetCreateInput> = {}, time = at) => work.writeAsset({ ...base, id, name: `Fixture ${id}`, ...patch }, time);
  const measure = async <T>(read: () => T | Promise<T>) => {
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
  const notice = (id: string, index: number) => {
    const asset = put(id, { sphere: 'personal', dates: { review_on: '2026-10-17' }, rules: [noticeRule] }, at + index);
    rows.ensure({ id: `notice:${id}`, asset_id: id, rule_id: noticeRule.id, cycle: evaluateAssetRuleClock(asset, noticeRule, { now: at, timeZone: 'UTC' }).cycle,
      commitment_id: null, question: false, trigger_kind: 'rule', created_at: at + index });
    return asset;
  };
  return { db, work, rows, spheres, service, put, notice, measure, pause };
};
const pinBatchSql = (sql: string) => /FROM sphere_items WHERE collection='asset' AND id IN\s*\(/u.test(sql);
const pointPins = (sql: string[]) => sql.filter(statement => /FROM sphere_items WHERE collection='asset' AND id\s*=/u.test(statement));

describe('batched final asset placements', () => {
  it('batches only the returned page without a sphere filter, preserving order and complete placements', async () => {
    const f = fixture(); const ids: string[] = [];
    f.db.transaction(() => { for (let index = 0; index < 241; index++) ids.unshift(f.put(`asset-${String(index).padStart(4, '0')}`, { sphere: 'personal' }, at + index).id); })();
    const page = ids.slice(31, 231); const expected = page.map(id => ({ ref: { collection: 'asset', id }, ...f.spheres.resolve({ collection: 'asset', id }) }));
    const batch = vi.spyOn(f.spheres, 'resolveAssets');
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE'); batch.mockClear();
      const read = await f.measure(() => f.service.snapshot({ limit: 200, offset: 31 }));
      expect(read.value.total_assets).toBe(241); expect(read.value.assets.map(row => row.id)).toEqual(page);
      expect(read.value.sphere_placements).toEqual(expected);
      expect(pointPins(read.sql)).toEqual([]); expect(read.sql.filter(pinBatchSql)).toHaveLength(1);
      expect(batch).toHaveBeenCalledExactlyOnceWith(page);
    }
  });

  it('bounds more than 200 final asset references, retaining duplicate and cross-collection ordering', async () => {
    const f = fixture(); const ids = Array.from({ length: 203 }, (_, n) => `asset-${String(n).padStart(4, '0')}`); ids.push("asset-'quoted?", 'asset-漢');
    const rule = noticeRule;
    f.db.transaction(() => { for (const [index, id] of ids.entries()) {
      const asset = f.put(id, { sphere: index % 2 ? 'personal' : 'professional', dates: { review_on: '2026-10-17' }, rules: [rule] }, at + index);
      f.rows.ensure({ id: `notice:${id}`, asset_id: id, rule_id: rule.id, cycle: evaluateAssetRuleClock(asset, rule, { now: at, timeZone: 'UTC' }).cycle,
        commitment_id: null, question: false, trigger_kind: 'rule', created_at: at + index });
    } })();
    const pageId = ids[1]!;
    f.work.writeCommitment({ id: pageId, source_id: 'recued.commitment', direction: 'outbound', statement: 'Shared id task', derivation: 'user_declared', lifecycle_state: 'pending' }, at);
    f.rows.ensure({ id: 'shared-task', asset_id: pageId, rule_id: 'task', cycle: 'task', commitment_id: pageId, question: false, trigger_kind: 'rule', created_at: at + 500 });
    const ordered = [pageId, ...ids.filter(id => id !== pageId)];
    const refs: SituationRef[] = [...ordered.map(id => ({ collection: 'asset' as const, id })), { collection: 'commitment', id: pageId }];
    const expected = refs.map(ref => ({ ref, ...f.spheres.resolve(ref) }));
    const batch = vi.spyOn(f.spheres, 'resolveAssets'); const individual = vi.spyOn(f.spheres, 'resolve');
    const read = await f.measure(() => f.service.snapshot({ limit: 1, offset: 203 }));
    expect(read.value.assets.map(row => row.id)).toEqual([pageId]); expect(read.value.occurrences).toHaveLength(206);
    expect(read.value.sphere_placements).toEqual(expected); expect(read.value.sphere_placements).toHaveLength(206);
    expect(batch).toHaveBeenCalledExactlyOnceWith(ordered); expect(read.sql.filter(pinBatchSql)).toHaveLength(2); expect(pointPins(read.sql)).toEqual([]);
    expect(individual.mock.calls.map(([ref]) => ref)).toEqual([{ collection: 'commitment', id: pageId }]);
  });

  it('keeps pins, overrides, custom origins and source fallbacks fresh across snapshots', async () => {
    const f = fixture(ref => ref.collection === 'asset' ? { source: 'calendar:fixture:room', sphere: 'professional' } : undefined);
    f.put('parent', { sphere: 'personal' }); f.put('child', { belongs_to: 'parent' }); f.put('override', { sphere_override: 'personal' });
    f.put('pinned', { sphere_override: 'personal' }); f.spheres.setItem({ collection: 'asset', id: 'pinned' }, 'professional');
    f.spheres.setSource('calendar:fixture', 'personal');
    const expected = () => f.work.listAssets().map(asset => ({ ref: { collection: 'asset', id: asset.id }, ...f.spheres.resolve({ collection: 'asset', id: asset.id }) }));
    const first = await f.service.snapshot(); expect(first.sphere_placements).toEqual(expected());
    expect(first.sphere_placements.find(row => row.ref.id === 'child')).toMatchObject({ sphere: 'personal', reason: 'from: calendar:fixture:room' });
    f.spheres.setSource('calendar:fixture', 'professional'); f.spheres.setItem({ collection: 'asset', id: 'pinned' }, null);
    const next = await f.service.snapshot(); expect(next.sphere_placements).toEqual(expected());
    expect(next.sphere_placements.find(row => row.ref.id === 'child')?.sphere).toBe('professional');
    expect(next.sphere_placements.find(row => row.ref.id === 'pinned')?.sphere).toBe('personal');
    expect(first.sphere_placements.find(row => row.ref.id === 'child')?.sphere).toBe('personal');
  });

  it('reads unfiltered placements after delivery yields and freezes them before the later reply await', async () => {
    const f = fixture(); f.put('parent', { sphere: 'personal' }); f.put('child', { belongs_to: 'parent' }); const p = f.pause();
    const reading = f.service.snapshot({ search: 'Fixture child' });
    try {
      await p.destinationsEntered.promise; f.put('parent', { sphere: 'professional' }, at + 1);
      p.destinationsRelease.resolve(); await p.repliesEntered.promise;
      f.put('parent', { sphere: 'personal' }, at + 2); f.spheres.setItem({ collection: 'asset', id: 'child' }, 'personal');
      p.repliesRelease.resolve(); const first = await reading;
      expect(first.assets[0]?.sphere).toBe('personal');
      expect(first.sphere_placements).toEqual([{ ref: { collection: 'asset', id: 'child' }, sphere: 'professional', reason: 'from: source or relationship', pinned: false, source: 'work:recued.asset' }]);
      expect((await f.service.snapshot({ search: 'Fixture child' })).sphere_placements[0]).toMatchObject({ sphere: 'personal', pinned: true });
      expect(first.sphere_placements[0]?.sphere).toBe('professional');
    } finally { p.destinationsRelease.resolve(); p.repliesRelease.resolve(); await reading; }
  });

  it('retains the selection placement for a sphere-filtered page across delivery waits', async () => {
    const f = fixture(); f.put('child', { sphere: 'personal' }); const p = f.pause(); const batch = vi.spyOn(f.spheres, 'resolveAssets');
    const reading = f.service.snapshot({ asset_sphere: 'personal' });
    try {
      await p.destinationsEntered.promise; batch.mockClear(); f.spheres.setItem({ collection: 'asset', id: 'child' }, 'professional');
      p.destinationsRelease.resolve(); await p.repliesEntered.promise; p.repliesRelease.resolve(); const first = await reading;
      expect(first.assets.map(row => row.id)).toEqual(['child']); expect(first.total_assets).toBe(1);
      expect(first.sphere_placements[0]).toMatchObject({ sphere: 'personal', pinned: false }); expect(batch).not.toHaveBeenCalled();
      expect((await f.service.snapshot({ asset_sphere: 'personal' })).assets).toEqual([]);
      expect((await f.service.snapshot({ asset_sphere: 'professional' })).sphere_placements[0]).toMatchObject({ sphere: 'professional', pinned: true });
    } finally { p.destinationsRelease.resolve(); p.repliesRelease.resolve(); await reading; }
  });

  for (const failure of ['prepare', 'execution'] as const) it(`uses individual placements if batch ${failure} fails`, async () => {
    const f = fixture(); for (const id of ['a', 'b', 'c']) f.put(id, { sphere: 'personal' });
    const expected = f.work.listAssets().map(asset => ({ ref: { collection: 'asset', id: asset.id }, ...f.spheres.resolve({ collection: 'asset', id: asset.id }) }));
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (!pinBatchSql(sql)) return prepare(sql);
      if (failure === 'prepare') throw new Error('Fixture placement prepare failure');
      const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementation(() => { throw new Error('Fixture placement execution failure'); }); return statement;
    });
    const read = await f.measure(() => f.service.snapshot());
    expect(read.value.sphere_placements).toEqual(expected); expect(pointPins(read.sql)).toHaveLength(3);
  });

  it('discards completed chunks after a later failure while retaining the selected sphere placement', async () => {
    const f = fixture(); const ids = Array.from({ length: 205 }, (_, n) => `asset-${String(n).padStart(4, '0')}`);
    f.db.transaction(() => { for (const [index, id] of ids.entries()) f.notice(id, index); })();
    const selected = ids[1]!; const p = f.pause();
    const reading = f.service.snapshot({ asset_sphere: 'personal', limit: 1, offset: 203 });
    try {
      await p.destinationsEntered.promise;
      const selectedPlacement = f.spheres.resolve({ collection: 'asset', id: selected });
      f.spheres.setItem({ collection: 'asset', id: selected }, 'professional'); f.spheres.setItem({ collection: 'asset', id: ids[0]! }, 'professional');
      const ordered = [selected, ...ids.filter(id => id !== selected)];
      const expected = ordered.map(id => ({ ref: { collection: 'asset', id }, ...(id === selected ? selectedPlacement : f.spheres.resolve({ collection: 'asset', id })) }));
      const prepare = f.db.prepare.bind(f.db); let chunks = 0;
      vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
        const statement = prepare(sql);
        if (pinBatchSql(sql) && ++chunks === 2) vi.spyOn(statement, 'all').mockImplementation(() => { throw new Error('Fixture later placement execution failure'); });
        return statement;
      });
      const individual = vi.spyOn(f.spheres, 'resolve');
      p.destinationsRelease.resolve(); await p.repliesEntered.promise; p.repliesRelease.resolve(); const result = await reading;
      expect(result.assets.map(row => row.id)).toEqual([selected]); expect(result.total_assets).toBe(205);
      expect(result.sphere_placements).toEqual(expected); expect(chunks).toBe(2);
      expect(individual.mock.calls.map(([ref]) => ref)).toEqual(ordered.slice(1).map(id => ({ collection: 'asset', id })));
      expect(result.sphere_placements[0]).toMatchObject({ sphere: 'personal', pinned: false });
      expect(result.sphere_placements[1]).toMatchObject({ sphere: 'professional', pinned: true });
    } finally { p.destinationsRelease.resolve(); p.repliesRelease.resolve(); await reading; }
  });

  it('keeps notice references when their assets disappear during delivery and resolves retained pins', async () => {
    const f = fixture(); f.put('displayed'); f.notice('vanish-b', 1); f.notice('vanish-c', 2); const p = f.pause();
    const reading = f.service.snapshot({ search: 'Fixture displayed' });
    try {
      await p.destinationsEntered.promise; f.work.deleteAsset('vanish-b'); f.work.deleteAsset('vanish-c');
      f.spheres.setItem({ collection: 'asset', id: 'vanish-b' }, 'professional');
      p.destinationsRelease.resolve(); await p.repliesEntered.promise; p.repliesRelease.resolve(); const first = await reading;
      expect(first.assets.map(row => row.id)).toEqual(['displayed']); expect(first.occurrences).toHaveLength(2);
      expect(first.sphere_placements).toEqual([
        { ref: { collection: 'asset', id: 'displayed' }, reason: 'unsorted', pinned: false, source: 'work:recued.asset' },
        { ref: { collection: 'asset', id: 'vanish-b' }, sphere: 'professional', reason: 'placed by you', pinned: true },
        { ref: { collection: 'asset', id: 'vanish-c' }, reason: 'unsorted', pinned: false },
      ]);
      const next = await f.service.snapshot({ search: 'Fixture displayed' }); expect(next.occurrences).toEqual([]);
      expect(next.sphere_placements).toEqual(first.sphere_placements.slice(0, 1));
      expect(first.sphere_placements[1]?.sphere).toBe('professional');
    } finally { p.destinationsRelease.resolve(); p.repliesRelease.resolve(); await reading; }
  });

  it('preserves individual resolution errors when an ancestor becomes unreadable during delivery', async () => {
    const f = fixture(); f.put('parent', { sphere: 'personal' }); f.put('child', { belongs_to: 'parent' }); const p = f.pause();
    const reading = f.service.snapshot({ search: 'Fixture child' });
    try {
      await p.destinationsEntered.promise; f.db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run('{', 'parent');
      p.destinationsRelease.resolve(); await expect(reading).rejects.toBeInstanceOf(SyntaxError);
    } finally { p.destinationsRelease.resolve(); p.repliesRelease.resolve(); await reading.catch(() => {}); }
  });

  it('does no asset placement work when no asset references are returned', async () => {
    const f = fixture(); f.put('a'); const batch = vi.spyOn(f.spheres, 'resolveAssets');
    const read = await f.measure(() => f.service.snapshot({ search: 'no-fixture-match' }));
    expect(read.value.assets).toEqual([]); expect(read.value.sphere_placements).toEqual([]); expect(batch).not.toHaveBeenCalled();
    expect(pointPins(read.sql)).toEqual([]); expect(read.sql.filter(pinBatchSql)).toEqual([]);
  });
});
