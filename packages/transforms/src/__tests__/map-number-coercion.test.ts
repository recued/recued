import { describe, expect, it } from 'vitest';
import { getTransform } from '../index.js';
import { ctx } from './helpers.js';

const c = ctx();

const mapTransform = () => {
  const fn = getTransform('map');
  if (!fn) throw new Error('map transform is not registered');
  return fn;
};

describe('map expression number coercion', () => {
  it('coerces only exact {{item.path | number}} refs and preserves invalid values as null', () => {
    const items = [
      { value: '30000', name: 'numeric string' },
      { value: '1e-7', name: 'exponent' },
      { value: '12.75', name: 'decimal' },
      { value: '-42', name: 'negative' },
      { value: 99, name: 101 },
      { value: '', name: 'empty' },
      { value: null, name: 'null' },
      { name: 'missing' },
      { value: 'abc', name: 'invalid' },
      { value: 'Infinity', name: 'infinite' },
      { value: 'NaN', name: 'nan' },
    ];

    const result = mapTransform()(
      {
        array: items,
        expression: {
          v: '{{item.value | number}}',
          name: '{{item.name}}',
        },
      },
      c,
    ) as Array<{ v: unknown; name: unknown }>;

    expect(result.map((row) => row.v)).toEqual([
      30000,
      1e-7,
      12.75,
      -42,
      99,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(result[1].v).toBe(1e-7);
    expect(result[0].name).toBe('numeric string');
    expect(typeof result[0].name).toBe('string');
    expect(result[4].name).toBe(101);
    expect(typeof result[4].name).toBe('number');
  });

  it('coerces nested dotted paths and flat capitalized paths', () => {
    const result = mapTransform()(
      {
        array: [
          {
            properties: { amount: '30000' },
            Amount: '12000',
          },
        ],
        expression: {
          nested: '{{item.properties.amount | number}}',
          flat: '{{item.Amount | number}}',
        },
      },
      c,
    ) as Array<{ nested: unknown; flat: unknown }>;

    expect(result).toEqual([{ nested: 30000, flat: 12000 }]);
  });

  it('does not coerce the number-filter form when it is embedded in surrounding text', () => {
    const result = mapTransform()(
      {
        array: [{ value: '30000' }],
        expression: 'amount={{item.value | number}}',
      },
      c,
    ) as string[];

    expect(result).toEqual(['amount={{item.value | number}}']);
  });
});
