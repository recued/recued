/** D-166 — the `contract.contract_definition`-backed contract-lifecycle store
 *  (LOCAL-ONLY): mint / record-use / revoke over the one self-describing contract
 *  store. This is the IMPURE layer (it needs a clock + id-gen) atop the pure
 *  `contract-definition.ts` predicates (`contractLifecycleState` /
 *  `isContractActive` / `contractScopeMatches`) — D-148's policy matrix referenced
 *  `contract_id` values; D-166 mints them here.
 *
 *  A contract is keyed by a single `contract_id` (`contract-schema.ts`
 *  `contract_definition` composite_key, merge_rule `override` — exactly one row per
 *  contract_id, no composition). The row carries the contract's scope, immutable
 *  `minted_at` / `minted_by` provenance, and the optional `expiry_at` / `max_uses`
 *  / `uses_remaining` / `revoked_at` fields the use-resolution slice gates on:
 *
 *  - **Mint** — a fresh `contract_id`, `minted_at = now()`, the caller's
 *    `minted_by` / `display_name` / `scope`, and any of `approved_actions_template`
 *    / `expiry_at` / `max_uses`. A `max_uses` seeds `uses_remaining = max_uses`.
 *  - **Use** — `recordUse` decrements `uses_remaining` by one on a BOUNDED contract
 *    (unbounded ⇒ unmetered no-op). The active-check is the CALLER's job: the
 *    use-resolution slice applies the contract overlay only when
 *    `isContractActive(now)`, then records the use; `recordUse` is a dumb counter
 *    primitive (it does not re-read the clock).
 *  - **Expire** — PASSIVE, not a write op: `contractLifecycleState` reports
 *    `expired` once `expiry_at < now` and `exhausted` once `uses_remaining <= 0`.
 *    There is nothing to persist, so this store has no `expire` method.
 *  - **Revoke** — stamps `revoked_at = now()` + `revocation_reason`. Idempotent:
 *    a re-revoke preserves the FIRST revocation's provenance (a revoked contract
 *    is already inert).
 *
 *  The write goes through `ContractStore.put`, so every minted / mutated row is
 *  validated against the `contract_definition` value_shape (incl. the nested
 *  `contract_scope`); the `override` merge_rule runs no tightening check. Inert at
 *  gateway dispatch by construction — `contract_lifecycle` is an INVENTORY-style
 *  role (dispatch returns the row, it is not policy-merged), so these rows back the
 *  use-resolution active-check + the (later) Settings → Privacy → Contracts rpc,
 *  not a `composeForRole` lattice.
 *
 *  Local-only — the contract store never syncs cloud (D-090/D-097/D-168).
 *
 *  Spec: D-166 §"contract_definition (new — contract_id lifecycle)". */

import { randomUUID } from 'node:crypto';

import {
  CONTRACT_DEFINITION_SCOPE,
  DELEGATION_RULE_MAX_USES,
  DELEGATION_RULE_RISK_TIERS,
  DELEGATION_RULE_TTL_MS,
  SCOPED_GRANT_MAX_USES_CEILING,
  SCOPED_GRANT_SOURCES,
  SCOPED_GRANT_TTL_MS_CEILING,
  SESSION_GRANT_RISK_TIERS,
  isContractActive,
  isReservedOwnerContractId,
  isReservedPublicContractId,
  isStandingContractDefinition,
  isWellFormedOpenProjection,
  rolledContractUses,
  usageCapWindowStart,
  scopedContainmentAdmits,
  type BoundRecipeRef,
  type ContractDefinition,
  type DoorExecutionPolicy,
  type ContractScope,
  type DoorType,
  type RiskTier,
  type ScopedGrantSource,
  type UsageCapPeriod,
  type SessionGrantBatchMember,
  type ScopedSenderCandidate,
} from '@recued/contracts';

import type { ContractStore } from './contract-store.js';

/** Caller-supplied fields for {@link ContractDefinitionStore.mint}. `contract_id`
 *  and `minted_at` are generated/stamped by the store; everything else is the
 *  user's. `max_uses`, when set, seeds the initial `uses_remaining`. */
export interface MintContractInput {
  /** Who minted the contract — provenance (e.g. a user id). Immutable once set. */
  minted_by: string;
  /** Human-facing label for the owner Contracts row. */
  display_name: string;
  /** D-196 R3 — the generic owner authoring path may mint a customer template,
   * but never a customer instance or a gate-consumed grant. Omit for standing. */
  grant_kind?: 'customer_template';
  /** The `(channels × actors × ingredient_ids × operation_ids × connection_names)`
   *  surface the contract authorizes. An empty/absent axis is a wildcard. */
  scope: ContractScope;
  /** Server-derived per-run limits for a door. Not exposed by the generic owner mint RPC. */
  door_execution_policy?: DoorExecutionPolicy;
  /** D-187 §6 (step 7) — the level-1 door types this contract may back
   *  (`'mcp'` / `'mcp_chat'`). Omit or `[]` = wildcard (any door type — the
   *  behaviour-preserving default); a non-empty list restricts the contract to
   *  the named door types (the HTTP MCP transport's connection-establishment gate
   *  rejects others). */
  door_types?: ReadonlyArray<DoorType>;
  /** D-209 #1 — the door's authored stage-trust ceiling (see
   *  `ContractDefinition.max_risk_without_approval`). Written by DERIVED door
   *  mints only (today: the webhook door's `'admin'`); omit everywhere else —
   *  absent is the contracted LOW default at the reader. */
  max_risk_without_approval?: 'read' | 'write' | 'admin' | 'none';
  /** Pre-authorized actions that bypass per-call approval (opaque to this store —
   *  the use-resolution slice interprets it). Omit for none. */
  approved_actions_template?: unknown;
  /** Epoch-ms after which the contract time-expires. Omit for never. */
  expiry_at?: number;
  /** Total dispatches the contract permits — seeds `uses_remaining`. Omit for
   *  unlimited (the contract is never use-exhausted). */
  max_uses?: number;
  /** How often `max_uses` refills. Omit for `'total'` — one budget, never
   *  refilled, which is what every contract minted before this field meant. */
  use_period?: UsageCapPeriod;
}

/** D-177 P2 — caller-supplied fields for
 *  {@link ContractDefinitionStore.mintSessionGrant}. The store stamps
 *  `contract_id` / `minted_at` / `grant_kind: 'session'` / the explicit
 *  `grant_mode`; everything else is the approval layer's (N.5 — session rows
 *  are minted ONLY by the approval layer from a human answer, never from
 *  caller/channel/model input).
 *
 *  The three session bindings the N.4 common predicate requires
 *  (`channel_session_id` / `bound_recipe` / `arg_shape_hash`) are REQUIRED
 *  here — the value_shape can't express conditional requirements, so the mint
 *  primitive is the enforcement point (a row missing them would be inert at
 *  the matcher anyway; refusing the mint surfaces the bug at its source). */
export interface MintSessionGrantInput {
  /** Provenance — who answered the ask (the owner; N.5). */
  minted_by: string;
  /** Human-facing label for the active-limits inspector row. */
  display_name: string;
  /** Binding scope. MUST explicitly name the granted ingredient in
   *  `ingredient_ids` (codex HIGH fold, N.3) — the mint throws otherwise;
   *  `operation_ids` / `connection_names` bind when the envelope carried
   *  them. */
  scope: ContractScope;
  /** The D-153 tier-1 channel session the grant is bound to (D6). */
  channel_session_id: string;
  /** Per-mode match rule (N.4). Omit for `'exact'` (the rev-5 default). */
  grant_mode?: 'exact' | 'batch' | 'open';
  /** The minting run's recipe identity — content drift invalidates (N.4). */
  bound_recipe: BoundRecipeRef;
  /** D-177 N.14 — the governing DOOR contract id when the minting dispatch
   *  came through a door (v1: reception). REQUIRED when `scope.actors`
   *  names `'anonymous'` (an unbound anonymous grant would be inert at the
   *  matcher's asymmetric door clause — refuse loudly instead); must be
   *  non-empty when present. */
  bound_contract_id?: string;
  /** The approved envelope's arg key-shape hash (N.4 common predicate). */
  arg_shape_hash: string;
  /** D-177 P3 (codex HIGH fold) — the approved risk tier, pinned on the row.
   *  REQUIRED, and must be session-grantable (`write` | `admin`): the
   *  matcher requires EQUALITY with the dispatching envelope's tier, so a
   *  grant minted for a `write` call can never absorb an `admin`-tier ask
   *  after a manifest/policy re-classification. */
  risk_tier: RiskTier;
  /** `'exact'` mode: the one approved payload hash. REQUIRED for exact. */
  canonical_payload_hash?: string;
  /** `'batch'` mode (N.10): the approved member set. REQUIRED for batch. */
  batch_members?: SessionGrantBatchMember[];
  /** `'open'` mode (N.11): the tainted-root pin hash. REQUIRED for open. */
  pinned_projection_hash?: string;
  /** `'open'` mode (N.11 rule 6): the provenance projection. REQUIRED for open. */
  open_projection?: unknown;
  /** Primary-entity binding when the minting op declared one. */
  entity_scope?: string;
  /** Checkpoint/audit anchor of the minting approval (D8). */
  approved_action_ref?: string;
  /** Epoch-ms expiry — `now + ttl_ms` from the owner cell defaults (N.5).
   *  REQUIRED (codex HIGH fold): every session grant is BOUNDED by
   *  construction — the N.11 confirm sentence's every clause ("for [TTL], up
   *  to [N] times") maps 1:1 onto an enforced bound, so an unbounded session
   *  grant must not be representable. Must be in the future at mint time. */
  expiry_at: number;
  /** Use budget from the cell defaults — seeds `uses_remaining`. REQUIRED
   *  (codex HIGH fold, same bounded-by-construction rule); ≥ 1. */
  max_uses: number;
}

/** D-177 P2 — a session-grant mint input that cannot produce a matchable,
 *  bounded grant: missing bindings, an unbound ingredient axis, or a mode
 *  missing its per-mode identity field. Thrown by `mintSessionGrant` so the
 *  approval layer's bug surfaces at the mint, not as a silently-inert row. */
export class SessionGrantMintError extends Error {
  constructor(detail: string) {
    super(`session_grant_mint_invalid: ${detail}`);
    this.name = 'SessionGrantMintError';
  }
}

/** D-177 N.13 (P6c) — caller-supplied fields for
 *  {@link ContractDefinitionStore.mintDelegationRule}. The store stamps
 *  `contract_id` / `minted_at` / `grant_kind: 'delegation'` and the EXPLICIT
 *  `grant_mode` (required here — P6b's suggestion-key derivation demands the
 *  explicit literal, so the minted rule can later derive its own key for
 *  suppression). There is deliberately NO `channel_session_id` field: scope
 *  REPLACES the session binding on a rule (N.13 delta 2) — the shape makes a
 *  session-bound delegation row unrepresentable at this seam.
 *
 *  `approved_action_ref` is REQUIRED (the suggestion `key_hash` anchor): it
 *  is both the audit back-pointer ("which suggestion did the human accept")
 *  and the accept rpc's at-least-once idempotence key (a retry finds the
 *  minted twin by it instead of minting again). */
