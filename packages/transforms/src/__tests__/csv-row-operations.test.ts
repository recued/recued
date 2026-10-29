import { describe, expect, it } from 'vitest';
import { CSV_TOOLKIT_LIMITS, parseCsvTransformInput, type CsvExpression } from '@recued/contracts';
import { operateCsvTable, parseCsvTable, serializeCsvTable } from '../csv-toolkit.js';
const run = (csv: string, args: Record<string, unknown>) => operateCsvTable(parseCsvTable(csv, ','),
  parseCsvTransformInput({ source: 'file:one', ...args }));
const col = (column: string) => ({ column });
const value = (value: string) => ({ value });

describe('mapping CSV columns', () => {
  it('stops expansion at the encoded file limit before evaluating later rows', () => {
    // Quotes and UTF-8 both expand the serialized size beyond the JS string length.
    const cell = 'é"'.repeat(2048), encodedRowBytes = Buffer.byteLength('1,"' + cell.replaceAll('"', '""') + '1"\n');
    const input = parseCsvTransformInput({ source: 'file:one', operation: 'map', mappings: [
      { as: 'note', expression: { op: 'concat', values: [value(cell), col('id')], separator: '' } },
    ] });
    const count = Math.floor((CSV_TOOLKIT_LIMITS.bytes - Buffer.byteLength('id,note\n')) / encodedRowBytes);
    const table = { columns: ['id'], rows: Array.from({ length: count }, () => ['1']) };
    expect(Buffer.byteLength(serializeCsvTable(operateCsvTable(table, input).table))).toBeLessThanOrEqual(CSV_TOOLKIT_LIMITS.bytes);
    const later = ['1']; Object.defineProperty(later, '0', { get: () => { throw new Error('evaluated beyond the file limit'); } });
    table.rows.push(['1'], later);
    expect(() => operateCsvTable(table, input)).toThrow(/output exceeds the 32 MiB file limit/);
  });
  it('cleans text, performs exact arithmetic and reads every mapping from the original row', () => {
    const out = run('id,email,qty,price,status\n001, ADA@EXAMPLE.TEST ,3,0.10,pending\n', { operation: 'map', mappings: [
      { as: 'email', expression: { op: 'lower', input: { op: 'trim', input: col('email') } } },
      { as: 'original', expression: col('email') },
      { as: 'total', expression: { op: 'multiply', left: col('qty'), right: col('price') } },
      { as: 'balance', expression: { op: 'subtract', left: { op: 'add', left: value('9007199254740993'), right: value('0.2') }, right: value('0.1') } },
      { as: 'status', expression: { op: 'replace', input: col('status'), from: 'pending', to: 'open' } },
      { as: 'label', expression: { op: 'concat', values: [col('id'), { op: 'upper', input: col('status') }], separator: ':' } },
    ] });
    expect(out.table.rows).toEqual([['001', 'ada@example.test', '3', '0.10', 'open', ' ADA@EXAMPLE.TEST ', '0.3', '9007199254740993.1', '001:PENDING']]);
    expect(parseCsvTable(serializeCsvTable(out.table), ',')).toEqual(out.table);
  });
  it('rounds division half away from zero for either divisor sign and refuses zero and overflow', () => {
    const args = { operation: 'map', mappings: [{ as: 'n', expression: { op: 'divide', left: col('a'), right: col('b'), scale: 0 } }] };
    expect(run('a,b\n-3,2\n3,-2\n-3,-2\n', args).table.rows.map(r => r[2])).toEqual(['-2', '-2', '2']);
    expect(() => run('a,b\n1,2\n1,0\n', args)).toThrow(/data row 2.*division by zero/);
    expect(() => run('a,b\n99999999999999999999999999999999999999,10\n', { operation: 'map',
      mappings: [{ as: 'n', expression: { op: 'multiply', left: col('a'), right: col('b') } }] })).toThrow(/38 digits/);
  });
  it('propagates blanks only explicitly and cannot hide a malformed other operand', () => {
    const args = { operation: 'map', mappings: [{ as: 'n', expression: { op: 'add', left: col('a'), right: col('b') } }] };
    expect(() => run('a,b\n,2\n', args)).toThrow(/plain decimal/);
    expect(run('a,b\n,2\n', { ...args, empty_numeric: 'blank' }).table.rows).toEqual([['', '2', '']]);
    expect(() => run('a,b\n,bad\n', { ...args, empty_numeric: 'blank' })).toThrow(/plain decimal/);
  });
  it('rejects malformed/deep expressions, duplicate targets and missing columns even on empty tables', () => {
    let deep: CsvExpression = col('id');
    for (let i = 0; i < 9; i++) deep = { op: 'trim', input: deep };
    for (const expression of [deep, { column: 'id', value: 'injected' }, { op: 'eval', code: '1' }, { value: '\ud800' }]) {
      expect(() => run('id\n', { operation: 'map', mappings: [{ as: 'x', expression }] })).toThrow();
    }
    expect(() => run('id\n', { operation: 'map', mappings: [{ as: 'x', expression: col('missing') }] })).toThrow(/does not exist/);
    expect(() => run('id\n', { operation: 'map', mappings: ['a', 'b'].map(() => ({ as: 'x', expression: col('id') })) })).toThrow(/duplicate/);
    expect(() => run('id\n' + 'x'.repeat(150000), { operation: 'map', mappings: [
      { as: 'x', expression: { op: 'concat', values: [col('id'), col('id')] } },
    ] })).toThrow(/character limit/);
  });
});

