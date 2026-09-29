/** Shared Run | Schedule modal — pure model (no DOM).
 *
 *  Lifted verbatim from the recipes-route run modal so behaviour is
 *  identical: `parseRunConfig` + `runTargetGate` are the same JSON-object
 *  guard and design-§8 targeting derivation the server re-checks. Kept
 *  DOM-free so the gate + state transitions are unit-testable.
 */

import {
  assessRunTargets,
  deriveRecipeTargeting,
  DEFAULT_MISSED_SCHEDULE_POLICY,
  type EventTrigger,
  type ServerRecipeListEntry,
  type ServerSchedule,
} from '@recued/contracts';

import type { RunModalMailFactDraft, RunModalState, RunModalTab } from './types.js';

/** Display name for a recipe row — its metadata name, else its id. */
export const recipeDisplayName = (entry: ServerRecipeListEntry): string =>
  entry.recipe.metadata?.name?.trim() || entry.recipe_id;

/** `3 steps` / `1 step`. */
export const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? '' : 's'}`;

const isNonEmptyObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parse the raw-JSON config field. Empty → `{}`; non-object → throws
 *  (surfaced as the run error). */
export const parseRunConfig = (text: string): Record<string, unknown> => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!isNonEmptyObject(parsed)) {
    throw new Error('Run config must be a JSON object.');
  }
  return parsed;
};

/** Targeting guard (design § 8) — the run tab's gate for one snapshot:
 *  the derived targets, the `context` object the filled inputs build, and
 *  the assessment that drives the warning + Run-button disable. Config
 *  targets read the parsed config overrides (they render as variable
 *  widgets); context targets read the dedicated target inputs. Same rule
 *  set the server enforces — both call the contracts derivation. */
export const runTargetGate = (
  recipe: unknown,
  configText: string,
  targetValues: Record<string, string>,
  contextValues: Record<string, unknown> = {},
): {
  targeting: ReturnType<typeof deriveRecipeTargeting>;
  context: Record<string, unknown>;
  assessment: ReturnType<typeof assessRunTargets>;
} => {
  const targeting = deriveRecipeTargeting(recipe);
  const context: Record<string, unknown> = { ...contextValues };
  for (const [key, value] of Object.entries(targetValues)) {
    if (value.trim().length > 0) context[key] = value.trim();
    else delete context[key];
  }
  let config: Record<string, unknown> = {};
  try {
    config = parseRunConfig(configText);
  } catch {
    config = {};
  }
  return {
    targeting,
    context,
    assessment: assessRunTargets(targeting, config, context),
  };
};

/** Filter a full schedule list to one recipe's rows. */
export const recipeSchedules = (
  schedules: readonly ServerSchedule[],
  recipe_id: string,
): ServerSchedule[] => schedules.filter((s) => s.recipe_id === recipe_id);

/** Filter a full trigger list to one recipe's rows (R21 Trigger tab). */
export const recipeTriggers = (
  triggers: readonly EventTrigger[],
  recipe_id: string,
): EventTrigger[] => triggers.filter((t) => t.recipe_id === recipe_id);

/** D-315 §5.1 — the "A mail fact" form, fresh: any kind, every change. */
export const EMPTY_MAIL_FACT_DRAFT: RunModalMailFactDraft = {
  type: '',
  fields: [],
  where_variable: '',
  where_value: '',
  template_id: '',
};

/** The initial state for one open instance. */
export const initialRunModalState = (
  initialTab: RunModalTab,
  presetExpression: string,
): RunModalState => ({
  tab: initialTab,
  missed_policy: DEFAULT_MISSED_SCHEDULE_POLICY,
  config_text: '{}',
  target_values: {},
  context_values: {},
  executing: false,
  run_error: null,
  result: null,
  schedules: null,
  preset_expression: presetExpression,
  repeat: true,
  run_at_local: '',
  mutating: false,
  schedule_error: null,
  triggers: null,
  pattern_text: '',
  trigger_kind: 'pattern',
  mail_fact: EMPTY_MAIL_FACT_DRAFT,
  mail_fact_templates: null,
  mail_fact_types: [],
  trigger_mutating: false,
  trigger_error: null,
});
