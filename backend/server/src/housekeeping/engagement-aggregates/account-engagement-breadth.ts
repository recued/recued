/** D-139 P4 — `account_engagement_breadth` deterministic producer.
 *
 *  Account-scoped multi-threading depth signal — distinct contacts
 *  at the account engaging in the recent 90d window, recency-
 *  weighted (30d half-life per contact's most-recent qualifying
 *  engagement). MEDDIC-flavored read.
 *
 *  Pass-4 evidence-quality consumption defaults baked into the
 *  algorithm:
 *    - direction `'internal'` excluded — rep-internal chatter
 *      doesn't indicate prospect engagement breadth.
 *    - lifecycle filter: `'point_in_time' | 'completed'` only —
 *      pending tasks + scheduled meetings + cancelled rows aren't
 *      breadth evidence.
 *    - authorship `'crm_automation'` + `'system_process'` excluded —
 *      workflow auto-logs + tracking pixels don't indicate
 *      prospect-side engagement.
 *    - dedupe_acceptance: `'exact_only'` — probable-twin pairs
 *      treated as separate evidence; producer over-counts (twin
 *      pair may represent the SAME prospect contact through
 *      different channels, but caller's per-contact identity
 *      grouping resolves this — see `contact_email` keying below).
 *
 *  Algorithm:
 *    1. Iterate engagement rows. For each qualifying row, look up
 *       its contact email via the per-row `contact_email` field
 *       (caller-resolved via engagement_edges + D-138 expansion).
 *    2. Track per-contact freshest qualifying engagement event_at.
 *    3. After folding all rows: compute distinct contact count +
 *       sum of per-contact recency weights (decay over 30d
 *       half-life from each contact's most-recent qualifying
 *       engagement).
 *    4. Bucket on distinct count.
 *
 *  Spec: D-139 § A.9.2b + § P4 acceptance. */

import {
  type AccountBreadthBucket,
  type AccountEngagementBreadthValue,
  type CoverageMetadata,
  type EngagementRow,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Recent window — 90d. Aligns with velocity / inbound-outbound
 *  windows so cross-topic recipes share the same horizon. */
export const ACCOUNT_BREADTH_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Per-contact recency half-life — 30d. A contact who engaged
 *  yesterday weighs ~1.0; 30d ago weighs 0.5; 60d ago weighs
 *  0.25. Tightens recency emphasis without dropping older contacts
 *  from the breadth count entirely (they still count toward
 *  `distinct_contacts`). */
export const ACCOUNT_BREADTH_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** Bucket cutoffs on `distinct_contacts`. */
export const ACCOUNT_BREADTH_DEVELOPING_THRESHOLD = 2;
export const ACCOUNT_BREADTH_MULTI_THREADED_THRESHOLD = 4;

// ────────────────────────────────────────────────────────────────
// Producer-supplied evidence shapes
// ────────────────────────────────────────────────────────────────

/** Producer input row. Pairs an `EngagementRow` with the contact
 *  email it edges to (substrate-side resolved via engagement_edges
 *  → D-138 identity expansion). The producer keys the breadth fold
 *  on this email; rows without a resolvable contact email are
 *  silently dropped (the engagement may be account-only, e.g.
 *  ContentDocumentLink without a primary contact). */
export interface AccountBreadthRow {
  row: EngagementRow;
  /** Canonical contact email (lowercased + trimmed). `null` when
   *  the engagement has no resolved contact edge. */
  contact_email: string | null;
}

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** True when the engagement row qualifies as account-breadth
 *  evidence per § A.9.2b. */
export const isQualifyingBreadthEvent = (row: EngagementRow): boolean => {
  if (row.event_at === null) return false;
  if (row.direction === 'internal') return false;
  if (row.authorship === 'crm_automation' || row.authorship === 'system_process') return false;
  if (row.lifecycle_state !== 'point_in_time' && row.lifecycle_state !== 'completed') return false;
  return true;
};

/** Decay weight from contact's freshest qualifying engagement.
 *  Half-life 30d; weight in (0, 1]. */
export const breadthRecencyWeight = (
  freshest_event_at: number,
  now: number,
): number => {
  if (freshest_event_at <= 0) return 0;
  const age_ms = Math.max(0, now - freshest_event_at);
  return Math.pow(0.5, age_ms / ACCOUNT_BREADTH_HALF_LIFE_MS);
};

/** Bucket the distinct contact count into the closed enum. */
export const decideBreadthBucket = (
  distinct_contacts: number,
): AccountBreadthBucket => {
  if (distinct_contacts <= 0) return 'silent';
  if (distinct_contacts < ACCOUNT_BREADTH_DEVELOPING_THRESHOLD) return 'narrow';
  if (distinct_contacts < ACCOUNT_BREADTH_MULTI_THREADED_THRESHOLD) return 'developing';
  return 'multi_threaded';
};

// ────────────────────────────────────────────────────────────────
// Producer entry point
// ────────────────────────────────────────────────────────────────

export interface AccountEngagementBreadthProducerInput {
  /** Engagement rows scoped to the account's contacts (via
   *  engagement_edges → contact → account-affiliation walk). Each
   *  row carries its resolved contact email (or `null` when the
   *  engagement has no resolvable contact). */
  rows: ReadonlyArray<AccountBreadthRow>;
  /** Caller-supplied coverage signals; pass through unchanged. */
  coverage: CoverageMetadata;
  /** Wall-clock now() in unix-ms UTC. */
  now: number;
}

export interface AccountEngagementBreadthProducerOutput {
  value: AccountEngagementBreadthValue;
  coverage: CoverageMetadata;
}

export const computeAccountEngagementBreadth = (
  input: AccountEngagementBreadthProducerInput,
): AccountEngagementBreadthProducerOutput => {
  const recent_cutoff = input.now - ACCOUNT_BREADTH_WINDOW_MS;
  const distinct_contact_set = new Set<string>();
  let recency_weighted_score = 0;
  let cursor_at = 0;

  // Codex P1 #3 fold — `recency_weighted_score` sums per-row
  // weights, not per-contact weights, so probable-twin pairs
  // contribute as 2 separate engagements per spec § P4 line 1508
  // ("test fixture with 1 mail-twin pair at probable confidence →
  // both rows count as 2 separate engagements in
  // `account_engagement_breadth` recency-weight math"). Pre-fold
  // the producer per-contact deduped via a freshest-per-contact
  // map, collapsing both twin rows to one weight; the spec's
  // exact_only acceptance contract demands over-count rather than
  // mis-merge. `distinct_contacts` remains a unique-by-canonical-
  // email count — the topic's named primitive is "distinct
  // contacts engaging at the account."
  for (const item of input.rows) {
    const row = item.row;
    if (row.vendor_modified_at > cursor_at) cursor_at = row.vendor_modified_at;
    if (item.contact_email === null) continue;
    if (!isQualifyingBreadthEvent(row)) continue;
    if (row.event_at === null) continue; // re-asserted for type narrowing
    if (row.event_at < recent_cutoff) continue;

    distinct_contact_set.add(item.contact_email);
    recency_weighted_score += breadthRecencyWeight(row.event_at, input.now);
  }

  const distinct_contacts = distinct_contact_set.size;
  const bucket = decideBreadthBucket(distinct_contacts);

  const value: AccountEngagementBreadthValue = {
    distinct_contacts,
    recency_weighted_score,
    bucket,
    cursor_at,
  };

  return { value, coverage: input.coverage };
};
