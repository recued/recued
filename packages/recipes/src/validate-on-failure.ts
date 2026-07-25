/** D-116 — install-time validator for the `on_failure` binding.
 *
 *  The structural validator (`validate/structural.ts:validateOnFailure`)
 *  covers checks that read only the recipe object — shape, self-loop,
 *  config-shape. This module runs at install time and needs registry
 *  I/O to verify the referenced handler is installed, reactive, and
 *  has a `recipe-watcher` step.
 *
 *  Pure function: caller supplies the registry lookup. Tests mock it
 *  directly; the server runtime wires the real install registry.
 */

import type { RecipeDefinition } from '@recued/contracts';

/** Minimal shape the install-time check needs from the install
 *  registry. A closure over `installRegistry.getInstalled(id)?.recipe`
 *  is the typical caller. Returns null for unknown ids (handler not
 *  installed yet) so the check can surface the typed error. */
export type OnFailureHandlerLookup = (recipe_id: string) => RecipeDefinition | null;

export interface OnFailureInstallIssue {
  code:
    | 'ON_FAILURE_HANDLER_UNKNOWN'
    | 'ON_FAILURE_HANDLER_NOT_REACTIVE'
    | 'ON_FAILURE_HANDLER_MISSING_WATCHER';
  recipe_id: string;
  handler_recipe_id: string;
  message: string;
}

const hasRecipeWatcher = (handler: RecipeDefinition): boolean =>
  Array.isArray(handler.trigger_steps)
  && handler.trigger_steps.some((s) => {
    const step = s as unknown as Record<string, unknown>;
    return step.ingredient === 'recipe-watcher';
  });

/** Verify the handler reference on `recipe.on_failure` is installable.
 *  Returns null when the binding is absent or already valid; otherwise
 *  an issue describing exactly what's wrong so the install dialog can
 *  surface the error code + message to the user. */
export const checkOnFailureInstallable = (
  recipe: RecipeDefinition,
  lookup: OnFailureHandlerLookup,
): OnFailureInstallIssue | null => {
  const binding = recipe.on_failure;
  if (!binding || typeof binding.recipe_id !== 'string' || !binding.recipe_id) return null;

  const handler = lookup(binding.recipe_id);
  if (!handler) {
    return {
      code: 'ON_FAILURE_HANDLER_UNKNOWN',
      recipe_id: recipe.recipe_id,
      handler_recipe_id: binding.recipe_id,
      message: `on_failure handler "${binding.recipe_id}" is not installed — install it before "${recipe.recipe_id}"`,
    };
  }
  if (!Array.isArray(handler.trigger_steps) || handler.trigger_steps.length === 0) {
    return {
      code: 'ON_FAILURE_HANDLER_NOT_REACTIVE',
      recipe_id: recipe.recipe_id,
      handler_recipe_id: binding.recipe_id,
      message: `on_failure handler "${binding.recipe_id}" is not reactive — add trigger_steps with a recipe-watcher step`,
    };
  }
  if (!hasRecipeWatcher(handler)) {
    return {
      code: 'ON_FAILURE_HANDLER_MISSING_WATCHER',
      recipe_id: recipe.recipe_id,
      handler_recipe_id: binding.recipe_id,
      message: `on_failure handler "${binding.recipe_id}" has no recipe-watcher step — the engine cannot route the failure signal`,
    };
  }
  return null;
};

/** Collect every source recipe that binds its `on_failure` to the
 *  given handler. Used by the recipe-watcher runtime to augment the
 *  handler's filter — when the handler's tick evaluates its
 *  recipe-watcher step, the watcher only fires for failures of the
 *  bound sources (not every failed recipe in the audit log). */
export const failureSourcesFor = (
  handler_recipe_id: string,
  installed: readonly RecipeDefinition[],
): string[] => {
  const out: string[] = [];
  for (const r of installed) {
    if (r.on_failure?.recipe_id === handler_recipe_id) out.push(r.recipe_id);
  }
  return out;
};
