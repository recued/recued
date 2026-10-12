/** The settings a run that starts on its own needs (D-319 amendment, 2026-10-11).
 *
 *  The owner: *"scheduled runs should require the necessary fields for any
 *  recipes to run properly, that should apply to all recipes."* A schedule, a
 *  trigger or the auto-run timer starts a run nobody is there to ask, and the
 *  owner's own run fills what such a run cannot (an empty "Send from",
 *  `mailSenderSettings`). So a dish that runs on its own must hold every setting
 *  its recipe needs, and nothing checked that: not the server when such a start
 *  was armed, and not the run, which went ahead with the setting undefined and
 *  failed wherever the recipe first needed it.
 *
 *  🔑 ONE READER, for the server that refuses and the screens that ask:
 *  - a setting declared with no default and not optional, unless the recipe
 *    reads it where empty is a working path — a step's `skip_when`, the value of
 *    a `default` step, or one of a `coalesce` step's values;
 *  - a setting a guard or `fail_on` refuses the run without
 *    ({@link guardRequiredVariables}, which leaves out a check on a step skipped
 *    whenever the setting is empty).
 *  Not a connection setting: D-320 settles connections, and refuses an
 *  unattended run it cannot (`connection_target_unpinned`).
 *
 *  "Empty" is what a recipe's own `is_empty` says (`@recued/transforms`
 *  `evaluateOp`): absent, null, `''`, an empty list. */

import type { RecipeDefinition } from '@recued/contracts';

import { guardRequiredVariables } from './chat-catalog.js';

export interface NeededSetting {
  readonly key: string;
  /** The setting's label, as the dish form shows it; its key when it has none. */
  readonly label: string;
}

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

const hintOf = (spec: unknown): Record<string, unknown> | undefined =>
  spec !== null && typeof spec === 'object' && !Array.isArray(spec) ? spec as Record<string, unknown> : undefined;

/** Settings the recipe reads where an empty value is a working path. */
const readWhereEmptyWorks = (recipe: RecipeDefinition): ReadonlySet<string> => {
  const steps = [
    ...((recipe.prefetch_steps ?? []) as unknown as Array<Record<string, unknown>>),
    ...((recipe.steps ?? []) as unknown as Array<Record<string, unknown>>),
    ...((recipe.trigger_steps ?? []) as unknown as Array<Record<string, unknown>>),
  ];
  const blobs = steps.flatMap((step) => [
    step.skip_when,
    step.transform === 'default' ? step.value : undefined,
    step.transform === 'coalesce' ? step.values : undefined,
  ]).filter((part) => part !== undefined).map((part) => JSON.stringify(part));
  const read = new Set<string>();
  for (const key of Object.keys(recipe.variables ?? {})) {
    const ref = new RegExp(`\\{\\{\\s*config\\.${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[}|.:]`);
    if (blobs.some((blob) => ref.test(blob))) read.add(key);
  }
  return read;
};

/** Every setting a run that starts on its own needs, in declaration order. */
export const settingsNeededUnattended = (recipe: RecipeDefinition): NeededSetting[] => {
  const variables = (recipe.variables ?? {}) as Record<string, unknown>;
  const guarded = guardRequiredVariables(recipe);
  const optionalWhenEmpty = readWhereEmptyWorks(recipe);
  const needed: NeededSetting[] = [];
  for (const [key, spec] of Object.entries(variables)) {
    const hint = hintOf(spec);
    if (hint?.type === 'connection') continue;
    const declared = spec === null || (hint !== undefined && hint.optional !== true && hint.default === undefined);
    if (!guarded.has(key) && !(declared && !optionalWhenEmpty.has(key))) continue;
    const label = typeof hint?.label === 'string' && hint.label.trim() !== '' ? hint.label.trim() : key;
    needed.push({ key, label });
  }
  return needed;
};

/** The settings a run on its own needs that `config` leaves empty. A setting's
 *  declared default fills it, as the engine does before the first step. */
export const missingUnattendedSettings = (
  recipe: RecipeDefinition,
  config: Readonly<Record<string, unknown>>,
): NeededSetting[] => {
  const variables = (recipe.variables ?? {}) as Record<string, unknown>;
  return settingsNeededUnattended(recipe).filter(({ key }) => {
    if (!isEmpty(config[key])) return false;
    const spec = variables[key];
    const hint = hintOf(spec);
    return isEmpty(hint !== undefined ? hint.default : spec);
  });
};

/** One sentence naming what to fill, for a refusal the owner reads. */
export const describeMissingUnattended = (missing: readonly NeededSetting[]): string =>
  missing.map((setting) => `"${setting.label}"`).join(', ');