export interface MintDelegationRuleInput {
  /** Provenance — who accepted the suggestion (the owner; N.9.7). */
  minted_by: string;
  /** Human-facing label for the contracts inspector row. */
  display_name: string;
  /** Binding scope — every axis the repeated approvals carried. MUST
   *  explicitly name the granted ingredient (N.3 applies to rules too). */
  scope: ContractScope;
  /** Per-mode match rule. EXPLICIT `'exact' | 'open'` only (N.13 delta 4 —
   *  `'batch'` is one approval's enumeration, inherently session-bound). */
  grant_mode: 'exact' | 'open';
  /** The suggesting grants' recipe identity — content drift re-asks (N.4). */
  bound_recipe: BoundRecipeRef;
  /** D-177 N.14 — the door binding. REQUIRED (non-empty, with channels
   *  `['reception']`) when `scope.actors` is `['anonymous']`; FORBIDDEN on
   *  an owner (`['user_self']`) rule. */
  bound_contract_id?: string;
  /** The repeated envelope's arg key-shape hash (N.4 common predicate). */
  arg_shape_hash: string;
  /** The repeated tier — must be within {@link DELEGATION_RULE_RISK_TIERS}
   *  (fork 2: `write` only in v1; `admin` delegation is never suggestion-
   *  minted). */
  risk_tier: RiskTier;
  /** `'exact'` mode: the one repeated payload hash. REQUIRED for exact. */
  canonical_payload_hash?: string;
  /** `'open'` mode: the one repeated pinned-projection hash. REQUIRED for
   *  open. */
  pinned_projection_hash?: string;
  /** `'open'` mode: the N.11 projection structure (the N.4 open arm's
   *  well-formedness gate reads it off the row). REQUIRED for open. */
  open_projection?: unknown;
  /** Primary-entity binding when the repeated grants carried one. */
  entity_scope?: string;
  /** The accepted suggestion's `key_hash` (D8-style anchor). REQUIRED. */
  approved_action_ref: string;
  /** Epoch-ms expiry. REQUIRED, future, and within
   *  {@link DELEGATION_RULE_TTL_MS} of mint time (fork 3 — tighten-only;
   *  a longer-lived rule is unrepresentable). */
  expiry_at: number;
  /** Use budget — seeds `uses_remaining`. REQUIRED; 1 ≤ n ≤
   *  {@link DELEGATION_RULE_MAX_USES} (fork 3 ceiling). */
  max_uses: number;
}

/** D-177 N.13 (P6c) — a delegation-rule mint input that cannot produce a
 *  matchable, bounded, vocabulary-legal rule. Thrown by `mintDelegationRule`
 *  so the accept layer's bug surfaces at the mint, not as a silently-inert
 *  (or worse, silently-broad) standing row. */
export class DelegationRuleMintError extends Error {
  constructor(detail: string) {
    super(`delegation_rule_mint_invalid: ${detail}`);
    this.name = 'DelegationRuleMintError';
  }
}

/** D-177 N.11 rule 5 (5.c, slice C) — caller-supplied fields for
 *  {@link ContractDefinitionStore.mintScopedSessionGrant}. The store stamps
 *  `contract_id` / `minted_at` / `grant_kind: 'session'` /
 *  `grant_mode: 'scoped'`. A scoped grant is UTTERANCE-derived (5.a): there
 *  is no minting dispatch, so the shape carries NO `bound_recipe` /
 *  `arg_shape_hash` / payload hash — its enforcement axes are the explicit
 *  op + connection binding, the session binding, TTL/`max_uses`, and the
 *  5.d structured-field containment the matcher + consume re-verify.
 *
 *  `approved_action_ref` is REQUIRED (the proposal `key_hash` anchor) — the
 *  accept rpc's at-least-once idempotence key + audit back-pointer, same
 *  posture as the delegation mint. */
export interface MintScopedSessionGrantInput {
  /** Provenance — who accepted the proposal (the owner; N.9.7). */
  minted_by: string;
  /** Human-facing label for the active-limits inspector row. */
  display_name: string;
  /** Binding scope. The INGREDIENT, OPERATION, and CONNECTION axes are all
   *  required non-empty — never wildcards for scoped rows (5.b/5.d; the
   *  matcher enforces the same row-side). */
  scope: ContractScope;
  /** The D-153 tier-1 channel session the grant is bound to (5.c —
   *  "in this chat"). */
  channel_session_id: string;
  /** The resolved catalog op's tier — must be session-grantable
   *  ({@link SESSION_GRANT_RISK_TIERS}). */
  risk_tier: RiskTier;
  /** The closed source enum (v1 exactly `'forwarded_item_sender'`, 5.b). */
  scoped_source: ScopedGrantSource;
  /** The accepted proposal's `key_hash` (D8-style anchor). REQUIRED. */
  approved_action_ref: string;
  /** Epoch-ms expiry. REQUIRED, future, and within
   *  `SCOPED_GRANT_TTL_MS_CEILING` of mint time (tighten-only). */
  expiry_at: number;
  /** Use budget — seeds `uses_remaining`. REQUIRED; 1 ≤ n ≤
   *  `SCOPED_GRANT_MAX_USES_CEILING`. */
  max_uses: number;
}

/** D-177 N.11 rule 5 (slice C) — a scoped-grant mint input that cannot
 *  produce a matchable, bounded grant. Same fail-loud posture as the other
 *  mint primitives. */
export class ScopedGrantMintError extends Error {
  constructor(detail: string) {
    super(`scoped_grant_mint_invalid: ${detail}`);
    this.name = 'ScopedGrantMintError';
  }
}

/** D-182 §8 — caller-supplied fields for
 *  {@link ContractDefinitionStore.mintRawOpGrant}. The store stamps
 *  `contract_id` / `minted_at` / `grant_kind: 'session'` /
 *  `grant_mode: 'raw_op'`. A raw-op grant is the recipe-less door grant: it is
 *  minted from a human's per-call approval of a door's raw catalog op
 *  (`allow_session` on a write-tier raw op), so — UNLIKE a `'scoped'` grant —
 *  there IS a minting dispatch and the shape carries the `arg_shape_hash` +
 *  exact `canonical_payload_hash` identity; but there is NO `bound_recipe`
 *  (a raw op has no recipe). Its enforcement axes are the explicit op
 *  (ingredient + operation) + connection binding, the session binding, the
 *  arg-shape + exact-payload identity, and TTL/`max_uses` — all of which the
 *  N.4 `'raw_op'` matcher arm + `consumeSessionGrant`'s raw-op re-verify
 *  enforce. Bounds come from the (`mcp`, `contracted_user`) cell's
 *  `session_grant_defaults` offer (no separate ceiling), as for
 *  `mintSessionGrant`. */
export interface MintRawOpGrantInput {
  /** Provenance — who approved the raw-op ask (the owner; N.5 — the owner is
   *  the only approver on the door's `mcp` surface). */
  minted_by: string;
  /** Human-facing label for the active-limits inspector row. */
  display_name: string;
  /** Binding scope. The INGREDIENT and OPERATION axes are required non-empty
   *  (a raw op IS an op over a catalog ingredient — never wildcards, the
   *  matcher enforces the same row-side). `connection_names` binds when the op
   *  resolves a connection (http / connection / mcp); the matcher requires it
   *  when the dispatch carries one, so omit it only for `ai` / `entity` ops. */
  scope: ContractScope;
  /** The D-153 tier-1 channel session the grant is bound to (D6). */
  channel_session_id: string;
  /** The resolved catalog op's tier — must be session-grantable
   *  ({@link SESSION_GRANT_RISK_TIERS}; reads never ask, `destructive` never
   *  grants). */
  risk_tier: RiskTier;
  /** The approved raw-op call's arg key-shape hash (N.4 common predicate). */
  arg_shape_hash: string;
  /** The approved raw-op call's exact payload hash (recipe-less exact, §8). */
  canonical_payload_hash: string;
  /** Primary-entity binding when the op declared one (matched both-absent-or-
   *  equal). Omit when none. */
  entity_scope?: string;
  /** Checkpoint/audit anchor of the minting approval (D8). REQUIRED. */
  approved_action_ref: string;
  /** Epoch-ms expiry — `now + ttl_ms` from the door cell defaults (N.5).
   *  REQUIRED, future: every session grant is BOUNDED by construction. */
  expiry_at: number;
  /** Use budget from the cell defaults — seeds `uses_remaining`. REQUIRED; ≥ 1. */
  max_uses: number;
  /** D-177 N.14.6 — the DOOR contract this grant belongs to. Present for a door's
   *  raw-op grant (the delegated mcp bearer), absent for the owner's own stdio
   *  client. Non-empty when present (the matcher treats an empty binding as
   *  malformed → inert); the matcher + `consumeSessionGrant` both require equality
   *  against it, so a row can never outlive a rebind of the token that minted it. */
  bound_contract_id?: string;
}

/** D-182 §8 — a raw-op grant mint input that cannot produce a matchable,
 *  bounded grant (empty bindings, an unbound ingredient/operation axis,
 *  missing payload identity, out-of-vocabulary tier). Same fail-loud posture
 *  as the other mint primitives. */
export class RawOpGrantMintError extends Error {
  constructor(detail: string) {
    super(`raw_op_grant_mint_invalid: ${detail}`);
    this.name = 'RawOpGrantMintError';
  }
}

/** D-202 — caller-supplied fields for
 *  {@link ContractDefinitionStore.mintQualityDelegation}. The store stamps
 *  `contract_id` / `minted_at` / `grant_kind: 'quality_delegation'`.
 *
 *  Deliberately MUCH narrower than {@link MintDelegationRuleInput}: the quality
 *  axis governs at the COARSE (recipe, op) grain (§5), so a quality delegation
 *  carries NO per-mode identity (`grant_mode` / `canonical_payload_hash` /
 *  `pinned_projection_hash`), NO `arg_shape_hash`, and NO `risk_tier` — the
 *  quality matcher (`matchesQualityDelegation`) reads none of them. It binds on
 *  recipe identity + the op scope only.
 *
 *  It is also STANDING by construction: unlike the authorization gate grants
 *  (bounded-by-construction with a required TTL + use budget), a quality
 *  delegation exists to STOP per-artifact review, so a use budget would defeat
 *  it. Its lifecycle is governed by the §3 invalidation ladder + the §4
 *  kill-switch, not a counter — hence NO `max_uses`, and `expiry_at` is OPTIONAL
 *  (an owner may set a self-expiring review cadence; absent ⇒ standing). */
export interface MintQualityDelegationInput {
  /** Provenance — who accepted the suggestion (the owner; owner-only mint). */
  minted_by: string;
  /** Human-facing label for the contracts inspector row. */
  display_name: string;
  /** Binding scope — MUST explicitly name the granted ingredient (op grain,
   *  N.3) and be owner-only (`actors` === `['user_self']`): a quality delegation
   *  is SCOPE-matched, so a `contracted_user`-scoped row would match every door,
   *  same door-widening hazard the delegation-rule mint refuses. */
  scope: ContractScope;
  /** The (recipe, op)'s recipe identity — content drift (`recipe_hash`) re-asks
   *  (the v1 whole-template reset, §14). */
  bound_recipe: BoundRecipeRef;
  /** The accepted suggestion's `key_hash` anchor — the accept rpc's
   *  at-least-once idempotence key + the audit back-pointer. REQUIRED. */
  approved_action_ref: string;
  /** OPTIONAL epoch-ms expiry. Absent ⇒ STANDING (the intended posture). When
   *  set it must be a future timestamp; there is NO TTL ceiling — a standing
   *  auto-accept is legitimate, reclaimed by the kill-switch, not a TTL. */
  expiry_at?: number;
}

/** D-202 — a quality-delegation mint input that cannot produce a matchable,
 *  owner-scoped grant (empty recipe identity, a non-owner or wildcard-ingredient
 *  scope, a missing anchor, a non-future explicit expiry). Same fail-loud
 *  posture as the other mint primitives — the accept layer's bug surfaces at the
 *  mint, not as a silently-inert (or silently-broad) row. */
