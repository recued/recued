/** D-139 Phase 4 — contracts smoke tests for the cross-entity
 *  enrichment registry entries + value schemas.
 *
 *  Covers all 6 P4 topics from § A.9.2b:
 *    - meeting_to_followup_lag (deal-scoped time_bound × scenario)
 *    - out_of_band_engagement (deal-scoped time_bound × scenario)
 *    - account_engagement_breadth (account-scoped aggregate_window × scenario)
 *    - account_reentry_signal (account-scoped time_bound × scenario)
 *    - champion_deal_count (contact-scoped aggregate_window × perspective)
 *    - multi_account_contact (contact-scoped time_bound × perspective)
 *
 *  Spec: D-139 § A.9.2b + § P4 acceptance. */

import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_BREADTH_BUCKETS,
  CHAMPION_DEAL_BUCKETS,
  ENRICHMENT_REGISTRY,
  MEETING_FOLLOWUP_LAG_BUCKETS,
  isEnrichmentTopic,
  type AccountBreadthBucket,
  type AccountEngagementBreadthValue,
  type AccountReentrySignalValue,
  type ChampionDealBucket,
  type ChampionDealCountValue,
  type MeetingFollowupLagBucket,
  type MeetingToFollowupLagValue,
  type MultiAccountContactValue,
  type OutOfBandEngagementValue,
} from '../index.js';

const HUBSPOT_DEAL = 'connection.api.hubspot.deal' as const;
const SALESFORCE_OPP = 'connection.api.salesforce.opportunity' as const;
const HUBSPOT_COMPANY = 'connection.api.hubspot.company' as const;
const SALESFORCE_ACCOUNT = 'connection.api.salesforce.account' as const;
const HUBSPOT_CONTACT = 'connection.api.hubspot.contact' as const;
const SALESFORCE_CONTACT = 'connection.api.salesforce.contact' as const;

const PER_TYPE_ENGAGEMENTS = [
  'connection.api.hubspot.email',
  'connection.api.hubspot.meeting',
  'connection.api.hubspot.note',
  'connection.api.hubspot.call',
  'connection.api.hubspot.task',
  'connection.api.salesforce.task',
  'connection.api.salesforce.event',
  'connection.api.salesforce.email_message',
  'connection.api.salesforce.voice_call',
  'connection.api.salesforce.call_history',
];

// ────────────────────────────────────────────────────────────────
// meeting_to_followup_lag
// ────────────────────────────────────────────────────────────────

