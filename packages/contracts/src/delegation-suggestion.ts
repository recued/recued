/** D-177 N.13 (P6b) — staged-trust suggestion vocabulary: the N.13 key a
 *  delegation-rule suggestion aggregates session-grant rows under, the
 *  suggestion row shape the housekeeping learner upserts, and the pure
 *  derivation + threshold evaluation the learner runs.
 *
 *  Ladder step 6 (N.9.7): background learning SUGGESTS a bounded delegation
 *  rule after repeated successful approvals; only the human mints it (P6c).
 *  The learner's signal is durable `grant_kind: 'session'` rows ONLY (fork 5)
 *  — every `allow_session` answer is one row carrying the complete would-be-
 *  rule key, and `uses_remaining < max_uses` proves the grant absorbed a real
 *  repeat dispatch (the mint-time resume proceeds on the approval itself, so
 *  the first consumption IS a repeat). Plain-Approve answers are deliberately
 *  NOT a signal (asks prune; commits carry no admit-basis).
 *
 *  Everything here is PURE — no I/O, no clock reads (callers pass `nowMs`).
 *  The impure halves live server-side: the suggestion store
 *  (`delegation-suggestion-store.ts` — UNIQUE-key upsert over
 *  `contract.delegation_rule_suggestion.<key_hash>`) and the housekeeping
 *  learner task (`delegation-rule-suggestion-scan.ts`). N.9.8: counting never
 *  touches the gate hot path — the matcher / resolver / consume paths import
 *  nothing from this module.
 *
 *  Spec: D-177 § N.13; landing order P6b. */

import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import { sha256Hex } from '@recued/crypto/hash';

import type { RiskTier } from './ingredient.js';
import type { ContractDefinition, ContractScope } from './contract-definition.js';
import { DELEGATION_RULE_RISK_TIERS, DELEGATION_RULE_TTL_MS } from './session-grant.js';
import { isWellFormedOpenProjection } from './open-projection.js';

/** The housekeeping task id of the P6b learner (the registry primary key in
 *  `housekeeping_state`). Mirrors `CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID` —
 *  the scan-task constant lives beside the vocabulary it aggregates. */
export const DELEGATION_RULE_SUGGESTION_SCAN_TASK_ID =
  'delegation-rule-suggestion-scan' as const;

/** The `composite_keys` scope a suggestion row is keyed under (a row lives at
 *  `contract.delegation_rule_suggestion.<key_hash>`). The store's `put` IS the
 *  N.13 UNIQUE-key upsert. Defined here (beside the row shape) per the
 *  `CONTRACT_DEFINITION_SCOPE` convention. */
export const DELEGATION_RULE_SUGGESTION_SCOPE = 'delegation_rule_suggestion';

/** N.13 — session-grant rows on a key before a suggestion fires (the D-132
 *  `MANUAL_RUN_THRESHOLD` precedent). Doubles as the distinct-session floor:
 *  the rows must span at least this many DISTINCT `channel_session_id`s
 *  (cross-session repetition is precisely the pain a standing rule removes —
 *  within-session repeats are already absorbed by the session grant). */
export const DELEGATION_SUGGEST_THRESHOLD = 3;

/** N.13 — the learner's evidence lookback window (30 d). Rows minted before
 *  `nowMs - LOOKBACK` are stale evidence and don't count toward the threshold
 *  (revocation suppression deliberately ignores this window — distrust is
 *  durable). Equals `DELEGATION_RULE_TTL_MS` (P6c) BY DESIGN — defined as it,
 *  so the alignment can't drift: while a minted rule lives, its key raises no
 *  asks → no fresh session grants accumulate — so by natural rule expiry the
 *  pre-mint evidence has aged out and a re-suggestion needs genuinely fresh
 *  repeats. */
export const DELEGATION_SUGGEST_LOOKBACK_MS = DELEGATION_RULE_TTL_MS;

