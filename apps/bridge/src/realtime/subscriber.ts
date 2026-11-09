/** D-169 P2 Slice 1 — bridge broadcast-bus subscriber.
 *
 *  The bridge subscribes to the per-pair D-121 broadcast bus on every
 *  (re)connect via the SAME `events.subscribe` rpc + `server_event`
 *  push envelope the webclient uses (I-6 / TR-5 — no bespoke bridge
 *  push protocol). This module is a typed dispatcher over the inbound
 *  `server_event.event`: it validates the payload is a `ServerEvent`
 *  (kind ∈ `BROADCAST_EVENT_KIND_SET`), narrows on `kind`, and fans the
 *  event to registered listeners. The SW bootstrap registers a single
 *  `onAny` listener that feeds the bus buffer (`bus-buffer.ts`).
 *
 *  ⚠️  Intentional duplication. This is a near-verbatim replica of the
 *  webclient's `apps/webclient/src/realtime/subscriber.ts`
 *  `createBroadcastSubscriber`. The bridge does NOT depend on
 *  `@recued/webclient` (it has no `exports` map + the bridge's only
 *  shared client dep is `@recued/ui-shared`), so the protocol-parity
 *  invariant (I-6) is satisfied here by a copy rather than a shared
 *  import. NEXT (follow-on): lift `createBroadcastSubscriber` +
 *  `BroadcastSubscriber` into `@recued/ui-shared` so webclient + bridge
 *  share one copy. Deferred from Slice 1 to keep the blast radius inside
 *  `apps/bridge/` (a concurrent session is editing `@recued/ui-shared`).
 */

import {
  BROADCAST_EVENT_KIND_SET,
  type BroadcastEventKind,
  type ServerEvent,
} from '@recued/contracts';

/** D-169 P2 Slice 1 — the bridge side-panel's default subscription set.
 *
 *  Scoped to exactly the kinds Slice 1 renders into the three
 *  previously-empty list sections (N.5 #2/#3/#4):
 *
 *   - `execution`               → Recent recipes (#2): `op:'complete'`
 *                                 / `'error'` land a result row.
 *   - `notification.notify`     → Notifications (#3): one row per UI
 *                                 fire-and-forget notify card.
 *   - `notification.ask`        → Approvals (#4): a pending-ask row.
 *   - `notification.ask_closed` → Approvals (#4): removes the resolved
 *                                 ask by `ask_id`.
 *
 *  Deliberately NARROW — the bridge subscribes to what it renders so the
 *  server fans only those kinds (TR-10). Section #1 (server status)
 *  stays on its P1 `system.status` tick this slice; `reactive_fire` /
 *  `schedule` / `entitlement` join this set when Slice 2 wires live
 *  status-counter updates (N.5 #1).
 *
 *  ⚠️  Every entry MUST be a real `BroadcastEventKind`. The spec § A.4
 *  pseudo-code names (`execution.complete`, `reactive.fire`,
 *  `pair.changed`) are NOT real kinds — passing any string outside
 *  `BROADCAST_EVENT_KIND_SET` makes the server reject the whole
 *  `events.subscribe` call, leaving the bridge silently event-less. A
 *  ratchet test pins this list to the contract enum. */
export const BRIDGE_DEFAULT_SUBSCRIPTIONS: ReadonlyArray<BroadcastEventKind> = [
  'execution',
  'notification.ask',
  'notification.ask_closed',
  'notification.bridge_mode_changed',
  'notification.notify',
] as const;

export type BroadcastListener<K extends BroadcastEventKind = BroadcastEventKind> = (
  event: Extract<ServerEvent, { kind: K }>,
) => void;

export interface BridgeBroadcastSubscriber {
  /** Register a listener for a specific kind. Returns an unsubscribe
   *  fn. Multiple listeners per kind are allowed; ordering matches
   *  registration order. */
  on<K extends BroadcastEventKind>(kind: K, listener: BroadcastListener<K>): () => void;
  /** Wildcard listener — fires on every inbound event regardless of
   *  kind. The bridge uses this to feed the bus buffer. */
  onAny(listener: (event: ServerEvent) => void): () => void;
  /** Dispatch a single inbound `server_event.event` payload. Validated
   *  as a `ServerEvent` (kind ∈ `BROADCAST_EVENT_KIND_SET`); malformed
   *  payloads are dropped silently — a server-shaped bug MUST NOT raise
   *  inside the SW. */
  dispatch(message: unknown): void;
  /** Listener count for diagnostics + tests. */
  size(kind?: BroadcastEventKind): number;
}

const isServerEvent = (m: unknown): m is ServerEvent => {
  if (!m || typeof m !== 'object') return false;
  const e = m as { kind?: unknown };
  return typeof e.kind === 'string' && BROADCAST_EVENT_KIND_SET.has(e.kind as BroadcastEventKind);
};

export const createBridgeBroadcastSubscriber = (): BridgeBroadcastSubscriber => {
  const byKind = new Map<BroadcastEventKind, Set<BroadcastListener>>();
  const wildcard = new Set<(event: ServerEvent) => void>();

  return {
    on<K extends BroadcastEventKind>(kind: K, listener: BroadcastListener<K>) {
      let set = byKind.get(kind);
      if (!set) {
        set = new Set();
        byKind.set(kind, set);
      }
      set.add(listener as unknown as BroadcastListener);
      return () => {
        set?.delete(listener as unknown as BroadcastListener);
        if (set && set.size === 0) byKind.delete(kind);
      };
    },
    onAny(listener) {
      wildcard.add(listener);
      return () => wildcard.delete(listener);
    },
    dispatch(message) {
      if (!isServerEvent(message)) return;
      const set = byKind.get(message.kind);
      if (set) {
        for (const listener of [...set]) {
          try {
            (listener as unknown as (e: ServerEvent) => void)(message);
          } catch {
            // Listener errors are isolated — one broken consumer
            // doesn't take down the dispatch loop.
          }
        }
      }
      for (const w of [...wildcard]) {
        try {
          w(message);
        } catch {
          // Same isolation discipline.
        }
      }
    },
    size(kind) {
      if (kind === undefined) {
        let total = wildcard.size;
        for (const s of byKind.values()) total += s.size;
        return total;
      }
      return byKind.get(kind)?.size ?? 0;
    },
  };
};
