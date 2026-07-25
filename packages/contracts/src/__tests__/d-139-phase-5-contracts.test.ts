/** D-139 Phase 5 — contracts smoke tests for the AI-surface canary
 *  enrichment registry entries + value schemas + evidence-quality
 *  consumption-default annotations.
 *
 *  Covers:
 *    - Two new topic registrations (engagement_sentiment_trend +
 *      next_best_action).
 *    - Each topic declares the full Pass-4 D-136 substrate
 *      annotations (temporal_class × identity_aggregation ×
 *      lifecycle_policy + compression_class + producer_kind +
 *      default_trust_state + default_pool_policy + valid_scopes +
 *      aggregates_from listing all per-type engagement scopes).
 *    - P5 substrate widening — `body_state_acceptance` /
 *      `authorship_acceptance` / `lifecycle_state_acceptance` /
 *      `dedupe_acceptance` declared per topic per Pass-4
 *      consumption defaults (§ A.3.2 + § A.3.5 + § A.3.6 + § A.3).
 *    - Manual-trust default per D-132 (registered topics carry
 *      `default_trust_state: 'manual'`).
 *    - Value schemas validator-pass on canonical inputs and reject
 *      malformed shapes per the per-field contracts.
 *    - Closed-list exports for tone + action enums.
 *    - Output value-shape body-text safety — registry validator
 *      rejects body-shaped strings (long key_phrases tokens,
 *      over-long rationale).
 *
 *  Spec: docs/d-139-spec.md § A.9.2 + § A.9.5 + § P5 acceptance. */

import { describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  ENGAGEMENT_SENTIMENT_TONES,
  ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASES,
  ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASE_CHARS,
  NEXT_BEST_ACTIONS,
  NEXT_BEST_ACTION_MAX_RATIONALE_CHARS,
  isEnrichmentTopic,
  type EngagementSentimentTone,
  type EngagementSentimentTrendValue,
  type NextBestAction,
  type NextBestActionValue,
} from '../index.js';

const HUBSPOT_DEAL = 'connection.api.hubspot.deal' as const;
const SALESFORCE_OPP = 'connection.api.salesforce.opportunity' as const;

