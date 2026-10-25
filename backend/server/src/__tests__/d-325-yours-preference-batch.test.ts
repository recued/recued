import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel, type NotificationSettings, type PendingAsk } from '@recued/notification';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createSphereStore } from '../storage/sphere-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';

const at = Date.parse('2026-10-23T12:00Z');
const keys = ['digest.frequency', 'last_time.choice', 'metrics.opt_in'];
const defaults = () => ({ 'digest.frequency': 'weekly', 'last_time.choice': 'unasked', 'metrics.opt_in': false });
const pointSql = (sql: string) => /^SELECT value FROM proactive_settings WHERE key=/u.test(sql);
const batchSql = (sql: string) => /^SELECT key,value FROM proactive_settings WHERE key IN/u.test(sql);
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0)) await dispose(); });
const gate = () => {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
};
const fixture = () => {
  let measured: string[] | undefined;
  const db = new Database(':memory:', { verbose(sql) { if (measured && typeof sql === 'string') measured.push(sql); } });
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const situations = createSituationStore(db); const spheres = createSphereStore(db, work);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => at, timeZone: () => 'UTC' });
  const service = createYoursService({ db, work, dispatchers, occurrences, situations, spheres, now: () => at });
  disposals.push(async () => { await service.stop(); db.close(); });
  const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const measure = async <T>(read: () => T | Promise<T>) => {
    const before = changes(); const sql: string[] = []; let value: T; measured = sql;
    try { value = await read(); } finally { measured = undefined; }
    return { value, sql, changes: changes() - before };
  };
  const expected = () => ({ digest: situations.readSetting('digest.frequency', 'weekly'),
    last_time: situations.readSetting('last_time.choice', 'unasked'), measures: situations.readSetting('metrics.opt_in', false) });
  const pause = (phase: 'destinations' | 'replies') => {
    const entered = gate(); const release = gate();
    const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
      settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
      channels: [createUiChannel({ busSink: () => {} })] });
    service.bind({ ...block,
      async getReminderDestinations() { if (phase === 'destinations') { entered.resolve(); await release.promise; } return { destinations: [], issues: [] }; },
      async listUnmatchedAskReplies() { if (phase === 'replies') { entered.resolve(); await release.promise; } return []; },
    });
    return { entered, release };
  };
  return { db, situations, service, measure, expected, pause };
};
const errorFrom = (read: () => unknown): Error => {
  try { read(); } catch (error) { if (error instanceof Error) return error; throw error; }
  throw new Error('Expected the read to fail');
};

