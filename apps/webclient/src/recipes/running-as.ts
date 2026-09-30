/** D-319 §5.1 — the recipe page's "Running as" section.
 *
 *  One line per dish (a dish is the recipe switched on with its settings):
 *  its name — none while it is the only dish — the settings that tell it
 *  apart, what starts it in words, its last and next run, and its status.
 *  Each line offers its switch, Settings, and a menu: Run once as this, Add a
 *  schedule, Make this the main one, Remove. With no dish, a recipe that
 *  starts on its own offers Switch on and a manual one Save settings; "+ Add
 *  another" appears once there is a dish.
 *
 *  Pure markup from a snapshot. The route owns the state and the rpc, and
 *  reads the action a click names from `RUNNING_AS_ACTION_ATTR` and the dish
 *  from `RUNNING_AS_DISH_ATTR` on the same button. */

import type {
  AutoRunStatusEntry,
  Dish,
  DishLastRun,
  EventTrigger,
  RecipeDefinition,
  ServerSchedule,
} from '@recued/contracts';
import {
  e,
  dishLineName,
  dishNextRun,
  dishStartsLine,
  dishStatus,
  formatClientDateTime,
  rowsOfDish,
  settingsThatTellApart,
  whatStartsIt,
  type SettingValueText,
} from '@recued/ui-shared';

/** The section. Value = recipe_id. */
export const RUNNING_AS_ATTR = 'data-recued-running-as';
/** A dish's line, and every control on it. Value = dish_id. */
export const RUNNING_AS_DISH_ATTR = 'data-recued-running-as-dish';
/** What a control does. Value = a `RunningAsAction`. */
export const RUNNING_AS_ACTION_ATTR = 'data-recued-running-as-action';
/** A line's status. Value = `on` / `off` / `waiting` / `failing`. */
export const RUNNING_AS_STATUS_ATTR = 'data-recued-running-as-status';
/** A recipe-level control (Switch on, Save settings, + Add another). Value =
 *  recipe_id, so a related recipe's row can offer the same Switch on. */
export const RUNNING_AS_RECIPE_ATTR = 'data-recued-running-as-recipe';

export type RunningAsAction =
  /** No dish yet, and the recipe starts on its own: the switch-on form. */
  | 'switch-on'
  /** No dish yet, and the recipe runs when the owner runs it: the same form. */
  | 'save-settings'
  /** "+ Add another": the form, for a second dish. */
  | 'add'
  | 'toggle-on'
  | 'toggle-off'
  | 'settings'
  /** Open or close a line's menu. */
  | 'menu'
  | 'run'
  | 'schedule'
  | 'make-main'
  /** A dish On whose row the server stopped: switching it on again restarts it. */
  | 'rearm'
  /** Remove asks first; the answer is one of the next two. */
  | 'remove'
  | 'remove-confirm'
  | 'remove-cancel';

export const RUNNING_AS_ACTIONS: ReadonlySet<string> = new Set<RunningAsAction>([
  'switch-on', 'save-settings', 'add', 'toggle-on', 'toggle-off', 'settings', 'menu',
  'run', 'schedule', 'make-main', 'rearm', 'remove', 'remove-confirm', 'remove-cancel',
]);

export interface RunningAsView {
  readonly recipe_id: string;
  /** The recipe's own name: an unnamed dish's switch says what it switches. */
  readonly recipe_name: string;
  readonly recipe: Pick<RecipeDefinition, 'variables' | 'auto_run' | 'event_triggers'>;
  /** This recipe's dishes; `null` when they could not be read (the section
   *  stays quiet rather than claiming there are none). */
  readonly dishes: readonly Dish[] | null;
  readonly lastRuns: Readonly<Record<string, DishLastRun>>;
  readonly schedules: readonly ServerSchedule[] | null;
  readonly triggers: readonly EventTrigger[] | null;
  readonly autoRun: readonly AutoRunStatusEntry[] | null;
  /** What the host can do; a missing caller renders no dead button. */
  readonly can: {
    readonly create: boolean;
    readonly update: boolean;
    readonly remove: boolean;
    readonly run: boolean;
    readonly schedule: boolean;
  };
  /** Dishes with a change in flight (`''` = switching the recipe on). */
  readonly busy: ReadonlySet<string>;
  readonly openMenu: string | null;
  readonly confirmingRemove: string | null;
  /** Per dish; `''` for the recipe's own. */
  readonly errors: ReadonlyMap<string, string>;
  /** Where "See why" leads for a failing dish. */
  readonly failureHref?: string;
  /** Names a setting's value the plain wording cannot (a mail template). */
  readonly valueText?: SettingValueText;
}

