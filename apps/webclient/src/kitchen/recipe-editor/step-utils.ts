/** Recipe-editor step-editing pure helpers (D-148 salvage).
 *
 *  Ported verbatim from the retired extension Kitchen (`c222acac~1`) — it
 *  depends only on stable seams (`@recued/contracts` types + `UNARY_OPS`,
 *  `@recued/transforms` `getTransformSchema`), so it carried over unchanged.
 *
 *  Every function here is pure — no closure over module state, no DOM. These
 *  are the primitives the step inspector builds on: parse/apply field-value
 *  pairs, generate unique step ids, extract schema-derived transform params +
 *  ingredient input params, build blank step scaffolds, pure list mutations
 *  (remove / reorder), the step-rename ref-rewriter (renames `{{step.OLD...}}`
 *  refs and authored output section source paths), condition string formatting,
 *  CSV <-> array helpers, and the rename validator.
 *
 *  Scope note: `createBlankStep` mints `transform` / `ingredient` / `guard`
 *  steps; `createBlankOpStep` mints a connection-agnostic op-step. After the
 *  D-182 absorb the `recipe.save` seam ACCEPTS inline op-steps (the dispatch
 *  path lowers + runs them), so op-steps are first-class inline-authored
 *  artifacts here too. */

import type {
  RecipeStep,
  PrefetchStep,
  RecipeDefinition,
  OutputSection,
  VariableDefault,
  IngredientManifest,
  ConditionOp,
} from '@recued/contracts';
import { UNARY_OPS } from '@recued/contracts';
import { getTransformSchema } from '@recued/transforms';

// ────────────────────────────────────────────────────────────────
// Step field handlers
// ────────────────────────────────────────────────────────────────

/** Parse a raw input value back into the typed JS value the recipe
 *  expects. Empty strings on skip_when/fail_on are special: they mean
 *  "delete the field" (since an empty condition string would be an
 *  always-false guard, which is never useful).
 *  Exported for unit testing — pure. */
export const parseStepFieldValue = (
  raw: string,
  fieldType: string,
  isCondition: boolean,
): unknown => {
  if (isCondition && raw.trim() === '') return undefined;
  switch (fieldType) {
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case 'boolean':
      return raw === 'true' || raw === 'on';
    case 'string':
    case 'enum':
    default:
      return raw;
  }
};

/** Parse a raw op-step `args.<name>` value. Op args carry no schema (kernel ops
 *  have no arg metadata; Tier-P args live in the pack manifest) and are most
 *  often `{{config.*}}` / `{{step.*}}` refs — so unlike transform/ingredient
 *  fields they're always edited as free text and smart-parsed: a JSON literal
 *  (number / boolean / array / object / quoted string) is parsed to its typed
 *  value; anything else (a bare ref, an unquoted word) stays the verbatim
 *  string. An empty input keeps an empty string (the user is mid-typing).
 *  Pure — exported for unit testing. The inverse is the route's serializeValue:
 *  `{{config.x}}` ⇄ `{{config.x}}`, `200` ⇄ `200`, `["a"]` ⇄ `["a"]`. */
export const parseOpArgValue = (raw: string): unknown => {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
};

/** Apply a single field change to a step in an array, returning a new
 *  array with the updated step. Pure — does not mutate the input.
 *  Exported for unit testing. */
export const applyFieldToStep = <T extends { id: string }>(
  list: T[],
  stepId: string,
  field: string,
  value: unknown,
): T[] =>
  list.map((s) => {
    if (s.id !== stepId) return s;
    const next = { ...s } as Record<string, unknown>;
    if (field === 'skip_when' || field === 'fail_on') {
      if (value === undefined) {
        delete next[field];
      } else {
        next[field] = value;
      }
    } else if (field.startsWith('param:')) {
      const paramName = field.slice('param:'.length);
      if (value === undefined) delete next[paramName];
      else next[paramName] = value;
    } else if (field.startsWith('input:')) {
      const inputName = field.slice('input:'.length);
      const prevInput = (next.input as Record<string, unknown> | undefined) ?? {};
      next.input = { ...prevInput, [inputName]: value };
      if (value === undefined) delete (next.input as Record<string, unknown>)[inputName];
    } else if (field.startsWith('arg:')) {
      const argName = field.slice('arg:'.length);
      const prevArgs = (next.args as Record<string, unknown> | undefined) ?? {};
      next.args = { ...prevArgs, [argName]: value };
    }
    return next as unknown as T;
  });

