/** D-136 P3 follow-up — `compression_class` + `prompt_bias_hints`
 *  registry annotations (§A.14.2 + §A.14.3).
 *
 *  Locks the per-topic compression-class assignment + the
 *  `prompt_bias_hints` shape rule. Surfaces in `registry.describe`
 *  in P7; P3 follow-up just lands the annotation + validator gate. */

import { describe, expect, it } from 'vitest';

import {
  ALL_COMPRESSION_CLASSES,
  ENRICHMENT_REGISTRY,
  PROMPT_BIAS_HINT_RE,
  validateLifecycleDefinition,
  type CompressionClass,
  type EnrichmentDefinition,
  type EnrichmentTopic,
} from '../index.js';

describe('D-136 P3 follow-up — compression_class registry coverage', () => {
  it('every registered topic declares a closed-list compression_class', () => {
    for (const [topic, def] of Object.entries(ENRICHMENT_REGISTRY)) {
      expect(
        ALL_COMPRESSION_CLASSES,
        `topic '${topic}' compression_class must be one of ${ALL_COMPRESSION_CLASSES.join(', ')}`,
      ).toContain((def as EnrichmentDefinition).compression_class);
    }
  });

  it('lossy / lossless / derived counts match the §A.14.2 P3 retrofit table', () => {
    const counts: Record<CompressionClass, number> = {
      lossless: 0,
      lossy: 0,
      derived: 0,
    };
    for (const def of Object.values(ENRICHMENT_REGISTRY)) {
      counts[(def as EnrichmentDefinition).compression_class] += 1;
    }
    // Per §A.14.2 P3 retrofit (registry now 62 topics post-D-145 PA9
    // — D-139 P1a.1 canary + 3 from P3 deterministic + 6 from P4
    // cross-entity + 2 from P5 AI-surface canaries + 1 from P6.B
    // post-substrate canary + 15 from D-145 PA9 work-entity / engine
    // + reliability producers, all `compression_class: 'derived'`):
    //   lossy:    purpose, summary, action_items, preparation_notes,
    //             topic_cluster, calendar_event_rollup,
    //             engagement_sentiment_trend (D-139 P5 — tone bucket
    //             compresses tonal evidence into closed enum + score)
    //   lossless: embedding, attribution_signal, working_group
    //   derived:  everything else (51 — D-172 P6 added caption /
    //             extracted_text / transcript, all derived; D-139 P5 added next_best_action;
    //             D-139 P6.B added commitment_tracker; D-145 PA9 adds
    //             15 producers all carrying scalar / count / closed-list
    //             outputs (derived per §A.14.2 — neither lossless nor
    //             narrative-lossy)).
    expect(counts).toEqual({ lossless: 3, lossy: 7, derived: 51 });
  });

  it('lossy topics are exactly the §A.14.2 retrofit list', () => {
    const lossy = (Object.entries(ENRICHMENT_REGISTRY) as Array<[EnrichmentTopic, EnrichmentDefinition]>)
      .filter(([, def]) => def.compression_class === 'lossy')
      .map(([topic]) => topic)
      .sort();
    expect(lossy).toEqual([
      'action_items',
      'calendar_event_rollup',
      'engagement_sentiment_trend',
      'preparation_notes',
      'purpose',
      'summary',
      'topic_cluster',
    ]);
  });

  it('lossless topics are exactly the §A.14.2 retrofit list', () => {
    const lossless = (Object.entries(ENRICHMENT_REGISTRY) as Array<[EnrichmentTopic, EnrichmentDefinition]>)
      .filter(([, def]) => def.compression_class === 'lossless')
      .map(([topic]) => topic)
      .sort();
    expect(lossless).toEqual([
      'attribution_signal',
      'embedding',
      'working_group',
    ]);
  });
});

