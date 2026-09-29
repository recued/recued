/** Recipe-editor step-shape logic (D-148 salvage).
 *
 *  The PURE half of the retired extension's `kitchen/template-steps.ts`
 *  (`c222acac~1`): step-kind discrimination, the 14-operator condition-builder
 *  table, transform/ingredient param enumeration, and field-type detection.
 *  The original file's renderers emitted extension chrome (`e`, ui-shared
 *  `typedField`) — those are reimplemented as imperative DOM in the inspector;
 *  only this seam-only logic carried over.
 *
 *  Drift fix vs the original: the source `detectStepKind` predates D-182's
 *  `CanonicalOpStep` and would mis-classify an `op:` step as `ingredient`. We
 *  add an explicit `op` branch (via `isCanonicalOpStep`) so a loaded op-step
 *  recipe is recognised and shown read-only with an "author via a pack" notice
 *  — inline authoring mints only transform/ingredient/guard. */

import type {
  RecipeStep,
  PrefetchStep,
  ConditionOp,
  IngredientManifest,
} from '@recued/contracts';
import { isCanonicalOpStep } from '@recued/contracts';
import { getTransformSchema, type ParamDef } from '@recued/transforms';

/** Resolves an ingredient slug to its manifest so the inspector can surface
 *  D-112 lock / wildcard / undeclared-key state for ingredient steps. Return
 *  undefined for unknown slugs — the renderer falls back to plain param
 *  enumeration without D-112 awareness. */
export type ManifestLookup = (slug: string) => IngredientManifest | undefined;

/** Human-legible operator labels for the condition-builder dropdown, in
 *  display order (most-common first). Matches the 14 `ConditionOp`s exactly. */
export const CONDITION_OP_LABELS: ReadonlyArray<{ op: ConditionOp; label: string }> = [
  { op: 'equal',            label: '=' },
  { op: 'not_equal',        label: '≠' },
  { op: 'greater',          label: '>' },
  { op: 'greater_or_equal', label: '≥' },
  { op: 'less',             label: '<' },
  { op: 'less_or_equal',    label: '≤' },
  { op: 'contains',         label: 'contains' },
  { op: 'not_contains',     label: 'not contains' },
  { op: 'in',               label: 'in' },
  { op: 'not_in',           label: 'not in' },
  { op: 'is_null',          label: 'is null' },
  { op: 'is_not_null',      label: 'is not null' },
  { op: 'is_empty',         label: 'is empty' },
  { op: 'is_not_empty',     label: 'is not empty' },
];

/** Step kinds the inspector renders. `op` is read-only (inline-unauthorable);
 *  the other three are fully editable. */
export type StepKind = 'transform' | 'ingredient' | 'guard' | 'op';

/** Discriminate the step shape. Contracts allow exactly one discriminator key;
 *  we check transform/guard first (cheap key probes), then `op` (a
 *  `CanonicalOpStep` — `op:` present, none of transform/ingredient/guard), and
 *  default to `ingredient`. */
export const detectStepKind = (step: RecipeStep): StepKind => {
  if (typeof (step as { transform?: unknown }).transform === 'string') return 'transform';
  if (typeof (step as { guard?: unknown }).guard === 'string') return 'guard';
  if (isCanonicalOpStep(step)) return 'op';
  return 'ingredient';
};

/** Pull the discriminator string (transform name / ingredient slug / guard
 *  name / op id) for the inspector header. Always a string for display. */
export const getStepDiscriminator = (step: RecipeStep): string => {
  const kind = detectStepKind(step);
  if (kind === 'transform') return String((step as { transform: string }).transform);
  if (kind === 'guard') return String((step as { guard: string }).guard);
  if (kind === 'op') return String((step as { op: string }).op);
  return String((step as { ingredient: string }).ingredient);
};

/** Is this value a template reference (e.g. "{{step.x}}") rather than a
 *  literal? References must NOT be edited as plain values — the user would
 *  clobber the reference. The renderer shows them read-only. */
export const isReference = (value: unknown): boolean =>
  typeof value === 'string' && /\{\{[^}]+\}\}/.test(value);

/** Field-level type used to pick the right input element. 'unsupported' covers
 *  arrays/objects/refs, which the inline editor shows read-only. */
export type StepFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'unsupported';

/** Decide how to render a transform / ingredient param: a template reference →
 *  unsupported (read-only); a schema enum → enum; otherwise the runtime JS
 *  type; arrays / objects / null → unsupported. */
export const detectStepFieldType = (
  value: unknown,
  paramDef?: ParamDef,
): StepFieldType => {
  if (isReference(value)) return 'unsupported';
  if (paramDef?.enum && paramDef.enum.length > 0) return 'enum';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'unsupported';
};

/** Reserved param names on a transform step that are NOT user-facing params —
 *  the discriminator / control fields (BaseStep + TransformStep). */
const TRANSFORM_RESERVED_KEYS = new Set([
  'id', 'transform', 'skip_when', 'fail_on', 'stop_when', 'cache',
]);

/** Walk a transform step and return [name, value, ParamDef?] for every
 *  editable / inspectable param. Schema-known params come first (declared
 *  order), then extras the recipe set that the schema doesn't know about. */
export const enumerateTransformParams = (
  step: RecipeStep,
): Array<{ name: string; value: unknown; def?: ParamDef }> => {
  if (detectStepKind(step) !== 'transform') return [];
  const transformName = (step as { transform: string }).transform;
  const schema = getTransformSchema(transformName);
  const out: Array<{ name: string; value: unknown; def?: ParamDef }> = [];
  const seen = new Set<string>();

  if (schema) {
    for (const name of Object.keys(schema)) {
      if (TRANSFORM_RESERVED_KEYS.has(name)) continue;
      out.push({ name, value: (step as Record<string, unknown>)[name], def: schema[name] });
      seen.add(name);
    }
  }
  for (const key of Object.keys(step)) {
    if (TRANSFORM_RESERVED_KEYS.has(key)) continue;
    if (seen.has(key)) continue;
    out.push({ name: key, value: (step as Record<string, unknown>)[key] });
  }
  return out;
};

/** Walk an ingredient step's `input` map → [name, value] per entry. Returns []
 *  when input is missing / non-object. */
export const enumerateIngredientInputs = (
  step: RecipeStep | PrefetchStep,
): Array<{ name: string; value: unknown }> => {
  const input = (step as { input?: unknown }).input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  return Object.entries(input as Record<string, unknown>).map(
    ([name, value]) => ({ name, value }),
  );
};

/** Walk a canonical op-step's `args` map → [name, value] per entry (read-only
 *  display; op-steps aren't inline-editable). Returns [] when args is
 *  missing / non-object. */
export const enumerateOpArgs = (
  step: RecipeStep,
): Array<{ name: string; value: unknown }> => {
  const args = (step as { args?: unknown }).args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return Object.entries(args as Record<string, unknown>).map(
    ([name, value]) => ({ name, value }),
  );
};
