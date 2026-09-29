/**
 * D-315 — the mail ingest's hand-off to the fact writer (§5, §5.3, §7.4).
 *
 * The mail collection calls three hooks: a message upserted, rows removed, a
 * row re-keyed. This turns them into the writer's calls.
 *
 *   - **A message may trigger only when it is news:** seen for the first time,
 *     its mailbox past its first backfill (what that backfill finds is past
 *     mail), and dated inside the backfill window. Mail that arrived while the
 *     server was down is news when the restart's re-list finds it; a years-old
 *     message that appears because it was moved into a synced folder elsewhere
 *     is not. Anything else stores its facts silently. News is told to the
 *     writer the moment the row lands (`onMessageStored`), before the
 *     attachments are fetched, so a stop, a vault lock or a crash before the
 *     facts are read leaves it news for the re-list.
 *   - **The email's date is its own, never later than now:** the providers
 *     give the sender's `Date:` header, which a sender can set in the future;
 *     a thing's state goes by its newest email, and one dated next year would
 *     hold it until then.
 *   - **Template health counts a first sighting only,** so a restart's re-list
 *     and a flag change do not inflate it.
 *   - **Skipped entirely:** mail Recued itself sent (it carries the
 *     reconciliation id, §7.4 — a reply in an owner-request thread must not
 *     become a request), and drafts, which nobody has received or sent.
 *   - **The content fingerprint** covers what the rules read except labels
 *     and relationships, which the writer hashes itself — only those a
 *     template tests — so a read/unread flip re-reads nothing.
 *
 * A deleted, pruned or dropped email takes its facts with it (ruling 29); a
 * moved one keeps them under its new id.
 *
 * The envelope carries what the standards pass needs beyond the content, for
 * owner requests (§7.4): the account's address, the recipients, the RFC
 * message id, the thread, and whether the PROVIDER records this account as
 * the sender. That last one is the canonical message's `direction`, which each
 * provider sets from its own record — Gmail's SENT label, IMAP's Sent folder,
 * Graph's sentitems — never from From. (The STORED direction trusts a From
 * equal to the account; it is not used here.)
 */

import { createHash } from 'node:crypto';

import { isMailReconciliationId } from '@recued/contracts';

import type { MailStoredContext, MailUpsertContext } from '../collections/mail/mail-collection.js';
import { normalizeRfcMessageId, type CanonicalMessage } from '../collections/mail/provider.js';

import type { MailFactWriteResult, MailFactWriter } from './fact-writer.js';
import type { MailFactSourceEmail } from './rules-pass.js';
import type { MailFactEnvelope } from './standards-pass.js';

const MS_PER_DAY = 86_400_000;

export interface MailFactIngestDeps {
  readonly writer: MailFactWriter;
  readonly now: () => number;
  /** The sender's relationships from the contact graph (`family`, `work`, …),
   *  by lower-case address. Absent ⇒ none, and a relationship condition never
   *  holds. */
  readonly relationshipsOf?: (address: string) => readonly string[];
}

export interface MailFactIngest {
  /** The row landed, before its attachments: news is recorded now (§5). */
  onMessageStored(msg: CanonicalMessage, ctx: MailStoredContext): void;
  onMessageUpserted(msg: CanonicalMessage, ctx: MailUpsertContext): MailFactWriteResult | null;
  onRecordsRemoved(slug: string, record_ids: readonly string[]): void;
  onRecordRekeyed(slug: string, from_record_id: string, to_record_id: string): void;
}

/** The labels a template's `label` condition tests: the provider's labels
 *  (Gmail), and the folder the message is in (every provider). */
const labelsOf = (msg: CanonicalMessage): string[] => {
  const labels = new Set<string>();
  for (const label of msg.labels ?? []) if (label.length > 0) labels.add(label);
  if (msg.folder_or_label.length > 0) labels.add(msg.folder_or_label);
  return [...labels];
};

/** A digest of what the passes read. The attachments count: one whose ingest
 *  failed and later succeeded gives the email a file it did not have.
 *  Exported: a backfill fingerprints an email read again the same way, so
 *  an email the ingest already read with the same templates is skipped. */
