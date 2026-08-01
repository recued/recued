/** Recipe validator — public entry.
 *
 *  Runs three validation phases sequentially in one pass:
 *  1. STRUCTURAL — shape, refs, transform param schemas, namespaces, conditions.
 *     Anything the recipe must satisfy to be parseable and wirable to the engine.
 *  2. QUALITY    — orphan detection, PII hygiene, TTL floors, placeholder IDs,
 *     output determinism, and other hints mirroring the Python quality precheck.
 *  3. CONTRACTS  — inner structure of display blocks (to_checklist items,
 *     to_summary fields, to_table columns), AI function input contracts
 *     (ai-classify needs llm.categories, ai-score needs llm.criteria, etc.),
 *     and either/or transform params (any/all values|conditions, merge
 *     source|sources, switch cases shape). Phase 1 checks top-level params
 *     via TRANSFORM_SCHEMAS; phase 3 validates the SHAPE of those params.
 *
 *  All three phases are structural/mechanical — no semantic judgment.
 *
 *  SCOPE BOUNDARY: this validator operates on ONE recipe in isolation.
 *  It does NOT:
 *    - Look up ingredient slugs in a registry (no external I/O)
 *    - Execute the recipe to detect runtime issues (engine's job)
 *    - Apply semantic judgment like "is this the right AI function"
 *      (that's the LLM quality checker's job)
 *  Those checks live in other layers.
 *
 *  The phase validators live under `./validate/` — this file orchestrates
 *  them and exposes the public types + convenience wrappers.
 */

import type { RecipeDefinition } from '@recued/contracts';
import {
  validateRequiredFields,
  validateRecipeId,
  validateTrigger,
  validateMetadata,
  validateSteps,
  validateVariables,
  validateOutput,
  validateAutoRun,
  validateEventTriggers,
  validateWebhookDeclarations,
  validateTriggerSteps,
  validateWait,
  validateOnFailure,
  validateProvenance,
  validateChatExposed,
  validateRequires,
  validateRunMode,
  validateEnrichmentSteps,
  validateRequiresFormFields,
} from './validate/structural.js';
import {
  validateReferences,
  validateForwardReferences,
} from './validate/references.js';
import { validateQualityChecks } from './validate/quality.js';
import { validateContracts } from './validate/contracts.js';

/** Validation severity tiers.
 *  - `error` blocks install / publish. valid === false when any error is present.
 *  - `warn`  does not block but marketplace + kitchen UI should surface.
 *  - `info`  advisory hint.
 */
export type ValidationSeverity = 'error' | 'warn' | 'info';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  /** Dot path into the recipe (e.g. "metadata.author", "steps[3].id"). */
  path: string;
  message: string;
}

export interface ValidationResult {
  /** True iff no error-severity issues. warn/info do not affect this. */
  valid: boolean;
  issues: ValidationIssue[];
}

/** Validate a recipe definition against all structural, reference, and
 *  marketplace rules. Returns a ValidationResult with every finding.
 *  Never throws — malformed input produces issues instead. */
export const validateRecipe = (input: unknown): ValidationResult => {
  const issues: ValidationIssue[] = [];
  const add = (severity: ValidationSeverity, code: string, path: string, message: string): void => {
    issues.push({ severity, code, path, message });
  };

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    add('error', 'recipe_not_object', '', 'recipe must be an object');
    return { valid: false, issues };
  }
  const r = input as Record<string, unknown>;

  if (!validateOwnEnumerableFields(r, add)) {
    return { valid: false, issues };
  }
  validateRequiredFields(r, add);
  validateRecipeId(r, add);
  validateTrigger(r, add);
  validateMetadata(r, add);
  validateAutoRun(r, add);
  validateEventTriggers(r, add);
  validateWebhookDeclarations(r, add);
  const declaredStepIds = validateSteps(r, add);
  // trigger_steps share the same id namespace as prefetch + sequential
  // so {{step.X}} can never collide with {{trigger.X}} via the same id.
  validateTriggerSteps(r, declaredStepIds, add);
  validateWait(r, add);
  validateOnFailure(r, add);
  validateProvenance(r, add);
  validateChatExposed(r, add);
  validateRequires(r, add);
  validateRunMode(r, add);
  validateEnrichmentSteps(r, add);
  validateRequiresFormFields(r, add);
  validateVariables(r, declaredStepIds, add);
  validateOutput(r, declaredStepIds, add);
  validateReferences(r, declaredStepIds, add);
  validateForwardReferences(r, add);
  validateQualityChecks(r, add);
  validateContracts(r, add);

  const valid = !issues.some((i) => i.severity === 'error');
  return { valid, issues };
};

