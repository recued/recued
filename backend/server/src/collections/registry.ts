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
 *  - Each collection's close() is attempted in registration order.
 *  - A throwing close() does NOT abort the pipeline — later
 *    collections still get closed. Half-closed state is strictly
 *    worse than best-effort closed state (same reasoning as the
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
  /** Every registered collection in registration order. Returns a
   *  shallow copy so callers can iterate without risk of
   *  mid-iteration mutation. */
  list(): Collection[];
  /** Close every registered collection and clear the registry.
   *  Idempotent — a second dispose is a no-op. Called from the
   *  `pause_collections` drain step. */
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

    list() {
      return [...order];
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      const toClose = [...order];
      order.length = 0;
      byKey.clear();
      const errors: unknown[] = [];
      for (const c of toClose) {
        try {
          await c.close();
        } catch (err) {
          errors.push(err);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          'CollectionRegistry.dispose: one or more close() calls failed',
        );
      }
    },
  };
};
