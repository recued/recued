/** `core.records.import` — a whole CSV file becomes rows, in one gated call.
 *
 *  ⛔⛔ THE ACTION EXISTS BECAUSE A RECIPE CANNOT DO THIS CORRECTLY. Driving
 *  `statement-import` against a real 1000-row bank export found four faults that are
 *  structural rather than bugs: the rows blew the 10 MB step-context cap at 11.9 MB,
 *  dedup by read-back is capped at 200 rows so any account past that compares against a
 *  fraction of itself, `upsert` cannot express a blind overwrite, and a `foreach` write
 *  reports SUCCESS when every single item was rejected. This file asserts the properties
 *  that replace them — and nothing here is provable from the artifact.
 *
 *  ⚠ THE NAMESPACE INSTALLS EXACTLY ONE WRITE OP: the import. No `create` binding
 *  exists, deliberately. Every row this action seats is therefore admitted by the
 *  import's OWN binding through `requireState`'s narrow divergence — so if that
 *  divergence stopped working, these tests stop passing, rather than quietly riding an
 *  installed sibling.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RECORDS_IMPORT_SAMPLE_LIMIT,
  type RecordsExecutionBinding, type RecordsImportResult,
  type RecordsPackRef, type RecordsSchemaSnapshot,
} from '@recued/contracts';

import { createRecordsStore, type RecordsStore } from '../store.js';

const OWNER: RecordsPackRef = { publisher: 'recued-core', pack_slug: 'statements' };
const SH = 'a'.repeat(64), DH = 'b'.repeat(64);

const bind = (
  action: string, entity: string, tag = '',
): RecordsExecutionBinding => ({
  kind: 'core.records', action: action as never, entity, owner: OWNER, pack_version: 1,
  storage_schema_hash: SH, declaration_hash: DH,
  operation_digest: `d:${action}:${entity}${tag}`,
});

const schema: RecordsSchemaSnapshot = {
  decimal_scale: 4,
  entities: {
    line: { kind: 'line', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'posted_on', slot: 's1', kind: 'string', required: true },
      { key: 'description', slot: 's2', kind: 'string', required: true },
      { key: 'category', slot: 's3', kind: 'string', required: true },
      { key: 'amount', slot: 'n1', kind: 'number', required: false },
      { key: 'money_in', slot: 'n3', kind: 'number', required: false },
      { key: 'money_out', slot: 'n4', kind: 'number', required: false },
      { key: 'balance', slot: 'n2', kind: 'number', required: false },
    ] },
    other: { kind: 'other', fields: [
      { key: 'id', slot: 'pk', kind: 'id', required: true },
      { key: 'note', slot: 's1', kind: 'string', required: true },
    ] },
  },
};

const B = {
  importLine: bind('import', 'line'),
  importOther: bind('import', 'other'),
};

/** The two-column money layout, mapped FAITHFULLY — one column, one field.
 *
 *  ⛔ THE STORE NEVER FOLDS THE PAIR. Which column means money out is a fact about a
 *  BANK, so combining them on the way in would put a figure in the warehouse that no
 *  line of the source ever contained, and the stored row would stop being checkable
 *  against the paper. The signed view is derived by readers, over a page of rows. */
const SPEC = {
  columns: [
    { column: 'Date', field: 'posted_on' },
    { column: 'Detail', field: 'description' },
    { column: 'In', field: 'money_in' },
    { column: 'Out', field: 'money_out' },
    { column: 'Bal', field: 'balance' },
  ],
  numeric_fields: ['money_in', 'money_out', 'balance'],
  dedup_on: ['posted_on', 'description', 'money_in', 'money_out'],
  scope: 'acct-1',
  thousands_separator: ',',
  defaults: { category: '' },
};

const HEADER = 'Date,Detail,In,Out,Bal';
const csvOf = (...lines: string[]): string => [HEADER, ...lines].join('\n');
const THREE = csvOf(
  '01-Jan,coffee,0,3.50,996.50',
  '02-Jan,salary,"3,391.02",0,"4,387.52"',
  '03-Jan,rent,0,"1,200.00","3,187.52"',
);

