import { describe, it, expect } from 'vitest';
import {
  matchesParamType,
  describeType,
  validateStepId,
  parseStepRef,
  validateConditionField,
  validateConditionString,
  REF_PATTERN,
  type AddFn,
} from '../validate/helpers.js';

// Capture accumulator used by validators to collect issues.
const captureAdd = () => {
  const issues: Array<{ severity: string; code: string; path: string; message: string }> = [];
  const add: AddFn = (severity, code, path, message) =>
    issues.push({ severity, code, path, message });
  return { add, issues };
};

// ────────────────────────────────────────────────────────────────
// matchesParamType + describeType
// ────────────────────────────────────────────────────────────────

describe('matchesParamType', () => {
  it('matches strings', () => {
    expect(matchesParamType('hi', 'string')).toBe(true);
    expect(matchesParamType(42, 'string')).toBe(false);
  });

  it('matches finite numbers (rejects NaN and Infinity)', () => {
    expect(matchesParamType(42, 'number')).toBe(true);
    expect(matchesParamType(NaN, 'number')).toBe(false);
    expect(matchesParamType(Infinity, 'number')).toBe(false);
    expect(matchesParamType('42', 'number')).toBe(false);
  });

  it('matches booleans (strictly)', () => {
    expect(matchesParamType(true, 'boolean')).toBe(true);
    expect(matchesParamType(false, 'boolean')).toBe(true);
    expect(matchesParamType(0, 'boolean')).toBe(false);
    expect(matchesParamType('true', 'boolean')).toBe(false);
  });

  it('matches arrays', () => {
    expect(matchesParamType([], 'array')).toBe(true);
    expect(matchesParamType([1, 2], 'array')).toBe(true);
    expect(matchesParamType({}, 'array')).toBe(false);
  });

  it('matches plain objects (rejects arrays and null)', () => {
    expect(matchesParamType({}, 'object')).toBe(true);
    expect(matchesParamType({ a: 1 }, 'object')).toBe(true);
    expect(matchesParamType([], 'object')).toBe(false);
    expect(matchesParamType(null, 'object')).toBe(false);
  });

  it('"any" matches every value', () => {
    expect(matchesParamType(42, 'any')).toBe(true);
    expect(matchesParamType(null, 'any')).toBe(true);
    expect(matchesParamType([], 'any')).toBe(true);
    expect(matchesParamType(undefined, 'any')).toBe(true);
  });
});

describe('describeType', () => {
  it('returns "null" for null (distinguished from object)', () => {
    expect(describeType(null)).toBe('null');
  });

  it('returns "array" for arrays (distinguished from object)', () => {
    expect(describeType([1, 2])).toBe('array');
  });

  it('falls back to typeof for everything else', () => {
    expect(describeType('hi')).toBe('string');
    expect(describeType(42)).toBe('number');
    expect(describeType(true)).toBe('boolean');
    expect(describeType({ a: 1 })).toBe('object');
    expect(describeType(undefined)).toBe('undefined');
  });
});

// ────────────────────────────────────────────────────────────────
// REF_PATTERN
// ────────────────────────────────────────────────────────────────

