/** D-145 PA9 — `enrichment-declaration-complete.ratchet`.
 *
 *  Spec § A.7.5 / § PA9 acceptance — every D-145 producer carries the
 *  full declaration contract; missing fields hard-fail registry load.
 *  Per-class consistency rules:
 *    - `confidence_kind: 'emits_confidence'` requires
 *      `temporal_class IN ('aggregate_window', 'time_bound')` +
 *      `sample_floor ≥ 30` (PSI calibration baseline per D-133).
 *    - aggregate_window / time_bound producers must declare a window
 *      + an `event_time_field`.
 *    - snapshot / cumulative producers must declare `window: null`.
 *
 *  Closed-list discipline:
 *    - 15 D-145 producer topics enumerated in `D145_PRODUCER_TOPICS`.
 *    - 8 work-entity + 7 engine + reliability per spec § A.7.1 + § A.7.2.
 *    - 4 PSI-eligible producers enumerated in
 *      `D145_PSI_ELIGIBLE_PRODUCER_TOPICS` (matches `confidence_kind:
 *      'emits_confidence'` set on declarations + `emits_confidence: true`
 *      on registry entries).
 *    - 6 closed-list enums with their full membership locked. */

import { describe, expect, it } from 'vitest';

import {
  CONFIDENCE_KINDS,
  COVERAGE_POSTURES,
  D145_ENGINE_RELIABILITY_PRODUCER_TOPICS,
  D145_PRODUCER_DECLARATIONS,
  D145_PRODUCER_TOPICS,
  D145_PRODUCER_TOPIC_SET,
  D145_PSI_ELIGIBLE_PRODUCER_TOPICS,
  D145_WORK_ENTITY_PRODUCER_TOPICS,
  DECLARATION_IDENTITY_AGGREGATIONS,
  DECLARATION_PRODUCER_KINDS,
  DECLARATION_TEMPORAL_CLASSES,
  DECLARATION_WINDOW_KINDS,
  ENRICHMENT_REGISTRY,
  EnrichmentDeclarationError,
  PRIVACY_CLASSES,
  PSI_ELIGIBLE_TEMPORAL_CLASSES,
  PSI_SAMPLE_FLOOR_MINIMUM,
  assertD145ProducerDeclarations,
  assertEnrichmentDeclaration,
  isConfidenceKind,
  isCoveragePosture,
  isD145ProducerTopic,
  isD145PsiEligibleProducerTopic,
  isDeclarationIdentityAggregation,
  isDeclarationProducerKind,
  isDeclarationTemporalClass,
  isDeclarationWindowKind,
  isPrivacyClass,
  validateD145ProducerDeclarations,
  validateEnrichmentDeclaration,
  type EnrichmentDeclaration,
  type EnrichmentTopic,
} from '../index.js';

