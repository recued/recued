/** Warehouse event bus.
 *
 *  In-process publisher/subscriber for `data.{collection}.{verb}` events,
 *  the signal warehouse writers (IMAP ingestor, filesystem watcher,
 *  webhook listener, CRM poller) emit when new data arrives. The cache
 *  invalidator subscribes to this bus and wipes stale cache entries
 *  synchronously with the warehouse write.
 *
 *  Design notes:
 *   - Not a global singleton — callers own the bus instance. Tests get
 *     isolation; production wires one bus per server process.
 *   - Listeners may return a promise; emit returns synchronously and
 *     does not await listeners (fire-and-forget). Invalidation latency
 *     is best-effort — warehouse writes shouldn't block on cache work.
 *   - Errors in one listener do not break others; caught + silenced.
 *     This is how invalidation degrades gracefully when a subscriber
 *     misbehaves.
 */

/** Verb vocabulary for warehouse events. Keep small and stable — adding
 *  a new verb is a coordination event across adapters + subscribers. */
export type DataEventVerb =
  | 'arrived'      // new record added to the collection
  | 'updated'      // existing record changed
  | 'deleted'      // record removed
  | 'upcoming'     // near-future timed event fires (calendar reminders)
  | 'created'      // filesystem/file creation
  | 'received';    // webhook inbound

export interface DataEvent {
  /** Collection namespace: 'emails' | 'calendar' | 'files' | 'webhooks'
   *  | 'crm-snapshots' | custom adapters. */
  collection: string;
  verb: DataEventVerb;
  /** Entity ids affected. Omit for collection-wide invalidation (e.g.,
   *  bulk re-sync). */
  ids?: readonly string[];
  /** Wall-clock emission time. Defaults to Date.now() if omitted. */
  at?: number;
}

export type DataEventListener = (event: DataEvent) => void | Promise<void>;

export interface EventBus {
  /** Publish an event. Synchronous from the caller's POV: listeners fire
   *  immediately on the same tick; async listeners run unawaited. */
  emit(event: DataEvent): void;
  /** Register a listener. Returns an unsubscribe function. */
  subscribe(listener: DataEventListener): () => void;
  /** Number of active listeners — useful for diagnostics. */
  size(): number;
}

export const createEventBus = (): EventBus => {
  const listeners = new Set<DataEventListener>();

  return {
    emit(event) {
      // Copy the set first so an unsubscribe during emit doesn't skip
      // listeners or mutate the iteration.
      const snapshot = [...listeners];
      for (const l of snapshot) {
        try {
          const ret = l(event);
          if (ret && typeof (ret as Promise<void>).then === 'function') {
            // Swallow async listener failures — never bubble to emitter.
            (ret as Promise<void>).catch(() => { /* ignore */ });
          }
        } catch {
          // Sync listener failure — silenced, continue to next.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    size() {
      return listeners.size;
    },
  };
};
