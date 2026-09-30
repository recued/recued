/** Shared execution/preparation config layering. This only merges values;
 * callers perform the existing dish liveness and ownership checks first.
 * A resumed/frozen run skips this merge entirely.
 *
 * D-319 — lowest first:
 *  - a run AS a dish: its group's ‹ the dish's ‹ the values given for this
 *    run ("change values for one run");
 *  - a run with NO dish: the recipe's main dish's (`install`) ‹ the values
 *    given for this run. */
export const mergeRecipeConfigLayers = (input: {
  requested?: Record<string, unknown>;
  install?: Record<string, unknown>;
  bound_dish?: { config_overlay: Record<string, unknown>; group_overlay?: Record<string, unknown> };
}): Record<string, unknown> => input.bound_dish
  ? { ...(input.bound_dish.group_overlay ?? {}), ...input.bound_dish.config_overlay, ...(input.requested ?? {}) }
  : { ...(input.install ?? {}), ...(input.requested ?? {}) };