describe('sorting and deduplicating CSV rows', () => {
  it('sorts composite keys, preserves ties and keeps blanks last even descending, before slicing', () => {
    const csv = 'id,g,n\n001,a,10\n002,a,2\n003,a,2.0\n004,b,9007199254740993\n005,a,\n';
    const args = { operation: 'sort', by: [{ column: 'g' }, { column: 'n', comparison: 'decimal', direction: 'desc' }] };
    expect(run(csv, args).table.rows.map(r => r[0])).toEqual(['001', '002', '003', '005', '004']);
    expect(run(csv, { ...args, offset: 1, limit: 2 }).table.rows.map(r => r[0])).toEqual(['002', '003']);
    expect(run('n\n2\n10\n', { operation: 'sort', by: [{ column: 'n' }] }).table.rows).toEqual([['10'], ['2']]);
    expect(run('n\n2\n""\n1\n', { operation: 'sort', by: [{ column: 'n', empty: 'first' }] }).table.rows).toEqual([[''], ['1'], ['2']]);
  });
  it('validates excluded rows and blank/unknown keys rather than hiding them with a limit', () => {
    const args = { operation: 'sort', by: [{ column: 'n', comparison: 'decimal' }], limit: 0 };
    expect(() => run('n\n2\nbad\n', args)).toThrow(/plain decimal/);
    expect(() => run('n\n""\n', { ...args, by: [{ column: 'n', empty: 'error' }] })).toThrow(/empty sort/);
    expect(() => run('n\n', { ...args, by: [{ column: 'missing' }] })).toThrow(/does not exist/);
    expect(() => run('n\n', { ...args, offset: -1 })).toThrow(/whole number/);
  });
  it('removes exact whole-row duplicates and refuses conflicting keyed rows until first/last is explicit', () => {
    expect(run('id,note\n001,\n001,\n1,x\n', { operation: 'deduplicate' }).table.rows).toEqual([['001', ''], ['1', 'x']]);
    const csv = 'id,note\n001,old\n1,other\n001,new\n';
    expect(() => run(csv, { operation: 'deduplicate', keys: ['id'] })).toThrow(/conflicting rows/);
    expect(run(csv, { operation: 'deduplicate', keys: ['id'], keep: 'first' }).table.rows).toEqual([['001', 'old'], ['1', 'other']]);
    const last = run(csv, { operation: 'deduplicate', keys: ['id'], keep: 'last' });
    expect(last.table.rows).toEqual([['1', 'other'], ['001', 'new']]);
    expect(last.counts).toMatchObject({ removed: 1, duplicate_groups: 1, conflict_groups: 1 });
  });
  it('keeps blank composite keys independent unless the caller explicitly matches or rejects them', () => {
    const csv = 'id,g,n\n,a,1\n,a,1\n001,a,1\n001,a,1\n001,b,2\n';
    const args = { operation: 'deduplicate', keys: ['id', 'g'] };
    expect(run(csv, args).table.rows).toHaveLength(4);
    expect(run(csv, { ...args, empty_keys: 'match' }).table.rows).toHaveLength(3);
    expect(() => run(csv, { ...args, empty_keys: 'error' })).toThrow(/empty deduplication key/);
    expect(run('id,g,n\n', args).table.rows).toEqual([]);
  });
});