describe('D-145 PA9 — closed-list shape discipline', () => {
  it('D145_PRODUCER_TOPICS enumerates exactly 14 producers (8 work-entity + 6 engine + reliability)', () => {
    // ⛔ WAS 15 / 7 until 2026-09-10, when `context_packet_quality` was
    // retired from the declaration set. It was the only entry here with no
    // producer: a census of the 61 registry topics found 55 produced, and of
    // the 6 that were not, five are reserved registry ids (the deliberate
    // D-122 pattern) while this one carried a full `EnrichmentDeclaration`.
    //
    // 🔑 A declaration asserts `invalidation_triggers`, `benchmark_scenarios`,
    // a `sample_floor` and `emits_confidence` — all statements about a
    // producer's behaviour. Making them about a producer that does not exist
    // is what this ratchet's count was quietly protecting.
    expect(D145_PRODUCER_TOPICS).toHaveLength(14);
    expect(D145_WORK_ENTITY_PRODUCER_TOPICS).toHaveLength(8);
    expect(D145_ENGINE_RELIABILITY_PRODUCER_TOPICS).toHaveLength(6);
    expect([...D145_PRODUCER_TOPICS].sort()).toEqual([
      ...D145_WORK_ENTITY_PRODUCER_TOPICS,
      ...D145_ENGINE_RELIABILITY_PRODUCER_TOPICS,
    ].sort());
  });

  it('D145_PRODUCER_TOPIC_SET predicate matches the closed list exactly', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      expect(D145_PRODUCER_TOPIC_SET.has(topic)).toBe(true);
      expect(isD145ProducerTopic(topic)).toBe(true);
    }
    expect(isD145ProducerTopic('not_a_d145_topic')).toBe(false);
    expect(isD145ProducerTopic('purpose')).toBe(false); // pre-D-145 topic
  });

  it('D145_PSI_ELIGIBLE_PRODUCER_TOPICS enumerates exactly 3 producers per § A.7.2', () => {
    // ⛔ WAS 4. PSI drift compares a producer's confidence distribution
    // against its own baseline — with no producer there was never a
    // distribution, so `context_packet_quality` could sit in this list
    // indefinitely without the drift task ever having anything to score.
    expect(D145_PSI_ELIGIBLE_PRODUCER_TOPICS).toHaveLength(3);
    expect([...D145_PSI_ELIGIBLE_PRODUCER_TOPICS].sort()).toEqual([
      'commitment_followthrough_score',
      'task_completion_velocity',
      'project_velocity',
    ].sort());
  });

  it('isD145PsiEligibleProducerTopic predicate matches the closed list', () => {
    for (const topic of D145_PSI_ELIGIBLE_PRODUCER_TOPICS) {
      expect(isD145PsiEligibleProducerTopic(topic)).toBe(true);
    }
    expect(isD145PsiEligibleProducerTopic('commitment_imbalance')).toBe(false);
    expect(isD145PsiEligibleProducerTopic('purpose')).toBe(false);
  });

  it('DECLARATION_TEMPORAL_CLASSES enumerates the 4 D-145 declaration values', () => {
    expect([...DECLARATION_TEMPORAL_CLASSES].sort()).toEqual([
      'aggregate_window',
      'cumulative',
      'snapshot',
      'time_bound',
    ]);
    expect(isDeclarationTemporalClass('snapshot')).toBe(true);
    expect(isDeclarationTemporalClass('cumulative')).toBe(true);
    expect(isDeclarationTemporalClass('stable_truth')).toBe(false); // D-136 enum, not D-145
  });

  it('DECLARATION_IDENTITY_AGGREGATIONS = scenario / perspective', () => {
    expect([...DECLARATION_IDENTITY_AGGREGATIONS].sort()).toEqual([
      'perspective',
      'scenario',
    ]);
    expect(isDeclarationIdentityAggregation('scenario')).toBe(true);
    expect(isDeclarationIdentityAggregation('perspective')).toBe(true);
    expect(isDeclarationIdentityAggregation('global')).toBe(false);
  });

  it('CONFIDENCE_KINDS = none / derived_band / emits_confidence', () => {
    expect([...CONFIDENCE_KINDS].sort()).toEqual([
      'derived_band',
      'emits_confidence',
      'none',
    ]);
    expect(isConfidenceKind('none')).toBe(true);
    expect(isConfidenceKind('derived_band')).toBe(true);
    expect(isConfidenceKind('emits_confidence')).toBe(true);
    expect(isConfidenceKind('confidence')).toBe(false);
  });

  it('COVERAGE_POSTURES = declared / computed', () => {
    expect([...COVERAGE_POSTURES].sort()).toEqual(['computed', 'declared']);
    expect(isCoveragePosture('declared')).toBe(true);
    expect(isCoveragePosture('computed')).toBe(true);
    expect(isCoveragePosture('partial')).toBe(false);
  });

  it('PRIVACY_CLASSES = public_metadata / user_inferable / sensitive', () => {
    expect([...PRIVACY_CLASSES].sort()).toEqual([
      'public_metadata',
      'sensitive',
      'user_inferable',
    ]);
    expect(isPrivacyClass('public_metadata')).toBe(true);
    expect(isPrivacyClass('user_inferable')).toBe(true);
    expect(isPrivacyClass('sensitive')).toBe(true);
    expect(isPrivacyClass('private')).toBe(false);
  });

  it('DECLARATION_WINDOW_KINDS = rolling_days / rolling_weeks / all_time', () => {
    expect([...DECLARATION_WINDOW_KINDS].sort()).toEqual([
      'all_time',
      'rolling_days',
      'rolling_weeks',
    ]);
    expect(isDeclarationWindowKind('rolling_days')).toBe(true);
    expect(isDeclarationWindowKind('all_time')).toBe(true);
    expect(isDeclarationWindowKind('rolling_minutes')).toBe(false);
  });

  it('DECLARATION_PRODUCER_KINDS = reactive / housekeeping', () => {
    expect([...DECLARATION_PRODUCER_KINDS].sort()).toEqual([
      'housekeeping',
      'reactive',
    ]);
    expect(isDeclarationProducerKind('reactive')).toBe(true);
    expect(isDeclarationProducerKind('housekeeping')).toBe(true);
    expect(isDeclarationProducerKind('idle')).toBe(false);
  });

  it('PSI_ELIGIBLE_TEMPORAL_CLASSES = aggregate_window / time_bound', () => {
    expect([...PSI_ELIGIBLE_TEMPORAL_CLASSES].sort()).toEqual([
      'aggregate_window',
      'time_bound',
    ]);
  });

  it('PSI_SAMPLE_FLOOR_MINIMUM = 30', () => {
    expect(PSI_SAMPLE_FLOOR_MINIMUM).toBe(30);
  });
});

