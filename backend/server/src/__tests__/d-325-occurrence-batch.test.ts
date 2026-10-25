import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetCreateInput, AssetRule, YoursReadRequest } from '@recued/contracts';
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
import { summarizeYoursAsset } from '../situations/asset-summary.js';

const at = Date.parse('2026-10-17T12:00Z');
const base = { source_id: 'recued.asset', source: { kind: 'owner' as const, ref: 'fixture-owner' } };
const rule: AssetRule = { id: 'review', title: 'Review', enabled: true, muted: true, pinned: false, consequence: 'routine', expiry_policy: 'escalate_overdue',
  when: { kind: 'expiry', field: 'review_on' }, reaction: { notify: false, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true } };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
const gate = () => {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const fixture = () => {
  let measured: string[] | undefined;
  const db = new Database(':memory:', { verbose(sql) { if (measured) { if (typeof sql !== 'string') throw new Error('Missing SQL trace'); measured.push(sql); } } });
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const rows = createAssetOccurrenceStore(db); const spheres = createSphereStore(db, work);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => at, timeZone: () => 'UTC' });
  const service = createYoursService({ db, work, dispatchers, occurrences, spheres, situations: createSituationStore(db), now: () => at, timeZone: () => 'UTC' });
  disposals.push(async () => { await service.stop(); db.close(); });
  const put = (id: string, patch: Partial<AssetCreateInput> = {}, time = at) => work.writeAsset({ ...base, id, name: `Fixture ${id}`, ...patch }, time);
  const receipt = (asset_id: string, id: string, patch: Partial<Parameters<typeof rows.ensure>[0]> = {}) => rows.ensure({
    id, asset_id, rule_id: 'review', cycle: id, commitment_id: null, question: false, trigger_kind: 'rule', created_at: at, ...patch,
  });
  const measure = async <T>(read: () => T | Promise<T>) => {
    const sql: string[] = []; measured = sql;
    try { return { value: await read(), sql }; } finally { measured = undefined; }
  };
  const pause = () => {
    const entered = gate(); const release = gate();
    const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
      channels: [createUiChannel({ busSink: () => {} })] });
    service.bind({ ...block, async getReminderDestinations() { entered.resolve(); await release.promise; return { destinations: [], issues: [] }; } });
    return { entered, release };
  };
  return { db, work, rows, spheres, dispatchers, occurrences, service, put, receipt, measure, pause };
};
const occurrenceReads = (sql: string[]) => sql.filter(statement => /FROM asset_occurrences WHERE subject_kind='asset' AND asset_id\s*(?:=|IN\s*\()/u.test(statement));
const listSql = (sql: string) => sql === 'SELECT * FROM asset_occurrences ORDER BY created_at,id';
const batchSql = (sql: string) => /FROM asset_occurrences WHERE subject_kind='asset' AND asset_id IN\s*\(/u.test(sql);
const summaryModes: Array<{ name: string; request: YoursReadRequest }> = [
  { name: 'attention', request: { asset_filter: 'missing_facts', include_asset_summaries: true } },
  { name: 'ordinary', request: { include_asset_summaries: true } },
  { name: 'sphere', request: { asset_sphere: 'personal', include_asset_summaries: true } },
];

describe('bounded asset occurrence reads', () => {
  it('omits the unused retirement scan from list snapshots and preserves displayed receipts', async () => {
    const f = fixture(); f.put('a', { sphere: 'personal', dates: { review_on: null }, rules: [rule] });
    for (const [id, asset_id, subject_kind] of [['asset-task', 'a', 'asset'], ['occasion-task', 'birthday', 'occasion']] as const) {
      f.work.writeCommitment({ id: `task:${id}`, source_id: 'recued.commitment', direction: 'outbound', statement: id,
        derivation: 'user_declared', lifecycle_state: 'pending', promised_for_at: at }, at);
      f.receipt(asset_id, id, { commitment_id: `task:${id}`, subject_kind });
    }
    const requests: YoursReadRequest[] = [{}, { include_asset_summaries: true },
      { asset_sphere: 'personal', include_asset_summaries: true }, { asset_filter: 'missing_facts' },
      { occasion_id: 'birthday' }, { search: 'no-matching-asset' }, { offset: 999 }];
    for (const request of requests) for (let round = 0; round < 2; round++) {
      const read = await f.measure(() => f.service.snapshot(request));
      expect(read.value).not.toHaveProperty('retirement_impact');
      expect(read.value.occurrences.map(row => row.id)).toEqual(request.occasion_id ? ['occasion-task'] : ['asset-task', 'occasion-task']);
      expect(read.sql.filter(listSql)).toHaveLength(2);
    }
  });

  it('matches individual DTOs and order across batches, aliases, query statistics, absent and quoted ids', async () => {
    const f = fixture(); const ids = Array.from({ length: 1001 }, (_, index) => `asset-${index}`);
    ids.push("asset-'quoted?", 'asset-漢');
    f.db.transaction(() => {
      for (const [index, id] of ids.entries()) {
        // Equal creation times and reverse insertion distinguish the id tie break.
        for (const suffix of ['a', 'z', 'm']) f.receipt(id, `${id}:${suffix}`, { created_at: at + (suffix === 'm' ? 1 : 0),
          question: index % 2 === 0, commitment_id: suffix === 'z' ? `task:${id}` : null });
        f.receipt(id, `${id}:occasion`, { subject_kind: 'occasion' });
      }
    })();
    const keys = [...ids, 'absent', 'another-absent', ids[0]!];
    for (const analyze of [false, true]) {
      if (analyze) f.db.exec('ANALYZE');
      const expected = new Map([...new Set(keys)].map(id => [id, f.rows.byAsset(id)]));
      const batch = await f.measure(() => f.rows.byAssets(keys));
      expect(batch.value).toEqual(expected); expect([...batch.value.keys()]).toEqual([...new Set(keys)]);
      expect(batch.value.get(ids[0]!)?.map(row => row.id)).toEqual(['asset-0:m', 'asset-0:z', 'asset-0:a']);
      expect(batch.value.get('absent')).not.toBe(batch.value.get('another-absent'));
      expect(occurrenceReads(batch.sql)).toHaveLength(6); expect(batch.sql.every(batchSql)).toBe(true);
      expect(batch.value.get(ids[0]!)?.every(row => row.subject_kind === undefined && !Object.hasOwn(row, 'reaction_kind'))).toBe(true);
    }
    const empty = await f.measure(() => f.rows.byAssets([])); expect(empty.value.size).toBe(0); expect(empty.sql).toEqual([]);
  });

  it('returns independent rows and reads additions, edits and removals on the next call', () => {
    const f = fixture(); f.receipt('a', 'old-a'); f.receipt('b', 'old-b');
    const first = f.rows.byAssets(['a', 'b', 'absent']);
    first.get('a')![0]!.question = true; first.get('absent')!.push(first.get('a')![0]!);
    expect(f.rows.byAsset('a')[0]?.question).toBe(false); expect(first.get('b')?.[0]?.question).toBe(false);
    f.rows.remove('old-a'); f.receipt('a', 'new-a', { created_at: at + 1 });
    f.db.prepare('UPDATE asset_occurrences SET question=1,close_processed_at=?,rearmed_at=? WHERE id=?').run(at, at + 1, 'old-b');
    const next = f.rows.byAssets(['a', 'b', 'absent']);
    for (const id of next.keys()) expect(next.get(id)).toEqual(f.rows.byAsset(id));
    expect(next.get('b')?.[0]).toMatchObject({ question: true, close_processed_at: at, rearmed_at: at + 1 });
    expect(next.get('absent')).toEqual([]); expect(first.get('a')?.[0]?.id).toBe('old-a');
  });

  it('reuses the required occurrence list for every summary candidate in a large library with no receipts', async () => {
    const f = fixture(); const ids: string[] = [];
    f.db.transaction(() => {
      for (let index = 0; index < 600; index++) ids.unshift(f.put(`asset-${String(index).padStart(4, '0')}`, { dates: { review_on: null }, rules: [rule] }, at + index).id);
    })();
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', include_asset_summaries: true, offset: 211, limit: 5 }));
    expect(read.value.total_assets).toBe(600); expect(read.value.assets.map(asset => asset.id)).toEqual(ids.slice(211, 216));
    expect(read.value.asset_summaries).toEqual(ids.slice(211, 216).map(asset_id => ({ asset_id, open_tasks: 0, active_rules: 1, next_due: null,
      missing: [{ path: 'dates.review_on', reason: 'unknown' }] })));
    expect(read.value.asset_filter).toEqual({ kind: 'missing_facts', unavailable: 0 });
    expect(occurrenceReads(read.sql)).toEqual([]); expect(read.sql.filter(listSql)).toHaveLength(2);
  });

  it('reuses receipts for attention candidates and keeps sphere-only summaries on the returned page', async () => {
    const f = fixture(); const personal: string[] = [];
    f.db.transaction(() => {
      for (let index = 0; index < 401; index++) {
        const id = `asset-${String(index).padStart(4, '0')}`; const sphere = index % 3 === 1 ? 'personal' as const : 'professional' as const;
        f.put(id, { sphere, dates: { review_on: null }, rules: [rule] }, at + index); if (sphere === 'personal') personal.unshift(id);
      }
    })();
    const read = await f.measure(() => f.service.snapshot({ asset_sphere: 'personal', asset_filter: 'missing_facts', search: 'Fixture', offset: 2, limit: 5 }));
    expect(read.value.total_assets).toBe(personal.length); expect(read.value.assets.map(asset => asset.id)).toEqual(personal.slice(2, 7));
    expect(occurrenceReads(read.sql)).toEqual([]); expect(read.sql.filter(listSql)).toHaveLength(2);
    const page = await f.measure(() => f.service.snapshot({ asset_sphere: 'personal', include_asset_summaries: true, offset: 2, limit: 5 }));
    expect(page.value.assets.map(asset => asset.id)).toEqual(personal.slice(2, 7));
    expect(occurrenceReads(page.sql)).toEqual([]); expect(page.sql.filter(listSql)).toHaveLength(2);
    const empty = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', search: 'no-fixture-match' }));
    expect(empty.value.total_assets).toBe(0); expect(occurrenceReads(empty.sql)).toEqual([]);
  });

  it('reuses receipts for ordinary, sphere and detail summaries while preserving full page DTOs and empty results', async () => {
    const f = fixture(); const ids: string[] = []; const personal: string[] = [];
    f.db.transaction(() => {
      for (let index = 0; index < 601; index++) {
        const id = index === 120 ? "asset-'漢?" : `asset-${String(index).padStart(4, '0')}`;
        const sphere = index % 3 === 0 ? 'personal' : 'professional';
        f.put(id, { sphere, dates: { review_on: index % 5 === 0 ? null : '2026-10-16' }, rules: [rule],
          status: index % 17 === 0 ? 'retired' : index % 7 === 0 ? 'lent' : 'active' }, at + index);
        ids.unshift(id); if (sphere === 'personal') personal.unshift(id);
        if (index % 41 !== 0) continue;
        for (const suffix of ['a', 'z']) {
          const commitment_id = `task:${id}:${suffix}`;
          f.work.writeCommitment({ id: commitment_id, source_id: 'recued.commitment', direction: 'outbound', statement: 'Review',
            derivation: 'user_declared', lifecycle_state: suffix === 'z' ? 'pending' : 'fulfilled', promised_for_at: at - 86400000 }, at);
          f.receipt(id, `occ:${id}:${suffix}`, { commitment_id, created_at: at + index });
        }
        f.receipt(id, `occ:${id}:occasion`, { subject_kind: 'occasion' });
      }
    })();
    const cases: Array<{ request: YoursReadRequest; page: string[]; total: number }> = [
      { request: { include_asset_summaries: true, offset: 197, limit: 50 }, page: ids.slice(197, 247), total: ids.length },
      { request: { asset_sphere: 'personal', include_asset_summaries: true, offset: 197, limit: 50 }, page: personal.slice(197), total: personal.length },
      { request: { asset_id: ids[199]!, include_asset_summaries: true }, page: [ids[199]!], total: ids.length },
      { request: { search: 'no-fixture-match', include_asset_summaries: true }, page: [], total: 0 },
    ];
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE');
      for (const { request, page, total } of cases) {
        const expected = page.map(id => f.work.readAssetEffective(id)!);
        const summaries = expected.map(asset => summarizeYoursAsset(asset, { work: f.work, occurrences: f.rows.byAsset(asset.id), now: at, timeZone: 'UTC' }));
        const read = await f.measure(() => f.service.snapshot(request));
        expect(read.value.assets).toEqual(expected); expect(read.value.total_assets).toBe(total); expect(read.value.asset_summaries).toEqual(summaries);
        expect(occurrenceReads(read.sql)).toEqual([]); expect(read.sql.filter(listSql)).toHaveLength(request.asset_id ? 3 : 2);
      }
    }
  });

  for (const sphere of [undefined, 'personal'] as const) for (const phase of ['prepare', 'execution'] as const) {
    it(`retains guarded page summaries after a shared ${phase} failure with sphere ${sphere ?? 'all'}`, async () => {
      const f = fixture(); f.put('good', { sphere: 'personal', dates: { review_on: null }, rules: [rule] });
      f.put('bad', { sphere: 'personal', dates: { review_on: '9999-12-31' }, rules: [{ ...rule, when: { kind: 'interval', field: 'review_on', every: { amount: 1, unit: 'days' } } }] });
      const prepare = f.db.prepare.bind(f.db); let lists = 0;
      vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
        if (listSql(sql) && ++lists === 2) {
          if (phase === 'prepare') throw new Error('Fixture page shared prepare failure');
          const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementationOnce(() => { throw new Error('Fixture page shared execution failure'); }); return statement;
        }
        return prepare(sql);
      });
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const read = await f.measure(() => f.service.snapshot({ include_asset_summaries: true, ...(sphere ? { asset_sphere: sphere } : {}) }));
      expect(read.value.assets).toHaveLength(2); expect(read.value.total_assets).toBe(2);
      expect(read.value.asset_summaries?.map(summary => summary.asset_id)).toEqual(['good']); expect(read.value.asset_filter).toBeUndefined();
      expect(lists).toBe(3); expect(occurrenceReads(read.sql)).toHaveLength(2); expect(occurrenceReads(read.sql).some(batchSql)).toBe(false);
      expect(warning).toHaveBeenCalledTimes(1);
    });
  }

  for (const phase of ['prepare', 'execution'] as const) it(`isolates a selected receipt ${phase} failure after the shared page read fails`, async () => {
    const f = fixture();
    for (const id of ['bad', 'good']) f.put(id, { sphere: 'personal', dates: { review_on: null }, rules: [rule] });
    const prepare = f.db.prepare.bind(f.db); let lists = 0; let points = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (listSql(sql) && ++lists === 2) throw new Error('Fixture shared page read failure');
      if (/FROM asset_occurrences WHERE subject_kind='asset' AND asset_id=\?/u.test(sql) && ++points === 1) {
        if (phase === 'prepare') throw new Error('Fixture selected receipt prepare failure');
        const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementationOnce(() => { throw new Error('Fixture selected receipt execution failure'); }); return statement;
      }
      return prepare(sql);
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests: YoursReadRequest[] = [{ include_asset_summaries: true },
      { asset_sphere: 'personal', include_asset_summaries: true }, { asset_id: 'bad', include_asset_summaries: true }];
    for (const request of requests) {
      lists = 0; points = 0; warning.mockClear();
      const result = await f.service.snapshot(request);
      expect(result.assets.map(asset => asset.id)).toEqual(request.asset_id ? ['bad'] : ['bad', 'good']);
      expect(result.asset_summaries?.map(summary => summary.asset_id)).toEqual(request.asset_id ? [] : ['good']);
      expect(result.total_assets).toBe(2); expect(result.asset_filter).toBeUndefined();
      expect(lists).toBe(request.asset_id ? 4 : 3); expect(points).toBe(request.asset_id ? 1 : 2); expect(warning).toHaveBeenCalledTimes(1);
    }
  });

  it('preserves complete summaries and canonical task edits across successive filtered snapshots', async () => {
    const f = fixture();
    for (const id of ['a', 'b', 'c']) { f.put(id, { dates: { review_on: '2026-10-16' }, rules: [rule] }); await f.occurrences.reconcileAsset(id); }
    f.receipt('a', 'occasion-a', { subject_kind: 'occasion' });
    const expected = () => f.work.listAssets().map(asset => summarizeYoursAsset(asset, { work: f.work, occurrences: f.rows.byAsset(asset.id), now: at, timeZone: 'UTC' }))
      .filter(summary => summary.next_due?.state === 'overdue');
    const first = await f.measure(() => f.service.snapshot({ asset_filter: 'overdue', include_asset_summaries: true }));
    expect(first.value.asset_summaries).toEqual(expected()); expect(first.value.total_assets).toBe(3);
    expect(occurrenceReads(first.sql)).toEqual([]);
    await f.dispatchers.commitmentUpdate({ id: f.rows.byAsset('a')[0]!.commitment_id!, promised_for_at: Date.parse('2026-10-22') });
    await f.dispatchers.commitmentFulfill({ id: f.rows.byAsset('b')[0]!.commitment_id! });
    const second = await f.measure(() => f.service.snapshot({ asset_filter: 'overdue', include_asset_summaries: true }));
    expect(second.value.assets.map(asset => asset.id)).toEqual(['c']); expect(second.value.asset_summaries).toEqual(expected());
    expect(occurrenceReads(second.sql)).toEqual([]); expect(first.value.asset_summaries).toHaveLength(3);
  });

  for (const mode of summaryModes) it(`reads receipt changes after refresh and keeps no cache for ${mode.name} summaries`, async () => {
    const f = fixture(); f.put('a', { sphere: 'personal', dates: { review_on: '2026-10-16' }, rules: [rule] });
    const request = { ...mode.request, ...(mode.request.asset_filter ? { asset_filter: 'overdue' as const } : {}) };
    await f.occurrences.reconcileAsset('a');
    const original = f.rows.byAsset('a')[0]!;
    await f.dispatchers.commitmentUpdate({ id: original.commitment_id!, promised_for_at: Date.parse('2026-10-22') });
    f.rows.remove(original.id);
    const first = f.service.snapshot(request);
    // snapshot has yielded at refreshEvidence; summary selection follows it.
    f.receipt('a', original.id, { rule_id: original.rule_id, cycle: original.cycle, commitment_id: original.commitment_id });
    const before = await first;
    if (request.asset_filter) expect(before.assets).toEqual([]);
    else expect(before.asset_summaries?.[0]).toMatchObject({ open_tasks: 1, next_due: { on: '2026-10-22', state: 'upcoming' } });
    const second = f.service.snapshot(request);
    f.rows.remove(original.id);
    const changed = await second;
    expect(changed.assets.map(asset => asset.id)).toEqual(['a']);
    expect(changed.asset_summaries?.[0]).toMatchObject({ open_tasks: 0, next_due: { on: '2026-10-16', state: 'overdue' } });
  });

  it('preserves SQL receipt tie ordering in summaries without reversing the displayed occurrence list', async () => {
    const f = fixture(); const asset = f.put("asset-'漢?", { sphere: 'personal', dates: { review_on: null }, rules: [rule] });
    for (const suffix of ['a', 'A', '漢', '😀', '\ue000']) {
      const id = `occ:${suffix}`; const commitment_id = `task:${suffix}`;
      f.work.writeCommitment({ id: commitment_id, source_id: 'recued.commitment', direction: 'outbound', statement: 'Review',
        derivation: 'user_declared', lifecycle_state: 'pending', promised_for_at: at - 86400000 }, at);
      f.receipt(asset.id, id, { commitment_id });
    }
    f.receipt(asset.id, 'occasion', { subject_kind: 'occasion' });
    expect(f.rows.byAsset(asset.id).map(row => row.id)).toEqual(['occ:😀', 'occ:\ue000', 'occ:漢', 'occ:a', 'occ:A']);
    const expected = summarizeYoursAsset(asset, { work: f.work, occurrences: f.rows.byAsset(asset.id), now: at, timeZone: 'UTC' });
    expect(expected.next_due?.commitment_id).toBe('task:😀'); expect(expected.open_tasks).toBe(5);
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE');
      for (const mode of summaryModes) {
        const read = await f.measure(() => f.service.snapshot(mode.request));
        expect(read.value.asset_summaries).toEqual([expected]); expect(occurrenceReads(read.sql)).toEqual([]);
        expect(read.value.occurrences.map(row => row.id)).toEqual(['occ:A', 'occ:a', 'occ:漢', 'occ:\ue000', 'occ:😀']);
        expect(read.sql.filter(listSql)).toHaveLength(2);
      }
    }
  });

  it('prioritizes receipt creation time over id and reads reordered receipts on the next snapshot', async () => {
    const f = fixture(); f.put('a', { dates: { review_on: null }, rules: [rule] });
    for (const id of ['a', 'z']) {
      f.work.writeCommitment({ id: `task:${id}`, source_id: 'recued.commitment', direction: 'outbound', statement: 'Review',
        derivation: 'user_declared', lifecycle_state: 'pending', promised_for_at: at - 86400000 }, at);
      f.receipt('a', `occ:${id}`, { commitment_id: `task:${id}`, created_at: id === 'a' ? at + 1 : at });
    }
    const first = await f.service.snapshot({ asset_filter: 'missing_facts', include_asset_summaries: true });
    expect(first.asset_summaries?.[0]?.next_due?.commitment_id).toBe('task:a');
    expect(first.occurrences.map(row => row.id)).toEqual(['occ:z', 'occ:a']);
    f.db.prepare('UPDATE asset_occurrences SET created_at=? WHERE id=?').run(at + 2, 'occ:z');
    const second = await f.service.snapshot({ asset_filter: 'missing_facts', include_asset_summaries: true });
    expect(second.asset_summaries?.[0]?.next_due?.commitment_id).toBe('task:z');
    expect(second.occurrences.map(row => row.id)).toEqual(['occ:a', 'occ:z']);
    expect(first.asset_summaries?.[0]?.next_due?.commitment_id).toBe('task:a');
  });

  for (const phase of ['prepare', 'execution'] as const) it(`propagates a persistent list ${phase} failure after the guarded summary fallback`, async () => {
    const f = fixture(); f.put('a', { sphere: 'personal', dates: { review_on: null }, rules: [rule] });
    const prepare = f.db.prepare.bind(f.db); const failure = new Error(`Fixture persistent list ${phase} failure`); let lists = 0; let batches = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (batchSql(sql)) batches++;
      if (listSql(sql) && ++lists >= 2) {
        if (phase === 'prepare') throw failure;
        const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementation(() => { throw failure; }); return statement;
      }
      return prepare(sql);
    });
    for (const mode of summaryModes) {
      lists = 0; batches = 0;
      await expect(f.service.snapshot(mode.request)).rejects.toBe(failure);
      expect(lists).toBe(3); expect(batches).toBe(mode.request.asset_filter ? 1 : 0);
    }
  });

  for (const phase of ['prepare', 'execution'] as const) it(`uses bounded summaries and retries the list after a shared ${phase} failure`, async () => {
    const f = fixture(); const asset = f.put('a', { dates: { review_on: null }, rules: [rule] });
    const expected = summarizeYoursAsset(asset, { work: f.work, occurrences: [], now: at, timeZone: 'UTC' });
    const prepare = f.db.prepare.bind(f.db); let lists = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (listSql(sql) && ++lists === 2) {
        if (phase === 'prepare') throw new Error('Fixture shared prepare failure');
        const statement = prepare(sql);
        vi.spyOn(statement, 'all').mockImplementationOnce(() => { throw new Error('Fixture shared execution failure'); }); return statement;
      }
      return prepare(sql);
    });
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', include_asset_summaries: true }));
    expect(read.value.asset_summaries).toEqual([expected]); expect(read.value.asset_filter?.unavailable).toBe(0);
    expect(lists).toBe(3); expect(occurrenceReads(read.sql)).toHaveLength(1); expect(occurrenceReads(read.sql).every(batchSql)).toBe(true);
  });

  for (const mode of summaryModes) it(`keeps ${mode.name} summaries through delivery and reads changes next time`, async () => {
    const f = fixture(); f.put('a', { sphere: 'personal', dates: { review_on: null }, rules: [rule] });
    f.receipt('a', 'before'); const p = f.pause();
    const reading = f.service.snapshot({ ...mode.request, include_closed: true });
    try {
      await p.entered.promise; f.rows.remove('before');
      const commitment_id = 'new-task';
      f.work.writeCommitment({ id: commitment_id, source_id: 'recued.commitment', direction: 'outbound', statement: 'New task',
        derivation: 'user_declared', lifecycle_state: 'pending', promised_for_at: at - 86400000 }, at);
      f.receipt('a', 'after', { commitment_id });
      p.release.resolve(); const first = await reading;
      expect(first.asset_summaries?.[0]?.open_tasks).toBe(0); expect(first.occurrences.map(row => row.id)).toEqual(['before']);
      const next = await f.service.snapshot(mode.request);
      expect(next.asset_summaries?.[0]?.open_tasks).toBe(1); expect(next.occurrences.map(row => row.id)).toEqual(['after']);
      expect(first.asset_summaries?.[0]?.open_tasks).toBe(0);
    } finally { p.release.resolve(); await reading; }
  });

  it('reads retirement receipts freshly after delivery for the selected asset and its retiring descendants', async () => {
    const f = fixture();
    f.put('a', { dates: { review_on: null }, rules: [rule] });
    f.put('part', { belongs_to: 'a', retirement: 'part' });
    f.put('nested-part', { belongs_to: 'part', retirement: 'part' });
    f.put('contract', { belongs_to: 'a', retirement: 'cancel_or_transfer' });
    f.put('contract-part', { belongs_to: 'contract', retirement: 'part' });
    f.put('unrelated'); const p = f.pause();
    const reading = f.measure(() => f.service.snapshot({ asset_id: 'a', include_asset_summaries: true }));
    try {
      await p.entered.promise;
      for (const asset_id of ['a', 'part', 'nested-part', 'contract', 'contract-part', 'unrelated']) {
        const commitment_id = `task:${asset_id}`;
        f.work.writeCommitment({ id: commitment_id, source_id: 'recued.commitment', direction: 'outbound', statement: 'New task',
          derivation: 'user_declared', lifecycle_state: 'pending' }, at);
        f.receipt(asset_id, `late:${asset_id}`, { commitment_id });
      }
      f.work.writeCommitment({ id: 'closed', source_id: 'recued.commitment', direction: 'outbound', statement: 'Closed task',
        derivation: 'user_declared', lifecycle_state: 'fulfilled' }, at);
      f.receipt('a', 'closed', { commitment_id: 'closed' }); f.receipt('part', 'notice');
      p.release.resolve(); const first = await reading;
      expect(first.value.retirement_impact).toEqual({ parts: 2, contracts: 1, open_occurrences: 3 });
      expect(first.value.occurrences).toEqual([]); expect(first.value.asset_summaries?.[0]?.open_tasks).toBe(0);
      expect(first.sql.filter(listSql)).toHaveLength(3);
      const next = await f.measure(() => f.service.snapshot({ asset_id: 'a', include_asset_summaries: true }));
      expect(next.value.asset_summaries?.[0]?.open_tasks).toBe(1);
      expect(next.value.occurrences.map(row => row.id)).toEqual(['late:a']);
      expect(next.value.retirement_impact).toEqual(first.value.retirement_impact); expect(next.sql.filter(listSql)).toHaveLength(3);
    } finally { p.release.resolve(); await reading; }
  });

  it('reads retirement closures and removals freshly after destinations load', async () => {
    const f = fixture(); f.put('a', { dates: { review_on: null }, rules: [rule] });
    f.put('part', { belongs_to: 'a', retirement: 'part' });
    for (const [id, asset_id] of [['close', 'a'], ['keep', 'a'], ['remove', 'part']] as const) {
      const commitment_id = `task:${id}`;
      f.work.writeCommitment({ id: commitment_id, source_id: 'recued.commitment', direction: 'outbound', statement: id,
        derivation: 'user_declared', lifecycle_state: 'pending', promised_for_at: at }, at);
      f.receipt(asset_id, id, { commitment_id });
    }
    const p = f.pause(); const reading = f.measure(() => f.service.snapshot({ asset_id: 'a', include_asset_summaries: true }));
    try {
      await p.entered.promise;
      f.work.writeCommitment({ id: 'task:close', source_id: 'recued.commitment', direction: 'outbound', statement: 'close',
        derivation: 'user_declared', lifecycle_state: 'fulfilled', promised_for_at: at }, at + 1);
      f.rows.remove('remove'); p.release.resolve(); const first = await reading;
      expect(first.value.asset_summaries?.[0]?.open_tasks).toBe(2);
      expect(first.value.occurrences.map(row => row.id)).toEqual(['close', 'keep']);
      expect(first.value.retirement_impact).toEqual({ parts: 1, contracts: 0, open_occurrences: 1 });
      expect(first.sql.filter(listSql)).toHaveLength(3);
      const next = await f.service.snapshot({ asset_id: 'a', include_asset_summaries: true });
      expect(next.asset_summaries?.[0]?.open_tasks).toBe(1); expect(next.occurrences.map(row => row.id)).toEqual(['keep']);
      expect(next.retirement_impact).toEqual(first.value.retirement_impact);
    } finally { p.release.resolve(); await reading; }
  });

  it('retains retirement impact when the selected asset row is missing', async () => {
    const f = fixture();
    f.work.writeCommitment({ id: 'task:missing', source_id: 'recued.commitment', direction: 'outbound', statement: 'Retained task',
      derivation: 'user_declared', lifecycle_state: 'pending' }, at);
    f.receipt('missing', 'orphan', { commitment_id: 'task:missing' });
    const read = await f.measure(() => f.service.snapshot({ asset_id: 'missing' }));
    expect(read.value.assets).toEqual([]); expect(read.value.total_assets).toBe(0);
    expect(read.value.occurrences.map(row => row.id)).toEqual(['orphan']);
    expect(read.value.retirement_impact).toEqual({ parts: 0, contracts: 0, open_occurrences: 1 });
    expect(read.sql.filter(listSql)).toHaveLength(3);
  });

  for (const phase of ['prepare', 'execution'] as const) it(`falls back on a batch ${phase} failure and retains per-asset unavailable counts`, async () => {
    const f = fixture(); f.put('good', { dates: { review_on: null }, rules: [rule] });
    f.put('unreadable', { dates: { review_on: '9999-12-31' }, rules: [{ ...rule, when: { kind: 'interval', field: 'review_on', every: { amount: 1, unit: 'days' } } }] });
    const prepare = f.db.prepare.bind(f.db); let failures = 0; let lists = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (listSql(sql) && ++lists === 2) throw new Error('Fixture shared list failure');
      if (!batchSql(sql)) return prepare(sql);
      if (phase === 'prepare') { failures++; throw new Error('Fixture batch failure'); }
      const statement = prepare(sql);
      vi.spyOn(statement, 'all').mockImplementation(() => { failures++; throw new Error('Fixture execution failure'); });
      return statement;
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', include_asset_summaries: true }));
    expect(failures).toBe(1); expect(read.value.assets.map(asset => asset.id)).toEqual(['good']);
    expect(read.value.asset_filter).toEqual({ kind: 'missing_facts', unavailable: 1 });
    expect(occurrenceReads(read.sql)).toHaveLength(2); expect(warning).toHaveBeenCalledTimes(1);
  });
});
