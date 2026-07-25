/** D-139 Phase 4 — cross-entity producer tests.
 *
 *  Pure-compute tests for the six new cross-entity producers:
 *    - meeting_to_followup_lag (calendar × CRM × mail)
 *    - out_of_band_engagement (mail × CRM)
 *    - account_engagement_breadth (account multi-threading)
 *    - account_reentry_signal (dormant → active)
 *    - champion_deal_count (contact across deals)
 *    - multi_account_contact (mail domain ≠ CRM company)
 *
 *  All tests build synthetic fixtures + assert algorithm correctness
 *  + Pass-4 evidence-quality consumption defaults baked in:
 *    - direction `'internal'` excluded from external-engagement
 *      producers (breadth + reentry + meeting/follow-up).
 *    - lifecycle filter: `'point_in_time' | 'completed'` only;
 *      pending/scheduled/cancelled/failed/no_answer rows excluded
 *      (lag/follow-up/breadth/reentry).
 *    - authorship `'crm_automation'` + `'system_process'` excluded
 *      (breadth/reentry); allowed but caller-classified for
 *      meeting_to_followup_lag's outbound side (only user/crm_user
 *      rep effort counts).
 *    - dedupe_acceptance: `'exact_only'` — probable-twin pairs
 *      treated as separate evidence; never collapsed (would
 *      mis-merge).
 *
 *  out_of_band_engagement-specific:
 *    - Message-ID match preferred → no out-of-band entry.
 *    - Quadruple fallback (from + first-recipient + sent_at±5m +
 *      subject_hash) → matched + no out-of-band entry.
 *    - Grace window OUT_OF_BAND_GRACE_MINUTES = 30: mail < 30m old
 *      not yet flagged.
 *    - Confidence gate: single-deal contact OR primary-deal
 *      activity in last 14d → gate passes; else fail-closed.
 *
 *  Spec: docs/d-139-spec.md § A.9.2b + § P4 acceptance. */

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
  computeMeetingToFollowupLag,
  decideMeetingFollowupBucket,
  isQualifyingFollowup,
  isQualifyingMeeting,
  MEETING_FOLLOWUP_FAST_MS,
  MEETING_FOLLOWUP_LONG_MS,
  MEETING_FOLLOWUP_NORMAL_MS,
} from '../housekeeping/engagement-aggregates/meeting-to-followup-lag.js';
import {
  buildCrmMessageIdIndex,
  computeOutOfBandEngagement,
  matchesCrmQuadruple,
  OUT_OF_BAND_GRACE_MS,
  OUT_OF_BAND_PRIMARY_DEAL_RECENCY_MS,
  passesConfidenceGate,
  type OutOfBandContactConfidence,
  type OutOfBandMailRow,
} from '../housekeeping/engagement-aggregates/out-of-band-engagement.js';
import {
  ACCOUNT_BREADTH_HALF_LIFE_MS,
  breadthRecencyWeight,
  computeAccountEngagementBreadth,
  decideBreadthBucket,
  isQualifyingBreadthEvent,
  type AccountBreadthRow,
} from '../housekeeping/engagement-aggregates/account-engagement-breadth.js';
import {
  ACCOUNT_DORMANCY_MS,
  ACCOUNT_REENTRY_RECENT_MS,
  computeAccountReentrySignal,
  isQualifyingAccountEvent,
} from '../housekeeping/engagement-aggregates/account-reentry-signal.js';
import {
  computeChampionDealCount,
  decideChampionBucket,
  type ChampionDealRow,
} from '../housekeeping/engagement-aggregates/champion-deal-count.js';
import {
  canonicaliseDomain,
  computeMultiAccountContact,
  isFreeMailDomain,
} from '../housekeeping/engagement-aggregates/multi-account-contact.js';

const FIXED_NOW = 1_714_867_200_000;
const day = 24 * 60 * 60 * 1000;
const minute = 60 * 1000;

