import { describe, it, expect } from 'vitest';
import { filter, sort, map, project, reduce, unique, flatten, slice, group_by, to_list, partition } from '../collection.js';
import { getField } from '../evaluate.js';
import { ctx } from './helpers.js';

const c = ctx();
const deals = [
  { name: 'A', stage: 'won', amount: 100 },
  { name: 'B', stage: 'lost', amount: 200 },
  { name: 'C', stage: 'won', amount: 50 },
];

describe('filter', () => {
  it('filters by equality', () => {
    const r = filter({ array: deals, field: 'stage', operator: 'equal', value: 'won' }, c) as unknown[];
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual(deals[0]);
  });
  it('filters by greater', () => {
    const r = filter({ array: deals, field: 'amount', operator: 'greater', value: 100 }, c) as unknown[];
    expect(r).toHaveLength(1);
  });
  it('returns empty for null array', () => expect(filter({ array: null, field: 'x', operator: 'equal' }, c)).toEqual([]));
  it('supports conditions array (AND by default)', () => {
    const r = filter({
      array: deals,
      conditions: [{ field: 'stage', operator: 'equal', value: 'won' }, { field: 'amount', operator: 'greater', value: 50 }],
    }, c) as unknown[];
    expect(r).toHaveLength(1);
    expect((r[0] as { name: string }).name).toBe('A');
  });

  it('conditions with mode=all — explicit AND', () => {
    const r = filter({
      array: deals,
      mode: 'all',
      conditions: [
        { field: 'stage', operator: 'equal', value: 'won' },
        { field: 'amount', operator: 'greater', value: 50 },
      ],
    }, c) as unknown[];
    expect(r).toHaveLength(1);
    expect((r[0] as { name: string }).name).toBe('A');
  });

  it('conditions with mode=any — OR across conditions', () => {
    // won OR amount > 150 → A (won), B (200), C (won)
    const r = filter({
      array: deals,
      mode: 'any',
      conditions: [
        { field: 'stage', operator: 'equal', value: 'won' },
        { field: 'amount', operator: 'greater', value: 150 },
      ],
    }, c) as unknown[];
    expect(r).toHaveLength(3);
  });

  it('conditions with mode=any — only OR matches', () => {
    // Neither condition true for any deal → empty
    const r = filter({
      array: deals,
      mode: 'any',
      conditions: [
        { field: 'stage', operator: 'equal', value: 'negotiating' },
        { field: 'amount', operator: 'greater', value: 1000 },
      ],
    }, c) as unknown[];
    expect(r).toHaveLength(0);
  });

  it('single-condition mode unchanged when mode param present', () => {
    const r = filter({
      array: deals,
      mode: 'any',            // ignored when no conditions array
      field: 'stage',
      operator: 'equal',
      value: 'won',
    }, c) as unknown[];
    expect(r).toHaveLength(2);
  });
});

describe('sort', () => {
  it('sorts ascending', () => {
    const r = sort({ array: deals, fields: [{ field: 'amount', direction: 'asc' }] }, c) as { amount: number }[];
    expect(r[0].amount).toBe(50);
  });
  it('sorts descending', () => {
    const r = sort({ array: deals, fields: [{ field: 'amount', direction: 'desc' }] }, c) as { amount: number }[];
    expect(r[0].amount).toBe(200);
  });
  it('returns empty for null', () => expect(sort({ array: null, fields: [] }, c)).toEqual([]));
});

