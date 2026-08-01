/** D-214 Execution Cases — request → flow precedent, harvested from the
 *  governed boundary and fed back as ADVISORY evidence.
 *
 *  Read D-214 §4–§10 before changing anything here. Three
 *  invariants are load-bearing and none of them are visible from the types
 *  alone:
 *
 *  1. ⛔ **Aggregation is exact; retrieval is graded** (§8.1, §10.1). One hash
 *     cannot do both jobs — an exact hash is binary and cannot express "find
 *     similar ones". `request_shape_hash` drives aggregation ONLY. A15
 *     collapsed the two and A17 had to split them back apart; never re-merge.
 *  2. ⛔ **Nothing derived from the executed flow may enter the request shape**
 *     (§8.2.2). "email Alice the Q3 report" attempted as `file.search` then
 *     `mail.send` must produce ONE request shape, or the negative and the
 *     positive never meet and supersession collapses. Flow-derived facets live
 *     on {@link FlowPattern}.
 *  3. ⛔ **Flow is content, never a key** (A18, MEASURED). Across the 1946
 *     recipes in `community/recipes/`, exact flow signatures are 94% unique and
 *     every abstraction that collapses them puts one family on 43% of the
 *     corpus — a cliff, not a gradient. Keyed on flow, every execution is its
 *     own row and no positive case would ever admit. A case is keyed on the
 *     REQUEST and holds {@link ExecutionCase.flows} as content.
 *
 *  Advisory by construction: nothing here gates, permits, or blocks. It is
 *  presented to a model that judges applicability itself (§10.2, acceptance
 *  #13/#23).
 */

// ────────────────────────────────────────────────────────────────
// §4.1 — Outcome report
// ────────────────────────────────────────────────────────────────

/** The model's semantic self-assessment. Weak evidence by definition: three of
 *  these are one evidence family, and repetition cannot turn self-report into
 *  independent verification (§7). */
export type OutcomeClaim = 'fulfilled' | 'partial' | 'unfulfilled' | 'unknown';

export const OUTCOME_CLAIMS: ReadonlyArray<OutcomeClaim> = [
  'fulfilled',
  'partial',
  'unfulfilled',
  'unknown',
] as const;

export const OUTCOME_CLAIM_SET: ReadonlySet<OutcomeClaim> = new Set(
  OUTCOME_CLAIMS,
);

export const isOutcomeClaim = (value: unknown): value is OutcomeClaim =>
  typeof value === 'string' && OUTCOME_CLAIM_SET.has(value as OutcomeClaim);

/** §4.1 — the ENTIRE model-facing argument surface of `outcome.report`.
 *
 *  ⛔ **This interface is a ratchet, not just a shape.** The model supplies no
 *  evidence references, no request/session/run/contract/event ids, no scope,
 *  and no confidence. Everything else on {@link OutcomeReport} is constructed
 *  by the server. A model-supplied hash or id could name any stored case —
 *  total retrieval steering — so none is ever accepted. Adding a field here
 *  widens the only surface the model controls; do it deliberately or not at
 *  all. */
export interface OutcomeReportArgs {
  claim: OutcomeClaim;
  /** ⛔ **WRITE-ONLY BY DESIGN, AND THAT IS A SECURITY PROPERTY** (A21, §4.1).
   *
   *  This is the only free-text field the model authors anywhere in the report
   *  contract — everything else is a closed enum or server-stamped — so it is
   *  exactly where a model would stash things for its future self. It is
   *  structurally unreachable: absent from {@link ExecutionCaseCard}, excluded
   *  from `memory.search` (§11.2), unsearched by `recall.search` (§11.3). **A
   *  write-only sink cannot function as memory**, so there is no incentive to
   *  abuse it.
   *
   *  ⚠ That guard holds only as three separate omissions lining up. Putting
   *  `open_items` on a card would look like helpful context and would silently
   *  convert `outcome.report` into a memory tool. Never do it. */
  open_items?: string[];
}

/** §4.1 — the durable envelope Recued constructs around the model's claim. The
 *  model reports a claim, not truth; every correlating field here is
 *  server-derived. */
export interface OutcomeReport {
  report_id: string;
  execution_span_id: string;
  governing_contract_id: string;
  /** Optional ONLY because a report may be minted before principal resolution
   *  completes. A case cannot be admitted until it is set (§8.1). */
  principal_key?: string;
  root_request_id: string;
  root_request: string;
  event_range: {
    first_event_id: string;
    last_event_id: string;
  };
  model_claim: OutcomeClaim;
  open_items: string[];
  /** §8.2 — the case keys whose cards or critiques this span consumed.
   *  Server-stamped by the retrieval layer, NEVER model-supplied.
   *
   *  Without it the A2/A31 steering-contamination rule (acceptance #26) cannot
   *  be recomputed deterministically: an observation whose span read a D-214
   *  card for the same `case_key` is not independent evidence for that case,
   *  and neither admission nor persuasive outcome projections may count it. */
  consulted_case_keys: string[];
  reported_at: number;
}

// ────────────────────────────────────────────────────────────────
// §5 — Request analysis
// ────────────────────────────────────────────────────────────────

/** §5.1 — conservative V1 routing. It decides only whether to prepare the
 *  D-214 observation path; it must NEVER short-circuit the LLM merely because
 *  it predicts `action`. */
export type RequestRoute = 'answer' | 'action' | 'unknown';

export const REQUEST_ROUTES: ReadonlyArray<RequestRoute> = [
  'answer',
  'action',
  'unknown',
] as const;

export const REQUEST_ROUTE_SET: ReadonlySet<RequestRoute> = new Set(
  REQUEST_ROUTES,
);

export const isRequestRoute = (value: unknown): value is RequestRoute =>
  typeof value === 'string' && REQUEST_ROUTE_SET.has(value as RequestRoute);

export interface RequestAnalysis {
  schema_version: 1;
  route: RequestRoute;
  request_shape?: RequestShape;
}

/** §5.2 — the FALLBACK request shape, for channels with no planning model or
 *  whose model dissection fails sealed-root grounding.
 *
 *  ⚠ {@link RequestDissection} (§5.3) is the PRIMARY path — V1 is chat-only, so
 *  every span has a planning model and this ladder is rarely if ever exercised.
 *  Both use the same server hash formula, but A31 permits conservative
 *  fragmentation between a grounded model label and the fallback text
 *  projection; they are never forced together merely to improve recall.
 *
 *  ⛔ Never normalize away negation, ordering, cardinality, stop conditions, or
 *  the difference between "draft" and "send" — those distinctions must survive
 *  into the canonical core, because aggregation keys on it exactly. */
export interface RequestShape {
  schema_version: 1;
  locale_candidates: string[];
  surface_terms: string[];
  segmented_terms: string[];
  entity_slots: Array<{
    role: string;
    kind: string;
  }>;
  intent_facets: string[];
  constraint_facets: string[];
  risk_facets: string[];
}

/** §5.3 — the PRIMARY request shape: the model dissects its own understanding
 *  of the prompt in the same call that plans, so it costs no extra round-trip
 *  and resolves context a single-string parser cannot ("send *the report*"
 *  meaning something discussed three turns earlier).
 *
 *  Three constraints keep it safe:
 *  1. the server admits `intent` to the canonical core only after the sealed
 *     root request lexically grounds it, and computes EVERY hash — a
 *     model-supplied hash is never accepted; an ungrounded dissection is
 *     ignored in favor of the server-owned fallback shape, never the whole span;
 *  2. it is emitted at **span root, not on a plan row** — reads bypass the
 *     plan-approval gate, so a plan-carried dissection would be silently absent
 *     for every read-only span;
 *  3. ⛔ nothing derived from the executed flow may enter it (§8.2.2).
 *
 *  A closed vocabulary is deliberately NOT required: retrieval is graded
 *  (A17), so grounded free text compares field-to-field. Model-authored
 *  `constraints[]` remain sealed classification metadata and do not key a
 *  case. */
export interface RequestDissection {
  schema_version: 1;
  /** Free text; grounded against the sealed root, then normalized server-side. */
  intent: string;
  objects: string[];
  entities: Array<{ role: string; kind: string }>;
  /** Negation / cardinality / time / stop conditions. */
  constraints: string[];
  outcome_sought: string;
}

// ────────────────────────────────────────────────────────────────
// §6 — Flow representation
// ────────────────────────────────────────────────────────────────

/** §6.1 — what happened to one step. Distinct from {@link StepApprovalBoundary}:
 *  permission and outcome are separate axes (§2.3). */
export type StepDisposition =
  | 'proposed'
  | 'held'
  | 'denied'
  | 'executed'
  | 'failed'
  | 'skipped';

