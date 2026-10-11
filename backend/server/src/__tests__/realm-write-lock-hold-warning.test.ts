/** Since `takeWriteLockFirst`, every realm transaction holds the write lock
 *  from BEGIN to COMMIT, and every other process writing the realm (the server,
 *  each `recued --mcp`) waits that long for its own write. A run from source
 *  says when one holds it for `WRITE_LOCK_HOLD_WARN_MS` or more
 *  (`reportLongWriteLockHolds`), so a long holder shows up before anyone times
 *  out on it.
 *
 *  Most cases drive the warning's clock by hand: the body moves it, so a hold
 *  is exactly as long as the case says. The waiting case uses the real clock,
 *  because what it pins is that waiting for ANOTHER process's lock is not
 *  counted as this transaction's hold. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  openDatabase,
  WRITE_LOCK_HOLD_WARN_MS,
  writeLockWarningByDefault,
  type WriteLockHoldWarning,
} from '../open-database.js';
import { expectWriteLockHeldElsewhere, holdWriteLock } from './helpers/realm-write-lock-holder.js';

const dirs: string[] = [];
const dbs: Database.Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const openRealm = async (
  writeLockWarning?: WriteLockHoldWarning | false,
): Promise<{ file: string; db: Database.Database }> => {
  const dir = mkdtempSync(join(tmpdir(), 'realm-hold-warning-'));
  dirs.push(dir);
  const file = join(dir, 'realm.db');
  const db = await openDatabase(file, {
    databaseKey: null,
    ...(writeLockWarning === undefined ? {} : { writeLockWarning }),
  });
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)`);
  dbs.push(db);
  return { file, db };
};

/** A warning whose clock the case moves: `clock.ms += n` inside a body makes
 *  that transaction hold the lock for `n` ms. */
const handClock = () => {
  const clock = { ms: 0 };
  const messages: string[] = [];
  const warning: WriteLockHoldWarning = {
    thresholdMs: 1_000,
    warn: (message) => { messages.push(message); },
    now: () => clock.ms,
  };
  return { clock, messages, warning };
};

describe('a transaction that holds the write lock too long is reported', () => {
  it('names the database, the hold and the place it was called from', async () => {
    const { clock, messages, warning } = handClock();
    const { db } = await openRealm(warning);

    db.transaction(() => {
      db.prepare(`INSERT INTO t VALUES ('a', '1')`).run();
      clock.ms += 1_500;
    })();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('held the write lock on realm.db for 1500 ms');
    // The first frame is this file, not the wrapper.
    expect(messages[0]).toMatch(/Called from:\n {4}at .*realm-write-lock-hold-warning\.test\.ts:\d+/);
    expect(db.prepare(`SELECT v FROM t WHERE k = 'a'`).get()).toEqual({ v: '1' });
  });

  it('says nothing about a hold under the threshold', async () => {
    const { clock, messages, warning } = handClock();
    const { db } = await openRealm(warning);

    db.transaction(() => { clock.ms += 999; })();

    expect(messages).toEqual([]);
  });

  it('times the explicit .immediate() and .exclusive() as well', async () => {
    const { clock, messages, warning } = handClock();
    const { db } = await openRealm(warning);

    db.transaction(() => { clock.ms += 1_200; }).immediate();
    db.transaction(() => { clock.ms += 1_300; }).exclusive();

    expect(messages.map((message) => /for (\d+) ms/.exec(message)?.[1])).toEqual(['1200', '1300']);
  });

  it('does not time .deferred(), the opt-out for a long read', async () => {
    const { clock, messages, warning } = handClock();
    const { db } = await openRealm(warning);

    db.transaction(() => {
      db.prepare(`SELECT count(*) FROM t`).get();
      clock.ms += 5_000;
    }).deferred();

    expect(messages).toEqual([]);
  });

  it('counts a nested transaction as part of the outer hold, once', async () => {
    const { clock, messages, warning } = handClock();
    const { db } = await openRealm(warning);
    const inner = db.transaction(() => { clock.ms += 1_500; });

    db.transaction(() => {
      inner();
      clock.ms += 100;
    })();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('for 1600 ms');
  });

  it('reports a hold that ended in a throw: the lock was held until the rollback', async () => {
    const { clock, messages, warning } = handClock();
    const { db } = await openRealm(warning);

    expect(() => db.transaction(() => {
      db.prepare(`INSERT INTO t VALUES ('a', '1')`).run();
      clock.ms += 2_000;
      throw new Error('boom');
    })()).toThrow('boom');

    expect(messages).toHaveLength(1);
    expect(db.prepare(`SELECT count(*) AS n FROM t`).get()).toEqual({ n: 0 });
  });

  it('reports each place once', async () => {
    const { clock, messages, warning } = handClock();
    const { db } = await openRealm(warning);
    const slow = db.transaction(() => { clock.ms += 1_500; });

    for (let i = 0; i < 3; i += 1) slow();
    expect(messages).toHaveLength(1);

    db.transaction(() => { clock.ms += 1_500; })();
    expect(messages).toHaveLength(2);
  });

  it('keeps the variants and the database on the transaction function', async () => {
    const { warning } = handClock();
    const { db } = await openRealm(warning);
    const transaction = db.transaction(() => 'done');

    // The driver sets `database` on every variant; its types leave it out.
    expect((transaction as unknown as { database: unknown }).database).toBe(db);
    expect(transaction.immediate()).toBe('done');
    expect(transaction.deferred()).toBe('done');
    expect(transaction.exclusive()).toBe('done');
    expect(transaction.default()).toBe('done');
  });
});

