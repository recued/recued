/** D-244 — `csv-filter` / `csv-columns`, the kernel half.
 *
 *  ⛔ WHY A KERNEL OP AND NOT A TRANSFORM, since the logic is pure and could
 *  have gone either way. Dereferencing a `file_ref` is the Gateway-gated content
 *  boundary, and `packages/` transforms run on the Bridge and webclient — hosts
 *  with no warehouse at all. A file-reading transform would be BOTH an unaudited
 *  second path to those bytes AND undefined on two of three hosts. The rule the
 *  split follows: transforms operate on what is already in step state; kernel
 *  ops are how bytes enter it.
 *
 *  ⚠ The parsing is deliberately NOT tested here — it lives in
 *  `packages/transforms/src/__tests__/csv-file.test.ts` and is shared with
 *  `csv_parse`. What this file owns is the I/O contract: what gets read, what
 *  gets ingested, and what the caller can tell apart afterwards.
 */

import { describe, expect, it } from 'vitest';
import { getTransform } from '@recued/transforms';

import {
  handleCsvColumns,
  handleCsvFilter,
  handleCsvRows,
  handleCsvStats,
  CSV_FILTER_MAX_BYTES,
  CSV_ROWS_DEFAULT_LIMIT,
  CSV_ROWS_MAX_LIMIT,
  type CsvFilterDeps,
} from '../collections/file/csv-filter-handler.js';

const CSV = 'Name,Email,Amount\nAcme Ltd,ops@acme.test,1240.50\nGlobex,hi@globex.test,88\n';

const deps = (csv = CSV, over: Partial<CsvFilterDeps> = {}) => {
  const ingested: Array<{ bytes: Buffer; filename: string; mime_type: string }> = [];
  const reads: string[] = [];
  const d: CsvFilterDeps = {
    reader: {
      readFile: async ({ record_id }) => {
        reads.push(record_id);
        return {
          record_id,
          bytes_b64: Buffer.from(csv, 'utf8').toString('base64'),
          filename: 'people.csv',
          mime_type: 'text/csv',
        };
      },
    },
    ingest: async (input) => {
      ingested.push(input);
      return { record_id: 'file:filtered' };
    },
    ...over,
  };
  return { d, ingested, reads };
};

describe('csv-filter', () => {
  it('ingests only the matching rows, with the header', async () => {
    const { d, ingested } = deps();
    const r = await handleCsvFilter(d, {
      record_id: 'file:src', column: 'Email', match: 'globex',
    });

    expect(r.file_ref).toBe('file:filtered');
    expect(r).toMatchObject({ matched: 1, scanned: 2, column_found: true });
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.bytes.toString('utf8')).toBe('Name,Email,Amount\nGlobex,hi@globex.test,88');
    expect(ingested[0]!.mime_type).toBe('text/csv');
  });

  /** ⛔⛔ THE CONTRACT EVERY CALLER DEPENDS ON. A missing column and a genuine
   *  miss are the same row count; only `column_found` separates them. And the
   *  op returns NO ref for a missing column — handing one back would give the
   *  caller a parseable empty file, which is exactly the ambiguity this op was
   *  built to remove. */
  it('returns no ref for a missing column, and says the column is missing', async () => {
    const { d, ingested } = deps();
    const r = await handleCsvFilter(d, {
      record_id: 'file:src', column: 'Nope', match: 'x',
    });

    expect(r.column_found).toBe(false);
    expect(r.file_ref).toBeUndefined();
    expect(r.matched).toBe(0);
    // Nothing is written for a question that could not be asked.
    expect(ingested).toEqual([]);
    // ...and the caller can name the columns that DO exist.
    expect(r.columns).toEqual(['Name', 'Email', 'Amount']);
  });

  it('distinguishes that from a genuine zero-match, which DOES get a ref', async () => {
    const { d, ingested } = deps();
    const r = await handleCsvFilter(d, {
      record_id: 'file:src', column: 'Email', match: 'nobody@here',
    });

    expect(r.column_found).toBe(true);
    expect(r.matched).toBe(0);
    expect(r.file_ref).toBe('file:filtered');
    // A header-only file: a downstream parse sees a well-formed CSV with no
    // rows, rather than an empty file that reads like a failed run.
    expect(ingested[0]!.bytes.toString('utf8')).toBe('Name,Email,Amount');
  });

  it('honours exact mode and case folding', async () => {
    const { d } = deps();
    expect((await handleCsvFilter(d, {
      record_id: 'f', column: 'Name', match: 'Acme', mode: 'equal',
    })).matched).toBe(0);
    expect((await handleCsvFilter(d, {
      record_id: 'f', column: 'Name', match: 'acme', ignore_case: true,
    })).matched).toBe(1);
  });

  /** ⚠ This handler is the LAST place able to refuse before the bytes are
   *  decoded into memory. The ceiling is generous next to what a recipe could
   *  safely pull into step state — because here the bytes never leave the
   *  handler — but it is still a bound. */
  it('refuses a file past the ceiling before parsing it', async () => {
    const { d } = deps('x'.repeat(4096));
    await expect(handleCsvFilter(
      { ...d, maxBytes: 1024 },
      { record_id: 'file:big', column: 'a', match: 'b' },
    )).rejects.toThrow(/past the 1024-byte ceiling/u);
  });

  it('has a default ceiling at all', () => {
    expect(CSV_FILTER_MAX_BYTES).toBe(32 * 1024 * 1024);
  });

  it('reads the record it was asked for, once', async () => {
    const { d, reads } = deps();
    await handleCsvFilter(d, { record_id: 'file:abc', column: 'Name', match: 'Acme' });
    expect(reads).toEqual(['file:abc']);
  });

  it.each([
    ['no record_id', { record_id: '', column: 'a', match: 'b' }],
    ['no column', { record_id: 'f', column: '', match: 'b' }],
  ])('refuses %s', async (_label, args) => {
    const { d } = deps();
    await expect(handleCsvFilter(d, args as never)).rejects.toThrow();
  });
});

