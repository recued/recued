/** D-136 P3 follow-up — universal `window_ms` stamping (§A.10).
 *
 *  Locks two invariants for the 8 retrofitted topics:
 *
 *  1. The registry entry carries `aggregate_window_ms` so pack-install
 *     and user overrides have a default to widen / narrow against
 *     (audit §25.1 — only the 3 connection_* topics exposed it before
 *     P3 follow-up).
 *  2. Each topic's `value_schema` requires `window_ms: number` —
 *     producers must stamp it on every row so consumers can
 *     interpret the windowed signal across cross-industry overrides.
 *
 *  Field renames (audit §25.6) are validated as part of the same
 *  schema check — a stale `mail_count_30d` literal raises
 *  `field 'mail_count_window' failed validation`.
 *
 *  `thread_signals` is intentionally excluded from the retrofit list:
 *  its producer folds every mail sharing `thread_id` (per-thread
 *  aggregate, not per-time-window). The audit §25.1 "24h window" cell
 *  was a guess about the topic's design that the producer code never
 *  honored — Codex review of the P3 follow-up flagged the false claim
 *  + the missing concrete schema. P3 follow-up landed both fixes:
 *  registry `aggregate_window_ms` removed for thread_signals; concrete
 *  `ThreadSignalsSchema` replaces `acceptObject`.
 *
 *  Spec: `docs/d-136-spec.md` §A.10. */

import { describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type EnrichmentDefinition,
  type EnrichmentTopic,
} from '../index.js';

const RETROFIT_TOPICS: ReadonlyArray<EnrichmentTopic> = [
  'behavioral_signature',
  'reply_patterns',
  'meeting_frequency',
  'attendee_patterns',
  'meeting_reschedule_pattern',
  'contact_timeline_rollup',
  'calendar_event_rollup',
  'topic_cluster',
];

describe('D-136 P3 follow-up — aggregate_window_ms registry coverage', () => {
  it.each(RETROFIT_TOPICS)('%s declares aggregate_window_ms', (topic) => {
    const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
    expect(typeof def.aggregate_window_ms).toBe('number');
    expect(def.aggregate_window_ms).toBeGreaterThan(0);
  });

  it('the audit §25.6 renamed-field topics carry the renamed fields', () => {
    // behavioral_signature keeps mail_count_window / meeting_count_window
    const sig = ENRICHMENT_REGISTRY.behavioral_signature.value_schema({
      mail_count_window: 5,
      mail_count_total: 20,
      meeting_count_window: 1,
      meeting_count_total: 4,
      mean_reply_latency_ms: null,
      reply_sample_count: 0,
      last_meeting_at: null,
      last_inbound_at: null,
      computed_at: 1_700_000_000_000,
      window_ms: 30 * 24 * 60 * 60 * 1000,
    });
    expect(sig.ok).toBe(true);

    // reply_patterns keeps inbound_count_window / reply_sample_count_window / reply_rate_window
    const rp = ENRICHMENT_REGISTRY.reply_patterns.value_schema({
      inbound_count_window: 10,
      reply_sample_count_window: 6,
      reply_rate_window: 0.6,
      reply_sample_count: 12,
      mean_reply_latency_ms: null,
      p50_reply_latency_ms: null,
      p95_reply_latency_ms: null,
      computed_at: 1_700_000_000_000,
      window_ms: 30 * 24 * 60 * 60 * 1000,
    });
    expect(rp.ok).toBe(true);

    // meeting_frequency keeps events_window_short / events_window_long / per_week_window_short / per_month_window_long
    const mf = ENRICHMENT_REGISTRY.meeting_frequency.value_schema({
      events_total: 10,
      events_window_short: 3,
      events_window_long: 7,
      per_week_window_short: 0.7,
      per_month_window_long: 2.33,
      trend: 'stable',
      last_event_at: null,
      computed_at: 1_700_000_000_000,
      window_ms: 30 * 24 * 60 * 60 * 1000,
    });
    expect(mf.ok).toBe(true);

    // attendee_patterns keeps events_window
    const ap = ENRICHMENT_REGISTRY.attendee_patterns.value_schema({
      events_total: 5,
      events_window: 4,
      top_co_attendees: [],
      last_event_at: null,
      computed_at: 1_700_000_000_000,
      window_ms: 90 * 24 * 60 * 60 * 1000,
    });
    expect(ap.ok).toBe(true);
  });

  it('rejects legacy field names (audit §25.6 clean rename — pre-launch zero installs)', () => {
    const sig = ENRICHMENT_REGISTRY.behavioral_signature.value_schema({
      mail_count_30d: 5, // legacy name
      mail_count_total: 20,
      meeting_count_30d: 1, // legacy name
      meeting_count_total: 4,
      mean_reply_latency_ms: null,
      reply_sample_count: 0,
      last_meeting_at: null,
      last_inbound_at: null,
      computed_at: 1_700_000_000_000,
      window_ms: 30 * 24 * 60 * 60 * 1000,
    });
    expect(sig.ok).toBe(false);
    if (!sig.ok) {
      const issues = sig.issues.join(' ');
      expect(issues).toContain('mail_count_window');
      expect(issues).toContain('meeting_count_window');
    }
  });
});

