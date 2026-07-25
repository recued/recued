import { describe, it, expect } from 'vitest';
import { evaluateOp, getField } from '../evaluate.js';

describe('getField', () => {
  it('gets top-level field', () => expect(getField({ a: 1 }, 'a')).toBe(1));
  it('gets nested field', () => expect(getField({ a: { b: 2 } }, 'a.b')).toBe(2));
  it('returns undefined for missing', () => expect(getField({ a: 1 }, 'b')).toBeUndefined());
  it('returns undefined for null obj', () => expect(getField(null, 'a')).toBeUndefined());
  it('gets array index', () => expect(getField({ a: [10, 20] }, 'a.1')).toBe(20));

  it('does not read inherited or prototype-sensitive fields', () => {
    const inherited = Object.create({ secret: 'inherited' }) as Record<string, unknown>;
    inherited.safe = 'own';
    const unsafe = JSON.parse('{"__proto__":{"polluted":true},"safe":"ok"}') as Record<string, unknown>;
    expect(getField(inherited, 'safe')).toBe('own');
    expect(getField(inherited, 'secret')).toBeUndefined();
    expect(getField({}, 'constructor.name')).toBeUndefined();
    expect(getField(unsafe, '__proto__.polluted')).toBeUndefined();
    expect(getField(unsafe, 'prototype.x')).toBeUndefined();
  });
});

describe('evaluateOp', () => {
  // Unary
  it('is_null: true for null', () => expect(evaluateOp(null, 'is_null')).toBe(true));
  it('is_null: false for value', () => expect(evaluateOp(5, 'is_null')).toBe(false));
  it('is_not_null: true for value', () => expect(evaluateOp('x', 'is_not_null')).toBe(true));
  it('is_empty: true for empty string', () => expect(evaluateOp('', 'is_empty')).toBe(true));
  it('is_empty: true for empty array', () => expect(evaluateOp([], 'is_empty')).toBe(true));
  it('is_empty: true for null', () => expect(evaluateOp(null, 'is_empty')).toBe(true));
  it('is_empty: false for non-empty', () => expect(evaluateOp([1], 'is_empty')).toBe(false));
  it('is_not_empty: true for non-empty', () => expect(evaluateOp('x', 'is_not_empty')).toBe(true));

  // Equality
  it('equal: same value', () => expect(evaluateOp(5, 'equal', 5)).toBe(true));
  it('equal: coerced', () => expect(evaluateOp('5', 'equal', 5)).toBe(true));
  it('equal: true equals string true', () => expect(evaluateOp(true, 'equal', 'true')).toBe(true));
  it('equal: false equals string false', () => expect(evaluateOp(false, 'equal', 'false')).toBe(true));
  it('equal: string true equals true', () => expect(evaluateOp('true', 'equal', true)).toBe(true));
  it('equal: true does not equal string false', () => expect(evaluateOp(true, 'equal', 'false')).toBe(false));
  it('equal: true does not equal uppercase string true', () => expect(evaluateOp(true, 'equal', 'TRUE')).toBe(false));
  it('equal: true keeps numeric coercion', () => expect(evaluateOp(true, 'equal', 1)).toBe(true));
  it('equal: string true equals string true', () => expect(evaluateOp('true', 'equal', 'true')).toBe(true));
  it('equal: null does not equal true', () => expect(evaluateOp(null, 'equal', true)).toBe(false));
  it('equal: undefined does not equal true', () => expect(evaluateOp(undefined, 'equal', true)).toBe(false));
  it('equal: true does not equal empty string', () => expect(evaluateOp(true, 'equal', '')).toBe(false));
  it('not_equal', () => expect(evaluateOp(5, 'not_equal', 3)).toBe(true));
  it('not_equal: true complements string true', () => expect(evaluateOp(true, 'not_equal', 'true')).toBe(false));
  it('not_equal: false complements string false', () => expect(evaluateOp(false, 'not_equal', 'false')).toBe(false));
  it('not_equal: string true complements true', () => expect(evaluateOp('true', 'not_equal', true)).toBe(false));
  it('not_equal: true complements string false', () => expect(evaluateOp(true, 'not_equal', 'false')).toBe(true));
  it('not_equal: true complements uppercase string true', () => expect(evaluateOp(true, 'not_equal', 'TRUE')).toBe(true));
  it('not_equal: true complements numeric coercion', () => expect(evaluateOp(true, 'not_equal', 1)).toBe(false));
  it('not_equal: string true complements string true', () => expect(evaluateOp('true', 'not_equal', 'true')).toBe(false));
  it('not_equal: null complements true', () => expect(evaluateOp(null, 'not_equal', true)).toBe(true));
  it('not_equal: undefined complements true', () => expect(evaluateOp(undefined, 'not_equal', true)).toBe(true));
  it('not_equal: true complements empty string', () => expect(evaluateOp(true, 'not_equal', '')).toBe(true));

  // Comparison
  it('greater', () => expect(evaluateOp(10, 'greater', 5)).toBe(true));
  it('greater: false', () => expect(evaluateOp(3, 'greater', 5)).toBe(false));
  it('greater_or_equal', () => expect(evaluateOp(5, 'greater_or_equal', 5)).toBe(true));
  it('less', () => expect(evaluateOp(3, 'less', 5)).toBe(true));
  it('less_or_equal', () => expect(evaluateOp(5, 'less_or_equal', 5)).toBe(true));

  // String
  it('contains', () => expect(evaluateOp('hello world', 'contains', 'world')).toBe(true));
  it('contains: false', () => expect(evaluateOp('hello', 'contains', 'xyz')).toBe(false));
  it('not_contains', () => expect(evaluateOp('hello', 'not_contains', 'xyz')).toBe(true));

  // Array membership
  it('in: found', () => expect(evaluateOp('a', 'in', ['a', 'b'])).toBe(true));
  it('in: not found', () => expect(evaluateOp('c', 'in', ['a', 'b'])).toBe(false));
  it('not_in', () => expect(evaluateOp('c', 'not_in', ['a', 'b'])).toBe(true));
  it('in/not_in: does not bool-coerce string true into boolean true', () => {
    expect(evaluateOp('true', 'in', [true])).toBe(false);
    expect(evaluateOp('true', 'not_in', [true])).toBe(true);
  });
});
