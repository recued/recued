import type { AuditLogStore, CheckpointStore } from '@recued/storage';

const queues = new WeakMap<CheckpointStore, Map<string, Promise<unknown>>>();

/** Call after caller authorization when applicable. Ask-backed decisions retain the block's
 *  answer arbitration. Ask-less inbox decisions and retention share a queue by checkpoint store
 *  and hold, including copied/composed dependency objects. The task must read
 *  the hold afresh after waiting; this preliminary read only picks the path. */
export const runAsklessCheckpointDecision = async <T>(
  deps: { checkpointStore: CheckpointStore; auditLog: AuditLogStore },
  holdId: unknown,
  task: () => Promise<T>,
): Promise<T> => {
  if (typeof holdId !== 'string' || holdId.length === 0) return task();
  const checkpoint = await deps.checkpointStore.get(holdId);
  const anchor = checkpoint === null ? null : await deps.auditLog.get(checkpoint.run_id);
  if (typeof anchor?.ask_id === 'string' && anchor.ask_id.length > 0) return task();

  let queue = queues.get(deps.checkpointStore);
  if (!queue) { queue = new Map(); queues.set(deps.checkpointStore, queue); }
  const ownedQueue = queue;
  const previous = queue.get(holdId) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(task);
  queue.set(holdId, pending);
  try { return await pending; }
  finally {
    if (ownedQueue.get(holdId) === pending) {
      ownedQueue.delete(holdId);
      if (ownedQueue.size === 0) queues.delete(deps.checkpointStore);
    }
  }
};
