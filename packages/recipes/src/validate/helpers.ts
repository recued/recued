/** Shared helpers used by multiple validator phases.
 *
 *  - `AddFn` — issue accumulator signature, passed down through every
 *    phase so validators stay pure over the input recipe.
 *  - `REF_PATTERN` — matches `{{…}}` template refs so literal-type
 *    checks know to skip values whose runtime type is only known at
 *    execution time. Shared between structural (transform param type
 *    checks) and contracts (AI function input array checks).
 *  - Small primitives: matchesParamType, describeType, validateStepId,
 *    parseStepRef.
 *  - Condition validators: validateConditionField + validateConditionString
 *    are shared between structural (skip_when/fail_on/guard on steps)
 *    and contracts (checklist item `issue` field).
 */

import { OPS, UNARY_OPS, type ConditionOp } from '@recued/contracts';
import type { ParamType } from '@recued/transforms';
import type { ValidationSeverity } from '../validate.js';
import { RESERVED_STEP_IDS } from './constants.js';

export type AddFn = (
  severity: ValidationSeverity,
  code: string,
  path: string,
  message: string,
) => void;

/** Pattern for a template reference value. Reference values can't be
 *  type-checked at validation time — the actual runtime type depends on
 *  what the reference resolves to — so we skip type checks for them. */
export const REF_PATTERN = /\{\{[^}]+\}\}/;

export const matchesParamType = (value: unknown, type: ParamType): boolean => {
  switch (type) {
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array':   return Array.isArray(value);
    case 'object':  return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'any':     return true;
  }
};

export const describeType = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

export const validateStepId = (
  id: string,
  path: string,
  declared: Set<string>,
  add: AddFn,
): void => {
  if (RESERVED_STEP_IDS.has(id)) {
    add('error', 'step_id_reserved', `${path}.id`,
      `step id "${id}" is reserved — pick a different name`);
    return;
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) {
    add('error', 'step_id_invalid', `${path}.id`,
      `step id "${id}" must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (identifier rules — used in {{step.X}} references)`);
    return;
  }
  if (declared.has(id)) {
    add('error', 'step_id_duplicate', `${path}.id`,
      `step id "${id}" is already declared — ids must be unique across prefetch_steps + steps`);
    return;
  }
  declared.add(id);
};

/** Extract the step id from "step.X" or "step.X.path" form.
 *  Returns the first segment after `step.` or null if not a step ref. */
export const parseStepRef = (source: string): string | null => {
  const trimmed = source.trim();
  const prefix = 'step.';
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length);
  if (!rest) return null;
  // Take the first path segment
  const firstDot = rest.indexOf('.');
  return firstDot === -1 ? rest : rest.slice(0, firstDot);
};

export const validateConditionField = (cond: unknown, path: string, add: AddFn): void => {
  if (typeof cond === 'string') {
    validateConditionString(cond, path, add);
    return;
  }
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    // Object form: { field, operator, value? }
    const c = cond as Record<string, unknown>;
    if (typeof c.field !== 'string') {
      add('error', 'condition_object_field', `${path}.field`, 'condition.field must be a string');
    }
    if (typeof c.operator !== 'string' || !OPS.has(c.operator as ConditionOp)) {
      add('error', 'condition_object_operator', `${path}.operator`,
        `condition.operator must be one of the 14 valid operators`);
    }
    return;
  }
  add('error', 'condition_shape', path,
    'condition must be a string ("{{ref}} op value") or an object { field, operator, value? }');
};

/** Parse and validate a condition STRING. Format: `{{ref}} operator value?` */
export const validateConditionString = (cond: string, path: string, add: AddFn): void => {
  // Forbidden compound keywords — recipes use any/all transform steps, not or/and inline
  if (/\bor\b/i.test(cond) || /\band\b/i.test(cond)) {
    add('error', 'condition_compound', path,
      'use any/all transform steps for compound conditions, not "or"/"and" in the condition string');
    return;
  }

  const parts = cond.trim().split(/\s+/);
  if (parts.length < 2) {
    add('error', 'condition_too_short', path,
      `condition "${cond}" has too few tokens — expected "{{ref}} operator [value]"`);
    return;
  }
  const operator = parts[1];
  if (!OPS.has(operator as ConditionOp)) {
    add('error', 'condition_operator_invalid', path,
      `operator "${operator}" is not one of the 14 valid operators`);
    return;
  }
  if (UNARY_OPS.has(operator as ConditionOp)) {
    if (parts.length !== 2) {
      add('error', 'condition_unary_has_value', path,
        `unary operator "${operator}" must not have a value (got ${parts.length - 2} extra token(s))`);
    }
  } else {
    if (parts.length < 3) {
      add('error', 'condition_binary_missing_value', path,
        `binary operator "${operator}" requires a value`);
    }
  }
};
