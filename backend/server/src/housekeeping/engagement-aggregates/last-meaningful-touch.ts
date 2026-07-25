/** D-139 P3 — `last_meaningful_touch` deterministic producer.
 *
 *  Most recent substantive engagement on a deal — filtered against
 *  tracking-pixel + workflow auto-logs. Pure compute over
 *  `EngagementRow[]`; zero token cost.
 *
 *  Pass-4 evidence-quality consumption defaults baked into the
 *  algorithm:
 *    - authorship: `'crm_automation'` + `'system_process'` excluded
 *      (tracking-pixel opens + workflow auto-logs are not
 *      "meaningful"). Everything else (user / crm_user / integration
 *      / import / unknown) counts.
 *    - lifecycle_state: `'point_in_time'` + `'completed'` only.
 *      Pending tasks, scheduled meetings, cancelled rows,
 *      `'no_answer'` calls, `'failed'` sends, `'rescheduled'` are
 *      activity records but NOT meaningful touches (the touch
 *      hasn't happened or didn't connect).
 *    - direction: any (a meaningful inbound or outbound counts —
 *      including `'internal'` because a teammate's note IS a
 *      meaningful touch from the deal's perspective; consumer
 *      decides whether internal counts via downstream filtering).
 *      Note: this differs from `engagement_velocity_signal` +
 *      `inbound_outbound_ratio` which exclude internal direction
 *      from external trajectory math; `last_meaningful_touch`'s
 *      job is "when was the last activity on this deal," not
 *      "external prospect engagement only."
 *    - dedupe_acceptance: `'exact_only'` — caller surfaces
 *      `'probable'`-confidence twins as separate rows; producer
 *      picks the freshest by `event_at` regardless.
 *    - event_at: `null` rows excluded (the touch hasn't happened —
 *      consistent with lifecycle filter above; redundant gate but
 *      explicit).
 *
 *  Output:
 *    - `last_touch_at = 0` + all-null fields when no qualifying
 *      touch found (deal exists but no meaningful engagement yet).
 *    - Otherwise carries the freshest qualifying row's
 *      `(event_at, vendor, entity, authorship, direction)` so
 *      consumers can reason about the touch's semantics without
 *      re-querying the engagement set.
 *
 *  Tie-break: when two rows share the same `event_at` (typical for
 *  same-second batch ingest), the iteration order picks the LAST
 *  match (caller is responsible for stable ordering — substrate
 *  resolver sorts by `(event_at DESC, connection_id ASC, target_id
 *  ASC)` per § A.5.1, so the producer sees stable-ordered input).
 *
 *  Spec: `docs/d-139-spec.md` § A.9.1 + § A.3.2 + § A.3.6 +
 *  § P3 acceptance. */

import {
  type Authorship,
  type CoverageMetadata,
  type Direction,
  type EngagementRow,
  type LastMeaningfulTouchValue,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Decide whether a row qualifies as a meaningful touch. */
export const isMeaningfulTouch = (row: EngagementRow): boolean => {
  if (row.event_at === null) return false;
  if (row.authorship === 'crm_automation' || row.authorship === 'system_process') {
    return false;
  }
  if (row.lifecycle_state !== 'point_in_time' && row.lifecycle_state !== 'completed') {
    return false;
  }
  return true;
};

// ────────────────────────────────────────────────────────────────
// Producer entry point
// ────────────────────────────────────────────────────────────────

export interface LastMeaningfulTouchProducerInput {
  /** Engagement rows scoped to the deal via edge-walker. */
  rows: ReadonlyArray<EngagementRow>;
  /** Caller-supplied coverage signals. */
  coverage: CoverageMetadata;
  now: number;
}

export interface LastMeaningfulTouchProducerOutput {
  value: LastMeaningfulTouchValue;
  coverage: CoverageMetadata;
}

/** Pure compute. Iterates the row set in one O(n) pass picking the
 *  freshest qualifying touch. Tracks max vendor_modified_at across
 *  ALL rows (not just qualifying ones) so the cursor reflects the
 *  producer's read horizon, not the qualifying-subset progress (per
 *  Codex P2 #3 fold). */
export const computeLastMeaningfulTouch = (
  input: LastMeaningfulTouchProducerInput,
): LastMeaningfulTouchProducerOutput => {
  let last_at = 0;
  let last_row: EngagementRow | null = null;
  let cursor_at = 0;
  for (const row of input.rows) {
    // Codex P2 #3 fold — fold every row into the cursor (regardless
    // of meaningful-touch eligibility) so the cursor matches the
    // producer's actual progress through source rows.
    if (row.vendor_modified_at > cursor_at) cursor_at = row.vendor_modified_at;
    if (!isMeaningfulTouch(row)) continue;
    // event_at is non-null after isMeaningfulTouch() short-circuits;
    // narrow the union with a non-null assertion via local copy.
    const at = row.event_at as number;
    if (at >= last_at) {
      last_at = at;
      last_row = row;
    }
  }
  let value: LastMeaningfulTouchValue;
  if (last_row === null || last_at === 0) {
    value = {
      last_touch_at: 0,
      vendor: null,
      entity: null,
      authorship: null,
      direction: null,
      cursor_at,
    };
  } else {
    value = {
      last_touch_at: last_at,
      vendor: last_row.vendor,
      entity: last_row.entity,
      authorship: last_row.authorship as Authorship,
      direction: last_row.direction as Direction,
      cursor_at,
    };
  }
  return { value, coverage: input.coverage };
};
