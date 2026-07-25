/** D-184 Decision 2 — live CRM-email ↔ `data.mail` twin resolver.
 *
 *  Builds the `MailTwinResolver` hook the `data.contact.engagements`
 *  resolver calls at read time. Given the raw RFC822 Message-IDs of the
 *  email engagement rows on a page, it normalizes them (strip `<>` +
 *  trim — see `normalizeRfcMessageId`), batches a single membership
 *  lookup against `data.mail`'s `rfc_message_id` hot field, and returns
 *  a map from each ORIGINAL input id to the matched `data.mail`
 *  record_id.
 *
 *  Resolution is LIVE — the engagement resolver invokes this on every
 *  read — so adding or removing a mailbox is reflected without any
 *  re-ingest (D-184 Decision 2, Case 3). The engagement ingest stores
 *  only the CRM row + its `meta.message_id`; it never pre-binds a mail
 *  edge. When no mail collection is connected the resolver simply omits
 *  this hook (Case 2 — CRM-only). */

import type { CollectionTable } from '../table.js';
import type { MailTwinResolver } from '../../storage/engagement-store.js';
import { normalizeRfcMessageId } from './provider.js';

/** The `data.mail` hot field that carries the normalized RFC822
 *  Message-ID (written by `MailCollection`'s `buildRecord`). */
export const MAIL_RFC_MESSAGE_ID_HOT_FIELD = 'rfc_message_id';

/** Construct a `MailTwinResolver` over a `data.mail` collection table.
 *  Only the batched `findByHotFieldIn` primitive is needed. */
export const createMailTwinResolver = (
  mailTable: Pick<CollectionTable, 'findByHotFieldIn'>,
): MailTwinResolver => {
  return (messageIds) => {
    // Group raw inputs by their normalized form — several raw spellings
    // (angle-bracketed or bare, padded) can normalize to one Message-ID,
    // and the result map must be keyed by the caller's ORIGINAL string so
    // the resolver can look each row back up.
    const normalizedToRaw = new Map<string, string[]>();
    for (const raw of messageIds) {
      const norm = normalizeRfcMessageId(raw);
      if (norm === undefined) continue;
      const existing = normalizedToRaw.get(norm);
      if (existing) existing.push(raw);
      else normalizedToRaw.set(norm, [raw]);
    }
    const out = new Map<string, string>();
    if (normalizedToRaw.size === 0) return out;

    const records = mailTable.findByHotFieldIn(
      MAIL_RFC_MESSAGE_ID_HOT_FIELD,
      Array.from(normalizedToRaw.keys()),
    );
    // `findByHotFieldIn` orders `received_at DESC, record_id DESC`, so the
    // FIRST record seen per Message-ID wins deterministically when several
    // mail rows share one (e.g. Inbox + Sent copies).
    for (const rec of records) {
      const stored = (rec.hot_fields as { rfc_message_id?: unknown })
        .rfc_message_id;
      const norm =
        typeof stored === 'string' ? normalizeRfcMessageId(stored) : undefined;
      if (norm === undefined) continue;
      const raws = normalizedToRaw.get(norm);
      if (raws === undefined) continue;
      for (const raw of raws) {
        if (!out.has(raw)) out.set(raw, rec.record_id);
      }
    }
    return out;
  };
};
