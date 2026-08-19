/** D-145 PB5 — AI-cooperative substrate types.
 *
 *  Per § B.6 (visible multi-turn loop + alternatives + `fixed_slots`
 *  invariant). Two paired principles, substrate-level:
 *
 *    1. Visible multi-turn AI ↔ Recued loop (§ B.6.1) — complex
 *       requests typically span multiple AI ↔ Recued tool-call rounds;
 *       the substrate makes the loop *visible* in the Transparency
 *       Stream (one `recued.multi_turn.round_*` event per round) rather
 *       than collapsing it to a single final result.
 *
 *    2. Pre-emptive alternatives in action results (§ B.6.4-§ B.6.10)
 *       — kernel ingredients that perform actions with potential
 *       conflict / ambiguity return the primary `result` PLUS
 *       `alternatives` in the same call. Each alternative MUST
 *       preserve every field listed in the request's `fixed_slots`
 *       (§ B.6.5-§ B.6.8) — substrate runtime gate drops drifted
 *       alternatives + emits `fixed_slot_drift` invariant violations.
 *
 *  Closed-list constants + pure types here; the engine layer
 *  (`packages/engine/src/ai-cooperative/`) implements:
 *    - `enforceFixedSlots` runtime gate per § B.6.8 (drops drifting
 *      alternatives, emits violation events)
 *    - `processActionResult` validator-gate processor per § B.6.4 +
 *      § B.6.9 (ranks by confidence, preserves empty-alternatives
 *      passthrough)
 *    - `runMultiTurnLoop` discipline per § B.6.1-§ B.6.3 (per-round
 *      Transparency Stream emission)
 *
 *  Spec: § B.6 + § B.15.7 (alternatives all fail) + § B.6.11 (validator
 *  gate on ingredient submission). */

// ── PB5.1 — ActionRequest / ActionResult shapes (§ B.6.6) ────────────

/** § B.6.6 — kernel ingredient inbound shape. The caller declares
 *  `args` (the action parameters) + `fixed_slots` (the field names
 *  that semantically must NOT vary across alternatives — typically
 *  named entities like `person` or `venue`). The substrate enforces
 *  preservation at the gate boundary; the ingredient is responsible
 *  for honoring the slots when it generates alternatives. */
export interface ActionRequest<TArgs> {
  readonly args: TArgs;
  /** Field names in `args` that must be preserved exactly across every
   *  alternative. Substrate runtime gate (`enforceFixedSlots`) drops
   *  any alternative whose `args[slot]` deep-differs from the request.
   *  Empty array allowed (e.g. when nothing semantically fixed —
   *  rare). */
  readonly fixed_slots: ReadonlyArray<keyof TArgs>;
}

/** § B.6.6 — kernel ingredient outbound shape.
 *
 *  - `result` carries the primary chosen value when the action could be
 *    performed; `null` signals conflict / ambiguity (alternatives
 *    array typically populated, OR empty + `conflict` per § B.6.9).
 *  - `alternatives` is OPTIONAL; when present each entry's `args` MUST
 *    preserve every `fixed_slots` field of the original `ActionRequest`
 *    or the substrate drops it.
 *  - `conflict` is REQUIRED-when-no-result-and-empty-alternatives per
 *    § B.6.9 (engine surfaces this user-facing copy when no acceptable
 *    solution exists). */
export interface ActionResult<TArgs> {
  readonly result: TArgs | null;
  readonly conflict?: string;
  readonly alternatives?: ReadonlyArray<{
    readonly args: TArgs;
    /** `0..1` — caller's confidence in this alternative. The
     *  substrate sorts descending by confidence so AI sees the best
     *  candidate first. */
    readonly confidence: number;
    /** Optional caller-provided rationale for *why* this alternative
     *  is good ("usual cafe", "Bob's free 9-10 Tue"). Closed against
     *  user content — ingredient-author-provided, not user input. */
    readonly annotation?: string;
  }>;
  /** Telemetry only — substrate consumers (Transparency Stream
   *  composer, benchmark fixtures) read this to score round-trip
   *  reduction (§ B.6.13). */
  readonly meta?: { readonly rounds_avoided?: number };
}