const when = (at: number): string =>
  formatClientDateTime(at, { includeSeconds: false, includeTimeZone: false });

/** True when the recipe starts on its own (a trigger it declares, or a timer). */
export const startsOnItsOwn = (
  recipe: Pick<RecipeDefinition, 'auto_run' | 'event_triggers'>,
): boolean => recipe.auto_run !== undefined || (recipe.event_triggers ?? []).length > 0;

const button = (
  action: RunningAsAction,
  label: string,
  opts: {
    readonly dish_id?: string;
    readonly recipe_id?: string;
    readonly busy?: boolean;
    readonly primary?: boolean;
    readonly danger?: boolean;
    readonly extra?: string;
  } = {},
): string => `<button type="button" class="recipes-button${opts.primary ? ' recipes-button--primary' : ''}${opts.danger ? ' recipes-button--danger' : ''}"
  ${RUNNING_AS_ACTION_ATTR}="${action}"${opts.dish_id !== undefined ? ` ${RUNNING_AS_DISH_ATTR}="${e(opts.dish_id)}"` : ''}${opts.recipe_id !== undefined ? ` ${RUNNING_AS_RECIPE_ATTR}="${e(opts.recipe_id)}"` : ''}${opts.busy ? ' aria-disabled="true" aria-busy="true"' : ''}${opts.extra ?? ''}>${e(label)}</button>`;

