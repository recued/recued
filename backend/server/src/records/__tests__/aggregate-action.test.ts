/** D-226 — `core.records.aggregate` against the real store.
 *
 *  The evaluator itself is proved in `packages/contracts`; what this file has
 *  to establish is the part only the store can be wrong about:
 *    - the DECLARED select is honoured and caller args cannot widen it,
 *    - decoded values reach the evaluator with the right KINDS (a decimal must
 *      arrive as its fixed-point string, not a scaled integer),
 *    - it STREAMS, so it keeps `count`'s retention posture rather than
 *      materializing a scan to return six numbers,
 *    - and the op and the in-memory array form return THE SAME ANSWER, which is
 *      the conformance check D-226 asks for. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateRecordsAggregate,
  evaluateRecordsGroupedAggregate,
  type RecordsGroupedAggregateResult,
  type RecordsExecutionBinding,
  type RecordsFieldKind,
  type RecordsPackRef,
  type RecordsSchemaSnapshot,
} from '@recued/contracts';

import { createRecordsStore, type RecordsStore } from '../store.js';

const OWNER: RecordsPackRef = { publisher: 'recued-core', pack_slug: 'billable-hours' };
const SH = 'a'.repeat(64);
const DH = 'b'.repeat(64);

const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    // ⚠ A `ref` slot is EXISTENCE-CHECKED within the pack — the parent must be a
    // real row. That is the within-pack r-slot rule D-226 records, enforced by
    // the store, so the fixture has to seat engagements before entries.
    engagement: {
      kind: 'engagement',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'label', slot: 's1', kind: 'string', required: true },
      ],
    },
    entry: {
      kind: 'entry',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'engagement_ref', slot: 'r1', kind: 'ref', required: true },
        { key: 'worked_on', slot: 'd1', kind: 'date', required: true },
        { key: 'task', slot: 's1', kind: 'string', required: false },
        { key: 'minutes', slot: 'n1', kind: 'number', required: true },
        { key: 'rate', slot: 'dec1', kind: 'decimal', required: false },
        { key: 'billable', slot: 'b1', kind: 'boolean', required: true },
        { key: 'invoiced', slot: 'b2', kind: 'boolean', required: true },
        { key: 'note', slot: 't1', kind: 'text', required: false },
      ],
    },
  },
};

const KINDS: Record<string, RecordsFieldKind> = {
  engagement_ref: 'ref', worked_on: 'date', task: 'string',
  minutes: 'number', rate: 'decimal', billable: 'boolean', invoiced: 'boolean', note: 'text',
};

const ROLLUP = {
  unbilled_minutes: { fn: 'sum', field: 'minutes' },
  entry_count: { fn: 'count' },
  task_count: { fn: 'count_distinct', field: 'task' },
  engagements: { fn: 'count_distinct', field: 'engagement_ref' },
  last_worked_on: { fn: 'max', field: 'worked_on' },
  last_task: { fn: 'latest', field: 'task', by: 'worked_on' },
  rate_total: { fn: 'sum', field: 'rate' },
} as const;

const bind = (
  action: RecordsExecutionBinding['action'],
  extra: Partial<RecordsExecutionBinding> = {},
  entity = 'entry',
  tag = '',
): RecordsExecutionBinding => ({
  kind: 'core.records', action, entity, owner: OWNER,
  pack_version: 1, storage_schema_hash: SH, declaration_hash: DH,
  // ⚠ MUST be unique per binding — two bindings sharing a digest collide at
  // install and the second silently never becomes callable.
  operation_digest: `d:${action}:${entity}${tag}`, ...extra,
});

const BINDINGS = {
  create: bind('create'),
  create_engagement: bind('create', {}, 'engagement'),
  search: bind('search', { filter_fields: ['billable', 'invoiced', 'task'], sort_fields: ['minutes'] }),
  rollup: bind('aggregate', { filter_fields: ['billable', 'invoiced', 'task'], select: ROLLUP }),
  no_select: bind('aggregate', { filter_fields: ['billable'] }, 'entry', ':noselect'),
  by_task: bind('aggregate', {
    filter_fields: ['billable', 'invoiced'], group_by: 'task',
    select: { minutes: { fn: 'sum', field: 'minutes' }, n: { fn: 'count' },
              money: { fn: 'sum', field: 'rate' }, last: { fn: 'max', field: 'worked_on' } },
  }, 'entry', ':bytask'),
  by_note: bind('aggregate', {
    filter_fields: ['billable'], group_by: 'note',
    select: { n: { fn: 'count' } },
  }, 'entry', ':bynote'),
  by_minutes: bind('aggregate', {
    filter_fields: ['billable'], group_by: 'minutes',
    select: { n: { fn: 'count' } },
  }, 'entry', ':byminutes'),
};

/** id, engagement, date, task, minutes, rate, billable, invoiced */
const SEED = [
  ['e1', 'engagement/a', '2026-07-02', 'ENG-441', 60, '10.5000', true, false],
  ['e2', 'engagement/a', '2026-07-09', 'ENG-441', 30, '10.5000', true, false],
  ['e3', 'engagement/b', '2026-07-14', 'ENG-502', 45, '20.2500', true, false],
  ['e4', 'engagement/b', '2026-07-20', 'ENG-502', 90, '20.2500', true, true],   // billed
  ['e5', 'engagement/a', '2026-07-21', '',        120, null,      false, false], // not billable
] as const;

