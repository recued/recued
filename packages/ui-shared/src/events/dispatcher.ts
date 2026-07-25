/** D-121 Phase 6 — client-side realtime broadcast dispatcher.
 *
 *  The server emits `ServerEvent`s through the existing pair-WS push
 *  channel using the envelope `{ type: 'server_event', event }`.
 *  This dispatcher:
 *
 *    1. Listens to the surface-specific RpcAdapter (extension's
 *       `chrome.runtime.onMessage` broadcast bus, or the webapp's
 *       direct WS receiver — both expose the same wire shape).
 *    2. Filters incoming messages on the `server_event` envelope,
 *       extracts the `ServerEvent`, persists the latest cursor in
 *       the StorageAdapter so reconnects can resume from the right
 *       point, then fans out to per-kind listeners.
 *
 *  Listeners receive the `ServerEvent` directly. Subscriptions are
 *  per-kind to keep the consumer surface narrow — a Memory tab
 *  subscribes to `'memory'` only; the Attention popover subscribes
 *  to `'approval'`. The dispatcher is single-instance per surface
 *  (composed once at app shell init).
 *
 *  Cursor persistence key: `events.cursor` (`prefs.<client_id>` is
 *  pair-only state per D-102 and not reachable from the client; this
 *  cursor lives in the StorageAdapter the surface already wires for
 *  other UI state). */

import type {
  BroadcastEventKind,
  ServerEvent,
} from '@recued/contracts';
import type { RpcAdapter, StorageAdapter } from '../runtime/adapters.js';

/** Listener for a specific kind. The dispatcher narrows the event
 *  shape so consumers don't reach for `if (ev.kind === 'memory')`. */
export type EventListener<K extends BroadcastEventKind> = (
  event: Extract<ServerEvent, { kind: K }>,
) => void;

export interface EventDispatcher {
  /** Subscribe to a specific event kind. Returns an unsubscribe
   *  function — callers should hold this for the listener's
   *  lifetime and invoke on dispose. */
  on<K extends BroadcastEventKind>(kind: K, listener: EventListener<K>): () => void;
  /** Latest cursor seen across all incoming events. Surfaces use
   *  this to populate `SubscribeRequest.cursor_since` on reconnect. */
  cursor(): number;
  /** Detach the underlying RpcAdapter listener. Idempotent. */
  dispose(): void;
}

export interface CreateEventDispatcherOptions {
  rpc: RpcAdapter;
  /** Optional storage for cursor persistence. When omitted the
   *  cursor only lives in memory — fine for tests + first-load
   *  surfaces that don't expect to reconnect. */
  storage?: StorageAdapter;
  /** Storage key for cursor persistence. Defaults to
   *  `events.cursor`. Override when a surface has multiple paired
   *  servers and wants per-server cursors. */
  cursorKey?: string;
}

/** Wire envelope checker — narrow `unknown` from the RpcAdapter
 *  down to a `ServerEvent`. Tolerant of unrelated broadcasts on
 *  the same channel (extension SW emits many message types; we
 *  must ignore everything that isn't ours). */
const extractServerEvent = (msg: unknown): ServerEvent | null => {
  if (!msg || typeof msg !== 'object') return null;
  const env = msg as { type?: unknown; event?: unknown };
  if (env.type !== 'server_event') return null;
  const ev = env.event as Partial<ServerEvent> | undefined;
  if (!ev || typeof ev !== 'object') return null;
  if (typeof ev.kind !== 'string') return null;
  if (typeof ev.cursor !== 'number') return null;
  return ev as ServerEvent;
};

const DEFAULT_CURSOR_KEY = 'events.cursor';

export const createEventDispatcher = (
  opts: CreateEventDispatcherOptions,
): EventDispatcher => {
  const cursorKey = opts.cursorKey ?? DEFAULT_CURSOR_KEY;
  /** Per-kind listener buckets. Map insertion order is iteration
   *  order so listeners fire in registration order. */
  const listeners = new Map<BroadcastEventKind, Set<EventListener<BroadcastEventKind>>>();
  let cursor = 0;
  let unsubAdapter: (() => void) | null = null;
  let disposed = false;

  // Hydrate cursor from storage on construction. We don't await — UI
  // can begin subscribing immediately; if a few events land before
  // hydration completes, the cursor lookup just settles to whichever
  // is greater on the next emit.
  if (opts.storage) {
    void opts.storage.get<number>(cursorKey).then((saved) => {
      if (typeof saved === 'number' && saved > cursor) cursor = saved;
    });
  }

  const persistCursor = (): void => {
    if (!opts.storage) return;
    void opts.storage.set(cursorKey, cursor);
  };

  const onMessage = (raw: unknown): void => {
    const ev = extractServerEvent(raw);
    if (!ev) return;
    if (ev.cursor > cursor) {
      cursor = ev.cursor;
      persistCursor();
    }
    const bucket = listeners.get(ev.kind);
    if (!bucket) return;
    for (const fn of bucket) {
      try { fn(ev); }
      catch { /* listener errors are isolated — never break the dispatch loop */ }
    }
  };

  unsubAdapter = opts.rpc.subscribe(onMessage);

  return {
    on<K extends BroadcastEventKind>(kind: K, listener: EventListener<K>) {
      if (disposed) return () => {};
      const bucket =
        listeners.get(kind) ??
        listeners.set(kind, new Set()).get(kind)!;
      // Cast through `EventListener<BroadcastEventKind>` — bucket is
      // type-erased; the narrow shape is enforced at the public
      // overload boundary.
      bucket.add(listener as unknown as EventListener<BroadcastEventKind>);
      return () => {
        bucket.delete(listener as unknown as EventListener<BroadcastEventKind>);
      };
    },

    cursor() {
      return cursor;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (unsubAdapter) {
        unsubAdapter();
        unsubAdapter = null;
      }
      listeners.clear();
    },
  };
};
