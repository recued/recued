/** CSV → records import planning: the deterministic core of `core.records.import-csv`.
 *
 *  ⛔⛔ THIS EXISTS BECAUSE THE RECIPE-LEVEL VERSION CANNOT BE MADE CORRECT. Driving
 *  `statement-import` against a real 1000-row bank export found six defects, and four of
 *  them are structural rather than bugs:
 *    · `step context is 11.9MB (max 10MB)` — a recipe carrying N rows through a dozen
 *      `map` steps cannot import a real statement at all. Planning here means the rows
 *      never enter step state.
 *    · Dedup by read-back is capped at `RECORDS_MAX_PAGE_SIZE` (200), so any account past
 *      200 rows compares against a fraction of itself and double-counts the rest.
 *    · `upsert` refuses a blind overwrite (it wants `expected_revision`), so idempotence
 *      cannot be expressed in recipe JSON without reading every row first.
 *    · A `foreach` write reports SUCCESS when every item was rejected — 1000 rows refused,
 *      `success: true`, nothing on screen.
 *
 *  🔑 THE MAPPING STAYS DECLARATIVE AND CALLER-SUPPLIED; only the plumbing moves here.
 *  Which column is the amount is a per-bank fact the owner declares. Parsing CSV and
 *  planning a bulk insert is substrate every import pack would otherwise reimplement —
 *  badly, as the recipe version did.
 *
 *  ⚠⚠ IMPORT IMPORTS; THE OWNER OWNS DATA QUALITY (owner decision). An earlier version
 *  REJECTED rows it judged unfit — an unparseable number, a blank identity, a line
 *  repeated inside the file. That was the same silent data loss it was written to prevent,
 *  pointed the other way: a rejected row VANISHES, and an owner cannot reconcile against
 *  their statement when the row count does not match. The duplicate rule was worst — two
 *  identical £3 coffees on one day are both REAL, and refusing the second deletes a
 *  transaction.
 *
 *  🔑 THE PROPERTY THAT ACTUALLY MATTERED WAS NEVER REJECT-VS-IMPORT. It was that an
 *  unparseable value must never become ZERO. `null` is the honest representation: the row
 *  lands, the field is empty, nothing is fabricated, and the owner can see and fix it.
 *  Every row now imports; `unparsed` reports what needs their attention instead of
 *  deciding for them.
 *
 *  ⛔ THE CALLER SUPPLIES A MAPPING, NEVER A TARGET. There is no entity or namespace
 *  argument by design: the binding comes from the pack, exactly as every other records op
 *  binds. Otherwise this becomes a primitive for writing arbitrary rows into any pack's
 *  store.
 */
import { createHash } from 'node:crypto';

/** One CSV column routed to one entity field. Declared by the owner, per source.
 *
 *  ⛔⛔ AN ARRAY, NOT AN OBJECT KEYED BY COLUMN NAME, and the reason is not
 *  style. These keys come from a BANK's header row, and the store's own arg
 *  guard (`assertJsonTree`) refuses any object key containing a `.` — plus
 *  `__proto__` / `prototype` / `constructor`. A perfectly ordinary header like
 *  `Tran. Date` would therefore fail the whole call with "is not a safe
 *  own-property key", pointing at a guard the owner cannot satisfy and cannot
 *  act on. In an array the column name is a VALUE, so no header can be
 *  unmappable.
 *
 *  ⚠ Also keeps one name from meaning two things: `field_mapping` is already
 *  the D-221 MIGRATION vocabulary (`[{op:'move', from, to}]`), and a second
 *  differently-shaped `field_mapping` in the same subsystem is a collision
 *  waiting for whoever reads them a year apart. */
export interface CsvImportColumn {
  /** Header cell in the source file, verbatim — misspellings included. */
  readonly column: string;
  /** Friendly field on the bound entity. */
  readonly field: string;
}

