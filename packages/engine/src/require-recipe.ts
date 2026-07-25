/** D-182 §6/§10 step 7 — `ExecutionContext.recipe` became OPTIONAL so a raw op
 *  the LLM calls without a recipe (§8) can form a recipe-less context that the
 *  Gateway still audits at the op level.
 *
 *  The recipe-EXECUTION engine — `executeRecipe`, prefetch, the sequential step
 *  loop, the lane governor — only ever runs on the recipe-ORIGIN path: a raw op
 *  reaches the Gateway (`runCatalogOperation`) directly and never enters this
 *  loop. So every one of those functions requires the recipe by construction.
 *  `requireRecipe` makes that invariant explicit and narrows the optional type
 *  for the call site, instead of scattering `ctx.recipe!` non-null assertions or
 *  `?.` fallbacks that would falsely imply the loop supports a recipe-less run.
 *
 *  It THROWS (an internal contract violation — the caller wired no recipe into a
 *  recipe-run entry, not a user-content error like a malformed recipe, which the
 *  validator still surfaces as an `ExecutionResult` error). No existing caller
 *  reaches it: `recipe` was a required field before this slice, so the
 *  recipe-origin path is byte-for-byte unchanged. */
import type { RecipeDefinition } from '@recued/contracts';
import type { ExecutionContext } from './types.js';

export const requireRecipe = (ctx: ExecutionContext): RecipeDefinition => {
  if (ctx.recipe === undefined) {
    throw new Error(
      'engine: the recipe-execution path requires ctx.recipe — a raw-op '
        + '(recipe-less) context never runs a recipe; it dispatches through the '
        + 'Gateway directly.',
    );
  }
  return ctx.recipe;
};
