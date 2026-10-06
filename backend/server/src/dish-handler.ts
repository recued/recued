/** Dish rpc handlers — D-179 P1, dispatched from the WS registry.
 *
 *  D-319 — a dish is a recipe switched on: its settings, a name and an
 *  On/Off switch, and the triggers and schedules that start it on its own.
 *    dishes.list      list all (optional recipe_id filter)
 *    dishes.create    { recipe_id, name?, config_overlay?, enabled? } — switch on
 *    dishes.update    { dish_id, name?, config_overlay?, enabled?, main? }
 *    dishes.delete    by dish_id — its rows and continuity snapshot go too
 *    dishes.defaults  { recipe_id } — what a new dish starts from
 *    dishes.history   a dish's runs, each with the settings it ran with
 *
 *  A recipe's first dish is its MAIN dish (`is_default`); the server sets
 *  it, never the caller. What each change does to the dish's rows lives in
 *  `dish-automation.ts`.
 *
 *  Synchronous (`store` is in-process SQLite). Standing dishes only —
 *  ephemeral (manual-run) dish ids are minted inside the execute
 *  handler and never reach this surface. Dishes live ONLY on this
 *  instance — no cloud sync (D-097/D-102).
 */

import {
  DISH_ID_PREFIX,
  DISH_GROUP_ID_PREFIX,
  RpcError,
  type Dish,
  type DishGroup,
  type DishLastRun,
  type DishRunRow,
  type DishWebhookDoorChange,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import { estimateSize, type StorageGate } from '@recued/storage-gate';
import type { AuditLogStore } from '@recued/storage';
import type { DishStore } from './dish-store.js';
import type { DishGroupStore } from './dish-group-store.js';
import type { DishContextStore } from './dish-context-store.js';
import type { DishAutomation } from './dish-automation.js';
import type { WsClient } from './ws-server.js';

export interface DishHandlerDeps {
  store: DishStore;
  /** D-179 P3 — dish groups. Absent ⇒ `dish_groups.*` and dish
   *  `group_id` bindings fail closed (`not_configured`). */
  groupStore?: DishGroupStore;
  /** Continuity snapshots — cleared on dish delete so a re-minted
   *  dish never inherits a dead instance's prior-run state. */
  contextStore?: DishContextStore;
  now?: () => number;
  /** Phase B gate — same posture as schedules: dishes are user-class,
   *  rejections surface as `storage_pressure`. Absent → no enforcement
   *  (legacy / test path). */
  gate?: StorageGate;
  /** Audit log — admission rejections emit `quota_exceeded` keyed to
   *  `dishes`. */
  auditLog?: AuditLogStore;
  /** D-319 — the rows that follow a dish (its triggers and schedules).
   *  Late-bound by the stage that composes triggers. Absent ⇒ dishes change
   *  and no row follows. */
  automation?: DishAutomation;
  /** D-319 — what a new dish of a recipe starts from beyond its variable
   *  defaults (D-315's mail templates). Late-bound. */
  defaultsFor?: (recipe_id: string) => Record<string, unknown>;
  /** The publisher a recipe is installed under — the one its dishes carry.
   *  Absent, or null for a recipe that is gone ⇒ `'local'`. */
  publisherOf?: (recipe_id: string) => string | null;
  /** D-319 — is the recipe installed, and does it start on its own? What the
   *  one refused switch reads ({@link refuseSwitchOnNotInstalled}). Late-bound
   *  by the composition. Absent (a harness) ⇒ nothing is refused; null ⇒ the
   *  server has no such recipe. */
  recipeInstall?: (recipe_id: string) => RecipeInstallState | null;
  /** D-209 — a recipe's webhook door FOLLOWS ITS MAIN DISH
   *  (`followMainDishWebhookDoors`): a pushed run takes the main dish's
   *  settings, so the door it runs under is re-derived whenever they change, the
   *  dish is made main, or the main dish goes. Late-bound by the composition
   *  (the door substrate composes after the dish stores). Absent ⇒ no door
   *  moves (a harness, or a server without webhooks). */
  webhookDoors?: {
    mainDishChanged(recipe_id: string): readonly DishWebhookDoorChange[];
  };
}

/** The door changes a main-dish change made, for the rpc result: only the ones
 *  that MOVED something — an unchanged door is not news to the owner. */
const movedWebhookDoors = (
  deps: DishHandlerDeps,
  recipe_id: string,
): { webhook_doors?: DishWebhookDoorChange[] } => {
  const moved = (deps.webhookDoors?.mainDishChanged(recipe_id) ?? [])
    .filter((change) => change.state !== 'unchanged');
  return moved.length > 0 ? { webhook_doors: [...moved] } : {};
};

/** D-319 — a recipe's install state, as the switch reads it. */
export interface RecipeInstallState {
  readonly installed: boolean;
  /** It declares a timer or a trigger (`startsOnItsOwn`). */
  readonly startsOnItsOwn: boolean;
  /** Its name, for the refusal. */
  readonly name: string;
  /** The packs that ship it (`<publisher>.<slug>`) — filled only when the
   *  answer is a refusal, so a switch that goes ahead pays no roster walk. */
  readonly packs: ReadonlyArray<{ readonly ref: string; readonly name: string }>;
}

/** Page size for `dishes.history` when the caller names none. Bounded
 *  because the audit store filters in JS over a full scan (§ 4.3) — an
 *  unbounded page would ship the whole log for one row's detail view. */
const DISH_HISTORY_DEFAULT_LIMIT = 50;

const generateDishId = (): string => {
  // Same scheme as schedule ids: timestamp (base36) + 6 random chars.
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${DISH_ID_PREFIX}${ts}${rnd}`;
};

const generateGroupId = (): string => {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${DISH_GROUP_ID_PREFIX}${ts}${rnd}`;
};

/** Validate a dish's group binding at write time: the group must
 *  exist (when a group store is wired). Returns the validated id. */
const requireGroupBinding = (
  deps: DishHandlerDeps,
  group_id: string,
): string => {
  if (!deps.groupStore) {
    throw new RpcError('not_configured', 'dish groups require a DB-backed server', 501);
  }
  if (deps.groupStore.get(group_id) === null) {
    throw new RpcError('not_found', `Dish group '${group_id}' not found`, 404);
  }
  return group_id;
};

const requireOverlay = (
  value: unknown,
  field: string,
): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RpcError('bad_request', `${field} must be an object`, 400);
  }
  return value as Record<string, unknown>;
};