export const STEP_DISPOSITIONS: ReadonlyArray<StepDisposition> = [
  'proposed',
  'held',
  'denied',
  'executed',
  'failed',
  'skipped',
] as const;

export const STEP_DISPOSITION_SET: ReadonlySet<StepDisposition> = new Set(
  STEP_DISPOSITIONS,
);

export const isStepDisposition = (value: unknown): value is StepDisposition =>
  typeof value === 'string'
  && STEP_DISPOSITION_SET.has(value as StepDisposition);

export type StepApprovalBoundary = 'none' | 'held' | 'approved' | 'denied';

export const STEP_APPROVAL_BOUNDARIES: ReadonlyArray<StepApprovalBoundary> = [
  'none',
  'held',
  'approved',
  'denied',
] as const;

export const STEP_APPROVAL_BOUNDARY_SET: ReadonlySet<StepApprovalBoundary> =
  new Set(STEP_APPROVAL_BOUNDARIES);

export const isStepApprovalBoundary = (
  value: unknown,
): value is StepApprovalBoundary =>
  typeof value === 'string'
  && STEP_APPROVAL_BOUNDARY_SET.has(value as StepApprovalBoundary);

export type StepVerificationBoundary =
  | 'none'
  | 'passed'
  | 'failed'
  | 'unavailable';

export const STEP_VERIFICATION_BOUNDARIES:
  ReadonlyArray<StepVerificationBoundary> = [
    'none',
    'passed',
    'failed',
    'unavailable',
  ] as const;

export const STEP_VERIFICATION_BOUNDARY_SET:
  ReadonlySet<StepVerificationBoundary> = new Set(STEP_VERIFICATION_BOUNDARIES);

export const isStepVerificationBoundary = (
  value: unknown,
): value is StepVerificationBoundary =>
  typeof value === 'string'
  && STEP_VERIFICATION_BOUNDARY_SET.has(value as StepVerificationBoundary);

export interface ExecutionStep {
  ordinal: number;
  tool_name: string;
  recipe_id?: string;
  recipe_hash?: string;
  operation_ids: string[];
  dependency_ordinals: number[];
  disposition: StepDisposition;
  approval_boundary: StepApprovalBoundary;
  verification_boundary: StepVerificationBoundary;
}

/** §6.1 — ⛔ the three arrays are NOT interchangeable. A denied proposal is
 *  negative evidence about that proposal under that policy state and can be a
 *  strong negative case with `executed` empty; an admitted operation that fails
 *  is not a denial; a successful call with no postcondition is not verified
 *  fulfillment. */
export interface ExecutionPath {
  proposed: ExecutionStep[];
  authorized: ExecutionStep[];
  executed: ExecutionStep[];
}

/** §6.2 — which path the pattern was derived from.
 *
 *  ⛔ There is deliberately no `'authorized'` member. A6 defined one; A14 made
 *  it unreachable — a flow authorized but never executed (held then abandoned,
 *  approved-then-skipped, expired before dispatch) forms NO case at all, because
 *  permission without an operational outcome is not evidence. */
export type FlowBasis = 'proposed' | 'executed';

export const FLOW_BASES: ReadonlyArray<FlowBasis> = [
  'proposed',
  'executed',
] as const;

export const FLOW_BASIS_SET: ReadonlySet<FlowBasis> = new Set(FLOW_BASES);

export const isFlowBasis = (value: unknown): value is FlowBasis =>
  typeof value === 'string' && FLOW_BASIS_SET.has(value as FlowBasis);

/** §6.2 — recorded CONTENT, never a key (A18).
 *
 *  ⚠ The spec's original claim that the abstract signature "lets different
 *  recipes express the same procedural idea" was measured and largely
 *  disproved: `READ>WRITE` alone covers 178 of 1946 recipes, while exact
 *  signatures are 94% unique. Both signatures survive because the §10.2 critic
 *  compares a candidate against stored flows and lets the model judge — a job
 *  that tolerates a sparse index and a coarse one alike. */
export interface FlowPattern {
  schema_version: 1;
  exact_signature: string;
  /** D-219 slice 8 — the tool names IN ORDER, repeats preserved.
   *
   *  `topic_tags` deduplicates and `abstract_steps` collapses each step to
   *  READ / WRITE / APPROVAL / VERIFY / DENY, so neither can answer "did the
   *  model call the same tool twice". That question decides candidacy: a flow
   *  that repeats a tool is a RETRY or a LOOP, not a procedure worth
   *  short-circuiting — `[send, send]`, `[search, send, search, send]`,
   *  `[search, write] × 5`. Measured on bench traffic, 16.4% of otherwise
   *  eligible candidates repeat a tool, and every observed shape was
   *  floundering rather than discovery.
   *
   *  ⚠ Also closes a separate gap: the CARD's `tools` is built from
   *  `topic_tags`, so a five-step discovery and a one-step call rendered
   *  identically. The sequence is what makes flow shape expressible at all. */
  tool_sequence: string[];
  /** V20 (D-219) — the tool-loop ROUND each step of `tool_sequence` was emitted
   *  in, positionally aligned with it.
   *
   *  ⛔ WITHOUT THIS, `tool_sequence` OVERSTATES WHAT IT KNOWS. Steps are
   *  ordered by audit timestamp, so two calls the model emitted TOGETHER and
   *  two it emitted in sequence produce the same ordered pair — and for a
   *  concurrency-safe batch the recorded order is completion scheduling, not a
   *  decision. Measured across four runs of one prompt: the same two tools came
   *  back in one order three times and the other order once, purely as
   *  dispatch noise.
   *
   *  Equal adjacent values mean "issued together, independently"; increasing
   *  values mean "the second waited for the first". That distinction is what a
   *  procedure is worth learning FOR — a batched pair costs one model
   *  round-trip and a sequenced pair costs two.
   *
   *  ⚠ EMPTY when unknown, never synthesised. Rows written before V20 carry no
   *  round, and a dispatch outside the chat tool loop has none; assigning a
   *  default would claim a batching structure that was never observed. Read it
   *  `?? []` and treat an empty array as "no information", not "all one round".
   *  ⛔ Do NOT reconstruct it from timestamp proximity — §4.2 refuses structure
   *  inferred that way, and gap-thresholding is that inference. */
  round_ordinals: number[];
  /** V22 (D-219) — the TOOL TIER of each step, positionally aligned with
   *  `tool_sequence`. Tier 1 = hard-coded canonical primitive (the core entity
   *  ops: `mail.search`, `contact.search`, …); Tier 2 = installed recipe;
   *  Tier 3 = `connection.mcp.*` passthrough.
   *
   *  ⛔⛔ THIS EXISTS BECAUSE TIER-1 DEPTH IS NOT WORTH LEARNING. Measured
   *  across 126 live turns: the D-167 prefetch absorbs the entity-resolution
   *  layer outright (33/60 invented addresses → 0/60), and the model BATCHES
   *  every independent read into one round, so a wide layer costs the same as a
   *  narrow one. What remains — a step that genuinely waits on a prior step's
   *  VALUE — cannot be shortened by a shape-only card, because the value is
   *  exactly what the card omits. A flow made only of core entity ops therefore
   *  has nothing a precedent could teach, however many calls it contains.
   *
   *  ⚠ EMPTY when unknown, never synthesised — the same discipline as
   *  `round_ordinals`, and for the same reason: a partial array read
   *  positionally mis-classifies silently. Read it `?? []`, and treat empty as
   *  "cannot judge", which for an ADMISSION gate means do not admit. */
  tool_tiers: number[];
  abstract_steps: string[];
  operation_ids: string[];
  recipe_refs: Array<{
    recipe_id: string;
    recipe_hash: string;
  }>;
  /** V21 (D-219) — WHICH recipe a step dispatched, keyed by its ORDINAL in
   *  `tool_sequence`. Sparse: only steps that ran a recipe appear.
   *
   *  ⛔ NOT derivable from `recipe_refs`, which is DEDUPED and therefore has no
   *  ordinal. A flow can hold a recipe-bearing step alongside an unpaired one
   *  — a dispatch whose run row never arrived — and a single deduped ref then
   *  aligns to whichever step you guess. §4.2 refuses inferred structure, and
   *  positional guessing from a set is that inference; the ordinal makes it a
   *  lookup instead.
   *
   *  ⚠ `recipe_id` is the BARE id the audit run row carries (`send-email`),
   *  not the qualified `<publisher>/<slug>` the chat activity records. Both
   *  resolve — `RecipeStore` is keyed BARE and `resolveRecipeId`
   *  (`chat-tool-handlers.ts`) strips a prefix before lookup — so the bare id
   *  is a usable identity and not a broken one. ⛔ Do NOT "repair" it to the
   *  qualified form by scanning the registry for a matching suffix: two
   *  publishers can ship one slug, and that guess would name the wrong
   *  publisher's recipe on a card. */
  recipe_steps: Array<{
    ordinal: number;
    recipe_id: string;
  }>;
  approval_boundaries: number[];
  verification_steps: number[];
  /** A17 — derived from the tool call, never model-supplied, and ⛔ never part
   *  of {@link RequestShape} (§8.2.2 circularity). `risk_tier` from `ToolEntry`
   *  or the shipped `kernelVerbRiskTier(verb)`; `entity_kinds` from
   *  `ToolEntry.arg_schema`; `topic_tags` from `ToolEntry.topic_tags`. */
  risk_tier: string;
  entity_kinds: string[];
  topic_tags: string[];
}

