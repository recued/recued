import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { TRANSFORMS } from '@recued/transforms';
import { describe, expect, it } from 'vitest';

import { planCsvImport } from '../records/csv-import.js';

/** Driven against the SAME real bank export that found six defects in the recipe-level
 *  import, because the whole justification for this code existing is that the recipe
 *  version could not be made correct — and a synthetic fixture would have passed there too.
 */
const CSV = resolve(import.meta.dirname, '../../../..', '..', 'sample_data/1000-BT-Records.csv');
const maybe = existsSync(CSV) ? it : it.skip;

const csvRows = (): Record<string, string>[] => {
  const parse = (TRANSFORMS as unknown as Map<string, (p: Record<string, unknown>, c: unknown) => unknown>)
    .get('csv_parse')!;
  /** ⚠ The DEFAULT ragged mode, matching what the store's `import` action does. `'skip'`
   *  drops a short row entirely, which is silent row loss — the one thing this planner
   *  exists to prevent — and would make `rows_read` describe the parser rather than
   *  the file. That this still reads 1000 rows says the export is clean. */
  return parse({ input: readFileSync(CSV, 'utf8'), delimiter: ',' }, {}) as Record<string, string>[];
};

/** This bank's real header — `Withdrawls` misspelled in the export, which is exactly why
 *  the mapping is declared by the owner rather than inferred. */
const SPEC = {
  columns: [
    { column: 'Date', field: 'posted_on' },
    { column: 'Description', field: 'description' },
    { column: 'Deposits', field: 'credit' },
    { column: 'Withdrawls', field: 'debit' },
    { column: 'Balance', field: 'balance_after' },
  ],
  dedup_on: ['posted_on', 'description', 'credit', 'debit'],
  scope: 'bt-current',
  thousands_separator: ',',
  numeric_fields: ['credit', 'debit', 'balance_after'],
  defaults: { counterparty: '', category: '', currency: 'INR' },
} as const;

