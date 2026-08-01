/** Schedule rpc handlers — dispatched from the WS registry.
 *
 *  Four methods:
 *    schedules.list               list all (optional recipe_id filter)
 *    schedules.create             { recipe_id, publisher_id?, cron_expression, enabled? }
 *    schedules.update             { cron_expression?, enabled? }
 *    schedules.delete             by schedule_id
 *
 *  Synchronous (`store` is in-process SQLite). Handlers return the
 *  bare response shape and throw `RpcError(code, message, status)` on
 *  validation failure; the WS dispatcher wraps that into the wire
 *  envelope. Schedules live ONLY on this instance — no push to cloud
 *  or other servers.
 */

import type { Schedule } from '@recued/scheduler';
import { validateCronInterval, nextCronMatch, MIN_CRON_INTERVAL_MS } from '@recued/scheduler';
import {
  DISH_ID_PREFIX,
  RpcError,
  type Dish,
  type HandlerSlice,
  type ServerRpcRegistry,
  type ServerSchedule,
} from '@recued/contracts';
import { estimateSize, type StorageGate } from '@recued/storage-gate';
import type { AuditLogStore } from '@recued/storage';
import type { ScheduleStore } from './schedule-store.js';
import type { DishStore } from './dish-store.js';
import type { DishContextStore } from './dish-context-store.js';
import { reconcileManagedConfigDish } from './managed-config-dish.js';
import { retireSchedule } from './schedule-retire.js';
import type { RecipeStore } from './recipe-store.js';
import type { WsClient } from './ws-server.js';
import type { EventBus } from './events/bus.js';
import { emitSchedule } from './events/emit-sites.js';

export interface ScheduleHandlerDeps {
  store: ScheduleStore;
  /** When provided, schedule creation validates that targets already
   *  exist in the local recipe store. The legacy UI path leaves this
   *  absent for backward compatibility; the recipe-callable
   *  schedule_recipe path wires it and therefore rejects inline/new
   *  recipe creation attempts. */
  recipeStore?: Pick<RecipeStore, 'get'>;
  /** D-179 P2 — standing-dish lookup for create-time binding
   *  validation (existence + recipe match). D-179 config-on-schedule
   *  widens to `set`/`delete`: a create with a non-empty `config_overlay`
   *  mints a managed dish to carry it into headless fires, and delete
   *  dissolves it. Optional; absent ⇒ binding is type-checked only, the
   *  fire-time gate owns the rest, and `config_overlay` is a no-op. */
  dishStore?: Pick<DishStore, 'get' | 'set' | 'delete'>;
  /** D-179 config-on-schedule — continuity snapshots for the managed
   *  overlay dish. Cleared alongside the dish on delete so a re-minted
   *  dish never inherits a dead instance's prior-run state (same
   *  discipline as `deleteDish` + the declarative reconciler's
   *  managed-dish dissolution). Optional; absent ⇒ no snapshot clear. */
  dishContextStore?: Pick<DishContextStore, 'clear'>;
  instanceId: string;
  now?: () => number;
  /** Override for the cron interval floor. Self-hosters can lower this
   *  below the hosted 5-minute default. */
  cronFloorMs?: number;
  /** Phase B gate for admission-checking create + update. Schedules
   *  are user-class (never reserve); rejections surface as
   *  `storage_pressure` so clients can back off. Absent → no gate
   *  enforcement (legacy / test path). */
  gate?: StorageGate;
  /** Audit log — when wired, admission rejections emit a
   *  `quota_exceeded` activity keyed to `schedules`. */
  auditLog?: AuditLogStore;
  /** D-121 Phase 6 — realtime broadcast bus. When provided each
   *  successful create / update / delete emits a `kind: 'schedule',
   *  op: 'updated'` event for subscribed clients. The scheduler's
   *  fired tick emits `op: 'fired'` separately. Bus emits are
   *  best-effort. */
  eventBus?: EventBus;
}

const generateScheduleId = (): string => {
  // Short unique id: timestamp (base36) + 6 random chars.
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `sch_${ts}${rnd}`;
};

