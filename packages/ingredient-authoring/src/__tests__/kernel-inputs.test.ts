import { describe, it, expect } from 'vitest';
import { parseCsvInspectInput, parseCsvTransformInput } from '@recued/contracts';
import { kernelArguments } from '../kernel-inputs.js';

describe('shared kernel argument declarations', () => {
  it('keeps CSV required fields and defaults aligned with canonical runtime parsing', () => {
    const examples = [
      { operation: 'filter', conditions: [{ column: 'name', operator: 'eq', value: 'A' }] },
      { operation: 'project', columns: ['name'] },
      { operation: 'concat', other_source: 'file:other' },
      { operation: 'join', other_source: 'file:other', left_keys: ['name'], right_keys: ['name'] },
      { operation: 'diff', other_source: 'file:other', keys: ['name'] },
      { operation: 'aggregate', aggregations: [{ op: 'count', as: 'rows' }] },
    ];
    for (const variant of examples) {
      const input: Record<string, unknown> = { source: 'file:source', ...variant };
      const schema = kernelArguments('core.storage.csv.transform', input)!;
      const parsed = parseCsvTransformInput(input) as unknown as Record<string, unknown>;
      for (const key of Object.keys(input)) {
        const missing = { ...input }; delete missing[key]; let required = false;
        try { parseCsvTransformInput(missing); } catch { required = true; }
        expect(schema.required?.includes(key) ?? false, `${variant.operation}.${key}`).toBe(required);
      }
      for (const [key, field] of Object.entries(schema.properties!)) {
        if (field.default !== undefined) expect(parsed[key], `${variant.operation}.${key}`).toEqual(field.default);
      }
    }
    const inspect = kernelArguments('core.storage.csv.inspect')!, parsed = parseCsvInspectInput({ source: 'file:source' });
    expect(inspect.required).toEqual(['source']); expect(inspect.properties!.preview_rows!.default).toBe(parsed.preview_rows);
    expect(inspect.properties!.delimiter!.default).toBe(parsed.delimiter);
  });
  it('does not guess a union branch or requiredness from null defaults', () => {
    const unspecified = kernelArguments('core.storage.csv.transform', { operation: '{{config.action}}' })!;
    expect(Object.keys(unspecified.properties!)).toEqual(['source', 'delimiter', 'operation']);
    const legacy = kernelArguments('core.kitchen.draft.import')!;
    expect(legacy.required).toBeUndefined(); expect(legacy.properties!.source).toEqual({});
    expect(legacy.properties!.title).toEqual({ type: 'string', default: 'Imported source' });
    expect(kernelArguments('constructor')).toBeUndefined();
  });
});