describe('map', () => {
  it('expression mode — object template', () => {
    const r = map({ array: deals, expression: { n: '{{item.name}}' } }, c) as { n: string }[];
    expect(r).toHaveLength(3);
    expect(r[0].n).toBe('A');
  });

  it('expression mode — single-ref preserves type', () => {
    const r = map({ array: deals, expression: '{{item.amount}}' }, c) as number[];
    expect(r).toEqual([100, 200, 50]);
  });

  it('expression mode — math expression with per-item substitution', () => {
    // Compute amount * 2 for each deal
    const r = map({ array: deals, expression: '{{item.amount}} * 2' }, c) as number[];
    expect(r).toEqual([200, 400, 100]);
  });

  it('expression mode — math with two item fields', () => {
    const dealsWithProb = [
      { amount: 1000, stage_probability: 75 },
      { amount: 2000, stage_probability: 50 },
    ];
    const r = map(
      { array: dealsWithProb, expression: '{{item.amount}} * {{item.stage_probability}} / 100' },
      c,
    ) as number[];
    expect(r).toEqual([750, 1000]);
  });

  it('expression mode — output_field attaches computed value to item', () => {
    const r = map(
      {
        array: deals,
        expression: '{{item.amount}} * 2',
        output_field: 'doubled',
      },
      c,
    ) as Array<{ name: string; amount: number; doubled: number }>;
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ name: 'A', amount: 100, doubled: 200 });
    expect(r[1].doubled).toBe(400);
  });

  it('expression mode — drops prototype-sensitive output_field names', () => {
    const r = map(
      {
        array: deals.slice(0, 1),
        expression: { polluted: true },
        output_field: '__proto__',
      },
      c,
    ) as Array<Record<string, unknown>>;
    expect(r[0].name).toBe('A');
    expect((r[0] as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(r[0], '__proto__')).toBe(false);
  });

  it('expression mode — missing field coerces to 0 in math', () => {
    const items = [{ a: 10 }, {}];
    const r = map({ array: items, expression: '{{item.a}} + 5' }, c) as number[];
    expect(r).toEqual([15, 5]); // 0 + 5 for the second
  });

  it('returns empty for null', () => expect(map({ array: null, expression: {} }, c)).toEqual([]));
});

describe('project', () => {
  it('projects one object through the collection expression evaluator with number coercion', () => {
    const result = project(
      {
        object: {
          properties: {
            dealname: 'Acme',
            amount: '30000',
            closedate: '1700000000000',
          },
        },
        expression: {
          name: '{{item.properties.dealname}}',
          amount: '{{item.properties.amount | number}}',
          key_dates: {
            close_date: '{{item.properties.closedate}}',
          },
        },
      },
      c,
    ) as { name: string; amount: unknown; key_dates: { close_date: string } };

    expect(result).toEqual({
      name: 'Acme',
      amount: 30000,
      key_dates: { close_date: '1700000000000' },
    });
    expect(typeof result.amount).toBe('number');
  });

  it.each([null, undefined, [], 'scalar', 42])('returns null for non-object input: %s', (object) => {
    expect(project({ object, expression: { name: '{{item.name}}' } }, c)).toBeNull();
  });

  it('projects a missing nested field without throwing', () => {
    const result = project(
      {
        object: { properties: { dealname: 'Acme' } },
        expression: { missing: '{{item.properties.missing}}' },
      },
      c,
    ) as Record<string, unknown>;

    expect(result.missing).toBeUndefined();
  });
});

describe('reduce', () => {
  it('sums', () => expect(reduce({ array: deals, field: 'amount', operator: 'sum', initial: 0 }, c)).toBe(350));
  it('counts', () => expect(reduce({ array: deals, field: 'amount', operator: 'count' }, c)).toBe(3));
  it('averages', () => {
    const r = reduce({ array: deals, field: 'amount', operator: 'avg' }, c) as number;
    expect(Math.round(r)).toBe(117);
  });
  it('counts null-prototype items without a field', () => {
    const items = [
      Object.assign(Object.create(null), { amount: 5 }),
      Object.assign(Object.create(null), { amount: 3 }),
    ];
    expect(reduce({ array: items, operator: 'count' }, c)).toBe(2);
  });
  it('sums null-prototype items without a field without throwing', () => {
    const items = [
      Object.assign(Object.create(null), { amount: 5 }),
      Object.assign(Object.create(null), { amount: 3 }),
    ];
    expect(reduce({ array: items, operator: 'sum', initial: 0 }, c)).toBe(0);
  });
  it('averages null-prototype items without a field without throwing', () => {
    const items = [
      Object.assign(Object.create(null), { amount: 5 }),
      Object.assign(Object.create(null), { amount: 3 }),
    ];
    expect(reduce({ array: items, operator: 'avg' }, c)).toBe(0);
  });
  it('sums single-number array values by Number coercion', () => {
    const items = [
      Object.assign(Object.create(null), { v: [5] }),
      Object.assign(Object.create(null), { v: [3] }),
    ];
    expect(reduce({ array: items, field: 'v', operator: 'sum', initial: 0 }, c)).toBe(8);
  });
  it('returns initial for empty', () => expect(reduce({ array: [], field: 'x', operator: 'sum', initial: 0 }, c)).toBe(0));
});

