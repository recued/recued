/** D-153 P9 — Continuation memory entities.
 *
 *  D-153's session substrate is now five legs deep: P1 named the
 *  three-tier session IDs (channel / cognition / correlation), P5 named
 *  the *links between* sessions (`predecessor_session_id`), P6 named
 *  when a session *closes* (the cut models), P7 named what happens
 *  *inside* an open session (lifecycle states + routing), and P8 turned
 *  a finished session into a reusable Recipe. P9 names how a *closed*
 *  session is *continued* — the memory entity a later session loads to
 *  pick up where the prior one left off.
 *
 *  **Why a summary entity exists.** The commit substrate (P1) stores
 *  *observable facts* — one tool call, one commit — never *intent*, the
 *  unobservable claim about what the user meant (spec line 587). But a
 *  continuation needs *something* to load: replaying a closed session's
 *  raw commit log is possible but lossy and expensive. The resolution
 *  (spec lines 587-595): a cognition component's `summarize_for_handoff()`
 *  produces a summary blob that lands as a memory entity (D-120) keyed
 *  by `channel_session_id`. The summary is:
 *
 *    - *An observable cognition output* — cognition wrote this artifact
 *      at a recorded time; it is itself auditable. This preserves the
 *      "no intent storage" honesty: the summary is a *product* of
 *      cognition (a recorded fact), not a *claim* about meaning.
 *    - *User-editable* — if cognition's summary is wrong, the user
 *      corrects it; the correction lands as a fresh `user_edit` summary
 *      row and the next session reads the corrected version. The
 *      user's word outranks cognition's (`selectCurrentContinuation-
 *      Summary`).
 *    - *Loaded by the next session* continuing the same
 *      `channel_session_id` — the substrate keys on the *predecessor's*
 *      channel-session id, so every descendant of a forking session
 *      tree (P5) reads one shared summary.
 *
 *  **Lazy summarization.** The summary is generated lazily — on the
 *  *next-message-arrival* that actually continues a session, NOT
 *  eagerly when the session closes (spec line 597). A session that
 *  closes and is never resumed is never summarized; that is the token
 *  saving. `evaluateSummarizeTrigger` is the deterministic encoding of
 *  the lazy rule: it declines at the `'session_close'` occasion and
 *  fires only at `'continuation'`, and only when no summary exists yet.
 *
 *  **The summary is generated once, on first continuation, regardless
 *  of K/V availability.** Spec § Linked sessions (lines 518-523) lists
 *  three continuation outcomes a cognition component picks between —
 *  full K/V transfer, summary-handoff, cold start. The lazy trigger
 *  does NOT gate on which outcome cognition will pick: it fires on the
 *  first continuation even when the predecessor's K/V is still in store
 *  and a full transfer is what cognition uses *this* time. The reason
 *  is durability — K/V is archived eventually; generating the summary
 *  on the first continuation means the durable entity exists for every
 *  *later* continuation after the K/V archives. Which outcome cognition
 *  loads is cognition's call; *that a summary gets written on first
 *  continuation* is the substrate's.
 *
 *  **The summary content is a cognition stub.** Mirroring P6's
 *  cognition-driven cut and P7's routing classifier: producing the
 *  summary *text* is an LLM call (`summarize_for_handoff()` — spec line
 *  589), not deterministic Engine logic, and no cognition component
 *  runs in the default Recued runtime per the 2026-05-19 cognition
 *  downscope (internal benchmarks Path B Stage 4 verdict; cognition is
 *  pluggable, DEFAULT DISABLED). P9 ships the *summarizer API* —
 *  `HandoffSummarizationInput`, `HandoffSummarizationResult`, the
 *  `HandoffSummarizer` slot type — but no summarizer *implementation*.
 *  What P9 *does* ship deterministically is everything around the
 *  content: the entity shape, the lazy trigger, the current-summary
 *  picker, and the two constructors.
 *
 *  P9 ships substrate-only — the closed lists, the entity shape, the
 *  pure trigger reducer, the picker, the constructors, and the
 *  summarizer API land here. Deferred to D-145 (Engine substrate):
 *
 *    - **The summary store.** Which table holds `ContinuationSummary`
 *      rows, the `WHERE channel_session_id = ?` query behind
 *      `selectCurrentContinuationSummary`, and the read/write rpcs are
 *      the Engine's warehouse work. The substrate operates on a summary
 *      list the caller already holds — same decoupling P5 / P8 use.
 *    - **Driving the trigger.** *When* the Engine evaluates the trigger
 *      (on the next-message-arrival that opens a linked session — P5
 *      `predecessor_session_id`, P7 `'new_session'` routing) is Engine
 *      work; `evaluateSummarizeTrigger` is only the pure decision.
 *    - **The user-commit for an edit.** Spec line 591: a user edit
 *      "lands as a user-commit". `applyUserEditToContinuationSummary`
 *      produces the new summary row; the paired commit-log entry is
 *      the Gateway's (P1 / D-145).
 *    - **Enforcing the text cap.** `CONTINUATION_SUMMARY_TEXT_MAX_BYTES`
 *      is the declared bound; the storage insert path enforces it
 *      (truncate-with-warning, as D-120 does for its sibling blob caps).
 *    - **The summarizer implementation.** `HandoffSummarizer` is the
 *      typed slot; a cognition component fills it. See the stub note
 *      above.
 *
 *  Cognition-independent (modulo the typed `HandoffSummarizer` stub).
 *  The last cognition-independent contracts slice of D-153 — after P9
 *  only P4 (cognition K/V, deferred) and P10 (Engine-touching retire)
 *  remain. Matches the P1 / P3 / P5 / P6 / P7 / P8 substrate-first
 *  pattern. Self-contained — this file imports nothing.
 *
 *  No tests in this file per the test-after-review workflow; tests land
 *  in a separate post-review step.
 *
 *  Spec: D-153 § Memory continuity — no intent stored, but
 *  summaries are (lines 587-597); § Linked sessions (lines 518-523);
 *  phase plan line 655. */