export interface CsvImportSpec {
  readonly columns: readonly CsvImportColumn[];
  /** Entity fields whose combined value identifies a row. Order is significant and is
   *  preserved, so a mapping change that reorders them produces different ids — which is
   *  correct: it IS a different identity. */
  readonly dedup_on?: readonly string[];
  /** Folded into every id so two accounts importing the same statement keep their own
   *  rows. Without it, identical transactions in a joint and a personal account collide
   *  and the second import silently drops a real one. */
  readonly scope?: string;
  readonly delimiter?: string;
  /** ⚠ A LOCALE FACT, NOT A CONSTANT. Real exports quote amounts as `"3,391.02"`;
   *  `Number()` returns NaN for those, and the recipe version turned that null into a
   *  legitimate-looking ZERO through a subtraction. 663 of 1000 rows imported as zeros
   *  under a fully green suite. */
  readonly thousands_separator?: string;
  /** Fields to coerce to number. A field listed here whose cell is non-empty and does not
   *  parse lands NULL and is reported in `unparsed` — never 0, and never a dropped row. */
  readonly numeric_fields?: readonly string[];
  /** Values for fields the entity declares but the CSV does not carry. A records `create`
   *  requires EVERY declared field, so without these every row is refused for a column
   *  nobody was ever going to map. */
  readonly defaults?: Readonly<Record<string, unknown>>;
}