describe('unique', () => {
  it('deduplicates primitives', () => expect(unique({ array: [1, 2, 2, 3] }, c)).toEqual([1, 2, 3]));
  it('deduplicates by field', () => {
    const r = unique({ array: deals, field: 'stage' }, c) as unknown[];
    expect(r).toHaveLength(2);
  });
});

describe('flatten', () => {
  it('flattens one level', () => expect(flatten({ array: [[1, 2], [3]] }, c)).toEqual([1, 2, 3]));
  it('flattens nested with depth', () => expect(flatten({ array: [[[1]], [[2]]], depth: 2 }, c)).toEqual([1, 2]));
});

describe('slice', () => {
  it('slices array', () => expect(slice({ array: [10, 20, 30, 40], start: 1, end: 3 }, c)).toEqual([20, 30]));
  it('returns empty for null', () => expect(slice({ array: null, start: 0, end: 1 }, c)).toEqual([]));
});

describe('group_by', () => {
  it('groups without aggregate', () => {
    const r = group_by({ array: deals, field: 'stage' }, c) as Record<string, unknown[]>;
    expect(r['won']).toHaveLength(2);
    expect(r['lost']).toHaveLength(1);
  });
  it('groups with aggregate', () => {
    const r = group_by({
      array: deals, field: 'stage',
      aggregate: { total: { operator: 'sum', field: 'amount' }, count: { operator: 'count' } },
    }, c) as { stage: string; total: number; count: number }[];
    const won = r.find(x => x.stage === 'won')!;
    expect(won.total).toBe(150);
    expect(won.count).toBe(2);
  });

  it('groups null-prototype items with aggregate count', () => {
    const items = [
      Object.assign(Object.create(null), { stage: 'won' }),
      Object.assign(Object.create(null), { stage: 'lost' }),
      Object.assign(Object.create(null), { stage: 'won' }),
    ];
    const r = group_by({
      array: items,
      field: 'stage',
      aggregate: { count: { operator: 'count' } },
    }, c) as { stage: string; count: number }[];
    const won = r.find(x => x.stage === 'won')!;
    const lost = r.find(x => x.stage === 'lost')!;
    expect(won.count).toBe(2);
    expect(lost.count).toBe(1);
  });

  it('groups by a null-prototype object field value without throwing', () => {
    const key = Object.assign(Object.create(null), { label: 'vip' });
    const items = [
      Object.assign(Object.create(null), { group: key }),
    ];
    const r = group_by({ array: items, field: 'group' }, c) as Record<string, unknown[]>;
    const keys = Object.keys(r);
    expect(keys).toEqual(['[object]']);
    expect(typeof keys[0]).toBe('string');
    expect(r['[object]']).toHaveLength(1);
  });

  it('groups values named like prototype properties without crashing', () => {
    const r = group_by({
      array: [{ kind: '__proto__' }, { kind: 'constructor' }, { kind: 'prototype' }],
      field: 'kind',
    }, c) as Record<string, unknown[]>;
    expect(Object.prototype.hasOwnProperty.call(r, '__proto__')).toBe(true);
    expect(r['__proto__']).toHaveLength(1);
    expect(r['constructor']).toHaveLength(1);
    expect(r['prototype']).toHaveLength(1);
  });

  it('drops prototype-sensitive aggregate output names', () => {
    const aggregate = JSON.parse(
      '{"total":{"operator":"sum","field":"amount"},"__proto__":{"operator":"sum","field":"amount"},"constructor":{"operator":"count"},"prototype":{"operator":"count"}}',
    );
    const r = group_by({
      array: deals,
      field: 'stage',
      aggregate,
    }, c) as Array<Record<string, unknown>>;
    const won = r.find(x => x.stage === 'won')!;
    expect(won.total).toBe(150);
    expect(Object.getPrototypeOf(won)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(won, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(won, 'prototype')).toBe(false);
  });

  // D-182 Tier-P — group by a DOTTED raw vendor path while naming the output key
  // plainly via `group_as`, so the key reads back through `getField` (dot-split)
  // downstream. Without `group_as` the key would land under the literal
  // "properties.stage" string, which getField can't reach.
  it('group_as names the output key for a dotted (raw vendor) field path', () => {
    const rawDeals = [
      { properties: { stage: 'won', amount: 100 } },
      { properties: { stage: 'lost', amount: 200 } },
      { properties: { stage: 'won', amount: 50 } },
    ];
    const r = group_by({
      array: rawDeals,
      field: 'properties.stage',
      group_as: 'stage',
      aggregate: { total: { operator: 'sum', field: 'properties.amount' }, count: { operator: 'count' } },
    }, c) as Array<Record<string, unknown>>;
    const won = r.find(x => x.stage === 'won')!;
    expect(won).toBeDefined();
    expect(won.total).toBe(150);
    expect(won.count).toBe(2);
    // the key is readable through getField (no dotted literal leaked)
    expect(getField(won, 'stage')).toBe('won');
    expect(Object.prototype.hasOwnProperty.call(won, 'properties.stage')).toBe(false);
  });

  it('group_as absent → key stays under the field name (unchanged behavior)', () => {
    const r = group_by({
      array: deals, field: 'stage',
      aggregate: { count: { operator: 'count' } },
    }, c) as Array<Record<string, unknown>>;
    expect(r.find(x => x.stage === 'won')!.count).toBe(2);
  });
});

describe('to_list', () => {
  it('converts object to key-value pairs', () => {
    const r = to_list({ input: { a: 1, b: 2 } }, c) as { key: string; value: number }[];
    expect(r).toEqual([{ key: 'a', value: 1 }, { key: 'b', value: 2 }]);
  });
  it('returns empty for non-object', () => expect(to_list({ input: null }, c)).toEqual([]));
});

describe('partition', () => {
  it('splits by single condition', () => {
    const r = partition({ array: deals, field: 'stage', operator: 'equal', value: 'won' }, c) as {
      matched: typeof deals;
      unmatched: typeof deals;
    };
    expect(r.matched).toHaveLength(2);
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0].name).toBe('B');
  });

  it('splits by conditions array (AND by default)', () => {
    const r = partition({
      array: deals,
      conditions: [
        { field: 'stage', operator: 'equal', value: 'won' },
        { field: 'amount', operator: 'greater', value: 50 },
      ],
    }, c) as { matched: typeof deals; unmatched: typeof deals };
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].name).toBe('A');
    expect(r.unmatched).toHaveLength(2);
  });

  it('splits by conditions with mode=any (OR)', () => {
    const r = partition({
      array: deals,
      mode: 'any',
      conditions: [
        { field: 'stage', operator: 'equal', value: 'won' },
        { field: 'amount', operator: 'greater', value: 150 },
      ],
    }, c) as { matched: typeof deals; unmatched: typeof deals };
    expect(r.matched).toHaveLength(3);
    expect(r.unmatched).toHaveLength(0);
  });

  it('returns empty buckets for null array', () => {
    expect(partition({ array: null, field: 'x', operator: 'equal' }, c)).toEqual({ matched: [], unmatched: [] });
  });

  it('preserves order within each bucket', () => {
    const items = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];
    const r = partition({ array: items, field: 'n', operator: 'greater', value: 2 }, c) as {
      matched: { n: number }[];
      unmatched: { n: number }[];
    };
    expect(r.matched.map(x => x.n)).toEqual([3, 4]);
    expect(r.unmatched.map(x => x.n)).toEqual([1, 2]);
  });
});