// ── PB5.2 — Closed-list invariant violation kinds ────────────────────

/** Closed list of substrate invariant violations the AI-cooperative
 *  layer can emit. § B.6.8 ratchet pins membership. PB5 ratchet test
 *  asserts membership; drift requires substrate D-spec change. */
export const FIXED_SLOT_INVARIANT_VIOLATION_KINDS = [
  /** § B.6.8 — alternative's `args[slot]` does not match the
   *  request's `args[slot]`. The substrate drops the alternative;
   *  ingredient bug. */
  'fixed_slot_drift',
  /** Alternative entry referenced a slot name that's not a key of the
   *  request's args (typo / stale ingredient). Same drop semantics. */
  'fixed_slot_unknown_field',
] as const;
export type FixedSlotInvariantViolationKind =
  (typeof FIXED_SLOT_INVARIANT_VIOLATION_KINDS)[number];
export const FIXED_SLOT_INVARIANT_VIOLATION_KIND_SET: ReadonlySet<FixedSlotInvariantViolationKind> =
  new Set(FIXED_SLOT_INVARIANT_VIOLATION_KINDS);

/** Substrate invariant violation event shape — emitted to the
 *  Transparency Stream + audit log when a fixed-slot drift is caught.
 *  PB5's `enforceFixedSlots` is the canonical emitter; PB7's stream
 *  composer renders the Recued-voiced narrative ("an ingredient
 *  returned an alternative that changed something I'd marked
 *  fixed — dropped"). Closed-list `kind` so PB7 can pin templates. */
export interface FixedSlotInvariantViolation {
  readonly kind: FixedSlotInvariantViolationKind;
  /** Field name on `ActionRequest.args` that was supposed to stay
   *  fixed. Closed to keys of TArgs by the gate (string at the wire
   *  layer). */
  readonly slot: string;
  /** Index of the dropped alternative in the original
   *  `ActionResult.alternatives` array. Useful for audit replay. */
  readonly alternative_index: number;
}

// ── PB5.3 — Closed-list multi-turn loop event kinds (§ B.6.1) ────────

/** Closed list of Transparency Stream event kinds the multi-turn
 *  loop discipline emits per § B.6.1-§ B.6.3. PB7 renders each via a
 *  Recued voice template. PB5 ratchet test pins membership.
 *
 *  Naming uses the `recued.multi_turn.*` namespace so PB7's closed
 *  taxonomy can group all multi-turn events under one prefix. */
export const MULTI_TURN_EVENT_KINDS = [
  /** Round started — emitted before the AI ↔ Recued exchange that
   *  drives this round. Carries `round_index` (0-based) +
   *  `expected_max_rounds` from the tier's `TierPacketBudget`. */
  'recued.multi_turn.round_started',
  /** Round completed — emitted after the round's tool calls + AI
   *  responses settle. Carries `round_index` + `tool_calls_executed`
   *  + `alternatives_returned` (counts only — never user content). */
  'recued.multi_turn.round_completed',
  /** Loop terminated — emitted when the multi-turn loop exits
   *  cleanly (success), via early termination (no further AI
   *  request), or by hitting the tier's `max_rounds` ceiling. Carries
   *  `total_rounds` + `termination_reason` (closed list). */
  'recued.multi_turn.loop_terminated',
] as const;
export type MultiTurnEventKind = (typeof MULTI_TURN_EVENT_KINDS)[number];
export const MULTI_TURN_EVENT_KIND_SET: ReadonlySet<MultiTurnEventKind> = new Set(
  MULTI_TURN_EVENT_KINDS,
);

/** Closed list of multi-turn loop termination reasons. PB7 renders
 *  each via a Recued voice template; PB15 maps `max_rounds_exhausted`
 *  to a `failure_class: 'cost'` row when the orchestrator widens. */
