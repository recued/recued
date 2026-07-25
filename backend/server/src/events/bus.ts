/** D-121 Phase 6 — server-side realtime event bus.
 *
 *  Single in-process broker that:
 *    1. Stamps every emit with a monotonic cursor.
 *    2. Stores recent events in a bounded ring (default 10K — see
 *       `DEFAULT_EVENT_RING_SIZE`) for cursor-since replay.
 *    3. Tracks per-client subscription filters + push callbacks.
 *
 *  Composed once at server boot and shared by every emit site
 *  (warehouse adapters, audit emitter, approval store, schedule
 *  store, …). Clients subscribe via `events.subscribe` rpc; the
 *  ws-server wires the push callback to its `send` helper, sending
 *  events over the existing `{ type: 'server_event', event }` push
 *  envelope.
 *
 *  Failure model: bus failures (push throws, subscriber callback
 *  throws) are swallowed — the underlying domain operation must
 *  not abort because a UI couldn't be notified. Missed events are
 *  recovered on reconnect via cursor-since replay; a stale cursor
 *  past the ring window flips `fell_off_ring=true` so the client
 *  knows to do a full re-sync. */

import {
  DEFAULT_EVENT_RING_SIZE,
  type BroadcastEventKind,
  type ServerEvent,
  type SubscribeAck,
  type SubscribeRequest,
} from '@recued/contracts';

/** Distributive `Omit` so each variant of the discriminated union
 *  loses `cursor` independently — `Omit<ServerEvent, 'cursor'>` would
 *  collapse to `{ kind: BroadcastEventKind }` because non-distributive
 *  Omit returns the intersection of properties common to every
 *  variant. */
export type ServerEventInput =
  ServerEvent extends infer T
    ? T extends ServerEvent
      ? Omit<T, 'cursor'>
      : never
    : never;

/** Stable identifier for a subscriber. The ws-server keys on the
 *  client's WebSocket reference (an `unknown` from outside this
 *  module — it doesn't care about WS internals). */
export type EventSubscriberId = string | number | object;

/** Push callback supplied at subscribe time. The bus invokes this
 *  for every emitted event whose kind matches the subscription
 *  filter, in cursor order. Throws are swallowed (bus must not
 *  fail an emit because one push handler is wedged). */
export type EventPushFn = (event: ServerEvent) => void;

interface SubscriptionEntry {
  kinds: ReadonlySet<BroadcastEventKind>;
  push: EventPushFn;
}

export interface EventBusOptions {
  /** Ring-buffer capacity for replay. Defaults to
   *  `DEFAULT_EVENT_RING_SIZE`. Hosted setups with longer reconnect
   *  windows can raise this. */
  ringSize?: number;
}

export interface EventBus {
  /** Current monotonic cursor. Last assigned value; first emit
   *  becomes `cursor + 1`. Exposed for tests + telemetry. */
  cursor(): number;
  /** Subscribe `id` to the kinds in `req.kinds`. Returns an
   *  ack with the bus's current cursor + the count of replayed
   *  events about to be pushed (server pushes them synchronously
   *  before this method returns). Re-calling with the same `id`
   *  replaces the previous filter. */
  subscribe(id: EventSubscriberId, req: SubscribeRequest, push: EventPushFn): SubscribeAck;
  /** Drop the subscription for `id` (no-op if absent). Called by
   *  the ws-server on disconnect. */
  unsubscribe(id: EventSubscriberId): void;
  /** Stamp + buffer + fan out a new event. Cursor is assigned
   *  here; callers pass everything else. */
  emit(event: ServerEventInput): ServerEvent;
  /** Snapshot of buffered events with `cursor > since`. Exposed
   *  for tests; subscribe() uses this internally for replay. */
  replay(since: number): ServerEvent[];
  /** Number of active subscribers — used by tests + telemetry. */
  subscriberCount(): number;
}

/** Construct a new bus. Ring buffer is a fixed-capacity circular
 *  array — push is O(1), `replay(since)` is O(min(ringSize,
 *  cursor - since)). */
