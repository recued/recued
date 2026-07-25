/** D-145 PB14 — engine wiring for the Correction Learning primitive.
 *
 *  Per § B.14.3. Three deterministic engine-side consumption hooks
 *  over a per-pair `CorrectionEventRow[]` snapshot:
 *
 *    Hook 1 (pre-flight context shaping, § B.14.3 step 1)
 *      → `computeContextShapingBiases(rows, ctx) → ContextShapingBias[]`
 *
 *    Hook 2 (extraction confidence re-calibration, § B.14.3 step 2)
 *      → `computeExtractionThresholdAdjustment(rows, fact_type, now)`
 *        → number (current auto-save threshold, post-ladder)
 *
 *    Hook 3 (AI synthesis prompt augmentation, § B.14.3 step 3)
 *      → `buildCorrectionSummary(rows, now) → CorrectionSummary`
 *
 *  All three hooks are pure functions — no IO, no side effects, no
 *  database access. Hook 3 is adapted into the D-160
 *  `correctionLearningMiddleware`, which threads the snapshot in via
 *  `ctx.state` (a faithful no-op until a producer supplies
 *  `listRecentCorrectionEvents()`); Hooks 1 & 2 remain exported
 *  substrate with no live consumer yet. Pure functions keep engine
 *  consumption deterministic + cheap to unit-test in isolation.
 *
 *  Privacy invariant (§ B.14.4): `buildCorrectionSummary` projects
 *  raw correction payloads into flat aggregate counts. Raw alias
 *  text, raw platform_ids, raw standing_instruction body content,
 *  raw social context — none of these are ever copied into the
 *  output map. The substrate enforces this by construction (the
 *  summary projection only reads `kind` + `user_feedback` +
 *  scoped `contact_id` keys; raw text fields are not consulted).
 *
 *  Spec: `docs/d-145-spec.md` § B.14.3 + § B.14.4. */

import {
  CORRECTION_EVENT_KIND_SET,
  EXTRACTION_THRESHOLD_LADDER,
  EXTRACTION_THRESHOLD_TRIGGER_COUNT,
  EXTRACTION_THRESHOLD_WINDOW_MS,
  PLAN_OUTCOME_USER_FEEDBACK_SET,
  type CorrectionEvent,
  type CorrectionEventKind,
  type CorrectionEventRow,
  type CorrectionSummary,
  type ExtractionUndoneReason,
  type ExtractionEventKind,
  type OmissionReasonCode,
  type PlanOutcomeUserFeedback,
} from '@recued/contracts';

// ── PB14.10 — Hook 1: pre-flight context shaping ────────────────────

/** § B.14.3 step 1 output. A derivable `OmittedItem`-shaped record
 *  destined for `RecuedPlan.omitted_context[]`. Closed
 *  shape — `reason_code` is always `'permission_scope'` (the user
 *  explicitly marked the context source); `reason_detail` carries the
 *  derivation pointer so audit replay can re-walk the correction. */
export interface ContextShapingBias {
  /** Path; never content. Verbatim from the correction's source_ref. */
  readonly source_ref: string;
  /** Always `'permission_scope'` — the user marked this source as
   *  omit. Other omission codes route through a different code path. */
  readonly reason_code: Extract<OmissionReasonCode, 'permission_scope'>;
  /** Pointer back to the originating correction row by id. Format:
   *  `'derived_from_correction:<correction_id>'`. Lets Settings UI +
   *  Transparency Stream render the cause chain. */
  readonly reason_detail: string;
  /** Substrate-enforced compile-time invariant — biases never carry
   *  payload, only a path + reason. Mirrors `OmittedItem.content_stored`
   *  per § B.5.2. */
  readonly content_stored: false;
}

/** Optional context the pre-flight hook reads to apply scoped biases. */
export interface ContextShapingInput {
  /** Per-pair correction snapshot — `listRecentCorrectionEvents()`
   *  results, once a caller supplies them. */
  readonly rows: ReadonlyArray<CorrectionEventRow>;
  /** Current request's subject contact (when known). Drives
   *  `this_contact` scope filtering — corrections with payload
   *  `contact_id === current_contact_id` apply; others don't. */
  readonly current_contact_id?: string;
}

/** § B.14.3 step 1 — pure projection. Reads `context_marked_omit` rows
 *  in the snapshot, filters by scope, and emits one bias per
 *  applicable correction. The orchestrator (which no live caller
 *  wires yet) threads these through `RecuedPlan.omitted_context[]` so
 *  the AI packet composer
 *  sees the omission rationale.
 *
 *  Scope semantics:
 *    - `'global'` → always applies
 *    - `'this_contact'` → applies when payload `contact_id` matches
 *      `current_contact_id` (silently skipped if either side missing)
 *    - `'this_request'` / `'this_session'` → never applies (these are
 *      inert by the next request boundary)
 *
 *  Determinism: same input → same output in the same order (rows are
 *  consumed in passed-in order; the pre-flight caller passes rows
 *  newest-first via `idx_correction_kind_time`). */
