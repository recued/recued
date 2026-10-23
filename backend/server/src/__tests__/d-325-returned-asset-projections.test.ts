import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetCreateInput, AssetRule } from '@recued/contracts';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel, type NotificationSettings, type PendingAsk } from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';

const at = Date.parse('2026-10-17T12:00Z');
const base = { source_id: 'recued.asset', source: { kind: 'owner' as const, ref: 'fixture-owner' } };
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
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => at, timeZone: () => 'UTC' });
  const service = createYoursService({ db, work, dispatchers, occurrences, situations: createSituationStore(db), now: () => at, timeZone: () => 'UTC' });
  disposals.push(async () => { await service.stop(); db.close(); });
  const put = (id: string, patch: Partial<AssetCreateInput> = {}, time = at) => work.writeAsset({ ...base, id, name: `Fixture ${id}`, ...patch }, time);
  const seed = (count: number, missing = false) => {
    put('parent', { name: 'Ancestor', sphere: 'personal', audience: 'household', anchors: [{ kind: 'place', name: 'Home' }], exact_address: 'Fixture address' }, at - 1);
    const ids = Array.from({ length: count }, (_, n) => `asset-${String(n).padStart(4, '0')}`);
    db.transaction(() => { for (const [index, id] of ids.entries()) put(id, { belongs_to: 'parent', ...(missing ? { rules: [rule], dates: { review_on: null } } : {}) }, at + index); })();
    return ids.reverse();
  };
  const pause = () => {
    const entered = gate(); const release = gate();
    const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
      channels: [createUiChannel({ busSink: () => {} })] });
    service.bind({ ...block, async getReminderDestinations() { entered.resolve(); await release.promise; return { destinations: [], issues: [] }; } });
    return { entered, release };
  };
  return { db, work, service, put, seed, pause };
};
const ancestrySql = (sql: string) => /^WITH RECURSIVE ancestry\b/u.test(sql);

