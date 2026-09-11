/** D-139 P1a.1 — `engagement_silence_duration` deterministic producer.
 *
 *  Days since the last meaningful INBOUND engagement on a deal — the
 *  "nobody on their side has replied in N days" signal.
 *
 *  ⚠ This was the spec's designated P1a.1 CANARY ("single-source, no AI,
 *  the simplest possible producer"), and it is the only one of the twelve
 *  D-139 topics whose kernel was never written at all: registry entry,
 *  value schema, cascade coverage, a shipped alert recipe
 *  (`notify-engagement-silence-exceeded`) and a withdrawn producer recipe
 *  all existed around an empty middle.
 *
 *  Evidence-quality consumption defaults, matching its siblings:
 *    - direction: `'inbound'` ONLY. The whole signal is "have THEY gone
 *      quiet" — counting our own outbound would reset the clock every time
 *      a rep sent a follow-up, which inverts the meaning.
 *    - authorship: `'crm_automation'` + `'system_process'` excluded. A
 *      tracking-pixel open is not somebody replying. Same exclusion
 *      `last_meaningful_touch` applies, and for the same reason.
 *    - lifecycle_state: `'point_in_time'` + `'completed'` (the resolver
 *      default). A scheduled meeting has not happened yet.
 *    - `event_at: null` rows excluded — no event time, no clock to read.
 *
 *  Honest zero: no qualifying inbound yields `days: 0` +
 *  `last_inbound_event_at: 0`, and the coverage carried alongside says
 *  which sources were actually readable. ⚠ `days: 0` therefore means
 *  "silence not measurable from what we can see" as much as "they replied
 *  today"; the alert recipe's `greater` threshold treats both as
 *  not-firing, which is the safe direction. The two are distinguished by
 *  `last_inbound_event_at` (0 vs a real timestamp) and by coverage — which
 *  is exactly the pair § A.9.3 exists to provide.
 *
 *  Spec: D-139 § A.9.1. */

import type {
  Authorship,
  CoverageMetadata,
  Direction,
  EngagementRow,
  EngagementSilenceDurationValue,
} from '@recued/contracts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Authorship values that can constitute somebody actually engaging. */
export const SILENCE_ACCEPTED_AUTHORSHIP: ReadonlyArray<Authorship> = [
  'user',
  'crm_user',
  'integration',
  'import',
  'unknown',
];

/** Only inbound counts — see the header. */
export const SILENCE_ACCEPTED_DIRECTION: ReadonlyArray<Direction> = ['inbound'];

/** Lookback. Beyond a year the number stops being actionable and the row
 *  should read as "no recent inbound" rather than "inbound 500 days ago". */
export const SILENCE_WINDOW_MS = 365 * DAY_MS;

/** ⛔ READS THE SAME TWO CONSTANTS THE TASK SPEC HANDS THE RESOLVER.
 *
 *  The policy is declared ONCE. Previously this hardcoded
 *  `row.direction !== 'inbound'` while the spec passed
 *  `SILENCE_ACCEPTED_DIRECTION` — the same rule at two ends, which is the
 *  shape that drifts: widen one and the other silently keeps filtering.
 *
 *  ⚠ THIS is the enforcement point; the resolver-side filter is a query
 *  NARROWING that stops rows crossing from SQL only to be dropped here. A
 *  mutation deleting the spec's `direction` filter is therefore invisible
 *  to any outcome-level test, BY DESIGN — measured, not assumed: dropping
 *  it left all ten task tests green. Do not add a contrived test to
 *  manufacture a red; the guarantee lives here. */
export const isQualifyingInbound = (row: EngagementRow): boolean => {
  if (!SILENCE_ACCEPTED_DIRECTION.includes(row.direction)) return false;
  if (!SILENCE_ACCEPTED_AUTHORSHIP.includes(row.authorship)) return false;
  return typeof row.event_at === 'number' && row.event_at > 0;
};

export interface EngagementSilenceProducerInput {
  rows: ReadonlyArray<EngagementRow>;
  coverage: CoverageMetadata;
  now: number;
}

export interface EngagementSilenceProducerOutput {
  value: EngagementSilenceDurationValue;
  coverage: CoverageMetadata;
}

export const computeEngagementSilenceDuration = (
  input: EngagementSilenceProducerInput,
): EngagementSilenceProducerOutput => {
  let last_inbound_event_at = 0;
  let cursor_at = 0;

  for (const row of input.rows) {
    // The cursor folds EVERY row's vendor_modified_at, qualifying or not —
    // it records how far the producer has read, which is not the same
    // question as which rows counted.
    if (row.vendor_modified_at > cursor_at) cursor_at = row.vendor_modified_at;
    if (!isQualifyingInbound(row)) continue;
    const at = row.event_at as number;
    if (at > last_inbound_event_at) last_inbound_event_at = at;
  }

  // Clamp at zero: a vendor timestamp slightly ahead of our clock (clock
  // skew, a timezone-inferred event_at) must not produce negative days,
  // which the value schema rejects outright.
  const days =
    last_inbound_event_at === 0
      ? 0
      : Math.max(0, Math.floor((input.now - last_inbound_event_at) / DAY_MS));

  return {
    value: { days, last_inbound_event_at, cursor_at },
    coverage: input.coverage,
  };
};