/** D-319 — there are no managed dishes any more. A schedule, trigger or
 *  auto-run timer belongs to a dish and owns none (the per-row config dishes
 *  D-179 minted and D-215 guarded are retired), so every dish is the owner's
 *  to edit, switch and remove through this rpc. */

/** D-319 — refuse the one switch that would start nothing: switching on a
 *  recipe that starts on its own when the server only SHIPS it (bundled, not
 *  installed). Its own starts are read from the INSTALLED recipes alone — the
 *  auto-run roster (`listInstallInputs`) and the declarative trigger
 *  reconciler both walk `listStored()` — so the dish would show On while its
 *  timer and its triggers never ran. Switching on is what the owner asked;
 *  installing the pack is what makes it true, so the refusal says so.
 *
 *  ⚠ Only the switch: a schedule or trigger the owner adds names the recipe
 *  by id and runs the shipped copy, so a dish made to hold one
 *  (`mainDishFor`) and a dish that already holds one switch as before. Same
 *  code and `missing_packs` shape as the run and schedule refusals, so a
 *  surface can offer the same install link. */
const refuseSwitchOnNotInstalled = (deps: DishHandlerDeps, recipe_id: string): void => {
  const state = deps.recipeInstall?.(recipe_id);
  if (state === undefined || state === null || state.installed || !state.startsOnItsOwn) return;
  // One pack ⇒ name and link it; several ship it ⇒ any one would do, which
  // `missing_packs` ("install them") cannot say, so the message alone does.
  const only = state.packs.length === 1 ? state.packs[0] : undefined;
  throw new RpcError(
    'pack_not_installed',
    only !== undefined
      ? `'${state.name}' comes with the ${only.name} pack, which is not installed. `
        + 'Install it from Packs, then switch it on.'
      : `'${state.name}' comes with a pack that is not installed. Install it from Packs, then switch it on.`,
    400,
    undefined,
    only !== undefined ? { missing_packs: [only.ref] } : undefined,
  );
};