describe('D-145 PA9 — every D-145 producer has a complete declaration', () => {
  it('D145_PRODUCER_DECLARATIONS map contains every topic in D145_PRODUCER_TOPICS', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      expect(
        D145_PRODUCER_DECLARATIONS[topic],
        `D-145 producer '${topic}' missing from D145_PRODUCER_DECLARATIONS`,
      ).toBeDefined();
    }
  });

  it('every declaration\'s topic field matches its registry key', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      expect(decl.topic).toBe(topic);
    }
  });

  it('every D-145 declaration passes validateEnrichmentDeclaration cleanly', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      const issues = validateEnrichmentDeclaration(decl);
      expect(issues, `topic '${topic}': ${issues.join('; ')}`).toEqual([]);
    }
  });

  it('every D-145 declaration carries non-empty operates_on / invalidation_triggers / benchmark_scenarios', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      expect(decl.operates_on.length, `topic '${topic}' has empty operates_on`).toBeGreaterThan(0);
      expect(
        decl.benchmark_scenarios.length,
        `topic '${topic}' has empty benchmark_scenarios — every D-145 producer MUST have ≥ 1 fixture in C.3`,
      ).toBeGreaterThan(0);
      // invalidation_triggers may be [] for snapshot producers with no
      // event-driven invalidation (derived from current state at compute
      // time); validator allows empty.
    }
  });

  it('validateD145ProducerDeclarations returns [] for the live registry', () => {
    expect(validateD145ProducerDeclarations()).toEqual([]);
  });

  it('assertD145ProducerDeclarations does not throw for the live registry', () => {
    expect(() => assertD145ProducerDeclarations()).not.toThrow();
  });
});

