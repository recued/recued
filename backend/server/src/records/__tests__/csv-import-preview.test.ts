/** D-292 — an import says what it SAW: the file's header, the mapped columns the
 *  file does not have, and (dry run only) the first rows as the rehearsal handled
 *  them.
 *
 *  ⛔⛔ WHY THESE ARE STORE FACTS AND NOT A CLIENT'S GUESS. A dry run exists for a
 *  mapping that is VALID but points at the WRONG column — every row lands,
 *  `failed: 0`. Only the values show it, and the values live here: the planned rows
 *  existed inside `importCsv` and were thrown away. Each row's outcome is read off the
 *  REAL rolled-back rehearsal, so `records_conflict` on a row the owner edited shows
 *  as `failed` on that exact line instead of being predicted by a second
 *  implementation that could disagree.
 *
 *  Same real store + in-memory SQLite as `csv-import-action.test.ts`; the namespace
 *  installs only the import op.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RECORDS_IMPORT_ECHO_CHARS,
  RECORDS_IMPORT_HEADER_LIMIT,
  RECORDS_IMPORT_PREVIEW_LIMIT,
  type RecordsExecutionBinding, type RecordsImportResult,
  type RecordsPackRef, type RecordsSchemaSnapshot,
} from '@recued/contracts';

import { createRecordsStore, type RecordsStore } from '../store.js';

const OWNER: RecordsPackRef = { publisher: 'recued-core', pack_slug: 'statements' };
const SH = 'a'.repeat(64), DH = 'b'.repeat(64);

const importBinding: RecordsExecutionBinding = {
  kind: 'core.records', action: 'import' as never, entity: 'line', owner: OWNER,
  pack_version: 1, storage_schema_hash: SH, declaration_hash: DH,
  operation_digest: 'd:import:line',
};

const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    line: { kind: 'line', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'posted_on', slot: 's1', kind: 'string', required: true },
      { key: 'description', slot: 's2', kind: 'string', required: true },
      { key: 'category', slot: 's3', kind: 'string', required: true },
      { key: 'amount', slot: 'n1', kind: 'number', required: false },
      { key: 'balance', slot: 'n2', kind: 'number', required: false },
    ] },
  },
};

const SPEC = {
  columns: [
    { column: 'Date', field: 'posted_on' },
    { column: 'Detail', field: 'description' },
    { column: 'Amount', field: 'amount' },
    { column: 'Bal', field: 'balance' },
  ],
  numeric_fields: ['amount', 'balance'],
  // `balance` is deliberately NOT part of identity: a re-export that restates a
  // line's balance differently collides on the same id with different values.
  dedup_on: ['posted_on', 'description', 'amount'],
  scope: 'acct-1',
  thousands_separator: ',',
  defaults: { category: '' },
};

const HEADER = 'Date,Detail,Amount,Bal';
const csvOf = (...lines: string[]): string => [HEADER, ...lines].join('\n');
const THREE = csvOf(
  '01-Jan,coffee,-3.50,996.50',
  '02-Jan,salary,"3,391.02","4,387.52"',
  '03-Jan,rent,"-1,200.00","3,187.52"',
);

describe('D-292 — the import reports what it saw', () => {
  let db: Database.Database;
  let store: RecordsStore;

  const run = (csv: string, opts: { spec?: unknown; dry_run?: boolean } = {}): RecordsImportResult =>
    store.execute({
      binding: importBinding, principal: 'owner',
      args: {
        csv, spec: opts.spec ?? SPEC,
        ...(opts.dry_run === undefined ? {} : { dry_run: opts.dry_run }),
      },
    }) as RecordsImportResult;

  const rowCount = (): number =>
    (db.prepare('SELECT count(*) AS n FROM core_records').get() as { n: number }).n;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    store = createRecordsStore(db, { now: (() => { let t = 1e12; return () => t++; })() });
    store.installNamespace({
      owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'x', schema, bindings: { importLine: importBinding },
    });
  });
  afterEach(() => db.close());

  describe('preview_sample — the rows a check would record', () => {
    it('a dry run returns the first rows with the values the store would receive, and writes nothing', () => {
      const r = run(THREE, { dry_run: true });
      expect(r.dry_run).toBe(true);
      expect(rowCount(), 'a rehearsal must leave the store untouched').toBe(0);
      expect(r.preview_sample).toEqual([
        { line: 2, outcome: 'written',
          values: { posted_on: '01-Jan', description: 'coffee', amount: -3.5, balance: 996.5 } },
        { line: 3, outcome: 'written',
          values: { posted_on: '02-Jan', description: 'salary', amount: 3391.02, balance: 4387.52 } },
        { line: 4, outcome: 'written',
          values: { posted_on: '03-Jan', description: 'rent', amount: -1200, balance: 3187.52 } },
      ]);
    });

    it('carries FILE-MAPPED fields only, in spec order — never the defaults', () => {
      const [first] = run(THREE, { dry_run: true }).preview_sample ?? [];
      // `category` is a default: the same '' on every line. In the preview it would
      // be noise sitting exactly where the owner is looking for their columns.
      expect(Object.keys(first!.values)).toEqual(['posted_on', 'description', 'amount', 'balance']);
    });

    it('a real import returns no preview', () => {
      const r = run(THREE);
      expect(r.written).toBe(3);
      expect(r.preview_sample).toBeUndefined();
    });

    it('each row carries its OWN rehearsed outcome — replayed lines and a conflicting one', () => {
      run(THREE);
      // Same identity for line 3 (date, detail, amount unchanged), different balance:
      // the store holds a different value under the same id ⇒ records_conflict.
      const r = run(csvOf(
        '01-Jan,coffee,-3.50,996.50',
        '02-Jan,salary,"3,391.02",9999',
        '03-Jan,rent,"-1,200.00","3,187.52"',
        '04-Jan,gym,-40,"3,147.52"',
      ), { dry_run: true });
      expect(r.preview_sample?.map((row) => [row.line, row.outcome])).toEqual([
        [2, 'replayed'], [3, 'failed'], [4, 'replayed'], [5, 'written'],
      ]);
      const conflict = r.preview_sample?.[1];
      expect(conflict?.code).toBe('records_conflict');
      expect(conflict?.reason).toEqual(expect.any(String));
      // The per-row outcomes agree with the counters they are drawn from.
      expect([r.replayed, r.failed, r.written]).toEqual([2, 1, 1]);
      expect(rowCount(), 'still only the first import').toBe(3);
    });

    it('a cell that will not parse previews as null — never as zero', () => {
      const r = run(csvOf('05-Jan,refund,£12.00,100'), { dry_run: true });
      expect(r.preview_sample?.[0]?.values.amount).toBeNull();
      expect(r.unparsed).toBe(1);
    });

    it(`stops at RECORDS_IMPORT_PREVIEW_LIMIT (${RECORDS_IMPORT_PREVIEW_LIMIT}) rows, while the counts stay exact`, () => {
      const lines = Array.from({ length: 25 }, (_, i) => `${String(i + 1).padStart(2, '0')}-Feb,item ${i},-1,${i}`);
      const r = run(csvOf(...lines), { dry_run: true });
      expect(r.rows_read).toBe(25);
      expect(r.written).toBe(25);
      expect(r.preview_sample).toHaveLength(RECORDS_IMPORT_PREVIEW_LIMIT);
      expect(r.preview_sample?.map((row) => row.line))
        .toEqual(Array.from({ length: RECORDS_IMPORT_PREVIEW_LIMIT }, (_, i) => i + 2));
    });

    it('cuts a long cell for display only — the rehearsal and the real import use all of it', () => {
      const long = 'x'.repeat(RECORDS_IMPORT_ECHO_CHARS + 50);
      const csv = csvOf(`06-Jan,${long},-1,1`);
      const shown = run(csv, { dry_run: true }).preview_sample?.[0]?.values.description;
      expect(shown).toBe(`${'x'.repeat(RECORDS_IMPORT_ECHO_CHARS)}…`);
      expect(run(csv).written).toBe(1);
      const stored = db.prepare('SELECT s2 FROM core_records').get() as { s2: string };
      expect(stored.s2).toBe(long);
    });
  });

  describe('columns_missing — a misspelt column is no longer silent', () => {
    it('names every mapped column the file does not have, and still imports (reported, not halted)', () => {
      const spec = {
        ...SPEC,
        columns: [
          { column: 'Date', field: 'posted_on' },
          { column: 'Detail', field: 'description' },
          { column: 'Amount', field: 'amount' },
          // Trailing space: the most ordinary way to miss a column by hand.
          { column: 'Bal ', field: 'balance' },
        ],
      };
      const r = run(THREE, { spec });
      expect(r.columns_missing).toEqual(['Bal ']);
      expect(r.written, 'the rule for import is land what you can and report the rest').toBe(3);
      const balances = db.prepare('SELECT n2 FROM core_records').all() as { n2: number | null }[];
      expect(balances.every((row) => row.n2 === null)).toBe(true);
    });

    it('is empty when every mapped column is present', () => {
      expect(run(THREE, { dry_run: true }).columns_missing).toEqual([]);
    });

    it('a header-only file answers from the header row', () => {
      const r = run(HEADER, { dry_run: true });
      expect(r.rows_read).toBe(0);
      expect(r.columns_missing).toEqual([]);
      expect(r.header).toEqual(['Date', 'Detail', 'Amount', 'Bal']);
    });

    it('⛔ a mapped name an Object already has (`constructor`) no longer crashes the whole import', () => {
      // Before D-292 the planner read `row['constructor']` off the prototype —
      // the Object function — and `.trim()` threw a TypeError that failed the
      // import and named nothing the owner wrote.
      const spec = {
        ...SPEC,
        columns: [...SPEC.columns.slice(0, 3), { column: 'constructor', field: 'category' }],
        numeric_fields: ['amount'],
        defaults: {},
      };
      const r = run(THREE, { spec, dry_run: true });
      expect(r.columns_missing).toEqual(['constructor']);
      expect(r.written).toBe(3);
      expect(r.preview_sample?.[0]?.values.category).toBe('');
    });
  });

  describe('header — what the columns actually are', () => {
    it('echoes the header in file order, BOM stripped, on a real import too', () => {
      const r = run(`﻿${THREE}`);
      expect(r.header).toEqual(['Date', 'Detail', 'Amount', 'Bal']);
    });

    it('reads the header with the SPEC\'s delimiter', () => {
      const semi = THREE.replace(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g, ';');
      const r = run(semi, { spec: { ...SPEC, delimiter: ';', thousands_separator: ',' }, dry_run: true });
      expect(r.header).toEqual(['Date', 'Detail', 'Amount', 'Bal']);
      expect(r.columns_missing).toEqual([]);
    });

    it(`caps the echo at ${RECORDS_IMPORT_HEADER_LIMIT} names of ${RECORDS_IMPORT_ECHO_CHARS} characters`, () => {
      const extra = Array.from({ length: RECORDS_IMPORT_HEADER_LIMIT + 20 }, (_, i) => `c${i}`);
      const longName = 'L'.repeat(RECORDS_IMPORT_ECHO_CHARS + 1);
      const wide = [[longName, HEADER, ...extra].join(','), `x,01-Jan,coffee,-1,1${',v'.repeat(extra.length)}`].join('\n');
      const r = run(wide, { dry_run: true });
      expect(r.header).toHaveLength(RECORDS_IMPORT_HEADER_LIMIT);
      expect(r.header?.[0]).toBe(`${'L'.repeat(RECORDS_IMPORT_ECHO_CHARS)}…`);
      expect(r.header?.[1]).toBe('Date');
    });
  });
});
