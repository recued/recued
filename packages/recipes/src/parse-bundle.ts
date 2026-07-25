/** D-119 Phase 2 — typed `RecipeBundle` parser.
 *
 *  Wraps `parseRecipe` for the bundle envelope: validates the
 *  optional `bundle_version`, runs the recipe through `parseRecipe`,
 *  and runs each entry of the optional `ingredients` array through
 *  `validateIngredient` from `@recued/ingredients`. Issue paths from
 *  the inner validators are prefixed (`recipe.X`, `ingredients[i].X`)
 *  so the install UI can render them with their context preserved.
 *
 *  Phase 2 install paths (file-picker, URL-paste, marketplace) all
 *  funnel through this parser before the engine sees the payload.
 *  Bundles fetched from the marketplace pass with `ingredients`
 *  empty / absent (the marketplace install path resolves ingredients
 *  separately); file/URL bundles typically include them.
 */

import type { RecipeBundle, RecipeDefinition, IngredientManifest } from '@recued/contracts';
import {
  deriveExecutionScope,
  isExecutionScopeSubset,
  isRecipeBundle,
  isValidExecutionScope,
  sortExecutionScope,
} from '@recued/contracts';
import { validateIngredient } from '@recued/ingredients';
import { parseRecipe } from './parse.js';
import type { ParseResult } from './parse.js';
import type { ValidationIssue, ValidationSeverity } from './validate.js';

/** Parse an unknown input as a recipe bundle.
 *
 *  Accepts both forms produced by Phase 2 install paths:
 *    - **Wrapped**: `{ recipe, ingredients?, signature?, bundle_version? }`.
 *    - **Bare**: a `RecipeDefinition` is auto-wrapped as `{ recipe }`.
 *      This keeps the existing URL-paste path (`fetchRecipeByUrl`
 *      returns a bare recipe) compatible with the new bundle-aware
 *      flow without forcing every publisher to repackage.
 *
 *  On success the returned bundle is a normalized envelope containing
 *  only own top-level bundle fields, or a freshly-allocated `{ recipe }`
 *  wrapper for the bare-input case. */
