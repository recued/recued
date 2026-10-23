import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetCreateInput, AssetReading, AssetRule } from '@recued/contracts';
import { assetSummaryHistoryFields, createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createSphereStore } from '../storage/sphere-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';

const at = Date.parse('2026-10-17T12:00Z');
const rule: AssetRule = { id: 'usage', title: 'Service', enabled: true, muted: true, pinned: false, consequence: 'routine', expiry_policy: 'escalate_overdue',
  when: { kind: 'objective', field: 'meter', target: 100, unit: 'km', direction: 'rising', mode: 'usage', lead_days: 0 },
  reaction: { notify: false, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true } };
const sample = (value: number, as_of = at): AssetReading => ({ value, unit: 'km', as_of, evidence: [] });
type FieldRow = { id: string; data_blob: string; status: string; sync_state: string; deleted_at: number | null };
type Mode = 'raw' | 'sphere';
const databases: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
const fixture = () => {
  const sql: string[] = []; const db = new Database(':memory:', { verbose(text) { sql.push(String(text)); } }); databases.push(db);
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const spheres = createSphereStore(db, work);
  const put = (id: string, patch: Partial<AssetCreateInput> = {}, time = at) => work.writeAsset({
    id, name: `Fixture ${id}`, source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, sphere: 'professional',
    attributes: { fixture_id: id }, readings: { meter: null, fuel: null },
    rules: [rule, { ...rule, id: 'duplicate' }, { ...rule, id: 'fuel', when: { ...rule.when, field: 'fuel' } }], ...patch,
  }, time);
  const seed = (size: number) => db.transaction(() => { for (let n = 0; n < size; n++) {
    const id = `asset-${String(n).padStart(4, '0')}`; put(id, {}, at + n);
    for (const field of ['meter', 'fuel']) db.prepare('INSERT INTO asset_reading_history(asset_id,field,as_of,value) VALUES(?,?,?,?)')
      .run(id, field, at, JSON.stringify(sample(n)));
  } })();
  const rows = () => db.prepare('SELECT id,data_blob,status,sync_state,deleted_at FROM data_asset ORDER BY updated_at DESC,id ASC').all() as FieldRow[];
  const fields = (row: FieldRow, patch: Partial<FieldRow> = {}) => {
    const value = { ...row, ...patch };
    return (db.prepare('SELECT asset_summary_history_fields(?,?,?,?) AS fields')
      .get(value.data_blob, value.status, value.sync_state, value.deleted_at) as { fields: string }).fields;
  };
  const countParses = () => {
    const blobs = new Set(rows().map(row => row.data_blob)); const calls: string[] = []; const parse = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (blobs.has(text)) calls.push(text);
      return parse(text, reviver);
    });
    return { calls, spy };
  };
  const scope = <T>(mode: Mode, read: () => T): T => mode === 'raw' ? work.withAssetReadingHistories({}, read)
    : spheres.withAssetReadingHistories('professional', {}, read);
  const candidates = (mode: Mode) => mode === 'raw' ? work.assetCandidates()! : spheres.assetCandidates('professional')!;
  return { db, work, spheres, put, seed, rows, fields, countParses, scope, candidates, sql };
};
const requestsFor = (assets: readonly Asset[]) => assets.flatMap(asset => assetSummaryHistoryFields(asset)
  .map(field => ({ asset_id: asset.id, field })));
const individual = (work: ReturnType<typeof createWorkEntityStore>, requests: ReturnType<typeof requestsFor>) => {
  const result = new Map<string, Map<string, AssetReading[]>>();
  for (const { asset_id, field } of requests) {
    let fields = result.get(asset_id); if (!fields) { fields = new Map(); result.set(asset_id, fields); }
    fields.set(field, work.assetReadingHistory(asset_id, field));
  }
  return result;
};

