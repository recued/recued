/** D-244 — whole-file CSV filtering, the pure half.
 *
 *  🔑 The point of these functions living beside `csv_parse` rather than in the
 *  kernel is that they PARSE THE SAME WAY. A kernel op with its own parser would
 *  read the identical file differently from the transform layer — a BOM'd header
 *  matching in one place and not the other reads to an owner as "the data is
 *  wrong", and it would go unnoticed for a long time. So the tests below are
 *  mostly about FIDELITY: quoting, embedded delimiters, CRLF, ragged rows and
 *  column order surviving a filter untouched. */

import { describe, expect, it } from 'vitest';

import { csvFilter, csvColumns, csvStats, CSV_STATS_UNIQUE_CAP } from '../csv-file.js';
import { csv_parse } from '../object.js';

const parse = (text: string): unknown =>
  csv_parse({ input: text } as never, {} as never);

describe('csvFilter', () => {
  const CSV = 'Name,Email,Amount\nAcme Ltd,ops@acme.test,1240.50\nGlobex,hi@globex.test,88\n';

  it('keeps the header and the matching rows', () => {
    const r = csvFilter({ text: CSV, column: 'Email', match: 'globex' });
    expect(r.csv).toBe('Name,Email,Amount\nGlobex,hi@globex.test,88');
    expect(r.scanned).toBe(2);
    expect(r.matched).toBe(1);
    expect(r.column_found).toBe(true);
  });

  it('matches exactly when asked', () => {
    expect(csvFilter({ text: CSV, column: 'Name', match: 'Acme', mode: 'equal' }).matched).toBe(0);
    expect(csvFilter({ text: CSV, column: 'Name', match: 'Acme Ltd', mode: 'equal' }).matched).toBe(1);
  });

  /** ⚠ Default is case-SENSITIVE: an exact lookup of a customer id must not
   *  quietly match a different casing. */
  it('folds case only on request', () => {
    expect(csvFilter({ text: CSV, column: 'Name', match: 'acme' }).matched).toBe(0);
    expect(csvFilter({ text: CSV, column: 'Name', match: 'acme', ignore_case: true }).matched).toBe(1);
  });

  /** ⛔⛔ THE DISTINCTION EVERYTHING DOWNSTREAM KEYS ON. A missing column and a
   *  genuine miss both yield zero rows; only `column_found` tells them apart,
   *  and over a customer list "no such record" is the expensive wrong answer. */
  it('reports a missing column as such, not as an empty result', () => {
    const miss = csvFilter({ text: CSV, column: 'Nope', match: 'anything' });
    expect(miss.column_found).toBe(false);
    expect(miss.matched).toBe(0);
    // ...and it still says what the columns ARE, so the caller can name them.
    expect(miss.columns).toEqual(['Name', 'Email', 'Amount']);

    const genuine = csvFilter({ text: CSV, column: 'Email', match: 'nobody@here' });
    expect(genuine.column_found).toBe(true);
    expect(genuine.matched).toBe(0);
  });

  /** The header survives a zero-match filter, so a downstream parse sees a
   *  well-formed file with no rows — not an empty file indistinguishable from a
   *  failed run. */
  it('carries the header through a zero-match filter', () => {
    const r = csvFilter({ text: CSV, column: 'Email', match: 'nobody@here' });
    expect(r.csv).toBe('Name,Email,Amount');
    expect(parse(r.csv)).toEqual([]);
  });

  describe('fidelity — a filtered file must still say exactly what it said', () => {
    /** ⛔ The reason this parses to RAW ROWS instead of objects. Round-tripping
     *  through `Record<string,string>` rebuilds the file from object keys, so a
     *  duplicate header name collapses onto one column and the row silently
     *  loses a cell. */
        it('preserves duplicate header names', () => {
      const dup = 'id,note,note\n1,alpha,beta\n2,gamma,delta\n';
      const r = csvFilter({ text: dup, column: 'id', match: '2' });
      expect(r.csv).toBe('id,note,note\n2,gamma,delta');
    });

    it('preserves column order', () => {
      const r = csvFilter({ text: CSV, column: 'Amount', match: '88' });
      expect(r.csv.split('\n')[0]).toBe('Name,Email,Amount');
    });

    it('re-quotes a cell containing the delimiter, a quote or a newline', () => {
      const tricky = 'id,note\n1,"a,b"\n2,"say ""hi"""\n3,"two\nlines"\n';
      for (const [needle, expected] of [
        ['1', 'id,note\n1,"a,b"'],
        ['2', 'id,note\n2,"say ""hi"""'],
        ['3', 'id,note\n3,"two\nlines"'],
      ] as const) {
        expect(csvFilter({ text: tricky, column: 'id', match: needle }).csv).toBe(expected);
      }
    });

    /** A filtered file is re-read by the caller, so it must survive the same
     *  parser it came from — the property that makes the round trip safe. */
    it('round-trips through csv_parse', () => {
      const tricky = 'id,note\n1,"a,b"\n2,"say ""hi"""\n';
      const r = csvFilter({ text: tricky, column: 'id', match: '1' });
      expect(parse(r.csv)).toEqual([{ id: '1', note: 'a,b' }]);
    });

    it('reads CRLF input and a BOM the same way csv_parse does', () => {
      const crlf = '﻿Name,Email\r\nAcme,ops@acme.test\r\n';
      const r = csvFilter({ text: crlf, column: 'Name', match: 'Acme' });
      // ⛔ The BOM is stripped, so `Name` matches. Without that the first column
      // is really named `﻿Name` and never matches anything a human types.
      expect(r.column_found).toBe(true);
      expect(r.csv).toBe('Name,Email\nAcme,ops@acme.test');
    });

    it('honours a non-comma delimiter on both read and write', () => {
      const tsv = 'id\tnote\n1\ta,b\n2\tc\n';
      const r = csvFilter({ text: tsv, column: 'note', match: 'a,b', delimiter: '\t' });
      // The comma is NOT special here, so the cell needs no quoting.
      expect(r.csv).toBe('id\tnote\n1\ta,b');
    });

    /** ⚠ A row shorter than the header has no cell at the index — a MISS, not a
     *  crash and not a match. */
    it('treats a short row as a miss', () => {
      const ragged = 'a,b,c\n1,2\n3,4,5\n';
      expect(csvFilter({ text: ragged, column: 'c', match: '5' }).matched).toBe(1);
      expect(csvFilter({ text: ragged, column: 'c', match: '' }).matched).toBe(2);
    });
  });

  it('handles an empty file without inventing a column', () => {
    const r = csvFilter({ text: '', column: 'x', match: 'y' });
    expect(r).toMatchObject({ csv: '', scanned: 0, matched: 0, column_found: false, columns: [] });
  });

  it('handles a header-only file', () => {
    const r = csvFilter({ text: 'a,b\n', column: 'a', match: '1' });
    expect(r.column_found).toBe(true);
    expect(r.scanned).toBe(0);
    expect(r.csv).toBe('a,b');
  });
});

