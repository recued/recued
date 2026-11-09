import type { IdempotencyCache } from './cache.js';

/** Observe successful mutations after their commit promise settles. The
 *  observer receives no command data and cannot hold up admission or results.
 *  Reads and replays are silent, preventing an inspection feedback loop. */
export const observeIdempotencyChanges = (
  cache: IdempotencyCache,
  onChanged: () => void | Promise<void>,
): IdempotencyCache => {
  const changed = (): void => {
    try { void Promise.resolve(onChanged()).catch(() => undefined); }
    catch { /* Diagnostics cannot change the outcome of a committed operation. */ }
  };
  return {
    async claim(command_id, key) {
      const result = await cache.claim(command_id, key);
      if (result.kind === 'claimed') changed();
      return result;
    },
    async store(command_id, key, result) {
      await cache.store(command_id, key, result);
      changed();
    },
    lookup: command_id => cache.lookup(command_id),
    lookupByIdempotencyKey: key => cache.lookupByIdempotencyKey(key),
    async sweepExpired(at) {
      const removed = await cache.sweepExpired(at);
      if (removed > 0) changed();
      return removed;
    },
    list: () => cache.list(),
    inspectReceipts: () => cache.inspectReceipts(),
    inspectInFlight: () => cache.inspectInFlight(),
    inspectDiagnostics: () => cache.inspectDiagnostics(),
    async clear() {
      await cache.clear();
      changed();
    },
  };
};