describe('batched returned asset projections', () => {
  it('projects a 200-asset ordinary page with full inherited facts and isolated outputs', async () => {
    const f = fixture(); const ids = f.seed(241).slice(31, 231);
    const expected = ids.map(id => f.work.readAssetEffective(id)!);
    const batch = vi.spyOn(f.work, 'readAssetsEffective'); const point = vi.spyOn(f.work, 'readAssetEffective');
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE'); batch.mockClear(); point.mockClear();
      const result = await f.service.snapshot({ search: 'Fixture asset-', limit: 200, offset: 31 });
      expect(result.total_assets).toBe(241); expect(result.assets).toEqual(expected);
      expect(batch.mock.calls.map(([keys]) => keys)).toEqual([ids, ids]); expect(point).not.toHaveBeenCalled();
      Object.assign(result.assets[0]!.anchors[0]!, { name: 'Changed output' });
      expect(result.assets[1]!.anchors).toEqual(expected[1]!.anchors); expect(f.work.readAsset('parent')!.anchors).toEqual([{ kind: 'place', name: 'Home' }]);
    }
  });

  it('batches only the selected missing-fact rows across a scan boundary', async () => {
    const f = fixture(); const ids = f.seed(441, true).slice(197, 210);
    const expected = ids.map(id => f.work.readAssetEffective(id)!);
    const batch = vi.spyOn(f.work, 'readAssetsEffective'); const point = vi.spyOn(f.work, 'readAssetEffective');
    const result = await f.service.snapshot({ search: 'Fixture asset-', asset_filter: 'missing_facts', limit: 13, offset: 197, include_asset_summaries: true });
    expect(result.total_assets).toBe(441); expect(result.assets).toEqual(expected);
    expect(result.asset_summaries?.map(row => row.asset_id)).toEqual(ids); expect(result.asset_filter).toEqual({ kind: 'missing_facts', unavailable: 0 });
    expect(batch.mock.calls.map(([keys]) => keys)).toEqual([ids.slice(0, 3), ids.slice(3), ids]); expect(point).not.toHaveBeenCalled();
  });

  it('retains inherited sphere selection, page summaries and placement metadata', async () => {
    const f = fixture(); const ids = f.seed(441).slice(197, 210);
    const expected = ids.map(id => f.work.readAssetEffective(id)!); const point = vi.spyOn(f.work, 'readAssetEffective');
    const result = await f.service.snapshot({ search: 'Fixture asset-', asset_sphere: 'personal', limit: 13, offset: 197, include_asset_summaries: true });
    expect(result.total_assets).toBe(441); expect(result.assets).toEqual(expected); expect(result.asset_summaries?.map(row => row.asset_id)).toEqual(ids);
    expect(result.sphere_placements).toEqual(ids.map(id => ({ ref: { collection: 'asset', id }, sphere: 'personal', reason: 'from: source or relationship', pinned: false, source: 'work:recued.asset' })));
    expect(point).not.toHaveBeenCalled();
  });

  for (const filtered of [false, true]) for (const failure of ['prepare', 'execution'] as const) {
    it(`keeps individual projection fallback for ${filtered ? 'filtered' : 'ordinary'} pages after a batch ${failure} failure`, async () => {
      const f = fixture(); const ids = f.seed(3, true); const expected = ids.map(id => f.work.readAssetEffective(id)!);
      const prepare = f.db.prepare.bind(f.db); let failed = false;
      vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
        if (!failed && ancestrySql(sql)) {
          failed = true;
          if (failure === 'prepare') throw new Error('Fixture projection prepare failure');
          const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementation(() => { throw new Error('Fixture projection execution failure'); }); return statement;
        }
        return prepare(sql);
      });
      const point = vi.spyOn(f.work, 'readAssetEffective');
      const result = await f.service.snapshot({ search: 'Fixture asset-', ...(filtered ? { asset_filter: 'missing_facts' as const } : {}), include_asset_summaries: true });
      expect(failed).toBe(true); expect(result.assets).toEqual(expected); expect(result.total_assets).toBe(3);
      expect(result.asset_summaries?.map(row => row.asset_id)).toEqual(ids); expect(point.mock.calls.map(([id]) => id)).toEqual(ids);
    });
  }

  it('retains an earlier selected page when a later native projection batch fails', async () => {
    const f = fixture(); const ids = f.seed(441, true).slice(197, 210);
    const expected = ids.map(id => f.work.readAssetEffective(id)!);
    const prepare = f.db.prepare.bind(f.db); let batches = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (ancestrySql(sql) && ++batches === 2) vi.spyOn(statement, 'all').mockImplementation(() => { throw new Error('Fixture later projection execution failure'); });
      return statement;
    });
    const point = vi.spyOn(f.work, 'readAssetEffective');
    const result = await f.service.snapshot({ search: 'Fixture asset-', asset_filter: 'missing_facts', limit: 13, offset: 197, include_asset_summaries: true });
    expect(result.assets).toEqual(expected); expect(result.total_assets).toBe(441);
    expect(result.asset_summaries?.map(row => row.asset_id)).toEqual(ids);
    expect(point.mock.calls.map(([id]) => id)).toEqual(ids.slice(3)); expect(batches).toBe(3);
  });

  it('backfills across a scan boundary when the first selected group no longer resolves', async () => {
    const f = fixture(); const ids = f.seed(441, true); const missing = new Set(ids.slice(197, 200));
    const expected = ids.slice(200, 203).map(id => f.work.readAssetEffective(id)!);
    const readBatch = f.work.readAssetsEffective; const readPoint = f.work.readAssetEffective;
    vi.spyOn(f.work, 'readAssetsEffective').mockImplementationOnce(keys => { const result = readBatch(keys); for (const id of missing) result.delete(id); return result; });
    const point = vi.spyOn(f.work, 'readAssetEffective').mockImplementation((id, canReadParent) => missing.has(id) ? null : readPoint(id, canReadParent));
    const result = await f.service.snapshot({ search: 'Fixture asset-', asset_filter: 'missing_facts', limit: 3, offset: 197, include_asset_summaries: true });
    expect(result.assets).toEqual(expected); expect(result.total_assets).toBe(441);
    expect(result.asset_summaries?.map(row => row.asset_id)).toEqual(expected.map(row => row.id));
    expect(point.mock.calls.map(([id]) => id)).toEqual([...missing]);
    expect(result.sphere_placements.map(row => row.ref.id)).toEqual(expected.map(row => row.id));
  });

  it('backfills a missing filtered projection without changing the match count or skipping the next row', async () => {
    const f = fixture(); const ids = f.seed(6, true); const missing = ids[1]!;
    const expected = [ids[0]!, ids[2]!, ids[3]!].map(id => f.work.readAssetEffective(id)!);
    const readBatch = f.work.readAssetsEffective; const readPoint = f.work.readAssetEffective;
    vi.spyOn(f.work, 'readAssetsEffective').mockImplementationOnce(keys => { const result = readBatch(keys); result.delete(missing); return result; });
    const point = vi.spyOn(f.work, 'readAssetEffective').mockImplementation((id, canReadParent) => id === missing ? null : readPoint(id, canReadParent));
    const result = await f.service.snapshot({ search: 'Fixture asset-', asset_filter: 'missing_facts', limit: 3, include_asset_summaries: true });
    expect(result.assets).toEqual(expected); expect(result.total_assets).toBe(6); expect(result.asset_summaries?.map(row => row.asset_id)).toEqual(expected.map(row => row.id));
    expect(point.mock.calls.map(([id]) => id)).toEqual([missing]);
  });

  it('preserves the individual error if an ancestor cannot be decoded by either reader', async () => {
    const f = fixture(); f.seed(1); const readBatch = f.work.readAssetsEffective;
    vi.spyOn(f.work, 'readAssetsEffective').mockImplementationOnce(keys => { f.db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run('{', 'parent'); return readBatch(keys); });
    const point = vi.spyOn(f.work, 'readAssetEffective');
    await expect(f.service.snapshot({ search: 'Fixture asset-' })).rejects.toBeInstanceOf(SyntaxError);
    expect(point.mock.calls.map(([id]) => id)).toEqual(['asset-0000']);
  });

  it('keeps missing, deleted and cyclic ancestors consistent with the individual projection', async () => {
    const f = fixture(); f.put('ancestor', { name: 'Ancestor', sphere: 'personal' });
    f.put('deleted', { name: 'Deleted ancestor', belongs_to: 'ancestor' }); f.put('child', { belongs_to: 'deleted' });
    f.db.prepare('UPDATE data_asset SET deleted_at=1 WHERE id=?').run('deleted');
    f.put('orphan'); f.db.prepare('UPDATE data_asset SET belongs_to=? WHERE id=?').run('absent', 'orphan');
    f.put('cycle-a', { sphere_override: 'professional' }); f.put('cycle-b');
    f.db.prepare('UPDATE data_asset SET belongs_to=? WHERE id=?').run('cycle-a', 'cycle-b'); f.db.prepare('UPDATE data_asset SET belongs_to=? WHERE id=?').run('cycle-b', 'cycle-a');
    const expected = f.work.listAssets({ search: 'Fixture' }).map(row => f.work.readAssetEffective(row.id)!);
    const result = await f.service.snapshot({ search: 'Fixture' }); expect(result.assets).toEqual(expected);
    expect(result.assets.find(row => row.id === 'child')?.sphere).toBeUndefined(); expect(result.assets.find(row => row.id === 'cycle-b')?.sphere).toBe('professional');
  });

  it('keeps selected facts stable across delivery awaits and reads parent updates on the next snapshot', async () => {
    const f = fixture(); f.seed(2); const before = f.work.readAssetEffective('asset-0001')!; const p = f.pause();
    const reading = f.service.snapshot({ search: 'Fixture asset-', limit: 1 });
    try {
      await p.entered.promise;
      f.put('parent', { name: 'Ancestor', sphere: 'professional', anchors: [{ kind: 'place', name: 'Office' }], exact_address: 'New fixture address' });
      p.release.resolve(); const first = await reading;
      expect(first.assets).toEqual([before]); expect(first.sphere_placements[0]?.sphere).toBe('professional');
      const next = await f.service.snapshot({ search: 'Fixture asset-', limit: 1 });
      expect(next.assets).toEqual([f.work.readAssetEffective('asset-0001')]); expect(next.assets[0]?.sphere).toBe('professional');
      expect(first.assets).toEqual([before]);
    } finally { p.release.resolve(); await reading; }
  });

  it('retains sphere-selected facts and placements when their parent moves during delivery', async () => {
    const f = fixture(); f.seed(2); const before = f.work.readAssetEffective('asset-0001')!; const p = f.pause();
    const reading = f.service.snapshot({ search: 'Fixture asset-', asset_sphere: 'personal', limit: 1, include_asset_summaries: true });
    try {
      await p.entered.promise;
      f.put('parent', { name: 'Ancestor', sphere: 'professional', anchors: [{ kind: 'place', name: 'Office' }], exact_address: 'New fixture address' });
      p.release.resolve(); const first = await reading;
      expect(first.total_assets).toBe(2); expect(first.assets).toEqual([before]);
      expect(first.asset_summaries?.map(row => row.asset_id)).toEqual(['asset-0001']);
      expect(first.sphere_placements).toEqual([{ ref: { collection: 'asset', id: 'asset-0001' }, sphere: 'personal', reason: 'from: source or relationship', pinned: false, source: 'work:recued.asset' }]);
      const next = await f.service.snapshot({ search: 'Fixture asset-', asset_sphere: 'personal', limit: 1, include_asset_summaries: true });
      expect(next.total_assets).toBe(0); expect(next.assets).toEqual([]); expect(next.asset_summaries).toEqual([]); expect(next.sphere_placements).toEqual([]);
      expect(first.assets).toEqual([before]); expect(first.sphere_placements[0]?.sphere).toBe('personal');
    } finally { p.release.resolve(); await reading; }
  });

  it('keeps a detail read on its existing point projection', async () => {
    const f = fixture(); f.put('detail'); const expected = f.work.readAssetEffective('detail')!;
    const batch = vi.spyOn(f.work, 'readAssetsEffective'); const point = vi.spyOn(f.work, 'readAssetEffective');
    expect((await f.service.snapshot({ asset_id: 'detail' })).assets).toEqual([expected]);
    expect(point).toHaveBeenCalledExactlyOnceWith('detail'); expect(batch.mock.calls.map(([keys]) => keys)).toEqual([['detail']]);
  });

  it('does no projection work for empty ordinary and filtered pages', async () => {
    const f = fixture(); f.seed(1, true); const batch = vi.spyOn(f.work, 'readAssetsEffective'); const point = vi.spyOn(f.work, 'readAssetEffective');
    for (const asset_filter of [undefined, 'missing_facts'] as const) {
      expect((await f.service.snapshot({ search: 'no-matching-fixture', ...(asset_filter ? { asset_filter } : {}) })).assets).toEqual([]);
    }
    expect(batch).not.toHaveBeenCalled(); expect(point).not.toHaveBeenCalled();
  });
});