describe('D-139 P4 — meeting_to_followup_lag topic registration', () => {
  it('topic resolves via isEnrichmentTopic', () => {
    expect(isEnrichmentTopic('meeting_to_followup_lag')).toBe(true);
  });
  it('carries time_bound × scenario × historical lifecycle per § A.9.2b', () => {
    const def = ENRICHMENT_REGISTRY.meeting_to_followup_lag;
    expect(def.temporal_class).toBe('time_bound');
    expect(def.identity_aggregation).toBe('scenario');
    expect(def.lifecycle_policy).toBe('historical');
  });
  it('valid_scopes covers HubSpot deal + Salesforce opportunity', () => {
    const def = ENRICHMENT_REGISTRY.meeting_to_followup_lag;
    expect(def.valid_scopes).toEqual([HUBSPOT_DEAL, SALESFORCE_OPP]);
  });
  it('aggregates_from spans per-type engagement scopes + mail + calendar', () => {
    const def = ENRICHMENT_REGISTRY.meeting_to_followup_lag;
    const af = [...(def.aggregates_from ?? [])].sort();
    expect(af).toEqual([...PER_TYPE_ENGAGEMENTS, 'calendar', 'mail'].sort());
  });
  it('default trust state = auto + pool policy = free_only', () => {
    const def = ENRICHMENT_REGISTRY.meeting_to_followup_lag;
    expect(def.default_trust_state).toBe('auto');
    expect(def.default_pool_policy).toBe('free_only');
  });
  it('populates_coverage = true (every D-139 topic emits coverage metadata)', () => {
    const def = ENRICHMENT_REGISTRY.meeting_to_followup_lag;
    expect(def.populates_coverage).toBe(true);
  });
  it('value_schema validates well-formed values', () => {
    const def = ENRICHMENT_REGISTRY.meeting_to_followup_lag;
    const v: MeetingToFollowupLagValue = {
      bucket: 'fast',
      last_meeting_at: 1714867200000,
      next_outbound_at: 1714867200000 + 60 * 60 * 1000,
      lag_ms: 60 * 60 * 1000,
      cursor_at: 1714867200000,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('value_schema accepts no-followup lag_ms = -1', () => {
    const def = ENRICHMENT_REGISTRY.meeting_to_followup_lag;
    const v: MeetingToFollowupLagValue = {
      bucket: 'slipping',
      last_meeting_at: 1714867200000,
      next_outbound_at: 0,
      lag_ms: -1,
      cursor_at: 1714867200000,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('value_schema rejects unknown bucket', () => {
    const def = ENRICHMENT_REGISTRY.meeting_to_followup_lag;
    expect(
      def.value_schema!({
        bucket: 'sprinting',
        last_meeting_at: 0,
        next_outbound_at: 0,
        lag_ms: -1,
        cursor_at: 0,
      }).ok,
    ).toBe(false);
  });
  it('MEETING_FOLLOWUP_LAG_BUCKETS enumerates fast / normal / long / slipping / none', () => {
    expect([...MEETING_FOLLOWUP_LAG_BUCKETS].sort()).toEqual([
      'fast',
      'long',
      'none',
      'normal',
      'slipping',
    ]);
    const x: MeetingFollowupLagBucket = 'fast';
    expect(MEETING_FOLLOWUP_LAG_BUCKETS).toContain(x);
  });
});

// ────────────────────────────────────────────────────────────────
// out_of_band_engagement
// ────────────────────────────────────────────────────────────────

describe('D-139 P4 — out_of_band_engagement topic registration', () => {
  it('topic resolves via isEnrichmentTopic', () => {
    expect(isEnrichmentTopic('out_of_band_engagement')).toBe(true);
  });
  it('carries time_bound × scenario × historical lifecycle per § A.9.2b', () => {
    const def = ENRICHMENT_REGISTRY.out_of_band_engagement;
    expect(def.temporal_class).toBe('time_bound');
    expect(def.identity_aggregation).toBe('scenario');
    expect(def.lifecycle_policy).toBe('historical');
  });
  it('valid_scopes covers HubSpot deal + Salesforce opportunity', () => {
    const def = ENRICHMENT_REGISTRY.out_of_band_engagement;
    expect(def.valid_scopes).toEqual([HUBSPOT_DEAL, SALESFORCE_OPP]);
  });
  it('aggregates_from spans email engagement scopes + mail (visibility-gap shape)', () => {
    const def = ENRICHMENT_REGISTRY.out_of_band_engagement;
    expect([...(def.aggregates_from ?? [])].sort()).toEqual(
      [
        'connection.api.hubspot.email',
        'connection.api.salesforce.email_message',
        'mail',
      ].sort(),
    );
  });
  it('value_schema validates well-formed value', () => {
    const def = ENRICHMENT_REGISTRY.out_of_band_engagement;
    const v: OutOfBandEngagementValue = {
      out_of_band_count: 3,
      latest_unmatched_at: 1714867200000,
      confidence_gate_passed: true,
      cursor_at: 1714867200000,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('value_schema rejects non-boolean confidence gate', () => {
    const def = ENRICHMENT_REGISTRY.out_of_band_engagement;
    expect(
      def.value_schema!({
        out_of_band_count: 0,
        latest_unmatched_at: 0,
        confidence_gate_passed: 'yes' as unknown,
        cursor_at: 0,
      }).ok,
    ).toBe(false);
  });
  it('value_schema rejects negative count', () => {
    const def = ENRICHMENT_REGISTRY.out_of_band_engagement;
    expect(
      def.value_schema!({
        out_of_band_count: -1,
        latest_unmatched_at: 0,
        confidence_gate_passed: false,
        cursor_at: 0,
      }).ok,
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// account_engagement_breadth
// ────────────────────────────────────────────────────────────────

describe('D-139 P4 — account_engagement_breadth topic registration', () => {
  it('topic resolves via isEnrichmentTopic', () => {
    expect(isEnrichmentTopic('account_engagement_breadth')).toBe(true);
  });
  it('carries aggregate_window × scenario × forward_only lifecycle per § A.9.2b', () => {
    const def = ENRICHMENT_REGISTRY.account_engagement_breadth;
    expect(def.temporal_class).toBe('aggregate_window');
    expect(def.identity_aggregation).toBe('scenario');
    expect(def.lifecycle_policy).toBe('forward_only');
  });
  it('valid_scopes covers HubSpot company + Salesforce account (account scope)', () => {
    const def = ENRICHMENT_REGISTRY.account_engagement_breadth;
    expect(def.valid_scopes).toEqual([HUBSPOT_COMPANY, SALESFORCE_ACCOUNT]);
  });
  it('aggregate window is 90d + axis event_time', () => {
    const def = ENRICHMENT_REGISTRY.account_engagement_breadth;
    expect(def.aggregate_window_axis).toBe('event_time');
    expect(def.aggregate_window_ms).toBe(90 * 24 * 60 * 60 * 1000);
  });
  it('value_schema validates well-formed value', () => {
    const def = ENRICHMENT_REGISTRY.account_engagement_breadth;
    const v: AccountEngagementBreadthValue = {
      distinct_contacts: 4,
      recency_weighted_score: 2.75,
      bucket: 'multi_threaded',
      cursor_at: 1714867200000,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('ACCOUNT_BREADTH_BUCKETS enumerates narrow / developing / multi_threaded / silent', () => {
    expect([...ACCOUNT_BREADTH_BUCKETS].sort()).toEqual([
      'developing',
      'multi_threaded',
      'narrow',
      'silent',
    ]);
    const x: AccountBreadthBucket = 'developing';
    expect(ACCOUNT_BREADTH_BUCKETS).toContain(x);
  });
});

// ────────────────────────────────────────────────────────────────
// account_reentry_signal
// ────────────────────────────────────────────────────────────────

describe('D-139 P4 — account_reentry_signal topic registration', () => {
  it('topic resolves via isEnrichmentTopic', () => {
    expect(isEnrichmentTopic('account_reentry_signal')).toBe(true);
  });
  it('carries time_bound × scenario × historical lifecycle per § A.9.2b', () => {
    const def = ENRICHMENT_REGISTRY.account_reentry_signal;
    expect(def.temporal_class).toBe('time_bound');
    expect(def.identity_aggregation).toBe('scenario');
    expect(def.lifecycle_policy).toBe('historical');
  });
  it('valid_scopes covers HubSpot company + Salesforce account', () => {
    const def = ENRICHMENT_REGISTRY.account_reentry_signal;
    expect(def.valid_scopes).toEqual([HUBSPOT_COMPANY, SALESFORCE_ACCOUNT]);
  });
  it('value_schema validates well-formed value', () => {
    const def = ENRICHMENT_REGISTRY.account_reentry_signal;
    const v: AccountReentrySignalValue = {
      reentered: true,
      dormancy_days: 90,
      last_reentry_at: 1714867200000,
      cursor_at: 1714867200000,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('value_schema accepts not-reentered shape', () => {
    const def = ENRICHMENT_REGISTRY.account_reentry_signal;
    const v: AccountReentrySignalValue = {
      reentered: false,
      dormancy_days: 0,
      last_reentry_at: 0,
      cursor_at: 0,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('value_schema rejects negative dormancy_days', () => {
    const def = ENRICHMENT_REGISTRY.account_reentry_signal;
    expect(
      def.value_schema!({
        reentered: false,
        dormancy_days: -1,
        last_reentry_at: 0,
        cursor_at: 0,
      }).ok,
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// champion_deal_count
// ────────────────────────────────────────────────────────────────

describe('D-139 P4 — champion_deal_count topic registration', () => {
  it('topic resolves via isEnrichmentTopic', () => {
    expect(isEnrichmentTopic('champion_deal_count')).toBe(true);
  });
  it('carries aggregate_window × perspective × forward_only lifecycle per § A.9.2b', () => {
    const def = ENRICHMENT_REGISTRY.champion_deal_count;
    expect(def.temporal_class).toBe('aggregate_window');
    expect(def.identity_aggregation).toBe('perspective');
    expect(def.lifecycle_policy).toBe('forward_only');
  });
  it('valid_scopes covers HubSpot contact + Salesforce contact (contact scope)', () => {
    const def = ENRICHMENT_REGISTRY.champion_deal_count;
    expect(def.valid_scopes).toEqual([HUBSPOT_CONTACT, SALESFORCE_CONTACT]);
  });
  it('aggregates_from spans deal scopes + per-type engagement scopes (touched-deal walk)', () => {
    const def = ENRICHMENT_REGISTRY.champion_deal_count;
    const expected = [
      HUBSPOT_DEAL,
      SALESFORCE_OPP,
      ...PER_TYPE_ENGAGEMENTS,
    ];
    expect([...(def.aggregates_from ?? [])].sort()).toEqual(expected.sort());
  });
  it('declares identity_extractor for perspective fan-in (D-136 substrate)', () => {
    const def = ENRICHMENT_REGISTRY.champion_deal_count;
    expect(def.identity_extractor).toBeDefined();
  });
  it('aggregate window is 1y for win/loss patterns', () => {
    const def = ENRICHMENT_REGISTRY.champion_deal_count;
    expect(def.aggregate_window_ms).toBe(365 * 24 * 60 * 60 * 1000);
  });
  it('value_schema validates well-formed value', () => {
    const def = ENRICHMENT_REGISTRY.champion_deal_count;
    const v: ChampionDealCountValue = {
      total_deals: 5,
      won_deals: 3,
      lost_deals: 1,
      open_deals: 1,
      win_rate: 0.75,
      bucket: 'champion',
      cursor_at: 1714867200000,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('value_schema rejects win_rate > 1', () => {
    const def = ENRICHMENT_REGISTRY.champion_deal_count;
    expect(
      def.value_schema!({
        total_deals: 1,
        won_deals: 1,
        lost_deals: 0,
        open_deals: 0,
        win_rate: 1.5,
        bucket: 'champion',
        cursor_at: 0,
      }).ok,
    ).toBe(false);
  });
  it('CHAMPION_DEAL_BUCKETS enumerates champion / mixed / blocker / unknown', () => {
    expect([...CHAMPION_DEAL_BUCKETS].sort()).toEqual([
      'blocker',
      'champion',
      'mixed',
      'unknown',
    ]);
    const x: ChampionDealBucket = 'blocker';
    expect(CHAMPION_DEAL_BUCKETS).toContain(x);
  });
});

// ────────────────────────────────────────────────────────────────
// multi_account_contact
// ────────────────────────────────────────────────────────────────

describe('D-139 P4 — multi_account_contact topic registration', () => {
  it('topic resolves via isEnrichmentTopic', () => {
    expect(isEnrichmentTopic('multi_account_contact')).toBe(true);
  });
  it('carries time_bound × perspective × historical lifecycle per § A.9.2b', () => {
    const def = ENRICHMENT_REGISTRY.multi_account_contact;
    expect(def.temporal_class).toBe('time_bound');
    expect(def.identity_aggregation).toBe('perspective');
    expect(def.lifecycle_policy).toBe('historical');
  });
  it('valid_scopes covers HubSpot contact + Salesforce contact', () => {
    const def = ENRICHMENT_REGISTRY.multi_account_contact;
    expect(def.valid_scopes).toEqual([HUBSPOT_CONTACT, SALESFORCE_CONTACT]);
  });
  it('aggregates_from spans contact scopes + mail (job-change detection shape)', () => {
    const def = ENRICHMENT_REGISTRY.multi_account_contact;
    expect([...(def.aggregates_from ?? [])].sort()).toEqual(
      [HUBSPOT_CONTACT, SALESFORCE_CONTACT, 'mail'].sort(),
    );
  });
  it('declares identity_extractor for perspective fan-in (D-136 substrate)', () => {
    const def = ENRICHMENT_REGISTRY.multi_account_contact;
    expect(def.identity_extractor).toBeDefined();
  });
  it('value_schema validates well-formed value', () => {
    const def = ENRICHMENT_REGISTRY.multi_account_contact;
    const v: MultiAccountContactValue = {
      is_multi_account: true,
      mail_domain: 'newco.com',
      crm_company_domains: ['oldco.com'],
      cursor_at: 1714867200000,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('value_schema accepts null mail_domain (no professional mail observed)', () => {
    const def = ENRICHMENT_REGISTRY.multi_account_contact;
    const v: MultiAccountContactValue = {
      is_multi_account: false,
      mail_domain: null,
      crm_company_domains: [],
      cursor_at: 0,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('value_schema rejects non-array crm_company_domains', () => {
    const def = ENRICHMENT_REGISTRY.multi_account_contact;
    expect(
      def.value_schema!({
        is_multi_account: false,
        mail_domain: null,
        crm_company_domains: 'not-an-array' as unknown,
        cursor_at: 0,
      }).ok,
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Cross-topic invariants
// ────────────────────────────────────────────────────────────────

describe('D-139 P4 — cross-topic registry invariants', () => {
  const P4_TOPICS = [
    'meeting_to_followup_lag',
    'out_of_band_engagement',
    'account_engagement_breadth',
    'account_reentry_signal',
    'champion_deal_count',
    'multi_account_contact',
  ] as const;
  it('all 6 P4 topics declare populates_coverage = true', () => {
    for (const topic of P4_TOPICS) {
      const def = ENRICHMENT_REGISTRY[topic];
      expect(def.populates_coverage, `topic '${topic}' missing populates_coverage`).toBe(true);
    }
  });
  it('all 6 P4 topics ship trust default = auto + pool policy = free_only', () => {
    for (const topic of P4_TOPICS) {
      const def = ENRICHMENT_REGISTRY[topic];
      expect(def.default_trust_state).toBe('auto');
      expect(def.default_pool_policy).toBe('free_only');
    }
  });
  it('every P4 topic is policy = aggregate, and producer_kind tracks whether a producer is REGISTERED', () => {
    // ⛔ This asserted `producer_kind === 'reactive'` for all six until
    // slice 3 (2026-09-09), when two of them gained registered housekeeping
    // producers. Splitting the set rather than relaxing the assertion is
    // deliberate: `producer_kind` drives which execution mode owns the topic
    // AND how Settings → Housekeeping renders it (a reactive row shows
    // "live, N events processed" and offers no Run-Now), so a topic that a
    // housekeeping task now produces must not still claim `'reactive'`.
    //
    // ⚠ THE FOUR BELOW ARE STILL `'reactive'` AND STILL HAVE NO PRODUCER OF
    // ANY KIND. Their kernels exist and are tested but do not fit the
    // record-aggregate shell: three need a projected row type
    // (`account_engagement_breadth`, `champion_deal_count`,
    // `multi_account_contact`) and one needs cross-source input
    // (`out_of_band_engagement`). This list shrinking is the progress
    // marker — when it empties, the reactive lane is gone.
    const PRODUCED_BY_HOUSEKEEPING = [
      'meeting_to_followup_lag',
      'account_reentry_signal',
      'account_engagement_breadth',
      'champion_deal_count',
      'multi_account_contact',
      // Landed last of the three shells, and only after its quadruple
      // fallback got a join key at all (`meta.subject_hash`, ec8f55872) —
      // wiring it before that would have shipped a producer whose headline
      // claim was false by construction.
      'out_of_band_engagement',
    ];
    // 🏁 EMPTY. Every P4 topic now has a registered producer — the last
    // three landed on `_record-projected-task.ts`, whose only addition over
    // the deterministic shell is a `project` seam between resolving a
    // record's engagements and running its kernel.
    //
    // ⛔ KEEP THE ASSERTION EVEN AT ZERO. Its job is not to hold a list, it
    // is to make `producer_kind` and "is there a producer" agree — a future
    // topic added as `'reactive'` with no producer belongs here, and an
    // empty array is the state that says the reactive lane is gone rather
    // than merely untracked.
    const STILL_UNPRODUCED: string[] = [];
    expect([...PRODUCED_BY_HOUSEKEEPING, ...STILL_UNPRODUCED].sort())
      .toEqual([...P4_TOPICS].sort());

    for (const topic of P4_TOPICS) {
      const def = ENRICHMENT_REGISTRY[topic];
      expect(def.policy, topic).toBe('aggregate');
    }
    for (const topic of PRODUCED_BY_HOUSEKEEPING) {
      expect(ENRICHMENT_REGISTRY[topic as keyof typeof ENRICHMENT_REGISTRY].producer_kind, topic)
        .toBe('housekeeping');
    }
    for (const topic of STILL_UNPRODUCED) {
      expect(ENRICHMENT_REGISTRY[topic as keyof typeof ENRICHMENT_REGISTRY].producer_kind, topic)
        .toBe('reactive');
    }
  });
  it('all 6 P4 topics declare compression_class = derived (deterministic counts/buckets)', () => {
    for (const topic of P4_TOPICS) {
      const def = ENRICHMENT_REGISTRY[topic];
      expect(def.compression_class).toBe('derived');
    }
  });
});
