/** D-139 Phase 7 — Cross-vendor producer symmetry tests.
 *
 *  Asserts the deal-level deterministic producers are vendor-agnostic
 *  end-to-end at the compute layer — same `EngagementRow[]` shape from
 *  HubSpot vs Salesforce produces equivalent outputs. The producer
 *  takes per-vendor `EngagementRow` rows already edge-walked +
 *  scoped to a deal; the substrate's `engagement_edges` schema is
 *  the abstraction. The test fixture proves the producer's compute
 *  doesn't depend on `vendor`-discriminating branches.
 *
 *  Mixed-vendor row sets (HubSpot email + Salesforce email_message
 *  both contributing to one deal target) is the synthetic substrate
 *  proof — in production this case doesn't arise (deals stay
 *  platform-scoped per the Deal Identity Asymmetry Invariant § A.5.5)
 *  but the producer must still fold mixed rows symmetrically because
 *  it operates at one level below the platform-reference-id keying.
 *
 *  Spec: D-139 § P7 acceptance + § A.10 (cascade —
 *  producers iterate per-type scopes via `aggregates_from`). */

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

import { computeEngagementVelocitySignal } from '../housekeeping/engagement-aggregates/engagement-velocity-signal.js';
import { computeInboundOutboundRatio } from '../housekeeping/engagement-aggregates/inbound-outbound-ratio.js';
import { computeLastMeaningfulTouch } from '../housekeeping/engagement-aggregates/last-meaningful-touch.js';

const FIXED_NOW = 1_714_867_200_000;
const day = 24 * 60 * 60 * 1000;

/** Codex P3 #2 fold — factory replaces the previously-shared mutable
 *  `EMPTY_COVERAGE` constant so producer cases never share state
 *  through the coverage metadata object. Each call returns a fresh
 *  object the producer is free to read or extend without polluting
 *  sibling tests. */
const buildEmptyCoverage = (): CoverageMetadata => ({
  sources_connected: [],
  sources_unavailable: [],
  sources_stale: [],
  sources_degraded: [],
  row_counts: {},
  last_source_event_at: 0,
});

interface RowOverrides {
  vendor: EngagementVendor;
  entity: string;
  target_id: string;
  event_at_offset_days: number;
  authorship?: Authorship;
  direction?: Direction;
  lifecycle_state?: EngagementLifecycleState;
}

/** Build a vendor-symmetric engagement row. The fixture varies only
 *  the vendor / entity / target_id / event_at; every other field
 *  stays identical so the producer compute output depends solely on
 *  the per-row evidence-quality fields, NOT the vendor label. */
const buildRow = (overrides: RowOverrides): EngagementRow => {
  const event_at = FIXED_NOW - overrides.event_at_offset_days * day;
  return {
    connection_id: `${overrides.vendor}-canonical`,
    target_id: overrides.target_id,
    vendor: overrides.vendor,
    entity: overrides.entity,
    meta: {},
    mirror_blob_hash: null,
    authorship: overrides.authorship ?? ('user' as Authorship),
    direction: overrides.direction ?? ('outbound' as Direction),
    dedupe_confidence: 'none' as DedupeConfidence,
    lifecycle_state: overrides.lifecycle_state ?? ('point_in_time' as EngagementLifecycleState),
    event_at,
    vendor_created_at: event_at,
    vendor_modified_at: event_at,
    ingested_at: event_at,
    body_state: 'none',
  };
};

// ────────────────────────────────────────────────────────────────
// Vendor-symmetric input sets — same evidence-quality shape, vendor
// label varies. Producer output must be byte-equal across vendors.
// ────────────────────────────────────────────────────────────────

/** Codex P2 #3 fold — fixtures now cover all 10 per-type engagement
 *  scopes the contracts test pins (HubSpot `email|meeting|note|call|task`
 *  + Salesforce `task|event|email_message|voice_call|call_history`).
 *  Pre-fold the row sets only carried 6 of the 10 scopes (HubSpot
 *  dropped note + task; Salesforce dropped task + call_history),
 *  weakening the cross-vendor symmetry assertion against the full
 *  per-type surface. The 5+5 vendor-symmetric pair preserves trajectory
 *  math (each row contributes weight 1.0 — `point_in_time` /
 *  `completed` × `user` × `outbound`). */