// ────────────────────────────────────────────────────────────────
// Add / remove / reorder helpers (pure, exported for testing)
// ────────────────────────────────────────────────────────────────

/** Step ids that the validator reserves — must not be used as new
 *  step ids. Mirrors RESERVED_STEP_IDS in @recued/recipes. */
const RESERVED_STEP_IDS = new Set([
  'vault', 'config', 'context', 'meta', 'step', 'item',
]);

/** Generate an unused step id by appending _N to a base name until
 *  it doesn't collide with `existing`. Falls back to 'new_step' if
 *  the base is empty or reserved. The base is sanitised to lowercase
 *  with non-identifier chars replaced by underscores so callers can
 *  pass things like a transform name ("filter") or a hint. */
export const generateStepId = (
  existing: string[],
  base = 'new_step',
): string => {
  const sanitised = base
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '');
  const safeBase =
    sanitised && !RESERVED_STEP_IDS.has(sanitised) ? sanitised : 'new_step';
  if (!existing.includes(safeBase) && !RESERVED_STEP_IDS.has(safeBase)) {
    return safeBase;
  }
  let i = 1;
  // Bounded loop — caller never has 100k steps but defend anyway.
  while (i < 10000) {
    const candidate = `${safeBase}_${i}`;
    if (!existing.includes(candidate) && !RESERVED_STEP_IDS.has(candidate)) {
      return candidate;
    }
    i++;
  }
  return `${safeBase}_${Date.now()}`;
};

/** Extract user-facing input params from an ingredient manifest.
 *  Filters out infrastructure keys (method, url, header.*,  query.*)
 *  and returns only the params the recipe author sets. */
export const extractRecipeInputParams = (
  manifest: IngredientManifest | undefined,
): Record<string, unknown> | undefined => {
  if (!manifest?.input) return undefined;
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest.input)) {
    // Skip HTTP infrastructure — the engine handles these
    if (key === 'method' || key === 'url' || key.startsWith('header.') || key.startsWith('query.')) continue;
    input[key] = value;
  }
  return Object.keys(input).length > 0 ? input : undefined;
};

/** Generate blank params from a transform schema.
 *  Required params get null (user must fill in), optional params are omitted.
 *  Enum params get the first value as default. */
export const extractTransformParams = (
  transformName: string,
): Record<string, unknown> => {
  const schema = getTransformSchema(transformName);
  if (!schema) return {};
  const params: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(schema)) {
    if (!def.required) continue;
    // Enum params: use first value as a sensible default
    if (def.enum && def.enum.length > 0) {
      params[key] = def.enum[0];
    } else {
      params[key] = null;
    }
  }
  return params;
};

/** Build a blank sequential step with the chosen discriminator.
 *  Pre-populates params from schema (transforms) or manifest (ingredients)
 *  so the user sees field names and fills in values. */
export const createBlankStep = (
  kind: 'transform' | 'ingredient' | 'guard',
  name: string,
  id: string,
  ingredientManifest?: IngredientManifest,
): RecipeStep => {
  if (kind === 'transform') {
    const params = extractTransformParams(name);
    return { id, transform: name, ...params } as unknown as RecipeStep;
  }
  if (kind === 'guard') {
    return { id, guard: '' } as RecipeStep;
  }
  const input = extractRecipeInputParams(ingredientManifest);
  return input
    ? { id, ingredient: name, input } as RecipeStep
    : { id, ingredient: name } as RecipeStep;
};

/** Build a blank connection-agnostic op-step with an empty args map. `op` is the
 *  two-tier op id (kernel `core.<domain>.<op>` / Tier-P
 *  `<publisher>.<pack>.<operation>` / legacy bare-canonical `deal.search`) — free
 *  text in the editor; `recipe.validate` gives precise op-shape errors. Args,
 *  connection slot, and foreach are filled in afterward in the inspector. */
export const createBlankOpStep = (op: string, id: string): RecipeStep =>
  ({ id, op, args: {} } as unknown as RecipeStep);

/** Build a blank prefetch step. Prefetch is always an ingredient.
 *  Pre-populates input params when a manifest is provided. */
export const createBlankPrefetchStep = (
  ingredient: string,
  id: string,
  ingredientManifest?: IngredientManifest,
): PrefetchStep => {
  const input = extractRecipeInputParams(ingredientManifest);
  return input
    ? { id, ingredient, input }
    : { id, ingredient };
};

