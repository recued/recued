import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetClassPreset, ExecutionSource, ProactiveProposalInput } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createYoursService } from '../situations/yours-service.js';

const disposals: Array<() => Promise<void>> = [];
const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
const preset = (id = 'fixture_class', version = 2): AssetClassPreset => ({
  id, version, name: 'Fixture class', origin: 'owner', audience: 'owner', retirement: 'part', rules: [],
  fields: { dates: {}, readings: {}, observations: {}, settings: {} },
});
const proposalInput = (key: string): ProactiveProposalInput => ({ key, kind: 'rule', title: key, explanation: '',
  confidence: 'high', origin: 'owner', sources: [], payload: {} });
const fixture = () => {
  let measured: string[] | undefined;
  const db = new Database(':memory:', { verbose(sql) { measured?.push(String(sql)); } });
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const now = () => Date.parse('2026-10-17T12:00:00Z');
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now, timeZone: () => 'UTC' });
  const service = createYoursService({ db, work, dispatchers, occurrences, situations: createSituationStore(db), now });
  disposals.push(async () => { await service.stop(); db.close(); });
  const put = (id: string, patch: Partial<Parameters<typeof work.writeAsset>[0]> = {}) => work.writeAsset({
    source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture-owner' }, name: id, ...patch, id,
  }, now());
  const read = async () => {
    const sql: string[] = []; measured = sql;
    try { return { value: await service.snapshot({ search: 'no matching fixture asset' }), sql }; }
    finally { measured = undefined; }
  };
  const offers = () => service.proposals.list({ state: 'proposed', kind: 'rule', limit: 10000 }).filter(row => row.payload.apply_class === true);
  const measure = <T>(action: () => T) => {
    const sql: string[] = []; measured = sql;
    try { return { value: action(), sql }; } finally { measured = undefined; }
  };
  return { db, work, service, put, read, offers, measure };
};
// Evidence refresh still has its own 500-row walk. Count only the class scan.
const classReads = (sql: string[]) => sql.filter(statement => /\bFROM data_asset WHERE id\s*>[\s\S]*\bLIMIT 100(?:\.0+)?\s*$/iu.test(statement));
const presetReads = (sql: string[]) => sql.filter(statement => /^SELECT value FROM asset_class_presets WHERE id=/u.test(statement));
const suppressionReads = (sql: string[]) => sql.filter(statement => /^SELECT value FROM proactive_suppressions ORDER BY id/u.test(statement));
const assetPointReads = (sql: string[]) => sql.filter(statement => /^SELECT \* FROM data_asset WHERE id = /u.test(statement));
const assetBatchReads = (sql: string[]) => sql.filter(statement => /^SELECT \* FROM data_asset WHERE id IN\s*\(/u.test(statement));
const proposalPointReads = (sql: string[]) => sql.filter(statement => /^SELECT value FROM proactive_proposals WHERE dedupe_key=/u.test(statement));
const proposalIdReads = (sql: string[]) => sql.filter(statement => /^SELECT value FROM proactive_proposals WHERE id=/u.test(statement));
const proposalBatchReads = (sql: string[]) => sql.filter(statement => /^SELECT dedupe_key,value FROM proactive_proposals WHERE dedupe_key IN\s*\(/u.test(statement));
const tombstoneBatchReads = (sql: string[]) => sql.filter(statement => /^WITH proposal_tombstone_requested\b/u.test(statement));
const tombstonePointReads = (sql: string[]) => sql.filter(statement => /^SELECT 1 FROM proactive_proposal_tombstones WHERE dedupe_key=/u.test(statement));

describe('D-325 class update scan', () => {
  for (const count of [0, 1, 1001]) it(`uses one class scan SELECT with ${count} unclassed assets`, async () => {
    const f = fixture();
    f.db.transaction(() => { for (let index = 0; index < count; index++) f.put(`asset-${String(index).padStart(5, '0')}`); })();
    expect(f.work.countAssets()).toBe(count);
    const { value, sql } = await f.read();
    expect(value.assets).toEqual([]); expect(f.offers()).toEqual([]);
    expect(classReads(sql)).toHaveLength(1);
    expect(presetReads(sql)).toEqual([]);
    expect(assetBatchReads(sql)).toEqual([]);
    expect(proposalBatchReads(sql)).toEqual([]);
    expect(tombstoneBatchReads(sql)).toEqual([]);
  });

  it('keeps class, version, asset status and sync visibility eligibility', async () => {
    const f = fixture(); f.service.classes.register(preset());
    for (const status of ['active', 'lent', 'sold', 'lost', 'retired'] as const) {
      for (const sync_state of ['live', 'stale_unreachable', 'orphaned', 'tombstoned'] as const) {
        f.put(`${status}-${sync_state}`, { class_id: 'fixture_class', status, sync_state, settings: { class_version: 1 } });
      }
    }
    for (const [id, patch] of [
      ['unclassed', {}], ['empty-class', { class_id: '' }], ['missing-class', { class_id: 'missing' }],
      ['current', { class_id: 'fixture_class', settings: { class_version: 2 } }],
      ['numeric-version', { class_id: 'fixture_class', settings: { class_version: '2' } }],
      ['ahead', { class_id: 'fixture_class', settings: { class_version: 3 } }],
      ['deleted', { class_id: 'fixture_class' }],
    ] as const) f.put(id, patch);
    f.db.prepare('UPDATE data_asset SET deleted_at=1 WHERE id=?').run('deleted');
    expect(f.work.walkAssetsForClassUpdates('', 100)).toEqual(f.work.walkByAssetId('', 100)
      .filter(row => row.class_id && ['active', 'lent'].includes(row.status)));
    await f.read();
    expect(f.offers().map(row => row.payload.asset_id).sort()).toEqual(['active-live', 'active-stale_unreachable', 'lent-live', 'lent-stale_unreachable']);
  });

  it('does not hydrate assets excluded by the class scan', () => {
    const f = fixture();
    f.put('eligible', { class_id: 'fixture_class' });
    f.put('unclassed'); f.put('empty-class', { class_id: '' });
    f.put('retired', { class_id: 'fixture_class', status: 'retired' });
    f.put('orphaned', { class_id: 'fixture_class', sync_state: 'orphaned' });
    f.db.prepare("UPDATE data_asset SET data_blob='invalid JSON' WHERE id<>'eligible'").run();
    expect(f.work.walkAssetsForClassUpdates('', 100).map(row => row.id)).toEqual(['eligible']);
  });

  it('updates index membership on class, status and sync changes, including transaction rollback', () => {
    const f = fixture(); const ids = () => f.work.walkAssetsForClassUpdates('', 100).map(row => row.id);
    const source = { ...f.work.getSource('recued.asset')!, id: 'fixture.asset' }; f.work.registerSource(source);
    const putA = (patch: Partial<Parameters<typeof f.work.writeAsset>[0]>) => f.put('a', { ...patch, source_id: source.id });
    putA({ class_id: 'fixture_class' }); f.put('b'); expect(ids()).toEqual(['a']);
    putA({ class_id: null }); f.put('b', { class_id: 'fixture_class', status: 'lent' }); expect(ids()).toEqual(['b']);
    f.put('b', { status: 'retired' }); expect(ids()).toEqual([]);
    putA({ class_id: 'fixture_class', sync_state: 'stale_unreachable' }); expect(ids()).toEqual(['a']);
    f.work.unregisterSource(source.id); expect(ids()).toEqual([]); f.work.registerSource(source);
    f.put('b', { status: 'active' }); expect(ids()).toEqual(['b']);
    expect(f.db.transaction(() => { putA({ sync_state: 'live', name: 'Seen again' }); f.put('b', { class_id: '' }); throw new Error('rollback'); })).toThrow('rollback');
    expect(ids()).toEqual(['b']);
    f.work.deleteAsset('b', { tombstone: true }); expect(ids()).toEqual([]);
  });

  for (const change of ['reclassify', 'delete'] as const) it(`resumes in binary ID order after a cursor asset is changed by ${change}`, () => {
    const f = fixture(); const ids = ["asset-'quoted", 'asset-0', 'asset-Z', 'asset-z', 'asset-É', 'asset-漢', 'asset-😀'];
    for (const id of [...ids].reverse()) f.put(id, { class_id: 'fixture_class' });
    f.put('asset-unclassed');
    const expected = [...ids].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    const seen = f.work.walkAssetsForClassUpdates('', 2).map(row => row.id);
    expect(seen).toEqual(expected.slice(0, 2)); const cursor = seen.at(-1)!;
    if (change === 'reclassify') f.put(cursor, { class_id: null }); else f.work.deleteAsset(cursor);
    for (;;) {
      const page = f.work.walkAssetsForClassUpdates(seen.at(-1)!, 2); if (!page.length) break;
      seen.push(...page.map(row => row.id));
    }
    expect(seen).toEqual(expected);
  });

  it('installs an indexed class scan on existing realms and keeps it after ANALYZE', async () => {
    const f = fixture();
    f.db.transaction(() => { for (let index = 0; index < 1001; index++) f.put(`unclassed-${index}`); })();
    f.put('eligible', { class_id: 'fixture_class' });
    f.db.exec('DROP INDEX idx_asset_class_updates');
    ensureWorkEntitySchema(f.db); ensureWorkEntitySchema(f.db);
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE');
      const { sql } = await f.read(); const query = classReads(sql)[0]!;
      expect(query).toBeDefined();
      const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{ detail: string }>;
      expect(plan.some(row => row.detail.includes('USING INDEX idx_asset_class_updates'))).toBe(true);
    }
  });

  for (const count of [100, 101, 201]) it(`walks ${count} sparse classed assets across page boundaries`, async () => {
    const f = fixture(); f.service.classes.register(preset());
    const ids = Array.from({ length: count }, (_, index) => `asset-${String(index).padStart(5, '0')}-classed`);
    f.db.transaction(() => {
      f.put('000-unclassed');
      for (const id of [...ids].reverse()) { f.put(id, { class_id: 'fixture_class' }); f.put(`${id}-unclassed`); }
      f.put('zzz-retired', { class_id: 'fixture_class', status: 'retired' });
    })();
    const { sql } = await f.read();
    expect(f.offers().map(row => row.payload.asset_id).sort()).toEqual(ids);
    expect(classReads(sql)).toHaveLength(Math.ceil(count / 100) + 1);
    expect(presetReads(sql)).toHaveLength(1);
    // Each publication page starts with a point read; later events share placements.
    expect(assetPointReads(sql)).toHaveLength(Math.ceil(count / 100));
    expect(assetBatchReads(sql)).toHaveLength(Math.ceil(count / 200));
    expect(proposalPointReads(sql)).toEqual([]);
    expect(proposalIdReads(sql)).toEqual([]);
    expect(proposalBatchReads(sql)).toHaveLength(Math.ceil(count / 100));
    expect(tombstoneBatchReads(sql)).toHaveLength(Math.ceil(count / 100));
    expect(tombstonePointReads(sql)).toEqual([]);
    const first = new Map(f.offers().map(row => [row.key, row.id]));
    const repeated = await f.read();
    expect(presetReads(repeated.sql)).toHaveLength(1);
    expect(assetPointReads(repeated.sql)).toEqual([]);
    expect(assetBatchReads(repeated.sql)).toHaveLength(Math.ceil(count / 200));
    expect(proposalPointReads(repeated.sql)).toEqual([]);
    expect(proposalIdReads(repeated.sql)).toEqual([]);
    expect(proposalBatchReads(repeated.sql)).toHaveLength(Math.ceil(count / 100));
    expect(tombstoneBatchReads(repeated.sql)).toEqual([]); expect(tombstonePointReads(repeated.sql)).toEqual([]);
    expect(new Map(f.offers().map(row => [row.key, row.id]))).toEqual(first);
  });

  it('skips prefetch for ineligible and suppressed offers, including mixed pages', async () => {
    const f = fixture(); f.service.classes.register(preset()); f.service.classes.register(preset('quiet_class'));
    f.service.proposals.saveSuppression({ kind: 'proposal_kind', value: 'class-update:quiet_class' }, 1);
    f.put('current', { class_id: 'fixture_class', settings: { class_version: 2 } });
    f.put('quiet', { class_id: 'quiet_class' });
    const quiet = await f.read(); expect(proposalBatchReads(quiet.sql)).toEqual([]); expect(tombstoneBatchReads(quiet.sql)).toEqual([]);
    f.put('new', { class_id: 'fixture_class' });
    const queries = proposalBatchReads((await f.read()).sql); expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('class-update:new:fixture_class:2');
    expect(queries[0]).not.toContain('class-update:current'); expect(queries[0]).not.toContain('class-update:quiet');
  });

  it('prefetches distinct proposal keys in bounded SQL batches, including quoted keys and explicit misses', () => {
    const f = fixture(); const store = f.service.proposals;
    const keys = Array.from({ length: 401 }, (_, index) => `batch-${index}${index === 0 ? "-'漢" : ''}`);
    f.db.transaction(() => { for (const key of keys) store.ensure(proposalInput(key), 1); })();
    const empty = f.measure(() => store.prefetchKeys([])); expect(empty.sql).toEqual([]); expect(empty.value?.('missing')).toBeUndefined();
    const { value: lookup, sql } = f.measure(() => store.prefetchKeys([...keys, ...keys, 'missing']));
    expect(proposalPointReads(sql)).toEqual([]);
    expect(proposalBatchReads(sql).map(query => [...query.matchAll(/'batch-/gu)].length)).toEqual([200, 200, 1]);
    expect(tombstoneBatchReads(sql)).toHaveLength(1); expect(tombstoneBatchReads(sql)[0]).toContain("'missing'");
    expect(tombstoneBatchReads(sql)[0]).not.toContain("'batch-");
    expect(keys.map(key => lookup?.(key))).toEqual(keys.map(key => store.byKey(key)));
    expect(lookup?.('missing')).toBeNull(); expect(lookup?.('unrequested')).toBeUndefined();
  });

  for (const existing of [false, true]) it(`consumes each prefetched key once with an ${existing ? 'existing' : 'absent'} proposal`, () => {
    const f = fixture(); const store = f.service.proposals; const input = proposalInput('subject');
    if (existing) store.ensure(input, 1);
    const lookup = store.prefetchKeys([input.key]);
    const first = f.measure(() => store.ensure(input, 2, lookup)); expect(proposalPointReads(first.sql)).toEqual([]);
    const edited = store.edit(first.value.id, { title: 'Owner edit' }, 3);
    const next = f.measure(() => store.ensure(input, 4, lookup));
    expect(proposalPointReads(next.sql)).toHaveLength(1); expect(next.value).toEqual(edited);
    expect(store.list()).toHaveLength(1);
  });

  it('validates before decoding a prefetched legacy proposal and leaves that key unconsumed on validation failure', () => {
    const f = fixture(); const store = f.service.proposals; const input = proposalInput('subject'); const old = store.ensure(input, 1);
    f.db.prepare('UPDATE proactive_proposals SET value=? WHERE id=?').run('invalid JSON', old.id);
    const lookup = store.prefetchKeys([input.key]);
    expect(() => store.ensure({ ...input, title: '' }, 2, lookup)).toThrow('Invalid or oversized proposal');
    expect(() => store.ensure(input, 2, lookup)).toThrow(SyntaxError);
  });

  for (const mode of ['failure', 'incomplete', 'unavailable'] as const) it(`keeps proposal point lookups when key prefetch is ${mode}`, async () => {
    const f = fixture(); f.service.classes.register(preset()); f.put('subject', { class_id: 'fixture_class' });
    await f.read(); const old = f.offers()[0]!;
    if (mode === 'failure') f.service.proposals.prefetchKeys = () => { throw new Error('Batch unavailable'); };
    if (mode === 'incomplete') f.service.proposals.prefetchKeys = () => () => undefined;
    if (mode === 'unavailable') delete (f.service.proposals as Partial<typeof f.service.proposals>).prefetchKeys;
    const { sql } = await f.read();
    expect(proposalPointReads(sql)).toHaveLength(1); expect(f.offers().map(row => row.id)).toEqual([old.id]);
  });

  it('retains a customized ensure implementation and its lookup order', async () => {
    const f = fixture(); f.service.classes.register(preset()); f.put('subject', { class_id: 'fixture_class' }); await f.read();
    const ensure = f.service.proposals.ensure; const seen: string[] = [];
    f.service.proposals.ensure = (input, at) => { seen.push(input.key); return ensure(input, at); };
    expect(f.service.proposals.prefetchKeys(['class-update:subject:fixture_class:2'])).toBeUndefined();
    const { sql } = await f.read();
    expect(seen).toEqual(['class-update:subject:fixture_class:2']);
    expect(proposalPointReads(sql)).toHaveLength(1); expect(proposalBatchReads(sql)).toEqual([]);
  });

  it('keeps owner edits, answers and deleted or forgotten proposal tombstones through repeated class scans', async () => {
    const f = fixture(); f.service.classes.register(preset());
    for (const id of ['edited', 'dismissed', 'accepted', 'deleted', 'forgotten']) f.put(id, { class_id: 'fixture_class' });
    await f.read(); const rows = Object.fromEntries(f.offers().map(row => [String(row.payload.asset_id), row]));
    const edited = f.service.proposals.edit(rows.edited!.id, { title: 'Owner title', payload: { ...rows.edited!.payload, owner_note: 'Keep me' } }, 2);
    const dismissed = f.service.proposals.outcome(rows.dismissed!.id, 'not_this_one', 2);
    const accepted = f.service.proposals.outcome(rows.accepted!.id, 'accepted', 2);
    f.service.proposals.delete(rows.deleted!.id); f.service.proposals.forget(rows.forgotten!.id, 2);
    for (let round = 0; round < 2; round++) {
      const { sql } = await f.read(); expect(proposalPointReads(sql)).toEqual([]); expect(proposalBatchReads(sql)).toHaveLength(1);
      for (const row of [edited, dismissed, accepted]) expect(f.service.proposals.read(row.id)).toEqual(row);
      expect(f.service.proposals.read(rows.deleted!.id)).toBeNull(); expect(f.service.proposals.read(rows.forgotten!.id)).toBeNull();
      expect(f.offers().map(row => row.id)).toEqual([edited.id]);
    }
  });

  it('preserves earlier proposal creation before a later stored proposal fails to decode', async () => {
    const f = fixture(); f.service.classes.register(preset());
    f.put('a', { class_id: 'fixture_class' }); f.put('b', { class_id: 'fixture_class' });
    const old = f.service.proposals.ensure(proposalInput('class-update:b:fixture_class:2'), 1);
    f.db.prepare('UPDATE proactive_proposals SET value=? WHERE id=?').run('invalid JSON', old.id);
    await expect(f.read()).rejects.toThrow(SyntaxError);
    expect(f.service.proposals.byKey('class-update:a:fixture_class:2')?.state).toBe('proposed');
  });

  it('preserves earlier proposal creation before later malformed eligibility data throws', async () => {
    const f = fixture(); f.service.classes.register(preset());
    f.put('a', { class_id: 'fixture_class' }); f.put('b', { class_id: 'fixture_class' });
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.settings',NULL) WHERE id='b'").run();
    await expect(f.read()).rejects.toThrow();
    expect(f.service.proposals.byKey('class-update:a:fixture_class:2')?.state).toBe('proposed');
    expect(f.service.proposals.byKey('class-update:b:fixture_class:2')).toBeNull();
  });

  it('reads proposal keys afresh on later scan pages and on the next refresh', async () => {
    const f = fixture(); f.service.classes.register(preset());
    const ids = Array.from({ length: 101 }, (_, index) => `subject-${String(index).padStart(3, '0')}`);
    f.db.transaction(() => { for (const id of ids) f.put(id, { class_id: 'fixture_class' }); })();
    await f.read(); const last = f.offers().find(row => row.payload.asset_id === ids[100])!;
    const walk = f.work.walkAssetsForClassUpdates; let changed = false;
    f.work.walkAssetsForClassUpdates = (after, limit) => {
      if (after && !changed) { changed = true; f.service.proposals.delete(last.id); }
      return walk(after, limit);
    };
    const { sql } = await f.read();
    expect(proposalPointReads(sql)).toEqual([]); expect(proposalBatchReads(sql)).toHaveLength(2);
    expect(tombstonePointReads(sql)).toEqual([]); expect(tombstoneBatchReads(sql)).toHaveLength(1);
    expect(f.offers()).toHaveLength(100); expect(f.service.proposals.byKey(last.key)).toBeNull();
    f.service.proposals.pruneTombstones(key => key === last.key); await f.read();
    expect(f.offers()).toHaveLength(101); expect(f.service.proposals.byKey(last.key)?.id).not.toBe(last.id);
  });

  it('keeps bulk reads raw, includes unavailable rows and distinguishes missing IDs', () => {
    const f = fixture(); f.put('parent', { sphere: 'professional' });
    f.put("child-'漢", { belongs_to: 'parent' }); f.put('orphan', { sync_state: 'orphaned' });
    f.put('retired', { status: 'retired' }); f.put('tombstone'); f.work.deleteAsset('tombstone', { tombstone: true });
    f.put('removed'); f.work.deleteAsset('removed');
    const ids = ["child-'漢", 'orphan', 'retired', 'tombstone', 'removed', 'missing', "child-'漢"];
    const result = f.work.readAssets(ids)!;
    expect(result).toEqual(new Map([...new Set(ids)].map(id => [id, f.work.readAsset(id)])));
    expect(result.has('parent')).toBe(false);
    expect(result.get("child-'漢")?.sphere).toBeUndefined();
    expect(f.work.readAssetEffective("child-'漢")?.sphere).toBe('professional');
    f.put("child-'漢", { name: 'Edited' });
    expect(f.work.readAssets(["child-'漢"])?.get("child-'漢")?.name).toBe('Edited');
    expect(result.get("child-'漢")?.name).toBe("child-'漢");
  });

  it('deduplicates bulk IDs, caps SQL batches at 200 and skips empty input', () => {
    const f = fixture(); const ids = Array.from({ length: 401 }, (_, index) => `batch-${index}`);
    f.db.transaction(() => { for (const id of ids) f.put(id); })();
    const empty = f.measure(() => f.work.readAssets([])); expect(empty.value).toEqual(new Map()); expect(empty.sql).toEqual([]);
    const { value, sql } = f.measure(() => f.work.readAssets([...ids, ...ids, 'missing']));
    expect(value?.size).toBe(402); expect(value?.get('missing')).toBeNull();
    expect(assetPointReads(sql)).toEqual([]);
    expect(assetBatchReads(sql).map(query => [...query.matchAll(/'batch-/gu)].length)).toEqual([200, 200, 1]);
  });

  for (const mode of ['failure', 'incomplete', 'unavailable'] as const) it(`retains point-read cleanup when the bulk reader is ${mode}`, async () => {
    const f = fixture(); f.service.classes.register(preset()); f.put('subject', { class_id: 'fixture_class' });
    await f.read(); const offer = f.offers()[0]!;
    if (mode === 'failure') f.work.readAssets = () => { throw new Error('Batch unavailable'); };
    if (mode === 'incomplete') f.work.readAssets = () => new Map();
    if (mode === 'unavailable') delete (f.work as Partial<typeof f.work>).readAssets;
    const { sql } = await f.read();
    expect(assetPointReads(sql)).toHaveLength(1);
    expect(f.service.proposals.read(offer.id)?.state).toBe('proposed');
    f.put('subject', { class_id: null }); await f.read();
    expect(f.service.proposals.read(offer.id)?.state).toBe('retracted');
  });

  it('retains customized point-reader visibility during offer cleanup', async () => {
    const f = fixture(); f.service.classes.register(preset()); f.put('subject', { class_id: 'fixture_class' });
    await f.read(); const offer = f.offers()[0]!; const current = f.work.readAsset('subject')!;
    const read = f.work.readAsset; const seen: string[] = [];
    f.work.readAsset = id => { seen.push(id); return id === 'subject' ? { ...current, status: 'retired' } : read(id); };
    expect(f.work.readAssets(['subject'])).toBeUndefined();
    const { sql } = await f.read();
    expect(assetBatchReads(sql)).toEqual([]); expect(seen).toEqual(['subject']);
    expect(f.service.proposals.read(offer.id)?.state).toBe('retracted');
  });

  it('preserves earlier retractions before a later malformed asset throws', async () => {
    const f = fixture(); f.service.classes.register(preset());
    f.put('a', { class_id: 'fixture_class' }); f.put('b', { class_id: 'fixture_class' }); await f.read();
    const [first, second] = f.offers();
    f.put('a', { status: 'retired' }); f.put('b', { status: 'retired' });
    f.db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run('invalid JSON', second!.payload.asset_id);
    await expect(f.read()).rejects.toThrow();
    expect(f.service.proposals.read(first!.id)?.state).toBe('retracted');
    expect(f.service.proposals.read(second!.id)?.state).toBe('proposed');
  });

  it('preserves earlier retractions before a later malformed proposal payload throws', async () => {
    const f = fixture(); f.service.classes.register(preset());
    f.put('a', { class_id: 'fixture_class' }); f.put('b', { class_id: 'fixture_class' }); await f.read();
    const [first, second] = f.offers(); f.put('a', { status: 'retired' }); f.put('b', { status: 'retired' });
    f.db.prepare('UPDATE proactive_proposals SET value=? WHERE id=?').run(JSON.stringify({ ...second, payload: null }), second!.id);
    await expect(f.read()).rejects.toThrow();
    expect(f.service.proposals.read(first!.id)?.state).toBe('retracted');
    expect(f.service.proposals.read(second!.id)?.state).toBe('proposed');
  });

  it('reads later cleanup batches after earlier retractions without retaining the whole library', async () => {
    const f = fixture(); f.service.classes.register(preset());
    const ids = Array.from({ length: 201 }, (_, index) => `subject-${index}`);
    f.db.transaction(() => { for (const id of ids) f.put(id, { class_id: 'fixture_class' }); })();
    await f.read(); const ordered = f.offers(); const last = ordered.at(-1)!;
    f.db.transaction(() => { for (const id of ids) f.put(id, { status: 'retired' }); })();
    const outcome = f.service.proposals.outcome; const seen: string[] = [];
    f.service.proposals.outcome = (id, state, at, result) => {
      if (!seen.length) f.put(String(last.payload.asset_id), { status: 'active' });
      seen.push(id); return outcome(id, state, at, result);
    };
    await f.read();
    expect(seen).toEqual(ordered.slice(0, 200).map(row => row.id));
    expect(f.offers().map(row => row.id)).toEqual([last.id]);
  });

  it('reads each distinct preset once across pages and offer rechecks, including missing classes', async () => {
    const f = fixture(); f.service.classes.register(preset()); f.service.classes.register(preset('other_class'));
    const classIds = ['fixture_class', 'other_class', 'missing_class'];
    f.db.transaction(() => {
      for (let index = 0; index < 201; index++) f.put(`asset-${String(index).padStart(5, '0')}`, {
        class_id: classIds[index % classIds.length], settings: { class_version: index % classIds.length === 0 ? 2 : 1 },
      });
    })();
    for (let round = 0; round < 2; round++) {
      const { sql } = await f.read(); const reads = presetReads(sql);
      expect(classReads(sql)).toHaveLength(4);
      expect(reads).toHaveLength(3);
      for (const id of classIds) expect(reads.filter(statement => statement.endsWith(`'${id}'`))).toHaveLength(1);
      expect(f.offers()).toHaveLength(67);
      expect(f.offers().every(row => row.payload.class_id === 'other_class')).toBe(true);
    }
  });

  it('forgets cached misses, edits and removals before the next refresh', async () => {
    const f = fixture();
    f.put('a', { class_id: 'fixture_class' }); f.put('b', { class_id: 'fixture_class' });
    expect(presetReads((await f.read()).sql)).toHaveLength(1); expect(f.offers()).toEqual([]);
    f.service.classes.register(preset());
    expect(presetReads((await f.read()).sql)).toHaveLength(1);
    const old = f.offers(); expect(old).toHaveLength(2);
    f.service.classes.register(preset('fixture_class', 3));
    expect(presetReads((await f.read()).sql)).toHaveLength(1);
    expect(old.map(row => f.service.proposals.read(row.id)?.state)).toEqual(['retracted', 'retracted']);
    expect(f.offers().map(row => row.payload.preset_version)).toEqual([3, 3]);
    const updated = f.offers(); f.service.classes.deleteOwner('fixture_class');
    expect(presetReads((await f.read()).sql)).toHaveLength(1); expect(f.offers()).toEqual([]);
    expect(updated.map(row => f.service.proposals.read(row.id)?.state)).toEqual(['retracted', 'retracted']);
    f.service.classes.register(preset('fixture_class', 4)); await f.service.tick();
    expect(f.offers().map(row => row.payload.preset_version)).toEqual([4, 4]);
    const offer = f.offers().find(row => row.payload.asset_id === 'a')!;
    expect(await f.service.command({ action: 'proposal.accept', ids: [offer.id] }, owner)).toMatchObject({ changed: 1 });
    expect(f.work.readAsset('a')?.settings.class_version).toBe(4);
  });

  for (const change of ['new-version', 'removed-preset'] as const) it(`rejects acceptance after ${change} without another refresh`, async () => {
    const f = fixture(); f.service.classes.register(preset()); f.put('subject', { class_id: 'fixture_class' });
    await f.read(); const offer = f.offers()[0]!; const current = f.work.readAsset('subject');
    if (change === 'new-version') f.service.classes.register(preset('fixture_class', 3)); else f.service.classes.deleteOwner('fixture_class');
    expect(await f.service.command({ action: 'proposal.accept', ids: [offer.id] }, owner))
      .toMatchObject({ changed: 0, failed: [{ id: offer.id }] });
    expect(f.work.readAsset('subject')).toEqual(current);
    expect(f.service.proposals.read(offer.id)?.state).toBe('proposed');
  });

  it('reads assignments and newer presets afresh while keeping dismissals and suppressions', async () => {
    const f = fixture(); f.service.classes.register(preset());
    f.service.classes.register(preset('quiet_class'));
    f.service.proposals.saveSuppression({ kind: 'proposal_kind', value: 'class-update:quiet_class' }, 1);
    f.put('new-assignment'); f.put('quiet', { class_id: 'quiet_class' });
    await f.read(); expect(f.offers()).toEqual([]);
    f.put('new-assignment', { class_id: 'fixture_class' });
    await f.service.tick();
    const offer = f.offers()[0]!;
    expect(offer.key).toBe('class-update:new-assignment:fixture_class:2');
    f.service.proposals.outcome(offer.id, 'not_this_one', 2);
    await f.read(); expect(f.offers()).toEqual([]);
    f.service.classes.register(preset('fixture_class', 3));
    await f.read();
    expect(f.offers().map(row => row.key)).toEqual(['class-update:new-assignment:fixture_class:3']);
    expect(f.service.proposals.read(offer.id)?.state).toBe('dismissed');
  });

  it('reads suppressions once across pages and multiple eligible classes, including an empty suppression list', async () => {
    const f = fixture(); const idleReads = suppressionReads((await f.read()).sql).length;
    f.service.classes.register(preset()); f.service.classes.register(preset('other_class'));
    f.db.transaction(() => {
      for (let index = 0; index < 201; index++) f.put(`asset-${String(index).padStart(5, '0')}`, {
        class_id: index % 2 ? 'other_class' : 'fixture_class',
      });
    })();
    for (let round = 0; round < 2; round++) {
      expect(suppressionReads((await f.read()).sql)).toHaveLength(idleReads + 1);
      expect(f.offers()).toHaveLength(201);
      expect(new Set(f.offers().map(row => row.payload.class_id))).toEqual(new Set(['fixture_class', 'other_class']));
    }
  });

  it('does not load class-update suppressions until an eligible preset update is found', async () => {
    const f = fixture(); const idleReads = suppressionReads((await f.read()).sql).length;
    f.service.classes.register(preset());
    f.put('unclassed'); f.put('missing', { class_id: 'missing_class' });
    f.put('current', { class_id: 'fixture_class', settings: { class_version: 2 } });
    f.put('retired', { class_id: 'fixture_class', status: 'retired' });
    f.put('orphaned', { class_id: 'fixture_class', sync_state: 'orphaned' });
    expect(suppressionReads((await f.read()).sql)).toHaveLength(idleReads);
    expect(f.offers()).toEqual([]);
  });

  for (const scope of ['class-update:fixture_class', 'rule']) it(`refreshes the ${scope} suppression after saves and deletions`, async () => {
    const f = fixture(); const idleReads = suppressionReads((await f.read()).sql).length;
    f.service.classes.register(preset()); f.service.classes.register(preset('other_class'));
    // Other suppression kinds with the same text do not stop class updates.
    f.service.proposals.saveSuppression({ kind: 'person', value: 'class-update:fixture_class' }, 1);
    f.service.proposals.saveSuppression({ kind: 'merchant', value: 'rule' }, 1);
    f.db.transaction(() => {
      for (let index = 0; index < 201; index++) f.put(`asset-${String(index).padStart(5, '0')}`, {
        class_id: index % 2 ? 'other_class' : 'fixture_class',
      });
    })();
    await f.read(); const old = f.offers(); expect(old).toHaveLength(201);
    const stop = f.service.proposals.saveSuppression({ kind: 'proposal_kind', value: scope }, 2);
    // Callers outside the refresh retain fresh default suppression reads.
    expect(f.service.proposals.allows({ kind: 'rule', payload: { proposal_class: 'class-update:fixture_class' } })).toBe(false);
    f.service.classes.register(preset('fixture_class', 3)); f.service.classes.register(preset('other_class', 3));
    expect(suppressionReads((await f.read()).sql)).toHaveLength(idleReads + 1);
    expect(f.offers()).toHaveLength(scope === 'rule' ? 0 : 100);
    expect(f.offers().every(row => row.payload.class_id === 'other_class' && row.payload.preset_version === 3)).toBe(true);
    expect(old.every(row => f.service.proposals.read(row.id)?.state === 'retracted')).toBe(true);
    f.service.proposals.deleteSuppression(stop.id);
    expect(f.service.proposals.allows({ kind: 'rule', payload: { proposal_class: 'class-update:fixture_class' } })).toBe(true);
    await f.service.tick();
    expect(f.offers()).toHaveLength(201);
    expect(f.offers().every(row => row.payload.preset_version === 3)).toBe(true);
  });

  for (const [change, patch] of [
    ['reclassified', { class_id: 'other_class' }], ['unclassed', { class_id: null }],
    ['retired', { status: 'retired' }], ['orphaned', {}], ['soft-deleted', {}],
  ] as const) {
    const invalidate = (f: ReturnType<typeof fixture>) => {
      f.put('subject', patch);
      if (change === 'orphaned') f.work.unregisterSource('recued.asset');
      if (change === 'soft-deleted') f.db.prepare('UPDATE data_asset SET deleted_at=1 WHERE id=?').run('subject');
      return f.work.readAsset('subject')!;
    };
    it(`retracts a class update offer when its asset becomes ${change}`, async () => {
      const f = fixture(); f.service.classes.register(preset()); f.service.classes.register(preset('other_class', 1));
      f.put('subject', { class_id: 'fixture_class' }); await f.read(); const offer = f.offers()[0]!;
      invalidate(f); await f.read();
      expect(f.service.proposals.read(offer.id)?.state).toBe('retracted');
      expect(f.offers().some(row => row.id === offer.id)).toBe(false);
    });

    it(`rejects direct acceptance after the asset becomes ${change}, before another snapshot`, async () => {
      const f = fixture(); f.service.classes.register(preset()); f.service.classes.register(preset('other_class', 1));
      f.put('subject', { class_id: 'fixture_class' }); await f.read(); const offer = f.offers()[0]!;
      const current = invalidate(f);
      const result = await f.service.command({ action: 'proposal.accept', ids: [offer.id] }, owner);
      expect(result).toMatchObject({ changed: 0, failed: [{ id: offer.id }] });
      expect(f.work.readAsset('subject')).toEqual(current);
      expect(f.service.proposals.read(offer.id)?.state).toBe('proposed');
    });
  }

  for (const change of ['applied', 'new-version', 'removed-preset', 'deleted-asset'] as const) {
    it(`still retracts a stale offer after ${change}`, async () => {
      const f = fixture(); f.service.classes.register(preset());
      f.put('subject', { class_id: 'fixture_class' }); await f.read();
      const offer = f.offers()[0]!;
      // Retraction must run even when the filtered scan has no candidates.
      f.put('subject', { status: 'retired' });
      if (change === 'applied') f.put('subject', { class_id: null, settings: { class_version: 2 } });
      if (change === 'new-version') f.service.classes.register(preset('fixture_class', 3));
      if (change === 'removed-preset') f.service.classes.deleteOwner('fixture_class');
      if (change === 'deleted-asset') f.work.deleteAsset('subject');
      await f.read();
      expect(f.offers()).toEqual([]);
      expect(f.service.proposals.read(offer.id)?.state).toBe('retracted');
    });
  }
});