// ────────────────────────────────────────────────────────────────
// sort — uncovered branches
// ────────────────────────────────────────────────────────────────

describe('sort — edge cases', () => {
  it('uses shorthand single-field params when fields is omitted', () => {
    const r = sort({ array: deals, field: 'amount', direction: 'asc' }, c) as { amount: number }[];
    expect(r.map(x => x.amount)).toEqual([50, 100, 200]);
  });

  it('defaults direction to asc when neither fields nor direction is given', () => {
    const r = sort({ array: deals, field: 'amount' }, c) as { amount: number }[];
    expect(r[0].amount).toBe(50);
  });

  it('tie-breaks with a second field', () => {
    const rows = [
      { s: 'won', a: 200, n: 'X' },
      { s: 'won', a: 100, n: 'Y' },
      { s: 'lost', a: 100, n: 'Z' },
    ];
    const r = sort({ array: rows, fields: [
      { field: 's', direction: 'asc' },
      { field: 'a', direction: 'desc' },
    ] }, c) as typeof rows;
    expect(r.map(x => x.n)).toEqual(['Z', 'X', 'Y']);
  });

  it('places nulls after non-nulls on ascending sort (null == null → 0)', () => {
    const rows = [{ v: 2 }, { v: null }, { v: 1 }, { v: null }];
    const r = sort({ array: rows, field: 'v', direction: 'asc' }, c) as { v: number | null }[];
    expect(r.map(x => x.v)).toEqual([1, 2, null, null]);
  });

  it('places nulls LAST on DESCENDING sort too — the null verdict is direction-independent', () => {
    // Regression guard for the null-sort footgun: a desc sort must rank the
    // PRESENT values high and sink the missing ones, NOT float nulls to the top
    // (which would make a "top N by value" recipe rank value-less rows #1).
    const rows = [{ v: 2 }, { v: null }, { v: 1 }, { v: null }];
    const r = sort({ array: rows, field: 'v', direction: 'desc' }, c) as { v: number | null }[];
    expect(r.map(x => x.v)).toEqual([2, 1, null, null]);
  });

  it('undefined (missing key) also sorts last on a desc sort', () => {
    const rows = [{ v: 1 }, {}, { v: 3 }];
    const r = sort({ array: rows, field: 'v', direction: 'desc' }, c) as { v?: number }[];
    expect(r.map(x => x.v)).toEqual([3, 1, undefined]);
  });

  it('keeps nulls last on the PRIMARY field, then tie-breaks the present-value ties by a secondary field', () => {
    const rows = [
      { v: null, n: 'A' },
      { v: 50, n: 'B' },
      { v: null, n: 'C' },
      { v: 100, n: 'D' },
    ];
    const r = sort({ array: rows, fields: [
      { field: 'v', direction: 'desc' },
      { field: 'n', direction: 'asc' },
    ] }, c) as typeof rows;
    // present values desc (D=100, B=50), THEN the null-v rows — tie-broken by name asc (A, C).
    expect(r.map(x => x.n)).toEqual(['D', 'B', 'A', 'C']);
  });
});

