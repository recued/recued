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
import type { NotificationMessage } from '@recued/notification';
import { presentAutomationFailure } from '../automation-failure.js';
import {
  decideAutomationFailure,
  type AutomationUnitRef,
} from '../automation-failure-reporter.js';
import { triggerEventContext } from './event-context.js';
import type { PreapprovalDriver } from '../preapproval-driver.js';

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
    /** Private queue metadata, never part of recipe context or public RPC. */
    candidate?: object;
  }) => Promise<void | { skipped: true } | { total_refusal: true }>;
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
  /** D-268 — deliver one owner notice about a failed fire: the first failure of
   *  an episode, and the disarm. Absent ⇒ failures are recorded on the trigger
   *  row and reach nobody, which is the pre-D-268 behaviour. */
  onAutomationFailure?: (notice: NotificationMessage, unit: AutomationUnitRef) => void;
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
  /** Late-bound because the realm review service composes after this bus. */
  getPreapprovalDriver?: () => PreapprovalDriver | undefined;
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

  const unitOf = (trigger: EventTrigger): AutomationUnitRef => ({
    kind: 'trigger',
    id: trigger.trigger_id,
    recipe_id: trigger.recipe_id,
  });

  /** D-268 — classify one failed fire, move the 24h counter, and hand the owner
   *  the one notice this episode owes.
   *
   *  ⛔ THE COUNTER IS STILL `recordError`, DELIBERATELY. The trigger path's
   *  24h window already behaves as "failures since the last success" —
   *  `clearErrors` runs on every clean fire — so introducing a second counter
   *  would be a second place the same fact lives, and they would disagree the
   *  first time one of them was reset and the other was not. */
  const handleFailure = (
    trigger: EventTrigger,
    code: string | undefined,
    total_refusal: boolean,
    reason: string,
  ): 'not_a_failure' | 'continue' | 'stop' => {
    const unit = unitOf(trigger);
    // `recordError` both appends and returns the new length, so the count
    // BEFORE this failure is one less — which is the episode boundary the
    // reporter needs (`0 → 1` opens an episode and sends its one notice).
    const count = recordError(trigger.trigger_id);
    const report = decideAutomationFailure({
      unit,
      code,
      total_refusal,
      reason,
      prior_consecutive_failures: count - 1,
      threshold: errorCap,
    });
    if (report.not_a_failure) {
      // Undo the append: a tripped guard is not evidence the trigger is broken,
      // and leaving it counted would disarm a working trigger after `errorCap`
      // successful guard evaluations.
      const entries = errorsByTrigger.get(trigger.trigger_id);
      if (entries) entries.pop();
      return 'not_a_failure';
    }
    if (report.notice) {
      try {
        deps.onAutomationFailure?.(report.notice, unit);
      } catch {
        // Telling the owner is best-effort; a broken consumer must not turn a
        // recorded failure into a failed dispatch.
      }
    }
    return report.disarm ? 'stop' : 'continue';
  };

  const disableTrigger = async (trigger: EventTrigger, why: string): Promise<void> => {
    deps.store.update(trigger.trigger_id, { enabled: false });
    clearErrors(trigger.trigger_id);
    await deps.auditLog?.logActivity({
      activity_id: '',
      timestamp: now(),
      action: 'trigger_auto_disabled',
      target: trigger.trigger_id,
      detail: why,
    }).catch(() => { /* best-effort */ });
    rebuild();
    emitAutomationRule(deps.eventBus, 'event_trigger');
  };

  const onEvent = async (trigger: EventTrigger, event: WarehouseEvent, candidate?: object): Promise<void> => {
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
      const outcome = await deps.runtime.runRecipe({
        recipe_id: trigger.recipe_id,
        publisher_id: trigger.publisher_id,
        context: triggerEventContext(trigger.trigger_id, event),
        dish_id: trigger.dish_id ?? null,
        trigger_id: trigger.trigger_id,
        ...(candidate ? { candidate } : {}),
      });
      if (outcome !== undefined && 'skipped' in outcome) return;
      // D-268 — a run that reported success and refused every item it attempted.
      // It is a failure for the counter's sake and NOT for the row's: the run
      // completed, so `last_error` stays null and the status is untouched. What
      // is false is the inference that it produced anything.
      if (outcome !== undefined && 'total_refusal' in outcome) {
        deps.store.update(trigger.trigger_id, { last_fired_at: now() });
        const verdict = handleFailure(trigger, undefined, true,
          'This run attempted items and every one was refused.');
        if (verdict === 'stop') await disableTrigger(trigger, 'total_refusal');
        return;
      }
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
      const failure = presentAutomationFailure(err);
      if (failure.redacted) {
        console.error(
          `[event-triggers] trigger ${trigger.trigger_id} internal failure: ${failure.internalMessage}`,
        );
      }
      const raw = (err as { code?: unknown } | null)?.code;
      const code = typeof raw === 'string' ? raw : undefined;
      const verdict = handleFailure(trigger, code, false, failure.userMessage);
      // ⛔ A `conditional` code is the recipe DECIDING not to act and being right
      // to — a tripped guard, a matched fail-on, an absent prerequisite. It
      // leaves no `last_error` and touches no counter: counting those toward the
      // cap disarms triggers that are working, and it would look exactly like
      // the feature working.
      if (verdict === 'not_a_failure') {
        deps.store.update(trigger.trigger_id, { last_fired_at: now() });
        return;
      }
      deps.store.update(trigger.trigger_id, {
        last_fired_at: now(),
        last_error: failure.userMessage,
      });
      if (verdict === 'stop') {
        await disableTrigger(trigger, code !== undefined ? `code=${code}` : 'errors_24h');
      }
    }
  };

  const queue = createTriggerDispatchQueue({
    processEvent: onEvent,
    onOverflow: ({ dropped_events, retained_keys, max_keys }) => {
      // First drop is immediately actionable; thereafter rate-limit the warning
      // so an event storm cannot turn the safety fence into a log flood.
      if (dropped_events !== 1 && dropped_events % 100 !== 0) return;
      console.warn(
        `[event-triggers] dispatch pressure: refused ${dropped_events} event(s); `
          + `${retained_keys}/${max_keys} distinct record keys retained`,
      );
    },
  });

  const rebuild = (): void => {
    for (const sub of subscriptions) {
      try { sub.unsubscribe(); } catch { /* idempotent */ }
    }
    subscriptions.length = 0;

    // With the owned driver, include paused rows in subscriptions: accepting
    // their next execution can arm them without an asynchronous rebuild gap.
    // Every callback still checks the live row and captures only eligible work.
    for (const subscribed of deps.getPreapprovalDriver ? deps.store.list() : deps.store.listEnabled()) {
      const unsubscribe = deps.bus.subscribe(subscribed.pattern, (event) => {
        const driver = deps.getPreapprovalDriver?.();
        const trigger = deps.getPreapprovalDriver ? deps.store.get(subscribed.trigger_id) : subscribed;
        if (!trigger) return;
        if (deps.getPreapprovalDriver && !driver && !trigger.enabled) return;
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
        // Capture only after the same suppression/self-loop rules that govern
        // execution. An initial backfill is not a qualifying future event.
        if (driver) {
          if ((deps.backfillState && !deps.backfillState.isComplete(event.platform, event.slug))
            || (deps.isVaultUnlocked && !deps.isVaultUnlocked())
            || (event.platform === RUN_OUTCOME_PLATFORM && event.record?.origin_trigger_id === trigger.trigger_id)) return;
          const candidate = driver.captureTrigger(trigger, event);
          if (!candidate) return;
          queue.enqueue(trigger, event, candidate);
        } else queue.enqueue(trigger, event);
      });
      subscriptions.push({ trigger_id: subscribed.trigger_id, unsubscribe });
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
