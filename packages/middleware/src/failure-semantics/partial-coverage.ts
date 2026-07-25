/** D-145 PB15 — partial-primitive-failure coverage metadata composer.
 *
 *  Per § B.15.2. When a primitive call partially succeeds (e.g.,
 *  `data.fetch` returns 8 of 10 expected sources due to one source
 *  quota-suspended), the engine:
 *
 *    1. Records the partial failure in `primitive_calls[].status:
 *       'ok_partial'` (already supported in the IR closed list).
 *    2. Adds `coverage.sources_degraded: { source, reason, since }` to
 *       `included_context` entries derived from the partial fetch.
 *    3. May continue (sufficient context) OR halt with
 *       `coverage_insufficient` (when missing source is critical).
 *    4. AI packet receives the coverage metadata.
 *
 *  This module ships:
 *    - The closed-list `PartialCoverageReason` taxonomy
 *    - `composePartialCoverage` — builds a `ContextItem.redacted_payload`
 *      JSON-encoded coverage envelope that the AI packet composer
 *      reads. Stays inside the persist_policy='redacted_only' rail.
 *    - `shouldHaltOnCoverageGap` — caller-provided criticality
 *      predicate, with a closed-list default the orchestrator uses
 *      when no override fits.
 *
 *  Pure functions — no IO, no mutation of input.
 *
 *  Spec: § B.15.2 + § B.5.2. */

import type { ContextItem } from '@recued/contracts';

/** Closed-list reasons a source can be degraded. Drift requires
 *  substrate D-spec work. */
export const PARTIAL_COVERAGE_REASONS = [
  'quota_suspended',
  'auth_expired',
  'rate_limited',
  'source_unavailable',
  'timeout',
  'capacity_gap',
] as const;
export type PartialCoverageReason = (typeof PARTIAL_COVERAGE_REASONS)[number];
export const PARTIAL_COVERAGE_REASON_SET: ReadonlySet<PartialCoverageReason> = new Set(
  PARTIAL_COVERAGE_REASONS,
);

export interface DegradedSource {
  /** Audit-clean identifier (source id / vendor name / capacity key).
   *  Closed-character — never user content. */
  readonly source: string;
  readonly reason: PartialCoverageReason;
  /** Epoch ms — when the degradation first observed. */
  readonly since: number;
}

export interface PartialCoverageEnvelope {
  readonly sources_degraded: ReadonlyArray<DegradedSource>;
  /** Substrate marker so AI packet readers can detect coverage
   *  metadata via JSON-shape predicate without parsing full body. */
  readonly partial_coverage: true;
}

/** Build the coverage envelope. Returns a frozen object — caller may
 *  serialize it via `JSON.stringify` into the `redacted_payload`
 *  field of a synthesized ContextItem. */
export const composePartialCoverage = (
  degraded: ReadonlyArray<DegradedSource>,
): PartialCoverageEnvelope => {
  for (let i = 0; i < degraded.length; i++) {
    const entry = degraded[i]!;
    if (!PARTIAL_COVERAGE_REASON_SET.has(entry.reason)) {
      throw new Error(
        `composePartialCoverage: degraded[${i}].reason '${entry.reason}' is not in PARTIAL_COVERAGE_REASONS`,
      );
    }
  }
  return Object.freeze({
    sources_degraded: Object.freeze([...degraded]),
    partial_coverage: true as const,
  });
};

export interface CoverageGapInput {
  /** Sources successfully fetched. */
  readonly succeeded_sources: ReadonlyArray<string>;
  /** Sources marked degraded for this call. */
  readonly degraded_sources: ReadonlyArray<string>;
  /** Sources the orchestration policy declared critical for this
   *  request (caller-supplied — closed list per the policy's intent
   *  classification). When ANY critical source is in `degraded_sources`,
   *  the engine halts with `coverage_insufficient`. */
  readonly critical_sources: ReadonlyArray<string>;
}

export type CoverageGapDecision =
  | { readonly kind: 'continue' }
  | {
      readonly kind: 'halt';
      readonly halt_status: 'cancelled_capacity_gap';
      /** Sources that were both critical AND degraded — caller threads
       *  into the failure result detail. */
      readonly critical_missing: ReadonlyArray<string>;
    };

/** Decide whether the partial coverage warrants a halt. Returns
 *  `continue` when no critical source is degraded, else `halt` with
 *  the offending source list. */
export const decidePartialCoverageHalt = (input: CoverageGapInput): CoverageGapDecision => {
  if (input.critical_sources.length === 0) {
    return { kind: 'continue' };
  }
  const degraded = new Set(input.degraded_sources);
  const missing = input.critical_sources.filter((s) => degraded.has(s));
  if (missing.length === 0) {
    return { kind: 'continue' };
  }
  return {
    kind: 'halt',
    halt_status: 'cancelled_capacity_gap',
    critical_missing: missing,
  };
};

/** Synthesize a `ContextItem` that carries the coverage envelope so
 *  the AI packet composer can include it alongside the partial fetch's
 *  context. The synthesized item is `'system_provenance'` content_class
 *  + `'persist'` persist_policy (coverage metadata about engine state,
 *  not user content). */
export const buildCoverageContextItem = (args: {
  readonly source_ref: string;
  readonly envelope: PartialCoverageEnvelope;
}): ContextItem => ({
  source_ref: args.source_ref,
  content_class: 'system_provenance',
  persist_policy: 'persist',
  redacted_payload: JSON.stringify(args.envelope),
});
