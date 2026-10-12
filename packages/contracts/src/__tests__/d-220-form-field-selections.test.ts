import { describe, expect, it } from 'vitest';
import { collectFormValueRefs, collectWholeFormRecordRefs } from '../index.js';

const get = { id: 'accepted', op: 'core.data.form-response.get', args: { submission_id: 's' } };
const list = { id: 'pending', op: 'core.data.form-response.list', args: { endpoint_id: 'door' } };
const csv = (columns: unknown, extra: unknown[] = []) => ({ steps: [list, {
  id: 'csv', transform: 'to_csv', array: '{{step.pending.records}}', columns,
}, ...extra] });
const pick = (fields: unknown, source = '{{step.accepted.record.values}}', extra: unknown[] = []) => ({
  steps: [get, { id: 'picked', transform: 'pick', source, fields }, ...extra],
});

describe('explicit form answer selections', () => {
  it.each([
    ['values.full_name', 'values.address.city'],
    [{ field: 'values.full_name', label: 'Name' }, { field: 'values.address.city', label: 'City' }],
    [null, {}, { field: '' }, 'values.full_name', { field: 'values.address.city' }],
  ].map((columns) => [columns]))('counts usable CSV paths as named answer reads: %j', (columns) => {
    const value = csv(columns);
    expect(collectFormValueRefs(value)).toEqual(['full_name', 'address']);
    expect(collectWholeFormRecordRefs(value)).toEqual([]);
  });

  it.each([undefined, null, [], [null, {}, { field: '' }]].map((columns) => [columns]))('keeps automatic CSV columns unbounded: %j', (columns) => {
    expect(collectWholeFormRecordRefs(csv(columns))).toEqual(['{{step.pending.records}}']);
  });

  it.each(['values', ''])('distinguishes a whole answer cell from an empty string column: %j', (field) => {
    expect(collectWholeFormRecordRefs(csv([field]))).toEqual(field === 'values' ? ['csv.columns.0 (values)'] : []);
  });

  it.each(['{{config.columns}}', ['{{config.field}}'], [{ field: '{{config.field}}' }, 'values.full_name']].map((columns) => [columns]))(
    'does not assume configurable CSV columns are bounded: %j', (columns) => {
      expect(collectWholeFormRecordRefs(csv(columns))).toContain('{{step.pending.records}}');
    },
  );

  it('checks CSV labels and interpolation independently of column selection', () => {
    const value = csv([{ field: 'values.full_name', label: '{{step.accepted.record.values}}' }]);
    value.steps.unshift(get);
    expect(collectFormValueRefs(value)).toEqual(['full_name']);
    expect(collectWholeFormRecordRefs(value)).toEqual(['{{step.accepted.record.values}}']);
    const embedded = { steps: [list, { id: 'csv', transform: 'to_csv', array: 'Rows: {{step.pending.records}}', columns: ['values.full_name'] }] };
    expect(collectWholeFormRecordRefs(embedded)).toContain('{{step.pending.records}}');
  });

  it('allows metadata CSV columns without declaring visitor answers', () => {
    const value = csv(['_id', 'submission_id', 'visitor.email']);
    expect(collectFormValueRefs(value)).toEqual([]);
    expect(collectWholeFormRecordRefs(value)).toEqual([]);
  });

  it('traces nested array field paths with the runtime numeric index grammar', () => {
    for (const index of ['0', '+0', '0e0', '']) {
      const value = { steps: [list,
        { id: 'groups', transform: 'default', value: [{ children: '{{step.pending.records}}' }], fallback: [] },
        { id: 'csv', transform: 'to_csv', array: '{{step.groups}}', columns: [`children.${index}.values.full_name`] },
      ] };
      expect(collectFormValueRefs(value)).toEqual(['full_name']);
      expect(collectWholeFormRecordRefs(value)).toEqual([]);
      value.steps[2] = { id: 'csv', transform: 'to_csv', array: '{{step.groups}}', columns: [`children.${index}.values`] };
      expect(collectWholeFormRecordRefs(value)).toHaveLength(1);
    }
  });

  it('counts shallow picks of named answers and permits their later serialization', () => {
    const value = pick(['full_name', 'address'], undefined, [{ id: 'body', transform: 'json_stringify', input: '{{step.picked}}' }]);
    expect(collectFormValueRefs(value)).toEqual(['full_name', 'address']);
    expect(collectWholeFormRecordRefs(value)).toEqual([]);
  });

  it('treats whitespace outside a pick source ref as serialization', () => {
    const value = pick(['full_name'], ' {{step.accepted.record.values}} ');
    expect(collectWholeFormRecordRefs(value)).toEqual(['{{step.accepted.record.values}}']);
  });

  it('does not interpret a pick key as a dotted path', () => {
    const value = pick(['values.full_name'], '{{step.accepted.record}}');
    expect(collectFormValueRefs(value)).toEqual([]);
    expect(collectWholeFormRecordRefs(value)).toEqual([]);
  });

  it('keeps dotted own keys that contain unrestricted answers', () => {
    const value = { steps: [get,
      { id: 'wrapper', transform: 'defaults', fields: { 'answers.values': { value: '{{step.accepted.record.values}}', fallback: {} } } },
      { id: 'picked', transform: 'pick', source: '{{step.wrapper}}', fields: ['answers.values'] },
      { id: 'body', transform: 'json_stringify', input: '{{step.picked}}' },
    ] };
    expect(collectWholeFormRecordRefs(value)).toEqual(['picked.fields.0 (answers.values)', '{{step.picked}}']);
  });

  it.each([undefined, null, '{{config.fields}}', ['{{config.field}}'], ['full_name', { field: 'private_note' }]].map((fields) => [fields]))(
    'keeps omitted or unresolved picks unbounded: %j', (fields) => {
      const value = pick(fields, undefined, [{ id: 'body', transform: 'json_stringify', input: '{{step.picked}}' }]);
      expect(collectWholeFormRecordRefs(value)).toEqual(['{{step.accepted.record.values}}', '{{step.picked}}']);
    },
  );

  it('permits empty or metadata-only picks and drops prototype-sensitive keys', () => {
    for (const fields of [[], ['submission_id'], ['__proto__', 'constructor', 'prototype']]) {
      const value = pick(fields, '{{step.accepted.record}}', [{ id: 'body', transform: 'json_stringify', input: '{{step.picked}}' }]);
      expect(collectFormValueRefs(value)).toEqual([]);
      expect(collectWholeFormRecordRefs(value)).toEqual([]);
    }
  });

  it('retains provenance when a pick selects the full answer container', () => {
    const value = pick(['values'], '{{step.accepted.record}}', [
      { id: 'name', transform: 'default', value: '{{step.picked.values.full_name}}', fallback: '' },
      { id: 'body', transform: 'json_stringify', input: '{{step.picked}}' },
    ]);
    expect(collectFormValueRefs(value)).toEqual(['full_name']);
    expect(collectWholeFormRecordRefs(value)).toEqual(['picked.fields.0 (values)', '{{step.picked}}']);
  });

  it.each(['_id', '_collection'])('retains unrestricted answers in an implicitly preserved %s', (key) => {
    const value = { steps: [get,
      { id: 'wrapper', transform: 'defaults', fields: { [key]: { value: '{{step.accepted.record.values}}', fallback: {} } } },
      { id: 'picked', transform: 'pick', source: '{{step.wrapper}}', fields: [] },
      { id: 'body', transform: 'json_stringify', input: '{{step.picked}}' },
    ] };
    expect(collectWholeFormRecordRefs(value)).toEqual([`picked.source.${key} (preserved field)`, '{{step.picked}}']);
  });

  it('keeps an array passed through by pick unbounded', () => {
    const value = { steps: [list,
      { id: 'picked', transform: 'pick', source: '{{step.pending.records}}', fields: [] },
      { id: 'body', transform: 'json_stringify', input: '{{step.picked}}' },
    ] };
    expect(collectWholeFormRecordRefs(value)).toEqual(['{{step.pending.records}}', '{{step.picked}}']);
  });

  it('reads selections in foreach results while retaining the original item in the envelope', () => {
    const value = { steps: [list,
      { id: 'picked', transform: 'pick', foreach: '{{step.pending.records}}', source: '{{item.values}}', fields: ['full_name'] },
      { id: 'csv', transform: 'to_csv', array: '{{step.picked}}', columns: [{ field: 'result.full_name', label: 'Name' }] },
    ] };
    expect(collectFormValueRefs(value)).toEqual(['full_name']);
    expect(collectWholeFormRecordRefs(value)).toEqual([]);
    const leak = { ...value, steps: [...value.steps, { id: 'body', transform: 'json_stringify', input: '{{step.picked}}' }] };
    expect(collectWholeFormRecordRefs(leak)).toEqual(['{{step.picked}}']);
  });

  it('checks CSV selections against foreach get results and original items', () => {
    const value = { steps: [list,
      { id: 'details', foreach: '{{step.pending.records}}', op: 'core.data.form-response.get', args: { submission_id: '{{item.submission_id}}' } },
      { id: 'csv', transform: 'to_csv', array: '{{step.details}}', columns: ['result.record.values.full_name', 'item.values.note'] },
    ] };
    expect(collectFormValueRefs(value)).toEqual(['full_name', 'note']);
    expect(collectWholeFormRecordRefs(value)).toEqual([]);
  });

  it('keeps ordinary records independent of the form producer in the same recipe', () => {
    const value = { steps: [get,
      { id: 'mail', op: 'core.mail.list', args: {} },
      { id: 'csv', transform: 'to_csv', array: '{{step.mail.records}}' },
      { id: 'picked', transform: 'pick', source: '{{step.mail.records.0}}' },
    ] };
    expect(collectFormValueRefs(value)).toEqual([]);
    expect(collectWholeFormRecordRefs(value)).toEqual([]);
  });
});
