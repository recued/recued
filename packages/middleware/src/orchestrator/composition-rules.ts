/** D-145 PB3 — composition order rules per § B.1.2.
 *
 *  Pure validator over `RecuedPlan.primitive_calls[]`. The
 *  orchestrator runs this AFTER each round + at plan finalization
 *  so violations are caught at write time. The rules encode the
 *  ordering constraints of § B.1.2 (numbered as in the spec):
 *
 *    1. capacity_spec walks run before downstream primitives
 *    2. memory.recall runs before ai.synthesize
 *    3. enrichment.lookup runs before ai.synthesize
 *    (§ B.1.2 rule 4 — the two-stage `ai.synthesize` generator-round
 *     rule — retired with the D-145 Item 1 single-stage collapse;
 *     there is now exactly one synthesis call, so the per-round
 *     generator count it enforced no longer applies.)
 *    5. memory.write runs after ai.synthesize (final response;
 *       enforced as "no memory.write before any ai.synthesize ok")
 *    6. bridge.dispatch runs only after a capacity_spec ok per the
 *       same intent_id (or pre-flight when intent_id absent)
 *    7. approval.request is synchronous (no enforcement at the
 *       composition layer — runtime semantics)
 *    8. provenance.link is fire-and-forget (no ordering constraint
 *       beyond rule 1)
 *
 *  Returns a list of `CompositionRuleViolation`s — empty array
 *  means the plan is rule-conformant. The orchestrator MUST refuse
 *  to persist plans with violations (raises `CompositionRuleError`).
 *
 *  Spec: § B.1.2. */

import type { PrimitiveCall } from '@recued/contracts';

/** Closed list of composition rule kinds the validator enforces.
 *  PB3 ratchet pins the list — drift requires substrate D-spec
 *  change. */
export const COMPOSITION_RULE_KINDS = [
  'capacity_spec_must_precede_dependent',
  'memory_recall_before_ai_synthesize',
  'enrichment_lookup_before_ai_synthesize',
  'memory_write_after_ai_synthesize',
  'bridge_dispatch_requires_capacity_check',
] as const;
export type CompositionRuleKind = (typeof COMPOSITION_RULE_KINDS)[number];
export const COMPOSITION_RULE_KIND_SET: ReadonlySet<CompositionRuleKind> = new Set(
  COMPOSITION_RULE_KINDS,
);

export interface CompositionRuleViolation {
  rule: CompositionRuleKind;
  /** Index into `primitive_calls[]` where the violation was detected. */
  call_index: number;
  /** Human-readable; never echoes user-content fields. */
  detail: string;
}

export class CompositionRuleError extends Error {
  readonly code = 'COMPOSITION_RULE_VIOLATION' as const;
  readonly violations: ReadonlyArray<CompositionRuleViolation>;
  constructor(violations: ReadonlyArray<CompositionRuleViolation>) {
    super(`Composition rule violation: ${violations.length} issue(s)`);
    this.name = 'CompositionRuleError';
    this.violations = violations;
  }
}

/** Validate composition order over a sequence of primitive calls.
 *  Pure function — collects every violation rather than bailing on
 *  the first. The orchestrator calls this AFTER every primitive
 *  appends its row + at plan finalization. */
