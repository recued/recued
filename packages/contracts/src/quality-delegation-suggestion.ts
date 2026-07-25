/** D-202 — quality-delegation suggest→accept vocabulary: the suggestion row a
 *  quality delegation is offered as, its `(recipe, op)` key, and the pure
 *  mint-plan the accept path projects into a {@link MintQualityDelegationInput}.
 *
 *  Mirrors the D-177 delegation-suggestion substrate (`delegation-suggestion.ts`)
 *  but MUCH narrower: a quality delegation is coarse `(recipe, op)` grain (spec
 *  §5) and grants NO authority, so the key carries no per-call payload identity,
 *  no `grant_mode`, no `risk_tier`, no projection — just the recipe identity + the
 *  op. Like the delegation ladder (§12.4 — no silent promotion), a suggestion is
 *  only ever MINTED by the owner accepting it; background learning never mints.
 *
 *  The suggestion SOURCE — the reject-driven learner that decides a `(recipe, op)`
 *  has earned an offer — is Slice 1 (it consumes the D-200 §9 reject/approve
 *  signals). So this module is the vocab + the accept-side mint-plan ONLY; the
 *  threshold/derivation logic lands with the learner. Everything here is PURE (no
 *  I/O, no clock reads — callers pass `nowMs`); the impure half is the server-side
 *  store (`quality-delegation-suggestion-store.ts`).
 *
 *  Spec: docs/d-202-spec.md §5 / §12.4. */

import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import { sha256Hex } from '@recued/crypto/hash';

import type { BoundRecipeRef, ContractScope } from './contract-definition.js';

/** The `composite_keys` scope a suggestion row is keyed under (a row lives at
 *  `contract.quality_delegation_suggestion.<key_hash>`). Defined here beside the
 *  row shape, per the `CONTRACT_DEFINITION_SCOPE` convention. */
export const QUALITY_DELEGATION_SUGGESTION_SCOPE = 'quality_delegation_suggestion';

/** The housekeeping task id the Slice 1 learner will register under. Reserved
 *  here so the scope + task constant live beside the vocabulary they key. */
export const QUALITY_DELEGATION_SUGGESTION_SCAN_TASK_ID =
  'quality-delegation-suggestion-scan' as const;

/** D-202 — the `(recipe, op)` identity a quality-delegation suggestion fires
 *  for. The coarse grain (§5): recipe content (`recipe_hash`) so a re-authored
 *  recipe re-arms a fresh key (the v1 whole-template reset), plus the op
 *  (ingredient + optional operation). No actor/channel — a quality judgment is a
 *  property of the recipe's OUTPUT, not the trigger; the owner-only provenance is
 *  stamped by the mint (scope `actors: ['user_self']`) + the owner-only rpc, not
 *  a key axis. */
export interface QualityDelegationSuggestionKey {
  readonly recipe_id: string;
  readonly recipe_hash: string;
  readonly ingredient_id: string;
  /** Bound exactly when the delivery op carried a trusted operation key —
   *  absent on simple-form dispatches (both-absent-or-equal at the matcher). */
  readonly operation_id?: string;
}

/** The snapshot a suggestion stores — the would-be grant, verbatim (the accept
 *  mints FROM this, "what the card showed"). v1 is exactly the key; reserved as a
 *  distinct type so region/display metadata can hang off it later (§14) without
 *  re-keying. */
export interface QualityDelegationSuggestionSnapshot
  extends QualityDelegationSuggestionKey {
  /** Human-facing label the learner proposes for the grant (the card shows it;
   *  the accept passes it as the grant's `display_name`). Optional — the accept
   *  path falls back to a derived label. */
  readonly display_name?: string;
}

/** The evidence block describing WHY the `(recipe, op)` earned an offer — the
 *  card's "see the approvals behind this" affordance. The Slice 1 learner
 *  recomputes it from the D-200 §9 default-reason approve signals; until then a
 *  test/fake source seeds it. */