/** Evidence cap — newest-first sample of the contributing session-grant
 *  `contract_id`s stored on the suggestion row (the P6c card's "see the
 *  approvals behind this" affordance reads these; the full set is always
 *  re-derivable from the durable session rows). */
export const DELEGATION_SUGGEST_SAMPLE_CONTRACT_IDS_MAX = 5;

/** D-177 N.13 — the aggregation key a suggestion fires for. One field per
 *  authority-bearing clause of the N.4/N.13 match predicate — two session
 *  rows share a key iff the delegation rule minted from either would admit
 *  exactly the dispatches the other admitted. `risk_tier` and `entity_scope`
 *  are IN the key (P6a codex HIGH fold): both are authority-bearing at the
 *  matcher (pinned-tier equality; both-absent-or-equal entity), so
 *  aggregating across them could reach the threshold on mixed-authority
 *  votes and mint a snapshot broader than any single repeated grant.
 *
 *  Per-mode identity (N.9.6 same-mode-as-granted): exact grants repeating
 *  the SAME `canonical_payload_hash` key together; open grants repeating the
 *  SAME `pinned_projection_hash` key together. Exact grants with VARYING
 *  payloads over a shared shape land on DIFFERENT keys and so suggest
 *  nothing — inferring a pattern from variation is exactly what the learner
 *  must not do. */
export interface DelegationRuleSuggestionKey {
  readonly channel: string;
  readonly actor: string;
  /** D-177 N.14 — the door binding, present exactly when the evidence rows
   *  are door session grants (`anonymous` + `bound_contract_id`). IN the
   *  key: evidence never pools across doors (aggregating two doors' rows
   *  could reach the threshold on approvals no single door earned), and the
   *  minted rule carries the same binding the matcher requires. */
  readonly bound_contract_id?: string;
  readonly ingredient_id: string;
  /** Bound exactly when the granted dispatch carried a trusted operation
   *  key — absent on simple-form grants (both-absent-or-equal). */
  readonly operation_id?: string;
  /** Bound exactly when the granted dispatch resolved a connection. */
  readonly connection_name?: string;
  readonly recipe_id: string;
  readonly recipe_hash: string;
  readonly arg_shape_hash: string;
  /** Always within {@link DELEGATION_RULE_RISK_TIERS} — a session grant at a
   *  tier the rule vocabulary can't mint (e.g. `admin`) derives NO key. */
  readonly risk_tier: RiskTier;
  readonly entity_scope?: string;
  /** `'exact' | 'open'` only — `'batch'` is session-bound by construction
   *  (one approval's enumeration) and never suggests. */
  readonly grant_mode: 'exact' | 'open';
  /** `'exact'` mode — the one repeated payload hash. */
  readonly canonical_payload_hash?: string;
  /** `'open'` mode — the one repeated pinned-projection hash. */
  readonly pinned_projection_hash?: string;
}

/** The envelope SNAPSHOT a suggestion stores — the would-be rule, verbatim
 *  (N.13: "Accept mints from the stored snapshot — what the card showed").
 *  Exactly the {@link DelegationRuleSuggestionKey} plus the `'open'` arm's
 *  stored projection structure (the P6c mint persists it on the rule row for
 *  the N.4 well-formedness check + the inspector). */
export interface DelegationRuleSuggestionSnapshot extends DelegationRuleSuggestionKey {
  /** `'open'` mode — the N.11 rule-6 projection of the rows the key
   *  aggregates (identical across the group: the projection's canonical hash
   *  IS the key's `pinned_projection_hash`). */
  readonly open_projection?: unknown;
}

/** The evidence block recomputed onto the suggestion row each time the
 *  learner re-evaluates the key (N.13: count, distinct sessions, consumed
 *  uses, sample `contract_id`s, first/last `minted_at`). Describes the
 *  QUALIFYING rows — lookback-windowed, ≥ 1 consumed use each. */
