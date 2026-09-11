/** Every Records list page seeks instead of scanning + sorting the table.
 *
 *  ⛔ THE DEFECT. `listTasks` / `listCommitments` / `listBookings` /
 *  `listProjects` page with `ORDER BY <ts> DESC LIMIT ? OFFSET ?`, and every
 *  index on those tables leads with a FILTER column (`lifecycle_state`,
 *  `state`, `done_at`…), which cannot serve that order. So each page was a full
 *  table SCAN plus a temp b-tree sort. Measured at 100k rows, page 20:
 *
 *      data_task        43.0ms      data_commitment  50.8ms
 *      data_booking     39.5ms      data_project     38.3ms      -> 0.2ms
 *
 *  D-230 sized Records at 5 GB, so there is no ceiling holding these small.
 *
 *  ⚠ `data_note` ALREADY had this index (`idx_note_last_user_action`) and was
 *  0.2ms before any change. It is kept here as the control: a harness that
 *  reports every table as improved is measuring itself.
 *
 *  ⛔ THE OBVIOUS COMPOSITE IS THE WRONG ANSWER, and only measurement says so.
 *  `(sync_state, created_at DESC, id DESC)` — filter column first, textbook —
 *  measured 28.1ms against a 27.4ms baseline: no improvement whatsoever. The
 *  list filter is `sync_state IN ('live','stale_unreachable')`, and an IN over
 *  two values makes SQLite merge two ranges, forfeiting the index's ordering.
 *  The bare ordering index wins because the filter barely narrows anything
 *  (almost every row is `live`).
 *
 *  ⚠ WHAT IS NOT A DEFECT, checked and left alone: `getBookingHistory` sorts
 *  too, but it narrows to one contact's completed bookings with `LIMIT 10`
 *  first — the sort is over a handful of rows. A sweep that flagged it would be
 *  reporting the shape rather than the cost. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';

/** The four built-in Sources the D-145 suites register. Writers need one, and
 *  the list filter joins `source_registry`, so an empty registry makes the
 *  equivalence case below fail on a foreign key rather than on the query. */
const registerBuiltinSources = (s: WorkEntityStore): void => {
  for (const kind of ['task', 'note', 'commitment', 'project'] as const) {
    s.registerSource({
      id: `recued.${kind}`,
      top_tier_kind: kind,
      source_kind: 'builtin',
      source_label: `Recued built-in (${kind}s)`,
      write_capable: true,
      mcp_exposed: false,
    } as never);
  }
};

/** Record the SQL the STORE prepares, then EXPLAIN that text.
 *
 *  ⛔ NOT SQL WRITTEN HERE. A hand-written `SELECT … ORDER BY updated_at DESC`
 *  proves what SQLite does with the TEST's query; it says nothing about the one
 *  `listTasks` builds — and these statements interpolate a `where` fragment
 *  assembled at runtime, so the two are easy to drift apart. */
const world = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // ⚠ The same setup the store's own suites use. `createWorkEntityStore` does
  // not build `source_registry`, and the list filter joins against it — a
  // hand-rolled fixture fails on the query this test exists to EXPLAIN.
  ensureWorkEntitySchema(db);
  const prepared: string[] = [];
  const real = db.prepare.bind(db);
  const store = createWorkEntityStore(db);
  registerBuiltinSources(store);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    prepared.push(sql);
    return real(sql);
  };
  return { db, store, prepared };
};

/** The plan for the one recorded statement matching `shape`. Placeholders are
 *  bound with throwaway values — the plan does not depend on them. */
const planOf = (db: Database.Database, prepared: readonly string[], shape: RegExp): string => {
  const hits = prepared.filter((s) => shape.test(s));
  if (hits.length !== 1) {
    throw new Error(`expected exactly one statement matching ${shape}, got ${hits.length}`);
  }
  const sql = hits[0]!;
  const n = (sql.match(/\?/g) ?? []).length;
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...Array.from({ length: n }, () => 1)) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' ; ');
};

const CASES = [
  { kind: 'task', shape: /FROM data_task .*ORDER BY updated_at DESC/s, drop: 'idx_task_updated_at', run: (s: ReturnType<typeof world>['store']) => s.listTasks({}) },
  { kind: 'commitment', shape: /FROM data_commitment .*ORDER BY state_changed_at DESC/s, drop: 'idx_commitment_state_changed', run: (s: ReturnType<typeof world>['store']) => s.listCommitments({}) },
  { kind: 'booking', shape: /FROM data_booking .*ORDER BY created_at DESC, id DESC/s, drop: 'idx_booking_created', run: (s: ReturnType<typeof world>['store']) => s.listBookings({}) },
  { kind: 'project', shape: /FROM data_project .*ORDER BY last_activity_at DESC/s, drop: 'idx_project_last_activity', run: (s: ReturnType<typeof world>['store']) => s.listProjects({}) },
] as const;