const checkAdmission = (
  deps: DishHandlerDeps,
  bytes: number,
  verb: string,
  now: number,
): void => {
  if (!deps.gate || bytes <= 0) return;
  const check = deps.gate.canWrite(bytes);
  if (check.ok) return;
  if (deps.auditLog) {
    void deps.auditLog.logActivity({
      activity_id: '',
      timestamp: now,
      action: 'quota_exceeded',
      target: 'dishes',
      detail: check.reason ?? 'storage_pressure',
    }).catch(() => { /* best-effort */ });
  }
  throw new RpcError(
    check.reason === 'writes_blocked' ? 'storage_pressure' : check.reason ?? 'storage_pressure',
    `dish ${verb} rejected: ${check.reason}`,
    507,
  );
};

export const listDishes = async (
  deps: DishHandlerDeps,
  query: { recipe_id?: string },
): Promise<{ dishes: Dish[]; last_runs?: Record<string, DishLastRun> }> => {
  const dishes = query.recipe_id
    ? deps.store.listByRecipe(query.recipe_id)
    : deps.store.list();
  // D-215 slice 3 — the last-outcome cell, resolved in ONE audit scan for
  // the whole page rather than per row. Absent audit store ⇒ the field is
  // omitted entirely; the surface treats "no map" and "not in the map"
  // identically (unknown → "never run"), so this degrades rather than
  // rendering every dish as failed.
  if (!deps.auditLog || dishes.length === 0) return { dishes };
  const latest = await deps.auditLog.latestByDishes(dishes.map((d) => d.dish_id));
  if (latest.size === 0) return { dishes };
  const last_runs: Record<string, DishLastRun> = {};
  for (const [dish_id, entry] of latest) {
    last_runs[dish_id] = {
      run_id: entry.run_id,
      started_at: entry.started_at,
      commit_status: entry.commit_status,
    };
  }
  return { dishes, last_runs };
};

/** D-215 slice 5 — one dish's run history, newest first.
 *
 *  ⚠ Consults NO dish store, deliberately. `dish_id` is an audit-row field
 *  and OUTLIVES the dish: auto-run config versioning dissolves the prior
 *  dish on every change, and a one-shot retires itself on success (§ 5).
 *  Looking the dish up here to "validate" the id would break exactly the
 *  case this exists to serve — a RETIRED dish's history.
 *
 *  An unknown id is an empty list, never an error. "No runs yet" and "this
 *  dish is gone" are both legitimate answers, and the caller distinguishes
 *  them by whether `dishes.list` still carries the row; the server has no
 *  better information than that. */
export const dishHistory = async (
  deps: DishHandlerDeps,
  query: { dish_id?: unknown; limit?: unknown },
): Promise<{ runs: DishRunRow[] }> => {
  const dish_id = typeof query.dish_id === 'string' ? query.dish_id : '';
  if (dish_id.length === 0) {
    throw new RpcError('bad_request', 'dish_id is required', 400);
  }
  if (!deps.auditLog) return { runs: [] };
  const limit = typeof query.limit === 'number' && Number.isFinite(query.limit)
    ? Math.max(0, Math.trunc(query.limit))
    : DISH_HISTORY_DEFAULT_LIMIT;
  const entries = await deps.auditLog.listByDish(dish_id, limit);
  return {
    runs: entries.map((entry) => ({
      run_id: entry.run_id,
      started_at: entry.started_at,
      duration_ms: entry.duration_ms,
      commit_status: entry.commit_status,
      trigger_source: entry.trigger_source,
      error: ((entry.errors ?? [])[0] as { message?: string } | undefined)?.message ?? null,
      // D-319 — a dish's settings are edited in place: what THIS run used.
      config: entry.config_snapshot !== undefined && entry.config_snapshot !== null
        ? { ...entry.config_snapshot }
        : null,
    })),
  };
};