export class QualityDelegationMintError extends Error {
  constructor(detail: string) {
    super(`quality_delegation_mint_invalid: ${detail}`);
    this.name = 'QualityDelegationMintError';
  }
}

/** The contract-lifecycle write/read surface over `contract.contract_definition.*`.
 *  Every mutator returns the resulting {@link ContractDefinition} (or `null` when
 *  the `contract_id` names no row), so a caller sees the post-write state without a
 *  follow-up read. */
export interface ContractDefinitionStore {
  /** Mint a fresh contract: a new `contract_id`, `minted_at = now()`, and the
   *  caller's fields. Returns the written definition (the source of the new
   *  `contract_id`). */
  mint(input: MintContractInput): ContractDefinition;
  /** Read one contract by id; `null` when absent. */
  get(contract_id: string): ContractDefinition | null;
  /** Every minted contract, newest first (`minted_at` descending, `contract_id`
   *  ascending as a stable tiebreak) — the owner Contracts feed. */
  list(): ContractDefinition[];
  /** Record one dispatch against the contract: decrement `uses_remaining` by one
   *  on a BOUNDED contract, clamped at 0 (the last use lands it at 0 ⇒ `exhausted`
   *  on the next lifecycle check). UNBOUNDED (no `max_uses`) ⇒ an unmetered no-op.
   *  Already at 0 ⇒ idempotent no-op (no spurious write). Returns the resulting
   *  definition, or `null` if `contract_id` is absent. Does NOT check expiry /
   *  revocation — the use-resolution slice gates on `isContractActive` first. */
  recordUse(contract_id: string): ContractDefinition | null;
  /** Atomic admission and reservation for a deferred in-flight attempt. */
  reserveDispatchUse?(contract_id: string): { before: ContractDefinition; after: ContractDefinition } | null;
  /** Give back a unit taken by {@link reserveDispatchUse} when the attempt never
   *  crossed the boundary — held for approval, refused downstream, or failed
   *  before any effect.
   *
   *  ⛔⛔ THE ARM THAT DID NOT EXIST, AND ITS ABSENCE IS WHY RESERVING EARLY WAS
   *  A TRADE. `reserveDispatchUse` charges and never refunds, so the preapproval
   *  lane accepts that a reserved-then-abandoned attempt costs a use. The
   *  ordinary lane cannot: it counts BOUNDARY CROSSINGS ("every dispatch
   *  decrements"), and `execute-handler.ts:4291` records that the decrement was
   *  deliberately relocated to the proceed point to close an UNDERCOUNT.
   *  Reserving early without this arm would swing the same field the other way.
   *
   *  ⛔ CLAMPED AT `max_uses`, WHICH IS THE SAFETY PROPERTY. A release can only
   *  ever restore what the owner authorised, so a double-release — a bug, a
   *  retry, a settle running twice — cannot inflate a budget past its cap. The
   *  caller also spends its token once (see the overlay), so this clamp is the
   *  backstop, not the only guard.
   *
   *  ⚠ UNBOUNDED CONTRACTS TOOK NOTHING, so releasing one is a no-op rather than
   *  a free credit: `reserveDispatchUse` leaves `after === before` when there is
   *  no counter, and this mirrors that exactly.
   *
   *  Returns true iff a unit was actually given back. */
  releaseDispatchUse?(contract_id: string): boolean;
  /** Revoke the contract: stamp `revoked_at = now()` + `revocation_reason`.
   *  Idempotent — a re-revoke leaves the FIRST revocation's `revoked_at` / reason
   *  intact (a revoked contract is already inert). Returns the resulting
   *  definition, or `null` if `contract_id` is absent. */
  revoke(contract_id: string, reason: string): ContractDefinition | null;
  /** D-187 §6 / D-196 R3 — set the level-1 door types on an EXISTING standing
   *  contract or customer template IN PLACE (no re-mint, so an agent's
   *  `contract_id` + any bound MCP token survive).
   *  `door_types` REPLACES the field: a non-empty array restricts the contract to
   *  those door types; an EMPTY array CLEARS the restriction (drops the key →
   *  sparse wildcard, matching `mint`'s only-supplied-fields discipline so a
   *  minted-without and a cleared contract share one stored shape). Returns the
   *  updated definition, or `null` when `contract_id` names no row OR names a
   *  gate-consumed `session` / `delegation` grant or a customer instance (only
   *  standing doors and templates are human-editable here). Does NOT touch
   *  lifecycle; the value_shape gate validates the array on write. */
  setDoorTypes(
    contract_id: string,
    door_types: ReadonlyArray<DoorType>,
  ): ContractDefinition | null;
  /** D-186 Slice C — early-revoke ONE session grant (the live-control
   *  bubble's "Active passes" revoke). A SESSION-SCOPED guard over the same
   *  lifecycle as {@link revoke}: it stamps `revoked_at` (expire-early →
   *  inert at the matcher's `isContractActive` + `consumeSessionGrant`'s
   *  re-check, so future matching ops re-ask) ONLY when `grant_id` names an
   *  ACTIVE `grant_kind: 'session'` row. Returns `null` (fail-closed) when the
   *  id names no row, a non-session row (a standing contract / delegation rule
   *  is revoked from Settings → Privacy → Contracts via `revoke`, never from
   *  this surface — so the grant-control surface can never nuke a standing
   *  contract), OR an already-inert (expired / exhausted) session row (no point
   *  rewriting a dead pass's natural lifecycle cause to `revoked`). Idempotent
   *  like `revoke` (a re-revoke of an already-revoked grant returns it with the
   *  first `revoked_at` intact). Does NOT touch in-flight already-admitted
   *  ops (that is `execution.kill`'s separate job, D-181) — it only removes
   *  the grant's future auto-admit authority. */
  revokeSessionGrant(grant_id: string): ContractDefinition | null;
  /** D-177 P2 — mint a session grant (N.3): a `contract_definition` row with
   *  `grant_kind: 'session'`, an explicit `grant_mode` (default `'exact'`), and
   *  the session bindings the N.4 predicate matches on. Throws
   *  {@link SessionGrantMintError} when the input cannot produce a matchable
   *  grant (empty bindings, unbound `ingredient_ids`, a mode missing its
   *  per-mode identity field). Reuses the standing lifecycle verbatim —
   *  `recordUse` / `revoke` / `list` / `get` all operate on session rows. */
  mintSessionGrant(input: MintSessionGrantInput): ContractDefinition;
  /** D-177 P2 — the session index: every `grant_kind: 'session'` row bound to
   *  `channel_session_id`, soonest-expiring first (the resolver consumes the
   *  first match, so the grant closest to expiry burns first — preserving the
   *  most usable budget; `minted_at` then `contract_id` break ties).
   *  Implemented as a scope scan + filter: contract rows are tiny and few (the
   *  store doc's ~45–175 rows), the lookup fires only on `ask` verdicts
   *  (human-paced), and rows are keyed by `contract_id` alone — a real SQLite
   *  index would need a generated column over the JSON for no measurable win.
   *  Includes non-live rows; the matcher's `isContractActive` gates liveness
   *  (so an inspector can reuse this listing for expired/revoked grants). */
  listSessionGrants(channel_session_id: string): ContractDefinition[];
  /** D-177 N.13 (P6a) — the delegation index: every `grant_kind: 'delegation'`
   *  row (the ladder-6 standing rules — scope-bound, no channel session), in
   *  the same soonest-expiring-first order as {@link listSessionGrants} and
   *  for the same reason (the resolver consumes the first match — burn the
   *  rule closest to expiry first). Same scan-and-filter implementation
   *  justification (tiny row count, ask-verdict-paced lookups only) and the
   *  same include-non-live posture (the matcher gates liveness; an inspector
   *  reuses the listing for expired/revoked rules). Empty until the P6c
   *  suggestion-accept mints a rule — the resolver's delegation pass scans an
   *  empty set and the gate behaves exactly as pre-P6a (inert by
   *  construction). */
  listDelegationRules(): ContractDefinition[];
  /** D-177 N.13 (P6c) — mint a delegation rule (ladder 6→7: the human
   *  accepted a staged-trust suggestion): a `contract_definition` row with
   *  `grant_kind: 'delegation'`, an EXPLICIT `grant_mode`, scope instead of
   *  a session binding, and the fork-3 bounds enforced as ceilings
   *  (`expiry_at` within {@link DELEGATION_RULE_TTL_MS} of mint;
   *  `max_uses` ≤ {@link DELEGATION_RULE_MAX_USES}) — a rule broader than
   *  the ratified vocabulary is unrepresentable at this seam. Throws
   *  {@link DelegationRuleMintError} on every refusal (out-of-vocabulary
   *  tier, unbound ingredient axis, missing per-mode identity, malformed
   *  open projection, out-of-ceiling bounds, missing anchor) — failing loud
   *  surfaces the accept layer's bug at its source rather than persisting a
   *  silently-inert (or silently-broad) standing row. Reuses the gate-grant
   *  lifecycle verbatim — `consumeSessionGrant` / `revoke` / `recordUse` /
   *  `listDelegationRules` all operate on the minted row. */
  mintDelegationRule(input: MintDelegationRuleInput): ContractDefinition;
  /** D-177 N.11 rule 5 (5.c, slice C) — mint a SCOPED session grant from an
   *  owner-accepted utterance proposal: a `contract_definition` row with
   *  `grant_kind: 'session'` + `grant_mode: 'scoped'`, the explicit
   *  ingredient/operation/connection triple, the session binding, the closed
   *  source enum, and the slice-C ceilings enforced tighten-only. Throws
   *  {@link ScopedGrantMintError} on every refusal. The N.4 scoped arm +
   *  `consumeSessionGrant`'s scoped re-verify (slice A) operate on the
   *  minted row; matching stays inert until slice D threads destination +
   *  candidate data into the gate's match context. */
  mintScopedSessionGrant(input: MintScopedSessionGrantInput): ContractDefinition;
  /** D-182 §8 — mint a RAW-OP session grant from a human's per-call approval
   *  of a door's raw catalog op (`allow_session` on a write-tier raw op): a
   *  `contract_definition` row with `grant_kind: 'session'` +
   *  `grant_mode: 'raw_op'`, the explicit ingredient + operation (+ connection
   *  when the op resolves one) scope, the session binding, and the recipe-less
   *  exact identity (`arg_shape_hash` + `canonical_payload_hash`) — but NO
   *  `bound_recipe` (a raw op has none). Throws {@link RawOpGrantMintError} on
   *  every refusal. The N.4 `'raw_op'` matcher arm + `consumeSessionGrant`'s
   *  raw-op re-verify operate on the minted row; reuses the gate-grant
   *  lifecycle verbatim (`consumeSessionGrant` / `revoke` / `recordUse` /
   *  `listSessionGrants`). */
  mintRawOpGrant(input: MintRawOpGrantInput): ContractDefinition;
  /** D-202 — the quality-delegation index: every
   *  `grant_kind: 'quality_delegation'` row (the coarse (recipe, op)-grain
   *  quality-axis grants — scope-bound, no channel session, standing). Global
   *  by construction (scope narrows at the matcher), same include-non-live
   *  posture as {@link listDelegationRules} (an inspector reuses the listing;
   *  the matcher gates liveness). Ordered by {@link byExpirySoonestFirst} for a
   *  deterministic listing — standing rows (no `expiry_at`) sort last, which is
   *  harmless: unlike the authorization grants, quality matching is
   *  NON-consuming, so there is no burn-order to honour. Empty until a mint —
   *  the gate's quality pass scans an empty set and behaves exactly as pre-D-202
   *  (inert by construction). */
  listQualityDelegations(): ContractDefinition[];
  /** D-202 — mint a QUALITY delegation (the owner accepted a quality-axis
   *  suggestion, or minted one directly): a `contract_definition` row with
   *  `grant_kind: 'quality_delegation'`, recipe identity + op scope, and NO
   *  per-call payload identity (quality is coarse — §5). STANDING by
   *  construction: no `max_uses`, `expiry_at` optional (governed by the §3
   *  ladder + §4 kill-switch, not a use budget). Owner-only
   *  (`scope.actors === ['user_self']`) for the same door-widening reason as
   *  {@link mintDelegationRule}. Throws {@link QualityDelegationMintError} on
   *  every refusal (empty recipe identity, non-owner / wildcard-ingredient
   *  scope, missing anchor, non-future explicit expiry) — failing loud surfaces
   *  the accept layer's bug at its source. The quality row NEVER flows through
   *  `consumeSessionGrant` (that re-verifies `'session'`/`'delegation'` and
   *  fails closed on it); `matchesQualityDelegation` reads it non-destructively,
   *  and `revoke` / `listQualityDelegations` operate on it. */
  mintQualityDelegation(input: MintQualityDelegationInput): ContractDefinition;
  /** D-177 P2 — consume one use of a gate grant (a session grant, or — N.13
   *  P6a — a delegation rule) at the Gateway's dispatch proceed point (N.4
   *  step 4). UNLIKE `recordUse` (a dumb counter that never
   *  fails), this is an atomic check-and-decrement that re-verifies the row is
   *  a LIVE gate-grant row before writing: absent / not-`'session'`-or-
   *  `'delegation'` / revoked / expired / exhausted ⇒ `false`, and the caller
   *  falls back to hold — fail closed. A grant row with NO `uses_remaining` is
   *  malformed (the mints require `max_uses` — bounded by construction) and
   *  also returns `false`: consuming it would admit an unmetered auto-approve
   *  loop. Synchronous read-check-write with no interleaving point
   *  (better-sqlite3), so two concurrent dispatches can't both consume a
   *  final use.
   *
   *  D-177 P5a — per-mode consumption (N.4): an `'exact'` row decrements as
   *  before (`call` ignored); a `'batch'` row requires
   *  `call.canonical_payload_hash` and atomically CLAIMS one unconsumed
   *  member with that hash (consumed_at stamp + decrement in the same
   *  synchronous write — the claim IS the consumption; no such member ⇒
   *  `false`, fail closed).
   *
   *  D-177 P5b — an `'open'` row requires `call.pinned_projection_hash`
   *  equal to the row's before decrementing (hash-verified consumption,
   *  same posture as the batch claim: the matcher already required the
   *  fire's recomputed projection hash to equal the grant's, and the store
   *  re-verifies at the write so a resolver bug can never spend an open
   *  use on a divergent fire). Absent / divergent ⇒ `false`, fail closed.
   *
   *  D-177 N.13 (P6a) — a `'delegation'` row consumes through the same
   *  exact/open arms; `'batch'` is SESSION-ONLY, so a batch-mode delegation
   *  row refuses here too (defense in depth — the matcher never returns
   *  one). */
  consumeSessionGrant(
    contract_id: string,
    call?: {
      canonical_payload_hash?: string;
      pinned_projection_hash?: string;
      /** D-177 N.11 rule 5 — `'scoped'` rows: the dispatch's canonical
       *  destination emails + the per-session sender candidate index, both
       *  re-verified through `scopedContainmentAdmits` at this write (5.a:
       *  containment is checked at match AND consume). Absent => a scoped
       *  consumption refuses. */
      destination_emails?: ReadonlyArray<string>;
      scoped_sender_candidates?: ReadonlyArray<ScopedSenderCandidate>;
      /** D-177 N.14 — the dispatching run's governing door contract id; a
       *  row carrying `bound_contract_id` requires equality at this write
       *  (the matcher's door clause, re-verified — a resolver bug can never
       *  spend a door grant's use on another door's dispatch). */
      source_contract_id?: string;
    },
  ): boolean;
  /** D-177 P5a (N.10) — claim a SPECIFIC batch member at the proceed point
   *  of a batch-approved RESUME dispatch (the `preflight_batch_claim`
   *  marker names the member the answer minted from this very hold).
   *  Atomic: live `'batch'` session row ∧ the member exists ∧ unconsumed ∧
   *  THE ENVELOPE STILL MATCHES (codex HIGH fold — the grant's
   *  `arg_shape_hash` equals the dispatch's, and the member's
   *  `canonical_payload_hash` equals the dispatch's, so a resume whose
   *  recipe/args drifted mid-pause fails the claim and re-asks rather
   *  than spending an approved member on unreviewed content) ⇒
   *  consumed_at stamp + `uses_remaining` decrement in one synchronous
   *  write, `true`. Everything else ⇒ `false` (the caller re-holds — an
   *  agent replay that claimed the member first won the approved budget;
   *  fail closed, never exceeded). */
  claimBatchMember(
    contract_id: string,
    member_id: string,
    call: {
      arg_shape_hash: string;
      canonical_payload_hash: string;
      /** D-177 N.14.6 — the dispatching run's governing door contract id. A row
       *  carrying `bound_contract_id` claims ONLY against equality, the same
       *  re-verify `consumeSessionGrant` applies for the same stated reason (a
       *  resolver bug must never spend a door grant on another door's dispatch).
       *  The claim is the OTHER spend path: it decrements `uses_remaining` and
       *  burns a member, so leaving it unfenced left the invariant "a bound row
       *  spends only for its own door" true on one path and silent on the other. */
      source_contract_id?: string;
    },
  ): boolean;
}

