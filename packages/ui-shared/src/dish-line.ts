/** D-319 — one dish, said as a line (§2.3, §5.1): the settings that tell it
 *  apart from the recipe's other dishes, what starts it, when it runs next,
 *  and whether it is On, Off, Waiting for you or Failing. The recipe page's
 *  "Running as" section says a dish this way, and Automation's list will.
 *
 *  Pure: no DOM, no rpc. A dish's rows (its triggers, schedules and auto-run
 *  timer) are passed in already read. */

import {
  describeCron,
  type AutoRunStatusEntry,
  type Dish,
  type DishLastRun,
  type EventTrigger,
  type RecipeDefinition,
  type ServerSchedule,
  type VariableDefault,
} from '@recued/contracts';

import { formatClientDateTime } from './date-time.js';
import { startPhrase } from './dish-lead.js';
import { timerNextRun, type TimeWindowSource } from './time-window.js';
import { gateStepsOf } from './timer-gate-args.js';
import { isValidValueHint, toWidgetShape } from './variable-widgets.js';

/** The rows that run as one dish. */
export interface DishRows {
  readonly triggers: readonly EventTrigger[];
  readonly schedules: readonly ServerSchedule[];
  /** Its auto-run timer, when the recipe runs on one. */
  readonly timer?: AutoRunStatusEntry;
}

/** A dish's rows out of a recipe's. */
export const rowsOfDish = (
  dish_id: string,
  all: {
    readonly triggers?: readonly EventTrigger[] | null;
    readonly schedules?: readonly ServerSchedule[] | null;
    readonly autoRun?: readonly AutoRunStatusEntry[] | null;
  },
): DishRows => {
  const timer = (all.autoRun ?? []).find((entry) => entry.dish_id === dish_id);
  return {
    triggers: (all.triggers ?? []).filter((trigger) => trigger.dish_id === dish_id),
    schedules: (all.schedules ?? []).filter((schedule) => schedule.dish_id === dish_id),
    ...(timer !== undefined ? { timer } : {}),
  };
};

export type DishStatus =
  | { readonly kind: 'on' }
  | { readonly kind: 'off' }
  /** A run is held for the owner's approval. */
  | { readonly kind: 'waiting' }
  /** The dish is on, and something of it failed (§3.3). `stopped`: the
   *  server stopped a row of it, which switching the dish on again restarts;
   *  otherwise a run failed and the next may not. */
  | { readonly kind: 'failing'; readonly reason: string; readonly stopped: boolean };

/** The one status a dish's line shows. Off is the owner's switch. A row the
 *  server stopped leaves its dish On and says it is Failing, with the reason
 *  (that first: nothing of it runs until it starts again); then a row whose
 *  last fire failed, a run held for approval (Waiting for you) and a last run
 *  that failed. */
export const dishStatus = (
  dish: Dish,
  rows: DishRows,
  last: DishLastRun | undefined,
): DishStatus => {
  if (!dish.enabled) return { kind: 'off' };
  const failing = (reason: string, stopped: boolean): DishStatus => ({ kind: 'failing', reason, stopped });
  const timer = rows.timer;
  if (timer?.auto_disabled === true) return failing(timer.last_failure_reason ?? 'It stopped after failing.', true);
  // A trigger's `last_error` clears on its next good fire, so one set means
  // its last fire failed — and, with the trigger off, that the server stopped it.
  const stoppedTrigger = rows.triggers.find((row) => !row.enabled && row.last_error !== null);
  if (stoppedTrigger !== undefined) return failing(stoppedTrigger.last_error!, true);
  const stoppedSchedule = rows.schedules.find((row) => !row.enabled && (row.consecutive_failures ?? 0) > 0);
  if (stoppedSchedule !== undefined) return failing(stoppedSchedule.last_error ?? 'It stopped after failing.', true);
  if (timer !== undefined && timer.consecutive_failures > 0) {
    return failing(timer.last_failure_reason ?? 'Its last run failed.', false);
  }
  const failedTrigger = rows.triggers.find((row) => row.last_error !== null);
  if (failedTrigger !== undefined) return failing(failedTrigger.last_error!, false);
  const failedSchedule = rows.schedules.find((row) => row.last_status === 'error');
  if (failedSchedule !== undefined) return failing(failedSchedule.last_error ?? 'Its last run failed.', false);
  if (last?.commit_status === 'awaiting_approval') return { kind: 'waiting' };
  if (last?.commit_status === 'failed') return failing('Its last run failed.', false);
  return { kind: 'on' };
};

export const DISH_STATUS_LABEL: Readonly<Record<DishStatus['kind'], string>> = {
  on: 'On',
  off: 'Off',
  waiting: 'Waiting for you',
  failing: 'Failing',
};

/** When the dish runs next on its own: its soonest schedule or timer. `null`
 *  when it has neither, or both are off. A timer with a time window runs next
 *  at its first check inside the window, read on the server's clock
 *  (`timeZone`), so `recipe` is needed to say it; without it, the next check. */