describe('planCsvImport — against a real bank export', () => {
  maybe('⛔⛔ reads every row, parses separated amounts, flags nothing', () => {
    const plan = planCsvImport(csvRows(), SPEC);
    expect(plan.rows_read).toBe(1000);
    /** ⛔ The recipe version silently produced 663 zeros here. An unparsed cell is now
     *  reported with a line number, so an EMPTY `unparsed` genuinely means clean. */
    expect(plan.unparsed, JSON.stringify(plan.unparsed.slice(0, 3))).toEqual([]);
    expect(plan.rows).toHaveLength(1000);

    /** ⛔⛔ THE MONEY, computed from the planned values against an INDEPENDENT sum of the
     *  file. Comparing the planner to itself is how a wrong planner certifies itself. */
    const raw = (s: string): number => Number((s ?? '').replaceAll(',', '').trim() || 0);
    const source = csvRows();
    const expected = source.reduce((n, r) => n + raw(r.Deposits!) - raw(r.Withdrawls!), 0);
    const net = plan.rows.reduce(
      (n, r) => n + Number(r.values.credit ?? 0) - Number(r.values.debit ?? 0), 0);
    expect(net).toBeCloseTo(expected, 2);
    expect(net).toBeCloseTo(151_193.70, 2);
  });

  maybe('⛔⛔ every declared field is present — a records create requires all of them', () => {
    /** The defect that rejected all 1000 rows in the drive: the entity declared
     *  `counterparty` / `category`, the CSV never carried them, and `create` refuses a
     *  missing declared field. `defaults` is the only place that can be answered. */
    const { values } = planCsvImport(csvRows(), SPEC).rows[0]!;
    for (const field of ['posted_on', 'description', 'credit', 'debit', 'balance_after',
      'counterparty', 'category', 'currency']) {
      expect(Object.hasOwn(values, field), `missing declared field '${field}'`).toBe(true);
    }
    expect(values.credit).toBe(3391.02);
    expect(values.counterparty).toBe('');
  });

  maybe('⛔⛔⛔ ids are STABLE across runs and account-scoped', () => {
    /** Stability is what makes a re-import a no-op instead of a doubling; scope is what
     *  keeps two accounts holding the same transaction from cancelling each other out. */
    const a = planCsvImport(csvRows(), SPEC);
    const b = planCsvImport(csvRows(), SPEC);
    expect(b.rows.map((r) => r.id)).toEqual(a.rows.map((r) => r.id));

    const other = planCsvImport(csvRows(), { ...SPEC, scope: 'bt-savings' });
    expect(new Set(other.rows.map((r) => r.id)).size).toBe(1000);
    const overlap = new Set(a.rows.map((r) => r.id));
    expect(other.rows.some((r) => overlap.has(r.id)),
      'a different account must not collide with the first').toBe(false);
  });

  it('⛔⛔ an unparseable cell becomes NULL and the row still IMPORTS — never 0', () => {
    /** THE DEFECT THIS FILE EXISTS FOR. The recipe version coerced `"3,391.02"` to null,
     *  then `null - 0` made it a legitimate-looking ZERO no downstream null-check could
     *  catch. Null is the honest answer: absent, not "a transaction for nothing".
     *  ⚠ AND THE ROW LANDS. An earlier version REJECTED it, which is the same silent data
     *  loss pointed the other way — the owner cannot reconcile against their statement
     *  when the row count does not match. Import imports; `unparsed` tells them where to
     *  look, with a line number that matches the file. */
    const plan = planCsvImport(
      [{ Date: '01-Jan-2020', Description: 'ok', Deposits: '10.00', Withdrawls: '0', Balance: '10' },
        { Date: '02-Jan-2020', Description: 'bad', Deposits: 'N/A', Withdrawls: '0', Balance: '10' }],
      SPEC,
    );
    expect(plan.rows, 'every row imports').toHaveLength(2);
    expect(plan.rows[1]!.values.credit, 'null, not zero').toBeNull();
    expect(plan.unparsed).toHaveLength(1);
    expect(plan.unparsed[0]!.line, 'header + 1-based, so it matches the file').toBe(3);
    expect(plan.unparsed[0]!.column).toBe('Deposits');
    /** ⚠ An EMPTY cell is not an unparsed one — a blank debit column is normal, and
     *  flagging it would bury the real signal in noise. */
    expect(plan.rows[0]!.values.debit).toBe(0);
    expect(plan.unparsed.some((u) => u.line === 2)).toBe(false);
  });

  it('⛔⛔ two IDENTICAL lines both import, and re-importing is still idempotent', () => {
    /** Two identical £3 coffees on one day are BOTH REAL. An earlier version refused the
     *  second as a duplicate and deleted a transaction. The id carries which occurrence
     *  it is, so they stay distinct — and because the same file walks the same rows in
     *  the same order, a re-import reproduces the same two ids rather than adding more. */
    const row = { Date: '01-Jan-2020', Description: 'coffee', Deposits: '0', Withdrawls: '3.00', Balance: '7' };
    const first = planCsvImport([row, { ...row }], SPEC);
    expect(first.rows, 'both real transactions must land').toHaveLength(2);
    expect(first.rows[0]!.id).not.toBe(first.rows[1]!.id);

    const again = planCsvImport([row, { ...row }], SPEC);
    expect(again.rows.map((r) => r.id), 're-import must reproduce the same ids')
      .toEqual(first.rows.map((r) => r.id));
  });

  it('⚠ a row with a blank identity still imports, rather than being judged unfit', () => {
    /** It is the owner's file and the owner's call. Two blank rows stay two rows via the
     *  occurrence counter instead of collapsing onto one id, which would have landed a
     *  single row for the whole file and looked like a working import. */
    const blank = { Date: '', Description: '', Deposits: '', Withdrawls: '', Balance: '' };
    const plan = planCsvImport([blank, { ...blank }], SPEC);
    expect(plan.rows).toHaveLength(2);
    expect(plan.rows[0]!.id).not.toBe(plan.rows[1]!.id);
  });
});