describe('D-145 PA9 — PSI eligibility consistency', () => {
  it('every PSI-eligible producer declares confidence_kind: emits_confidence', () => {
    for (const topic of D145_PSI_ELIGIBLE_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      expect(decl.confidence_kind, `topic '${topic}' is PSI-eligible but confidence_kind != emits_confidence`).toBe('emits_confidence');
    }
  });

  it('every PSI-eligible producer declares sample_floor ≥ 30 (PSI calibration baseline)', () => {
    for (const topic of D145_PSI_ELIGIBLE_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      expect(
        decl.sample_floor,
        `topic '${topic}' is PSI-eligible but sample_floor (${decl.sample_floor}) < ${PSI_SAMPLE_FLOOR_MINIMUM}`,
      ).toBeGreaterThanOrEqual(PSI_SAMPLE_FLOOR_MINIMUM);
    }
  });

  it('every PSI-eligible producer declares temporal_class IN aggregate_window | time_bound', () => {
    for (const topic of D145_PSI_ELIGIBLE_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      expect(
        PSI_ELIGIBLE_TEMPORAL_CLASSES,
        `topic '${topic}' is PSI-eligible but temporal_class is ${decl.temporal_class}`,
      ).toContain(decl.temporal_class);
    }
  });

  it('every non-PSI-eligible D-145 producer carries confidence_kind != emits_confidence', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      if (D145_PSI_ELIGIBLE_PRODUCER_TOPICS.includes(topic)) continue;
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      expect(
        decl.confidence_kind,
        `topic '${topic}' is NOT PSI-eligible but declares confidence_kind: 'emits_confidence'`,
      ).not.toBe('emits_confidence');
    }
  });

  it('registry-side emits_confidence flag on PSI-eligible D-145 producers matches declaration set', () => {
    // Cross-check: the registry's `emits_confidence: true` flag must
    // align with the declaration-side `confidence_kind: 'emits_confidence'`
    // for D-145 PA9 producers. Pre-D-145 producers (purpose / summary /
    // action_items) carry registry-side `emits_confidence: true` but no
    // PA9 declaration — they're not in this test's scope.
    for (const topic of D145_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      const def = ENRICHMENT_REGISTRY[topic as EnrichmentTopic];
      const declSaysPsi = decl.confidence_kind === 'emits_confidence';
      const regSaysPsi = (def as { emits_confidence?: boolean }).emits_confidence === true;
      expect(
        regSaysPsi,
        `topic '${topic}' declaration confidence_kind: '${decl.confidence_kind}' but registry emits_confidence: ${regSaysPsi}`,
      ).toBe(declSaysPsi);
    }
  });

  it('PSI-eligible producers carry deliberate cross-layer temporal_class divergence (registry: stable_truth; declaration: aggregate_window) — D145_PSI_LAYER_DIVERGENCE_LOCKED', () => {
    // Codex P2 fold — PSI-eligible producers split across two enums:
    // - Registry-side `temporal_class: 'stable_truth'` (D-136 gate-1
    //   requires this for `emits_confidence: true`).
    // - Declaration-side `temporal_class: 'aggregate_window'` (D-145
    //   spec § A.7.5 example — producers aggregate over rolling
    //   windows; declaration documents the actual compute pattern).
    //
    // The divergence is intentional. A future maintainer trying to
    // "fix" either direction needs to amend D-136 gate-1 + the spec
    // first. This ratchet locks the deliberate split.
    for (const topic of D145_PSI_ELIGIBLE_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      const def = ENRICHMENT_REGISTRY[topic as EnrichmentTopic];
      expect(
        decl.temporal_class,
        `PSI-eligible '${topic}' declaration must carry temporal_class: 'aggregate_window' per spec § A.7.5`,
      ).toBe('aggregate_window');
      expect(
        def.temporal_class,
        `PSI-eligible '${topic}' registry must carry temporal_class: 'stable_truth' per D-136 gate-1`,
      ).toBe('stable_truth');
    }
  });
});

describe('D-145 PA9 — registry / declaration consistency', () => {
  it('every D-145 producer is registered in ENRICHMENT_REGISTRY', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      expect(
        ENRICHMENT_REGISTRY[topic as EnrichmentTopic],
        `D-145 producer '${topic}' missing from ENRICHMENT_REGISTRY`,
      ).toBeDefined();
    }
  });

  it('every D-145 producer declaration carries a non-zero positive sample_floor', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      expect(decl.sample_floor, `topic '${topic}' has invalid sample_floor`).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(decl.sample_floor)).toBe(true);
    }
  });

  it('declaration aggregate_window / time_bound producers carry window non-null', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      if (decl.temporal_class === 'aggregate_window' || decl.temporal_class === 'time_bound') {
        expect(decl.window, `topic '${topic}' (${decl.temporal_class}) has window: null`).not.toBeNull();
        expect(decl.event_time_field, `topic '${topic}' (${decl.temporal_class}) has event_time_field: null`).not.toBeNull();
      }
    }
  });

  it('declaration snapshot / cumulative producers carry window: null', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      if (decl.temporal_class === 'snapshot' || decl.temporal_class === 'cumulative') {
        expect(decl.window, `topic '${topic}' (${decl.temporal_class}) has non-null window`).toBeNull();
      }
    }
  });
});

