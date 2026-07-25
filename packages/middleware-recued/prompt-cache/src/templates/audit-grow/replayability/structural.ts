/** D-164 P4h-2 — audit-grow replayability: structural step-kind check.
 *
 *  Classifies a candidate template's recorded step sequence as
 *  short-circuit-eligible (`render_template`) or full-executor-path
 *  (`structural_plan`). Pure function over step-type strings: the
 *  caller has already mined the kinds from wherever they live (audit
 *  log feed, D-153 commit log walk, recipe step inspector at promotion
 *  time) — the classifier doesn't reach into any storage shape.
 *
 *  The rule (design O-6 + § 3 Invariant 2):
 *
 *  - **Deterministic** by construction iff EVERY step kind is one of
 *    `{ 'query', 'list', 'transform', 'render' }`. Those four are the
 *    NER-template vocabulary: `entity.query` / `entity.list` warehouse
 *    reads, pure `transform` projections, and templated `render`
 *    emission. None can mutate; none can call out to an LLM at gate
 *    time. → `'render_template'` (short-circuit-eligible).
 *  - **Any other step kind disqualifies.** The spec calls out `ai-*`
 *    by name (the prototypical disqualifier), but the broader rule is
 *    "anything outside the deterministic four". Mutations, vendor
 *    actions, recipe dispatches — all of them route through the main
 *    executor + gateway path, where audit + approval + commit landing
 *    still apply. → `'structural_plan'` (NOT short-circuit-eligible).
 *
 *  The classification is a SUGGESTION, not a gate. The Kitchen UI
 *  surfaces it as the default selection at promotion time (design
 *  O-6); the registration-time validator is the gate that actually
 *  enforces `render_template ⇒ deterministic-only`. A user who picks
 *  `render_template` for a sequence the classifier flagged as
 *  `structural_plan` still hits the validator's `ai-*` reject path
 *  (or the broader path-validator that lands with audit-grow store
 *  P4h-4) — this slice's only job is informing the default.
 *
 *  Caller contracts:
 *
 *  - **Non-empty input.** The classifier throws `RangeError` on an
 *    empty `step_kinds` array. A zero-step audit row is a contract
 *    violation upstream (a recipe with no steps would never have
 *    produced an action-history entry to promote) — surfacing it as
 *    `render_template` (vacuously deterministic) or `structural_plan`
 *    (silently swallowing the bug) both hide the upstream defect.
 *    Mirrors `promotion.ts`'s throw-on-bad-input posture.
 *
 *  - **Step kinds are opaque strings.** The classifier has no opinion
 *    on how the caller obtained them. The audit substrate's per-step
 *    field was retired in D-145 slice 3b.4; today's callers walk D-153
 *    commits (`commit_kind` carries the action/query split) plus the
 *    recipe step list (the in-memory recipe still carries `transform`
 *    / `ingredient` / `guard` kinds — and ingredient slugs like
 *    `ai-extract`, `entity-query`, etc.). The mapping from those raw
 *    shapes to the four-kind vocabulary lives in the caller; this
 *    function only classifies the result.
 *
 *  - **Order-preserving deduplication.** `disqualifying_step_kinds`
 *    lists each unique non-deterministic kind in first-seen order so
 *    the Kitchen UI can render a deterministic explanation ("found
 *    ai-extract, then entity-action-hubspot") without sorting. The
 *    list is empty for `render_template`.
 *
 *  See: D-164
 *  § 1 templates/audit-grow/replayability + § 3 Invariant 2 + O-6. */

import type { TemplateKind } from '../../../types.js';

/** Closed list of step kinds that are short-circuit-safe by
 *  construction. Aligned with § 3 Invariant 2: NER-templates can only
 *  reach `entity.query` (`'query'`), `entity.list` (`'list'`), pure
 *  projections (`'transform'`), and templated emission (`'render'`).
 *  Frozen at module-load so accidental mutation by a caller never
 *  silently widens the allow-list. */
export const DETERMINISTIC_STEP_KINDS = Object.freeze(
  ['query', 'list', 'transform', 'render'] as const,
);

/** String-literal union derived from `DETERMINISTIC_STEP_KINDS`. */
export type DeterministicStepKind = (typeof DETERMINISTIC_STEP_KINDS)[number];

/** Predicate — true iff `value` is one of the four deterministic
 *  kinds. Narrows `string` to `DeterministicStepKind` so callers can
 *  use it as a type guard without re-listing the closed set. */
export const isDeterministicStepKind = (
  value: string,
): value is DeterministicStepKind =>
  (DETERMINISTIC_STEP_KINDS as readonly string[]).includes(value);

/** Shared frozen empty array for the render_template happy path so
 *  the classifier doesn't allocate a fresh empty list per call.
 *  `Object.freeze([])` returns a typed empty `readonly never[]` —
 *  cast to `readonly string[]` so the parent shape's array element
 *  type is preserved without a per-call cast inside the return
 *  expression. */
const EMPTY_DISQUALIFYING: ReadonlyArray<string> = Object.freeze(
  [] as readonly string[],
);

/** Input to `classifyReplayability`. Wrapping shape (rather than a
 *  bare array) so future fields — locale-specific rules, validator
 *  strictness, action-class hints — can land additively without
 *  breaking call sites. */
export interface ClassifyReplayabilityInput {
  /** Ordered sequence of step-kind strings from one audit-grow
   *  candidate's recorded execution. Must be non-empty (see module
   *  header "Non-empty input" caller contract). The classifier
   *  doesn't inspect order beyond preserving first-seen ordering in
   *  the disqualifying list. */
  readonly step_kinds: ReadonlyArray<string>;
}

/** Output of `classifyReplayability`. Discriminated on `kind` and
 *  aligned with `TemplateKind` from `types.ts` so callers can pass the
 *  classification straight through to the library's match key + the
 *  Kitchen UI's promotion dialog without a remap layer.
 *
 *  - `kind: 'render_template'` → every step kind is in the
 *    deterministic four. `disqualifying_step_kinds` is empty.
 *  - `kind: 'structural_plan'` → at least one step kind is outside
 *    the deterministic four. `disqualifying_step_kinds` carries the
 *    deduplicated, first-seen offenders. */
export interface ReplayabilityClassification {
  readonly kind: TemplateKind;
  readonly disqualifying_step_kinds: ReadonlyArray<string>;
}

/** Classify a recorded step sequence's replayability. See module
 *  header for the rule, caller contracts, and design references. */
export const classifyReplayability = (
  input: ClassifyReplayabilityInput,
): ReplayabilityClassification => {
  if (input.step_kinds.length === 0) {
    throw new RangeError(
      'classifyReplayability: step_kinds must be a non-empty array',
    );
  }

  const seen = new Set<string>();
  const disqualifying: string[] = [];
  for (const kind of input.step_kinds) {
    if (isDeterministicStepKind(kind)) continue;
    if (seen.has(kind)) continue;
    seen.add(kind);
    disqualifying.push(kind);
  }

  if (disqualifying.length === 0) {
    return Object.freeze({
      kind: 'render_template' as const,
      disqualifying_step_kinds: EMPTY_DISQUALIFYING,
    });
  }

  return Object.freeze({
    kind: 'structural_plan' as const,
    disqualifying_step_kinds: Object.freeze(disqualifying as readonly string[]),
  });
};