export interface CsvImportPlannedRow {
  /** ⚠ ABSENT on a natural-key entity — the store derives the id from the key's own
   *  fields, and a planner-invented one would be a second identity competing with it. */
  readonly id?: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/** A cell that arrived non-empty and did not parse. The row STILL IMPORTS with the field
 *  null — this is a signal for the owner, not a verdict on their data. */
export interface CsvImportUnparsed {
  /** 1-based line number in the source file, header included, so it matches what the
   *  owner sees when they open the CSV. A 0-based row index would send them to the wrong
   *  line, which is worse than no number. */
  readonly line: number;
  readonly column: string;
  readonly value: string;
}

export interface CsvImportPlan {
  readonly rows_read: number;
  readonly rows: readonly CsvImportPlannedRow[];
  /** ⚠ Non-empty here does NOT mean the import was partial — every row is in `rows`.
   *  It means some cells came in as null and the owner should look. */
  readonly unparsed: readonly CsvImportUnparsed[];
}

/** The bound entity's writable fields, as the store knows them. */
export interface CsvImportField {
  readonly key: string;
  readonly required: boolean;
}

const SPEC_KEYS = new Set([
  'columns', 'dedup_on', 'scope', 'delimiter', 'thousands_separator',
  'numeric_fields', 'defaults',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Check a caller's spec against the entity it will write, BEFORE any row runs.
 *  Returns every problem rather than the first; empty = admissible.
 *
 *  ⛔⛔ THIS EXISTS BECAUSE THE ALTERNATIVE IS A THOUSAND IDENTICAL REFUSALS. Every
 *  fault below is a property of the SPEC, so it is true of row 1 and of row 1000
 *  equally — and discovering it per row means an owner reads "1000 rows failed" and
 *  has to reverse-engineer one mistake out of it. Defect #4 of the original drive was
 *  exactly this: the entity declared `counterparty`/`category`, the CSV never carried
 *  them, `create` refuses a missing declared field, and all 1000 rows were refused for
 *  a column nobody was ever going to map.
 *
 *  ⛔ THE VOCABULARY IS CLOSED, and that is the load-bearing part. A misspelt
 *  `thousands_seperator` is silently ignored by an open one — and then every amount
 *  fails to parse and lands null, which is the SHAPE of the defect that put 663 silent
 *  zeros into a green suite. A typo must be a refusal, not a quiet behaviour change.
 */
export const validateCsvImportSpec = (
  raw: unknown,
  fields: readonly CsvImportField[],
  /** The entity's declared `natural_key`, when it has one. Its PRESENCE moves ownership
   *  of identity from the caller to the store, so it flips whether `dedup_on` is
   *  required or refused. */
  naturalKey?: readonly string[],
): string[] => {
  if (!isPlainObject(raw)) return ['spec must be an object'];
  const problems: string[] = [];
  const known = new Map(fields.map((field) => [field.key, field]));

  for (const key of Object.keys(raw)) {
    if (!SPEC_KEYS.has(key)) {
      problems.push(`unknown spec key '${key}' — admitted: ${[...SPEC_KEYS].sort().join(', ')}`);
    }
  }

  const mapped = new Set<string>();
  if (!Array.isArray(raw.columns) || raw.columns.length === 0) {
    problems.push('columns must be a non-empty array of { column, field }');
  } else {
    raw.columns.forEach((entry, index) => {
      const at = `columns[${index}]`;
      if (!isPlainObject(entry)) {
        problems.push(`${at}: must be an object { column, field }`);
        return;
      }
      for (const key of Object.keys(entry)) {
        if (key !== 'column' && key !== 'field') problems.push(`${at}: unknown key '${key}'`);
      }
      if (typeof entry.column !== 'string' || entry.column.length === 0) {
        problems.push(`${at}: column must be a non-empty header name`);
      }
      const field = entry.field;
      if (typeof field !== 'string' || !known.has(field)) {
        problems.push(`${at}: '${String(field)}' is not a writable field of this entity`);
        return;
      }
      // ⚠ A planned row is a FLAT object, so a dotted alias would arrive as the
      // literal key `identity.customer` and the store's nested walk would never
      // find it — the field reads as absent and, if required, every row fails.
      // Refused here rather than left to look like a mapping that did nothing.
      if (field.includes('.')) {
        problems.push(`${at}: nested field '${field}' cannot be imported — a CSV column maps to a top-level field`);
      }
      if (mapped.has(field)) problems.push(`${at}: field '${field}' is mapped more than once`);
      mapped.add(field);
    });
  }

  // ⛔ EVERY REQUIRED FIELD MUST BE ANSWERED SOMEWHERE. A records `create` refuses a
  // missing declared field, so an unanswered one is not a partial import — it is a
  // total one, 1000 rows deep.
  const defaults = raw.defaults;
  if (defaults !== undefined && !isPlainObject(defaults)) {
    problems.push('defaults must be an object of field → value');
  } else if (isPlainObject(defaults)) {
    for (const key of Object.keys(defaults)) {
      if (!known.has(key)) problems.push(`defaults: '${key}' is not a writable field of this entity`);
    }
  }
  const answered = new Set([
    ...mapped,
    ...(isPlainObject(defaults) ? Object.keys(defaults) : []),
  ]);
  for (const field of fields) {
    if (field.required && !answered.has(field.key)) {
      problems.push(
        `required field '${field.key}' is neither mapped nor defaulted`
        + ' — a records create refuses a missing declared field, so every row would be refused',
      );
    }
  }

  const fieldList = (key: 'dedup_on' | 'numeric_fields', required: boolean): void => {
    const value = raw[key];
    if (value === undefined) {
      if (required) problems.push(`${key} must be a non-empty array of mapped field names`);
      return;
    }
    if (!Array.isArray(value) || (required && value.length === 0)) {
      problems.push(`${key} must be a non-empty array of mapped field names`);
      return;
    }
    const seen = new Set<string>();
    value.forEach((entry, index) => {
      if (typeof entry !== 'string' || !mapped.has(entry)) {
        // ⛔ MAPPED, not merely declared. Dedup on an unmapped field and every row
        // reduces to the same empty key, so identity collapses to the occurrence
        // counter — deterministic, re-importable, and completely meaningless.
        problems.push(`${key}[${index}]: '${String(entry)}' is not a mapped column`);
        return;
      }
      if (seen.has(entry)) problems.push(`${key}[${index}]: '${entry}' is listed twice`);
      seen.add(entry);
    });
  };
  if (naturalKey === undefined) {
    fieldList('dedup_on', true);
  } else if (raw.dedup_on !== undefined) {
    // ⛔ REFUSED, NOT IGNORED. On a natural-key entity the store derives each row id from
    // the key's own fields; a `dedup_on` sitting beside it would read like the thing
    // choosing identity while something else actually did — the most expensive kind of
    // dead config, because it looks answered.
    problems.push(
      `dedup_on is not admitted: this entity declares a natural_key (${naturalKey.join(', ')}), `
      + 'so the store derives each row id from those fields',
    );
  }
  fieldList('numeric_fields', false);

  for (const key of ['scope', 'thousands_separator'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') problems.push(`${key} must be a string`);
  }
  // ⚠ `csv_parse` falls back to `,` for anything that is not exactly one character,
  // so a two-character delimiter would parse the file WRONGLY rather than fail.
  if (raw.delimiter !== undefined
    && (typeof raw.delimiter !== 'string' || raw.delimiter.length !== 1)) {
    problems.push('delimiter must be a single character');
  }

  return problems;
};

/** Field separator for the identity key. NUL cannot appear in a cell `csv_parse`
 *  produces, so joined field boundaries are unambiguous — see `planCsvImport`. */
const SEP = '\u0000';

const stripSeparator = (value: string, separator: string | undefined): string =>
  separator === undefined || separator === '' ? value : value.split(separator).join('');

/** Plan an import from already-decoded CSV text. Pure and total: it never throws on
 *  content, because one unreadable cell must not abandon the other 999 rows.
 *
 *  ⛔⛔ A NON-EMPTY CELL THAT FAILS TO PARSE BECOMES NULL AND ITS ROW STILL LANDS. It is
 *  never coerced to 0 and never dropped — those are the two ways an import produces a
 *  plausible wrong number, and a dropped row is the worse of them because the owner
 *  cannot reconcile a count that does not match their statement. `unparsed` carries the
 *  line and column so the caller CANNOT report a clean import over one that needs a look.
 */
export const planCsvImport = (
  rows: readonly Readonly<Record<string, string>>[],
  spec: CsvImportSpec,
): CsvImportPlan => {
  const planned: CsvImportPlannedRow[] = [];
  const unparsed: CsvImportUnparsed[] = [];
  const numeric = new Set(spec.numeric_fields ?? []);
  /** ⛔ OCCURRENCE, NOT REJECTION. A statement can legitimately repeat a line, and the
   *  dedup key cannot tell the two apart — so the id carries which occurrence this is.
   *  Both rows land, and a re-import of the SAME file walks the same rows in the same
   *  order, producing the same ids: identical lines stay distinct AND stay idempotent. */
  const occurrences = new Map<string, number>();

  rows.forEach((row, index) => {
    /** +2: one for the header line, one because files are 1-based. */
    const line = index + 2;
    const values: Record<string, unknown> = { ...(spec.defaults ?? {}) };

    /** The ONE place a cell becomes a number. Both the mapped-column path and the
     *  two-column difference path go through it, so they cannot drift into disagreeing
     *  about what `"3,391.02"` means — which is precisely how the recipe version ended up
     *  with one rule for stripping separators and another for reading the result.
     *  Returns `undefined` for an empty cell: absent, which each caller reads its own
     *  correct way. `null` means present-and-unreadable, and is recorded. */
    const numberCell = (column: string): number | null | undefined => {
      const raw = (row[column] ?? '').trim();
      if (raw === '') return undefined;
      const parsed = Number(stripSeparator(raw, spec.thousands_separator));
      /** ⛔⛔ NULL, NEVER ZERO. Coercing here is how `"3,391.02"` became 0 and 663 of 1000
       *  rows imported as silent zeros under a green suite. Null says "absent"; zero says
       *  "this transaction was for nothing", and only one of those is true. */
      if (!Number.isFinite(parsed)) {
        unparsed.push({ line, column, value: raw });
        return null;
      }
      return parsed;
    };

    /** ⛔ ONE COLUMN, ONE FIELD, VERBATIM — there is deliberately no arithmetic here.
     *
     *  A two-column money layout (`Deposits`/`Withdrawls`, `In`/`Out`) imports as TWO
     *  FIELDS, because that is what the file says. An earlier version of this module
     *  combined such a pair into one signed number, which put "money in minus money out"
     *  — a per-bank fact the RECIPE declares — inside the store. Which column means
     *  debit is not something an importer can know, and a store that computes it holds a
     *  number no row of the source ever contained. Deriving the signed view is the
     *  reader's job, over a page of rows, where it is cheap and reversible. */
    for (const { column, field } of spec.columns) {
      if (!numeric.has(field)) {
        values[field] = (row[column] ?? '').trim();
        continue;
      }
      values[field] = numberCell(column) ?? null;
    }

    /** ⛔ NO ID WHEN THE CALLER DECLARED NO `dedup_on`. That is the natural-key case: the
     *  store derives the id from the key's own fields, so inventing one here would be a
     *  second identity for the same row — and the store refuses it outright ("id is
     *  forbidden on a natural_key entity"). */
    if (spec.dedup_on === undefined) {
      planned.push({ values });
      return;
    }

    /** ⛔⛔ NUL-SEPARATED, NOT SPACE-SEPARATED. A space lets two DIFFERENT rows produce
     *  the same key — `("01-Jan", "coffee shop")` and `("01-Jan coffee", "shop")` both
     *  read "01-Jan coffee shop" — and colliding rows are then told apart only by their
     *  position in the file. A bank that re-exports the same period in a different order
     *  hands them swapped ids, and the re-import adds both again. NUL cannot occur in a
     *  cell `csv_parse` produces, so the field boundaries are unambiguous.
     *
     *  ⚠ Invisible on a first import: both rows land either way, because the occurrence
     *  counter separates them. It surfaces only on the SECOND import — the case this is
     *  for. */
    const key = spec.dedup_on.map((field) => String(values[field] ?? '')).join(SEP);
    const nth = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, nth);

    const id = createHash('sha256')
      .update([spec.scope ?? '', key, String(nth)].join(SEP))
      .digest('hex');

    planned.push({ id, values });
  });

  return { rows_read: rows.length, rows: planned, unparsed };
};