describe('batched Yours preferences', () => {
  it('uses one preference SELECT and zero writes for every snapshot', async () => {
    const f = fixture();
    for (let round = 0; round < 2; round++) {
      const read = await f.measure(() => f.service.snapshot());
      expect(read.value.settings).toEqual({ digest: 'weekly', last_time: 'unasked', measures: false });
      expect(read.sql.filter(batchSql)).toHaveLength(1); expect(read.sql.filter(pointSql)).toEqual([]); expect(read.changes).toBe(0);
    }
  });

  it('preserves missing defaults, stored values and explicit nulls', async () => {
    const f = fixture();
    for (const values of [{}, { 'digest.frequency': 'daily', 'last_time.choice': 'on', 'metrics.opt_in': true },
      { 'digest.frequency': null, 'last_time.choice': null, 'metrics.opt_in': null }]) {
      f.db.prepare('DELETE FROM proactive_settings').run();
      for (const [key, value] of Object.entries(values)) f.situations.writeSetting(key, value);
      const expected = f.expected(); const read = await f.measure(() => f.service.snapshot());
      expect(read.value.settings).toEqual(expected); expect(read.sql.filter(batchSql)).toHaveLength(1); expect(read.changes).toBe(0);
    }
  });

  it('reads edits and deletions next time without retaining a cache', async () => {
    const f = fixture(); const first = (await f.service.snapshot()).settings;
    f.situations.writeSetting('digest.frequency', 'off'); f.situations.writeSetting('last_time.choice', 'on');
    expect((await f.service.snapshot()).settings).toEqual({ digest: 'off', last_time: 'on', measures: false });
    f.db.prepare('DELETE FROM proactive_settings WHERE key=?').run('digest.frequency');
    expect((await f.service.snapshot()).settings).toEqual({ digest: 'weekly', last_time: 'on', measures: false });
    expect(first).toEqual({ digest: 'weekly', last_time: 'unasked', measures: false });
  });

  it('retains customized reader order, receiver and intervening writes', async () => {
    const f = fixture(); const native = f.situations.readSetting; const calls: string[] = [];
    f.situations.readSetting = function<T>(this: typeof f.situations, key: string, fallback: T): T {
      expect(this).toBe(f.situations); calls.push(key); const value = native(key, fallback);
      if (key === 'digest.frequency') this.writeSetting('last_time.choice', 'on'); return value;
    };
    const read = await f.measure(() => f.service.snapshot());
    expect(read.value.settings).toEqual({ digest: 'weekly', last_time: 'on', measures: false }); expect(calls).toEqual(keys);
    expect(read.sql.filter(pointSql)).toHaveLength(3); expect(read.sql.filter(batchSql)).toEqual([]);
  });

  it('does not invoke reader getters while checking for the native path', async () => {
    const f = fixture(); const native = f.situations.readSetting; const calls: string[] = [];
    Object.defineProperty(f.situations, 'readSetting', { configurable: true, get() {
      calls.push('get'); return function<T>(this: typeof f.situations, key: string, fallback: T): T {
        expect(this).toBe(f.situations); calls.push(key); return native(key, fallback);
      };
    } });
    const read = await f.measure(() => f.service.snapshot());
    expect(read.value.settings).toEqual({ digest: 'weekly', last_time: 'unasked', measures: false });
    expect(calls).toEqual(['get', keys[0], 'get', keys[1], 'get', keys[2]]); expect(read.sql.filter(pointSql)).toHaveLength(3);
  });

  it('retains the point path for a legacy situation store without a batch method', async () => {
    const f = fixture(); Object.defineProperty(f.situations, 'readSettings', { value: undefined });
    const read = await f.measure(() => f.service.snapshot());
    expect(read.value.settings).toEqual({ digest: 'weekly', last_time: 'unasked', measures: false });
    expect(read.sql.filter(pointSql)).toHaveLength(3); expect(read.sql.filter(batchSql)).toEqual([]);
  });

  for (const phase of ['prepare', 'execution'] as const) it(`falls back after preference batch ${phase} failure`, async () => {
    const f = fixture(); f.situations.writeSetting('digest.frequency', 'daily'); const prepare = f.db.prepare.bind(f.db); let attempts = 0;
    vi.spyOn(f.db, 'prepare').mockImplementation(sql => {
      if (batchSql(sql)) {
        attempts++; if (phase === 'prepare') throw new Error('Fixture preference prepare failure');
        const statement = prepare(sql); vi.spyOn(statement, 'all').mockImplementationOnce(() => { throw new Error('Fixture preference execution failure'); });
        return statement;
      }
      return prepare(sql);
    });
    const read = await f.measure(() => f.service.snapshot());
    expect(read.value.settings).toEqual({ digest: 'daily', last_time: 'unasked', measures: false });
    expect(attempts).toBe(1); expect(read.sql.filter(pointSql)).toHaveLength(3); expect(read.changes).toBe(0);
  });

  it('preserves requested-key JSON error order and ignores unrequested malformed values', async () => {
    const f = fixture(); const put = f.db.prepare('INSERT INTO proactive_settings(key,value) VALUES(?,?)');
    put.run('unrequested', 'broken unrelated JSON'); await f.service.snapshot();
    put.run('metrics.opt_in', 'broken metrics JSON'); put.run('digest.frequency', 'broken digest JSON');
    const expected = errorFrom(() => f.situations.readSetting('digest.frequency', 'weekly'));
    await expect(f.service.snapshot()).rejects.toThrow(expected);
  });

  for (const phase of ['destinations', 'replies'] as const) it(`reads preferences after edits during ${phase}`, async () => {
    const f = fixture(); f.situations.writeSetting('digest.frequency', 'daily'); const p = f.pause(phase);
    const reading = f.measure(() => f.service.snapshot());
    try {
      await p.entered.promise; f.situations.writeSetting('digest.frequency', 'off');
      f.situations.writeSetting('last_time.choice', 'on'); f.situations.writeSetting('metrics.opt_in', true);
      p.release.resolve(); const read = await reading;
      expect(read.value.settings).toEqual({ digest: 'off', last_time: 'on', measures: true }); expect(read.sql.filter(batchSql)).toHaveLength(1);
    } finally { p.release.resolve(); await reading; }
  });

  for (const mode of ['method', 'getter'] as const) it(`honors a reader ${mode} replaced while unmatched replies are loading`, async () => {
    const f = fixture(); const p = f.pause('replies'); const native = f.situations.readSetting; const calls: string[] = [];
    const reading = f.measure(() => f.service.snapshot());
    try {
      await p.entered.promise;
      const reader = function<T>(this: typeof f.situations, key: string, fallback: T): T {
        expect(this).toBe(f.situations); calls.push(key); const value = native(key, fallback);
        if (key === 'digest.frequency') this.writeSetting('last_time.choice', 'on'); return value;
      };
      if (mode === 'method') f.situations.readSetting = reader;
      else Object.defineProperty(f.situations, 'readSetting', { configurable: true, get() { calls.push('get'); return reader; } });
      p.release.resolve(); const read = await reading;
      expect(read.value.settings).toEqual({ digest: 'weekly', last_time: 'on', measures: false });
      expect(calls).toEqual(mode === 'method' ? keys : ['get', keys[0], 'get', keys[1], 'get', keys[2]]);
      expect(read.sql.filter(batchSql)).toEqual([]); expect(read.sql.filter(pointSql)).toHaveLength(3);
    } finally { p.release.resolve(); await reading; }
  });

  it('uses fresh point reads when the optional batch method is removed while replies are loading', async () => {
    const f = fixture(); const p = f.pause('replies'); const reading = f.measure(() => f.service.snapshot());
    try {
      await p.entered.promise; Object.defineProperty(f.situations, 'readSettings', { value: undefined });
      f.situations.writeSetting('digest.frequency', 'off'); p.release.resolve(); const read = await reading;
      expect(read.value.settings).toEqual({ digest: 'off', last_time: 'unasked', measures: false });
      expect(read.sql.filter(batchSql)).toEqual([]); expect(read.sql.filter(pointSql)).toHaveLength(3);
    } finally { p.release.resolve(); await reading; }
  });

  it('bounds generic preference batches and safely maps quoted and prototype-like keys', async () => {
    const f = fixture(); const names = [...Array.from({ length: 201 }, (_, index) => `pref-${index}`), "quoted-'?", '__proto__', '漢'];
    const fallbacks: Record<string, unknown> = Object.fromEntries(names.map(name => [name, null]));
    for (const [index, name] of names.entries()) if (index % 2 === 0) f.situations.writeSetting(name, { index });
    const expected = Object.fromEntries(names.map(name => [name, f.situations.readSetting(name, fallbacks[name])]));
    const read = await f.measure(() => f.situations.readSettings!(fallbacks));
    expect(read.value).toEqual(expected); expect(Object.getPrototypeOf(read.value)).toBe(Object.prototype);
    expect(Object.hasOwn(read.value, '__proto__')).toBe(true); expect(read.sql.filter(batchSql)).toHaveLength(2); expect(read.changes).toBe(0);
  });

  it('propagates a customized reader error once', async () => {
    const f = fixture(); const failure = new Error('Fixture preference reader failure'); const calls: string[] = [];
    f.situations.readSetting = function<T>(key: string, _fallback: T): T { calls.push(key); throw failure; };
    await expect(f.service.snapshot()).rejects.toBe(failure); expect(calls).toEqual(['digest.frequency']);
  });

  it('uses a borrowed batch method receiver rather than another store’s preferences', async () => {
    const a = fixture(); const b = fixture(); a.situations.writeSetting('digest.frequency', 'off'); b.situations.writeSetting('digest.frequency', 'daily');
    const read = await b.measure(() => a.situations.readSettings!.call(b.situations, defaults()));
    expect(read.value).toEqual({ ...defaults(), 'digest.frequency': 'daily' });
    expect(read.sql.filter(pointSql)).toHaveLength(3); expect(read.sql.filter(batchSql)).toEqual([]);
  });
});
