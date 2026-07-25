/** D-122 Phase 4.5 — enrichment-registry contract tests. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ENRICHMENT_REGISTRY,
  ALL_ENRICHMENT_POLICIES,
  ALL_ENRICHMENT_SIDECARS,
  enrichmentTopicsForScope,
  getEnrichmentDefinition,
  isEnrichmentTopic,
  type EnrichmentDefinition,
  type EnrichmentPolicy,
  type EnrichmentTopic,
} from '../enrichment-registry.js';

const ENRICHMENT_REGISTRY_SOURCE = new URL('../enrichment-registry.ts', import.meta.url);

describe('D-122 Phase 4.5 — enrichment registry contracts', () => {
  it('keeps the source file text-searchable', () => {
    const source = readFileSync(ENRICHMENT_REGISTRY_SOURCE);
    expect(source.indexOf(0)).toBe(-1);
  });

  it('reserves the three reactive producers shipped in D-122', () => {
    const reactive: EnrichmentTopic[] = [
      'contact_timeline_rollup',
      'calendar_event_rollup',
      'meeting_reschedule_pattern',
    ];
    for (const topic of reactive) {
      expect(ENRICHMENT_REGISTRY[topic]).toBeDefined();
      expect(ENRICHMENT_REGISTRY[topic].producer_kind).toBe('reactive');
    }
  });

  it('every entry tags producer_kind explicitly', () => {
    for (const topic of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
      const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
      expect(['reactive', 'housekeeping']).toContain(def.producer_kind);
    }
  });

  it('every entry declares a closed-set policy', () => {
    for (const topic of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
      const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
      expect(ALL_ENRICHMENT_POLICIES).toContain<EnrichmentPolicy>(def.policy);
    }
  });

  it('every Shape A entry declares valid_scopes', () => {
    for (const topic of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
      const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
      if (def.shape === 'per_record') {
        expect(def.valid_scopes).toBeDefined();
        expect(def.valid_scopes!.length).toBeGreaterThan(0);
      }
    }
  });

  it('every Shape B members_list entry declares members_field + members_scope', () => {
    for (const topic of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
      const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
      if (def.shape === 'derived_entity' && def.policy === 'members_list') {
        expect(def.members_field).toBe('members');
        expect(def.members_scope).toBeDefined();
      }
    }
  });

  it('every aggregate entry declares aggregates_from + recompute_cadence', () => {
    for (const topic of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
      const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
      if (def.policy === 'aggregate') {
        expect(def.aggregates_from).toBeDefined();
        expect(def.aggregates_from!.length).toBeGreaterThan(0);
        expect(def.recompute_cadence).toBeDefined();
      }
    }
  });

  it('every entry uses a sidecar from the closed enum', () => {
    for (const topic of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
      const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
      const sidecar = def.sidecar ?? 'none';
      expect(ALL_ENRICHMENT_SIDECARS).toContain(sidecar);
    }
  });

  it('isEnrichmentTopic narrows known topics', () => {
    expect(isEnrichmentTopic('contact_timeline_rollup')).toBe(true);
    expect(isEnrichmentTopic('topic_cluster')).toBe(true);
    expect(isEnrichmentTopic('not_a_real_topic')).toBe(false);
    expect(isEnrichmentTopic('')).toBe(false);
  });

  it('getEnrichmentDefinition throws for unknown topics', () => {
    expect(() => getEnrichmentDefinition('not_a_real_topic')).toThrow(/enrichment_topic_unknown/);
  });

  it('getEnrichmentDefinition returns the registered entry', () => {
    const def = getEnrichmentDefinition('calendar_event_rollup');
    expect(def.shape).toBe('per_record');
    expect(def.policy).toBe('dependent');
    expect(def.valid_scopes).toEqual(['calendar']);
  });

  it('enrichmentTopicsForScope returns Shape A topics matching the scope', () => {
    const mailTopics = enrichmentTopicsForScope('mail');
    expect(mailTopics).toContain('embedding');
    expect(mailTopics).toContain('summary');
    expect(mailTopics).not.toContain('contact_timeline_rollup'); // contact-only
    expect(mailTopics).not.toContain('topic_cluster'); // Shape B
  });

  it('enrichmentTopicsForScope omits Shape B entirely', () => {
    for (const scope of ['mail', 'contact', 'calendar', 'file'] as const) {
      const out = enrichmentTopicsForScope(scope);
      for (const topic of out) {
        const def = ENRICHMENT_REGISTRY[topic] as EnrichmentDefinition;
        expect(def.shape).toBe('per_record');
      }
    }
  });

  it('reserves D-172 file-enrichment topics over data.file', () => {
    const fileTopics: EnrichmentTopic[] = ['transcript', 'caption', 'extracted_text'];
    const scopedTopics = enrichmentTopicsForScope('file');
    for (const topic of fileTopics) {
      const def = getEnrichmentDefinition(topic);
      expect(scopedTopics).toContain(topic);
      expect(def.shape).toBe('per_record');
      expect(def.valid_scopes).toEqual(['file']);
      expect(def.policy).toBe('dependent');
      expect(def.producer_kind).toBe('housekeeping');
      expect(def.sidecar).toBe('none');
      expect(def.temporal_class).toBe('stable_truth');
      expect(def.identity_aggregation).toBe('scenario');
      expect(def.lifecycle_policy).toBe('forward_only');
      expect(def.default_trust_state).toBe('manual');
      expect(def.default_pool_policy).toBe('free_only');
    }
  });

  it('reactive value schemas accept well-formed values', () => {
    const def = getEnrichmentDefinition('contact_timeline_rollup');
    const result = def.value_schema({
      interaction_count: 12,
      last_interaction: 1_700_000_000_000,
      recent_subjects: ['hello', 'world'],
      cursor_at: 1_700_000_000_000,
      window_ms: 30 * 24 * 60 * 60 * 1000,
    });
    expect(result.ok).toBe(true);
  });

  it('reactive value schemas reject ill-formed values', () => {
    const def = getEnrichmentDefinition('contact_timeline_rollup');
    const result = def.value_schema({ interaction_count: 'twelve' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('meeting_reschedule_pattern accepts an optional reason field', () => {
    const def = getEnrichmentDefinition('meeting_reschedule_pattern');
    const ok = def.value_schema({
      reschedule_count: 4,
      recent_at: [1, 2, 3],
      cursor_at: 100,
      reason: 'frequent',
      window_ms: 90 * 24 * 60 * 60 * 1000,
    });
    expect(ok.ok).toBe(true);
  });

  it('D-172 file-enrichment value schemas accept conformant values and reject malformed values', () => {
    expect(
      getEnrichmentDefinition('transcript').value_schema({
        text: 'hello',
        language: 'en',
        duration_s: 1.5,
        model: 'transcribe-v1',
      }).ok,
    ).toBe(true);
    expect(getEnrichmentDefinition('transcript').value_schema({ text: 123 }).ok).toBe(false);

    expect(
      getEnrichmentDefinition('caption').value_schema({
        caption: 'A receipt on a desk.',
        model: 'vision-v1',
      }).ok,
    ).toBe(true);
    expect(getEnrichmentDefinition('caption').value_schema({ caption: ['bad'] }).ok).toBe(false);

    expect(
      getEnrichmentDefinition('extracted_text').value_schema({
        text: 'Invoice total: $42',
        page_count: 2,
        model: 'ocr-v1',
      }).ok,
    ).toBe(true);
    expect(
      getEnrichmentDefinition('extracted_text').value_schema({
        text: 'Invoice total: $42',
        page_count: 'two',
      }).ok,
    ).toBe(false);
  });

  it('reserved housekeeping topic IDs are present', () => {
    const reserved: EnrichmentTopic[] = [
      'thread_signals',
      'transcript',
      'caption',
      'extracted_text',
      'embedding',
      'purpose',
      'summary',
      'action_items',
      'behavioral_signature',
      'reply_patterns',
      'attendee_patterns',
      'meeting_frequency',
      'company',
      'role',
      'preparation_notes',
      'related_threads',
      'topic_cluster',
      'working_group',
      'organization',
      'semantic_cluster',
    ];
    for (const topic of reserved) {
      expect(ENRICHMENT_REGISTRY[topic]).toBeDefined();
    }
  });
});
