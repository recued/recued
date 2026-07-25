/** D-145 PB3 — composition rule validator tests.
 *
 *  Per § B.1.2. Each composition rule has a positive + negative test
 *  demonstrating the validator's pin. (D-145 Item 1 collapsed the
 *  two-stage discriminator: ai.synthesize is a single synthesis call,
 *  so the memory.recall / enrichment.lookup ordering rules fire on
 *  EVERY ai.synthesize rather than only the `generator` stage.) */

import { describe, it, expect } from 'vitest';

import {
  COMPOSITION_RULE_KINDS,
  COMPOSITION_RULE_KIND_SET,
  CompositionRuleError,
  assertValidComposition,
  preCheckBridgeDispatchAllowed,
  validateCompositionRules,
} from '../orchestrator/index.js';

import type { PrimitiveCall } from '@recued/contracts';

const call = (overrides: Partial<PrimitiveCall> & Pick<PrimitiveCall, 'primitive'>): PrimitiveCall => ({
  call_id: overrides.call_id ?? 'c1',
  args_summary: overrides.args_summary ?? 'args',
  outcome_summary: overrides.outcome_summary ?? 'outcome',
  status: overrides.status ?? 'ok',
  duration_ms: overrides.duration_ms ?? 1,
  started_at: overrides.started_at ?? 1000,
  ...(overrides.intent_id !== undefined ? { intent_id: overrides.intent_id } : {}),
  primitive: overrides.primitive,
});

// ── Closed-list pin ─────────────────────────────────────────────────

describe('COMPOSITION_RULE_KINDS — closed list', () => {
  it('exposes the 5 named rules (D-145 Item 1 dropped the 3 stage-coupled rules)', () => {
    expect(COMPOSITION_RULE_KINDS).toEqual([
      'capacity_spec_must_precede_dependent',
      'memory_recall_before_ai_synthesize',
      'enrichment_lookup_before_ai_synthesize',
      'memory_write_after_ai_synthesize',
      'bridge_dispatch_requires_capacity_check',
    ]);
  });

  it('exposes the matching ReadonlySet', () => {
    expect(COMPOSITION_RULE_KIND_SET.size).toBe(5);
    expect(COMPOSITION_RULE_KIND_SET.has('memory_recall_before_ai_synthesize')).toBe(true);
  });
});

// ── Rule: bridge.dispatch requires a preceding capacity_spec ────────

describe('rule: bridge_dispatch_requires_capacity_check', () => {
  it('passes when capacity_spec ok precedes bridge.dispatch with same intent_id', () => {
    const calls = [
      call({ primitive: 'capacity_spec', status: 'ok', intent_id: 'i1' }),
      call({ primitive: 'bridge.dispatch', status: 'ok', intent_id: 'i1' }),
    ];
    expect(validateCompositionRules(calls)).toEqual([]);
  });

  it('fails when bridge.dispatch has no preceding capacity_spec', () => {
    const calls = [call({ primitive: 'bridge.dispatch', status: 'ok' })];
    const v = validateCompositionRules(calls);
    expect(v.some((x) => x.rule === 'bridge_dispatch_requires_capacity_check')).toBe(true);
  });

  it('fails when capacity_spec succeeded for different intent', () => {
    const calls = [
      call({ primitive: 'capacity_spec', status: 'ok', intent_id: 'i1' }),
      call({ primitive: 'bridge.dispatch', status: 'ok', intent_id: 'i2' }),
    ];
    const v = validateCompositionRules(calls);
    expect(v.some((x) => x.rule === 'bridge_dispatch_requires_capacity_check')).toBe(true);
  });

  it('passes pre-flight (no intent_id) when capacity_spec also pre-flight', () => {
    const calls = [
      call({ primitive: 'capacity_spec', status: 'ok' }),
      call({ primitive: 'bridge.dispatch', status: 'ok' }),
    ];
    expect(validateCompositionRules(calls)).toEqual([]);
  });

  it('fails when bridge.dispatch precedes its capacity_spec ok', () => {
    const calls = [
      call({ primitive: 'bridge.dispatch', status: 'ok' }),
      call({ primitive: 'capacity_spec', status: 'ok' }),
    ];
    const v = validateCompositionRules(calls);
    expect(v.some((x) => x.rule === 'bridge_dispatch_requires_capacity_check')).toBe(true);
  });
});

// ── Rule 2: memory.recall before ai.synthesize ──────────────────────