describe('core.records.aggregate', () => {
  let db: Database.Database;
  let store: RecordsStore;
  let materialized: { sql: string; rows: number }[];
  let streamed: { sql: string; rows: number }[];

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    materialized = []; streamed = [];
    const realPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      const st = realPrepare(sql);
      const realAll = st.all.bind(st), realIterate = st.iterate.bind(st);
      (st as unknown as { all: unknown }).all = (...a: unknown[]) => {
        const rows = realAll(...a as []) as unknown[];
        materialized.push({ sql, rows: rows.length });
        return rows;
      };
      (st as unknown as { iterate: unknown }).iterate = function* (...a: unknown[]) {
        let n = 0;
        for (const row of realIterate(...a as []) as IterableIterator<unknown>) { n += 1; yield row; }
        streamed.push({ sql, rows: n });
      };
      return st;
    };
    store = createRecordsStore(db, { now: (() => { let t = 1_800_000_000_000; return () => t++; })() });
    store.installNamespace({
      owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'artifact-bh', schema, bindings: BINDINGS,
    });
    for (const id of ['a', 'b']) {
      store.execute({ binding: BINDINGS.create_engagement, principal: 'owner',
                      args: { id, values: { label: `Engagement ${id}` } } });
    }
    for (const [id, ref, worked_on, task, minutes, rate, billable, invoiced] of SEED) {
      store.execute({
        binding: BINDINGS.create, principal: 'owner',
        args: { id, values: { engagement_ref: ref, worked_on, task, minutes,
                              ...(rate === null ? {} : { rate }), billable, invoiced } },
      });
    }
    materialized = []; streamed = [];
  });
  afterEach(() => db.close());

  const rollup = (filters?: Record<string, unknown>) =>
    (store.execute({ binding: BINDINGS.rollup, principal: 'owner', args: filters ? { filters } : {} }) as
      { aggregate: Record<string, unknown> }).aggregate;

  it('answers the whole declared rollup over the rows a filter admits', () => {
    const r = rollup({ billable: true, invoiced: false });
    expect(r).toEqual({
      unbilled_minutes: 135,         // e1 60 + e2 30 + e3 45; e4 is billed, e5 is not billable
      entry_count: 3,
      task_count: 2,
      engagements: 2,
      last_worked_on: '2026-07-14',
      last_task: 'ENG-502',
      rate_total: '41.2500',         // 10.50 + 10.50 + 20.25
    });
  });

  it('⛔ a DECIMAL arrives as its fixed-point string, not a scaled integer', () => {
    // The slot stores a scaled int64. If the store handed the evaluator the raw
    // column, `sum` would return 412500 and look entirely plausible.
    expect(rollup({ billable: true, invoiced: false }).rate_total).toBe('41.2500');
    expect(rollup({ billable: true, invoiced: false }).rate_total).not.toBe(412500);
  });

  it('a REF counts distinct on its canonical encoding', () => {
    expect(rollup({ billable: true }).engagements).toBe(2);
  });

  it('with no filters it sees every row, including non-billable', () => {
    const r = rollup();
    expect(r.entry_count).toBe(5);
    expect(r.unbilled_minutes).toBe(345);
    expect(r.task_count).toBe(2);      // '' counts as absent, not a third task
  });

  it('an empty result set gives the documented empty answers, not zeros everywhere', () => {
    const r = rollup({ task: 'NOT-A-TASK' });
    expect(r).toMatchObject({ entry_count: 0, unbilled_minutes: 0, task_count: 0, rate_total: '0.0000' });
    expect(r.last_worked_on).toBeNull();
    expect(r.last_task).toBeNull();
  });

  it('⛔ the caller CANNOT widen the rollup — select comes from the binding', () => {
    const sneaky = store.execute({
      binding: BINDINGS.rollup, principal: 'owner',
      args: { filters: { billable: true }, select: { everything: { fn: 'sum', field: 'minutes' } } },
    }) as { aggregate: Record<string, unknown> };
    // the declared outputs, and nothing the caller asked for
    expect(Object.keys(sneaky.aggregate).sort()).toEqual(Object.keys(ROLLUP).sort());
    expect(sneaky.aggregate).not.toHaveProperty('everything');
  });

  it('an aggregate binding with no select refuses rather than returning {}', () => {
    expect(() => store.execute({ binding: BINDINGS.no_select, principal: 'owner', args: {} }))
      .toThrow(/declares no select/);
  });

  it('a filter field the binding never admitted is refused', () => {
    expect(() => rollup({ minutes: 60 })).toThrow();
  });

  it('⛔ STREAMS — it keeps count\'s retention posture, not search\'s', () => {
    rollup({ billable: true, invoiced: false });
    const scan = streamed.find(s => s.sql.includes('FROM'));
    expect(scan, 'the scan must be iterated, not materialized').toBeDefined();
    expect(materialized.filter(m => m.rows > 0)).toHaveLength(0);
  });

  it('does not read a 1 MiB text body to answer a rollup that never names it', () => {
    rollup({ billable: true });
    const scans = streamed.map(s => s.sql).join('\n');
    expect(scans).not.toMatch(/\bt1\b/);
  });
});

