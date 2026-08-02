import type {
  ActivityEntry,
  AppendOptions,
  AuditEntry,
  AuditLogStore,
} from '@recued/storage';

/** Server-side ownership wrapper for audit appends.
 *
 * Many activity producers are deliberately non-blocking: an observability row
 * must not turn a quota denial, notification, or housekeeping pass into a user-
 * visible failure. Those promises still own SQLite work, however. This wrapper
 * keeps that work visible to the terminal lifecycle flush and closes admission
 * before draining, so no late producer can write after the database closes.
 */
export interface DrainableAuditLog {
  readonly auditLog: AuditLogStore;
  /** Permanently close append admission and wait for admitted writes. Safe and
   * idempotent under concurrent shutdown callers. */
  closeAndDrain(): Promise<void>;
}

export const createDrainableAuditLog = (
  underlying: AuditLogStore,
): DrainableAuditLog => {
  const pending = new Set<Promise<unknown>>();
  let accepting = true;
  let drainPromise: Promise<void> | undefined;

  const track = <T>(start: () => Promise<T>): Promise<T> => {
    // A terminal drain has already stopped every producer. Treat a genuinely
    // late telemetry append as a contained no-op rather than letting a detached
    // caller manufacture an unhandled rejection during process shutdown.
    if (!accepting) return Promise.resolve(undefined as T);

    let task: Promise<T>;
    try {
      task = Promise.resolve(start());
    } catch (err) {
      task = Promise.reject(err);
    }
    pending.add(task);
    const clear = (): void => { pending.delete(task); };
    void task.then(clear, clear);
    return task;
  };

  // Keep this adapter explicit. If AuditLogStore gains a method, TypeScript
  // makes this construction fail instead of silently losing it through a
  // spread/prototype boundary.
  const auditLog: AuditLogStore = {
    append: (entry: AuditEntry, options?: AppendOptions) =>
      track(() => underlying.append(entry, options)),
    listRecent: (limit, options) => underlying.listRecent(limit, options),
    listByRecipe: (recipeId, limit) => underlying.listByRecipe(recipeId, limit),
    listByChannelSession: (id, limit, axis) =>
      underlying.listByChannelSession(id, limit, axis),
    listByCognitionSession: (id, limit, axis) =>
      underlying.listByCognitionSession(id, limit, axis),
    listByCorrelation: (id, limit, axis) =>
      underlying.listByCorrelation(id, limit, axis),
    listByDish: (dishId, limit, axis) =>
      underlying.listByDish(dishId, limit, axis),
    latestByDishes: (dishIds) => underlying.latestByDishes(dishIds),
    get: (runId) => underlying.get(runId),
    clearOlderThan: (cutoffMs) => underlying.clearOlderThan(cutoffMs),
    clearByRecipe: (recipeId) => underlying.clearByRecipe(recipeId),
    exportAll: () => underlying.exportAll(),
    size: () => underlying.size(),
    clearAll: () => underlying.clearAll(),
    logActivity: (entry: ActivityEntry, options?: AppendOptions) =>
      track(() => underlying.logActivity(entry, options)),
    listActivities: (limit) => underlying.listActivities(limit),
    exportActivities: () => underlying.exportActivities(),
    clearOldestActivities: (limit) => underlying.clearOldestActivities(limit),
    clearOldestEntries: (limit) => underlying.clearOldestEntries(limit),
    countReserveEntries: () => underlying.countReserveEntries(),
    countReserveActivities: () => underlying.countReserveActivities(),
    lastSuccessfulBridgeDispatch: (bridgeId, targetPattern) =>
      underlying.lastSuccessfulBridgeDispatch(bridgeId, targetPattern),
  };

  const closeAndDrain = (): Promise<void> => {
    if (drainPromise) return drainPromise;
    accepting = false;
    drainPromise = (async () => {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    })();
    return drainPromise;
  };

  return { auditLog, closeAndDrain };
};
