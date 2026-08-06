/** The ask store's SQLite read path — the one its own package cannot test.
 *
 *  ⛔ WHY THIS FILE EXISTS. `packages/notification` has 225 passing tests and
 *  every one of them runs against the IN-MEMORY collection, because `packages/`
 *  may not import the server's SQLite backing (public-boundary rule). When
 *  `createAskStore` gained a `isFieldQueryable` fast path, that entire suite
 *  kept exercising the fallback — the branch that does NOT run in production.
 *  A fast path covered only in production is a fast path nobody has tested.
 *
 *  ⛔ AND THE SAFETY PROPERTY LIVES IN THIS BRANCH NOW. `pruneHandled`'s
 *  guarantee — never `answered` (the at-least-once retry queue), never `open`
 *  (a live decision) — used to be two `continue` statements in JS. On the fast
 *  path it is a SQL predicate. Same guarantee, different code, previously zero
 *  coverage. D-158 TR-4 calls deleting an answered ask a forbidden failure.
 *
 *  The differential tests below are the core: identical data through both
 *  backings must produce identical answers. That is what stops the two paths
 *  drifting, which is the failure mode a one-sided test cannot see. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createInMemoryCollection, isFieldQueryable } from '@recued/storage';
import {
  createAskStore,
  type AskStore,
} from '@recued/notification';
import type { PendingAsk, PendingAskStatus } from '@recued/notification';

import { createSQLiteCollection } from '../sqlite-collection.js';

const NOW = 1_800_000_000_000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

const mkAsk = (
  ask_id: string,
  status: PendingAskStatus,
  created_at: number,
): PendingAsk => ({
  ask_id,
  message: { title: 'hz', body: 'body' },
  options: [{ id: 'ok', label: 'OK' }],
  handler_kind: 'noop',
  handler_payload: {},
  fanout_channels: [],
  status,
  created_at,
  ...(status === 'open' ? {} : { answer: { option: 'ok' } }),
} as unknown as PendingAsk);

/** The same population through both backings. Deliberately includes every
 *  class the prune must NOT touch, each one OLD enough that an age-only
 *  predicate would take it. */
const POPULATION: ReadonlyArray<readonly [string, PendingAskStatus, number]> = [
  ['h-old-1', 'handled', NOW - WEEK - 5_000],
  ['h-old-2', 'handled', NOW - WEEK - 1_000],
  ['h-fresh', 'handled', NOW - 1_000],
  // ⛔ Ancient and ANSWERED — the retry queue. Must survive.
  ['a-ancient', 'answered', NOW - 10 * WEEK],
  // ⛔ Ancient and OPEN — a live decision. Must survive.
  ['o-ancient', 'open', NOW - 10 * WEEK],
  ['o-fresh', 'open', NOW - 500],
  // Exactly AT the cutoff: the predicate is strict `<`, so it must survive.
  ['h-boundary', 'handled', NOW - WEEK],
];

const populate = async (store: {
  raw: { set: (k: string, v: PendingAsk) => Promise<void> };
}): Promise<void> => {
  for (const [id, status, created_at] of POPULATION) {
    await store.raw.set(id, mkAsk(id, status, created_at));
  }
};

const mkSqlite = (): { store: AskStore; raw: ReturnType<typeof createSQLiteCollection<PendingAsk>>; db: Database.Database } => {
  const db = new Database(':memory:');
  const raw = createSQLiteCollection<PendingAsk>(db, 'pending_asks');
  raw.ensureFieldIndexes(['status', 'created_at']);
  return { store: createAskStore(raw), raw, db };
};

const mkMemory = (): { store: AskStore; raw: ReturnType<typeof createInMemoryCollection<PendingAsk>> } => {
  const raw = createInMemoryCollection<PendingAsk>();
  return { store: createAskStore(raw), raw };
};