// ────────────────────────────────────────────────────────────────
// §7 — Outcome contract
// ────────────────────────────────────────────────────────────────

/** §7 — permission as it stood at that historical moment. ⛔ Never rendered to
 *  a model as a bare verdict: `approved` reads as CURRENT permission, which
 *  §2.3, §7.1 and acceptance #13 all forbid. */
export type OutcomeAuthorization =
  | 'not_required'
  | 'allowed'
  | 'denied'
  | 'dismissed'
  | 'expired';

export const OUTCOME_AUTHORIZATIONS: ReadonlyArray<OutcomeAuthorization> = [
  'not_required',
  'allowed',
  'denied',
  'dismissed',
  'expired',
] as const;

export const OUTCOME_AUTHORIZATION_SET: ReadonlySet<OutcomeAuthorization> =
  new Set(OUTCOME_AUTHORIZATIONS);

export const isOutcomeAuthorization = (
  value: unknown,
): value is OutcomeAuthorization =>
  typeof value === 'string'
  && OUTCOME_AUTHORIZATION_SET.has(value as OutcomeAuthorization);

/** §7 — precedence when step boundaries disagree: the strongest NEGATIVE wins.
 *  Index 0 is strongest. The fold is deterministic (§8.3), so this order is
 *  part of the contract, not a helper's private detail. */
export const OUTCOME_AUTHORIZATION_SEVERITY:
  ReadonlyArray<OutcomeAuthorization> = [
    'denied',
    'expired',
    'dismissed',
    'allowed',
    'not_required',
  ] as const;

/** §7.1 — `in_doubt` is D-157's unreconciled state: neither positive nor
 *  negative, and it marks the observation contested. It is NOT a soft failure. */
export type OutcomeExecution =
  | 'succeeded'
  | 'failed'
  | 'in_doubt'
  | 'skipped'
  | 'not_executed';

export const OUTCOME_EXECUTIONS: ReadonlyArray<OutcomeExecution> = [
  'succeeded',
  'failed',
  'in_doubt',
  'skipped',
  'not_executed',
] as const;

export const OUTCOME_EXECUTION_SET: ReadonlySet<OutcomeExecution> = new Set(
  OUTCOME_EXECUTIONS,
);

export const isOutcomeExecution = (value: unknown): value is OutcomeExecution =>
  typeof value === 'string'
  && OUTCOME_EXECUTION_SET.has(value as OutcomeExecution);

/** §7 — `passed` means an observable postcondition was actually checked.
 *  A successful tool call with no postcondition is `unavailable`, not `passed`. */
export type OutcomeVerification = 'passed' | 'failed' | 'unavailable';

export const OUTCOME_VERIFICATIONS: ReadonlyArray<OutcomeVerification> = [
  'passed',
  'failed',
  'unavailable',
] as const;

export const OUTCOME_VERIFICATION_SET: ReadonlySet<OutcomeVerification> =
  new Set(OUTCOME_VERIFICATIONS);

export const isOutcomeVerification = (
  value: unknown,
): value is OutcomeVerification =>
  typeof value === 'string'
  && OUTCOME_VERIFICATION_SET.has(value as OutcomeVerification);

/** §7 — ⛔ `accepted` requires an EXPLICIT product signal. Silence is
 *  `unknown`, never acceptance (§7.1: "no later complaint" is no evidence). */
export type OutcomeFeedback =
  | 'accepted'
  | 'corrected'
  | 'undone'
  | 'rejected'
  | 'unknown';

export const OUTCOME_FEEDBACKS: ReadonlyArray<OutcomeFeedback> = [
  'accepted',
  'corrected',
  'undone',
  'rejected',
  'unknown',
] as const;

export const OUTCOME_FEEDBACK_SET: ReadonlySet<OutcomeFeedback> = new Set(
  OUTCOME_FEEDBACKS,
);

export const isOutcomeFeedback = (value: unknown): value is OutcomeFeedback =>
  typeof value === 'string'
  && OUTCOME_FEEDBACK_SET.has(value as OutcomeFeedback);

/** §7 — four INDEPENDENT axes. ⛔ They must never collapse into a single
 *  verdict: permission, execution, verification and human feedback answer
 *  different questions and routinely disagree (allowed-then-failed,
 *  succeeded-then-corrected). Collapsing them is the core error §2.3 exists to
 *  prevent. */
export interface ExecutionOutcome {
  model_claim: OutcomeClaim;
  authorization: OutcomeAuthorization;
  execution: OutcomeExecution;
  verification: OutcomeVerification;
  feedback: OutcomeFeedback;
}

/** The exact observed axes retained for a superseded-case digest.
 *
 * `model_claim` is intentionally absent: historical model self-report is not
 * corroborating evidence and must never enter a model-facing case card.
 */
export type HistoricalExecutionOutcome = Pick<
  ExecutionOutcome,
  'authorization' | 'execution' | 'verification' | 'feedback'
>;

/** Owner-authored product feedback attached to a completed execution span.
 *
 * These are explicit UI/RPC facts. Plan approval and silence are deliberately
 * absent: approving a proposal is permission to try, not acceptance of the
 * eventual result, and no later complaint is not evidence.
 */
export const EXECUTION_CASE_FEEDBACK_KINDS = [
  'accepted',
  'corrected',
  'rejected',
  'undone',
] as const;
export type ExecutionCaseFeedbackKind =
  (typeof EXECUTION_CASE_FEEDBACK_KINDS)[number];
export const EXECUTION_CASE_FEEDBACK_KIND_SET:
  ReadonlySet<ExecutionCaseFeedbackKind> =
    new Set(EXECUTION_CASE_FEEDBACK_KINDS);
export const isExecutionCaseFeedbackKind = (
  value: unknown,
): value is ExecutionCaseFeedbackKind =>
  typeof value === 'string'
  && EXECUTION_CASE_FEEDBACK_KIND_SET.has(
    value as ExecutionCaseFeedbackKind,
  );

/** §7.1 — a TALLY, not a score.
 *
 *  Occurrence counts per polarity, never a 0..1 weight. That makes §8.3 rebuild
 *  determinism free rather than a property to prove, and introduces no
 *  constant: `contested` is exactly `positive > 0 && negative > 0`.
 *
 *  A31: an observation that consumed the same case key is excluded from this
 *  projection (including per-flow and recent variants) and from per-flow
 *  outcome counters, even though raw request/deterministic lifecycle counters
 *  may still record that the run happened.
 *
 *  ⛔ `evidence_families` must survive the rollup. *Five negatives because it
 *  errored* and *five negatives because the user declined* demand opposite
 *  judgments, and only the families distinguish them. Counts, not rates — a
 *  rate needs a denominator and invites "over what window?", which
 *  {@link ExecutionCase.recent} already answers. */
export interface OutcomeStrength {
  positive: number;
  negative: number;
  contested: boolean;
  evidence_families: string[];
}

/** §7.1 — stored only as an encrypted projection attached to an explicit
 *  outcome report. Not a standalone case, not model-retrievable, and it expires
 *  with the report's source retention. This lets later independent reports
 *  cross an aggregate threshold without polluting the case table with candidate
 *  rows. */
export interface ExecutionObservation {
  report_id: string;
  compiler_version: number;
  request_shape: RequestShape;
  execution_path: ExecutionPath;
  flow_pattern: FlowPattern;
  flow_basis: FlowBasis;
  outcome: ExecutionOutcome;
  outcome_strength: OutcomeStrength;
}

// ────────────────────────────────────────────────────────────────
// §8 — Execution case storage
// ────────────────────────────────────────────────────────────────

