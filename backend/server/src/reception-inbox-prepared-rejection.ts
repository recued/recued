import { isReceptionInboxTopTierKind } from '@recued/contracts';
import { PREPARED_PREFLIGHT_DENIAL_KIND } from '@recued/gateway';
import type { Answer } from '@recued/notification';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';
import type { ReceptionInboxSubviewStore } from './reception-inbox-handler.js';

/** Required, idempotent history projection of an accepted inbox denial.
 *  The gateway checks checkpoint/batch binding before calling this. Throws
 *  remain on the durable answer's retry path, including partial writes. */
export const createPreparedInboxRejectionRecorder = (deps: {
  subviewStore: ReceptionInboxSubviewStore;
  auditLog: AuditLogStore;
}) => async (answer: Answer): Promise<void> => {
  const data = answer.prepared;
  const rejection = data?.inbox_rejection;
  if (answer.option !== 'deny' || data?.kind !== PREPARED_PREFLIGHT_DENIAL_KIND
    || typeof data.checkpoint_id !== 'string' || data.checkpoint_id.length === 0
    || !Number.isFinite(answer.answered_at) || !rejection || typeof rejection !== 'object' || Array.isArray(rejection)) {
    throw new Error('Invalid prepared inbox rejection');
  }
  const fields = rejection as Record<string, unknown>;
  if (!isReceptionInboxTopTierKind(fields.top_tier_kind)
    || typeof fields.source_record_ref !== 'string'
    || (fields.reason !== undefined && typeof fields.reason !== 'string')
    || (fields.door_contract_id !== undefined && typeof fields.door_contract_id !== 'string')) {
    throw new Error('Invalid prepared inbox rejection history');
  }
  deps.subviewStore.record({ hold_id: data.checkpoint_id, status: 'dismissed', top_tier_kind: fields.top_tier_kind,
    source_record_ref: fields.source_record_ref, dismissed_at: answer.answered_at,
    ...(typeof fields.reason === 'string' ? { reason: fields.reason } : {}),
    ...(typeof fields.door_contract_id === 'string' ? { door_contract_id: fields.door_contract_id } : {}),
  });
  await deps.auditLog.logActivity({ activity_id: `reception.inbox.rejected-${answer.answered_at}-${data.checkpoint_id}`,
    timestamp: answer.answered_at, action: 'reception.inbox.rejected' as ActivityEntry['action'], target: data.checkpoint_id,
    detail: typeof fields.reason === 'string' ? `rejected: ${fields.reason}` : 'rejected', reserve: true,
  });
};
