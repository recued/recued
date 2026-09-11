/** Shared execution/preparation config layering. This only merges values;
 * callers perform the existing dish liveness and ownership checks first.
 * A resumed/frozen run skips this merge entirely. */
export const mergeRecipeConfigLayers = (input: {
  requested?: Record<string, unknown>;
  install?: Record<string, unknown>;
  bound_dish?: { config_overlay: Record<string, unknown>; group_overlay?: Record<string, unknown> };
}): Record<string, unknown> => input.bound_dish
  ? { ...(input.requested ?? {}), ...(input.bound_dish.group_overlay ?? {}), ...input.bound_dish.config_overlay }
  : { ...(input.install ?? {}), ...(input.requested ?? {}) };