export const createEventBus = (opts: EventBusOptions = {}): EventBus => {
  const ringSize = Math.max(1, Math.floor(opts.ringSize ?? DEFAULT_EVENT_RING_SIZE));
  const ring: ServerEvent[] = new Array(ringSize);
  let ringHead = 0;
  let ringFill = 0;
  let cursor = 0;
  const subscribers = new Map<EventSubscriberId, SubscriptionEntry>();

  /** Return a ring-safe copy of an event for REPLAY retention. Credential-
   *  bearing kinds (`token.rotated`) keep their non-secret metadata + cursor
   *  but have the bearer BLANKED, so a low-`cursor_since` replay can never
   *  harvest reusable auth material. The LIVE fan-out (in `emit`) carries the
   *  UNSCRUBBED event so the target consumes the new bearer inline; a target
   *  that missed the live push replays the scrubbed metadata (new_token_id,
   *  no bearer) and re-auths — the correct outcome, since its old bearer was
   *  already invalidated by the rotation. Scrubbing (vs excluding the event)
   *  keeps every event IN the ring, so cursors stay DENSE and the replay-
   *  window / fell-off math (`cursor - ringFill + 1`) stays correct. */
  const scrubForRing = (event: ServerEvent): ServerEvent =>
    event.kind === 'token.rotated' ? { ...event, bearer: '' } : event;

  /** Smallest cursor still present in the ring, or `0` when empty. */
  const oldestRetainedCursor = (): number => {
    if (ringFill === 0) return 0;
    // Cursors are dense (1, 2, 3, …) — every event is ringed (credential kinds
    // enter scrubbed, never excluded); the oldest = newest - fill + 1.
    return cursor - ringFill + 1;
  };

  /** Append to ring, evicting the oldest entry when full. */
  const ringPush = (ev: ServerEvent): void => {
    ring[ringHead] = ev;
    ringHead = (ringHead + 1) % ringSize;
    if (ringFill < ringSize) ringFill++;
  };

  /** Iterate ring contents in cursor order (oldest → newest).
   *  Single-pass — caller breaks early when filter matches. */
  const forEachInOrder = (visit: (ev: ServerEvent) => void): void => {
    if (ringFill === 0) return;
    const tail = (ringHead - ringFill + ringSize) % ringSize;
    for (let i = 0; i < ringFill; i++) {
      const slot = (tail + i) % ringSize;
      visit(ring[slot]);
    }
  };

  return {
    cursor() {
      return cursor;
    },

    subscribe(id, req, push) {
      // Reject empty kinds — explicit "no filter" is a client bug;
      // the recommended path is to pass the full DEFAULT_SUBSCRIPTIONS list.
      if (!Array.isArray(req.kinds) || req.kinds.length === 0) {
        throw new Error('events.subscribe: kinds must be a non-empty array');
      }
      const kindSet = new Set(req.kinds);
      subscribers.set(id, { kinds: kindSet, push });

      const since = req.cursor_since ?? cursor;
      // No replay requested (no since, or caller is already current).
      if (since >= cursor) {
        return { cursor, replay_count: 0, fell_off_ring: false };
      }
      // Caller is behind; check whether ring still covers the gap.
      const oldest = oldestRetainedCursor();
      const fellOff = since > 0 && oldest > 0 && since < oldest - 1;
      if (fellOff) {
        return { cursor, replay_count: 0, fell_off_ring: true };
      }

      // Replay matching events in cursor order. Push synchronously so
      // the caller can rely on ordering (replay before live events).
      let replayCount = 0;
      forEachInOrder((ev) => {
        if (ev.cursor <= since) return;
        if (!kindSet.has(ev.kind)) return;
        try { push(ev); }
        catch { /* swallow — push errors must not abort emit */ }
        replayCount++;
      });
      return { cursor, replay_count: replayCount, fell_off_ring: false };
    },

    unsubscribe(id) {
      subscribers.delete(id);
    },

    emit(event: ServerEventInput) {
      cursor++;
      // Cast the spread back to ServerEvent — TS can't narrow that the
      // input variant + cursor field reconstruct a valid union member,
      // but every `ServerEventInput` is by definition a discriminated
      // variant minus cursor.
      const stamped = { ...event, cursor } as ServerEvent;
      // Retain a ring-safe (secret-scrubbed) copy for replay; the live fan-out
      // below carries the FULL event so the target consumes the bearer inline.
      ringPush(scrubForRing(stamped));
      for (const sub of subscribers.values()) {
        if (!sub.kinds.has(stamped.kind)) continue;
        try { sub.push(stamped); }
        catch { /* see subscribe — never abort the emit chain */ }
      }
      return stamped;
    },

    replay(since) {
      const out: ServerEvent[] = [];
      forEachInOrder((ev) => {
        if (ev.cursor > since) out.push(ev);
      });
      return out;
    },

    subscriberCount() {
      return subscribers.size;
    },
  };
};
