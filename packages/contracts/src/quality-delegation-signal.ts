/** D-202 Slice 1 — the reject-driven quality LEARNER's pure vocabulary + logic:
 *  the durable verdict SIGNAL a quality-relevant ask produces, its projection
 *  onto the coarse `(recipe, op)` suggestion key, the suppression-join key a
 *  minted quality delegation occupies, and the reject-driven threshold the
 *  housekeeping learner evaluates a signal group against.
 *
 *  ── Why an explicit signal exists (contrast D-177) ──
 *  D-177's staged-trust learner (`delegation-suggestion.ts`) reads durable
 *  `grant_kind:'session'` rows — every `allow_session` approval MINTS one, so the
 *  grant IS the signal. The quality axis has no such artifact: a reject mints
 *  nothing and an approve just resumes the run, so D-202 needs an EXPLICIT signal
 *  record. This module is that record + the pure derivation the learner runs over
 *  it; the durable STORE (`quality-delegation-signal-store.ts`) and the live
 *  capture at the answer path (Slice 1b) are the impure halves.
 *
 *  ── Reject-driven, only-defaults-train (§6/§8/§12.3) ──
 *  Confidence rises on default-reason approves (`quality_good`) and is knocked
 *  down by a default-reason reject (`quality_bad`): a reject RESETS the
 *  accumulation, so the offer re-earns only on fresh approves AFTER it (§8
 *  "over-attribution costs only latency — it re-earns on the next approve"). Only
 *  default-reason verdicts train ({@link reasonTrainsQuality}); the two override
 *  reasons (`policy` reject, `ship_anyway` approve) never move confidence. v1 is
 *  the degenerate single whole-template node (§14): attribution is trivially the
 *  whole `(recipe, op)`, so there is no region graph here yet.
 *
 *  Everything is PURE — no I/O, no clock reads (callers pass `nowMs`).
 *
 *  Spec: D-202 §2 (signals), §6/§8 (reject-driven confidence +
 *  attribution), §12.3 (only defaults train), §14 (degenerate node). */

import type { ContractDefinition } from './contract-definition.js';
import {
  QUALITY_DELEGATION_GRANT_KIND,
  reasonTrainsQuality,
  type QualityVerdictReason,
} from './quality-delegation.js';
import type {
  QualityDelegationSuggestionEvidence,
  QualityDelegationSuggestionKey,
} from './quality-delegation-suggestion.js';

/** The `composite_keys` scope a signal row is keyed under (a row lives at
 *  `contract.quality_delegation_signal.<signal_id>`). Defined here beside the row
 *  shape, per the `CONTRACT_DEFINITION_SCOPE` convention. */
export const QUALITY_DELEGATION_SIGNAL_SCOPE = 'quality_delegation_signal';

/** Default-reason approves — spanning that many DISTINCT sessions — that a
 *  `(recipe, op)` must accumulate AFTER its most recent reject before it earns an
 *  offer. Mirrors the D-177 `DELEGATION_SUGGEST_THRESHOLD` = 3 (the D-132
 *  `MANUAL_RUN_THRESHOLD` precedent). Both floors are the same value: the pain a
 *  standing quality delegation removes is a recipe reviewed the SAME way again and
 *  again across sessions, so a single session's burst of approves must not alone
 *  earn the offer. Over-strictness costs only latency (the owner can always mint
 *  manually), which is the acceptable direction. */
export const QUALITY_DELEGATION_SUGGEST_THRESHOLD = 3;

/** Evidence lookback (30 d) — a verdict older than this is stale and does not
 *  count toward the threshold. Equal to the D-177 lookback; a quality delegation
 *  is standing (no rule TTL), so this is a plain recency window, not a
 *  TTL-alignment. */
export const QUALITY_DELEGATION_SUGGEST_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** Newest-first cap on the sample refs stored on the suggestion evidence (the
 *  card's "see the approvals behind this" affordance; the full set is always
 *  re-derivable from the durable signal rows). */
export const QUALITY_DELEGATION_SUGGEST_SAMPLE_REFS_MAX = 5;

/** D-202 §2 — one durable owner verdict on a quality-relevant `(recipe, op)`
 *  send. Written (Slice 1b) when the owner approves/rejects an ask the 4a gate
 *  raised as `quality_not_delegated` — authorization admitted; only the MISSING
 *  quality delegation held the send. Those are precisely the asks a quality
 *  delegation would remove, so learning from them is non-circular relevance (seam
 *  contract §2 — the owner's own reviews are the signal, not a gate-derived taint).
 *
 *  `reason` is the §2 reason code — v1's live capture stamps only the two DEFAULT
 *  reasons (approve → `quality_good`, reject → `quality_bad`); the two overrides
 *  (`policy` reject, `ship_anyway` approve) are reserved for the richer render
 *  (D-200 Slice 4) and, if ever stored, are dropped by {@link reasonTrainsQuality}
 *  before anything is counted. */
