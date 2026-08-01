import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RECORDS_MAX_PAGE_SIZE,
  type RecordsExecutionBinding,
  type RecordsPackRef,
  type RecordsSchemaSnapshot,
} from '@recued/contracts';

import { createRecordsStore, type RecordsStore } from '../store.js';

const OWNER: RecordsPackRef = { publisher: 'publisher-a', pack_slug: 'bulk' };
const SH = 'a'.repeat(64);
const DH = 'b'.repeat(64);

const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    doc: {
      kind: 'doc',
      fields: [
        { key: 'id', slot: 'pk', kind: 'id', required: true },
        { key: 'status', slot: 's1', kind: 'string', required: true },
        { key: 'seq', slot: 'n1', kind: 'number', required: true },
        // The expensive family: 1 MiB cap each, and only `is_null` may reach it.
        { key: 'body', slot: 't1', kind: 'text', required: false },
        { key: 'notes', slot: 't2', kind: 'text', required: false },
      ],
    },
  },
};

const bind = (
  action: RecordsExecutionBinding['action'],
  extra: Partial<RecordsExecutionBinding> = {},
): RecordsExecutionBinding => ({
  kind: 'core.records', action, entity: 'doc', owner: OWNER,
  pack_version: 1, storage_schema_hash: SH, declaration_hash: DH,
  operation_digest: `d:${action}`,
  ...extra,
});

const BINDINGS = {
  create: bind('create'),
  search: bind('search', { filter_fields: ['status', 'seq', 'body'], sort_fields: ['seq'] }),
  count: bind('count', { filter_fields: ['status', 'seq', 'body'] }),
};

const ROWS = 40;
const BODY_BYTES = 40 * 1024;
const TOTAL_TEXT = ROWS * BODY_BYTES * 2; // `body` + `notes` on every row.