// ────────────────────────────────────────────────────────────────
// map — apply mode + expression edges
// ────────────────────────────────────────────────────────────────

describe('map — apply mode', () => {
  it('applies a transform function per item with output_field (value injected as `input` by default)', () => {
    // A custom target not in APPLY_VALUE_PARAM receives the field value
    // under the default `input` param.
    const ctxWithFn = {
      ...c,
      getTransform: (name: string) =>
        name === 'double'
          ? (input: Record<string, unknown>) => Number(input.input) * 2
          : undefined,
    };
    const r = map(
      { array: deals, apply: 'double', field: 'amount', output_field: 'doubled' },
      ctxWithFn,
    ) as Array<{ name: string; doubled: number }>;
    expect(r.map(x => x.doubled)).toEqual([200, 400, 100]);
  });

  it('throws when the apply target is not a registered transform (silent-corruption guard)', () => {
    const ctxNoFn = { ...c, getTransform: () => undefined };
    expect(() => map(
      { array: deals, apply: 'ai-classify', field: 'amount', output_field: 'x' },
      ctxNoFn,
    )).toThrow(/not a registered transform/);
  });

  it('throws when ctx has no getTransform hook (apply cannot run without the registry)', () => {
    const ctxNoHelper = { ...c, getTransform: undefined } as unknown as typeof c;
    expect(() => map(
      { array: deals, apply: 'double', field: 'amount', output_field: 'x' },
      ctxNoHelper,
    )).toThrow(/not a registered transform/);
  });
});

