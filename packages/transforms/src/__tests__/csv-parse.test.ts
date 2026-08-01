/** `csv_parse` — string in, STRINGS out.
 *
 *  Written adversarially on purpose. A CSV parser that is 95% right is worse
 *  than none: it works for every tenant until the one whose note contains a
 *  comma, and then it silently shifts every column after it. Each case here is
 *  a shape a real bank or spreadsheet export produces.
 */
import { describe, expect, it } from 'vitest';
import { csv_parse } from '../object.js';

const parse = (input: unknown, params: Record<string, unknown> = {}) =>
  csv_parse({ input, ...params }, {} as never);

describe('csv_parse — the deterministic RFC 4180 half', () => {
  it('parses a plain file with a header', () => {
    expect(parse('contract_id,amount\nrc_1,1200.00\nrc_2,850.50')).toEqual([
      { contract_id: 'rc_1', amount: '1200.00' },
      { contract_id: 'rc_2', amount: '850.50' },
    ]);
  });

  it('keeps a quoted field that CONTAINS the delimiter', () => {
    // The case that silently shifts every later column when a parser gets it
    // wrong — and the one a rent note produces constantly.
    expect(parse('id,note,amount\nrc_1,"paid late, partial",600.00')).toEqual([
      { id: 'rc_1', note: 'paid late, partial', amount: '600.00' },
    ]);
  });

  it('keeps a quoted field that contains a NEWLINE', () => {
    expect(parse('id,note\nrc_1,"line one\nline two"')).toEqual([
      { id: 'rc_1', note: 'line one\nline two' },
    ]);
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(parse('id,note\nrc_1,"she said ""paid"" today"')).toEqual([
      { id: 'rc_1', note: 'she said "paid" today' },
    ]);
  });

  it('handles CRLF line endings', () => {
    // Every Windows-authored spreadsheet. A parser that splits on \n alone
    // leaves a trailing \r on the LAST cell of every row.
    // ⚠ The CR lookahead itself is an EQUIVALENT mutant — removing it ends the
    // row twice and the empty-row guard eats the second. This asserts the
    // OUTCOME, which is what matters; it does not pin that one branch.
    expect(parse('id,amount\r\nrc_1,100\r\nrc_2,200')).toEqual([
      { id: 'rc_1', amount: '100' },
      { id: 'rc_2', amount: '200' },
    ]);
  });

  it('strips a leading BOM', () => {
    // Excel writes one. Left in place it becomes part of the FIRST header key,
    // so that column never matches and the failure looks like a typo.
    const rows = parse('﻿id,amount\nrc_1,100') as Record<string, string>[];
    expect(Object.keys(rows[0] ?? {})).toEqual(['id', 'amount']);
  });

  it('does not emit a phantom row for a trailing newline OR a blank line', () => {
    expect(parse('id,amount\nrc_1,100\n')).toHaveLength(1);
    expect(parse('id,amount\nrc_1,100\r\n')).toHaveLength(1);
    // ⚠ The trailing-newline cases alone did NOT reach the empty-row guard —
    // mutation-proved: deleting it left them green. A BLANK LINE does reach it,
    // and files with one between sections are ordinary.
    expect(parse('id,amount\nrc_1,100\n\nrc_2,200')).toEqual([
      { id: 'rc_1', amount: '100' },
      { id: 'rc_2', amount: '200' },
    ]);
  });

  it('keeps empty cells as empty strings, not as missing keys', () => {
    expect(parse('id,note,amount\nrc_1,,100')).toEqual([
      { id: 'rc_1', note: '', amount: '100' },
    ]);
  });
});