export interface DelegationRuleSuggestionEvidence {
  readonly row_count: number;
  readonly distinct_session_count: number;
  /** Total uses consumed across the qualifying rows
   *  (Σ `max_uses - uses_remaining`). */
  readonly consumed_uses: number;
  /** Newest-first, capped at
   *  {@link DELEGATION_SUGGEST_SAMPLE_CONTRACT_IDS_MAX}. */
  readonly sample_contract_ids: ReadonlyArray<string>;
  readonly first_minted_at: number;
  readonly last_minted_at: number;
  /** D-177 N.14.8 fork 3 (owner: "surface") — how many items the owner REJECTED
   *  on this door over the SAME lookback window the counts above use. Present
   *  only on door-bound keys (a `user_self` key has no D-173 inbox and so no
   *  rejects); absent ⇒ not counted, which is NOT the same as zero.
   *
   *  🔑 WHY IT EXISTS: without it the card asserts "you approved these
   *  repeatedly" while silently omitting that the owner may have refused far
   *  more — and a standing rule runs WITHOUT review, so a 3-approval /
   *  20-rejection key is exactly where automating is most wrong and the card
   *  was quietest. This is the counter-evidence, shown so the human can judge.
   *  ⛔ It is EVIDENCE, never a gate: nothing may suppress a suggestion on it
   *  (owner-ruled — see the reject-stamp comment in `reception-inbox-handler`).
   *  ⚠ Joined at READ time, not frozen into the stored row: rejects since the
   *  last learner scan must count, or the sentence goes stale between sweeps. */
  readonly door_rejected_count?: number;
  /** The newest reject counted by {@link door_rejected_count}. */
  readonly door_last_rejected_at?: number;
}

/** Suggestion lifecycle (the D-132 promotion-banner shape). `'open'` rows are
 *  recomputed idempotently by the learner; `'dismissed'` is per-key PERMANENT
 *  (N.13 — `recipe_hash` in the key re-arms naturally on recipe update, which
 *  derives a fresh key); `'accepted'` marks the P6c mint and is likewise
 *  never re-opened by the learner (re-surfacing after the minted rule's
 *  natural expiry is the P6c surface's call, not background learning's). */
export type DelegationRuleSuggestionState = 'open' | 'accepted' | 'dismissed';

/** One suggestion row, keyed by `key_hash` at
 *  `contract.delegation_rule_suggestion.<key_hash>` (value_shape
 *  `delegation_rule_suggestion`, `contract-schema.ts`). Never serialized into
 *  model-visible context, tool results, or the chat catalog (N.9.1) — the row
 *  surfaces ONLY on the owner's D-174 `#contracts` panel via the P6c rpc. */
export interface DelegationRuleSuggestionRow {
  readonly key_hash: string;
  readonly state: DelegationRuleSuggestionState;
  readonly snapshot: DelegationRuleSuggestionSnapshot;
  readonly evidence: DelegationRuleSuggestionEvidence;
  /** Epoch-ms the suggestion first fired (stable across recomputes). */
  readonly created_at: number;
  /** Epoch-ms of the last recompute that CHANGED the row. */
  readonly updated_at: number;
}

/** A non-empty string — the same runtime-defensive JSON-row gate the N.4
 *  matcher uses (rows are JSON; a hand-authored row could carry anything). */
const nonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

/** A scope axis that names exactly ONE value — the only shape the N.5/N.13
 *  mints produce (`channels: [ctx.channel]`, …). A multi-valued or empty axis
 *  cannot be keyed faithfully (which value did the human approve?) and a
 *  wildcard axis is never grant-legal — fail closed to "derives no key". */
const singleValue = (axis: ReadonlyArray<string> | undefined): string | undefined =>
  axis !== undefined && axis.length === 1 && nonEmptyString(axis[0])
    ? axis[0]
    : undefined;

/** An OPTIONAL scope axis: absent ⇒ unbound (a legal grant shape — the
 *  envelope carried no operation/connection), single-valued ⇒ that value,
 *  anything else ⇒ underivable. The three-way split needs a sentinel beyond
 *  `undefined`, hence the tagged return. */