/** Store a new dish. The recipe's first is its MAIN dish; a concurrent
 *  create that loses the race for main is stored as an ordinary one. */
const storeNewDish = (deps: DishHandlerDeps, dish: Dish, now: number): Dish => {
  checkAdmission(deps, estimateSize(dish), 'creation', now);
  try {
    deps.store.set(dish);
    return dish;
  } catch (e) {
    if (!dish.is_default || !(e instanceof Error) || !e.message.includes('UNIQUE')) throw e;
    const ordinary: Dish = { ...dish, is_default: false };
    deps.store.set(ordinary);
    return ordinary;
  }
};

/** D-319 — switch a recipe on: a dish with these settings. `switchOn`
 *  (default: the dish's own `enabled`) turns on every row it starts with —
 *  the recipe's declared triggers; a dish made only to hold a schedule's or
 *  a trigger's settings passes `false`, and only that row runs. */
export const createDish = (
  deps: DishHandlerDeps,
  body: {
    recipe_id?: unknown;
    publisher_id?: unknown;
    name?: unknown;
    config_overlay?: unknown;
    enabled?: unknown;
    group_id?: unknown;
  },
  opts: { readonly switchOn?: boolean } = {},
): { dish: Dish; webhook_doors?: DishWebhookDoorChange[] } => {
  const recipe_id = typeof body.recipe_id === 'string' ? body.recipe_id : null;
  if (!recipe_id) {
    throw new RpcError('bad_request', 'recipe_id is required', 400);
  }
  const publisher_id = typeof body.publisher_id === 'string'
    ? body.publisher_id
    : deps.publisherOf?.(recipe_id) ?? 'local';
  if (body.name !== undefined && typeof body.name !== 'string') {
    throw new RpcError('bad_request', 'name must be a string', 400);
  }
  const name = body.name ?? '';
  const config_overlay = body.config_overlay === undefined
    ? {}
    : requireOverlay(body.config_overlay, 'config_overlay');
  // `enabled` gates dish lifecycle — malformed input is rejected, never
  // silently defaulted (codex LOW fold).
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw new RpcError('bad_request', 'enabled must be a boolean', 400);
  }
  const enabled = body.enabled ?? true;
  if (body.group_id !== undefined && typeof body.group_id !== 'string') {
    throw new RpcError('bad_request', 'group_id must be a string', 400);
  }
  const group_id = body.group_id !== undefined
    ? requireGroupBinding(deps, body.group_id)
    : undefined;
  // What `created` turns on: the switch, and only for a dish made on.
  if ((opts.switchOn ?? enabled) && enabled) refuseSwitchOnNotInstalled(deps, recipe_id);

  const now = deps.now?.() ?? Date.now();
  const dish = storeNewDish(deps, {
    dish_id: generateDishId(),
    recipe_id,
    publisher_id,
    name,
    is_default: deps.store.getDefault(recipe_id) === null,
    config_overlay,
    enabled,
    ...(group_id !== undefined ? { group_id } : {}),
    created_at: now,
  }, now);
  deps.automation?.created(dish, { switchOn: opts.switchOn ?? enabled });
  // The recipe's first dish is its main one: its settings are what a pushed run
  // now takes, so a webhook door that could not exist before may exist now.
  return { dish, ...(dish.is_default ? movedWebhookDoors(deps, recipe_id) : {}) };
};

/** D-319 — the dish a schedule or trigger made for a recipe WITHOUT naming
 *  one belongs to: the recipe's main dish. With none, one is made, on, from
 *  the settings given — the caller asked for them (the run dialog's
 *  "Config for every scheduled run"). It is not switched on as a whole: only
 *  the row being made runs, and the recipe's own triggers wait for the
 *  switch (§ 3.3).
 *
 *  Settings given for a recipe that HAS a main dish are refused unless they
 *  are its settings already: settings belong to the dish, and quietly
 *  dropping them would run the row with values the owner did not choose.
 *
 *  D-209 — making the main dish can open, change or close the recipe's webhook
 *  door, as `dishes.create` can; `webhook_doors` says what moved, for the rpc
 *  that made the row to return. An existing main dish moves nothing. */
