/** D-319 §5.4 — Automation as one list: grouped by recipe, then by dish.
 *
 *  Each dish is a line — its state, what starts it, its last run — with its
 *  own switch, Settings and Details, and its triggers, schedules and timer
 *  under it, each with its own last and next run and its own actions (the
 *  page's rule rows, rendered by the page). A recipe that starts on its own
 *  and has no dish says "Not switched on", with Switch on. Filters: On, Off,
 *  Needs you, Failing. Beside it, "Coming up": the next runs by time.
 *
 *  Pure markup from a snapshot. The page owns state, rpc and the rule rows;
 *  the controls here speak the page's own actions (`AUTOMATION_ACTION_ATTR`
 *  with `AUTOMATION_RULE_ID_ATTR`), so a dish's switch here is the same
 *  switch as on its Dishes row. */

import type { Dish } from '@recued/contracts';
import { e, formatClientDateTime, type DishStatus } from '@recued/ui-shared';
import { NOT_INSTALLED_TEXT } from '../recipes/running-as.js';
import { serializeShellRoute } from '../shell/route.js';

/** A control's action (`toggle:dish:on`, `configure:dish`, `detail:dish`,
 *  `switch-on:recipe`, `chip:<filter>`). Shared with the page's delegated
 *  click handler. */
export const AUTOMATION_ACTION_ATTR = 'data-recued-automation-action';
/** The id a control acts on (a dish id; a recipe id for Switch on). */
export const AUTOMATION_RULE_ID_ATTR = 'data-rule-id';
/** A recipe's group. Value = recipe_id. */
export const AUTOMATION_RECIPE_GROUP_ATTR = 'data-recued-automation-recipe';
/** A dish's line. Value = dish_id. */
export const AUTOMATION_DISH_LINE_ATTR = 'data-recued-automation-dish';
/** A filter chip. Value = the filter. */
export const AUTOMATION_CHIP_ATTR = 'data-recued-automation-chip';
/** The note on a recipe whose pack is not installed. Value = recipe_id. */
export const AUTOMATION_NOT_INSTALLED_ATTR = 'data-recued-automation-not-installed';
/** The "Coming up" list. */
export const AUTOMATION_COMING_UP_ATTR = 'data-recued-automation-coming-up';

export type AutomationChip = 'on' | 'off' | 'needs-you' | 'failing';
export const AUTOMATION_CHIPS: readonly AutomationChip[] = ['on', 'off', 'needs-you', 'failing'];
const CHIP_LABEL: Readonly<Record<AutomationChip, string>> = {
  on: 'On',
  off: 'Off',
  'needs-you': 'Needs you',
  failing: 'Failing',
};

export const isAutomationChip = (value: string): value is AutomationChip =>
  (AUTOMATION_CHIPS as readonly string[]).includes(value);

export interface ByRecipeDishLine {
  readonly dish: Dish;
  /** Its name; a recipe's only unnamed dish has none ("On" / "Off" shows). */
  readonly name: string | null;
  readonly status: DishStatus;
  /** A row of it holds for the owner (a missed run to answer). */
  readonly needsYou: boolean;
  readonly startsLine: string;
  readonly lastRun: string;
  /** Its triggers, schedules and timer, as the page renders a rule row. */
  readonly rows: readonly string[];
  readonly busy: boolean;
}

export interface ByRecipeGroup {
  readonly recipe_id: string;
  readonly name: string;
  readonly href: string;
  readonly lines: readonly ByRecipeDishLine[];
  /** Rows of this recipe that belong to no dish (made before D-319). */
  readonly strayRows: readonly string[];
  /** It starts on its own, and nobody switched it on. */
  readonly notSwitchedOn: boolean;
  /** It starts on its own, and the server only ships it: its pack is not
   *  installed, so it cannot be switched on (the group shows only for rows
   *  of its own). */
  readonly notInstalled: boolean;
  /** What would start it, as a sentence ("It runs every 15 minutes."). */
  readonly lead: string;
  readonly switchOnBusy: boolean;
}

export interface ByRecipeView {
  readonly groups: readonly ByRecipeGroup[];
  readonly chip: AutomationChip | null;
  readonly can: {
    readonly switchDish: boolean;
    readonly settings: boolean;
    readonly switchOn: boolean;
  };
}

/** The filter a dish line answers to. */
export const chipOf = (line: ByRecipeDishLine): AutomationChip =>
  line.status.kind === 'off'
    ? 'off'
    : line.needsYou || line.status.kind === 'waiting'
      ? 'needs-you'
      : line.status.kind === 'failing' ? 'failing' : 'on';

/** How many lines each filter would show; a recipe nobody switched on is Off. */
export const chipCounts = (groups: readonly ByRecipeGroup[]): Record<AutomationChip, number> => {
  const counts: Record<AutomationChip, number> = { on: 0, off: 0, 'needs-you': 0, failing: 0 };
  for (const group of groups) {
    if (group.notSwitchedOn) counts.off += 1;
    for (const line of group.lines) counts[chipOf(line)] += 1;
  }
  return counts;
};

