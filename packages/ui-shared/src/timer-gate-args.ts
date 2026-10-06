/** A timer recipe's gates, read as a run reads them (2026-10-05).
 *
 *  A timer recipe checks every N minutes; its `trigger_steps` decide whether a
 *  check runs it: a `core.watch.time` window, or a watcher on data (a time
 *  before a record's date, a page). Saying when the recipe really runs means reading those
 *  steps with the values the dish runs with. Shared by `time-window.ts` and
 *  `timer-events.ts`. */

import type { RecipeDefinition, VariableDefault } from '@recued/contracts';

import { isValidValueHint } from './variable-widgets.js';

/** What a timer's gates are read from: the recipe's `trigger_steps` and its
 *  defaults (`variables`). Both optional, as the screens' views carry them. */
export type TimeWindowSource = Partial<Pick<RecipeDefinition, 'trigger_steps' | 'variables'>>;

/** The watchers a trigger step can be, by op id and by ingredient slug. */
export type WatcherKind = 'time' | 'time-relative' | 'http';

const BY_OP: Readonly<Record<string, WatcherKind>> = {
  'core.watch.time': 'time',
  'core.watch.time-relative': 'time-relative',
  'core.watch.http': 'http',
};

const BY_INGREDIENT: Readonly<Record<string, WatcherKind>> = {
  'time-watcher': 'time',
  'time-relative-watcher': 'time-relative',
  'http-watcher': 'http',
};

/** One trigger step, as far as a gate reading needs it. */
export interface GateStep {
  readonly kind: WatcherKind | null;
  readonly args: Readonly<Record<string, unknown>>;
}

/** The recipe's trigger steps: which watcher each is (`null`: not a watcher),
 *  and its arguments. */
export const gateStepsOf = (recipe: TimeWindowSource): GateStep[] =>
  ((recipe.trigger_steps ?? []) as ReadonlyArray<Record<string, unknown> | null | undefined>)
    .filter((step): step is Record<string, unknown> => step !== null && typeof step === 'object')
    .map((step) => ({
      kind: (typeof step.op === 'string' ? BY_OP[step.op] : undefined)
        ?? (typeof step.ingredient === 'string' ? BY_INGREDIENT[step.ingredient] : undefined)
        ?? null,
      args: ((step.args ?? step.input ?? {}) as Record<string, unknown>),
    }));

const CONFIG_REF = /^\{\{\s*config\.([A-Za-z0-9_]+)\s*\}\}$/;

/** A value the screen cannot read: worked out at run time. */
export const GATE_ARG_UNREADABLE = Symbol('unreadable');

/** A gate argument's value: a literal, or a pure `{{config.<key>}}` read from
 *  the dish's own settings, else the recipe's default — as a run resolves it.
 *  Any other reference is worked out at run time: {@link GATE_ARG_UNREADABLE}. */
export const gateArgValue = (
  raw: unknown,
  recipe: TimeWindowSource,
  overlay: Readonly<Record<string, unknown>> | undefined,
): unknown => {
  if (typeof raw !== 'string') return raw;
  if (!raw.includes('{{')) return raw;
  const ref = CONFIG_REF.exec(raw.trim());
  if (ref === null) return GATE_ARG_UNREADABLE;
  const key = ref[1]!;
  if (overlay !== undefined && Object.prototype.hasOwnProperty.call(overlay, key)) return overlay[key];
  const def = (recipe.variables as Readonly<Record<string, VariableDefault>> | undefined)?.[key];
  if (def === undefined) return undefined;
  return isValidValueHint(def) ? def.default : def;
};

/** "a", "a and b", "a, b and c". */
export const joinWords = (words: readonly string[]): string =>
  words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