export const mainDishFor = (
  deps: DishHandlerDeps,
  input: { recipe_id: string; publisher_id: string; config_overlay: Record<string, unknown> | null },
): { dish: Dish; webhook_doors?: DishWebhookDoorChange[] } => {
  const main = deps.store.getDefault(input.recipe_id);
  if (main !== null) {
    const given = input.config_overlay ?? {};
    if (Object.keys(given).length > 0 && !sameSettings(given, main.config_overlay)) {
      throw new RpcError(
        'conflict',
        `Settings belong to the dish: '${input.recipe_id}' runs with the settings of its dish `
          + `'${main.dish_id}' — change them there, or add another dish with these.`,
        409,
      );
    }
    return { dish: main };
  }
  return createDish(deps, {
    recipe_id: input.recipe_id,
    publisher_id: input.publisher_id,
    config_overlay: input.config_overlay ?? {},
    enabled: true,
  }, { switchOn: false });
};

/** Key-order-independent equality of two settings overlays. */
const sameSettings = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
    }
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
};

/** D-319 — settings change in place, from the dish's next run (each run
 *  records what it used); `enabled` switches every row of the dish, and is
 *  acted on even when unchanged — "switch on" is also how the owner re-arms
 *  a dish some of whose rows the server stopped; `main: true` makes it the
 *  recipe's main dish. */
export const updateDish = (
  deps: DishHandlerDeps,
  dish_id: string,
  body: { name?: unknown; config_overlay?: unknown; enabled?: unknown; group_id?: unknown; main?: unknown },
): { dish: Dish; webhook_doors?: DishWebhookDoorChange[] } => {
  const existing = deps.store.get(dish_id);
  if (!existing) {
    throw new RpcError('not_found', `Dish '${dish_id}' not found`, 404);
  }
  if (body.name !== undefined && typeof body.name !== 'string') {
    throw new RpcError('bad_request', 'name must be a string', 400);
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw new RpcError('bad_request', 'enabled must be a boolean', 400);
  }
  if (body.main !== undefined && body.main !== true) {
    throw new RpcError('bad_request', 'main must be true — make another dish main instead', 400);
  }
  // `group_id: null` detaches; a string re-binds (validated); absent
  // leaves membership untouched.
  if (
    body.group_id !== undefined &&
    body.group_id !== null &&
    typeof body.group_id !== 'string'
  ) {
    throw new RpcError('bad_request', 'group_id must be a string or null', 400);
  }
  // Off → On is a switch on. A dish that holds a schedule or trigger of its
  // own still switches: those rows run the shipped recipe by id. One with
  // none would only re-arm the recipe's own starts, which it never runs.
  if (body.enabled === true && !existing.enabled
    && (deps.automation?.ownRows?.(dish_id) ?? 0) === 0) {
    refuseSwitchOnNotInstalled(deps, existing.recipe_id);
  }
  const updated: Dish = {
    ...existing,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.config_overlay !== undefined
      ? { config_overlay: requireOverlay(body.config_overlay, 'config_overlay') }
      : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
  };
  if (body.group_id === null) {
    delete updated.group_id;
  } else if (typeof body.group_id === 'string') {
    updated.group_id = requireGroupBinding(deps, body.group_id);
  }

  const now = deps.now?.() ?? Date.now();
  const projected = Math.max(0, estimateSize(updated) - estimateSize(existing));
  checkAdmission(deps, projected, 'update', now);
  deps.store.set(updated);
  const stored = body.main === true ? deps.store.setMain(dish_id) ?? updated : updated;

  // A switch re-makes the recipe's rows before writing them, so settings
  // changed in the same call are followed by it too.
  if (body.enabled !== undefined) deps.automation?.switched(stored);
  else if (body.config_overlay !== undefined || body.group_id !== undefined) deps.automation?.settingsChanged(stored);
  else deps.automation?.touched();
  // The main dish's settings are what a pushed run takes: they changed if this
  // dish is main and its settings did, or if it just BECAME main.
  const mainSettingsMoved = stored.is_default
    && (body.config_overlay !== undefined || !existing.is_default);
  return {
    dish: stored,
    ...(mainSettingsMoved ? movedWebhookDoors(deps, stored.recipe_id) : {}),
  };
};