describe('csv_parse — never types a value', () => {
  it('leaves every cell a STRING, whatever it looks like', () => {
    // ⛔ The whole reason this is not a "smart" parser. `1,200.00` and
    // `1.200,00` are the same amount in different locales; guessing turns one
    // of them into 1 on a rent ledger. `to_number` exists; the author decides.
    const rows = parse('a,b,c,d\n1200.00,"1.200,00",0007,true') as Record<string, string>[];
    expect(rows[0]).toEqual({ a: '1200.00', b: '1.200,00', c: '0007', d: 'true' });
    for (const v of Object.values(rows[0]!)) expect(typeof v).toBe('string');
  });

  it('preserves a leading zero, which any numeric coercion would destroy', () => {
    expect((parse('unit\n0042') as Record<string, string>[])[0]?.unit).toBe('0042');
  });
});

describe('csv_parse — what surfaces as an argument', () => {
  it('takes a semicolon delimiter (the European export)', () => {
    expect(parse('id;amount\nrc_1;1.200,00', { delimiter: ';' })).toEqual([
      { id: 'rc_1', amount: '1.200,00' },
    ]);
  });

  it('takes a tab delimiter', () => {
    expect(parse('id\tamount\nrc_1\t100', { delimiter: '\t' })).toEqual([
      { id: 'rc_1', amount: '100' },
    ]);
  });

  it('takes a single-quote quote character', () => {
    expect(parse("id,note\nrc_1,'paid, late'", { quote: "'" })).toEqual([
      { id: 'rc_1', note: 'paid, late' },
    ]);
  });

  it('returns arrays when has_header is false', () => {
    expect(parse('rc_1,100\nrc_2,200', { has_header: false })).toEqual([
      ['rc_1', '100'],
      ['rc_2', '200'],
    ]);
  });

  it('applies each ragged-row policy', () => {
    const short = 'id,note,amount\nrc_1,only-two';
    const long = 'id,amount\nrc_1,100,extra';
    // pad (default) — the missing cell is an empty string, the extra is dropped
    expect(parse(short)).toEqual([{ id: 'rc_1', note: 'only-two', amount: '' }]);
    expect(parse(long)).toEqual([{ id: 'rc_1', amount: '100' }]);
    // skip — the row is omitted entirely
    expect(parse(short, { ragged: 'skip' })).toEqual([]);
    // error — refuses, naming both counts
    expect(() => parse(short, { ragged: 'error' })).toThrow(/2 cells, header has 3/);
  });

  it('ignores a multi-character delimiter or quote rather than misparsing', () => {
    // A malformed parameter must fall back to the default, not split on the
    // first character and shift every column.
    expect(parse('id,amount\nrc_1,100', { delimiter: '||' })).toEqual([
      { id: 'rc_1', amount: '100' },
    ]);
  });
});

describe('csv_parse — fails closed', () => {
  it('returns [] for a non-string or empty input', () => {
    for (const bad of [undefined, null, 42, {}, [], '']) {
      expect(parse(bad), JSON.stringify(bad)).toEqual([]);
    }
  });

  it('returns [] for a header-only file', () => {
    expect(parse('id,amount')).toEqual([]);
    expect(parse('id,amount\n')).toEqual([]);
  });

  it('DROPS a header cell that would pollute the prototype', () => {
    // ⚠ EQUIVALENT MUTANT, recorded so nobody re-derives it: removing the
    // guard changes nothing observable, because `obj['__proto__'] = '<string>'`
    // sets a prototype to a non-object, which JS ignores. The guard is depth
    // against a later edit that makes the values non-strings, not a fix for a
    // reachable hole — so these assertions describe the outcome, and no test
    // here can prove the branch.
    const rows = parse('__proto__,id\nboom,rc_1') as Record<string, string>[];
    expect(Object.keys(rows[0] ?? {})).toEqual(['id']);
    expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
    expect(rows[0]).not.toHaveProperty('boom');
  });

  it('keeps the LAST column when a header name repeats', () => {
    // Documented behaviour rather than a fifth parameter: a file with two
    // `amount` columns is malformed, and this pins which one survives.
    expect(parse('amount,amount\n100,200')).toEqual([{ amount: '200' }]);
  });
});
