import type { ConditionOp } from '@recued/contracts';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Get a nested field value via dot-notation path. */
export const getField = (obj: unknown, path: string): unknown => {
  if (obj == null || !path) return undefined;
  return path.split('.').reduce<unknown>((acc, key) => {
    if (DANGEROUS_KEYS.has(key)) return undefined;
    if (acc == null) return undefined;
    const n = Number(key);
    if (!Number.isNaN(n) && Array.isArray(acc)) return acc[n];
    if (
      (typeof acc !== 'object' && typeof acc !== 'function') ||
      !Object.prototype.hasOwnProperty.call(acc, key)
    ) {
      return undefined;
    }
    return (acc as Record<string, unknown>)[key];
  }, obj);
};

/** Boolean × string-boolean looseness for `equal`. CRM wire formats
 *  (HubSpot v3 returns EVERY property as a string — `hs_is_closed:
 *  'true'`) meet authored boolean literals (`"value": true`), and JS's
 *  `==` does NOT bridge that pair (`'true' == true` → `Number('true')`
 *  is NaN → false), so the comparison silently never matched on real
 *  data while boolean fixtures passed. Returns undefined when the pair
 *  isn't boolean-vs-'true'/'false' so `equal` falls through to `==`. */
const boolLooseEqual = (a: unknown, b: unknown): boolean | undefined => {
  if (typeof a === 'boolean' && (b === 'true' || b === 'false')) return a === (b === 'true');
  if (typeof b === 'boolean' && (a === 'true' || a === 'false')) return b === (a === 'true');
  return undefined;
};

/** The number a numeric comparison reads, or `null` when there is none.
 *
 *  ⛔⛔ A MISSING VALUE IS NOT ZERO. These four operators used to compare
 *  `Number(left)` with `Number(right)`, and `Number(null)` and `Number('')` are
 *  both 0 — so an absent amount passed `less_or_equal 0` as "paid", a missing
 *  date's `date_diff` passed `greater_or_equal 0` as "on time", and an unset
 *  price passed a `0 … 900000000000` range check as valid (`create-job`,
 *  `correct-job-money`, `release-worker-money`). Found by the Home Assistant
 *  energy recipe, where a meter with no `last_reset` counted twice. `undefined`
 *  already gave NaN and failed, so the two "missing" values behaved OPPOSITELY.
 *
 *  ⇒ null, undefined and a blank string are ABSENT, and a comparison with an
 *  absent side is false both ways. Everything else coerces exactly as before
 *  (`'12'` → 12, `true` → 1, a Date → its time). A recipe that MEANS "missing
 *  counts as 0" says so with `default` / `coalesce`. */
const comparable = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
};

const compareNumbers = (
  left: unknown,
  right: unknown,
  test: (a: number, b: number) => boolean,
): boolean => {
  const a = comparable(left);
  const b = comparable(right);
  return a !== null && b !== null && test(a, b);
};

/** Evaluate a single condition operator. Handles all 14 OPS. */
export const evaluateOp = (left: unknown, operator: ConditionOp, right?: unknown): boolean => {
  switch (operator) {
    case 'is_null': return left == null;
    case 'is_not_null': return left != null;
    case 'is_empty': return left == null || left === '' || (Array.isArray(left) && left.length === 0);
    case 'is_not_empty': return !evaluateOp(left, 'is_empty');
    case 'equal': return boolLooseEqual(left, right) ?? (left == right);
    case 'not_equal': return !evaluateOp(left, 'equal', right);
    case 'greater': return compareNumbers(left, right, (a, b) => a > b);
    case 'greater_or_equal': return compareNumbers(left, right, (a, b) => a >= b);
    case 'less': return compareNumbers(left, right, (a, b) => a < b);
    case 'less_or_equal': return compareNumbers(left, right, (a, b) => a <= b);
    case 'contains': return typeof left === 'string' && typeof right === 'string' && left.includes(right);
    case 'not_contains': return !evaluateOp(left, 'contains', right);
    case 'in': return Array.isArray(right) && right.includes(left);
    case 'not_in': return !evaluateOp(left, 'in', right);
    default: return false;
  }
};
