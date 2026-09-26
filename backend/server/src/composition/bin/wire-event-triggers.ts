/** Event-trigger substrate composer (reactive-substrate slice 1).
 *
 *  The D-109 Phase G substrate (store + dispatcher + `triggers.*` rpc
 *  handlers) shipped as modules but was never wired into cmdServe —
 *  `ws-server.ts` accepted `triggersDeps` optionally and nothing in the
 *  production composition constructed it, so the whole event-trigger
 *  surface was silently dead (the D-167 P5 Slice 2b trap, one layer
 *  earlier). This composer is the production boot:
 *
 *    1. `createEventTriggersStore(db)` — SQLite `event_triggers` rows.
 *    2. `createEventTriggerDispatcher` — subscribes every enabled
 *       trigger's pattern on the warehouse bus, dispatches matches
 *       through `handleExecute` with the D-153 P2.C
 *       `(channel: 'reactive', actor: 'system')` execution source so
 *       the policy gate evaluates event-trigger fires against the same
 *       matrix cell auto-run fires use.
 *    3. Returns `triggersDeps` for `createServerHandlerSet` (the
 *       `triggers.*` rpc slice) + the dispatcher handle so the
 *       post-listener runtime can register its stop closure with the
 *       background-services registry (`kind: 'scheduler'` — triggers
 *       stop firing during migration maintenance alongside cron +
 *       auto-run; like housekeeping they stay stopped until daemon
 *       restart per the D-123 P7 precedent).
 *
 *  Backfill suppression (D-124 Phase 2.2) rides a fresh
 *  `createInstanceStore({ db })` handle — instance stores are cheap
 *  prepared-statement wrappers over the shared db (same posture as
 *  housekeeping's own instance store).
 *
 *  Boot ordering: collection adapters start in
 *  `startBootRecoveryAndAdapters`, BEFORE the listener composition
 *  this composer runs in — warehouse events emitted in that window
 *  are not dispatched. Deliberate: initial-sync events are backfill-
 *  suppressed anyway, trigger delivery is at-most-once by design (no
 *  replay), and the window is the same one every listener-time bus
 *  subscriber has.
 *
 *  Absent `db` → returns undefined and the rpc surface stays
 *  `not_configured`, mirroring every other db-gated handler family. */

import type Database from 'better-sqlite3';
import { deriveRunYield, runYieldIsTotalRefusal } from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import type { WarehouseEventBus } from '@recued/warehouse-events';

import type { LocalManifestStore } from '../../ingredient-authoring/local-manifest-store.js';
import { liveVendorRegistry } from '../../recipe-runnability-handler.js';
import { createInstanceStore } from '../../collections/instance-store.js';
import type { EventBus } from '../../events/bus.js';
import { emitAutomationRule, emitReactiveFire } from '../../events/emit-sites.js';
import { handleExecute, type ExecuteHandlerDeps } from '../../execute-handler.js';
import type { TriggersRpcDeps } from '../../triggers/handler.js';
import { createBackfillStateLookup } from '../../triggers/backfill-state.js';
import { reconcileDeclarativeTriggers } from '../../triggers/declarative-reconciler.js';
import {
  createEventTriggerDispatcher,
  type EventTriggerDispatcher,
  type EventTriggerDispatcherDeps,
} from '../../triggers/dispatcher.js';
import { createEventTriggersStore, type EventTriggersStore } from '../../triggers/store.js';

export interface ComposeEventTriggersInput {
  /** SQLite handle. Absent (dbless harness) → substrate stays unwired. */
  db: Database.Database | undefined;
  /** Warehouse-events bus the dispatcher subscribes patterns on. */
  warehouseBus: WarehouseEventBus;
  /** Shared execute deps — the dispatcher's `runRecipe` runtime routes
   *  through the same `handleExecute` composition the schedulers use,
   *  so gating / audit / approvals apply uniformly. */
  executeDeps: ExecuteHandlerDeps;
  auditLog: AuditLogStore | undefined;
  /** D-121 broadcast bus — trigger fires emit `reactive_fire`; the
   *  error-cap auto-disable emits `automation_rule_changed`. */
  eventBus: EventBus | undefined;
  /** Authoring sugar — the reconciler compiles `on:` alias forms
   *  against the live merged vendor registry (built-ins + installed
   *  3rd-party packs), the SAME source install / runnability / watch
   *  use. Absent (manifest-less boots) → `liveVendorRegistry` still
   *  yields the built-ins, so `on: deal.changed` fans across
   *  HubSpot + Salesforce regardless. */
  localManifestStore:
    | Pick<LocalManifestStore, 'listManifests' | 'getEntitySchemas'>
    | undefined;
  /** R21.1 — live vault-unlocked predicate. The dispatcher drops the
   *  reactive fan-out while sealed. Absent → un-gated. */
  isVaultUnlocked?: () => boolean;
  /** D-268 — deliver one owner notice about a failed fire. Absent ⇒ failures
   *  reach the trigger row and nobody else. */
  onAutomationFailure?: EventTriggerDispatcherDeps['onAutomationFailure'];
}

