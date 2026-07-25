/** Phase G (D-109) — `triggers.*` rpc handler slice.
 *
 *  Four methods — `triggers.list`, `triggers.create`, `triggers.update`,
 *  `triggers.delete`. All four write-through to `EventTriggersStore` +
 *  refresh the bus subscription via the dispatcher passed in deps.
 *
 *  Pattern validation happens at create / update time via
 *  `isValidPattern` from `@recued/warehouse-events` — invalid patterns
 *  reject with `TRIGGER_PATTERN_INVALID`. Recipe availability checks
 *  happen at dispatch time (the user may install a trigger before
 *  installing the recipe). */

import { randomUUID } from 'node:crypto';
import { isValidPattern } from '@recued/warehouse-events';
import {
  DISH_ID_PREFIX,
  RpcError,
  type Dish,
  type EventTrigger,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { WsClient } from '../ws-server.js';
import type { EventBus } from '../events/bus.js';
import { emitAutomationRule } from '../events/emit-sites.js';
import type { EventTriggersStore } from './store.js';
import type { EventTriggerDispatcher } from './dispatcher.js';
import type { DishStore } from '../dish-store.js';
import type { DishContextStore } from '../dish-context-store.js';
import { reconcileManagedConfigDish } from '../managed-config-dish.js';

export interface TriggersRpcDeps {
  store: EventTriggersStore;
  /** Dispatcher that subscribes to the warehouse bus. Re-subscribed
   *  after every mutation so the live listener set matches the
   *  persisted rows without a server restart. Optional so tests can
   *  exercise the store without bringing up a bus. */
  dispatcher?: EventTriggerDispatcher;
  /** D-121 broadcast bus — mutations fan `automation_rule_changed` so
   *  every paired client's Automation surface refreshes live. Optional;
   *  emits are best-effort. */
  eventBus?: EventBus;
  /** Poll-manager / G6 — fired after every trigger mutation (next to
   *  `dispatcher.rebuild()`) so the watch manager re-derives its poll
   *  demand (a created/enabled `data.connection.api.…` pattern arms a
   *  loop; a delete/disable may drop the last subscriber). LATE-BOUND
   *  by the composition: the watch manager composes after the trigger
   *  substrate, so `compose-listeners` assigns this field onto the
   *  already-built deps object (the `getHandle` posture). Optional;
   *  best-effort. */
  onRulesChanged?: () => void;
  /** D-179 P2 — standing-dish lookup for create/update-time binding
   *  validation (existence + recipe match). P5c widens to `set` for
   *  the enable-mints-dish lifecycle on recipe-origin rows (owner
   *  decision 2026-06-12): enabling an unbound recipe-origin trigger
   *  mints a managed dish and binds it; disabling flips the managed
   *  dish's `enabled` off (identity + continuity survive); uninstall
   *  dissolution lives in the declarative reconciler. Optional;
   *  absent ⇒ binding is type-checked only and the fire-time gate
   *  owns the rest. D-179 config-on-trigger widens to `delete`: a
   *  create with a non-empty `config_overlay` mints a managed dish to
   *  carry it into headless fires, and `triggers.delete` dissolves it. */
  dishStore?: Pick<DishStore, 'get' | 'set' | 'delete'>;
  /** D-179 config-on-trigger — continuity snapshots for the managed
   *  overlay dish. Cleared alongside the dish on delete (same discipline
   *  as the declarative reconciler's managed-dish dissolution) so a
   *  re-minted dish never inherits a dead instance's state. Optional. */
  dishContextStore?: Pick<DishContextStore, 'clear'>;
  /** Override the clock (tests). */
  now?: () => number;
  /** Override the id generator (tests). */
  genId?: () => string;
}

// D-179 P5c — managed-dish id mint (same scheme as `dishes.create`).
const genDishId = (deps: TriggersRpcDeps): string => {
  const now = deps.now?.() ?? Date.now();
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${DISH_ID_PREFIX}${now.toString(36)}${rnd}`;
};

const genTriggerId = (): string => {
  // ULID-ish: 26 chars of base32 is close enough for uniqueness; we
  // don't need monotonicity for triggers. Source of randomness is the
  // standard UUID generator stripped down to fit.
  const raw = randomUUID().replace(/-/g, '');
  return `t-${raw.slice(0, 24)}`;
};

const requirePatternValid = (pattern: string): void => {
  if (!isValidPattern(pattern)) {
    throw new RpcError(
      'trigger_pattern_invalid',
      `pattern ${JSON.stringify(pattern)} is not a valid warehouse-bus subscribe expression`,
      400,
    );
  }
};

const requireNonEmptyString = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || v.length === 0) {
    throw new RpcError('bad_request', `${field} is required`, 400);
  }
  return v;
};

// D-179 P2 — dish binding + lifted poll-interval knob (the retired
// `config_patch` override's replacements). Null clears; undefined leaves.
const requireDishId = (v: unknown): string | null => {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length === 0) {
    throw new RpcError('bad_request', 'dish_id must be a non-empty string or null', 400);
  }
  return v;
};

/** Create/update-time binding validation: the named dish must exist
 *  and instantiate the trigger's recipe. Best-effort — only when the
 *  dish store is wired. */
const requireDishBindsRecipe = (
  deps: TriggersRpcDeps,
  dish_id: string,
  recipe_id: string,
): void => {
  if (!deps.dishStore) return;
  const dish = deps.dishStore.get(dish_id);
  if (!dish) {
    throw new RpcError('not_found', `Dish '${dish_id}' not found`, 404);
  }
  if (dish.recipe_id !== recipe_id) {
    throw new RpcError(
      'bad_request',
      `Dish '${dish_id}' instantiates recipe '${dish.recipe_id}', not '${recipe_id}'`,
      400,
    );
  }
};

const requireWatchInterval = (v: unknown): number | null => {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new RpcError('bad_request', 'watch_interval_ms must be a positive number or null', 400);
  }
  return v;
};

// D-179 config-on-trigger — validate the optional overlay. `undefined` ⇒
// null (none); a non-object ⇒ reject; an object ⇒ the overlay.
const optionalOverlay = (v: unknown): Record<string, unknown> | null => {
  if (v === undefined) return null;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new RpcError('bad_request', 'config_overlay must be an object', 400);
  }
  return v as Record<string, unknown>;
};

// ────────────────────────────────────────────────────────────────
// triggers.list
// ────────────────────────────────────────────────────────────────

/** Attach the trigger's config (read from the bound dish) so the run
 *  modal can pre-fill the per-row Config editor. Derived at read time —
 *  the dish is the source of truth; nothing extra is persisted. */
const triggerWithConfig = (deps: TriggersRpcDeps, t: EventTrigger): EventTrigger => {
  if (t.dish_id === undefined || !deps.dishStore) return t;
  const overlay = deps.dishStore.get(t.dish_id)?.config_overlay;
  return overlay !== undefined ? { ...t, config_overlay: overlay } : t;
};

export const handleTriggersList = async (
  deps: TriggersRpcDeps,
): Promise<{ triggers: EventTrigger[] }> => ({
  triggers: deps.store.list().map((t) => triggerWithConfig(deps, t)),
});

// ────────────────────────────────────────────────────────────────
// triggers.create
// ────────────────────────────────────────────────────────────────

export const handleTriggersCreate = async (
  deps: TriggersRpcDeps,
  args: {
    recipe_id?: unknown;
    publisher_id?: unknown;
    pattern?: unknown;
    dish_id?: unknown;
    config_overlay?: unknown;
    watch_interval_ms?: unknown;
    enabled?: unknown;
  },
): Promise<{ trigger: EventTrigger }> => {
  const recipe_id = requireNonEmptyString(args.recipe_id, 'recipe_id');
  const publisher_id = requireNonEmptyString(args.publisher_id, 'publisher_id');
  const pattern = requireNonEmptyString(args.pattern, 'pattern');
  requirePatternValid(pattern);
  const dish_id = args.dish_id === undefined ? null : requireDishId(args.dish_id);
  const overlay = optionalOverlay(args.config_overlay);
  const watch_interval_ms = args.watch_interval_ms === undefined
    ? null
    : requireWatchInterval(args.watch_interval_ms);
  const enabled = args.enabled === undefined ? true : args.enabled === true;
  if (dish_id !== null) requireDishBindsRecipe(deps, dish_id, recipe_id);

  const trigger_id = (deps.genId ?? genTriggerId)();
  const now = (deps.now ?? Date.now)();

  // D-179 config-on-trigger — mint a managed dish to carry the overlay
  // into the headless fires (the dispatcher threads `trigger.dish_id`,
  // the executor merges the dish overlay over recipe defaults). Only when
  // a non-empty overlay is given and no explicit dish binding (which
  // wins); `triggers.delete` dissolves it.
  let boundDishId = dish_id;
  if (dish_id === null
    && overlay !== null
    && Object.keys(overlay).length > 0
    && deps.dishStore) {
    const managedDishId = genDishId(deps);
    const managedDish: Dish = {
      dish_id: managedDishId,
      recipe_id,
      publisher_id,
      name: recipe_id,
      is_default: false,
      config_overlay: overlay,
      enabled: true,
      managed_by_trigger_id: trigger_id,
      created_at: now,
    };
    deps.dishStore.set(managedDish);
    boundDishId = managedDishId;
  }

  const trigger = deps.store.create({
    trigger_id,
    recipe_id,
    publisher_id,
    pattern,
    enabled,
    dish_id: boundDishId,
    watch_interval_ms,
    created_at: now,
  });
  deps.dispatcher?.rebuild();
  deps.onRulesChanged?.();
  emitAutomationRule(deps.eventBus, 'event_trigger');
  return { trigger };
};

// ────────────────────────────────────────────────────────────────
// triggers.update
// ────────────────────────────────────────────────────────────────

export const handleTriggersUpdate = async (
  deps: TriggersRpcDeps,
  args: {
    trigger_id?: unknown;
    enabled?: unknown;
    pattern?: unknown;
    dish_id?: unknown;
    config_overlay?: unknown;
    watch_interval_ms?: unknown;
  },
): Promise<{ trigger: EventTrigger }> => {
  const trigger_id = requireNonEmptyString(args.trigger_id, 'trigger_id');
  const overlay = optionalOverlay(args.config_overlay);
  const patch: {
    enabled?: boolean;
    pattern?: string;
    dish_id?: string | null;
    watch_interval_ms?: number | null;
  } = {};
  if (args.enabled !== undefined) patch.enabled = args.enabled === true;
  if (args.pattern !== undefined) {
    const p = requireNonEmptyString(args.pattern, 'pattern');
    requirePatternValid(p);
    patch.pattern = p;
  }
  if (args.dish_id !== undefined) {
    patch.dish_id = requireDishId(args.dish_id);
    if (patch.dish_id !== null) {
      const existing = deps.store.get(trigger_id);
      if (!existing) {
        throw new RpcError('not_found', `trigger ${trigger_id} not found`, 404);
      }
      requireDishBindsRecipe(deps, patch.dish_id, existing.recipe_id);
    }
  }
  if (args.watch_interval_ms !== undefined) {
    patch.watch_interval_ms = requireWatchInterval(args.watch_interval_ms);
  }

  // D-179 — config edit: reconcile the managed config dish immutably (a
  // changed overlay mints a new dish + dissolves the prior, so editing a
  // trigger's config never mutates a live dish_id). Only when no explicit
  // `dish_id` (that wins). A NON-EMPTY overlay provides the managed dish
  // and supersedes the P5c empty-mint below; an empty `{}` only CLEARS
  // config, so P5c must still run (e.g. enabling a recipe-origin trigger
  // still needs its standing identity dish).
  let configProvidesDish = false;
  if (overlay !== null && args.dish_id === undefined && deps.dishStore) {
    const existing = deps.store.get(trigger_id);
    if (!existing) {
      throw new RpcError('not_found', `trigger ${trigger_id} not found`, 404);
    }
    const { nextDishId, changed } = reconcileManagedConfigDish({
      dishStore: deps.dishStore,
      ...(deps.dishContextStore ? { dishContextStore: deps.dishContextStore } : {}),
      recipe_id: existing.recipe_id,
      publisher_id: existing.publisher_id,
      marker: 'managed_by_trigger_id',
      markerValue: trigger_id,
      currentDishId: existing.dish_id ?? null,
      overlay,
      now: deps.now?.() ?? Date.now(),
    });
    if (changed) patch.dish_id = nextDishId;
    configProvidesDish = Object.keys(overlay).length > 0;
  }

  // D-179 P5c — enable-mints-dish lifecycle for RECIPE-ORIGIN rows
  // (owner decision 2026-06-12). Arming an unbound recipe-origin
  // trigger mints a managed dish and binds it (so reactive fires get
  // standing identity: overlay slot, audit attribution, continuity);
  // disarming flips the managed dish's `enabled` off WITHOUT deleting
  // it, so a disable/enable cycle keeps run-to-run state and history.
  // User-assigned bindings (no `managed_by_trigger_id` match) are
  // never touched. Explicit `dish_id` in the same patch wins; a non-empty
  // config edit (above) already provided the managed dish.
  if (!configProvidesDish
    && patch.enabled !== undefined && args.dish_id === undefined && deps.dishStore) {
    const existing = deps.store.get(trigger_id);
    if (existing && existing.origin === 'recipe') {
      const bound = existing.dish_id !== undefined
        ? deps.dishStore.get(existing.dish_id)
        : null;
      const managed = bound !== null && bound !== undefined
        && bound.managed_by_trigger_id === trigger_id;
      if (patch.enabled && existing.dish_id === undefined) {
        const now = deps.now?.() ?? Date.now();
        const dish = {
          dish_id: genDishId(deps),
          recipe_id: existing.recipe_id,
          publisher_id: existing.publisher_id,
          name: existing.recipe_id,
          is_default: false,
          config_overlay: {},
          enabled: true,
          managed_by_trigger_id: trigger_id,
          created_at: now,
        };
        deps.dishStore.set(dish);
        patch.dish_id = dish.dish_id;
      } else if (managed && bound) {
        deps.dishStore.set({ ...bound, enabled: patch.enabled });
      }
    }
  }

  const updated = deps.store.update(trigger_id, patch);
  if (!updated) {
    throw new RpcError('not_found', `trigger ${trigger_id} not found`, 404);
  }
  deps.dispatcher?.rebuild();
  deps.onRulesChanged?.();
  emitAutomationRule(deps.eventBus, 'event_trigger');
  return { trigger: updated };
};

// ────────────────────────────────────────────────────────────────
// triggers.delete
// ────────────────────────────────────────────────────────────────

export const handleTriggersDelete = async (
  deps: TriggersRpcDeps,
  args: { trigger_id?: unknown },
): Promise<{ ok: true }> => {
  const trigger_id = requireNonEmptyString(args.trigger_id, 'trigger_id');
  // Read the row before removal so we can dissolve the dish this trigger
  // auto-minted for its overlay (D-179 config-on-trigger).
  const existing = deps.store.get(trigger_id);
  const removed = deps.store.remove(trigger_id);
  if (!removed) {
    throw new RpcError('not_found', `trigger ${trigger_id} not found`, 404);
  }
  // Dissolve only the managed overlay dish this trigger owns
  // (`managed_by_trigger_id` match); a user-assigned binding is never
  // touched. Mirrors the declarative reconciler's uninstall cleanup.
  if (existing?.dish_id !== undefined && deps.dishStore) {
    const dish = deps.dishStore.get(existing.dish_id);
    if (dish && dish.managed_by_trigger_id === trigger_id) {
      deps.dishStore.delete(existing.dish_id);
      // Clear the dish's continuity snapshot too (mirrors the reconciler's
      // managed-dish dissolution) so nothing orphans.
      deps.dishContextStore?.clear(existing.dish_id);
    }
  }
  deps.dispatcher?.rebuild();
  deps.onRulesChanged?.();
  emitAutomationRule(deps.eventBus, 'event_trigger');
  return { ok: true };
};

// ────────────────────────────────────────────────────────────────
// Handler slice
// ────────────────────────────────────────────────────────────────

export type TriggersMethods =
  | 'triggers.list'
  | 'triggers.create'
  | 'triggers.update'
  | 'triggers.delete';

export const makeTriggersHandlers = (
  deps: TriggersRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, TriggersMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['triggers.list', 'triggers.create', 'triggers.update', 'triggers.delete'],
    handlers: {
      'triggers.list': async () => handleTriggersList(deps),
      'triggers.create': async (args) =>
        handleTriggersCreate(deps, args as Parameters<typeof handleTriggersCreate>[1]),
      'triggers.update': async (args) =>
        handleTriggersUpdate(deps, args as Parameters<typeof handleTriggersUpdate>[1]),
      'triggers.delete': async (args) =>
        handleTriggersDelete(deps, args as Parameters<typeof handleTriggersDelete>[1]),
    },
  };
};