export const parseBundle = (input: unknown): ParseResult<RecipeBundle> => {
  const issues: ValidationIssue[] = [];
  const add = (severity: ValidationSeverity, code: string, path: string, message: string): void => {
    issues.push({ severity, code, path, message });
  };

  // Top-level shape — must be a non-array object.
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    add('error', 'bundle_not_object', '', 'bundle must be an object');
    return { ok: false, issues };
  }
  const obj = input as Record<string, unknown>;

  // Auto-wrap a bare `RecipeDefinition` so the legacy URL-paste path
  // keeps working unchanged. We detect "bare recipe" by the absence
  // of a `recipe` field and presence of recipe-shaped fields.
  let bundle: RecipeBundle;
  if (!isRecipeBundle(obj)) {
    if (
      hasOwn(obj, 'recipe_id')
      && hasOwn(obj, 'steps')
      && typeof obj.recipe_id === 'string'
      && Array.isArray(obj.steps)
    ) {
      bundle = { recipe: obj as unknown as RecipeDefinition };
    } else {
      add('error', 'bundle_recipe_required', 'recipe', 'bundle must contain a recipe object (or be a bare recipe)');
      return { ok: false, issues };
    }
  } else {
    bundle = { recipe: obj.recipe as RecipeDefinition };
    if (hasOwn(obj, 'bundle_version')) {
      bundle.bundle_version = obj.bundle_version as RecipeBundle['bundle_version'];
    }
    if (hasOwn(obj, 'ingredients')) {
      bundle.ingredients = obj.ingredients as RecipeBundle['ingredients'];
    }
    if (hasOwn(obj, 'signature')) {
      bundle.signature = obj.signature as RecipeBundle['signature'];
    }
  }

  // bundle_version — only `1` is recognized today (Phase 2 ships v1).
  if (bundle.bundle_version !== undefined && bundle.bundle_version !== 1) {
    add('error', 'bundle_version_unknown', 'bundle_version', 'bundle_version must be 1 when present');
  }

  // signature — structural shape only here. Cryptographic verification
  // happens in `verifyBundleSignature` (Web Crypto). Phase 2 callers
  // run both before installing.
  if (bundle.signature !== undefined) {
    const sig = bundle.signature as Partial<RecipeBundle['signature']> & Record<string, unknown>;
    if (sig === null || typeof sig !== 'object') {
      add('error', 'signature_not_object', 'signature', 'signature must be an object');
    } else {
      if (typeof sig.algorithm !== 'string' || sig.algorithm.length === 0) {
        add('error', 'signature_algorithm_required', 'signature.algorithm', 'signature.algorithm is required');
      }
      if (typeof sig.publisher_pubkey !== 'string' || sig.publisher_pubkey.length === 0) {
        add('error', 'signature_pubkey_required', 'signature.publisher_pubkey', 'signature.publisher_pubkey is required');
      }
      if (typeof sig.signature !== 'string' || sig.signature.length === 0) {
        add('error', 'signature_value_required', 'signature.signature', 'signature.signature is required');
      }
    }
  }

  // Recipe — delegate to the existing recipe parser, prefixing paths.
  const recipeResult = parseRecipe(bundle.recipe);
  for (const issue of recipeResult.issues) {
    issues.push({ ...issue, path: prefixPath('recipe', issue.path) });
  }

  // Ingredients — optional array; each manifest goes through the
  // existing per-manifest validator.
  if (bundle.ingredients !== undefined) {
    if (!Array.isArray(bundle.ingredients)) {
      add('error', 'ingredients_not_array', 'ingredients', 'ingredients must be an array when present');
    } else {
      bundle.ingredients.forEach((manifest: IngredientManifest, idx: number) => {
        const result = validateIngredient(manifest);
        for (const issue of result.issues) {
          issues.push({
            severity: issue.severity,
            code: issue.code,
            path: prefixPath(`ingredients[${idx}]`, issue.path),
            message: issue.message,
          });
        }
      });
    }
  }

  // D-119 Phase 15 — recipe-level execution_scope check. The recipe's
  // declared scope must be a subset of the scope derived from the
  // bundled ingredients. Wider declarations error with the same
  // taxonomy as the per-ingredient check (`EXECUTION_SCOPE_TOO_WIDE`).
  // Skipped when ingredients[] is absent (marketplace install path
  // resolves manifests separately and runs the same gate then).
  validateRecipeExecutionScope(bundle, add);

  const hasError = issues.some((i) => i.severity === 'error');
  if (hasError) return { ok: false, issues };
  return { ok: true, recipe: bundle, issues };
};

const validateRecipeExecutionScope = (
  bundle: RecipeBundle,
  add: (severity: ValidationSeverity, code: string, path: string, message: string) => void,
): void => {
  const declared = bundle.recipe?.metadata?.execution_scope;
  if (declared === undefined) return;
  if (!isValidExecutionScope(declared)) {
    add('error', 'execution_scope_shape', 'recipe.metadata.execution_scope',
      'execution_scope must be a non-empty array of unique values from {"device","server"}');
    return;
  }
  // Without bundled ingredients the bundle parser cannot derive the
  // recipe's scope — defer to the install-time gate (which has the
  // resolved manifests). Skipping here keeps marketplace bundles
  // (which omit `ingredients[]`) lint-clean at parse time.
  if (!Array.isArray(bundle.ingredients) || bundle.ingredients.length === 0) return;
  const derived = deriveExecutionScope(bundle.ingredients);
  if (!isExecutionScopeSubset(declared, derived)) {
    add('error', 'EXECUTION_SCOPE_TOO_WIDE', 'recipe.metadata.execution_scope',
      `execution_scope ${JSON.stringify(sortExecutionScope(declared))} is wider than the scope derived from bundled ingredients ${JSON.stringify(derived)} — narrow the declaration or change the ingredients`);
  }
};

const prefixPath = (prefix: string, suffix: string): string => {
  if (!suffix) return prefix;
  if (suffix.startsWith('[')) return `${prefix}${suffix}`;
  return `${prefix}.${suffix}`;
};

const hasOwn = <K extends string>(
  obj: Record<string, unknown>,
  key: K,
): obj is Record<K, unknown> & Record<string, unknown> =>
  Object.prototype.hasOwnProperty.call(obj, key);
