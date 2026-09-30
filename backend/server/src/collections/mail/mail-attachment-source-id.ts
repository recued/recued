/** Which mailbox a received attachment belongs to, as its file's source id says.
 *
 *  A mail attachment is stored in `data.file.received` — ONE table for every
 *  mailbox — as `inboundFileRecordId('mail_attachment', source_id)`, and linked
 *  from its email. The source id was `<mail record id>:<part>`, and an IMAP
 *  record id hashes `uid@folder`, which two IMAP accounts share (each has a UID
 *  7 in INBOX). Their rows never met — each mailbox has its own table — but
 *  their attachments were ONE file: every restart's re-scan re-ingested it with
 *  the other account's bytes, and a reader keyed by the bare id got the other
 *  account's document.
 *
 *  ⇒ An IMAP attachment is named with its mailbox: `<slug>/<mail record id>:<part>`
 *  (SCOPED). The old form (LEGACY) is kept only where it cannot be ambiguous: a
 *  message no other mailbox holds, whose file is already stored and linked —
 *  so an upgrade renames no single-account file. Gmail and Graph ids are the
 *  provider's own; their attachments keep the legacy form.
 *
 *  The two forms cannot be read as each other: a slug holds neither `/` nor `:`
 *  (`SLUG_RE`, `enroll.ts`), and a mail record id starts `mail:`. */

import type Database from 'better-sqlite3';

import { inboundFileRecordId } from '../file/inbound-file-collection.js';
import type { CollectionRegistry } from '../registry.js';
import { listCollectionDataTables } from '../table.js';
import type { MailCollection } from './mail-collection.js';

export const legacyMailAttachmentSourceId = (mailRecordId: string, partId: string): string =>
  `${mailRecordId}:${partId}`;

export const scopedMailAttachmentSourceId = (slug: string, mailRecordId: string, partId: string): string =>
  `${slug}/${mailRecordId}:${partId}`;

/** The `data.file.received` record an attachment's source id names. */
export const mailAttachmentFileId = (sourceId: string): string =>
  inboundFileRecordId('mail_attachment', sourceId);

export interface MailAttachmentSource {
  /** The mailbox a scoped id names; `null` for the legacy form, which names none. */
  readonly slug: string | null;
  readonly mail_record_id: string;
  readonly part_id: string;
}

const SCOPED = /^([^/:]+)\/(mail:[^:]+):(.+)$/;
const LEGACY = /^(mail:[^:]+):(.+)$/;

/** `null` for a source id in neither form — not an attachment of an email. */
export const parseMailAttachmentSourceId = (sourceId: string): MailAttachmentSource | null => {
  const scoped = SCOPED.exec(sourceId);
  if (scoped) return { slug: scoped[1]!, mail_record_id: scoped[2]!, part_id: scoped[3]! };
  const legacy = LEGACY.exec(sourceId);
  return legacy ? { slug: null, mail_record_id: legacy[1]!, part_id: legacy[2]! } : null;
};

/** Whether a mail table other than `ownTable` holds a row under `record_id`.
 *  Read from the tables, not the registry: a mailbox not started yet (boot
 *  starts them one by one) or since deleted still has its rows, and its
 *  attachments may be in the legacy file. */
export const mailRecordIdHeldByAnotherMailbox = (
  db: Database.Database,
  ownTable: string,
  record_id: string,
): boolean =>
  listCollectionDataTables(db, 'mail').some((table) => table !== ownTable
    && db.prepare(`SELECT 1 FROM ${table} WHERE record_id = ?`).get(record_id) !== undefined);

/** `MailCollection.legacyAttachmentsAmbiguous` for the mailbox a slug names.
 *  ⛔ Fails closed: a mailbox the registry does not hold, or one that cannot
 *  answer, reads as ambiguous — a legacy file is then not offered, rather than
 *  offered as possibly another account's document. */
export const legacyAttachmentsAmbiguousIn = (registry: Pick<CollectionRegistry, 'get'>) =>
  (slug: string, record_id: string): boolean => {
    const mailbox = registry.get('mail', slug) as Partial<Pick<MailCollection, 'legacyAttachmentsAmbiguous'>> | undefined;
    if (typeof mailbox?.legacyAttachmentsAmbiguous !== 'function') return true;
    try { return mailbox.legacyAttachmentsAmbiguous(record_id); }
    catch { return true; }
  };
