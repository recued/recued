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
  compileTriggerSugarEntry,
  RpcError,
  validateRecipeEventTriggerEntry,
  type CompiledTriggerSubscription,
  type Dish,
  type EventTrigger,
  type HandlerSlice,
  type MailFactTypeSpec,
  type RecipeEventTrigger,
  type ServerRpcRegistry,
  type TriggerSugarOptions,
} from '@recued/contracts';
import type { WsClient } from '../ws-server.js';
import type { EventBus } from '../events/bus.js';
import { emitAutomationRule } from '../events/emit-sites.js';
import type { EventTriggersStore } from './store.js';
import type { EventTriggerDispatcher } from './dispatcher.js';
import type { DishStore } from '../dish-store.js';

export interface TriggersRpcDeps {
  store: EventTriggersStore;
  preapprovalStatus?: (triggerId: string) => Pick<EventTrigger, 'enabled' | 'lifecycle_revision' | 'preapproval'> | null;
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
  /** D-179 P2 / D-319 — dish lookup for create/update-time binding
   *  validation (existence + recipe match). Optional; absent ⇒ binding is
   *  type-checked only and the fire-time gate owns the rest. */
  dishStore?: Pick<DishStore, 'get'>;
  /** D-319 — the dish a trigger made for a recipe WITHOUT naming one belongs
   *  to: the recipe's main dish, made (on, with the settings given) when it
   *  has none (`mainDishFor`). Late-bound by the composition, because the
   *  dish rpc deps compose apart. Absent ⇒ such a trigger is dishless and
   *  settings are refused (a harness without dishes). */
  mainDish?: (input: {
    recipe_id: string;
    publisher_id: string;
    config_overlay: Record<string, unknown> | null;
  }) => Dish;
  /** D-315 §5.1 — the kinds of email the owner made on this server. A row made
   *  here is checked against every kind a fact here can have, so what no kind
   *  has is refused while the owner is there to fix it; a recipe's own trigger
   *  is only told (a kind made later may have it). */
  mailFactTypes?: () => readonly MailFactTypeSpec[];
  /** Override the clock (tests). */
  now?: () => number;
  /** Override the id generator (tests). */
  genId?: () => string;
}

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

/** D-315 §5.1 — a trigger made from the authoring shorthand (`on`, with
 *  `fields` and `where`) is validated and compiled exactly as a recipe's
 *  declared trigger is, so Automation's and Kitchen's "A mail fact" row make
 *  the row the reconciler would, strict filters included. It must compile to
 *  ONE subscription: a CRM alias fans out per vendor, which only a recipe's
 *  reconcile can keep in step. `null` when no `on` was given. */
const compileShorthand = (args: {
  on?: unknown;
  fields?: unknown;
  where?: unknown;
}, options: TriggerSugarOptions): CompiledTriggerSubscription | null => {
  if (args.on === undefined) {
    if (args.fields !== undefined || args.where !== undefined) {
      throw new RpcError('bad_request', 'fields and where narrow an `on` — give one', 400);
    }
    return null;
  }
  const entry = {
    on: args.on,
    ...(args.fields !== undefined ? { fields: args.fields } : {}),
    ...(args.where !== undefined ? { where: args.where } : {}),
  };
  const problems = validateRecipeEventTriggerEntry(entry, options);
  if (problems.length > 0) {
    throw new RpcError('bad_request', `The trigger cannot be made: ${problems[0]}`, 400, undefined, { problems });
  }
  const compiled = compileTriggerSugarEntry(entry as RecipeEventTrigger, [], options);
  if (compiled === null || compiled.length !== 1) {
    throw new RpcError('bad_request', `'${String(args.on)}' does not name one event on its own — give a pattern`, 400);
  }
  return compiled[0]!;
};

const requireNonEmptyString = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || v.length === 0) {
    throw new RpcError('bad_request', `${field} is required`, 400);
  }
  return v;
};