const optionalSingleValue = (
  axis: ReadonlyArray<string> | undefined,
): { ok: true; value: string | undefined } | { ok: false } => {
  if (axis === undefined || axis.length === 0) return { ok: true, value: undefined };
  if (axis.length === 1 && nonEmptyString(axis[0])) {
    return { ok: true, value: axis[0] };
  }
  return { ok: false };
};

/** Derive the N.13 key (+ snapshot) a gate-grant row embodies, or `undefined`
 *  when the row cannot faithfully produce one — fail closed on every clause,
 *  mirroring the matcher's posture (a row the learner can't key must simply
 *  not count; it must never count under a broader key).
 *
 *  Accepts BOTH gate-grant kinds, with the per-kind binding invariant
 *  enforced: a `'session'` row (the learner's SIGNAL) must carry its session
 *  binding; a `'delegation'` row (the learner's SUPPRESSION join — an
 *  existing rule occupies/poisons its key) must NOT. Standing rows and
 *  unknown future `grant_kind` vocabulary derive nothing.
 *
 *  Underivable shapes (each ⇒ `undefined`):
 *  - `grant_mode` not the EXPLICIT `'exact'`/`'open'` literal (`'batch'` is
 *    one approval's enumeration — inherently session-bound, never a rule;
 *    unknown modes fail closed; ABSENT fails closed too, codex MEDIUM fold —
 *    the mints stamp the mode explicitly, so an unstamped row is
 *    malformed/hand-shaped. Deliberately STRICTER than the matcher's
 *    absent⇒exact tolerance: the matcher honors a row's real authority at
 *    dispatch; the learner requires the full explicit stamp before counting
 *    it as evidence toward standing authority),
 *  - any scope axis not exactly single-valued (channel / actor / ingredient
 *    REQUIRED single; operation / connection absent-or-single),
 *  - missing/partial `bound_recipe` or empty `arg_shape_hash`,
 *  - `risk_tier` outside {@link DELEGATION_RULE_RISK_TIERS} (fork 2 — the
 *    would-be rule wouldn't be mintable: an `admin` session grant never
 *    suggests; the P6c mint re-validates the same ceiling),
 *  - missing per-mode identity (`canonical_payload_hash` for exact;
 *    `pinned_projection_hash` + a WELL-FORMED `open_projection` for open —
 *    a malformed projection would mint an inert rule, N.4 rule 6). */