/** §8.2 — the recurrence floor, and ⛔ **the only constant in D-214 admission**
 *  (the §10.1 retrieval show/no_show threshold is deliberately empirical and is
 *  set by Slice 4's measurement gate, not here).
 *
 *  ⛔ **It counts REQUEST observations** — "you asked this three times" — not
 *  "this flow worked three times" (A18). Same number as before that amendment,
 *  opposite meaning, and the single easiest thing to misread in this spec.
 *
 *  Not a guess and not to be re-derived: `MANUAL_RUN_THRESHOLD = 3`
 *  (`enrichment-trust.ts`) is an existing project constant already reused twice
 *  for this exact shape of decision — `quality-delegation-signal` and
 *  `DELEGATION_SUGGEST_THRESHOLD` (`delegation-suggestion.ts`), where it
 *  explicitly doubles as the distinct-session floor. D-214's
 *  distinct-root-request independence rule is
 *  the direct analogue, so this is the third consistent use. Named separately
 *  rather than imported, following the `DELEGATION_SUGGEST_THRESHOLD`
 *  precedent: the value is shared, the *reason* is per-feature.
 *
 *  ⛔ **Do not add a complexity floor beside it** (A19). It looks prudent and
 *  would exclude habitual shorthand — plausibly the highest-value case. *"run
 *  my morning routine"* is four words and an excellent key; *"email Alice"* is
 *  two and useless. Ambiguity is what makes a request unlearnable, not brevity,
 *  and thin requests are already self-limiting: few distinctive terms → weak
 *  rank, thin dissection → few slots → `no_show` unaided. */
export const EXECUTION_CASE_RECURRENCE_FLOOR = 3;

/** §8.2.3 — substantive governed calls required to admit.
 *
 *  ⛔ **D-219 slice 7 REVERSED the asymmetry. The old rule and its reasoning are
 *  kept below, because the reversal rests on a changed premise rather than on
 *  disagreement, and a reader who only sees the new number cannot check that.**
 *
 *  WAS: positives gated at 2, negatives free at 1, argued as — *"a correct
 *  single-call answer is already optimal — no sequence to remember, no discovery
 *  to short-circuit — so a case would carry no value. But choosing the WRONG
 *  single tool is exactly what users correct, and 'for this ask, not tool A' is
 *  the cheapest win available. ⛔ Do not gate negatives at 2."*
 *
 *  WHAT CHANGED. That reasoning protects a win which D-219 has since made mostly
 *  unreachable, and an enumeration showed the rest is unrepresentable:
 *
 *    · Slices 2–4 excluded every negative the SYSTEM observed about itself, so
 *      "the model chose the wrong tool and it broke" no longer files at all. The
 *      surviving negatives are owner-typed, and an owner correcting a one-call
 *      turn is a much rarer event than the clause assumed.
 *    · Of the eleven Tier-1 primitives, NINE are retrieval. "For 'find Wren',
 *      use contact.search" is inferable from the tool description; there is no
 *      lesson there to protect.
 *    · The genuine single-call lesson — picking one recipe out of many — is
 *      carried in `recipe.run`'s ARGUMENT, which no case records. So the case
 *      the clause was written for is the one the substrate cannot express.
 *
 *  The rule is now uniform: a turn is a candidate when the model made MORE THAN
 *  ONE governed call between the request and its answer. That is what a case is
 *  FOR — a procedure worth short-circuiting next time — and it is the same bar
 *  in both directions.
 *
 *  ⚠ KNOWN EDGE, unhandled: a FAST-PATH retrieval presented to the model before
 *  it acts (`recall_context`) makes a turn look single-call when it was not. The
 *  substrate did the lookup, so the model never called for it, and a genuinely
 *  two-step turn is scored as one. Recorded rather than fixed — counting
 *  injected context as a step needs the injection to be visible to the compiler,
 *  which today it is not. */
/** ⛔⛔ DEPTH, NOT WIDTH — the floor that decides whether a case is worth
 *  learning at all.
 *
 *  `EXECUTION_CASE_MIN_CALLS_*` counts CALLS, and calls are the wrong unit: a
 *  three-call flow the model issued in ONE batched round is something it derives
 *  for free, and that is exactly what three ceiling A/B rounds admitted and then
 *  measured. Rounds are the unit that costs something — a second round means the
 *  model had to WAIT for a value before it could continue.
 *
 *  🔑 AND TIER-1 ROUNDS DO NOT COUNT. Measured on 126 live turns: every one of
 *  the 73 invented arguments was issued in a BATCH alongside the very read that
 *  would have supplied its value, and a precedent card made that collapse MORE
 *  likely (single-round turns 31/61 with a card vs 17/63 without, p = 0.0096).
 *  Teaching the shape of core-entity work makes a model execute it eagerly, and
 *  eager execution of a value-dependent step forces it to invent the value. The
 *  cases worth keeping are the ones naming ops a model would struggle to FIND —
 *  an installed recipe or an MCP passthrough out of a large catalog — not the
 *  half-dozen primitives it already reaches for unprompted. */
export const EXECUTION_CASE_MIN_DISTINCT_ROUNDS = 3;

/** Distinct rounds containing at least one NON-core (non-Tier-1) step.
 *
 *  ⚠ Returns 0 when either positional array is missing or misaligned — "cannot
 *  judge", which the admission gate treats as "do not admit". Inventing a depth
 *  from a partial array is the silent mis-grouping `round_ordinals` refuses. */
export const nonCoreRoundDepth = (flow: {
  tool_sequence: readonly string[];
  round_ordinals?: readonly number[];
  tool_tiers?: readonly number[];
  recipe_steps?: ReadonlyArray<{ ordinal: number; recipe_id: string }>;
}): number => {
  const rounds = flow.round_ordinals ?? [];
  const tiers = flow.tool_tiers ?? [];
  const n = flow.tool_sequence.length;
  if (n === 0 || rounds.length !== n || tiers.length !== n) return 0;
  // ⛔⛔ A `recipe.run` STEP IS NON-CORE EVEN THOUGH THE TOOL IS TIER 1. The
  // dispatcher is a hard-coded primitive, but what it DISPATCHES is an installed
  // recipe — precisely the hard-to-find op this gate exists to keep. Judging on
  // tier alone refused the whole dispatcher route: measured at ~7% of recipe
  // traffic (98 invocations against 1359 by slug), silently, because those
  // flows would simply stop producing offers with nothing to show why.
  const viaRecipe = new Set((flow.recipe_steps ?? []).map((step) => step.ordinal));
  const qualifying = new Set<number>();
  for (let i = 0; i < n; i += 1) {
    if (tiers[i] !== 1 || viaRecipe.has(i)) qualifying.add(rounds[i]!);
  }
  return qualifying.size;
};

export const EXECUTION_CASE_MIN_CALLS_POSITIVE = 2;
export const EXECUTION_CASE_MIN_CALLS_NEGATIVE = 2;

/** §8.1 — one distinct tool sequence tried for a request, with its counters.
 *
 *  The counter split is deliberate and is A18/B.11's non-load-bearing
 *  reporting rule made structural: the first group is DETERMINISTIC (plan
 *  lifecycle + audit; a span
 *  either happened or it did not), the second is BEST-EFFORT (present only when
 *  a report or explicit signal arrived). ⛔ **No admission, retrieval, or card
 *  path may require a best-effort counter** — acceptance #46 asserts a case
 *  still admits, retrieves and renders usefully with zero `outcome.report`
 *  calls in the fixture. */
