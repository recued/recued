import { describe, it, expect } from 'vitest';
import { round, clamp, to_number, math, decimal_math, weighted_score, evaluateMathExpression } from '../numeric.js';
import { ctx } from './helpers.js';

const c = ctx();

describe('round', () => {
  it('rounds to integer', () => expect(round({ input: 3.7 }, c)).toBe(4));
  it('rounds to 2 decimals', () => expect(round({ input: 3.456, precision: 2 }, c)).toBe(3.46));
  it('returns null for NaN', () => expect(round({ input: 'abc' }, c)).toBeNull());
});

describe('clamp', () => {
  it('clamps below min', () => expect(clamp({ input: -5, min: 0, max: 100 }, c)).toBe(0));
  it('clamps above max', () => expect(clamp({ input: 150, min: 0, max: 100 }, c)).toBe(100));
  it('passes through in range', () => expect(clamp({ input: 50, min: 0, max: 100 }, c)).toBe(50));
});

describe('to_number', () => {
  it('parses string', () => expect(to_number({ input: '42' }, c)).toBe(42));
  it('parses float', () => expect(to_number({ input: '3.14' }, c)).toBe(3.14));
  it('returns null for non-numeric', () => expect(to_number({ input: 'abc' }, c)).toBeNull());
  it('passes through number', () => expect(to_number({ input: 7 }, c)).toBe(7));
});

describe('math — classic mode', () => {
  it('adds', () => expect(math({ left: 5, operator: 'add', right: 3 }, c)).toBe(8));
  it('subtracts', () => expect(math({ left: 10, operator: 'subtract', right: 3 }, c)).toBe(7));
  it('multiplies', () => expect(math({ left: 4, operator: 'multiply', right: 5 }, c)).toBe(20));
  it('divides', () => expect(math({ left: 10, operator: 'divide', right: 4 }, c)).toBe(2.5));
  it('returns null on divide by zero', () => expect(math({ left: 10, operator: 'divide', right: 0 }, c)).toBeNull());
  it('modulo', () => expect(math({ left: 7, operator: 'modulo', right: 3 }, c)).toBe(1));
  it('abs', () => expect(math({ left: -5, operator: 'abs' }, c)).toBe(5));
  it('ceil', () => expect(math({ left: 3.2, operator: 'ceil' }, c)).toBe(4));
  it('floor', () => expect(math({ left: 3.9, operator: 'floor' }, c)).toBe(3));
});

describe('math — expression mode', () => {
  it('basic arithmetic', () => expect(math({ expression: '5 + 3' }, c)).toBe(8));
  it('multiplication and division', () => expect(math({ expression: '10 / 4 * 2' }, c)).toBe(5));
  it('parentheses', () => expect(math({ expression: '(5 + 3) * 2' }, c)).toBe(16));
  it('nested parentheses', () => expect(math({ expression: '((2 + 3) * (4 - 1))' }, c)).toBe(15));
  it('min function', () => expect(math({ expression: 'min(50, 100)' }, c)).toBe(50));
  it('max function', () => expect(math({ expression: 'max(50, 100)' }, c)).toBe(100));
  it('min with expression args', () => expect(math({ expression: 'min(45 / 90 * 100, 100)' }, c)).toBe(50));
  it('abs function', () => expect(math({ expression: 'abs(-7)' }, c)).toBe(7));
  it('ceil function', () => expect(math({ expression: 'ceil(3.2)' }, c)).toBe(4));
  it('floor function', () => expect(math({ expression: 'floor(3.9)' }, c)).toBe(3));
  it('round with precision', () => expect(math({ expression: 'round(3.456, 2)' }, c)).toBe(3.46));
  it('real recipe pattern: score clamp', () => {
    // min(days / max_days * 100, 100) where days=45, max_days=90
    expect(math({ expression: 'min(45 / 90 * 100, 100)' }, c)).toBe(50);
  });
  it('real recipe pattern: exceeds clamp', () => {
    expect(math({ expression: 'min(120 / 90 * 100, 100)' }, c)).toBe(100);
  });
  it('divide by zero returns null', () => expect(math({ expression: '10 / 0' }, c)).toBeNull());
  it('unary minus', () => expect(math({ expression: '-5 + 10' }, c)).toBe(5));
  it('modulo', () => expect(math({ expression: '7 % 3' }, c)).toBe(1));
  it('empty expression returns null', () => expect(math({ expression: '' }, c)).toBeNull());
  it('expression takes priority over classic mode', () => {
    expect(math({ expression: '2 + 2', left: 10, operator: 'add', right: 5 }, c)).toBe(4);
  });
});

