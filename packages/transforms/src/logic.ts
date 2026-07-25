import type { ConditionOp } from '@recued/contracts';
import type { TransformFn } from './types.js';
import { evaluateOp } from './evaluate.js';

export const compare: TransformFn = (p) => {
  const right = p.right ?? p.value;
  return evaluateOp(p.left, p.operator as ConditionOp, right);
};

export const coalesce: TransformFn = (p) => {
  const values = p.values as unknown[];
  if (!Array.isArray(values)) return null;
  return values.find(v => v != null) ?? null;
};

/** Two-arg sugar over coalesce. `{ value, fallback }` reads cleaner
 *  than `{ values: [value, fallback] }` when there's exactly one
 *  default. Returns `value` unless it is null/undefined/empty-string,
 *  otherwise `fallback`.
 *
 *  Empty-string is treated as nullish for this transform specifically —
 *  authors want "N/A" to show up when a template-interpolated value is
 *  literally an empty string, not when it's missing. (coalesce preserves
 *  empty strings; default does not.) */
export const default_: TransformFn = (p) => {
  const value = p.value;
  if (value === null || value === undefined || value === '') return p.fallback ?? null;
  return value;
};

/** Logical NOT. Coerces input to boolean using JS truthiness rules
 *  (null, undefined, 0, '', false, NaN → true; everything else → false).
 *  Handy for negating a step's result inside `skip_when`/`fail_on`
 *  without wrapping in a `compare` step. */
export const not_: TransformFn = (p) => {
  return !p.input;
};

/** Conditional value selector. Reads `if` (truthiness), returns `then`
 *  when truthy, `else` when falsy. Cleaner than:
 *    switch  input: {{x}}  cases: { true: ..., false: ... }
 *  especially when the branches are references or strings with interpolation. */
export const ternary: TransformFn = (p) => {
  return p.if ? p.then : (p.else ?? null);
};

/** Pluralization picker. Selects the right string based on `count`:
 *    count === 0 → `zero`  (falls through to `many` if not provided)
 *    count === 1 → `one`
 *    else        → `many`  (aliased as `other`)
 *
 *  Meant to be used AFTER the engine has interpolated counts into each
 *  branch string — e.g., `many: "{{step.n}} deals"` is already resolved
 *  to "5 deals" by the time this transform runs. */
export const pluralize: TransformFn = (p) => {
  const count = Number(p.count);
  if (!Number.isFinite(count)) return String(p.many ?? p.other ?? '');
  if (count === 0 && p.zero !== undefined) return String(p.zero);
  if (count === 1 && p.one !== undefined) return String(p.one);
  return String(p.many ?? p.other ?? '');
};

export const switch_: TransformFn = (p) => {
  const key = String(p.input);
  const cases = p.cases as Record<string, unknown> | undefined;
  if (
    cases !== null &&
    typeof cases === 'object' &&
    !Array.isArray(cases) &&
    Object.prototype.hasOwnProperty.call(cases, key)
  ) {
    return cases[key];
  }
  return p.default ?? null;
};

export const all: TransformFn = (p, ctx) => {
  if (Array.isArray(p.conditions)) {
    return (p.conditions as string[]).every(c => ctx.evaluate(c));
  }
  const values = p.values as unknown[];
  return Array.isArray(values) && values.every(Boolean);
};

export const any: TransformFn = (p, ctx) => {
  if (Array.isArray(p.conditions)) {
    return (p.conditions as string[]).some(c => ctx.evaluate(c));
  }
  const values = p.values as unknown[];
  return Array.isArray(values) && values.some(Boolean);
};

export const count: TransformFn = (p) => {
  const input = p.input;
  if (Array.isArray(input)) return input.length;
  if (input && typeof input === 'object') return Object.keys(input).length;
  return 0;
};
