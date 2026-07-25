/** Phase G (D-109) — warehouse-event → recipe dispatcher.
 *
 *  Subscribes to the warehouse bus on boot, then dispatches each
 *  matching event to `executeRecipe` with the event payload on
 *  `context.event`. Two-way lifecycle:
 *    1. `rebuild()` — called on boot + after every `triggers.*`
 *       mutation. Tears down existing subscriptions, reads the
 *       current enabled trigger set, subscribes each pattern.
 *    2. `dispose()` — called on drain. Unsubscribes all without
 *       flushing in-flight dispatches (the drain orchestrator
 *       stops `executeRecipe` via its own `pause_collections`
 *       step so the caller-side drain flows through naturally).
 *
 *  Failure semantics:
 *    - Missing recipe → auto-disable via the error-cap (the
 *      trigger's `last_error` captures why; the Recipes UI shows
 *      "Auto-disabled — click to resume").
 *    - Recipe execution error → log `last_error` + increment the
 *      per-trigger 24h error counter. Counter cap is config-
 *      driven (`triggers.auto_disable_after_errors_24h`, default 10).
 *
 *  The dispatcher does not observe the drain state directly; callers
 *  are responsible for invoking `dispose()` from the drain pipeline
 *  (see `backend/server/src/lifecycle/drain-orchestrator.ts` step
 *  registration). */

import type {
  WarehouseEvent,
  WarehouseEventBus,
} from '@recued/warehouse-events';
import { matchesPattern, eventPath, RUN_OUTCOME_PLATFORM } from '@recued/warehouse-events';
import type { AuditLogStore } from '@recued/storage';
import type { EventTrigger } from '@recued/contracts';
import { matchesTriggerDispatchFilter } from '@recued/contracts';
import type { EventBus } from '../events/bus.js';
import { emitAutomationRule } from '../events/emit-sites.js';
import type { EventTriggersStore } from './store.js';
import type { BackfillStateLookup } from './backfill-state.js';
import { createTriggerDispatchQueue } from './queue.js';

/** Callback the dispatcher invokes when a trigger matches. Wired to
 *  `serverExecutor.executeRecipe` by the composition root; tests
 *  pass a spy. Returning (success or error) is captured into the
 *  trigger's `last_fired_at` + `last_error`; synchronous throws are
 *  treated identically to rejected promises. */
export interface TriggerDispatchRuntime {
  runRecipe: (input: {
    recipe_id: string;
    publisher_id: string;
    context: Record<string, unknown>;
    /** D-179 P2 — standing dish the trigger dispatches as (the dish
     *  overlay resolves inside handleExecute; fire-time enabled gate
     *  lives in the runtime's runRecipe). Null = dishless. */
    dish_id: string | null;
    trigger_id: string;
  }) => Promise<void>;
}

export interface EventTriggerDispatcher {
  /** Idempotent — safe to call repeatedly. Subscribes every enabled
   *  trigger from the store. Unsubscribes prior subs first. */
  rebuild(): void;
  /** Tear down every subscription without rebuilding. Called on
   *  drain. */
  dispose(): void;
  /** Current subscription count (tests + observability). */
  activeSubscriptions(): number;
  /** D-124 Phase 2.3 — number of currently active queue keys
   *  (in-flight + queued events grouped by `(trigger_id, record_id)`).
   *  Tests + observability surface. */
  activeQueueKeys(): number;
  /** D-124 Phase 2.3 — resolve once every in-flight dispatch settles.
   *  Test affordance — production callers don't need it (the drain
   *  orchestrator runs `pause_collections` upstream). */
  drained(): Promise<void>;
}

export interface EventTriggerDispatcherDeps {
  bus: WarehouseEventBus;
  store: EventTriggersStore;
  runtime: TriggerDispatchRuntime;
  auditLog?: AuditLogStore;
  /** D-121 broadcast bus — the error-cap auto-disable fans
   *  `automation_rule_changed` so the Automation governance surface
   *  sees the server-side disarm (the one rule mutation with no rpc
   *  in front of it). Optional; emits are best-effort. */
  eventBus?: EventBus;
  /** Error cap — consecutive failures within a 24h window before the
   *  trigger auto-disables. Defaults to 10. */
  autoDisableAfterErrors24h?: number;
  now?: () => number;
  /** D-124 Phase 2.2 — backfill-state lookup. The dispatcher gates
   *  every fan-out on `isComplete(event.platform, event.slug)`. Events
   *  emitted while the source adapter is still draining its initial
   *  backfill window are silently dropped at this seam — `bus.emit`
   *  itself is unchanged, so other warehouse subscribers (FTS index,
   *  heartbeat counts, the realtime broadcast bridge) keep seeing
   *  every event. Optional so legacy tests that don't care about
   *  suppression keep working — when omitted, the gate behaves as if
   *  every adapter is fully drained. */
  backfillState?: BackfillStateLookup;
  /** Vault-unlocked gate. When provided and `false`, an incoming event
   *  is dropped before `runtime.runRecipe` — reactive execution must not
   *  run while the vault is sealed (its recipe can't reach credentials,
   *  and the run would write cache rows the locked store can't encrypt).
   *  The drop is silent (no error bookkeeping, no auto-disable): the
   *  vault state is transient, not a trigger fault. Watch-driven
   *  triggers re-detect on the next poll once unlocked; this is a
   *  best-effort at-most-once surface, so a dropped external event is
   *  not re-delivered. Absent → un-gated (legacy / tests). */
  isVaultUnlocked?: () => boolean;
}

