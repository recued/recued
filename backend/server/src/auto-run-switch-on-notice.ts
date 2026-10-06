/** D-319 — telling the owner, once, which recipes the update left switched off.
 *
 *  D-319 slice 2 (`1daedf9c0`) moved the auto-run timer from the recipe onto
 *  its dish: a recipe runs on its own only once it is switched on. A recipe
 *  with a dish gets its timer back (`auto-run-timer-rearm.ts`); one with NO
 *  dish stays stopped until its recipe is switched on, and the owner could
 *  learn that only from the changelog. This is the notice. It says "a recent
 *  update", not "this update": 26.9.30 shipped the change without it, so on a
 *  server already running 26.9.30 it arrives one update later.
 *
 *  It runs at boot, once per server, ever: D-308's ledger (`data_repairs`) holds
 *  its row under `AUTO_RUN_SWITCH_ON_NOTICE_ID`.
 *
 *  - **What it says comes from CURRENT state only**: the installed recipes that
 *    declare `auto_run` and that Automation shows as "Not switched on" — the one
 *    rule both read (`isNotSwitchedOn`, `@recued/contracts`). ⛔ Never the old
 *    tables: a server updating straight from 26.9.29 still has them and one
 *    that ran 26.9.30 does not, so reading them would say different things on
 *    different servers. A recipe the owner had paused is named too, and the
 *    wording says only what is true of both: never that they "were running".
 *  - **It waits for a boot with a notifier.** Without one it records nothing,
 *    so the next boot that can tell the owner does.
 *  - **It waits for the re-arm's ledger row**, recording nothing, so it never
 *    spends its one shot before the recipes the re-arm switches on can be
 *    named. ⚠ A re-arm failing on every boot also holds the notice; the boot
 *    log warns each time.
 *  - **The ledger row is written only once the owner has been told**, or once
 *    there is nothing to say. D-308's order: the history row under a fixed id
 *    (a retry overwrites it), then the ledger, then the live push, best-effort.
 *    A crash before the ledger re-delivers into the same history row at the
 *    next boot. Any row ends it.
 *
 *  ⚠ A recipe with a dish is not named as "Not switched on", whether the dish is
 *  on or off: Automation shows it as a dish. Its timer is the re-arm's
 *  (`auto-run-timer-rearm.ts`), which runs first at the same boot. When that
 *  repair had to take recipes as running — the server had already lost the
 *  old tables — the notice also names the recipes it switched on, so the
 *  owner can switch off one that should not run. Read from the repair's
 *  ledger row, so a later boot that delivers the notice still has them. It
 *  says only what is true of every one of them: some may have been paused
 *  before the update, so never that they "were running". */

import { isNotSwitchedOn } from '@recued/contracts';
import type { NotificationBlock, NotificationMessage } from '@recued/notification';
import type { AuditLogStore } from '@recued/storage';

import { listDefinitional } from './auto-run-handler.js';
import { AUTO_RUN_TIMER_REARM_ID, type AutoRunTimerRearmSummary } from './auto-run-timer-rearm.js';
import type { DishStore } from './dish-store.js';
import type { RecipeStore } from './recipe-store.js';
import type { DataRepairLedger } from './storage/data-repair-ledger.js';

export const AUTO_RUN_SWITCH_ON_NOTICE_ID = 'd319-auto-run-switch-on-notice-v1';

/** Automation, as the webclient addresses it. */
const AUTOMATION_ROUTE = '#automation';

/** How many names the notice lists before "…and N more". */
const LISTED = 10;

export interface NotSwitchedOnRecipe {
  readonly recipe_id: string;
  /** Its name as Automation shows it; its id when it has none. */
  readonly name: string;
}

export interface NotSwitchedOnSources {
  readonly recipeStore: Pick<RecipeStore, 'listStored'>;
  readonly dishStore: Pick<DishStore, 'listByRecipe'>;
}

/** The installed recipes on a timer that Automation shows as "Not switched
 *  on", by name. Installed = stored, as the timer roster reads them: a recipe
 *  the server only bundles runs nothing and is not the update's doing. */