// ────────────────────────────────────────────────────────────────
// Continuation-summary source — who authored a summary row
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of who authored a `ContinuationSummary` row.
 *
 *  - `'cognition'` — a cognition component wrote it via
 *    `summarize_for_handoff()`. The original artifact, generated
 *    lazily on first continuation. A `cognition` row carries the
 *    `cognition_session_id` that produced it.
 *  - `'user_edit'` — the user corrected a prior summary. The
 *    correction is a fresh row, not a mutation of the cognition one,
 *    so the audit trail keeps both. A `user_edit` row never carries a
 *    `cognition_session_id` — a user is not a cognition session.
 *
 *  Source is the *primary* precedence key in `selectCurrentContinuation-
 *  Summary`: a `user_edit` outranks a `cognition` row unconditionally,
 *  so the user's correction is always what the next session reads. */
export const CONTINUATION_SUMMARY_SOURCES = ['cognition', 'user_edit'] as const;

/** String-literal union derived from `CONTINUATION_SUMMARY_SOURCES`. */
export type ContinuationSummarySource =
  (typeof CONTINUATION_SUMMARY_SOURCES)[number];

/** Predicate — true when `value` is a known `ContinuationSummarySource`. */
export const isContinuationSummarySource = (
  value: unknown,
): value is ContinuationSummarySource =>
  typeof value === 'string'
  && (CONTINUATION_SUMMARY_SOURCES as readonly string[]).includes(value);

// ────────────────────────────────────────────────────────────────
// Text size cap
// ────────────────────────────────────────────────────────────────

/** Cap on a `ContinuationSummary.summary_text` blob, in bytes. Matches
 *  D-120's sibling blob caps (`RECIPE_INSIGHT_FLATTENED_MAX_BYTES`,
 *  `CONTEXT_RECIPE_MAX_BYTES` — both 16 KB): a handoff summary is a
 *  *summary*, and an unbounded one defeats the token saving that makes
 *  lazy summarization worthwhile.
 *
 *  Declared here as the contract bound; the D-145 storage insert path
 *  enforces it (truncate-with-warning, the same posture D-120 takes for
 *  `context.recipe.*`). The structural predicate `isContinuationSummary`
 *  deliberately does NOT range-check against this — an over-cap blob is
 *  still structurally a summary; size is a storage-policy concern, not a
 *  shape concern. */
export const CONTINUATION_SUMMARY_TEXT_MAX_BYTES = 16_384;

// ────────────────────────────────────────────────────────────────
// ContinuationSummary — the summary memory entity
// ────────────────────────────────────────────────────────────────

