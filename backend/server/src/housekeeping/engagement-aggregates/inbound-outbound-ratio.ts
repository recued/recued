/** D-139 P3 — `inbound_outbound_ratio` deterministic producer.
 *
 *  Rep effort vs prospect engagement on a deal. Pure compute over
 *  `EngagementRow[]`; zero token cost.
 *
 *  Pass-4 evidence-quality consumption defaults baked into the
 *  algorithm (per § A.3.2 + § A.3.3 + § A.3.6 + § P3 acceptance):
 *    - Inbound bucket — counts only prospect-side meaningful
 *      engagement: `direction === 'inbound'` AND
 *      `authorship NOT IN ('crm_automation', 'system_process')` AND
 *      `lifecycle_state IN ('point_in_time', 'completed')`. Auto-
 *      replies (system_process inbounds) + workflow-logged inbound
 *      rows are excluded from BOTH buckets — they're neither rep
 *      effort nor prospect engagement.
 *    - Outbound bucket — counts only rep effort: `direction ===
 *      'outbound'` AND `authorship IN ('user', 'crm_user')` AND
 *      ENTITY-AWARE lifecycle gate per § A.3.6 + Codex P1 #3 fold:
 *        - `'point_in_time' | 'completed'` count for any entity.
 *        - `'no_answer'` counts for CALL entities only (rep dialed,
 *          no connection — the attempt is rep effort).
 *        - `'failed'` counts for EMAIL entities only (HubSpot email
 *          send failed — rep clicked send + the message hit the
 *          gateway error path). Failed CALLS are dial-attempt
 *          failures (per spec § A.3.6 the call "did not occur" so
 *          the row is NOT engagement evidence).
 *      `'crm_automation'` outbounds (workflow sequences) are
 *      excluded — the rep didn't drive them.
 *    - Direction `'internal'` excluded from both buckets always.
 *    - dedupe_acceptance: `'exact_only'` — caller surfaces
 *      `'probable'`-confidence twins as separate rows.
 *    - event_at: required for `'point_in_time' | 'completed'` rows
 *      (the touch must have happened); for `'failed'` email +
 *      `'no_answer'` call rows event_at MAY be null (HubSpot
 *      doesn't populate `hs_email_sent_on` when the send aborts
 *      mid-pipeline) — those rows count as effort regardless.
 *      Pre-Codex-P1-#3-fold this missed real rep effort.
 *    - 90d window cutoff applied per § A.9.1 (Codex P2 #2 fold) —
 *      registry's `aggregate_window_ms = 90d`. Rows with non-null
 *      event_at older than the cutoff are excluded; rows with null
 *      event_at fall back to vendor_modified_at as the effort
 *      timestamp so a stale workflow-logged failed send from 2y
 *      ago doesn't leak in.
 *
 *  Bucket math:
 *    ratio = outbound_count / max(inbound_count, 1)
 *    bucket:
 *      ratio > 1.5 → 'rep_pushing'      (rep talking, prospect quiet)
 *      ratio < 0.67 → 'prospect_pulling' (prospect-driven)
 *      otherwise   → 'mutual'           (balanced exchange)
 *
 *  When BOTH counts are zero (silent deal — could happen post-create
 *  before any engagement lands, or after pruning), bucket is `'mutual'`
 *  with `ratio = 0` — recipes gate on `inbound_count + outbound_count > 0`
 *  before treating the bucket as meaningful.
 *
 *  Spec: D-139 § A.9.1 + § A.3.2 (authorship filter) +
 *  § A.3.3 (direction filter) + § A.3.6 (lifecycle filter) +
 *  § P3 acceptance. */