export const renderChips = (
  counts: Readonly<Record<AutomationChip, number>>,
  active: AutomationChip | null,
): string => `
  <div class="automation-chips" role="group" aria-label="Show only">
    ${AUTOMATION_CHIPS.map((chip) => `<button type="button" class="automation-chip"
      ${AUTOMATION_ACTION_ATTR}="chip:${chip}" ${AUTOMATION_CHIP_ATTR}="${chip}"
      aria-pressed="${active === chip ? 'true' : 'false'}">${e(CHIP_LABEL[chip])} <span class="automation-chip-count">${counts[chip]}</span></button>`).join('')}
  </div>`;

const button = (action: string, id: string, label: string, extra = ''): string =>
  `<button type="button" class="automation-button" ${AUTOMATION_ACTION_ATTR}="${e(action)}"
    ${AUTOMATION_RULE_ID_ATTR}="${e(id)}"${extra}>${e(label)}</button>`;

const renderLine = (view: ByRecipeView, recipeName: string, line: ByRecipeDishLine): string => {
  const { dish, status } = line;
  const called = line.name ?? recipeName;
  const busyAttrs = line.busy ? ' aria-disabled="true" aria-busy="true"' : '';
  const statusChip = status.kind === 'failing' || status.kind === 'waiting' || line.needsYou
    ? `<span class="automation-dish-status automation-dish-status--${e(chipOf(line))}">${e(CHIP_LABEL[chipOf(line)])}</span>`
    : '';
  return `<li ${AUTOMATION_DISH_LINE_ATTR}="${e(dish.dish_id)}" data-status="${e(status.kind)}">
    <div class="automation-dish-line">
      <span class="automation-dish-dot automation-dish-dot--${e(status.kind)}" aria-hidden="true"></span>
      ${line.name !== null ? `<span class="automation-dish-name">${e(line.name)}</span>` : ''}
      ${dish.is_default && line.name !== null ? '<span class="automation-dish-main">Main</span>' : ''}
      ${statusChip}
      <span class="automation-dish-starts">${e(line.startsLine)}</span>
      <span class="automation-dish-last">${e(line.lastRun)}</span>
      <span class="automation-dish-actions">
        ${view.can.switchDish
          ? button(`toggle:dish:${dish.enabled ? 'off' : 'on'}`, dish.dish_id,
            line.busy ? 'Switching…' : dish.enabled ? 'On' : 'Off',
            ` role="switch" aria-checked="${dish.enabled ? 'true' : 'false'}" aria-label="${e(called)}"${busyAttrs}`)
          : ''}
        ${view.can.settings ? button('configure:dish', dish.dish_id, 'Settings', ` aria-label="${e(`Settings of ${called}`)}"${busyAttrs}`) : ''}
        ${button('detail:dish', dish.dish_id, 'Details', ` aria-label="${e(`Details of ${called}`)}"`)}
      </span>
    </div>
    ${status.kind === 'failing'
      ? `<p class="automation-dish-reason">${e(status.reason)}${status.stopped && view.can.switchDish
        // The server stopped a row of it: switching the dish on again
        // restarts it, as on the recipe page.
        ? ` ${button('toggle:dish:on', dish.dish_id, line.busy ? 'Starting…' : 'Start again',
          ` aria-label="${e(`Start ${called} again`)}"${busyAttrs}`)}`
        : ''}</p>`
      : ''}
    ${line.rows.length > 0 ? `<ul class="automation-list automation-dish-rows">${line.rows.join('')}</ul>` : ''}
  </li>`;
};

