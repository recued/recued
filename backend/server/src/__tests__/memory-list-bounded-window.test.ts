/** `memory.list` pages bounded windows instead of reading both stores whole.
 *
 *  ⛔ THE DEFECT. The handler called `listRecent(Number.MAX_SAFE_INTEGER)` — the
 *  ENTIRE audit log — plus `userMemoryStore.list()` — the ENTIRE store — then
 *  projected, filtered, sorted and sliced 50 rows off the front. Measured on
 *  real 698 B rows: 401ms and 393 MB of resident heap for ONE page at 200k
 *  entries, linear in the table. D-230 raised the audit ceiling to 5 GB and left
 *  `user_memory` with no quota at all, so at the prune trigger one page is ~5s
 *  and ~4.9 GB — the shape that OOM'd the audit-prune harness at 3.1 GB.
 *
 *  ⛔ WHY THE EXISTING 29 HANDLER TESTS COULD NOT SEE IT, AND STILL CANNOT.
 *  Every one of them seeds a handful of rows. The window is 128, so both sources
 *  return short, nothing truncates, the horizon is unbounded and the loop exits
 *  after a single round — the multi-round merge those tests appear to cover is
 *  never entered. They are correct and they pin the projection; they say nothing
 *  about the read. Everything here seeds ABOVE the window on purpose.
 *
 *  🔑 THE HORIZON IS THE PART THAT CAN SILENTLY LOSE ROWS. Two sources are
 *  windowed independently, so their tops are only safe to merge down to
 *  whichever ran out FIRST. `walks the whole feed` is built so a naive merge
 *  (take everything both sources returned, resume from the deepest tail) skips
 *  ~100 user rows outright — and still returns a plausible, correctly-ordered,
 *  correctly-sized page every time. Only the whole-feed set comparison catches
 *  it. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createAuditLogStore, createInMemoryCollection } from '@recued/storage';
import type { AuditEntry, AuditLogStore } from '@recued/storage';

import { createSQLiteCollection } from '../sqlite-collection.js';
import { handleMemoryList } from '../memory-rpc-handler.js';
import type { MemoryRpcDeps } from '../memory-rpc-handler.js';
import { createUserMemoryStore } from '../user-memory-store.js';
import type { UserMemoryRow, UserMemoryStore } from '../user-memory-store.js';

const auditEff = (r: AuditEntry): number => r.event_at ?? r.started_at;
const userEff = (r: UserMemoryRow): number => r.event_at ?? r.ts;

/** ⛔ COUNTS ROWS HANDED OUT, NOT CALLS. A call count says nothing about cost —
 *  one `listRecent(MAX_SAFE_INTEGER)` is a single call that reads the table. */
interface Meter { rows: number; calls: number; unbounded: number; }

const auditSourceOver = (rows: AuditEntry[], meter: Meter): AuditLogStore =>
  ({
    async listRecent(limit: number) {
      // The old path. Kept live and METERED rather than removed: a test that
      // deletes the slow path cannot notice the handler drifting back onto it.
      meter.calls += 1;
      if (!Number.isSafeInteger(limit) || limit > 100_000) meter.unbounded += 1;
      const out = [...rows].sort((a, b) => b.started_at - a.started_at).slice(0, limit);
      meter.rows += out.length;
      return out;
    },
    async listWindow({ limit, before }: {
      limit: number;
      before?: { ts: number; id: string };
    }) {
      meter.calls += 1;
      if (!Number.isSafeInteger(limit) || limit > 100_000) meter.unbounded += 1;
      const ordered = [...rows].sort((a, b) =>
        (auditEff(b) - auditEff(a))
        || (a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0));
      const after = before === undefined
        ? ordered
        : ordered.filter((r) => (auditEff(r) !== before.ts
          ? auditEff(r) < before.ts
          : r.run_id < before.id));
      const out = after.slice(0, limit);
      meter.rows += out.length;
      return out;
    },
    async get() { return null; },
  }) as unknown as AuditLogStore;

