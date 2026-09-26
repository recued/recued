/** CSV → records import planning: the deterministic core of `core.records.import-csv`.
 *
 *  ⛔⛔ THIS EXISTS BECAUSE THE RECIPE-LEVEL VERSION CANNOT BE MADE CORRECT. Driving
 *  `statement-import` against a real 1000-row bank export found six defects, three of
 *  them structural rather than bugs (a fourth was retracted — see the first bullet):
 *    · ⛔ RETRACTED 2026-09-18 — this bullet read "`step context is 11.9MB (max 10MB)` — a
 *      recipe carrying N rows through a dozen `map` steps cannot import a real statement at
 *      all." The quoted message was itself wrong: `MAX_CONTEXT_BYTES` has been 50MB since
 *      2026-08-24 while `trackContextSize` kept formatting a hardcoded `(max 10MB)`, so
 *      11.9 MB passed the whole time. Retaining the text plus the parsed rows plus derived
 *      copies is still the wrong SHAPE — that is what `core.storage.csv.*` / `file-persist`
 *      / `file-put-ref` exist to replace — but it is not a wall, and this file does not
 *      need it to be one. THE THREE BELOW ARE UNAFFECTED and are why this exists.
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
import {
  RECORDS_IMPORT_CONFLICT_MODES, type RecordsImportConflictMode,
} from '@recued/contracts';

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

/** D-301 — how a file writes the decimal mark. */
export const CSV_IMPORT_DECIMAL_SEPARATORS = ['.', ','] as const;
export type CsvImportDecimalSeparator = (typeof CSV_IMPORT_DECIMAL_SEPARATORS)[number];

/** D-302 — the order of a date's day, month and year, as a typed format names it:
 *  `dmy` for `dd/mm/yyyy`. */
export type CsvImportDateOrder = 'dmy' | 'mdy' | 'ymd' | 'ydm' | 'myd' | 'dym';
/** The three orders dates are written in. A date the owner's format cannot read is
 *  tried against these, and the refusal suggests the one it reads in. */
const COMMON_ORDERS: readonly CsvImportDateOrder[] = ['dmy', 'mdy', 'ymd'];

/** D-302 — a date format as the owner typed it, read by `readDateFormat`. */
export interface CsvImportDateFormat {
  /** The order of the parts. With a year first needing four digits, it is all a
   *  cell is held to: separators and zero-padding may vary from cell to cell. */
  readonly order: CsvImportDateOrder;
  /** The three parts as typed, in order (`dd`, `mm`, `yyyy`). */
  readonly tokens: readonly [string, string, string];
  /** The text before, between and after them, as typed. Nothing between the parts
   *  (`yyyymmdd`) makes the format COMPACT: the typed widths cut each cell. */
  readonly separators: readonly [string, string, string, string];
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
   *  under a fully green suite.
   *
   *  D-302 — no longer needed: the thousands mark is RECOGNISED (`parseCsvAmount`).
   *  Still admitted, because importers before v6 send it; unless it is the decimal
   *  mark, it is recognised as a thousands mark too. */
  readonly thousands_separator?: string;
  /** D-301 — the file's decimal mark. Absent ⇒ `.`. D-302 — the only number setting:
   *  every other mark between digit groups is a thousands mark. */
  readonly decimal_separator?: CsvImportDecimalSeparator;
  /** D-301 — mapped fields that hold a date, stored as `YYYY-MM-DD` once the owner says
   *  how the file writes them (`date_format`), so they sort and filter as dates.
   *  ⚠ A date in `dedup_on` is part of a line's identity: lines imported earlier with
   *  their dates as written will not match the converted ones. */
  readonly date_fields?: readonly string[];
  /** D-302 — how the file writes those dates, as the owner types it: `dd/mm/yyyy`,
   *  `mm/dd/yyyy`, `yyyy-mm-dd`, `dd-mmm-yyyy`, `yyyymmdd`. Empty or absent ⇒ the dates
   *  are stored exactly as written. See `readDateFormat`. */
  readonly date_format?: string;
  /** Fields to coerce to number. A field listed here whose cell is non-empty and does not
   *  parse lands NULL and is reported in `unparsed` — never 0, and never a dropped row. */
  readonly numeric_fields?: readonly string[];
  /** Values for fields the entity declares but the CSV does not carry. A records `create`
   *  requires EVERY declared field, so without these every row is refused for a column
   *  nobody was ever going to map. */
  readonly defaults?: Readonly<Record<string, unknown>>;
  /** What to do with a row whose identity already exists but whose VALUES differ.
   *  Absent means `'fail'` — what the action did before this existed.
   *
   *  ⚠ This decides nothing about a byte-identical row: that is `replayed` in
   *  every mode, and always was. The question here only arises when the file
   *  DISAGREES with a row the owner already has. */
  readonly on_conflict?: RecordsImportConflictMode;
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
  /** D-301 — the first date the owner's `date_format` could not read that ANOTHER
   *  order reads. Present ⇒ the file is not written the way the owner said, so the
   *  dates that DID read may have read wrong, and the import must not record them. */
  readonly date_mismatch?: CsvImportDateMismatch;
}