/** The grouped list, filtered by the chip. `''` when nothing is left. */
export const renderByRecipe = (view: ByRecipeView): string => {
  const shown = view.groups.flatMap((group) => {
    const lines = view.chip === null ? group.lines : group.lines.filter((line) => chipOf(line) === view.chip);
    const notSwitchedOn = group.notSwitchedOn && (view.chip === null || view.chip === 'off');
    const strays = view.chip === null ? group.strayRows : [];
    return lines.length === 0 && !notSwitchedOn && strays.length === 0 ? [] : [{ group, lines, notSwitchedOn, strays }];
  });
  return shown.map(({ group, lines, notSwitchedOn, strays }) => {
    const on = group.lines.filter((line) => line.dish.enabled).length;
    const off = group.lines.length - on;
    const summary = group.lines.length < 2 ? '' : [on > 0 ? `${on} on` : '', off > 0 ? `${off} off` : '']
      .filter((part) => part !== '').join(' · ');
    return `<section class="automation-recipe" ${AUTOMATION_RECIPE_GROUP_ATTR}="${e(group.recipe_id)}">
      <h3 class="automation-recipe-title"><a href="${e(group.href)}">${e(group.name)}</a>${summary !== ''
        ? ` <span class="automation-recipe-summary">· ${e(summary)}</span>` : ''}</h3>
      ${lines.length > 0 ? `<ul class="automation-dishes">${lines.map((line) => renderLine(view, group.name, line)).join('')}</ul>` : ''}
      ${notSwitchedOn
        ? `<div class="automation-not-on">
            <span class="automation-dish-dot automation-dish-dot--off" aria-hidden="true"></span>
            <span>Not switched on. ${e(group.lead)}</span>
            ${view.can.switchOn
              ? button('switch-on:recipe', group.recipe_id, group.switchOnBusy ? 'Switching on…' : 'Switch on',
                group.switchOnBusy ? ' aria-disabled="true" aria-busy="true"' : '')
              : ''}
          </div>`
        : ''}
      ${group.notInstalled && view.chip === null
        ? `<div class="automation-not-on" ${AUTOMATION_NOT_INSTALLED_ATTR}="${e(group.recipe_id)}">
            <span class="automation-dish-dot automation-dish-dot--off" aria-hidden="true"></span>
            <span>${e(NOT_INSTALLED_TEXT)} <a href="${e(serializeShellRoute('packs'))}">Install it from Packs</a> to switch it on.</span>
          </div>`
        : ''}
      ${strays.length > 0 ? `<ul class="automation-list">${strays.join('')}</ul>` : ''}
    </section>`;
  }).join('');
};

/** One run coming up. */
export interface ComingUpEntry {
  readonly at: number;
  readonly recipe_name: string;
  readonly href: string;
  /** Its dish's name, when the recipe has more than one. */
  readonly dish_name: string | null;
  /** What it is: "Weekdays at 9:00 AM", "Every 15 minutes". */
  readonly what: string;
}

/** "Coming up": the next runs, soonest first. */
export const renderComingUp = (entries: readonly ComingUpEntry[]): string => {
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  if (sorted.length === 0) {
    return `<p class="automation-section-hint" ${AUTOMATION_COMING_UP_ATTR}>Nothing is due to run on its own.</p>`;
  }
  return `<ol class="automation-coming-up" ${AUTOMATION_COMING_UP_ATTR}>
    ${sorted.map((entry) => `<li>
      <time datetime="${e(new Date(entry.at).toISOString())}">${e(formatClientDateTime(entry.at, { includeSeconds: false }))}</time>
      <a href="${e(entry.href)}">${e(entry.recipe_name)}</a>${entry.dish_name !== null ? ` · ${e(entry.dish_name)}` : ''}
      <span class="automation-coming-up-what">${e(entry.what)}</span>
    </li>`).join('')}
  </ol>`;
};

/** Styles for the grouped list and "Coming up", beside the page's own. */
export const BY_RECIPE_STYLES = `
.automation-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0 12px; }
.automation-chip {
  border: 1px solid var(--border); border-radius: 999px; background: var(--surface);
  color: var(--fg); padding: 5px 10px; font: inherit; font-size: 13px; cursor: pointer; min-height: 32px;
}
.automation-chip[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-weak); color: var(--accent); }
.automation-chip-count { color: var(--fg-muted); margin-left: 2px; }
.automation-recipe { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 0 0 10px; min-width: 0; }
.automation-recipe-title { margin: 0 0 6px; font-size: 14px; font-weight: 650; overflow-wrap: anywhere; }
.automation-recipe-title a { color: inherit; text-decoration: none; }
.automation-recipe-title a:hover { text-decoration: underline; }
.automation-recipe-summary { color: var(--fg-muted); font-weight: 400; font-size: 13px; }
.automation-dishes { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.automation-dish-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; }
.automation-dish-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
.automation-dish-dot--off { background: var(--border-strong, var(--border)); }
.automation-dish-dot--failing { background: var(--danger); }
.automation-dish-name { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
.automation-dish-main, .automation-dish-status {
  border: 1px solid var(--border); border-radius: 999px; padding: 0 7px; font-size: 11px; color: var(--fg-muted);
}
.automation-dish-status--failing { border-color: var(--danger); color: var(--danger); }
.automation-dish-starts, .automation-dish-last { font-size: 12px; color: var(--fg-muted); overflow-wrap: anywhere; }
.automation-dish-actions { display: inline-flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.automation-dish-actions [role="switch"][aria-checked="true"] { border-color: var(--accent); color: var(--accent); }
.automation-dish-reason { margin: 2px 0 0 16px; font-size: 12px; color: var(--danger); }
.automation-dish-rows { margin: 6px 0 0 16px; }
.automation-not-on { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-size: 13px; color: var(--fg-muted); }
.automation-coming-up { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.automation-coming-up li { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; font-size: 13px; }
.automation-coming-up time { font-variant-numeric: tabular-nums; min-width: 11em; }
.automation-coming-up-what { color: var(--fg-muted); }
`;
