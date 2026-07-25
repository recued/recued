/** Dish rpc handlers — D-179 P1, dispatched from the WS registry.
 *
 *  Four methods:
 *    dishes.list      list all (optional recipe_id filter)
 *    dishes.create    { recipe_id, name?, config_overlay?, enabled?, is_default? }
 *    dishes.update    { dish_id, name?, config_overlay?, enabled? }
 *    dishes.delete    by dish_id (also clears the continuity snapshot)
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
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import { estimateSize, type StorageGate } from '@recued/storage-gate';
import type { AuditLogStore } from '@recued/storage';
import type { DishStore } from './dish-store.js';
import type { DishGroupStore } from './dish-group-store.js';
import type { DishContextStore } from './dish-context-store.js';
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
}

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

export const listDishes = (
  deps: DishHandlerDeps,
  query: { recipe_id?: string },
): { dishes: Dish[] } => {
  const dishes = query.recipe_id
    ? deps.store.listByRecipe(query.recipe_id)
    : deps.store.list();
  return { dishes };
};

export const createDish = (
  deps: DishHandlerDeps,
  body: {
    recipe_id?: unknown;
    publisher_id?: unknown;
    name?: unknown;
    config_overlay?: unknown;
    enabled?: unknown;
    is_default?: unknown;
    group_id?: unknown;
  },
): { dish: Dish } => {
  const recipe_id = typeof body.recipe_id === 'string' ? body.recipe_id : null;
  if (!recipe_id) {
    throw new RpcError('bad_request', 'recipe_id is required', 400);
  }
  const publisher_id = typeof body.publisher_id === 'string' ? body.publisher_id : 'local';
  if (body.name !== undefined && typeof body.name !== 'string') {
    throw new RpcError('bad_request', 'name must be a string', 400);
  }
  const name = body.name ?? '';
  const config_overlay = body.config_overlay === undefined
    ? {}
    : requireOverlay(body.config_overlay, 'config_overlay');
  // `enabled` / `is_default` gate dish lifecycle — malformed input is
  // rejected, never silently defaulted (codex LOW fold).
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    throw new RpcError('bad_request', 'enabled must be a boolean', 400);
  }
  if (body.is_default !== undefined && typeof body.is_default !== 'boolean') {
    throw new RpcError('bad_request', 'is_default must be a boolean', 400);
  }
  const enabled = body.enabled ?? true;
  const is_default = body.is_default ?? false;
  if (body.group_id !== undefined && typeof body.group_id !== 'string') {
    throw new RpcError('bad_request', 'group_id must be a string', 400);
  }
  const group_id = body.group_id !== undefined
    ? requireGroupBinding(deps, body.group_id)
    : undefined;

  if (is_default && deps.store.getDefault(recipe_id) !== null) {
    throw new RpcError(
      'conflict',
      `Recipe '${recipe_id}' already has a default dish`,
      409,
    );
  }

  const now = deps.now?.() ?? Date.now();
  const dish: Dish = {
    dish_id: generateDishId(),
    recipe_id,
    publisher_id,
    name,
    is_default,
    config_overlay,
    enabled,
    ...(group_id !== undefined ? { group_id } : {}),
    created_at: now,
  };

  checkAdmission(deps, estimateSize(dish), 'creation', now);
  try {
    deps.store.set(dish);
  } catch (e) {
    // Default-dish unique-index race backstop — the pre-check above can
    // lose to a concurrent create; the partial index then raises here.
    if (is_default && e instanceof Error && e.message.includes('UNIQUE')) {
      throw new RpcError(
        'conflict',
        `Recipe '${recipe_id}' already has a default dish`,
        409,
      );
    }
    throw e;
  }
  return { dish };
};

export const updateDish = (
  deps: DishHandlerDeps,
  dish_id: string,
  body: { name?: unknown; config_overlay?: unknown; enabled?: unknown; group_id?: unknown },
): { dish: Dish } => {
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
  // `group_id: null` detaches; a string re-binds (validated); absent
  // leaves membership untouched.
  if (
    body.group_id !== undefined &&
    body.group_id !== null &&
    typeof body.group_id !== 'string'
  ) {
    throw new RpcError('bad_request', 'group_id must be a string or null', 400);
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
  return { dish: updated };
};

export const deleteDish = (
  deps: DishHandlerDeps,
  dish_id: string,
): { deleted: true } => {
  const deleted = deps.store.delete(dish_id);
  if (!deleted) {
    throw new RpcError('not_found', `Dish '${dish_id}' not found`, 404);
  }
  deps.contextStore?.clear(dish_id);
  return { deleted: true };
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
  return { deleted: true, detached_dish_ids };
};

// ────────────────────────────────────────────────────────────────
// Recipe install config — the recipe's `is_default` dish overlay
// (D-179). Applied as a base under per-run config for dishless runs
// (execute-handler). MUTABLE: the default dish is a config SOURCE, not a
// dispatch identity — its `dish_id` never lands in a run's audit — so
// editing in place is audit-safe (no immutable versioning needed).
// ────────────────────────────────────────────────────────────────

const findDefaultDish = (deps: DishHandlerDeps, recipe_id: string): Dish | null =>
  deps.store.listByRecipe(recipe_id).find((d) => d.is_default) ?? null;

export const getRecipeConfig = (
  deps: DishHandlerDeps,
  query: { recipe_id?: unknown },
): { config_overlay: Record<string, unknown> } => {
  if (typeof query.recipe_id !== 'string' || query.recipe_id.length === 0) {
    throw new RpcError('bad_request', 'recipe_id is required', 400);
  }
  const dish = findDefaultDish(deps, query.recipe_id);
  return { config_overlay: dish?.config_overlay ?? {} };
};

export const setRecipeConfig = (
  deps: DishHandlerDeps,
  body: { recipe_id?: unknown; publisher_id?: unknown; config_overlay?: unknown },
): { config_overlay: Record<string, unknown> } => {
  if (typeof body.recipe_id !== 'string' || body.recipe_id.length === 0) {
    throw new RpcError('bad_request', 'recipe_id is required', 400);
  }
  const recipe_id = body.recipe_id;
  const overlay = requireOverlay(body.config_overlay, 'config_overlay');
  const existing = findDefaultDish(deps, recipe_id);
  const now = deps.now?.() ?? Date.now();
  if (Object.keys(overlay).length === 0) {
    // Empty clears install config — drop the default dish + its snapshot.
    if (existing) {
      deps.store.delete(existing.dish_id);
      deps.contextStore?.clear(existing.dish_id);
    }
    return { config_overlay: overlay };
  }
  if (existing) {
    // In-place update (mutable config source — see the block header).
    const updated: Dish = { ...existing, config_overlay: overlay };
    checkAdmission(deps, Math.max(0, estimateSize(updated) - estimateSize(existing)), 'recipe config update', now);
    deps.store.set(updated);
  } else {
    const dish: Dish = {
      dish_id: generateDishId(),
      recipe_id,
      publisher_id: typeof body.publisher_id === 'string' ? body.publisher_id : 'local',
      name: '', // the default dish renders under the recipe's own name (fork c)
      is_default: true,
      config_overlay: overlay,
      enabled: true,
      created_at: now,
    };
    checkAdmission(deps, estimateSize(dish), 'recipe config creation', now);
    deps.store.set(dish);
  }
  return { config_overlay: overlay };
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type DishMethods =
  | 'dishes.list'
  | 'dishes.create'
  | 'dishes.update'
  | 'dishes.delete'
  | 'dish_groups.list'
  | 'dish_groups.create'
  | 'dish_groups.update'
  | 'dish_groups.delete'
  | 'recipe_config.get'
  | 'recipe_config.set';

export const makeDishHandlers = (
  deps: DishHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, DishMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'dishes.list', 'dishes.create', 'dishes.update', 'dishes.delete',
      'dish_groups.list', 'dish_groups.create', 'dish_groups.update', 'dish_groups.delete',
      'recipe_config.get', 'recipe_config.set',
    ],
    handlers: {
      'recipe_config.get': async (args) => getRecipeConfig(deps, args),
      'recipe_config.set': async (args) => setRecipeConfig(deps, args),
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
