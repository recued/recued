/** D-124 Phase 2.3 — per-(trigger, record_id) coalescing dispatch queue.
 *
 *  Replaces the fire-and-forget `void onEvent(trigger, event)` callsite
 *  in `dispatcher.ts` with a serial drain per `${trigger_id}:${record_id}`
 *  key. Within a key, at most TRIGGER_QUEUE_MAX_DEPTH_PER_KEY entries
 *  exist — one in-flight + one coalesced tail. Repeated edits to the
 *  same record collapse into the tail, but the original `prev` anchor
 *  is preserved across collapses so a "what changed" recipe sees the
 *  diff against state-before-any-edits, not state-just-before-the-
 *  latest-edit (a reschedule-tracker would otherwise report 0-minute
 *  diffs whenever rapid edits net to no movement, instead of the actual
 *  cumulative shift — Load-bearing #6 in the spec).
 *
 *  Concurrency:
 *    - Different keys run in parallel — different recipes, or the same
 *      recipe on different records.
 *    - Same key serializes — at most one `processEvent` in-flight at a
 *      time, with one optionally-coalesced tail.
 *
 *  Errors raised by `processEvent` are swallowed at the queue layer.
 *  The dispatcher's existing try/catch already handles recipe failures
 *  (sets `last_error`, increments the 24h error counter); the queue's
 *  swallow is defense-in-depth against errors that escape that path. */

import type { EventTrigger } from '@recued/contracts';
import type { WarehouseEvent } from '@recued/warehouse-events';

/** Maximum entries per `(trigger_id, record_id)` queue.
 *  In-flight + one coalesced tail. Higher depths offer no semantic
 *  gain — tail-replacement always carries the latest current value
 *  and the prev anchor is preserved across collapses. */
export const TRIGGER_QUEUE_MAX_DEPTH_PER_KEY = 2;

export interface TriggerDispatchQueue {
  /** Enqueue an event for processing. Starts a fresh drain if the key
   *  is idle. Same-key events serialize; diff-key events run in
   *  parallel. */
  enqueue(trigger: EventTrigger, event: WarehouseEvent): void;
  /** Number of currently active queue keys (tests + observability). */
  activeKeys(): number;
  /** Settled depth of a specific key. Returns 0 for an absent key. */
  size(key: string): number;
  /** Resolves once every active drain settles. Tests use this as a
   *  deterministic barrier. */
  drained(): Promise<void>;
}

export interface TriggerDispatchQueueDeps {
  /** The actual event handler — typically `dispatcher.onEvent`. */
  processEvent: (trigger: EventTrigger, event: WarehouseEvent) => Promise<void>;
}

interface QueueEntry {
  trigger: EventTrigger;
  event: WarehouseEvent;
}

/** Build the canonical queue key from the trigger row + event. Exported
 *  so tests can assert against `queue.size(queueKey(...))` without
 *  reimplementing the convention. */
export const queueKey = (trigger_id: string, record_id: string): string =>
  `${trigger_id}:${record_id}`;

export const createTriggerDispatchQueue = (
  deps: TriggerDispatchQueueDeps,
): TriggerDispatchQueue => {
  const queues = new Map<string, QueueEntry[]>();
  const drains = new Map<string, Promise<void>>();

  const drain = async (key: string): Promise<void> => {
    while (true) {
      const queue = queues.get(key);
      if (!queue || queue.length === 0) {
        queues.delete(key);
        drains.delete(key);
        return;
      }
      const next = queue[0];
      try {
        await deps.processEvent(next.trigger, next.event);
      } catch {
        // Defense-in-depth — the dispatcher's `onEvent` already catches
        // recipe errors internally.
      }
      queue.shift();
    }
  };

  const enqueue = (trigger: EventTrigger, event: WarehouseEvent): void => {
    const key = queueKey(trigger.trigger_id, event.record_id);
    const existing = queues.get(key);

    if (!existing) {
      queues.set(key, [{ trigger, event }]);
      drains.set(key, drain(key));
      return;
    }

    if (existing.length < TRIGGER_QUEUE_MAX_DEPTH_PER_KEY) {
      existing.push({ trigger, event });
      return;
    }

    const tailIndex = existing.length - 1;
    const tail = existing[tailIndex];
    const coalescedPrev = tail.event.prev !== undefined ? tail.event.prev : event.prev;
    // Poll-manager / G6 — keep `changed_fields` consistent with the
    // preserved prev anchor: a collapse of `B→C` + `C→D` keeps
    // `prev = B` and `record = D`, so the field list must be the UNION
    // of both hops (a recipe gating on `changed_fields contains amount`
    // must fire when amount changed in EITHER hop). The union can
    // over-report a field that changed and changed back — acceptable
    // for a gate; the recipe reads exact values off prev/record. When
    // either collapsed event lacks the list (non-poll source), drop it
    // rather than ship a half-true one.
    const coalescedChangedFields =
      tail.event.changed_fields !== undefined && event.changed_fields !== undefined
        ? [...new Set([...tail.event.changed_fields, ...event.changed_fields])].sort()
        : undefined;
    const { changed_fields: _droppedChangedFields, ...latestEvent } = event;
    existing[tailIndex] = {
      trigger,
      event: {
        ...latestEvent,
        ...(coalescedPrev !== undefined ? { prev: coalescedPrev } : {}),
        ...(coalescedChangedFields !== undefined
          ? { changed_fields: coalescedChangedFields }
          : {}),
      },
    };
  };

  return {
    enqueue,
    activeKeys: () => queues.size,
    size: (key) => queues.get(key)?.length ?? 0,
    drained: async () => {
      while (drains.size > 0) {
        await Promise.all(Array.from(drains.values()));
      }
    },
  };
};