const EMPTY_COVERAGE: CoverageMetadata = {
  sources_connected: [],
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

// ════════════════════════════════════════════════════════════════
// meeting_to_followup_lag
// ════════════════════════════════════════════════════════════════

describe('D-139 P4 — meeting_to_followup_lag filter helpers', () => {
  it('isQualifyingMeeting: completed external meeting → true', () => {
    expect(isQualifyingMeeting(buildRow({
      entity: 'meeting',
      lifecycle_state: 'completed',
      direction: 'outbound',
      event_at: FIXED_NOW - 2 * day,
    }))).toBe(true);
  });
  it('isQualifyingMeeting: scheduled meeting → false (not happened yet)', () => {
    expect(isQualifyingMeeting(buildRow({
      entity: 'meeting',
      lifecycle_state: 'scheduled',
      event_at: null,
    }))).toBe(false);
  });
  it('isQualifyingMeeting: cancelled meeting → false', () => {
    expect(isQualifyingMeeting(buildRow({
      entity: 'meeting',
      lifecycle_state: 'cancelled',
      event_at: FIXED_NOW - 2 * day,
    }))).toBe(false);
  });
  it('isQualifyingMeeting: internal direction → false (rep-internal sync)', () => {
    expect(isQualifyingMeeting(buildRow({
      entity: 'meeting',
      lifecycle_state: 'completed',
      direction: 'internal',
      event_at: FIXED_NOW - 2 * day,
    }))).toBe(false);
  });
  it('isQualifyingMeeting: email entity → false (only meeting/event)', () => {
    expect(isQualifyingMeeting(buildRow({
      entity: 'email',
      lifecycle_state: 'completed',
      event_at: FIXED_NOW - 2 * day,
    }))).toBe(false);
  });
  it('isQualifyingMeeting: Salesforce event entity → true', () => {
    expect(isQualifyingMeeting(buildRow({
      vendor: 'salesforce',
      entity: 'event',
      lifecycle_state: 'completed',
      event_at: FIXED_NOW - 2 * day,
    }))).toBe(true);
  });

  it('isQualifyingFollowup: outbound user email completed → true', () => {
    expect(isQualifyingFollowup(buildRow({
      entity: 'email',
      direction: 'outbound',
      authorship: 'user',
      lifecycle_state: 'point_in_time',
    }))).toBe(true);
  });
  it('isQualifyingFollowup: outbound automation email rejected (not rep effort)', () => {
    expect(isQualifyingFollowup(buildRow({
      entity: 'email',
      direction: 'outbound',
      authorship: 'crm_automation',
    }))).toBe(false);
  });
  it('isQualifyingFollowup: failed email send rejected (didn\'t happen)', () => {
    expect(isQualifyingFollowup(buildRow({
      entity: 'email',
      direction: 'outbound',
      authorship: 'user',
      lifecycle_state: 'failed',
    }))).toBe(false);
  });
  it('isQualifyingFollowup: no_answer call rejected (didn\'t connect)', () => {
    expect(isQualifyingFollowup(buildRow({
      entity: 'call',
      direction: 'outbound',
      authorship: 'user',
      lifecycle_state: 'no_answer',
    }))).toBe(false);
  });
  it('isQualifyingFollowup: note rejected (descriptive, not active touch)', () => {
    expect(isQualifyingFollowup(buildRow({
      entity: 'note',
      direction: 'outbound',
      authorship: 'user',
    }))).toBe(false);
  });
  it('isQualifyingFollowup: inbound rejected (only outbound counts as follow-up)', () => {
    expect(isQualifyingFollowup(buildRow({
      direction: 'inbound',
      authorship: 'user',
    }))).toBe(false);
  });

  it('decideMeetingFollowupBucket: no meeting → none', () => {
    expect(decideMeetingFollowupBucket(0, -1)).toBe('none');
  });
  it('decideMeetingFollowupBucket: meeting + no follow-up → slipping', () => {
    expect(decideMeetingFollowupBucket(FIXED_NOW, -1)).toBe('slipping');
  });
  it('decideMeetingFollowupBucket: ≤ 24h → fast', () => {
    expect(decideMeetingFollowupBucket(FIXED_NOW, MEETING_FOLLOWUP_FAST_MS - 1)).toBe('fast');
  });
  it('decideMeetingFollowupBucket: ≤ 72h → normal', () => {
    expect(decideMeetingFollowupBucket(FIXED_NOW, MEETING_FOLLOWUP_NORMAL_MS - 1)).toBe('normal');
  });
  it('decideMeetingFollowupBucket: ≤ 7d → long', () => {
    expect(decideMeetingFollowupBucket(FIXED_NOW, MEETING_FOLLOWUP_LONG_MS - 1)).toBe('long');
  });
  it('decideMeetingFollowupBucket: > 7d → slipping', () => {
    expect(decideMeetingFollowupBucket(FIXED_NOW, MEETING_FOLLOWUP_LONG_MS + 1)).toBe('slipping');
  });
});

describe('D-139 P4 — meeting_to_followup_lag compute', () => {
  it('no meetings → bucket=none, lag_ms=-1', () => {
    const out = computeMeetingToFollowupLag({
      rows: [buildRow({ entity: 'email', authorship: 'user', direction: 'outbound' })],
      coverage: EMPTY_COVERAGE,
      now: FIXED_NOW,
    });
    expect(out.value.bucket).toBe('none');
    expect(out.value.last_meeting_at).toBe(0);
    expect(out.value.lag_ms).toBe(-1);
  });

  it('meeting + outbound 2h later → bucket=fast', () => {
    const meetingAt = FIXED_NOW - 5 * day;
    const followupAt = meetingAt + 2 * 60 * 60 * 1000;
    const rows: EngagementRow[] = [
      buildRow({
        target_id: 'm1', entity: 'meeting', lifecycle_state: 'completed',
        direction: 'outbound', event_at: meetingAt, vendor_modified_at: meetingAt,
      }),
      buildRow({
        target_id: 'e1', entity: 'email', direction: 'outbound', authorship: 'user',
        lifecycle_state: 'point_in_time', event_at: followupAt, vendor_modified_at: followupAt,
      }),
    ];
    const out = computeMeetingToFollowupLag({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.last_meeting_at).toBe(meetingAt);
    expect(out.value.next_outbound_at).toBe(followupAt);
    expect(out.value.lag_ms).toBe(2 * 60 * 60 * 1000);
    expect(out.value.bucket).toBe('fast');
  });

  it('meeting + no follow-up → bucket=slipping, lag_ms=-1', () => {
    const meetingAt = FIXED_NOW - 3 * day;
    const rows: EngagementRow[] = [
      buildRow({
        target_id: 'm1', entity: 'meeting', lifecycle_state: 'completed',
        direction: 'outbound', event_at: meetingAt,
      }),
    ];
    const out = computeMeetingToFollowupLag({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.bucket).toBe('slipping');
    expect(out.value.lag_ms).toBe(-1);
    expect(out.value.next_outbound_at).toBe(0);
  });

  it('meeting + follow-up 5d later → bucket=long', () => {
    const meetingAt = FIXED_NOW - 7 * day;
    const followupAt = meetingAt + 5 * day;
    const rows: EngagementRow[] = [
      buildRow({
        target_id: 'm1', entity: 'meeting', lifecycle_state: 'completed',
        direction: 'outbound', event_at: meetingAt,
      }),
      buildRow({
        target_id: 'e1', entity: 'email', direction: 'outbound', authorship: 'user',
        lifecycle_state: 'point_in_time', event_at: followupAt,
      }),
    ];
    const out = computeMeetingToFollowupLag({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.bucket).toBe('long');
  });

  it('failed email send NOT counted as follow-up — bucket stays slipping', () => {
    const meetingAt = FIXED_NOW - 3 * day;
    const rows: EngagementRow[] = [
      buildRow({
        target_id: 'm1', entity: 'meeting', lifecycle_state: 'completed',
        direction: 'outbound', event_at: meetingAt,
      }),
      // Failed outbound after meeting → does NOT clear the slipping signal.
      buildRow({
        target_id: 'e1', entity: 'email', direction: 'outbound', authorship: 'user',
        lifecycle_state: 'failed', event_at: meetingAt + 1 * day,
      }),
    ];
    const out = computeMeetingToFollowupLag({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.lag_ms).toBe(-1);
    expect(out.value.bucket).toBe('slipping');
  });

  it('outbound BEFORE the meeting NOT counted (lag is post-meeting only)', () => {
    const meetingAt = FIXED_NOW - 2 * day;
    const earlierAt = meetingAt - 1 * day;
    const rows: EngagementRow[] = [
      buildRow({
        target_id: 'e0', entity: 'email', direction: 'outbound', authorship: 'user',
        lifecycle_state: 'point_in_time', event_at: earlierAt,
      }),
      buildRow({
        target_id: 'm1', entity: 'meeting', lifecycle_state: 'completed',
        direction: 'outbound', event_at: meetingAt,
      }),
    ];
    const out = computeMeetingToFollowupLag({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.next_outbound_at).toBe(0);
    expect(out.value.bucket).toBe('slipping');
  });

  it('cursor_at = max vendor_modified_at across folded rows', () => {
    const rows: EngagementRow[] = [
      buildRow({ entity: 'meeting', lifecycle_state: 'completed', vendor_modified_at: FIXED_NOW - 5 * day }),
      buildRow({ entity: 'email', vendor_modified_at: FIXED_NOW - 1 * day }),
    ];
    const out = computeMeetingToFollowupLag({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.cursor_at).toBe(FIXED_NOW - 1 * day);
  });

  it('coverage passes through unchanged', () => {
    const cov: CoverageMetadata = {
      ...EMPTY_COVERAGE,
      sources_degraded: [{ source: 'mail', reason: 'permission_revoked', since: FIXED_NOW - 60 * minute }],
    };
    const out = computeMeetingToFollowupLag({ rows: [], coverage: cov, now: FIXED_NOW });
    expect(out.coverage.sources_degraded[0]?.reason).toBe('permission_revoked');
  });
});

// ════════════════════════════════════════════════════════════════
// out_of_band_engagement
// ════════════════════════════════════════════════════════════════

const buildMail = (overrides: Partial<OutOfBandMailRow> = {}): OutOfBandMailRow => ({
  message_id: 'mid-1',
  from_email: 'rep@recued.example',
  to_emails: ['prospect@acme.example'],
  subject_hash: 'sha-abc',
  sent_at: FIXED_NOW - 60 * minute,
  vendor_modified_at: FIXED_NOW - 60 * minute,
  ...overrides,
});

const buildCrmEmail = (overrides: Partial<EngagementRow> & { meta?: Record<string, unknown> } = {}): EngagementRow => ({
  ...buildRow({
    entity: 'email',
    direction: 'outbound',
    authorship: 'user',
    target_id: 'hubspot_email_x',
    event_at: FIXED_NOW - 60 * minute,
    vendor_modified_at: FIXED_NOW - 60 * minute,
  }),
  ...overrides,
  meta: {
    message_id: 'mid-1',
    from_email: 'rep@recued.example',
    to_emails: ['prospect@acme.example'],
    subject_hash: 'sha-abc',
    timestamp: FIXED_NOW - 60 * minute,
    ...(overrides.meta ?? {}),
  },
});

describe('D-139 P4 — out_of_band_engagement helpers', () => {
  it('buildCrmMessageIdIndex builds map by Message-ID', () => {
    const idx = buildCrmMessageIdIndex([buildCrmEmail({ meta: { message_id: 'mid-1' } })]);
    expect(idx.get('mid-1')).toBeDefined();
  });
  it('matchesCrmQuadruple: identical from + first-recipient + sent_at + subject_hash → true', () => {
    expect(matchesCrmQuadruple(buildMail(), buildCrmEmail())).toBe(true);
  });
  it('matchesCrmQuadruple: drift outside 5min tolerance → false', () => {
    expect(matchesCrmQuadruple(
      buildMail({ sent_at: FIXED_NOW - 60 * minute }),
      buildCrmEmail({ event_at: FIXED_NOW - 70 * minute, meta: { timestamp: FIXED_NOW - 70 * minute } }),
    )).toBe(false);
  });
  it('matchesCrmQuadruple: drift within 5min tolerance → true', () => {
    expect(matchesCrmQuadruple(
      buildMail({ sent_at: FIXED_NOW - 60 * minute }),
      buildCrmEmail({ event_at: FIXED_NOW - 62 * minute, meta: { timestamp: FIXED_NOW - 62 * minute } }),
    )).toBe(true);
  });
  it('matchesCrmQuadruple: from mismatch → false', () => {
    expect(matchesCrmQuadruple(
      buildMail({ from_email: 'someone-else@recued.example' }),
      buildCrmEmail(),
    )).toBe(false);
  });
  it('matchesCrmQuadruple: subject_hash mismatch → false', () => {
    expect(matchesCrmQuadruple(
      buildMail({ subject_hash: 'different-hash' }),
      buildCrmEmail(),
    )).toBe(false);
  });
  it('matchesCrmQuadruple: empty mail to-list → false (can\'t compare)', () => {
    expect(matchesCrmQuadruple(buildMail({ to_emails: [] }), buildCrmEmail())).toBe(false);
  });

  it('passesConfidenceGate: single-deal contact → true', () => {
    const conf: OutOfBandContactConfidence = {
      email: 'prospect@acme.example',
      deal_count: 1,
      primary_deal_last_activity_at: 0,
    };
    expect(passesConfidenceGate(conf, FIXED_NOW)).toBe(true);
  });
  it('passesConfidenceGate: multi-deal contact + recent primary activity → true', () => {
    const conf: OutOfBandContactConfidence = {
      email: 'prospect@acme.example',
      deal_count: 5,
      primary_deal_last_activity_at: FIXED_NOW - 5 * day,
    };
    expect(passesConfidenceGate(conf, FIXED_NOW)).toBe(true);
  });
  it('passesConfidenceGate: multi-deal contact + stale primary (> 14d) → false', () => {
    const conf: OutOfBandContactConfidence = {
      email: 'prospect@acme.example',
      deal_count: 5,
      primary_deal_last_activity_at: FIXED_NOW - (OUT_OF_BAND_PRIMARY_DEAL_RECENCY_MS + 1 * day),
    };
    expect(passesConfidenceGate(conf, FIXED_NOW)).toBe(false);
  });
  it('passesConfidenceGate: undefined confidence → false (fail-closed)', () => {
    expect(passesConfidenceGate(undefined, FIXED_NOW)).toBe(false);
  });
});

describe('D-139 P4 — out_of_band_engagement compute', () => {
  const conf: ReadonlyMap<string, OutOfBandContactConfidence> = new Map([
    ['prospect@acme.example', { email: 'prospect@acme.example', deal_count: 1, primary_deal_last_activity_at: 0 }],
  ]);

  it('Message-ID match → not flagged as out-of-band', () => {
    const mail = buildMail({ message_id: 'mid-X' });
    const crm = [buildCrmEmail({ meta: { message_id: 'mid-X', from_email: mail.from_email, to_emails: [...mail.to_emails], subject_hash: mail.subject_hash, timestamp: mail.sent_at } })];
    const out = computeOutOfBandEngagement({
      mail_rows: [mail], crm_email_rows: crm, contact_confidence: conf,
      coverage: EMPTY_COVERAGE, now: FIXED_NOW,
    });
    expect(out.value.out_of_band_count).toBe(0);
  });

  it('Quadruple match (different message_id but same envelope) → not flagged', () => {
    const mail = buildMail({ message_id: 'mid-mail' });
    const crm = [buildCrmEmail({ meta: { message_id: 'mid-crm', from_email: mail.from_email, to_emails: [...mail.to_emails], subject_hash: mail.subject_hash, timestamp: mail.sent_at } })];
    const out = computeOutOfBandEngagement({
      mail_rows: [mail], crm_email_rows: crm, contact_confidence: conf,
      coverage: EMPTY_COVERAGE, now: FIXED_NOW,
    });
    expect(out.value.out_of_band_count).toBe(0);
  });

  it('No CRM match → flagged as out-of-band', () => {
    const mail = buildMail({ message_id: 'mid-orphan', sent_at: FIXED_NOW - 2 * day });
    const out = computeOutOfBandEngagement({
      mail_rows: [mail], crm_email_rows: [], contact_confidence: conf,
      coverage: EMPTY_COVERAGE, now: FIXED_NOW,
    });
    expect(out.value.out_of_band_count).toBe(1);
    expect(out.value.latest_unmatched_at).toBe(FIXED_NOW - 2 * day);
    expect(out.value.confidence_gate_passed).toBe(true);
  });

  it('Grace window: mail < 30 min old NOT yet flagged', () => {
    const mail = buildMail({ message_id: 'mid-fresh', sent_at: FIXED_NOW - 10 * minute });
    const out = computeOutOfBandEngagement({
      mail_rows: [mail], crm_email_rows: [], contact_confidence: conf,
      coverage: EMPTY_COVERAGE, now: FIXED_NOW,
    });
    expect(out.value.out_of_band_count).toBe(0);
  });

  it('Grace window boundary: mail at exactly 30 min → flagged', () => {
    const mail = buildMail({ message_id: 'mid-edge', sent_at: FIXED_NOW - OUT_OF_BAND_GRACE_MS });
    const out = computeOutOfBandEngagement({
      mail_rows: [mail], crm_email_rows: [], contact_confidence: conf,
      coverage: EMPTY_COVERAGE, now: FIXED_NOW,
    });
    expect(out.value.out_of_band_count).toBe(1);
  });

  it('Confidence gate fails for multi-deal contact with stale activity → mail filtered out (Codex P1 #1 fold)', () => {
    const staleConf = new Map<string, OutOfBandContactConfidence>([
      ['prospect@acme.example', {
        email: 'prospect@acme.example',
        deal_count: 5,
        primary_deal_last_activity_at: FIXED_NOW - 60 * day,
      }],
    ]);
    const mail = buildMail({ message_id: 'mid-orphan', sent_at: FIXED_NOW - 2 * day });
    const out = computeOutOfBandEngagement({
      mail_rows: [mail], crm_email_rows: [], contact_confidence: staleConf,
      coverage: EMPTY_COVERAGE, now: FIXED_NOW,
    });
    // Codex P1 #1 fold — confidence gate filters BEFORE counting.
    // Below-threshold mails no longer inflate the out_of_band_count;
    // the registry contract says "below threshold → mails don't
    // count toward out_of_band_count."
    expect(out.value.out_of_band_count).toBe(0);
    expect(out.value.confidence_gate_passed).toBe(false);
  });

  it('Confidence gate fails when contact has no confidence record → mail filtered out (Codex P1 #1 fold)', () => {
    const mail = buildMail({ message_id: 'mid-orphan', sent_at: FIXED_NOW - 2 * day });
    const out = computeOutOfBandEngagement({
      mail_rows: [mail], crm_email_rows: [], contact_confidence: new Map(),
      coverage: EMPTY_COVERAGE, now: FIXED_NOW,
    });
    expect(out.value.out_of_band_count).toBe(0);
    expect(out.value.confidence_gate_passed).toBe(false);
  });

  it('Codex P1 #1 fold — single-deal contact above gate counted; multi-deal stale contact filtered', () => {
    const conf2 = new Map<string, OutOfBandContactConfidence>([
      ['prospect-a@acme.example', { email: 'prospect-a@acme.example', deal_count: 1, primary_deal_last_activity_at: 0 }],
      ['prospect-b@acme.example', { email: 'prospect-b@acme.example', deal_count: 5, primary_deal_last_activity_at: FIXED_NOW - 60 * day }],
    ]);
    const mailA = buildMail({ message_id: 'mid-a', sent_at: FIXED_NOW - 2 * day, to_emails: ['prospect-a@acme.example'] });
    const mailB = buildMail({ message_id: 'mid-b', sent_at: FIXED_NOW - 1 * day, to_emails: ['prospect-b@acme.example'] });
    const out = computeOutOfBandEngagement({
      mail_rows: [mailA, mailB], crm_email_rows: [], contact_confidence: conf2,
      coverage: EMPTY_COVERAGE, now: FIXED_NOW,
    });
    expect(out.value.out_of_band_count).toBe(1);
    expect(out.value.confidence_gate_passed).toBe(true);
    expect(out.value.latest_unmatched_at).toBe(FIXED_NOW - 2 * day); // mailA's send time
  });

  it('Codex P1 #2 fold — inbound CRM email with same Message-ID does NOT suppress outbound mail alert', () => {
    const mail = buildMail({ message_id: 'mid-shared', sent_at: FIXED_NOW - 2 * day });
    // CRM row is INBOUND with the same Message-ID (e.g. threaded
    // reply that re-stamped envelope) — must NOT suppress.
    const inboundCrm = buildCrmEmail({
      direction: 'inbound',
      meta: { message_id: 'mid-shared', from_email: mail.from_email, to_emails: [...mail.to_emails], subject_hash: mail.subject_hash, timestamp: mail.sent_at },
    });
    const out = computeOutOfBandEngagement({
      mail_rows: [mail], crm_email_rows: [inboundCrm], contact_confidence: conf,
      coverage: EMPTY_COVERAGE, now: FIXED_NOW,
    });
    expect(out.value.out_of_band_count).toBe(1);
  });

  it('Codex P1 #5 fold — cursor_at folds across mail AND CRM source surfaces', () => {
    const mail = buildMail({ message_id: 'mid-1', vendor_modified_at: FIXED_NOW - 5 * day });
    const crmRow = buildCrmEmail({ vendor_modified_at: FIXED_NOW - 1 * day });
    const out = computeOutOfBandEngagement({
      mail_rows: [mail], crm_email_rows: [crmRow], contact_confidence: conf,
      coverage: EMPTY_COVERAGE, now: FIXED_NOW,
    });
    expect(out.value.cursor_at).toBe(FIXED_NOW - 1 * day);
  });

  it('Outside 90d window NOT counted', () => {
    const mail = buildMail({ message_id: 'mid-old', sent_at: FIXED_NOW - 100 * day });
    const out = computeOutOfBandEngagement({
      mail_rows: [mail], crm_email_rows: [], contact_confidence: conf,
      coverage: EMPTY_COVERAGE, now: FIXED_NOW,
    });
    expect(out.value.out_of_band_count).toBe(0);
  });

  it('cursor_at = max vendor_modified_at across folded mail rows', () => {
    const rows = [
      buildMail({ message_id: 'm1', sent_at: FIXED_NOW - 5 * day, vendor_modified_at: FIXED_NOW - 5 * day }),
      buildMail({ message_id: 'm2', sent_at: FIXED_NOW - 1 * day, vendor_modified_at: FIXED_NOW - 1 * day }),
    ];
    const out = computeOutOfBandEngagement({
      mail_rows: rows, crm_email_rows: [], contact_confidence: conf,
      coverage: EMPTY_COVERAGE, now: FIXED_NOW,
    });
    expect(out.value.cursor_at).toBe(FIXED_NOW - 1 * day);
  });

  it('deterministic re-run', () => {
    const mail = buildMail({ message_id: 'mid-orphan', sent_at: FIXED_NOW - 2 * day });
    const a = computeOutOfBandEngagement({
      mail_rows: [mail], crm_email_rows: [], contact_confidence: conf,
      coverage: EMPTY_COVERAGE, now: FIXED_NOW,
    });
    const b = computeOutOfBandEngagement({
      mail_rows: [mail], crm_email_rows: [], contact_confidence: conf,
      coverage: EMPTY_COVERAGE, now: FIXED_NOW,
    });
    expect(a.value).toEqual(b.value);
  });

  it('coverage passes through with sources_unavailable for missing CRM', () => {
    const cov: CoverageMetadata = {
      ...EMPTY_COVERAGE,
      sources_unavailable: ['connection.api.hubspot.email'],
    };
    const out = computeOutOfBandEngagement({
      mail_rows: [], crm_email_rows: [], contact_confidence: conf,
      coverage: cov, now: FIXED_NOW,
    });
    expect(out.coverage.sources_unavailable).toEqual(['connection.api.hubspot.email']);
  });
});

// ════════════════════════════════════════════════════════════════
// account_engagement_breadth
// ════════════════════════════════════════════════════════════════

describe('D-139 P4 — account_engagement_breadth helpers', () => {
  it('isQualifyingBreadthEvent: outbound point_in_time email → true', () => {
    expect(isQualifyingBreadthEvent(buildRow())).toBe(true);
  });
  it('isQualifyingBreadthEvent: internal direction → false', () => {
    expect(isQualifyingBreadthEvent(buildRow({ direction: 'internal' }))).toBe(false);
  });
  it('isQualifyingBreadthEvent: crm_automation authorship → false', () => {
    expect(isQualifyingBreadthEvent(buildRow({ authorship: 'crm_automation' }))).toBe(false);
  });
  it('isQualifyingBreadthEvent: pending lifecycle → false', () => {
    expect(isQualifyingBreadthEvent(buildRow({ lifecycle_state: 'pending' }))).toBe(false);
  });
  it('isQualifyingBreadthEvent: event_at null → false', () => {
    expect(isQualifyingBreadthEvent(buildRow({ event_at: null }))).toBe(false);
  });

  it('breadthRecencyWeight: today → ~1.0', () => {
    expect(breadthRecencyWeight(FIXED_NOW, FIXED_NOW)).toBeCloseTo(1.0, 5);
  });
  it('breadthRecencyWeight: 30d ago → 0.5 (half-life)', () => {
    expect(breadthRecencyWeight(FIXED_NOW - ACCOUNT_BREADTH_HALF_LIFE_MS, FIXED_NOW)).toBeCloseTo(0.5, 5);
  });
  it('breadthRecencyWeight: 60d ago → 0.25 (two half-lives)', () => {
    expect(breadthRecencyWeight(FIXED_NOW - 2 * ACCOUNT_BREADTH_HALF_LIFE_MS, FIXED_NOW)).toBeCloseTo(0.25, 5);
  });
  it('breadthRecencyWeight: zero event_at → 0', () => {
    expect(breadthRecencyWeight(0, FIXED_NOW)).toBe(0);
  });

  it('decideBreadthBucket: 0 contacts → silent', () => {
    expect(decideBreadthBucket(0)).toBe('silent');
  });
  it('decideBreadthBucket: 1 contact → narrow', () => {
    expect(decideBreadthBucket(1)).toBe('narrow');
  });
  it('decideBreadthBucket: 3 contacts → developing', () => {
    expect(decideBreadthBucket(3)).toBe('developing');
  });
  it('decideBreadthBucket: 5 contacts → multi_threaded', () => {
    expect(decideBreadthBucket(5)).toBe('multi_threaded');
  });
});

describe('D-139 P4 — account_engagement_breadth compute', () => {
  it('one contact engaging → narrow + weight ~ 1', () => {
    const rows: AccountBreadthRow[] = [
      { row: buildRow({ event_at: FIXED_NOW }), contact_email: 'a@acme.example' },
    ];
    const out = computeAccountEngagementBreadth({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.distinct_contacts).toBe(1);
    expect(out.value.bucket).toBe('narrow');
    expect(out.value.recency_weighted_score).toBeCloseTo(1.0, 4);
  });

  it('5 contacts engaging recently → multi_threaded', () => {
    const rows: AccountBreadthRow[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push({ row: buildRow({ event_at: FIXED_NOW - 1 * day, target_id: `e${i}` }), contact_email: `c${i}@acme.example` });
    }
    const out = computeAccountEngagementBreadth({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.distinct_contacts).toBe(5);
    expect(out.value.bucket).toBe('multi_threaded');
  });

  it('Codex P1 #3 fold — multiple engagements per contact: distinct_contacts dedupes by canonical email; recency_weighted_score sums per-row', () => {
    // Spec § P4 line 1508: probable-twin pairs count as 2 separate
    // engagements in account_engagement_breadth recency-weight math.
    // Per-row weight summed, not per-contact freshest.
    const rows: AccountBreadthRow[] = [
      { row: buildRow({ event_at: FIXED_NOW - 30 * day, target_id: 'e1' }), contact_email: 'a@acme.example' },
      { row: buildRow({ event_at: FIXED_NOW - 1 * day, target_id: 'e2' }), contact_email: 'a@acme.example' },
    ];
    const out = computeAccountEngagementBreadth({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.distinct_contacts).toBe(1);
    // Weight ≈ exp(-30/30 * ln2) + exp(-1/30 * ln2) ≈ 0.5 + 0.977 ≈ 1.477
    // (per-row sum, not per-contact freshest).
    expect(out.value.recency_weighted_score).toBeGreaterThan(1.4);
    expect(out.value.recency_weighted_score).toBeLessThan(1.5);
  });

  it('Codex P1 #3 fold — probable-twin pair counts as 2 separate engagements in recency math', () => {
    // Same contact, same engagement seen via HubSpot email +
    // Salesforce email_message (probable-confidence twin pair).
    // Per spec § A.3.5 dedupe_acceptance: 'exact_only' — over-count.
    const sameNow = FIXED_NOW - 1 * day;
    const rows: AccountBreadthRow[] = [
      { row: buildRow({ event_at: sameNow, target_id: 'hubspot_email_1', dedupe_confidence: 'probable' }), contact_email: 'a@acme.example' },
      { row: buildRow({ event_at: sameNow, target_id: 'salesforce_email_message_1', vendor: 'salesforce', entity: 'email_message', dedupe_confidence: 'probable' }), contact_email: 'a@acme.example' },
    ];
    const out = computeAccountEngagementBreadth({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.distinct_contacts).toBe(1);
    // Both rows' weights summed (~ 2 × 0.977) ≈ 1.95. Pre-fold this
    // collapsed to a single ~0.977 weight per the freshest-per-
    // contact dedupe.
    expect(out.value.recency_weighted_score).toBeGreaterThan(1.9);
  });

  it('internal-direction rows excluded from breadth', () => {
    const rows: AccountBreadthRow[] = [
      { row: buildRow({ direction: 'internal' }), contact_email: 'rep@team.example' },
      { row: buildRow({ direction: 'inbound' }), contact_email: 'a@acme.example' },
    ];
    const out = computeAccountEngagementBreadth({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.distinct_contacts).toBe(1);
  });

  it('automation/system_process rows excluded from breadth', () => {
    const rows: AccountBreadthRow[] = [
      { row: buildRow({ authorship: 'crm_automation' }), contact_email: 'a@acme.example' },
      { row: buildRow({ authorship: 'system_process' }), contact_email: 'b@acme.example' },
      { row: buildRow({ authorship: 'user' }), contact_email: 'c@acme.example' },
    ];
    const out = computeAccountEngagementBreadth({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.distinct_contacts).toBe(1);
  });

  it('null contact_email rows skipped (account-only engagements)', () => {
    const rows: AccountBreadthRow[] = [
      { row: buildRow(), contact_email: null },
      { row: buildRow(), contact_email: 'a@acme.example' },
    ];
    const out = computeAccountEngagementBreadth({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.distinct_contacts).toBe(1);
  });

  it('outside 90d window excluded', () => {
    const rows: AccountBreadthRow[] = [
      { row: buildRow({ event_at: FIXED_NOW - 100 * day }), contact_email: 'a@acme.example' },
    ];
    const out = computeAccountEngagementBreadth({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.distinct_contacts).toBe(0);
    expect(out.value.bucket).toBe('silent');
  });

  it('cursor_at = max vendor_modified_at folded across all rows', () => {
    const rows: AccountBreadthRow[] = [
      { row: buildRow({ vendor_modified_at: FIXED_NOW - 10 * day }), contact_email: 'a@acme.example' },
      { row: buildRow({ vendor_modified_at: FIXED_NOW - 1 * day }), contact_email: 'b@acme.example' },
    ];
    const out = computeAccountEngagementBreadth({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.cursor_at).toBe(FIXED_NOW - 1 * day);
  });
});

// ════════════════════════════════════════════════════════════════
// account_reentry_signal
// ════════════════════════════════════════════════════════════════

describe('D-139 P4 — account_reentry_signal compute', () => {
  it('isQualifyingAccountEvent shape gate matches breadth gate', () => {
    expect(isQualifyingAccountEvent(buildRow())).toBe(true);
    expect(isQualifyingAccountEvent(buildRow({ direction: 'internal' }))).toBe(false);
    expect(isQualifyingAccountEvent(buildRow({ authorship: 'crm_automation' }))).toBe(false);
    expect(isQualifyingAccountEvent(buildRow({ lifecycle_state: 'pending' }))).toBe(false);
  });

  it('no engagement at all → reentered=false', () => {
    const out = computeAccountReentrySignal({ rows: [], coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.reentered).toBe(false);
    expect(out.value.dormancy_days).toBe(0);
    expect(out.value.last_reentry_at).toBe(0);
  });

  it('only recent engagement, no prior → reentered=true (first-time-ever / cold lookback)', () => {
    const rows: EngagementRow[] = [
      buildRow({ event_at: FIXED_NOW - 5 * day }),
    ];
    const out = computeAccountReentrySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.reentered).toBe(true);
    expect(out.value.last_reentry_at).toBe(FIXED_NOW - 5 * day);
  });

  it('continuous engagement (no dormancy gap) → reentered=false', () => {
    const rows: EngagementRow[] = [
      buildRow({ target_id: 'e1', event_at: FIXED_NOW - 30 * day }),  // pre-recent
      buildRow({ target_id: 'e2', event_at: FIXED_NOW - 5 * day }),    // recent
    ];
    const out = computeAccountReentrySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    // Gap is only 25d — below 60d dormancy threshold.
    expect(out.value.reentered).toBe(false);
  });

  it('60d+ dormancy + recent engagement → reentered=true', () => {
    const rows: EngagementRow[] = [
      buildRow({ target_id: 'e1', event_at: FIXED_NOW - 90 * day }),  // 90d ago
      buildRow({ target_id: 'e2', event_at: FIXED_NOW - 5 * day }),    // recent
    ];
    const out = computeAccountReentrySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.reentered).toBe(true);
    expect(out.value.dormancy_days).toBe(85); // 90d - 5d
    expect(out.value.last_reentry_at).toBe(FIXED_NOW - 5 * day);
  });

  it('dormancy below 60d threshold → reentered=false', () => {
    const rows: EngagementRow[] = [
      buildRow({ target_id: 'e1', event_at: FIXED_NOW - 50 * day }),
      buildRow({ target_id: 'e2', event_at: FIXED_NOW - 1 * day }),
    ];
    const out = computeAccountReentrySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.reentered).toBe(false);
  });

  it('exactly 60d dormancy boundary → reentered=true', () => {
    const rows: EngagementRow[] = [
      buildRow({ target_id: 'e1', event_at: FIXED_NOW - ACCOUNT_REENTRY_RECENT_MS - ACCOUNT_DORMANCY_MS }),
      buildRow({ target_id: 'e2', event_at: FIXED_NOW - 1 * day }),
    ];
    const out = computeAccountReentrySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.reentered).toBe(true);
  });

  it('only old engagement (no recent) → reentered=false', () => {
    const rows: EngagementRow[] = [
      buildRow({ target_id: 'e1', event_at: FIXED_NOW - 90 * day }),
    ];
    const out = computeAccountReentrySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.reentered).toBe(false);
  });

  it('automation engagement does NOT count as reentry', () => {
    const rows: EngagementRow[] = [
      buildRow({ target_id: 'e1', event_at: FIXED_NOW - 90 * day }),
      buildRow({ target_id: 'e2', event_at: FIXED_NOW - 1 * day, authorship: 'crm_automation' }),
    ];
    const out = computeAccountReentrySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.reentered).toBe(false);
  });

  it('Codex P1 #4 fold — last_reentry_at = EARLIEST recent engagement that broke dormancy, not freshest', () => {
    // Pre-fold this case reported last_reentry_at = E3 (3d ago);
    // semantically the reentry moment is E2 (13d ago — first
    // engagement after the dormant gap).
    const rows: EngagementRow[] = [
      buildRow({ target_id: 'e1', event_at: FIXED_NOW - 90 * day }),  // pre-recent dormancy anchor
      buildRow({ target_id: 'e2', event_at: FIXED_NOW - 13 * day }),   // earliest recent — actual reentry
      buildRow({ target_id: 'e3', event_at: FIXED_NOW - 7 * day }),    // recent
      buildRow({ target_id: 'e4', event_at: FIXED_NOW - 3 * day }),    // freshest recent
    ];
    const out = computeAccountReentrySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.reentered).toBe(true);
    expect(out.value.last_reentry_at).toBe(FIXED_NOW - 13 * day);
    // Dormancy = earliest_recent - latest_pre_recent = 90d - 13d = 77d.
    expect(out.value.dormancy_days).toBe(77);
  });

  it('cursor_at folded across all rows', () => {
    const rows: EngagementRow[] = [
      buildRow({ vendor_modified_at: FIXED_NOW - 10 * day }),
      buildRow({ vendor_modified_at: FIXED_NOW - 1 * day }),
    ];
    const out = computeAccountReentrySignal({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.cursor_at).toBe(FIXED_NOW - 1 * day);
  });
});

// ════════════════════════════════════════════════════════════════
// champion_deal_count
// ════════════════════════════════════════════════════════════════

describe('D-139 P4 — champion_deal_count helpers', () => {
  it('decideChampionBucket: < 2 closed → unknown', () => {
    expect(decideChampionBucket(1, 0, 1.0)).toBe('unknown');
    expect(decideChampionBucket(0, 1, 0.0)).toBe('unknown');
  });
  it('decideChampionBucket: 2 wins, 0 losses → champion', () => {
    expect(decideChampionBucket(2, 0, 1.0)).toBe('champion');
  });
  it('decideChampionBucket: 3 wins, 1 loss (75%) → champion', () => {
    expect(decideChampionBucket(3, 1, 0.75)).toBe('champion');
  });
  it('decideChampionBucket: 1 win, 1 loss → mixed', () => {
    expect(decideChampionBucket(1, 1, 0.5)).toBe('mixed');
  });
  it('decideChampionBucket: 0 wins, 3 losses → blocker', () => {
    expect(decideChampionBucket(0, 3, 0.0)).toBe('blocker');
  });
  it('decideChampionBucket: 1 win, 4 losses (20%) → blocker', () => {
    expect(decideChampionBucket(1, 4, 0.2)).toBe('blocker');
  });
});

describe('D-139 P4 — champion_deal_count compute', () => {
  const buildDealRow = (overrides: Partial<ChampionDealRow> = {}): ChampionDealRow => ({
    deal_id: 'hubspot_deal_1',
    status: 'open',
    vendor_modified_at: FIXED_NOW - 1 * day,
    ...overrides,
  });

  it('no deals → unknown bucket + zeros', () => {
    const out = computeChampionDealCount({ rows: [], coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.total_deals).toBe(0);
    expect(out.value.bucket).toBe('unknown');
    expect(out.value.win_rate).toBe(0);
  });

  it('3 wins + 1 loss → champion (75% win rate)', () => {
    const rows: ChampionDealRow[] = [
      buildDealRow({ deal_id: 'hubspot_deal_1', status: 'won' }),
      buildDealRow({ deal_id: 'hubspot_deal_2', status: 'won' }),
      buildDealRow({ deal_id: 'hubspot_deal_3', status: 'won' }),
      buildDealRow({ deal_id: 'hubspot_deal_4', status: 'lost' }),
    ];
    const out = computeChampionDealCount({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.won_deals).toBe(3);
    expect(out.value.lost_deals).toBe(1);
    expect(out.value.total_deals).toBe(4);
    expect(out.value.win_rate).toBe(0.75);
    expect(out.value.bucket).toBe('champion');
  });

  it('0 wins + 3 losses → blocker', () => {
    const rows: ChampionDealRow[] = [
      buildDealRow({ deal_id: 'hubspot_deal_1', status: 'lost' }),
      buildDealRow({ deal_id: 'hubspot_deal_2', status: 'lost' }),
      buildDealRow({ deal_id: 'hubspot_deal_3', status: 'lost' }),
    ];
    const out = computeChampionDealCount({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.bucket).toBe('blocker');
    expect(out.value.win_rate).toBe(0);
  });

  it('all open deals → unknown bucket (no closed sample)', () => {
    const rows: ChampionDealRow[] = [
      buildDealRow({ deal_id: 'hubspot_deal_1', status: 'open' }),
      buildDealRow({ deal_id: 'hubspot_deal_2', status: 'open' }),
      buildDealRow({ deal_id: 'hubspot_deal_3', status: 'open' }),
    ];
    const out = computeChampionDealCount({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.total_deals).toBe(3);
    expect(out.value.open_deals).toBe(3);
    expect(out.value.bucket).toBe('unknown');
  });

  it('cross-vendor deal mix counted (HubSpot + Salesforce)', () => {
    const rows: ChampionDealRow[] = [
      buildDealRow({ deal_id: 'hubspot_deal_1', status: 'won' }),
      buildDealRow({ deal_id: 'salesforce_opportunity_006A0', status: 'won' }),
      buildDealRow({ deal_id: 'salesforce_opportunity_006B1', status: 'lost' }),
    ];
    const out = computeChampionDealCount({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.total_deals).toBe(3);
    expect(out.value.won_deals).toBe(2);
    expect(out.value.lost_deals).toBe(1);
  });

  it('duplicate deal_id deduped (defensive — caller may double-emit on multi-edge)', () => {
    const rows: ChampionDealRow[] = [
      buildDealRow({ deal_id: 'hubspot_deal_1', status: 'won' }),
      buildDealRow({ deal_id: 'hubspot_deal_1', status: 'won' }),
    ];
    const out = computeChampionDealCount({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.total_deals).toBe(1);
    expect(out.value.won_deals).toBe(1);
  });

  it('unknown status rows count toward total but not won/lost/open', () => {
    const rows: ChampionDealRow[] = [
      buildDealRow({ deal_id: 'hubspot_deal_1', status: 'won' }),
      buildDealRow({ deal_id: 'hubspot_deal_2', status: 'won' }),
      buildDealRow({ deal_id: 'hubspot_deal_3', status: 'unknown' }),
    ];
    const out = computeChampionDealCount({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.total_deals).toBe(3);
    expect(out.value.won_deals).toBe(2);
    expect(out.value.lost_deals).toBe(0);
    expect(out.value.open_deals).toBe(0);
  });

  it('cursor_at = max deal vendor_modified_at folded', () => {
    const rows: ChampionDealRow[] = [
      buildDealRow({ deal_id: 'd1', vendor_modified_at: FIXED_NOW - 100 * day }),
      buildDealRow({ deal_id: 'd2', vendor_modified_at: FIXED_NOW - 1 * day }),
    ];
    const out = computeChampionDealCount({ rows, coverage: EMPTY_COVERAGE, now: FIXED_NOW });
    expect(out.value.cursor_at).toBe(FIXED_NOW - 1 * day);
  });

  it('coverage passes through unchanged', () => {
    const cov: CoverageMetadata = {
      ...EMPTY_COVERAGE,
      sources_unavailable: ['connection.api.salesforce.opportunity'],
    };
    const out = computeChampionDealCount({ rows: [], coverage: cov, now: FIXED_NOW });
    expect(out.coverage.sources_unavailable).toEqual(['connection.api.salesforce.opportunity']);
  });
});

// ════════════════════════════════════════════════════════════════
// multi_account_contact
// ════════════════════════════════════════════════════════════════

describe('D-139 P4 — multi_account_contact helpers', () => {
  it('canonicaliseDomain lowercases + trims + strips www.', () => {
    expect(canonicaliseDomain('  WWW.Acme.Example  ')).toBe('acme.example');
  });
  it('canonicaliseDomain handles null', () => {
    expect(canonicaliseDomain(null)).toBe('');
  });
  it('isFreeMailDomain: gmail.com → true', () => {
    expect(isFreeMailDomain('gmail.com')).toBe(true);
  });
  it('isFreeMailDomain: outlook.com → true', () => {
    expect(isFreeMailDomain('outlook.com')).toBe(true);
  });
  it('isFreeMailDomain: protonmail.com → true', () => {
    expect(isFreeMailDomain('protonmail.com')).toBe(true);
  });
  it('isFreeMailDomain: acme.example → false (professional)', () => {
    expect(isFreeMailDomain('acme.example')).toBe(false);
  });
});

describe('D-139 P4 — multi_account_contact compute', () => {
  it('mail domain ≠ CRM domain → is_multi_account=true', () => {
    const out = computeMultiAccountContact({
      mail_from_domain: 'newco.example',
      crm_company_domains: ['oldco.example'],
      crm_vendor_modified_at: FIXED_NOW - 1 * day,
      mail_vendor_modified_at: FIXED_NOW - 1 * day,
      coverage: EMPTY_COVERAGE,
      now: FIXED_NOW,
    });
    expect(out.value.is_multi_account).toBe(true);
    expect(out.value.mail_domain).toBe('newco.example');
    expect(out.value.crm_company_domains).toEqual(['oldco.example']);
  });

  it('mail domain = CRM domain → is_multi_account=false', () => {
    const out = computeMultiAccountContact({
      mail_from_domain: 'acme.example',
      crm_company_domains: ['acme.example'],
      crm_vendor_modified_at: FIXED_NOW - 1 * day,
      mail_vendor_modified_at: 0,
      coverage: EMPTY_COVERAGE,
      now: FIXED_NOW,
    });
    expect(out.value.is_multi_account).toBe(false);
  });

  it('mail domain matches one of multiple CRM domains → false', () => {
    const out = computeMultiAccountContact({
      mail_from_domain: 'acme-uk.example',
      crm_company_domains: ['acme.example', 'acme-uk.example'],
      crm_vendor_modified_at: FIXED_NOW - 1 * day,
      mail_vendor_modified_at: 0,
      coverage: EMPTY_COVERAGE,
      now: FIXED_NOW,
    });
    expect(out.value.is_multi_account).toBe(false);
  });

  it('free-mail mail domain → mail_domain=null + is_multi_account=false', () => {
    const out = computeMultiAccountContact({
      mail_from_domain: 'gmail.com',
      crm_company_domains: ['acme.example'],
      crm_vendor_modified_at: FIXED_NOW - 1 * day,
      mail_vendor_modified_at: 0,
      coverage: EMPTY_COVERAGE,
      now: FIXED_NOW,
    });
    expect(out.value.is_multi_account).toBe(false);
    expect(out.value.mail_domain).toBeNull();
  });

  it('null mail_from_domain → is_multi_account=false (no signal)', () => {
    const out = computeMultiAccountContact({
      mail_from_domain: null,
      crm_company_domains: ['acme.example'],
      crm_vendor_modified_at: FIXED_NOW - 1 * day,
      mail_vendor_modified_at: 0,
      coverage: EMPTY_COVERAGE,
      now: FIXED_NOW,
    });
    expect(out.value.is_multi_account).toBe(false);
    expect(out.value.mail_domain).toBeNull();
  });

  it('empty CRM-domain set → is_multi_account=false (insufficient signal)', () => {
    const out = computeMultiAccountContact({
      mail_from_domain: 'newco.example',
      crm_company_domains: [],
      crm_vendor_modified_at: FIXED_NOW - 1 * day,
      mail_vendor_modified_at: 0,
      coverage: EMPTY_COVERAGE,
      now: FIXED_NOW,
    });
    expect(out.value.is_multi_account).toBe(false);
    expect(out.value.crm_company_domains).toEqual([]);
  });

  it('canonicalises domains (case + www. + whitespace) before comparison', () => {
    const out = computeMultiAccountContact({
      mail_from_domain: '  ACME.example  ',
      crm_company_domains: ['www.acme.EXAMPLE'],
      crm_vendor_modified_at: FIXED_NOW - 1 * day,
      mail_vendor_modified_at: 0,
      coverage: EMPTY_COVERAGE,
      now: FIXED_NOW,
    });
    // After canonicalisation both are 'acme.example' → match → not multi-account.
    expect(out.value.is_multi_account).toBe(false);
  });

  it('cursor_at = max(crm, mail) per Codex P1 #6 fold (mail evidence advances cursor)', () => {
    // CRM older than mail evidence → cursor must reflect mail.
    const out = computeMultiAccountContact({
      mail_from_domain: 'newco.example',
      crm_company_domains: ['acme.example'],
      crm_vendor_modified_at: FIXED_NOW - 5 * day,
      mail_vendor_modified_at: FIXED_NOW - 1 * day,
      coverage: EMPTY_COVERAGE,
      now: FIXED_NOW,
    });
    expect(out.value.cursor_at).toBe(FIXED_NOW - 1 * day);
  });

  it('cursor_at = max(crm, mail) — CRM-only when no mail evidence', () => {
    const out = computeMultiAccountContact({
      mail_from_domain: null,
      crm_company_domains: ['acme.example'],
      crm_vendor_modified_at: FIXED_NOW - 5 * day,
      mail_vendor_modified_at: 0,
      coverage: EMPTY_COVERAGE,
      now: FIXED_NOW,
    });
    expect(out.value.cursor_at).toBe(FIXED_NOW - 5 * day);
  });

  it('coverage passes through unchanged', () => {
    const cov: CoverageMetadata = {
      ...EMPTY_COVERAGE,
      sources_degraded: [{ source: 'mail', reason: 'permission_revoked', since: FIXED_NOW }],
    };
    const out = computeMultiAccountContact({
      mail_from_domain: null, crm_company_domains: [],
      crm_vendor_modified_at: 0, mail_vendor_modified_at: 0,
      coverage: cov, now: FIXED_NOW,
    });
    expect(out.coverage.sources_degraded[0]?.reason).toBe('permission_revoked');
  });
});