const buildHubSpotOnlyRows = (): EngagementRow[] => [
  buildRow({ vendor: 'hubspot', entity: 'email',   target_id: 'hubspot_email_h1',   event_at_offset_days: 5 }),
  buildRow({ vendor: 'hubspot', entity: 'meeting', target_id: 'hubspot_meeting_h1', event_at_offset_days: 4 }),
  buildRow({ vendor: 'hubspot', entity: 'note',    target_id: 'hubspot_note_h1',    event_at_offset_days: 3 }),
  buildRow({ vendor: 'hubspot', entity: 'call',    target_id: 'hubspot_call_h1',    event_at_offset_days: 2, lifecycle_state: 'completed' }),
  buildRow({ vendor: 'hubspot', entity: 'task',    target_id: 'hubspot_task_h1',    event_at_offset_days: 1, lifecycle_state: 'completed' }),
];

const buildSalesforceOnlyRows = (): EngagementRow[] => [
  buildRow({ vendor: 'salesforce', entity: 'email_message', target_id: 'salesforce_email_message_s1', event_at_offset_days: 5 }),
  buildRow({ vendor: 'salesforce', entity: 'event',         target_id: 'salesforce_event_s1',         event_at_offset_days: 4 }),
  buildRow({ vendor: 'salesforce', entity: 'task',          target_id: 'salesforce_task_s1',          event_at_offset_days: 3, lifecycle_state: 'completed' }),
  buildRow({ vendor: 'salesforce', entity: 'voice_call',    target_id: 'salesforce_voice_call_s1',    event_at_offset_days: 2, lifecycle_state: 'completed' }),
  buildRow({ vendor: 'salesforce', entity: 'call_history',  target_id: 'salesforce_call_history_s1',  event_at_offset_days: 1, lifecycle_state: 'completed' }),
];