describe('parsed objective fields in native candidate batches', () => {
  for (const mode of ['raw', 'sphere'] as const) {
    it(`reuses ${mode} fields across more than 1000 assets without changing histories or sample limits`, () => {
      const f = fixture(); f.seed(1001);
      for (let n = 1; n <= 145; n++) f.db.prepare('INSERT INTO asset_reading_history(asset_id,field,as_of,value) VALUES(?,?,?,?)')
        .run('asset-0999', 'meter', at - n, JSON.stringify(sample(n, at - n)));
      const groups = Array.from({ length: 6 }, (_, n) => requestsFor(f.work.listAssets({ limit: 200, offset: n * 200 })));
      const expected = groups.map(requests => individual(f.work, requests)); const parses = f.countParses(); f.sql.length = 0;
      const actual = f.scope(mode, () => {
        const cursor = f.candidates(mode); const histories = [];
        try { for (const batch of cursor) histories.push(f.work.assetReadingHistories(requestsFor(batch.assets))); }
        finally { cursor.return(false); }
        return histories;
      });
      expect(actual).toEqual(expected); expect(parses.calls.length).toBeGreaterThanOrEqual(1001); expect(parses.calls.length).toBeLessThan(1100);
      expect(f.sql.filter(text => /\breading_stream_candidates AS\b/u.test(text))).toHaveLength(1);
      expect(f.sql.some(text => /^WITH reading_requested\b/u.test(text))).toBe(false);
      const samples = actual.flatMap(map => [...map.values()].flatMap(fields => [...fields.values()]));
      expect(Math.max(...samples.map(history => history.length))).toBe(100); expect(samples[0]![0]).not.toBe(samples[1]![0]);
      parses.calls.length = 0; f.fields(f.rows()[0]!); expect(parses.calls).toHaveLength(1);
    });

    it(`retains only the current ${mode} batch and matches the exact blob and status columns`, () => {
      const f = fixture(); f.seed(401); const rows = f.rows(); const parses = f.countParses();
      f.scope(mode, () => {
        const cursor = f.candidates(mode);
        try {
          const first = cursor.next(); if (first.done) throw new Error('Missing first batch');
          first.value.assets[0]!.rules.length = 0; // Consumer mutation must not change the stored field projection.
          parses.calls.length = 0;
          expect(rows.map(row => f.fields(row))).toEqual(rows.map(() => '["meter","fuel"]'));
          expect(parses.calls).toHaveLength(201);
          parses.calls.length = 0;
          expect(f.fields(rows[0]!)).toBe('["meter","fuel"]'); expect(parses.calls).toHaveLength(0);
          for (const patch of [{ status: 'retired' }, { sync_state: 'tombstoned' }, { deleted_at: 1 }]) expect(f.fields(rows[0]!, patch)).toBe('[]');
          expect(parses.calls).toHaveLength(3);
          expect(f.fields(rows[0]!, { data_blob: `${rows[0]!.data_blob} ` })).toBe('["meter","fuel"]');
          expect(cursor.next().done).toBe(false); parses.calls.length = 0;
          f.fields(rows[0]!); expect(parses.calls).toHaveLength(1);
          f.fields(rows[200]!); expect(parses.calls).toHaveLength(1);
        } finally { cursor.return(false); }
        parses.calls.length = 0; f.fields(rows[200]!); expect(parses.calls).toHaveLength(1);
      });
    });
    it(`checks status again when identical ${mode} blobs cross batch boundaries`, () => {
      const f = fixture(); f.seed(401); const blob = f.rows()[0]!.data_blob;
      f.db.prepare("UPDATE data_asset SET data_blob=?,status=CASE WHEN id='asset-0000' THEN 'lent' WHEN id<='asset-0200' THEN 'retired' ELSE 'active' END").run(blob);
      const rows = f.rows(); const parses = f.countParses();
      f.scope(mode, () => {
        const cursor = f.candidates(mode);
        try {
          expect(cursor.next().done).toBe(false); parses.calls.length = 0;
          expect(f.fields(rows[0]!)).toBe('["meter","fuel"]'); expect(parses.calls).toHaveLength(0);
          expect(cursor.next().done).toBe(false); parses.calls.length = 0;
          expect(f.fields(rows[200]!)).toBe('[]'); expect(parses.calls).toHaveLength(0);
          expect(f.fields(rows[0]!)).toBe('["meter","fuel"]'); expect(parses.calls).toHaveLength(1);
          expect(cursor.next().done).toBe(false); parses.calls.length = 0;
          expect(f.fields(rows[400]!)).toBe('["meter","fuel"]'); expect(parses.calls).toHaveLength(0);
          expect(f.fields(rows[200]!)).toBe('[]'); expect(parses.calls).toHaveLength(1);
        } finally { cursor.return(false); }
      });
    });

    for (const failure of ['next', 'return'] as const) it(`clears the current fields when the ${mode} candidate cursor's ${failure} fails`, () => {
      const f = fixture(); f.seed(401); const row = f.rows()[0]!; const parses = f.countParses();
      const error = new Error('Fixture candidate cursor failure'); const prepare = f.db.prepare.bind(f.db);
      const statements: Database.Statement[] = []; let closed = 0;
      vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
        const statement = prepare(sql);
        if (mode === 'raw' ? /^SELECT \* FROM data_asset\b/u.test(sql) : sql.includes('asset_sphere_candidates AS')) {
          statements.push(statement); const iterate = statement.iterate.bind(statement);
          vi.spyOn(statement, 'iterate').mockImplementation((...params) => {
            const cursor = iterate(...params); let steps = 0;
            return {
              next() { if (failure === 'next' && ++steps === 201) throw error; return cursor.next(); },
              return() { closed++; const result = cursor.return?.() ?? { done: true, value: undefined }; if (failure === 'return') throw error; return result; },
              [Symbol.iterator]() { return this; },
            };
          });
        }
        return statement;
      });
      f.scope(mode, () => {
        const cursor = f.candidates(mode);
        try {
          expect(cursor.next().done).toBe(false); parses.calls.length = 0;
          f.fields(row); expect(parses.calls).toHaveLength(0);
          expect(() => failure === 'next' ? cursor.next() : cursor.return(false)).toThrow(error);
          parses.calls.length = 0; f.fields(row); expect(parses.calls).toHaveLength(1);
        } finally { cursor.return(false); }
      });
      expect(statements).toHaveLength(1); expect(closed).toBeGreaterThanOrEqual(1);
      expect(statements.every(statement => !statement.busy)).toBe(true);
    });
  }

  it('preserves unsupported legacy sentinels, SQL overlays, blob deletion flags and kind exclusions', () => {
    const f = fixture(); f.seed(10); const original = f.rows()[0]!.data_blob;
    const blobs = ['null', ' \nnull ', '[]', '7', '"text"', '{"rules":null}', '{"_kind":"note","rules":null}',
      '{"rules":[{"enabled":true,"when":{"kind":"objective","field":4}}]}',
      JSON.stringify({ ...JSON.parse(original), status: 'retired', sync_state: 'tombstoned' }), JSON.stringify({ ...JSON.parse(original), deleted_at: 1 })];
    const update = f.db.prepare('UPDATE data_asset SET data_blob=?,status=? WHERE id=?');
    blobs.forEach((blob, n) => update.run(blob, n < 5 ? 'retired' : 'active', `asset-${String(n).padStart(4, '0')}`));
    const rows = f.rows(); const expected = rows.map(row => f.fields(row));
    expect(expected).toEqual(['[]', '["meter","fuel"]', 'null', '[]', 'null', '[]', '[]', '[]', 'null', 'null']);
    const parses = f.countParses(); f.work.withAssetReadingHistories({}, () => {
      const cursor = f.work.assetCandidates()!;
      try {
        const batch = cursor.next(); if (batch.done) throw new Error('Missing legacy batch');
        expect(batch.value.assets.some(asset => asset.id === 'asset-0006')).toBe(false);
        parses.calls.length = 0; expect(rows.map(row => f.fields(row))).toEqual(expected);
        expect(parses.calls).toHaveLength(6); // Nonobjects and the excluded kind use the original decoder.
      } finally { cursor.return(false); }
    });
  });

  it('does not mix identical blobs with different SQL status values', () => {
    const f = fixture(); f.seed(3); const blob = f.rows()[0]!.data_blob;
    f.db.prepare('UPDATE data_asset SET data_blob=?').run(blob);
    f.db.prepare("UPDATE data_asset SET status='retired' WHERE id='asset-0001'").run();
    const rows = f.rows(); const expected = rows.map(row => f.fields(row));
    f.work.withAssetReadingHistories({}, () => {
      const cursor = f.work.assetCandidates()!;
      try { expect(cursor.next().done).toBe(false); expect(rows.map(row => f.fields(row))).toEqual(expected); }
      finally { cursor.return(false); }
    });
    expect(expected).toEqual(['["meter","fuel"]', '[]', '["meter","fuel"]']);
  });

  it('retains the ordinary decoder for legacy JSON stored as a SQLite blob', () => {
    const f = fixture(); f.seed(3); const original = f.rows()[0]!;
    f.db.prepare('UPDATE data_asset SET data_blob=? WHERE id=?').run(Buffer.from(original.data_blob), original.id);
    const row = f.rows()[0]!; expect(Buffer.isBuffer(row.data_blob)).toBe(true); const expected = f.fields(row);
    f.work.withAssetReadingHistories({}, () => {
      const cursor = f.work.assetCandidates()!;
      try { expect(cursor.next().done).toBe(false); expect(f.fields(row)).toBe(expected); }
      finally { cursor.return(false); }
    });
    expect(expected).toBe('["meter","fuel"]');
  });

  it('masks and restores outer batches across nested readers and stores on the same connection', () => {
    const f = fixture(); f.seed(201); const other = createWorkEntityStore(f.db); const row = f.rows()[0]!; const parses = f.countParses();
    f.work.withAssetReadingHistories({}, () => {
      const outer = f.work.assetCandidates()!;
      try {
        outer.next(); parses.calls.length = 0; f.fields(row); expect(parses.calls).toHaveLength(0);
        other.withAssetReadingHistories({}, () => {
          f.fields(row); expect(parses.calls).toHaveLength(1);
          const inner = other.assetCandidates()!;
          try { inner.next(); parses.calls.length = 0; f.fields(row); expect(parses.calls).toHaveLength(0); }
          finally { inner.return(false); }
        });
        parses.calls.length = 0; f.fields(row); expect(parses.calls).toHaveLength(0);
        f.work.withAssetReadingHistories({}, () => { f.fields(row); expect(parses.calls).toHaveLength(1); });
        parses.calls.length = 0; f.fields(row); expect(parses.calls).toHaveLength(0);
      } finally { outer.return(false); }
    });
    f.fields(row); expect(parses.calls).toHaveLength(1);
  });

  it('does not revive an outer reader closed while another store has the active scope', () => {
    const f = fixture(); f.seed(401); const other = createWorkEntityStore(f.db); const rows = f.rows(); const parses = f.countParses();
    f.work.withAssetReadingHistories({}, () => {
      const outer = f.work.assetCandidates()!;
      try {
        outer.next();
        other.withAssetReadingHistories({}, () => {
          expect(f.work.assetReadingHistories([{ asset_id: rows[0]!.id, field: 'non-rule' }]).get(rows[0]!.id)?.get('non-rule')).toEqual([]);
        });
        parses.calls.length = 0; f.fields(rows[0]!); expect(parses.calls).toHaveLength(1);
        outer.next(); parses.calls.length = 0; f.fields(rows[200]!); expect(parses.calls).toHaveLength(1);
      } finally { outer.return(false); }
    });
  });

  it('binds generators to their constructing scope and prevents older cursors from clearing a newer batch', () => {
    const f = fixture(); f.seed(201); const row = f.rows()[0]!; const parses = f.countParses();
    const outside = f.work.assetCandidates()!; let expired: ReturnType<typeof f.candidates> | undefined;
    f.work.withAssetReadingHistories({}, () => {
      try {
        outside.next(); parses.calls.length = 0; f.fields(row); expect(parses.calls).toHaveLength(1);
        expired = f.work.assetCandidates()!;
      } finally { outside.return(false); }
    });
    f.work.withAssetReadingHistories({}, () => {
      const older = f.work.assetCandidates()!; const newer = f.work.assetCandidates()!;
      try {
        expired!.next(); parses.calls.length = 0; f.fields(row); expect(parses.calls).toHaveLength(1);
        older.next(); newer.next(); older.return(false); expired!.return(false);
        parses.calls.length = 0; f.fields(row); expect(parses.calls).toHaveLength(0);
      } finally { older.return(false); newer.return(false); expired!.return(false); }
    });
  });

  it('masks outer fields for replaced list implementations and honors a replacement SQL function', () => {
    const f = fixture(); f.seed(3); const row = f.rows()[0]!; const parses = f.countParses();
    f.work.withAssetReadingHistories({}, () => {
      const cursor = f.work.assetCandidates()!;
      try {
        cursor.next(); const list = f.work.listByKind;
        f.work.listByKind = (kind, query) => list(kind, query);
        try { f.work.withAssetReadingHistories({}, () => { parses.calls.length = 0; f.fields(row); expect(parses.calls).toHaveLength(1); }); }
        finally { f.work.listByKind = list; }
        parses.calls.length = 0; f.fields(row); expect(parses.calls).toHaveLength(0);
        f.db.function('asset_summary_history_fields', { deterministic: true }, (_blob: unknown, _status: unknown, _sync: unknown, _deleted: unknown) => '["custom"]');
        expect(f.fields(row)).toBe('["custom"]');
      } finally { cursor.return(false); }
    });
  });

  for (const failure of ['prepare', 'return', 'consumer'] as const) it(`clears parsed fields before ${failure === 'return' ? 'ordinary replay' : 'leaving a failed read'} (${failure})`, () => {
    const f = fixture(); f.seed(401); const row = f.rows()[0]!; const parses = f.countParses(); const prepare = f.db.prepare.bind(f.db);
    const statements: Database.Statement[] = []; const error = new Error('Fixture original consumer failure'); let visits = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (/\breading_stream_candidates AS\b/u.test(sql) && failure === 'prepare') throw new Error('Fixture stream prepare failure');
      const statement = prepare(sql);
      if (/\breading_stream_candidates AS\b/u.test(sql)) {
        statements.push(statement); const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, 'iterate').mockImplementation((...params) => {
          const cursor = iterate(...params);
          return { next() { return cursor.next(); }, return() { cursor.return?.(); throw new Error('Fixture stream cleanup failure'); }, [Symbol.iterator]() { return this; } };
        });
      }
      return statement;
    });
    const read = () => f.work.withAssetReadingHistories({}, () => {
      visits++; const cursor = f.work.assetCandidates()!;
      try {
        const batch = cursor.next(); if (batch.done) throw new Error('Missing first batch');
        parses.calls.length = 0; f.fields(row); expect(parses.calls).toHaveLength(visits === 1 ? 0 : 1);
        expect(f.work.assetReadingHistories(requestsFor(batch.value.assets))).toEqual(individual(f.work, requestsFor(batch.value.assets)));
        if (failure === 'prepare') { parses.calls.length = 0; f.fields(row); expect(parses.calls).toHaveLength(1); }
        if (failure === 'consumer') throw error;
        return 'complete';
      } finally { cursor.return(false); }
    });
    if (failure === 'consumer') expect(read).toThrow(error); else expect(read()).toBe('complete');
    expect(visits).toBe(failure === 'return' ? 2 : 1); expect(statements.every(statement => !statement.busy)).toBe(true);
    parses.calls.length = 0; f.fields(row); expect(parses.calls).toHaveLength(1);
  });

  it('observes changed fields on the next request after the synchronous scope ends', async () => {
    const f = fixture(); f.seed(3); const row = f.rows()[0]!; const parses = f.countParses();
    f.work.withAssetReadingHistories({}, () => {
      const cursor = f.work.assetCandidates()!;
      try { cursor.next(); parses.calls.length = 0; expect(f.fields(row)).toBe('["meter","fuel"]'); expect(parses.calls).toHaveLength(0); }
      finally { cursor.return(false); }
    });
    await Promise.resolve(); parses.calls.length = 0; f.fields(row); expect(parses.calls).toHaveLength(1);
    f.db.prepare("UPDATE data_asset SET data_blob=json_set(data_blob,'$.rules[0].when.field','changed') WHERE id=?").run(row.id);
    const updated = f.rows()[0]!;
    f.work.withAssetReadingHistories({}, () => {
      const cursor = f.work.assetCandidates()!;
      try { cursor.next(); expect(f.fields(updated)).toBe('["changed","meter","fuel"]'); }
      finally { cursor.return(false); }
    });
  });
});
