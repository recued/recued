/** D-179 — managed config-dish reconcile, shared by the schedule /
 *  trigger / auto-run config surfaces.
 *
 *  Config for an automation's headless fires lives on a MANAGED dish
 *  whose `config_overlay` the executor merges over recipe defaults. The
 *  dish is versioned IMMUTABLY: a config change MINTS a new dish and
 *  DISSOLVES the superseded one — it never rewrites an existing dish, so
 *  one `dish_id` = one config and the audit never shows a `dish_id` with
 *  drifting results. An identical overlay is a no-op (no churn); an empty
 *  overlay clears config (dropping even a STALE pointer whose dish was
 *  deleted out-of-band). Superseded config is discarded, not retained —
 *  consistent with a manual run's config not outliving the run.
 *
 *  The caller owns the POINTER (a schedule/trigger row's `dish_id`, or
 *  `auto_run_settings.dish_id`): this returns the next pointer value +
 *  whether anything changed, and performs the dish mint/dissolve itself.
 */

import { DISH_ID_PREFIX, type Dish } from '@recued/contracts';
import type { DishStore } from './dish-store.js';
import type { DishContextStore } from './dish-context-store.js';

/** Which `managed_by_*` marker stamps the dish (also the dissolve guard,
 *  so a config surface never dissolves a dish another owns). */
export type ManagedConfigMarker =
  | 'managed_by_schedule_id'
  | 'managed_by_trigger_id'
  | 'managed_by_auto_run';

/** Managed config-dish id mint (same scheme as `dishes.create`). */
export const genManagedDishId = (now: number): string => {
  const ts = now.toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${DISH_ID_PREFIX}${ts}${rnd}`;
};

/** Key-order-independent overlay equality (recursive — object keys sorted
 *  at every depth; arrays keep order), so re-sending an identical config
 *  never churns a new dish. */
export const overlaysEqual = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean => {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.keys(o).sort().map((k) => [k, canon(o[k])]);
    }
    return v;
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
};

export interface ReconcileManagedConfigDishInput {
  dishStore: Pick<DishStore, 'get' | 'set' | 'delete'>;
  /** Continuity snapshots — cleared when a superseded dish is dissolved. */
  dishContextStore?: Pick<DishContextStore, 'clear'>;
  recipe_id: string;
  publisher_id: string;
  /** The marker that stamps a minted dish + guards the dissolve. */
  marker: ManagedConfigMarker;
  /** The owning id the marker carries (schedule_id / trigger_id /
   *  recipe_id) — dissolve only touches a dish whose marker matches. */
  markerValue: string;
  /** The pointer's current value (row `dish_id` / setting `dish_id`). */
  currentDishId: string | null;
  /** The desired config. Empty `{}` clears; non-empty mints on change. */
  overlay: Record<string, unknown>;
  now: number;
}

/** Reconcile the managed config dish toward `overlay`. Returns the next
 *  pointer value (which the caller persists) + whether it changed. */
export const reconcileManagedConfigDish = (
  input: ReconcileManagedConfigDishInput,
): { nextDishId: string | null; changed: boolean } => {
  const {
    dishStore, dishContextStore, recipe_id, publisher_id,
    marker, markerValue, currentDishId, overlay, now,
  } = input;

  const currentDish = currentDishId !== null ? dishStore.get(currentDishId) : null;
  const currentOverlay = currentDish?.config_overlay ?? {};
  const isEmpty = Object.keys(overlay).length === 0;
  // Empty clears: always drop a non-null pointer (including a stale one
  // whose dish was deleted out-of-band — `currentOverlay` resolves to
  // `{}` and would otherwise compare equal). Otherwise mint only on a
  // real change.
  const changed = isEmpty
    ? currentDishId !== null
    : !overlaysEqual(overlay, currentOverlay);
  if (!changed) return { nextDishId: currentDishId, changed: false };

  let nextDishId: string | null = null;
  if (!isEmpty) {
    nextDishId = genManagedDishId(now);
    const dish: Dish = {
      dish_id: nextDishId,
      recipe_id,
      publisher_id,
      name: recipe_id,
      is_default: false,
      config_overlay: overlay,
      enabled: true,
      created_at: now,
    };
    dish[marker] = markerValue;
    dishStore.set(dish);
  }
  // Dissolve the superseded managed dish + its continuity snapshot —
  // guarded on the marker so a user-assigned binding is never touched.
  if (currentDishId !== null && currentDish?.[marker] === markerValue) {
    dishStore.delete(currentDishId);
    dishContextStore?.clear(currentDishId);
  }
  return { nextDishId, changed: true };
};