const FULL_AGGREGATES_FROM = [
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
// engagement_sentiment_trend
// ────────────────────────────────────────────────────────────────

describe('D-139 P5 — engagement_sentiment_trend topic registration', () => {
  it('topic resolves via isEnrichmentTopic', () => {
    expect(isEnrichmentTopic('engagement_sentiment_trend')).toBe(true);
  });
  it('carries aggregate_window × scenario × forward_only lifecycle per § A.9.2', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    expect(def).toBeDefined();
    expect(def.temporal_class).toBe('aggregate_window');
    expect(def.identity_aggregation).toBe('scenario');
    expect(def.lifecycle_policy).toBe('forward_only');
  });
  it('valid_scopes covers HubSpot deal + Salesforce opportunity', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    expect(def.valid_scopes).toEqual([HUBSPOT_DEAL, SALESFORCE_OPP]);
  });
  it('aggregates_from enumerates all per-type engagement scopes', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    expect([...(def.aggregates_from ?? [])].sort()).toEqual(
      [...FULL_AGGREGATES_FROM].sort(),
    );
  });
  it('default trust state = manual per D-132 (AI-surface)', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    expect(def.default_trust_state).toBe('manual');
  });
  it('default pool policy = free_only per P5 spec', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    expect(def.default_pool_policy).toBe('free_only');
  });
  it('aggregate window is 60d + axis event_time + composition aggregate_window_fold', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    expect(def.aggregate_window_axis).toBe('event_time');
    expect(def.aggregate_window_ms).toBe(60 * 24 * 60 * 60 * 1000);
    expect(def.inputFingerprintComposition).toBe('aggregate_window_fold');
  });
  it('compression_class = lossy (closed-bucket tone read compresses tonal evidence)', () => {
    expect(ENRICHMENT_REGISTRY.engagement_sentiment_trend.compression_class).toBe('lossy');
  });
  it('populates_coverage = true per § A.9.3', () => {
    expect(ENRICHMENT_REGISTRY.engagement_sentiment_trend.populates_coverage).toBe(true);
  });
  it('declares prompt_bias_hints per § A.14.3', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    expect(def.prompt_bias_hints).toBeDefined();
    expect(def.prompt_bias_hints!.length).toBeGreaterThan(0);
  });
  it('body_state_acceptance accepts truncated_inline (tone-from-preview is partial-but-useful)', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    expect(def.body_state_acceptance).toBeDefined();
    expect([...(def.body_state_acceptance ?? [])].sort()).toEqual([
      'calendar_link',
      'inline_body',
      'mail_link',
      'truncated_inline',
    ]);
  });
  it('authorship_acceptance excludes crm_automation + system_process per Pass-4', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    expect(def.authorship_acceptance).toBeDefined();
    const accept = new Set<string>(def.authorship_acceptance);
    expect(accept.has('crm_automation')).toBe(false);
    expect(accept.has('system_process')).toBe(false);
    expect(accept.has('user')).toBe(true);
    expect(accept.has('crm_user')).toBe(true);
    expect(accept.has('unknown')).toBe(true);
  });
  it('lifecycle_state_acceptance is exact_only evidence states per Pass-4', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    expect([...(def.lifecycle_state_acceptance ?? [])].sort()).toEqual([
      'completed',
      'point_in_time',
    ]);
  });
  it('dedupe_acceptance = exact_only per Pass-4 (probable twins counted separately)', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    expect(def.dedupe_acceptance).toBe('exact_only');
  });

  // ── Value schema ──────────────────────────────────────────────
  it('value_schema validates a well-formed value', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    const v: EngagementSentimentTrendValue = {
      tone: 'warming',
      score: 0.6,
      key_phrases: ['fast_replies', 'positive_phrasing'],
      samples: 12,
      cursor_at: 1714867200000,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('value_schema rejects unknown tone + score outside [-1, 1]', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    expect(def.value_schema!({ tone: 'glowing', score: 0, key_phrases: [], samples: 0, cursor_at: 0 }).ok).toBe(false);
    expect(def.value_schema!({ tone: 'steady', score: 1.5, key_phrases: [], samples: 0, cursor_at: 0 }).ok).toBe(false);
    expect(def.value_schema!({ tone: 'steady', score: -1.1, key_phrases: [], samples: 0, cursor_at: 0 }).ok).toBe(false);
  });
  it('value_schema rejects body-shaped key_phrases (over-long tokens)', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    const longBodyToken = 'a'.repeat(ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASE_CHARS + 1);
    const result = def.value_schema!({
      tone: 'cooling',
      score: -0.5,
      key_phrases: [longBodyToken],
      samples: 5,
      cursor_at: 1,
    });
    expect(result.ok).toBe(false);
  });
  it('value_schema rejects key_phrases array beyond cap', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    const tooMany = Array.from({ length: ENGAGEMENT_SENTIMENT_MAX_KEY_PHRASES + 1 }, (_, i) => `tok${i}`);
    const result = def.value_schema!({
      tone: 'cooling',
      score: -0.5,
      key_phrases: tooMany,
      samples: 5,
      cursor_at: 1,
    });
    expect(result.ok).toBe(false);
  });
  it('value_schema rejects negative samples + negative cursor_at', () => {
    const def = ENRICHMENT_REGISTRY.engagement_sentiment_trend;
    expect(def.value_schema!({ tone: 'steady', score: 0, key_phrases: [], samples: -1, cursor_at: 0 }).ok).toBe(false);
    expect(def.value_schema!({ tone: 'steady', score: 0, key_phrases: [], samples: 0, cursor_at: -1 }).ok).toBe(false);
  });
  it('ENGAGEMENT_SENTIMENT_TONES enumerates closed bucket', () => {
    expect([...ENGAGEMENT_SENTIMENT_TONES].sort()).toEqual([
      'cooling',
      'insufficient_signal',
      'steady',
      'volatile',
      'warming',
    ]);
    const x: EngagementSentimentTone = 'steady';
    expect(ENGAGEMENT_SENTIMENT_TONES).toContain(x);
  });
});

// ────────────────────────────────────────────────────────────────
// next_best_action
// ────────────────────────────────────────────────────────────────