const renderLine = (
  view: RunningAsView,
  dish: Dish,
  dishCount: number,
  shownSettings: ReadonlyArray<{ readonly label: string; readonly text: string }>,
): string => {
  const rows = rowsOfDish(dish.dish_id, view);
  const status = dishStatus(dish, rows, view.lastRuns[dish.dish_id]);
  const name = dishLineName(dish, dishCount);
  const called = name ?? 'this dish';
  const busy = view.busy.has(dish.dish_id);
  const last = view.lastRuns[dish.dish_id];
  const next = dishNextRun(dish, rows);
  const menuOpen = view.openMenu === dish.dish_id;
  const confirming = view.confirmingRemove === dish.dish_id;
  const error = view.errors.get(dish.dish_id);
  const times = [
    last === undefined
      ? 'Never run'
      : `Last run ${when(last.started_at)}${last.commit_status === 'failed' ? ' — failed'
        : last.commit_status === 'awaiting_approval' ? ' — waiting for you' : ''}`,
    ...(next !== null ? [`next ${when(next)}`] : []),
  ].join(' · ');
  const menu = menuOpen
    ? `<div class="running-as-menu" role="menu" aria-label="${e(`More for ${called}`)}">
        ${view.can.run ? button('run', 'Run once as this', { dish_id: dish.dish_id, extra: ' role="menuitem"' }) : ''}
        ${view.can.schedule ? button('schedule', 'Add a schedule', { dish_id: dish.dish_id, extra: ' role="menuitem"' }) : ''}
        ${view.can.update && !dish.is_default ? button('make-main', 'Make this the main one', { dish_id: dish.dish_id, extra: ' role="menuitem"' }) : ''}
        ${view.can.remove ? button('remove', 'Remove', { dish_id: dish.dish_id, danger: true, extra: ' role="menuitem"' }) : ''}
      </div>`
    : '';
  const hasMenu = view.can.run || view.can.schedule || view.can.remove
    || (view.can.update && !dish.is_default);
  return `<li class="running-as-line" ${RUNNING_AS_DISH_ATTR}="${e(dish.dish_id)}" ${RUNNING_AS_STATUS_ATTR}="${status.kind}">
    <div class="running-as-head">
      <span class="running-as-dot running-as-dot--${status.kind}" aria-hidden="true"></span>
      ${name !== null ? `<span class="running-as-name">${e(name)}</span>` : ''}
      ${dish.is_default && dishCount > 1 ? '<span class="running-as-main">Main</span>' : ''}
      ${status.kind === 'waiting' || status.kind === 'failing'
        ? `<span class="running-as-status running-as-status--${status.kind}">${status.kind === 'waiting' ? 'Waiting for you' : 'Failing'}</span>`
        : ''}
      <span class="running-as-controls">
        ${view.can.update
          ? button(dish.enabled ? 'toggle-off' : 'toggle-on', busy ? 'Switching…' : dish.enabled ? 'On' : 'Off', {
              dish_id: dish.dish_id,
              busy,
              extra: ` role="switch" aria-checked="${dish.enabled ? 'true' : 'false'}" aria-label="${e(name ?? view.recipe_name)}"`,
            })
          : `<span class="running-as-state">${dish.enabled ? 'On' : 'Off'}</span>`}
        ${view.can.update && Object.keys(view.recipe.variables ?? {}).length > 0
          ? button('settings', 'Settings', { dish_id: dish.dish_id, busy, extra: ` aria-label="${e(`Settings of ${called}`)}"` })
          : ''}
        ${hasMenu
          ? button('menu', '⋯', { dish_id: dish.dish_id, extra: ` aria-haspopup="menu" aria-expanded="${menuOpen ? 'true' : 'false'}" aria-label="${e(`More for ${called}`)}"` })
          : ''}
      </span>
    </div>
    ${shownSettings.length > 0
      ? `<p class="running-as-settings">${shownSettings.map((setting) => `${e(setting.label)}: ${e(setting.text)}`).join(' · ')}</p>`
      : ''}
    <p class="running-as-starts">${e(dishStartsLine(view.recipe, rows.schedules))}</p>
    <p class="running-as-times">${e(times)}</p>
    ${status.kind === 'failing'
      ? `<p class="running-as-failure">${e(status.reason)}${view.failureHref !== undefined
          ? ` <a class="recipes-inline-link" href="${e(view.failureHref)}">See why</a>` : ''}${
          status.stopped && view.can.update
            ? ` ${button('rearm', busy ? 'Starting…' : 'Start again', { dish_id: dish.dish_id, busy })}`
            : ''}</p>`
      : ''}
    ${menu}
    ${confirming
      ? `<div class="running-as-confirm" role="group" aria-label="${e(`Remove ${called}?`)}">
          <span>Remove ${e(called)}? Its triggers and schedules go with it.</span>
          ${button('remove-confirm', 'Remove', { dish_id: dish.dish_id, danger: true, busy })}
          ${button('remove-cancel', 'Keep', { dish_id: dish.dish_id })}
        </div>`
      : ''}
    ${error !== undefined ? `<p class="running-as-error" role="alert">${e(error)}</p>` : ''}
  </li>`;
};

/** A related recipe's "Switch on…": the same form as its own page's. */
export const renderSwitchOnButton = (recipe_id: string, busy: boolean, label = 'Switch on…'): string =>
  button('switch-on', busy ? 'Switching on…' : label, { recipe_id, busy });

/** The focus a control's own click should leave: the same control where it
 *  survives the repaint, else the line's menu, else the section's own. */
export const RUNNING_AS_FOCUS_AFTER: Readonly<Record<string, string>> = {
  'toggle-on': 'toggle', 'toggle-off': 'toggle', menu: 'menu', settings: 'settings',
  remove: 'remove-cancel', 'remove-cancel': 'menu', 'remove-confirm': 'add', rearm: 'toggle',
  run: 'menu', schedule: 'menu', 'make-main': 'menu',
  add: 'add', 'switch-on': 'switch-on', 'save-settings': 'save-settings',
};
/** A control's focus key: the switch is one control whichever way it points. */
export const runningAsFocusKey = (action: string | null): string | null =>
  action === 'toggle-on' || action === 'toggle-off' ? 'toggle' : action;