export const dishNextRun = (
  dish: Dish,
  rows: DishRows,
  opts: {
    readonly recipe?: TimeWindowSource;
    readonly timeZone?: string;
  } = {},
): number | null => {
  if (!dish.enabled) return null;
  const times = [
    ...rows.schedules
      .filter((schedule) => schedule.enabled)
      .map((schedule) => schedule.next_run_at),
    rows.timer !== undefined && rows.timer.enabled && !rows.timer.auto_disabled
      ? timerNextRun(rows.timer, opts.recipe, dish.config_overlay, opts.timeZone)
      : null,
  ].filter((at): at is number => typeof at === 'number');
  return times.length === 0 ? null : Math.min(...times);
};

const lowerFirst = (text: string): string =>
  /^[A-Z][a-z]/.test(text) ? `${text[0]!.toLowerCase()}${text.slice(1)}` : text;

const upperFirst = (text: string): string =>
  text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;

/** A schedule's cadence in words: "weekdays at 9:00 AM", "once on 3 Oct…". */
const cadenceInWords = (schedule: ServerSchedule): string =>
  schedule.mode === 'one_shot'
    ? `once on ${formatClientDateTime(schedule.run_at ?? schedule.next_run_at, {
        includeSeconds: false, includeTimeZone: false, invalidText: 'a time not set',
      })}`
    : lowerFirst(describeCron(schedule.cron_expression));

/** What starts a dish, as its line says it: the recipe's own start and the
 *  dish's schedules — "Starts when a shipment’s state changes and weekdays
 *  at 9:00 AM", "Runs daily at 9:00 AM", "Runs when you run it", "Runs every
 *  10 minutes from 8:00 to 9:00 AM on weekdays, and weekdays at 8:00 AM".
 *  `overlay`: the dish's own settings, which a timer's window may read. */
export const dishStartsLine = (
  recipe: Pick<RecipeDefinition, 'auto_run' | 'event_triggers'> & TimeWindowSource,
  schedules: readonly ServerSchedule[],
  overlay?: Readonly<Record<string, unknown>>,
): string => {
  const own = startPhrase(recipe, overlay);
  const cadences = [...new Set(schedules.map(cadenceInWords))];
  if (cadences.length === 0) return upperFirst(own);
  // A recipe that starts on nothing of its own runs on its schedules.
  if (own === 'runs when you run it') return `Runs ${cadences.join(' and ')}`;
  // A gated timer already says when ("on weekdays", "checking every minute"): a
  // comma keeps the schedule's own times from reading as part of it.
  const gated = recipe.auto_run !== undefined && gateStepsOf(recipe).length > 0;
  return upperFirst(`${own}${gated ? ', and ' : ' and '}${cadences.join(' and ')}`);
};

/** One setting of a dish, as its line shows it. */
export interface DishSetting {
  readonly key: string;
  readonly label: string;
  readonly text: string;
}

/** A setting's value as a line shows it, or `null` when it shows nothing
 *  (empty, a secret, or a reference the host cannot name). */
export type SettingValueText = (
  key: string,
  type: string,
  value: unknown,
) => string | null;

const MAX_VALUE_CHARS = 40;

const clip = (text: string): string =>
  text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…` : text;

/** The default wording of a value. A secret never shows; a file, record or
 *  mail template needs its name, which only the host can look up. */
export const plainSettingText: SettingValueText = (_key, type, value) => {
  if (type === 'secret' || type === 'file_ref' || type === 'record_ref' || type === 'mail_template') {
    return null;
  }
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : clip(value.trim());
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) {
    const items = value.filter((item) => ['string', 'number'].includes(typeof item)).map(String);
    return items.length === 0 ? null : clip(items.join(', '));
  }
  return null;
};

/** The value a dish runs with for one setting: its own, else the recipe's. */
const valueOf = (def: VariableDefault, dish: Dish, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(dish.config_overlay, key)
    ? dish.config_overlay[key]
    : isValidValueHint(def) ? def.default : def;

const sameValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The settings that tell a recipe's dishes apart (§2.3): those whose values
 *  differ between them. With one dish, its first few settings that show a
 *  value. At most `limit` per dish, in the recipe's order. */
export const settingsThatTellApart = (
  variables: Readonly<Record<string, VariableDefault>>,
  dishes: readonly Dish[],
  opts: { readonly limit?: number; readonly valueText?: SettingValueText } = {},
): Map<string, DishSetting[]> => {
  const limit = opts.limit ?? 3;
  const textOf = opts.valueText ?? plainSettingText;
  const keys = Object.keys(variables).filter((key) => {
    if (dishes.length < 2) return true;
    const def = variables[key]!;
    const first = valueOf(def, dishes[0]!, key);
    return dishes.some((dish) => !sameValue(valueOf(def, dish, key), first));
  });
  const out = new Map<string, DishSetting[]>();
  for (const dish of dishes) {
    const shown: DishSetting[] = [];
    for (const key of keys) {
      if (shown.length >= limit) break;
      const def = variables[key]!;
      const value = valueOf(def, dish, key);
      const shape = toWidgetShape(key, def, value);
      const text = textOf(key, shape.type, value);
      if (text !== null) shown.push({ key, label: shape.label, text });
    }
    out.set(dish.dish_id, shown);
  }
  return out;
};

/** A dish's name on its line. The only dish needs none unless the owner gave
 *  it one; among several, an unnamed dish is the main one (a second dish is
 *  named when it is made). */
export const dishLineName = (dish: Dish, dishCount: number): string | null => {
  if (dish.name.trim() !== '') return dish.name;
  if (dishCount < 2) return null;
  return dish.is_default ? 'Main' : 'Unnamed';
};