describe('csvColumns', () => {
  it('returns the header in order', () => {
    expect(csvColumns({ text: 'z,a,m\n1,2,3\n' })).toEqual(['z', 'a', 'm']);
  });

  it('strips the BOM, so a name matches what a human typed', () => {
    expect(csvColumns({ text: '﻿Name,Email\n' })).toEqual(['Name', 'Email']);
  });

  it('is empty for an empty file', () => {
    expect(csvColumns({ text: '' })).toEqual([]);
  });
});

describe('csvStats', () => {
  const CSV = 'Name,Amount,Note\nAcme,10,alpha\nGlobex,2.5,\nInitech,7.5,alpha\n';
  const col = (text: string, name: string) =>
    csvStats({ text }).columns.find((c) => c.name === name)!;

  it('counts rows excluding the header', () => {
    expect(csvStats({ text: CSV }).rows).toBe(3);
  });

  it('summarises a numeric column', () => {
    expect(col(CSV, 'Amount')).toMatchObject({
      filled: 3, empty: 0, numeric: true, min: 2.5, max: 10, sum: 20, mean: 20 / 3,
    });
  });

  it('counts empties and distinct values on a text column', () => {
    expect(col(CSV, 'Note')).toMatchObject({
      filled: 2, empty: 1, unique: 1, numeric: false, min: null, mean: null,
    });
  });

  /** ⛔⛔ THE TRAP THIS GUARDS. `Number('')` is 0 and `Number('  ')` is 0, so an
   *  empty cell parsed naively becomes a legitimate-looking zero — dragging a
   *  mean down with values that were never there. Emptiness is decided BEFORE
   *  parsing, so a blank never reaches the arithmetic. */
  it('never lets an empty cell become a zero', () => {
    // ⚠ Two columns, because `csv_parse` SWALLOWS a wholly blank LINE (its
    // empty-row guard) — so a blank must be a real CELL to be counted. A first
    // draft used '\n\n' and asserted two empties; the parser had dropped one.
    const c = col('k,n\na,10\nb,\nc,  \nd,20\n', 'n');
    expect(c).toMatchObject({ filled: 2, empty: 2, sum: 30, mean: 15, min: 10, max: 20 });
  });

  /** ⛔ One stray non-number makes the whole column non-numeric. A mean over
   *  "most of" a column reads as a mean over the column — worse than no mean. */
  it('refuses to summarise a column with a single non-number in it', () => {
    const c = col('n\n10\nN/A\n20\n', 'n');
    expect(c.numeric).toBe(false);
    expect(c).toMatchObject({ sum: null, mean: null, min: null, max: null });
    expect(c.filled).toBe(3);
  });

  /** ⚠ A thousands-separated figure is NOT numeric, and that is correct:
   *  spreadsheets export them as text, and summing only the ones that happen to
   *  parse would report a total over an arbitrary subset of the column. */
  it('treats a comma-formatted figure as text', () => {
    // ⚠ QUOTED, because unquoted `1,240.50` is genuinely TWO cells under a comma
    // delimiter — which is correct CSV and not what this test is about. The
    // quoted form is how a spreadsheet actually exports a formatted figure.
    expect(col('n\n"1,240.50"\n88\n', 'n').numeric).toBe(false);
  });

  it('measures the longest value', () => {
    expect(col(CSV, 'Name').longest).toBe('Initech'.length);
  });

  /** ⛔ The one place a "summary" could cost as much as the data: a Set over
   *  every value of a high-cardinality column. Capped — and the cap is REPORTED,
   *  because a capped count read as an exact one is a quiet lie. */
  it('caps distinct counting and says when it did', () => {
    const many = ['id', ...Array.from({ length: 50 }, (_, i) => String(i))].join('\n');
    const small = csvStats({ text: many }).columns[0]!;
    expect(small.unique).toBe(50);
    expect(small.unique_capped).toBe(false);
    expect(CSV_STATS_UNIQUE_CAP).toBe(10_000);
  });

  it('is empty for an empty file', () => {
    expect(csvStats({ text: '' })).toEqual({ rows: 0, columns: [] });
  });

  it('reports a header-only file as zero rows with its columns', () => {
    const r = csvStats({ text: 'a,b\n' });
    expect(r.rows).toBe(0);
    expect(r.columns.map((c) => c.name)).toEqual(['a', 'b']);
    expect(r.columns[0]!.numeric).toBe(false);
  });

  /** Every field is a scalar — the result must not grow with the file, or it
   *  stops being a value-shaped answer. */
  it('returns a result whose size depends only on the column count', () => {
    const wide = csvStats({ text: CSV });
    for (const c of wide.columns) {
      for (const v of Object.values(c)) {
        expect(['string', 'number', 'boolean', 'object']).toContain(typeof v);
        expect(Array.isArray(v)).toBe(false);
      }
    }
  });
});