describe('rule: memory_recall_before_ai_synthesize', () => {
  it('passes when memory.recall precedes ai.synthesize', () => {
    const calls = [
      call({ primitive: 'memory.recall', status: 'ok' }),
      call({ primitive: 'enrichment.lookup', status: 'ok' }),
      call({ primitive: 'ai.synthesize', status: 'ok' }),
    ];
    expect(validateCompositionRules(calls)).toEqual([]);
  });

  it('fails when ai.synthesize runs with no memory.recall', () => {
    const calls = [
      call({ primitive: 'enrichment.lookup', status: 'ok' }),
      call({ primitive: 'ai.synthesize', status: 'ok' }),
    ];
    const v = validateCompositionRules(calls);
    expect(v.some((x) => x.rule === 'memory_recall_before_ai_synthesize')).toBe(true);
  });

  it('passes when memory.recall errored — broker did consult', () => {
    const calls = [
      call({ primitive: 'memory.recall', status: 'error' }),
      call({ primitive: 'enrichment.lookup', status: 'ok' }),
      call({ primitive: 'ai.synthesize', status: 'ok' }),
    ];
    expect(validateCompositionRules(calls)).toEqual([]);
  });

  it('fires on EVERY ai.synthesize — no classifier exemption (single-stage re-anchor)', () => {
    // Pre-collapse, only the `generator` stage was gated; the
    // `classifier` pre-call was exempt. Single-stage: every
    // ai.synthesize is the composing call and must be consulted-first.
    const v = validateCompositionRules([call({ primitive: 'ai.synthesize', status: 'ok' })]);
    expect(v.some((x) => x.rule === 'memory_recall_before_ai_synthesize')).toBe(true);
    expect(v.some((x) => x.rule === 'enrichment_lookup_before_ai_synthesize')).toBe(true);
  });
});

// ── Codex P1 fold (rule #2): per-intent strict matching ─────────────

describe('rule: memory_recall_before_ai_synthesize (per-intent strict, Codex P1)', () => {
  it('FAILS: memory.recall for intent A does NOT satisfy ai.synthesize for intent B', () => {
    const calls = [
      call({ primitive: 'memory.recall', status: 'ok', intent_id: 'i1' }),
      call({ primitive: 'enrichment.lookup', status: 'ok', intent_id: 'i2' }),
      call({ primitive: 'ai.synthesize', status: 'ok', intent_id: 'i2' }),
    ];
    const v = validateCompositionRules(calls);
    expect(v.some((x) => x.rule === 'memory_recall_before_ai_synthesize')).toBe(true);
    // Intent must be referenced in the violation detail.
    expect(
      v.find((x) => x.rule === 'memory_recall_before_ai_synthesize')?.detail,
    ).toContain('intent_id=i2');
  });

  it('PASSES: pre-flight memory.recall (no intent_id) satisfies any per-intent synthesize', () => {
    const calls = [
      call({ primitive: 'memory.recall', status: 'ok' }), // pre-flight
      call({ primitive: 'enrichment.lookup', status: 'ok' }),
      call({ primitive: 'ai.synthesize', status: 'ok', intent_id: 'i2' }),
    ];
    expect(
      validateCompositionRules(calls).filter(
        (v) => v.rule === 'memory_recall_before_ai_synthesize',
      ),
    ).toEqual([]);
  });

  it('PASSES: per-intent memory.recall covers same-intent synthesize', () => {
    const calls = [
      call({ primitive: 'memory.recall', status: 'ok', intent_id: 'i1' }),
      call({ primitive: 'enrichment.lookup', status: 'ok', intent_id: 'i1' }),
      call({ primitive: 'ai.synthesize', status: 'ok', intent_id: 'i1' }),
    ];
    expect(
      validateCompositionRules(calls).filter(
        (v) =>
          v.rule === 'memory_recall_before_ai_synthesize'
          || v.rule === 'enrichment_lookup_before_ai_synthesize',
      ),
    ).toEqual([]);
  });

  it('FAILS independently per intent on multi-intent run', () => {
    const calls = [
      // intent i1 — fully consulted
      call({ primitive: 'memory.recall', status: 'ok', intent_id: 'i1' }),
      call({ primitive: 'enrichment.lookup', status: 'ok', intent_id: 'i1' }),
      call({ primitive: 'ai.synthesize', status: 'ok', intent_id: 'i1' }),
      // intent i2 — synthesizer ran with NO consult for i2
      call({ primitive: 'ai.synthesize', status: 'ok', intent_id: 'i2' }),
    ];
    const v = validateCompositionRules(calls);
    expect(v.some((x) => x.rule === 'memory_recall_before_ai_synthesize')).toBe(true);
    expect(v.some((x) => x.rule === 'enrichment_lookup_before_ai_synthesize')).toBe(true);
  });
});

// ── Rule 3: enrichment.lookup before ai.synthesize ──────────────────

describe('rule: enrichment_lookup_before_ai_synthesize', () => {
  it('passes when enrichment.lookup precedes ai.synthesize', () => {
    const calls = [
      call({ primitive: 'memory.recall', status: 'ok' }),
      call({ primitive: 'enrichment.lookup', status: 'ok' }),
      call({ primitive: 'ai.synthesize', status: 'ok' }),
    ];
    expect(validateCompositionRules(calls)).toEqual([]);
  });

  it('fails when ai.synthesize runs with no enrichment.lookup', () => {
    const calls = [
      call({ primitive: 'memory.recall', status: 'ok' }),
      call({ primitive: 'ai.synthesize', status: 'ok' }),
    ];
    const v = validateCompositionRules(calls);
    expect(v.some((x) => x.rule === 'enrichment_lookup_before_ai_synthesize')).toBe(true);
  });
});