export const deriveDelegationRuleSuggestionKey = (
  grant: ContractDefinition,
): DelegationRuleSuggestionSnapshot | undefined => {
  if (grant.grant_kind === 'session') {
    // The session binding is the signal's provenance (the distinct-session
    // floor counts it) — a session row missing it is malformed and inert at
    // the matcher; it must not count as evidence either.
    if (!nonEmptyString(grant.channel_session_id)) return undefined;
  } else if (grant.grant_kind === 'delegation') {
    // N.13 — scope REPLACES the session binding on a rule; a delegation row
    // carrying one is malformed (the matcher refuses it) → no key.
    if (grant.channel_session_id !== undefined && grant.channel_session_id !== null) {
      return undefined;
    }
  } else {
    // Standing rows + unknown future vocabulary — never keyed.
    return undefined;
  }

  // EXPLICIT mode literal only (codex MEDIUM fold) — no absent⇒exact default
  // here: `grant_mode` is an authority-bearing KEY field and the mints stamp
  // it on every row, so absence marks a malformed/hand-shaped row that must
  // not contribute evidence (fail closed, per the module's posture).
  const mode = grant.grant_mode;
  if (mode !== 'exact' && mode !== 'open') return undefined;

  const channel = singleValue(grant.scope.channels);
  const actor = singleValue(grant.scope.actors);
  const ingredient_id = singleValue(grant.scope.ingredient_ids);
  if (channel === undefined || actor === undefined || ingredient_id === undefined) {
    return undefined;
  }
  // TWO LEARNABLE FAMILIES, each bound tighter than scope alone (N.14
  // extends the 2026-06-22 owner-only pin — whose rationale was precisely
  // the MISSING contract dimension — with the dimension that dissolves it):
  //
  //  - the OWNER (`user_self`) — the original N.13 signal. NO door binding:
  //    a `user_self` row carrying one is malformed/hand-shaped → no key.
  //  - a DOOR row (`anonymous` + the N.14 `bound_contract_id` + the
  //    `reception` channel) — the owner's repeated D-173 inbox answers on
  //    ONE door. The binding is IN the key (evidence never pools across
  //    doors) and rides onto the minted rule, which the matcher's
  //    asymmetric door clause then binds to exactly that door.
  //
  // Everything else stays unlearnable. In particular `contracted_user` —
  // every mcp door, INCLUDING the owner's own raw-MCP bearer (see
  // `buildMcpExecutionSource`): those grants carry no binding today, so a
  // learned rule would be scope-bound only and match EVERY door sharing
  // channel × actor × ingredient × op — auto-widening door access by
  // habituation. Applies to BOTH the session signal AND the delegation
  // suppression join, so an unbindable door rule is never keyed.
  const boundContractId = grant.bound_contract_id ?? undefined;
  if (actor === 'user_self') {
    if (boundContractId !== undefined) return undefined;
  } else if (actor === 'anonymous') {
    if (!nonEmptyString(boundContractId)) return undefined;
    if (channel !== 'reception') return undefined;
  } else {
    return undefined;
  }
  const operation = optionalSingleValue(grant.scope.operation_ids);
  const connection = optionalSingleValue(grant.scope.connection_names);
  if (!operation.ok || !connection.ok) return undefined;

  if (
    grant.bound_recipe === undefined
    || grant.bound_recipe === null
    || !nonEmptyString(grant.bound_recipe.recipe_id)
    || !nonEmptyString(grant.bound_recipe.recipe_hash)
  ) {
    return undefined;
  }
  if (!nonEmptyString(grant.arg_shape_hash)) return undefined;
  if (
    !nonEmptyString(grant.risk_tier)
    || !(DELEGATION_RULE_RISK_TIERS as readonly string[]).includes(grant.risk_tier)
  ) {
    return undefined;
  }

  const base = {
    channel,
    actor,
    ...(boundContractId !== undefined
      ? { bound_contract_id: boundContractId }
      : {}),
    ingredient_id,
    ...(operation.value !== undefined ? { operation_id: operation.value } : {}),
    ...(connection.value !== undefined ? { connection_name: connection.value } : {}),
    recipe_id: grant.bound_recipe.recipe_id,
    recipe_hash: grant.bound_recipe.recipe_hash,
    arg_shape_hash: grant.arg_shape_hash,
    risk_tier: grant.risk_tier,
    ...(grant.entity_scope !== undefined && grant.entity_scope !== null
      ? { entity_scope: grant.entity_scope }
      : {}),
  };

  if (mode === 'exact') {
    if (!nonEmptyString(grant.canonical_payload_hash)) return undefined;
    return {
      ...base,
      grant_mode: 'exact',
      canonical_payload_hash: grant.canonical_payload_hash,
    };
  }
  // mode === 'open'
  if (!nonEmptyString(grant.pinned_projection_hash)) return undefined;
  if (!isWellFormedOpenProjection(grant.open_projection)) return undefined;
  return {
    ...base,
    grant_mode: 'open',
    pinned_projection_hash: grant.pinned_projection_hash,
    open_projection: grant.open_projection,
  };
};

/** The canonical key hash — the suggestion row's storage segment + UNIQUE
 *  upsert identity. Hashes the KEY fields only (canonical JSON: sorted keys,
 *  absent optionals omitted — two rows whose optionals are absent vs present
 *  hash differently, which is correct: both-absent-or-equal is the matcher's
 *  clause). The snapshot's `open_projection` is deliberately NOT hashed — its
 *  canonical identity is already pinned by `pinned_projection_hash`. */
