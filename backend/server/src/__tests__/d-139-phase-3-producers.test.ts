/** D-139 Phase 3 — deterministic deal-level producer tests.
 *
 *  Pure-compute tests for the three new producers landed at P3:
 *    - `engagement_velocity_signal` (touches/week trajectory)
 *    - `inbound_outbound_ratio` (rep effort vs prospect engagement)
 *    - `last_meaningful_touch` (most recent substantive touch)
 *
 *  All tests build synthetic `EngagementRow` fixtures + assert the
 *  algorithm's evidence-quality consumption defaults baked in per
 *  Pass-4 contracts:
 *    - authorship: `'crm_automation'` + `'system_process'` weighted
 *      0.25 (velocity) / excluded (ratio + last-touch)
 *    - direction: `'internal'` excluded from velocity + ratio;
 *      last-touch direction-agnostic
 *    - lifecycle_state: `'point_in_time'` + `'completed'` count
 *      fully; `'no_answer'` calls count at 0.25 (velocity) /
 *      outbound-only (ratio); `'failed'` excluded (velocity) /
 *      outbound-only for HubSpot email send failures (ratio)
 *    - dedupe_acceptance: `'exact_only'` — `'probable'`-confidence
 *      pairs counted as separate touches (not collapsed)
 *    - event_at: `null` rows excluded (touch hasn't happened)
 *
 *  Spec: docs/d-139-spec.md § A.9.1 + § P3 acceptance. */

import { describe, expect, it } from 'vitest';

import {
  type Authorship,
  type CoverageMetadata,
  type DedupeConfidence,
  type Direction,
  type EngagementLifecycleState,
  type EngagementRow,
  type EngagementVendor,
} from '@recued/contracts';

import {
  computeEngagementVelocitySignal,
  decideVelocityTrajectory,
  velocityWeightForRow,
  VELOCITY_AUTOMATION_WEIGHT,
  VELOCITY_NO_ANSWER_WEIGHT,
} from '../housekeeping/engagement-aggregates/engagement-velocity-signal.js';
import {
  computeInboundOutboundRatio,
  decideInboundOutboundBucket,
  isInboundProspectEngagement,
  isOutboundRepEffort,
} from '../housekeeping/engagement-aggregates/inbound-outbound-ratio.js';
import {
  computeLastMeaningfulTouch,
  isMeaningfulTouch,
} from '../housekeeping/engagement-aggregates/last-meaningful-touch.js';

const FIXED_NOW = 1_714_867_200_000;
const day = 24 * 60 * 60 * 1000;

const EMPTY_COVERAGE: CoverageMetadata = {
  sources_connected: ['connection.api.hubspot.email'],
  sources_unavailable: [],
  sources_stale: [],
  sources_degraded: [],
  row_counts: {},
  last_source_event_at: 0,
};

