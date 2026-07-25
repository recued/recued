/** D-118 Phase 6 — input validation + argv ref resolution for
 *  `service-invoke`.
 *
 *  Flow:
 *    1. Validate recipe-supplied `inputs` against the op's declared
 *       `input: Record<string, InvokeFieldSchema>`. Type-check,
 *       enum-check, `url` scheme allowlist, flag-injection guard on
 *       `file_ref` / `url`.
 *    2. Substitute `{{input.*}}` + `{{config.*}}` refs inside argv
 *       and env values. `{{vault.*}}` only flows inside env (argv
 *       is config/input-only) and routes through the supervisor
 *       module's resolver.
 *    3. Return the resolved argv + env the dispatcher hands off to
 *       `spawnInvoke`.
 */
import { resolveArgvValue, resolveEnvValue } from '../supervisor/refs.js';
import type { VaultResolveFn } from '../supervisor/types.js';
import {
  hasOwnSafe,
  isPrototypeSensitiveKey,
  setSafeKey,
} from '../key-safety.js';
import type {
  InvokeFieldSchema,
  InvokeOpSpec,
} from './types.js';

/** Thrown on validation failure. The dispatcher maps this to the
 *  `SERVICE_INPUT_INVALID` rpc error + populates detail. */
export class InvokeInputInvalidError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`invoke input '${field}': ${reason}`);
    this.name = 'InvokeInputInvalidError';
    this.field = field;
  }
}

/** Validate + coerce one input value against its schema. */
const validateField = (
  name: string,
  value: unknown,
  schema: InvokeFieldSchema,
): unknown => {
  if (value === undefined || value === null) {
    if (schema.required === true) {
      throw new InvokeInputInvalidError(name, 'required');
    }
    return value;
  }

  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') {
        throw new InvokeInputInvalidError(name, 'must be a string');
      }
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvokeInputInvalidError(name, 'must be a finite number');
      }
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new InvokeInputInvalidError(name, 'must be a boolean');
      }
      return value;
    }
    case 'enum': {
      if (typeof value !== 'string') {
        throw new InvokeInputInvalidError(name, 'enum value must be a string');
      }
      if (!schema.values || !schema.values.includes(value)) {
        throw new InvokeInputInvalidError(
          name,
          `must be one of ${schema.values?.join(', ') ?? '(no values declared)'}`,
        );
      }
      return value;
    }
    case 'file_ref': {
      if (typeof value !== 'string' || value === '') {
        throw new InvokeInputInvalidError(name, 'file_ref must be a non-empty string');
      }
      if (!schema.allow_flag_like && value.startsWith('-')) {
        throw new InvokeInputInvalidError(
          name,
          'file_ref value starts with "-" (flag-injection guard); set allow_flag_like to opt in',
        );
      }
      return value;
    }
    case 'url': {
      if (typeof value !== 'string' || value === '') {
        throw new InvokeInputInvalidError(name, 'url must be a non-empty string');
      }
      if (!schema.allow_flag_like && value.startsWith('-')) {
        throw new InvokeInputInvalidError(
          name,
          'url value starts with "-" (flag-injection guard); set allow_flag_like to opt in',
        );
      }
      if (!/^https?:\/\//i.test(value)) {
        throw new InvokeInputInvalidError(name, 'url must have http:// or https:// scheme');
      }
      return value;
    }
    default: {
      throw new InvokeInputInvalidError(name, `unknown field type '${schema.type as string}'`);
    }
  }
};

/** Validate every declared input + reject extras. Returns the
 *  coerced input map (same shape as the caller's, with values
 *  narrowed to the declared types). */
export const validateInvokeInputs = (
  op: InvokeOpSpec,
  inputs: Record<string, unknown>,
): Record<string, unknown> => {
  // Unknown fields — reject to keep the surface tight. Templates
  // that accept extra inputs declare them explicitly.
  for (const key of Object.keys(inputs)) {
    if (!hasOwnSafe(op.input as Record<string, unknown>, key)) {
      throw new InvokeInputInvalidError(key, 'unknown input field');
    }
  }
  const validated: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(op.input)) {
    if (isPrototypeSensitiveKey(name)) continue;
    const value = hasOwnSafe(inputs, name) ? inputs[name] : undefined;
    const coerced = validateField(name, value, schema);
    if (coerced !== undefined) setSafeKey(validated, name, coerced);
  }
  return validated;
};

const INPUT_REF = /\{\{\s*input\.([^}:\s]+)\s*\}\}/g;

/** Walk an input path against the validated inputs map. */
const walkInputPath = (inputs: Record<string, unknown>, path: string): unknown => {
  let cur: unknown = inputs;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (!hasOwnSafe(cur as Record<string, unknown>, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
};

/** Substitute `{{input.*}}` refs into a string. Pure refs preserve
 *  type via JSON stringification for objects; `{{config.*}}` refs
 *  are handled by `resolveArgvValue` upstream. */
const substituteInputRefs = (
  value: string,
  inputs: Record<string, unknown>,
): string => {
  return value.replace(INPUT_REF, (match, path: string) => {
    const resolved = walkInputPath(inputs, path);
    if (resolved === undefined) return match;
    if (resolved === null) return '';
    return typeof resolved === 'object'
      ? JSON.stringify(resolved)
      : String(resolved);
  });
};

/** Resolve `{{input.*}}` + `{{config.*}}` in each argv entry.
 *  Applied AFTER `validateInvokeInputs` so ref substitution sees
 *  only coerced values. */
export const resolveInvokeArgv = (
  argv: string[],
  inputs: Record<string, unknown>,
  config: Record<string, unknown>,
): string[] => {
  return argv.map((a) => {
    const afterConfig = resolveArgvValue(a, config);
    return substituteInputRefs(afterConfig, inputs);
  });
};

/** Resolve refs inside env values — config + vault + input. */
export const resolveInvokeEnv = (
  env: Record<string, string> | undefined,
  inputs: Record<string, unknown>,
  config: Record<string, unknown>,
  publisher_id: string,
  resolveVault: VaultResolveFn | undefined,
): Record<string, string> | undefined => {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const afterConfigVault = resolveEnvValue(v, config, publisher_id, resolveVault);
    setSafeKey(out, k, substituteInputRefs(afterConfigVault, inputs));
  }
  return out;
};
