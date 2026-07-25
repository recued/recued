import { describe, it, expect } from 'vitest';
import { interpolationText, resolveValue } from '../resolve.js';
import type { NamespaceStores } from '../resolve.js';

const stores: NamespaceStores = {
  vault: {},
  config: { dynamic_key: 'ctx', count: 12 },
  context: {},
  meta: {},
  step: {
    ctx: { a: 1 },
    scalar_array: [1, 2],
    count: 12,
  },
  data: {
    shared: {
      ctx: { a: 1 },
    },
  },
};

describe('interpolationText', () => {
  it('renders text-position values without object garbling', () => {
    const cases: Array<[unknown, string]> = [
      ['hello', 'hello'],
      [42, '42'],
      [false, 'false'],
      [null, ''],
      [undefined, ''],
      [[], ''],
      [[1, 2], '1,2'],
      [['a', null, 'b'], 'a,,b'],
      [[{ a: 1 }], '[{"a":1}]'],
      [{ a: 1 }, '{"a":1}'],
      [[[1, 2], [3]], '[[1,2],[3]]'],
      [{}, '{}'],
    ];

    for (const [value, expected] of cases) {
      expect(interpolationText(value)).toBe(expected);
    }
  });
});

describe('resolveValue structured interpolation', () => {
  it('embeds object refs as compact JSON in interpolated text', () => {
    expect(resolveValue('Deal: {{step.ctx}}', stores)).toBe('Deal: {"a":1}');
  });

  it('keeps pure object refs type-preserved', () => {
    expect(resolveValue('{{step.ctx}}', stores)).toEqual({ a: 1 });
  });

  it('keeps scalar-only arrays on the legacy comma join in text', () => {
    expect(resolveValue('Ids: {{step.scalar_array}}', stores)).toBe('Ids: 1,2');
  });

  it('uses compact JSON when a scalar hint falls through on an object', () => {
    expect(resolveValue('Hint: {{step.ctx:number}}', stores)).toBe('Hint: {"a":1}');
  });

  it('keeps scalar number hints unchanged', () => {
    expect(resolveValue('Count: {{step.count:number}}', stores)).toBe('Count: 12');
  });

  it('matches nested dynamic-key object interpolation with main interpolation', () => {
    expect(resolveValue('Main: {{step.ctx}}', stores)).toBe('Main: {"a":1}');
    expect(resolveValue('Main: {{data.shared.{{config.dynamic_key}}}}', stores)).toBe('Main: {"a":1}');
  });
});