/** `csv-rows` — csv-filter's READING twin. Same matches, returned as rows, and
 *  NOTHING saved: that is what lets a view that runs unasked use it, and what
 *  makes it a read where csv-filter is a write. */
describe('csv-rows', () => {
  /** ⛔⛔ THE PROPERTY THE OP EXISTS FOR. Handed the full dep bundle, ingestor
   *  included, it still ingests nothing — its deps type drops the ingestor, and
   *  this pins the behaviour a type cannot. */
  it('returns the matching rows and ingests nothing, even when handed an ingestor', async () => {
    const { d, ingested } = deps();
    const r = await handleCsvRows(d, { record_id: 'file:src', column: 'Email', match: 'globex' });
    expect(r.rows).toEqual([{ Name: 'Globex', Email: 'hi@globex.test', Amount: '88' }]);
    expect(r).toMatchObject({ matched: 1, scanned: 2, truncated: false, column_found: true });
    expect(ingested).toHaveLength(0);
  });

  /** The twin cannot disagree with its sibling: the rows are what parsing the
   *  file csv-filter saves gives, on the same input. */
  it("returns exactly what reading back csv-filter's saved file would", async () => {
    const tricky = 'id,note\n1,"a,b"\n2,"say ""hi"""\n3,"two\nlines"\n4\n';
    const { d, ingested } = deps(tricky);
    await handleCsvFilter(d, { record_id: 'file:src', column: 'id', match: '' });
    // The recipe engine's own `csv_parse`, reached the way a recipe reaches it.
    const saved = getTransform('csv_parse')!({ input: ingested[0]!.bytes.toString('utf8') } as never, {} as never);
    const read = await handleCsvRows(deps(tricky).d, { record_id: 'file:src', column: 'id', match: '' });
    expect(read.rows).toEqual(saved);
  });

  it('caps the rows at a default, counts every match, and says it cut', async () => {
    const big = ['n', ...Array.from({ length: CSV_ROWS_DEFAULT_LIMIT + 50 }, (_, i) => `${i}`)].join('\n');
    const r = await handleCsvRows(deps(big).d, { record_id: 'file:src', column: 'n', match: '' });
    expect(r.rows).toHaveLength(CSV_ROWS_DEFAULT_LIMIT);
    expect(r).toMatchObject({ matched: CSV_ROWS_DEFAULT_LIMIT + 50, truncated: true });

    const all = await handleCsvRows(deps(big).d, {
      record_id: 'file:src', column: 'n', match: '', limit: CSV_ROWS_MAX_LIMIT,
    });
    expect(all.rows).toHaveLength(CSV_ROWS_DEFAULT_LIMIT + 50);
    expect(all.truncated).toBe(false);
  });

  /** ⛔ Refused, not clamped — a caller that asked for more than the ceiling and
   *  quietly got less would read `truncated` as a fact about the sheet. */
  it.each([0, -1, 2.5, CSV_ROWS_MAX_LIMIT + 1])('refuses limit %s', async (limit) => {
    await expect(handleCsvRows(deps().d, { record_id: 'file:src', column: 'Email', match: '', limit }))
      .rejects.toThrow(/limit/);
  });

  it('says a missing column is missing, with no rows', async () => {
    const r = await handleCsvRows(deps().d, { record_id: 'file:src', column: 'Nope', match: 'x' });
    expect(r).toMatchObject({ rows: [], column_found: false, matched: 0 });
    expect(r.columns).toEqual(['Name', 'Email', 'Amount']);
  });

  it('respects the same byte ceiling as the other csv ops', async () => {
    const { d } = deps(CSV, { maxBytes: 8 });
    await expect(handleCsvRows(d, { record_id: 'file:src', column: 'Email', match: '' }))
      .rejects.toThrow(/ceiling/);
  });
});

