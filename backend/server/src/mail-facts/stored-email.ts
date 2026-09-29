/**
 * D-315 §4.4, §6 — mail that already arrived, read the way the ingest read it.
 *
 * The stored row keeps the subject, the body text, the sender's address and
 * the labels; it drops the HTML, the headers and the sender's name (§4.4). A
 * template's preview (§6.2) and a backfill (§6.3) read an email as the passes
 * read it at ingest, so they fetch it again from its provider
 * (`MailProvider.fetchMessage`) and build the same input the ingest builds.
 *
 *   - **The RFC message id must still match.** An IMAP id is `UID@folder` with
 *     no UIDVALIDITY: a mailbox renumbered since hands back another message
 *     under the same UID. A mismatch is treated as the email being gone.
 *   - **When it cannot be fetched** — the provider has no single-message read,
 *     no longer has the message, or the read failed — the STORED COPY is used,
 *     and the result says so: no HTML, no headers, no sender name, no
 *     attachments, and never an owner request (whether the account sent it is
 *     the provider's record, which the stored copy does not carry, §7.4).
 *   - **An attachment is named by the file the ingest made of it**
 *     (`inboundFileRecordId`), derived the same way, so a `file` variable a
 *     backfill reads points at that file — from the email's id when it was
 *     ingested: a move since gave it a new one (the writer's move ledger).
 */

import type { CollectionRecord } from '@recued/contracts';

import { inboundFileRecordId } from '../collections/file/inbound-file-collection.js';
import type { MailCollection } from '../collections/mail/mail-collection.js';
import { normalizeRfcMessageId, type CanonicalMessage } from '../collections/mail/provider.js';
import { materializeMailBody } from '../mail-body-read-handler.js';
import type { BlobStore } from '../storage/blob-store.js';
import { mailFactEnvelope, mailFactSourceEmail } from './mail-ingest.js';
import type { MailFactSourceAttachment, MailFactSourceEmail } from './rules-pass.js';
import type { MailFactEnvelope } from './standards-pass.js';

/** How an email was read: again from its provider, or from the stored copy. */
export type StoredEmailRead = 'provider' | 'stored';

/** Why the stored copy was read instead. */
export type StoredEmailFallback = 'unsupported' | 'gone' | 'failed';

export interface StoredEmail {
  readonly record: CollectionRecord;
  readonly email: MailFactSourceEmail;
  readonly envelope: MailFactEnvelope;
  readonly read: StoredEmailRead;
  readonly fallback?: StoredEmailFallback;
  /** The message as fetched, when it was. */
  readonly message?: CanonicalMessage;
}

export interface StoredEmailDeps {
  readonly blobs: BlobStore;
  /** The sender's relationships from the contact graph. */
  readonly relationshipsOf?: (address: string) => readonly string[];
  /** Whether the ingest stored this attachment's file. A download that failed
   *  stored none, and a rule must not read a file that does not exist: without
   *  this, no attachment of an email read again is offered at all. */
  readonly fileStored?: (file_id: string) => boolean;
  /** The type the ingest stored an attachment's file with, which it read from
   *  the file's bytes: a PDF its provider calls `application/octet-stream` is
   *  a PDF. Read again, an attachment is the type the ingest read — a rule
   *  that finds one by type lost the PDF, and its fact went. */
  readonly storedFileType?: (file_id: string) => string | undefined;
  /** The ids a move took an email from (the writer's move ledger). The ingest
   *  names an attachment's file by its email's id then, and a move gives the
   *  email a new one: without these, a moved email read again has none. */
  readonly formerRecordIds?: (slug: string, record_id: string) => readonly string[];
}

const hotString = (record: CollectionRecord, key: string): string => {
  const value = record.hot_fields[key];
  return typeof value === 'string' ? value : '';
};