/** D-319 — remove a dish: its triggers and schedules go with it, and its
 *  run-to-run memory. Removing the main dish makes the oldest remaining one
 *  main, so the runs that name no dish keep settings to run with. */
export const deleteDish = (
  deps: DishHandlerDeps,
  dish_id: string,
): { deleted: true; webhook_doors?: DishWebhookDoorChange[] } => {
  // Read BEFORE deleting: the rows are found by the dish's id.
  const existing = deps.store.get(dish_id);
  if (!existing) {
    throw new RpcError('not_found', `Dish '${dish_id}' not found`, 404);
  }
  if (!deps.store.delete(dish_id)) {
    throw new RpcError('not_found', `Dish '${dish_id}' not found`, 404);
  }
  deps.contextStore?.clear(dish_id);
  if (existing.is_default) {
    const next = deps.store.listByRecipe(existing.recipe_id)
      .sort((a, b) => a.created_at - b.created_at || (a.dish_id < b.dish_id ? -1 : 1))[0];
    if (next !== undefined) deps.store.setMain(next.dish_id);
  }
  deps.automation?.deleted(existing);
  // Removing the main dish hands its role to the next one, or to none — either
  // way a pushed run now takes different settings.
  return {
    deleted: true,
    ...(existing.is_default ? movedWebhookDoors(deps, existing.recipe_id) : {}),
  };
};

// ────────────────────────────────────────────────────────────────
// Dish groups — D-179 P3
// ────────────────────────────────────────────────────────────────

const requireGroupStore = (deps: DishHandlerDeps): DishGroupStore => {
  if (!deps.groupStore) {
    throw new RpcError('not_configured', 'dish groups require a DB-backed server', 501);
  }
  return deps.groupStore;
};

export const listDishGroups = (
  deps: DishHandlerDeps,
): { groups: { group: DishGroup; member_dish_ids: string[] }[] } => {
  const groupStore = requireGroupStore(deps);
  return {
    groups: groupStore.list().map((group) => ({
      group,
      member_dish_ids: deps.store.listByGroup(group.group_id).map((d) => d.dish_id),
    })),
  };
};

export const createDishGroup = (
  deps: DishHandlerDeps,
  body: { name?: unknown; config_overlay?: unknown },
): { group: DishGroup } => {
  const groupStore = requireGroupStore(deps);
  if (typeof body.name !== 'string' || body.name.length === 0) {
    throw new RpcError('bad_request', 'name is required', 400);
  }
  const config_overlay = body.config_overlay === undefined
    ? {}
    : requireOverlay(body.config_overlay, 'config_overlay');
  const now = deps.now?.() ?? Date.now();
  const group: DishGroup = {
    group_id: generateGroupId(),
    name: body.name,
    config_overlay,
    created_at: now,
  };
  checkAdmission(deps, estimateSize(group), 'group creation', now);
  groupStore.set(group);
  return { group };
};

export const updateDishGroup = (
  deps: DishHandlerDeps,
  group_id: string,
  body: { name?: unknown; config_overlay?: unknown },
): { group: DishGroup } => {
  const groupStore = requireGroupStore(deps);
  const existing = groupStore.get(group_id);
  if (!existing) {
    throw new RpcError('not_found', `Dish group '${group_id}' not found`, 404);
  }
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length === 0)) {
    throw new RpcError('bad_request', 'name must be a non-empty string', 400);
  }
  const updated: DishGroup = {
    ...existing,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.config_overlay !== undefined
      ? { config_overlay: requireOverlay(body.config_overlay, 'config_overlay') }
      : {}),
  };
  const now = deps.now?.() ?? Date.now();
  const projected = Math.max(0, estimateSize(updated) - estimateSize(existing));
  checkAdmission(deps, projected, 'group update', now);
  groupStore.set(updated);
  // Its dishes' runs read the group's settings, so their triggers follow them
  // (a folder or mailbox a trigger watches may be set here).
  if (body.config_overlay !== undefined) {
    for (const member of deps.store.listByGroup(group_id)) deps.automation?.settingsChanged(member);
  }
  return { group: updated };
};