describe('csv-columns', () => {
  it('returns the header in order', async () => {
    const { d } = deps();
    expect(await handleCsvColumns(d, { record_id: 'file:src' }))
      .toEqual({ columns: ['Name', 'Email', 'Amount'] });
  });

  /** Cheap enough to run BEFORE a filter — which is how a recipe keeps "no such
   *  column" apart from "no such record" without reading the sheet twice. */
  it('never ingests anything', async () => {
    const { d, ingested } = deps();
    await handleCsvColumns(d, { record_id: 'file:src' });
    expect(ingested).toEqual([]);
  });
});

describe('csv-stats', () => {
  const SHEET = 'Name,Amount\nAcme,10\nGlobex,\nInitech,20\n';

  /** 🔑 A VALUE result, and that is why this is a kernel op rather than the
   *  `csvstat` CLI pack on the stdout-capture arm. That arm would make the stats
   *  reachable and WORSE — a small structured summary coming back as a FILE,
   *  costing read → decode → parse to recover what the caller wanted directly. */
  it('returns the summary directly, ingesting nothing', async () => {
    const { d, ingested } = deps(SHEET);
    const r = await handleCsvStats(d, { record_id: 'file:sheet' });

    expect(r.rows).toBe(3);
    expect(r.columns.map((c) => c.name)).toEqual(['Name', 'Amount']);
    expect(r.columns[1]).toMatchObject({
      filled: 2, empty: 1, numeric: true, min: 10, max: 20, sum: 30, mean: 15,
    });
    // Nothing is written — a summary is an answer, not an artifact.
    expect(ingested).toEqual([]);
  });

  /** ⛔ The empty cell must not become a zero. With `Number('')` returning 0, a
   *  naive parse would report mean 10 over three values instead of 15 over two. */
  it('excludes the empty cell from the mean rather than counting it as zero', async () => {
    const { d } = deps(SHEET);
    const r = await handleCsvStats(d, { record_id: 'f' });
    expect(r.columns[1]!.mean).toBe(15);
  });

  it('respects the same ceiling as the other csv ops', async () => {
    const { d } = deps('x'.repeat(4096));
    await expect(handleCsvStats(
      { ...d, maxBytes: 1024 },
      { record_id: 'file:big' },
    )).rejects.toThrow(/past the 1024-byte ceiling/u);
  });
});

describe('the addressing the recipe actually uses', () => {
  /** ⛔⛔ THE SECOND JOIN NO TEST CROSSED. The handler was widened to accept
   *  `{slug, path}` and the recipe was switched to it — but the KERNEL ADAPTER
   *  in between still demanded `record_id` and threw BAD_INPUT, so the request
   *  never reached the widened handler. Handler tests passed a record_id; the
   *  recipe test asserted the recipe passes slug/path; nothing ran the pair.
   *
   *  🔑 The shape of the miss is the lesson: widening a boundary means widening
   *  every gate ON it, and the gates are not all in the file you edited. */
  it('reads a named file instance, not only a CAS record', async () => {
    const reads: Array<{ slug: string; path: string }> = [];
    const { d } = deps();
    const withInstance = {
      ...d,
      instanceReader: {
        readInstanceFile: async (input: { slug: string; path: string }) => {
          reads.push(input);
          return { body_b64: Buffer.from(CSV, 'utf8').toString('base64') };
        },
      },
    };

    const r = await handleCsvFilter(withInstance as never, {
      slug: 'vault', path: 'spreadsheets/abc.s1.csv',
      column: 'Email', match: 'globex',
    } as never);

    expect(r.matched).toBe(1);
    expect(r.column_found).toBe(true);
    expect(reads).toEqual([{ slug: 'vault', path: 'spreadsheets/abc.s1.csv' }]);
  });

  /** ⛔ Ambiguity is REFUSED, not resolved by precedence — a caller that passed
   *  both addresses meant one of them, and silently picking reads the wrong
   *  file while looking successful. */
  it('refuses both addresses at once', async () => {
    const { d } = deps();
    await expect(handleCsvFilter(
      { ...d, instanceReader: { readInstanceFile: async () => ({ body_b64: '' }) } } as never,
      { record_id: 'file:x', slug: 'vault', path: 'p.csv', column: 'Email', match: 'a' } as never,
    )).rejects.toThrow(/not both/u);
  });

  it('refuses neither', async () => {
    const { d } = deps();
    await expect(handleCsvFilter(d, { column: 'Email', match: 'a' } as never)).rejects.toThrow();
  });
});