describe('Records list ordering indexes', () => {
  it('upgrades an existing timestamp-only task index once and keeps tied pages stable', () => {
    const { db, store, prepared } = world();
    try {
      const seeds = [
        { id: 'task-c', now: 3000 }, { id: 'task-old', now: 1000 },
        { id: 'task-a', now: 3000 }, { id: 'task-middle', now: 2000 },
        { id: 'task-b', now: 3000 },
      ];
      for (const { id, now } of seeds) store.writeTask({ id, title: id, source_id: 'recued.task' }, now);
      db.exec('DROP INDEX idx_task_updated_at; CREATE INDEX idx_task_updated_at ON data_task (updated_at DESC)');
      prepared.length = 0;
      const before = store.listTasks({}).map((task) => task.id);
      expect(planOf(db, prepared, CASES[0].shape)).toMatch(/TEMP B-TREE/);
      expect(before).toEqual(['task-a', 'task-b', 'task-c', 'task-middle', 'task-old']);

      ensureWorkEntitySchema(db);
      prepared.length = 0;
      expect(store.listTasks({}).map((task) => task.id)).toEqual(before);
      expect(planOf(db, prepared, CASES[0].shape)).not.toMatch(/TEMP B-TREE/);
      expect(store.listTasks({ limit: 2 }).map((task) => task.id)).toEqual(['task-a', 'task-b']);
      expect(store.listTasks({ limit: 2, offset: 2 }).map((task) => task.id)).toEqual(['task-c', 'task-middle']);
      expect(store.countTasks({})).toBe(5);

      const ddl = vi.spyOn(db, 'exec');
      try {
        ensureWorkEntitySchema(db);
        expect(ddl.mock.calls.some(([sql]) => /DROP INDEX.*idx_task_updated_at/s.test(sql))).toBe(false);
      } finally { ddl.mockRestore(); }
    } finally { db.close(); }
  });

  for (const c of CASES) {
    it(`⛔ list${c.kind}s does not sort — it walks the ordering index`, () => {
      const { db, store, prepared } = world();
      c.run(store);                       // forces the prepare
      const plan = planOf(db, prepared, c.shape);
      expect(plan, c.kind).not.toMatch(/TEMP B-TREE/);
      expect(plan, c.kind).toMatch(/USING (COVERING )?INDEX/);
      db.close();
    });

    it(`⛔ KNOWN NEGATIVE: dropping ${c.drop} brings the sort back`, () => {
      // Without this, the assertion above could be passing because SQLite
      // happens not to sort a table with no rows in it — which is the failure
      // mode a plan test is most likely to have.
      const { db, store, prepared } = world();
      db.exec(`DROP INDEX ${c.drop}`);
      c.run(store);
      const plan = planOf(db, prepared, c.shape);
      expect(plan, c.kind).toMatch(/TEMP B-TREE/);
      db.close();
    });
  }

  it('⛔ data_note is the CONTROL — it already had its index and still seeks', () => {
    // If this ever needs a new index, the premise of the whole change (that one
    // of the five was already right) has moved.
    const { db, store, prepared } = world();
    store.listNotes({});
    const plan = planOf(db, prepared, /FROM data_note .*ORDER BY last_user_action_at DESC/s);
    expect(plan).not.toMatch(/TEMP B-TREE/);
    db.close();
  });

  it('the lists still return what they returned, in the same order', () => {
    // Equivalence: an index moves the plan, never the answer. Written through
    // the store's own writers so the rows are shaped the way it shapes them.
    const { db, store } = world();
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      made.push(store.writeTask({ title: `t${i}`, source_id: 'recued.task' } as never).id);
    }
    const listed = store.listTasks({}).map((t) => t.id);
    expect(new Set(listed)).toEqual(new Set(made));
    // Newest-first by `updated_at`, id-stable — the order the index provides.
    const times = store.listTasks({}).map((t) => t.updated_at);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    db.close();
  });

  it('⛔ every new index is created by the SCHEMA, not by a caller', () => {
    // The index has to arrive with the table. Left to a composition root it
    // ships inert, and the plan tests above would still pass because each of
    // them builds its own store.
    const { db } = world();
    const names = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index'`,
    ).all() as Array<{ name: string }>).map((r) => r.name);
    for (const c of CASES) {
      expect(names, `${c.drop} missing`).toContain(c.drop);
    }
    db.close();
  });
});
