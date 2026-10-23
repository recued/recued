import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProactiveProposalInput } from '@recued/contracts';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const input = (key: string): ProactiveProposalInput => ({ key, kind: 'rule', title: key, explanation: '',
  confidence: 'high', origin: 'owner', sources: [], payload: {} });
const fixture = () => {
  let sql: string[] | undefined;
  const db = new Database(':memory:', { verbose: statement => sql?.push(String(statement)) }); databases.push(db);
  const store = createProactiveProposalStore(db);
  const measure = <T>(run: () => T) => { const statements: string[] = []; sql = statements;
    try { return { value: run(), sql: statements }; } finally { sql = undefined; }
  };
  const gone = (key: string) => { const row = store.ensure(input(key), 1); store.delete(row.id); };
  return { db, store, measure, gone };
};
const batches = (sql: string[]) => sql.filter(statement => /^WITH proposal_tombstone_requested\b/u.test(statement));
const points = (sql: string[]) => sql.filter(statement => /^SELECT 1 FROM proactive_proposal_tombstones WHERE dedupe_key=/u.test(statement));
const proposalPoints = (sql: string[]) => sql.filter(statement => /^SELECT value FROM proactive_proposals WHERE dedupe_key=/u.test(statement));

describe('D-325 proposal tombstone prefetch', () => {
  for (const count of [0, 1, 200, 201, 401]) it(`batches ${count} distinct missing keys and consumes each tombstone result once`, () => {
    const f = fixture();
    const keys = Array.from({ length: count }, (_, index) => `key-${index}${index === 0 ? "-'漢😀" : ''}`);
    const prepared = f.measure(() => f.store.prefetchKeys([...keys, ...keys]));
    expect(batches(prepared.sql).map(statement => [...statement.matchAll(/'key-/gu)].length))
      .toEqual(Array.from({ length: Math.ceil(count / 200) }, (_, page) => Math.min(200, count - 200 * page)));
    const first = f.measure(() => keys.map(key => f.store.ensure(input(key), 2, prepared.value)));
    expect(points(first.sql)).toEqual([]); expect(proposalPoints(first.sql)).toEqual([]);
    expect(first.value.map(row => row.key)).toEqual(keys); expect(first.value.every(row => row.state === 'proposed')).toBe(true);
    const warm = f.measure(() => f.store.prefetchKeys(keys)); expect(batches(warm.sql)).toEqual([]);
    expect(f.measure(() => keys.map(key => f.store.ensure(input(key), 3, warm.value))).value).toEqual(first.value);
    expect(f.store.list({ limit: 10000 })).toHaveLength(count);
  });

  it('checks only absent proposals and preserves live rows, deleted and forgotten tombstones', () => {
    const f = fixture(); const live = f.store.ensure(input('live'), 1);
    f.db.prepare('INSERT INTO proactive_proposal_tombstones VALUES(?,?)').run('live', 1);
    f.gone('deleted'); const forgotten = f.store.ensure(input('forgotten'), 1); f.store.forget(forgotten.id, 2);
    const prepared = f.measure(() => f.store.prefetchKeys(['live', 'deleted', 'forgotten', 'new']));
    expect(batches(prepared.sql)).toHaveLength(1); expect(batches(prepared.sql)[0]).not.toContain("'live'");
    const rows = f.measure(() => ['live', 'deleted', 'forgotten', 'new'].map(key => f.store.ensure(input(key), 3, prepared.value)));
    expect(points(rows.sql)).toEqual([]); expect(proposalPoints(rows.sql)).toEqual([]);
    expect(rows.value[0]).toEqual(live);
    for (const row of rows.value.slice(1, 3)) {
      expect(row).toMatchObject({ state: 'dismissed', dismissal: 'not_this_one' });
      expect(row.id).toMatch(/^deleted-proposal-/u); expect(f.store.byKey(row.key)).toBeNull();
    }
    expect(rows.value[3]?.state).toBe('proposed');
    expect(rows.sql.filter(statement => /^(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(statement))).toHaveLength(2);
  });

  for (const tombstoned of [false, true]) it(`uses fresh tombstones after consuming a ${tombstoned ? 'deleted' : 'missing'} key`, () => {
    const f = fixture(); if (tombstoned) f.gone('key');
    const lookup = f.store.prefetchKeys(['key']);
    const first = f.measure(() => f.store.ensure(input('key'), 2, lookup)); expect(points(first.sql)).toEqual([]);
    if (tombstoned) f.store.pruneTombstones(() => true); else f.store.delete(first.value.id);
    const repeated = f.measure(() => f.store.ensure(input('key'), 3, lookup));
    expect(points(repeated.sql)).toHaveLength(1); expect(proposalPoints(repeated.sql)).toHaveLength(1);
    expect(repeated.value.state).toBe(tombstoned ? 'proposed' : 'dismissed');
  });

  for (const tombstoned of [false, true]) it(`does not reuse tombstone metadata after direct consumption with tombstoned=${tombstoned}`, () => {
    const f = fixture(); if (tombstoned) f.gone('key');
    const lookup = f.store.prefetchKeys(['key']); expect(lookup?.('key')).toBeNull();
    if (!tombstoned) f.gone('key');
    const result = f.measure(() => f.store.ensure(input('key'), 3, lookup));
    expect(points(result.sql)).toHaveLength(1); expect(result.value.state).toBe('dismissed');
  });

  for (const mode of ['callback', 'other-store', 'other-database'] as const) it(`keeps current point checks for a ${mode} reader`, () => {
    const f = fixture(); f.gone('key');
    const lookup = mode === 'callback' ? () => null
      : mode === 'other-store' ? createProactiveProposalStore(f.db).prefetchKeys(['key']) : fixture().store.prefetchKeys(['key']);
    const result = f.measure(() => f.store.ensure(input('key'), 3, lookup));
    expect(points(result.sql)).toHaveLength(1); expect(result.value.state).toBe('dismissed');
  });

  it('validates before consuming tombstone metadata', () => {
    const f = fixture(); f.gone('key'); const lookup = f.store.prefetchKeys(['key']);
    expect(() => f.store.ensure({ ...input('key'), title: '' }, 2, lookup)).toThrow('Invalid or oversized proposal');
    const result = f.measure(() => f.store.ensure(input('key'), 3, lookup));
    expect(points(result.sql)).toEqual([]); expect(proposalPoints(result.sql)).toEqual([]); expect(result.value.state).toBe('dismissed');
  });

  for (const value of ['null', 'false']) it(`retains point checks for a stored legacy ${value} proposal`, () => {
    const f = fixture(); const row = f.store.ensure(input('key'), 1);
    f.db.prepare('UPDATE proactive_proposals SET value=? WHERE id=?').run(value, row.id);
    f.db.prepare('INSERT INTO proactive_proposal_tombstones VALUES(?,?)').run('key', 1);
    const prepared = f.measure(() => f.store.prefetchKeys(['key'])); expect(batches(prepared.sql)).toEqual([]);
    const result = f.measure(() => f.store.ensure(input('key'), 2, prepared.value));
    expect(points(result.sql)).toHaveLength(1); expect(result.value.state).toBe('dismissed');
  });

  it('retains the proposal prefetch and defers failed tombstone preparation to fresh point checks', () => {
    const f = fixture(); const live = f.store.ensure(input('live'), 1);
    f.db.exec('DROP TABLE proactive_proposal_tombstones');
    const lookup = f.store.prefetchKeys(['live', 'key']);
    expect(f.store.ensure(input('live'), 2, lookup)).toEqual(live);
    f.db.exec('CREATE TABLE proactive_proposal_tombstones (dedupe_key TEXT PRIMARY KEY,at INTEGER NOT NULL)');
    f.db.prepare('INSERT INTO proactive_proposal_tombstones VALUES(?,?)').run('key', 1);
    const result = f.measure(() => f.store.ensure(input('key'), 3, lookup));
    expect(proposalPoints(result.sql)).toEqual([]); expect(points(result.sql)).toHaveLength(1); expect(result.value.state).toBe('dismissed');
  });

  for (const failure of ['prepare', 'execution'] as const) for (const tombstoned of [false, true]) {
    it(`discards earlier tombstone metadata after a later ${failure} failure with tombstoned=${tombstoned}`, () => {
      const f = fixture(); const keys = Array.from({ length: 201 }, (_, index) => `key-${index}`);
      if (tombstoned) f.gone(keys[0]!);
      const prepare = f.db.prepare.bind(f.db); let attempts = 0;
      const spy = vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
        if (/^WITH proposal_tombstone_requested\b/u.test(sql) && ++attempts === 2) {
          if (failure === 'prepare') throw new Error('Fixture later tombstone failure');
          const statement = prepare(sql);
          vi.spyOn(statement, 'all').mockImplementationOnce(() => { throw new Error('Fixture later tombstone failure'); }); return statement;
        }
        return prepare(sql);
      });
      let lookup: ReturnType<typeof f.store.prefetchKeys>;
      try { lookup = f.store.prefetchKeys(keys); expect(attempts).toBe(2); } finally { spy.mockRestore(); }
      if (tombstoned) f.store.pruneTombstones(() => true); else f.gone(keys[0]!);
      const result = f.measure(() => f.store.ensure(input(keys[0]!), 3, lookup));
      expect(proposalPoints(result.sql)).toEqual([]); expect(points(result.sql)).toHaveLength(1);
      expect(result.value.state).toBe(tombstoned ? 'proposed' : 'dismissed');
    });
  }

  for (const tombstoned of [false, true]) it(`keeps missing tombstone rows unknown with tombstoned=${tombstoned}`, () => {
    const f = fixture(); if (tombstoned) f.gone('missing');
    const prepare = f.db.prepare.bind(f.db);
    const spy = vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      if (/^WITH proposal_tombstone_requested\b/u.test(sql)) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementationOnce((...args) => (all(...args) as Array<{ dedupe_key: string }>)
          .filter(row => row.dedupe_key !== 'missing'));
      }
      return statement;
    });
    let lookup: ReturnType<typeof f.store.prefetchKeys>;
    try { lookup = f.store.prefetchKeys(['known', 'missing']); } finally { spy.mockRestore(); }
    const result = f.measure(() => f.store.ensure(input('missing'), 2, lookup));
    expect(proposalPoints(result.sql)).toEqual([]); expect(points(result.sql)).toHaveLength(1);
    expect(result.value.state).toBe(tombstoned ? 'dismissed' : 'proposed');
    const known = f.measure(() => f.store.ensure(input('known'), 2, lookup));
    expect(points(known.sql)).toEqual([]); expect(known.value.state).toBe('proposed');
  });

  for (const tombstoned of [false, true]) it(`retains fresh point checks for bigint tombstone results with tombstoned=${tombstoned}`, () => {
    const f = fixture(); if (tombstoned) f.gone('key'); f.db.defaultSafeIntegers(true);
    const prepared = f.measure(() => f.store.prefetchKeys(['key'])); expect(batches(prepared.sql)).toHaveLength(1);
    if (tombstoned) f.store.pruneTombstones(() => true); else f.gone('key');
    const result = f.measure(() => f.store.ensure(input('key'), 3, prepared.value));
    expect(proposalPoints(result.sql)).toEqual([]); expect(points(result.sql)).toHaveLength(1);
    expect(result.value.state).toBe(tombstoned ? 'proposed' : 'dismissed');
  });

  it('keeps unrequested keys fresh without consuming a requested miss', () => {
    const f = fixture(); f.gone('other'); const lookup = f.store.prefetchKeys(['key']);
    const other = f.measure(() => f.store.ensure(input('other'), 2, lookup));
    expect(points(other.sql)).toHaveLength(1); expect(other.value.state).toBe('dismissed');
    const requested = f.measure(() => f.store.ensure(input('key'), 3, lookup));
    expect(points(requested.sql)).toEqual([]); expect(requested.value.state).toBe('proposed');
  });
});