const userSourceOver = (rows: UserMemoryRow[], meter: Meter): UserMemoryStore =>
  ({
    async list() {
      meter.calls += 1;
      meter.unbounded += 1;      // `list()` is unbounded BY DEFINITION
      meter.rows += rows.length;
      return rows;
    },
    async listWindow({ limit, before }: {
      limit: number;
      before?: { ts: number; id: string };
    }) {
      meter.calls += 1;
      if (!Number.isSafeInteger(limit) || limit > 100_000) meter.unbounded += 1;
      const ordered = [...rows].sort((a, b) =>
        (userEff(b) - userEff(a))
        || (a.memory_id < b.memory_id ? 1 : a.memory_id > b.memory_id ? -1 : 0));
      const after = before === undefined
        ? ordered
        : ordered.filter((r) => (userEff(r) !== before.ts
          ? userEff(r) < before.ts
          : r.memory_id < before.id));
      const out = after.slice(0, limit);
      meter.rows += out.length;
      return out;
    },
  }) as unknown as UserMemoryStore;

/** ⚠ `kind` is the REAL `commit_kind` union, not `string`. It was `string`, and
 *  the `as unknown as AuditEntry` below meant a seeded `'rare'` type-checked at
 *  the construction site and only surfaced ~100 lines later, as a TS2367 on a
 *  comparison that could never be true. A fixture that seeds a value the system
 *  cannot produce is also testing a state that cannot occur. Absent `kind` is
 *  the honest way to get the handler's `'run'` default (`commit_kind ?? 'run'`). */
const mkAudit = (id: string, ts: number, kind?: AuditEntry['commit_kind']): AuditEntry =>
  ({
    run_id: id,
    started_at: ts,
    ...(kind ? { commit_kind: kind } : {}),
  }) as unknown as AuditEntry;

const mkUser = (id: string, ts: number, kind = 'note'): UserMemoryRow =>
  ({ memory_id: id, origin_actor: 'user_self', kind, ts, size_bytes: 0 }) as UserMemoryRow;

const world = (audit: AuditEntry[], user: UserMemoryRow[]) => {
  const meter: Meter = { rows: 0, calls: 0, unbounded: 0 };
  const deps: MemoryRpcDeps = {
    auditLog: auditSourceOver(audit, meter),
    userMemoryStore: userSourceOver(user, meter),
  } as MemoryRpcDeps;
  return { deps, meter };
};