describe('the clock starts once the lock is held', () => {
  it('does not count the wait for another process’s lock', async () => {
    const messages: string[] = [];
    const { file, db } = await openRealm({
      thresholdMs: 1_000,
      warn: (message) => { messages.push(message); },
    });
    const holder = await holdWriteLock(file, 1_500);
    await expectWriteLockHeldElsewhere(file);

    const started = performance.now();
    db.transaction(() => { db.prepare(`INSERT INTO t VALUES ('a', '1')`).run(); })();
    const waited = performance.now() - started;
    await holder.released;

    // It did wait out the other process, past the threshold, and holding the
    // lock itself took no time: timing from BEGIN would have reported the wait.
    expect(waited).toBeGreaterThan(1_000);
    expect(messages).toEqual([]);
  });

  it('counts a real hold on the real clock', async () => {
    const messages: string[] = [];
    const { db } = await openRealm({
      thresholdMs: 200,
      warn: (message) => { messages.push(message); },
    });

    db.transaction(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    })();

    expect(messages).toHaveLength(1);
  });
});

describe('only a run from source warns', () => {
  it('is on from source and off in the packaged binary, the Docker image and tests', () => {
    const source = () => false;
    expect(writeLockWarningByDefault({}, source)).toBe(true);
    expect(writeLockWarningByDefault({ NODE_ENV: 'development' }, source)).toBe(true);
    expect(writeLockWarningByDefault({}, () => true)).toBe(false);
    expect(writeLockWarningByDefault({ NODE_ENV: 'production' }, source)).toBe(false);
    expect(writeLockWarningByDefault({ NODE_ENV: 'test' }, source)).toBe(false);
    expect(writeLockWarningByDefault({ VITEST: 'true' }, source)).toBe(false);
    expect(writeLockWarningByDefault({ VITEST_WORKER_ID: '1' }, source)).toBe(false);
  });

  // The predicate alone does not prove `openDatabase` asks it. A real hold past
  // `WRITE_LOCK_HOLD_WARN_MS` must stay silent under test, then, with the
  // process made to look like a run from source, reach `console.warn` by default
  // and not with `writeLockWarning: false`.
  it('openDatabase is silent under test, warns from source, and not when told false', async () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      VITEST: process.env.VITEST,
      VITEST_WORKER_ID: process.env.VITEST_WORKER_ID,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const holdPastThreshold = (db: Database.Database) => db.transaction(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WRITE_LOCK_HOLD_WARN_MS + 100);
    })();
    try {
      // Under test, as every case in the suite runs: off.
      holdPastThreshold((await openRealm()).db);
      expect(warn).not.toHaveBeenCalled();

      delete process.env.NODE_ENV;
      delete process.env.VITEST;
      delete process.env.VITEST_WORKER_ID;
      expect(writeLockWarningByDefault()).toBe(true);

      holdPastThreshold((await openRealm(false)).db);
      expect(warn).not.toHaveBeenCalled();

      holdPastThreshold((await openRealm()).db);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('[write-lock] a transaction held the write lock on realm.db');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      warn.mockRestore();
    }
  });
});