export const MULTI_TURN_TERMINATION_REASONS = [
  /** Loop body signaled "no further work needed" — typical happy path
   *  (AI's last `tool_calls[]` was empty + `events[]` produced final
   *  state). */
  'completed',
  /** Tier's `TierPacketBudget.max_rounds` reached — the loop body
   *  STILL wants to fire another round. Engine halts here (not the
   *  AI): the budget is calculated, deterministic, audit-replayable. */
  'max_rounds_exhausted',
  /** Orchestrator-side abort (e.g. cost ceiling halt mid-loop, SI
   *  conflict detected, capacity gap mid-run per § B.15.4). */
  'aborted',
  /** The loop ended because the model's last output could not be READ as a
   *  turn — empty after the recovery retry, or carrying tool calls in a shape
   *  the coercer does not recognise.
   *
   *  ⛔⛔ THIS USED TO REPORT `completed`, AND THAT WAS THE EXPENSIVE PART. A
   *  turn that dispatched nothing because its final packet was unparseable is
   *  not a happy path, but it exits through the same `!moreTools` branch as one
   *  that genuinely finished — so telemetry, the D-219 flow compiler and any
   *  reader all saw a clean completion. Measured on bench 181: of five
   *  slice+lean-core runs, THREE ended on an unrecovered empty and TWO on a
   *  dropped tool call whose content was the NEXT STEP OF THE CHAIN. All five
   *  reported `completed`.
   *
   *  ⚠ It is NOT a failure of the run — work already dispatched stands, and the
   *  owner still gets `EMPTY_AI_OUTPUT_MESSAGE`. It is a statement that the turn
   *  stopped for a reason nobody chose. */
  'output_unreadable',
] as const;
export type MultiTurnTerminationReason =
  (typeof MULTI_TURN_TERMINATION_REASONS)[number];
export const MULTI_TURN_TERMINATION_REASON_SET: ReadonlySet<MultiTurnTerminationReason> =
  new Set(MULTI_TURN_TERMINATION_REASONS);

// ── PB5.4 — Validator-gate output shape (§ B.6.4 + § B.6.8 + § B.6.9) ─

/** Output of `processActionResult` — the substrate's wrapper around
 *  a kernel ingredient's `ActionResult<TArgs>`. The processor:
 *    - drops drifting alternatives via `enforceFixedSlots` (§ B.6.8)
 *    - sorts surviving alternatives by `confidence` descending
 *    - records each dropped alternative + violation reason for audit
 *    - preserves the original `result` + `conflict` + `meta` fields
 *    - never fabricates alternatives (§ B.6.9 — empty stays empty)
 *
 *  Engine consumers (the main-turn composer, PB13 Dry Run wrapper)
 *  read `processed.alternatives` to hand to AI; `processed.violations`
 *  feeds the Transparency Stream + audit emission. */
export interface ProcessedActionResult<TArgs> {
  readonly original_result: TArgs | null;
  readonly conflict?: string;
  /** Surviving alternatives sorted by `confidence` descending. Capped
   *  at `tier.TierPacketBudget.max_alternatives` by the caller;
   *  the processor itself does NOT truncate — it returns every
   *  surviving alternative so the caller can audit-log the full
   *  ingredient response. */
  readonly alternatives: ReadonlyArray<{
    readonly args: TArgs;
    readonly confidence: number;
    readonly annotation?: string;
  }>;
  /** Alternatives that were dropped + the violation that caused the
   *  drop. PB7's composer emits one Transparency Stream event per
   *  violation. */
  readonly violations: ReadonlyArray<FixedSlotInvariantViolation>;
  readonly meta?: { readonly rounds_avoided?: number };
}

// ── PB5.5 — Validator-gate manifest declaration (§ B.6.11) ───────────

/** § B.6.11 — manifest field that declares whether an ingredient
 *  participates in the AI-cooperative substrate. Optional — only
 *  ingredients the validator's pattern detector flags as
 *  "action-with-conflict-potential" (`category: 'action'` AND
 *  `risk_tier ∈ {'write', 'admin', 'destructive'}` AND
 *  `kind ∈ {'http', 'mcp', 'connection', 'storage', 'service'}`) are
 *  required to either declare `declares_alternatives: true` (with
 *  `fixed_slots_honored: true`) OR explicitly opt out with a
 *  `opt_out_rationale` string explaining why alternatives don't apply.
 *
 *  Substrate validator (`validateAiCooperativeManifest`) gates at
 *  install time. Marketplace-published ingredients without a
 *  declaration when the pattern fires get a warning at PB5; the
 *  marketplace flow can promote to error after the kernel ingredient
 *  catalog declares uniformly. */