export interface CreateContractDefinitionStoreOptions {
  /** Time source for `minted_at` / `revoked_at` (epoch-ms). Defaults to `Date.now`. */
  now?: () => number;
  /** `contract_id` factory. MUST return a fresh unique id per call (the store
   *  upserts, so a repeat id would overwrite an existing contract). Defaults to a
   *  `ct_`-prefixed v4 UUID (no dots — the seg_key codec keeps it one clean
   *  segment). Tests inject a deterministic counter. */
  newId?: () => string;
}

/** Soonest-expiring first (codex LOW fold — minted-order is NOT expiry order
 *  when TTLs vary): the resolver consumes the first match, so burning the
 *  grant closest to expiry preserves the most usable budget. Every minted
 *  gate-grant row carries `expiry_at` (bounded by construction); a malformed
 *  row missing it sorts last (it never matches anyway). `minted_at` then
 *  `contract_id` break ties deterministically. Shared by the session index
 *  and the N.13 delegation index — one burn order, two listings. */
const byExpirySoonestFirst = (a: ContractDefinition, b: ContractDefinition): number => {
  const aExp = a.expiry_at ?? Number.POSITIVE_INFINITY;
  const bExp = b.expiry_at ?? Number.POSITIVE_INFINITY;
  if (aExp !== bExp) return aExp - bExp;
  if (a.minted_at !== b.minted_at) return a.minted_at - b.minted_at;
  if (a.contract_id < b.contract_id) return -1;
  if (a.contract_id > b.contract_id) return 1;
  return 0;
};

/** Wrap a {@link ContractStore} as the {@link ContractDefinitionStore}. Stateless
 *  beyond the injected clock + id-gen — every call forwards to the shared store
 *  handle; safe to construct more than once over the same store. */
