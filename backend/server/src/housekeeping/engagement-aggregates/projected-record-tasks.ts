/** D-139 P4 — the three projected-input record aggregates.
 *
 *  The last three of the twelve D-139 topics. Each is DATA plus one
 *  `project` function; the walk, cap, cursor, upsert and failure accounting
 *  live once in `_record-projected-task.ts`, and the SQL lives once in
 *  `record-projections.ts`.
 *
 *  Spec: D-139 § A.9.2b. */

import { enrichmentProducerAuthoredBy } from '../enrichment-producer.js';
import { buildProjectedRecordTask } from './_record-projected-task.js';
import {
  ACCOUNT_BREADTH_WINDOW_MS,
  computeAccountEngagementBreadth,
} from './account-engagement-breadth.js';
import { computeChampionDealCount } from './champion-deal-count.js';
import { computeMultiAccountContact } from './multi-account-contact.js';
import {
  contactEmailFromMeta,
  emailDomain,
  projectAccountBreadthRows,
  projectChampionDealRows,
  projectCrmCompanyDomains,
} from './record-projections.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** ── Account-scoped ──────────────────────────────────────────── */

export const accountEngagementBreadthTask = buildProjectedRecordTask({
  topic: 'account_engagement_breadth',
  crm_alias: 'account',
  authored_by: enrichmentProducerAuthoredBy('account_engagement_breadth'),
  description:
    'How many distinct contacts are engaging at an account, recency-weighted — the multi-threading signal. Deterministic; zero token cost.',
  window_ms: ACCOUNT_BREADTH_WINDOW_MS,
  project: (ctx, { resolved, coverage, now }) => ({
    rows: projectAccountBreadthRows(ctx.db, resolved.engagements),
    coverage,
    now,
  }),
  compute: computeAccountEngagementBreadth,
});

/** ── Contact-scoped ──────────────────────────────────────────── */

export const championDealCountTask = buildProjectedRecordTask({
  topic: 'champion_deal_count',
  crm_alias: 'contact',
  authored_by: enrichmentProducerAuthoredBy('champion_deal_count'),
  description:
    'How many deals a contact touches, and their won/lost ratio — champions vs blockers across the book. Deterministic; zero token cost.',
  // The tally is over the contact's whole deal history, not a recent slice;
  // a champion is established by deals that CLOSED, which may be old.
  window_ms: 365 * DAY_MS,
  project: (ctx, { record, coverage, now }) => {
    // ⛔ The contact's EMAIL is the join key, not its platform target_id —
    // contact edges are keyed on the canonical email. A contact record whose
    // meta carries no email cannot be joined to anything, and computing over
    // the resulting empty edge set would emit "0 deals, no champion signal"
    // as a finding rather than as an absence.
    const email = contactEmailFromMeta(record.meta_json);
    if (email === null) return null;
    return { rows: projectChampionDealRows(ctx.db, email), coverage, now };
  },
  compute: computeChampionDealCount,
});

export const multiAccountContactTask = buildProjectedRecordTask({
  topic: 'multi_account_contact',
  crm_alias: 'contact',
  authored_by: enrichmentProducerAuthoredBy('multi_account_contact'),
  description:
    'A contact whose mail domain no longer matches any CRM account they are affiliated with — a likely job change. Deterministic; zero token cost.',
  window_ms: 365 * DAY_MS,
  project: (ctx, { record, resolved, coverage, now }) => {
    const email = contactEmailFromMeta(record.meta_json);
    if (email === null) return null;
    const { domains, latest_modified_at } = projectCrmCompanyDomains(ctx.db, email);
    // Freshest engagement the contact appears on — the mail-side half of the
    // cursor the kernel folds. Zero when they have none.
    let mail_vendor_modified_at = 0;
    for (const row of resolved.engagements) {
      if (row.vendor_modified_at > mail_vendor_modified_at) {
        mail_vendor_modified_at = row.vendor_modified_at;
      }
    }
    return {
      // ⚠ The contact's OWN domain. The kernel drops free-mail domains
      // itself (`isFreeMailDomain`) — a gmail.com contact is not evidence of
      // a job change, and pre-filtering here would hide that decision.
      mail_from_domain: emailDomain(email),
      crm_company_domains: domains,
      crm_vendor_modified_at: latest_modified_at,
      mail_vendor_modified_at,
      coverage,
      now,
    };
  },
  compute: computeMultiAccountContact,
});

/** Registration order = Settings → Housekeeping render order. */
export const PROJECTED_RECORD_TASKS = [
  accountEngagementBreadthTask,
  championDealCountTask,
  multiAccountContactTask,
] as const;