const buildRow = (overrides: Partial<EngagementRow> = {}): EngagementRow => ({
  connection_id: 'acme-hubspot',
  target_id: 'hubspot_email_1',
  vendor: 'hubspot' as EngagementVendor,
  entity: 'email',
  meta: {},
  mirror_blob_hash: null,
  authorship: 'user' as Authorship,
  direction: 'outbound' as Direction,
  dedupe_confidence: 'none' as DedupeConfidence,
  lifecycle_state: 'point_in_time' as EngagementLifecycleState,
  event_at: FIXED_NOW - 1 * day,
  vendor_created_at: FIXED_NOW - 1 * day,
  vendor_modified_at: FIXED_NOW - 1 * day,
  ingested_at: FIXED_NOW - 1 * day,
  body_state: 'none',
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// engagement_velocity_signal
// ────────────────────────────────────────────────────────────────

describe('D-139 P3 — engagement_velocity_signal weight + bucket helpers', () => {
  it('point_in_time + user authorship + outbound direction → weight 1.0', () => {
    expect(velocityWeightForRow(buildRow())).toBe(1.0);
  });
  it('crm_automation authorship → weight 0.25', () => {
    expect(velocityWeightForRow(buildRow({ authorship: 'crm_automation' }))).toBe(VELOCITY_AUTOMATION_WEIGHT);
  });
  it('system_process authorship → weight 0.25', () => {
    expect(velocityWeightForRow(buildRow({ authorship: 'system_process' }))).toBe(VELOCITY_AUTOMATION_WEIGHT);
  });
  it('internal direction → weight 0 (excluded entirely)', () => {
    expect(velocityWeightForRow(buildRow({ direction: 'internal' }))).toBe(0);
  });
  it('no_answer call (lifecycle) → weight 0.25', () => {
    expect(velocityWeightForRow(buildRow({ lifecycle_state: 'no_answer' }))).toBe(VELOCITY_NO_ANSWER_WEIGHT);
  });
  it('failed lifecycle → weight 0 (excluded)', () => {
    expect(velocityWeightForRow(buildRow({ lifecycle_state: 'failed' }))).toBe(0);
  });
  it('cancelled lifecycle → weight 0', () => {
    expect(velocityWeightForRow(buildRow({ lifecycle_state: 'cancelled' }))).toBe(0);
  });
  it('pending lifecycle → weight 0', () => {
    expect(velocityWeightForRow(buildRow({ lifecycle_state: 'pending' }))).toBe(0);
  });
  it('completed lifecycle → weight 1.0', () => {
    expect(velocityWeightForRow(buildRow({ lifecycle_state: 'completed' }))).toBe(1.0);
  });

  it('decideVelocityTrajectory below MIN_SAMPLE → steady', () => {
    expect(decideVelocityTrajectory(0.5, 0.5)).toBe('steady');
  });
  it('decideVelocityTrajectory ratio ≥ 1.5 → accelerating', () => {
    expect(decideVelocityTrajectory(6, 4)).toBe('accelerating');
  });
  it('decideVelocityTrajectory ratio ≤ 0.5 → decaying', () => {
    expect(decideVelocityTrajectory(2, 6)).toBe('decaying');
  });
  it('decideVelocityTrajectory zero baseline + recent activity → accelerating', () => {
    expect(decideVelocityTrajectory(3, 0)).toBe('accelerating');
  });
});

describe('D-139 P3 — engagement_velocity_signal compute', () => {
  it('rep call recent + nothing baseline → accelerating (zero-baseline path)', () => {
    const rows: EngagementRow[] = [
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'hubspot_email_1' }),
      buildRow({ event_at: FIXED_NOW - 3 * day, target_id: 'hubspot_email_2' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'hubspot_email_3' }),
    ];
    const out = computeEngagementVelocitySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.weighted_recent).toBe(3);
    expect(out.value.weighted_baseline).toBe(0);
    expect(out.value.trajectory).toBe('accelerating');
    // Codex P2 #3 fold — cursor_at = max vendor_modified_at across folded rows
    // (default buildRow sets vendor_modified_at = FIXED_NOW - 1 * day).
    expect(out.value.cursor_at).toBe(FIXED_NOW - 1 * day);
  });

  it('balanced recent + baseline → steady', () => {
    const rows: EngagementRow[] = [];
    // 4 in recent (last 30d), 8 in baseline (30-90d) → 4 vs 8/2=4 → ratio=1.0 → steady
    for (let i = 0; i < 4; i++) {
      rows.push(buildRow({ event_at: FIXED_NOW - (i + 1) * day, target_id: `hubspot_email_r_${i}` }));
    }
    for (let i = 0; i < 8; i++) {
      rows.push(buildRow({ event_at: FIXED_NOW - (35 + i * 5) * day, target_id: `hubspot_email_b_${i}` }));
    }
    const out = computeEngagementVelocitySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.weighted_recent).toBe(4);
    expect(out.value.weighted_baseline).toBe(8);
    expect(out.value.trajectory).toBe('steady');
  });

  it('decaying — heavy baseline + sparse recent', () => {
    const rows: EngagementRow[] = [];
    // 2 recent + 12 baseline → 2 vs 12/2=6 → ratio=0.33 → decaying
    for (let i = 0; i < 2; i++) {
      rows.push(buildRow({ event_at: FIXED_NOW - (i + 1) * day, target_id: `hubspot_email_r_${i}` }));
    }
    for (let i = 0; i < 12; i++) {
      rows.push(buildRow({ event_at: FIXED_NOW - (35 + i * 4) * day, target_id: `hubspot_email_b_${i}` }));
    }
    const out = computeEngagementVelocitySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.trajectory).toBe('decaying');
  });

  it('Pass-5 R5.12 — system_process tracking-pixel rows weighted at 0.25', () => {
    const rows: EngagementRow[] = [
      buildRow({ event_at: FIXED_NOW - 2 * day, target_id: 'hubspot_email_1', authorship: 'crm_user' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'hubspot_email_2', authorship: 'system_process' }),
    ];
    const out = computeEngagementVelocitySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.weighted_recent).toBe(1.25); // 1.0 + 0.25
    expect(out.value.total_recent).toBe(2);
  });

  it('Pass-5 R5.12 — internal-only chatter excluded from external trajectory', () => {
    const rows: EngagementRow[] = [
      // 3 internal rep-to-rep emails (direction='internal') + 1 external inbound
      buildRow({ event_at: FIXED_NOW - 5 * day, direction: 'internal', target_id: 'hubspot_email_i1' }),
      buildRow({ event_at: FIXED_NOW - 4 * day, direction: 'internal', target_id: 'hubspot_email_i2' }),
      buildRow({ event_at: FIXED_NOW - 3 * day, direction: 'internal', target_id: 'hubspot_email_i3' }),
      buildRow({ event_at: FIXED_NOW - 2 * day, direction: 'inbound', target_id: 'hubspot_email_e1' }),
    ];
    const out = computeEngagementVelocitySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.weighted_recent).toBe(1); // only the external row
    expect(out.value.total_recent).toBe(1);
  });

  it('Pass-5 R5.12 — failed email send excluded from trajectory', () => {
    const rows: EngagementRow[] = [
      buildRow({ event_at: FIXED_NOW - 1 * day, lifecycle_state: 'failed', target_id: 'hubspot_email_failed' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, lifecycle_state: 'no_answer', target_id: 'hubspot_call_noanswer' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, lifecycle_state: 'point_in_time', target_id: 'hubspot_email_sent' }),
    ];
    const out = computeEngagementVelocitySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    // 'failed' excluded; 'no_answer' counts at 0.25; 'point_in_time' at 1.0
    expect(out.value.weighted_recent).toBe(1.25);
    expect(out.value.total_recent).toBe(2); // failed dropped before total
  });

  it('Pass-5 R5.12 — probable-confidence twins counted as separate touches (dedupe_acceptance: exact_only)', () => {
    // Same engagement seen as both HubSpot email + Salesforce email (probable triple match).
    // Producer's exact_only acceptance keeps both rows; trajectory math counts both.
    const rows: EngagementRow[] = [
      buildRow({
        event_at: FIXED_NOW - 1 * day,
        dedupe_confidence: 'probable',
        target_id: 'hubspot_email_1',
      }),
      buildRow({
        event_at: FIXED_NOW - 1 * day,
        dedupe_confidence: 'probable',
        target_id: 'salesforce_email_message_1',
        vendor: 'salesforce',
        entity: 'email_message',
      }),
    ];
    const out = computeEngagementVelocitySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.total_recent).toBe(2);
    expect(out.value.weighted_recent).toBe(2);
  });

  it('event_at = null rows excluded (touch hasn\'t happened — pending tasks, future meetings)', () => {
    const rows: EngagementRow[] = [
      buildRow({ event_at: null, lifecycle_state: 'pending', target_id: 'hubspot_task_1' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'hubspot_email_1' }),
    ];
    const out = computeEngagementVelocitySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.total_recent).toBe(1);
  });

  it('deterministic re-run — same inputs produce same output across iterations', () => {
    const rows: EngagementRow[] = [
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'hubspot_email_1' }),
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'hubspot_email_2' }),
      buildRow({ event_at: FIXED_NOW - 40 * day, target_id: 'hubspot_email_3' }),
    ];
    const a = computeEngagementVelocitySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    const b = computeEngagementVelocitySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    const c = computeEngagementVelocitySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(a.value).toEqual(b.value);
    expect(b.value).toEqual(c.value);
  });

  it('coverage passes through unchanged + carries quota_suspended degraded reason', () => {
    const cov: CoverageMetadata = {
      sources_connected: [],
      sources_unavailable: [],
      sources_stale: [],
      sources_degraded: [
        {
          source: 'connection.api.hubspot.email',
          reason: 'quota_suspended',
          since: FIXED_NOW - 60 * 60 * 1000,
        },
      ],
      row_counts: {},
      last_source_event_at: 0,
    };
    const out = computeEngagementVelocitySignal({ rows: [], coverage: cov, now: FIXED_NOW });
    expect(out.coverage.sources_degraded[0]?.reason).toBe('quota_suspended');
  });
});

