import { describe, it, expect } from 'vitest';
import { compare, coalesce, switch_, all, any, count, default_, not_, ternary, pluralize } from '../logic.js';
import { ctx } from './helpers.js';

const c = ctx();

describe('compare', () => {
  it('equal', () => expect(compare({ left: 5, operator: 'equal', right: 5 }, c)).toBe(true));
  it('greater', () => expect(compare({ left: 10, operator: 'greater', right: 5 }, c)).toBe(true));
  it('is_null', () => expect(compare({ left: null, operator: 'is_null' }, c)).toBe(true));
  it('supports value alias', () => expect(compare({ left: 'a', operator: 'equal', value: 'a' }, c)).toBe(true));
});

describe('coalesce', () => {
  it('returns first non-null', () => expect(coalesce({ values: [null, undefined, 'x', 'y'] }, c)).toBe('x'));
  it('returns null if all null', () => expect(coalesce({ values: [null, undefined] }, c)).toBeNull());
  it('returns false (non-null)', () => expect(coalesce({ values: [null, false, 'x'] }, c)).toBe(false));
  it('returns null for non-array', () => expect(coalesce({ values: null }, c)).toBeNull());
});

describe('switch', () => {
  it('matches case', () => expect(switch_({ input: 'a', cases: { a: 1, b: 2 } }, c)).toBe(1));
  it('returns default on miss', () => expect(switch_({ input: 'z', cases: { a: 1 }, default: 99 }, c)).toBe(99));
  it('coerces boolean', () => expect(switch_({ input: true, cases: { true: 'yes', false: 'no' } }, c)).toBe('yes'));
  it('returns null without default', () => expect(switch_({ input: 'z', cases: { a: 1 } }, c)).toBeNull());
  it('does not match inherited prototype case names', () => {
    expect(switch_({ input: 'constructor', cases: { a: 1 }, default: 'safe' }, c)).toBe('safe');
  });
  it('supports own prototype-sensitive case names without walking the prototype chain', () => {
    const cases = Object.create(null) as Record<string, unknown>;
    cases['constructor'] = 'own';
    expect(switch_({ input: 'constructor', cases, default: 'safe' }, c)).toBe('own');
  });
});

describe('all', () => {
  it('true when all truthy', () => expect(all({ values: [true, 1, 'x'] }, c)).toBe(true));
  it('false when one falsy', () => expect(all({ values: [true, false] }, c)).toBe(false));
  it('evaluates conditions', () => {
    const evalCtx = ctx({ evaluate: (cond) => String(cond).includes('true') });
    expect(all({ conditions: ['true', 'true'] }, evalCtx)).toBe(true);
    expect(all({ conditions: ['true', 'false'] }, evalCtx)).toBe(false);
  });
});

describe('any', () => {
  it('true when one truthy', () => expect(any({ values: [false, 0, 'x'] }, c)).toBe(true));
  it('false when all falsy', () => expect(any({ values: [false, 0, ''] }, c)).toBe(false));
  it('evaluates conditions', () => {
    const evalCtx = ctx({ evaluate: (cond) => String(cond).includes('true') });
    expect(any({ conditions: ['false', 'true'] }, evalCtx)).toBe(true);
    expect(any({ conditions: ['false', 'false'] }, evalCtx)).toBe(false);
  });
});

describe('count', () => {
  it('counts array', () => expect(count({ input: [1, 2, 3] }, c)).toBe(3));
  it('counts object keys', () => expect(count({ input: { a: 1, b: 2 } }, c)).toBe(2));
  it('returns 0 for null', () => expect(count({ input: null }, c)).toBe(0));
  it('returns 0 for empty', () => expect(count({ input: [] }, c)).toBe(0));
});

describe('default', () => {
  it('returns value when present', () => expect(default_({ value: 'hello', fallback: 'N/A' }, c)).toBe('hello'));
  it('returns fallback when null', () => expect(default_({ value: null, fallback: 'N/A' }, c)).toBe('N/A'));
  it('returns fallback when undefined', () => expect(default_({ value: undefined, fallback: 0 }, c)).toBe(0));
  it('returns fallback when empty string', () => expect(default_({ value: '', fallback: 'blank' }, c)).toBe('blank'));
  it('preserves 0 (truthy zero is a real value)', () => expect(default_({ value: 0, fallback: 99 }, c)).toBe(0));
  it('preserves false (explicit boolean)', () => expect(default_({ value: false, fallback: true }, c)).toBe(false));
  it('returns null when no fallback provided', () => expect(default_({ value: null }, c)).toBeNull());
});

describe('not', () => {
  it('inverts true → false', () => expect(not_({ input: true }, c)).toBe(false));
  it('inverts false → true', () => expect(not_({ input: false }, c)).toBe(true));
  it('inverts null → true', () => expect(not_({ input: null }, c)).toBe(true));
  it('inverts 0 → true', () => expect(not_({ input: 0 }, c)).toBe(true));
  it('inverts non-empty string → false', () => expect(not_({ input: 'x' }, c)).toBe(false));
  it('inverts empty array → false (non-empty reference)', () => expect(not_({ input: [] }, c)).toBe(false));
  it('inverts empty object → false (non-empty reference)', () => expect(not_({ input: {} }, c)).toBe(false));
});

describe('ternary', () => {
  it('returns then when if truthy', () => expect(ternary({ if: true, then: 'yes', else: 'no' }, c)).toBe('yes'));
  it('returns else when if falsy', () => expect(ternary({ if: false, then: 'yes', else: 'no' }, c)).toBe('no'));
  it('returns else when if null', () => expect(ternary({ if: null, then: 'yes', else: 'no' }, c)).toBe('no'));
  it('returns else when if 0', () => expect(ternary({ if: 0, then: 'yes', else: 'no' }, c)).toBe('no'));
  it('returns then when if non-empty string', () => expect(ternary({ if: 'x', then: 'yes', else: 'no' }, c)).toBe('yes'));
  it('returns null when if falsy and no else', () => expect(ternary({ if: false, then: 'yes' }, c)).toBeNull());
  it('preserves types (numbers)', () => expect(ternary({ if: true, then: 42, else: 0 }, c)).toBe(42));
  it('preserves types (objects)', () => {
    const obj = { a: 1 };
    expect(ternary({ if: true, then: obj, else: null }, c)).toBe(obj);
  });
});

describe('pluralize', () => {
  it('returns zero branch when count is 0', () => expect(pluralize({ count: 0, zero: 'no deals', one: '1 deal', many: '{n} deals' }, c)).toBe('no deals'));
  it('returns one branch when count is 1', () => expect(pluralize({ count: 1, zero: 'no deals', one: '1 deal', many: '{n} deals' }, c)).toBe('1 deal'));
  it('returns many branch when count > 1', () => expect(pluralize({ count: 5, zero: 'no deals', one: '1 deal', many: '5 deals' }, c)).toBe('5 deals'));
  it('falls through to many when zero is missing', () => expect(pluralize({ count: 0, many: '0 deals' }, c)).toBe('0 deals'));
  it('accepts other as alias for many', () => expect(pluralize({ count: 3, other: '3 items' }, c)).toBe('3 items'));
  it('returns many fallback when count is not finite', () => expect(pluralize({ count: NaN, many: 'unknown' }, c)).toBe('unknown'));
  it('returns empty string when all branches missing and count invalid', () => expect(pluralize({ count: 'abc' }, c)).toBe(''));
  it('coerces count from string', () => expect(pluralize({ count: '1', one: 'singular', many: 'plural' }, c)).toBe('singular'));
});