export const delegationRuleSuggestionKeyHash = (
  key: DelegationRuleSuggestionKey,
): string =>
  sha256Hex(
    canonicalJSONStringify({
      channel: key.channel,
      actor: key.actor,
      ...(key.bound_contract_id !== undefined
        ? { bound_contract_id: key.bound_contract_id }
        : {}),
      ingredient_id: key.ingredient_id,
      ...(key.operation_id !== undefined ? { operation_id: key.operation_id } : {}),
      ...(key.connection_name !== undefined
        ? { connection_name: key.connection_name }
        : {}),
      recipe_id: key.recipe_id,
      recipe_hash: key.recipe_hash,
      arg_shape_hash: key.arg_shape_hash,
      risk_tier: key.risk_tier,
      ...(key.entity_scope !== undefined ? { entity_scope: key.entity_scope } : {}),
      grant_mode: key.grant_mode,
      ...(key.canonical_payload_hash !== undefined
        ? { canonical_payload_hash: key.canonical_payload_hash }
        : {}),
      ...(key.pinned_projection_hash !== undefined
        ? { pinned_projection_hash: key.pinned_projection_hash }
        : {}),
    }),
  );

/** A row's consumed-use count, or 0 for any shape the bounded-by-construction
 *  mint + the clamped consume/recordUse paths cannot produce — non-integer
 *  bounds, `max_uses < 1`, `uses_remaining` negative or above `max_uses`
 *  (codex MEDIUM fold: a hand-shaped `uses_remaining: -1` row must prove
 *  NOTHING, not read as consumed — malformed evidence is no evidence). */
const consumedUses = (row: ContractDefinition): number => {
  const max = row.max_uses;
  const remaining = row.uses_remaining;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) return 0;
  if (typeof remaining !== 'number' || !Number.isInteger(remaining)) return 0;
  if (remaining < 0 || remaining > max) return 0;
  return max - remaining;
};

/** Evaluate one key group — every `grant_kind: 'session'` row deriving the
 *  same key hash — against the N.13 threshold at `nowMs`. Pure; the caller
 *  (the learner) supplies the group and separately joins the delegation-rule
 *  suppression (an existing rule on the key — revoked ⇒ durable distrust,
 *  live ⇒ already operating; both suppress) and the suggestion-row state
 *  machine (dismissed/accepted rows are never re-opened).
 *
 *  Disqualifies (`qualifies: false`) when:
 *  - ANY row in the group is revoked — regardless of window or consumption:
 *    revocation is durable distrust, fail closed (N.13),
 *  - fewer than {@link DELEGATION_SUGGEST_THRESHOLD} QUALIFYING rows — minted
 *    within {@link DELEGATION_SUGGEST_LOOKBACK_MS} of `nowMs` AND ≥ 1
 *    consumed use each (`uses_remaining < max_uses` — the proof a repeat
 *    dispatch actually rode the grant),
 *  - the qualifying rows span fewer than the threshold's DISTINCT
 *    `channel_session_id`s.
 *
 *  On qualification, `evidence` describes exactly the qualifying rows. */
