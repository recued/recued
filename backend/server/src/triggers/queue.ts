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
 *    - Different keys run in parallel up to
 *      TRIGGER_QUEUE_MAX_CONCURRENT_KEYS. Further distinct keys wait in
 *      insertion order. Without this global fence a provider burst over many
 *      record ids started one complete recipe run per record at once.
 *    - Same key serializes — at most one `processEvent` in-flight at a
 *      time, with one optionally-coalesced tail.
 *    - At most TRIGGER_QUEUE_MAX_KEYS distinct keys are retained. Existing
 *      keys still coalesce at the ceiling; a new key is refused once full so
 *      an external event storm cannot grow the server heap without bound.
 *    - D-315 — except a mail fact's event: it is one email's news about a
 *      thing, announced once, which nothing delivers again. It is never
 *      refused at the ceiling and never coalesced. Its producers that can
 *      wait (a backfill that runs recipes, an AI answer) wait for `room`
 *      first, which bounds how far the queue grows past the marks.
 *
 *  Errors raised by `processEvent` are swallowed at the queue layer.
 *  The dispatcher's existing try/catch already handles recipe failures
 *  (sets `last_error`, increments the 24h error counter); the queue's
 *  swallow is defense-in-depth against errors that escape that path. */

import { MAIL_FACT_EVENT_PLATFORM, type EventTrigger } from '@recued/contracts';
import type { WarehouseEvent } from '@recued/warehouse-events';

/** Maximum entries per `(trigger_id, record_id)` queue.
 *  In-flight + one coalesced tail. Higher depths offer no semantic
 *  gain — tail-replacement always carries the latest current value
 *  and the prev anchor is preserved across collapses. */
export const TRIGGER_QUEUE_MAX_DEPTH_PER_KEY = 2;

/** Maximum distinct keys whose events may execute at once. Recipe operations
 *  have their own lane governors, but a run allocates state before reaching a
 *  governed operation; bounding at this earlier seam prevents a broad trigger
 *  burst from creating an unbounded population of live runs. */
export const TRIGGER_QUEUE_MAX_CONCURRENT_KEYS = 16;

/** Hard bound over active + waiting distinct keys. A normal live-change burst
 *  should remain far below this; initial collection backfills are suppressed
 *  before this queue. */
export const TRIGGER_QUEUE_MAX_KEYS = 1_024;

/** A producer that can wait (a backfill that runs recipes) waits until fewer
 *  keys than this are retained: live events keep the other half. */
export const TRIGGER_QUEUE_PRODUCER_KEYS = TRIGGER_QUEUE_MAX_KEYS / 2;

/** ...and while any key holds this many events: seventy emails about one
 *  thing, whose recipe is slow, keep pace with it rather than pile up behind
 *  it. A mail fact's events are never coalesced, so a key can be this deep. */
export const TRIGGER_QUEUE_PRODUCER_DEPTH = 32;

export interface TriggerDispatchQueue {
  /** Enqueue an event for processing. Starts a fresh drain if the key
   *  is idle. Same-key events serialize; diff-key events run in
   *  parallel. */
  enqueue(trigger: EventTrigger, event: WarehouseEvent, candidate?: object): boolean;
  /** Number of retained queue keys (running + waiting; tests + observability). */
  activeKeys(): number;
  /** Number of events refused because a new key arrived at the hard ceiling. */
  droppedEvents(): number;
  /** Settled depth of a specific key. Returns 0 for an absent key. */
  size(key: string): number;
  /** Resolves once every active drain settles. Tests use this as a
   *  deterministic barrier. */
  drained(): Promise<void>;
  /** Resolves once fewer than `keys` keys are retained and no key holds
   *  `depth` events or more: a producer that can wait (a backfill that runs
   *  recipes) waits for room rather than build a backlog. */
  room(keys: number, depth?: number): Promise<void>;
}

export interface TriggerDispatchQueueDeps {
  /** The actual event handler — typically `dispatcher.onEvent`. */
  processEvent: (trigger: EventTrigger, event: WarehouseEvent, candidate?: object) => Promise<void>;
  /** Test/embedding overrides. Values are sanitized to positive integers. */
  maxConcurrentKeys?: number;
  maxKeys?: number;
  /** Best-effort observability hook for a refused new key. Throws are contained. */
  onOverflow?: (state: {
    dropped_events: number;
    retained_keys: number;
    max_keys: number;
  }) => void;
}

