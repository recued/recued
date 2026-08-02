/** Phase D (D-106) — CollectionRegistry.
 *
 *  Owns the live set of `Collection` instances keyed by
 *  `(platform, slug)`. Single instance per server process, composed
 *  at boot in `bin.ts::cmdServe` after the gate registry is wired
 *  but before `startServer` runs — the rpc dispatcher reads from
 *  here on every `collection.*` call.
 *
 *  The registry itself is intentionally thin: it holds references,
 *  dedupes on register, iterates on list, and fans out close() on
 *  dispose. All the real work (ingest, FTS5, retention, events)
 *  lives on the Collection implementations.
 *
 *  Errors during `dispose()`:
 *  - Every collection's close() is started in registration order before any
 *    one close is awaited, so a slow provider cannot leave later collection
 *    admission open during drain.
 *  - A throwing close() does NOT abort the pipeline. Half-closed state is
 *    strictly worse than best-effort closed state (same reasoning as the
 *    Phase C drain orchestrator).
 *  - Collected errors surface as an `AggregateError`; the drain
 *    step that invokes dispose() records the step as `aborted`.
 */

import type { Collection } from './types.js';

export interface CollectionRegistry {
  /** Add a collection. Throws when `(platform, slug)` already has a
   *  registered instance — duplicates indicate a composition-root
   *  bug, not a recoverable runtime condition. Also throws after
   *  `dispose()` so late registrations during drain can't leak. */
  register(collection: Collection): void;
  /** Look up by `(platform, slug)`. Returns `undefined` when no
   *  adapter is registered for the pair. Case-sensitive on both
   *  arguments — the registry keys are interpolated verbatim from
   *  TOML. */
  get(platform: string, slug: string): Collection | undefined;
  /** Remove a `(platform, slug)` entry. Returns true when one was present.
   *
   *  Does NOT close the collection — the caller that took it out of service owns
   *  that (the mail/calendar stacks close in their own `stopLive`), and closing
   *  here would double-close. Exists because `register` THROWS on a duplicate:
   *  without a way out, a delete-then-re-enroll of the same slug either throws
   *  or silently keeps serving the CLOSED collection from the first enroll. */
  unregister(platform: string, slug: string): boolean;
  /** Every registered collection in registration order. Returns a
   *  shallow copy so callers can iterate without risk of
   *  mid-iteration mutation. */
  list(): Collection[];
  /** Close every registered collection and clear the registry. Concurrent
   *  callers coalesce onto the same drain promise; later calls return that
   *  settled result. Called from the `pause_collections` drain step. */
  dispose(): Promise<void>;
}

/** Key builder — kept internal so callers can't bypass the
 *  `(platform, slug)` contract by passing a precomputed key. */
const makeKey = (platform: string, slug: string): string =>
  `${platform}:${slug}`;

export const createCollectionRegistry = (): CollectionRegistry => {
  const byKey = new Map<string, Collection>();
  const order: Collection[] = [];
  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  return {
    register(collection) {
      if (disposed) {
        throw new Error(
          'CollectionRegistry: cannot register after dispose()',
        );
      }
      const k = makeKey(collection.platform, collection.slug);
      if (byKey.has(k)) {
        throw new Error(
          `CollectionRegistry: duplicate registration for ${k}`,
        );
      }
      byKey.set(k, collection);
      order.push(collection);
    },

    get(platform, slug) {
      return byKey.get(makeKey(platform, slug));
    },

    unregister(platform, slug) {
      const k = makeKey(platform, slug);
      const existing = byKey.get(k);
      if (existing === undefined) return false;
      byKey.delete(k);
      // `order` backs `list()`, so it has to drop the entry too — leaving it
      // would keep a removed collection in every heartbeat / retention sweep.
      const i = order.indexOf(existing);
      if (i >= 0) order.splice(i, 1);
      return true;
    },

    list() {
      return [...order];
    },

    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      const toClose = [...order];
      order.length = 0;
      byKey.clear();
      const closes = toClose.map((collection) => {
        try { return Promise.resolve(collection.close()); }
        catch (err) { return Promise.reject(err); }
      });
      disposePromise = Promise.allSettled(closes).then((results) => {
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason);
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            'CollectionRegistry.dispose: one or more close() calls failed',
          );
        }
      });
      return disposePromise;
    },
  };
};