export const contentFingerprint = (email: MailFactSourceEmail, envelope: MailFactEnvelope): string => {
  const hash = createHash('sha256');
  const part = (value: string): void => {
    hash.update(String(value.length)).update(':').update(value);
  };
  part(envelope.account_email);
  for (const address of [...envelope.to, '\u0000', ...envelope.cc]) part(address);
  part(envelope.sent_by_account ? 'sent' : '');
  part(envelope.rfc_message_id ?? '');
  part(envelope.thread_id);
  part(email.subject);
  part(email.body_text);
  part(email.html ?? '');
  part(email.from_address);
  part(email.from_name);
  for (const name of Object.keys(email.headers).sort()) {
    part(name);
    part(email.headers[name] ?? '');
  }
  for (const attachment of email.attachments) {
    part(attachment.file_id);
    part(attachment.filename);
    part(attachment.mime_type);
  }
  return hash.digest('hex');
};

/** The email as the rules pass reads it. */
export const mailFactSourceEmail = (
  msg: CanonicalMessage,
  ctx: Pick<MailUpsertContext, 'attachments'>,
  relationships: readonly string[],
): MailFactSourceEmail => ({
  subject: msg.subject,
  body_text: msg.body_text,
  html: msg.body_html ?? null,
  from_address: msg.from.trim().toLowerCase(),
  from_name: msg.from_name ?? '',
  headers: msg.headers ?? {},
  labels: labelsOf(msg),
  relationships,
  attachments: ctx.attachments,
});

/** What the standards pass needs beyond the content (§7.4). */
export const mailFactEnvelope = (
  msg: CanonicalMessage,
  ctx: Pick<MailUpsertContext, 'slug' | 'account_email'>,
): MailFactEnvelope => ({
  slug: ctx.slug,
  account_email: ctx.account_email.trim().toLowerCase(),
  to: msg.to,
  cc: msg.cc,
  sent_by_account: msg.direction === 'outbound',
  rfc_message_id: normalizeRfcMessageId(msg.rfc_message_id) ?? null,
  thread_id: msg.thread_id,
});

/** News: first seen, past the first backfill, and inside the backfill window —
 *  and inside the mailbox's retention: mail older than that was pruned, and a
 *  re-list that finds it again has found old mail. */
export const mailMayTrigger = (
  msg: CanonicalMessage,
  ctx: Pick<MailUpsertContext, 'first_seen' | 'backfill_complete' | 'backfill_days' | 'retention_days'>,
  now: number,
): boolean => {
  const days = ctx.retention_days !== undefined && ctx.retention_days > 0
    ? Math.min(ctx.backfill_days, ctx.retention_days)
    : ctx.backfill_days;
  return ctx.first_seen
    && ctx.backfill_complete
    && msg.received_at >= now - Math.max(0, days) * MS_PER_DAY;
};

/** The email's date for its facts: its own, never later than now. */
export const mailFactEmailAt = (received_at: number, now: number): number => Math.min(received_at, now);

/** Mail the passes never read: what Recued sent itself, and drafts. */
const passedOver = (msg: CanonicalMessage): boolean =>
  isMailReconciliationId(msg.reconciliation_id) || msg.direction === 'draft';

export const createMailFactIngest = (deps: MailFactIngestDeps): MailFactIngest => ({
  onMessageStored(msg, ctx) {
    if (passedOver(msg)) return;
    if (mailMayTrigger(msg, { ...ctx, first_seen: true }, deps.now())) {
      deps.writer.markNews({ slug: ctx.slug, record_id: ctx.record_id });
    }
  },
  onMessageUpserted(msg, ctx) {
    if (passedOver(msg)) return null;
    const address = msg.from.trim().toLowerCase();
    const email = mailFactSourceEmail(msg, ctx, deps.relationshipsOf?.(address) ?? []);
    const envelope = mailFactEnvelope(msg, ctx);
    return deps.writer.write({
      ref: { slug: ctx.slug, record_id: ctx.record_id },
      email,
      email_at: mailFactEmailAt(msg.received_at, deps.now()),
      content_fingerprint: contentFingerprint(email, envelope),
      may_trigger: mailMayTrigger(msg, ctx, deps.now()),
      count_health: ctx.first_seen,
      envelope,
    });
  },
  onRecordsRemoved(slug, record_ids) {
    deps.writer.removeEmails(slug, record_ids);
  },
  onRecordRekeyed(slug, from_record_id, to_record_id) {
    deps.writer.rekeyEmail(slug, from_record_id, to_record_id);
  },
});
