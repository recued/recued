/** D-139 § A.9.2b — the inputs `computeOutOfBandEngagement` cannot get itself.
 *
 *  The kernel is pure: mail rows in, CRM rows in, per-contact confidence in,
 *  a value out. Three of those come from three different substrates, which is
 *  why this topic outlived the other eleven — its gather is the work.
 *
 *  ## Mail is indexed ONCE PER CYCLE, not once per deal
 *
 *  `data.mail` is one physical table PER ENROLLED ACCOUNT
 *  (`collection_mail_<10-hex>`), so a per-deal query would be
 *  O(deals × accounts × window) — on a portal with a few hundred deals that
 *  is the same scan repeated a few hundred times. The index is built once and
 *  keyed by recipient, so each deal pays a map lookup.
 *
 *  ⚠ `'draft'` IS A DIRECTION in `data.mail`, alongside `'outbound'`,
 *  `'inbound'` and `'unknown'`. Only `'outbound'` counts: a draft has not
 *  been sent, so the CRM is right to have no record of it, and counting one
 *  would report a visibility gap for a mail that never left. */

import type Database from 'better-sqlite3';

import { engagementSubjectHash } from '@recued/contracts';

import { listCollectionDataTables } from '../../collections/table.js';
import type { OutOfBandContactConfidence, OutOfBandMailRow } from './out-of-band-engagement.js';

/** Cap on mail rows folded per cycle across every account. Bounds a first
 *  cycle on a large archive; the window already bounds steady state. */
export const OUT_OF_BAND_MAIL_SCAN_CAP = 5_000;

/** Cap on contacts pulled per deal. `listDealCounterpartyContactEmails`
 *  takes `cap + 1` so truncation is detectable. */
export const OUT_OF_BAND_CONTACTS_PER_DEAL = 200;

const canonicalEmail = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
};

interface MailHotFields {
  from?: unknown;
  to?: unknown;
  subject?: unknown;
  direction?: unknown;
  rfc_message_id?: unknown;
  message_id?: unknown;
}

/** Recipient email → the outbound mails addressed to them in the window.
 *  A mail with N recipients appears under N keys; the kernel gates on the
 *  FIRST recipient, so the duplication is what lets any deal contact find
 *  the mail regardless of their position in the to-list. */
export type OutboundMailIndex = ReadonlyMap<string, ReadonlyArray<OutOfBandMailRow>>;

export const buildOutboundMailIndex = (
  db: Database.Database,
  input: { since: number; cap?: number },
): OutboundMailIndex => {
  const cap = input.cap ?? OUT_OF_BAND_MAIL_SCAN_CAP;
  const index = new Map<string, OutOfBandMailRow[]>();
  let scanned = 0;

  for (const table of listCollectionDataTables(db, 'mail')) {
    if (scanned >= cap) break;
    const rows = db
      .prepare(
        `SELECT record_id, received_at, modified_at, hot_fields
           FROM ${table}
          WHERE received_at >= ?
            AND json_extract(hot_fields, '$.direction') = 'outbound'

          ORDER BY received_at DESC
          LIMIT ?`,
      )
      .all(input.since, cap - scanned) as Array<{
        record_id: string; received_at: number; modified_at: number; hot_fields: string;
      }>;

    for (const row of rows) {
      scanned += 1;
      let hot: MailHotFields;
      try { hot = JSON.parse(row.hot_fields) as MailHotFields; } catch { continue; }

      const from_email = canonicalEmail(hot.from);
      if (from_email === null) continue;
      const to_emails = (Array.isArray(hot.to) ? hot.to : [])
        .map(canonicalEmail)
        .filter((e): e is string => e !== null);
      if (to_emails.length === 0) continue;

      // ⛔ The SAME function the CRM reconcilers stamp into
      // `meta.subject_hash`. Two normalisations here would mean the
      // fallback never matches — the defect this producer was blocked on.
      const subject_hash = engagementSubjectHash(
        typeof hot.subject === 'string' ? hot.subject : null,
      );
      // No subject ⇒ no fallback key, so the mail is skipped entirely.
      //
      // ⚠ THIS IS A DELIBERATE UNDER-REPORT, not a safety gate. A
      // subject-less outbound mail that the CRM genuinely never received IS
      // a visibility gap, and dropping it here means we never say so. The
      // alternative is worse: passing `null` through would make the kernel's
      // quadruple compare `null === undefined` on rows whose CRM meta also
      // lacks a subject, matching every subject-less mail against every
      // subject-less CRM row and SUPPRESSING real gaps at scale. Losing the
      // rare subject-less mail beats silently muting a whole class.
      if (subject_hash === null) continue;

      // `rfc_message_id` is the RFC822 header (already bracket-stripped by
      // `normalizeRfcMessageId` at ingest); `message_id` is the provider's
      // own source id and is NOT comparable to a CRM header. Prefer the
      // former and fall back to null rather than to the wrong identifier —
      // the kernel then relies on the quadruple, which is correct, whereas
      // a provider id would never match and reads as a gap.
      const message_id = typeof hot.rfc_message_id === 'string' && hot.rfc_message_id.length > 0
        ? hot.rfc_message_id
        : null;

      const mail: OutOfBandMailRow = {
        message_id,
        from_email,
        to_emails,
        subject_hash,
        // `received_at` is the closest thing `data.mail` carries to the
        // Date: header for a message the owner SENT.
        sent_at: row.received_at,
        vendor_modified_at: row.modified_at,
      };
      for (const recipient of to_emails) {
        const bucket = index.get(recipient);
        if (bucket) bucket.push(mail);
        else index.set(recipient, [mail]);
      }
    }
  }
  return index;
};

