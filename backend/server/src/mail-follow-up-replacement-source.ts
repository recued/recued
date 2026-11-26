import { createHash } from 'node:crypto';
import { RpcError, MAIL_DRAFT_SOURCE_MAX, MAIL_COMPOSE_MAX_ATTACHMENTS, MAIL_SEND_ATTACHMENT_MAX_BYTES,
  canonicalizeEmail, parseAddress, reminderMailReference, sameReminderMailReference,
  type ReminderMailReference, type MailDraftContent, type MailMessageAttachment, type MailMessageAttachmentsSnapshot } from '@recued/contracts';
import type { MailCollection } from './collections/mail/mail-collection.js';
import { deliveryMessageId } from './collections/mail/delivery-report.js';
import { followUpHash } from './storage/mail-follow-up-store.js';

type Mailbox = Pick<MailCollection, 'get' | 'accountEmail'> & { provider: Pick<MailCollection['provider'], 'fetchMessage'> };
export interface MailReplacementSource { content: MailDraftContent; current(): void }
const email = (raw: unknown): string => typeof raw === 'string' ? canonicalizeEmail(parseAddress(raw)?.email ?? '') : '';
const addresses = (raw: unknown): string[] => Array.isArray(raw) ? raw.map(email).sort() : [];
const unavailable = () => new RpcError('resource_changed', 'The complete original email and its attachments could not be verified. Refresh Mail before preparing a replacement.', 409);

/** Explicit owner read of the original Sent message. A replacement is a new
 * email, with only the failed recipient, plain text, and verified durable files.
 * It inherits neither reply headers nor the original send's replay identity. */
export const createMailReplacementSourceReader = (deps: {
  mailbox(slug: string): Mailbox | undefined;
  incarnation(slug: string): string | null;
  attachments(ref: ReminderMailReference): Promise<MailMessageAttachmentsSnapshot>;
  assertAttachments(ref: ReminderMailReference, items: readonly MailMessageAttachment[]): void;
}) => async (ref: ReminderMailReference, recipient: string, authorized: () => void): Promise<MailReplacementSource> => {
  const box = deps.mailbox(ref.slug), record = box?.get(ref.record_id);
  if (!box || !record || !box.provider.fetchMessage) throw unavailable();
  const original = reminderMailReference(ref.slug, record, deps.incarnation(ref.slug));
  if (!original || !sameReminderMailReference(ref, original) || email(record.hot_fields.from) !== email(box.accountEmail)
    || record.hot_fields.direction !== 'outbound') throw unavailable();
  const stamp = followUpHash(record), account = email(box.accountEmail);
  const files: string[] = []; let attachmentItems: readonly MailMessageAttachment[] | undefined;
  const current = () => {
    authorized();
    const latest = deps.mailbox(ref.slug), row = latest?.get(ref.record_id);
    if (!row || email(latest!.accountEmail) !== account || deps.incarnation(ref.slug) !== ref.incarnation
      || followUpHash(row) !== stamp) throw unavailable();
    if (attachmentItems) deps.assertAttachments(ref, attachmentItems);
  };
  current();
  const message = await box.provider.fetchMessage(ref.source_id); current();
  if (!message || message.source_id !== ref.source_id || !deliveryMessageId(message.rfc_message_id)
    || deliveryMessageId(message.rfc_message_id) !== deliveryMessageId(record.hot_fields.rfc_message_id)
    || email(message.from) !== account || message.subject !== record.hot_fields.subject
    || JSON.stringify(addresses(message.to)) !== JSON.stringify(addresses(record.hot_fields.to))
    || JSON.stringify(addresses(message.cc)) !== JSON.stringify(addresses(record.hot_fields.cc))
    || typeof message.body_text !== 'string' || message.body_text.length > MAIL_DRAFT_SOURCE_MAX
    || !message.body_text && Boolean(message.body_html)) throw unavailable();
  const parts = message.attachments ?? [];
  if (parts.length > MAIL_COMPOSE_MAX_ATTACHMENTS || (message.has_attachments || record.hot_fields.has_attachments) && !parts.length) throw unavailable();
  if (parts.length) {
    const snapshot = await deps.attachments(ref); current();
    if (snapshot.incarnation !== ref.incarnation || snapshot.slug !== ref.slug || snapshot.record_id !== ref.record_id
      || snapshot.truncated || snapshot.warnings.length || snapshot.items.length !== parts.length
      || snapshot.items.some(item => item.unavailable_reason || !item.content_hash || !item.selection_revision || item.size === null)
      || new Set(snapshot.items.map(item => item.file_id)).size !== parts.length) throw unavailable();
    attachmentItems = snapshot.items; current();
    const remaining = [...snapshot.items]; let total = 0;
    for (const part of parts) {
      if (!Number.isSafeInteger(part.size) || part.size < 0 || part.size > MAIL_SEND_ATTACHMENT_MAX_BYTES) throw unavailable();
      const bytes = await part.fetchBytes(); current(); total += bytes.length;
      if (total > MAIL_SEND_ATTACHMENT_MAX_BYTES) throw unavailable();
      const hash = createHash('sha256').update(bytes).digest('hex');
      const index = remaining.findIndex(item => item.content_hash === hash && item.size === bytes.length
        && item.filename === part.filename && item.mime_type.toLowerCase() === part.mime_type.toLowerCase());
      if (index < 0) throw unavailable();
      files.push(remaining.splice(index, 1)[0]!.file_id);
    }
    current();
  }
  return { content: { sender_mail_instance: ref.slug, to: [recipient], subject: message.subject,
    body: message.body_text, body_format: 'text', ...(files.length ? { attachments: files } : {}) }, current };
};