describe('D-136 P3 follow-up — prompt_bias_hints shape', () => {
  it('PROMPT_BIAS_HINT_RE accepts lowercase ASCII underscore-separated words', () => {
    expect(PROMPT_BIAS_HINT_RE.test('caps_output_at_250_words')).toBe(true);
    expect(PROMPT_BIAS_HINT_RE.test('closed_set_classification_no_hybrid_intent')).toBe(true);
    expect(PROMPT_BIAS_HINT_RE.test('a')).toBe(true);
    expect(PROMPT_BIAS_HINT_RE.test('foo_bar_2')).toBe(true);
  });

  it('PROMPT_BIAS_HINT_RE rejects whitespace / punctuation / casing', () => {
    expect(PROMPT_BIAS_HINT_RE.test('Caps_Output')).toBe(false);
    expect(PROMPT_BIAS_HINT_RE.test('caps output')).toBe(false);
    expect(PROMPT_BIAS_HINT_RE.test('caps-output')).toBe(false);
    expect(PROMPT_BIAS_HINT_RE.test('_leading_underscore')).toBe(false);
    expect(PROMPT_BIAS_HINT_RE.test('trailing_underscore_')).toBe(false);
    expect(PROMPT_BIAS_HINT_RE.test('double__underscore')).toBe(false);
    expect(PROMPT_BIAS_HINT_RE.test('')).toBe(false);
  });

  it('every prompt_bias_hints entry on registered topics matches PROMPT_BIAS_HINT_RE', () => {
    for (const [topic, def] of Object.entries(ENRICHMENT_REGISTRY)) {
      const hints = (def as EnrichmentDefinition).prompt_bias_hints;
      if (!hints) continue;
      for (const hint of hints) {
        expect(PROMPT_BIAS_HINT_RE.test(hint), `topic '${topic}' hint '${hint}' is malformed`).toBe(true);
      }
    }
  });

  it('the AI-surface producer set declaring prompt_bias_hints is exactly the §A.14.3 list', () => {
    const declaring = (Object.entries(ENRICHMENT_REGISTRY) as Array<[EnrichmentTopic, EnrichmentDefinition]>)
      .filter(([, def]) => def.prompt_bias_hints !== undefined)
      .map(([topic]) => topic)
      .sort();
    expect(declaring).toEqual([
      'action_items',
      'caption',
      'commitment_tracker',
      'company',
      'deal_health_score',
      'engagement_sentiment_trend',
      'extracted_text',
      'lifecycle_stage_inferred',
      'lifecycle_stage_inferred_salesforce',
      'next_best_action',
      'preparation_notes',
      'purpose',
      'role',
      'summary',
      'topic_cluster',
      'transcript',
    ]);
  });
});

describe('D-136 P3 follow-up — validator gates 9 + 10', () => {
  const baseStableTruth: EnrichmentDefinition = {
    shape: 'per_record',
    valid_scopes: ['mail'],
    policy: 'dependent',
    producer_kind: 'housekeeping',
    value_schema: () => ({ ok: true, value: {} }),
    sidecar: 'none',
    temporal_class: 'stable_truth',
    identity_aggregation: 'scenario',
    lifecycle_policy: 'recompute_on_drift',
    compression_class: 'derived',
    name: 'Test',
    description: 'Test',
    user_value: 'Test',
  };

  it('Gate 9 — missing compression_class fails', () => {
    const def = { ...baseStableTruth };
    // @ts-expect-error — exercise runtime gate by clearing required field
    delete def.compression_class;
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes('compression_class'))).toBe(true);
  });

  it('Gate 9 — invalid compression_class value fails', () => {
    const def = { ...baseStableTruth, compression_class: 'opaque' as unknown as CompressionClass };
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes('compression_class'))).toBe(true);
  });

  it('Gate 10 — malformed prompt_bias_hints entry fails (uppercase)', () => {
    const def: EnrichmentDefinition = {
      ...baseStableTruth,
      prompt_bias_hints: ['CamelCaseHint'],
    };
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes('prompt_bias_hints'))).toBe(true);
  });

  it('Gate 10 — empty prompt_bias_hints array fails (omit instead)', () => {
    const def: EnrichmentDefinition = {
      ...baseStableTruth,
      prompt_bias_hints: [],
    };
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.some((i) => i.includes('empty prompt_bias_hints'))).toBe(true);
  });

  it('Gate 10 — well-formed prompt_bias_hints passes', () => {
    const def: EnrichmentDefinition = {
      ...baseStableTruth,
      prompt_bias_hints: ['caps_output_at_250_words'],
    };
    const issues = validateLifecycleDefinition('test', def);
    expect(issues.filter((i) => i.includes('prompt_bias_hints'))).toEqual([]);
  });

  it('Every registered topic passes all 10 gates', () => {
    for (const [topic, def] of Object.entries(ENRICHMENT_REGISTRY)) {
      const issues = validateLifecycleDefinition(topic, def as EnrichmentDefinition);
      expect(issues, `topic '${topic}' failed lifecycle validation: ${issues.join('; ')}`).toEqual([]);
    }
  });
});