describe('D-139 P5 — next_best_action topic registration', () => {
  it('topic resolves via isEnrichmentTopic', () => {
    expect(isEnrichmentTopic('next_best_action')).toBe(true);
  });
  it('carries time_bound × scenario × historical lifecycle per § A.9.2', () => {
    const def = ENRICHMENT_REGISTRY.next_best_action;
    expect(def).toBeDefined();
    expect(def.temporal_class).toBe('time_bound');
    expect(def.identity_aggregation).toBe('scenario');
    expect(def.lifecycle_policy).toBe('historical');
  });
  it('valid_scopes covers HubSpot deal + Salesforce opportunity', () => {
    const def = ENRICHMENT_REGISTRY.next_best_action;
    expect(def.valid_scopes).toEqual([HUBSPOT_DEAL, SALESFORCE_OPP]);
  });
  it('aggregates_from enumerates all per-type engagement scopes', () => {
    const def = ENRICHMENT_REGISTRY.next_best_action;
    expect([...(def.aggregates_from ?? [])].sort()).toEqual(
      [...FULL_AGGREGATES_FROM].sort(),
    );
  });
  it('default trust state = manual per D-132 (AI-surface)', () => {
    expect(ENRICHMENT_REGISTRY.next_best_action.default_trust_state).toBe('manual');
  });
  it('default pool policy = free_only per P5 spec', () => {
    expect(ENRICHMENT_REGISTRY.next_best_action.default_pool_policy).toBe('free_only');
  });
  it('aggregate_window_ms = 60d for fingerprint composition', () => {
    expect(ENRICHMENT_REGISTRY.next_best_action.aggregate_window_ms).toBe(
      60 * 24 * 60 * 60 * 1000,
    );
    expect(ENRICHMENT_REGISTRY.next_best_action.inputFingerprintComposition).toBe('aggregate_window_fold');
  });
  it('as_of_field = computed_at per § A.9.2 lifecycle', () => {
    expect(ENRICHMENT_REGISTRY.next_best_action.as_of_field).toBe('computed_at');
  });
  it('compression_class = derived (closed action enum + scalar confidence)', () => {
    expect(ENRICHMENT_REGISTRY.next_best_action.compression_class).toBe('derived');
  });
  it('populates_coverage = true per § A.9.3', () => {
    expect(ENRICHMENT_REGISTRY.next_best_action.populates_coverage).toBe(true);
  });
  it('declares prompt_bias_hints per § A.14.3', () => {
    const def = ENRICHMENT_REGISTRY.next_best_action;
    expect(def.prompt_bias_hints).toBeDefined();
    expect(def.prompt_bias_hints!.length).toBeGreaterThan(0);
  });
  it('body_state_acceptance EXCLUDES truncated_inline (NBA needs full body context)', () => {
    const def = ENRICHMENT_REGISTRY.next_best_action;
    expect(def.body_state_acceptance).toBeDefined();
    expect([...(def.body_state_acceptance ?? [])].sort()).toEqual([
      'calendar_link',
      'inline_body',
      'mail_link',
    ]);
    // Tighter than sentiment — NBA rejects truncated_inline.
    expect(def.body_state_acceptance).not.toContain('truncated_inline');
  });
  it('authorship_acceptance excludes crm_automation + system_process per Pass-4', () => {
    const def = ENRICHMENT_REGISTRY.next_best_action;
    const accept = new Set<string>(def.authorship_acceptance);
    expect(accept.has('crm_automation')).toBe(false);
    expect(accept.has('system_process')).toBe(false);
    expect(accept.has('user')).toBe(true);
  });
  it('lifecycle_state_acceptance is exact_only evidence states', () => {
    const def = ENRICHMENT_REGISTRY.next_best_action;
    expect([...(def.lifecycle_state_acceptance ?? [])].sort()).toEqual([
      'completed',
      'point_in_time',
    ]);
  });
  it('dedupe_acceptance = exact_only', () => {
    expect(ENRICHMENT_REGISTRY.next_best_action.dedupe_acceptance).toBe('exact_only');
  });

  // ── Value schema ──────────────────────────────────────────────
  it('value_schema validates a well-formed value', () => {
    const def = ENRICHMENT_REGISTRY.next_best_action;
    const v: NextBestActionValue = {
      action: 'send_email',
      confidence: 0.7,
      rationale: 'Last touch was a question that the rep has not replied to in 4 days.',
      samples: 8,
      valid_until_at: 1714867200000 + 24 * 60 * 60 * 1000,
      computed_at: 1714867200000,
      cursor_at: 1714867200000,
    };
    expect(def.value_schema!(v).ok).toBe(true);
  });
  it('value_schema rejects unknown action + confidence outside [0, 1]', () => {
    const def = ENRICHMENT_REGISTRY.next_best_action;
    expect(def.value_schema!({ action: 'cold_call', confidence: 0.5, rationale: '', samples: 0, valid_until_at: 0, computed_at: 0, cursor_at: 0 }).ok).toBe(false);
    expect(def.value_schema!({ action: 'wait', confidence: 1.5, rationale: '', samples: 0, valid_until_at: 0, computed_at: 0, cursor_at: 0 }).ok).toBe(false);
    expect(def.value_schema!({ action: 'wait', confidence: -0.5, rationale: '', samples: 0, valid_until_at: 0, computed_at: 0, cursor_at: 0 }).ok).toBe(false);
  });
  it('value_schema rejects body-shaped rationale (over the char cap)', () => {
    const def = ENRICHMENT_REGISTRY.next_best_action;
    const longRationale = 'r'.repeat(NEXT_BEST_ACTION_MAX_RATIONALE_CHARS + 1);
    const result = def.value_schema!({
      action: 'wait',
      confidence: 0.3,
      rationale: longRationale,
      samples: 1,
      valid_until_at: 1,
      computed_at: 1,
      cursor_at: 1,
    });
    expect(result.ok).toBe(false);
  });
  it('value_schema rejects negative samples + computed_at + valid_until_at', () => {
    const def = ENRICHMENT_REGISTRY.next_best_action;
    expect(def.value_schema!({ action: 'wait', confidence: 0, rationale: '', samples: -1, valid_until_at: 0, computed_at: 0, cursor_at: 0 }).ok).toBe(false);
    expect(def.value_schema!({ action: 'wait', confidence: 0, rationale: '', samples: 0, valid_until_at: -1, computed_at: 0, cursor_at: 0 }).ok).toBe(false);
    expect(def.value_schema!({ action: 'wait', confidence: 0, rationale: '', samples: 0, valid_until_at: 0, computed_at: -1, cursor_at: 0 }).ok).toBe(false);
  });
  it('NEXT_BEST_ACTIONS enumerates closed action bucket', () => {
    expect([...NEXT_BEST_ACTIONS].sort()).toEqual([
      'escalate',
      'investigate',
      'no_action',
      'review_contact',
      'schedule_meeting',
      'send_email',
      'wait',
    ]);
    const x: NextBestAction = 'wait';
    expect(NEXT_BEST_ACTIONS).toContain(x);
  });
});