describe('REF_PATTERN', () => {
  it('matches basic refs', () => {
    expect(REF_PATTERN.test('{{step.x}}')).toBe(true);
    expect(REF_PATTERN.test('prefix {{config.x}} suffix')).toBe(true);
  });

  it('does not match plain strings', () => {
    expect(REF_PATTERN.test('no refs here')).toBe(false);
    expect(REF_PATTERN.test('')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// validateStepId
// ────────────────────────────────────────────────────────────────

describe('validateStepId', () => {
  it('accepts valid identifiers and records them in the declared set', () => {
    const { add, issues } = captureAdd();
    const declared = new Set<string>();
    validateStepId('deal_data', 'steps[0]', declared, add);
    expect(issues).toEqual([]);
    expect(declared.has('deal_data')).toBe(true);
  });

  it('rejects reserved namespace names', () => {
    const { add, issues } = captureAdd();
    for (const reserved of ['vault', 'config', 'context', 'meta', 'step']) {
      const declared = new Set<string>();
      validateStepId(reserved, 'steps[0]', declared, add);
    }
    expect(issues.every(i => i.code === 'step_id_reserved')).toBe(true);
    expect(issues).toHaveLength(5);
  });

  it('rejects identifiers starting with a digit', () => {
    const { add, issues } = captureAdd();
    validateStepId('1step', 'steps[0]', new Set(), add);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('step_id_invalid');
  });

  it('rejects identifiers with punctuation or hyphens', () => {
    const { add, issues } = captureAdd();
    validateStepId('my-step', 'steps[0]', new Set(), add);
    expect(issues[0].code).toBe('step_id_invalid');
  });

  it('detects duplicates across the declared set', () => {
    const { add, issues } = captureAdd();
    const declared = new Set<string>();
    validateStepId('deal_data', 'steps[0]', declared, add);
    validateStepId('deal_data', 'steps[1]', declared, add);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('step_id_duplicate');
  });
});

// ────────────────────────────────────────────────────────────────
// parseStepRef
// ────────────────────────────────────────────────────────────────

describe('parseStepRef', () => {
  it('extracts the step id from a simple ref', () => {
    expect(parseStepRef('step.deal')).toBe('deal');
  });

  it('extracts the first segment of a deep path', () => {
    expect(parseStepRef('step.deal.amount')).toBe('deal');
    expect(parseStepRef('step.contacts.0.name')).toBe('contacts');
  });

  it('returns null when not a step ref', () => {
    expect(parseStepRef('config.x')).toBeNull();
    expect(parseStepRef('vault.hubspot.token')).toBeNull();
    expect(parseStepRef('arbitrary text')).toBeNull();
  });

  it('returns null for an empty step.', () => {
    expect(parseStepRef('step.')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(parseStepRef('  step.deal  ')).toBe('deal');
  });
});

// ────────────────────────────────────────────────────────────────
// validateConditionField (string vs object forms)
// ────────────────────────────────────────────────────────────────

describe('validateConditionField', () => {
  it('accepts a valid string condition', () => {
    const { add, issues } = captureAdd();
    validateConditionField('{{step.days}} greater 7', 'path', add);
    expect(issues).toEqual([]);
  });

  it('accepts a valid object condition with field + operator', () => {
    const { add, issues } = captureAdd();
    validateConditionField({ field: '{{step.stage}}', operator: 'equal', value: 'won' }, 'path', add);
    expect(issues).toEqual([]);
  });

  it('flags object condition with non-string field', () => {
    const { add, issues } = captureAdd();
    validateConditionField({ field: 42, operator: 'equal' }, 'path', add);
    expect(issues.some(i => i.code === 'condition_object_field')).toBe(true);
  });

  it('flags object condition with missing / invalid operator', () => {
    const { add, issues } = captureAdd();
    validateConditionField({ field: '{{step.x}}', operator: 'fuzzy_match' }, 'path', add);
    expect(issues.some(i => i.code === 'condition_object_operator')).toBe(true);
  });

  it('flags non-string, non-object condition (number, array, null)', () => {
    for (const bad of [42, true, null, [1, 2]]) {
      const { add, issues } = captureAdd();
      validateConditionField(bad, 'path', add);
      expect(issues[0].code).toBe('condition_shape');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// validateConditionString
// ────────────────────────────────────────────────────────────────

describe('validateConditionString', () => {
  it('accepts a valid unary condition', () => {
    const { add, issues } = captureAdd();
    validateConditionString('{{step.deal}} is_null', 'path', add);
    expect(issues).toEqual([]);
  });

  it('accepts a valid binary condition', () => {
    const { add, issues } = captureAdd();
    validateConditionString('{{step.days}} greater 7', 'path', add);
    expect(issues).toEqual([]);
  });

  it('rejects inline "or" and "and" with condition_compound code', () => {
    for (const cond of [
      '{{step.a}} equal 1 or {{step.b}} equal 2',
      '{{step.a}} equal 1 and {{step.b}} equal 2',
      '{{step.a}} equal 1 OR {{step.b}} equal 2',
    ]) {
      const { add, issues } = captureAdd();
      validateConditionString(cond, 'path', add);
      expect(issues[0].code).toBe('condition_compound');
    }
  });

  it('rejects conditions with fewer than two tokens', () => {
    const { add, issues } = captureAdd();
    validateConditionString('onlyoneword', 'path', add);
    expect(issues[0].code).toBe('condition_too_short');
  });

  it('rejects an unknown operator', () => {
    const { add, issues } = captureAdd();
    validateConditionString('{{step.x}} wibble 1', 'path', add);
    expect(issues[0].code).toBe('condition_operator_invalid');
  });

  it('flags extra tokens after a unary operator', () => {
    const { add, issues } = captureAdd();
    validateConditionString('{{step.x}} is_null extra garbage', 'path', add);
    expect(issues[0].code).toBe('condition_unary_has_value');
  });

  it('flags a binary operator missing its value', () => {
    const { add, issues } = captureAdd();
    validateConditionString('{{step.x}} equal', 'path', add);
    expect(issues[0].code).toBe('condition_binary_missing_value');
  });
});