const hotStrings = (record: CollectionRecord, key: string): string[] => {
  const value = record.hot_fields[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
};

/** A message's attachments whose files the ingest stored, each by the id it
 *  was stored under: the ingest names a file by its email's id, the first of
 *  `recordIds` that names a stored file — the email's id now, then the ids a
 *  move took it from. */
const storedAttachments = (
  message: CanonicalMessage,
  recordIds: readonly string[],
  deps: Pick<StoredEmailDeps, 'fileStored' | 'storedFileType'>,
): MailFactSourceAttachment[] => {
  const out: MailFactSourceAttachment[] = [];
  for (const [index, part] of (message.attachments ?? []).entries()) {
    const partId = part.source_part_id || `part-${index}`;
    const file_id = recordIds
      .map((record_id) => inboundFileRecordId('mail_attachment', `${record_id}:${partId}`))
      .find((id) => deps.fileStored?.(id) === true);
    if (file_id !== undefined) {
      out.push({ file_id, filename: part.filename, mime_type: deps.storedFileType?.(file_id) ?? part.mime_type });
    }
  }
  return out;
};

/** A fetched message's attachments whose files are stored now, for its email's
 *  id now and the ids a move took it from — read again after a wait, a file
 *  deleted meanwhile is not offered. */
export const storedAttachmentsOf = (
  message: CanonicalMessage,
  slug: string,
  record_id: string,
  deps: Pick<StoredEmailDeps, 'fileStored' | 'storedFileType' | 'formerRecordIds'>,
): MailFactSourceAttachment[] =>
  storedAttachments(message, [record_id, ...(deps.formerRecordIds?.(slug, record_id) ?? [])], deps);

/** A stored email's labels as the passes read them: its labels and its folder. */
export const storedLabels = (record: CollectionRecord): string[] => {
  const labels = new Set(hotStrings(record, 'labels'));
  const folder = hotString(record, 'folder');
  if (folder.length > 0) labels.add(folder);
  return [...labels];
};

/** The stored copy as the passes read it: no HTML, headers, sender name or
 *  attachments. `withBody: false` skips reading the body (a first cut on the
 *  hot fields alone). */
export const storedCopyEmail = async (
  deps: StoredEmailDeps,
  record: CollectionRecord,
  options: { readonly withBody?: boolean } = {},
): Promise<MailFactSourceEmail> => {
  const address = hotString(record, 'from').trim().toLowerCase();
  const labels = storedLabels(record);
  return {
    subject: hotString(record, 'subject'),
    body_text: options.withBody === false ? '' : (await materializeMailBody(record, deps.blobs)) ?? '',
    html: null,
    from_address: address,
    from_name: '',
    headers: {},
    labels,
    relationships: deps.relationshipsOf?.(address) ?? [],
    attachments: [],
  };
};

const storedCopyEnvelope = (collection: MailCollection, record: CollectionRecord): MailFactEnvelope => ({
  slug: collection.slug,
  account_email: collection.accountEmail.trim().toLowerCase(),
  to: hotStrings(record, 'to'),
  cc: hotStrings(record, 'cc'),
  // The stored direction trusts a From equal to the account; only the
  // provider's own record may say the account sent it (§7.4). It still leaves
  // the copy out as sent mail, as the ingest left it out.
  sent_by_account: false,
  ...(hotString(record, 'direction') === 'outbound' ? { stored_as_sent: true } : {}),
  rfc_message_id: normalizeRfcMessageId(hotString(record, 'rfc_message_id')) ?? null,
  thread_id: hotString(record, 'thread_id'),
});

/** One stored email, read again from its provider when it can be. `null` when
 *  the mailbox has no such row. */
export const readStoredEmail = async (
  deps: StoredEmailDeps,
  collection: MailCollection,
  record_id: string,
): Promise<StoredEmail | null> => {
  const record = collection.get(record_id);
  if (record === null) return null;

  let fallback: StoredEmailFallback = 'unsupported';
  const fetch = collection.provider.fetchMessage;
  if (typeof fetch === 'function') {
    try {
      const message = await fetch.call(collection.provider, record.source_id);
      const storedId = normalizeRfcMessageId(hotString(record, 'rfc_message_id'));
      const fetchedId = normalizeRfcMessageId(message?.rfc_message_id);
      // A Message-ID the stored email has must be the fetched message's too: a
      // message with none may be another one under a reused id (IMAP).
      if (message === null || (storedId !== undefined && fetchedId !== storedId)) {
        fallback = 'gone';
      } else {
        const ctx = {
          slug: collection.slug,
          account_email: collection.accountEmail,
          // Named by the id the ingest gave a file — the email's id then, which
          // a move since has changed — and kept only when that file is stored:
          // a download that failed at ingest made none.
          attachments: storedAttachmentsOf(message, collection.slug, record.record_id, deps),
        };
        const address = message.from.trim().toLowerCase();
        return {
          record,
          email: mailFactSourceEmail(message, ctx, deps.relationshipsOf?.(address) ?? []),
          envelope: mailFactEnvelope(message, ctx),
          read: 'provider',
          message,
        };
      }
    } catch {
      fallback = 'failed';
    }
  }
  return {
    record,
    email: await storedCopyEmail(deps, record),
    envelope: storedCopyEnvelope(collection, record),
    read: 'stored',
    fallback,
  };
};