// Shared by the negative-paths + D-164 P2 describes; module-scope so
// both reuse one fixture.
const baseValidDeclaration: EnrichmentDeclaration = {
  topic: 'test_topic',
  operates_on: ['data.test'],
  event_time_field: 'test.created_at',
  window: { kind: 'rolling_days', n: 30 },
  producer_kind: 'housekeeping',
  temporal_class: 'aggregate_window',
  identity_aggregation: 'scenario',
  sample_floor: 30,
  confidence_kind: 'none',
  coverage: 'computed',
  source_degradation_reasons: [],
  privacy_class: 'user_inferable',
  mcp_exposed_default: false,
  invalidation_triggers: ['data.test.updated'],
  benchmark_scenarios: ['scn_test'],
  return_shape: '{ test_field: number, computed_at: number }',
  suggest_directive: null,
  concurrency_safe: true,
};

describe('D-145 PA9 — validateEnrichmentDeclaration (negative paths)', () => {

  it('rejects empty operates_on', () => {
    const issues = validateEnrichmentDeclaration({ ...baseValidDeclaration, operates_on: [] });
    expect(issues.some((s) => s.includes('operates_on'))).toBe(true);
  });

  it('rejects empty benchmark_scenarios', () => {
    const issues = validateEnrichmentDeclaration({ ...baseValidDeclaration, benchmark_scenarios: [] });
    expect(issues.some((s) => s.includes('benchmark_scenarios'))).toBe(true);
  });

  it('rejects sample_floor: 0', () => {
    const issues = validateEnrichmentDeclaration({ ...baseValidDeclaration, sample_floor: 0 });
    expect(issues.some((s) => s.includes('sample_floor'))).toBe(true);
  });

  it('rejects emits_confidence + temporal_class: snapshot (PSI not eligible)', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseValidDeclaration,
      temporal_class: 'snapshot',
      window: null,
      confidence_kind: 'emits_confidence',
    });
    expect(issues.some((s) => s.includes('PSI is only meaningful'))).toBe(true);
  });

  it('rejects emits_confidence + sample_floor < 30 (PSI calibration baseline)', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseValidDeclaration,
      confidence_kind: 'emits_confidence',
      sample_floor: 10,
    });
    expect(issues.some((s) => s.includes('sample_floor'))).toBe(true);
  });

  it('rejects aggregate_window + window: null', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseValidDeclaration,
      window: null,
    });
    expect(issues.some((s) => s.includes('window is null'))).toBe(true);
  });

  it('rejects snapshot + window: non-null', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseValidDeclaration,
      temporal_class: 'snapshot',
      event_time_field: null,
    });
    expect(issues.some((s) => s.includes('window is non-null'))).toBe(true);
  });

  it('rejects aggregate_window + event_time_field: null', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseValidDeclaration,
      event_time_field: null,
    });
    expect(issues.some((s) => s.includes('event_time_field is null'))).toBe(true);
  });

  it('rejects unrecognised SourceDegradationReason values', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseValidDeclaration,
      source_degradation_reasons: ['nonsense_reason' as never],
    });
    expect(issues.some((s) => s.includes('source_degradation_reasons'))).toBe(true);
  });

  it('rejects all_time window kind with non-undefined n', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseValidDeclaration,
      window: { kind: 'all_time', n: 30 },
    });
    expect(issues.some((s) => s.includes("window.n' must be omitted"))).toBe(true);
  });

  it('rejects rolling_days window kind without n', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseValidDeclaration,
      window: { kind: 'rolling_days' },
    });
    expect(issues.some((s) => s.includes("window.n' must be a positive"))).toBe(true);
  });

  it('assertEnrichmentDeclaration throws EnrichmentDeclarationError on first issue', () => {
    expect(() =>
      assertEnrichmentDeclaration({ ...baseValidDeclaration, sample_floor: 0 }),
    ).toThrow(EnrichmentDeclarationError);
  });
});