export interface EventTriggersBundle {
  triggersDeps: TriggersRpcDeps;
  /** Live dispatcher — the post-listener runtime registers its stop
   *  closure with the background-services registry. */
  dispatcher: EventTriggerDispatcher;
  /** The trigger store — the watch poll-manager derives its demand
   *  from enabled rows (G6). */
  store: EventTriggersStore;
  /** G6 — re-run the declarative reconcile (installed recipes'
   *  `event_triggers` ⇆ `origin: 'recipe'` store rows) and, when the
   *  row set changed, rebuild the dispatcher + emit
   *  `automation_rule_changed`. Returns true when rows changed (the
   *  caller chains a watch recompute). Hooked to recipe-store
   *  mutations + maintenance exit by the composition. */
  reconcile: () => boolean;
  /** D-296 — the vendor registry the reconcile compiles sugar against, so the
   *  pack install preview compiles the SAME declarations. */
  getVendorEntities: () => ReturnType<typeof liveVendorRegistry>;
}

export const composeEventTriggers = (
  input: ComposeEventTriggersInput,
): EventTriggersBundle | undefined => {
  const {
    db, warehouseBus, executeDeps, auditLog, eventBus, localManifestStore, isVaultUnlocked,
    onAutomationFailure,
  } = input;
  if (!db) return undefined;

  const store = createEventTriggersStore(db);
  const backfillState = createBackfillStateLookup({
    instances: createInstanceStore({ db }),
  });

  const dispatcher = createEventTriggerDispatcher({
    bus: warehouseBus,
    store,
    getPreapprovalDriver: () => executeDeps.preapprovalDriver,
    runtime: {
      runRecipe: async ({ recipe_id, context, dish_id, trigger_id, candidate }) => {
        const driver = executeDeps.preapprovalDriver;
        // A queued legacy event cannot acquire a newly composed/accepted
        // reviewed execution. Live rows are reread even without the driver.
        if ((driver && !candidate) || (!driver && !store.get(trigger_id)?.enabled)) return { skipped: true };
        // D-179 P2 — fire-time dish gate. A disabled (or vanished)
        // standing dish SKIPS the fire silently: the attachment stays
        // armed, the trigger records a clean fire, and no failed-run
        // noise lands in audit. Lookup is best-effort — an unwired
        // dish store (dbless) degrades to a dishless dispatch.
        if (dish_id !== null && executeDeps.dishStore) {
          const dish = executeDeps.dishStore.get(dish_id);
          if (!dish || !dish.enabled) {
            console.warn(
              `[event-triggers] skipping fire for recipe ${recipe_id}: dish ${dish_id} `
                + (dish ? 'is disabled' : 'no longer exists'),
            );
            return { skipped: true };
          }
        }
        // The dispatcher built `context.event` with the canonical
        // topic path — surface it as the execution source's
        // `event_kind` so audit rows say WHICH event fired the run,
        // not just "an event did".
        const event = (context as {
          event?: { topic?: string[]; kind?: string };
        }).event;
        const event_kind =
          event?.topic?.join('.') ?? event?.kind ?? 'event_trigger';
        const request: Parameters<typeof handleExecute>[1] = {
          recipe_id,
          trigger_source: 'event_trigger',
          execution_source: {
            channel: 'reactive',
            actor: 'system',
            event_kind,
            source_recipe: recipe_id,
            // D-215 slice 1a — background automation is contract-free.
            // The `(reactive, system)` channel already resolves to the `read`
            // ceiling, so writes still HOLD without turning the owner sentinel
            // into a bound door that would require an impossible snapshot.
          },
          context,
          // D-179 P2 — the dish overlay resolves INSIDE handleExecute
          // (dish → install → defaults), replacing the retired
          // `config_patch` shallow merge.
          ...(dish_id !== null ? { dish_id } : {}),
        };
        const result = driver ? await driver.executeTrigger(request, candidate!) : await handleExecute(executeDeps, request);
        if (!result) return { skipped: true };
        emitReactiveFire(eventBus, recipe_id);
        // A trigger-gate skip is a successful evaluation, not a
        // failure — only real execution errors feed the dispatcher's
        // 24h error cap.
        if (!result.success && !result.trigger_skipped && !result.awaiting_approval && !result.awaiting_peer) {
          const first = result.errors[0] as { message?: string; code?: string } | undefined;
          // ⛔⛔ D-268 — THE CODE HAS TO SURVIVE THE THROW. This raised a bare
          // `new Error(message)`, which was harmless while the only consumer
          // COUNTED failures — and became a live defect the moment the count
          // depended on the KIND. An unclassified failure stops at the first
          // occurrence (fail closed), so discarding the code here would disarm
          // every trigger on its first transient network blip. The code is the
          // whole difference between "wait, it may pass" and "waiting buys
          // nothing".
          const error = new Error(first?.message ?? 'execution failed') as Error & { code?: string };
          if (typeof first?.code === 'string') error.code = first.code;
          throw error;
        }
        // D-268 — the success-shaped failure: a `foreach` is continue-on-error,
        // so a run whose every item was refused arrives here reporting success.
        // REPORTED, never thrown — the run did complete, and throwing would make
        // the dispatcher write a `last_error` for a run that had none.
        if (result.success && runYieldIsTotalRefusal(deriveRunYield(result.steps))) {
          return { total_refusal: true };
        }
      },
    },
    ...(auditLog ? { auditLog } : {}),
    ...(eventBus ? { eventBus } : {}),
    backfillState,
    ...(isVaultUnlocked ? { isVaultUnlocked } : {}),
    ...(onAutomationFailure ? { onAutomationFailure } : {}),
  });
  // G6 — materialize installed recipes' declarative `event_triggers`
  // into store rows BEFORE the first rebuild, so boot subscribes them
  // in the same pass. Reconcile-then-rebuild is the same closure the
  // recipe-store mutation hook + maintenance exit call later.
  const reconcilerDeps = {
    store,
    listStored: () => executeDeps.recipeStore.listStored(),
    // Authoring sugar — alias-form fan source. The thunk re-reads the
    // manifest store per reconcile, so a 3rd-party CRM pack installed
    // mid-process widens `on: deal.changed` on the very reconcile its
    // install triggers (pack install mutates the recipe store).
    // Throw-contained to the BUILT-IN registry: this runs at boot
    // composition — a broken/partial manifest store must degrade the
    // alias fan to HubSpot + Salesforce, never kill trigger
    // materialization (and with it the whole listener composition).
    getVendorEntities: () => {
      try {
        return liveVendorRegistry(localManifestStore);
      } catch (e) {
        console.warn('[triggers] live vendor registry unavailable — alias sugar fans built-ins only', e);
        return liveVendorRegistry(undefined);
      }
    },
    // D-179 P5c — managed-dish dissolution when an uninstall removes
    // the managing recipe-origin row.
    ...(executeDeps.dishStore ? { dishStore: executeDeps.dishStore } : {}),
    ...(executeDeps.dishContextStore
      ? { dishContextStore: executeDeps.dishContextStore }
      : {}),
  };
  const reconcile = (): boolean => {
    const result = reconcileDeclarativeTriggers(reconcilerDeps);
    if (result.changed) {
      dispatcher.rebuild();
      emitAutomationRule(eventBus, 'event_trigger');
    }
    return result.changed;
  };
  reconcileDeclarativeTriggers(reconcilerDeps);
  dispatcher.rebuild();

  return {
    getVendorEntities: reconcilerDeps.getVendorEntities,
    triggersDeps: {
      store,
      dispatcher,
      ...(eventBus ? { eventBus } : {}),
      // D-179 P2 — create/update-time dish-binding validation.
      ...(executeDeps.dishStore ? { dishStore: executeDeps.dishStore } : {}),
      // D-179 config-on-trigger — clear the managed dish's continuity
      // snapshot when a trigger's overlay dish is dissolved on delete.
      ...(executeDeps.dishContextStore
        ? { dishContextStore: executeDeps.dishContextStore }
        : {}),
    },
    dispatcher,
    store,
    reconcile,
  };
};
