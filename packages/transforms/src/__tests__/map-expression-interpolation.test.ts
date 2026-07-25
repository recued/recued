import { describe, it, expect } from 'vitest';
import { map } from '../collection.js';
import { ctx } from './helpers.js';

const c = ctx();

describe('map expression interpolation', () => {
  it('substitutes object, scalar, null, and scalar-array fields in text position', () => {
    const rows = [
      {
        contact: { id: 'c1', email: 'ada@example.com' },
        label: 'vip',
        empty: null,
        tags: [1, 2],
      },
    ];

    const result = map({
      array: rows,
      expression: 'Contact {{item.contact}} {{item.label}} {{item.empty}} tags {{item.tags}}',
    }, c) as string[];

    expect(result).toEqual([
      'Contact {"id":"c1","email":"ada@example.com"} vip  tags 1,2',
    ]);
  });

  it('leaves math expressions numeric', () => {
    const result = map({
      array: [{ amount: 21 }],
      expression: '{{item.amount}} * 2',
    }, c) as number[];

    expect(result).toEqual([42]);
  });

  it('leaves pure refs type-preserved', () => {
    const obj = { a: 1 };
    const result = map({
      array: [{ obj }],
      expression: '{{item.obj}}',
    }, c) as Array<{ a: number }>;

    expect(result).toEqual([obj]);
  });
});
