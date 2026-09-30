/** ⛔ ATTACHMENT LINKS TWO IMAP MAILBOXES SHARED, REPAIRED ONCE.
 *
 *  Before an IMAP attachment was named with its mailbox
 *  (`mail-attachment-source-id.ts`), two IMAP accounts holding an email under
 *  one id — `uid@folder`: both have a UID 7 in INBOX — stored its attachments
 *  as ONE file, each re-ingest writing its own bytes. That file holds whichever
 *  account wrote last, and the email's link to it is keyed by the bare id, so
 *  it is both mailboxes' link.
 *
 *  For every id two or more mail tables hold, one of them an enrolled IMAP
 *  mailbox's, the email's links to LEGACY attachment files go. The FILES stay:
 *  a chat attachment or a fact may name one. The next sync names the
 *  attachments of the emails in its backfill window with their mailbox; an
 *  older email shows no attachment rather than another account's.
 *
 *  Gmail and Graph ids are the provider's own — two tables hold one only when
 *  an account was enrolled twice (or deleted and enrolled again under another
 *  name) — so an id no IMAP mailbox holds is left alone.
 *
 *  Recorded in the D-308 ledger in the SAME transaction as the deletes, so it
 *  runs once per server. */

import type Database from 'better-sqlite3';

import { createDataRepairLedger } from '../../storage/data-repair-ledger.js';
import { LINK_TABLE } from '../../storage/annotation-store.js';
import { DATA_FILE_RECEIVED_SLUG } from '../file/file-read-handler.js';
import { collectionTableName, listCollectionDataTables } from '../table.js';
import { parseMailAttachmentSourceId } from './mail-attachment-source-id.js';

export const MAIL_ATTACHMENT_SHARED_ID_REPAIR_ID = 'mail-attachment-shared-id-links-v1';

export interface MailAttachmentLinkRepairSummary {
  /** Each link removed: the email's id and the file it named, which is kept. */
  readonly unlinked: ReadonlyArray<{ readonly record_id: string; readonly file_id: string }>;
}

export interface MailAttachmentLinkRepairResult {
  readonly applied: boolean;
  readonly unlinked: number;
}

interface LinkedFileRow {
  readonly link_id: string;
  readonly file_id: string;
  readonly source_id: string;
  readonly origin: unknown;
}

const tableExists = (db: Database.Database, name: string): boolean =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

/** The links to remove: from an email whose id two mail tables hold, one an
 *  IMAP mailbox's, to a `mail_attachment` file named by that id alone. */
const sharedLegacyLinks = (db: Database.Database): Array<{ link_id: string; record_id: string; file_id: string }> => {
  const mailTables = listCollectionDataTables(db, 'mail');
  const filesTable = collectionTableName('file', DATA_FILE_RECEIVED_SLUG);
  if (mailTables.length < 2 || !tableExists(db, LINK_TABLE) || !tableExists(db, filesTable)) return [];
  const imapTables = new Set(tableExists(db, 'collection_instances')
    ? (db.prepare(`SELECT slug FROM collection_instances WHERE platform = 'mail' AND adapter_type = 'imap'`)
      .all() as Array<{ slug: string }>).map((row) => collectionTableName('mail', row.slug))
    : []);
  // A table holds an id at most once (`record_id` is its key): the count is
  // how many mailboxes hold it.
  const held = mailTables
    .map((table) => `SELECT record_id, ${imapTables.has(table) ? 1 : 0} AS imap FROM ${table}`)
    .join(' UNION ALL ');
  const shared = db.prepare(
    `SELECT record_id FROM (${held}) GROUP BY record_id HAVING COUNT(*) > 1 AND MAX(imap) = 1`,
  ).all() as Array<{ record_id: string }>;
  const linkedFiles = db.prepare(
    `SELECT l.id AS link_id, l.to_id AS file_id, f.source_id AS source_id,
            json_extract(f.hot_fields, '$.origin') AS origin
       FROM ${LINK_TABLE} l JOIN ${filesTable} f ON f.record_id = l.to_id
      WHERE l.from_collection = 'mail' AND l.from_id = ? AND l.role = 'attachment' AND l.to_collection = 'file'`,
  );
  const out: Array<{ link_id: string; record_id: string; file_id: string }> = [];
  for (const { record_id } of shared) {
    for (const row of linkedFiles.all(record_id) as LinkedFileRow[]) {
      const source = row.origin === 'mail_attachment' ? parseMailAttachmentSourceId(row.source_id) : null;
      if (source !== null && source.slug === null && source.mail_record_id === record_id) {
        out.push({ link_id: row.link_id, record_id, file_id: row.file_id });
      }
    }
  }
  return out;
};

/** Runs once: a server whose ledger holds the repair gets `applied: false`. */
export const repairSharedMailAttachmentLinks = (
  db: Database.Database,
  now: number,
): MailAttachmentLinkRepairResult => {
  const ledger = createDataRepairLedger(db);
  if (ledger.get(MAIL_ATTACHMENT_SHARED_ID_REPAIR_ID) !== null) return { applied: false, unlinked: 0 };
  let unlinked = 0;
  const applied = db.transaction((): boolean => {
    // Again under the write lock: another process opening this database (the
    // MCP server beside the server) may have run it since the check above.
    if (ledger.get(MAIL_ATTACHMENT_SHARED_ID_REPAIR_ID) !== null) return false;
    const links = sharedLegacyLinks(db);
    const drop = db.prepare(`DELETE FROM ${LINK_TABLE} WHERE id = ?`);
    for (const link of links) drop.run(link.link_id);
    unlinked = links.length;
    ledger.record({
      repair_id: MAIL_ATTACHMENT_SHARED_ID_REPAIR_ID,
      applied_at: now,
      summary: {
        unlinked: links.map(({ record_id, file_id }) => ({ record_id, file_id })),
      } satisfies MailAttachmentLinkRepairSummary,
    });
    return true;
  }).immediate();
  return { applied, unlinked };
};