/** A continuation-summary memory entity — the handoff artifact a later
 *  session loads to continue a closed one (spec lines 587-595). One
 *  `channel_session_id` may have several rows over its life: the single
 *  `cognition` original plus zero or more `user_edit` corrections;
 *  `selectCurrentContinuationSummary` resolves which is authoritative.
 *
 *  Every field is load-bearing for the predicate, the picker, or a
 *  constructor:
 *    - `summary_id` — identity; distinguishes the rows that share a
 *      `channel_session_id` and is the picker's deterministic
 *      tie-break. A non-empty string.
 *    - `channel_session_id` — the *summarized* session — the key the
 *      next session looks the summary up by. A descendant of a forking
 *      session tree (P5) reads its predecessor's summary under the
 *      predecessor's id. A non-empty string.
 *    - `summary_text` — the handoff blob. Bounded by
 *      `CONTINUATION_SUMMARY_TEXT_MAX_BYTES` at the storage layer. May
 *      be the empty string — a `user_edit` that clears the summary is a
 *      valid, if degenerate, state, so emptiness is not malformed.
 *    - `source` — `'cognition'` / `'user_edit'`; who authored the row.
 *    - `created_at` — unix-ms the row was authored: when cognition
 *      produced the artifact, or when the user saved the edit. A finite
 *      number; the picker's secondary precedence key.
 *    - `cognition_session_id` — the cognition session that produced a
 *      `cognition` row, for audit provenance. The shape carries a
 *      biconditional invariant the predicate enforces: present iff
 *      `source === 'cognition'`. A `user_edit` row never carries one;
 *      a `cognition` row always does. A non-empty string when present. */
export interface ContinuationSummary {
  readonly summary_id: string;
  readonly channel_session_id: string;
  readonly summary_text: string;
  readonly source: ContinuationSummarySource;
  readonly created_at: number;
  readonly cognition_session_id?: string;
}

/** Structural predicate — true when `value` matches `ContinuationSummary`
 *  exactly. The Engine / warehouse wiring receives summary rows from the
 *  D-145 store as untyped JSON; this narrows them before the picker and
 *  the trigger trust the shape.
 *
 *  Enforces the source ⇔ cognition-session biconditional: a `'cognition'`
 *  row MUST carry a non-empty `cognition_session_id`; a `'user_edit'`
 *  row MUST NOT carry one. The two constructors (`buildCognitionSummary`
 *  / `applyUserEditToContinuationSummary`) satisfy this by construction;
 *  the predicate is the gate for rows that did not come through them.
 *
 *  `summary_id` / `channel_session_id` must be non-empty — an empty id
 *  is malformed, not absent. `summary_text` may be empty (see the shape
 *  doc). `created_at` must be a finite number. */
export const isContinuationSummary = (
  value: unknown,
): value is ContinuationSummary => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const nonEmptyString = (x: unknown): x is string =>
    typeof x === 'string' && x.length > 0;

  if (!nonEmptyString(v.summary_id)) return false;
  if (!nonEmptyString(v.channel_session_id)) return false;
  if (typeof v.summary_text !== 'string') return false;
  if (!isContinuationSummarySource(v.source)) return false;
  if (typeof v.created_at !== 'number' || !Number.isFinite(v.created_at)) {
    return false;
  }

  // source ⇔ cognition_session_id biconditional.
  if (v.source === 'cognition') {
    if (!nonEmptyString(v.cognition_session_id)) return false;
  } else if (v.cognition_session_id !== undefined) {
    // source === 'user_edit' — a user is not a cognition session.
    return false;
  }
  return true;
};

// ────────────────────────────────────────────────────────────────
// Current-summary picker — user_edit-wins precedence
// ────────────────────────────────────────────────────────────────

/** True when summary `a` outranks `b` as the authoritative current
 *  summary. Precedence, in order:
 *
 *    1. **Source** — a `'user_edit'` outranks a `'cognition'` row
 *       *unconditionally*. The spec's "if cognition's summary is wrong,
 *       the user fixes it … the next session reads the corrected
 *       version" (line 591) makes the user's word authoritative; this
 *       must hold even if a `cognition` row somehow carries a later
 *       `created_at` (clock skew). In normal operation the lazy trigger
 *       is idempotent — exactly one `cognition` row is ever written,
 *       before any edit — so recency alone would suffice; source-first
 *       precedence is the spec-faithful encoding plus skew defence.
 *    2. **Recency** — among rows of the same source, the later
 *       `created_at` wins (the most recent of several `user_edit`
 *       corrections).
 *    3. **`summary_id`** — a code-point tie-break, so the choice is
 *       deterministic when two same-source rows share a timestamp. A
 *       stability rule, not a semantic ranking (mirrors P5's
 *       lowest-`session_id` `latest_leaf` tie-break). */