export const createContractDefinitionStore = (
  store: ContractStore,
  opts?: CreateContractDefinitionStoreOptions,
): ContractDefinitionStore => {
  const now = opts?.now ?? ((): number => Date.now());
  const newId = opts?.newId ?? ((): string => `ct_${randomUUID()}`);

  // Every contract DATA row at this scope is a validated `contract_definition`
  // value (writes go through `store.put`), so the narrowing from `unknown` is
  // sound — mirrors `createContractScanFn`'s record narrowing.
  const read = (contract_id: string): ContractDefinition | null => {
    const row = store.get(CONTRACT_DEFINITION_SCOPE, [contract_id]);
    return row ? (row.value as ContractDefinition) : null;
  };

  return {
    mint(input) {
      const contract_id = newId();
      // D-187 AMENDMENT 3b — a minted door / standing contract may NEVER carry the
      // reserved OWNER sentinel id: the owner contract is a sentinel storage key derived
      // at the gate, never a `contract_definition` row. The default `newId` (`ct_`+uuid)
      // can't collide, but a misconfigured factory must fail LOUD rather than mint a
      // contract whose rows are the owner's permissive grants (defense in depth alongside
      // the token-binding fence + the gate-level `gateStandingContractId`).
      if (isReservedOwnerContractId(contract_id)) {
        throw new Error(
          `contract_definition mint: newId produced the reserved owner contract id '${contract_id}' — a door / standing contract can never be the owner sentinel`,
        );
      }
      // D-248 Amendment 3 — the PUBLIC sentinel's twin. A `contract_definition` row for
      // the floor is the one thing that would make it gateable and grantable, which is
      // exactly the drift `isReservedPublicContractId`'s docstring says the fence exists
      // to prevent.
      if (isReservedPublicContractId(contract_id)) {
        throw new Error(
          `contract_definition mint: newId produced the reserved public-anonymous id '${contract_id}' — the floor is derived at the gate and can never have a definition row`,
        );
      }
      // Construct with ONLY the supplied optional fields so the persisted shape
      // matches the read-back shape (no `undefined` keys). `max_uses` seeds
      // `uses_remaining` to the same value — the counter starts full.
      const def: ContractDefinition = {
        contract_id,
        minted_at: now(),
        minted_by: input.minted_by,
        display_name: input.display_name,
        scope: input.scope,
        ...(input.door_execution_policy !== undefined
          ? { door_execution_policy: input.door_execution_policy }
          : {}),
        ...(input.grant_kind !== undefined
          ? { grant_kind: input.grant_kind }
          : {}),
        // D-187 §6 (step 7) — only land `door_types` when supplied (construction
        // discipline: persisted shape == read-back shape, no `undefined` keys).
        // Absent ⇒ wildcard (any door type), the behaviour-preserving default.
        ...(input.door_types !== undefined ? { door_types: input.door_types } : {}),
        // D-209 #1 — the derived-door ceiling, landed only when supplied.
        ...(input.max_risk_without_approval !== undefined
          ? { max_risk_without_approval: input.max_risk_without_approval }
          : {}),
        ...(input.approved_actions_template !== undefined
          ? { approved_actions_template: input.approved_actions_template }
          : {}),
        ...(input.expiry_at !== undefined ? { expiry_at: input.expiry_at } : {}),
        ...(input.max_uses !== undefined
          ? {
            max_uses: input.max_uses,
            uses_remaining: input.max_uses,
            // The window the fresh counter belongs to. Stamped only for a
            // periodic cap — `'total'` has no window, and writing one would
            // imply a refill that never comes.
            ...(input.use_period !== undefined && input.use_period !== 'total'
              ? {
                use_period: input.use_period,
                ...(() => {
                  const start = usageCapWindowStart(input.use_period, now());
                  return start !== null ? { use_period_start: start } : {};
                })(),
              }
              : {}),
          }
          : {}),
      };
      // `put` validates the value_shape (incl. the nested contract_scope) and is an
      // idempotent upsert; merge_rule `override` runs no tightening check. A fresh
      // random `contract_id` never collides, so this is always an insert.
      store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], def);
      return def;
    },

    get(contract_id) {
      return read(contract_id);
    },

    list() {
      return store
        .scan(CONTRACT_DEFINITION_SCOPE)
        .map((row) => row.value as ContractDefinition)
        .sort((a, b) => {
          if (a.minted_at !== b.minted_at) return b.minted_at - a.minted_at;
          // Deterministic tiebreak (matches the store's BINARY-collation ordering):
          // contract_ids are ascii, so a plain `<`/`>` agrees with SQLite's order.
          if (a.contract_id < b.contract_id) return -1;
          if (a.contract_id > b.contract_id) return 1;
          return 0;
        });
    },

    reserveDispatchUse(contract_id) {
      let reservation: { before: ContractDefinition; after: ContractDefinition } | null = null;
      store.transaction(() => {
        const stored = read(contract_id);
        if (!stored) return;
        // ⛔⛔ THE REFILL IS PART OF THE TAKE, NOT A SEPARATE TICK. `isContractActive`
        //   already reads a rolled window as active, so judging on the stored
        //   counter here would decrement a refilled budget from 0 to -1 and hand
        //   back a reservation for a unit that was never there. Same transaction,
        //   same instant, one write.
        const before = rolledContractUses(stored, now());
        if (!isContractActive(before, now()) || !isStandingContractDefinition(before)) return;
        const after = typeof before.uses_remaining === 'number' ? { ...before, uses_remaining: before.uses_remaining - 1 } : before;
        // `before !== stored` means a refill landed even if the counter arithmetic
        // did not move it — persist either way, or the window anchor never advances
        // and the next take refills again.
        if (after !== before || before !== stored) {
          store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], after);
        }
        reservation = { before, after };
      });
      return reservation;
    },
    releaseDispatchUse(contract_id) {
      let released = false;
      store.transaction(() => {
        const stored = read(contract_id);
        if (!stored) return;
        // ⚠ A release that lands AFTER the window rolled credits the NEW window —
        //   which is correct and harmless: the refill already restored the full
        //   budget, so the `max_uses` clamp below turns this into a no-op rather
        //   than a unit carried across a boundary it never belonged to.
        const current = rolledContractUses(stored, now());
        // Unbounded took nothing — mirror `reserveDispatchUse`'s own no-op arm
        // rather than crediting a counter that does not exist.
        if (typeof current.uses_remaining !== 'number') return;
        // ⛔ NEVER ABOVE THE AUTHORISED CAP. `max_uses` is the ceiling the owner
        //   set; a release that could exceed it would turn a settle bug into a
        //   bigger budget than anyone granted.
        const ceiling = typeof current.max_uses === 'number'
          ? current.max_uses
          : current.uses_remaining;
        const next = Math.min(ceiling, current.uses_remaining + 1);
        if (next === current.uses_remaining && current === stored) return;
        store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], {
          ...current,
          uses_remaining: next,
        });
        released = next !== current.uses_remaining;
      });
      return released;
    },
    recordUse(contract_id) {
      const stored = read(contract_id);
      if (!stored) return null;
      // A periodic cap refills here too. This path has no active re-check of its
      // own (its gate was the caller's `shouldMeterUse`), so without the refill a
      // legacy overlay would keep decrementing a window that had already rolled.
      const def = rolledContractUses(stored, now());
      // Unbounded — no `max_uses` cap. Both ABSENT and explicit `null` count as
      // unmetered (the `number?` value_shape admits `null`, and
      // `contractLifecycleState` treats null/undefined identically); guarding only
      // `undefined` would let a `null` row fall through to `null - 1` and persist
      // `uses_remaining: 0`, silently exhausting an unlimited contract.
      if (def.uses_remaining === undefined || def.uses_remaining === null) return def;
      const next = Math.max(0, def.uses_remaining - 1);
      // Already exhausted (0) — clamp leaves it unchanged; skip the redundant write
      // UNLESS a refill just landed, which must still be persisted.
      if (next === def.uses_remaining && def === stored) return def;
      const updated: ContractDefinition = { ...def, uses_remaining: next };
      store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], updated);
      return updated;
    },

    revoke(contract_id, reason) {
      const def = read(contract_id);
      if (!def) return null;
      // Preserve the first revocation — a revoked contract is already inert, so a
      // re-revoke must not move `revoked_at` or overwrite the original reason. Only
      // a REAL timestamp short-circuits: `revoked_at: null` (admitted by the
      // `datetime?` value_shape) means NOT-yet-revoked per `contractLifecycleState`,
      // so guarding `undefined` alone would no-op a genuine revoke of such a row.
      if (def.revoked_at !== undefined && def.revoked_at !== null) return def;
      const updated: ContractDefinition = {
        ...def,
        revoked_at: now(),
        revocation_reason: reason,
      };
      store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], updated);
      return updated;
    },

    setDoorTypes(contract_id, door_types) {
      const def = read(contract_id);
      if (!def) return null;
      // Door types are editable for ordinary standing doors and for D-196
      // customer templates (the template defines which customer surfaces an
      // issued instance may back). Customer instances and gate-consumed grants
      // remain server-owned / inert on this generic authoring surface.
      if (
        !isStandingContractDefinition(def)
        && def.grant_kind !== 'customer_template'
      ) return null;
      // Start from a shallow copy with `door_types` removed, then re-add only when
      // non-empty: an empty array CLEARS (sparse wildcard — matches `mint`, so a
      // minted-without and a cleared contract share one stored shape). The
      // string-indexed cast drops the readonly field on the COPY (the stored `def`
      // is untouched); the value_shape gate validates the array on `put`.
      const base = { ...def };
      delete (base as Record<string, unknown>).door_types;
      const updated: ContractDefinition =
        door_types.length === 0 ? base : { ...base, door_types: [...door_types] };
      store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], updated);
      return updated;
    },

    revokeSessionGrant(grant_id) {
      const def = read(grant_id);
      if (!def) return null;
      // Fail-closed session guard (D-186 Slice C): the live-control "Active
      // passes" surface only ever revokes session grants. A standing contract
      // or an N.13 delegation rule reaching here (wrong id, or a UI bug) is
      // NOT revoked — it returns `null` exactly like a missing row, so the
      // grant-control path can never tear down a standing contract. Those are
      // revoked from Settings → Privacy → Contracts via `revoke`.
      if (def.grant_kind !== 'session') return null;
      // Same idempotent expire-early as `revoke`: a real `revoked_at`
      // short-circuits (a session grant is already inert once revoked), but
      // `null` (admitted by the `datetime?` value_shape) means not-yet-revoked.
      if (def.revoked_at !== undefined && def.revoked_at !== null) return def;
      // Active-only: this surface expires a LIVE pass EARLY. An already-inert
      // (expired / exhausted) row returns `null` (→ handler `not_found`) rather
      // than rewriting its natural lifecycle cause to `revoked` — preserving
      // provenance and matching the "revoke an active pass" contract. The
      // cosmetic expire-between-list-and-click race resolves to "no active
      // session grant" + a re-list (the row was already gone), the correct UX.
      if (!isContractActive(def, now())) return null;
      const updated: ContractDefinition = {
        ...def,
        revoked_at: now(),
        revocation_reason: 'Revoked from live-control',
      };
      store.put(CONTRACT_DEFINITION_SCOPE, [grant_id], updated);
      return updated;
    },

    mintSessionGrant(input) {
      // The mint is the enforcement point for the conditional requirements the
      // value_shape can't express (its mini-language has no "required when").
      // Every refusal here would otherwise be a silently-inert row at the
      // matcher — failing loud surfaces the approval-layer bug at its source.
      if (input.channel_session_id.length === 0) {
        throw new SessionGrantMintError('channel_session_id must be non-empty (D6)');
      }
      if (
        input.bound_recipe.recipe_id.length === 0
        || input.bound_recipe.recipe_hash.length === 0
      ) {
        throw new SessionGrantMintError('bound_recipe must carry recipe_id + recipe_hash');
      }
      if (input.arg_shape_hash.length === 0) {
        throw new SessionGrantMintError('arg_shape_hash must be non-empty');
      }
      // codex HIGH fold (P3) — the row pins the approved tier and only the
      // grantable tiers are representable (D7): read/write/admin may grant,
      // `destructive` never grants. The matcher requires tier equality, so a
      // row outside this vocabulary would be inert anyway — refuse it loudly.
      if (!(SESSION_GRANT_RISK_TIERS as readonly string[]).includes(input.risk_tier)) {
        throw new SessionGrantMintError(
          `risk_tier '${input.risk_tier}' is not session-grantable (D7 — read|write|admin only)`,
        );
      }
      // codex HIGH fold (N.3) — the ingredient axis is never a wildcard for
      // session grants: an unbound scope could match across different tools
      // that share an arg shape. The matcher enforces this too; refusing the
      // mint keeps an unmatchable row from ever existing.
      if (!input.scope.ingredient_ids || input.scope.ingredient_ids.length === 0) {
        throw new SessionGrantMintError(
          'scope.ingredient_ids must explicitly name the granted ingredient (N.3)',
        );
      }
      // D-177 N.14 — the door binding's conditional requirements: a
      // present binding must be non-empty (the matcher treats an empty one
      // as malformed → inert), and an ANONYMOUS-scoped grant REQUIRES one
      // (the matcher's asymmetric clause makes an unbound anonymous grant
      // unmatchable — refuse the mint loudly at its source instead).
      if (
        input.bound_contract_id !== undefined
        && input.bound_contract_id.length === 0
      ) {
        throw new SessionGrantMintError(
          'bound_contract_id must be non-empty when present (N.14)',
        );
      }
      if (
        input.scope.actors?.includes('anonymous') === true
        && input.bound_contract_id === undefined
      ) {
        throw new SessionGrantMintError(
          "an 'anonymous'-scoped session grant requires bound_contract_id "
            + '(N.14 — the door binding)',
        );
      }
      // codex HIGH fold — bounded by construction: every session grant
      // carries a future expiry AND a positive use budget (N.5 mints both
      // from the cell defaults; the N.11 confirm sentence's clauses each map
      // onto an enforced bound). The matcher + consume fail closed on rows
      // missing either, so an unbounded mint would only ever produce an
      // inert row — refuse it loudly instead.
      const minted_at = now();
      if (!Number.isFinite(input.expiry_at) || input.expiry_at <= minted_at) {
        throw new SessionGrantMintError(
          `expiry_at must be a future epoch-ms timestamp (got ${String(input.expiry_at)})`,
        );
      }
      if (!Number.isInteger(input.max_uses) || input.max_uses < 1) {
        throw new SessionGrantMintError(
          `max_uses must be a positive integer (got ${String(input.max_uses)})`,
        );
      }
      const grant_mode = input.grant_mode ?? 'exact';
      // Per-mode identity fields must be non-empty, not merely present (codex
      // LOW fold): the matcher requires non-empty strings, so an empty-string
      // mint would persist an active-looking grant that never matches — the
      // user's "allow this session" silently degrading into repeated asks.
      if (
        grant_mode === 'exact'
        && (input.canonical_payload_hash === undefined
          || input.canonical_payload_hash.length === 0)
      ) {
        throw new SessionGrantMintError(
          "grant_mode 'exact' requires a non-empty canonical_payload_hash",
        );
      }
      if (grant_mode === 'batch') {
        if (input.batch_members === undefined || input.batch_members.length === 0) {
          throw new SessionGrantMintError("grant_mode 'batch' requires a non-empty batch_members");
        }
        for (const member of input.batch_members) {
          if (member.member_id.length === 0 || member.canonical_payload_hash.length === 0) {
            throw new SessionGrantMintError(
              'batch_members entries require non-empty member_id + canonical_payload_hash',
            );
          }
        }
      }
      if (
        grant_mode === 'open'
        && (input.pinned_projection_hash === undefined
          || input.pinned_projection_hash.length === 0
          || input.open_projection === undefined)
      ) {
        throw new SessionGrantMintError(
          "grant_mode 'open' requires a non-empty pinned_projection_hash + open_projection",
        );
      }
      const contract_id = newId();
      // Same construction discipline as `mint`: only supplied optional fields land
      // on the row (no `undefined` keys), so persisted equals read-back.
      // `grant_mode` is stamped EXPLICITLY (never left to the absent⇒exact
      // default) so the inspector and audit read the mode off the row verbatim.
      const def: ContractDefinition = {
        contract_id,
        minted_at,
        minted_by: input.minted_by,
        display_name: input.display_name,
        scope: input.scope,
        grant_kind: 'session',
        grant_mode,
        channel_session_id: input.channel_session_id,
        bound_recipe: input.bound_recipe,
        ...(input.bound_contract_id !== undefined
          ? { bound_contract_id: input.bound_contract_id }
          : {}),
        arg_shape_hash: input.arg_shape_hash,
        risk_tier: input.risk_tier,
        expiry_at: input.expiry_at,
        max_uses: input.max_uses,
        uses_remaining: input.max_uses,
        ...(input.canonical_payload_hash !== undefined
          ? { canonical_payload_hash: input.canonical_payload_hash }
          : {}),
        ...(input.batch_members !== undefined
          ? { batch_members: input.batch_members }
          : {}),
        ...(input.pinned_projection_hash !== undefined
          ? { pinned_projection_hash: input.pinned_projection_hash }
          : {}),
        ...(input.open_projection !== undefined
          ? { open_projection: input.open_projection }
          : {}),
        ...(input.entity_scope !== undefined ? { entity_scope: input.entity_scope } : {}),
        ...(input.approved_action_ref !== undefined
          ? { approved_action_ref: input.approved_action_ref }
          : {}),
      };
      store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], def);
      return def;
    },

    listSessionGrants(channel_session_id) {
      return store
        .scan(CONTRACT_DEFINITION_SCOPE)
        .map((row) => row.value as ContractDefinition)
        .filter(
          (def) =>
            def.grant_kind === 'session'
            && def.channel_session_id === channel_session_id,
        )
        .sort(byExpirySoonestFirst);
    },

    listDelegationRules() {
      // D-177 N.13 (P6a) — same scan-and-filter + burn-order rationale as the
      // session index above; the delegation vocabulary has no session key, so
      // the listing is global by construction (scope does the narrowing at
      // the matcher).
      return store
        .scan(CONTRACT_DEFINITION_SCOPE)
        .map((row) => row.value as ContractDefinition)
        .filter((def) => def.grant_kind === 'delegation')
        .sort(byExpirySoonestFirst);
    },

    mintDelegationRule(input) {
      // Same enforcement-point rationale as `mintSessionGrant`: the
      // value_shape can't express conditional requirements or the fork-3
      // ceilings, so the mint primitive is where the N.13 vocabulary becomes
      // unrepresentable-if-violated. Every refusal here would otherwise be a
      // silently-inert row at the matcher — or, for the bounds, a standing
      // rule broader than anything the human was shown.
      if (
        input.bound_recipe.recipe_id.length === 0
        || input.bound_recipe.recipe_hash.length === 0
      ) {
        throw new DelegationRuleMintError('bound_recipe must carry recipe_id + recipe_hash');
      }
      if (input.arg_shape_hash.length === 0) {
        throw new DelegationRuleMintError('arg_shape_hash must be non-empty');
      }
      // Fork 2 — the rule vocabulary is STRICTER than the session-grant
      // ceiling: `write` only in v1. The matcher enforces the same set
      // row-side, so an out-of-vocabulary row would be inert anyway —
      // refuse it loudly (the P6c accept re-validates the snapshot's tier
      // through this exact check).
      if (!(DELEGATION_RULE_RISK_TIERS as readonly string[]).includes(input.risk_tier)) {
        throw new DelegationRuleMintError(
          `risk_tier '${input.risk_tier}' is not delegation-mintable (N.13 fork 2 — write only)`,
        );
      }
      // TWO MINTABLE FAMILIES (storage chokepoint — the last line of the same
      // defense-in-depth as the tier / N.3 checks; the learner + the snapshot→plan
      // gate already refuse everything else upstream, `delegation-suggestion.ts`):
      //  - OWNER (`['user_self']`) — the original N.13 rule, NO door binding
      //    (a user_self rule carrying one would be inert at the matcher's
      //    equality clause against owner contexts — refuse it loudly);
      //  - DOOR (`['anonymous']` + N.14 `bound_contract_id` + `['reception']`
      //    channels) — the rule the matcher binds to exactly ONE door.
      // Every other actor stays refusable: a `contracted_user` rule is
      // SCOPE-matched only (no binding exists for those grants), so it would
      // match EVERY door sharing channel × actor × ingredient × op —
      // auto-widening door access. (Every mcp door, incl. the owner's own
      // raw-MCP bearer, dispatches as `contracted_user`.)
      const actors = input.scope.actors;
      const isOwnerRule = actors?.length === 1 && actors[0] === 'user_self';
      const isDoorRule = actors?.length === 1 && actors[0] === 'anonymous';
      if (!isOwnerRule && !isDoorRule) {
        throw new DelegationRuleMintError(
          "scope.actors must be exactly ['user_self'] (owner rule) or ['anonymous'] "
            + '(N.14 door rule) — a contracted_user-scoped rule would match every door',
        );
      }
      if (isOwnerRule && input.bound_contract_id !== undefined) {
        throw new DelegationRuleMintError(
          'an owner rule must not carry bound_contract_id (N.14 — the binding is door-only)',
        );
      }
      if (isDoorRule) {
        if (
          input.bound_contract_id === undefined
          || input.bound_contract_id.length === 0
        ) {
          throw new DelegationRuleMintError(
            "an 'anonymous'-scoped delegation rule requires a non-empty "
              + 'bound_contract_id (N.14 — the door binding)',
          );
        }
        if (
          input.scope.channels?.length !== 1
          || input.scope.channels[0] !== 'reception'
        ) {
          throw new DelegationRuleMintError(
            "an 'anonymous'-scoped delegation rule must bind channels ['reception'] (N.14)",
          );
        }
      }
      // N.3 applies to rules too: the ingredient axis is never a wildcard —
      // an unbound scope could match across tools sharing an arg shape.
      if (!input.scope.ingredient_ids || input.scope.ingredient_ids.length === 0) {
        throw new DelegationRuleMintError(
          'scope.ingredient_ids must explicitly name the granted ingredient (N.3)',
        );
      }
      // The anchor is REQUIRED on a rule: it is the accept rpc's durable
      // idempotence key (at-least-once retries find the twin by it) and the
      // audit's back-pointer to the accepted suggestion.
      if (input.approved_action_ref.length === 0) {
        throw new DelegationRuleMintError('approved_action_ref must be non-empty');
      }
      // Fork 3 — bounded by construction, with the code constants as
      // CEILINGS (tighten-only): a rule outliving DELEGATION_RULE_TTL_MS or
      // budgeted past DELEGATION_RULE_MAX_USES must not be representable.
      const minted_at = now();
      if (!Number.isFinite(input.expiry_at) || input.expiry_at <= minted_at) {
        throw new DelegationRuleMintError(
          `expiry_at must be a future epoch-ms timestamp (got ${String(input.expiry_at)})`,
        );
      }
      if (input.expiry_at > minted_at + DELEGATION_RULE_TTL_MS) {
        throw new DelegationRuleMintError(
          `expiry_at exceeds the rule TTL ceiling (${String(DELEGATION_RULE_TTL_MS)} ms — fork 3, tighten-only)`,
        );
      }
      if (!Number.isInteger(input.max_uses) || input.max_uses < 1) {
        throw new DelegationRuleMintError(
          `max_uses must be a positive integer (got ${String(input.max_uses)})`,
        );
      }
      if (input.max_uses > DELEGATION_RULE_MAX_USES) {
        throw new DelegationRuleMintError(
          `max_uses exceeds the rule ceiling (${String(DELEGATION_RULE_MAX_USES)} — fork 3, tighten-only)`,
        );
      }
      // Per-mode identity — non-empty, not merely present (the matcher
      // requires non-empty strings; an empty-string mint would persist an
      // active-looking rule that never matches). The open arm additionally
      // requires a WELL-FORMED projection: the N.4 open clause re-validates
      // it per dispatch, so a malformed one would mint an inert rule.
      if (input.grant_mode === 'exact') {
        if (
          input.canonical_payload_hash === undefined
          || input.canonical_payload_hash.length === 0
        ) {
          throw new DelegationRuleMintError(
            "grant_mode 'exact' requires a non-empty canonical_payload_hash",
          );
        }
      } else if (input.grant_mode === 'open') {
        if (
          input.pinned_projection_hash === undefined
          || input.pinned_projection_hash.length === 0
          || !isWellFormedOpenProjection(input.open_projection)
        ) {
          throw new DelegationRuleMintError(
            "grant_mode 'open' requires a non-empty pinned_projection_hash + a well-formed open_projection",
          );
        }
      } else {
        // 'batch' (session-only — N.13 delta 4) and unknown future modes.
        throw new DelegationRuleMintError(
          `grant_mode '${String(input.grant_mode)}' is not delegation-mintable (exact | open only)`,
        );
      }
      const contract_id = newId();
      // Same construction discipline as the other mints: only supplied
      // optional fields land on the row. `grant_kind` + the EXPLICIT
      // `grant_mode` are stamped verbatim — P6b's suggestion-key derivation
      // requires the explicit mode literal, so the minted rule derives its
      // own key for the learner's suppression join. NO `channel_session_id`
      // lands by construction (the input shape has no such field).
      const def: ContractDefinition = {
        contract_id,
        minted_at,
        minted_by: input.minted_by,
        display_name: input.display_name,
        scope: input.scope,
        grant_kind: 'delegation',
        grant_mode: input.grant_mode,
        bound_recipe: input.bound_recipe,
        ...(input.bound_contract_id !== undefined
          ? { bound_contract_id: input.bound_contract_id }
          : {}),
        arg_shape_hash: input.arg_shape_hash,
        risk_tier: input.risk_tier,
        expiry_at: input.expiry_at,
        max_uses: input.max_uses,
        uses_remaining: input.max_uses,
        approved_action_ref: input.approved_action_ref,
        ...(input.canonical_payload_hash !== undefined
          ? { canonical_payload_hash: input.canonical_payload_hash }
          : {}),
        ...(input.pinned_projection_hash !== undefined
          ? { pinned_projection_hash: input.pinned_projection_hash }
          : {}),
        ...(input.open_projection !== undefined
          ? { open_projection: input.open_projection }
          : {}),
        ...(input.entity_scope !== undefined ? { entity_scope: input.entity_scope } : {}),
      };
      store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], def);
      return def;
    },

    listQualityDelegations() {
      // D-202 — same scan-and-filter as the session/delegation indexes; the
      // quality vocabulary has no session key, so the listing is global by
      // construction (scope narrows at the matcher). Matching is NON-consuming,
      // so the burn order is purely cosmetic determinism (standing rows last).
      return store
        .scan(CONTRACT_DEFINITION_SCOPE)
        .map((row) => row.value as ContractDefinition)
        .filter((def) => def.grant_kind === 'quality_delegation')
        .sort(byExpirySoonestFirst);
    },

    mintQualityDelegation(input) {
      // Same enforcement-point rationale as the other mints: the value_shape
      // can't express conditional requirements, so refusals land here, loudly.
      // Every clause mirrors a fail-closed `matchesQualityDelegation` clause —
      // a row violating any would be inert (or, for the actor axis, door-widening).
      if (
        input.bound_recipe.recipe_id.length === 0
        || input.bound_recipe.recipe_hash.length === 0
      ) {
        throw new QualityDelegationMintError(
          'bound_recipe must carry recipe_id + recipe_hash',
        );
      }
      // OWNER-ONLY (storage chokepoint). A quality delegation is SCOPE-matched
      // (`matchesQualityDelegation` on recipe × ingredient × op), so any actor
      // other than exactly `[user_self]` would match doors (`contracted_user`),
      // auto-widening door access. Refuse here so no caller — present or future —
      // can ever mint a door-matching quality grant.
      if (input.scope.actors?.length !== 1 || input.scope.actors[0] !== 'user_self') {
        throw new QualityDelegationMintError(
          "scope.actors must be exactly ['user_self'] — quality delegations are "
            + 'owner-only (a contracted_user-scoped grant would match every door)',
        );
      }
      // N.3 — the ingredient axis is never a wildcard (the matcher requires the
      // explicit slug; an unbound scope could match across tools sharing a recipe).
      if (!input.scope.ingredient_ids || input.scope.ingredient_ids.length === 0) {
        throw new QualityDelegationMintError(
          'scope.ingredient_ids must explicitly name the granted ingredient (N.3)',
        );
      }
      // The anchor is REQUIRED: the accept rpc's durable idempotence key + the
      // audit back-pointer to the accepted suggestion.
      if (input.approved_action_ref.length === 0) {
        throw new QualityDelegationMintError('approved_action_ref must be non-empty');
      }
      const minted_at = now();
      // STANDING by construction — `expiry_at` is OPTIONAL. When present it must
      // be a FUTURE timestamp (a past / NaN expiry would mint an inert row);
      // there is deliberately NO TTL ceiling — a standing auto-accept is the
      // point, reclaimed by the kill-switch, not a TTL.
      if (input.expiry_at !== undefined) {
        if (!Number.isFinite(input.expiry_at) || input.expiry_at <= minted_at) {
          throw new QualityDelegationMintError(
            `expiry_at, when set, must be a future epoch-ms timestamp (got ${String(input.expiry_at)})`,
          );
        }
      }
      const contract_id = newId();
      // Defense in depth (matches `mint`): a mis-configured factory must never
      // mint the reserved owner sentinel id.
      if (isReservedOwnerContractId(contract_id)) {
        throw new Error(
          `mintQualityDelegation: newId produced the reserved owner contract id '${contract_id}'`,
        );
      }
      // D-248 Amendment 3 — the PUBLIC sentinel's twin (matches `mint`).
      if (isReservedPublicContractId(contract_id)) {
        throw new Error(
          `mintQualityDelegation: newId produced the reserved public-anonymous id '${contract_id}'`,
        );
      }
      // Construction discipline: only supplied optional fields land on the row
      // (persisted shape == read-back shape). NO `grant_mode` / `risk_tier` /
      // `arg_shape_hash` / payload hash / `max_uses` — the quality axis reads
      // none of them (§5, coarse (recipe, op) grain).
      const def: ContractDefinition = {
        contract_id,
        minted_at,
        minted_by: input.minted_by,
        display_name: input.display_name,
        scope: input.scope,
        grant_kind: 'quality_delegation',
        bound_recipe: input.bound_recipe,
        approved_action_ref: input.approved_action_ref,
        ...(input.expiry_at !== undefined ? { expiry_at: input.expiry_at } : {}),
      };
      store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], def);
      return def;
    },

    mintScopedSessionGrant(input) {
      // Same enforcement-point rationale as the other mints: the value_shape
      // can't express conditional requirements or ceilings, so refusals land
      // here, loudly. Every clause mirrors a fail-closed matcher clause
      // (slice A) — a row violating any of these would be inert anyway.
      if (input.channel_session_id.length === 0) {
        throw new ScopedGrantMintError('channel_session_id must be non-empty (5.c — session-bound)');
      }
      // 5.b/5.d — the ingredient, operation, AND connection axes are never
      // wildcards for a scoped row: the grant admits exactly one catalog op
      // over exactly the named connection(s).
      if (!input.scope.ingredient_ids || input.scope.ingredient_ids.length === 0) {
        throw new ScopedGrantMintError(
          'scope.ingredient_ids must explicitly name the granted ingredient (N.3)',
        );
      }
      if (!input.scope.operation_ids || input.scope.operation_ids.length === 0) {
        throw new ScopedGrantMintError(
          'scope.operation_ids must explicitly name the granted operation (5.b)',
        );
      }
      if (!input.scope.connection_names || input.scope.connection_names.length === 0) {
        throw new ScopedGrantMintError(
          'scope.connection_names must explicitly name the connection (5.c/5.d — none enrolled ⇒ unmintable)',
        );
      }
      if (!(SESSION_GRANT_RISK_TIERS as readonly string[]).includes(input.risk_tier)) {
        throw new ScopedGrantMintError(
          `risk_tier '${input.risk_tier}' is not session-grantable (D7 — read|write|admin only)`,
        );
      }
      if (!(SCOPED_GRANT_SOURCES as readonly string[]).includes(input.scoped_source)) {
        throw new ScopedGrantMintError(
          `scoped_source '${String(input.scoped_source)}' is not in the closed source vocabulary (5.b)`,
        );
      }
      if (input.approved_action_ref.length === 0) {
        throw new ScopedGrantMintError('approved_action_ref must be non-empty');
      }
      // Bounded by construction, ceilings tighten-only (the slice-C code
      // constants — a scoped grant is "this afternoon"-scale; anything
      // longer is delegation-shaped and must go through the N.13 ladder).
      const minted_at = now();
      if (!Number.isFinite(input.expiry_at) || input.expiry_at <= minted_at) {
        throw new ScopedGrantMintError(
          `expiry_at must be a future epoch-ms timestamp (got ${String(input.expiry_at)})`,
        );
      }
      if (input.expiry_at > minted_at + SCOPED_GRANT_TTL_MS_CEILING) {
        throw new ScopedGrantMintError(
          `expiry_at exceeds the scoped-grant TTL ceiling (${String(SCOPED_GRANT_TTL_MS_CEILING)} ms — tighten-only)`,
        );
      }
      if (!Number.isInteger(input.max_uses) || input.max_uses < 1) {
        throw new ScopedGrantMintError(
          `max_uses must be a positive integer (got ${String(input.max_uses)})`,
        );
      }
      if (input.max_uses > SCOPED_GRANT_MAX_USES_CEILING) {
        throw new ScopedGrantMintError(
          `max_uses exceeds the scoped-grant ceiling (${String(SCOPED_GRANT_MAX_USES_CEILING)} — tighten-only)`,
        );
      }
      const contract_id = newId();
      // NO bound_recipe / arg_shape_hash / payload identity lands by
      // construction (the input shape has none — 5.a: an utterance-derived
      // grant has no minting dispatch). The matcher's scoped arm skips those
      // clauses; every other mode still requires them.
      const def: ContractDefinition = {
        contract_id,
        minted_at,
        minted_by: input.minted_by,
        display_name: input.display_name,
        scope: input.scope,
        grant_kind: 'session',
        grant_mode: 'scoped',
        channel_session_id: input.channel_session_id,
        risk_tier: input.risk_tier,
        scoped_source: input.scoped_source,
        approved_action_ref: input.approved_action_ref,
        expiry_at: input.expiry_at,
        max_uses: input.max_uses,
        uses_remaining: input.max_uses,
      };
      store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], def);
      return def;
    },

    mintRawOpGrant(input) {
      // Same enforcement-point rationale as the other gate-grant mints: the
      // value_shape can't express conditional requirements, so refusals land
      // here, loudly. Every clause mirrors a fail-closed matcher clause — a row
      // violating any of these would be inert at the N.4 `'raw_op'` arm anyway.
      if (input.channel_session_id.length === 0) {
        throw new RawOpGrantMintError('channel_session_id must be non-empty (D6 — session-bound)');
      }
      // §8 (codex HIGH fold) — a raw_op grant is minted from ONE approved call
      // to ONE op over ONE connection, so the authority axes bind EXACTLY one
      // value each — never a wildcard (empty) AND never a multi-value set (the
      // matcher admits via `.includes`, so a multi-value axis would turn one
      // approval into a grant spanning every listed op/connection). A broad
      // raw_op grant is unrepresentable at this seam.
      if (!input.scope.ingredient_ids || input.scope.ingredient_ids.length !== 1) {
        throw new RawOpGrantMintError(
          'scope.ingredient_ids must name EXACTLY one catalog ingredient (one approved call binds one op)',
        );
      }
      if (!input.scope.operation_ids || input.scope.operation_ids.length !== 1) {
        throw new RawOpGrantMintError(
          'scope.operation_ids must name EXACTLY one operation (one approved call binds one op)',
        );
      }
      // Connection is optional (ai/entity ops carry none), but when present it
      // binds exactly one — one approved call resolves one connection.
      if (
        input.scope.connection_names !== undefined
        && input.scope.connection_names.length !== 1
      ) {
        throw new RawOpGrantMintError(
          'scope.connection_names, when present, must name EXACTLY one connection (one approved call binds one connection)',
        );
      }
      if (!(SESSION_GRANT_RISK_TIERS as readonly string[]).includes(input.risk_tier)) {
        throw new RawOpGrantMintError(
          `risk_tier '${input.risk_tier}' is not session-grantable (D7 — read|write|admin only)`,
        );
      }
      // Recipe-less EXACT (§8): unlike a scoped grant, a raw-op grant has a
      // minting dispatch, so it pins both the key shape and the exact payload.
      if (input.arg_shape_hash.length === 0) {
        throw new RawOpGrantMintError(
          'arg_shape_hash must be non-empty (recipe-less exact pins the approved call)',
        );
      }
      if (input.canonical_payload_hash.length === 0) {
        throw new RawOpGrantMintError(
          'canonical_payload_hash must be non-empty (recipe-less exact pins the approved call)',
        );
      }
      if (input.approved_action_ref.length === 0) {
        throw new RawOpGrantMintError('approved_action_ref must be non-empty');
      }
      // Bounded by construction (the bounds are the door cell's offer — no
      // separate ceiling, same as `mintSessionGrant`).
      const minted_at = now();
      if (!Number.isFinite(input.expiry_at) || input.expiry_at <= minted_at) {
        throw new RawOpGrantMintError(
          `expiry_at must be a future epoch-ms timestamp (got ${String(input.expiry_at)})`,
        );
      }
      if (!Number.isInteger(input.max_uses) || input.max_uses < 1) {
        throw new RawOpGrantMintError(
          `max_uses must be a positive integer (got ${String(input.max_uses)})`,
        );
      }
      // D-177 N.14.6 — the door binding, same conditional shape as
      // `mintSessionGrant`: present ⇒ non-empty (the matcher treats an empty
      // binding as malformed → inert, so an empty one would mint a row that can
      // never match — refuse at the source instead).
      //
      // ⚠ There is deliberately NO "a door mint REQUIRES a binding" fence to
      // mirror the anonymous one. That fence works for reception because an
      // unbound anonymous row is inert for EVERYONE. An unbound mcp row is not:
      // it is exactly what the OWNER's own stdio client mints and rides. The
      // store sees only `scope`, and a door's scope (`['mcp'] × ['contracted_user']`)
      // is byte-identical to the owner's — it cannot tell them apart, so it must
      // not try. The door clause in the matcher is where that call is made.
      if (
        input.bound_contract_id !== undefined
        && input.bound_contract_id.length === 0
      ) {
        throw new RawOpGrantMintError(
          'bound_contract_id must be non-empty when present (N.14)',
        );
      }
      const contract_id = newId();
      // NO bound_recipe lands by construction (the input shape has none — §8: a
      // raw op has no recipe). The matcher's raw-op arm skips that clause; the
      // arg-shape + exact-payload clauses still apply.
      const def: ContractDefinition = {
        contract_id,
        minted_at,
        minted_by: input.minted_by,
        display_name: input.display_name,
        scope: input.scope,
        grant_kind: 'session',
        grant_mode: 'raw_op',
        channel_session_id: input.channel_session_id,
        risk_tier: input.risk_tier,
        arg_shape_hash: input.arg_shape_hash,
        canonical_payload_hash: input.canonical_payload_hash,
        ...(input.entity_scope !== undefined ? { entity_scope: input.entity_scope } : {}),
        ...(input.bound_contract_id !== undefined
          ? { bound_contract_id: input.bound_contract_id }
          : {}),
        approved_action_ref: input.approved_action_ref,
        expiry_at: input.expiry_at,
        max_uses: input.max_uses,
        uses_remaining: input.max_uses,
      };
      store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], def);
      return def;
    },

    consumeSessionGrant(contract_id, call) {
      const def = read(contract_id);
      // Fail closed on every non-consumable shape: absent row, a standing
      // contract's id (gate-grant consumption must never burn a standing
      // use), or a row that is no longer live (revoked / expired / exhausted
      // since the match). The caller treats `false` as "fall back to hold"
      // (N.4 step 4). N.13 (P6a): `'delegation'` rows consume through the
      // same arms — they share the bounded-by-construction lifecycle.
      if (!def || (def.grant_kind !== 'session' && def.grant_kind !== 'delegation')) {
        return false;
      }
      if (!isContractActive(def, now())) return false;
      // codex HIGH fold — session grants are bounded by construction (the mint
      // requires `max_uses`, seeding `uses_remaining`). A session row with no
      // use counter is malformed/hand-shaped; consuming it would admit an
      // UNMETERED auto-approve loop, so fail closed rather than free-pass.
      if (def.uses_remaining === undefined || def.uses_remaining === null) return false;
      // D-177 N.14 — the door binding re-verify (defense in depth,
      // mirroring the matcher's asymmetric clause): a row carrying
      // `bound_contract_id` spends ONLY for a call supplying the same id,
      // so a resolver bug can never burn a door grant's use on another
      // door's (or the owner's) dispatch. A present-but-empty binding is
      // malformed → inert (same posture as the matcher).
      const boundContract = def.bound_contract_id ?? undefined;
      if (boundContract !== undefined) {
        if (
          typeof boundContract !== 'string'
          || boundContract.length === 0
          || call?.source_contract_id !== boundContract
        ) {
          return false;
        }
      }
      // D-177 P5a — per-mode consumption (N.4). `'batch'` claims a member
      // (the claim IS the consumption); `'open'` (P5b) is hash-verified
      // against the fire's recomputed projection before the decrement;
      // `'exact'` (and the absent⇒exact default) is the plain decrement
      // below.
      const mode = def.grant_mode ?? 'exact';
      // N.13 (P6a, codex MEDIUM fold) — the store re-refuses the delegation
      // VOCABULARY the matcher pins, so a hand-shaped delegation row whose id
      // somehow reaches consumption directly stays inert (defense in depth —
      // the matcher never returns one): no session binding (scope replaces
      // it), `write`-only tier (DELEGATION_RULE_RISK_TIERS, fork 2), and
      // exact/open modes only (a member set is one approval's enumeration —
      // batch is session-only; unknown future modes refuse the same way
      // rather than falling through to the exact decrement).
      if (def.grant_kind === 'delegation') {
        if (def.channel_session_id !== undefined && def.channel_session_id !== null) {
          return false;
        }
        if (
          typeof def.risk_tier !== 'string'
          || !(DELEGATION_RULE_RISK_TIERS as readonly string[]).includes(def.risk_tier)
        ) {
          return false;
        }
        if (mode !== 'exact' && mode !== 'open') return false;
      }
      if (mode === 'open') {
        // D-177 P5b — the caller must supply the FIRE's recomputed
        // `pinned_projection_hash` and it must equal the row's (the
        // matcher already required this; re-verifying at the write means
        // a resolver bug can never spend an open use on a divergent
        // fire — same defense-in-depth as the batch claim). A row missing
        // its own hash is malformed → inert.
        if (
          call?.pinned_projection_hash === undefined
          || call.pinned_projection_hash.length === 0
          || typeof def.pinned_projection_hash !== 'string'
          || def.pinned_projection_hash.length === 0
          || def.pinned_projection_hash !== call.pinned_projection_hash
        ) {
          return false;
        }
        const updated: ContractDefinition = {
          ...def,
          uses_remaining: def.uses_remaining - 1,
        };
        store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], updated);
        return true;
      }
      if (mode === 'batch') {
        // (Delegation rows never reach here — the vocabulary block above
        // refused every non-exact/open delegation mode.)
        if (
          call === undefined
          || call.canonical_payload_hash === undefined
          || call.canonical_payload_hash.length === 0
        ) {
          return false;
        }
        const members = def.batch_members ?? [];
        const idx = members.findIndex(
          (m) =>
            (m.consumed_at === undefined || m.consumed_at === null)
            && m.canonical_payload_hash === call.canonical_payload_hash,
        );
        if (idx === -1) return false;
        const claimed = members.map((m, i) =>
          i === idx ? { ...m, consumed_at: now() } : m,
        );
        const updated: ContractDefinition = {
          ...def,
          batch_members: claimed,
          uses_remaining: def.uses_remaining - 1,
        };
        store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], updated);
        return true;
      }
      if (mode === 'scoped') {
        // D-177 N.11 rule 5 (5.a build constraint) — consumption RE-VERIFIES
        // the 5.d containment the matcher checked: every destination email
        // equal to a candidate sender contributed within the grant window.
        // Session-only (the delegation vocabulary block above refused every
        // non-exact/open delegation mode, so only session rows reach here);
        // an absent call / missing fields / a hand-shaped row without
        // `scoped_source` all refuse — never the plain decrement.
        if (def.grant_kind !== 'session') return false;
        if (call === undefined || !scopedContainmentAdmits(def, call)) {
          return false;
        }
        const updated: ContractDefinition = {
          ...def,
          uses_remaining: def.uses_remaining - 1,
        };
        store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], updated);
        return true;
      }
      if (mode === 'raw_op') {
        // D-182 §8 — recipe-less EXACT: RE-VERIFY the exact payload hash the
        // matcher pinned (defense in depth — mirrors the scoped/open/batch
        // re-verify, so a resolver bug can never spend a raw-op use on a
        // divergent call) then decrement. Session-only (a raw-op grant is never
        // a delegation row — the vocabulary block above refused every non-
        // exact/open delegation mode anyway); an absent call / missing fields /
        // a row without its own payload hash all refuse — never the plain
        // decrement. The matcher also pins `arg_shape_hash`, but re-verifying it
        // here is REDUNDANT: `canonical_payload_hash` is the hash of the full
        // canonical payload, so payload-hash equality IMPLIES key-shape equality
        // (a different shape is a different payload). Re-verifying the payload
        // therefore subsumes the arg-shape re-verify (codex MEDIUM — checked,
        // not folded: the consume `call` carries no `arg_shape_hash` and adding
        // it would gain nothing).
        if (def.grant_kind !== 'session') return false;
        if (
          call === undefined
          || call.canonical_payload_hash === undefined
          || call.canonical_payload_hash.length === 0
          || typeof def.canonical_payload_hash !== 'string'
          || def.canonical_payload_hash.length === 0
          || def.canonical_payload_hash !== call.canonical_payload_hash
        ) {
          return false;
        }
        const updated: ContractDefinition = {
          ...def,
          uses_remaining: def.uses_remaining - 1,
        };
        store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], updated);
        return true;
      }
      // D-177 rule-5 fold (the spec's own warning, 5.a) — the plain
      // decrement is the EXACT arm, not a default: an unknown future
      // `grant_mode` on a JSON row must refuse here exactly as the matcher
      // does, never fall through to an unmetered-semantics decrement.
      if (mode !== 'exact') return false;
      // `isContractActive` already excluded `<= 0`; decrement and persist. The
      // read-check-write runs synchronously with no interleaving point
      // (better-sqlite3), so a concurrent dispatch can't double-spend the
      // final use.
      const updated: ContractDefinition = {
        ...def,
        uses_remaining: def.uses_remaining - 1,
      };
      store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], updated);
      return true;
    },

    claimBatchMember(contract_id, member_id, call) {
      const def = read(contract_id);
      // Same fail-closed posture as `consumeSessionGrant`, plus the mode +
      // member-identity pins: only a live, bounded, `'batch'` session row
      // with THIS member still unconsumed claims. A member an agent replay
      // already consumed returns `false` — the resume re-holds and the
      // approved budget holds exact.
      if (!def || def.grant_kind !== 'session') return false;
      if ((def.grant_mode ?? 'exact') !== 'batch') return false;
      if (!isContractActive(def, now())) return false;
      if (def.uses_remaining === undefined || def.uses_remaining === null) return false;
      // D-177 N.14.6 — the door binding re-verify, BYTE-FOR-BYTE the rule
      // `consumeSessionGrant` applies above and for the same stated reason: a
      // resolver bug must never burn a door grant on another door's (or the
      // owner's) dispatch. This is the OTHER spend path — it decrements
      // `uses_remaining` and burns a member — so without this the invariant "a
      // bound row spends only for its own door" held on consume and said nothing
      // here. (Upstream, `approval-resume-authority` already denies a resume whose
      // bearer rebound — `bearer_binding_changed`. That fence lives in the mcp /
      // llm_gateway resume authority; this one is the store's own, so the
      // invariant does not depend on a distant caller getting it right.)
      // A present-but-empty binding is malformed → inert (same posture as the matcher).
      const boundContract = def.bound_contract_id ?? undefined;
      if (boundContract !== undefined) {
        if (
          typeof boundContract !== 'string'
          || boundContract.length === 0
          || call.source_contract_id !== boundContract
        ) {
          return false;
        }
      }
      // codex HIGH fold — the claim re-verifies the CURRENT envelope
      // against what was approved: arg key-shape at the grant, exact
      // payload at the member. A resumed dispatch whose recipe/args
      // drifted while the ask was outstanding mismatches and re-asks —
      // the member never authorizes unreviewed content.
      if (call.arg_shape_hash.length === 0 || call.canonical_payload_hash.length === 0) {
        return false;
      }
      if (def.arg_shape_hash !== call.arg_shape_hash) return false;
      const members = def.batch_members ?? [];
      const idx = members.findIndex((m) => m.member_id === member_id);
      if (idx === -1) return false;
      const target = members[idx];
      if (target.canonical_payload_hash !== call.canonical_payload_hash) {
        return false;
      }
      if (target.consumed_at !== undefined && target.consumed_at !== null) {
        return false;
      }
      const claimed = members.map((m, i) =>
        i === idx ? { ...m, consumed_at: now() } : m,
      );
      const updated: ContractDefinition = {
        ...def,
        batch_members: claimed,
        uses_remaining: def.uses_remaining - 1,
      };
      store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], updated);
      return true;
    },
  };
};