describe('memory.list bounded window', () => {
  it('⛔ reads a BOUNDED number of rows for one page of a large feed', async () => {
    // 5,000 + 5,000 rows. The old handler read all 10,000 to return 50.
    const audit = Array.from({ length: 5_000 }, (_, i) => mkAudit(`r-${1e6 + i}`, 1_000 + i));
    const user = Array.from({ length: 5_000 }, (_, i) => mkUser(`umem-${1e6 + i}`, 1_000 + i));
    const { deps, meter } = world(audit, user);

    const res = await handleMemoryList(deps, { limit: 50 });

    expect(res.entries).toHaveLength(50);
    expect(meter.unbounded, 'no unbounded read may remain on the page path').toBe(0);
    // One round of two 128-row windows. Asserted as a ceiling rather than an
    // equality so tuning the window is not a test edit — the CONTRACT is that
    // it does not scale with the table.
    expect(meter.rows).toBeLessThan(600);
    expect(meter.rows).toBeGreaterThan(0);   // ...and it did read something
  });

  it('⛔ the cost does NOT grow with the table', async () => {
    // The property the byte counts above only sample. If this ever fails, the
    // handler is back to reading the store rather than a page of it.
    const measure = async (n: number): Promise<number> => {
      const audit = Array.from({ length: n }, (_, i) => mkAudit(`r-${1e6 + i}`, 1_000 + i));
      const user = Array.from({ length: n }, (_, i) => mkUser(`umem-${1e6 + i}`, 1_000 + i));
      const { deps, meter } = world(audit, user);
      await handleMemoryList(deps, { limit: 50 });
      return meter.rows;
    };
    const small = await measure(500);
    const large = await measure(20_000);   // 40x the rows
    expect(large).toBe(small);
  });

  it('⛔ walks the WHOLE feed with no gap and no repeat, across the horizon', async () => {
    // ⛔ THE SHAPE THAT BREAKS A NAIVE MERGE. The two sources cover DIFFERENT
    // time ranges, so with a 128-row window the audit window bottoms out at
    // ts~73 while the user window bottoms out at ts~173. Merging both tops and
    // resuming from the DEEPER tail (73) skips every user row between 173 and
    // 73 — about 100 rows — while still returning full, correctly-ordered
    // pages. Only comparing the walked SET against the expected set sees it.
    const audit = Array.from({ length: 200 }, (_, i) => mkAudit(`r-${1000 + i}`, 1 + i));
    const user = Array.from({ length: 200 }, (_, i) => mkUser(`umem-${1000 + i}`, 100 + i));
    const { deps } = world(audit, user);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const res: Awaited<ReturnType<typeof handleMemoryList>> = await handleMemoryList(
        deps,
        { limit: 25, ...(cursor ? { cursor } : {}) },
      );
      seen.push(...res.entries.map((e) => e.memory_id));
      pages += 1;
      if (res.next_cursor === undefined || pages > 100) break;
      cursor = res.next_cursor;
    }

    expect(new Set(seen).size, 'a repeated id means the cursor went backwards').toBe(seen.length);
    expect(seen).toHaveLength(400);
    expect(new Set(seen)).toEqual(new Set([
      ...audit.map((r) => r.run_id),
      ...user.map((r) => r.memory_id),
    ]));

    // ...and in the feed's declared order the whole way down.
    const expected = [
      ...audit.map((r) => ({ id: r.run_id, ts: auditEff(r) })),
      ...user.map((r) => ({ id: r.memory_id, ts: userEff(r) })),
    ].sort((a, b) => (b.ts - a.ts) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    expect(seen).toEqual(expected.map((e) => e.id));
  });

  it('⛔ MULTI-ROUND: the horizon holds when one source out-runs the other', async () => {
    // ⛔ WHY THE WHOLE-FEED WALK ABOVE DOES NOT COVER THIS, THOUGH IT LOOKS LIKE
    // IT SHOULD. Every REQUEST re-windows both sources from the cursor, so a
    // naive merge is re-anchored on each call and loses nothing across pages —
    // deleting the horizon filter entirely left that test green. The horizon is
    // load-bearing only INSIDE one request, once a filter forces round 2, and
    // only when the two sources bottom out at very different depths.
    //
    // 🔑 SO THE FIXTURE MAKES THEM DIVERGE HARD. Audit rows are dense (1 tick
    // apart) and user rows sparse (10 ticks apart), so a 128-row window leaves
    // audit at ts~99873 and user at ts~98730. Resuming from the DEEPER tail
    // skips ~1,100 audit rows in one step — and the matching rows live in the
    // audit source, so they vanish from the feed while every page still looks
    // full, ordered and plausible.
    const RARE = 20;
    const audit = Array.from({ length: 3_000 }, (_, i) =>
      mkAudit(`r-${100_000 - i}`, 100_000 - i, i % RARE === 0 ? 'cognition_output' : undefined));
    const user = Array.from({ length: 3_000 }, (_, i) =>
      mkUser(`umem-${100_000 - i * 10}`, 100_000 - i * 10));
    const expected = audit.filter((r) => r.commit_kind === 'cognition_output').map((r) => r.run_id);
    expect(expected).toHaveLength(150);   // the fixture says what it claims

    const { deps } = world(audit, user);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let p = 0; p < 60; p++) {
      const res: Awaited<ReturnType<typeof handleMemoryList>> = await handleMemoryList(
        deps,
        { limit: 40, kind: 'cognition_output', ...(cursor ? { cursor } : {}) },
      );
      seen.push(...res.entries.map((e) => e.memory_id));
      if (res.next_cursor === undefined) break;
      cursor = res.next_cursor;
    }

    // A dropped row is the failure. Set equality, not just a count — a naive
    // merge returns FEWER rows, but a subtly wrong cursor could return the
    // right number of the wrong ones.
    expect(new Set(seen)).toEqual(new Set(expected));
    expect(seen).toEqual(expected);        // ...and in feed order
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('⛔ a SELECTIVE filter still fills a page instead of returning short', async () => {
    // One matching row per 200. A single fixed window would return 1-2 entries
    // and a `next_cursor`, which renders as "the feed ended" for a filter that
    // has hundreds of matches left. The window grows per round instead.
    const audit = Array.from({ length: 3_000 }, (_, i) => mkAudit(`r-${1e6 + i}`, 1_000 + i));
    const user = Array.from({ length: 3_000 }, (_, i) =>
      mkUser(`umem-${1e6 + i}`, 1_000 + i, i % 200 === 0 ? 'rare' : 'note'));
    const { deps } = world(audit, user);

    const res = await handleMemoryList(deps, { limit: 10, kind: 'rare' });
    expect(res.entries).toHaveLength(10);
    expect(res.entries.every((e) => e.kind === 'rare')).toBe(true);
  });

  it('⛔ the ROUND CAP returns a resumable cursor, not the end of the feed', async () => {
    // ⛔ THE BUG THIS EXISTS FOR. The walk is capped so a filter matching
    // nothing for a long stretch cannot page the whole table inside one
    // request. With `hasMore = collected.length > limit`, hitting that cap with
    // a short page emitted NO `next_cursor` — which the client renders as "end
    // of feed". Every match below the stopping point became unreachable, and
    // the response looked completely normal.
    //
    // The matches sit ~60k rows down, past what 12 doubling rounds can reach in
    // one request, so the first call MUST come back short AND resumable.
    const DEEP = 60_000;
    const audit = Array.from({ length: 70_000 }, (_, i) =>
      mkAudit(`r-${1_000_000 - i}`, 1_000_000 - i, i >= DEEP ? 'cognition_output' : undefined));
    const { deps } = world(audit, []);

    const first = await handleMemoryList(deps, { limit: 10, kind: 'cognition_output' });
    expect(first.entries.length, 'the cap should bite before reaching the matches')
      .toBeLessThan(10);
    expect(first.next_cursor, 'a capped walk must be resumable').toBeDefined();

    // ...and continuing actually reaches them.
    const seen: string[] = [];
    let cursor: string | undefined = first.next_cursor;
    seen.push(...first.entries.map((e) => e.memory_id));
    for (let p = 0; p < 40 && cursor !== undefined; p++) {
      const res: Awaited<ReturnType<typeof handleMemoryList>> = await handleMemoryList(
        deps,
        { limit: 10, kind: 'cognition_output', cursor },
      );
      seen.push(...res.entries.map((e) => e.memory_id));
      cursor = res.next_cursor;
      if (seen.length >= 30) break;
    }
    expect(seen.length).toBeGreaterThanOrEqual(30);
    expect(new Set(seen).size).toBe(seen.length);          // no repeats
    expect(seen[0]).toBe(`r-${1_000_000 - DEEP}`);         // and the right ones
  });

  it('⛔ a filter matching NOTHING terminates instead of walking forever', async () => {
    const audit = Array.from({ length: 2_000 }, (_, i) => mkAudit(`r-${1e6 + i}`, 1_000 + i));
    const { deps, meter } = world(audit, []);
    const res = await handleMemoryList(deps, { limit: 10, kind: 'no-such-kind' });
    expect(res.entries).toHaveLength(0);
    expect(res.next_cursor).toBeUndefined();
    expect(meter.unbounded).toBe(0);
  });

  it('⛔ one exhausted source does not truncate the other', async () => {
    // The asymmetric case: 400 audit rows against 3 user rows. The user source
    // never fills its window, so it contributes no horizon; if an empty or
    // short source were treated as a bound, the feed would stop at row 3.
    const audit = Array.from({ length: 400 }, (_, i) => mkAudit(`r-${1000 + i}`, 1_000 + i));
    const user = [mkUser('umem-a', 5), mkUser('umem-b', 4), mkUser('umem-c', 3)];
    const { deps } = world(audit, user);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let p = 0; p < 100; p++) {
      const res: Awaited<ReturnType<typeof handleMemoryList>> = await handleMemoryList(
        deps,
        { limit: 40, ...(cursor ? { cursor } : {}) },
      );
      seen.push(...res.entries.map((e) => e.memory_id));
      if (res.next_cursor === undefined) break;
      cursor = res.next_cursor;
    }
    expect(seen).toHaveLength(403);
    expect(seen.slice(-3)).toEqual(['umem-a', 'umem-b', 'umem-c']);
  });

  it('handles rows that TIE on effective time', async () => {
    // Equal timestamps are what makes a naive `ts`-only cursor skip or repeat:
    // the id tiebreak is the only thing separating them.
    const audit = Array.from({ length: 150 }, (_, i) => mkAudit(`r-${1000 + i}`, 500));
    const user = Array.from({ length: 150 }, (_, i) => mkUser(`umem-${1000 + i}`, 500));
    const { deps } = world(audit, user);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let p = 0; p < 100; p++) {
      const res: Awaited<ReturnType<typeof handleMemoryList>> = await handleMemoryList(
        deps,
        { limit: 20, ...(cursor ? { cursor } : {}) },
      );
      seen.push(...res.entries.map((e) => e.memory_id));
      if (res.next_cursor === undefined) break;
      cursor = res.next_cursor;
    }
    expect(new Set(seen).size).toBe(300);
    expect(seen).toHaveLength(300);
  });
});