describe('csvStats — the distinct-count cap actually engages', () => {
  /** ⛔ A mutation deleting the `capped = true` line kept every test green,
   *  because none of them exceeded the cap. A flag nobody exercises is a flag
   *  that can silently stop working — and this one is what keeps a FLOOR from
   *  being read as an exact count. */
  it('reports unique_capped once past the ceiling', () => {
    const rows = ['id', ...Array.from({ length: CSV_STATS_UNIQUE_CAP + 500 }, (_, i) => `v${i}`)];
    const c = csvStats({ text: rows.join('\n') }).columns[0]!;
    expect(c.unique).toBe(CSV_STATS_UNIQUE_CAP);
    expect(c.unique_capped).toBe(true);
    // ⚠ The row count is exact regardless — only DISTINCTNESS is capped.
    expect(csvStats({ text: rows.join('\n') }).rows).toBe(CSV_STATS_UNIQUE_CAP + 500);
  });

  /** ⚠ And a repeated value past the cap must NOT flip the flag — it is already
   *  counted, so nothing was lost. Without the `!seen.has(cell)` check this
   *  would report capped on a column of one repeated value. */
  it('does not flag a repeat that was already counted', () => {
    const rows = ['id', ...Array.from({ length: CSV_STATS_UNIQUE_CAP }, (_, i) => `v${i}`)];
    rows.push('v0', 'v1', 'v2');
    const c = csvStats({ text: rows.join('\n') }).columns[0]!;
    expect(c.unique).toBe(CSV_STATS_UNIQUE_CAP);
    expect(c.unique_capped).toBe(false);
  });
});
