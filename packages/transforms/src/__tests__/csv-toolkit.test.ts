import { describe, expect, it } from 'vitest';
import { CSV_TOOLKIT_LIMITS, parseCsvTransformInput, parseCsvInspectInput } from '@recued/contracts';
import { parseCsvTable, serializeCsvTable, operateCsvTable, summarizeCsvTable } from '../csv-toolkit.js';

const run = (csv: string, args: Record<string, unknown>, other?: string) => operateCsvTable(
  parseCsvTable(csv, ','), parseCsvTransformInput({ source: 'file:one', ...(other ? { other_source: 'file:two' } : {}), ...args }),
  other === undefined ? undefined : parseCsvTable(other, ','));

describe('CSV Toolkit parsing and bounded output', () => {
  it('round-trips BOM, CRLF, embedded quotes/newlines, empty cells and literal identifier text', () => {
    const table = parseCsvTable('\ufeffid,note\r\n001,"a,b"\r\n02,"say ""hi""\nnext"\r\n03,\r\n', ',');
    expect(table.rows).toEqual([['001', 'a,b'], ['02', 'say "hi"\nnext'], ['03', '']]);
    expect(parseCsvTable(serializeCsvTable(table), ',')).toEqual(table);
    expect(parseCsvTable('value\n""\n""', ',').rows).toEqual([[''], ['']]);
    expect(parseCsvTable(serializeCsvTable({ columns: ['value'], rows: [['']] }), ',').rows).toEqual([['']]);
    expect(parseCsvTable('a;b\n1;2\n', ';').rows).toEqual([['1', '2']]);
  });
  it('preserves a literal leading BOM inside the first column name across UTF-8 output', () => {
    const table = parseCsvTable('"\ufeffid",💼\n001,Ω\n', ',');
    expect(table.columns).toEqual(['\ufeffid', '💼']);
    const persisted = new TextEncoder().encode(serializeCsvTable(table));
    expect(parseCsvTable(new TextDecoder().decode(persisted), ',')).toEqual(table);
  });
  it.each(['a,a\n1,2', 'a,\n1,2', 'a,b\n1', 'a\n"unterminated', 'a\n"x"tail', 'a\nx"y', '', 'a\n\0'])('rejects ambiguous CSV %j', csv => {
    expect(() => parseCsvTable(csv, ',')).toThrow();
  });
  it('retains header-only files and never presents a truncated cell as a complete preview', () => {
    expect(parseCsvTable('a,b\n', ',').rows).toEqual([]);
    const table = { columns: ['value'], rows: [['x'.repeat(16001)], ['small']] };
    expect(summarizeCsvTable(table)).toMatchObject({ rows: 2, preview: [], preview_truncated: true });
  });
  it('bounds parser cell allocation and serialized bytes', () => {
    expect(() => parseCsvTable('a\n' + 'x'.repeat(CSV_TOOLKIT_LIMITS.cell_chars + 1), ',')).toThrow(/limit/i);
    const row = ['x'.repeat(262144)];
    expect(() => serializeCsvTable({ columns: ['a'], rows: Array.from({ length: 129 }, () => row) })).toThrow(/32 MiB/);
  });
  it('refuses unknown arguments and temporary refs before any operation', () => {
    expect(() => parseCsvInspectInput({ source: { kind: 'temp' } })).toThrow();
    expect(() => parseCsvTransformInput({ source: 'file:one', operation: 'project', columns: ['a'], run_id: 'forged' })).toThrow(/unknown argument/);
    expect(() => parseCsvTransformInput({ source: 'file:one', operation: 'filter', conditions: [{ column: 'a', operator: 'eq', value: 1 }] })).toThrow(/value must be text/);
  });
});