describe('ask store — SQLite read path', () => {
  it('the SQLite backing IS field-queryable and the in-memory one is NOT', () => {
    // The premise of every test below. If this flips, the differential tests
    // silently compare the fallback against itself and prove nothing — the
    // "audited, clean" shape that means nothing was audited.
    const { raw, db } = mkSqlite();
    expect(isFieldQueryable(raw)).toBe(true);
    expect(isFieldQueryable(createInMemoryCollection<PendingAsk>())).toBe(false);
    db.close();
  });

  it('⛔ pruneHandled takes handled+old ONLY — never answered, never open', async () => {
    const { store, raw, db } = mkSqlite();
    await populate({ raw });

    const removed = await store.pruneHandled(NOW - WEEK);
    expect(removed).toBe(2);

    const survivors = (await raw.list()).map((a) => a.ask_id).sort();
    expect(survivors).toEqual(
      ['a-ancient', 'h-boundary', 'h-fresh', 'o-ancient', 'o-fresh'],
    );
    // Named individually — these are the two D-158 TR-4 forbidden failures and
    // a set-equality assertion reads past them too easily.
    expect(await store.get('a-ancient')).not.toBeNull();
    expect(await store.get('o-ancient')).not.toBeNull();
    db.close();
  });

  it('both backings agree on pruneHandled — count AND survivors', async () => {
    const sq = mkSqlite();
    const mem = mkMemory();
    await populate({ raw: sq.raw });
    await populate({ raw: mem.raw });

    const removedSq = await sq.store.pruneHandled(NOW - WEEK);
    const removedMem = await mem.store.pruneHandled(NOW - WEEK);
    expect(removedSq).toBe(removedMem);

    const ids = async (c: { list: () => Promise<PendingAsk[]> }): Promise<string[]> =>
      (await c.list()).map((a) => a.ask_id).sort();
    expect(await ids(sq.raw)).toEqual(await ids(mem.raw));
    sq.db.close();
  });

  it('both backings agree on countOpen and listByStatus (incl. ordering)', async () => {
    const sq = mkSqlite();
    const mem = mkMemory();
    await populate({ raw: sq.raw });
    await populate({ raw: mem.raw });

    expect(await sq.store.countOpen()).toBe(await mem.store.countOpen());
    expect(await sq.store.countOpen()).toBe(2);

    for (const status of ['open', 'answered', 'handled'] as const) {
      const a = (await sq.store.listByStatus(status)).map((x) => x.ask_id);
      const b = (await mem.store.listByStatus(status)).map((x) => x.ask_id);
      // Order matters: the boot sweep walks these oldest-first.
      expect(a, status).toEqual(b);
    }
    expect((await sq.store.listByStatus('open')).map((x) => x.ask_id))
      .toEqual(['o-ancient', 'o-fresh']);
    sq.db.close();
  });

  it('the queries USE the indexes — a correct answer read the slow way is still the bug', async () => {
    // ⛔ SQLite matches expression indexes SYNTACTICALLY. If the index text and
    // the query text ever diverge, every query above keeps returning the right
    // rows while scanning the whole table — the exact defect this change was
    // made to remove, hidden behind passing correctness tests.
    const { raw, db } = mkSqlite();
    await populate({ raw });

    const plan = (sql: string, ...params: unknown[]): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map((r) => r.detail).join(' ; ');

    expect(
      plan(`SELECT COUNT(*) FROM pending_asks WHERE json_extract(data, '$.status') = ?`, 'open'),
    ).toMatch(/USING (COVERING )?INDEX idx_pending_asks_status/);

    expect(
      plan(
        `DELETE FROM pending_asks WHERE json_extract(data, '$.status') = ? `
        + `AND json_extract(data, '$.created_at') < ?`,
        'handled', NOW,
      ),
    ).toMatch(/USING INDEX idx_pending_asks_/);
    db.close();
  });

  it('⛔ deleteByField REFUSES an empty query instead of emptying the table', async () => {
    // `buildWhere` renders `1=1` for a spec with no predicates — right for a
    // read, catastrophic for a delete. A caller assembling a spec dynamically
    // must get an error, not a wipe.
    const { raw, db } = mkSqlite();
    await populate({ raw });
    await expect(raw.deleteByField({})).rejects.toThrow(/refusing an empty query/);
    expect((await raw.list()).length).toBe(POPULATION.length);
    db.close();
  });

  it('rejects a field name that is not a bare identifier', async () => {
    // Field names are interpolated into SQL (a JSON path cannot be a bind
    // parameter). First-party callers today; not a security property.
    const { raw, db } = mkSqlite();
    await expect(raw.queryByField({ equals: { "x') = 1 OR ('1": 'y' } }))
      .rejects.toThrow(/invalid field name/);
    expect(() => raw.ensureFieldIndexes(['a-b'])).toThrow(/invalid field name/);
    db.close();
  });
});