describe('D-164 P2 — return_shape + suggest_directive on every D-145 declaration', () => {
  it('every D-145 declaration carries a non-empty return_shape', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      expect(
        typeof decl.return_shape === 'string' && decl.return_shape.length > 0,
        `topic '${topic}' has empty return_shape — D-164 P2 requires bench-style annotation literal`,
      ).toBe(true);
    }
  });

  it("every D-145 declaration's return_shape includes 'computed_at'", () => {
    // Every D-145 Value interface carries `computed_at: number`; the
    // return_shape must surface it so the LLM knows when the row was
    // last written.
    for (const topic of D145_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      expect(
        decl.return_shape.includes('computed_at'),
        `topic '${topic}' return_shape '${decl.return_shape}' missing 'computed_at'`,
      ).toBe(true);
    }
  });

  it('every D-145 declaration carries suggest_directive (null or populated)', () => {
    for (const topic of D145_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      // Either null OR a fully-populated SuggestDirective — the validator
      // already gates per-field non-empty when non-null; this asserts the
      // field is present (never `undefined`).
      expect(
        decl.suggest_directive === null
          || (typeof decl.suggest_directive === 'object' && !Array.isArray(decl.suggest_directive)),
        `topic '${topic}' suggest_directive must be null or a SuggestDirective object`,
      ).toBe(true);
    }
  });

  it('exactly 1 D-145 declaration carries suggest_directive: null (operational signal)', () => {
    // source_freshness_degradation is the operational signal whose recourse
    // is configuration / reconciliation, not a different warehouse query.
    // Every other producer has a natural deterministic fallback.
    const nullSuggest: string[] = [];
    for (const topic of D145_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      if (decl.suggest_directive === null) nullSuggest.push(topic);
    }
    expect(nullSuggest.sort()).toEqual([
      'source_freshness_degradation',
    ].sort());
  });

  it('per-entity-scoped declarations carry the primary entity REF in return_shape', () => {
    // D-164 P2 bench-alignment — when a producer's scope is per-X (contact /
    // project / task / note / mail-thread), the return shape surfaces the
    // entity REF as the first field so the LLM can chain entity.query off
    // the result without remembering the call args. Matches bench convention
    // (engagement_silence_duration / engagement_velocity_signal / inbound_-
    // outbound_ratio in catalog.js).
    //
    // System / operational signals (context_packet_quality / source_freshness_-
    // degradation) and dual-scope producers (open_loop_pressure —
    // per-contact OR per-project per header comment) are exempt — the
    // entity is either absent or ambiguous from the declaration alone.
    const EXPECTED_PRIMARY_REF: Readonly<Record<string, string>> = {
      commitment_followthrough_score: 'contact: REF<contacts>',
      commitment_imbalance: 'contact: REF<contacts>',
      commitment_reliability_band: 'contact: REF<contacts>',
      note_relevance_decay: 'note: REF<note>',
      outbound_commitment_overdue_count: 'contact: REF<contacts>',
      preferred_channel_by_contact: 'contact: REF<contacts>',
      project_next_action_gap: 'project: REF<project>',
      project_stall_signal: 'project: REF<project>',
      project_velocity: 'project: REF<project>',
      task_completion_velocity: 'contact: REF<contacts>',
      task_duplicate_candidate: 'task: REF<task>',
      task_signal_density_per_thread: 'thread: REF<mail>',
    };
    const offenders: string[] = [];
    for (const [topic, expectedRef] of Object.entries(EXPECTED_PRIMARY_REF)) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      if (!decl.return_shape.includes(expectedRef)) {
        offenders.push(
          `topic '${topic}' return_shape '${decl.return_shape}' missing '${expectedRef}'`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('validator rejects empty return_shape', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseValidDeclaration,
      return_shape: '',
    });
    expect(issues.some((s) => s.includes("'return_shape'"))).toBe(true);
  });

  it('validator rejects suggest_directive with empty tool / kind / hint', () => {
    for (const field of ['tool', 'kind', 'hint'] as const) {
      const issues = validateEnrichmentDeclaration({
        ...baseValidDeclaration,
        suggest_directive: {
          tool: field === 'tool' ? '' : 'entity.query',
          kind: field === 'kind' ? '' : 'mail',
          hint: field === 'hint' ? '' : 'Search mail.',
        },
      });
      expect(
        issues.some((s) => s.includes(`'suggest_directive.${field}'`)),
        `expected validator to reject empty suggest_directive.${field}; issues: ${issues.join('; ')}`,
      ).toBe(true);
    }
  });

  it('validator rejects suggest_directive that is an array', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseValidDeclaration,
      // Cast through unknown to bypass TS; runtime validator catches the
      // misshape.
      suggest_directive: [] as unknown as EnrichmentDeclaration['suggest_directive'],
    });
    expect(issues.some((s) => s.includes("'suggest_directive'"))).toBe(true);
  });

  it('validator accepts suggest_directive: null', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseValidDeclaration,
      suggest_directive: null,
    });
    expect(issues).toEqual([]);
  });

  it('validator accepts suggest_directive with optional args', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseValidDeclaration,
      suggest_directive: {
        tool: 'entity.query',
        kind: 'mail',
        hint: 'Search mail.',
        args: { limit: 10 },
      },
    });
    expect(issues).toEqual([]);
  });

  // Closed-list literal-presence ratchet — catches copy-paste shapes that
  // mismatch a producer's actual Value enum. Each entry pins the literal
  // values the topic's Value interface uses; the declaration's
  // return_shape must mention every one (otherwise the catalog renders an
  // incomplete enum to the LLM). Only producers whose Value carries a
  // closed-list enum field are listed; primitive-only producers are
  // covered by the non-empty + computed_at ratchets above.
  const RETURN_SHAPE_ENUM_LITERALS: ReadonlyArray<{
    topic: string;
    literals: readonly string[];
  }> = [
    {
      topic: 'commitment_imbalance',
      literals: ['aligned', 'inbound_heavy', 'outbound_heavy', 'insufficient_data'],
    },
    {
      topic: 'commitment_reliability_band',
      literals: ['insufficient_data', 'reliable', 'mixed', 'risky'],
    },
    {
      topic: 'preferred_channel_by_contact',
      literals: [
        'email_preferred',
        'call_preferred',
        'text_preferred',
        'meeting_preferred',
        'mixed_no_clear_preference',
      ],
    },
    {
      topic: 'task_duplicate_candidate',
      literals: ['exact', 'probable', 'low'],
    },
  ];

  it('declarations whose Value carries a closed-list enum mention every literal in return_shape', () => {
    for (const { topic, literals } of RETURN_SHAPE_ENUM_LITERALS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic as never]!;
      for (const literal of literals) {
        expect(
          decl.return_shape.includes(`'${literal}'`),
          `topic '${topic}' return_shape '${decl.return_shape}' missing literal '${literal}'`,
        ).toBe(true);
      }
    }
  });
});

