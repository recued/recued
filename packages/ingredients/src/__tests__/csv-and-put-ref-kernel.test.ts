/** D-244 / D-245 — the kernel ADAPTER cases, which is where two shipped defects
 *  lived.
 *
 *  ⛔⛔ BOTH WERE GATE-VS-HANDLER MISMATCHES, and both shipped green. The
 *  handlers were widened to accept a second shape; the adapter gates in
 *  `kernel.ts` were not. So the request was rejected with `BAD_INPUT` before it
 *  ever reached the widened code:
 *
 *    - `file-put-ref` demanded a record-id STRING, while a CLI op's
 *      `shape: 'ref'` output defaults to `storage: 'temp'` — a TempFileRef
 *      OBJECT. The whole `to_csv → put-ref` refresh path could not run.
 *    - `csv-filter` demanded `record_id`, while the recipe addresses its file by
 *      `{slug, path}`. Every named-file search failed.
 *
 *  🔑 WHY NOTHING CAUGHT THEM, and the reason this file exists at all: the
 *  handler tests called `handleCsvFilter` / `handleFilePutRef` DIRECTLY, and the
 *  recipe test asserted the recipe's shape. Both sides were exercised, the gate
 *  between them was not, and mutating the gate left every one of those tests
 *  green. A boundary is only covered by a test that goes THROUGH it. */

import { describe, expect, it } from 'vitest';

import { createKernelAdapter } from '../kernel.js';
import { IngredientError } from '../types.js';
import type { TempFileRef } from '@recued/contracts';

const TEMP_REF: TempFileRef = {
  backing: 'temp',
  path: '/tmp/recued-run-scratch/run-1/op-x/sheet.csv',
  mime_type: 'text/csv',
  filename: 'sheet.csv',
};
const CAS_REF = `file:${'a'.repeat(32)}`;

const mkCall = (slug: string, input: Record<string, unknown>, stepMeta?: Record<string, unknown>) =>
  ({
    slug,
    risk_tier: slug === 'file-put-ref' ? ('write' as const) : ('read' as const),
    input,
    output: {},
    ...(stepMeta ? { stepMeta } : {}),
  }) as Parameters<ReturnType<typeof createKernelAdapter>>[0];

describe('kernel adapter — file-put-ref', () => {
  const PUT_RESULT = { ok: true as const, bytes_written: 7, slug: 'vault', path: 'a.csv' };

  /** ⛔ THE DEFECT. This is the exact value `xlsx2csv.spreadsheet.to_csv`
   *  produces, and the gate used to reject it outright. */
  it('routes a TempFileRef object through, with the run scope', async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = createKernelAdapter({
      filePutRef: async (input) => { captured = input as never; return PUT_RESULT; },
    });

    await adapter(mkCall(
      'file-put-ref',
      { slug: 'vault', path: 'sheets/a.csv', ref: TEMP_REF },
      { run_id: 'run-1', step_id: 'stored' },
    ));

    expect(captured?.ref).toEqual(TEMP_REF);
    // The run scope is the only authorization a temp ref carries.
    expect(captured?.run_id).toBe('run-1');
  });

  it('still routes a CAS record-id string', async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = createKernelAdapter({
      filePutRef: async (input) => { captured = input as never; return PUT_RESULT; },
    });
    await adapter(mkCall('file-put-ref', { slug: 'vault', path: 'a.csv', ref: CAS_REF }));
    expect(captured?.ref).toBe(CAS_REF);
  });

  it.each([
    ['no ref', { slug: 'vault', path: 'a.csv' }],
    ['empty ref', { slug: 'vault', path: 'a.csv', ref: '' }],
    ['no slug', { path: 'a.csv', ref: CAS_REF }],
    ['no path', { slug: 'vault', ref: CAS_REF }],
  ])('refuses %s', async (_label, input) => {
    const adapter = createKernelAdapter({ filePutRef: async () => PUT_RESULT });
    await expect(adapter(mkCall('file-put-ref', input))).rejects.toBeInstanceOf(IngredientError);
  });
});