export const computeContextShapingBiases = (
  input: ContextShapingInput,
): ReadonlyArray<ContextShapingBias> => {
  const out: ContextShapingBias[] = [];
  const seen = new Set<string>();
  for (const row of input.rows) {
    if (row.kind !== 'context_marked_omit') continue;
    const payload = row.payload_blob as Record<string, unknown>;
    const sourceRef = payload.source_ref;
    if (typeof sourceRef !== 'string' || sourceRef.length === 0) continue;
    // Codex P2 fold (2026-05-10) — read `row.scope` as canonical, not
    // `payload.for_scope`. The store-side scope-filter queries
    // (`listByScope`) read the row column, so a divergence between
    // `row.scope` and `payload.for_scope` would let a row stored as
    // `this_request` / `this_session` (correctly filtered out at
    // store level) leak through the hook if its payload's for_scope
    // disagreed. Defense-in-depth — if the two ever drift in a
    // parsed-JSON path, the store's column wins.
    const scope = row.scope;
    if (scope === 'this_request' || scope === 'this_session') continue;
    if (scope === 'this_contact') {
      // contact_id still lives on the payload — the row column doesn't
      // carry contact identity (intentional; the row keys are
      // (id, kind, scope, plan-correlation, extraction-correlation)).
      const payloadContact = payload.contact_id;
      if (typeof payloadContact !== 'string' || payloadContact.length === 0) continue;
      if (input.current_contact_id !== payloadContact) continue;
    } else if (scope !== 'global') {
      // Unknown scope — defensive skip; runtime guard mirrors the
      // contract-side closed-list check, but parsed-JSON inputs may
      // still drift.
      continue;
    }
    // Dedupe by (source_ref) — multiple corrections marking the same
    // source as omit collapse to one bias. The newest row wins because
    // rows arrive newest-first; the loop only inserts on first sight.
    if (seen.has(sourceRef)) continue;
    seen.add(sourceRef);
    out.push({
      source_ref: sourceRef,
      reason_code: 'permission_scope',
      reason_detail: `derived_from_correction:${row.id}`,
      content_stored: false,
    });
  }
  return out;
};

// ── PB14.11 — Hook 2: extraction confidence re-calibration ──────────

/** Default auto-save threshold per § B.14.3 step 2. Matches the ladder
 *  base. Engine code calls this default when no per-class override
 *  exists and the correction stream hasn't yet triggered a step. */
export const DEFAULT_EXTRACTION_AUTO_SAVE_THRESHOLD = EXTRACTION_THRESHOLD_LADDER[0];

export interface ExtractionThresholdInput {
  /** Per-pair correction snapshot — same shape as Hook 1's `rows`. */
  readonly rows: ReadonlyArray<CorrectionEventRow>;
  /** Which extraction kind to bucket on. Threshold re-calibration is
   *  per-fact-type — `extraction.commitment` corrections don't move
   *  `extraction.preference`'s threshold. */
  readonly fact_type: ExtractionEventKind;
  /** Current wallclock (Unix ms). Drives the recency window. Pass
   *  `Date.now()` from runtime callers; tests pass deterministic
   *  values. */
  readonly now: number;
  /** Optional starting threshold (defaults to the ladder base 0.85).
   *  Tests override to verify ladder walks from arbitrary starting
   *  positions; runtime callers pass the system default. */
  readonly base_threshold?: number;
}

/** § B.14.3 step 2 — pure threshold projection. Walks the
 *  `EXTRACTION_THRESHOLD_LADDER` based on the correction stream:
 *
 *    - ≥3 `extraction_undone` with
 *      `reason: 'low_confidence_should_have_skipped'` for the fact_type
 *      in the last 30d → step UP one rung (cap at the ladder top).
 *    - ≥3 `rejected_extraction` for the fact_type in the last 30d
 *      → step DOWN one rung (floor at the ladder base).
 *
 *  When both conditions trigger simultaneously, the substrate prefers
 *  the safer direction (UP — raising the threshold reduces auto-save
 *  noise; the user's recent undo signal carries more weight than the
 *  rejection-at-queue signal).
 *
 *  Returns the resolved auto-save threshold ∈ EXTRACTION_THRESHOLD_LADDER.
 *  Pure; same input → same output. */
