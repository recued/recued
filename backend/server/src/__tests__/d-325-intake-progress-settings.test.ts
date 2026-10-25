import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssetIntake } from '../situations/asset-intake.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createMailFactStore } from '../storage/mail-fact-store.js';

const databases: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
const defaults = () => ({ receipts_found: 0, likely_assets: 0, last_scan_at: null as number | null });
const pointSql = (sql: string) => /^SELECT value FROM proactive_intake_settings WHERE key=/u.test(sql);
const batchSql = (sql: string) => /^SELECT key,value FROM proactive_intake_settings WHERE key IN/u.test(sql);
const fixture = (withMail = false) => {
  let measured: string[] | undefined;
  const db = new Database(':memory:', { verbose(sql) { if (measured && typeof sql === 'string') measured.push(sql); } });
  databases.push(db); const proposals = createProactiveProposalStore(db); const mail = createMailFactStore(db);
  const intake = createAssetIntake({ db, proposals, ...(withMail ? { mailFacts: mail } : {}) });
  const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const measure = <T>(read: () => T) => {
    const before = changes(); const sql: string[] = []; let value: T; measured = sql;
    try { value = read(); } finally { measured = undefined; }
    return { value, sql, changes: changes() - before };
  };
  const expected = () => ({ emails_read: 0, receipts_found: proposals.setting('receipts_found', 0),
    likely_assets: proposals.setting('likely_assets', 0), last_scan_at: proposals.setting<number | null>('last_scan_at', null) });
  return { db, proposals, mail, intake, measure, expected };
};
const errorFrom = (read: () => unknown): Error => {
  try { read(); } catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error('Expected the read to fail');
};

