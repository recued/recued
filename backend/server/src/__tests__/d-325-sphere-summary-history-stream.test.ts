import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetCreateInput, AssetReading, AssetRule, YoursReadRequest } from '@recued/contracts';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel, type NotificationSettings, type PendingAsk } from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { assetSummaryHistoryFields, createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createSphereStore } from '../storage/sphere-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';
import { summarizeYoursAsset } from '../situations/asset-summary.js';

const at = Date.parse('2026-10-17T12:00Z'); const DAY = 86400000;
const base = { source_id: 'recued.asset', source: { kind: 'owner' as const, ref: 'fixture-owner' } };
const objective = (patch: Partial<Extract<AssetRule['when'], { kind: 'objective' }>> = {}): Extract<AssetRule['when'], { kind: 'objective' }> =>
  ({ kind: 'objective', field: 'meter', target: 100, unit: 'km', direction: 'rising', mode: 'usage', lead_days: 0, ...patch });
const rule: AssetRule = { id: 'usage', title: 'Service', enabled: true, muted: true, pinned: false, consequence: 'routine', expiry_policy: 'escalate_overdue',
  when: objective(),
  reaction: { notify: false, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true } };
const sample = (value: number, as_of = at, unit = 'km'): AssetReading => ({ value, unit, as_of, evidence: [{ collection: 'file', id: 'file:fixture:sample' }] });
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
  const rows = createAssetOccurrenceStore(db);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => at, timeZone: () => 'UTC' });
  const service = createYoursService({ db, work, dispatchers, occurrences, situations: createSituationStore(db), now: () => at, timeZone: () => 'UTC' });
  disposals.push(async () => { await service.stop(); db.close(); });
  const fuel: AssetRule = { ...rule, id: 'fuel', when: objective({ field: 'fuel', unit: 'L' }) };
  const put = (id: string, patch: Partial<AssetCreateInput> = {}, time = at) => work.writeAsset({ ...base, id, name: `Fixture ${id}`, sphere: 'professional', attributes: { fixture_id: id }, rules: [rule, { ...rule, id: 'duplicate' }, fuel], readings: { meter: null, fuel: null }, ...patch }, time);
  const seed = (asset_id: string, field: string, reading: AssetReading) => db.prepare('INSERT INTO asset_reading_history(asset_id,field,as_of,value) VALUES(?,?,?,?) ON CONFLICT(asset_id,field,as_of) DO UPDATE SET value=excluded.value')
    .run(asset_id, field, reading.as_of, JSON.stringify(reading));
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
  const retained = async (request: YoursReadRequest) => {
    const scope = work.withAssetReadingHistories; work.withAssetReadingHistories = (_query, read) => read();
    try { return await service.snapshot(request); } finally { work.withAssetReadingHistories = scope; }
  };
  const all = (search?: string) => {
    const assets: Asset[] = [];
    for (let offset = 0; ; offset += 200) { const page = work.listAssets({ limit: 200, offset, search }); assets.push(...page); if (page.length < 200) return assets; }
  };
  const seedAssets = (size: number) => db.transaction(() => { for (let n = 0; n < size; n++) {
    const id = `asset-${String(n).padStart(4, '0')}`;
    put(id, { readings: { meter: n % 3 ? sample(50, at - 2 * DAY) : null, fuel: n % 4 ? sample(10, at - 2 * DAY, 'L') : null } }, at + n);
    seed(id, 'meter', sample(40, at - 3 * DAY)); seed(id, 'fuel', sample(14, at - 3 * DAY, 'L'));
  } })();
  const capture = () => {
    const statements: Database.Statement[] = []; const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(sql => { const statement = prepare(sql); if (streamSql(sql) || sphereCandidateSql(sql)) statements.push(statement); return statement; });
    return statements;
  };
  return { db, work, rows, service, put, seed, measure, pause, retained, all, seedAssets, capture };
};
const streamSql = (sql: string) => /\breading_stream_candidates AS\b/u.test(sql);
const batchSql = (sql: string) => /^WITH reading_requested\b/u.test(sql);
const requestsFor = (assets: readonly Asset[]) => assets.flatMap(asset => ['active', 'lent'].includes(asset.status)
  ? asset.rules.flatMap(rule => rule.enabled && rule.when.kind === 'objective' ? [{ asset_id: asset.id, field: rule.when.field }] : []) : []);
const individual = (work: ReturnType<typeof createWorkEntityStore>, requests: ReturnType<typeof requestsFor>, limit?: number) => {
  const result = new Map<string, Map<string, AssetReading[]>>();
  for (const { asset_id, field } of requests) {
    let fields = result.get(asset_id); if (!fields) { fields = new Map(); result.set(asset_id, fields); }
    fields.set(field, work.assetReadingHistory(asset_id, field, limit));
  }
  return result;
};

const sphereStreamSql = (sql: string) => streamSql(sql) && /\basset_summary_history_members AS\b/u.test(sql);
const sphereCandidateSql = (sql: string) => /\basset_sphere_candidates AS\b/u.test(sql);