describe('D-136 P3 follow-up — window_ms required in every retrofit value schema', () => {
  it('contact_timeline_rollup rejects a value missing window_ms', () => {
    const result = ENRICHMENT_REGISTRY.contact_timeline_rollup.value_schema({
      interaction_count: 4,
      last_interaction: 1_700_000_000_000,
      recent_subjects: [],
      cursor_at: 1_700_000_000_000,
      // window_ms intentionally omitted
    });
    expect(result.ok).toBe(false);
  });

  it('calendar_event_rollup rejects a value missing window_ms', () => {
    const result = ENRICHMENT_REGISTRY.calendar_event_rollup.value_schema({
      brief: 'meeting brief',
      attendees: [],
      related_thread_ids: [],
      generated_at: 1_700_000_000_000,
      // window_ms intentionally omitted
    });
    expect(result.ok).toBe(false);
  });

  it('meeting_reschedule_pattern rejects a value missing window_ms', () => {
    const result = ENRICHMENT_REGISTRY.meeting_reschedule_pattern.value_schema({
      reschedule_count: 1,
      recent_at: [1, 2, 3],
      cursor_at: 1_700_000_000_000,
      // window_ms intentionally omitted
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(' ')).toContain('window_ms');
    }
  });

  it('topic_cluster rejects a value missing window_ms', () => {
    const result = ENRICHMENT_REGISTRY.topic_cluster.value_schema({
      topic_name: 'Test',
      summary: 'test cluster',
      members: ['m1', 'm2'],
      thread_ids: ['t1'],
      theme_tokens: ['test'],
      thread_count: 2,
      ai_invoked: true,
      computed_at: 1_700_000_000_000,
      // window_ms intentionally omitted
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(' ')).toContain('window_ms');
    }
  });
});

describe('D-136 P3 follow-up — thread_signals exception (Codex review fix)', () => {
  it('thread_signals registry entry omits aggregate_window_ms', () => {
    const def = ENRICHMENT_REGISTRY.thread_signals as EnrichmentDefinition;
    expect(def.aggregate_window_ms).toBeUndefined();
  });

  it('thread_signals value_schema is concrete (not acceptObject — Codex item 3 fix)', () => {
    const def = ENRICHMENT_REGISTRY.thread_signals as EnrichmentDefinition;
    // A well-formed value passes
    const ok = def.value_schema({
      thread_id: 't-1',
      message_count: 3,
      participant_count: 4,
      span_days: 2,
      has_unread: true,
    });
    expect(ok.ok).toBe(true);

    // Missing required field fails — proves schema is not acceptObject
    const missingField = def.value_schema({
      thread_id: 't-1',
      message_count: 3,
      participant_count: 4,
      // span_days omitted
      has_unread: true,
    });
    expect(missingField.ok).toBe(false);

    // Wrong type on participant_count fails
    const wrongType = def.value_schema({
      thread_id: 't-1',
      message_count: 3,
      participant_count: 'four',
      span_days: 2,
      has_unread: true,
    });
    expect(wrongType.ok).toBe(false);

    // Non-object fails
    const nonObject = def.value_schema('not-a-thread-signals');
    expect(nonObject.ok).toBe(false);
  });

  it('thread_signals value omits window_ms (per-thread aggregate, not windowed)', () => {
    const def = ENRICHMENT_REGISTRY.thread_signals as EnrichmentDefinition;
    // Schema accepts a value WITHOUT window_ms
    const result = def.value_schema({
      thread_id: 't-1',
      message_count: 3,
      participant_count: 4,
      span_days: 2,
      has_unread: true,
    });
    expect(result.ok).toBe(true);
  });
});
