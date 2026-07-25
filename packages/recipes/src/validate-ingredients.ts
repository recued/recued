/** Ingredient reference validator — async, manifest-aware.
 *
 *  Unlike the pure `validateRecipe` (which operates in isolation with
 *  no I/O), this validator loads ingredient manifests to check:
 *
 *    1. Step input keys exist in ingredient.input schema
 *    2. Required ingredient inputs (null values) are supplied by the recipe
 *    3. step.X.field references point to fields declared in ingredient.output
 *    4. Ingredient slug resolves to a manifest (ingredient exists)
 *
 *  Returns an array of IngredientIssue — each tagged with step_id,
 *  ingredient slug, and severity (error/warning/info).
 */

import type { RecipeDefinition, IngredientManifest } from '@recued/contracts';
import {
  isLockedInputKey,
  isWildcardMarker,
  matchesWildcard,
  wildcardPrefix,
} from '@recued/contracts';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface IngredientIssue {
  severity: IssueSeverity;
  step_id: string;
  ingredient: string;
  code: string;
  field?: string;
  message: string;
}

/** D-112 strict-validation flag.
 *
 *  Release N (D-112 ships): `false` — undeclared keys warn; locks
 *  still error (those are non-negotiable).
 *  Release N+1: flipped to `true` — undeclared keys error. Third-
 *  party ingredient authors have one release cycle to add wildcards
 *  or enumerate missing fields.
 *
 *  Read from `process.env.RECUED_STRICT_INPUT_VALIDATION` when the
 *  runtime exposes `process`; otherwise defaults to `false`. Tests
 *  pass an explicit override through `validateIngredientRefs` options. */