// ── Rule 5: memory.write after ai.synthesize ────────────────────────

describe('rule: memory_write_after_ai_synthesize', () => {
  it('passes when memory.write follows the final ai.synthesize ok', () => {
    const calls = [
      call({ primitive: 'memory.recall', status: 'ok' }),
      call({ primitive: 'enrichment.lookup', status: 'ok' }),
      call({ primitive: 'ai.synthesize', status: 'ok' }),
      call({ primitive: 'memory.write', status: 'ok' }),
    ];
    expect(validateCompositionRules(calls)).toEqual([]);
  });

  it('fails when memory.write precedes the final ai.synthesize ok', () => {
    const calls = [
      call({ primitive: 'memory.write', status: 'ok' }),
      call({ primitive: 'memory.recall', status: 'ok' }),
      call({ primitive: 'enrichment.lookup', status: 'ok' }),
      call({ primitive: 'ai.synthesize', status: 'ok' }),
    ];
    const v = validateCompositionRules(calls);
    expect(v.some((x) => x.rule === 'memory_write_after_ai_synthesize')).toBe(true);
  });

  it('passes when no ai.synthesize present (short-circuit path)', () => {
    const calls = [
      call({ primitive: 'memory.recall', status: 'ok' }),
      call({ primitive: 'memory.write', status: 'ok' }),
    ];
    expect(validateCompositionRules(calls)).toEqual([]);
  });
});

// ── Codex P1 fold (rule #6): pre-execution bridge.dispatch gate ────

describe('preCheckBridgeDispatchAllowed (Codex P1)', () => {
  it('returns null when capacity_spec ok precedes for same intent', () => {
    const prior = [call({ primitive: 'capacity_spec', status: 'ok', intent_id: 'i1' })];
    expect(preCheckBridgeDispatchAllowed(prior, 'i1')).toBeNull();
  });

  it('returns null when capacity_spec ok_partial precedes for same intent', () => {
    const prior = [call({ primitive: 'capacity_spec', status: 'ok_partial', intent_id: 'i1' })];
    expect(preCheckBridgeDispatchAllowed(prior, 'i1')).toBeNull();
  });

  it('returns violation when no capacity_spec at all', () => {
    expect(preCheckBridgeDispatchAllowed([], 'i1')).not.toBeNull();
  });

  it('returns violation when capacity_spec ok was for different intent', () => {
    const prior = [call({ primitive: 'capacity_spec', status: 'ok', intent_id: 'iX' })];
    expect(preCheckBridgeDispatchAllowed(prior, 'i1')).not.toBeNull();
  });

  it('returns null for pre-flight bridge dispatch when capacity ok was pre-flight', () => {
    const prior = [call({ primitive: 'capacity_spec', status: 'ok' })];
    expect(preCheckBridgeDispatchAllowed(prior, undefined)).toBeNull();
  });

  it('returns violation when capacity_spec status was capacity_gap', () => {
    const prior = [
      call({ primitive: 'capacity_spec', status: 'capacity_gap', intent_id: 'i1' }),
    ];
    expect(preCheckBridgeDispatchAllowed(prior, 'i1')).not.toBeNull();
  });

  it('violation detail mentions intent_id', () => {
    const v = preCheckBridgeDispatchAllowed([], 'i1');
    expect(v?.detail).toContain('intent_id=i1');
  });
});

// ── assertValidComposition + CompositionRuleError ───────────────────

describe('assertValidComposition + CompositionRuleError', () => {
  it('throws CompositionRuleError on violation', () => {
    const calls = [call({ primitive: 'bridge.dispatch', status: 'ok' })];
    expect(() => assertValidComposition(calls)).toThrow(CompositionRuleError);
  });

  it('passes silently on valid composition', () => {
    const calls = [
      call({ primitive: 'memory.recall', status: 'ok' }),
      call({ primitive: 'enrichment.lookup', status: 'ok' }),
      call({ primitive: 'ai.synthesize', status: 'ok' }),
      call({ primitive: 'memory.write', status: 'ok' }),
    ];
    expect(() => assertValidComposition(calls)).not.toThrow();
  });

  it('CompositionRuleError exposes violation list', () => {
    const calls = [
      // bridge.dispatch with no capacity_spec → rule violation; and an
      // ai.synthesize with no memory.recall / enrichment.lookup → two more.
      call({ primitive: 'bridge.dispatch', status: 'ok' }),
      call({ primitive: 'ai.synthesize', status: 'ok' }),
    ];
    try {
      assertValidComposition(calls);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CompositionRuleError);
      const err = e as CompositionRuleError;
      expect(err.code).toBe('COMPOSITION_RULE_VIOLATION');
      expect(err.violations.length).toBeGreaterThanOrEqual(2);
    }
  });
});