describe('D-221 §6.5 query work is bounded by the PAGE, not the candidate set', () => {
  let db: Database.Database;
  let store: RecordsStore;
  /** Bytes every statement actually handed back, keyed by SQL. */
  let materialized: Array<{ sql: string; rows: number; bytes: number }>;
  /** Rows a statement STREAMED — work done, not memory held. */
  let streamed: Array<{ sql: string; rows: number }>;

  const ownDbExec = (sql: string, ...params: unknown[]): void => {
    db.prepare(sql).run(...params as []);
  };

  const measure = (): number => materialized.reduce((sum, entry) => sum + entry.bytes, 0);

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    materialized = [];
    streamed = [];
    // Record what each statement RETURNS, and how. `.all()` MATERIALIZES its
    // whole result; `.iterate()` streams it. Wrapping only `.all()` would go
    // blind the moment a scan switched to `iterate` — a passing assertion
    // resting on a probe that no longer observes the path it polices — so both
    // are instrumented, and the two are asserted differently: streamed rows are
    // WORK (unavoidable, O(candidates)), materialized rows are RETENTION (which
    // must stay O(page)).
    const realPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      const statement = realPrepare(sql);
      const realAll = statement.all.bind(statement);
      const realIterate = statement.iterate.bind(statement);
      (statement as unknown as { all: unknown }).all = (...args: unknown[]) => {
        const rows = realAll(...args as []) as unknown[];
        materialized.push({
          sql,
          rows: rows.length,
          bytes: Buffer.byteLength(JSON.stringify(
            rows,
            (_key, value) => typeof value === 'bigint' ? String(value) : value,
          ) ?? ''),
        });
        return rows;
      };
      (statement as unknown as { iterate: unknown }).iterate = function* (...args: unknown[]) {
        let yielded = 0;
        for (const row of realIterate(...args as []) as IterableIterator<unknown>) {
          yielded += 1;
          yield row;
        }
        streamed.push({ sql, rows: yielded });
      };
      return statement;
    };

    store = createRecordsStore(db, { now: (() => { let t = 1_800_000_000_000; return () => t++; })() });
    store.installNamespace({
      owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'artifact-bulk', schema, bindings: BINDINGS,
    });
    for (let index = 0; index < ROWS; index += 1) {
      store.execute({
        binding: BINDINGS.create,
        principal: 'owner',
        args: {
          id: `doc-${String(index).padStart(3, '0')}`,
          values: {
            status: 'open',
            seq: index,
            body: 'b'.repeat(BODY_BYTES),
            notes: 'n'.repeat(BODY_BYTES),
          },
        },
      });
    }
    materialized = []; streamed = []; // Measure the QUERY, not the seeding.
  });

  afterEach(() => db.close());

  it('reads an EMPTY cursor as the first page, not as a bad handle', () => {
    // ⛔ `''` is this system's canonical first-page value, in three places: the
    // engine injects a paged recipe's declared default into config, it OFFERS
    // paging only when that default is exactly `''`, and a fresh Search
    // re-sets `config.cursor = ''` (`outputFilterSearchConfig`). Looking it up
    // as a token failed all three — so a Records-backed list broke on its FIRST
    // load and on every new search with "cursor is unknown or expired",
    // pointing at page state rather than at the empty default.
    // Found by running a whole pack live; four shipped recipes were affected,
    // `list-job-board` among them.
    const withEmpty = store.execute({
      binding: BINDINGS.search,
      principal: 'owner',
      args: { filters: { status: 'open' }, sort: 'seq', limit: 2, cursor: '' },
    }) as { records: Array<Record<string, unknown>>; next_cursor?: string };
    const withNone = store.execute({
      binding: BINDINGS.search,
      principal: 'owner',
      args: { filters: { status: 'open' }, sort: 'seq', limit: 2 },
    }) as { records: Array<Record<string, unknown>>; next_cursor?: string };

    expect(withEmpty.records.map((r) => r.id)).toEqual(['doc-000', 'doc-001']);
    expect(withEmpty.records.map((r) => r.id)).toEqual(withNone.records.map((r) => r.id));
    // …and it still hands back a real next page, so paging is not just "works
    // once". A minted token continues to be validated.
    expect(withEmpty.next_cursor).toBeDefined();
    expect(() => store.execute({
      binding: BINDINGS.search,
      principal: 'owner',
      args: { filters: { status: 'open' }, sort: 'seq', limit: 2, cursor: 'not-a-token' },
    })).toThrow(/unknown or expired/);
  });

  it('search hydrates the page only — bytes scale with limit, not with matches', () => {
    const page = store.execute({
      binding: BINDINGS.search,
      principal: 'owner',
      args: { filters: { status: 'open' }, sort: 'seq', limit: 2 },
    }) as { records: Array<Record<string, unknown>>; next_cursor?: string };

    // Correctness first: the page is real, ordered, and FULLY hydrated. A thin
    // scan that forgot to hydrate would pass a byte budget and be useless.
    expect(page.records).toHaveLength(2);
    expect(page.records.map((record) => record.id)).toEqual(['doc-000', 'doc-001']);
    expect(page.records[0]!.body).toHaveLength(BODY_BYTES);
    expect(page.records[0]!.notes).toHaveLength(BODY_BYTES);
    expect(page.next_cursor).toBeDefined();

    // All 40 rows MATCH, so `SELECT *` over the candidate set would materialize
    // every one of them. The page is 2.
    const bytes = measure();
    expect(bytes).toBeLessThan(TOTAL_TEXT / 4);
    // And positively: at least the two hydrated rows' worth, so the assertion
    // above cannot be satisfied by returning nothing.
    expect(bytes).toBeGreaterThan(2 * BODY_BYTES);

    // The scan STREAMED every candidate — the work is unavoidable and this
    // proves the probe actually observed the scan rather than missing it.
    expect(streamed.reduce((sum, entry) => sum + entry.rows, 0)).toBe(ROWS);
    // But NOTHING materialized more than one page. That is the whole property:
    // retention scales with `limit`, not with how many rows matched.
    for (const entry of materialized) {
      expect(entry.rows, entry.sql.slice(0, 40)).toBeLessThanOrEqual(RECORDS_MAX_PAGE_SIZE);
    }
    expect(Math.max(...materialized.map((entry) => entry.rows))).toBe(2);
  });

  it('count materializes no row bodies at all, and is still exact', () => {
    const result = store.execute({
      binding: BINDINGS.count,
      principal: 'owner',
      args: { filters: { status: 'open' } },
    }) as { count: number };
    expect(result.count).toBe(ROWS);

    // `count` returns one integer. Reading 3.2 MB of text to produce it was pure
    // waste, and the quota that bounded it is owner-settable to any safe integer.
    // A count retains NOTHING: it streams the candidates and keeps a counter.
    expect(measure()).toBe(0);
    expect(materialized).toEqual([]);
    expect(streamed.reduce((sum, entry) => sum + entry.rows, 0)).toBe(ROWS);
  });

  it('export refuses over its envelope budget instead of exhausting the process', () => {
    // Export cannot stream — one digest-signed envelope holds the whole
    // selection — so it is bounded by the accounting the namespace already
    // keeps, and the refusal names the exit that exists.
    const oversize = 65 * 1024 * 1024;
    ownDbExec(`UPDATE ${'core_record_namespaces'} SET payload_bytes=? WHERE publisher=? AND pack_slug=?`,
      oversize, OWNER.publisher, OWNER.pack_slug);
    let refusal: { code?: string; message?: string; details?: Record<string, unknown> } | undefined;
    try { store.exportNamespace(OWNER); } catch (error) { refusal = error as typeof refusal; }
    expect(refusal?.code).toBe('records_query_budget');
    expect(refusal?.message).toMatch(/export one kind at a time/);
    expect(refusal?.details).toMatchObject({ budget_bytes: 64 * 1024 * 1024 });

    // Permitting: a single kind is still exportable, because that is the exit
    // the refusal advertises — and its own size is measured, not inherited.
    const perKind = store.exportNamespace(OWNER, 'doc');
    expect(Object.values(perKind.records).flat()).toHaveLength(ROWS);
  });

  it('a text filter still works, without reading the text', () => {
    // `is_null` is the only predicate admitted on `t*`, so a text slot is
    // projected as a null-preserving sentinel. The answer must be identical to
    // one derived from the real 40 KB value.
    store.execute({
      binding: BINDINGS.create,
      principal: 'owner',
      args: { id: 'doc-empty', values: { status: 'open', seq: 999, body: null, notes: null } },
    });
    materialized = [];

    const missing = store.execute({
      binding: BINDINGS.count,
      principal: 'owner',
      args: { filters: { body: { op: 'is_null' } } },
    }) as { count: number };
    expect(missing.count).toBe(1);

    const present = store.execute({
      binding: BINDINGS.count,
      principal: 'owner',
      args: { filters: { body: { op: 'is_null', value: false } } },
    }) as { count: number };
    expect(present.count).toBe(ROWS);

    expect(measure()).toBeLessThan(BODY_BYTES);
  });
});
