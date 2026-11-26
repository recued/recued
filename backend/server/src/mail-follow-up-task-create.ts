import { RECUED_BUILTIN_SOURCE_ID, RpcError, type MailFollowUpTaskRef, type Task } from '@recued/contracts';
import type { WorkEntityCrudRpcDeps } from './work-entity-crud-handler.js';

export interface MailFollowUpTaskWriter {
  available(): boolean;
  prepare(input: { id: string; created_at: number; title: string; body: string; due_at?: number }): {
    ref: MailFollowUpTaskRef; write(): void; publish(): void;
  };
}

/** The caller's watch store and this canonical task store share one SQLite
 * connection. Prepare has no effects; write belongs inside that transaction. */
export const createMailFollowUpTaskWriter = (current: () => WorkEntityCrudRpcDeps | null): MailFollowUpTaskWriter => {
  const sourceId = RECUED_BUILTIN_SOURCE_ID('task');
  const ready = (deps: WorkEntityCrudRpcDeps | null): boolean => {
    const source = deps?.store.getSource(sourceId);
    return source?.source_kind === 'builtin' && source.top_tier_kind === 'task'
      && source.write_capable === true && source.sync_posture !== 'read_through';
  };
  return {
    available: () => ready(current()),
    prepare(input) {
      const owner = current();
      const check = () => {
        if (!owner || current() !== owner || !ready(owner)) throw new RpcError('unavailable', 'Local task creation is unavailable. Try again when Tasks is ready.', 503);
        return owner;
      };
      check(); let task: Task | undefined;
      return { ref: { id: input.id, source_id: sourceId, created_at: input.created_at },
        write() {
          const deps = check();
          if (deps.store.readTask(input.id)) throw new RpcError('conflict', 'This task identity is already in use. Refresh the watch before creating a task.', 409);
          task = deps.store.writeTask({ ...input, source_id: sourceId, done: false }, input.created_at);
        },
        publish() { if (task) owner!.dispatchers.ownerTaskWritten(task); },
      };
    },
  };
};
