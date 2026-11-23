import { PREPARED_PREFLIGHT_EDITS_KIND } from '@recued/gateway';
import type { AnswerAuditRecord } from '@recued/notification';
import type { ActivityEntry } from '@recued/storage';

/** Project only a committed inbox approval. Stable identity makes recovery
 *  idempotent; unaccepted proposals never reach the answer-audit callback. */
export const preparedInboxApprovalActivity = (record: AnswerAuditRecord): ActivityEntry | undefined => {
  const data = record.prepared;
  if (data?.kind !== PREPARED_PREFLIGHT_EDITS_KIND) return undefined;
  const audit = data.inbox_audit;
  const payload = record.handler_payload;
  const batchMember = typeof payload?.batch_id === 'string' && Array.isArray(payload.batch_checkpoint_ids)
    && payload.batch_checkpoint_ids.includes(data.checkpoint_id);
  if (typeof data.checkpoint_id !== 'string' || (data.checkpoint_id !== payload?.checkpoint_id && !batchMember)
    || !audit || typeof audit !== 'object'
    || typeof (audit as Record<string, unknown>).detail !== 'string') {
    throw new Error('Invalid prepared inbox approval audit');
  }
  return { activity_id: `reception.inbox.approved-${record.answered_at}-${record.ask_id}`,
    timestamp: record.answered_at, action: 'reception.inbox.approved' as ActivityEntry['action'], target: data.checkpoint_id,
    detail: (audit as { detail: string }).detail, reserve: true };
};