interface QueueEntry {
  trigger: EventTrigger;
  event: WarehouseEvent;
  candidate?: object;
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
  const waitingKeys = new Set<string>();
  const positiveInteger = (value: number | undefined, fallback: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value));
  };
  const maxKeys = positiveInteger(deps.maxKeys, TRIGGER_QUEUE_MAX_KEYS);
  const maxConcurrentKeys = Math.min(
    maxKeys,
    positiveInteger(deps.maxConcurrentKeys, TRIGGER_QUEUE_MAX_CONCURRENT_KEYS),
  );
  let droppedEvents = 0;

  const drain = async (key: string): Promise<void> => {
    while (true) {
      const queue = queues.get(key);
      if (!queue || queue.length === 0) {
        queues.delete(key);
        return;
      }
      const next = queue[0];
      try {
        await deps.processEvent(next.trigger, next.event, next.candidate);
      } catch {
        // Defense-in-depth — the dispatcher's `onEvent` already catches
        // recipe errors internally.
      }
      queue.shift();
      // A key one shallower may be what a producer waits for.
      wakeRoomWaiters();
    }
  };

  const startWaiting = (): void => {
    while (drains.size < maxConcurrentKeys && waitingKeys.size > 0) {
      const next = waitingKeys.values().next().value as string | undefined;
      if (next === undefined) return;
      waitingKeys.delete(next);
      if (!queues.has(next)) continue;
      startDrain(next);
    }
  };

  const roomWaiters: { keys: number; depth: number; resolve: () => void }[] = [];
  const hasRoom = (keys: number, depth: number): boolean => {
    if (queues.size >= keys) return false;
    if (depth === Number.POSITIVE_INFINITY) return true;
    for (const queue of queues.values()) if (queue.length >= depth) return false;
    return true;
  };
  const wakeRoomWaiters = (): void => {
    for (let i = roomWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = roomWaiters[i]!;
      if (hasRoom(waiter.keys, waiter.depth)) roomWaiters.splice(i, 1)[0]!.resolve();
    }
  };

  const startDrain = (key: string): void => {
    const task = drain(key).finally(() => {
      drains.delete(key);
      startWaiting();
      wakeRoomWaiters();
    });
    drains.set(key, task);
  };

  const enqueue = (trigger: EventTrigger, event: WarehouseEvent, candidate?: object): boolean => {
    const key = queueKey(trigger.trigger_id, event.record_id);
    const existing = queues.get(key);

    const mailFact = event.platform === MAIL_FACT_EVENT_PLATFORM;
    if (!existing) {
      if (queues.size >= maxKeys && !mailFact) {
        droppedEvents += 1;
        try {
          deps.onOverflow?.({
            dropped_events: droppedEvents,
            retained_keys: queues.size,
            max_keys: maxKeys,
          });
        } catch {
          // Observability must never break warehouse event delivery.
        }
        return false;
      }
      queues.set(key, [{ trigger, event, ...(candidate ? { candidate } : {}) }]);
      if (drains.size < maxConcurrentKeys) startDrain(key);
      else waitingKeys.add(key);
      return true;
    }

    if (mailFact || existing.length < TRIGGER_QUEUE_MAX_DEPTH_PER_KEY) {
      existing.push({ trigger, event, ...(candidate ? { candidate } : {}) });
      return true;
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
      ...(candidate ? { candidate } : {}),
      event: {
        ...latestEvent,
        ...(coalescedPrev !== undefined ? { prev: coalescedPrev } : {}),
        ...(coalescedChangedFields !== undefined
          ? { changed_fields: coalescedChangedFields }
          : {}),
      },
    };
    return true;
  };

  return {
    enqueue,
    activeKeys: () => queues.size,
    droppedEvents: () => droppedEvents,
    size: (key) => queues.get(key)?.length ?? 0,
    drained: async () => {
      while (queues.size > 0 || drains.size > 0) {
        startWaiting();
        if (drains.size === 0) return;
        await Promise.all(Array.from(drains.values()));
      }
    },
    room: (keys, depth = Number.POSITIVE_INFINITY) => (hasRoom(keys, depth)
      ? Promise.resolve()
      : new Promise<void>((resolve) => { roomWaiters.push({ keys, depth, resolve }); })),
  };
};