/** The section, or `''` when the dishes could not be read — or when there is
 *  nothing to say: a recipe that runs only when the owner runs it, with no
 *  settings and no dish yet. */
export const renderRunningAs = (view: RunningAsView): string => {
  if (view.dishes === null) return '';
  if (view.dishes.length === 0 && !startsOnItsOwn(view.recipe)
    && Object.keys(view.recipe.variables ?? {}).length === 0) return '';
  const dishes = [...view.dishes].sort((a, b) =>
    Number(b.is_default) - Number(a.is_default) || a.created_at - b.created_at);
  const recipeError = view.errors.get('');
  const switchingOn = view.busy.has('');
  const shown = settingsThatTellApart(view.recipe.variables ?? {}, dishes, {
    ...(view.valueText !== undefined ? { valueText: view.valueText } : {}),
  });
  const body = dishes.length === 0
    ? startsOnItsOwn(view.recipe)
      ? `<p class="recipes-detail-note">Not switched on. ${e(whatStartsIt(view.recipe))}</p>
         ${view.can.create ? `<div class="running-as-empty">${button('switch-on', switchingOn ? 'Switching on…' : 'Switch on', { recipe_id: view.recipe_id, primary: true, busy: switchingOn })}</div>` : ''}`
      : `<p class="recipes-detail-note">No saved settings. Save them once and every run and schedule uses them.</p>
         ${view.can.create && Object.keys(view.recipe.variables ?? {}).length > 0
           ? `<div class="running-as-empty">${button('save-settings', switchingOn ? 'Saving…' : 'Save settings', { recipe_id: view.recipe_id, busy: switchingOn })}</div>`
           : ''}`
    : `<ul class="running-as-list">${dishes.map((dish) =>
        renderLine(view, dish, dishes.length, shown.get(dish.dish_id) ?? [])).join('')}</ul>`;
  return `
    <section class="recipes-detail-section running-as" ${RUNNING_AS_ATTR}="${e(view.recipe_id)}">
      <div class="running-as-header">
        <h2 class="recipes-detail-section-title">Running as</h2>
        ${dishes.length > 0 && view.can.create ? button('add', switchingOn ? 'Adding…' : '+ Add another', { recipe_id: view.recipe_id, busy: switchingOn }) : ''}
      </div>
      ${body}
      ${recipeError !== undefined ? `<p class="running-as-error" role="alert">${e(recipeError)}</p>` : ''}
    </section>`;
};

/** Styles, scoped under the section so nothing else on the page changes. */
export const RUNNING_AS_STYLES = `
.running-as-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.running-as-list {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  min-width: 0;
}
.running-as-line {
  display: grid;
  gap: 3px;
  min-width: 0;
  padding: 10px 12px;
}
.running-as-line + .running-as-line {
  border-top: 1px solid var(--border);
}
.running-as-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  min-width: 0;
}
.running-as-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
}
.running-as-dot--off { background: var(--border-strong, var(--border)); }
.running-as-dot--failing { background: var(--danger); }
.running-as-dot--waiting { background: var(--warning, var(--accent)); }
.running-as-name {
  font-weight: 600;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.running-as-main,
.running-as-status {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 11px;
  color: var(--fg-muted);
}
.running-as-status--failing { border-color: var(--danger); color: var(--danger); }
.running-as-controls {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.running-as-controls [role="switch"][aria-checked="true"] {
  border-color: var(--accent);
  color: var(--accent);
}
.running-as-settings,
.running-as-starts,
.running-as-times,
.running-as-failure {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
.running-as-settings { color: var(--fg); }
.running-as-failure { color: var(--danger); }
.running-as-menu,
.running-as-confirm,
.running-as-empty {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.running-as-confirm > span { font-size: 12px; }
.running-as-error {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--danger);
}
`;