export interface QualityDelegationSuggestionEvidence {
  /** Default-reason `quality-good` approves observed for this `(recipe, op)`. */
  readonly approve_count: number;
  /** Distinct sessions those approves spanned. */
  readonly distinct_session_count: number;
  /** Newest-first sample of the contributing signal refs (audit anchors). */
  readonly sample_refs: ReadonlyArray<string>;
  readonly first_at: number;
  readonly last_at: number;
}

/** Suggestion lifecycle. `'dismissed'` is per-key PERMANENT (a fresh
 *  `recipe_hash` re-arms a new key naturally); `'accepted'` marks the owner mint
 *  and is never re-opened by the learner. */
export type QualityDelegationSuggestionState = 'open' | 'accepted' | 'dismissed';

/** One suggestion row, keyed by `key_hash` at
 *  `contract.quality_delegation_suggestion.<key_hash>` (value_shape
 *  `quality_delegation_suggestion`). Owner-surface only — never serialized into
 *  model-visible context (like the delegation suggestions, this family is
 *  reserved out of MCP). */
export interface QualityDelegationSuggestionRow {
  readonly key_hash: string;
  readonly state: QualityDelegationSuggestionState;
  readonly snapshot: QualityDelegationSuggestionSnapshot;
  readonly evidence: QualityDelegationSuggestionEvidence;
  readonly created_at: number;
  readonly updated_at: number;
}

/** A non-empty string — the runtime-defensive JSON-row gate (rows are JSON; a
 *  hand-authored row could carry anything). */
const nonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

/** The canonical key hash — the suggestion row's storage segment + UNIQUE upsert
 *  identity. Hashes the key fields only (canonical JSON: sorted keys, absent
 *  `operation_id` omitted — a `(recipe, op)` with no op hashes differently from
 *  one with an op, which is correct: both-absent-or-equal is the matcher's op
 *  clause). */
export const qualityDelegationSuggestionKeyHash = (
  key: QualityDelegationSuggestionKey,
): string =>
  sha256Hex(
    canonicalJSONStringify({
      recipe_id: key.recipe_id,
      recipe_hash: key.recipe_hash,
      ingredient_id: key.ingredient_id,
      ...(key.operation_id !== undefined ? { operation_id: key.operation_id } : {}),
    }),
  );

/** D-202 — the grant fields a stored snapshot projects into the accept-mint, or
 *  `undefined` when the snapshot cannot faithfully mint (fail closed on every
 *  clause — a suggestion row is JSON at rest, so the mint path re-validates
 *  rather than trusting storage, mirroring `delegationRuleMintPlanFromSnapshot`).
 *
 *  Returns the `scope` + `bound_recipe` the mint needs; the handler supplies
 *  `minted_by` / `display_name` / `approved_action_ref` / optional `expiry_at`.
 *  The scope is stamped owner-provenance (`actors: ['user_self']`) — the
 *  {@link mintQualityDelegation} store primitive requires it — and binds exactly
 *  the op the offer carried (ingredient + optional operation), never widened. */
export const qualityDelegationMintPlanFromSnapshot = (
  snapshot: QualityDelegationSuggestionSnapshot,
): { scope: ContractScope; bound_recipe: BoundRecipeRef } | undefined => {
  if (
    !nonEmptyString(snapshot.recipe_id)
    || !nonEmptyString(snapshot.recipe_hash)
    || !nonEmptyString(snapshot.ingredient_id)
  ) {
    return undefined;
  }
  // Optional op axis: absent ⇒ any op under the ingredient (a legal grant
  // shape); present must be a real value — an empty string would bind a
  // nonsense axis.
  if (snapshot.operation_id !== undefined && !nonEmptyString(snapshot.operation_id)) {
    return undefined;
  }
  const scope: ContractScope = {
    // Owner-provenance — the mint requires exactly `['user_self']`, and only the
    // owner (via the owner-only accept rpc) ever reaches this path (§12.4).
    actors: ['user_self'],
    ingredient_ids: [snapshot.ingredient_id],
    ...(snapshot.operation_id !== undefined
      ? { operation_ids: [snapshot.operation_id] }
      : {}),
  };
  return {
    scope,
    bound_recipe: { recipe_id: snapshot.recipe_id, recipe_hash: snapshot.recipe_hash },
  };
};