export const validateCompositionRules = (
  calls: ReadonlyArray<PrimitiveCall>,
): CompositionRuleViolation[] => {
  const violations: CompositionRuleViolation[] = [];

  // Track the most recent ok / ok_partial capacity_spec result + the
  // intent_id it covered. Per rule 6, bridge.dispatch requires a
  // capacity check for the same intent_id (or for the pre-flight
  // when intent_id is absent on both).
  const capacityOkByIntent = new Map<string, number>(); // intent_id → call_index
  const capacityOkPreflight: { call_index: number } | null = { call_index: -1 };

  // Track ai.synthesize ok presence — used for rule 5 (memory.write
  // must come AFTER an ai.synthesize ok).
  let lastAISynthesizeOkIndex = -1;

  // Track per-intent gate state for rule 2 / rule 3 (memory.recall +
  // enrichment.lookup must come BEFORE the ai.synthesize call for the
  // same intent / for the round).
  const memoryRecallSeen = new Set<string>(); // intent_id (or '__pre' for pre-intent)
  const enrichmentLookupSeen = new Set<string>();

  // Track every memory.write index so rule 5 can compare.
  const memoryWriteIndices: number[] = [];

  // Pass 1: scan for the per-call invariants + collect ordering
  // signals.
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;

    const intentKey = call.intent_id ?? '__pre';
    const isOk = call.status === 'ok' || call.status === 'ok_partial';

    switch (call.primitive) {
      case 'capacity_spec':
        if (isOk) {
          if (call.intent_id !== undefined) {
            capacityOkByIntent.set(call.intent_id, i);
          } else {
            capacityOkPreflight.call_index = i;
          }
        }
        break;
      case 'memory.recall':
        // Per § B.1.2 rule 2: any consult (ok / ok_partial / error /
        // timeout) counts. The broker DID try — errored consult means
        // memory was unavailable, but the AI didn't run blind.
        memoryRecallSeen.add(intentKey);
        break;
      case 'enrichment.lookup':
        // Per § B.1.2 rule 3: same — any consult counts.
        enrichmentLookupSeen.add(intentKey);
        break;
      case 'ai.synthesize': {
        // Rules 2 + 3 (Codex P1 fold — composition rule #2): memory.recall +
        // enrichment.lookup MUST have appeared earlier for the SAME intent
        // OR for the pre-flight (__pre) bucket. The previous implementation
        // had a "any memory.recall anywhere in the trace" fallback that
        // let intent A's recall satisfy intent B's synthesizer — wrong:
        // per § B.2 omission decisions are scoped to the AI packet for
        // the current intent, so each intent needs its own memory consult.
        // Errored memory.recall / enrichment.lookup is OK (broker decided
        // to skip / failed gracefully) — the SET registers any status.
        // D-145 Item 1: with the two-stage collapse there is one synthesis
        // call (no classifier/generator split), so these checks fire on
        // EVERY ai.synthesize rather than only the former 'generator' stage.
        const memoryConsulted =
          memoryRecallSeen.has(intentKey) || memoryRecallSeen.has('__pre');
        const enrichmentConsulted =
          enrichmentLookupSeen.has(intentKey) || enrichmentLookupSeen.has('__pre');
        if (!memoryConsulted) {
          violations.push({
            rule: 'memory_recall_before_ai_synthesize',
            call_index: i,
            detail: `ai.synthesize at index ${i} (intent_id=${intentKey}) ran without memory.recall consulted first for the same intent or pre-flight`,
          });
        }
        if (!enrichmentConsulted) {
          violations.push({
            rule: 'enrichment_lookup_before_ai_synthesize',
            call_index: i,
            detail: `ai.synthesize at index ${i} (intent_id=${intentKey}) ran without enrichment.lookup consulted first for the same intent or pre-flight`,
          });
        }
        if (isOk) lastAISynthesizeOkIndex = i;
        break;
      }
      case 'memory.write':
        memoryWriteIndices.push(i);
        break;
      case 'bridge.dispatch': {
        // Rule 6: bridge.dispatch requires a capacity_spec ok for
        // the same intent_id (or pre-flight when intent_id absent).
        const matchingCapacity =
          call.intent_id !== undefined
            ? capacityOkByIntent.get(call.intent_id)
            : capacityOkPreflight.call_index >= 0
              ? capacityOkPreflight.call_index
              : undefined;
        if (matchingCapacity === undefined || matchingCapacity > i) {
          violations.push({
            rule: 'bridge_dispatch_requires_capacity_check',
            call_index: i,
            detail: `bridge.dispatch at index ${i} (intent_id=${call.intent_id ?? '<none>'}) has no preceding capacity_spec ok for the same intent`,
          });
        }
        break;
      }
      case 'data.fetch':
      case 'recipe.invoke':
      case 'approval.request':
      case 'provenance.link':
        // No ordering constraint beyond rule 1; rule 1 is implicit
        // for primitives that take a capacity_spec — bridge.dispatch
        // is the only primitive PB3 substrate enforces capacity gating
        // on. PB7 + PB10 widen as needed.
        break;
    }
  }

  // Rule 5: every memory.write MUST come after at least one
  // ai.synthesize ok (the "final response"). Allowed to come before
  // when the request short-circuited (status != 'completed') — we
  // only enforce when an ai.synthesize ok exists in the trace.
  if (lastAISynthesizeOkIndex >= 0) {
    for (const writeIdx of memoryWriteIndices) {
      if (writeIdx < lastAISynthesizeOkIndex) {
        violations.push({
          rule: 'memory_write_after_ai_synthesize',
          call_index: writeIdx,
          detail: `memory.write at index ${writeIdx} precedes the final ai.synthesize ok at index ${lastAISynthesizeOkIndex}`,
        });
      }
    }
  }

  return violations;
};

/** Throw `CompositionRuleError` when the call sequence has violations.
 *  The orchestrator calls this defensively at plan finalization. */
export const assertValidComposition = (
  calls: ReadonlyArray<PrimitiveCall>,
): void => {
  const violations = validateCompositionRules(calls);
  if (violations.length > 0) throw new CompositionRuleError(violations);
};

// ── Pre-execution gating helpers (Codex P1 fold — composition rule #6) ──

/** Pre-execution composition gate for `bridge.dispatch` per § B.1.2 rule
 *  6. The orchestrator calls this BEFORE invoking the bridge.dispatch
 *  primitive's adapter — preventing DOM actuation when the per-intent
 *  capacity_spec ok hasn't landed yet. Without this gate the adapter
 *  ran first and the violation surfaced only at plan finalization
 *  (after the side effect already happened). The gate replays the
 *  same per-intent / pre-flight matching logic the validator uses;
 *  returns the violation when the call would be illegal, null when
 *  the dispatch is cleared.
 *
 *  Returns null when the call is allowed; returns a violation
 *  shaped like `validateCompositionRules` returns when the call
 *  would violate rule #6. */
export const preCheckBridgeDispatchAllowed = (
  prior_calls: ReadonlyArray<PrimitiveCall>,
  intent_id?: string,
): CompositionRuleViolation | null => {
  for (let i = 0; i < prior_calls.length; i++) {
    const c = prior_calls[i]!;
    if (c.primitive !== 'capacity_spec') continue;
    if (c.status !== 'ok' && c.status !== 'ok_partial') continue;
    if (intent_id !== undefined) {
      if (c.intent_id === intent_id) return null;
    } else if (c.intent_id === undefined) {
      return null;
    }
  }
  return {
    rule: 'bridge_dispatch_requires_capacity_check',
    call_index: prior_calls.length,
    detail: `bridge.dispatch (intent_id=${intent_id ?? '<none>'}) blocked pre-execution: no preceding capacity_spec ok for the same intent or pre-flight`,
  };
};