/** ⛔ THE FEATURE-DETECTED SQL PATH IS A SECOND IMPLEMENTATION.
 *
 *  `listWindow` takes `listWindowDesc` when the backing is SQLite and sorts in
 *  JS otherwise. The in-memory collection backs the tests, so without this block
 *  every assertion above would exercise the FALLBACK while production runs the
 *  SQL — the two would only have to agree by good intentions. Each case asserts
 *  its premise (which path it is on) before comparing. */
describe('listWindowDesc vs the in-memory fallback', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({
    memory_id: `umem-${1000 + i}`,
    ts: 1_000 + (i % 97),                       // deliberate ties
    ...(i % 3 === 0 ? { event_at: 5_000 + i } : {}),   // some bistemporal, some not
    kind: 'note',
    size_bytes: 0,
  }));

  const sqlBacked = async () => {
    const db = new Database(':memory:');
    const col = createSQLiteCollection<typeof rows[number]>(db, 'winbench');
    for (const r of rows) await col.set(r.memory_id, r);
    return { db, col };
  };

  const memBacked = async () => {
    const col = createInMemoryCollection<typeof rows[number]>();
    for (const r of rows) await col.set(r.memory_id, r);
    return col;
  };

  const WINDOW = { tsPath: 'event_at', tsFallbackPath: 'ts', idPath: 'memory_id' } as const;

  const jsWindow = (limit: number, before?: { ts: number; id: string }) => {
    const eff = (r: typeof rows[number]): number => r.event_at ?? r.ts;
    const ordered = [...rows].sort((a, b) =>
      (eff(b) - eff(a))
      || (a.memory_id < b.memory_id ? 1 : a.memory_id > b.memory_id ? -1 : 0));
    const after = before === undefined
      ? ordered
      : ordered.filter((r) => (eff(r) !== before.ts ? eff(r) < before.ts : r.memory_id < before.id));
    return after.slice(0, limit).map((r) => r.memory_id);
  };

  it('⛔ PREMISE: only the SQLite backing advertises the capability', async () => {
    // If this ever flips, the differential below is comparing one path with
    // itself and every other case in this file is decorative.
    const { db, col } = await sqlBacked();
    const mem = await memBacked();
    expect('listWindowDesc' in col).toBe(true);
    expect('listWindowDesc' in mem).toBe(false);
    db.close();
  });

  it('⛔ SQL and JS agree on the full walk, ties and bistemporal rows included', async () => {
    const { db, col } = await sqlBacked();
    col.ensureWindowIndex(WINDOW);

    let before: { ts: number; id: string } | undefined;
    const walked: string[] = [];
    for (let p = 0; p < 100; p++) {
      const page = await col.listWindowDesc({ ...WINDOW, limit: 17, ...(before ? { before } : {}) });
      expect(page.map((r) => r.memory_id), `page ${p}`).toEqual(jsWindow(17, before));
      if (page.length === 0) break;
      walked.push(...page.map((r) => r.memory_id));
      const last = page[page.length - 1]!;
      before = { ts: last.event_at ?? last.ts, id: last.memory_id };
    }
    expect(new Set(walked).size).toBe(rows.length);
    db.close();
  });

  /** EXPLAIN the statement the COLLECTION prepared, never one written here —
   *  a hand-written query proves what SQLite does with the test's SQL. */
  const planOf = async (
    before: { ts: number; id: string } | undefined,
    withIndex: boolean,
  ): Promise<{ plan: string; sql: string; close: () => void }> => {
    const { db, col } = await sqlBacked();
    if (withIndex) col.ensureWindowIndex(WINDOW);
    const prepared: string[] = [];
    const real = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      prepared.push(sql);
      return real(sql);
    };
    await col.listWindowDesc({ ...WINDOW, limit: 20, ...(before ? { before } : {}) });
    const sql = prepared.find((q) => /ORDER BY/i.test(q) && /COALESCE/i.test(q))!;
    const args = before ? [before.ts, before.ts, before.id, 20] : [20];
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{
      detail: string;
    }>).map((r) => r.detail).join(' ; ');
    return { plan, sql, close: () => db.close() };
  };

  it('⛔ a cursored page SEEKS — it does not scan the index ahead of it', async () => {
    // ⛔ THE DISTINCTION THAT COST A REWRITE. The natural cursor predicate,
    // `(eff < ? OR (eff = ? AND id < ?))`, produces `SCAN t USING INDEX` — the
    // index satisfies the ORDER BY but the cursor is a filter, so page N walks
    // every entry ahead of it. Row values do not fix it: SQLite will not use a
    // MULTI-COLUMN EXPRESSION index as a range constraint. Hoisting a leading
    // `eff <= ?` conjunct produces `SEARCH ... (<expr><?)`.
    //
    // ⚠ Both forms return byte-identical rows, so ONLY this assertion can tell
    // them apart. `USING INDEX` alone is not enough — the broken form says that
    // too.
    const seek = await planOf({ ts: 5_200, id: 'umem-1100' }, true);
    expect(seek.plan, seek.sql).toMatch(/SEARCH .* USING (COVERING )?INDEX/);
    // ⚠ `TEMP B-TREE`, not `TEMP B-TREE FOR ORDER BY`. An index missing its id
    // column still SEEKS and still says `USING INDEX` — it just sorts the last
    // ORDER BY term, which SQLite reports as `USE TEMP B-TREE FOR LAST TERM OF
    // ORDER BY`. The narrower pattern reads as strict and matches neither.
    expect(seek.plan, seek.sql).not.toMatch(/TEMP B-TREE/);
    seek.close();
  });

  it('⛔ KNOWN NEGATIVE: without the index the same statement scans + sorts', async () => {
    // Proves the assertion above discriminates rather than matching anything.
    const bare = await planOf({ ts: 5_200, id: 'umem-1100' }, false);
    expect(bare.plan).toMatch(/SCAN/);
    expect(bare.plan).toMatch(/TEMP B-TREE/);
    bare.close();
  });

  it('the FIRST page needs no seek — an ordered index walk stops at LIMIT', async () => {
    // No cursor means no range constraint, so this is a SCAN by construction —
    // and the right plan: it reads LIMIT entries off the top of the index. What
    // matters is that it never sorts.
    const first = await planOf(undefined, true);
    expect(first.plan, first.sql).toMatch(/USING (COVERING )?INDEX/);
    expect(first.plan, first.sql).not.toMatch(/TEMP B-TREE/);
    first.close();
  });

  it('⛔ CONSTRUCTING the audit store creates its window index — no caller opt-in', async () => {
    // ⛔ THE FIX THAT ALMOST SHIPPED INERT. Every case above calls
    // `ensureWindowIndex` itself, so all of them were green while the real
    // server created no index at all: `createAuditLogStore` is composed over a
    // `createSQLiteCollection` in `compose-storage-context.ts` and nothing there
    // asked for one. The window query would have SCANned a 5 GB
    // `audit_entries` and TEMP B-TREE-sorted it on every page — returning
    // perfectly correct rows the whole time.
    //
    // 🔑 So this asserts the INDEX EXISTS AFTER CONSTRUCTION, with no setup
    // call in between. That is the property the composition root depends on.
    const db = new Database(':memory:');
    const entries = createSQLiteCollection<AuditEntry>(db, 'audit_entries');
    const activities = createSQLiteCollection<Record<string, unknown>>(db, 'audit_activities');
    createAuditLogStore(entries as never, activities as never);

    const idx = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='audit_entries'`,
    ).all() as Array<{ sql: string | null }>;
    const win = idx.map((r) => r.sql ?? '').find((d) => /COALESCE/i.test(d));
    expect(win, 'no window index on audit_entries after construction').toBeDefined();
    expect(win).toMatch(/event_at/);
    expect(win).toMatch(/started_at/);
    expect(win).toMatch(/run_id/);
    db.close();
  });

  it('⛔ and the audit store SEEKS through it, over its own real statement', async () => {
    // The sibling half: the index above has to be the one `listWindow` uses.
    // Asserted through `createAuditLogStore` rather than the collection, so it
    // covers the store's choice of ts path (`event_at` / `started_at`) too — a
    // store windowing on the wrong field would still say `USING INDEX`.
    const db = new Database(':memory:');
    const entries = createSQLiteCollection<AuditEntry>(db, 'audit_entries');
    const activities = createSQLiteCollection<Record<string, unknown>>(db, 'audit_activities');
    const log = createAuditLogStore(entries as never, activities as never);
    for (let i = 0; i < 500; i++) {
      await entries.set(`r-${1000 + i}`, {
        run_id: `r-${1000 + i}`, started_at: 10_000 + i,
      } as unknown as AuditEntry);
    }

    const prepared: string[] = [];
    const real = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      prepared.push(sql);
      return real(sql);
    };
    const page = await log.listWindow({ limit: 20, before: { ts: 10_400, id: 'r-1400' } });
    expect(page).toHaveLength(20);

    const sql = prepared.find((q) => /ORDER BY/i.test(q) && /COALESCE/i.test(q))!;
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(10_400, 10_400, 'r-1400', 20) as Array<{ detail: string }>)
      .map((r) => r.detail).join(' ; ');
    expect(plan, sql).toMatch(/SEARCH .* USING (COVERING )?INDEX/);
    expect(plan, sql).not.toMatch(/TEMP B-TREE/);
    db.close();
  });

  it('⛔ CONSTRUCTING the user_memory store creates its window index too', async () => {
    // The sibling of the audit case, and it survived a mutation until this
    // existed: `memory.list` unions TWO sources, so an index on one of them
    // leaves the other scanning — and D-230 left `user_memory` with no quota at
    // all, which makes it the source with no ceiling on how large it gets.
    const db = new Database(':memory:');
    const col = createSQLiteCollection<UserMemoryRow>(db, 'user_memory');
    const blobs = {
      async get() { return null; },
      async put() { return 'h'; },
      async delete() { /* noop */ },
    };
    createUserMemoryStore(col, blobs as never, { db } as never);

    const idx = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='user_memory'`,
    ).all() as Array<{ sql: string | null }>).map((r) => r.sql ?? '');
    const win = idx.find((d) => /COALESCE/i.test(d));
    expect(win, 'no window index on user_memory after construction').toBeDefined();
    expect(win).toMatch(/event_at/);
    expect(win).toMatch(/memory_id/);
    db.close();
  });

  it('rejects a path that is not a clean field name', async () => {
    // The paths are INTERPOLATED into SQL text (a bound json path is
    // unindexable by construction), so the validation is load-bearing.
    const { db, col } = await sqlBacked();
    await expect(col.listWindowDesc({
      ...WINDOW, tsPath: "ts') OR 1=1 --", limit: 5,
    })).rejects.toThrow(/invalid/i);
    db.close();
  });
});