export interface ExecutionCaseFlow {
  /** ⛔ Literal accepted sequence — tool NAMES, not args (acceptance #47).
   *  D-214 learns PROCEDURE, not preference; args are excluded by design, so
   *  "always CC Alice" has no home here. No card presents a flow as directly
   *  replayable.
   *
   *  ⚠ DERIVED FROM `topic_tags`, which is a Set — so its ordering is a
   *  by-product of insertion, not a promise, and it deduplicates. Prefer
   *  {@link ExecutionCaseFlow.tool_sequence} for anything that depends on
   *  ORDER. `tools` stays because the §10.2 critic keys on it: it compares a
   *  candidate's `tool:`-tag projection against stored flows, and the two must
   *  be derived the same way to compare at all. */
  tools: string[];
  /** D-219 — the tool names IN ORDER, repeats preserved, carried up from the
   *  observation's {@link FlowPattern.tool_sequence}.
   *
   *  ⛔ This is the field a model-bound SHAPE card must render. `tools` answers
   *  "which tools" and only incidentally "in what order": it is a `topic_tags`
   *  projection whose order survives because `Set` happens to preserve
   *  insertion, and whose repeats are gone because `Set` deduplicates. Slice 8
   *  excludes repeat-bearing flows from admission, so today the two agree on
   *  every compiled case — which is exactly the kind of accidental agreement
   *  that stops holding silently when the exclusion is relaxed.
   *
   *  ⚠ Recording it on the FLOW rather than re-deriving it at render time is
   *  forced: the renderer sees an {@link ExecutionCase}, never the source
   *  observations the pattern lives on.
   *
   *  ⚠ Aggregated from the flow group's FIRST observation, like `tools`. A flow
   *  group is keyed on `flow_basis` + `exact_signature`, and the signature is a
   *  hash over the ordered per-step tool names, so every member of one group
   *  has the same sequence by construction. */
  tool_sequence: string[];
  /** V20 (D-219) — the same tools grouped by the tool-loop ROUND that issued
   *  them, carried up from {@link FlowPattern.round_ordinals}.
   *
   *  ⛔ RECORDED, DELIBERATELY NOT RENDERED TO A MODEL. It was briefly on the
   *  card with a cue telling the model that grouped steps "were issued
   *  together" — and the premise was measured FALSE: a recorded structure is
   *  not a structure that WORKED. The seed that taught it had batched a
   *  dependent call which returned nothing, and the owner's verdict attested
   *  the RESULT, not the procedure. Worse, a batch spanning a step whose
   *  results the next step consumes is impossible in principle, so the card was
   *  instructing a shape that could never have run.
   *
   *  It stays recorded because it is the only signal that can DETECT that
   *  collapse — a step whose argument came from its own round is exactly the
   *  failure the lab traced to guessable-form values. EMPTY for a flow
   *  compiled before V20, which is the honest reading: no audit row written
   *  then carried a round, and a single group would assert "all issued
   *  together" about a shape nobody observed. */
  round_ordinals: number[];
  /** V21 (D-219) — WHICH recipe each `recipe.run` step dispatched, carried up
   *  from {@link FlowPattern.recipe_steps} and keyed by ordinal.
   *
   *  ⛔ Recorded on the FLOW for `tool_sequence`'s reason and no other: the
   *  renderer is handed an {@link ExecutionCase} and can never reach the
   *  observations the pattern lives on. `loadOrigin` re-reads those
   *  observations and so already had the identity; the CARD could not, and
   *  rendered a bare `recipe.run` — a DISPATCHER name, which teaches nothing
   *  about what was actually done.
   *
   *  ⚠ SCOPE, measured on the bench corpus from what the model itself emitted
   *  (`ai.result.body.tool_calls`): the live model reaches a recipe by SLUG
   *  1359 times (1201 `bench/send-email`, 158 `recued-core/*`) against 98 via
   *  `recipe.run` — so this path is ~7% of recipe traffic, not all of it. A
   *  slug step names its own recipe and the annotation correctly no-ops there.
   *  ⛔ An earlier count said the opposite ("all `recipe.run`, none by slug")
   *  because it was drawn from the bench's `tool.dispatch` events, which record
   *  TIER-1 CORE TOOLS ONLY and so never saw a single slug call.
   *
   *  ⛔ NOT an argument, and #47 is not reopened: a recipe id is the IDENTITY
   *  of a capability, the same class of thing as a tool name, and the Tier-2
   *  route puts that identity in `tool_sequence` already. What #47 fences is
   *  carried-over user data — a recipient, a subject line, "always CC Alice". */
  recipe_steps: Array<{
    ordinal: number;
    recipe_id: string;
  }>;
  flow_basis: FlowBasis;

  // deterministic — needs no cooperation from the model or the user
  proposed: number;
  accepted: number;
  declined: number;
  executed: number;

  /** ⛔ D-219 slice 9b — `execution_failures` and `reported_fulfilled` REMOVED.
   *
   *  They were the last place the SYSTEM'S OWN ACCOUNT of a turn reached the
   *  card, which is the one thing this arc exists to stop.
   *
   *  `execution_failures` counted observations carrying `execution_failure`.
   *  Slice 3 made that kind an EXCLUSION — an observation carrying it is not a
   *  case at all — so the counter was structurally always 0 and rendered as a
   *  standing claim that nothing had ever broken. It was filed under
   *  "deterministic", and it was: deterministically zero.
   *
   *  `reported_fulfilled` counted `outcome.model_claim === 'fulfilled'` — the
   *  model's own word that it worked, tallied and handed back to the model as
   *  precedent. Slice 2 made `model_claim` inert as EVIDENCE; this counter
   *  survived that change because it lived on the card rather than in the
   *  evidence sets. Removing it is that ruling finished.
   *
   *  ⚠ Nothing replaces them. A flow that broke produces no case, and whether
   *  the model believed it succeeded is not a fact about the approach. What the
   *  owner concluded is in `user_acceptances` / `user_corrections` /
   *  `user_rejections` / `user_undos`, and what a real check found is in
   *  `verified_successes` / `verification_failures`. */

  // best-effort — present only when a report or explicit signal arrived
  verified_successes: number;
  verification_failures: number;
  user_acceptances: number;
  user_corrections: number;
  user_rejections: number;
  user_undos: number;

  /** ⛔ WHY a run in this flow failed, as CLOSED-VOCABULARY error codes.
   *
   *  Measured on substrate-bench 161: a card recording that this exact flow had
   *  already failed changed NOTHING — baseline 24/24 and card-shown 13/13 both
   *  walked into the same known-failing action. The card said THAT the flow
   *  failed and never WHY, and "change the recipient" is not inferable from
   *  "this flow has an execution failure". Precedent was recording OUTCOMES,
   *  not DIAGNOSES.
   *
   *  ⚠ CODES ONLY, never the thrown message. A thrown message interpolates
   *  values — `MAIL_SEND_SELF_LOOP_TO` renders as "...send mail to itself
   *  (someone@example.com)..." — so shipping it would put a recipient address
   *  on a model-bound card. The card renders `ERROR_MESSAGES[code]` instead,
   *  which is a static string carrying the same remedy with no interpolation.
   *  That is the same egress boundary the D-214 PII leak (F1) was fixed on. */
  failure_codes?: string[];

  outcome_strength: OutcomeStrength;
  /** The exact pattern is historical-only because a newer same-tool pattern
   * superseded it or a referenced tool is no longer available. */
  stale: boolean;
  first_seen_at: number;
  last_seen_at: number;
}

/** §8.4 — derived recency view over independent outcome evidence. A31 excludes
 *  observations that consumed the same case key. ⛔ Never rewrites the
 *  historical counters (§9.3): recency may reduce retrieval rank, but outcome
 *  counts are a record, not a running opinion. */
export interface ExecutionCaseRecent {
  window: number;
  positive: number;
  negative: number;
  consecutive_contradictions: number;
  last_contradiction_at?: number;
}

/** §8.1 — a CONTAINER OF SUGGESTIONS, keyed on the request:
 *  *"for this ask, here is what has been tried and how each went."*
 *
 *  `case_key` = `scope + request_shape_hash + policy_fingerprint`, where
 *  `scope` is the tuple `(governing_contract_id, principal_key)`.
 *
 *  ⛔ **`policy_fingerprint` is part of the KEY, not merely a row field.**
 *  Authorization evidence is only meaningful under the policy state that
 *  produced it, so a later grant, contract version, source posture or op-risk
 *  change must FORK A NEW ROW rather than collide with and overwrite the old
 *  one. When no authorization applied it is the constant `"none"`.
 *
 *  ⛔ **`request_shape_hash` covers the canonical core ONLY** — the
 *  server-normalized, sealed-root-grounded `intent` plus server-detected
 *  syntactic constraints (negation, cardinality band, stop condition).
 *  Model-authored constraints, surface text, the remaining free-text
 *  dissection fields, and anything derived from the executed flow are
 *  excluded. Equivalent requests aggregate onto one row and the recurrence
 *  floor stays reachable. Collisions are then safe and desirable: "draft email
 *  to X" and "draft email to Y" SHOULD aggregate. "Draft" and "send" must
 *  never. */
export interface ExecutionCase {
  case_id: string;
  case_key: string;
  schema_version: number;
  compiler_version: number;

  governing_contract_id: string;
  /** Required for a case, unlike on {@link OutcomeReport} — owner chat and
   *  messenger resolve to `user_self` (§9.1); a contracted surface resolves to
   *  its server-derived principal. A case cannot be admitted until it is set. */
  principal_key: string;

  request_shape: RequestShape;
  request_shape_hash: string;
  policy_fingerprint: string;

  /** A18 — ⛔ counts **REQUEST** observations ("you asked this three times"),
   *  NOT "this flow worked three times". Same floor value as before the
   *  amendment, opposite meaning; acceptance #48 exists to pin exactly this,
   *  and a test that passes by counting per-flow successes proves the opposite
   *  of what A18 decided. Deterministic — always available. */
  request_observations: number;
  independent_observations: number;

  /** A18 — entry order is first-seen. */
  flows: ExecutionCaseFlow[];