describe('CSV Toolkit operations', () => {
  it('filters text literally and decimals exactly, with explicit all/any predicates', () => {
    const csv = 'id,amount\n001,0.10\n1,0.2\n2,9007199254740993\n';
    expect(run(csv, { operation: 'filter', conditions: [{ column: 'id', operator: 'eq', value: '1' }] }).table.rows).toEqual([['1', '0.2']]);
    expect(run(csv, { operation: 'filter', conditions: [{ column: 'amount', operator: 'gt', value: '9007199254740992', comparison: 'decimal' }] }).table.rows).toEqual([['2', '9007199254740993']]);
    expect(run(csv, { operation: 'filter', match: 'any', conditions: [{ column: 'id', operator: 'eq', value: '001' }, { column: 'amount', operator: 'gt', value: '1', comparison: 'decimal' }] }).counts.matched).toBe(2);
    expect(() => run('id,amount\n1,bad\n', { operation: 'filter', match: 'any', conditions: [{ column: 'id', operator: 'eq', value: '1' }, { column: 'amount', operator: 'gt', value: '1', comparison: 'decimal' }] })).toThrow(/plain decimal/);
    expect(() => run(csv, { operation: 'filter', conditions: [{ column: 'missing', operator: 'empty' }] })).toThrow(/does not exist/);
  });
  it('projects, reorders and renames while preserving literal cells; empty matches stay parseable', () => {
    expect(run('a,b\n001,=literal\n', { operation: 'project', columns: ['b', 'a'], names: ['B', 'A'] }).table).toEqual({ columns: ['B', 'A'], rows: [['=literal', '001']] });
    expect(() => run('a,b\n1,2', { operation: 'project', columns: ['a', 'b'], names: ['same', 'same'] })).toThrow(/duplicate/);
    const out = run('a\n1\n', { operation: 'filter', conditions: [{ column: 'a', operator: 'eq', value: 'absent' }] });
    expect(parseCsvTable(serializeCsvTable(out.table), ',')).toEqual({ columns: ['a'], rows: [] });
  });
  it('concatenates by column name and fills missing cells only with explicit union', () => {
    expect(run('a,b\n1,2', { operation: 'concat' }, 'b,a\n3,4').table.rows).toEqual([['1', '2'], ['4', '3']]);
    expect(() => run('a\n1', { operation: 'concat' }, 'b\n2')).toThrow(/schemas differ/);
    expect(run('a\n1', { operation: 'concat', schema: 'union' }, 'b\n2').table).toEqual({ columns: ['a', 'b'], rows: [['1', ''], ['', '2']] });
  });
  it('joins exact composite keys and handles unmatched/blank keys explicitly', () => {
    const args = { operation: 'join', left_keys: ['id', 'region'], right_keys: ['key', 'area'], join_type: 'full' };
    const out = run('id,region\n001,A\n1,A\n,A\n', args, 'key,area\n001,A\n1,B\n,A\n');
    expect(out.table.rows).toEqual([['001', 'A', '001', 'A'], ['1', 'A', '', ''], ['', 'A', '', ''], ['', '', '1', 'B'], ['', '', '', 'A']]);
    expect(out.counts).toMatchObject({ matched_left: 1, unmatched_left: 2, matched_right: 1, unmatched_right: 2 });
  });
  it('rejects duplicate keys by default, permits all pairs explicitly and bounds expansion', () => {
    const args = { operation: 'join', left_keys: ['id'], right_keys: ['id'] };
    expect(() => run('id\nx\nx\n', args, 'id\nx\n')).toThrow(/duplicate/i);
    expect(run('id\nx\nx\n', { ...args, duplicates: 'all' }, 'id\nx\nx\n').table.rows).toHaveLength(4);
    const many = 'id\n' + 'x\n'.repeat(501);
    expect(() => run(many, { ...args, duplicates: 'all' }, many)).toThrow(/limit/);
  });
  it('reports added, removed, changed and unchanged rows even when column order differs', () => {
    const out = run('id,v\n1,a\n2,b\n4,z', { operation: 'diff', keys: ['id'] }, 'v,id\na,1\nB,2\ny,3');
    expect(out.table.rows).toEqual([['changed', '2', 'b', '2', 'B'], ['removed', '4', 'z', '', ''], ['added', '', '', '3', 'y']]);
    expect(out.counts).toMatchObject({ added: 1, removed: 1, changed: 1, unchanged: 1 });
    expect(() => run('id,v\n,a', { operation: 'diff', keys: ['id'] }, 'id,v\n1,a')).toThrow(/empty/i);
    expect(() => run('id,v\n1,a\n1,b', { operation: 'diff', keys: ['id'] }, 'id,v\n1,a')).toThrow(/duplicate/i);
  });
  it('aggregates decimals without float loss and rounds negative averages half away from zero', () => {
    const out = run('g,v\na,0.1\na,0.2\nb,-1\nb,-2', { operation: 'aggregate', group_by: ['g'], average_scale: 0,
      aggregations: [{ op: 'count', as: 'n' }, { op: 'sum', column: 'v', as: 'sum' }, { op: 'avg', column: 'v', as: 'avg' }, { op: 'min', column: 'v', as: 'min' }, { op: 'max', column: 'v', as: 'max' }] });
    expect(out.table.rows).toEqual([['a', '2', '0.3', '0', '0.1', '0.2'], ['b', '2', '-3', '-2', '-2', '-1']]);
    expect(run('v\n9007199254740993\n1', { operation: 'aggregate', aggregations: [{ op: 'sum', column: 'v', as: 'total' }] }).table.rows).toEqual([['9007199254740994']]);
  });
  it('requires a choice for missing numeric data and distinguishes empty totals from zero', () => {
    const args = { operation: 'aggregate', aggregations: [{ op: 'count', as: 'n' }, { op: 'sum', column: 'v', as: 'total' }] };
    expect(() => run('v\n""\n', args)).toThrow(/plain decimal/);
    const skipped = run('v\n""\n', { ...args, empty_numeric: 'skip' });
    expect(skipped.table.rows).toEqual([['1', '']]);
    expect(skipped.counts.skipped_empty_measure_values).toBe(1);
    expect(run('v\n', args).table.rows).toEqual([['0', '']]);
    expect(run('v\n0\n', args).table.rows).toEqual([['1', '0']]);
  });
});