import {
  type CoverageMetadata,
  type EngagementRow,
  type InboundOutboundBucket,
  type InboundOutboundRatioValue,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Bucket-cutoff ratios. `'rep_pushing'` when outbound > 1.5×
 *  inbound; `'prospect_pulling'` when inbound > 1.5× outbound
 *  (equivalently outbound < 0.667× inbound = 1/1.5). Symmetric
 *  threshold so the buckets are well-defined under inversion. */
export const INBOUND_OUTBOUND_REP_PUSHING_RATIO = 1.5;
export const INBOUND_OUTBOUND_PROSPECT_PULLING_RATIO = 1 / 1.5;

/** Codex P2 #2 fold — 90d full event-time window. Mirrors the
 *  registry's `aggregate_window_ms` declaration so producer
 *  behavior matches the substrate-side dependency annotation. */
export const INBOUND_OUTBOUND_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Codex P1 #3 fold — entity sets for the per-state lifecycle gate.
 *  HubSpot uses `'email'` / `'call'` etc.; Salesforce uses
 *  `'email_message'` / `'voice_call'` / `'call_history'`. Closed
 *  list captures both vendors' naming. */
const EMAIL_ENTITIES: ReadonlySet<string> = new Set([
  'email',          // HubSpot
  'email_message',  // Salesforce
]);
const CALL_ENTITIES: ReadonlySet<string> = new Set([
  'call',           // HubSpot
  'voice_call',     // Salesforce VoiceCall (Service Cloud Voice)
  'call_history',   // Salesforce CallHistory (legacy)
]);

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Window-eligibility predicate. Rows with non-null event_at must
 *  fall within the 90d window; rows with null event_at fall back to
 *  vendor_modified_at as the timing source (HubSpot failed email
 *  sends carry non-null modified_at when the send aborts before
 *  hs_email_sent_on populates). Rows with null event_at AND
 *  null/zero modified_at are excluded as a stale-data guard. */
const inWindow = (row: EngagementRow, now: number): boolean => {
  const cutoff = now - INBOUND_OUTBOUND_WINDOW_MS;
  if (row.event_at !== null) return row.event_at >= cutoff;
  if (row.vendor_modified_at > 0) return row.vendor_modified_at >= cutoff;
  return false;
};

/** Decide inbound bucket eligibility for a single row. */
export const isInboundProspectEngagement = (
  row: EngagementRow,
  now: number,
): boolean => {
  if (row.direction !== 'inbound') return false;
  if (row.authorship === 'crm_automation' || row.authorship === 'system_process') {
    return false;
  }
  // Inbound prospect engagement requires the touch to have actually
  // landed (point_in_time / completed). A `'failed'` inbound has no
  // semantic meaning (nothing to fail on the inbound side); a
  // `'no_answer'` inbound is similarly vacuous — buckets ignore both.
  if (row.lifecycle_state !== 'point_in_time' && row.lifecycle_state !== 'completed') {
    return false;
  }
  if (row.event_at === null) return false;
  if (!inWindow(row, now)) return false;
  return true;
};

/** Decide outbound bucket eligibility for a single row.
 *
 *  Codex P1 #3 fold: lifecycle gate is entity-aware. `'failed'`
 *  outbound counts for EMAIL only (rep send aborted mid-pipeline);
 *  `'no_answer'` outbound counts for CALL only (rep dialed, no
 *  connection). `'point_in_time' | 'completed'` count for any
 *  entity. Failed calls + no_answer emails are excluded (the call
 *  didn't happen / email never has a no-answer state). */
export const isOutboundRepEffort = (
  row: EngagementRow,
  now: number,
): boolean => {
  if (row.direction !== 'outbound') return false;
  if (row.authorship !== 'user' && row.authorship !== 'crm_user') return false;
  if (!inWindow(row, now)) return false;
  if (row.lifecycle_state === 'point_in_time' || row.lifecycle_state === 'completed') {
    if (row.event_at === null) return false;
    return true;
  }
  if (row.lifecycle_state === 'failed') {
    // Failed outbound counts for EMAIL only — rep clicked send +
    // the email pipeline aborted. Failed CALLS are dial-attempt
    // failures (the call didn't happen) — not rep effort per spec
    // § A.3.6.
    return EMAIL_ENTITIES.has(row.entity);
  }
  if (row.lifecycle_state === 'no_answer') {
    // No-answer counts for CALL only — rep dialed, no connect.
    // Email never has a no-answer lifecycle state.
    return CALL_ENTITIES.has(row.entity);
  }
  return false;
};

/** Bucket the inbound/outbound counts. */
export const decideInboundOutboundBucket = (
  inbound_count: number,
  outbound_count: number,
): InboundOutboundBucket => {
  const ratio = outbound_count / Math.max(inbound_count, 1);
  if (inbound_count === 0 && outbound_count === 0) return 'mutual';
  // Both gates compare against the same canonical 1.5×; the
  // symmetric form below avoids floating-point edge cases at the
  // exact 1.5 / 0.667 boundaries (which the closed-list test
  // explicitly checks).
  if (ratio > INBOUND_OUTBOUND_REP_PUSHING_RATIO) return 'rep_pushing';
  if (ratio < INBOUND_OUTBOUND_PROSPECT_PULLING_RATIO) return 'prospect_pulling';
  return 'mutual';
};

// ────────────────────────────────────────────────────────────────
// Producer entry point
// ────────────────────────────────────────────────────────────────

export interface InboundOutboundProducerInput {
  /** Engagement rows scoped to the deal via edge-walker. */
  rows: ReadonlyArray<EngagementRow>;
  /** Caller-supplied coverage signals. */
  coverage: CoverageMetadata;
  now: number;
}

export interface InboundOutboundProducerOutput {
  value: InboundOutboundRatioValue;
  coverage: CoverageMetadata;
}

/** Pure compute. Iterates the row set in one O(n) pass + folds the
 *  per-row max `vendor_modified_at` into `cursor_at` per Codex
 *  P2 #3 fold (cursor_at must reflect the producer's progress
 *  through source rows, not wall-clock now). */
export const computeInboundOutboundRatio = (
  input: InboundOutboundProducerInput,
): InboundOutboundProducerOutput => {
  let inbound_count = 0;
  let outbound_count = 0;
  let cursor_at = 0;
  for (const row of input.rows) {
    // Codex P2 #3 fold — track max vendor_modified_at across ALL
    // window-eligible rows (whether they pass the bucket filters or
    // not) so the cursor reflects the producer's read horizon, not
    // the bucket-passing subset.
    if (inWindow(row, input.now) && row.vendor_modified_at > cursor_at) {
      cursor_at = row.vendor_modified_at;
    }
    if (isInboundProspectEngagement(row, input.now)) inbound_count += 1;
    if (isOutboundRepEffort(row, input.now)) outbound_count += 1;
  }
  const ratio = outbound_count / Math.max(inbound_count, 1);
  const bucket = decideInboundOutboundBucket(inbound_count, outbound_count);
  const value: InboundOutboundRatioValue = {
    inbound_count,
    outbound_count,
    ratio,
    bucket,
    cursor_at,
  };
  return { value, coverage: input.coverage };
};