// ────────────────────────────────────────────────────────────────
// inbound_outbound_ratio
// ────────────────────────────────────────────────────────────────

describe('D-139 P3 — inbound_outbound_ratio bucket + filter helpers', () => {
  it('bucket: outbound > 1.5 × inbound → rep_pushing', () => {
    expect(decideInboundOutboundBucket(2, 4)).toBe('rep_pushing');
  });
  it('bucket: inbound > 1.5 × outbound → prospect_pulling', () => {
    expect(decideInboundOutboundBucket(4, 2)).toBe('prospect_pulling');
  });
  it('bucket: balanced → mutual', () => {
    expect(decideInboundOutboundBucket(3, 4)).toBe('mutual');
  });
  it('bucket: both zero → mutual (silent deal — recipes gate on count > 0)', () => {
    expect(decideInboundOutboundBucket(0, 0)).toBe('mutual');
  });

  it('isInboundProspectEngagement: rep-sent inbound prospect email passes', () => {
    expect(isInboundProspectEngagement(buildRow({ direction: 'inbound', authorship: 'unknown' }), FIXED_NOW)).toBe(true);
  });
  it('isInboundProspectEngagement: outbound rep email rejected', () => {
    expect(isInboundProspectEngagement(buildRow({ direction: 'outbound' }), FIXED_NOW)).toBe(false);
  });
  it('isInboundProspectEngagement: inbound auto-reply (system_process) rejected', () => {
    expect(isInboundProspectEngagement(buildRow({ direction: 'inbound', authorship: 'system_process' }), FIXED_NOW)).toBe(false);
  });
  it('isInboundProspectEngagement: failed inbound (semantically vacuous) rejected', () => {
    expect(isInboundProspectEngagement(buildRow({ direction: 'inbound', lifecycle_state: 'failed' }), FIXED_NOW)).toBe(false);
  });
  it('isInboundProspectEngagement: outside 90d window excluded (Codex P2 #2 fold)', () => {
    expect(isInboundProspectEngagement(buildRow({ direction: 'inbound', authorship: 'unknown', event_at: FIXED_NOW - 100 * day }), FIXED_NOW)).toBe(false);
  });

  it('isOutboundRepEffort: user-authorship outbound passes', () => {
    expect(isOutboundRepEffort(buildRow({ direction: 'outbound', authorship: 'user' }), FIXED_NOW)).toBe(true);
  });
  it('isOutboundRepEffort: crm_user-authorship outbound passes', () => {
    expect(isOutboundRepEffort(buildRow({ direction: 'outbound', authorship: 'crm_user' }), FIXED_NOW)).toBe(true);
  });
  it('isOutboundRepEffort: workflow-automation outbound rejected (rep didn\'t drive it)', () => {
    expect(isOutboundRepEffort(buildRow({ direction: 'outbound', authorship: 'crm_automation' }), FIXED_NOW)).toBe(false);
  });
  it('Codex P1 #3 fold — no_answer counts only for CALL entities (rep dialed)', () => {
    // Outbound call with no_answer → counts.
    expect(isOutboundRepEffort(buildRow({ direction: 'outbound', authorship: 'crm_user', lifecycle_state: 'no_answer', entity: 'call' }), FIXED_NOW)).toBe(true);
    // Outbound voice_call with no_answer → counts (Salesforce VoiceCall).
    expect(isOutboundRepEffort(buildRow({ direction: 'outbound', authorship: 'user', lifecycle_state: 'no_answer', entity: 'voice_call' }), FIXED_NOW)).toBe(true);
    // Outbound email with no_answer → rejected (no-answer is call-only per § A.3.6).
    expect(isOutboundRepEffort(buildRow({ direction: 'outbound', authorship: 'user', lifecycle_state: 'no_answer', entity: 'email' }), FIXED_NOW)).toBe(false);
  });
  it('Codex P1 #3 fold — failed counts only for EMAIL entities (rep send aborted mid-pipeline)', () => {
    // Outbound email send failed → counts (rep clicked send).
    expect(isOutboundRepEffort(buildRow({ direction: 'outbound', authorship: 'user', lifecycle_state: 'failed', entity: 'email' }), FIXED_NOW)).toBe(true);
    // Outbound Salesforce email_message failed → counts.
    expect(isOutboundRepEffort(buildRow({ direction: 'outbound', authorship: 'user', lifecycle_state: 'failed', entity: 'email_message' }), FIXED_NOW)).toBe(true);
    // Outbound call failed → rejected (the call did not occur per § A.3.6).
    expect(isOutboundRepEffort(buildRow({ direction: 'outbound', authorship: 'user', lifecycle_state: 'failed', entity: 'call' }), FIXED_NOW)).toBe(false);
  });
  it('Codex P1 #3 fold — failed email with event_at=NULL still counts (vendor_modified_at is the effort timestamp)', () => {
    // HubSpot's hs_email_sent_on is NULL when send aborts pre-delivery; the
    // row carries vendor_modified_at from when ingest landed. Pre-fold the
    // event_at gate dropped the row even though it's real rep effort.
    expect(isOutboundRepEffort(buildRow({
      direction: 'outbound',
      authorship: 'user',
      lifecycle_state: 'failed',
      entity: 'email',
      event_at: null,
      vendor_modified_at: FIXED_NOW - 1 * day,
    }), FIXED_NOW)).toBe(true);
  });
  it('isOutboundRepEffort: cancelled outbound rejected', () => {
    expect(isOutboundRepEffort(buildRow({ direction: 'outbound', authorship: 'user', lifecycle_state: 'cancelled' }), FIXED_NOW)).toBe(false);
  });
  it('isOutboundRepEffort: internal direction rejected', () => {
    expect(isOutboundRepEffort(buildRow({ direction: 'internal', authorship: 'user' }), FIXED_NOW)).toBe(false);
  });
  it('isOutboundRepEffort: outside 90d window excluded (Codex P2 #2 fold)', () => {
    expect(isOutboundRepEffort(buildRow({ direction: 'outbound', authorship: 'user', event_at: FIXED_NOW - 100 * day }), FIXED_NOW)).toBe(false);
  });
});