describe('D-164 P3 — concurrency_safe on every D-145 declaration', () => {
  it('every D-145 declaration carries concurrency_safe: true (warehouse-only producers are naturally safe)', () => {
    // All 16 D-145 producers compute over local warehouse data; none fan
    // out to a rate-limited external API. The all-true assertion is the
    // current lock — a future producer that touches an external endpoint
    // would land here as `false` and force an explicit decision when this
    // ratchet flips.
    for (const topic of D145_PRODUCER_TOPICS) {
      const decl = D145_PRODUCER_DECLARATIONS[topic]!;
      expect(
        decl.concurrency_safe,
        `topic '${topic}' concurrency_safe must be true (or a non-safe producer landed; flip this ratchet deliberately)`,
      ).toBe(true);
    }
  });

  it('validator rejects missing concurrency_safe', () => {
    // Cast through unknown so the validator (not the type system) catches
    // the misshape — substrate guarantees presence at registry load.
    const { concurrency_safe: _omit, ...stripped } = baseValidDeclaration;
    void _omit;
    const issues = validateEnrichmentDeclaration(
      stripped as unknown as EnrichmentDeclaration,
    );
    expect(issues.some((s) => s.includes("'concurrency_safe'"))).toBe(true);
  });

  it('validator rejects non-boolean concurrency_safe', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseValidDeclaration,
      concurrency_safe: 'yes' as unknown as boolean,
    });
    expect(issues.some((s) => s.includes("'concurrency_safe'"))).toBe(true);
  });

  it('validator accepts concurrency_safe: false (future per-vendor or rate-limited producer)', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseValidDeclaration,
      concurrency_safe: false,
    });
    expect(issues).toEqual([]);
  });
});