/** Remove the step with `stepId` from the list, returning a new array.
 *  Pure — does not mutate. If no step matches, returns the original
 *  reference (cheap no-op). */
export const removeStepById = <T extends { id: string }>(
  list: T[],
  stepId: string,
): T[] => {
  if (!list.some((s) => s.id === stepId)) return list;
  return list.filter((s) => s.id !== stepId);
};

/** Move the item at `fromIndex` to `toIndex`, returning a new array.
 *  Both indices are inclusive of the source bounds; out-of-range or
 *  no-op moves return the original list reference. */
export const reorderSteps = <T>(
  list: T[],
  fromIndex: number,
  toIndex: number,
): T[] => {
  if (fromIndex === toIndex) return list;
  if (fromIndex < 0 || fromIndex >= list.length) return list;
  if (toIndex < 0 || toIndex >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
};

// ────────────────────────────────────────────────────────────────
// Step rename + ref auto-rewrite (pure, exported for testing)
// ────────────────────────────────────────────────────────────────

/** Escape a string for inclusion in a RegExp. */
const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rewrite `{namespace}.OLD` references inside `{{...}}` blocks of a
 *  string. Only matches when `OLD` is followed by a non-identifier
 *  character (so `{{step.foo_bar}}` is NOT rewritten when oldId is
 *  `foo`). Defaults to `step` namespace for backward compat with the
 *  step-rename caller. Pure — no side effects. */
export const renameInRefString = (
  s: string,
  oldId: string,
  newId: string,
  namespace = 'step',
): string => {
  if (!s.includes('{{') || !s.includes(oldId)) return s;
  const escaped = escapeRegex(oldId);
  const refRegex = new RegExp(
    `(\\{\\{\\s*${escapeRegex(namespace)}\\.)${escaped}(?![a-zA-Z0-9_])`,
    'g',
  );
  return s.replace(refRegex, `$1${newId}`);
};

/** Rewrite a bare `step.OLD` prefix in an output section source path.
 *  Output sources are NOT wrapped in `{{}}` — they're plain dotted
 *  paths like `step.summary` or `step.deals[0].name`. We only rewrite
 *  when the source starts with `step.OLD` followed by a non-identifier
 *  character (or end of string). */
export const renameInBareSource = (
  source: string,
  oldId: string,
  newId: string,
  namespace = 'step',
): string => {
  const escaped = escapeRegex(oldId);
  const regex = new RegExp(`^${escapeRegex(namespace)}\\.${escaped}(?![a-zA-Z0-9_])`);
  return source.replace(regex, `${namespace}.${newId}`);
};

/** Generic deep walker that applies a string transformer to every
 *  string value found in a JSON-like structure. Returns a new tree;
 *  does not mutate. */
const deepRewriteStrings = (
  value: unknown,
  fn: (s: string) => string,
): unknown => {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => deepRewriteStrings(v, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepRewriteStrings(entry, fn)]));
  }
  return value;
};

/** Rename a step's id everywhere it appears in a recipe:
 *    - The step's own `id` field (in prefetch_steps OR steps)
 *    - Every `{{step.OLD...}}` ref inside any string value across
 *      variables / prefetch_steps / steps (deep walk)
 *    - Every authored output section source that starts with `step.OLD`
 *
 *  Returns a new recipe; does not mutate. No-op if oldId === newId. D-195:
 *  edited recipes author canonical `output.render`; legacy sidebar-only input
 *  is converted to render while rewriting the references. */
