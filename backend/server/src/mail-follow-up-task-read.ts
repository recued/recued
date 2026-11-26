import { RpcError, mailFollowUpTaskRef, type WorkEntityGetRpcResponse, type SourceRegistration, type WorkEntity } from '@recued/contracts';

export type MailFollowUpTaskRead = WorkEntityGetRpcResponse & { source?: SourceRegistration | null };
export const requireMailFollowUpTask = (read: MailFollowUpTaskRead, now: number, open = false): Extract<WorkEntity, { _kind: 'task' }> => {
  const task = read.entity, fresh = read.source_freshness;
  const current = fresh ? ['local', 'fresh'].includes(fresh.state) && fresh.list_complete !== false
    && !(fresh.state === 'fresh' && fresh.stale_after_ms !== undefined && (fresh.last_success_at == null || now - fresh.last_success_at > fresh.stale_after_ms))
    : read.source?.source_kind === 'builtin';
  if (!task || task._kind !== 'task' || !mailFollowUpTaskRef(task) || task.deleted_at != null || task.sync_state !== 'live' || task.pending_write
    || !current || read.source?.sync_posture === 'read_through' || open && task.done)
    throw new RpcError('resource_changed', open ? 'Choose an open, current saved task before linking a reply watch.' : 'The linked task is unavailable or its source is out of date. Open Tasks to check it.', 409);
  return task;
};
