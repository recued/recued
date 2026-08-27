import type { AutoRunStatusEntry } from '@recued/contracts';

/** The action a recipe can safely offer before its trigger conditions exist. */
export type RecipeActionKind = 'manual' | 'autorun' | 'managed-reactive';

/** The auto-run arm state, derived from the `auto_run.list` entry. */
export type AutoRunState = 'armed' | 'paused' | 'tripped' | 'off';

export interface RecipeReactiveShape {
  auto_run?: unknown;
  event_triggers?: unknown;
  trigger_steps?: unknown;
}

/** Trigger-driven recipes are lifecycle-managed, not manually runnable. An
 * `auto_run` definition has an arm state; event-only recipes are managed in
 * Automation. Empty trigger arrays do not make an otherwise manual recipe
 * reactive. */
export const classifyRecipeAction = (
  def: RecipeReactiveShape,
): RecipeActionKind => {
  if (def.auto_run !== undefined) return 'autorun';
  const eventTriggers = Array.isArray(def.event_triggers)
    ? def.event_triggers.length
    : 0;
  const triggerSteps = Array.isArray(def.trigger_steps)
    ? def.trigger_steps.length
    : 0;
  return eventTriggers > 0 || triggerSteps > 0 ? 'managed-reactive' : 'manual';
};

/** Map an `auto_run.list` entry (or its absence) to the arm state. */
export const autoRunStateOf = (
  entry: AutoRunStatusEntry | undefined,
): AutoRunState => {
  if (entry === undefined) return 'off';
  if (entry.auto_disabled) return 'tripped';
  if (!entry.enabled) return 'paused';
  return 'armed';
};

/** The toggle button for an arm state: its label + the `enabled` it sets. */
export const autoRunToggle = (
  state: AutoRunState,
): { label: string; nextEnabled: boolean } => {
  if (state === 'armed') return { label: 'Pause', nextEnabled: false };
  if (state === 'tripped') return { label: 'Re-arm', nextEnabled: true };
  return { label: 'Arm', nextEnabled: true }; // off | paused
};