// D-179 config-on-schedule — managed-dish id mint (same scheme as
// `dishes.create` / the trigger handler's `genDishId`).
const generateDishId = (): string => {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${DISH_ID_PREFIX}${ts}${rnd}`;
};

/** Validate an optional `config_overlay` arg. `undefined` ⇒ null (none);
 *  a non-object ⇒ reject; an object ⇒ the overlay. */
const optionalOverlay = (v: unknown): Record<string, unknown> | null => {
  if (v === undefined) return null;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new RpcError('bad_request', 'config_overlay must be an object', 400);
  }
  return v as Record<string, unknown>;
};

const computeNextRun = (cron: string, fromMs: number): number | null => {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  return nextCronMatch(parts, fromMs + 60_000); // start from next minute
};

const oneShotCronExpression = (runAt: number): string => {
  const d = new Date(runAt);
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
};

/** Attach the schedule's config (read from the bound dish) so the run
 *  modal can pre-fill the per-row Config editor. Derived at read time —
 *  the dish is the source of truth; nothing extra is persisted. */
const scheduleWithConfig = (
  deps: ScheduleHandlerDeps,
  s: Schedule,
): ServerSchedule => {
  if (s.dish_id === undefined || !deps.dishStore) return s;
  const overlay = deps.dishStore.get(s.dish_id)?.config_overlay;
  return overlay !== undefined ? { ...s, config_overlay: overlay } : s;
};

export const listSchedules = (
  deps: ScheduleHandlerDeps,
  query: { recipe_id?: string },
): { schedules: ServerSchedule[] } => {
  const schedules = query.recipe_id
    ? deps.store.listByRecipe(query.recipe_id)
    : deps.store.list();
  return { schedules: schedules.map((s) => scheduleWithConfig(deps, s)) };
};

export const createSchedule = (
  deps: ScheduleHandlerDeps,
  body: {
    recipe_id?: unknown;
    publisher_id?: unknown;
    mode?: unknown;
    cron_expression?: unknown;
    run_at?: unknown;
    enabled?: unknown;
    dish_id?: unknown;
    config_overlay?: unknown;
  },
): { schedule: Schedule } => {
  const recipe_id = typeof body.recipe_id === 'string' ? body.recipe_id : null;
  const publisher_id = typeof body.publisher_id === 'string' ? body.publisher_id : 'local';
  const explicitMode = body.mode !== undefined;
  const mode =
    body.mode === undefined || body.mode === 'recurring'
      ? 'recurring'
      : body.mode === 'one_shot'
        ? 'one_shot'
        : null;
  const cron_expression = typeof body.cron_expression === 'string' ? body.cron_expression : null;
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  if (!recipe_id) {
    throw new RpcError('bad_request', 'recipe_id is required', 400);
  }
  if (mode === null) {
    throw new RpcError('bad_request', "mode must be 'recurring' or 'one_shot'", 400);
  }
  if (deps.recipeStore && deps.recipeStore.get(recipe_id) === null) {
    throw new RpcError('not_found', `Recipe '${recipe_id}' not found`, 404);
  }
  // D-179 P2 — standing-dish binding. Validated for existence + recipe
  // match when the dish store is wired; the fire-time gate in the
  // scheduler owns enabled/vanished handling.
  if (body.dish_id !== undefined
    && (typeof body.dish_id !== 'string' || body.dish_id.length === 0)) {
    throw new RpcError('bad_request', 'dish_id must be a non-empty string', 400);
  }
  const dish_id = body.dish_id as string | undefined;
  if (dish_id !== undefined && deps.dishStore) {
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
  }
  // D-179 config-on-schedule — validate the optional overlay up-front;
  // the managed dish that carries it is minted below, only after the
  // admission gate passes (so a rejected create never orphans a dish).
  const overlay = optionalOverlay(body.config_overlay);
  let finalCronExpression = cron_expression;
  let run_at: number | undefined;
  if (mode === 'one_shot') {
    if (typeof body.run_at !== 'number' || !Number.isFinite(body.run_at) || body.run_at <= 0) {
      throw new RpcError('bad_request', 'run_at must be a positive Unix-ms timestamp for one_shot schedules', 400);
    }
    run_at = Math.trunc(body.run_at);
    finalCronExpression = finalCronExpression && finalCronExpression.trim().length > 0
      ? finalCronExpression
      : oneShotCronExpression(run_at);
  } else {
    if (!finalCronExpression) {
      throw new RpcError('bad_request', 'cron_expression is required', 400);
    }
    const floor = deps.cronFloorMs ?? MIN_CRON_INTERVAL_MS;
    const validation = validateCronInterval(finalCronExpression, floor);
    if (!validation.valid) {
      throw new RpcError('invalid_cron', validation.error ?? 'Invalid cron', 400);
    }
  }

  const now = deps.now?.() ?? Date.now();
  const schedule: Schedule = {
    schedule_id: generateScheduleId(),
    recipe_id,
    publisher_id,
    ...(explicitMode || mode === 'one_shot' ? { mode } : {}),
    cron_expression: finalCronExpression,
    ...(run_at !== undefined ? { run_at } : {}),
    enabled,
    created_at: now,
    last_run_at: null,
    next_run_at: mode === 'one_shot' ? run_at! : computeNextRun(finalCronExpression, now),
    last_status: null,
    last_error: null,
    instance_id: deps.instanceId,
    ...(dish_id !== undefined ? { dish_id } : {}),
  };

  // Phase B admission check. Schedules are user-class — a gate at
  // `writes_blocked` rejects new schedules so the quota doesn't
  // overflow (no cascade can reclaim here; user deletes old ones).
  if (deps.gate) {
    const check = deps.gate.canWrite(estimateSize(schedule));
    if (!check.ok) {
      if (deps.auditLog) {
        void deps.auditLog.logActivity({
          activity_id: '',
          timestamp: now,
          action: 'quota_exceeded',
          target: 'schedules',
          detail: check.reason ?? 'storage_pressure',
        }).catch(() => { /* best-effort */ });
      }
      throw new RpcError(
        check.reason === 'writes_blocked' ? 'storage_pressure' : check.reason ?? 'storage_pressure',
        `schedule creation rejected: ${check.reason}`,
        507,
      );
    }
  }

  // D-179 config-on-schedule — mint a managed dish to carry the overlay
  // into the headless fires (the scheduler threads `schedule.dish_id`,
  // and the executor merges the dish overlay over recipe defaults). Only
  // when the caller gave a non-empty overlay and no explicit dish (an
  // explicit binding wins). Placed post-admission so a GATE rejection
  // never mints; `schedules.delete` dissolves it. (A `store.set` failure
  // after the mint would leave an unreferenced dead dish row — the same
  // non-atomicity the P5c enable-mints-dish path accepts; an orphan here
  // is unreachable, so we don't pay a cross-store transaction for it.)
  if (dish_id === undefined
    && overlay !== null
    && Object.keys(overlay).length > 0
    && deps.dishStore) {
    const managedDishId = generateDishId();
    const managedDish: Dish = {
      dish_id: managedDishId,
      recipe_id,
      publisher_id,
      name: recipe_id,
      is_default: false,
      config_overlay: overlay,
      enabled: true,
      managed_by_schedule_id: schedule.schedule_id,
      created_at: now,
    };
    deps.dishStore.set(managedDish);
    schedule.dish_id = managedDishId;
  }

  deps.store.set(schedule);
  emitSchedule(deps.eventBus, 'updated');
  return { schedule };
};

export const updateSchedule = (
  deps: ScheduleHandlerDeps,
  schedule_id: string,
  body: { cron_expression?: unknown; enabled?: unknown; config_overlay?: unknown },
): { schedule: Schedule } => {
  const existing = deps.store.get(schedule_id);
  if (!existing) {
    throw new RpcError('not_found', `Schedule '${schedule_id}' not found`, 404);
  }
  const overlay = optionalOverlay(body.config_overlay);

  const cron_expression = typeof body.cron_expression === 'string' ? body.cron_expression : existing.cron_expression;
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : existing.enabled;
  if (existing.mode === 'one_shot' && body.cron_expression !== undefined) {
    throw new RpcError('bad_request', 'one_shot schedules cannot update cron_expression', 400);
  }

  if (cron_expression !== existing.cron_expression) {
    const floor = deps.cronFloorMs ?? MIN_CRON_INTERVAL_MS;
    const validation = validateCronInterval(cron_expression, floor);
    if (!validation.valid) {
      throw new RpcError('invalid_cron', validation.error ?? 'Invalid cron', 400);
    }
  }

  const now = deps.now?.() ?? Date.now();
  // D-215 — a retained terminal one-shot is the owner's retry handle. Turning
  // it back on must make it eligible to fire again; merely flipping `enabled`
  // leaves `last_run_at` populated, and the scheduler immediately disables it
  // again without dispatching. Keep this transition narrow so pausing and
  // resuming a not-yet-fired one-shot does not erase any evidence.
  const rearmingOneShot = existing.mode === 'one_shot'
    && !existing.enabled
    && enabled
    && existing.last_run_at !== null
    && (existing.last_status === 'error' || existing.last_status === 'skipped');
  const updated: Schedule = {
    ...existing,
    cron_expression,
    enabled,
    next_run_at: existing.mode === 'one_shot'
      ? (existing.run_at ?? existing.next_run_at)
      : computeNextRun(cron_expression, now),
    ...(rearmingOneShot
      ? { last_run_at: null, last_status: null, last_error: null }
      : {}),
  };

  // Updates are usually ≤ existing size, but explicitly check the net
  // delta so a user expanding a field that bloats the row still gets
  // rejected at writes_blocked.
  if (deps.gate) {
    const prevSize = estimateSize(existing);
    const newSize = estimateSize(updated);
    const projected = Math.max(0, newSize - prevSize);
    if (projected > 0) {
      const check = deps.gate.canWrite(projected);
      if (!check.ok) {
        if (deps.auditLog) {
          void deps.auditLog.logActivity({
            activity_id: '',
            timestamp: now,
            action: 'quota_exceeded',
            target: 'schedules',
            detail: check.reason ?? 'storage_pressure',
          }).catch(() => { /* best-effort */ });
        }
        throw new RpcError(
          check.reason === 'writes_blocked' ? 'storage_pressure' : check.reason ?? 'storage_pressure',
          `schedule update rejected: ${check.reason}`,
          507,
        );
      }
    }
  }

  // D-179 — reconcile the managed config dish (immutable versioning: a
  // changed overlay mints a new dish + dissolves the prior, so editing a
  // schedule's config never mutates a live dish_id). Post-gate so a
  // rejected update can't mint. `{}` clears; the row repoints.
  if (overlay !== null && deps.dishStore) {
    const { nextDishId, changed } = reconcileManagedConfigDish({
      dishStore: deps.dishStore,
      ...(deps.dishContextStore ? { dishContextStore: deps.dishContextStore } : {}),
      recipe_id: existing.recipe_id,
      publisher_id: existing.publisher_id,
      marker: 'managed_by_schedule_id',
      markerValue: schedule_id,
      currentDishId: existing.dish_id ?? null,
      overlay,
      now,
    });
    if (changed) {
      if (nextDishId === null) delete updated.dish_id;
      else updated.dish_id = nextDishId;
    }
  }

  // A skipped one-shot commonly retained a disabled managed dish. Re-arming
  // the schedule while leaving that dish paused would only produce another
  // skip, so revive the dish the schedule itself owns. Never touch an assigned
  // dish or one managed by a different rule.
  if (rearmingOneShot && updated.dish_id !== undefined && deps.dishStore) {
    const ownedDish = deps.dishStore.get(updated.dish_id);
    if (ownedDish !== null
      && ownedDish.managed_by_schedule_id === schedule_id
      && !ownedDish.enabled) {
      deps.dishStore.set({ ...ownedDish, enabled: true });
    }
  }

  deps.store.set(updated);
  emitSchedule(deps.eventBus, 'updated');
  return { schedule: updated };
};

export const deleteSchedule = (
  deps: ScheduleHandlerDeps,
  schedule_id: string,
): { deleted: true } => {
  // D-215 slice 1 — row delete + managed-dish dissolve now live in
  // `retireSchedule`, shared with the scheduler's one-shot success path so
  // the `managed_by_schedule_id` guard is written exactly once.
  if (!retireSchedule(deps, schedule_id)) {
    throw new RpcError('not_found', `Schedule '${schedule_id}' not found`, 404);
  }
  emitSchedule(deps.eventBus, 'updated');
  return { deleted: true };
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type ScheduleMethods =
  | 'schedules.list'
  | 'schedules.create'
  | 'schedules.update'
  | 'schedules.delete';

export const makeScheduleHandlers = (
  deps: ScheduleHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ScheduleMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['schedules.list', 'schedules.create', 'schedules.update', 'schedules.delete'],
    handlers: {
      'schedules.list': async (args) =>
        listSchedules(deps, args as { recipe_id?: string }),
      'schedules.create': async (args) => createSchedule(deps, args),
      'schedules.update': async (args) => {
        if (!args.schedule_id || typeof args.schedule_id !== 'string') {
          throw new RpcError('bad_request', 'schedule_id is required', 400);
        }
        return updateSchedule(deps, args.schedule_id, args);
      },
      'schedules.delete': async (args) => {
        if (!args.schedule_id || typeof args.schedule_id !== 'string') {
          throw new RpcError('bad_request', 'schedule_id is required', 400);
        }
        return deleteSchedule(deps, args.schedule_id);
      },
    },
  };
};