export const deleteDishGroup = (
  deps: DishHandlerDeps,
  group_id: string,
): { deleted: true; detached_dish_ids: string[] } => {
  const groupStore = requireGroupStore(deps);
  // Existence first (codex fold): a vanished group is `not_found`,
  // never a silent success off dangling members. Then detach members
  // BEFORE dropping the row — detachGroup is itself transactional, so
  // a crash between the two leaves only an empty group behind
  // (re-deletable), never dishes pointing at a vanished group.
  if (groupStore.get(group_id) === null) {
    throw new RpcError('not_found', `Dish group '${group_id}' not found`, 404);
  }
  const detached_dish_ids = deps.store.detachGroup(group_id);
  groupStore.delete(group_id);
  // The detached dishes no longer read the group's settings; their triggers follow.
  for (const dish_id of detached_dish_ids) {
    const dish = deps.store.get(dish_id);
    if (dish !== null) deps.automation?.settingsChanged(dish);
  }
  return { deleted: true, detached_dish_ids };
};

/** D-319 — what a new dish of this recipe starts from beyond its variable
 *  defaults. */
export const dishDefaults = (
  deps: DishHandlerDeps,
  query: { recipe_id?: unknown },
): { config_overlay: Record<string, unknown> } => {
  if (typeof query.recipe_id !== 'string' || query.recipe_id.length === 0) {
    throw new RpcError('bad_request', 'recipe_id is required', 400);
  }
  return { config_overlay: deps.defaultsFor?.(query.recipe_id) ?? {} };
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type DishMethods =
  | 'dishes.list'
  | 'dishes.create'
  | 'dishes.update'
  | 'dishes.delete'
  | 'dishes.history'
  | 'dishes.defaults'
  | 'dish_groups.list'
  | 'dish_groups.create'
  | 'dish_groups.update'
  | 'dish_groups.delete';

export const makeDishHandlers = (
  deps: DishHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, DishMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'dishes.list', 'dishes.create', 'dishes.update', 'dishes.delete',
      'dishes.history', 'dishes.defaults',
      'dish_groups.list', 'dish_groups.create', 'dish_groups.update', 'dish_groups.delete',
    ],
    handlers: {
      'dishes.list': async (args) =>
        listDishes(deps, args as { recipe_id?: string }),
      'dishes.create': async (args) => createDish(deps, args),
      'dishes.update': async (args) => {
        if (!args.dish_id || typeof args.dish_id !== 'string') {
          throw new RpcError('bad_request', 'dish_id is required', 400);
        }
        return updateDish(deps, args.dish_id, args);
      },
      'dishes.delete': async (args) => {
        if (!args.dish_id || typeof args.dish_id !== 'string') {
          throw new RpcError('bad_request', 'dish_id is required', 400);
        }
        return deleteDish(deps, args.dish_id);
      },
      'dishes.history': async (args) =>
        dishHistory(deps, args as { dish_id?: unknown; limit?: unknown }),
      'dishes.defaults': async (args) => dishDefaults(deps, args),
      'dish_groups.list': async () => listDishGroups(deps),
      'dish_groups.create': async (args) => createDishGroup(deps, args),
      'dish_groups.update': async (args) => {
        if (!args.group_id || typeof args.group_id !== 'string') {
          throw new RpcError('bad_request', 'group_id is required', 400);
        }
        return updateDishGroup(deps, args.group_id, args);
      },
      'dish_groups.delete': async (args) => {
        if (!args.group_id || typeof args.group_id !== 'string') {
          throw new RpcError('bad_request', 'group_id is required', 400);
        }
        return deleteDishGroup(deps, args.group_id);
      },
    },
  };
};
