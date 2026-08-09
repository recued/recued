/** Typed recipe parser.
 *
 *  `parseRecipe(input)` is the returnable form of `assertValidRecipe`:
 *  it runs the full validator, and instead of throwing on failure, it
 *  returns a discriminated result. On success, the input is narrowed to
 *  `RecipeDefinition`; on failure, all error-severity issues are returned
 *  so the caller can render them.
 *
 *  Use `parseRecipe` in control flow where the caller wants to branch on
 *  success/failure (install flow, Kitchen editor, marketplace publish).
 *  Use `assertValidRecipe` in scripts that should fail fast on bad input
 *  (build-time checks, CI validators).
 *
 *  On success, warnings and info issues are still surfaced via the result
 *  so consumers can display them even though they don't block parsing.
 */

import type { OutputSection, RecipeDefinition } from '@recued/contracts';
import { validateRecipe, type ValidationIssue } from './validate.js';

export type ParseResult<T> =
  | {
      ok: true;
      /** The validated recipe, narrowed from `unknown` to `RecipeDefinition`. */
      recipe: T;
      /** Non-blocking diagnostics (warn + info). May be empty. */
      issues: ValidationIssue[];
    }
  | {
      ok: false;
      /** All issues produced by the validator, including the errors that
       *  caused the failure. Never empty when `ok === false`. */
      issues: ValidationIssue[];
    };

const normalizeOutputRenderAlias = (recipe: RecipeDefinition): void => {
  const output = recipe.output as RecipeDefinition['output'] & {
    render?: OutputSection[];
    sidebar?: OutputSection[];
    exchange?: unknown;
  };
  // ⛔ D-232 § 19.3 — A FIRING RECIPE GETS NO PHANTOM RENDER. This function
  // grafts `render: []` onto anything lacking one, which for every other recipe
  // is the harmless canonical shape. On an `output.exchange` recipe it invents
  // the very key that result-XOR-fire forbids, and the NEXT parse — install
  // normalizes, then the run re-parses — refuses the recipe the installer just
  // accepted. Found exactly that way: the migrated peer receiver validated as a
  // FILE in three artifact suites and could not run at all.
  if (output.exchange !== undefined && !Array.isArray(output.render)
    && !Array.isArray(output.sidebar)) {
    delete output.sidebar;
    return;
  }
  output.render = Array.isArray(output.render)
    ? output.render
    : Array.isArray(output.sidebar)
      ? output.sidebar
      : [];
  delete output.sidebar;
};

/** Parse an unknown input as a recipe. On success, the returned recipe is
 *  the same reference as the input (no cloning). The parser normalizes the
 *  D-195 `output.render`/legacy `output.sidebar` alias in place so downstream
 *  save/install/runtime paths see the canonical render-only shape. */
export const parseRecipe = (input: unknown): ParseResult<RecipeDefinition> => {
  const result = validateRecipe(input);
  if (result.valid) {
    const recipe = input as RecipeDefinition;
    normalizeOutputRenderAlias(recipe);
    return {
      ok: true,
      recipe,
      issues: result.issues, // warn + info only, since valid === true
    };
  }
  return {
    ok: false,
    issues: result.issues,
  };
};

/** Filter a result's issues by severity. Convenience for rendering. */
export const issuesBySeverity = (
  result: ParseResult<unknown>,
  severity: 'error' | 'warn' | 'info',
): ValidationIssue[] => result.issues.filter((i) => i.severity === severity);
