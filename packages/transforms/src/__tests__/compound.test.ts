import { describe, it, expect } from 'vitest';
import { find, pluck, sum, min_by, max_by, percent, join } from '../compound.js';
import { ctx } from './helpers.js';

const c = ctx();
const items = [
  { name: 'A', score: 10 },
  { name: 'B', score: 30 },
  { name: 'C', score: 20 },
];

describe('find', () => {
  it('finds first match', () => {
    const r = find({ array: items, field: 'score', operator: 'greater', value: 15 }, c) as { name: string };
    expect(r.name).toBe('B');
  });
  it('returns null when no match', () => {
    expect(find({ array: items, field: 'score', operator: 'greater', value: 100 }, c)).toBeNull();
  });
  it('returns null for null array', () => expect(find({ array: null, field: 'x', operator: 'equal' }, c)).toBeNull());
});

describe('pluck', () => {
  it('extracts field values', () => expect(pluck({ array: items, field: 'name' }, c)).toEqual(['A', 'B', 'C']));
  it('returns empty for null', () => expect(pluck({ array: null, field: 'x' }, c)).toEqual([]));
});

describe('sum', () => {
  it('sums field', () => expect(sum({ array: items, field: 'score' }, c)).toBe(60));
  it('returns 0 for empty', () => expect(sum({ array: [], field: 'score' }, c)).toBe(0));
  it('returns 0 for null', () => expect(sum({ array: null, field: 'score' }, c)).toBe(0));
});

describe('min_by', () => {
  it('finds minimum', () => {
    const r = min_by({ array: items, field: 'score' }, c) as { name: string };
    expect(r.name).toBe('A');
  });
  it('returns null for empty', () => expect(min_by({ array: [], field: 'score' }, c)).toBeNull());
});

describe('max_by', () => {
  it('finds maximum', () => {
    const r = max_by({ array: items, field: 'score' }, c) as { name: string };
    expect(r.name).toBe('B');
  });
});

describe('percent', () => {
  it('calculates ratio', () => expect(percent({ value: 3, total: 4 }, c)).toBe(0.75));
  it('rounds to precision', () => expect(percent({ value: 1, total: 3, precision: 4 }, c)).toBe(0.3333));
  it('returns 0 for zero total', () => expect(percent({ value: 5, total: 0 }, c)).toBe(0));
});

describe('join', () => {
  it('joins with separator', () => expect(join({ array: ['a', 'b', 'c'], separator: '-' }, c)).toBe('a-b-c'));
  it('defaults to comma-space', () => expect(join({ array: ['a', 'b'] }, c)).toBe('a, b'));
  it('returns empty for null', () => expect(join({ array: null }, c)).toBe(''));
});