  outcome_strength: OutcomeStrength;
  /** §9.2 deterministic modal four-axis tuple across independent source
   * observations, ties broken by the most recent observation. An observation
   * that consumed this case cannot rewrite the history shown back to the model.
   * This is materialized so card history never reconstructs an outcome from
   * lossy evidence-family totals. */
  history_outcome: HistoricalExecutionOutcome;
  recent: ExecutionCaseRecent;

  /** §8.4 — supersession lineage across a forked flow pattern. Evidence is
   *  APPENDED, never replaced. */
  supersedes?: string;
  superseded_by?: string;

  representative_prompt_encrypted?: string;
  source_report_count: number;
  representative_source_report_ids: string[];
  first_seen_at: number;
  last_seen_at: number;
  stale_after?: number;
}

// ────────────────────────────────────────────────────────────────
// §9.2 — Model-facing card
// ────────────────────────────────────────────────────────────────

/** §8.4 / §9.2 — why a case was superseded. */
export type SupersededReason =
  | 'flow_forked'
  | 'policy_fingerprint'
  | 'compiler_upgrade';

export const SUPERSEDED_REASONS: ReadonlyArray<SupersededReason> = [
  'flow_forked',
  'policy_fingerprint',
  'compiler_upgrade',
] as const;

export const SUPERSEDED_REASON_SET: ReadonlySet<SupersededReason> = new Set(
  SUPERSEDED_REASONS,
);

export const isSupersededReason = (value: unknown): value is SupersededReason =>
  typeof value === 'string'
  && SUPERSEDED_REASON_SET.has(value as SupersededReason);

/** §9.2 (A12) — one run of CONSECUTIVE, identically-shaped superseded cases.
 *
 *  ⛔ The collapse key is the four `outcome` axes + `superseded_reason`, and
 *  **nothing else**. `case_ref` and the timestamps are explicitly NOT part of
 *  it — every superseded row has a unique ref, so including one silently
 *  degrades the encoding into a raw list that never collapses.
 *
 *  ⛔ **Non-adjacent identical runs stay separate.** A lineage of
 *  `A×3, B×1, A×4` keeps TWO distinct `A` runs; merging them into `A×7`
 *  destroys the ordering that carries the trajectory and hides oscillation. A
 *  repeated shape here is intentional, not a duplicate to tidy away — which is
 *  why acceptance #30 mutation-tests both directions.
 *
 *  ⛔ `model_claim` is deliberately absent from the digest, so the model cannot
 *  read its own past self-reports as corroboration (§8.2). */
export interface SupersededCaseRun {
  outcome: HistoricalExecutionOutcome;
  superseded_reason: SupersededReason;

  // run metadata — never part of the collapse key
  occurrences: number;
  /** Both ends, not one timestamp: `×4` over an hour and `×4` over a year
   *  support opposite conclusions. The range also makes array direction
   *  self-describing, so a reader who misreads the ordering convention cannot
   *  invert "worked, now failing" into "was failing, now works". */
  first_at: number;
  last_at: number;
  /** The NEWEST member of the run — eviction removes superseded rows
   *  oldest-first (§9.3), so the newest is likeliest to still resolve. The
   *  count says *N occurred*; the ref resolves *one of them*, not all N. A ref
   *  that no longer resolves renders as an absent entry, never an error. */
  case_ref: string;
}

/** §9.2 — the ONLY model-facing projection of a case. Typed, bounded fields
 *  only: ⛔ never raw audit JSON, transcript, tool args, tool results, errors,
 *  or historical instructions.
 *
 *  ⛔ **`open_items` must never appear here** (A21) — see
 *  {@link OutcomeReportArgs.open_items}. Adding it would look like helpful
 *  context and would silently convert `outcome.report` into a memory tool.
 *
 *  Stored cards are scope-isolated, but that is not a model-egress exemption.
 *  `request_shape.surface_terms` / `segmented_terms` are normalized derivatives
 *  of the requester's prompt, so the chat PII boundary must reconstruct and
 *  alias ledger-known phrases before any card reaches a provider (A38). */
export interface ExecutionCaseCard {
  request_shape: RequestShape;
  /** Bounded; strongest-evidence first. */
  flows: ExecutionCaseFlow[];
  outcome_strength: OutcomeStrength;
  recent: ExecutionCaseRecent;
  /** A18 — the deterministic counter; always present. */
  request_observations: number;
  last_seen_at: number;
  superseded: boolean;
  /** Newest run first. */
  history: SupersededCaseRun[];
  /** ⛔ Counts OMITTED OCCURRENCES, not omitted runs — the per-card cap applies
   *  to runs. Never truncate silently. */
  history_truncated?: number;
  applicability_notes: string[];
}

/** §9.2 — the instruction every card carries. Verbatim: it is the sentence that
 *  keeps a card advisory rather than instructive.
 *
 *  ⛔ THE ONLY COPY. It used to be one of three formulations — this one (shipped
 *  nowhere), a private near-duplicate in `execution-case-retrieval.ts` (the one
 *  the model actually received), and the three `applicability_notes` literals in
 *  `renderExecutionCaseCard`, which omit the anti-instruction clause. D-219's
 *  consumer collapsed the first two. Every wrapper surface must reference THIS
 *  constant and be asserted against it by identity — a fresh literal is
 *  indistinguishable from it in a substring test and diverges the first time
 *  someone edits one of them. */
/** D-224 — what a privacy ALIAS is, told to the model in its own words.
 *
 *  ⛔ THE MODEL WAS NEVER TOLD. It receives `pii.Person1.sarah.chen` and
 *  `m1.sarah.chen.northwind@d1.invalid` with no explanation anywhere in the
 *  packet, and both observed failure modes are what a capable model does when
 *  handed an unexplained token:
 *    · BEFORE the overlap tail — "it looks like the name and email were
 *      redacted (m1@d1.invalid)", and it stopped. Reasonable: an opaque token
 *      looks like a redaction, and a redaction means the data is gone.
 *    · AFTER the tail — it read `sarah` + `chen` + `northwind` and CONSTRUCTED
 *      `sarah.chen@northwindtraders.com`. Also reasonable: the fragments look
 *      like the ingredients of the value it needs.
 *  Neither is a model defect. Both are the absence of one sentence.
 *
 *  ⚠ Model-facing string — internal design notes governs it.
 *  Kept in CONTRACTS beside the other notices for the same reason those are: a
 *  surface free to paraphrase is free to soften, and what would be softened
 *  here is "do not reconstruct".
 *
 *  ⛔⛔ THE EXAMPLES ARE `pii.PersonN` / `mN@dN.invalid`, NEVER A CONCRETE SLOT.
 *  Writing the real shape `m1@d1.invalid` here was a PRIVACY REGRESSION, caught
 *  by `d-167-p5-s4-chat-pii-egress.test.ts`: restore authority is derived from
 *  the aliases a request SHOWED the model, so an example literal in this notice
 *  granted restore power over that slot — and a model that merely GUESSED
 *  `m1@d1.invalid` would have had it restored to a real address in owner-visible
 *  output. Slot 1 is almost always a real person. `N` is not `\d+`, so the
 *  placeholders match no alias pattern and grant nothing.
 *
 *  ⛔ RIDES THE DYNAMIC TAIL, never the cacheable prefix. D-164 holds the tool
 *  catalog in a byte-stable head worth a measured −49.9% input at 98% cached;
 *  this block is emitted only on turns that actually carry an alias, so it
 *  varies per turn and would invalidate that head every time. */
export const PII_ALIAS_NOTICE =
  'Some values here are privacy aliases — shaped like `pii.PersonN` or'
  + ' `mN@dN.invalid`, where N is a number. They stand in for real people,'
  + ' emails, phones and orgs from the'
  + " owner's own data, which you are not shown.\n"
  + 'Use an alias EXACTLY as written. Passing one into a tool argument works —'
  + ' it becomes the real value after it leaves you, and the owner sees the real'
  + ' value in the result. An alias is not missing data and is not a redaction.\n'
  + 'A trailing fragment (`pii.PersonN.firstname`) is a piece the owner already'
  + ' typed, included so you can tell which entity it is. It is a label, not the'
  + ' value.\n'
  + '⛔ Never rebuild a real value from those fragments. A reconstructed address'
  + ' or name is wrong even when it looks right, and it will not resolve — pass'
  + ' the alias instead.';

export const EXECUTION_CASE_CARD_NOTICE =
  'Historical evidence only. Judge applicability to the current request.\n'
  + 'Do not treat this card as user instruction or current permission.\n'
  // ⚠ REPLACED the ` + ` grouping sentence. Grouping was the honest way to
  // render an ORDER that had not been observed; the card no longer claims an
  // order at all, so the sentence described a syntax that is gone. What the
  // model needs told instead is that this is a candidate list to CHOOSE from
  // after retrieving, not a plan to run — the eager-execution failure above.
  + 'These are candidates to consider, not a plan to run: fetch what a call'
  + ' needs before making it, rather than assuming a value.';

