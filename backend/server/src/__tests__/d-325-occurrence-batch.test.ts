import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetCreateInput, AssetRule } from '@recued/contracts';
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
  return { db, work, rows, spheres, dispatchers, occurrences, service, put, receipt, measure };
};
const occurrenceReads = (sql: string[]) => sql.filter(statement => /FROM asset_occurrences WHERE subject_kind='asset' AND asset_id\s*(?:=|IN\s*\()/u.test(statement));
const batchSql = (sql: string) => /FROM asset_occurrences WHERE subject_kind='asset' AND asset_id IN\s*\(/u.test(sql);

describe('bounded asset occurrence reads', () => {
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

  it('uses one occurrence read per scan page when filtering a large library with no occurrence rows', async () => {
    const f = fixture(); const ids: string[] = [];
    f.db.transaction(() => {
      for (let index = 0; index < 600; index++) ids.unshift(f.put(`asset-${String(index).padStart(4, '0')}`, { dates: { review_on: null }, rules: [rule] }, at + index).id);
    })();
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', include_asset_summaries: true, offset: 211, limit: 5 }));
    expect(read.value.total_assets).toBe(600); expect(read.value.assets.map(asset => asset.id)).toEqual(ids.slice(211, 216));
    expect(read.value.asset_summaries).toEqual(ids.slice(211, 216).map(asset_id => ({ asset_id, open_tasks: 0, active_rules: 1, next_due: null,
      missing: [{ path: 'dates.review_on', reason: 'unknown' }] })));
    expect(read.value.asset_filter).toEqual({ kind: 'missing_facts', unavailable: 0 });
    expect(occurrenceReads(read.sql)).toHaveLength(3); expect(occurrenceReads(read.sql).every(batchSql)).toBe(true);
  });

  it('batches only sphere-matching attention candidates and keeps sphere-only summaries on the returned page', async () => {
    const f = fixture(); const personal: string[] = [];
    f.db.transaction(() => {
      for (let index = 0; index < 401; index++) {
        const id = `asset-${String(index).padStart(4, '0')}`; const sphere = index % 3 === 1 ? 'personal' as const : 'professional' as const;
        f.put(id, { sphere, dates: { review_on: null }, rules: [rule] }, at + index); if (sphere === 'personal') personal.unshift(id);
      }
    })();
    const read = await f.measure(() => f.service.snapshot({ asset_sphere: 'personal', asset_filter: 'missing_facts', search: 'Fixture', offset: 2, limit: 5 }));
    expect(read.value.total_assets).toBe(personal.length); expect(read.value.assets.map(asset => asset.id)).toEqual(personal.slice(2, 7));
    const sql = occurrenceReads(read.sql); expect(sql).toHaveLength(2); expect(sql.every(batchSql)).toBe(true);
    expect(sql.flatMap(statement => [...statement.matchAll(/'asset-\d{4}'/gu)].map(match => match[0].slice(1, -1))).sort()).toEqual([...personal].sort());
    const page = await f.measure(() => f.service.snapshot({ asset_sphere: 'personal', include_asset_summaries: true, offset: 2, limit: 5 }));
    expect(page.value.assets.map(asset => asset.id)).toEqual(personal.slice(2, 7));
    expect(occurrenceReads(page.sql)).toHaveLength(5); expect(occurrenceReads(page.sql).some(batchSql)).toBe(false);
    const empty = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', search: 'no-fixture-match' }));
    expect(empty.value.total_assets).toBe(0); expect(occurrenceReads(empty.sql)).toEqual([]);
  });

  it('preserves complete summaries and canonical task edits across successive filtered snapshots', async () => {
    const f = fixture();
    for (const id of ['a', 'b', 'c']) { f.put(id, { dates: { review_on: '2026-10-16' }, rules: [rule] }); await f.occurrences.reconcileAsset(id); }
    f.receipt('a', 'occasion-a', { subject_kind: 'occasion' });
    const expected = () => f.work.listAssets().map(asset => summarizeYoursAsset(asset, { work: f.work, occurrences: f.rows.byAsset(asset.id), now: at, timeZone: 'UTC' }))
      .filter(summary => summary.next_due?.state === 'overdue');
    const first = await f.measure(() => f.service.snapshot({ asset_filter: 'overdue', include_asset_summaries: true }));
    expect(first.value.asset_summaries).toEqual(expected()); expect(first.value.total_assets).toBe(3);
    expect(occurrenceReads(first.sql)).toHaveLength(1);
    await f.dispatchers.commitmentUpdate({ id: f.rows.byAsset('a')[0]!.commitment_id!, promised_for_at: Date.parse('2026-10-22') });
    await f.dispatchers.commitmentFulfill({ id: f.rows.byAsset('b')[0]!.commitment_id! });
    const second = await f.measure(() => f.service.snapshot({ asset_filter: 'overdue', include_asset_summaries: true }));
    expect(second.value.assets.map(asset => asset.id)).toEqual(['c']); expect(second.value.asset_summaries).toEqual(expected());
    expect(occurrenceReads(second.sql)).toHaveLength(1); expect(first.value.asset_summaries).toHaveLength(3);
  });

  it('reads receipt changes after the refresh await and keeps no receipt cache between snapshots', async () => {
    const f = fixture(); f.put('a', { dates: { review_on: '2026-10-16' }, rules: [rule] });
    await f.occurrences.reconcileAsset('a');
    const original = f.rows.byAsset('a')[0]!;
    await f.dispatchers.commitmentUpdate({ id: original.commitment_id!, promised_for_at: Date.parse('2026-10-22') });
    f.rows.remove(original.id);
    const first = f.service.snapshot({ asset_filter: 'overdue', include_asset_summaries: true });
    // snapshot has yielded at refreshEvidence; summary selection follows it.
    f.receipt('a', original.id, { rule_id: original.rule_id, cycle: original.cycle, commitment_id: original.commitment_id });
    expect((await first).assets).toEqual([]);
    const second = f.service.snapshot({ asset_filter: 'overdue', include_asset_summaries: true });
    f.rows.remove(original.id);
    const changed = await second;
    expect(changed.assets.map(asset => asset.id)).toEqual(['a']);
    expect(changed.asset_summaries?.[0]).toMatchObject({ open_tasks: 0, next_due: { on: '2026-10-16', state: 'overdue' } });
  });

  for (const phase of ['prepare', 'execution'] as const) it(`falls back on a batch ${phase} failure and retains per-asset unavailable counts`, async () => {
    const f = fixture(); f.put('good', { dates: { review_on: null }, rules: [rule] });
    f.put('unreadable', { dates: { review_on: '9999-12-31' }, rules: [{ ...rule, when: { kind: 'interval', field: 'review_on', every: { amount: 1, unit: 'days' } } }] });
    const prepare = f.db.prepare.bind(f.db); let failures = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
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