interface Subscription {
  trigger_id: string;
  unsubscribe: () => void;
}

interface ErrorWindowEntry {
  ts: number;
}

export const createEventTriggerDispatcher = (
  deps: EventTriggerDispatcherDeps,
): EventTriggerDispatcher => {
  const now = deps.now ?? (() => Date.now());
  const errorCap = deps.autoDisableAfterErrors24h ?? 10;
  const errorWindowMs = 24 * 60 * 60 * 1000;

  const subscriptions: Subscription[] = [];
  const errorsByTrigger = new Map<string, ErrorWindowEntry[]>();

  const recordError = (trigger_id: string): number => {
    const nowMs = now();
    const entries = errorsByTrigger.get(trigger_id) ?? [];
    const filtered = entries.filter((e) => nowMs - e.ts < errorWindowMs);
    filtered.push({ ts: nowMs });
    errorsByTrigger.set(trigger_id, filtered);
    return filtered.length;
  };

  const clearErrors = (trigger_id: string): void => {
    errorsByTrigger.delete(trigger_id);
  };

  const onEvent = async (trigger: EventTrigger, event: WarehouseEvent): Promise<void> => {
    // D-124 Phase 2.2 — suppress trigger fan-out for events emitted
    // while the source adapter is still in initial-backfill drain.
    // The check is fan-out only — `bus.emit` already fired, so FTS
    // index updates, heartbeat collection counts, and the realtime
    // broadcast bridge see this event. We just don't run the user
    // recipe (and don't audit / count / clear errors) until the
    // adapter has flipped `collection_instances.backfill_complete`.
    if (deps.backfillState && !deps.backfillState.isComplete(event.platform, event.slug)) {
      return;
    }
    // Vault-locked gate: drop the fan-out silently while the vault is
    // sealed (same fan-out-only posture as the backfill suppression
    // above — `bus.emit` already fired, so FTS / heartbeat / broadcast
    // subscribers are unaffected; we just don't run the user recipe).
    // No error bookkeeping — a sealed vault is a transient condition,
    // not a trigger fault.
    if (deps.isVaultUnlocked && !deps.isVaultUnlocked()) {
      return;
    }
    // D-179 P4 — direct self-loop guard: the run-outcome event of a
    // run THIS trigger dispatched never re-fires this trigger (a
    // recipe subscribed to its own outcome would otherwise loop
    // forever with no error to trip the 24h cap). Staged chains are
    // unaffected — a DIFFERENT trigger consuming the outcome fires
    // normally.
    if (
      event.platform === RUN_OUTCOME_PLATFORM &&
      (event.record as { origin_trigger_id?: unknown } | undefined)?.origin_trigger_id ===
        trigger.trigger_id
    ) {
      return;
    }
    try {
      await deps.runtime.runRecipe({
        recipe_id: trigger.recipe_id,
        publisher_id: trigger.publisher_id,
        context: {
          event: {
            topic: eventPath(event.platform, event.slug, event.entity_type, event.event_kind).split('.'),
            kind: event.event_kind,
            payload: {
              record_id: event.record_id,
              at: event.at,
              platform: event.platform,
              slug: event.slug,
              entity_type: event.entity_type,
              // D-124 Phase 1 — prev rides through to recipes for
              // updated/deleted events. Spread-conditional keeps
              // created/synced wire shape clean (no undefined keys
              // on the payload), so `{{context.event.payload.prev}}
              // is_null` evaluates correctly in skip_when branches.
              ...(event.prev !== undefined ? { prev: event.prev } : {}),
              // Poll-manager / G6 — the watch loop's emits carry the
              // fresh canonical projection + the changed canonical
              // field keys; same spread-conditional posture so
              // adapter-sourced events keep their exact wire shape.
              ...(event.record !== undefined ? { record: event.record } : {}),
              ...(event.changed_fields !== undefined
                ? { changed_fields: event.changed_fields }
                : {}),
            },
            trigger_id: trigger.trigger_id,
          },
        },
        dish_id: trigger.dish_id ?? null,
        trigger_id: trigger.trigger_id,
      });
      deps.store.update(trigger.trigger_id, {
        last_fired_at: now(),
        last_error: null,
      });
      clearErrors(trigger.trigger_id);
      await deps.auditLog?.logActivity({
        activity_id: '',
        timestamp: now(),
        action: 'trigger_fired',
        target: `${trigger.trigger_id}|${event.record_id}`,
      }).catch(() => { /* best-effort */ });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.store.update(trigger.trigger_id, {
        last_fired_at: now(),
        last_error: msg,
      });
      const errorCount = recordError(trigger.trigger_id);
      if (errorCount >= errorCap) {
        deps.store.update(trigger.trigger_id, { enabled: false });
        clearErrors(trigger.trigger_id);
        await deps.auditLog?.logActivity({
          activity_id: '',
          timestamp: now(),
          action: 'trigger_auto_disabled',
          target: trigger.trigger_id,
          detail: `errors_24h=${errorCount}`,
        }).catch(() => { /* best-effort */ });
        rebuild();
        emitAutomationRule(deps.eventBus, 'event_trigger');
      }
    }
  };

  const queue = createTriggerDispatchQueue({ processEvent: onEvent });

  const rebuild = (): void => {
    for (const sub of subscriptions) {
      try { sub.unsubscribe(); } catch { /* idempotent */ }
    }
    subscriptions.length = 0;

    for (const trigger of deps.store.listEnabled()) {
      const unsubscribe = deps.bus.subscribe(trigger.pattern, (event) => {
        // Match is already guaranteed by the bus; this extra check
        // is a defense-in-depth for the disable race (a subscription
        // from a prior rebuild firing during the tear-down window).
        if (!matchesPattern(trigger.pattern,
          eventPath(event.platform, event.slug, event.entity_type, event.event_kind))) {
          return;
        }
        // Authoring sugar — per-row dispatch filter (design § 3/§ 5):
        // read-free payload conditions evaluated BEFORE the queue, so a
        // non-matching event never costs a fire (zero skip-noise for
        // the common case). The view mirrors the payload `onEvent`
        // builds; a missing path PASSES (doorbell-shaped sources —
        // messenger / reception / adapter emits — carry no
        // record/changed_fields; over-fire beats silent-dead; the
        // recipe's own gates stay the correctness boundary). Poll- AND
        // reconciler-/webhook-sourced entity events are fat (record +
        // prev + changed_fields), so filters on CRM vendors evaluate
        // for real on both fidelity tiers.
        //
        // DELIBERATE semantics vs the d-124 coalescer (codex MEDIUM,
        // accepted): filtering per-event means a row's recipe sees the
        // MATCHING event's snapshot — a later same-record event that
        // does NOT match this row's filter never reaches the queue, so
        // it can't refresh an already-queued tail's `record`. That is
        // the subscription's own stream ("fire on stage changes" runs
        // with the stage-change snapshot, not a later amount-change
        // one); pushing non-matching events into the queue to chase
        // the latest snapshot would re-introduce the exact per-event
        // queue churn the filter exists to absorb. Recipes needing
        // guaranteed-latest state re-read it.
        if ((trigger.filter !== undefined || trigger.fields !== undefined)
          && !matchesTriggerDispatchFilter(trigger, {
            record_id: event.record_id,
            at: event.at,
            platform: event.platform,
            slug: event.slug,
            entity_type: event.entity_type,
            ...(event.prev !== undefined ? { prev: event.prev } : {}),
            ...(event.record !== undefined ? { record: event.record } : {}),
            ...(event.changed_fields !== undefined
              ? { changed_fields: event.changed_fields }
              : {}),
          })) {
          return;
        }
        // D-124 Phase 2.3 — replaces fire-and-forget `void onEvent(...)`.
        // Same `(trigger_id, record_id)` serializes; rapid edits to the
        // same record coalesce at depth 2 (in-flight + tail) preserving
        // the original prev anchor across collapses.
        queue.enqueue(trigger, event);
      });
      subscriptions.push({ trigger_id: trigger.trigger_id, unsubscribe });
    }
  };

  const dispose = (): void => {
    for (const sub of subscriptions) {
      try { sub.unsubscribe(); } catch { /* idempotent */ }
    }
    subscriptions.length = 0;
    errorsByTrigger.clear();
  };

  return {
    rebuild,
    dispose,
    activeSubscriptions: () => subscriptions.length,
    activeQueueKeys: () => queue.activeKeys(),
    drained: () => queue.drained(),
  };
};