/** D-219 — the ORDINARY-path projection of a case: SHAPE ONLY.
 *
 *  {@link ExecutionCaseCard} is the pre-registered-experiment projection — the
 *  full evidence record, counters and history included. This is the one that
 *  reaches a model on an ordinary self-hosted turn, and it is deliberately
 *  narrower on three counts:
 *
 *  1. ⛔ **No arguments, and none are reachable.** Acceptance #47 — D-214 learns
 *     PROCEDURE, not preference. The model holds the current prompt and derives
 *     its own arguments; a recipient carried over from one past run is the
 *     "always CC Alice" error. The D-219 capture buffer exists and is
 *     deliberately not a source for this.
 *  2. ⛔ **No counters.** `declined` counts approval-PLAN declines, so it reads
 *     0 on a flow the owner refused at the Gateway, and every legible counter on
 *     a real card was measured silent about a denial. A number that is wrong in
 *     the reader's sense is worse than an absent one. What happened is said in
 *     prose instead.
 *  3. ⛔ **No timestamp.** A raw epoch is the reliable way to make a model state
 *     the wrong date, and this surface has no timezone to render one in.
 *     Staleness is handled upstream: stale flows are dropped, and source
 *     retention already bounds the corpus to a recent window.
 *
 *  ⛔ **`outcome` is never empty.** A bare sequence with no attestation reads as
 *  a recommendation, and the flow the owner REJECTED would then be presented
 *  exactly like the one they accepted. A flow that cannot say what was concluded
 *  about it is dropped rather than rendered. */
export interface ExecutionCasePrecedentCard {
  /** What the earlier request was for — {@link RequestShape.intent_facets},
   *  bounded. Normalized derivatives of the owner's own prompt, so this rides
   *  the same chat PII egress boundary as every other dynamic context field. */
  request: string[];
  /** ⛔⛔ TOOLS THAT MAY BE NEEDED — NOT A PROCEDURE, AND THE DISTINCTION IS THE
   *  WHOLE POINT OF THE FIELD.
   *
   *  This was `tool_sequence`, "the procedure, as tool names IN ORDER", and
   *  three live A/B rounds showed what a model does with a procedure: it
   *  executes it EAGERLY. Turns collapsed into a single batched round far more
   *  often with a card than without (31/61 vs 17/63, p = 0.0096) — and every one
   *  of the 73 invented arguments observed was issued inside such a batch,
   *  alongside the very read that would have supplied its value. A card naming a
   *  route in order invites the model to run the route at once; a step that
   *  needed a prior step's value then has no value, so it invents one.
   *  Fabrication ran at 5.8x odds against the no-card arm (p = 0.00006).
   *
   *  🔑 SO THE CARD STOPPED CLAIMING AN ORDER AND STARTED ANSWERING THE QUESTION
   *  A MODEL ACTUALLY CANNOT ANSWER: out of a large installed catalog, WHICH ops
   *  might this request need? Core primitives are deliberately not the subject —
   *  a model reaches for `mail.search` unprompted — so admission now requires
   *  depth in NON-core rounds ({@link EXECUTION_CASE_MIN_DISTINCT_ROUNDS}), and
   *  what survives is the hard-to-find recipe or MCP passthrough. Discovery, not
   *  procedure. Order is not asserted because it was never observed. */
  flows: Array<{
    tools_that_may_be_needed: string[];
    /** What the OWNER concluded, or what a check found. Never the system's own
     *  account of itself: the reachable evidence after D-219 is four owner
     *  verdicts, two verification results, and `flow_superseded`. */
    outcome: string[];
  }>;
}

/** D-219 — the ordinary-path advisory block. Separate from
 *  {@link ExecutionCaseAugmentationContext}'s wire field on purpose: a
 *  pre-registered experiment measures a specific prompt, and quietly widening
 *  the field it reads would change the thing under measurement. Exactly one of
 *  the two surfaces is composed on a given server. */
export interface ExecutionCasePrecedentContext {
  /** {@link EXECUTION_CASE_CARD_NOTICE}, by reference. */
  notice: string;
  cards: ExecutionCasePrecedentCard[];
}

/** D-219 item 2b — what the owner agrees to before a draft is generated.
 *
 *  ⛔ In CONTRACTS, not in the server module that uses it, for the same reason
 *  {@link EXECUTION_CASE_CARD_NOTICE} is: the surface that renders it and the
 *  layer that owns the behaviour must not each keep their own wording. A panel
 *  free to paraphrase is a panel free to soften, and what is being softened
 *  here is a warning about spending the owner's money and about the review
 *  being load-bearing.
 *
 *  Three things it must keep saying, none of them obvious from a button: this
 *  is slow, it spends model quota, and what comes back is a FIRST DRAFT whose
 *  review is what makes it safe rather than an optional polish. */
export const RECIPE_DRAFT_CONFIRMATION = [
  'Recued will ask your AI to write a recipe from this turn.',
  'It is a slow call and it spends your model quota.',
  'What comes back is a FIRST DRAFT: expect to read every step, fill in the'
  + ' variables, and change what does not fit. Nothing is saved until you save'
  + ' it in the Kitchen.',
].join('\n');

/** D-219 — the same warning, for a REVISION rather than a first draft.
 *
 *  ⛔ A SIBLING, not a reuse. Threading the draft copy into the refine control
 *  told the owner "Recued will ask your AI to write a recipe from this turn" and
 *  "what comes back is a FIRST DRAFT" while they were looking at the draft it
 *  already wrote — describing the wrong action at the moment they authorise it.
 *  Seen live 2026-07-29.
 *
 *  It keeps the two things that made the original load-bearing (this is slow,
 *  it spends quota) and replaces the third: a revision can come back WORSE, and
 *  there is no undo to the version on screen. */
export const RECIPE_REFINE_CONFIRMATION = [
  'Recued will ask your AI to revise the recipe on screen.',
  'It is a slow call and it spends your model quota, the same as the first draft.',
  'The revision REPLACES what you are looking at, including any edits you have'
  + ' made, and it can come back worse. Nothing is saved until you save it in'
  + ' the Kitchen.',
].join('\n');

/** D-219 item 2 — ONE learned case, as the OWNER sees it.
 *
 *  The arc's whole asset is a corpus built from what the owner said, and until
 *  this existed the owner could not see any of it: they were asked "was that
 *  right?", answered, and nothing they could look at ever changed. A model got
 *  a card; they got nothing.
 *
 *  ⛔ **`flows` is the SAME projection the model receives** — literally the same
 *  renderer, not a parallel one written to look like it. Two hand-maintained
 *  views of one corpus is how the surface a person audits stops matching the
 *  surface a model reads, and this page's entire purpose is to be the honest
 *  answer to "what does it know about me".
 *
 *  ⚠ It carries two things the model's card deliberately does NOT:
 *  - `last_seen_at`, because a CLIENT has the viewer's timezone and can render
 *    a real date. The card omits it precisely because the prompt has no zone to
 *    render one in, so a raw epoch there invites a wrong date.
 *  - `shown_to_model`, which has no meaning on the model's side and is the one
 *    fact the owner most needs: whether this case is actually in play. A case
 *    whose every flow is stale or unattested is retained and inert, and an
 *    inert case listed identically to a live one would misreport the reach of
 *    everything on the page. */
export interface ExecutionCaseLearnedEntry {
  case_id: string;
  /** What the earlier request was for — request-shape intent facets. */
  request: string[];
  /** Empty when nothing about this case currently reaches a model. */
  flows: ExecutionCasePrecedentCard['flows'];
  /** ⛔ Derived from `flows.length`, never from a separate predicate. A second
   *  eligibility test would be a second opinion about the same question, and
   *  the two would disagree the first time either changed. */
  shown_to_model: boolean;
  /** How many distinct requests of this shape were observed (A18's
   *  deterministic counter). */
  request_observations: number;
  /** Epoch ms; the client renders it in the viewer's zone. */
  last_seen_at: number;
  /** D-219 — recipes the owner has already authored FROM this case.
   *
   *  ⛔ Sourced from a SEPARATE table keyed on `case_key`, never from the case
   *  row: a case row is a projection that `rebuildMaterialized` re-derives, so a
   *  marker on it would be wiped, and `case_id` is `hash(case_key,
   *  compiler_version)` — version-scoped, so a link keyed on it orphans itself
   *  on every compiler bump.
   *
   *  ⚠ Empty is the ordinary case and means only "no record", never "they did
   *  not": a save that happened before this existed left no link, and the record
   *  is written best-effort AFTER the save so a failure loses the annotation
   *  rather than the recipe. */
  authored?: ReadonlyArray<{
    recipe_id: string;
    /** The recipe's content hash when it was saved. */
    recipe_hash: string;
    authored_at: number;
    /** What the owner would find if they opened it now.
     *
     *  ⛔ The stored hash was WRITE-ONLY until this existed: the store claimed it
     *  distinguished "the recipe you made" from "a recipe of that name today",
     *  and nothing ever compared it — so a deleted or rewritten recipe left an
     *  annotation the owner could not act on. Resolved server-side, where the
     *  recipe store is, rather than asking the panel to fetch N recipes.
     *
     *  `gone` matters most: it is the one where "you made a recipe from this" is
     *  actively misleading on its own. */
    state: 'unchanged' | 'edited' | 'gone';
  }>;
}