// ────────────────────────────────────────────────────────────────
// Cross-topic invariants
// ────────────────────────────────────────────────────────────────

describe('D-139 P5 — registry invariants across both AI-surface canaries', () => {
  it('both topics carry policy = aggregate (cascade fires on engagement events)', () => {
    expect(ENRICHMENT_REGISTRY.engagement_sentiment_trend.policy).toBe('aggregate');
    expect(ENRICHMENT_REGISTRY.next_best_action.policy).toBe('aggregate');
  });
  it('both topics carry producer_kind = reactive', () => {
    expect(ENRICHMENT_REGISTRY.engagement_sentiment_trend.producer_kind).toBe('reactive');
    expect(ENRICHMENT_REGISTRY.next_best_action.producer_kind).toBe('reactive');
  });
  it('both topics tagged department:sales', () => {
    expect(ENRICHMENT_REGISTRY.engagement_sentiment_trend.tags).toContain('department:sales');
    expect(ENRICHMENT_REGISTRY.next_best_action.tags).toContain('department:sales');
  });
  it('NBA body-state acceptance is a strict subset of sentiment\'s', () => {
    const sentimentStates = new Set(
      ENRICHMENT_REGISTRY.engagement_sentiment_trend.body_state_acceptance,
    );
    const nbaStates = ENRICHMENT_REGISTRY.next_best_action.body_state_acceptance ?? [];
    for (const state of nbaStates) {
      expect(sentimentStates.has(state)).toBe(true);
    }
    // Strictness — NBA rejects at least one body state sentiment accepts.
    expect(nbaStates.length).toBeLessThan(sentimentStates.size);
  });
});