export const computeExtractionThresholdAdjustment = (
  input: ExtractionThresholdInput,
): number => {
  const base = input.base_threshold ?? EXTRACTION_THRESHOLD_LADDER[0];
  const cutoff = input.now - EXTRACTION_THRESHOLD_WINDOW_MS;
  // Bound the starting index against the ladder. If the supplied base
  // doesn't appear, we still walk; we just start at the nearest rung.
  let idx = EXTRACTION_THRESHOLD_LADDER.indexOf(base);
  if (idx < 0) {
    // Snap to the nearest rung (≤ base preferred so the ladder math
    // stays monotonic upward when we step).
    idx = 0;
    for (let i = 0; i < EXTRACTION_THRESHOLD_LADDER.length; i++) {
      if (EXTRACTION_THRESHOLD_LADDER[i] <= base) idx = i;
      else break;
    }
  }
  let undoneCount = 0;
  let rejectedCount = 0;
  for (const row of input.rows) {
    if (row.event_at < cutoff) continue;
    const payload = row.payload_blob as Record<string, unknown>;
    if (payload.fact_type !== input.fact_type) continue;
    if (row.kind === 'extraction_undone') {
      const reason = payload.reason as ExtractionUndoneReason | undefined;
      if (reason === 'low_confidence_should_have_skipped') undoneCount++;
    } else if (row.kind === 'rejected_extraction') {
      rejectedCount++;
    }
  }
  if (undoneCount >= EXTRACTION_THRESHOLD_TRIGGER_COUNT) {
    // Walk up — cap at the top rung.
    idx = Math.min(idx + 1, EXTRACTION_THRESHOLD_LADDER.length - 1);
  } else if (rejectedCount >= EXTRACTION_THRESHOLD_TRIGGER_COUNT) {
    // Walk down — floor at the ladder base. Conditional on `else if`
    // is deliberate: when both fire, the UP direction wins (substrate
    // prefers the safer side).
    idx = Math.max(idx - 1, 0);
  }
  return EXTRACTION_THRESHOLD_LADDER[idx];
};

// ── PB14.12 — Hook 3: AI synthesis prompt augmentation ──────────────

export interface CorrectionSummaryInput {
  /** Per-pair correction snapshot — same shape as Hook 1's `rows`. */
  readonly rows: ReadonlyArray<CorrectionEventRow>;
  /** Current wallclock (Unix ms). Drives the recency window. */
  readonly now: number;
  /** Recency window override (defaults to 30d — same as the
   *  threshold-ladder window). The summary projection is recency-
   *  scoped: the AI doesn't need to see corrections from a year ago. */
  readonly window_ms?: number;
}

/** § B.14.3 step 3 — pure summary projection. Reads the recent
 *  correction stream + emits a flat key→count map suitable for the AI
 *  packet `correction_summary` field.
 *
 *  Key schema (closed list — adding a key requires substrate D-spec):
 *    - `tone_wrong_action_recent_corrections`
 *    - `tone_wrong_tone_recent_corrections`
 *    - `tone_too_chatty_recent_corrections`
 *    - `tone_too_terse_recent_corrections`
 *    - `tone_right_action_wrong_args_recent_corrections`
 *    - `wrong_alias_corrections_for_<contact_id>` (one per contact
 *      that received ≥1 alias_corrected event in the window)
 *    - `recent_extraction_undones`
 *    - `recent_rejected_extractions`
 *
 *  Privacy invariant: keys NEVER contain raw alias text, raw
 *  platform_id strings, raw standing_instruction body, or raw social
 *  context. The only non-fixed key is `wrong_alias_corrections_for_<id>`
 *  which uses contact_id (a substrate-stable opaque identifier — not
 *  user-readable text). Substrate-enforced by construction — the
 *  projection only reads structurally typed fields. */
export const buildCorrectionSummary = (
  input: CorrectionSummaryInput,
): CorrectionSummary => {
  const window = input.window_ms ?? EXTRACTION_THRESHOLD_WINDOW_MS;
  const cutoff = input.now - window;
  const counters: Record<string, number> = {};
  const bump = (key: string): void => {
    counters[key] = (counters[key] ?? 0) + 1;
  };
  for (const row of input.rows) {
    if (row.event_at < cutoff) continue;
    const payload = row.payload_blob as Record<string, unknown>;
    if (row.kind === 'plan_outcome_corrected') {
      const fb = payload.user_feedback as PlanOutcomeUserFeedback | undefined;
      if (fb !== undefined && PLAN_OUTCOME_USER_FEEDBACK_SET.has(fb)) {
        bump(`tone_${fb}_recent_corrections`);
      }
    } else if (row.kind === 'alias_corrected') {
      const contact = payload.corrected_contact_id;
      if (typeof contact === 'string' && contact.length > 0) {
        bump(`wrong_alias_corrections_for_${contact}`);
      }
    } else if (row.kind === 'extraction_undone') {
      bump('recent_extraction_undones');
    } else if (row.kind === 'rejected_extraction') {
      bump('recent_rejected_extractions');
    }
  }
  return Object.freeze(counters);
};

// ── PB14.13 — Helper re-exports for ergonomic consumption ───────────

/** Re-export for callers that resolve corrections through PB14 without
 *  pulling the contracts directly. */
export type {
  CorrectionEvent,
  CorrectionEventRow,
  CorrectionEventKind,
  CorrectionSummary,
};
export { CORRECTION_EVENT_KIND_SET };