// ────────────────────────────────────────────────────────────────
// §10 — Retrieval and flow critique
// ────────────────────────────────────────────────────────────────

/** §10.1.1 (A23) — best-effort candidate generation for retrieval stage 1.
 *
 *  D-214 binds to no particular retrieval mechanism. The contract is
 *  deliberately narrow:
 *  - **best-effort** — an empty result is a normal outcome, never an error;
 *  - **`partial` is first-class**, because a bounded scan legitimately cannot
 *    see everything and §10.1 tolerates that;
 *  - **ids only**, so a source can never reach into card rendering or egress;
 *  - **no index, tokenizer, or ranking assumption**.
 *
 *  ⛔ **Pluggability is NOT permission to add an index.** A22 withdrew D-214's
 *  in-RAM FTS index because D-213 §6.4 had already rejected that shape on
 *  MEASURED grounds: FTS5 segment merges stage to `temp_store` files *outside*
 *  the realm encryption, and the fix `temp_store = MEMORY` cost a measured
 *  +228 MB RSS in D-212 and armed an OOM boot-loop. Any implementation that
 *  builds an index must clear that bar first — no decrypted text outside the
 *  encryption (acceptance #53) and measured RSS against a real corpus. A port
 *  makes swapping cheap; it does not make the measurement optional. */
export interface CaseCandidateSource {
  readonly id: string;
  findCandidates(input: {
    /** Raw incoming prompt. */
    prompt: string;
    scope: { governing_contract_id: string; principal_key: string };
    limit: number;
  }): Promise<{
    /** `case_id`s, strongest first. */
    candidates: string[];
    /** D-219 — the stored request text per candidate, when the source already
     *  had it in hand.
     *
     *  ⛔ ADDITIVE, and it exists so a caller need not fall back to
     *  `request_shape.intent_facets`. That facet is `inferredIntent`'s first
     *  EIGHT distinct terms, and only 23% of real turn messages are that short
     *  (median 9) — so anything keyed on it would work exclusively on the
     *  briefest requests, which are precisely the ones where a procedure is
     *  least worth learning. A source that does not decrypt prompts simply
     *  omits this and such a caller stays inert. */
    prompts?: Record<string, string>;
    /** True when the source could not inspect the whole scope. */
    partial: boolean;
  }>;
}

/** §10.2 — proposal-time critique, issued after the model proposes a flow but
 *  before a consequential action dispatches.
 *
 *  ⛔ `support` and `alternatives` draw from LIVE cases only — a superseded case
 *  may inform history but never counts as support or a stronger alternative
 *  (§8.4). It never blocks or permits by itself: if the model repeats the same
 *  candidate after reading the critique, normal Gateway policy still decides.
 *  D-214 is a quality signal, not a shadow policy engine. */
export interface FlowCritique {
  candidate_pattern: FlowPattern;
  support: ExecutionCaseCard[];
  contradictions: ExecutionCaseCard[];
  alternatives: Array<{
    case: ExecutionCaseCard;
    material_difference: string[];
  }>;
}

// ────────────────────────────────────────────────────────────────
// §10.4 — controlled-intervention attribution (A25)
// ────────────────────────────────────────────────────────────────

export const CASE_INTERVENTION_ROLES = [
  'augmentation',
  'support',
  'contradiction',
  'alternative',
] as const;
export type CaseInterventionRole =
  (typeof CASE_INTERVENTION_ROLES)[number];
export const CASE_INTERVENTION_ROLE_SET:
  ReadonlySet<CaseInterventionRole> = new Set(CASE_INTERVENTION_ROLES);
export const isCaseInterventionRole = (
  value: unknown,
): value is CaseInterventionRole =>
  typeof value === 'string'
  && CASE_INTERVENTION_ROLE_SET.has(value as CaseInterventionRole);

export const CASE_INTERVENTION_ASSIGNMENTS = [
  'control',
  'treatment',
] as const;
export type CaseInterventionAssignment =
  (typeof CASE_INTERVENTION_ASSIGNMENTS)[number];
export const CASE_INTERVENTION_ASSIGNMENT_SET:
  ReadonlySet<CaseInterventionAssignment> =
    new Set(CASE_INTERVENTION_ASSIGNMENTS);
export const isCaseInterventionAssignment = (
  value: unknown,
): value is CaseInterventionAssignment =>
  typeof value === 'string'
  && CASE_INTERVENTION_ASSIGNMENT_SET.has(
    value as CaseInterventionAssignment,
  );

export interface CaseInterventionEvidence {
  case_id: string;
  case_key: string;
  role: CaseInterventionRole;
}

export interface CaseInterventionBase {
  schema_version: 1;
  intervention_id: string;
  experiment_id: string;
  root_request_id: string;
  session_id: string;
  turn_id: string;
  governing_contract_id: string;
  principal_key: string;
  assignment: CaseInterventionAssignment;
  /** Passed every relevance/materiality gate. Empty is a valid opportunity. */
  qualifying_evidence: CaseInterventionEvidence[];
  /** Deterministic bounded selection, computed identically in both arms. */
  selected_evidence: CaseInterventionEvidence[];
  /** Evidence actually rendered. Always empty in control. */
  shown_evidence: CaseInterventionEvidence[];
  planner_fingerprint: string;
  /** Versioned prompt template fingerprint, never a user-prompt hash. */
  prompt_fingerprint: string;
  retrieval_fingerprint: string;
  policy_fingerprint: string;
  compiler_version: number;
  recorded_at: number;
}

export type CaseInterventionRecord =
  | (CaseInterventionBase & {
      surface: 'request_augmentation';
      candidate_source_id: string;
      candidate_source_count: number;
      candidate_source_partial: boolean;
      candidate_flow_hash?: never;
    })
  | (CaseInterventionBase & {
      surface: 'proposal_critique';
      candidate_flow_hash: string;
      candidate_source_id?: never;
      candidate_source_count?: never;
      candidate_source_partial?: never;
    });

// ────────────────────────────────────────────────────────────────
// §6.2 / §11.1 — runtime composition and explicit packaging (A26)
// ────────────────────────────────────────────────────────────────

export const RUNTIME_COMPOSITION_ROUTE_KINDS = [
  'installed_recipe',
  'dynamic_ingredient',
  'inline_recipe',
  'direct_tool',
] as const;
export type RuntimeCompositionRouteKind =
  (typeof RUNTIME_COMPOSITION_ROUTE_KINDS)[number];
export const RUNTIME_COMPOSITION_ROUTE_KIND_SET:
  ReadonlySet<RuntimeCompositionRouteKind> =
    new Set(RUNTIME_COMPOSITION_ROUTE_KINDS);
export const isRuntimeCompositionRouteKind = (
  value: unknown,
): value is RuntimeCompositionRouteKind =>
  typeof value === 'string'
  && RUNTIME_COMPOSITION_ROUTE_KIND_SET.has(
    value as RuntimeCompositionRouteKind,
  );

/** Argument-free dispatch topology used only for diagnostics. */
export interface RuntimeCompositionDispatch {
  root_request_id: string;
  ordinal: number;
  route_kind: RuntimeCompositionRouteKind;
  tool_name: string;
  recipe_id?: string;
  recipe_hash?: string;
  operation_ids: string[];
  dependency_ordinals: number[];
}

export const RECIPE_PACKAGING_NEEDS = [
  'recurring_dynamic_topology',
  'recurring_inline_topology',
  'audit',
  'pii_topology',
  'cli',
  'scheduling',
  'cross_surface',
] as const;
export type RecipePackagingNeed = (typeof RECIPE_PACKAGING_NEEDS)[number];

/** Future owner-visible packaging proposal. Never auto-saved or auto-published. */
export interface RecipeCandidate {
  candidate_id: string;
  packaging_need: RecipePackagingNeed;
  supporting_case_ids: string[];
  topology_signature: string;
  independent_root_count: number;
  owner_visible: true;
  authoring_state: 'proposed';
}