export interface QualityDelegationSignal {
  /** Unique row id (the storage segment). */
  readonly signal_id: string;
  readonly recipe_id: string;
  readonly recipe_hash: string;
  /** The dispatched ingredient slug. */
  readonly ingredient_id: string;
  /** The catalog op key — present exactly when the dispatch carried a trusted
   *  `surface_operation_key` (absent on simple-form dispatches;
   *  both-absent-or-equal at the coarse `(recipe, op)` grain). */
  readonly operation_id?: string;
  /** The session the verdict was given in — the distinct-session floor counts
   *  these so one session's repeated approves cannot alone earn an offer. */
  readonly channel_session_id: string;
  /** The §2 reason code. Only default reasons train ({@link reasonTrainsQuality}). */
  readonly reason: QualityVerdictReason;
  /** Event time (epoch-ms) the verdict was recorded. */
  readonly at: number;
  /** Optional audit back-pointer (the resolved run / ask id) — surfaced in the
   *  evidence sample; never load-bearing for the threshold. */
  readonly audit_ref?: string;
}

/** A non-empty string — the runtime-defensive JSON-row gate the sibling matchers
 *  use (signal rows are JSON at rest; a hand-authored row could carry anything). */
const nonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

/** Project a signal onto the coarse `(recipe, op)` suggestion key, or `undefined`
 *  when the signal can't faithfully key one (missing recipe identity / ingredient
 *  — fail closed; such a signal simply doesn't count). The op axis is
 *  absent-or-present, mirroring `qualityDelegationSuggestionKeyHash`'s op clause
 *  (both-absent-or-equal). */
export const qualityDelegationSignalKey = (
  signal: QualityDelegationSignal,
): QualityDelegationSuggestionKey | undefined => {
  if (
    !nonEmptyString(signal.recipe_id)
    || !nonEmptyString(signal.recipe_hash)
    || !nonEmptyString(signal.ingredient_id)
  ) {
    return undefined;
  }
  return {
    recipe_id: signal.recipe_id,
    recipe_hash: signal.recipe_hash,
    ingredient_id: signal.ingredient_id,
    ...(nonEmptyString(signal.operation_id) ? { operation_id: signal.operation_id } : {}),
  };
};

/** Derive the `(recipe, op)` suggestion key a minted quality delegation occupies —
 *  the learner's SUPPRESSION join. An existing grant on a key means: REVOKED ⇒
 *  durable distrust (never re-suggest), LIVE ⇒ already operating (a suggestion
 *  would be noise); the scan task treats both as suppressing, mirroring the D-177
 *  delegation-rule suppression. Returns `undefined` for any non-quality-delegation
 *  row or a grant that can't faithfully key one (fail closed).
 *
 *  Binds like {@link matchesQualityDelegation}: `bound_recipe` both halves + an
 *  explicit SINGLE ingredient + an optional single op. A multi-valued
 *  ingredient/op axis can't key the coarse grain and fails closed. The accept
 *  path (`qualityDelegationMintPlanFromSnapshot`) — the only mint CALLER — always
 *  produces a single-ingredient, ≤1-op scope, so a multi-valued grant never
 *  legitimately arises; and a LIVE one suppresses signal accrual at the gate
 *  regardless (no asks → no signals → no suggestion to suppress). The raw
 *  `mintQualityDelegation` store primitive is itself more permissive (it only
 *  requires the ingredient axis non-empty) — a latent gap shared with the D-177
 *  precedent, exposed only by a hypothetical REVOKED multi-valued grant that no
 *  caller produces. */
