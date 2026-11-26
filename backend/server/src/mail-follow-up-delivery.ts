import { canonicalizeEmail, parseAddress, mailRecipientInvalidReason, reminderMailReference,
  sameReminderMailReference, type MailFollowUpDeliveryFailure } from '@recued/contracts';
import type { Collection } from './collections/types.js';
import { deliveryMessageId, storedDeliveryReport } from './collections/mail/delivery-report.js';
import type { StoredMailFollowUp } from './storage/mail-follow-up-store.js';

const address = (raw: unknown): string => typeof raw === 'string' && mailRecipientInvalidReason(raw) === null
  ? canonicalizeEmail(parseAddress(raw)!.email) : '';
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every(value => b.includes(value));
export interface DeliveryObservation { failure?: MailFollowUpDeliveryFailure; review?: string }
/** Query the watched mailbox by the returned original Message-ID. Reports
 * commonly use their own conversation, so a thread-only check misses them. */
export const observeFollowUpDelivery = (value: StoredMailFollowUp, selection: {
  box: Pick<Collection, 'list'>; slug: string; account: string; messageId: string; recipients: string[];
}, incarnation: string | null): DeliveryObservation => {
  const rows = selection.box.list({ platform: 'mail', slug: selection.slug,
    filters: { delivery_report_original_id: deliveryMessageId(selection.messageId)! }, limit: 21 });
  const review = { review: 'A delivery report needs review. Its recipient, status, or original email could not be confirmed. No follow-up draft will be prepared.' };
  // A newer explicit report without returned original identity cannot safely
  // be assigned to any particular sent email. Ask for mailbox review rather
  // than treating this incomplete evidence as permission to prepare a draft.
  const unverified = selection.box.list({ platform: 'mail', slug: selection.slug,
    filters: { delivery_report_unverified: 'v1:unknown' }, since: value.watch.mail_ref.received_at, limit: 21 });
  if (unverified.some(row => row.hot_fields.direction !== 'outbound')) return review;
  if (!rows.length) return {};
  if (rows.length > 20 || new Set(rows.map(row => row.record_id)).size !== rows.length || incarnation !== value.watch.mail_ref.incarnation) return review;
  const originalId = deliveryMessageId(selection.messageId)!;
  const originals = [originalId, `<${originalId}>`].flatMap(id => selection.box.list({ platform: 'mail', slug: selection.slug,
    filters: { rfc_message_id: id }, limit: 21 })).filter(row => row.hot_fields.direction === 'outbound' && address(row.hot_fields.from) === selection.account);
  if (originals.length !== 1 || originals[0]!.record_id !== value.watch.mail_ref.record_id || originals[0]!.source_id !== value.watch.mail_ref.source_id) return review;
  const recipient = value.watch.waiting_for?.address ?? (value.recipients.length === 1 ? value.recipients[0] : undefined);
  const failures: MailFollowUpDeliveryFailure[] = [];
  for (const row of rows) {
    if (row.received_at < value.watch.mail_ref.received_at) return review;
    const report = storedDeliveryReport(row.hot_fields.delivery_report);
    const ref = reminderMailReference(selection.slug, row, incarnation);
    const destination = [...(Array.isArray(row.hot_fields.to) ? row.hot_fields.to : []), ...(Array.isArray(row.hot_fields.cc) ? row.hot_fields.cc : [])];
    if (!report || !ref || report.original_message_id !== deliveryMessageId(selection.messageId)
      || row.hot_fields.delivery_report_original_id !== report.original_message_id
      || row.hot_fields.direction !== 'inbound' || !destination.some(raw => address(raw) === selection.account)
      || report.original_from !== selection.account
      || !sameSet(report.original_recipients.filter(item => item !== selection.account), selection.recipients)
      || report.recipients.some(item => !report.original_recipients.includes(item.address))) return review;
    if (!recipient) return { review: 'A delivery report arrived for an email with several recipients. Review the report before following up; this watch waits for anyone.' };
    const target = report.recipients.find(item => item.address === recipient);
    // A specifically selected recipient is unaffected by a report concerning
    // only another original To/Cc recipient.
    if (!target) continue;
    if (target.action !== 'failed' || !target.status.startsWith('5.')) return review;
    failures.push({ recipient, status: target.status, ...(target.reason ? { reason: target.reason } : {}), report_ref: ref });
  }
  // Multiple observations may disagree or describe retries. First slice asks
  // the owner to resolve them rather than choosing a convenient report.
  return failures.length === 1 ? { failure: failures[0] } : failures.length ? review : {};
};
export const sameDeliveryFailure = (a: MailFollowUpDeliveryFailure, b: MailFollowUpDeliveryFailure): boolean =>
  a.recipient === b.recipient && a.status === b.status && a.reason === b.reason && sameReminderMailReference(a.report_ref, b.report_ref);