export interface AiCooperativeManifestDeclaration {
  /** True when the ingredient returns an `ActionResult<TArgs>` with
   *  alternatives by default (typical pattern). False when the
   *  ingredient is explicitly NOT alternative-bearing — `opt_out_rationale`
   *  becomes required. */
  readonly declares_alternatives: boolean;
  /** True when the ingredient's alternative-generation logic preserves
   *  every `fixed_slots` field across every alternative. Required when
   *  `declares_alternatives: true`. */
  readonly fixed_slots_honored?: boolean;
  /** Free-text rationale required when `declares_alternatives: false`.
   *  Surfaces in marketplace review + Settings → Ingredients audit so
   *  the user understands *why* this ingredient is alternative-free.
   *  Closed to ≥ 16 chars (rejects empty / placeholder strings). */
  readonly opt_out_rationale?: string;
}

/** Closed list of validator issue kinds the manifest gate emits at
 *  install time. PB5 ratchet test pins membership. */
export const AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS = [
  /** Ingredient matches action-with-conflict-potential pattern but the
   *  manifest carries no `ai_cooperative` declaration. Severity:
   *  `warn` at PB5 (kernel catalog migration); promotable to `error`
   *  when every kernel manifest declares. */
  'ai_cooperative_declaration_missing',
  /** `declares_alternatives: true` but `fixed_slots_honored` not set
   *  to true. Severity: `error`. */
  'ai_cooperative_fixed_slots_not_honored',
  /** `declares_alternatives: false` but `opt_out_rationale` missing
   *  or under-length. Severity: `error`. */
  'ai_cooperative_opt_out_rationale_required',
  /** Both `declares_alternatives: true` and `opt_out_rationale` set —
   *  contradictory. Severity: `error`. */
  'ai_cooperative_declaration_contradictory',
] as const;
export type AiCooperativeValidatorIssueKind =
  (typeof AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS)[number];
export const AI_COOPERATIVE_VALIDATOR_ISSUE_KIND_SET: ReadonlySet<AiCooperativeValidatorIssueKind> =
  new Set(AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS);

/** Minimum non-placeholder length for `opt_out_rationale`. Rejects
 *  empty / "TODO" / "n/a" placeholder strings at validate time. */
export const AI_COOPERATIVE_OPT_OUT_RATIONALE_MIN_CHARS = 16;

// ── PB5.6 — Substrate self-check ─────────────────────────────────────

/** Defensive runtime check — every closed-list constant is non-empty
 *  + frozen + members are unique. The orchestrator could call this
 *  at boot; PB5 ratchet asserts on the same invariants. */
export const assertAiCooperativeInvariants = (): void => {
  const checkClosedList = <T extends string>(
    name: string,
    list: ReadonlyArray<T>,
    set: ReadonlySet<T>,
  ): void => {
    const length = list.length as number;
    if (length === 0) {
      throw new Error(`${name} must be non-empty`);
    }
    if (set.size !== length) {
      throw new Error(`${name} contains duplicates`);
    }
  };
  checkClosedList(
    'FIXED_SLOT_INVARIANT_VIOLATION_KINDS',
    FIXED_SLOT_INVARIANT_VIOLATION_KINDS,
    FIXED_SLOT_INVARIANT_VIOLATION_KIND_SET,
  );
  checkClosedList(
    'MULTI_TURN_EVENT_KINDS',
    MULTI_TURN_EVENT_KINDS,
    MULTI_TURN_EVENT_KIND_SET,
  );
  checkClosedList(
    'MULTI_TURN_TERMINATION_REASONS',
    MULTI_TURN_TERMINATION_REASONS,
    MULTI_TURN_TERMINATION_REASON_SET,
  );
  checkClosedList(
    'AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS',
    AI_COOPERATIVE_VALIDATOR_ISSUE_KINDS,
    AI_COOPERATIVE_VALIDATOR_ISSUE_KIND_SET,
  );
  if (AI_COOPERATIVE_OPT_OUT_RATIONALE_MIN_CHARS <= 0) {
    throw new Error('AI_COOPERATIVE_OPT_OUT_RATIONALE_MIN_CHARS must be positive');
  }
};
