import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetClassPreset, ExecutionSource } from '@recued/contracts';
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
  return { db, work, service, put, read, offers };
};
// Evidence refresh still has its own 500-row walk. Count only the class scan.
const classReads = (sql: string[]) => sql.filter(statement => /\bFROM data_asset WHERE id\s*>[\s\S]*\bLIMIT 100(?:\.0+)?\s*$/iu.test(statement));

describe('D-325 class update scan', () => {
  for (const count of [0, 1, 1001]) it(`uses one class scan SELECT with ${count} unclassed assets`, async () => {
    const f = fixture();
    f.db.transaction(() => { for (let index = 0; index < count; index++) f.put(`asset-${String(index).padStart(5, '0')}`); })();
    expect(f.work.countAssets()).toBe(count);
    const { value, sql } = await f.read();
    expect(value.assets).toEqual([]); expect(f.offers()).toEqual([]);
    expect(classReads(sql)).toHaveLength(1);
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
    const first = new Map(f.offers().map(row => [row.key, row.id]));
    await f.read();
    expect(new Map(f.offers().map(row => [row.key, row.id]))).toEqual(first);
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