const outranksSummary = (
  a: ContinuationSummary,
  b: ContinuationSummary,
): boolean => {
  if (a.source !== b.source) return a.source === 'user_edit';
  if (a.created_at !== b.created_at) return a.created_at > b.created_at;
  return a.summary_id < b.summary_id;
};

/** Select the authoritative current summary for a `channel_session_id`
 *  from a set of summary rows. The substrate's stand-in for the
 *  storage-backed `WHERE channel_session_id = ?` query (engine + rpc
 *  work, deferred) and the reference precedence that query's
 *  result-ranking must match.
 *
 *  Scans `summaries` for rows whose `channel_session_id` matches and
 *  returns the one that outranks all others by the `outranksSummary`
 *  precedence (`user_edit` over `cognition`, then recency, then
 *  `summary_id`). Returns `undefined` when no row matches — the spec's
 *  "neither K/V nor summary" cold-start case (line 522).
 *
 *  Assumes well-formed `ContinuationSummary` rows — shape validation is
 *  `isContinuationSummary`'s job; this picks among rows it trusts. When
 *  the caller holds untyped rows, narrow with `isContinuationSummary`
 *  first.
 *
 *  Pure — never throws, never mutates the input. */
export const selectCurrentContinuationSummary = (
  summaries: ReadonlyArray<ContinuationSummary>,
  channel_session_id: string,
): ContinuationSummary | undefined => {
  let current: ContinuationSummary | undefined;
  for (const s of summaries) {
    if (s.channel_session_id !== channel_session_id) continue;
    if (current === undefined || outranksSummary(s, current)) {
      current = s;
    }
  }
  return current;
};

// ────────────────────────────────────────────────────────────────
// Constructors — the two ways a summary row comes into being
// ────────────────────────────────────────────────────────────────

/** Construct the `cognition`-sourced summary a continuation generates
 *  lazily on first load. The Engine calls this after the
 *  `HandoffSummarizer` slot returns: it extracts `summary_text` from the
 *  `HandoffSummarizationResult` and supplies the row metadata.
 *
 *  Sets `source: 'cognition'` and always carries `cognition_session_id`
 *  — the session that produced the artifact — so the row satisfies the
 *  `isContinuationSummary` biconditional by construction.
 *
 *  Pure — never throws. Does NOT enforce
 *  `CONTINUATION_SUMMARY_TEXT_MAX_BYTES`; the storage insert path does
 *  (see the constant's doc). */
export const buildCognitionSummary = (params: {
  readonly summary_id: string;
  readonly channel_session_id: string;
  readonly summary_text: string;
  readonly created_at: number;
  readonly cognition_session_id: string;
}): ContinuationSummary => ({
  summary_id: params.summary_id,
  channel_session_id: params.channel_session_id,
  summary_text: params.summary_text,
  source: 'cognition',
  created_at: params.created_at,
  cognition_session_id: params.cognition_session_id,
});

/** Apply a user edit to a prior summary — the user-edit affordance
 *  (spec line 591: a wrong summary, "the user fixes it"). Produces a
 *  *fresh* `user_edit` row rather than mutating `prior`, so the audit
 *  trail keeps both the original and the correction.
 *
 *  The new row:
 *    - takes `channel_session_id` from `prior` — an edit cannot move a
 *      summary to a different session;
 *    - sets `source: 'user_edit'` and carries NO `cognition_session_id`
 *      — a user is not a cognition session (the biconditional);
 *    - takes `summary_text` / `created_at` / `summary_id` from the
 *      edit. `created_at` later than `prior.created_at` is the normal
 *      case but is not required — `selectCurrentContinuationSummary`
 *      ranks `user_edit` over `cognition` by source regardless.
 *
 *  `prior` may itself be a `user_edit` row — editing an already-edited
 *  summary chains naturally, and the picker's recency rule selects the
 *  newest edit. The paired user-commit (spec line 591) is the Gateway's
 *  to write; this returns only the summary row.
 *
 *  Pure — never throws, never mutates `prior`. */