describe('decimal_math', () => {
  it('adds four-decimal values without float drift', () => {
    expect(decimal_math({ left: '0.0001', operator: 'add', right: 0.0002, decimal_places: 4 }, c)).toBe('0.0003');
  });
  it('preserves the largest stored invoice balance when subtracting a small payment', () => {
    expect(decimal_math({ left: '922337203685477.5807', operator: 'subtract', right: '0.0001', decimal_places: 4 }, c))
      .toBe('922337203685477.5806');
  });
  it('handles negative differences and normalizes zero', () => {
    expect(decimal_math({ left: 20.25, operator: 'subtract', right: '120.0001', decimal_places: 4 }, c)).toBe('-99.7501');
    expect(decimal_math({ left: '-0.0001', operator: 'add', right: '+0.0001', decimal_places: 4 }, c)).toBe('0.0000');
  });
  it('supports integer and eighteen-place scales', () => {
    expect(decimal_math({ left: '9223372036854775807', operator: 'add', right: 1, decimal_places: 0 }, c))
      .toBe('9223372036854775808');
    expect(decimal_math({ left: '0.000000000000000001', operator: 'add', right: 0, decimal_places: 18 }, c))
      .toBe('0.000000000000000001');
  });
  it.each([0.00001, '1.12345', '', ' 1', '1e4', 'abc', NaN, Infinity, null, {}, '1'.repeat(257)])
    ('refuses an invalid operand %s', left => {
      expect(decimal_math({ left, operator: 'add', right: 0, decimal_places: 4 }, c)).toBeNull();
    });
  it.each([-1, 19, 4.5, NaN, Infinity, '4'])('refuses an invalid scale %s', decimal_places => {
    expect(decimal_math({ left: 1, operator: 'add', right: 2, decimal_places }, c)).toBeNull();
  });
  it('refuses unsupported operations and expression mode without falling back to float math', () => {
    expect(decimal_math({ left: 1, operator: 'multiply', right: 2, decimal_places: 4 }, c)).toBeNull();
    expect(decimal_math({ expression: '1 + 2', decimal_places: 4 }, c)).toBeNull();
  });
});

describe('evaluateMathExpression', () => {
  it('handles operator precedence', () => expect(evaluateMathExpression('2 + 3 * 4')).toBe(14));
  it('handles left-to-right for same precedence', () => expect(evaluateMathExpression('10 - 3 - 2')).toBe(5));
  it('complex real-world expression', () => {
    // weighted average: (40 * 0.4 + 80 * 0.35 + 60 * 0.25) / (0.4 + 0.35 + 0.25)
    expect(evaluateMathExpression('(40 * 0.4 + 80 * 0.35 + 60 * 0.25) / 1')).toBe(59);
  });
});

describe('weighted_score', () => {
  it('computes weighted average', () => {
    const result = weighted_score({
      scores: [
        { value: 80, weight: 0.4 },
        { value: 60, weight: 0.35 },
        { value: 40, weight: 0.25 },
      ],
    }, c);
    // (80*0.4 + 60*0.35 + 40*0.25) / (0.4+0.35+0.25) = (32+21+10) / 1 = 63
    expect(result).toBe(63);
  });

  it('clamps to range', () => {
    const result = weighted_score({
      scores: [
        { value: 150, weight: 1 },
      ],
      clamp: [0, 100],
    }, c);
    expect(result).toBe(100);
  });

  it('respects precision', () => {
    const result = weighted_score({
      scores: [
        { value: 33, weight: 0.5 },
        { value: 67, weight: 0.5 },
      ],
      precision: 0,
    }, c);
    expect(result).toBe(50);
  });

  it('returns null for empty scores', () => {
    expect(weighted_score({ scores: [] }, c)).toBeNull();
  });

  it('skips NaN entries', () => {
    const result = weighted_score({
      scores: [
        { value: 80, weight: 0.5 },
        { value: 'bad', weight: 0.5 },
      ],
    }, c);
    // Only 80*0.5 / 0.5 = 80
    expect(result).toBe(80);
  });

  it('real recipe pattern: deal risk scoring', () => {
    const result = weighted_score({
      scores: [
        { value: 45, weight: 0.4 },   // activity score
        { value: 72, weight: 0.35 },   // close date score
        { value: 30, weight: 0.25 },   // contact score
      ],
      clamp: [0, 100],
      precision: 1,
    }, c);
    // (45*0.4 + 72*0.35 + 30*0.25) / 1 = 18 + 25.2 + 7.5 = 50.7
    expect(result).toBe(50.7);
  });
});