// D-179 P2 / D-319 — the dish a trigger belongs to. A trigger always has
// one: there is no clearing it.
const requireDishId = (v: unknown): string => {
  if (typeof v !== 'string' || v.length === 0) {
    throw new RpcError('bad_request', 'dish_id must be a non-empty string', 400);
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

// D-319 — validate the optional overlay: only a trigger that makes its
// recipe's main dish carries settings. `undefined` ⇒ null (none); a
// non-object ⇒ reject; an object ⇒ the overlay.
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

/** Attach the settings of the trigger's dish, shown with the row. Derived
 *  at read time — the dish is the source of truth; nothing extra is
 *  persisted, and a trigger has no settings of its own (D-319). */
const triggerWithConfig = (deps: TriggersRpcDeps, t: EventTrigger): EventTrigger => {
  const overlay = t.dish_id !== undefined ? deps.dishStore?.get(t.dish_id)?.config_overlay : undefined;
  return { ...t, ...deps.preapprovalStatus?.(t.trigger_id), ...(overlay !== undefined ? { config_overlay: overlay } : {}) };
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
    on?: unknown;
    fields?: unknown;
    where?: unknown;
    dish_id?: unknown;
    config_overlay?: unknown;
    watch_interval_ms?: unknown;
    enabled?: unknown;
  },
): Promise<{ trigger: EventTrigger }> => {
  const recipe_id = requireNonEmptyString(args.recipe_id, 'recipe_id');
  const publisher_id = requireNonEmptyString(args.publisher_id, 'publisher_id');
  const shorthand = compileShorthand(args, deps.mailFactTypes !== undefined ? { mailFactTypes: deps.mailFactTypes } : {});
  if (shorthand !== null && args.pattern !== undefined) {
    throw new RpcError('bad_request', 'give `on` or `pattern`, not both', 400);
  }
  const pattern = shorthand?.pattern ?? requireNonEmptyString(args.pattern, 'pattern');
  requirePatternValid(pattern);
  const overlay = optionalOverlay(args.config_overlay);
  const watch_interval_ms = args.watch_interval_ms === undefined
    ? null
    : requireWatchInterval(args.watch_interval_ms);
  const enabled = args.enabled === undefined ? true : args.enabled === true;
  const hasSettings = overlay !== null && Object.keys(overlay).length > 0;

  // D-319 — the dish the trigger belongs to, whose settings it runs with.
  let dish_id: string | null;
  if (args.dish_id !== undefined) {
    dish_id = requireDishId(args.dish_id);
    if (hasSettings) {
      throw new RpcError('bad_request', 'Settings belong to the dish — change them on the dish, not the trigger', 400);
    }
    requireDishBindsRecipe(deps, dish_id, recipe_id);
  } else if (deps.mainDish) {
    dish_id = deps.mainDish({ recipe_id, publisher_id, config_overlay: overlay }).dish_id;
  } else {
    if (hasSettings) {
      throw new RpcError('not_configured', 'Settings need a dish, and this server keeps none', 501);
    }
    dish_id = null;
  }

  const trigger_id = (deps.genId ?? genTriggerId)();
  const now = (deps.now ?? Date.now)();

  const trigger = deps.store.create({
    trigger_id,
    recipe_id,
    publisher_id,
    pattern,
    enabled,
    dish_id,
    watch_interval_ms,
    created_at: now,
    ...(shorthand?.filter !== undefined ? { filter: shorthand.filter } : {}),
    ...(shorthand?.fields !== undefined ? { fields: shorthand.fields } : {}),
  });
  deps.dispatcher?.rebuild();
  deps.onRulesChanged?.();
  emitAutomationRule(deps.eventBus, 'event_trigger');
  return { trigger };
};

// ────────────────────────────────────────────────────────────────
// triggers.update
// ────────────────────────────────────────────────────────────────

/** D-315 §5.1 — rows the owner made on this server that can never fire again,
 *  because the template or kind of email they are narrowed to was deleted, are
 *  switched off as the owner would switch them off. Their dish stays on: its
 *  other rows still run. A recipe's own rows are its recipe's to change. */
export const switchOffUserTriggers = async (
  deps: TriggersRpcDeps,
  match: (trigger: EventTrigger) => boolean,
): Promise<number> => {
  let switched = 0;
  for (const trigger of deps.store.list()) {
    if (trigger.origin !== 'user' || !match(trigger)) continue;
    await handleTriggersUpdate(deps, { trigger_id: trigger.trigger_id, enabled: false });
    switched += 1;
  }
  return switched;
};

export const handleTriggersUpdate = async (
  deps: TriggersRpcDeps,
  args: {
    trigger_id?: unknown;
    enabled?: unknown;
    pattern?: unknown;
    on?: unknown;
    fields?: unknown;
    where?: unknown;
    dish_id?: unknown;
    config_overlay?: unknown;
    watch_interval_ms?: unknown;
  },
): Promise<{ trigger: EventTrigger }> => {
  const trigger_id = requireNonEmptyString(args.trigger_id, 'trigger_id');
  // D-319 — settings belong to the trigger's dish.
  if (args.config_overlay !== undefined) {
    throw new RpcError('bad_request', 'A trigger has no settings of its own — change its dish’s settings', 400);
  }
  const patch: {
    enabled?: boolean;
    pattern?: string;
    dish_id?: string;
    watch_interval_ms?: number | null;
    filter?: Record<string, unknown> | null;
    fields?: string[] | null;
  } = {};
  if (args.enabled !== undefined) patch.enabled = args.enabled === true;
  const shorthand = compileShorthand(args, deps.mailFactTypes !== undefined ? { mailFactTypes: deps.mailFactTypes } : {});
  if (shorthand !== null || args.pattern !== undefined) {
    if (shorthand !== null && args.pattern !== undefined) {
      throw new RpcError('bad_request', 'give `on` or `pattern`, not both', 400);
    }
    const existing = deps.store.get(trigger_id);
    // What a recipe declared, its recipe narrows: a reconcile would put it back.
    if (shorthand !== null && existing?.origin === 'recipe') {
      throw new RpcError('bad_request', 'This trigger comes from its recipe — change it in the recipe', 400);
    }
    const p = shorthand?.pattern ?? requireNonEmptyString(args.pattern, 'pattern');
    requirePatternValid(p);
    patch.pattern = p;
    // On the owner's own row, a filter compiled for the old pattern never
    // carries over. A recipe's row keeps the reconciler's, as it always has.
    if (shorthand !== null || existing?.origin !== 'recipe') {
      patch.filter = shorthand?.filter ?? null;
      patch.fields = shorthand?.fields ?? null;
    }
  }
  if (args.dish_id !== undefined) {
    patch.dish_id = requireDishId(args.dish_id);
    const existing = deps.store.get(trigger_id);
    if (!existing) {
      throw new RpcError('not_found', `trigger ${trigger_id} not found`, 404);
    }
    // A recipe's trigger is made once per dish: a reconcile would put it back.
    if (existing.origin === 'recipe' && existing.dish_id !== patch.dish_id) {
      throw new RpcError('bad_request', 'This trigger comes from its recipe and belongs to the dish it was made for', 400);
    }
    requireDishBindsRecipe(deps, patch.dish_id, existing.recipe_id);
  }
  if (args.watch_interval_ms !== undefined) {
    patch.watch_interval_ms = requireWatchInterval(args.watch_interval_ms);
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
  // D-319 — the trigger's dish stays: its settings and other rows go on.
  if (!deps.store.remove(trigger_id)) {
    throw new RpcError('not_found', `trigger ${trigger_id} not found`, 404);
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
