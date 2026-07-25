/** D-145 PB5 — `processActionResult` substrate validator-gate processor.
 *
 *  Wraps a kernel ingredient's `ActionResult<TArgs>`:
 *    1. Runs `enforceFixedSlots` (§ B.6.8) over alternatives.
 *    2. Sorts survivors by `confidence` descending (stable sort —
 *       equal-confidence entries preserve their `original_index` order).
 *    3. Builds Transparency Stream `fixed_slot_drift` event envelopes
 *       (one per dropped alternative; PB7's renderer surfaces the
 *       Recued voice template).
 *    4. Preserves the original `result` + `conflict` + `meta` fields.
 *    5. Never fabricates alternatives (§ B.6.9 — empty stays empty;
 *       even when every input alternative drops, the substrate refuses
 *       to invent replacements).
 *
 *  Pure function — no IO, no side effects. The caller (the main-turn
 *  composer / PB13 Dry Run wrapper / multi-turn loop body) is the
 *  emission boundary; the processor returns the events as data so the
 *  caller can route through the orchestrator's `PlanDraft` (which is
 *  what threads them to the Transparency Stream + audit log).
 *
 *  Spec: § B.6.4 + § B.6.8 + § B.6.9. */

import {
  defaultRedactionForKind,
  type ActionRequest,
  type ActionResult,
  type FixedSlotInvariantViolation,
  type ProcessedActionResult,
  type TransparencyEvent,
  type TransparencyEventEnvelope,
} from '@recued/contracts';

import { enforceFixedSlots } from './enforce-fixed-slots.js';

/** Closed-list Transparency Stream event kind for fixed-slot drift.
 *  Aligned with the substrate's invariant violation kinds in
 *  `@recued/contracts/ai-cooperative` — closed-character-set so PB7's
 *  composer pins the renderer template. */
export const FIXED_SLOT_DRIFT_EVENT_KIND = 'fixed_slot_drift' as const;

/** PB7 wire-envelope helper — wraps a closed `TransparencyEvent` into
 *  the spec wire shape `{ event, redaction, emitted_at }` per § B.8.2.1
 *  using the per-kind default redaction tier. Settings filtering
 *  happens upstream when the envelope flows through
 *  `composeTransparencyEvent`. */
const wrapAsEnvelope = (event: TransparencyEvent): TransparencyEventEnvelope => ({
  event,
  redaction: defaultRedactionForKind(event.kind),
  emitted_at: Date.now(),
});

/** Build the Transparency Stream envelope for a single fixed-slot
 *  violation. Closed-list payload — `violation_kind` (which violation),
 *  `slot` (closed to keys of TArgs at the gate boundary, plain string
 *  at the wire), and `alternative_index` (0-based). NEVER includes the
 *  alternative's `args` payload — closed against user content per the
 *  privacy-class contract (§ B.2.3). */
export const buildFixedSlotDriftEvent = (
  violation: FixedSlotInvariantViolation,
): TransparencyEventEnvelope =>
  wrapAsEnvelope({
    kind: FIXED_SLOT_DRIFT_EVENT_KIND,
    violation_kind: violation.kind,
    slot: violation.slot,
    alternative_index: violation.alternative_index,
  });

/** § B.6.4 + § B.6.8 + § B.6.9 — substrate validator-gate processor.
 *
 *  Returns:
 *    - `processed`: ProcessedActionResult<TArgs> — survivors sorted by
 *      confidence descending; original `result`/`conflict`/`meta`
 *      preserved; violation list attached.
 *    - `events`: TransparencyEventEnvelope[] — one envelope per
 *      violation. Caller routes these through `PlanDraft`. Empty array
 *      when no violations.
 *
 *  Empty `result.alternatives` → `processed.alternatives === []` +
 *  zero events (the empty-alternatives passthrough invariant per
 *  § B.6.9 — substrate refuses to fabricate). */
export interface ProcessActionResultOutput<TArgs> {
  readonly processed: ProcessedActionResult<TArgs>;
  readonly events: ReadonlyArray<TransparencyEventEnvelope>;
}

export const processActionResult = <TArgs>(
  req: ActionRequest<TArgs>,
  result: ActionResult<TArgs>,
): ProcessActionResultOutput<TArgs> => {
  const { survivors, violations } = enforceFixedSlots(req, result);

  // Stable sort: pre-bind original index so equal-confidence entries
  // retain their original ordering. The processor sorts descending by
  // confidence so AI sees the strongest candidate first.
  const sorted = survivors
    .map((s, idx) => ({ s, idx }))
    .sort((a, b) => {
      if (b.s.confidence !== a.s.confidence) {
        return b.s.confidence - a.s.confidence;
      }
      // Stable: lower original_index first so the kernel ingredient's
      // declared ordering breaks ties (typically wall-clock or some
      // ingredient-specific signal).
      if (a.s.original_index !== b.s.original_index) {
        return a.s.original_index - b.s.original_index;
      }
      return a.idx - b.idx;
    })
    .map(({ s }) => {
      const out: {
        readonly args: TArgs;
        readonly confidence: number;
        readonly annotation?: string;
      } = s.annotation !== undefined
        ? { args: s.args, confidence: s.confidence, annotation: s.annotation }
        : { args: s.args, confidence: s.confidence };
      return out;
    });

  const processed: ProcessedActionResult<TArgs> = {
    original_result: result.result,
    ...(result.conflict !== undefined ? { conflict: result.conflict } : {}),
    alternatives: sorted,
    violations,
    ...(result.meta !== undefined ? { meta: result.meta } : {}),
  };

  const events: TransparencyEventEnvelope[] = violations.map(
    buildFixedSlotDriftEvent,
  );

  return { processed, events };
};