export const deriveQualityDelegationKeyFromGrant = (
  grant: ContractDefinition,
): QualityDelegationSuggestionKey | undefined => {
  if (grant.grant_kind !== QUALITY_DELEGATION_GRANT_KIND) return undefined;
  const bound = grant.bound_recipe;
  if (
    bound === undefined
    || bound === null
    || !nonEmptyString(bound.recipe_id)
    || !nonEmptyString(bound.recipe_hash)
  ) {
    return undefined;
  }
  const ingredientAxis = grant.scope.ingredient_ids;
  if (
    ingredientAxis === undefined
    || ingredientAxis.length !== 1
    || !nonEmptyString(ingredientAxis[0])
  ) {
    return undefined;
  }
  // Op axis: absent/empty ⇒ any op (unbound); exactly one ⇒ that op; multi-valued
  // ⇒ can't key the coarse grain (fail closed).
  const opAxis = grant.scope.operation_ids;
  let operation_id: string | undefined;
  if (opAxis !== undefined && opAxis.length > 0) {
    if (opAxis.length !== 1 || !nonEmptyString(opAxis[0])) return undefined;
    operation_id = opAxis[0];
  }
  return {
    recipe_id: bound.recipe_id,
    recipe_hash: bound.recipe_hash,
    ingredient_id: ingredientAxis[0],
    ...(operation_id !== undefined ? { operation_id } : {}),
  };
};

/** Evaluate one `(recipe, op)` signal group — every {@link QualityDelegationSignal}
 *  projecting the same suggestion key — against the reject-driven threshold at
 *  `nowMs`. Pure. The caller (the learner) supplies the group and separately joins
 *  the quality-delegation suppression (an existing grant on the key) + the
 *  suggestion-row state machine (dismissed/accepted rows are never re-opened).
 *
 *  Reject-driven (§6/§8/§12.3):
 *   - Only DEFAULT-reason verdicts train ({@link reasonTrainsQuality}) — the two
 *     override reasons are dropped before anything is counted, so a `policy`
 *     reject (routed to the authorization axis) never knocks quality confidence.
 *   - Within the {@link QUALITY_DELEGATION_SUGGEST_LOOKBACK_MS} window, the most
 *     recent default-reason REJECT (`quality_bad`) knocks confidence down: only
 *     `quality_good` approves STRICTLY AFTER it count toward the offer (a reject
 *     can never move a region toward delegation, §8; the offer re-earns on fresh
 *     approves). No windowed reject ⇒ every windowed approve counts.
 *   - Qualifies iff the counted approves ≥ {@link QUALITY_DELEGATION_SUGGEST_THRESHOLD}
 *     AND span ≥ that many DISTINCT `channel_session_id`s.
 *
 *  On qualification, `evidence` describes exactly the counted approves. */
export const evaluateQualityDelegationSuggestionGroup = (
  signals: ReadonlyArray<QualityDelegationSignal>,
  nowMs: number,
):
  | { qualifies: true; evidence: QualityDelegationSuggestionEvidence }
  | { qualifies: false } => {
  const windowStart = nowMs - QUALITY_DELEGATION_SUGGEST_LOOKBACK_MS;
  // Only default-reason verdicts train (§12.3); keep only windowed, real-time ones.
  const trained = signals.filter(
    (s) =>
      reasonTrainsQuality(s.reason)
      && Number.isFinite(s.at)
      && s.at >= windowStart
      && s.at <= nowMs,
  );

  // The most recent default-reason reject knocks confidence down — only approves
  // strictly AFTER it re-earn the offer (§8). An approve at the exact reject
  // instant does NOT count (it did not follow the reject) — conservative tie-break.
  let lastRejectAt = Number.NEGATIVE_INFINITY;
  for (const s of trained) {
    if (s.reason === 'quality_bad' && s.at > lastRejectAt) lastRejectAt = s.at;
  }
  const approves = trained.filter(
    (s) => s.reason === 'quality_good' && s.at > lastRejectAt,
  );
  if (approves.length < QUALITY_DELEGATION_SUGGEST_THRESHOLD) return { qualifies: false };

  const sessions = new Set<string>();
  for (const s of approves) {
    if (nonEmptyString(s.channel_session_id)) sessions.add(s.channel_session_id);
  }
  if (sessions.size < QUALITY_DELEGATION_SUGGEST_THRESHOLD) return { qualifies: false };

  const byAtDesc = [...approves].sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    if (a.signal_id < b.signal_id) return -1;
    if (a.signal_id > b.signal_id) return 1;
    return 0;
  });
  const sample_refs: string[] = [];
  for (const s of byAtDesc) {
    if (sample_refs.length >= QUALITY_DELEGATION_SUGGEST_SAMPLE_REFS_MAX) break;
    sample_refs.push(nonEmptyString(s.audit_ref) ? s.audit_ref : s.signal_id);
  }
  return {
    qualifies: true,
    evidence: {
      approve_count: approves.length,
      distinct_session_count: sessions.size,
      sample_refs,
      first_at: byAtDesc[byAtDesc.length - 1].at,
      last_at: byAtDesc[0].at,
    },
  };
};
