import { isMailSendClaimDelivered, isMailSendClaimReclaimable, mailSentReconciliationQueryFor } from '@recued/contracts';
import type { AskDeliveryOutcome } from '@recued/notification';
import type { MailSendClaimStore } from '../storage/mail-send-claim-store.js';
import type { MailCollection } from '../collections/mail/mail-collection.js';

/** Reuses D-200's source-truth query against the mailbox recorded BEFORE the
 * original send. In particular a missing claim is proof no fenced send started;
 * calling send to "check" that case would send a now-closed reminder. */
export const createReminderMailReconciler = (deps: {
  claims: Pick<MailSendClaimStore, 'get' | 'settle'>;
  mailbox: (slug: string) => Pick<MailCollection, 'lookupSentByReconciliationId'> | undefined;
  now?: () => number;
}) => async (reconciliation_id: string): Promise<AskDeliveryOutcome> => {
  const now = deps.now ?? Date.now;
  const claim = deps.claims.get(reconciliation_id);
  if (!claim || isMailSendClaimReclaimable(claim.status)) return { outcome: 'not_delivered' };
  if (isMailSendClaimDelivered(claim.status)) return { outcome: 'delivered',
    ...(claim.provider_message_id ? { provider_message_id: claim.provider_message_id } : {}) };
  const query = mailSentReconciliationQueryFor(claim, now());
  const mailbox = deps.mailbox(claim.sender_slug);
  if (!query || !mailbox || claim.status === 'ambiguous') return { outcome: 'unknown' };
  try {
    const proof = await mailbox.lookupSentByReconciliationId(query);
    const settled = deps.claims.settle({ reconciliation_id, expected_revision: claim.revision, result: proof, now: now() });
    return isMailSendClaimDelivered(settled.status) ? { outcome: 'delivered',
      ...(settled.provider_message_id ? { provider_message_id: settled.provider_message_id } : {}) }
      : isMailSendClaimReclaimable(settled.status) ? { outcome: 'not_delivered' } : { outcome: 'unknown' };
  } catch {
    const latest = deps.claims.get(reconciliation_id);
    return latest && isMailSendClaimDelivered(latest.status) ? { outcome: 'delivered',
      ...(latest.provider_message_id ? { provider_message_id: latest.provider_message_id } : {}) } : { outcome: 'unknown' };
  }
};
