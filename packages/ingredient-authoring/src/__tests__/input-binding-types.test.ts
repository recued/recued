import { describe, expect, it } from 'vitest';
import { checkClosedInputs, type ClosedInputSchema } from '../closed-inputs.js';
import { checkClosedInputBindings, inputBindingCompatibility, inputHintType, plainConfigBinding } from '../input-binding-types.js';

describe('advisory input binding types', () => {
  it('compares only declared primitive families, with explicit optionality and no default inference', () => {
    for (const [expected, type] of [['string', 'text'], ['integer', 'number'], ['number', 'number'], ['boolean', 'boolean']]) {
      expect(inputBindingCompatibility(expected!, { type, label: '', optional: true })).toBe('compatible');
    }
    expect(inputHintType({ label: 'Maybe', type: 'boolean', optional: true })?.optional).toBe(true);
    expect(inputHintType({ label: 'Required', type: 'boolean' })?.optional).toBe(false);
    expect(inputBindingCompatibility('boolean', { label: 'Text', type: 'text', default: true })).toBe('mismatch');
    for (const hint of ['text', true, { default: true }, { type: 'boolean' }, { label: 'x', type: 'boolean', optional: 'yes' },
      { label: 'x', type: 'future-type' }, { label: 'x', type: 'secret' }, { label: 'x', type: 'enum', options: [true] }])
      expect(inputBindingCompatibility('boolean', hint)).toBe('unknown');
    expect(inputBindingCompatibility('file_ref', { label: 'x', type: 'text' })).toBe('unknown');
  });
  it('accepts only canonical whole config roots and defers hints, members, interpolation and other namespaces', () => {
    expect(plainConfigBinding('{{ config.include_closed }}')).toBe('include_closed');
    for (const value of ['{{config.flag.value}}', '{{config.flag:json}}', '{{config.flag}} extra', '{{config.flag}} {{config.other}}',
      '{{step.flag}}', '{{config.a-b}}', '{{config.}}', true, {}]) expect(plainConfigBinding(value)).toBeUndefined();
  });
  it('keeps structured paths and literal deferrals while checking nested and array declaration conflicts without mutation', () => {
    const schema: ClosedInputSchema = { type: 'object', properties: {
      'a.b': { type: 'boolean' }, rows: { type: 'array', items: { type: 'integer', minimum: 1 } },
      message: { type: 'string', pattern: '^x' }, formatted: { type: 'boolean' }, custom: { type: 'boolean' },
    } };
    const values = { 'a.b': '{{config.text}}', rows: ['{{config.count}}', '{{config.text}}'], message: '{{config.text}}',
      formatted: '{{config.text:json}}', custom: '{{config.custom}}' };
    const variables = { text: { type: 'text', label: 'Text' }, count: { type: 'number', label: 'Count' }, custom: { type: 'future', label: 'Custom' } };
    const before = JSON.stringify({ schema, values, variables }), result = checkClosedInputBindings(schema, values, variables);
    expect(result).toEqual({ complete: true, totalFindings: 2, findings: [
      { path: ['a.b'], name: 'text', declared: 'text', expected: 'boolean' },
      { path: ['rows', 1], name: 'text', declared: 'text', expected: 'integer' },
    ] });
    expect(checkClosedInputs(schema, values).deferredValues).toBe(6);
    expect(checkClosedInputs(schema, values).findings).toEqual([]);
    expect(JSON.stringify({ schema, values, variables })).toBe(before);
  });
  it('bounds traversal and findings and leaves unknown schema fields opaque', () => {
    const array: ClosedInputSchema = { type: 'array', items: { type: 'boolean' } };
    const hints = { text: { type: 'text', label: 'Text' } };
    const truncated = checkClosedInputBindings(array, Array(101).fill('{{config.text}}'), hints);
    expect(truncated.complete).toBe(false); expect(truncated.totalFindings).toBe(101); expect(truncated.findings).toHaveLength(100);
    expect(checkClosedInputBindings(array, Array(5001).fill('{{config.unknown}}'), hints).complete).toBe(false);
    expect(checkClosedInputBindings({ type: 'object', properties: {} }, { unknown: ['{{config.text}}'] }, hints).findings).toEqual([]);
  });
  it('accepts readonly explicit builtin schemas and leaves omitted types unknown', () => {
    const schema = { type: 'object', properties: { count: { type: 'integer' }, unknown: { type: undefined, default: 1 }, values: { type: 'array', items: { type: 'boolean' } } } } as const;
    const hints = { text: { type: 'text', label: 'Text' } };
    expect(checkClosedInputBindings(schema, { count: '{{config.text}}', unknown: '{{config.text}}', values: ['{{config.text}}'] }, hints).findings.map(row => row.path))
      .toEqual([['count'], ['values', 0]]);
    expect(inputBindingCompatibility(undefined, hints.text)).toBe('unknown');
  });
});