describe('core.records.import', () => {
  let db: Database.Database;
  let store: RecordsStore;

  const importCsv = (
    csv: string, spec: unknown = SPEC, binding = B.importLine,
  ): RecordsImportResult =>
    store.execute({ binding, principal: 'owner', args: { csv, spec } }) as RecordsImportResult;

  const rows = () =>
    db.prepare('SELECT pk, s1, s2, s3, n1, n2, n3, n4 FROM core_records ORDER BY s1').all() as
      { pk: string; s1: string; s2: string; s3: string;
        n1: number | null; n2: number | null; n3: number | null; n4: number | null }[];
  /** The signed view, combined HERE rather than stored — per column, so an absent slot
   *  contributes 0 to its own sum without ever standing in for a value inside an
   *  expression. `null - 0` is 0, and there is no subtraction for a null to hide in. */
  const signedNet = () =>
    rows().reduce((n, r) => n + Number(r.n1 ?? 0) + Number(r.n3 ?? 0) - Number(r.n4 ?? 0), 0);
  const rowCount = () =>
    (db.prepare('SELECT count(*) AS n FROM core_records').get() as { n: number }).n;

  /** ⛔ EVERY LINE MUST BE ACCOUNTED FOR. A partial import that under-reports is the
   *  failure this action was built to remove, and only the arithmetic can prove it did
   *  not happen — `written` alone is exactly the number a broken import gets right. */
  const accounted = (r: RecordsImportResult): RecordsImportResult => {
    expect(r.written + r.replayed + r.failed + r.not_attempted,
      `unaccounted rows: ${JSON.stringify(r)}`).toBe(r.rows_read);
    return r;
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    store = createRecordsStore(db, { now: (() => { let t = 1e12; return () => t++; })() });
    store.installNamespace({
      owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
      artifact_digest: 'x', schema, bindings: B,
    });
  });
  afterEach(() => db.close());

  describe('the file lands, and the numbers are the file’s', () => {
    it('imports every row and reports what it did', () => {
      const r = accounted(importCsv(THREE));
      expect(r.rows_read).toBe(3);
      expect(r.written).toBe(3);
      expect(r.replayed).toBe(0);
      expect(r.failed).toBe(0);
      expect(r.unparsed).toBe(0);
      expect(rowCount()).toBe(3);
    });

    it('⛔⛔ a separated amount is a NUMBER, stored in the column that carried it', () => {
      /** The defect that shipped: `to_number("3,391.02")` is null, `null - 0` is 0, so
       *  663 of 1000 rows imported as silent zeros and the net read 22,302.42 against a
       *  true 151,193.70. The separator is handled; the SIGN is not invented. */
      importCsv(THREE);
      expect(rows().map((r) => [r.n3, r.n4]))
        .toEqual([[0, 3.5], [3391.02, 0], [0, 1200]]);
      /** ⛔ `amount` stays EMPTY: this export has no signed column, so there is nothing
       *  to put there. A folded figure here would pass the net check below while holding
       *  a number the statement does not contain. */
      expect(rows().every((r) => r.n1 === null)).toBe(true);
      /** And the signed net is right once a READER combines them. */
      expect(signedNet()).toBeCloseTo(2187.52, 2);
    });

    it('⚠ a SIGNED single column imports verbatim, sign and all', () => {
      /** The other half of the addressable banks, and the case that shows the store is
       *  not choosing a convention: a negative in the file is a negative on the row. */
      importCsv('Date,Detail,Amt\n01-Jan,coffee,-3.50\n02-Jan,salary,"3,391.02"', {
        columns: [
          { column: 'Date', field: 'posted_on' },
          { column: 'Detail', field: 'description' },
          { column: 'Amt', field: 'amount' },
        ],
        numeric_fields: ['amount'],
        dedup_on: ['posted_on', 'description', 'amount'],
        thousands_separator: ',',
        defaults: { category: '' },
      });
      expect(rows().map((r) => r.n1)).toEqual([-3.5, 3391.02]);
      expect(rows().every((r) => r.n3 === null && r.n4 === null)).toBe(true);
    });

    it('⛔⛔ an unreadable amount is NULL and the row STILL lands', () => {
      /** Null says "absent"; zero says "this transaction was for nothing", and only one
       *  of those is true. Dropping the row is the same loss inverted — the owner cannot
       *  reconcile against a statement whose count does not match. */
      const r = accounted(importCsv(csvOf('01-Jan,coffee,N/A,0,10')));
      expect(r.written, 'the row still imports').toBe(1);
      expect(rows()[0]!.n1, 'null, never zero').toBeNull();
      expect(r.unparsed).toBe(1);
      expect(r.unparsed_sample[0]).toMatchObject({ line: 2, column: 'In', value: 'N/A' });
    });

    it('⚠ a row blank on BOTH sides of the pair is unknown, not zero', () => {
      /** `0 - 0` is a real number and a fabricated fact. A blank row says nothing at
       *  all, and reporting it as a £0.00 transaction invents one. Storing the columns
       *  verbatim gets this for free — there is no arithmetic to turn absence into a
       *  figure. */
      importCsv(csvOf('01-Jan,mystery,,,10'));
      expect([rows()[0]!.n3, rows()[0]!.n4]).toEqual([null, null]);
    });

    it('⚠ a SHORT row lands padded rather than vanishing', () => {
      /** `ragged: 'skip'` would drop it, and `rows_read` would then describe what the
       *  parser kept rather than what the file holds — silent row loss wearing a clean
       *  count. */
      const r = accounted(importCsv(csvOf('01-Jan,truncated')));
      expect(r.rows_read).toBe(1);
      expect(r.written).toBe(1);
    });
  });

  describe('⛔⛔⛔ re-importing the same file does not double the money', () => {
    it('a second identical import writes nothing and says so', () => {
      importCsv(THREE);
      const r = accounted(importCsv(THREE));
      expect(r.written, 'nothing was new').toBe(0);
      expect(r.replayed, 'every line was already held').toBe(3);
      expect(r.failed).toBe(0);
      expect(rowCount()).toBe(3);
    });

    it('a DIFFERENT scope keeps its own rows', () => {
      /** Without the scope fold, two accounts holding the same transaction collide and
       *  the second import silently drops a real one. */
      importCsv(THREE);
      accounted(importCsv(THREE, { ...SPEC, scope: 'acct-2' }));
      expect(rowCount()).toBe(6);
    });

    it('two IDENTICAL lines are two rows, and stay two on re-import', () => {
      /** Two identical £3 coffees on one day are BOTH REAL — refusing the second
       *  deletes a transaction. The occurrence counter keeps them distinct AND keeps
       *  the ids reproducible. */
      const twice = csvOf('01-Jan,coffee,0,3.50,10', '01-Jan,coffee,0,3.50,10');
      expect(importCsv(twice).written).toBe(2);
      expect(accounted(importCsv(twice)).replayed).toBe(2);
      expect(rowCount()).toBe(2);
    });
  });

  describe('⛔⛔ one bad row does not cost its neighbours', () => {
    it('an edited row is refused ALONE — the rest of its slice still replay', () => {
      /** THE MECHANISM, not a comment. A slice is written as ONE transaction for speed,
       *  so a single refusal rolls back rows that were perfectly fine; the action then
       *  replays that slice row by row so every outcome is attributed to the row that
       *  earned it. An import's rows are independent facts from a file — there is no
       *  cross-row invariant an all-or-none would be protecting.
       *
       *  The scenario is the ordinary one: the owner categorised a line, then re-ran an
       *  overlapping export. Without the replay, that one edit would cost the whole
       *  slice. */
      importCsv(THREE);
      const edited = rows()[1]!.pk;
      db.prepare('UPDATE core_records SET s3=? WHERE pk=?').run('groceries', edited);

      const r = accounted(importCsv(THREE));
      expect(r.failed, 'exactly the edited row').toBe(1);
      expect(r.replayed, 'the other two were NOT collateral').toBe(2);
      expect(r.written).toBe(0);
      expect(r.failures_sample[0]?.code).toBe('records_conflict');
      expect(r.failures_sample[0]?.id).toBe(edited);
      /** ⛔ And the owner's edit survived — the refusal is what protects it. */
      expect(rows()[1]!.s3).toBe('groceries');
    });

    it('the failure sample is capped, and the COUNT is still exact', () => {
      /** The whole point of the action is that rows never enter step state; an uncapped
       *  failure list would put every one of them straight back into it. */
      const many = Array.from({ length: RECORDS_IMPORT_SAMPLE_LIMIT + 5 },
        (_, i) => `0${i}-Jan,row${i},0,1.00,10`);
      importCsv(csvOf(...many));
      db.prepare('UPDATE core_records SET s3=?').run('edited');

      const r = accounted(importCsv(csvOf(...many)));
      expect(r.failed).toBe(RECORDS_IMPORT_SAMPLE_LIMIT + 5);
      expect(r.failures_sample).toHaveLength(RECORDS_IMPORT_SAMPLE_LIMIT);
    });
  });

  describe('⛔ the spec is refused ONCE, before any row runs', () => {
    const refuse = (spec: unknown, matching: RegExp) => {
      expect(() => importCsv(THREE, spec)).toThrow(matching);
      expect(rowCount(), 'a refused spec must write nothing').toBe(0);
    };

    it('a required field neither mapped nor defaulted', () => {
      /** The defect that refused all 1000 rows of the original drive: the entity
       *  declared `category`, the CSV never carried it, and `create` refuses a missing
       *  declared field. Discovering that per row means the owner reads "1000 rows
       *  failed" and has to reverse-engineer one mistake out of it. */
      const { defaults: _drop, ...noDefaults } = SPEC;
      refuse(noDefaults, /required field 'category' is neither mapped nor defaulted/);
    });

    it('⛔⛔ a MISSPELT spec key, because an open vocabulary fails silently', () => {
      /** `thousands_seperator` ignored is not a typo, it is every amount failing to
       *  parse — the exact shape of the defect that put 663 silent zeros into a green
       *  suite. A typo must be a refusal, never a quiet behaviour change. */
      const { thousands_separator: sep, ...rest } = SPEC;
      refuse({ ...rest, thousands_seperator: sep }, /unknown spec key 'thousands_seperator'/);
    });

    it('a column mapped to a field this entity does not have', () => {
      refuse({ ...SPEC, columns: [...SPEC.columns, { column: 'X', field: 'nope' }] },
        /'nope' is not a writable field/);
    });

    it('dedup on a field no column feeds', () => {
      /** Every row would reduce to the same empty key, so identity collapses onto the
       *  occurrence counter — deterministic, re-importable, and meaningless. */
      refuse({ ...SPEC, dedup_on: ['posted_on', 'category'] },
        /'category' is not a mapped column/);
    });

    it('two writers for one field', () => {
      refuse({ ...SPEC, columns: [...SPEC.columns, { column: 'Out', field: 'money_in' }] },
        /mapped more than once/);
    });

    it('a multi-character delimiter, which csv_parse would silently ignore', () => {
      refuse({ ...SPEC, delimiter: '||' }, /delimiter must be a single character/);
    });

    it('⚠ and it PERMITS the case that separates it from a ban', () => {
      // The over-correction: a validator that refuses everything passes every test
      // above and imports nothing.
      expect(accounted(importCsv(THREE)).written).toBe(3);
    });
  });

  describe('⛔⛔ the write is admitted by the import’s OWN binding and nothing wider', () => {
    it('a bare `create` on the same entity is NOT callable', () => {
      /** This is the security property. Installing the inner write as its own operation
       *  would make it callable by anyone holding the digest — a wider grant than the
       *  import. The divergence is admitted inside `requireState` instead, so the ONLY
       *  way to reach a create here is through the import. */
      expect(() => store.execute({
        binding: bind('create', 'line', ':forged'), principal: 'owner',
        args: { id: 'x', values: { posted_on: 'a', description: 'b', category: '' } },
      })).toThrow(/not installed/);
      expect(rowCount()).toBe(0);
    });

    it('⛔ an import cannot be ridden to a SIBLING entity', () => {
      /** The batch's divergence looks up an allow-list, so its entity is chosen; an
       *  import's entity is PINNED to the bind. Forging the action while keeping the
       *  installed digest must not reach `other`. */
      expect(() => store.execute({
        binding: { ...B.importLine, action: 'create' as never, entity: 'other' },
        principal: 'owner', args: { id: 'x', values: { note: 'n' } },
      })).toThrow(/not installed/);
      expect(rowCount()).toBe(0);
    });

    it('an import bound to another entity writes THAT entity, not this one', () => {
      accounted(importCsv('Note\nhello', {
        columns: [{ column: 'Note', field: 'note' }],
        dedup_on: ['note'],
      }, B.importOther));
      expect(db.prepare("SELECT count(*) AS n FROM core_records WHERE kind='other'")
        .get()).toEqual({ n: 1 });
    });
  });

  describe('⛔ a namespace-level refusal HALTS instead of repeating itself', () => {
    it('a quota wall stops the import and names why', () => {
      /** Retrying the remaining rows can only reproduce it. On a large file that is
       *  hundreds of thousands of identical failures burying the one thing that
       *  actually happened — and an owner who needs to read "you ran out of room at
       *  line 4", not "195,000 rows failed". */
      store.setQuota(OWNER, { row_limit: 2 });
      const r = accounted(importCsv(THREE));
      expect(r.written).toBe(2);
      expect(r.failed).toBe(1);
      expect(r.not_attempted, 'the rest were never attempted').toBe(0);
      expect(r.halted_reason).toMatch(/records_quota_exceeded/);
      expect(rowCount()).toBe(2);
    });

    it('⚠ and a per-ROW refusal does NOT halt — it is a fact about the data', () => {
      // The over-correction: halting on any failure makes one edited row abandon the
      // rest of the file, which is the all-or-none behaviour this action rejects.
      importCsv(THREE);
      db.prepare('UPDATE core_records SET s3=? WHERE pk=?').run('x', rows()[0]!.pk);
      const r = accounted(importCsv(THREE));
      expect(r.halted_reason).toBeUndefined();
      expect(r.replayed).toBe(2);
    });
  });

  it('⛔⛔ two DISTINCT rows whose dedup values run together stay distinct', () => {
    /** The identity key is built by joining the `dedup_on` values. Join them with a
     *  SPACE and two genuinely different rows can produce the same key —
     *  `("01-Jan", "coffee shop")` and `("01-Jan coffee", "shop")` both read
     *  "01-Jan coffee shop". Colliding rows are then told apart only by their position
     *  in the file, so a bank that re-exports the same period in a different ORDER
     *  hands them swapped ids and the re-import adds both again.
     *
     *  ⚠ The collision is invisible on a single import — both rows land, because the
     *  occurrence counter separates them. It only shows up on the SECOND import, which
     *  is exactly the case this pack exists to get right. */
    const reorderable = (...lines: string[]) =>
      ['Date,Detail,In,Out,Bal', ...lines].join('\n');
    const a = '01-Jan,coffee shop,1.00,0,10';
    const b = '01-Jan coffee,shop,1.00,0,10';

    expect(accounted(importCsv(reorderable(a, b))).written).toBe(2);
    const r = accounted(importCsv(reorderable(b, a)));
    expect(r.replayed, 'a re-import in a different order must add nothing').toBe(2);
    expect(rowCount()).toBe(2);
  });

  it('an empty file is an honest zero, not an error', () => {
    const r = accounted(importCsv(HEADER));
    expect(r.rows_read).toBe(0);
    expect(r.written).toBe(0);
  });
});
