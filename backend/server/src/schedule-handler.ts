/** Schedule rpc handlers — dispatched from the WS registry.
 *
 *  Four methods:
 *    schedules.list               list all (optional recipe_id filter)
 *    schedules.create             { recipe_id, publisher_id?, cron_expression, enabled?, dish_id? }
 *    schedules.update             { cron_expression?, enabled?, dish_id? }
 *    schedules.delete             by schedule_id
 *
 *  D-319 — a schedule belongs to a dish and fires as it, with its settings;
 *  it has none of its own.
 *
 *  Synchronous (`store` is in-process SQLite). Handlers return the
 *  bare response shape and throw `RpcError(code, message, status)` on
 *  validation failure; the WS dispatcher wraps that into the wire
 *  envelope. Schedules live ONLY on this instance — no push to cloud
 *  or other servers.
 */

import { zoneOffsetMsAt } from '@recued/contracts';
import type { Schedule, MissedSchedulePolicy } from '@recued/scheduler';
import {
  validateCronInterval, nextCronMatch, MIN_CRON_INTERVAL_MS,
  isMissedSchedulePolicy, MISSED_SCHEDULE_POLICIES, buildMissedRunReport,
  countMissedCycles,
} from '@recued/scheduler';
import {
  RpcError,
  type Dish,
  type DishWebhookDoorChange,
  type HandlerSlice,
  type ServerRpcRegistry,
  type ServerSchedule,
  type ServerMissedRunReport,
} from '@recued/contracts';
import { estimateSize, type StorageGate } from '@recued/storage-gate';
import type { AuditLogStore } from '@recued/storage';
import type { ScheduleStore } from './schedule-store.js';
import type { DishStore } from './dish-store.js';
import { retireSchedule } from './schedule-retire.js';
import type { RecipeStore } from './recipe-store.js';
import type { WsClient } from './ws-server.js';
import type { EventBus } from './events/bus.js';
import { emitSchedule } from './events/emit-sites.js';

export interface ScheduleHandlerDeps {
  store: ScheduleStore;
  /** D-269 — the server's declared IANA zone, for schedules that carry none.
   *  ⚠ A thunk, read per call: under `follows_host` it is the host clock.
   *  Absent ⇒ host-local, the pre-D-269 behaviour. */
  serverTimeZone?: () => string | undefined;
  preapprovalStatus?: (scheduleId: string) => Pick<ServerSchedule, 'enabled' | 'lifecycle_revision' | 'preapproval'> | null;
  /** When provided, schedule creation validates that targets already
   *  exist in the local recipe store. The legacy UI path leaves this
   *  absent for backward compatibility; the recipe-callable
   *  schedule_recipe path wires it and therefore rejects inline/new
   *  recipe creation attempts. */
  recipeStore?: Pick<RecipeStore, 'get'>;
  /** The packs a recipe DECLARES but that are not installed — the create-time
   *  refusal. A schedule whose recipe cannot lower would accept a cron happily
   *  and then fail every single firing, forever; the fire-time gate skips those
   *  loudly, but never arming one beats explaining it later.
   *
   *  ⚠ SEPARATE FROM `recipeStore` ON PURPOSE. Wiring that store here would
   *  switch on the existence check above as a side effect, and its dormancy on
   *  the UI path is documented as deliberate ("legacy UI path leaves this absent
   *  for backward compatibility"). Turning a dormant refusal on is a decision to
   *  take on its own evidence, not a by-product of adding a different one.
   *
   *  Absent ⇒ no pack refusal, matching every other surface's posture: a server
   *  that cannot enumerate installed packs must not read "cannot tell" as
   *  "nothing works". */
  missingPackDepsForRecipe?: (recipe_id: string) => readonly string[];
  /** D-179 P2 / D-319 — dish lookup for create/update-time binding
   *  validation (existence + recipe match). Optional; absent ⇒ binding is
   *  type-checked only and the fire-time gate owns the rest. */
  dishStore?: Pick<DishStore, 'get'>;
  /** D-319 — the dish a schedule made for a recipe WITHOUT naming one
   *  belongs to: the recipe's main dish, made (on, with the settings given)
   *  when it has none (`mainDishFor`). Late-bound by the composition.
   *  Absent ⇒ such a schedule is dishless and settings are refused (a
   *  harness without dishes). */
  mainDish?: (input: {
    recipe_id: string;
    publisher_id: string;
    config_overlay: Record<string, unknown> | null;
  }) => { dish: Dish; webhook_doors?: DishWebhookDoorChange[] };
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

/** Validate an optional `config_overlay` arg — D-319: only a schedule that
 *  makes its recipe's main dish carries settings. `undefined` ⇒ null (none);
 *  a non-object ⇒ reject; an object ⇒ the overlay. */
const optionalOverlay = (v: unknown): Record<string, unknown> | null => {
  if (v === undefined) return null;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new RpcError('bad_request', 'config_overlay must be an object', 400);
  }
  return v as Record<string, unknown>;
};

