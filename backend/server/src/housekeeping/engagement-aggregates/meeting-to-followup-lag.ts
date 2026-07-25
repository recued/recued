/** D-139 P4 — `meeting_to_followup_lag` deterministic producer.
 *
 *  Deal-scoped slipping-deal signal. Reads engagement rows for the
 *  deal (CRM meetings + outbound rep touches) and computes the lag
 *  from the latest completed meeting → next outbound touch.
 *
 *  Pass-4 evidence-quality consumption defaults baked into the
 *  algorithm:
 *    - meeting source: `lifecycle_state = 'completed'` only
 *      (`'scheduled'` / `'cancelled'` / `'rescheduled'` excluded —
 *      the meeting hasn't happened or didn't happen);
 *      `direction = 'internal'` excluded (rep-internal sync isn't a
 *      deal meeting); `event_at IS NOT NULL` (meetings without an
 *      event_at haven't completed).
 *    - outbound source: `direction = 'outbound'` AND `authorship IN
 *      ('user', 'crm_user')` AND `lifecycle_state IN ('point_in_time',
 *      'completed')` — failed sends + no_answer calls + pending
 *      tasks are NOT follow-up evidence (the touch didn't happen);
 *      `event_at IS NOT NULL`.
 *    - dedupe_acceptance: `'exact_only'` — probable-twin pairs
 *      treated as separate evidence; producer over-counts rather
 *      than mis-merges.
 *
 *  Algorithm:
 *    1. Find the latest qualifying meeting (max `event_at` on rows
 *       satisfying the meeting filter).
 *    2. Find the earliest qualifying outbound after the meeting
 *       (min `event_at` on rows satisfying the outbound filter
 *       AND `event_at >= last_meeting_at`).
 *    3. Compute `lag_ms = next_outbound_at - last_meeting_at` (or
 *       `-1` when no follow-up landed yet).
 *    4. Bucket per `MEETING_FOLLOWUP_LAG_BUCKETS` thresholds.
 *
 *  Spec: D-139 § A.9.2b + § P4 acceptance. */

import {
  type CoverageMetadata,
  type EngagementRow,
  type MeetingFollowupLagBucket,
  type MeetingToFollowupLagValue,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** ≤ 24h → fast follow-up. */
export const MEETING_FOLLOWUP_FAST_MS = 24 * 60 * 60 * 1000;

/** ≤ 72h → normal cadence. */
export const MEETING_FOLLOWUP_NORMAL_MS = 72 * 60 * 60 * 1000;

/** ≤ 7d → long but not slipping. */
export const MEETING_FOLLOWUP_LONG_MS = 7 * 24 * 60 * 60 * 1000;

/** Closed list of CRM meeting entities — meetings only contribute
 *  the meeting half of the lag (the calendar half is folded by
 *  matching engagement_edges target_kind = 'data.calendar' upstream).
 *  Matches `EngagementEntity` shapes per D-139 § A.1 / § A.2. */
const MEETING_ENTITIES: ReadonlySet<string> = new Set(['meeting', 'event']);

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** True when the row qualifies as a deal-meeting per § A.9.2b. */
export const isQualifyingMeeting = (row: EngagementRow): boolean => {
  if (!MEETING_ENTITIES.has(row.entity)) return false;
  if (row.event_at === null) return false;
  if (row.lifecycle_state !== 'completed') return false;
  // Internal-only syncs don't count as deal meetings even when
  // logged on the deal — the rep didn't meet with the prospect.
  if (row.direction === 'internal') return false;
  return true;
};

/** True when the row qualifies as a rep follow-up touch per § A.9.2b.
 *  Outbound + user-driven + actually-happened. Calls + emails count;
 *  notes are not follow-ups (notes log retroactively); tasks count
 *  only when completed. */
export const isQualifyingFollowup = (row: EngagementRow): boolean => {
  if (row.event_at === null) return false;
  if (row.direction !== 'outbound') return false;
  if (row.authorship !== 'user' && row.authorship !== 'crm_user') return false;
  // Notes are descriptive logs — they're not active follow-up touches.
  if (row.entity === 'note') return false;
  // Pending / scheduled / cancelled / failed / no_answer aren't
  // a touch that happened. Only point_in_time + completed count.
  if (row.lifecycle_state !== 'point_in_time' && row.lifecycle_state !== 'completed') return false;
  return true;
};

/** Bucket the elapsed lag (ms) into the closed enum. */
export const decideMeetingFollowupBucket = (
  last_meeting_at: number,
  lag_ms: number,
): MeetingFollowupLagBucket => {
  if (last_meeting_at <= 0) return 'none';
  if (lag_ms < 0) return 'slipping'; // meeting found, no follow-up yet
  if (lag_ms <= MEETING_FOLLOWUP_FAST_MS) return 'fast';
  if (lag_ms <= MEETING_FOLLOWUP_NORMAL_MS) return 'normal';
  if (lag_ms <= MEETING_FOLLOWUP_LONG_MS) return 'long';
  return 'slipping';
};

// ────────────────────────────────────────────────────────────────
// Producer entry point
// ────────────────────────────────────────────────────────────────

export interface MeetingToFollowupLagProducerInput {
  /** Engagement rows already scoped to the deal via edge-walker
   *  (`engagement_edges` WHERE `edge_type='deal'` AND
   *  `target_id=...`). Both meetings + outbound touches are folded
   *  in one pass. */
  rows: ReadonlyArray<EngagementRow>;
  /** Caller-supplied coverage signals; pass through unchanged. */
  coverage: CoverageMetadata;
  /** Wall-clock now() in unix-ms UTC. */
  now: number;
}

export interface MeetingToFollowupLagProducerOutput {
  value: MeetingToFollowupLagValue;
  coverage: CoverageMetadata;
}

export const computeMeetingToFollowupLag = (
  input: MeetingToFollowupLagProducerInput,
): MeetingToFollowupLagProducerOutput => {
  let last_meeting_at = 0;
  let next_outbound_at = 0;
  let cursor_at = 0;

  // Pass 1 — find the freshest qualifying meeting.
  for (const row of input.rows) {
    if (row.vendor_modified_at > cursor_at) cursor_at = row.vendor_modified_at;
    if (!isQualifyingMeeting(row)) continue;
    if (row.event_at !== null && row.event_at > last_meeting_at) {
      last_meeting_at = row.event_at;
    }
  }

  // Pass 2 — find the earliest qualifying outbound STRICTLY AFTER
  // the meeting. Strict-after avoids the meeting itself getting
  // picked as its own follow-up (a completed outbound meeting
  // matches `isQualifyingFollowup`'s gate); a subsequent meeting
  // would still count as a valid follow-up since its event_at
  // would be > the original meeting's.
  if (last_meeting_at > 0) {
    for (const row of input.rows) {
      if (!isQualifyingFollowup(row)) continue;
      if (row.event_at === null) continue;
      if (row.event_at <= last_meeting_at) continue;
      if (next_outbound_at === 0 || row.event_at < next_outbound_at) {
        next_outbound_at = row.event_at;
      }
    }
  }

  const lag_ms = last_meeting_at > 0 && next_outbound_at > 0
    ? next_outbound_at - last_meeting_at
    : -1;
  const bucket = decideMeetingFollowupBucket(last_meeting_at, lag_ms);

  const value: MeetingToFollowupLagValue = {
    bucket,
    last_meeting_at,
    next_outbound_at,
    lag_ms,
    cursor_at,
  };

  return { value, coverage: input.coverage };
};
