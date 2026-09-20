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
    csv: string, spec: unknown = SPEC, binding = B.importLine, dry_run?: boolean,
  ): RecordsImportResult =>
    store.execute({
      binding, principal: 'owner',
      args: { csv, spec, ...(dry_run === undefined ? {} : { dry_run }) },
    }) as RecordsImportResult;

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
    expect(r.written + r.replayed + r.updated + r.skipped + r.failed + r.not_attempted,
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

    it('⛔ and in the DEFAULT mode that is still what happens — no mode, no change', () => {
      // The three modes were added under `on_conflict`; its absence must keep
      // meaning exactly what it meant before, or every already-installed pack
      // changes behaviour by being upgraded.
      importCsv(THREE);
      db.prepare('UPDATE core_records SET s3=? WHERE pk=?').run('groceries', rows()[1]!.pk);
      const r = accounted(importCsv(THREE));
      expect(r.failed).toBe(1);
      expect(r.updated, 'nothing was overwritten').toBe(0);
      expect(r.skipped, 'and nothing was silently passed over').toBe(0);
    });
  });

  describe('⛔⛔ on_conflict — the owner chooses what a disagreement means', () => {
    /** The file says one thing, the stored row says another. That is the only
     *  case any of this decides: a byte-identical row is `replayed` in every
     *  mode and always was. */
    /** ⚠ EDITS A MAPPED FIELD (`description`), not the defaulted `category`.
     *  The distinction is the whole of `overwrite`'s semantics: the file can only
     *  rewrite what the file carries, so an edit to a DEFAULTED field is a
     *  collision no overwrite can resolve — asserted separately below. Picking
     *  the defaulted field here by accident made the first version of these tests
     *  fail with `records_noop`, which is the right answer to a different
     *  question. `description` is not part of `dedup_on`'s identity tuple, so the
     *  edited row still collides rather than becoming a new one. */
    const withEditedRow = (): string => {
      importCsv(THREE);
      const edited = rows()[1]!.pk;
      db.prepare('UPDATE core_records SET s2=? WHERE pk=?').run('SALARY (corrected)', edited);
      return edited;
    };
    const mode = (m: string): unknown => ({ ...SPEC, on_conflict: m });

    it('skip: the store wins, the row is NOT a failure, and the edit survives', () => {
      withEditedRow();
      const r = accounted(importCsv(THREE, mode('skip')));
      expect(r.skipped, 'exactly the row that disagreed').toBe(1);
      expect(r.failed, 'a skip is a decision, not a refusal').toBe(0);
      expect(r.replayed, 'the other two agreed and are NOT skips').toBe(2);
      expect(r.updated).toBe(0);
      expect(r.written).toBe(0);
      // ⛔ THE OUTCOME, not just the counter: the owner's own edit is still there.
      expect(rows()[1]!.s2).toBe('SALARY (corrected)');
      expect(rowCount(), 'and a skip never seats a second copy').toBe(3);
    });

    it('overwrite: the file wins, and the row really is replaced', () => {
      withEditedRow();
      const r = accounted(importCsv(THREE, mode('overwrite')));
      expect(r.updated).toBe(1);
      expect(r.failed).toBe(0);
      expect(r.skipped).toBe(0);
      expect(r.replayed, 'the two that already agreed were not rewritten').toBe(2);
      expect(r.written, 'an overwrite is not a new row and must not read as one').toBe(0);
      // ⛔ THE EDIT IS GONE — that is what the owner asked for, and asserting the
      // counter alone would pass on an overwrite that quietly did nothing.
      expect(rows()[1]!.s2).toBe('salary');
      expect(rowCount()).toBe(3);
    });

    it('⛔⛔ neither mode touches a row that AGREES — that is still `replayed`', () => {
      importCsv(THREE);
      for (const m of ['skip', 'overwrite']) {
        const r = accounted(importCsv(THREE, mode(m)));
        expect(r.replayed, m).toBe(3);
        expect(r.updated + r.skipped + r.failed + r.written, m).toBe(0);
      }
    });

    it('⛔⛔ overwrite writes ONLY what the file carries — a DEFAULT is not a claim', () => {
      // `defaults` exist so a `create` has every declared field; they say nothing
      // about a row that already exists. Writing them on an overwrite would reset
      // fields the file never mentioned — a roster's `enrolled_at: <now>` would
      // silently become "when I last re-imported", every run.
      //
      // Here the owner categorised a line. `category` is DEFAULTED, not mapped,
      // so the file has nothing to say about it and the edit must survive even
      // under overwrite.
      importCsv(THREE);
      const edited = rows()[1]!.pk;
      db.prepare('UPDATE core_records SET s3=? WHERE pk=?').run('groceries', edited);

      const r = accounted(importCsv(THREE, mode('overwrite')));
      expect(rows()[1]!.s3, 'the defaulted field was NOT reset to \'\'').toBe('groceries');
      // and it is reported as the store's value surviving, which is a skip —
      // not `replayed` (the row is not byte-identical) and not a failure.
      expect(r.skipped).toBe(1);
      expect(r.updated).toBe(0);
      expect(r.failed).toBe(0);
    });

    it('⛔⛔ overwrite does NOT swallow a refusal that is not a collision', () => {
      // The catch is narrowed to `records_conflict` on purpose. A mode that
      // caught everything would report a clean import over rows that never
      // landed — the exact defect this action exists to remove, reintroduced by
      // the feature meant to make it friendlier.
      //
      // ⚠ The obvious way to write this does NOT work and is worth naming: an
      // unsatisfied required field is refused by the SPEC validator before any
      // row runs, so it never reaches the catch at all. This uses a per-ROW
      // refusal instead — a number where the entity declares a string is
      // rejected by `normalizeValues`, one row at a time.
      const r = accounted(importCsv(
        csvOf('04-Jan,book,0,9.99,3177.53'),
        { ...(mode('overwrite') as Record<string, unknown>),
          numeric_fields: ['money_in', 'money_out', 'balance', 'description'] },
      ));
      expect(r.failed, 'a per-row refusal is still a failure under overwrite').toBe(1);
      expect(r.updated).toBe(0);
      expect(r.skipped, 'and it is NOT laundered into a skip').toBe(0);
      expect(r.failures_sample[0]?.code).not.toBe('records_conflict');
    });

    it('⛔⛔⛔ NOR UNDER SKIP — where the narrow catch is the ONLY thing holding', () => {
      // ⚠ THIS IS THE CASE THAT MATTERS, and the overwrite version above does
      // NOT cover it. Mutation proved it: widening the catch to every error left
      // the overwrite test green, because the inner `update` re-fails on the same
      // refusal and rethrows — two guards, one property, and the narrow one is
      // redundant on that path.
      //
      // Skip has no second guard. Every refusal it swallows is returned as
      // `skipped`, so a file of rows that could not be stored would report as
      // "rows I already had, kept as mine" — the import would look clean and the
      // data would not be there.
      const r = accounted(importCsv(
        csvOf('04-Jan,book,0,9.99,3177.53'),
        { ...(mode('skip') as Record<string, unknown>),
          numeric_fields: ['money_in', 'money_out', 'balance', 'description'] },
      ));
      expect(r.failed, 'a per-row refusal is a failure under skip too').toBe(1);
      expect(r.skipped, '⛔ NOT laundered into "already had it"').toBe(0);
      expect(r.written).toBe(0);
      expect(r.failures_sample[0]?.code).not.toBe('records_conflict');
    });

    it('⛔ a skip inside a slice does not cost its neighbours a rollback', () => {
      // The mode is applied INSIDE the row write rather than in the per-row
      // catch, so a skipped row never throws and the slice transaction holds.
      // With 3 rows this is invisible; it is asserted through the outcome that
      // would differ — every other row still lands in the same call.
      withEditedRow();
      const grown = csvOf(
        '01-Jan,coffee,0,3.50,996.50',
        '02-Jan,salary,"3,391.02",0,"4,387.52"',
        '03-Jan,rent,0,"1,200.00","3,187.52"',
        '04-Jan,book,0,9.99,3177.53',
      );
      const r = accounted(importCsv(grown, mode('skip')));
      expect(r.skipped).toBe(1);
      expect(r.replayed).toBe(2);
      expect(r.written, 'the new line landed in the same call').toBe(1);
      expect(rowCount()).toBe(4);
    });

    it('⛔⛔ an unadmitted mode is refused BEFORE any row runs', () => {
      // A DOOR, not a safe default. `'Overwrite'` falling back to `'fail'` would
      // report `updated: 0` and read as a clean run over rows it never replaced.
      withEditedRow();
      expect(() => importCsv(THREE, mode('Overwrite')))
        .toThrow(/on_conflict .* is not admitted/);
      expect(() => importCsv(THREE, mode('overwrite ')))
        .toThrow(/on_conflict/);
      expect(rows()[1]!.s2, 'and nothing was written on the way to refusing').toBe('SALARY (corrected)');
    });
  });

  describe('⛔⛔ one bad row does not cost its neighbours (continued)', () => {
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

  describe('⛔⛔ import SUPPLEMENTS manual entry on a natural-key entity', () => {
    /** ⛔⛔ THE CASE THAT DOES NOT WORK WITHOUT THIS. `import` is a supplement, not a
     *  replacement — the same entity still takes rows typed by hand. But the two paths
     *  derive identity differently: a manual `create` gets a random id, an import a
     *  content-derived one. So a purchase entered on Tuesday and then present in
     *  Friday's card export lands TWICE, and neither path can see the other's row.
     *
     *  A `natural_key` is the mechanism that makes them converge — and it used to make
     *  `import` fail outright, because a natural-key entity refuses a caller-supplied id
     *  and `import` always supplied one. Now it omits the id and the store derives it,
     *  so both paths land on the same row.
     *
     *  🔑 THE CHOICE IS THE PACK'S. `statement_line` declares no key: two identical £3
     *  coffees are both real and import is its sole writer. An entity where import
     *  supplements typing wants the opposite, and pays for it by collapsing genuine
     *  duplicates — which is what declaring a natural key MEANS. */
    const KEYED_CREATE = {
      ...bind('create', 'line', ':nk'), natural_key: ['posted_on', 'description'],
    } as RecordsExecutionBinding;
    const keyedStore = () => {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      store = createRecordsStore(db, { now: (() => { let t = 1e12; return () => t++; })() });
      store.installNamespace({
        owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
        artifact_digest: 'x', schema,
        // The pack's declaration: identity is (posted_on, description).
        bindings: { imp: B.importLine, create: KEYED_CREATE },
      });
    };
    const KEYED_SPEC = {
      columns: [
        { column: 'Date', field: 'posted_on' },
        { column: 'Detail', field: 'description' },
        { column: 'In', field: 'money_in' },
      ],
      numeric_fields: ['money_in'],
      defaults: { category: '' },
    };
    /** What the owner types by hand — the SAME transaction the card export will carry. */
    const typed = (day: string, note: string, moneyIn: number) =>
      store.execute({
        binding: KEYED_CREATE, principal: 'owner',
        args: { values: { posted_on: day, description: note, category: '', money_in: moneyIn } },
      });

    it('⛔⛔⛔ a row typed by hand is RECOGNISED by the import, not duplicated', () => {
      keyedStore();
      typed('01-Jan', 'coffee', 3.5);                         // Tuesday, by hand
      const r = importCsv(
        'Date,Detail,In\n01-Jan,coffee,3.50\n02-Jan,rent,1200.00', KEYED_SPEC,
      );

      expect(r.replayed, 'the hand-typed row is recognised, not re-created').toBe(1);
      expect(r.written, 'only the line the owner had not typed').toBe(1);
      expect(r.failed, JSON.stringify(r.failures_sample)).toBe(0);
      expect(rowCount(), '⛔ two rows, not three').toBe(2);
    });

    it('⛔ and the import still refuses to overwrite what the owner typed', () => {
      /** Convergence must not mean the file wins. The hand-typed row carries a value the
       *  file disagrees with, so the row is refused — the same refusal that protects an
       *  edit on a re-import, reached through the other path. */
      keyedStore();
      typed('01-Jan', 'coffee', 99.99);   // the owner recorded a different amount
      const r = importCsv('Date,Detail,In\n01-Jan,coffee,3.50', KEYED_SPEC);
      expect(r.failed).toBe(1);
      expect(r.failures_sample[0]?.code).toBe('records_conflict');
      expect(r.failures_sample[0]?.line, 'the handle that always works').toBe(2);
      expect(r.failures_sample[0]?.id, 'no id — the store owns identity here').toBe('');
    });

    it('⛔ dedup_on is REFUSED on a natural-key entity — it would decide nothing', () => {
      keyedStore();
      expect(() => importCsv('Date,Detail,In\n01-Jan,coffee,3.50',
        { ...KEYED_SPEC, dedup_on: ['posted_on'] })).toThrow(/dedup_on is not admitted/);
      expect(rowCount()).toBe(0);
    });

    it('⚠ and it is still REQUIRED where the caller does own identity', () => {
      // The over-correction: making it optional everywhere would let an entity with no
      // key import rows whose identity nothing decides.
      const { dedup_on: _drop, ...noDedup } = SPEC;
      expect(() => importCsv(THREE, noDedup)).toThrow(/dedup_on must be a non-empty array/);
    });
  });

  describe('⛔⛔ a dry run rehearses the real write and keeps nothing', () => {
    /** ⛔ IT EXISTS FOR THE ONE FAILURE NOTHING ELSE CATCHES. A mapping that is
     *  VALID but points at the wrong column imports a thousand successful, WRONG
     *  rows: `failed: 0`, nothing to re-run, and the cleanup is manual because
     *  the ids were derived from the wrong values. Neither the result shape nor
     *  an all-or-nothing import would say a word about it. Seeing the first rows
     *  before committing is the only thing that does.
     *
     *  ⚠ NOT for malformed CSV — measured, that barely fails at all: an
     *  unreadable amount, a blank cell, a short row, extra cells and an entirely
     *  blank row ALL land (see the cases above). The dominant real failure is
     *  `records_conflict` on rows the owner has since edited. */

    it('writes NOTHING, and says so', () => {
      const r = accounted(importCsv(THREE, { ...SPEC }, B.importLine, true));
      expect(r.dry_run).toBe(true);
      expect(r.written, 'would-be-written is still reported').toBe(3);
      expect(rowCount(), 'and not one row survives the rollback').toBe(0);
    });

    it('⛔⛔ the numbers are MEASURED through the real write path, not predicted', () => {
      /** The property that makes a rehearsal worth anything. This row violates a
       *  STORE limit (>4096 bytes in an indexed string) — a rule that lives in
       *  `normalizeValues`, not in the planner. A dry run that simulated instead
       *  of executing would report it as fine and the real import would refuse
       *  it, which is worse than no dry run: it would have been checked and
       *  cleared. */
      const long = 'x'.repeat(5000);
      const r = accounted(importCsv(
        csvOf('01-Jan,ok,1.00,0,10', `02-Jan,${long},1.00,0,10`), SPEC, B.importLine, true,
      ));
      expect(r.failed, 'the store limit is enforced during the rehearsal').toBe(1);
      expect(r.failures_sample[0]?.code).toBe('records_invalid');
      expect(r.written).toBe(1);
      expect(rowCount(), 'still nothing kept').toBe(0);
    });

    it('⛔ it sees CONFLICTS with rows the owner already edited', () => {
      /** The realistic partial-import cause, and the number an owner actually
       *  wants before re-importing an overlapping export: how many of these have
       *  I touched since last time? */
      importCsv(THREE);
      db.prepare('UPDATE core_records SET s3=? WHERE s1=?').run('groceries', '02-Jan');
      const r = accounted(importCsv(THREE, SPEC, B.importLine, true));
      expect(r.failed).toBe(1);
      expect(r.failures_sample[0]?.code).toBe('records_conflict');
      expect(r.replayed, 'the untouched rows are already held').toBe(2);
      expect(rowCount(), 'the rehearsal changed nothing').toBe(3);
      expect(rows().find((x) => x.s1 === '02-Jan')?.s3, 'least of all the edit')
        .toBe('groceries');
    });

    it('⛔ a dry run leaves NO audit row — it is not provenance, nothing arrived', () => {
      const seen: unknown[] = [];
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      const store = createRecordsStore(db, {
        now: (() => { let t = 1e12; return () => t++; })(),
        onImport: (e) => { seen.push(e); },
      });
      store.installNamespace({
        owner: OWNER, version: 1, storage_schema_hash: SH, declaration_hash: DH,
        artifact_digest: 'x', schema, bindings: B,
      });
      store.execute({ binding: B.importLine, principal: 'owner',
        args: { csv: THREE, spec: SPEC, dry_run: true } });
      expect(seen, 'a rehearsal must not be recorded as an import').toEqual([]);
      store.execute({ binding: B.importLine, principal: 'owner',
        args: { csv: THREE, spec: SPEC } });
      expect(seen, 'a real import still is').toHaveLength(1);
    });

    it('⚠ dry_run must be a BOOLEAN — the string "false" cannot mean true', () => {
      /** A `{{config.*}}` ref or a form hands over strings. Under a truthy check
       *  `dry_run: "false"` would silently import nothing and report success. */
      expect(() => importCsv(THREE, SPEC, B.importLine, 'false' as never))
        .toThrow(/dry_run must be a boolean/);
      expect(rowCount()).toBe(0);
    });

    it('⚠ and the DEFAULT is a real import', () => {
      // The over-correction: a dry-run default would make every recipe a no-op.
      expect(accounted(importCsv(THREE)).dry_run).toBeUndefined();
      expect(rowCount()).toBe(3);
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