const readStrictEnv = (): boolean => {
  try {
    const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
    const v = g.process?.env?.RECUED_STRICT_INPUT_VALIDATION;
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
};

export const STRICT_INPUT_VALIDATION_DEFAULT = readStrictEnv();

export type ManifestLookup = (slug: string) => Promise<IngredientManifest | null>;

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const own = (value: Record<string, unknown>, key: string): unknown =>
  hasOwn(value, key) ? value[key] : undefined;

export interface ValidateIngredientRefsOptions {
  /** D-112 — when true, undeclared recipe keys error instead of
   *  warning. Defaults to `STRICT_INPUT_VALIDATION_DEFAULT` (reads
   *  `RECUED_STRICT_INPUT_VALIDATION` env). */
  strict?: boolean;
}

/** Validate all ingredient references in a recipe against loaded manifests. */
export const validateIngredientRefs = async (
  recipe: RecipeDefinition,
  lookupManifest: ManifestLookup,
  options: ValidateIngredientRefsOptions = {},
): Promise<IngredientIssue[]> => {
  const strict = options.strict ?? STRICT_INPUT_VALIDATION_DEFAULT;
  const issues: IngredientIssue[] = [];

  // Collect all ingredient steps (prefetch + sequential)
  const ingredientSteps: Array<{
    id: string;
    slug: string;
    input: Record<string, unknown>;
    pinnedVersion?: number;
  }> = [];

  // Skip steps whose slug is a recipe variable (e.g. the kernel
  // `run-ingredient` recipe uses `"ingredient": "{{config.ingredient_slug}}"`).
  // At validation time we can't resolve the ref; the runtime dispatches
  // the actual ingredient and surfaces INGREDIENT_NOT_FOUND then.
  const isStaticSlug = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0 && !(v.includes('{{') && v.includes('}}'));

  for (const step of recipe.prefetch_steps ?? []) {
    const s = step as unknown as Record<string, unknown>;
    const ingredient = own(s, 'ingredient');
    if (isStaticSlug(ingredient)) {
      const input = own(s, 'input');
      const pinnedVersion = own(s, 'ingredient_version');
      const id = own(s, 'id');
      ingredientSteps.push({
        id: typeof id === 'string' ? id : '',
        slug: ingredient,
        input: (typeof input === 'object' && input && !Array.isArray(input))
          ? input as Record<string, unknown>
          : {},
        pinnedVersion: typeof pinnedVersion === 'number' ? pinnedVersion : undefined,
      });
    }
  }
  for (const step of recipe.steps ?? []) {
    if (step && typeof step === 'object' && !Array.isArray(step)) {
      const s = step as Record<string, unknown>;
      const ingredient = own(s, 'ingredient');
      if (!isStaticSlug(ingredient)) continue;
      const input = own(s, 'input');
      const pinnedVersion = own(s, 'ingredient_version');
      const id = own(s, 'id');
      ingredientSteps.push({
        id: typeof id === 'string' ? id : '',
        slug: ingredient,
        input: (typeof input === 'object' && input && !Array.isArray(input))
          ? input as Record<string, unknown>
          : {},
        pinnedVersion: typeof pinnedVersion === 'number' ? pinnedVersion : undefined,
      });
    }
  }

  // Load manifests for all unique slugs
  const slugs = [...new Set(ingredientSteps.map((s) => s.slug))];
  const manifests = new Map<string, IngredientManifest | null>();
  await Promise.all(
    slugs.map(async (slug) => {
      try {
        manifests.set(slug, await lookupManifest(slug));
      } catch {
        manifests.set(slug, null);
      }
    }),
  );

  // Collect all step.X.field references across the entire recipe
  const outputRefs = collectOutputRefs(recipe);

  // Validate each ingredient step
  for (const step of ingredientSteps) {
    const manifest = manifests.get(step.slug);

    // 1. Check ingredient exists
    if (!manifest) {
      issues.push({
        severity: 'warning',
        step_id: step.id,
        ingredient: step.slug,
        code: 'ingredient_not_found',
        message: `Ingredient '${step.slug}' not found in registry — it may not be installed or published yet`,
      });
      continue;
    }

    // 2. Check version compatibility. Both `step.pinnedVersion` and
    //    `manifest.version` are positive integers per the recipe +
    //    ingredient schemas — the manifest schema version drives
    //    breaking-change detection. Service manifests use the same
    //    integer schema; binary release version lives on
    //    `input.service.binary_version` and isn't checked here.
    if (step.pinnedVersion != null && manifest.version != null) {
      if (manifest.min_version != null && step.pinnedVersion < manifest.min_version) {
        issues.push({
          severity: 'error',
          step_id: step.id,
          ingredient: step.slug,
          code: 'ingredient_breaking_change',
          message: `Ingredient '${step.slug}' has breaking changes: recipe was built against v${step.pinnedVersion}, current is v${manifest.version} (min compatible: v${manifest.min_version}). Update step input/output references.`,
        });
      } else if (step.pinnedVersion < manifest.version) {
        issues.push({
          severity: 'info',
          step_id: step.id,
          ingredient: step.slug,
          code: 'ingredient_version_behind',
          message: `Ingredient '${step.slug}' has a newer version: recipe uses v${step.pinnedVersion}, marketplace has v${manifest.version}. Check for new fields or changes.`,
        });
      }
    }

    // 3. Check input fields
    validateInputFields(step, manifest, issues, strict);

    // 4. Check output field references
    validateOutputRefs(step, manifest, outputRefs, issues);

    // 5. D-116 — nudge ai-prompt recipes off the legacy shape.
    if (step.slug === 'ai-prompt') {
      const hasLegacy = hasOwn(step.input, 'llm.system_prompt') || hasOwn(step.input, 'llm.prompt');
      const hasNew = hasOwn(step.input, 'llm.instruction_block') || hasOwn(step.input, 'llm.data_block');
      if (hasLegacy && !hasNew) {
        issues.push({
          severity: 'warning',
          step_id: step.id,
          ingredient: step.slug,
          code: 'ai_prompt_legacy_shape',
          message:
            'ai-prompt step uses legacy llm.system_prompt / llm.prompt — prefer llm.instruction_block + llm.data_block for explicit instruction/data separation. Legacy fields remain supported for back-compat.',
        });
      }
    }
  }

  return issues;
};

// ────────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────────

const validateInputFields = (
  step: { id: string; slug: string; input: Record<string, unknown> },
  manifest: IngredientManifest,
  issues: IngredientIssue[],
  strict: boolean,
): void => {
  const manifestInput = manifest.input;
  const stepInput = step.input;

  // Partition manifest keys into explicit declarations + wildcard
  // markers (D-112).
  const explicitKeys = new Set<string>();
  const wildcardPrefixes = new Set<string>();
  for (const [key, value] of Object.entries(manifestInput)) {
    if (isWildcardMarker(key, value)) {
      wildcardPrefixes.add(wildcardPrefix(key));
    } else {
      explicitKeys.add(key);
    }
  }

  // Check for required manifest inputs not supplied by the recipe.
  // Locked keys stay "required from manifest, never from recipe" — we
  // skip the required-field check for them because the engine owns
  // their resolution.
  for (const [key, defaultValue] of Object.entries(manifestInput)) {
    if (isLockedInputKey(key)) continue;
    if (isWildcardMarker(key, defaultValue)) continue;
    if (defaultValue === null && !hasOwn(stepInput, key)) {
      issues.push({
        severity: 'error',
        step_id: step.id,
        ingredient: step.slug,
        code: 'input_required',
        field: key,
        message: `Required input '${key}' is not provided — ingredient '${step.slug}' expects this field`,
      });
    }
  }

  // Check each recipe-supplied key. Engine-locked keys ALWAYS error
  // (regardless of strict flag). Unknown keys warn in permissive mode,
  // error in strict mode. Wildcard-admitted keys pass silently.
  for (const key of Object.keys(stepInput)) {
    if (isLockedInputKey(key)) {
      issues.push({
        severity: 'error',
        step_id: step.id,
        ingredient: step.slug,
        code: 'locked_input_key',
        field: key,
        message: `Recipe cannot override '${key}' — ingredient fields method / url / header.host / header.authorization / header.cookie are fixed by the engine (D-112). If you need a different target, fork or switch ingredients.`,
      });
      continue;
    }

    if (explicitKeys.has(key)) continue;
    if (matchesWildcard(key, wildcardPrefixes)) continue;

    if (strict) {
      issues.push({
        severity: 'error',
        step_id: step.id,
        ingredient: step.slug,
        code: 'undeclared_input_key',
        field: key,
        message: `Input '${key}' is not declared by ingredient '${step.slug}' (D-112 strict mode). Add the field to the manifest — or a \`prefix.*\` wildcard covering it — before recipes can use it.`,
      });
    } else {
      issues.push({
        severity: 'warning',
        step_id: step.id,
        ingredient: step.slug,
        code: 'undeclared_input_key_deprecated',
        field: key,
        message: `Input '${key}' is not declared by ingredient '${step.slug}'. This will be an error in the next release (D-112 strict mode). Add the field to the manifest or a \`${key.split('.').slice(0, -1).join('.')}.*\` wildcard.`,
      });
    }
  }
};

// ────────────────────────────────────────────────────────────────
// Output reference validation
// ────────────────────────────────────────────────────────────────

/** Collect all {{step.X.field}} references from the recipe JSON. */
const collectOutputRefs = (
  recipe: RecipeDefinition,
): Map<string, Set<string>> => {
  const refs = new Map<string, Set<string>>();
  const text = JSON.stringify(recipe);
  const re = /\{\{step\.(\w+)\.([\w.]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const stepId = m[1];
    const field = m[2];
    if (!refs.has(stepId)) refs.set(stepId, new Set());
    refs.get(stepId)!.add(field);
  }
  return refs;
};

const validateOutputRefs = (
  step: { id: string; slug: string },
  manifest: IngredientManifest,
  outputRefs: Map<string, Set<string>>,
  issues: IngredientIssue[],
): void => {
  const referencedFields = outputRefs.get(step.id);
  if (!referencedFields) return; // No references to this step's output

  const outputKeys = new Set(Object.keys(manifest.output));

  for (const field of referencedFields) {
    // Handle nested paths: step.deal.custom_fields.priority → check first segment
    const topLevel = field.split('.')[0];
    if (!outputKeys.has(topLevel) && !outputKeys.has(field)) {
      issues.push({
        severity: 'warning',
        step_id: step.id,
        ingredient: step.slug,
        code: 'output_field_unknown',
        field,
        message: `Reference '{{step.${step.id}.${field}}}' uses field '${field}' which is not declared in ingredient '${step.slug}' output — it may return undefined at runtime`,
      });
    }
  }
};
