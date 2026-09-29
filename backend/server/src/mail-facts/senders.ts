/**
 * D-315 §6.5 — Senders without a template: the senders the owner gets the most
 * mail from that no template and no standard reads, over the last 30 days.
 * This is how the long tail gets its templates: frequent senders become rules,
 * which are cheap and predictable.
 *
 *   - **Counted from the mail already stored, with no AI.** Each mailbox's
 *     stored mail in the window, grouped by sender.
 *   - **"No template and no standard reads"** is a sender none of whose emails
 *     in the window gave a fact. A sender with one read email is being read.
 *   - **Left out:** outbound mail and drafts (the account's own), mail Recued
 *     sent, the account's own address, and security notices (§9) — a sign-in
 *     code is never a template's to read.
 *   - **A dismissed sender stays dismissed** until the owner shows it again.
 *   - At most `SENDERS_SCAN_CAP` emails are read per call, newest first.
 */

import {
  isMailReconciliationId,
  MAIL_FACT_SENDERS_DAYS,
  type CollectionRecord,
  type MailFactSender,
  type MailFactSendersResult,
} from '@recued/contracts';

import type { MailCollection } from '../collections/mail/mail-collection.js';
import { materializeMailBody } from '../mail-body-read-handler.js';
import type { BlobStore } from '../storage/blob-store.js';
import type { MailFactStore } from '../storage/mail-fact-store.js';
import { looksLikeSecurityNoticeText } from './security-notice.js';
import { summaryOf } from './template-preview.js';

const DAY_MS = 86_400_000;
export const SENDERS_SCAN_CAP = 5_000;
const PAGE = 500;
const SUBJECTS_SHOWN = 3;

export interface SendersDeps {
  readonly mailboxes: () => readonly MailCollection[];
  readonly store: Pick<MailFactStore, 'emailsWithFactsSince' | 'dismissedSenders'>;
  readonly blobs: BlobStore;
  readonly now: () => number;
  readonly retentionDays?: (slug: string) => number | null;
}

const hotString = (record: CollectionRecord, key: string): string => {
  const value = record.hot_fields[key];
  return typeof value === 'string' ? value : '';
};

/** A subject with its numbers set aside, so "Order 123 shipped" and "Order 456
 *  shipped" count as one. */
const subjectKey = (subject: string): string => subject.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

interface Tally {
  count: number;
  read: boolean;
  newest: { mailbox: MailCollection; record: CollectionRecord } | null;
  subjects: Map<string, { count: number; newest: string; at: number }>;
}

export const listSendersWithoutTemplate = async (
  deps: SendersDeps,
  limit: number,
): Promise<MailFactSendersResult> => {
  const since = deps.now() - MAIL_FACT_SENDERS_DAYS * DAY_MS;
  const dismissed = deps.store.dismissedSenders();
  const skip = new Set(dismissed);
  const tallies = new Map<string, Tally>();
  let scanned = 0;

  for (const mailbox of deps.mailboxes()) {
    const own = mailbox.accountEmail.trim().toLowerCase();
    const withFacts = deps.store.emailsWithFactsSince(mailbox.slug, since);
    // Paged by date and id: a page ending inside emails of one date loses none.
    let before: { received_at: number; record_id: string } | undefined;
    while (scanned < SENDERS_SCAN_CAP) {
      const page = mailbox.list({
        platform: 'mail',
        slug: mailbox.slug,
        since,
        ...(before !== undefined ? { before } : {}),
        limit: PAGE,
      });
      for (const record of page) {
        if (scanned >= SENDERS_SCAN_CAP) break;
        scanned += 1;
        const direction = record.hot_fields.direction;
        if (direction === 'outbound' || direction === 'draft') continue;
        if (isMailReconciliationId(record.hot_fields.reconciliation_id)) continue;
        const address = hotString(record, 'from').trim().toLowerCase();
        if (address.length === 0 || address === own || skip.has(address)) continue;
        const tally = tallies.get(address) ?? { count: 0, read: false, newest: null, subjects: new Map() };
        tallies.set(address, tally);
        if (withFacts.has(record.record_id)) {
          tally.read = true;
          continue;
        }
        if (tally.read) continue;
        const subject = hotString(record, 'subject');
        const body = (await materializeMailBody(record, deps.blobs)) ?? '';
        if (looksLikeSecurityNoticeText(subject, body)) continue;
        tally.count += 1;
        if (tally.newest === null || record.received_at > tally.newest.record.received_at) {
          tally.newest = { mailbox, record };
        }
        const key = subjectKey(subject);
        const entry = tally.subjects.get(key) ?? { count: 0, newest: subject, at: record.received_at };
        entry.count += 1;
        if (record.received_at >= entry.at) {
          entry.newest = subject;
          entry.at = record.received_at;
        }
        tally.subjects.set(key, entry);
      }
      if (page.length < PAGE) break;
      const last = page[page.length - 1]!;
      before = { received_at: last.received_at, record_id: last.record_id };
    }
  }

  const senders: MailFactSender[] = [...tallies.entries()]
    .filter(([, tally]) => !tally.read && tally.count > 0 && tally.newest !== null)
    .sort(([, a], [, b]) => b.count - a.count || b.newest!.record.received_at - a.newest!.record.received_at)
    .slice(0, limit)
    .map(([address, tally]) => ({
      address,
      count: tally.count,
      subjects: [...tally.subjects.values()]
        .sort((a, b) => b.count - a.count || b.at - a.at)
        .slice(0, SUBJECTS_SHOWN)
        .map(({ newest, count }) => ({ subject: newest, count })),
      newest: summaryOf(deps, tally.newest!.mailbox.slug, tally.newest!.record),
    }));
  return { senders, dismissed, days: MAIL_FACT_SENDERS_DAYS, scanned };
};
