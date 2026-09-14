import { describe, expect, it } from 'vitest';
import type { RecordsEntitySnapshot, RecordsFieldSnapshot } from '@recued/contracts';
import { parseRecordsViewDraft, recordsViewDraft, recordsFilterOperators, recordsSortFields } from '../records-view-controls.js';

const entity: RecordsEntitySnapshot = { kind: 'job', fields: [
  { key: 'id', kind: 'id', slot: 'pk', required: true },
  { key: 'title', kind: 'string', slot: 's1', required: true },
  { key: 'amount', kind: 'decimal', slot: 'dec1', required: false },
  { key: 'count', kind: 'number', slot: 'n1', required: false },
  { key: 'paid', kind: 'boolean', slot: 'b1', required: false },
  { key: 'due', kind: 'date', slot: 'd1', required: false },
  { key: 'when', kind: 'datetime', slot: 'dt1', required: false },
  { key: 'body', kind: 'text', slot: 't1', required: false },
] };

describe('Records schema-based controls', () => {
  it('exposes only supported field operators and ordered sort fields', () => {
    const operators = (kind: RecordsFieldSnapshot['kind']) => recordsFilterOperators(entity.fields.find(field => field.kind === kind)!);
    expect(operators('id')).toEqual([]);
    expect(operators('text')).toEqual(['is_null', 'is_not_null']);
    expect(operators('boolean')).not.toContain('lt');
    expect(operators('string')).toContain('prefix');
    expect(recordsSortFields(entity).map(field => field.key)).toEqual(['id', '_record.created_at', '_record.updated_at', 'amount', 'count', 'paid', 'due', 'when']);
  });
  it('retains decimal precision, false, zero, empty strings and lists through a saved-view roundtrip', () => {
    const view = parseRecordsViewDraft({ sort: '-amount', filters: [
      { field: 'amount', op: 'gte', value: '900719925.1234' },
      { field: 'count', op: 'eq', value: '0' },
      { field: 'paid', op: 'eq', value: 'false' },
      { field: 'title', op: 'in', value: '["", "<Open>", null]' },
      { field: 'body', op: 'is_not_null', value: '' },
    ] }, entity);
    expect(view).toMatchObject({ filters: { amount: { value: '900719925.1234' }, count: { value: 0 }, paid: { value: false }, body: { op: 'is_null', value: false } } });
    expect(parseRecordsViewDraft(recordsViewDraft(view), entity)).toEqual(view);
  });
  it.each([
    ['count', 'eq', ''], ['count', 'eq', 'Infinity'], ['count', 'eq', '9007199254740993'],
    ['paid', 'eq', ''], ['due', 'eq', '2026-02-30'], ['when', 'eq', '2026-09-11T09:00'],
    ['body', 'eq', 'text'], ['title', 'gte', 'a'], ['removed', 'eq', 'x'], ['title', 'in', '[]'],
  ])('rejects invalid %s %s %s without broadening the query', (field, op, value) => {
    expect(() => parseRecordsViewDraft({ sort: 'id', filters: [{ field, op, value }] }, entity)).toThrow();
  });
  it('rejects duplicate filters and missing or unsupported sort fields', () => {
    expect(() => parseRecordsViewDraft({ sort: 'id', filters: Array(2).fill({ field: 'count', op: 'eq', value: '0' }) }, entity)).toThrow(/one filter/);
    for (const sort of ['title', 'body', 'removed', '--count']) expect(() => parseRecordsViewDraft({ sort, filters: [] }, entity)).toThrow();
  });
});