describe('⛔ CONFORMANCE — the op and the array form are ONE evaluator', () => {
  /** D-226: two implementations would drift, and the drift would be invisible —
   *  a recipe's aggregate and a root read over the same rows returning
   *  different numbers, each internally consistent, with no failing test
   *  anywhere. This is that test. */
  let db: Database.Database;
  let store: RecordsStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    store = createRecordsStore(db, { now: (() => { let t = 1_800_000_000_000; return () => t++; })() });
    store.installNamespace({
      owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'artifact-bh', schema, bindings: BINDINGS,
    });
    for (const id of ['a', 'b']) {
      store.execute({ binding: BINDINGS.create_engagement, principal: 'owner',
                      args: { id, values: { label: `Engagement ${id}` } } });
    }
    for (const [id, ref, worked_on, task, minutes, rate, billable, invoiced] of SEED) {
      store.execute({
        binding: BINDINGS.create, principal: 'owner',
        args: { id, values: { engagement_ref: ref, worked_on, task, minutes,
                              ...(rate === null ? {} : { rate }), billable, invoiced } },
      });
    }
  });
  afterEach(() => db.close());

  it('returns byte-equal results for the same declaration over the same rows', () => {
    for (const filters of [undefined, { billable: true }, { billable: true, invoiced: false },
                           { task: 'ENG-441' }, { task: 'NOT-A-TASK' }]) {
      const viaOp = (store.execute({
        binding: BINDINGS.rollup, principal: 'owner', args: filters ? { filters } : {},
      }) as { aggregate: Record<string, unknown> }).aggregate;

      // the same rows, fetched as records, run through the ARRAY form
      const rows = (store.execute({
        binding: BINDINGS.search, principal: 'owner',
        args: { ...(filters ? { filters } : {}), limit: 100 },
      }) as { records: Record<string, unknown>[] }).records;
      const viaArray = evaluateRecordsAggregate(rows, ROLLUP, KINDS);

      expect(JSON.stringify(viaArray), `filters ${JSON.stringify(filters)}`)
        .toBe(JSON.stringify(viaOp));
    }
  });
});

