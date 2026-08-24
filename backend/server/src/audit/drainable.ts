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
  /** R13 T4-6.1 — number of writes refused since `closeAndDrain()` closed
   * admission. Zero while accepting. The refusal itself is by design; the
   * DEFECT was that nothing counted it, so a recorded write and a dropped one
   * were indistinguishable to every caller. */
  droppedWrites(): number;
}

export interface DrainableAuditLogOptions {
  /** R13 T4-6.1 — invoked synchronously with the RUNNING TOTAL each time a
   * write is refused after drain. Callers persist it OUT-OF-BAND — the audit
   * store is the thing that can no longer record — so the next boot can
   * surface the count (see `dropped-writes-marker.ts`). Must not throw; a
   * throwing callback is swallowed (this runs on the shutdown path). */
  onDroppedWrite?: (total: number) => void;
}

export const createDrainableAuditLog = (
  underlying: AuditLogStore,
  options: DrainableAuditLogOptions = {},
): DrainableAuditLog => {
  const pending = new Set<Promise<unknown>>();
  let accepting = true;
  let dropped = 0;
  let drainPromise: Promise<void> | undefined;

  const track = <T>(start: () => Promise<T>): Promise<T> => {
    // A terminal drain has already stopped every producer. Treat a genuinely
    // late telemetry append as a contained no-op rather than letting a detached
    // caller manufacture an unhandled rejection during process shutdown — but
    // COUNT it (R13 T4-6.1): silent success with no counter made a dropped
    // write indistinguishable from a recorded one.
    if (!accepting) {
      dropped += 1;
      try { options.onDroppedWrite?.(dropped); } catch { /* shutdown path — never throw */ }
      return Promise.resolve(undefined as T);
    }

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
    listByCommitStatus: (status, limit) => underlying.listByCommitStatus(status, limit),
    listWindow: (query) => underlying.listWindow(query),
    listByRecipe: (recipeId, limit) => underlying.listByRecipe(recipeId, limit),
    listByChannelSession: (id, limit, axis) =>
      underlying.listByChannelSession(id, limit, axis),
    listByCognitionSession: (id, limit, axis) =>
      underlying.listByCognitionSession(id, limit, axis),
    listByCorrelation: (id, limit, axis) =>
      underlying.listByCorrelation(id, limit, axis),
    listByExchangeRef: (ref, limit, axis) =>
      underlying.listByExchangeRef(ref, limit, axis),
    listPendingExchangeRefs: (limit) => underlying.listPendingExchangeRefs(limit),
    listInboundContractIds: (limit) => underlying.listInboundContractIds(limit),
    listByPeerContract: (contractId, limit, axis) =>
      underlying.listByPeerContract(contractId, limit, axis),
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

  return { auditLog, closeAndDrain, droppedWrites: () => dropped };
};