/** True if the recipe has no error-severity issues. */
export const isValidRecipe = (input: unknown): input is RecipeDefinition =>
  validateRecipe(input).valid;

/** Throw on any error-severity issue. Useful in build/publish scripts. */
export const assertValidRecipe = (input: unknown): RecipeDefinition => {
  const result = validateRecipe(input);
  if (!result.valid) {
    const errors = result.issues.filter((i) => i.severity === 'error');
    const first = errors[0];
    throw new Error(
      `Recipe validation failed: [${first.code}] ${first.path} — ${first.message}` +
      (errors.length > 1 ? ` (+${errors.length - 1} more errors)` : ''),
    );
  }
  return input as RecipeDefinition;
};

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const DEFAULT_OBJECT_PROTOTYPE_KEYS = new Set<PropertyKey>([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);

const validateOwnEnumerableFields = (
  value: unknown,
  add: (severity: ValidationSeverity, code: string, path: string, message: string) => void,
  path = '',
  stack = new WeakSet<object>(),
): boolean => {
  if (!value || typeof value !== 'object') return true;
  if (stack.has(value)) {
    add(
      'error',
      'cyclic_reference',
      path,
      `field "${path}" creates a cycle; recipes must be JSON-compatible acyclic data`,
    );
    return false;
  }
  stack.add(value);

  if (Array.isArray(value)) {
    let ok = true;
    for (let i = 0; i < value.length; i++) {
      if (!hasOwn(value, i) && i in value) {
        add(
          'error',
          'inherited_field',
          `${path}[${i}]`,
          `field "${path}[${i}]" must be an own property; inherited recipe data is unsafe to validate`,
        );
        ok = false;
        continue;
      }
      ok = validateOwnEnumerableFields(value[i], add, `${path}[${i}]`, stack) && ok;
    }
    stack.delete(value);
    return ok;
  }

  const record = value as Record<string, unknown>;
  for (const key of inheritedKeys(record)) {
    const fieldPath = appendPath(path, key);
    add(
      'error',
      'inherited_field',
      fieldPath,
      `field "${fieldPath}" must be an own property; inherited recipe data is unsafe to validate`,
    );
  }

  let ok = true;
  for (const [key, child] of Object.entries(record)) {
    ok = validateOwnEnumerableFields(child, add, appendPath(path, key), stack) && ok;
  }
  stack.delete(value);
  return ok;
};

const inheritedKeys = (record: object): PropertyKey[] => {
  const keys: PropertyKey[] = [];
  const seen = new Set<PropertyKey>();
  let proto = Object.getPrototypeOf(record);
  while (proto !== null) {
    for (const key of Reflect.ownKeys(proto)) {
      if (proto === Object.prototype && DEFAULT_OBJECT_PROTOTYPE_KEYS.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return keys;
};

const appendPath = (base: string, key: PropertyKey): string => {
  const segment = typeof key === 'number'
    ? `[${key}]`
    : typeof key === 'symbol'
    ? `[${String(key)}]`
    : /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
    ? key
    : `[${JSON.stringify(key)}]`;
  if (!base) return segment;
  return segment.startsWith('[') ? `${base}${segment}` : `${base}.${segment}`;
};