describe('map — expression edges', () => {
  it('plain string without refs returns the literal', () => {
    const r = map({ array: deals, expression: 'just a string' }, c) as string[];
    expect(r).toEqual(['just a string', 'just a string', 'just a string']);
  });

  it('array template resolves each element per item', () => {
    const r = map(
      { array: deals, expression: ['{{item.name}}', '{{item.amount}}'] as unknown },
      c,
    ) as [string, number][];
    expect(r).toEqual([['A', 100], ['B', 200], ['C', 50]]);
  });

  it('object template drops prototype-sensitive keys', () => {
    const expression = JSON.parse(
      '{"safe":"{{item.name}}","__proto__":{"polluted":true},"constructor":"bad","prototype":"bad"}',
    );
    const r = map(
      { array: deals.slice(0, 1), expression },
      c,
    ) as Array<Record<string, unknown>>;
    expect(r[0]).toEqual({ safe: 'A' });
    expect(Object.getPrototypeOf(r[0])).toBe(Object.prototype);
    expect((r[0] as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('non-string non-object expression is returned verbatim', () => {
    const r = map({ array: deals, expression: 42 as unknown }, c) as number[];
    expect(r).toEqual([42, 42, 42]);
  });

  it('falls through to returning the array when expression + apply are both absent', () => {
    const r = map({ array: deals }, c);
    expect(r).toBe(deals);
  });
});

// ────────────────────────────────────────────────────────────────
// reduce — uncovered operators
// ────────────────────────────────────────────────────────────────

describe('reduce — edge cases', () => {
  it('min returns the smallest number', () => {
    expect(reduce({ array: deals, field: 'amount', operator: 'min' }, c)).toBe(50);
  });

  it('max returns the largest number', () => {
    expect(reduce({ array: deals, field: 'amount', operator: 'max' }, c)).toBe(200);
  });

  it('min returns null when there are no numeric values', () => {
    expect(reduce({ array: [{ x: 'a' }], field: 'x', operator: 'min' }, c)).toBeNull();
  });

  it('max returns null when there are no numeric values', () => {
    expect(reduce({ array: [{ x: 'a' }], field: 'x', operator: 'max' }, c)).toBeNull();
  });

  it('avg returns 0 for non-numeric values', () => {
    expect(reduce({ array: [{ x: 'a' }], field: 'x', operator: 'avg' }, c)).toBe(0);
  });

  it('returns null for an unknown operator', () => {
    // Cast to bypass the static ReduceOp union.
    expect(reduce({ array: deals, field: 'amount', operator: 'mode' as never }, c)).toBeNull();
  });

  it('returns null for empty array when no initial is supplied', () => {
    expect(reduce({ array: [], field: 'x', operator: 'sum' }, c)).toBeNull();
  });

  it('sums over raw values when no field is given', () => {
    expect(reduce({ array: [1, 2, 3], field: '', operator: 'sum', initial: 0 }, c)).toBe(6);
  });

  it('sum honors a non-zero initial', () => {
    expect(reduce({ array: deals, field: 'amount', operator: 'sum', initial: 1000 }, c)).toBe(1350);
  });
});

// ────────────────────────────────────────────────────────────────
// unique / flatten / slice — null-array branches
// ────────────────────────────────────────────────────────────────

describe('unique / flatten / slice — null array', () => {
  it('unique returns [] for null input', () => {
    expect(unique({ array: null }, c)).toEqual([]);
  });

  it('flatten returns [] for null input', () => {
    expect(flatten({ array: null }, c)).toEqual([]);
  });

  it('flatten defaults depth to 1 when omitted', () => {
    expect(flatten({ array: [[1, 2], [[3]]] }, c)).toEqual([1, 2, [3]]);
  });

  it('slice defaults start to 0 when omitted', () => {
    expect(slice({ array: [1, 2, 3, 4], end: 2 }, c)).toEqual([1, 2]);
  });
});

// ────────────────────────────────────────────────────────────────
// group_by — uncovered branches
// ────────────────────────────────────────────────────────────────

describe('group_by — edge cases', () => {
  it('returns {} for null input', () => {
    expect(group_by({ array: null, field: 'x' }, c)).toEqual({});
  });

  it('uses "null" as key when the group field value is null/undefined', () => {
    const items = [{ s: 'won' }, { s: null }, { s: undefined }];
    const r = group_by({ array: items, field: 's' }, c) as Record<string, unknown[]>;
    expect(r['null']).toHaveLength(2);
    expect(r['won']).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// to_list — uncovered branches
// ────────────────────────────────────────────────────────────────

describe('to_list — edge cases', () => {
  it('returns [] for undefined input', () => {
    expect(to_list({ input: undefined }, c)).toEqual([]);
  });

  it('returns [] when input is an array (not a plain object)', () => {
    expect(to_list({ input: [1, 2, 3] }, c)).toEqual([]);
  });
});