describe('batched intake progress settings', () => {
  it('uses one settings SELECT and zero writes for each progress read', () => {
    const f = fixture();
    for (let round = 0; round < 2; round++) {
      const read = f.measure(() => f.intake.progress());
      expect(read.value).toEqual({ emails_read: 0, ...defaults() });
      expect(read.sql).toHaveLength(1); expect(read.sql.filter(batchSql)).toHaveLength(1);
      expect(read.sql.filter(pointSql)).toEqual([]); expect(read.changes).toBe(0);
    }
  });

  it('preserves absent keys, stored values, explicit nulls and other JSON values', () => {
    const f = fixture();
    for (const values of [{}, { receipts_found: 19, likely_assets: 3, last_scan_at: 12345 },
      { receipts_found: null, likely_assets: null, last_scan_at: null },
      { receipts_found: false, likely_assets: '', last_scan_at: 0 }]) {
      f.db.prepare('DELETE FROM proactive_intake_settings').run();
      for (const [key, value] of Object.entries(values)) f.proposals.setSetting(key, value);
      const expected = f.expected(); const read = f.measure(() => f.intake.progress());
      expect(read.value).toEqual(expected); expect(read.sql).toHaveLength(1); expect(read.changes).toBe(0);
    }
  });

  it('reads edits, deletions and forgotten intake on the next call without caching', () => {
    const f = fixture(); f.proposals.setSetting('receipts_found', 8); f.proposals.setSetting('likely_assets', 2);
    f.proposals.setSetting('last_scan_at', 100);
    const first = f.intake.progress();
    f.proposals.setSetting('receipts_found', 12); f.db.prepare('DELETE FROM proactive_intake_settings WHERE key=?').run('last_scan_at');
    expect(f.intake.progress()).toEqual({ emails_read: 0, receipts_found: 12, likely_assets: 2, last_scan_at: null });
    f.intake.forget(); expect(f.intake.progress()).toEqual({ emails_read: 0, ...defaults() });
    expect(first).toEqual({ emails_read: 0, receipts_found: 8, likely_assets: 2, last_scan_at: 100 });
  });

  it('retains the email count and reads its updates with the batched progress values', () => {
    const f = fixture(true);
    const put = (id: string, read_at: number | null) => f.mail.saveEmailLedger({ email: { slug: 'fixture', record_id: id },
      fingerprint: id, labels: [], read_at, news: false, skipped: null, counted: [] });
    put('read', 1); put('unread', null); f.proposals.setSetting('receipts_found', 5);
    const first = f.measure(() => f.intake.progress());
    expect(first.value).toEqual({ emails_read: 1, receipts_found: 5, likely_assets: 0, last_scan_at: null });
    expect(first.sql).toHaveLength(2); expect(first.sql.filter(batchSql)).toHaveLength(1); expect(first.changes).toBe(0);
    put('unread', 2); expect(f.intake.progress().emails_read).toBe(2);
  });

  it('keeps customized setting calls in order with their receiver and intervening edits', () => {
    const f = fixture(); const native = f.proposals.setting; const calls: string[] = [];
    f.proposals.setting = function<T>(this: typeof f.proposals, key: string, fallback: T): T {
      expect(this).toBe(f.proposals); calls.push(key); const value = native(key, fallback);
      if (key === 'receipts_found') this.setSetting('likely_assets', 9);
      return value;
    };
    const read = f.measure(() => f.intake.progress());
    expect(read.value).toEqual({ emails_read: 0, receipts_found: 0, likely_assets: 9, last_scan_at: null });
    expect(calls).toEqual(Object.keys(defaults())); expect(read.sql.filter(pointSql)).toHaveLength(3);
    expect(read.sql.filter(batchSql)).toEqual([]);
  });

  it('does not invoke customized setting getters while checking for the native reader', () => {
    const f = fixture(); const native = f.proposals.setting; const calls: string[] = [];
    Object.defineProperty(f.proposals, 'setting', { configurable: true, get() {
      calls.push('get');
      return function<T>(this: typeof f.proposals, key: string, fallback: T): T {
        expect(this).toBe(f.proposals); calls.push(key); return native(key, fallback);
      };
    } });
    const read = f.measure(() => f.intake.progress());
    expect(read.value).toEqual({ emails_read: 0, ...defaults() });
    expect(calls).toEqual(['get', 'receipts_found', 'get', 'likely_assets', 'get', 'last_scan_at']);
    expect(read.sql.filter(pointSql)).toHaveLength(3); expect(read.sql.filter(batchSql)).toEqual([]);
  });

  it('retains the point path for a legacy store without a batch method', () => {
    const f = fixture(); Object.defineProperty(f.proposals, 'settings', { value: undefined });
    const read = f.measure(() => f.intake.progress());
    expect(read.value).toEqual({ emails_read: 0, ...defaults() }); expect(read.sql.filter(pointSql)).toHaveLength(3);
  });

  for (const phase of ['prepare', 'execution'] as const) it(`falls back to point reads after batch ${phase} failure`, () => {
    const f = fixture(); f.proposals.setSetting('receipts_found', 6); const prepare = f.db.prepare.bind(f.db); let attempts = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (batchSql(sql)) {
        attempts++; if (phase === 'prepare') throw new Error('Fixture batch prepare failure');
        const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementationOnce(() => { throw new Error('Fixture batch execution failure'); });
        return statement;
      }
      return prepare(sql);
    });
    const read = f.measure(() => f.intake.progress());
    expect(read.value).toEqual({ emails_read: 0, receipts_found: 6, likely_assets: 0, last_scan_at: null });
    expect(attempts).toBe(1); expect(read.sql.filter(pointSql)).toHaveLength(3); expect(read.changes).toBe(0);
  });

  it('preserves requested-key JSON error order and ignores malformed unrequested values', () => {
    const f = fixture(); const put = f.db.prepare('INSERT INTO proactive_intake_settings(key,value) VALUES(?,?)');
    put.run('unrequested', 'broken unrelated JSON'); expect(f.intake.progress()).toEqual({ emails_read: 0, ...defaults() });
    put.run('last_scan_at', 'broken last scan JSON'); put.run('receipts_found', 'broken receipt JSON');
    const expected = errorFrom(() => f.proposals.setting('receipts_found', 0));
    expect(expected).toBeInstanceOf(SyntaxError); expect(errorFrom(() => f.intake.progress()).message).toBe(expected.message);
  });

  for (const phase of ['prepare', 'execution'] as const) it(`discards partial batches after a later ${phase} failure`, () => {
    const f = fixture(); const keys = Array.from({ length: 201 }, (_, index) => `key-${index}`);
    const fallbacks = Object.fromEntries(keys.map(key => [key, -1]));
    for (const [index, key] of keys.entries()) f.proposals.setSetting(key, index);
    const prepare = f.db.prepare.bind(f.db); let batches = 0;
    const fail = () => {
      // The first batch captured zero; fallback must see this later owner edit.
      prepare('UPDATE proactive_intake_settings SET value=? WHERE key=?').run('999', keys[0]!);
      throw new Error('Fixture later settings batch failure');
    };
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (batchSql(sql) && ++batches === 2) {
        if (phase === 'prepare') return fail();
        const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementationOnce(fail); return statement;
      }
      return prepare(sql);
    });
    const read = f.measure(() => f.proposals.settings(fallbacks));
    expect(read.value).toEqual(Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 999 : index])));
    expect(batches).toBe(2); expect(read.sql.filter(pointSql)).toHaveLength(201);
    expect(read.changes).toBe(1); // Only the explicit fixture edit above.
  });

  it('propagates a reader error once when native-reader inspection fails', () => {
    const f = fixture(); const failure = new Error('Fixture custom reader failure'); const calls: string[] = [];
    f.proposals.setting = function<T>(key: string, _fallback: T): T { calls.push(key); throw failure; };
    const owner = new Proxy(f.proposals, { getOwnPropertyDescriptor(target, key) {
      if (key === 'setting') throw new Error('Fixture reader inspection failure');
      return Reflect.getOwnPropertyDescriptor(target, key);
    } });
    expect(errorFrom(() => owner.settings(defaults()))).toBe(failure);
    expect(calls).toEqual(['receipts_found']);
  });

  it('bounds generic settings batches and safely maps absent, quoted and prototype-like keys', () => {
    const f = fixture(); const keys = [...Array.from({ length: 201 }, (_, index) => `key-${index}`), "quoted-'?", '漢', '__proto__', 'constructor'];
    const fallbacks: Record<string, unknown> = Object.fromEntries(keys.map((key, index) => [key, { missing: index }]));
    for (const [index, key] of keys.entries()) if (index % 3 !== 0) f.proposals.setSetting(key, index % 7 === 0 ? null : { value: index });
    const expected = Object.fromEntries(keys.map(key => [key, f.proposals.setting(key, fallbacks[key])]));
    for (const analyzed of [false, true]) {
      if (analyzed) f.db.exec('ANALYZE');
      const read = f.measure(() => f.proposals.settings(fallbacks));
      expect(read.value).toEqual(expected); expect(Object.getPrototypeOf(read.value)).toBe(Object.prototype);
      expect(Object.hasOwn(read.value, '__proto__')).toBe(true); expect(read.sql.filter(batchSql)).toHaveLength(2);
      expect(read.sql.filter(pointSql)).toEqual([]); expect(read.changes).toBe(0);
    }
  });

  it('returns fresh decoded objects while preserving missing fallback references', () => {
    const f = fixture(); f.proposals.setSetting('structured', { n: 1 }); const absent = { n: 0 };
    const first = f.proposals.settings({ structured: { n: 0 }, absent }); first.structured.n = 99;
    expect(first.absent).toBe(absent); expect(f.proposals.settings({ structured: { n: 0 } }).structured).toEqual({ n: 1 });
    const empty = f.measure(() => f.proposals.settings({})); expect(empty.value).toEqual({}); expect(empty.sql).toEqual([]);
  });

  it('uses a borrowed batch method receiver rather than another store’s values', () => {
    const a = fixture(); const b = fixture(); a.proposals.setSetting('receipts_found', 1); b.proposals.setSetting('receipts_found', 2);
    const read = b.measure(() => a.proposals.settings.call(b.proposals, defaults()));
    expect(read.value).toEqual({ receipts_found: 2, likely_assets: 0, last_scan_at: null });
    expect(read.sql.filter(pointSql)).toHaveLength(3); expect(read.sql.filter(batchSql)).toEqual([]);
  });
});
