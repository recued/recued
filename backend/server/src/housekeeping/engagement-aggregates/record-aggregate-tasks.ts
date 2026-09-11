/** D-139 slice 3 — the six record-rooted aggregate tasks.
 *
 *  Each entry is DATA: which record root, how far back, which evidence
 *  counts, and the kernel. The walk / cap / cursor / upsert live once in
 *  `_record-aggregate-task.ts`.
 *
 *  Evidence-quality defaults are declared here rather than inside the
 *  kernels because they are a CONSUMPTION policy, not an algorithm: the
 *  same rows filtered differently answer different questions, and § A.3.2
 *  makes the filter part of each topic's contract.
 *
 *  ⚠ WHERE A KERNEL RE-APPLIES A FILTER INTERNALLY, THE KERNEL IS THE
 *  ENFORCEMENT POINT and the entry below is a query NARROWING — it stops
 *  rows crossing from SQL only to be dropped. Measured, not assumed:
 *  deleting `engagement_silence_duration`'s `direction` filter here left
 *  all ten end-to-end task tests green. Two consequences worth stating:
 *  a mutation of one of these fields can be invisible, and the pair must
 *  never become two spellings of one rule —
 *  `engagement-silence-duration.ts` reads the SAME exported constants this
 *  file passes, so widening the policy moves both ends at once.
 *
 *  Spec: D-139 § A.9.1 / § A.9.2b. */

import {
  enrichmentProducerAuthoredBy,
} from '../enrichment-producer.js';
import { buildRecordAggregateTask } from './_record-aggregate-task.js';
import {
  computeEngagementSilenceDuration,
  SILENCE_ACCEPTED_AUTHORSHIP,
  SILENCE_ACCEPTED_DIRECTION,
  SILENCE_WINDOW_MS,
} from './engagement-silence-duration.js';
import {
  computeEngagementVelocitySignal,
  VELOCITY_BASELINE_WINDOW_MS,
  VELOCITY_RECENT_WINDOW_MS,
} from './engagement-velocity-signal.js';
import {
  computeInboundOutboundRatio,
  INBOUND_OUTBOUND_WINDOW_MS,
} from './inbound-outbound-ratio.js';
import { computeLastMeaningfulTouch } from './last-meaningful-touch.js';
import {
  computeMeetingToFollowupLag,
  MEETING_FOLLOWUP_LONG_MS,
} from './meeting-to-followup-lag.js';
import {
  ACCOUNT_REENTRY_LOOKBACK_MS,
  computeAccountReentrySignal,
} from './account-reentry-signal.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** ── Deal-scoped ─────────────────────────────────────────────── */

export const engagementSilenceDurationTask = buildRecordAggregateTask({
  topic: 'engagement_silence_duration',
  crm_alias: 'deal',
  authored_by: enrichmentProducerAuthoredBy('engagement_silence_duration'),
  description:
    'Days since the last meaningful inbound engagement on a deal — the "have they gone quiet" signal. Deterministic; zero token cost.',
  window_ms: SILENCE_WINDOW_MS,
  authorship: SILENCE_ACCEPTED_AUTHORSHIP,
  direction: SILENCE_ACCEPTED_DIRECTION,
  compute: computeEngagementSilenceDuration,
});

export const engagementVelocitySignalTask = buildRecordAggregateTask({
  topic: 'engagement_velocity_signal',
  crm_alias: 'deal',
  authored_by: enrichmentProducerAuthoredBy('engagement_velocity_signal'),
  description:
    'Touches-per-week trajectory on a deal — accelerating / steady / decaying. Deterministic; zero token cost.',
  // Must span BOTH windows the kernel compares: it buckets rows into a
  // recent slice and a baseline slice behind it, so a `since` covering only
  // the recent window would leave the baseline permanently empty and every
  // deal would read as accelerating.
  window_ms: VELOCITY_RECENT_WINDOW_MS + VELOCITY_BASELINE_WINDOW_MS,
  // No authorship filter: the kernel deliberately INCLUDES automation and
  // system rows at a 0.25 weight (§ A.9.1) rather than dropping them, so
  // filtering them out at the resolver would silently change the algorithm.
  direction: ['inbound', 'outbound'],
  compute: computeEngagementVelocitySignal,
});

export const inboundOutboundRatioTask = buildRecordAggregateTask({
  topic: 'inbound_outbound_ratio',
  crm_alias: 'deal',
  authored_by: enrichmentProducerAuthoredBy('inbound_outbound_ratio'),
  description:
    'Rep effort vs prospect engagement on a deal — who is pushing. Deterministic; zero token cost.',
  window_ms: INBOUND_OUTBOUND_WINDOW_MS,
  // Internal chatter is excluded from external-trajectory math (§ A.9.1);
  // the kernel's own `isInbound/isOutbound` predicates agree.
  direction: ['inbound', 'outbound'],
  compute: computeInboundOutboundRatio,
});

export const lastMeaningfulTouchTask = buildRecordAggregateTask({
  topic: 'last_meaningful_touch',
  crm_alias: 'deal',
  authored_by: enrichmentProducerAuthoredBy('last_meaningful_touch'),
  description:
    'Most recent substantive engagement on a deal, filtered against tracking-pixel and workflow auto-logs. Deterministic; zero token cost.',
  window_ms: 365 * DAY_MS,
  // Automation + system_process excluded: a pixel open is not a touch.
  // ⚠ `'internal'` direction is intentionally NOT excluded here — a
  // teammate's note IS a meaningful touch from the deal's perspective,
  // which is where this topic deliberately differs from its two siblings
  // above (§ A.9.1, and the kernel header says so at length).
  authorship: ['user', 'crm_user', 'integration', 'import', 'unknown'],
  compute: computeLastMeaningfulTouch,
});

export const meetingToFollowupLagTask = buildRecordAggregateTask({
  topic: 'meeting_to_followup_lag',
  crm_alias: 'deal',
  authored_by: enrichmentProducerAuthoredBy('meeting_to_followup_lag'),
  description:
    'Time between a meeting on a deal and the next outbound follow-up — the slipping-deal signal. Deterministic; zero token cost.',
  // Needs room for a meeting AND the follow-up that answers it.
  window_ms: 4 * MEETING_FOLLOWUP_LONG_MS,
  compute: computeMeetingToFollowupLag,
});

/** ── Account-scoped ──────────────────────────────────────────── */

export const accountReentrySignalTask = buildRecordAggregateTask({
  topic: 'account_reentry_signal',
  crm_alias: 'account',
  authored_by: enrichmentProducerAuthoredBy('account_reentry_signal'),
  description:
    'A dormant account suddenly active again — the re-entry signal. Deterministic; zero token cost.',
  // The kernel compares a recent slice against a long dormancy lookback;
  // `since` must cover the lookback or dormancy can never be observed.
  window_ms: ACCOUNT_REENTRY_LOOKBACK_MS,
  compute: computeAccountReentrySignal,
});

/** Registration order = Settings → Housekeeping render order. */
export const RECORD_AGGREGATE_TASKS = [
  engagementSilenceDurationTask,
  engagementVelocitySignalTask,
  inboundOutboundRatioTask,
  lastMeaningfulTouchTask,
  meetingToFollowupLagTask,
  accountReentrySignalTask,
] as const;