/** Per-contact deal-association confidence for ONE deal.
 *
 *  `deal_count` — distinct deals reachable from the contact's engagements.
 *  `primary_deal_last_activity_at` — freshest engagement carrying BOTH a
 *  contact edge to this email AND a deal edge to THIS deal.
 *
 *  Both walk `engagement_edges`, which `(target_kind, target_id, edge_type)`
 *  indexes. ⚠ Only `target_kind='data.contact'` contact edges participate:
 *  a Salesforce platform-id contact edge carries a vendor id, not an email,
 *  and joining on it would match nothing while looking like it should. */
export const buildContactConfidence = (
  db: Database.Database,
  input: { deal_target_id: string; contact_emails: ReadonlyArray<string> },
): ReadonlyMap<string, OutOfBandContactConfidence> => {
  const dealCountStmt = db.prepare(
    `SELECT COUNT(DISTINCT d.target_id) AS n
       FROM engagement_edges c
       JOIN engagement_edges d
         ON d.connection_id = c.connection_id
        AND d.engagement_target_id = c.engagement_target_id
        AND d.edge_type = 'deal'
        AND d.deleted_at IS NULL
      WHERE c.edge_type = 'contact'
        AND c.target_kind = 'data.contact'
        AND c.target_id = ?
        AND c.deleted_at IS NULL`,
  );
  const lastActivityStmt = db.prepare(
    `SELECT MAX(e.event_at) AS at
       FROM engagements e
       JOIN engagement_edges c
         ON c.connection_id = e.connection_id
        AND c.engagement_target_id = e.target_id
        AND c.edge_type = 'contact' AND c.target_kind = 'data.contact'
        AND c.target_id = ? AND c.deleted_at IS NULL
       JOIN engagement_edges d
         ON d.connection_id = e.connection_id
        AND d.engagement_target_id = e.target_id
        AND d.edge_type = 'deal' AND d.target_kind = 'connection.api'
        AND d.target_id = ? AND d.deleted_at IS NULL
      WHERE e.deleted_at IS NULL`,
  );

  const out = new Map<string, OutOfBandContactConfidence>();
  for (const raw of input.contact_emails) {
    const email = canonicalEmail(raw);
    if (email === null || out.has(email)) continue;
    const deal_count = (dealCountStmt.get(email) as { n: number } | undefined)?.n ?? 0;
    const at = (lastActivityStmt.get(email, input.deal_target_id) as { at: number | null } | undefined)?.at;
    out.set(email, {
      email,
      deal_count,
      primary_deal_last_activity_at: typeof at === 'number' ? at : 0,
    });
  }
  return out;
};