describe('⛔ a grouped aggregate — a declared LIST, still one query', () => {
  let db: Database.Database;
  let store: RecordsStore;
  let queries: number;

  const run = (binding: RecordsExecutionBinding, filters: Record<string, unknown> = {}) =>
    store.execute({ binding, principal: 'owner', args: { filters } }) as
      unknown as RecordsGroupedAggregateResult;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    queries = 0;
    const realPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      const st = realPrepare(sql);
      const realIterate = st.iterate.bind(st);
      (st as unknown as { iterate: unknown }).iterate = function* (...a: unknown[]) {
        if (/FROM core_records\b/.test(sql)) queries += 1;
        for (const row of realIterate(...a as []) as IterableIterator<unknown>) yield row;
      };
      return st;
    };
    store = createRecordsStore(db, { now: (() => { let t = 1_800_000_000_000; return () => t++; })() });
    store.installNamespace({
      owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'artifact-bh', schema, bindings: BINDINGS,
    });
    for (const id of ['a', 'b']) {
      store.execute({ binding: BINDINGS.create_engagement, principal: 'owner',
                      args: { id, values: { label: `Engagement ${id}` } } });
    }
    for (const [id, ref, worked_on, task, minutes, rate, billable, invoiced] of SEED) {
      store.execute({
        binding: BINDINGS.create, principal: 'owner',
        args: { id, values: { engagement_ref: ref, worked_on, task, minutes,
                              ...(rate === null ? {} : { rate }), billable, invoiced } },
      });
    }
  });
  afterEach(() => db.close());

  it('returns one row per key, filtered, in ONE scan', () => {
    queries = 0;
    const out = run(BINDINGS.by_task, { billable: true, invoiced: false });
    expect(queries, 'a grouped list must not become a query per group').toBe(1);
    expect(out.group_by).toBe('task');
    expect(out.groups).toEqual([
      { key: 'ENG-441', values: { minutes: 90, n: 2, money: '21.0000', last: '2026-07-09' } },
      { key: 'ENG-502', values: { minutes: 45, n: 1, money: '20.2500', last: '2026-07-14' } },
    ]);
    expect(out.complete).toBe(true);
  });

  it('⛔ decoded values reach the grouper with their KINDS — money is a string', () => {
    const out = run(BINDINGS.by_task, { billable: true, invoiced: false });
    expect(typeof out.groups[0]!.values.money).toBe('string');
    expect(out.groups[0]!.values.money).toBe('21.0000');   // 10.5 + 10.5, not 21
  });

  it('the empty-task row lands in the NULL bucket, not under ""', () => {
    const out = run(BINDINGS.by_task, { billable: false });
    expect(out.groups).toEqual([{ key: null, values:
      { minutes: 120, n: 1, money: '0.0000', last: '2026-07-21' } }]);
  });

  it('⛔⛔ the op and the in-memory form agree, group for group', () => {
    // The conformance check that keeps the store from becoming a second
    // implementation. Both read the same rows; the answers must be identical.
    const rows = (store.execute({
      binding: BINDINGS.search, principal: 'owner',
      args: { filters: { billable: true, invoiced: false } },
    }) as unknown as { records: Record<string, unknown>[] }).records;
    expect(run(BINDINGS.by_task, { billable: true, invoiced: false }).groups).toEqual(
      evaluateRecordsGroupedAggregate(rows, 'task',
        BINDINGS.by_task.select as never, KINDS).groups);
  });

  it('⛔ a TEXT field is refused as a key — which is why `note` cannot be one', () => {
    // ⚠ I wrote this test first as "a t-slot key is projected whole", guarding
    // the NULL-vs-'' presence trick `count` uses on text slots — and it failed,
    // because the vocabulary excludes `text` outright, so that case cannot
    // arise. The store still adds the group key to `valueNeeded`: unreachable
    // today, and load-bearing the moment `RECORDS_GROUP_BY_KINDS` widens. What
    // is provable is the refusal, so that is what this asserts.
    expect(() => run(BINDINGS.by_note, { billable: true }))
      .toThrow(/a text field cannot be a group key/);
  });

  it('⛔ refuses a group key the vocabulary excludes, at CALL time too', () => {
    // Authoring refuses this at install; the store re-checks because a binding
    // can be stamped by some other path and a bad key must not silently produce
    // one group per row.
    expect(() => run(BINDINGS.by_minutes, { billable: true }))
      .toThrow(/cannot be a group key/);
  });

  it('the ungrouped op is untouched by any of this', () => {
    const out = store.execute({ binding: BINDINGS.rollup, principal: 'owner',
      args: { filters: { billable: true, invoiced: false } } }) as
      unknown as { aggregate: Record<string, unknown> };
    expect(out.aggregate).toBeDefined();
    expect((out as unknown as RecordsGroupedAggregateResult).groups).toBeUndefined();
  });
});