/** D-301 — a date that says the file is written in another format. */
export interface CsvImportDateMismatch extends CsvImportUnparsed {
  /** D-302 — the format the owner typed. */
  readonly format: string;
  /** D-302 — the same format with its parts in the order the date DOES read in: what
   *  the owner could type instead. */
  readonly reads_as: string;
}

/** The bound entity's writable fields, as the store knows them. */
export interface CsvImportField {
  readonly key: string;
  readonly required: boolean;
}

const SPEC_KEYS = new Set([
  'columns', 'dedup_on', 'scope', 'delimiter', 'thousands_separator',
  'numeric_fields', 'defaults', 'on_conflict',
  'decimal_separator', 'date_fields', 'date_format',
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

  // ⛔ A DOOR, NOT A SAFE DEFAULT. An unrecognised mode is refused here rather
  // than falling back to 'fail': a typo ('Overwrite', 'overwrite ') that read as
  // the default would leave the owner believing rows had been replaced that were
  // silently left alone — the import would report `skipped: 0, updated: 0` and
  // look like a clean no-op run.
  if (raw.on_conflict !== undefined
    && !RECORDS_IMPORT_CONFLICT_MODES.includes(raw.on_conflict as RecordsImportConflictMode)) {
    problems.push(`on_conflict '${String(raw.on_conflict)}' is not admitted — one of `
      + `${RECORDS_IMPORT_CONFLICT_MODES.join(', ')}`);
  }

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

  const fieldList = (key: 'dedup_on' | 'numeric_fields' | 'date_fields', required: boolean): void => {
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
  fieldList('date_fields', false);
  // D-301 — a closed vocabulary, refused rather than read as the default: a misspelt
  // mark that fell back to the point would misread every amount.
  if (raw.decimal_separator !== undefined
    && !(CSV_IMPORT_DECIMAL_SEPARATORS as readonly unknown[]).includes(raw.decimal_separator)) {
    problems.push(`decimal_separator '${String(raw.decimal_separator)}' is not admitted — one of `
      + `${CSV_IMPORT_DECIMAL_SEPARATORS.join(' ')}`);
  }
  // D-302 — the owner TYPES the date format, so one that cannot be read is refused with
  // why, never treated as "keep the dates as written".
  if (raw.date_format !== undefined) {
    if (typeof raw.date_format !== 'string') {
      problems.push('date_format must be a string');
    } else if (raw.date_format.trim() !== '') {
      const format = readDateFormat(raw.date_format);
      if ('problem' in format) problems.push(`date_format “${raw.date_format.trim()}”: ${format.problem}`);
    }
  }
  if (Array.isArray(raw.date_fields) && Array.isArray(raw.numeric_fields)) {
    for (const field of raw.date_fields) {
      if (raw.numeric_fields.includes(field)) problems.push(`'${String(field)}' cannot be both a date and a number`);
    }
  }

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

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** D-302 — a date format the owner typed (`dd/mm/yyyy`), read; or the reason it cannot
 *  be. `d`, `m` and `y` in any case, one run of each: `d`/`dd` a day, `m`/`mm` a month
 *  number, `mmm`/`mmmm` its name, `yy`/`yyyy` a year. Anything else between them is a
 *  separator. The reasons are in the owner's words: the store shows them as they are.
 *
 *  ⛔ A TWO-DIGIT YEAR MUST COME LAST. Read as `yy/mm/dd`, a day-first `31/12/25` is
 *  `2031-12-25`: valid on every line, so no cell fails and no mismatch fires (the
 *  D-301 hole). A four-digit year first cannot be taken for a day. */
export const readDateFormat = (typed: string): CsvImportDateFormat | { readonly problem: string } => {
  const text = typed.trim();
  if (/\d/.test(text)) return { problem: 'type the format, not a date: dd/mm/yyyy rather than 31/12/2025' };
  const tokens: string[] = [];
  const separators: string[] = [''];
  for (const run of text.match(/([a-z])\1*|[^a-z]+/gi) ?? []) {
    if (!/^[a-z]/i.test(run)) {
      separators[separators.length - 1] += run;
      continue;
    }
    const kind = run[0]!.toLowerCase();
    if (kind !== 'd' && kind !== 'm' && kind !== 'y') {
      // A time in the format (`hh:mm`) is the likely slip: say the cell's is dropped.
      const time = kind === 'h' || kind === 's' || kind === 't' ? ', and a time is dropped on its own' : '';
      return { problem: `use only d (day), m (month) and y (year); “${run}” is not one of them${time}` };
    }
    if (!/^(d{1,2}|m{1,4}|y{2}|y{4})$/i.test(run)) {
      return {
        problem: kind === 'y' ? 'write the year as yyyy, or yy'
          : kind === 'd' ? 'write the day as dd or d'
            : 'write the month as mm or m, or mmm for its name',
      };
    }
    tokens.push(run);
    separators.push('');
  }
  const kinds = tokens.map((token) => token[0]!.toLowerCase());
  if (tokens.length !== 3 || new Set(kinds).size !== 3) {
    return { problem: 'it needs one day, one month and one year, like dd/mm/yyyy' };
  }
  if (tokens[kinds.indexOf('y')]!.length === 2 && kinds[2] !== 'y') {
    return { problem: 'a two-digit year has to come last: write yyyy' };
  }
  const compact = separators[1] === '' && separators[2] === '';
  if (!compact && (separators[1] === '' || separators[2] === '')) {
    return { problem: 'put something between every part, or between none' };
  }
  if (compact && tokens.some((token) => /^[dm]/i.test(token) && token.length !== 2)) {
    return { problem: 'with nothing between the parts, write dd and mm' };
  }
  return {
    order: kinds.join('') as CsvImportDateOrder,
    tokens: tokens as [string, string, string],
    separators: separators as [string, string, string, string],
  };
};

/** The format as it would be typed. */
const formatText = (format: CsvImportDateFormat): string =>
  format.separators[0] + format.tokens[0] + format.separators[1] + format.tokens[1]
  + format.separators[2] + format.tokens[2] + format.separators[3];

/** The owner's format with its parts in another order, in the owner's own style:
 *  `dd/mm/yyyy` as `mdy` is `mm/dd/yyyy`. A year moved off the end gets four digits,
 *  since a two-digit one cannot come first. */
const reorder = (format: CsvImportDateFormat, order: CsvImportDateOrder): CsvImportDateFormat => {
  const typed = new Map(format.tokens.map((token) => [token[0]!.toLowerCase(), token] as const));
  const tokens = [...order].map((kind, index) => {
    const token = typed.get(kind)!;
    if (kind !== 'y' || index === 2 || token.length === 4) return token;
    return token[0] === 'Y' ? 'YYYY' : 'yyyy';
  }) as [string, string, string];
  return { order, tokens, separators: format.separators };
};

/** D-301 — one date cell, read in the owner's format, as `YYYY-MM-DD`; `null` when it
 *  does not read that way. Between the parts it takes any mix of punctuation and
 *  spaces. It takes an English month name or abbreviation (`20-Aug-2020`,
 *  `Aug 20, 2020`) and a two-digit year (as 20xx) when the year comes last. A
 *  trailing time is dropped: the field is a day. A date that does not exist on the
 *  calendar (31/02) is not a date. A compact format (`yyyymmdd`) cuts the cell by
 *  its typed widths.
 *
 *  ⛔ A YEAR ANYWHERE BUT LAST NEEDS ALL FOUR DIGITS. Read year first, a day-first
 *  `31/12/25` would be `2031-12-25`: valid on every line, so nothing is unreadable
 *  and nothing refuses. */
export const parseCsvDate = (raw: string, format: CsvImportDateFormat): string | null => {
  const text = raw.trim()
    .replace(/[T\s]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*([ap]\.?m\.?)?\s*(z|[+-]\d{2}:?\d{2})?$/i, '');
  let parts: string[];
  if (format.separators[1] === '' && format.separators[2] === '') {
    const widths = format.tokens.map((token) => token.length);
    if (!/^\d+$/.test(text) || text.length !== widths.reduce((sum, width) => sum + width, 0)) return null;
    let at = 0;
    parts = widths.map((width) => {
      at += width;
      return text.slice(at - width, at);
    });
  } else {
    parts = text.split(/[^0-9a-z]+/i).filter((part) => part !== '');
  }
  if (parts.length !== 3) return null;
  const kinds = [...format.order];
  const part = (kind: string): string => parts[kinds.indexOf(kind)]!;
  const [dayText, monthText, yearText] = [part('d'), part('m'), part('y')];
  if (!/^\d{1,2}$/.test(dayText)) return null;
  const day = Number(dayText);
  const month = /^\d{1,2}$/.test(monthText) ? Number(monthText)
    : /^[a-z]{3,}$/i.test(monthText) ? MONTHS[monthText.slice(0, 3).toLowerCase()] : undefined;
  const year = /^\d{4}$/.test(yearText) ? Number(yearText)
    : kinds[2] === 'y' && /^\d{2}$/.test(yearText) ? 2000 + Number(yearText) : undefined;
  if (month === undefined || year === undefined || month < 1 || month > 12 || day < 1) return null;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/** D-301 — the refusal of a date format the file contradicts, in the owner's words. */
export const dateMismatchMessage = (mismatch: CsvImportDateMismatch): string =>
  `The dates in column “${mismatch.column}” are not written ${mismatch.format}: `
  + `line ${mismatch.line} has “${mismatch.value}”, which reads as ${mismatch.reads_as}. `
  + 'Type the date format your file uses, or leave it empty to keep the dates as written.';

/** D-302 — the refusal of a date format that cannot be read, in the owner's words;
 *  `null` when it can be read, or when there is none (keep the dates as written). */
export const dateFormatRefusal = (typed: unknown): string | null => {
  if (typeof typed !== 'string' || typed.trim() === '') return null;
  const format = readDateFormat(typed);
  return 'problem' in format ? `The date format “${typed.trim()}” cannot be used: ${format.problem}.` : null;
};

/** D-302 — one amount, read with the file's decimal mark; `NaN` when it is not a number
 *  written that way.
 *
 *  🔑 THE DECIMAL MARK IS THE ONLY SETTING. Every other mark between digits (a comma,
 *  a dot, a space of any width, an apostrophe) can only group thousands, so it is
 *  RECOGNISED, not asked for. `1,234.56`, `1 234.56`, `1'234.56` and India's
 *  `12,34,567.89` read with the point; `1.234,56`, `1 234,56` and `1'234,56` with the
 *  comma. `extraMark` is the thousands mark an importer before v6 still sends, and it
 *  is recognised too, unless it is the decimal mark.
 *
 *  ⛔ STRICT GROUPING, SO THE WRONG DECIMAL MARK DOES NOT READ. A group is three digits
 *  (or India's 2-then-3). A number uses one kind of mark and has no leading zero, and
 *  only digits follow the decimal mark. So `12,50` read with the point, or `12.50` with
 *  the comma, is unreadable and reported. Neither is read as 1250.
 *
 *  🔑 WHAT READ CORRECTLY BEFORE READS THE SAME. Before D-302 the point mode dropped
 *  the configured separator wherever it stood and handed the rest to `Number()`. Every
 *  well-formed amount reads identically; only its misreads change, to unreadable
 *  (`12,50` was 1250, `1.200,00` was 1.2). A spreadsheet's exponent (`1.5E+07`) still
 *  reads, as `Number()` read it. */
export const parseCsvAmount = (
  raw: string,
  decimal: CsvImportDecimalSeparator,
  extraMark?: string,
): number => {
  let text = raw.trim();
  const exponent = /[eE][+-]?\d+$/.exec(text)?.[0] ?? '';
  text = text.slice(0, text.length - exponent.length);
  const sign = text.startsWith('-') ? '-' : '';
  if (text.startsWith('-') || text.startsWith('+')) text = text.slice(1);
  const [whole = '', fraction, ...more] = text.split(decimal);
  if (more.length > 0 || (fraction !== undefined && !/^\d*$/.test(fraction))) return Number.NaN;
  if (!/\d/.test(whole + (fraction ?? ''))) return Number.NaN;
  const digits = groupedDigits(whole, decimal, extraMark);
  if (digits === null) return Number.NaN;
  return Number(`${sign}${digits === '' ? '0' : digits}${fraction ? `.${fraction}` : ''}${exponent}`);
};

/** The decimal mark a spec means.
 *
 *  ⛔ A thousands mark of `.` says the file groups with dots, so its decimal mark is
 *  the comma: no file can use one mark for both. That thousands mark is what an
 *  importer before v6 sends from the owner's old setting, with no decimal mark. Read
 *  with the point, the default, `1.200` became 1.2: every amount a thousand times
 *  too small, silently, for owners whose currency groups with dots (CLP, IDR, COP…).
 *  Integrity audit, 2026-09-24. The D-302 check of "every well-formed amount reads
 *  as it did" tested `,`, space, `'` and none, and never `.`. */
export const csvDecimalMarkOf = (
  spec: Pick<CsvImportSpec, 'decimal_separator' | 'thousands_separator'>,
): CsvImportDecimalSeparator =>
  spec.thousands_separator === '.' && (spec.decimal_separator ?? '.') === '.'
    ? ','
    : spec.decimal_separator ?? '.';

/** The digits of a whole part written with thousands marks, or `null` when its marks
 *  are not thousands marks. */
const groupedDigits = (
  whole: string,
  decimal: CsvImportDecimalSeparator,
  extraMark: string | undefined,
): string | null => {
  if (/^\d*$/.test(whole)) return whole;
  const extra = extraMark === undefined || extraMark === '' || extraMark === decimal ? undefined : extraMark;
  // Every space is one kind of mark, and so are both apostrophes; a legacy mark longer
  // than one character stands in as one.
  const LEGACY = '\u0001';
  const unify = (value: string): string => value.replace(/\s/g, ' ').replace(/’/g, "'");
  const text = unify(extra !== undefined && extra.length > 1 ? whole.split(extra).join(LEGACY) : whole);
  const marks = new Set([...text].filter((char) => char < '0' || char > '9'));
  if (marks.size !== 1) return null;
  const [mark] = [...marks] as [string];
  const recognised = mark === ' ' || mark === "'" || mark === (decimal === '.' ? ',' : '.')
    || (extra !== undefined && mark === (extra.length > 1 ? LEGACY : unify(extra)));
  if (!recognised) return null;
  const [first = '', ...rest] = text.split(mark);
  if (!/^[1-9]\d*$/.test(first) || rest.length === 0) return null;
  const western = first.length <= 3 && rest.every((group) => /^\d{3}$/.test(group));
  const indian = first.length <= 2 && rest.length >= 2
    && rest.slice(0, -1).every((group) => /^\d{2}$/.test(group)) && /^\d{3}$/.test(rest[rest.length - 1]!);
  return western || indian ? first + rest.join('') : null;
};

/** One cell, by header name — OWN properties only, `''` when the file has no
 *  such column.
 *
 *  ⛔⛔ `row[column] ?? ''` READ THE PROTOTYPE CHAIN. `csv_parse` builds rows as
 *  plain object literals, so a mapped column the file does not carry but whose
 *  name an Object has anyway — `constructor`, `toString`, `valueOf` — resolved
 *  to a FUNCTION, `.trim()` threw, and the whole import failed with a
 *  TypeError naming nothing the owner wrote. (`constructor` is also one of the
 *  header names `csv_parse` deliberately drops, so a file that DOES have that
 *  column hit the same path.) D-292 put free header names in front of owners
 *  through a mapping screen, which is what made the latent case worth closing. */
const cellOf = (row: Readonly<Record<string, string>>, column: string): string => {
  if (!Object.prototype.hasOwnProperty.call(row, column)) return '';
  const value = row[column];
  return typeof value === 'string' ? value : '';
};

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
  // D-302 — the typed format, read. The store refuses one that cannot be read before it
  // plans, so here that is a caller skipping validation: fail rather than quietly keep
  // the dates the owner asked to convert.
  const typedFormat = (spec.date_format ?? '').trim();
  const format = typedFormat === '' ? null : readDateFormat(typedFormat);
  if (format !== null && 'problem' in format) {
    throw new Error(`planCsvImport: date_format “${typedFormat}”: ${format.problem}`);
  }
  const convert: CsvImportDateFormat | null = format;
  const dates = new Set(convert === null ? [] : spec.date_fields ?? []);
  let dateMismatch: CsvImportDateMismatch | undefined;
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
      const raw = cellOf(row, column).trim();
      if (raw === '') return undefined;
      const parsed = parseCsvAmount(raw, csvDecimalMarkOf(spec), spec.thousands_separator);
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
      // D-301 — a date in the owner's format becomes `YYYY-MM-DD`. One that does not read
      // as that format is KEPT as written and reported: the row still lands, and the owner
      // sees the line in the check. One that reads as ANOTHER format is the mismatch the
      // store refuses on.
      if (convert !== null && dates.has(field)) {
        const raw = cellOf(row, column).trim();
        const iso = raw === '' ? '' : parseCsvDate(raw, convert);
        if (iso === null) {
          unparsed.push({ line, column, value: raw });
          const readsAs = COMMON_ORDERS.filter((order) => order !== convert.order)
            .map((order) => reorder(convert, order))
            .find((other) => parseCsvDate(raw, other) !== null);
          if (dateMismatch === undefined && readsAs !== undefined) {
            dateMismatch = {
              line, column, value: raw, format: formatText(convert), reads_as: formatText(readsAs),
            };
          }
        }
        values[field] = iso ?? raw;
        continue;
      }
      if (!numeric.has(field)) {
        values[field] = cellOf(row, column).trim();
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

  return {
    rows_read: rows.length, rows: planned, unparsed,
    ...(dateMismatch === undefined ? {} : { date_mismatch: dateMismatch }),
  };
};