describe('D-139 P3 — inbound_outbound_ratio compute', () => {
  it('Pass-5 R5.12 — auto-reply + workflow rows excluded from BOTH buckets', () => {
    const rows: EngagementRow[] = [
      // rep-sent email (user authorship, outbound) → outbound bucket
      buildRow({ direction: 'outbound', authorship: 'user', target_id: 'hubspot_email_1' }),
      // auto-reply bounce (system_process authorship, inbound) → excluded
      buildRow({ direction: 'inbound', authorship: 'system_process', target_id: 'hubspot_email_2' }),
      // HubSpot workflow-logged "Sequence enrolled" (crm_automation authorship, outbound) → excluded
      buildRow({ direction: 'outbound', authorship: 'crm_automation', target_id: 'hubspot_task_1' }),
    ];
    const out = computeInboundOutboundRatio({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.outbound_count).toBe(1);
    expect(out.value.inbound_count).toBe(0);
  });

  it('Pass-5 R5.12 — internal-only chatter excluded from both buckets', () => {
    const rows: EngagementRow[] = [
      buildRow({ direction: 'internal', authorship: 'user', target_id: 'hubspot_email_i1' }),
      buildRow({ direction: 'internal', authorship: 'crm_user', target_id: 'hubspot_email_i2' }),
      buildRow({ direction: 'inbound', authorship: 'crm_user', target_id: 'hubspot_email_e1' }),
    ];
    const out = computeInboundOutboundRatio({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.inbound_count).toBe(1);
    expect(out.value.outbound_count).toBe(0);
  });

  it('Pass-5 R5.12 — pending tasks excluded (lifecycle filter)', () => {
    const rows: EngagementRow[] = [
      // pending task — filtered
      buildRow({
        direction: 'outbound',
        authorship: 'user',
        lifecycle_state: 'pending',
        target_id: 'hubspot_task_1',
      }),
      // completed call — counted
      buildRow({
        direction: 'outbound',
        authorship: 'user',
        lifecycle_state: 'completed',
        target_id: 'hubspot_call_1',
        entity: 'call',
      }),
    ];
    const out = computeInboundOutboundRatio({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.outbound_count).toBe(1);
  });

  it('rep-pushing trajectory — high outbound + zero inbound → bucket = rep_pushing', () => {
    const rows: EngagementRow[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(buildRow({ direction: 'outbound', authorship: 'user', target_id: `hubspot_email_${i}` }));
    }
    const out = computeInboundOutboundRatio({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.bucket).toBe('rep_pushing');
    expect(out.value.outbound_count).toBe(6);
    expect(out.value.inbound_count).toBe(0);
    expect(out.value.ratio).toBe(6);
  });

  it('prospect-pulling — high inbound + sparse outbound', () => {
    const rows: EngagementRow[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(buildRow({ direction: 'inbound', authorship: 'unknown', target_id: `hubspot_email_in_${i}` }));
    }
    rows.push(buildRow({ direction: 'outbound', authorship: 'user', target_id: 'hubspot_email_out_1' }));
    const out = computeInboundOutboundRatio({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.bucket).toBe('prospect_pulling');
    expect(out.value.inbound_count).toBe(5);
    expect(out.value.outbound_count).toBe(1);
  });

  it('deterministic re-run', () => {
    const rows: EngagementRow[] = [
      buildRow({ direction: 'outbound', authorship: 'user', target_id: 'hubspot_email_1' }),
      buildRow({ direction: 'inbound', authorship: 'unknown', target_id: 'hubspot_email_2' }),
    ];
    const a = computeInboundOutboundRatio({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    const b = computeInboundOutboundRatio({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(a.value).toEqual(b.value);
  });

  it('coverage passes through with body_redacted reason intact', () => {
    const cov: CoverageMetadata = {
      sources_connected: [],
      sources_unavailable: [],
      sources_stale: [],
      sources_degraded: [
        {
          source: 'connection.api.hubspot.email.body_content',
          reason: 'body_redacted',
          since: FIXED_NOW - 60 * 60 * 1000,
        },
      ],
      row_counts: {},
      last_source_event_at: 0,
    };
    const out = computeInboundOutboundRatio({ rows: [], coverage: cov, now: FIXED_NOW });
    expect(out.coverage.sources_degraded[0]?.reason).toBe('body_redacted');
  });
});

// ────────────────────────────────────────────────────────────────
// last_meaningful_touch
// ────────────────────────────────────────────────────────────────

describe('D-139 P3 — last_meaningful_touch filter helper', () => {
  it('point_in_time + user authorship → meaningful', () => {
    expect(isMeaningfulTouch(buildRow())).toBe(true);
  });
  it('crm_automation authorship excluded', () => {
    expect(isMeaningfulTouch(buildRow({ authorship: 'crm_automation' }))).toBe(false);
  });
  it('system_process authorship excluded (tracking-pixel opens)', () => {
    expect(isMeaningfulTouch(buildRow({ authorship: 'system_process' }))).toBe(false);
  });
  it('pending lifecycle excluded', () => {
    expect(isMeaningfulTouch(buildRow({ lifecycle_state: 'pending' }))).toBe(false);
  });
  it('scheduled meeting excluded', () => {
    expect(isMeaningfulTouch(buildRow({ lifecycle_state: 'scheduled' }))).toBe(false);
  });
  it('cancelled excluded', () => {
    expect(isMeaningfulTouch(buildRow({ lifecycle_state: 'cancelled' }))).toBe(false);
  });
  it('no_answer call excluded (didn\'t connect)', () => {
    expect(isMeaningfulTouch(buildRow({ lifecycle_state: 'no_answer' }))).toBe(false);
  });
  it('failed send excluded', () => {
    expect(isMeaningfulTouch(buildRow({ lifecycle_state: 'failed' }))).toBe(false);
  });
  it('completed task qualifies', () => {
    expect(isMeaningfulTouch(buildRow({ lifecycle_state: 'completed', entity: 'task' }))).toBe(true);
  });
  it('event_at = null excluded', () => {
    expect(isMeaningfulTouch(buildRow({ event_at: null }))).toBe(false);
  });
  it('internal direction NOT excluded — direction-agnostic per § A.9.1', () => {
    expect(isMeaningfulTouch(buildRow({ direction: 'internal' }))).toBe(true);
  });
});

describe('D-139 P3 — last_meaningful_touch compute', () => {
  it('returns no-touch shape when no qualifying rows', () => {
    const out = computeLastMeaningfulTouch({ rows: [], coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.last_touch_at).toBe(0);
    expect(out.value.vendor).toBeNull();
    expect(out.value.entity).toBeNull();
    expect(out.value.authorship).toBeNull();
    expect(out.value.direction).toBeNull();
    // Codex P2 #3 fold — cursor_at = max vendor_modified_at; empty
    // input → 0 (no source rows folded yet).
    expect(out.value.cursor_at).toBe(0);
  });

  it('Pass-5 R5.12 — tracking-pixel rows do not reset the touch clock', () => {
    const rows: EngagementRow[] = [
      // rep-typed call (crm_user) at -3d — meaningful
      buildRow({
        event_at: FIXED_NOW - 3 * day,
        authorship: 'crm_user',
        entity: 'call',
        direction: 'outbound',
        target_id: 'hubspot_call_1',
      }),
      // HubSpot tracking-pixel "email opened" (system_process) at -1d — NOT meaningful
      buildRow({
        event_at: FIXED_NOW - 1 * day,
        authorship: 'system_process',
        entity: 'email',
        direction: 'inbound',
        target_id: 'hubspot_email_pixel',
      }),
    ];
    const out = computeLastMeaningfulTouch({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.last_touch_at).toBe(FIXED_NOW - 3 * day);
    expect(out.value.entity).toBe('call');
    expect(out.value.authorship).toBe('crm_user');
    expect(out.value.direction).toBe('outbound');
  });

  it('Pass-5 R5.12 — pending task does not count as last touch', () => {
    const rows: EngagementRow[] = [
      // completed call at -5d
      buildRow({
        event_at: FIXED_NOW - 5 * day,
        lifecycle_state: 'completed',
        entity: 'call',
        authorship: 'user',
        target_id: 'hubspot_call_1',
      }),
      // pending task at -1d (more recent but not evidence)
      buildRow({
        event_at: FIXED_NOW - 1 * day,
        lifecycle_state: 'pending',
        entity: 'task',
        authorship: 'user',
        target_id: 'hubspot_task_1',
      }),
    ];
    const out = computeLastMeaningfulTouch({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.last_touch_at).toBe(FIXED_NOW - 5 * day);
    expect(out.value.entity).toBe('call');
  });

  it('Pass-5 R5.12 — failed email send + no_answer call excluded', () => {
    const rows: EngagementRow[] = [
      // failed send at -1d
      buildRow({
        event_at: FIXED_NOW - 1 * day,
        lifecycle_state: 'failed',
        entity: 'email',
        authorship: 'user',
        target_id: 'hubspot_email_failed',
      }),
      // completed email at -3d (older but qualifying)
      buildRow({
        event_at: FIXED_NOW - 3 * day,
        lifecycle_state: 'point_in_time',
        entity: 'email',
        authorship: 'user',
        target_id: 'hubspot_email_sent',
      }),
    ];
    const out = computeLastMeaningfulTouch({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.last_touch_at).toBe(FIXED_NOW - 3 * day);
  });

  it('picks the freshest qualifying touch when multiple exist', () => {
    const rows: EngagementRow[] = [
      buildRow({ event_at: FIXED_NOW - 10 * day, target_id: 'hubspot_email_1' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'hubspot_email_2' }),
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'hubspot_email_3' }),
    ];
    const out = computeLastMeaningfulTouch({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.last_touch_at).toBe(FIXED_NOW - 1 * day);
  });

  it('Salesforce row → vendor=salesforce + entity preserved', () => {
    const rows: EngagementRow[] = [
      buildRow({
        event_at: FIXED_NOW - 1 * day,
        vendor: 'salesforce',
        entity: 'email_message',
        target_id: 'salesforce_email_message_001',
      }),
    ];
    const out = computeLastMeaningfulTouch({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.vendor).toBe('salesforce');
    expect(out.value.entity).toBe('email_message');
  });

  it('deterministic re-run', () => {
    const rows: EngagementRow[] = [
      buildRow({ event_at: FIXED_NOW - 5 * day, target_id: 'hubspot_email_1' }),
      buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'hubspot_email_2' }),
    ];
    const a = computeLastMeaningfulTouch({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    const b = computeLastMeaningfulTouch({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(a.value).toEqual(b.value);
  });

  it('coverage passes through with authorship_unknown reason', () => {
    const cov: CoverageMetadata = {
      sources_connected: ['connection.api.hubspot.email'],
      sources_unavailable: [],
      sources_stale: [],
      sources_degraded: [
        { source: 'connection.api.hubspot.email', reason: 'authorship_unknown', since: FIXED_NOW - 60 * 60 * 1000 },
      ],
      row_counts: {},
      last_source_event_at: 0,
    };
    const out = computeLastMeaningfulTouch({ rows: [], coverage: cov, now: FIXED_NOW });
    expect(out.coverage.sources_degraded[0]?.reason).toBe('authorship_unknown');
  });
});