export const renameStepIdInRecipe = (
  recipe: RecipeDefinition,
  oldId: string,
  newId: string,
): RecipeDefinition => {
  if (oldId === newId) return recipe;
  const rewrite = (s: string): string => renameInRefString(renameInRefString(s, oldId, newId), oldId, newId, 'trigger');

  const renameOwnId = <T extends { id: string }>(s: T): T =>
    s.id === oldId ? { ...s, id: newId } : s;

  const prefetch = (recipe.prefetch_steps ?? []).map((s) => {
    const walked = deepRewriteStrings(s, rewrite) as PrefetchStep;
    return renameOwnId(walked);
  });
  const steps = (recipe.steps ?? []).map((s) => {
    const walked = deepRewriteStrings(s, rewrite) as RecipeStep;
    return renameOwnId(walked);
  });
  const variables = deepRewriteStrings(
    recipe.variables ?? {},
    rewrite,
  ) as Record<string, VariableDefault>;

  const authoredOutput = Array.isArray(recipe.output?.render)
    ? recipe.output.render
    : recipe.output?.sidebar ?? [];
  const render: OutputSection[] = authoredOutput.map((sec) => ({
    ...deepRewriteStrings(sec, rewrite) as OutputSection,
    source:
      typeof sec.source === 'string'
        ? renameInBareSource(renameInBareSource(sec.source, oldId, newId), oldId, newId, 'trigger')
        : sec.source,
  }));

  return {
    ...recipe,
    variables,
    ...(recipe.trigger_steps ? { trigger_steps: recipe.trigger_steps.map(step =>
      renameOwnId(deepRewriteStrings(step, rewrite) as RecipeStep)) } : {}),
    prefetch_steps: prefetch,
    steps,
    output: recipe.output.exchange
      ? deepRewriteStrings(recipe.output, rewrite) as RecipeDefinition['output']
      : { ...Object.fromEntries(Object.entries(recipe.output).filter(([key]) => key !== 'sidebar')), render },
  };
};

// ────────────────────────────────────────────────────────────────
// Condition builder: format helper
// ────────────────────────────────────────────────────────────────
//
// The runtime condition grammar is the inline string form:
//   `{{field}} operator value`
// with a small subset of unary operators (is_null, is_not_null,
// is_empty, is_not_empty) that omit the trailing value. The parser
// that the engine uses lives in @recued/contracts → parseCondition
// and is just a split(' ') — so we format with spaces to match.
//
// formatCondition is the inverse of parseCondition: given the three
// user-editable parts (field, operator, value), rebuild the inline
// string. Returns an empty string when both sides are empty so the
// handler can interpret "empty condition" as "delete the field"
// consistent with parseStepFieldValue's isCondition branch.

export const formatCondition = (parts: {
  field: string;
  operator: string;
  value?: string;
}): string => {
  const field = parts.field.trim();
  const operator = parts.operator.trim();
  const value = parts.value?.trim() ?? '';

  // No field + no operator → empty string (delete the condition).
  // We allow field-only (partially typed) to round-trip as-is.
  if (!field && !operator) return '';
  if (!field) return '';
  if (!operator) return field;
  if (UNARY_OPS.has(operator as ConditionOp)) {
    return `${field} ${operator}`;
  }
  if (!value) return `${field} ${operator}`;
  return `${field} ${operator} ${value}`;
};

// ────────────────────────────────────────────────────────────────
// Metadata editing: CSV <-> array helpers
// ────────────────────────────────────────────────────────────────
//
// The meta editor represents `supported_platforms` and `tags` as a
// single comma-separated text input. On input, we split and trim.
// On render, we join with ", ". Both helpers are pure.

/** Split a comma-separated string into a trimmed array, dropping
 *  empty entries so `"a, , b"` → `['a', 'b']`. */
export const parseCSV = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

/** Join an array into a comma-separated string for display in a
 *  text input. Non-string elements are coerced via `String()` so
 *  the function stays total. */
export const formatCSV = (arr: unknown): string => {
  if (!Array.isArray(arr)) return '';
  return arr.map((x) => String(x)).join(', ');
};

/** Validate a proposed step rename against an editing snapshot.
 *  Returns ok=true when the new id is safe to use, otherwise ok=false
 *  with a one-line error message the UI can surface. The validation
 *  rules mirror what the recipe validator catches at save time, so
 *  the user gets immediate feedback before the rewrite even runs. */
export const validateStepIdRename = (
  allStepIds: string[],
  oldId: string,
  newId: string,
): { ok: true } | { ok: false; error: string } => {
  if (newId === oldId) return { ok: true };
  const trimmed = newId.trim();
  if (!trimmed) return { ok: false, error: 'A step id cannot be blank' };
  if (!/^[a-z][a-z0-9_]*$/.test(trimmed)) {
    return {
      ok: false,
      error: 'A step id has to start with a letter, and use only lower-case letters, numbers and underscores',
    };
  }
  if (RESERVED_STEP_IDS.has(trimmed)) {
    return {
      ok: false,
      error: `'${trimmed}' is a reserved namespace id`,
    };
  }
  if (allStepIds.includes(trimmed)) {
    return {
      ok: false,
      error: `Another step is already named '${trimmed}'`,
    };
  }
  return { ok: true };
};