export const evaluateDelegationRuleSuggestionGroup = (
  rows: ReadonlyArray<ContractDefinition>,
  nowMs: number,
):
  | { qualifies: true; evidence: DelegationRuleSuggestionEvidence }
  | { qualifies: false } => {
  // Revocation poisons the KEY, not just the row (N.13 fail-closed): the
  // human reached for the kill switch on this exact bounded action once —
  // background learning must never re-suggest it.
  if (rows.some((r) => r.revoked_at !== undefined && r.revoked_at !== null)) {
    return { qualifies: false };
  }

  const windowStart = nowMs - DELEGATION_SUGGEST_LOOKBACK_MS;
  const qualifying = rows.filter(
    (r) => r.minted_at >= windowStart && r.minted_at <= nowMs && consumedUses(r) >= 1,
  );
  if (qualifying.length < DELEGATION_SUGGEST_THRESHOLD) return { qualifies: false };

  const sessions = new Set<string>();
  for (const r of qualifying) {
    if (nonEmptyString(r.channel_session_id)) sessions.add(r.channel_session_id);
  }
  // D-177 N.14 — DOOR keys count ROWS, not sessions. Every fire on a
  // reception door shares the door's ONE stable `channel_session_id`
  // (`reception:<reception_id>` — the runner sets no visitor_id), so the
  // distinct-session floor is unsatisfiable there BY CONSTRUCTION — and
  // unnecessary: each door row is one deliberate owner answer in the D-173
  // inbox (grants only mint on `allow_session`), so the row-count threshold
  // above already counts distinct human decisions. Owner keys keep the
  // cross-session floor verbatim (within-session repeats are absorbed by
  // the grant itself; the rule exists for CROSS-session pain). Group
  // homogeneity holds by key construction (the binding is IN the key); the
  // `every` is belt-and-suspenders — a mixed group falls to the stricter
  // owner floor.
  const doorBound = qualifying.every((r) => nonEmptyString(r.bound_contract_id));
  if (!doorBound && sessions.size < DELEGATION_SUGGEST_THRESHOLD) {
    return { qualifies: false };
  }

  const byMintedDesc = [...qualifying].sort((a, b) => {
    if (a.minted_at !== b.minted_at) return b.minted_at - a.minted_at;
    if (a.contract_id < b.contract_id) return -1;
    if (a.contract_id > b.contract_id) return 1;
    return 0;
  });
  return {
    qualifies: true,
    evidence: {
      row_count: qualifying.length,
      distinct_session_count: sessions.size,
      consumed_uses: qualifying.reduce((sum, r) => sum + consumedUses(r), 0),
      sample_contract_ids: byMintedDesc
        .slice(0, DELEGATION_SUGGEST_SAMPLE_CONTRACT_IDS_MAX)
        .map((r) => r.contract_id),
      first_minted_at: byMintedDesc[byMintedDesc.length - 1].minted_at,
      last_minted_at: byMintedDesc[0].minted_at,
    },
  };
};

/** D-177 N.13 (P6c) — the rule fields a stored snapshot projects into the
 *  accept-mint, or `undefined` when the snapshot cannot faithfully mint
 *  (fail closed on every clause, the module's posture throughout). The
 *  learner only writes snapshots `deriveDelegationRuleSuggestionKey`
 *  produced, but a suggestion row is JSON at rest — a hand-shaped row passes
 *  the value_shape's STRUCTURAL gate while carrying e.g. an `admin` tier
 *  (the shape keeps the full tier enum), so the mint path re-validates the
 *  same vocabulary the matcher pins rather than trusting storage:
 *
 *  - every required axis a non-empty string (channel / actor / ingredient /
 *    recipe identity / `arg_shape_hash`),
 *  - `risk_tier` ∈ {@link DELEGATION_RULE_RISK_TIERS} (N.13: "the P6c mint
 *    additionally re-validates the snapshot's tier"),
 *  - per-mode identity: `'exact'` ⇒ non-empty `canonical_payload_hash`;
 *    `'open'` ⇒ non-empty `pinned_projection_hash` + a WELL-FORMED
 *    `open_projection` (a malformed projection would mint an inert rule,
 *    N.4 rule 6); any other / absent mode ⇒ underivable.
 *
 *  The returned scope binds exactly the axes the human's repeated approvals
 *  carried — single-valued by snapshot construction, never widened here. */