describe('reading histories for sphere-selected attention', () => {
  it('reuses completed native membership and safety checks within the matching synchronous read', async () => {
    const f = fixture(); f.seedAssets(201);
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE');
      const read = await f.measure(() => f.service.snapshot({ asset_sphere: 'professional', asset_filter: 'missing_facts', search: ' Fixture asset- ' }));
      expect(read.sql.filter(sphereCandidateSql)).toHaveLength(1); expect(read.sql.find(sphereCandidateSql)).toContain('json_valid(');
      expect(read.sql.filter(sphereStreamSql)).toHaveLength(1); expect(read.sql.find(sphereStreamSql)).not.toContain('json_valid(');
      expect(read.sql.find(sphereStreamSql)).not.toContain('asset_sphere_matches');
      const plans = f.db.prepare(`EXPLAIN QUERY PLAN ${read.sql.find(sphereStreamSql)!}`).all() as Array<{ detail: string }>;
      expect(plans.some(row => /USING INDEX idx_asset_summary_history_order/u.test(row.detail))).toBe(true);
      expect(plans.some(row => row.detail === 'USE TEMP B-TREE FOR ORDER BY' || /MATERIALIZE reading_stream_candidates/u.test(row.detail))).toBe(false);
    }
    const pairs = requestsFor(f.all().slice(0, 1));
    const direct = await f.measure(() => f.service.spheres.withAssetReadingHistories('professional', {}, () => f.work.assetReadingHistories(pairs)));
    expect(direct.value).toEqual(individual(f.work, pairs)); expect(direct.sql.find(sphereStreamSql)).toContain('json_valid(');
  });

  it('returns the roster only on the first candidate row and never adds it to asset DTOs', async () => {
    const f = fixture(); f.seedAssets(401);
    f.db.prepare("UPDATE data_asset SET sphere='personal' WHERE id='asset-0400'").run();
    const expected = f.all().filter(asset => asset.sphere === 'professional').map(asset => asset.id).sort();
    const prepare = f.db.prepare.bind(f.db); const rosters: string[] = []; let candidateRows = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (sphereCandidateSql(sql)) {
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, 'iterate').mockImplementation((...params) => {
          const cursor = iterate(...params);
          return { next() { const row = cursor.next(); if (!row.done) {
            candidateRows++;
            const value = row.value as { history_members: string | null };
            if (typeof value.history_members === 'string') { expect(candidateRows).toBe(1); rosters.push(value.history_members); }
          } return row; }, return() { return cursor.return?.() ?? { done: true, value: undefined }; }, [Symbol.iterator]() { return this; } };
        });
      }
      return statement;
    });
    const read = await f.measure(() => f.service.snapshot({ asset_sphere: 'professional', asset_filter: 'missing_facts', limit: 13 }));
    expect(rosters).toHaveLength(1); expect(JSON.parse(rosters[0]!).sort()).toEqual(expected); expect(candidateRows).toBe(400);
    expect(read.value.assets).toHaveLength(13); expect(read.value.assets.every(asset => !Object.hasOwn(asset, 'history_members'))).toBe(true);
    expect(read.sql.find(sphereStreamSql)).not.toContain('asset_sphere_walk'); expect(read.sql.filter(batchSql)).toEqual([]);
  });

  for (const [label, char] of [['ASCII', 'a'], ['Unicode', '漢😀'], ['escaped', '\n"\\']] as const)
    it(`caps the encoded ${label} roster by bytes and retains native histories above the cap`, async () => {
      const f = fixture(); const ids = Array.from({ length: 600 }, (_, n) => `${String(n).padStart(4, '0')}:${char.repeat(600)}`);
      f.db.transaction(() => { for (const id of ids) f.put(id, { name: `Large ${id.slice(0, 1)}` }); })();
      const encoded = Buffer.byteLength(JSON.stringify(ids)); const fits = encoded <= 1024 * 1024;
      expect(fits).toBe(label === 'ASCII');
      const prepare = f.db.prepare.bind(f.db); const members: unknown[] = [];
      vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
        const statement = prepare(sql);
        if (sphereStreamSql(sql)) {
          const iterate = statement.iterate.bind(statement);
          vi.spyOn(statement, 'iterate').mockImplementation((...params) => { members.push(params[0]); return iterate(...params); });
        }
        return statement;
      });
      const pairs = requestsFor(f.all()); const expected = individual(f.work, pairs);
      const read = await f.measure(() => f.service.spheres.withAssetReadingHistories('professional', {}, () => {
        const candidates = f.service.spheres.assetCandidates('professional')!;
        try { expect(candidates.next().done).toBe(false); return f.work.assetReadingHistories(pairs); }
        finally { candidates.return(false); }
      }));
      expect(read.value).toEqual(expected); expect(read.sql.filter(sphereStreamSql)).toHaveLength(1); expect(read.sql.filter(batchSql)).toEqual([]);
      const sql = read.sql.find(sphereStreamSql)!; expect(sql).not.toContain('json_valid(');
      expect(sql.includes('asset_sphere_matches')).toBe(!fits);
      if (fits) { expect(typeof members[0]).toBe('string'); expect(Buffer.byteLength(members[0] as string)).toBe(encoded);
        expect(JSON.parse(members[0] as string).sort()).toEqual(ids.sort()); }
    });

  for (const extra of [0, 1]) it(`shares a roster at the byte limit and falls back ${extra ? 'one byte above it' : 'without truncating it'}`, () => {
    const f = fixture(); const ids = Array.from({ length: 600 }, (_, n) => `${String(n).padStart(4, '0')}:${'a'.repeat(1740)}`);
    ids[599] = ids[599]!.slice(0, ids[599]!.length - (Buffer.byteLength(JSON.stringify(ids)) - 1024 * 1024) + extra);
    expect(Buffer.byteLength(JSON.stringify(ids))).toBe(1024 * 1024 + extra);
    f.db.transaction(() => { for (const id of ids) f.put(id, { name: 'Boundary fixture' }); })();
    const original = f.work.withAssetReadingHistories;
    let selection: Parameters<typeof original>[0]['selection'];
    vi.spyOn(f.work, 'withAssetReadingHistories').mockImplementation((query, read) => { selection = query.selection; return original.call(f.work, query, read); });
    f.service.spheres.withAssetReadingHistories('professional', {}, () => {
      const candidates = f.service.spheres.assetCandidates('professional')!;
      try {
        expect(candidates.next().done).toBe(false);
        expect(selection!.ctes.includes('asset_sphere_matches')).toBe(Boolean(extra));
        if (!extra) { expect(typeof selection!.params[0]).toBe('string'); expect(Buffer.byteLength(selection!.params[0] as string)).toBe(1024 * 1024);
          expect(JSON.parse(selection!.params[0] as string).sort()).toEqual(ids.sort()); }
      } finally { candidates.return(false); }
    });
  });

  it('falls back to the retained scan when the roster aggregate fails', async () => {
    const f = fixture(); f.seedAssets(401);
    const request = { asset_sphere: 'professional' as const, asset_filter: 'missing_facts' as const, include_asset_summaries: true, offset: 197, limit: 13 };
    const expected = await f.retained(request); let failed = false;
    f.db.aggregate('json_group_array', { start: () => '', step(_state: string, _id: unknown): string { failed = true; throw new Error('Fixture roster aggregate failure'); } });
    const read = await f.measure(() => f.service.snapshot(request));
    expect(failed).toBe(true); expect(read.value).toEqual(expected); expect(read.sql.filter(streamSql)).toEqual([]);
    expect(read.sql.filter(batchSql).length).toBeGreaterThan(0);
  });

  it('round-trips quoted and control-character identities through the shared roster', async () => {
    const f = fixture(); const ids = ['plain', 'quoted-"\\\n\t漢😀', 'nul-\0-tail'];
    for (const id of ids) { f.put(id); f.seed(id, 'meter', sample(17)); }
    const request = { asset_sphere: 'professional' as const, asset_filter: 'missing_facts' as const, include_asset_summaries: true };
    const expected = await f.retained(request); const read = await f.measure(() => f.service.snapshot(request));
    expect(read.value).toEqual(expected); expect(read.sql.filter(sphereStreamSql)).toHaveLength(1);
    expect(read.sql.find(sphereStreamSql)).not.toContain('asset_sphere_matches'); expect(read.sql.filter(batchSql)).toEqual([]);
  });

  for (const reason of ['oversize', 'legacy'] as const) it(`does not run the roster aggregate for ${reason} selections`, async () => {
    const f = fixture();
    if (reason === 'oversize') f.db.transaction(() => { for (let n = 0; n < 600; n++) f.put(`${String(n).padStart(4, '0')}:${'a'.repeat(1800)}`, { name: 'Large fixture' }); })();
    else { f.seedAssets(3); f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.legacy',1) WHERE id='asset-0000'").run(); }
    const request = { asset_filter: 'missing_facts' as const, asset_sphere: 'professional' as const, include_asset_summaries: true, limit: 13 };
    const expected = await f.retained(request); let aggregated = 0;
    f.db.aggregate('json_group_array', { start: () => '', step(_state: string, _id: unknown): string { aggregated++; throw new Error('Fixture forbidden roster aggregate'); } });
    const statements = f.capture(); const read = await f.measure(() => f.service.snapshot(request));
    expect(read.value).toEqual(expected); expect(aggregated).toBe(0); expect(statements.every(statement => !statement.busy)).toBe(true);
    expect(read.sql.filter(sphereStreamSql)).toHaveLength(reason === 'oversize' ? 1 : 0);
    if (reason === 'oversize') { expect(read.sql.find(sphereStreamSql)).toContain('asset_sphere_matches'); expect(read.sql.filter(batchSql)).toEqual([]); }
    else expect(read.sql.filter(batchSql).length).toBeGreaterThan(0);
  });

  it('shares a matching normalized source filter while excluding unrelated legacy roots', async () => {
    const f = fixture(); f.seedAssets(201);
    f.work.registerSource({ ...f.work.getSource('recued.asset')!, id: 'other' }); f.put('asset-other', { source_id: 'other' });
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.legacy',1) WHERE id='asset-other'").run();
    const query = { search: ' Fixture asset- ', source_id: 'recued.asset' };
    const pairs = requestsFor(f.all().filter(asset => asset.source_id === 'recued.asset')); const expected = individual(f.work, pairs);
    const read = await f.measure(() => f.service.spheres.withAssetReadingHistories('professional', query, () => {
      const candidates = f.service.spheres.assetCandidates('professional', { ...query, search: 'fixture asset-' })!;
      try { expect(candidates.next().done).toBe(false); return f.work.assetReadingHistories(pairs); }
      finally { candidates.return(false); }
    }));
    expect(read.value).toEqual(expected); expect(read.sql.filter(sphereStreamSql)).toHaveLength(1);
    expect(read.sql.find(sphereStreamSql)).not.toContain('asset_sphere_matches'); expect(read.sql.filter(batchSql)).toEqual([]);
  });

  for (const exit of ['consumer error', 'history close replay'] as const) it(`expires a captured shared roster after ${exit}`, async () => {
    const f = fixture(); f.seedAssets(201); const pairs = requestsFor(f.all()); const expected = individual(f.work, pairs);
    const original = f.work.withAssetReadingHistories; let captured: Parameters<typeof original>[0] | undefined; let calls = 0;
    let ordinaryParams: readonly unknown[] = [];
    vi.spyOn(f.work, 'withAssetReadingHistories').mockImplementation((query, read) => { captured = query; ordinaryParams = [...query.selection!.params]; return original.call(f.work, query, read); });
    const prepare = f.db.prepare.bind(f.db); const statements: Database.Statement[] = [];
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (streamSql(sql) || sphereCandidateSql(sql)) statements.push(statement);
      if (sphereStreamSql(sql) && exit === 'history close replay') {
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, 'iterate').mockImplementation((...params) => {
          const cursor = iterate(...params);
          return { next() { return cursor.next(); }, return() { cursor.return?.(); throw new Error('Fixture history close replay'); }, [Symbol.iterator]() { return this; } };
        });
      }
      return statement;
    });
    const error = new Error('Fixture original consumer error');
    const read = () => f.service.spheres.withAssetReadingHistories('professional', {}, () => {
      calls++; const candidates = f.service.spheres.assetCandidates('professional')!;
      try {
        expect(candidates.next().done).toBe(false); expect(captured!.selection!.ctes).not.toContain('asset_sphere_matches');
        const result = f.work.assetReadingHistories(pairs); if (exit === 'consumer error') throw error; return result;
      } finally { candidates.return(false); }
    });
    if (exit === 'consumer error') { let caught: unknown; try { read(); } catch (failure) { caught = failure; } expect(caught).toBe(error); }
    else expect(read()).toEqual(expected);
    expect(calls).toBe(exit === 'consumer error' ? 1 : 2); expect(statements.every(statement => !statement.busy)).toBe(true);
    expect(captured!.selection!.ctes).toContain('json_valid('); expect(captured!.selection!.params).toEqual(ordinaryParams);
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.legacy',1) WHERE id='asset-0000'").run();
    const later = await f.measure(() => original.call(f.work, captured!, () => f.work.assetReadingHistories(pairs)));
    expect(later.value).toEqual(expected); expect(later.sql.find(sphereStreamSql)).toContain('json_valid('); expect(later.sql.filter(batchSql).length).toBeGreaterThan(0);
  });

  it('restores the outer roster after a nested consumer error', async () => {
    const f = fixture(); f.seedAssets(401); f.db.prepare("UPDATE data_asset SET sphere='personal' WHERE id<'asset-0200'").run();
    const pairs = requestsFor(f.all().filter(asset => asset.sphere === 'professional')); const expected = individual(f.work, pairs);
    const error = new Error('Fixture nested consumer error');
    const read = await f.measure(() => f.service.spheres.withAssetReadingHistories('professional', {}, () => {
      const outer = f.service.spheres.assetCandidates('professional')!;
      try {
        expect(outer.next().done).toBe(false);
        expect(() => f.service.spheres.withAssetReadingHistories('personal', {}, () => {
          const inner = f.service.spheres.assetCandidates('personal')!;
          try { expect(inner.next().done).toBe(false); throw error; } finally { inner.return(false); }
        })).toThrow(error);
        return f.work.assetReadingHistories(pairs);
      } finally { outer.return(false); }
    }));
    expect(read.value).toEqual(expected); expect(read.sql.filter(sphereStreamSql)).toHaveLength(1);
    expect(read.sql.find(sphereStreamSql)).not.toContain('asset_sphere_matches'); expect(read.sql.filter(batchSql)).toEqual([]);
  });

  it('keeps standalone candidate reads independent of the roster aggregate', async () => {
    const f = fixture(); f.seedAssets(401); let aggregated = 0;
    f.db.aggregate('json_group_array', { start: () => '', step(_state: string, _id: unknown): string { aggregated++; throw new Error('Fixture forbidden standalone aggregate'); } });
    const read = await f.measure(() => {
      const cursor = f.service.spheres.assetCandidates('professional')!; const ids: string[] = [];
      try { for (;;) { const next = cursor.next(); if (next.done) { expect(next.value).toBe(true); return ids; } ids.push(...next.value.assets.map(asset => asset.id)); } }
      finally { cursor.return(false); }
    });
    expect(read.value).toEqual(f.all().map(asset => asset.id)); expect(aggregated).toBe(0);
    expect(read.sql).toHaveLength(1); expect(read.sql[0]).not.toContain('AS history_members');
  });


  for (const proof of ['unopened', 'other-sphere', 'other-search', 'other-store'] as const)
    it(`retains full safety checks for an ${proof} candidate read`, async () => {
      const f = fixture(); f.seedAssets(3); const pairs = requestsFor(f.all().slice(0, 1));
      const read = await f.measure(() => f.service.spheres.withAssetReadingHistories('professional', {}, () => {
        const store = proof === 'other-store' ? createSphereStore(f.db, f.work) : f.service.spheres;
        const candidates = store.assetCandidates(proof === 'other-sphere' ? 'personal' : 'professional', proof === 'other-search' ? { search: 'Fixture asset-' } : {})!;
        try { if (proof !== 'unopened') candidates.next(); } finally { candidates.return(false); }
        return f.work.assetReadingHistories(pairs);
      }));
      expect(read.value).toEqual(individual(f.work, pairs)); expect(read.sql.find(sphereStreamSql)).toContain('json_valid(');
    });

  it('restores the prior safety scope after nested reads without promoting the outer read', async () => {
    const f = fixture(); f.seedAssets(3); const pairs = requestsFor(f.all().slice(0, 1));
    const read = await f.measure(() => f.service.spheres.withAssetReadingHistories('professional', {}, () => {
      f.service.spheres.withAssetReadingHistories('professional', {}, () => {
        const candidates = f.service.spheres.assetCandidates('professional')!;
        try { candidates.next(); } finally { candidates.return(false); }
        expect(f.work.assetReadingHistories(pairs)).toEqual(individual(f.work, pairs));
      });
      return f.work.assetReadingHistories(pairs);
    }));
    expect(read.value).toEqual(individual(f.work, pairs)); const queries = read.sql.filter(sphereStreamSql);
    expect(queries).toHaveLength(2); expect(queries[0]).not.toContain('json_valid('); expect(queries[1]).toContain('json_valid(');
  });

  it('restores the outer shared roster after reading a different sphere in a nested scope', async () => {
    const f = fixture(); f.seedAssets(401); f.db.prepare("UPDATE data_asset SET sphere='personal' WHERE id<'asset-0200'").run();
    const professional = requestsFor(f.all().filter(asset => asset.sphere === 'professional'));
    const personal = requestsFor(f.all().filter(asset => asset.sphere === 'personal'));
    const read = await f.measure(() => f.service.spheres.withAssetReadingHistories('professional', {}, () => {
      const outer = f.service.spheres.assetCandidates('professional')!;
      try {
        expect(outer.next().done).toBe(false);
        f.service.spheres.withAssetReadingHistories('personal', {}, () => {
          const inner = f.service.spheres.assetCandidates('personal')!;
          try { expect(inner.next().done).toBe(false); expect(f.work.assetReadingHistories(personal)).toEqual(individual(f.work, personal)); }
          finally { inner.return(false); }
        });
        return f.work.assetReadingHistories(professional);
      } finally { outer.return(false); }
    }));
    expect(read.value).toEqual(individual(f.work, professional)); expect(read.sql.filter(sphereStreamSql)).toHaveLength(2);
    expect(read.sql.filter(sphereStreamSql).every(sql => !sql.includes('asset_sphere_matches'))).toBe(true);
    expect(read.sql.filter(batchSql)).toEqual([]);
  });

  it('retains full guards and ordinary history fallback after an unsupported native candidate read', async () => {
    const f = fixture(); f.seedAssets(3); const pairs = requestsFor(f.all().slice(0, 1));
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.legacy',1) WHERE id='asset-0000'").run();
    const read = await f.measure(() => f.service.spheres.withAssetReadingHistories('professional', {}, () => {
      const candidates = f.service.spheres.assetCandidates('professional')!;
      try { expect(candidates.next()).toEqual({ done: true, value: false }); } finally { candidates.return(false); }
      return f.work.assetReadingHistories(pairs);
    }));
    expect(read.value).toEqual(individual(f.work, pairs)); expect(read.sql.find(sphereStreamSql)).toContain('json_valid(');
    expect(read.sql.filter(batchSql)).toHaveLength(1);
  });

  it('does not retain a completed safety check in a captured query used after its scope', async () => {
    const f = fixture(); f.seedAssets(3); const original = f.work.withAssetReadingHistories;
    let captured: Parameters<typeof original>[0] | undefined;
    vi.spyOn(f.work, 'withAssetReadingHistories').mockImplementation((query, read) => { captured = query; return original.call(f.work, query, read); });
    await f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional' }); expect(captured).toBeDefined();
    const pairs = requestsFor(f.all().slice(0, 1));
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.legacy',1) WHERE id='asset-0000'").run();
    const read = await f.measure(() => original.call(f.work, captured!, () => f.work.assetReadingHistories(pairs)));
    expect(read.value).toEqual(individual(f.work, pairs)); expect(read.sql.find(sphereStreamSql)).toContain('json_valid(');
    expect(read.sql.filter(batchSql)).toHaveLength(1);
  });

  it('does not waive checks when native selection uses different asset filters', async () => {
    const f = fixture(); f.seedAssets(3);
    f.work.registerSource({ ...f.work.getSource('recued.asset')!, id: 'other' }); f.put('asset-other', { source_id: 'other' });
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.legacy',1) WHERE id='asset-other'").run();
    const pairs = requestsFor(f.all().filter(asset => asset.source_id === 'recued.asset').slice(0, 1));
    const query = { search: 'Fixture asset-', source_id: 'recued.asset' };
    const read = await f.measure(() => f.service.spheres.withAssetReadingHistories('professional', { search: query.search }, () => {
      const candidates = f.service.spheres.assetCandidates('professional', query)!;
      try { expect(candidates.next().done).toBe(false); } finally { candidates.return(false); }
      return f.work.assetReadingHistories(pairs);
    }));
    expect(read.value).toEqual(individual(f.work, pairs)); expect(read.sql.find(sphereStreamSql)).toContain('json_valid(');
    expect(read.sql.filter(batchSql)).toHaveLength(1);
  });

  it('does not promote a later scope from a candidate cursor started before it', async () => {
    const f = fixture(); f.seedAssets(401); const pairs = requestsFor(f.all().slice(0, 1));
    const older = f.service.spheres.assetCandidates('professional')!;
    try {
      expect(older.next().done).toBe(false);
      const read = await f.measure(() => f.service.spheres.withAssetReadingHistories('professional', {}, () => {
        expect(older.next().done).toBe(false); return f.work.assetReadingHistories(pairs);
      }));
      expect(read.value).toEqual(individual(f.work, pairs)); expect(read.sql.find(sphereStreamSql)).toContain('json_valid(');
      expect(read.sql.filter(batchSql)).toEqual([]);
    } finally { older.return(false); }
  });

  it('streams more than 1000 selected assets without extracting fields or joining histories from another sphere', async () => {
    const f = fixture(); f.seedAssets(1601);
    f.db.prepare("UPDATE data_asset SET sphere='personal' WHERE id>'asset-1200'").run();
    const odd = "field-'漢?";
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.rules[0].when.field',?) WHERE id='asset-0500'").run(odd);
    f.seed('asset-0500', odd, sample(8));
    for (let n = 0; n < 145; n++) f.seed('asset-0999', 'meter', sample(n, at - n * 1000, n % 3 ? 'km' : 'mi'));
    f.db.prepare("UPDATE asset_reading_history SET value='{' WHERE asset_id='asset-0999' AND field='meter' AND as_of=?").run(at - 144000);
    const extracted: string[] = [];
    f.db.function('asset_summary_history_fields', { deterministic: true }, (blob: unknown, status: unknown, sync: unknown, deleted: unknown) => {
      const data = JSON.parse(blob as string) as Asset;
      extracted.push(data.attributes.fixture_id as string);
      return JSON.stringify([...new Set(assetSummaryHistoryFields({ ...data, status, sync_state: sync,
        ...(deleted !== null ? { deleted_at: deleted } : {}) } as Asset))]);
    });
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE');
      const assets = f.all().filter(asset => asset.sphere === 'professional');
      const groups = Array.from({ length: Math.ceil(assets.length / 200) }, (_, n) => requestsFor(assets.slice(n * 200, (n + 1) * 200)));
      const expected = groups.map(requests => individual(f.work, requests)); extracted.length = 0;
      const read = await f.measure(() => f.service.spheres.withAssetReadingHistories('professional', {}, () => groups.map(requests => f.work.assetReadingHistories(requests))));
      expect(read.value).toEqual(expected); expect(groups).toHaveLength(7);
      expect(read.sql.filter(sphereStreamSql)).toHaveLength(1); expect(read.sql.filter(batchSql)).toEqual([]);
      expect(extracted).toEqual(assets.map(asset => asset.id));
      expect(read.value.flatMap(map => [...map.values()].flatMap(fields => [...fields.values()])).every(samples => samples.length <= 100)).toBe(true);
      const plans = f.db.prepare(`EXPLAIN QUERY PLAN ${read.sql.find(sphereStreamSql)!}`).all() as Array<{ detail: string }>;
      expect(plans.some(row => /SEARCH history USING INTEGER PRIMARY KEY/u.test(row.detail))).toBe(true);
      expect(plans.some(row => /COVERING INDEX.+asset_id=\? AND field=\?/u.test(row.detail))).toBe(true);
      expect(plans.some(row => /^SCAN (?:history|asset_reading_history)\b/u.test(row.detail))).toBe(false);
      expect(plans.some(row => row.detail === 'USE TEMP B-TREE FOR ORDER BY')).toBe(false);
      expect(plans.some(row => /MATERIALIZE reading_stream_candidates/u.test(row.detail))).toBe(false);
      expect(plans.some(row => /USING INDEX idx_asset_summary_history_order/u.test(row.detail))).toBe(true);
    }
  });

  it('preserves full snapshots, placements and exact logical requests across sphere precedence, filters and pages', async () => {
    const f = fixture(); f.put('parent', { name: 'Ancestor', sphere: 'personal', anchors: [{ kind: 'place', name: 'Home' }] });
    f.work.registerSource({ ...f.work.getSource('recued.asset')!, id: 'jira' });
    f.seedAssets(701);
    f.db.prepare("UPDATE data_asset SET belongs_to='parent',sphere=NULL WHERE id GLOB 'asset-*' AND CAST(substr(id,7) AS INTEGER)%3=0").run();
    f.db.prepare("UPDATE data_asset SET sphere=NULL WHERE id GLOB 'asset-*' AND CAST(substr(id,7) AS INTEGER)%3=1").run();
    f.db.prepare("UPDATE data_asset SET sphere_override='personal' WHERE id GLOB 'asset-*' AND CAST(substr(id,7) AS INTEGER)%11=0").run();
    f.db.prepare("UPDATE data_asset SET source_id='jira' WHERE id GLOB 'asset-*' AND CAST(substr(id,7) AS INTEGER)%13=0").run();
    for (let n = 0; n < 701; n += 7) f.service.spheres.setItem({ collection: 'asset', id: `asset-${String(n).padStart(4, '0')}` }, 'professional');
    for (let n = 1; n < 701; n += 17) f.service.spheres.setSource(`asset:asset-${String(n).padStart(4, '0')}`, 'professional');
    f.db.prepare("UPDATE data_asset SET sync_state='stale_unreachable' WHERE id='asset-0003'").run();
    f.db.prepare("UPDATE data_asset SET status='retired' WHERE id='asset-0004'").run();
    const histories = vi.spyOn(f.work, 'assetReadingHistories');
    for (const asset_sphere of ['personal', 'professional', 'unsorted'] as const) for (const asset_filter of ['missing_facts', 'overdue'] as const)
      for (const offset of [0, 197, 9999]) for (const include_asset_summaries of [false, true]) {
        const request = { asset_sphere, asset_filter, offset, limit: 13, include_asset_summaries, search: 'Fixture asset-' };
        histories.mockClear(); const expected = await f.retained(request); const calls = structuredClone(histories.mock.calls); histories.mockClear();
        const read = await f.measure(() => f.service.snapshot(request));
        expect(read.value).toEqual(expected); expect(histories.mock.calls).toEqual(calls);
        expect(read.sql.filter(sphereStreamSql)).toHaveLength(calls.some(([pairs]) => pairs.length) ? 1 : 0);
        expect(read.sql.filter(batchSql)).toEqual([]);
      }
  });

  it('retains literal Unicode and class searches, quoted identities, raw visibility and stale histories', async () => {
    const f = fixture();
    for (const id of ["asset-'漢?", 'stale', 'deleted', 'hidden', 'retired', 'other-sphere']) f.put(id,
      { name: 'ÉCOLE 100%_[x]? 漢', class_id: 'class_special', sphere: id === 'other-sphere' ? 'personal' : 'professional', status: id === 'retired' ? 'retired' : 'active' });
    f.db.prepare("UPDATE data_asset SET sync_state='stale_unreachable' WHERE id='stale'").run();
    f.db.prepare("UPDATE data_asset SET sync_state='tombstoned' WHERE id='hidden'").run();
    f.db.prepare("UPDATE data_asset SET deleted_at=1 WHERE id='deleted'").run();
    for (const search of [' ÉcOlE ', '%_[x]?', 'CLASS_SPECIAL', 'missing-match']) {
      const request = { asset_sphere: 'professional' as const, asset_filter: 'missing_facts' as const, search, include_asset_summaries: true };
      const expected = await f.retained(request); const read = await f.measure(() => f.service.snapshot(request));
      expect(read.value).toEqual(expected); expect(read.sql.filter(sphereStreamSql)).toHaveLength(expected.total_assets ? 1 : 0);
      expect(read.value.assets.every(asset => !['deleted', 'hidden', 'retired', 'other-sphere'].includes(asset.id))).toBe(true);
    }
  });

  it('opens no history cursor for an empty callback, empty requests, no selected assets or disabled objective fields', async () => {
    const f = fixture(); f.put('target'); const statements = f.capture();
    const empty = await f.measure(() => f.service.spheres.withAssetReadingHistories('professional', {}, () => f.work.assetReadingHistories([])));
    expect(empty.value.size).toBe(0); expect(empty.sql).toEqual([]); expect(statements).toEqual([]);
    expect(f.service.spheres.withAssetReadingHistories('professional', {}, () => 7)).toBe(7); expect(statements).toEqual([]);
    const missing = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'personal' }));
    expect(missing.value.total_assets).toBe(0); expect(missing.sql.filter(streamSql)).toEqual([]);
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.rules',json(?))").run(JSON.stringify([{ ...rule, enabled: false }]));
    const disabled = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional' }));
    expect(disabled.value.total_assets).toBe(0); expect(disabled.sql.filter(streamSql)).toEqual([]);
  });

  it('closes partial cursors and consumer errors and restores nested sphere and unfiltered scopes with custom limits', async () => {
    const f = fixture(); f.seedAssets(401); const assets = f.all(); const first = requestsFor(assets.slice(0, 1)); const later = requestsFor(assets.slice(1, 2));
    const statements = f.capture();
    const read = await f.measure(() => f.work.withAssetReadingHistories({}, () => {
      expect(f.work.assetReadingHistories(first)).toEqual(individual(f.work, first));
      f.service.spheres.withAssetReadingHistories('professional', {}, () => {
        expect(f.work.assetReadingHistories(first, 1)).toEqual(individual(f.work, first, 1));
        expect(f.work.assetReadingHistories(first)).toEqual(individual(f.work, first));
        expect(f.work.readAssetsEffective([assets[0]!.id]).get(assets[0]!.id)?.id).toBe(assets[0]!.id);
      });
      expect(f.work.assetReadingHistories(later)).toEqual(individual(f.work, later));
    }));
    expect(read.sql.filter(streamSql)).toHaveLength(2); expect(read.sql.filter(sphereStreamSql)).toHaveLength(1);
    expect(read.sql.filter(batchSql)).toHaveLength(1); expect(statements.every(statement => !statement.busy)).toBe(true);
    const error = new Error('Fixture synchronous consumer error');
    expect(() => f.service.spheres.withAssetReadingHistories('professional', {}, () => { f.work.assetReadingHistories(first); throw error; })).toThrow(error);
    expect(statements.every(statement => !statement.busy)).toBe(true);
  });

  it('defers custom origins, replacement resolvers and candidates, absent work, and replaced lists to ordinary histories', async () => {
    const f = fixture(); f.put('target'); const requests = [{ asset_id: 'target', field: 'meter' }];
    const origin = vi.fn(() => ({ sphere: 'personal' as const })); const custom = createSphereStore(f.db, f.work, undefined, origin); const absent = createSphereStore(f.db);
    const variants = [custom, absent, { ...f.service.spheres, resolve: vi.fn(f.service.spheres.resolve) },
      { ...f.service.spheres, resolveAssets: vi.fn(f.service.spheres.resolveAssets) },
      { ...f.service.spheres, assetCandidates: vi.fn(f.service.spheres.assetCandidates) }];
    for (const spheres of variants) {
      const read = await f.measure(() => spheres.withAssetReadingHistories('professional', {}, () => f.work.assetReadingHistories(requests)));
      expect(read.value).toEqual(individual(f.work, requests)); expect(read.sql.filter(streamSql)).toEqual([]); expect(read.sql.filter(batchSql)).toHaveLength(1);
    }
    expect(origin).not.toHaveBeenCalled();
    const list = f.work.listByKind; vi.spyOn(f.work, 'listByKind').mockImplementation((kind, query) => list(kind, query));
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional' }));
    expect(read.value.total_assets).toBe(1); expect(read.sql.filter(streamSql)).toEqual([]);
  });

  it('preserves membership through delegating scope and history wrappers, and honors replacement histories', async () => {
    const f = fixture(); f.seedAssets(401); f.db.prepare("UPDATE data_asset SET sphere='personal' WHERE id>'asset-0300'").run();
    const scope = f.work.withAssetReadingHistories; const histories = f.work.assetReadingHistories;
    vi.spyOn(f.work, 'withAssetReadingHistories').mockImplementation((query, read) => scope.call(f.work, query, read));
    const delegated = vi.spyOn(f.work, 'assetReadingHistories').mockImplementation((requests, limit) => histories(requests, limit));
    const read = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional' }));
    expect(delegated).toHaveBeenCalledTimes(2); expect(read.sql.filter(sphereStreamSql)).toHaveLength(1);
    delegated.mockRestore(); vi.spyOn(f.work, 'assetReadingHistories').mockImplementation(requests => individual(f.work, requests as ReturnType<typeof requestsFor>));
    const custom = await f.measure(() => f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional' }));
    expect(custom.value).toEqual(read.value); expect(custom.sql.filter(streamSql)).toEqual([]);
  });

  for (const legacy of ['duplicate-keys', 'cycle', 'null-id'] as const) it(`retains the scan and ordinary histories for ${legacy} without opening a history stream`, async () => {
    const f = fixture(); f.seedAssets(401);
    if (legacy === 'duplicate-keys') {
      const row = f.db.prepare("SELECT data_blob FROM data_asset WHERE id='asset-0200'").get() as { data_blob: string };
      f.db.prepare("UPDATE data_asset SET data_blob=? WHERE id='asset-0200'").run(row.data_blob.replace('"rules":[', '"rules":null,"rules":['));
    } else if (legacy === 'cycle') f.db.prepare("UPDATE data_asset SET belongs_to='asset-0200' WHERE id='asset-0200'").run();
    else f.db.prepare("UPDATE data_asset SET id=NULL WHERE id='asset-0200'").run();
    const request = { asset_filter: 'missing_facts' as const, asset_sphere: 'professional' as const, include_asset_summaries: true, offset: 197, limit: 13 };
    const expected = await f.retained(request); const read = await f.measure(() => f.service.snapshot(request));
    expect(read.value).toEqual(expected); expect(read.sql.filter(streamSql)).toEqual([]); expect(read.sql.filter(batchSql).length).toBeGreaterThan(0);
  });

  for (const corrupt of ['history', 'rules'] as const) it(`isolates later selected corrupt ${corrupt} while ignoring corrupt histories from another sphere`, async () => {
    const f = fixture(); f.seedAssets(601);
    f.db.prepare("UPDATE data_asset SET sphere='personal' WHERE id='asset-0600'").run();
    f.db.prepare("UPDATE asset_reading_history SET value='{' WHERE asset_id='asset-0600'").run();
    if (corrupt === 'history') f.db.prepare("UPDATE asset_reading_history SET value='{' WHERE asset_id='asset-0001' AND field='meter'").run();
    else f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.rules',NULL) WHERE id='asset-0001'").run();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = { asset_filter: 'missing_facts' as const, asset_sphere: 'professional' as const, include_asset_summaries: true, offset: 3, limit: 13 };
    const expected = await f.retained(request); expect(expected.asset_filter?.unavailable).toBe(1);
    const statements = f.capture(); const read = await f.measure(() => f.service.snapshot(request)); expect(read.value).toEqual(expected);
    expect(read.sql.filter(sphereStreamSql)).toHaveLength(1); expect(statements.every(statement => !statement.busy)).toBe(true);
  });

  for (const failure of ['prepare', 'execution', 'later', 'close'] as const) it(`retains complete snapshots after ${failure} history failure`, async () => {
    const f = fixture(); f.seedAssets(601);
    const request = { asset_filter: 'missing_facts' as const, asset_sphere: 'professional' as const, include_asset_summaries: true, offset: 197, limit: 13 };
    const expected = await f.retained(request); const prepare = f.db.prepare.bind(f.db); const statements: Database.Statement[] = []; let failed = false; let closed = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (sphereStreamSql(sql) && failure === 'prepare') { failed = true; throw new Error('Fixture history prepare failure'); }
      const statement = prepare(sql);
      if (sphereStreamSql(sql)) {
        statements.push(statement); const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, 'iterate').mockImplementation((...params) => {
          if (failure === 'execution') { failed = true; throw new Error('Fixture history execution failure'); }
          const cursor = iterate(...params); let reads = 0;
          return { next() { if (failure === 'later' && ++reads === 900) { failed = true; throw new Error('Fixture later history failure'); } return cursor.next(); },
            return() { const result = cursor.return?.() ?? { done: true, value: undefined }; closed++;
              if (failure === 'close') { failed = true; throw new Error('Fixture history close failure'); } return result; }, [Symbol.iterator]() { return this; } };
        });
      }
      return statement;
    });
    const read = await f.measure(() => f.service.snapshot(request)); expect(read.value).toEqual(expected); expect(failed).toBe(true);
    expect(statements.every(statement => !statement.busy)).toBe(true); expect(closed).toBe(failure === 'later' || failure === 'close' ? 1 : 0);
    expect(read.sql.filter(batchSql).length).toBeGreaterThan(0);
    expect(read.sql.filter(sphereCandidateSql)).toHaveLength(failure === 'close' ? 2 : 1);
  });

  it('closes the history scope before a failed candidate stream restarts the retained scan', async () => {
    const f = fixture(); f.seedAssets(601);
    const request = { asset_filter: 'missing_facts' as const, asset_sphere: 'professional' as const, include_asset_summaries: true, offset: 197, limit: 13 };
    const expected = await f.retained(request); const prepare = f.db.prepare.bind(f.db); const statements: Database.Statement[] = [];
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql); if (streamSql(sql) || sphereCandidateSql(sql)) statements.push(statement);
      if (sphereCandidateSql(sql)) {
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, 'iterate').mockImplementation((...params) => {
          const cursor = iterate(...params); let reads = 0;
          return { next() { if (++reads === 201) throw new Error('Fixture later candidate failure'); return cursor.next(); },
            return() { return cursor.return?.() ?? { done: true, value: undefined }; }, [Symbol.iterator]() { return this; } };
        });
      }
      return statement;
    });
    const read = await f.measure(() => f.service.snapshot(request)); expect(read.value).toEqual(expected);
    expect(read.sql.filter(sphereStreamSql)).toHaveLength(1); expect(read.sql.filter(batchSql).length).toBeGreaterThan(0);
    expect(statements.every(statement => !statement.busy)).toBe(true);
  });

  it('preserves a pending point-projection error when history cleanup also fails', async () => {
    const f = fixture(); f.seedAssets(401); const prepare = f.db.prepare.bind(f.db); const statements: Database.Statement[] = [];
    const error = new Error('Fixture original point-projection failure');
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql); if (streamSql(sql) || sphereCandidateSql(sql)) statements.push(statement);
      if (sphereStreamSql(sql)) {
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, 'iterate').mockImplementation((...params) => {
          const cursor = iterate(...params);
          return { next() { return cursor.next(); }, return() { cursor.return?.(); throw new Error('Fixture history cleanup failure'); }, [Symbol.iterator]() { return this; } };
        });
      }
      return statement;
    });
    vi.spyOn(f.work, 'readAssetsEffective').mockImplementation(() => { throw error; }); vi.spyOn(f.work, 'readAssetEffective').mockImplementation(() => { throw error; });
    await expect(f.service.snapshot({ asset_filter: 'missing_facts', asset_sphere: 'professional', limit: 1 })).rejects.toBe(error);
    expect(statements).toHaveLength(2); expect(statements.every(statement => !statement.busy)).toBe(true);
  });

  it('releases both cursors before delivery and sees fresh history and owner membership on the next request', async () => {
    const f = fixture(); f.seedAssets(401);
    const request = { asset_filter: 'overdue' as const, asset_sphere: 'professional' as const, include_asset_summaries: true, limit: 3 };
    const expected = await f.retained(request); const statements = f.capture(); const pause = f.pause(); const pending = f.service.snapshot(request);
    try {
      await pause.entered.promise; expect(statements).toHaveLength(2); expect(statements.every(statement => !statement.busy)).toBe(true);
      f.db.prepare("DELETE FROM asset_reading_history WHERE asset_id='asset-0400'").run(); f.seed('asset-0399', 'meter', sample(49, at - 3 * DAY));
      f.seed('asset-0398', 'fuel', sample(15, at - 4 * DAY, 'L')); f.service.spheres.setItem({ collection: 'asset', id: 'asset-0400' }, 'personal');
      pause.release.resolve(); const first = await pending;
      expect(first.assets).toEqual(expected.assets); expect(first.asset_summaries).toEqual(expected.asset_summaries);
      const later = await f.retained(request); expect(await f.service.snapshot(request)).toEqual(later);
      expect(first.asset_summaries).toEqual(expected.asset_summaries);
    } finally { pause.release.resolve(); await pending; }
  });
});