describe('D-139 P7 — engagement_velocity_signal cross-vendor symmetry', () => {
  it('HubSpot-only and Salesforce-only row sets produce equivalent trajectory output', () => {
    const hubOut = computeEngagementVelocitySignal({
      rows: buildHubSpotOnlyRows(),
      coverage: buildEmptyCoverage(),
      now: FIXED_NOW,
    });
    const sfOut = computeEngagementVelocitySignal({
      rows: buildSalesforceOnlyRows(),
      coverage: buildEmptyCoverage(),
      now: FIXED_NOW,
    });
    // Same trajectory bucket + weighted counts — vendor labels do
    // NOT influence the math, only the per-row evidence-quality
    // fields do.
    expect(hubOut.value.trajectory).toBe(sfOut.value.trajectory);
    expect(hubOut.value.weighted_recent).toBe(sfOut.value.weighted_recent);
    expect(hubOut.value.weighted_baseline).toBe(sfOut.value.weighted_baseline);
    expect(hubOut.value.total_recent).toBe(sfOut.value.total_recent);
    expect(hubOut.value.total_baseline).toBe(sfOut.value.total_baseline);
  });

  it('mixed-vendor row set folds symmetrically (substrate proof — production keeps deals vendor-scoped)', () => {
    // Substrate proof: the producer doesn't filter on vendor, so a
    // mixed-vendor row set folds the same way as if all rows came
    // from one vendor. Production-side, the engagement_edges
    // edge-walker only returns rows for ONE deal at a time (deals
    // stay vendor-scoped per § A.5.5); but the producer's
    // vendor-agnostic contract is what makes the cross-vendor
    // topic-layer union work — a future Linear / Pipedrive
    // engagement entity would fold through the same compute path
    // without producer changes.
    const mixedRows = [...buildHubSpotOnlyRows(), ...buildSalesforceOnlyRows()];
    const out = computeEngagementVelocitySignal({
      rows: mixedRows,
      coverage: buildEmptyCoverage(),
      now: FIXED_NOW,
    });
    // 10 rows total (5 HubSpot + 5 Salesforce per Codex P2 #3 fold) —
    // all in recent (≤ 5d) window — weighted at 1.0.
    expect(out.value.weighted_recent).toBe(10);
    expect(out.value.total_recent).toBe(10);
    expect(out.value.weighted_baseline).toBe(0);
  });

  it('producer code carries no vendor-discriminating branch', () => {
    // Symmetric assertion: swapping every row's vendor label should
    // produce byte-equal output (proving the compute's vendor-
    // agnosticism at runtime in addition to the static guarantee).
    const rows = buildHubSpotOnlyRows();
    const swapped = rows.map((r) => ({
      ...r,
      vendor: 'salesforce' as EngagementVendor,
      target_id: r.target_id.replace('hubspot_', 'salesforce_'),
      connection_id: r.connection_id.replace('hubspot', 'salesforce'),
    }));
    const out1 = computeEngagementVelocitySignal({ rows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    const out2 = computeEngagementVelocitySignal({ rows: swapped, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    expect(out1.value).toEqual(out2.value);
  });
});

describe('D-139 P7 — inbound_outbound_ratio cross-vendor symmetry', () => {
  it('HubSpot-only and Salesforce-only mixed direction sets produce equivalent ratios', () => {
    const hubRows = [
      buildRow({ vendor: 'hubspot', entity: 'email', target_id: 'hubspot_email_h1', event_at_offset_days: 5, direction: 'outbound', authorship: 'user' }),
      buildRow({ vendor: 'hubspot', entity: 'email', target_id: 'hubspot_email_h2', event_at_offset_days: 3, direction: 'outbound', authorship: 'user' }),
      buildRow({ vendor: 'hubspot', entity: 'email', target_id: 'hubspot_email_h3', event_at_offset_days: 1, direction: 'inbound',  authorship: 'unknown' }),
    ];
    const sfRows = [
      buildRow({ vendor: 'salesforce', entity: 'email_message', target_id: 'salesforce_email_message_s1', event_at_offset_days: 5, direction: 'outbound', authorship: 'user' }),
      buildRow({ vendor: 'salesforce', entity: 'email_message', target_id: 'salesforce_email_message_s2', event_at_offset_days: 3, direction: 'outbound', authorship: 'user' }),
      buildRow({ vendor: 'salesforce', entity: 'email_message', target_id: 'salesforce_email_message_s3', event_at_offset_days: 1, direction: 'inbound',  authorship: 'unknown' }),
    ];
    const hubOut = computeInboundOutboundRatio({ rows: hubRows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    const sfOut = computeInboundOutboundRatio({ rows: sfRows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    expect(hubOut.value.outbound_count).toBe(sfOut.value.outbound_count);
    expect(hubOut.value.inbound_count).toBe(sfOut.value.inbound_count);
    expect(hubOut.value.bucket).toBe(sfOut.value.bucket);
    expect(hubOut.value.ratio).toBe(sfOut.value.ratio);
  });

  it('Codex P3 #1 fold — failed email send counts as outbound effort symmetrically across vendors', () => {
    // Per `inbound-outbound-ratio.ts` lines 154-159: lifecycle_state =
    // 'failed' counts as outbound effort ONLY for EMAIL entities (the
    // rep clicked send + the email pipeline aborted; failed CALLs are
    // dial-attempt failures the spec counts differently). The
    // EMAIL_ENTITIES closed list contains BOTH 'email' (HubSpot) and
    // 'email_message' (Salesforce) — pre-fold the cross-vendor test
    // didn't exercise this entity-name branch, so a regression that
    // shrunk EMAIL_ENTITIES to one vendor would slip past P7.
    const hubRows = [
      buildRow({ vendor: 'hubspot', entity: 'email', target_id: 'hubspot_email_h1', event_at_offset_days: 1, direction: 'outbound', authorship: 'user', lifecycle_state: 'failed' }),
    ];
    const sfRows = [
      buildRow({ vendor: 'salesforce', entity: 'email_message', target_id: 'salesforce_email_message_s1', event_at_offset_days: 1, direction: 'outbound', authorship: 'user', lifecycle_state: 'failed' }),
    ];
    const hubOut = computeInboundOutboundRatio({ rows: hubRows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    const sfOut = computeInboundOutboundRatio({ rows: sfRows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    // Both vendors count the failed send as outbound (rep effort).
    expect(hubOut.value.outbound_count).toBe(1);
    expect(sfOut.value.outbound_count).toBe(1);
    expect(hubOut.value.outbound_count).toBe(sfOut.value.outbound_count);
  });

  it('Codex P3 #1 fold — no_answer call counts as outbound effort symmetrically across HubSpot call + Salesforce voice_call + call_history', () => {
    // CALL_ENTITIES closed list spans 'call' (HubSpot), 'voice_call'
    // (Salesforce VoiceCall — Service Cloud Voice), and
    // 'call_history' (Salesforce CallHistory — legacy). Pass-5 R5.11
    // dual-schema means a Salesforce org may register either
    // depending on the SObject probe; the P7 producer must treat
    // both Salesforce variants identically to HubSpot's 'call'.
    const hubRows = [
      buildRow({ vendor: 'hubspot', entity: 'call', target_id: 'hubspot_call_h1', event_at_offset_days: 1, direction: 'outbound', authorship: 'user', lifecycle_state: 'no_answer' }),
    ];
    const sfVoiceRows = [
      buildRow({ vendor: 'salesforce', entity: 'voice_call', target_id: 'salesforce_voice_call_s1', event_at_offset_days: 1, direction: 'outbound', authorship: 'user', lifecycle_state: 'no_answer' }),
    ];
    const sfHistoryRows = [
      buildRow({ vendor: 'salesforce', entity: 'call_history', target_id: 'salesforce_call_history_s1', event_at_offset_days: 1, direction: 'outbound', authorship: 'user', lifecycle_state: 'no_answer' }),
    ];
    const hubOut = computeInboundOutboundRatio({ rows: hubRows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    const sfVoiceOut = computeInboundOutboundRatio({ rows: sfVoiceRows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    const sfHistoryOut = computeInboundOutboundRatio({ rows: sfHistoryRows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    expect(hubOut.value.outbound_count).toBe(1);
    expect(sfVoiceOut.value.outbound_count).toBe(1);
    expect(sfHistoryOut.value.outbound_count).toBe(1);
  });

  it('Codex P3 #1 fold — failed call (dial-attempt failure) excluded from outbound effort symmetrically across vendors', () => {
    // The asymmetry the producer encodes: failed CALLs do NOT count
    // (the call did not occur — pre-dial pipeline failure). Same
    // exclusion applies regardless of vendor — HubSpot 'call',
    // Salesforce 'voice_call', Salesforce 'call_history'.
    const hubRows = [
      buildRow({ vendor: 'hubspot', entity: 'call', target_id: 'hubspot_call_h1', event_at_offset_days: 1, direction: 'outbound', authorship: 'user', lifecycle_state: 'failed' }),
    ];
    const sfVoiceRows = [
      buildRow({ vendor: 'salesforce', entity: 'voice_call', target_id: 'salesforce_voice_call_s1', event_at_offset_days: 1, direction: 'outbound', authorship: 'user', lifecycle_state: 'failed' }),
    ];
    const sfHistoryRows = [
      buildRow({ vendor: 'salesforce', entity: 'call_history', target_id: 'salesforce_call_history_s1', event_at_offset_days: 1, direction: 'outbound', authorship: 'user', lifecycle_state: 'failed' }),
    ];
    const hubOut = computeInboundOutboundRatio({ rows: hubRows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    const sfVoiceOut = computeInboundOutboundRatio({ rows: sfVoiceRows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    const sfHistoryOut = computeInboundOutboundRatio({ rows: sfHistoryRows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    expect(hubOut.value.outbound_count).toBe(0);
    expect(sfVoiceOut.value.outbound_count).toBe(0);
    expect(sfHistoryOut.value.outbound_count).toBe(0);
  });

  it('Codex P3 #1 fold — no_answer email rejected symmetrically (no-answer is call-only)', () => {
    // No_answer never applies to EMAIL entities (no notion of
    // dial-with-no-connect for email). The exclusion holds for both
    // HubSpot 'email' and Salesforce 'email_message'.
    const hubRows = [
      buildRow({ vendor: 'hubspot', entity: 'email', target_id: 'hubspot_email_h1', event_at_offset_days: 1, direction: 'outbound', authorship: 'user', lifecycle_state: 'no_answer' }),
    ];
    const sfRows = [
      buildRow({ vendor: 'salesforce', entity: 'email_message', target_id: 'salesforce_email_message_s1', event_at_offset_days: 1, direction: 'outbound', authorship: 'user', lifecycle_state: 'no_answer' }),
    ];
    const hubOut = computeInboundOutboundRatio({ rows: hubRows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    const sfOut = computeInboundOutboundRatio({ rows: sfRows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    expect(hubOut.value.outbound_count).toBe(0);
    expect(sfOut.value.outbound_count).toBe(0);
  });
});

/** Codex P2 #1 fold — `engagement_silence_duration` (P1a.1 canary) has
 *  no factored `computeEngagementSilenceDuration` function — the
 *  compute path lives inline in the canary integration test
 *  (`d-139-phase-1a1-1-engagement.test.ts` lines 1188-1208) walking
 *  the storage layer's `engagement_edges` + `engagements` tables and
 *  applying Pass-4 evidence-quality filters (`event_at IS NOT NULL`,
 *  `lifecycle_state = 'point_in_time'`, `direction = 'inbound'`,
 *  `authorship NOT IN ('crm_automation', 'system_process')`). For
 *  P7 substrate-completeness validation we exercise the same filter
 *  predicate as a pure function over `EngagementRow[]` so the
 *  vendor-symmetry assertion holds against the same producer logic
 *  the canary integration test runs against. Future D may factor
 *  this helper out into the `housekeeping/engagement-aggregates/`
 *  directory alongside the other P3 producers; until then, this
 *  in-test mirror keeps the cross-vendor invariant pinned.
 *
 *  Spec: D-139 § A.9.1 + § P1a.1 acceptance "deterministic +
 *  gates on event_at IS NOT NULL" + § P7 acceptance widening. */
const SILENCE_DURATION_DAY_MS = 24 * 60 * 60 * 1000;
const computeSilenceDurationLocal = (
  rows: ReadonlyArray<EngagementRow>,
  now: number,
): { days: number; last_inbound_event_at: number } => {
  let last_inbound_event_at = 0;
  for (const row of rows) {
    if (row.event_at === null) continue;
    if (row.lifecycle_state !== 'point_in_time') continue;
    if (row.direction !== 'inbound') continue;
    if (row.authorship === 'crm_automation' || row.authorship === 'system_process') continue;
    if (row.event_at > last_inbound_event_at) last_inbound_event_at = row.event_at;
  }
  const days =
    last_inbound_event_at > 0
      ? Math.floor((now - last_inbound_event_at) / SILENCE_DURATION_DAY_MS)
      : 0;
  return { days, last_inbound_event_at };
};

describe('D-139 P7 — engagement_silence_duration cross-vendor symmetry (Codex P2 #1 fold)', () => {
  it('HubSpot inbound emails and Salesforce inbound EmailMessage rows produce equivalent silence value', () => {
    const hubRows = [
      buildRow({ vendor: 'hubspot', entity: 'email', target_id: 'hubspot_email_h1', event_at_offset_days: 5, direction: 'inbound',  authorship: 'unknown' }),
      buildRow({ vendor: 'hubspot', entity: 'email', target_id: 'hubspot_email_h2', event_at_offset_days: 3, direction: 'inbound',  authorship: 'unknown' }),
      buildRow({ vendor: 'hubspot', entity: 'email', target_id: 'hubspot_email_h3', event_at_offset_days: 1, direction: 'inbound',  authorship: 'unknown' }),
    ];
    const sfRows = [
      buildRow({ vendor: 'salesforce', entity: 'email_message', target_id: 'salesforce_email_message_s1', event_at_offset_days: 5, direction: 'inbound',  authorship: 'unknown' }),
      buildRow({ vendor: 'salesforce', entity: 'email_message', target_id: 'salesforce_email_message_s2', event_at_offset_days: 3, direction: 'inbound',  authorship: 'unknown' }),
      buildRow({ vendor: 'salesforce', entity: 'email_message', target_id: 'salesforce_email_message_s3', event_at_offset_days: 1, direction: 'inbound',  authorship: 'unknown' }),
    ];
    const hubOut = computeSilenceDurationLocal(hubRows, FIXED_NOW);
    const sfOut = computeSilenceDurationLocal(sfRows, FIXED_NOW);
    expect(hubOut.days).toBe(sfOut.days);
    expect(hubOut.last_inbound_event_at).toBe(sfOut.last_inbound_event_at);
    // Both at 1 day silence (most-recent inbound is 1d before now).
    expect(hubOut.days).toBe(1);
  });

  it('automation + system_process inbound rows excluded symmetrically (filter holds across vendors)', () => {
    // Pre-fold: the silence_duration filter excludes
    // `'crm_automation'` + `'system_process'` authorship — an
    // auto-reply or tracking-pixel inbound doesn't reset the silence
    // clock. The exclusion must hold for BOTH vendors' inbound
    // rows; otherwise the canary's vendor-symmetry breaks.
    const hubRows = [
      buildRow({ vendor: 'hubspot', entity: 'email', target_id: 'hubspot_email_h1', event_at_offset_days: 5, direction: 'inbound', authorship: 'unknown' }),
      buildRow({ vendor: 'hubspot', entity: 'email', target_id: 'hubspot_email_auto', event_at_offset_days: 1, direction: 'inbound', authorship: 'system_process' }),
    ];
    const sfRows = [
      buildRow({ vendor: 'salesforce', entity: 'email_message', target_id: 'salesforce_email_message_s1',   event_at_offset_days: 5, direction: 'inbound', authorship: 'unknown' }),
      buildRow({ vendor: 'salesforce', entity: 'email_message', target_id: 'salesforce_email_message_auto', event_at_offset_days: 1, direction: 'inbound', authorship: 'system_process' }),
    ];
    const hubOut = computeSilenceDurationLocal(hubRows, FIXED_NOW);
    const sfOut = computeSilenceDurationLocal(sfRows, FIXED_NOW);
    // Both must skip the system_process row and land on the 5d-old
    // unknown-authorship inbound — symmetric exclusion.
    expect(hubOut.days).toBe(5);
    expect(sfOut.days).toBe(5);
    expect(hubOut.last_inbound_event_at).toBe(sfOut.last_inbound_event_at);
  });

  it('mixed-vendor inbound row set picks the most-recent qualifying inbound regardless of vendor', () => {
    const rows: EngagementRow[] = [
      buildRow({ vendor: 'hubspot',    entity: 'email',         target_id: 'hubspot_email_h1',           event_at_offset_days: 5, direction: 'inbound', authorship: 'unknown' }),
      buildRow({ vendor: 'salesforce', entity: 'email_message', target_id: 'salesforce_email_message_s1', event_at_offset_days: 1, direction: 'inbound', authorship: 'unknown' }),
    ];
    const out = computeSilenceDurationLocal(rows, FIXED_NOW);
    expect(out.days).toBe(1);
    expect(out.last_inbound_event_at).toBe(FIXED_NOW - 1 * day);
  });
});

describe('D-139 P7 — last_meaningful_touch cross-vendor symmetry', () => {
  it('most-recent meaningful touch surfaces correctly regardless of vendor source', () => {
    const hubRows = [
      buildRow({ vendor: 'hubspot', entity: 'email',   target_id: 'hubspot_email_h1',   event_at_offset_days: 7 }),
      buildRow({ vendor: 'hubspot', entity: 'meeting', target_id: 'hubspot_meeting_h1', event_at_offset_days: 1 }),
    ];
    const sfRows = [
      buildRow({ vendor: 'salesforce', entity: 'email_message', target_id: 'salesforce_email_message_s1', event_at_offset_days: 7 }),
      buildRow({ vendor: 'salesforce', entity: 'event',         target_id: 'salesforce_event_s1',         event_at_offset_days: 1 }),
    ];
    const hubOut = computeLastMeaningfulTouch({ rows: hubRows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    const sfOut = computeLastMeaningfulTouch({ rows: sfRows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    // Same recency: most-recent touch is 1 day before now in both.
    expect(hubOut.value.last_touch_at).toBe(sfOut.value.last_touch_at);
    // Vendor + entity differ — the per-touch projection IS
    // vendor-aware (the value records which vendor the touch came
    // from for downstream display) but the recency math doesn't
    // depend on vendor.
    expect(hubOut.value.vendor).toBe('hubspot');
    expect(hubOut.value.entity).toBe('meeting');
    expect(sfOut.value.vendor).toBe('salesforce');
    expect(sfOut.value.entity).toBe('event');
  });

  it('mixed-vendor row set picks the most-recent touch regardless of vendor', () => {
    const rows: EngagementRow[] = [
      buildRow({ vendor: 'hubspot',    entity: 'email',         target_id: 'hubspot_email_h1',           event_at_offset_days: 7 }),
      buildRow({ vendor: 'salesforce', entity: 'email_message', target_id: 'salesforce_email_message_s1', event_at_offset_days: 1 }),
    ];
    const out = computeLastMeaningfulTouch({ rows, coverage: buildEmptyCoverage(), now: FIXED_NOW });
    expect(out.value.last_touch_at).toBe(FIXED_NOW - 1 * day);
    expect(out.value.vendor).toBe('salesforce');
    expect(out.value.entity).toBe('email_message');
  });
});