export const autoRunRecipesNotSwitchedOn = (
  sources: NotSwitchedOnSources,
): NotSwitchedOnRecipe[] =>
  listDefinitional(sources)
    .filter(({ recipe }) => isNotSwitchedOn({
      recipe,
      dishes: sources.dishStore.listByRecipe(recipe.recipe_id).length,
    }))
    .map(({ recipe }) => ({
      recipe_id: recipe.recipe_id,
      name: recipe.metadata?.name?.trim() || recipe.recipe_id,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.recipe_id.localeCompare(b.recipe_id));

/** Up to `LISTED` names, then a count of the rest. */
const listed = (recipes: readonly NotSwitchedOnRecipe[]): string =>
  recipes.slice(0, LISTED).map((recipe) => `\n• ${recipe.name}`).join('')
  + (recipes.length > LISTED ? `\n• …and ${recipes.length - LISTED} more` : '');

/** The owner's notice, or null with nothing to say. `switchedOn` — the
 *  recipes the re-arm switched on, taking them as running. */
export const autoRunSwitchOnNotice = (
  recipes: readonly NotSwitchedOnRecipe[],
  publicBaseUrl: string | null,
  switchedOn: readonly NotSwitchedOnRecipe[] = [],
): NotificationMessage | null => {
  if (recipes.length === 0 && switchedOn.length === 0) return null;
  const one = recipes.length === 1;
  const oneOn = switchedOn.length === 1;
  const intro = 'A recent update changed how recipes start: a recipe now runs on its own only once it is '
    + 'switched on. ';
  const notOn = (one
    ? 'This recipe starts on its own and is not switched on:'
    : 'These recipes start on their own and are not switched on:') + listed(recipes);
  // True of every one: none ran on its own after the update, and each does now.
  const on = (oneOn
    ? 'This recipe had not run on its own since then, and is switched on now:'
    : 'These recipes had not run on their own since then, and are switched on now:') + listed(switchedOn);
  const link = publicBaseUrl === null ? {} : { link_url: `${publicBaseUrl}/${AUTOMATION_ROUTE}` };
  if (switchedOn.length === 0) {
    return {
      title: one
        ? '1 recipe that starts on its own is not switched on'
        : `${recipes.length} recipes that start on their own are not switched on`,
      text: `${intro}${notOn}\n\nTo run ${one ? 'it' : 'them'}, open Automation and switch ${one ? 'it' : 'them'} on.`,
      ...link,
    };
  }
  if (recipes.length === 0) {
    return {
      title: oneOn
        ? '1 recipe that starts on its own was switched on'
        : `${switchedOn.length} recipes that start on their own were switched on`,
      text: `${intro}${on}\n\nIf ${oneOn ? 'it' : 'one'} should not run on its own, open Automation and switch it off.`,
      ...link,
    };
  }
  return {
    title: 'An update changed how recipes start',
    text: `${intro}${on}\n\n${notOn}\n\nOpen Automation to switch on the ones that are not, `
      + 'or to switch off one that should not run on its own.',
    ...link,
  };
};

/** The recipes the re-arm switched on taking them as running, from its ledger
 *  row: only the `recovered` path took anything as running. */
const switchedOnByRearm = (
  ledger: Pick<DataRepairLedger, 'get'>,
): NotSwitchedOnRecipe[] => {
  const summary = ledger.get(AUTO_RUN_TIMER_REARM_ID)?.summary as AutoRunTimerRearmSummary | undefined;
  return summary?.path === 'recovered'
    ? summary.rearmed
      .map(({ recipe_id, name }) => ({ recipe_id, name }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.recipe_id.localeCompare(b.recipe_id))
    : [];
};

export interface AutoRunSwitchOnNoticeDeps extends NotSwitchedOnSources {
  readonly ledger: Pick<DataRepairLedger, 'get' | 'record' | 'markNoticed'>;
  readonly auditLog: Pick<AuditLogStore, 'logActivity'>;
  /** Absent ⇒ this boot cannot tell the owner: it waits, recording nothing. */
  readonly notifier: Pick<NotificationBlock, 'notify'> | undefined;
  /** The server's public address for the link, or null (the owner's own
   *  screens still get `#automation`). */
  readonly publicBaseUrl: string | null;
  readonly now: () => number;
}

export type AutoRunSwitchOnNoticeOutcome =
  /** The owner was told, and the ledger says so. */
  | 'noticed'
  /** Every recipe on a timer is switched on, and the re-arm took none as
   *  running: recorded, nothing said. */
  | 'nothing_to_say'
  /** A boot before this one told the owner, or found nothing to say. */
  | 'done'
  /** No notifier this boot, or the re-arm has not recorded its row yet:
   *  nothing recorded, so a later boot tells. */
  | 'waiting';

export interface AutoRunSwitchOnNoticeResult {
  readonly outcome: AutoRunSwitchOnNoticeOutcome;
  /** How many recipes the notice named as not switched on; 0 unless `noticed`. */
  readonly named: number;
  /** How many recipes it named as switched on by the re-arm; 0 unless `noticed`. */
  readonly switched_on: number;
}

/** The one shot: a row, noticed, holding what the owner was told. */
const recordTold = (
  ledger: AutoRunSwitchOnNoticeDeps['ledger'],
  at: number,
  recipes: readonly NotSwitchedOnRecipe[],
  switchedOn: readonly NotSwitchedOnRecipe[],
): void => {
  ledger.record({
    repair_id: AUTO_RUN_SWITCH_ON_NOTICE_ID,
    applied_at: at,
    summary: { not_switched_on: recipes, switched_on: switchedOn },
  });
  ledger.markNoticed(AUTO_RUN_SWITCH_ON_NOTICE_ID, at);
};

/** Tell the owner once, at boot. Already told, or no notifier yet: no-op. */
export const noticeAutoRunSwitchOnAtBoot = async (
  deps: AutoRunSwitchOnNoticeDeps,
): Promise<AutoRunSwitchOnNoticeResult> => {
  if (deps.ledger.get(AUTO_RUN_SWITCH_ON_NOTICE_ID) !== null) return { outcome: 'done', named: 0, switched_on: 0 };
  const notifier = deps.notifier;
  if (notifier === undefined) return { outcome: 'waiting', named: 0, switched_on: 0 };
  // Not before the re-arm has recorded what it did: spending the one shot
  // first would leave whatever it switches on later unnamed.
  if (deps.ledger.get(AUTO_RUN_TIMER_REARM_ID) === null) return { outcome: 'waiting', named: 0, switched_on: 0 };
  const recipes = autoRunRecipesNotSwitchedOn(deps);
  const switchedOn = switchedOnByRearm(deps.ledger);
  const now = deps.now();
  const message = autoRunSwitchOnNotice(recipes, deps.publicBaseUrl, switchedOn);
  if (message === null) {
    recordTold(deps.ledger, now, recipes, switchedOn);
    return { outcome: 'nothing_to_say', named: 0, switched_on: 0 };
  }
  const persisted_activity_id = `data-repair:${AUTO_RUN_SWITCH_ON_NOTICE_ID}`;
  await deps.auditLog.logActivity({
    activity_id: persisted_activity_id,
    timestamp: now,
    action: 'notification_fired',
    target: AUTO_RUN_SWITCH_ON_NOTICE_ID,
    detail: JSON.stringify({ ...message, link_url: message.link_url ?? AUTOMATION_ROUTE }),
  });
  recordTold(deps.ledger, now, recipes, switchedOn);
  try {
    await notifier.notify(message, undefined, { persisted_activity_id, ui_link_url: AUTOMATION_ROUTE });
  } catch {
    // Best-effort: the notice is in the history, where the owner reads it.
  }
  return { outcome: 'noticed', named: recipes.length, switched_on: switchedOn.length };
};