/** D-266 — validate an optional `missed_policy`. `undefined` ⇒ null
 *  (leave it absent, which reads as `'auto'` everywhere); anything
 *  outside the closed list ⇒ reject.
 *
 *  ⛔ REJECT, rather than fall back to the default. A policy is the
 *  owner saying "do not decide this for me"; silently substituting
 *  `'auto'` for a value we failed to understand would answer the one
 *  question they asked us not to answer, and it would do it quietly. */
const optionalMissedPolicy = (v: unknown): MissedSchedulePolicy | null => {
  if (v === undefined) return null;
  if (!isMissedSchedulePolicy(v)) {
    throw new RpcError(
      'bad_request',
      `missed_policy must be one of ${MISSED_SCHEDULE_POLICIES.join(', ')}`,
      400,
    );
  }
  return v;
};

/** D-269 — a schedule's effective zone, or `undefined` when neither the row nor
 *  the server declares one (⇒ host-local, the pre-D-269 behaviour). */
/** D-319 — the named dish exists and is a dish of this recipe. */
const requireDishBindsRecipe = (
  deps: Pick<ScheduleHandlerDeps, 'dishStore'>,
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

const resolveScheduleZone = (
  schedule: { time_zone?: string } | undefined,
  deps: Pick<ScheduleHandlerDeps, 'serverTimeZone'>,
): string | undefined => {
  const declared = deps.serverTimeZone?.();
  if (schedule !== undefined) {
    const own = schedule.time_zone;
    if (typeof own === 'string' && own.length > 0) return own;
  }
  return declared !== undefined && declared.length > 0 ? declared : undefined;
};

const computeNextRun = (
  cron: string,
  fromMs: number,
  timeZone?: string,
): number | null => {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  return nextCronMatch(parts, fromMs + 60_000, undefined, timeZone); // from next minute
};

/** ⛔⛔ THIS MUST MOVE IN LOCKSTEP WITH THE MATCHER. A one-shot schedule's
 *  `run_at` is an absolute instant, but it is ALSO stored as a cron expression
 *  derived from that instant's wall clock. Derive it host-local while the
 *  matcher reads a declared zone and the two disagree — the schedule fires at
 *  the wrong hour despite `run_at` being exactly right. */
const oneShotCronExpression = (runAt: number, timeZone?: string): string => {
  if (timeZone === undefined) {
    const d = new Date(runAt);
    return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
  }
  const d = new Date(runAt + zoneOffsetMsAt(runAt, timeZone));
  return `${d.getUTCMinutes()} ${d.getUTCHours()} ${d.getUTCDate()} ${d.getUTCMonth() + 1} *`;
};

/** Attach the settings of the schedule's dish, shown with the row. Derived
 *  at read time — the dish is the source of truth; nothing extra is
 *  persisted, and a schedule has no settings of its own (D-319).
 *
 *  D-266 also attaches the missed-cycle count, but ONLY for a schedule
 *  that is actually behind.
 *
 *  ⛔ THE GATE IS NOT AN OPTIMISATION, IT IS WHAT KEEPS A SCAN OFF A HOT
 *  READ. `countMissedCycles` walks the window a minute at a time, so a
 *  daily schedule down a year costs ~36 ms even capped — times every
 *  schedule, on every `schedules.list`. `next_run_at` in the past is the
 *  free way to ask "is this one behind at all", and answers it exactly:
 *  the server sets that field to the next cron match at every fire. */
const scheduleWithConfig = (
  deps: ScheduleHandlerDeps,
  s: Schedule,
  now: number,
): ServerSchedule => {
  const overlay = s.dish_id !== undefined ? deps.dishStore?.get(s.dish_id)?.config_overlay : undefined;
  const behind = s.enabled
    && typeof s.next_run_at === 'number'
    && s.next_run_at < now;
  return {
    ...s,
    ...deps.preapprovalStatus?.(s.schedule_id),
    ...(overlay !== undefined ? { config_overlay: overlay } : {}),
    ...(behind ? { missed_cycles: countMissedCycles(s, now) } : {}),
  };
};

export const listSchedules = (
  deps: ScheduleHandlerDeps,
  query: { recipe_id?: string },
): { schedules: ServerSchedule[] } => {
  const now = deps.now?.() ?? Date.now();
  const schedules = query.recipe_id
    ? deps.store.listByRecipe(query.recipe_id)
    : deps.store.list();
  return { schedules: schedules.map((s) => scheduleWithConfig(deps, s, now)) };
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
    missed_policy?: unknown;
  },
): { schedule: Schedule; webhook_doors?: DishWebhookDoorChange[] } => {
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
  // Refuse rather than warn. A warning on a cron nobody looks at again is the
  // same as nothing, and this is unambiguous: a recipe that cannot lower cannot
  // ever run, and no input makes it work. The SAME code + `missing_packs` shape
  // the run path throws, so a surface can offer the identical install links here
  // without a second error contract.
  const missingPacks = deps.missingPackDepsForRecipe?.(recipe_id) ?? [];
  if (missingPacks.length > 0) {
    throw new RpcError(
      'pack_not_installed',
      `Recipe '${recipe_id}' needs ${missingPacks.length === 1 ? 'a pack' : 'packs'} that ${missingPacks.length === 1 ? 'is' : 'are'} not installed: ${missingPacks.join(', ')}. Install ${missingPacks.length === 1 ? 'it' : 'them'} before scheduling this recipe.`,
      400,
      undefined,
      { missing_packs: [...missingPacks] },
    );
  }
  // D-319 — the dish the schedule belongs to, validated for existence +
  // recipe match; the fire-time gate in the scheduler owns switched-off /
  // vanished handling. A schedule naming no dish joins the recipe's main
  // dish — resolved below, after the admission gate, because it can make one.
  if (body.dish_id !== undefined
    && (typeof body.dish_id !== 'string' || body.dish_id.length === 0)) {
    throw new RpcError('bad_request', 'dish_id must be a non-empty string', 400);
  }
  const named_dish_id = body.dish_id as string | undefined;
  if (named_dish_id !== undefined) requireDishBindsRecipe(deps, named_dish_id, recipe_id);
  const overlay = optionalOverlay(body.config_overlay);
  const hasSettings = overlay !== null && Object.keys(overlay).length > 0;
  if (named_dish_id !== undefined && hasSettings) {
    throw new RpcError('bad_request', 'Settings belong to the dish — change them on the dish, not the schedule', 400);
  }
  if (named_dish_id === undefined && deps.mainDish === undefined && hasSettings) {
    throw new RpcError('not_configured', 'Settings need a dish, and this server keeps none', 501);
  }
  const missed_policy = optionalMissedPolicy(body.missed_policy);
  let finalCronExpression = cron_expression;
  let run_at: number | undefined;
  if (mode === 'one_shot') {
    if (typeof body.run_at !== 'number' || !Number.isFinite(body.run_at) || body.run_at <= 0) {
      throw new RpcError('bad_request', 'run_at must be a positive Unix-ms timestamp for one_shot schedules', 400);
    }
    run_at = Math.trunc(body.run_at);
    finalCronExpression = finalCronExpression && finalCronExpression.trim().length > 0
      ? finalCronExpression
      : oneShotCronExpression(run_at, deps.serverTimeZone?.());
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
    // D-269 — a NEW schedule records the zone it was authored against, so a
    // later change to the server's declared zone does not silently move an
    // existing schedule the owner already reasoned about. Absent-zone rows
    // (everything written before D-269) keep tracking the declared value.
    ...(deps.serverTimeZone?.() !== undefined ? { time_zone: deps.serverTimeZone!() } : {}),
    next_run_at: mode === 'one_shot' ? run_at!
      : computeNextRun(finalCronExpression, now, deps.serverTimeZone?.()),
    last_status: null,
    last_error: null,
    instance_id: deps.instanceId,
    ...(missed_policy !== null ? { missed_policy } : {}),
    ...(named_dish_id !== undefined ? { dish_id: named_dish_id } : {}),
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

  // Post-admission, so a GATE rejection never makes a dish.
  let webhook_doors: DishWebhookDoorChange[] | undefined;
  if (named_dish_id === undefined && deps.mainDish !== undefined) {
    const main = deps.mainDish({ recipe_id, publisher_id, config_overlay: overlay });
    schedule.dish_id = main.dish.dish_id;
    // D-209 — a main dish made here can move the recipe's webhook door.
    webhook_doors = main.webhook_doors;
  }

  deps.store.set(schedule);
  emitSchedule(deps.eventBus, 'updated');
  return { schedule, ...(webhook_doors !== undefined ? { webhook_doors } : {}) };
};

export const updateSchedule = (
  deps: ScheduleHandlerDeps,
  schedule_id: string,
  body: {
    cron_expression?: unknown;
    enabled?: unknown;
    config_overlay?: unknown;
    missed_policy?: unknown;
    dish_id?: unknown;
  },
): { schedule: Schedule } => {
  const existing = deps.store.get(schedule_id);
  if (!existing) {
    throw new RpcError('not_found', `Schedule '${schedule_id}' not found`, 404);
  }
  // D-319 — settings belong to the schedule's dish.
  if (body.config_overlay !== undefined) {
    throw new RpcError('bad_request', 'A schedule has no settings of its own — change its dish’s settings', 400);
  }
  if (body.dish_id !== undefined
    && (typeof body.dish_id !== 'string' || body.dish_id.length === 0)) {
    throw new RpcError('bad_request', 'dish_id must be a non-empty string', 400);
  }
  if (typeof body.dish_id === 'string') requireDishBindsRecipe(deps, body.dish_id, existing.recipe_id);

  const missed_policy = optionalMissedPolicy(body.missed_policy);
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
  // D-268 — RE-ARMING RESETS THE FAILURE COUNTER, AND WITHOUT THIS THE FEATURE
  // READS AS BROKEN. A schedule disarmed at five consecutive failures comes back
  // still holding five, so the very next failure — including a single transient
  // blip — disarms it again immediately, and the owner's re-arm looks like it
  // did nothing. Scoped to the OFF → ON transition so an ordinary edit of a
  // still-failing schedule does not silently clear the evidence.
  //
  // 🔑 The sibling already does this: `AutoRunScheduler.resetCircuit` "zeros the
  // failure counter, clears the disabled flag". The cron path simply had no
  // counter to zero until now.
  // ⛔ BOTH DIRECTIONS, AND THAT IS WHAT MAKES THE STATE READABLE. Clearing only
  // on re-arm would leave a manually PAUSED failing schedule holding a non-zero
  // counter, and the surface cannot then tell "the owner paused this" from "the
  // server disarmed this" — which are the two facts D-268 exists to separate.
  // With both directions cleared, `!enabled && consecutive_failures > 0` means
  // exactly one thing: the server stopped it.
  const ownerToggledArm = typeof body.enabled === 'boolean' && enabled !== existing.enabled;
  const updated: Schedule = {
    ...existing,
    cron_expression,
    enabled,
    ...(ownerToggledArm ? { consecutive_failures: 0 } : {}),
    ...(missed_policy !== null ? { missed_policy } : {}),
    ...(typeof body.dish_id === 'string' ? { dish_id: body.dish_id } : {}),
    next_run_at: existing.mode === 'one_shot'
      ? (existing.run_at ?? existing.next_run_at)
      // ⛔ `undefined`, NOT `''`, when there is no zone at either level.
      // `cronZoneFor(row, '')` yields an empty string, and `Intl` throws a
      // RangeError on `timeZone: ''` — an update would take the whole rpc down
      // rather than fall back to host-local.
      : computeNextRun(cron_expression, now, resolveScheduleZone(existing, deps)),
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

  deps.store.set(updated);
  emitSchedule(deps.eventBus, 'updated');
  return { schedule: updated };
};

/** D-266 — the one-per-wake missed-run card.
 *
 *  🔑 A RECOMPUTED READ, NOT A STORED ASK. Every call rebuilds the
 *  report from live schedule rows, so there is nothing to expire,
 *  nothing to keep in step with the schedules, and no way for the card
 *  to claim a miss the world has since resolved. The one thing that IS
 *  durable is the owner's ANSWER (`missed_answer`) — because a
 *  decision, unlike a derivation, cannot be recomputed.
 *
 *  `recipe_name` is best-effort: absent when the recipe store is not
 *  wired or the recipe is gone, in which case the card shows the id. */
/** ⛔ NARROWED, NOT `ScheduleHandlerDeps`. The missed-run pair is also
 *  called from the scheduler boot (D-266's ask answer), which holds a
 *  schedule store and an event bus and none of the rpc slice's other
 *  deps. Taking the wide type there forced a cast, and a cast is exactly
 *  where "this function later reads `instanceId`" becomes a runtime
 *  failure with no red. Declaring what is actually read makes that a
 *  compile error at both call sites instead. */
export type MissedRunDeps = Pick<ScheduleHandlerDeps, 'store' | 'now' | 'recipeStore'>;
export type AnswerMissedDeps = Pick<ScheduleHandlerDeps, 'store' | 'now' | 'eventBus'>;

export const missedRuns = (
  deps: MissedRunDeps,
): ServerMissedRunReport => {
  const now = deps.now?.() ?? Date.now();
  const report = buildMissedRunReport(deps.store.list(), now);
  return {
    outage_from: report.outage_from,
    outage_to: report.outage_to,
    entries: report.entries.map((entry) => {
      const name = deps.recipeStore?.get(entry.recipe_id)?.metadata?.name;
      return {
        recipe_id: entry.recipe_id,
        ...(entry.dish_id !== undefined ? { dish_id: entry.dish_id } : {}),
        ...(typeof name === 'string' && name.length > 0 ? { recipe_name: name } : {}),
        schedule_ids: entry.schedule_ids,
        missed_cycles: entry.missed_cycles,
        ...(entry.missed_cycles_capped ? { missed_cycles_capped: true } : {}),
        last_run_at: entry.last_run_at,
      };
    }),
  };
};

/** D-266 — answer the card.
 *
 *  ⛔ `run` GRANTS ONE CATCH-UP PER DISH (D-319 — per recipe before), NOT
 *  ONE PER SCHEDULE AND NOT ONE PER MISSED CYCLE. A brief supersedes a
 *  brief: only the most-recently-run schedule of each dish is granted, and
 *  that dish's other waiting schedules are recorded skipped in the same
 *  breath. Two dishes of one recipe run with different settings, so each
 *  catches up. The missed COUNT stays in the card for as long as the card
 *  stands, because it is the record of the outage, not an offer of
 *  that many runs.
 *
 *  ⚠ The grant is not a dispatch. The scheduler fires it on its next
 *  tick (≤ one minute), through exactly the path an automatic
 *  catch-up takes — so the audit row carries `trigger_source:
 *  'backfill'` and the missed-cycle metadata, which a run dispatched
 *  from here would have lost.
 *
 *  `recipe_ids` answers every dish of those recipes, `dish_ids` those dishes;
 *  omitting both answers every entry: that is what the card's
 *  [Run them] / [Skip them] send. Ids naming nothing outstanding are
 *  ignored rather than rejected — the report is recomputed, so a
 *  client answering a card that a regular cycle resolved a second
 *  earlier is racing normally, not sending a bad request. */
export const answerMissed = (
  deps: AnswerMissedDeps,
  body: { answer?: unknown; recipe_ids?: unknown; dish_ids?: unknown },
): { ran: string[]; skipped: string[] } => {
  const answer = body.answer;
  if (answer !== 'run' && answer !== 'skip') {
    throw new RpcError('bad_request', "answer must be 'run' or 'skip'", 400);
  }
  for (const field of ['recipe_ids', 'dish_ids'] as const) {
    const ids = body[field];
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) {
      throw new RpcError('bad_request', `${field} must be an array of strings`, 400);
    }
  }
  const wantedRecipes = body.recipe_ids as string[] | undefined;
  const wantedDishes = body.dish_ids as string[] | undefined;
  const wanted = (entry: { recipe_id: string; dish_id?: string }): boolean =>
    (wantedRecipes === undefined && wantedDishes === undefined)
    || wantedRecipes?.includes(entry.recipe_id) === true
    || (entry.dish_id !== undefined && wantedDishes?.includes(entry.dish_id) === true);
  const now = deps.now?.() ?? Date.now();
  const report = buildMissedRunReport(deps.store.list(), now);

  // ⛔ FLOOR THE ANSWER TO ITS MINUTE, OR IT OUTLIVES THE FIRE IT
  // AUTHORISES. The scheduler stamps a catch-up's `last_run_at` with
  // the TICK MINUTE, not the wall clock, so an answer taken at 12:00:37
  // would still read `at > last_run_at` (12:00:00) after its own fire —
  // live, and good for another catch-up on the next qualifying tick.
  // Flooring makes "spent" exact: any fire landing in the answer's
  // minute or later consumes it. The two halves each looked right on
  // their own; only the PAIR was wrong.
  const answeredAt = now - (now % 60_000);

  const ran: string[] = [];
  const skipped: string[] = [];
  for (const entry of report.entries) {
    if (!wanted(entry)) continue;
    for (const schedule_id of entry.schedule_ids) {
      const runsThisOne = answer === 'run' && schedule_id === entry.run_schedule_id;
      if (runsThisOne) {
        deps.store.updateRun(schedule_id, {
          missed_answer: { at: answeredAt, answer: 'run' },
        });
        ran.push(schedule_id);
      } else {
        // ⛔ EVERY schedule the answer touched records it, INCLUDING the
        // siblings superseded by a `'run'`. Without the answer on the
        // row, `resolveMissedAction` still reads the miss as
        // outstanding — a skip moves no timestamp on purpose — so the
        // ask the owner just answered is raised again on the next tick,
        // and again, forever. `last_status` alone is a display fact;
        // the decision has to be somewhere the DECISION reads.
        deps.store.updateRun(schedule_id, {
          missed_answer: { at: answeredAt, answer: 'skip' },
          last_status: 'skipped',
          last_error: answer === 'run'
            ? 'Superseded by the newer missed run of this dish.'
            : 'Missed run skipped — you chose not to run it.',
        });
        skipped.push(schedule_id);
      }
    }
  }
  if (ran.length > 0 || skipped.length > 0) emitSchedule(deps.eventBus, 'updated');
  return { ran, skipped };
};

export const deleteSchedule = (
  deps: ScheduleHandlerDeps,
  schedule_id: string,
): { deleted: true } => {
  // D-215 slice 1 — `retireSchedule`, shared with the scheduler's one-shot
  // success path. D-319 — the schedule's dish stays.
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
  | 'schedules.delete'
  | 'schedules.missed'
  | 'schedules.answerMissed';

export const makeScheduleHandlers = (
  deps: ScheduleHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ScheduleMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'schedules.list', 'schedules.create', 'schedules.update', 'schedules.delete',
      'schedules.missed', 'schedules.answerMissed',
    ],
    handlers: {
      'schedules.list': async (args) =>
        listSchedules(deps, args as { recipe_id?: string }),
      'schedules.create': async (args) => createSchedule(deps, args),
      'schedules.missed': async () => missedRuns(deps),
      'schedules.answerMissed': async (args) => answerMissed(deps, args),
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