export const applyUserEditToContinuationSummary = (
  prior: ContinuationSummary,
  params: {
    readonly summary_id: string;
    readonly summary_text: string;
    readonly created_at: number;
  },
): ContinuationSummary => ({
  summary_id: params.summary_id,
  channel_session_id: prior.channel_session_id,
  summary_text: params.summary_text,
  source: 'user_edit',
  created_at: params.created_at,
});

// ────────────────────────────────────────────────────────────────
// Lazy-summarize trigger — when a summary gets generated
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of the occasions at which the Engine evaluates
 *  whether to summarize a session for handoff.
 *
 *  - `'continuation'`  — a message arrived that continues a closed
 *    session (P7 routes it `'new_session'`; the new session links to a
 *    predecessor via P5's `predecessor_session_id`). This is the
 *    next-message-arrival occasion the spec's lazy rule fires on.
 *  - `'session_close'` — a session just closed (any P6 cut authority).
 *    The lazy rule *declines* here: a session that is never resumed is
 *    never summarized, and that is the token saving.
 *
 *  The spec phrases the lazy rule as "runs only on next-message-arrival
 *  …, not eagerly on idle close" (line 597). `'session_close'`
 *  generalizes "idle close" to *any* close — the lazy decision is
 *  identical whichever P6 cut authority (debounce / plan-completion /
 *  cognition-driven) closed the session, so the substrate models one
 *  close occasion rather than one per authority. */
export const SUMMARIZE_TRIGGER_OCCASIONS = [
  'continuation',
  'session_close',
] as const;

/** String-literal union derived from `SUMMARIZE_TRIGGER_OCCASIONS`. */
export type SummarizeTriggerOccasion =
  (typeof SUMMARIZE_TRIGGER_OCCASIONS)[number];

/** Predicate — true when `value` is a known `SummarizeTriggerOccasion`. */
export const isSummarizeTriggerOccasion = (
  value: unknown,
): value is SummarizeTriggerOccasion =>
  typeof value === 'string'
  && (SUMMARIZE_TRIGGER_OCCASIONS as readonly string[]).includes(value);

/** Closed enumeration of why `evaluateSummarizeTrigger` reached its
 *  decision — informational, drives audit copy and the
 *  `session_lifecycle` event narrative, not control flow.
 *
 *  - `'continuation_first_load'` — the only `should_summarize: true`
 *    reason: a continuation with no summary yet, so cognition's
 *    `summarize_for_handoff()` runs now.
 *  - `'summary_already_exists'`  — a continuation, but a summary is
 *    already on file. The trigger is idempotent: the `cognition`
 *    summary is generated exactly once, and a later continuation (a
 *    second branch of a forking session tree) reuses it. A
 *    `user_edit` summary equally blocks regeneration — a re-summarize
 *    would silently overwrite the user's correction.
 *  - `'lazy_deferral'`           — the occasion was `'session_close'`;
 *    the lazy rule defers summarization to the next continuation, if
 *    one ever happens. */
export const SUMMARIZE_DECISION_REASONS = [
  'continuation_first_load',
  'summary_already_exists',
  'lazy_deferral',
] as const;

/** String-literal union derived from `SUMMARIZE_DECISION_REASONS`. */
export type SummarizeDecisionReason =
  (typeof SUMMARIZE_DECISION_REASONS)[number];

/** Predicate — true when `value` is a known `SummarizeDecisionReason`. */
export const isSummarizeDecisionReason = (
  value: unknown,
): value is SummarizeDecisionReason =>
  typeof value === 'string'
  && (SUMMARIZE_DECISION_REASONS as readonly string[]).includes(value);

/** The result of one `evaluateSummarizeTrigger` evaluation. */
export interface SummarizeTriggerEvaluation {
  /** True when the Engine should invoke `summarize_for_handoff()` now —
   *  a continuation with no summary on file. Always equals
   *  `reason === 'continuation_first_load'` (a single source of truth —
   *  the two can never disagree). */
  readonly should_summarize: boolean;
  /** Why the trigger reached its decision — see
   *  `SUMMARIZE_DECISION_REASONS`. */
  readonly reason: SummarizeDecisionReason;
}

/** Evaluate the lazy-summarize trigger — the deterministic encoding of
 *  the spec's lazy rule (line 597). Pure; the substrate's whole answer
 *  to "should a summary be generated now".
 *
 *  The decision:
 *    - `occasion === 'session_close'` → never summarize
 *      (`'lazy_deferral'`). This branch is what makes "lazy" a real,
 *      testable substrate guarantee rather than an Engine convention:
 *      the Engine may call the trigger at close time and the substrate
 *      will still decline.
 *    - `occasion === 'continuation'` with `current_summary` present →
 *      skip (`'summary_already_exists'`). Idempotent — see the reason
 *      doc.
 *    - `occasion === 'continuation'` with no `current_summary` →
 *      summarize (`'continuation_first_load'`).
 *
 *  `current_summary` is the authoritative summary already on file for
 *  the session being continued — pass the result of
 *  `selectCurrentContinuationSummary`, or `undefined` when the picker
 *  found none. The trigger keys only on its presence, not its source:
 *  a `cognition` summary and a `user_edit` summary both block
 *  regeneration.
 *
 *  Pure — never throws, never mutates the input. */
export const evaluateSummarizeTrigger = (
  occasion: SummarizeTriggerOccasion,
  current_summary: ContinuationSummary | undefined,
): SummarizeTriggerEvaluation => {
  if (occasion === 'session_close') {
    return { should_summarize: false, reason: 'lazy_deferral' };
  }
  // occasion === 'continuation'
  if (current_summary !== undefined) {
    return { should_summarize: false, reason: 'summary_already_exists' };
  }
  return { should_summarize: true, reason: 'continuation_first_load' };
};

// ────────────────────────────────────────────────────────────────
// Handoff summarizer — cognition stub (API only, no implementation)
// ────────────────────────────────────────────────────────────────

/** Input the Engine hands the handoff summarizer — the session to
 *  summarize. Deliberately narrow: a cognition implementation enriches
 *  this itself, pulling the session's commit log (P1) and its cognition
 *  K/V (P4, deferred) from `channel_session_id`. Mirrors P7's
 *  `RoutingClassifierInput` — the substrate's contract is the key, not
 *  the context.
 *
 *  - `channel_session_id` — the closed session to summarize. The
 *    resulting `ContinuationSummary` is keyed under this same id, so a
 *    later session reads it back by the predecessor's channel-session
 *    id. */
export interface HandoffSummarizationInput {
  readonly channel_session_id: string;
}

/** Output of the handoff summarizer — the cognition component's summary
 *  blob.
 *
 *  - `summary_text` — the handoff summary. Bounded by
 *    `CONTINUATION_SUMMARY_TEXT_MAX_BYTES` at the storage layer; the
 *    Engine passes it straight into `buildCognitionSummary`. May be the
 *    empty string (see `ContinuationSummary.summary_text`). */
export interface HandoffSummarizationResult {
  readonly summary_text: string;
}

/** Structural predicate — true when `value` matches `HandoffSummari-
 *  zationResult`. The summarizer output is a cognition component's
 *  product; the Engine narrows it with this before passing
 *  `summary_text` to `buildCognitionSummary`. Mirrors P7's
 *  `isRoutingClassification`. */
export const isHandoffSummarizationResult = (
  value: unknown,
): value is HandoffSummarizationResult => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.summary_text === 'string';
};

/** The handoff-summarizer slot — the typed contract a cognition
 *  component fills (the spec's `summarize_for_handoff()`, line 589).
 *  P9 ships this *type* (the summarizer API) but no implementation:
 *  there is no `summarizeForHandoff` function in the substrate.
 *  Producing the summary text is an LLM call, not deterministic Engine
 *  logic, and no cognition component runs in the default Recued runtime
 *  per the 2026-05-19 cognition downscope. The Engine invokes whatever
 *  fills this slot only when the `cognition` middleware is enabled in
 *  the D-160 registry (disabled — D-160 I-4); absent that, no summary
 *  is generated and a continuation falls back to the spec's cold-start
 *  outcome (commit + memory replay — line 522). Mirrors P6's cognition-
 *  driven cut and P7's `RoutingClassifier`. */
export type HandoffSummarizer = (
  input: HandoffSummarizationInput,
) => Promise<HandoffSummarizationResult>;