export const delegationRuleMintPlanFromSnapshot = (
  snapshot: DelegationRuleSuggestionSnapshot,
):
  | {
      scope: ContractScope;
      grant_mode: 'exact' | 'open';
      recipe_id: string;
      recipe_hash: string;
      arg_shape_hash: string;
      risk_tier: RiskTier;
      canonical_payload_hash?: string;
      pinned_projection_hash?: string;
      open_projection?: unknown;
      entity_scope?: string;
      /** D-177 N.14 — carried onto the minted rule; the matcher's
       *  asymmetric door clause binds on it. */
      bound_contract_id?: string;
    }
  | undefined => {
  if (
    !nonEmptyString(snapshot.channel)
    || !nonEmptyString(snapshot.actor)
    || !nonEmptyString(snapshot.ingredient_id)
    || !nonEmptyString(snapshot.recipe_id)
    || !nonEmptyString(snapshot.recipe_hash)
    || !nonEmptyString(snapshot.arg_shape_hash)
  ) {
    return undefined;
  }
  // TWO MINTABLE FAMILIES — defense in depth mirroring the key derivation
  // (a suggestion row is JSON at rest; a hand-shaped row must not mint what
  // the learner would never key). `user_self` = the original owner rule, NO
  // binding; `anonymous` = an N.14 DOOR rule, which REQUIRES the binding +
  // the reception channel (the matcher's asymmetric clause makes an unbound
  // anonymous rule unmatchable, and an unbindable actor — `contracted_user`,
  // every mcp door — would mint a rule matching EVERY door sharing its
  // scope: the privilege-creep this gate prevents).
  const snapshotBinding = snapshot.bound_contract_id ?? undefined;
  if (snapshot.actor === 'user_self') {
    if (snapshotBinding !== undefined) return undefined;
  } else if (snapshot.actor === 'anonymous') {
    if (!nonEmptyString(snapshotBinding)) return undefined;
    if (snapshot.channel !== 'reception') return undefined;
  } else {
    return undefined;
  }
  // Optional axes: absent ⇒ unbound (a legal grant shape); present must be a
  // real value — an empty string would bind a nonsense axis.
  if (snapshot.operation_id !== undefined && !nonEmptyString(snapshot.operation_id)) {
    return undefined;
  }
  if (
    snapshot.connection_name !== undefined
    && !nonEmptyString(snapshot.connection_name)
  ) {
    return undefined;
  }
  if (snapshot.entity_scope !== undefined && !nonEmptyString(snapshot.entity_scope)) {
    return undefined;
  }
  if (
    !nonEmptyString(snapshot.risk_tier)
    || !(DELEGATION_RULE_RISK_TIERS as readonly string[]).includes(snapshot.risk_tier)
  ) {
    return undefined;
  }

  const scope: ContractScope = {
    channels: [snapshot.channel],
    actors: [snapshot.actor],
    ingredient_ids: [snapshot.ingredient_id],
    ...(snapshot.operation_id !== undefined
      ? { operation_ids: [snapshot.operation_id] }
      : {}),
    ...(snapshot.connection_name !== undefined
      ? { connection_names: [snapshot.connection_name] }
      : {}),
  };
  const base = {
    scope,
    recipe_id: snapshot.recipe_id,
    recipe_hash: snapshot.recipe_hash,
    arg_shape_hash: snapshot.arg_shape_hash,
    risk_tier: snapshot.risk_tier,
    ...(snapshot.entity_scope !== undefined
      ? { entity_scope: snapshot.entity_scope }
      : {}),
    ...(snapshotBinding !== undefined
      ? { bound_contract_id: snapshotBinding }
      : {}),
  };

  if (snapshot.grant_mode === 'exact') {
    if (!nonEmptyString(snapshot.canonical_payload_hash)) return undefined;
    return {
      ...base,
      grant_mode: 'exact',
      canonical_payload_hash: snapshot.canonical_payload_hash,
    };
  }
  if (snapshot.grant_mode === 'open') {
    if (!nonEmptyString(snapshot.pinned_projection_hash)) return undefined;
    if (!isWellFormedOpenProjection(snapshot.open_projection)) return undefined;
    return {
      ...base,
      grant_mode: 'open',
      pinned_projection_hash: snapshot.pinned_projection_hash,
      open_projection: snapshot.open_projection,
    };
  }
  // Unknown / absent mode on a JSON row — never mintable (same explicit-
  // literal posture as the key derivation above).
  return undefined;
};