describe('kernel adapter — csv ops take either address', () => {
  const FILTER_RESULT = {
    file_ref: 'file:out', matched: 1, scanned: 2, column_found: true, columns: ['a'],
  };

  /** ⛔ THE DEFECT. The recipe addresses its own file by name; the gate used to
   *  insist on a CAS id, so the call died before the handler that understood it. */
  it('routes {slug, path} through to the dispatcher', async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = createKernelAdapter({
      csvFilter: async (input) => { captured = input as never; return FILTER_RESULT; },
    });

    await adapter(mkCall('csv-filter', {
      slug: 'vault', path: 'spreadsheets/abc.s1.csv', column: 'Email', match: 'globex',
    }));

    expect(captured).toMatchObject({
      slug: 'vault', path: 'spreadsheets/abc.s1.csv', column: 'Email', match: 'globex',
    });
    // ⛔ ...and does NOT invent a record_id the caller never gave.
    expect(captured?.record_id).toBeUndefined();
  });

  it('still routes a record_id', async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = createKernelAdapter({
      csvFilter: async (input) => { captured = input as never; return FILTER_RESULT; },
    });
    await adapter(mkCall('csv-filter', { record_id: CAS_REF, column: 'a', match: 'b' }));
    expect(captured?.record_id).toBe(CAS_REF);
    expect(captured?.slug).toBeUndefined();
  });

  it('refuses a call with neither address', async () => {
    const adapter = createKernelAdapter({ csvFilter: async () => FILTER_RESULT });
    await expect(adapter(mkCall('csv-filter', { column: 'a', match: 'b' })))
      .rejects.toBeInstanceOf(IngredientError);
  });

  it.each(['csv-columns', 'csv-stats'])('%s takes either address too', async (slug) => {
    let captured: Record<string, unknown> | undefined;
    const impl = async (input: unknown) => { captured = input as never; return { columns: [], rows: 0 }; };
    const adapter = createKernelAdapter({ csvColumns: impl as never, csvStats: impl as never });

    await adapter(mkCall(slug, { slug: 'vault', path: 'a.csv' }));
    expect(captured).toMatchObject({ slug: 'vault', path: 'a.csv' });

    await adapter(mkCall(slug, { record_id: CAS_REF }));
    expect(captured?.record_id).toBe(CAS_REF);

    await expect(adapter(mkCall(slug, {}))).rejects.toBeInstanceOf(IngredientError);
  });
});

/** `csv-rows` — csv-filter's READING twin. Same addresses, same match inputs, a
 *  `limit`, and none of csv-filter's run scope: nothing is ingested, so there is
 *  no provenance to key. The handler owns `limit`'s default and ceiling; the gate
 *  only refuses a `limit` that is not a number. */
describe('kernel adapter — csv-rows', () => {
  const ROWS_RESULT = {
    rows: [], matched: 0, scanned: 0, truncated: false, column_found: true, columns: [],
  };

  it('routes either address, the match inputs and limit — and no run scope', async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = createKernelAdapter({
      csvRows: async (input) => { captured = input as never; return ROWS_RESULT; },
    });
    await adapter(mkCall('csv-rows', {
      slug: 'vault', path: 'a.csv', column: 'Email', match: 'globex',
      mode: 'equal', ignore_case: true, delimiter: ';', limit: 5,
    }));
    expect(captured).toEqual({
      slug: 'vault', path: 'a.csv', column: 'Email', match: 'globex',
      mode: 'equal', ignore_case: true, delimiter: ';', limit: 5,
    });

    await adapter(mkCall('csv-rows', { record_id: CAS_REF, column: 'a', match: 'b' }));
    expect(captured).toEqual({ record_id: CAS_REF, column: 'a', match: 'b' });
  });

  it('refuses a missing address, a missing column, and a limit that is not a number', async () => {
    const adapter = createKernelAdapter({ csvRows: async () => ROWS_RESULT });
    for (const input of [
      { column: 'a', match: 'b' },
      { record_id: CAS_REF, match: 'b' },
      { record_id: CAS_REF, column: 'a', match: 'b', limit: '5' },
    ]) {
      await expect(adapter(mkCall('csv-rows', input))).rejects.toBeInstanceOf(IngredientError);
    }
  });

  it('says it is unavailable when no server wired it', async () => {
    const adapter = createKernelAdapter({});
    await expect(adapter(mkCall('csv-rows', { record_id: CAS_REF, column: 'a', match: 'b' })))
      .rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });
});
