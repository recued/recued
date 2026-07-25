/** D-166 — `contract_id` lifecycle: typed `contract_definition` / `contract_scope`
 *  shapes + pure lifecycle predicates.
 *
 *  D-148's `(channel × actor × contract_id)` policy matrix referenced `contract_id`
 *  values but never defined them; D-166 closes the gap with a `contract_definition`
 *  row (stored under `contract.contract_definition.<contract_id>`, schema in
 *  `contract-schema.ts`). A contract is MINTED by the user with an explicit
 *  `ContractScope`, immutable `minted_at` / `minted_by` provenance, and optional
 *  `expiry_at` / `max_uses` / `approved_actions_template`. It is USED when a
 *  gateway dispatch resolves a call against it (the use-resolution slice decrements
 *  `uses_remaining`); it EXPIRES when `expiry_at` passes or `uses_remaining` hits 0;
 *  it is REVOKED when the user sets `revoked_at` + `revocation_reason`.
 *
 *  This module is the PURE substrate: the storage-level mint / use / expire / revoke
 *  operations (which need a clock + id-gen) live in the store slice, and the
 *  use-resolution gating (active-check + the snapshot-aware re-wire of the parked
 *  `policy-matrix-dispatch` overlay over `.<contract_id>` rows) is a later slice.
 *  The predicates here — `contractLifecycleState` / `isContractActive` /
 *  `contractScopeMatches` — are what those slices call.
 *
 *  Spec: D-166 §"contract_definition (new — contract_id lifecycle)". */

import type { Actor, Channel } from './commits.js';
import type { RiskTier } from './ingredient.js';

/** The `composite_keys` scope name a contract_definition row is keyed under (a
 *  row lives at `contract.contract_definition.<contract_id>`). The store mints /
 *  uses / revokes rows under it; the use-resolution slice reads them. Mirrors
 *  `OVERRIDE_SCOPE` (`contract-override.ts`) / `POLICY_MATRIX_SCOPE`
 *  (`policy-matrix.ts`) — the canonical scope-name constant lives beside the
 *  shapes it keys, so callers never hand-write the literal. */
export const CONTRACT_DEFINITION_SCOPE = 'contract_definition';

// ════════════════════════════════════════════════════════════════
// OWNER_CONTRACT_ID — the canonical owner-contract id (D-187 AMENDMENT)
// ════════════════════════════════════════════════════════════════

/** D-187 AMENDMENT — the canonical OWNER contract id. The owner runs their own
 *  AI-bearing channels (`chat` / `webclient` / `messenger`) on the implicit
 *  `user_self` contract (the policy-matrix `(channel, user_self)` baseline cell,
 *  surfaced as "Owner (you)" per D-177), so the owner's grant rows live under
 *  `contract.contract_grant.user_self.<entry_key>`. The owner contract is DERIVED
 *  at the gate from an owner-AI source (`resolveGrantGoverningContractId`), never a
 *  bound door, and seeded complete by the boot reconcile.
 *
 *  `'user_self'` deliberately reuses the `user_self` {@link Actor} literal as the
 *  contract id; the actor/contract_id conflation is neutralised by the
 *  provenance-keyed governing-contract resolver + the {@link isReservedOwnerContractId}
 *  bind/mint fence (an explicit `contract_id: 'user_self'` on a contracted source is
 *  NEVER the owner). Hoisted here (grant-foundation slice 3, value unchanged) so the
 *  server gate and the D-174 webclient grant UI import ONE source of truth instead
 *  of each hardcoding the literal. */
export const OWNER_CONTRACT_ID = 'user_self';

/** True iff `contract_id` is the reserved OWNER sentinel. A door / standing
 *  contract may NEVER be bound (MCP token → contract) or minted
 *  (`contract.definition`) with this id: the owner contract is DERIVED from an
 *  owner-AI source at the gate (`resolveGrantGoverningContractId`), never a bound
 *  door. The binding / mint boundary rejects it so a door can't claim
 *  `OWNER_CONTRACT_ID` and inherit the owner's permissive grant rows — defense in
 *  depth alongside the gate-level fence in `gateStandingContractId` (codex 3b
 *  HIGH). */
export const isReservedOwnerContractId = (contract_id: string): boolean =>
  contract_id === OWNER_CONTRACT_ID;

/** D-207 slice 1b — the reserved PUBLIC sentinel: the seeded, undeletable, DENY-BY-
 *  DEFAULT contract that governs an anonymous reception dispatch which resolves no
 *  per-recipe contract of its own.
 *
 *  It is the twin of {@link OWNER_CONTRACT_ID} and its exact inverse: the owner
 *  sentinel is seeded PERMISSIVE (author-default `true`), this one is seeded to grant
 *  NOTHING. Both are derived at the gate, never bound to a door, and neither has a
 *  `contract_definition` lifecycle that can expire.
 *
 *  WHY it must exist — the revoke that doesn't revoke. Before D-207,
 *  `resolveGrantGoverningContractId` returned `undefined` for `(reception, anonymous)`,
 *  and `isOpGranted` reads `undefined` as "contract-free → no grant gate" → it returns
 *  `true` and the ACCESS gate is SKIPPED ENTIRELY. So an owner who deleted a paired
 *  recipe's contract while leaving the pair enabled would not tighten the door — they
 *  would BLOW IT OPEN. A public dispatch must therefore never be able to resolve to
 *  "no contract"; it falls back HERE, and here grants nothing.
 *
 *  ⚠ Fail-closed does NOT come from an empty scope. `opAuthorDefault` reads an empty /
 *  absent `scope.operation_ids` as a WILDCARD door and returns `true` (permissive) —
 *  so a "grants nothing" contract expressed as an empty scope would fail OPEN, and a
 *  paired recipe whose derived op closure is legitimately empty (a pure-transform
 *  recipe) would take a wildcard door. Deny-by-default is instead carried by
 *  `usesExplicitOnlyGrantDefaults`, which this sentinel and every reception-door
 *  contract opt into: ONLY an explicit `contract_grant` row authorizes an op. */
export const PUBLIC_CONTRACT_ID = 'public_anonymous';

/** True iff `contract_id` is the reserved PUBLIC sentinel. Like the owner sentinel it
 *  may NEVER be bound to a door or minted through `contract.definition`: it is derived
 *  at the gate as the fail-closed floor for an anonymous public dispatch. Binding it
 *  would let a door claim the sentinel — harmless today (it grants nothing) but the
 *  fence is kept symmetric with the owner's so the two can never drift. */
export const isReservedPublicContractId = (contract_id: string): boolean =>
  contract_id === PUBLIC_CONTRACT_ID;

// ════════════════════════════════════════════════════════════════
// DoorType — the level-1 "which externally-reachable door" axis (D-187 §6)
// ════════════════════════════════════════════════════════════════

/** D-187 §6 (grant-foundation slice 3b, step 7) — the closed set of DOOR TYPES a
 *  contract may be enabled to back. A "door" is a user-facing externally-reachable
 *  entry point (D-171); its TYPE is the coarse level-1 switch that sits ABOVE the
 *  per-entry `contract_grant` grants (ops / collections / topics):
 *
 *    - `'mcp'`      — the MCP TOOLS door: an external agent calling Recued tools over
 *                     the HTTP / WS MCP transport. Dispatches as `(channel: 'mcp',
 *                     actor: 'contracted_user')`.
 *    - `'mcp_chat'` — the MCP CHAT door: an external agent invoking the owner's chat
 *                     AI. `mcp_chat` is a `RecuedRequestSurface` (`recued-request.ts`),
 *                     NOT a policy `Channel` — it RESOLVES to the `'chat'` channel.
 *    - `'llm_gateway'` — the OpenAI-compatible HTTP chat-completions door. It is
 *                        a door type, not a customer tier/model selector; runtime
 *                        routing is configured outside this contract vocabulary.
 *
 *  This is WHY the door type is its OWN field on the contract, distinct from the
 *  `scope.channels` policy-channel axis (the spec §6 distinction): `scope.channels`
 *  is the RESOLVED channel a dispatch runs on (an `mcp_chat` door would read `'chat'`
 *  there — indistinguishable from the owner's own chat or any other chat door); the
 *  door type is the ENTRY POINT the connection was established through, fixed at the
 *  `token → contract_id` binding. The level-1 gate ({@link contractPermitsDoorType})
 *  checks the door type at connection establishment, before any per-entry grant.
 *
 *  Closed at the type level; a new door type adds a row here, an enum literal in the
 *  `contract_definition.door_types` value_shape (`contract-schema.ts`), and a gate
 *  site at the corresponding connection-establishment boundary. */
export const DOOR_TYPES = ['mcp', 'mcp_chat', 'llm_gateway', 'reception', 'webhook'] as const;

/** String-literal union derived from {@link DOOR_TYPES}. */
export type DoorType = (typeof DOOR_TYPES)[number];

/** D-207 slice 1b — the door types an owner may HAND-AUTHOR in the Contracts UI.
 *
 *  `'reception'` is deliberately EXCLUDED. A reception door is not authored, it is
 *  DERIVED: `bindReceptionDoor` mints it from a (form, recipe) pair, with a scope computed
 *  by `deriveRecipeCapability` and a `contract_id` the pair row points at. A hand-minted
 *  reception contract would have no pair pointing at it, so no dispatch could ever resolve
 *  to it — an inert row that looks like a live public door. It would also invite an owner
 *  to author a scope by hand where the whole point is that the scope is derived from what
 *  the recipe actually does.
 *
 *  `'webhook'` (D-209 #1) is excluded for the same reason — a webhook door is DERIVED at
 *  enrollment (the owner wires a vendor webhook to a recipe; the trigger row carries the
 *  minted `contract_id`) — plus D-171 decision 8: webhook is not a row in the owner-facing
 *  door LIST either; its contract is pure dispatch substrate.
 *
 *  Keep this list and {@link DOOR_TYPES} distinct: the latter is what a contract may BACK,
 *  this is what a human may CREATE. */
export const AUTHORABLE_DOOR_TYPES = ['mcp', 'mcp_chat', 'llm_gateway'] as const;

/** Predicate — true when `value` is a known {@link DoorType}. */
export const isDoorType = (value: unknown): value is DoorType =>
  typeof value === 'string' && (DOOR_TYPES as readonly string[]).includes(value);

/** String-literal union derived from {@link AUTHORABLE_DOOR_TYPES}. */
export type AuthorableDoorType = (typeof AUTHORABLE_DOOR_TYPES)[number];

/** A door type that is MINTED, never hand-authored — the type-level complement
 *  of {@link AuthorableDoorType} inside {@link DoorType}. A `Record` keyed on
 *  this union is the exhaustiveness pin for per-derived-door UI (labels,
 *  badges): adding a sixth door type that is derived fails compilation at
 *  every such record instead of silently falling through. */
export type DerivedDoorType = Exclude<DoorType, AuthorableDoorType>;

/** D-209 Task 3 — the derived (mint-only) door types, computed as
 *  DOOR_TYPES \ AUTHORABLE_DOOR_TYPES so the partition lives in ONE place.
 *  A derived door's contract is stamped with exactly one of these in
 *  `door_types` at mint (`mintDoorContract`); neither is hand-authorable, so
 *  EXPLICIT membership is proof of a mint — which is what
 *  {@link derivedDoorType} classifies on. A wildcard (absent/empty
 *  `door_types`) agent door BACKS these types but was never minted for them
 *  and must not classify as derived. */
export const DERIVED_DOOR_TYPES: readonly DerivedDoorType[] = DOOR_TYPES.filter(
  (t): t is DerivedDoorType =>
    !(AUTHORABLE_DOOR_TYPES as readonly string[]).includes(t),
);

/** The derived door type a contract was minted for, from EXPLICIT
 *  `door_types` membership — or null for hand-authored agents (wildcard
 *  included), self, and anything else. */
export const derivedDoorType = (
  doorTypes: ReadonlyArray<DoorType> | undefined,
): DerivedDoorType | null =>
  DERIVED_DOOR_TYPES.find((t) => doorTypes?.includes(t)) ?? null;

// ════════════════════════════════════════════════════════════════
// ContractGrantKind — the `contract_definition.grant_kind` discriminator
// ════════════════════════════════════════════════════════════════

/** D-177 / D-196 / D-202 — the closed stored vocabulary for
 *  `contract_definition.grant_kind`. Absent still means `'standing'` for legacy
 *  standing contracts. D-196 adds customer templates / instances as explicit
 *  literals so every pre-seller consumer can fail closed instead of accidentally
 *  treating them as standing rows. D-202 adds `'quality_delegation'` — the
 *  owner-minted SECOND delegation axis ("auto-accept this op's output QUALITY"),
 *  a sibling of `'delegation'` (the authorization axis) minted the same
 *  suggest→accept way but consumed on the quality conjunct at the gate
 *  (`quality-delegation.ts`), inert in every authorization-grant consumer. */
export const CONTRACT_GRANT_KINDS = [
  'standing',
  'session',
  'delegation',
  'customer_template',
  'customer_instance',
  'quality_delegation',
] as const;

export type ContractGrantKind = (typeof CONTRACT_GRANT_KINDS)[number];

export const isContractGrantKind = (value: unknown): value is ContractGrantKind =>
  typeof value === 'string'
  && (CONTRACT_GRANT_KINDS as readonly string[]).includes(value);

// ════════════════════════════════════════════════════════════════
// ContractScope — what a minted contract authorizes
// ════════════════════════════════════════════════════════════════

/** The `(channels × actors × ingredient_ids × operation_ids × connection_names)`
 *  surface a contract authorizes (value_shape `contract_scope`). An EMPTY (or
 *  absent) array on an axis means "any" — the spec's wildcard. The stored shape is
 *  string arrays (the value-shape `types` are `string[]`); matching is by string
 *  equality. Every axis is optional so `{}` is a valid "any/any/any/any/any" scope. */
export interface ContractScope {
  readonly channels?: ReadonlyArray<string>;
  readonly actors?: ReadonlyArray<string>;
  readonly ingredient_ids?: ReadonlyArray<string>;
  readonly operation_ids?: ReadonlyArray<string>;
  readonly connection_names?: ReadonlyArray<string>;
}

// ════════════════════════════════════════════════════════════════
// ContractDefinition — the contract_id lifecycle record
// ════════════════════════════════════════════════════════════════

/** D-177 N.3 — the recipe identity a session grant is bound to. Both fields must
 *  EQUAL the dispatching run's identity for the grant to match (N.4 common
 *  predicate); pinning `recipe_hash` makes recipe-content drift invalidate the
 *  grant naturally — a re-authored recipe re-asks, no drift detector needed. */
export interface BoundRecipeRef {
  readonly recipe_id: string;
  readonly recipe_hash: string;
}

/** D-177 N.10 — one member of a `grant_mode: 'batch'` session grant. `member_id`
 *  is the stable per-item identity (duplicate payload hashes stay DISTINCT
 *  members); a dispatch atomically CLAIMS one unconsumed member by stamping
 *  `consumed_at` (claim + `uses_remaining` decrement in one transaction). A
 *  claimed member never matches again — replay of an approved-and-dispatched
 *  item holds for a fresh approval. Consumption machinery lands in P5a. */
export interface SessionGrantBatchMember {
  readonly member_id: string;
  readonly canonical_payload_hash: string;
  /** Epoch-ms the member was claimed by a dispatch. Absent ⇒ unconsumed. */
  readonly consumed_at?: number;
}

/** A minted contract (value_shape `contract_definition`, keyed by `contract_id`).
 *  `minted_at` / `expiry_at` / `revoked_at` are epoch-ms (the store's `datetime`
 *  convention). The 5 required fields (`contract_id` / `minted_at` / `minted_by` /
 *  `display_name` / `scope`) are present on every row; the rest are optional and
 *  absent means "unbounded" (`expiry_at` / `max_uses` / `uses_remaining`) or
 *  "not revoked" (`revoked_at` / `revocation_reason`).
 *
 *  D-177 N.3 — a row is a STANDING contract (`grant_kind` absent or
 *  `'standing'`: every D-166/D-171 row — user-minted policy, merged at the
 *  policy gates), a SESSION GRANT (`grant_kind: 'session'`: server-minted by
 *  the approval layer, consumed at the Gateway's ask-branch — never merged
 *  through the policy algebra, D2), or — D-177 N.13 — a DELEGATION RULE
 *  (`grant_kind: 'delegation'`: the ladder-6 standing rule; same gate-consumed
 *  grant shape as a session row but bound by SCOPE instead of a channel
 *  session, minted ONLY by the owner accepting a staged-trust suggestion —
 *  never by background learning, N.9.7). Session rows and delegation rules
 *  reuse the whole lifecycle verbatim (expiry / max_uses / revoke /
 *  `isContractActive`) and add the value-shape fields below; they are never
 *  returned to a model as a bearer secret and surface only in the
 *  active-limits inspector. UNLIKE standing rows, both grant kinds are
 *  BOUNDED by construction: `expiry_at` + `max_uses` are required at mint
 *  (the N.11 confirm sentence's "for [TTL], up to [N] times" each map onto an
 *  enforced bound), and the matcher + consumption fail closed on a grant row
 *  missing either. */
export interface ContractDefinition {
  readonly contract_id: string;
  readonly minted_at: number;
  readonly minted_by: string;
  readonly display_name: string;
  readonly scope: ContractScope;
  /** D-187 §6 (step 7) — the level-1 DOOR TYPES this contract may back
   *  ({@link DoorType}). EMPTY or ABSENT = wildcard ("any door type") — the same
   *  "empty axis = any" convention {@link ContractScope} uses, and the
   *  behaviour-preserving default at zero installs (a contract minted with no
   *  door-type restriction backs whatever door binds it). A NON-empty list is a
   *  RESTRICTION: the contract may back ONLY the named door types, and a
   *  connection establishing on any other door type is rejected at the
   *  `token → contract_id` binding (the HTTP MCP transport's level-1 gate;
   *  {@link contractPermitsDoorType}). DISTINCT from `scope.channels` — a door
   *  type is the entry point, not the resolved policy channel. */
  readonly door_types?: ReadonlyArray<DoorType>;
  /** D-209 #1 — the DOOR's authored stage-trust ceiling. Resolved onto the
   *  dispatch `ContractSnapshot` by the door's snapshot builder and read by
   *  `resolveTrustCeiling` in preference to the flat contracted default. Today
   *  only a webhook door mint writes it (`'admin'` — the owner's two-sided
   *  enrollment IS the standing approval, D-209 §1.4); a reception door NEVER
   *  carries it, and the reader pins an `anonymous` reception dispatch at
   *  `read` regardless (the rev-5 F3 rule). Absent ⇒ the contracted LOW
   *  default. Vocabulary mirrors `override_policy.max_risk_without_approval`
   *  (`none` = approve everything; `destructive` has no place on a ceiling). */
  readonly max_risk_without_approval?: 'read' | 'write' | 'admin' | 'none';
  /** Pre-authorized actions that bypass per-call approval (opaque `json`; the
   *  use-resolution slice interprets it). */
  readonly approved_actions_template?: unknown;
  /** Epoch-ms after which the contract is inert. Absent ⇒ never time-expires. */
  readonly expiry_at?: number;
  /** Total dispatches the contract permits. Absent ⇒ unlimited. */
  readonly max_uses?: number;
  /** Dispatches left (decremented on use). Absent ⇒ unlimited; `<= 0` ⇒ exhausted. */
  readonly uses_remaining?: number;
  /** Epoch-ms the user revoked at. Absent ⇒ not revoked. */
  readonly revoked_at?: number;
  readonly revocation_reason?: string;

  // ── D-177 N.3 — gate-grant extension (absent on every standing row) ──
  /** Row discriminator. Absent ⇒ `'standing'` (every pre-D-177 row); the
   *  session matcher requires the EXPLICIT `'session'` literal and the
   *  delegation matcher the EXPLICIT `'delegation'` literal (N.13) — each
   *  fails closed on every other value, so future vocabulary stays inert.
   *  D-196 customer templates / instances are also explicit literals: they are
   *  inert in standing-contract consumers unless seller-specific code opts in. */
  readonly grant_kind?: ContractGrantKind;
  /** Session rows only. Absent ⇒ `'exact'`; an unrecognized value never
   *  matches (N.4 fail-closed). `'batch'` (N.10) / `'open'` (N.11) machinery
   *  lands in P5a/P5b; `'scoped'` (N.11 rule 5, rev 10) is the
   *  utterance-derived session-scope overlay — session-only, enforced by
   *  structured-field equality against a per-session forwarded-sender
   *  candidate index, never by payload/projection hashes. `'raw_op'` (D-182 §8)
   *  is the recipe-less raw-op door grant — a session grant minted from a
   *  human's per-call approval of a door's raw catalog op: it has a minting
   *  dispatch (so it keeps the `arg_shape_hash` + exact `canonical_payload_hash`
   *  identity) but NO `bound_recipe` (there is no recipe), binding instead on
   *  the explicit op (ingredient + operation) + connection scope. Session-only
   *  in v1. */
  readonly grant_mode?: 'exact' | 'batch' | 'open' | 'scoped' | 'raw_op';
  /** REQUIRED on session rows (D6) — the D-153 tier-1 channel session the
   *  grant is bound to. The session index keys lookups on it. */
  readonly channel_session_id?: string;
  /** REQUIRED on session rows — the minting run's recipe identity (N.4). */
  readonly bound_recipe?: BoundRecipeRef;
  /** D-177 N.14 — the DOOR binding: the governing door contract's
   *  `contract_id` from the minting dispatch's `ExecutionSource.contract_id`.
   *  A row binding like {@link bound_recipe} (deliberately NOT a
   *  `ContractScope` axis — a binding is exact-or-nothing, never a
   *  wildcard). Stamped on gate grants minted from a door hold (v1: the
   *  reception door); matched fail-closed ASYMMETRIC in `matchesGateGrant`:
   *  a row carrying it requires ctx equality, and an `anonymous`-actor ctx
   *  NEVER matches a row that lacks it (an unbound owner rule must not fan
   *  onto doors — the exact hazard the N.13 owner-only pin guarded before
   *  this dimension existed). Absent on standing rows and on every
   *  owner-minted (`user_self`) grant. */
  readonly bound_contract_id?: string;
  /** REQUIRED on session rows — the approved envelope's arg KEY-SHAPE hash;
   *  shape drift fails the match (N.4 common predicate). */
  readonly arg_shape_hash?: string;
  /** `'exact'` mode: the ONE approved resolved-payload hash. */
  readonly canonical_payload_hash?: string;
  /** D-177 P3 (codex HIGH fold) — REQUIRED on session rows: the risk tier the
   *  human approved (the resume decision's tier, equal to the offered tier by
   *  the mint precondition). The matcher requires EQUALITY with the
   *  envelope's tier — D7's set-membership check alone would let a grant
   *  minted for a `write` envelope absorb a later `admin`-tier ask for the
   *  same call after manifest/policy drift re-classifies the tool. */
  readonly risk_tier?: RiskTier;
  /** `'batch'` mode (N.10): the approved member set. */
  readonly batch_members?: ReadonlyArray<SessionGrantBatchMember>;
  /** `'open'` mode (N.11 rule 6): hash over ALL tainted-root resolved values. */
  readonly pinned_projection_hash?: string;
  /** `'open'` mode (N.11 rule 6): per authority-bearing arg — root refs, origin
   *  classes, pinned values, clean-root anchor ids. Opaque until P5b's walker. */
  readonly open_projection?: unknown;
  /** Primary-entity binding when the minting op declared one (N.1). Matched
   *  both-absent-or-equal against the envelope. */
  readonly entity_scope?: string;
  /** Checkpoint/audit anchor of the minting approval (D8). */
  readonly approved_action_ref?: string;
  /** `'scoped'` mode (N.11 rule 5) — the closed source vocabulary the grant's
   *  candidate set draws from. REQUIRED on scoped rows; anything outside
   *  {@link SCOPED_GRANT_SOURCES} (or absent) leaves the row inert (5.b:
   *  off-vocabulary is a no-parse, and a hand-shaped row fails closed). */
  readonly scoped_source?: ScopedGrantSource;
}

/** D-177 N.11 rule 5 (rev 10, 5.b) — the closed `'scoped'`-mode source enum.
 *  v1 is exactly `'forwarded_item_sender'` (codex HIGH fold): the STRUCTURED
 *  sender/from field of a mail item the USER forwarded into the session
 *  during the grant window — never an address appearing in body / signature /
 *  quoted chain (5.e.i), and never a free-typed or model-solicited address
 *  (5.e.iv). Widening this list is a deliberate spec amendment. */
export const SCOPED_GRANT_SOURCES = ['forwarded_item_sender'] as const;
export type ScopedGrantSource = (typeof SCOPED_GRANT_SOURCES)[number];

// ════════════════════════════════════════════════════════════════
// Lifecycle predicates (pure)
// ════════════════════════════════════════════════════════════════

/** A contract's resolved lifecycle state at a given instant. `'active'` is the
 *  only state a dispatch matches; the other three are inert. Precedence when more
 *  than one inert condition holds: `revoked` (explicit, has provenance) →
 *  `expired` (time) → `exhausted` (uses), so the most deliberate cause surfaces. */
export type ContractLifecycleState = 'active' | 'revoked' | 'expired' | 'exhausted';

/** Resolve a contract's lifecycle state at `nowMs` (epoch-ms). Pure. */
export const contractLifecycleState = (
  def: ContractDefinition,
  nowMs: number,
): ContractLifecycleState => {
  if (def.revoked_at !== undefined && def.revoked_at !== null) return 'revoked';
  if (def.expiry_at !== undefined && def.expiry_at !== null && def.expiry_at < nowMs) {
    return 'expired';
  }
  if (
    def.uses_remaining !== undefined
    && def.uses_remaining !== null
    && def.uses_remaining <= 0
  ) {
    return 'exhausted';
  }
  return 'active';
};

/** True iff the contract is `'active'` at `nowMs` — not revoked, not past its
 *  `expiry_at`, and not out of `uses_remaining`. The gate the use-resolution slice
 *  checks before a `.<contract_id>` overlay applies. Pure. */
export const isContractActive = (def: ContractDefinition, nowMs: number): boolean =>
  contractLifecycleState(def, nowMs) === 'active';

/** D-187 §6 (step 7) — true iff `def` is enabled to back a door of type
 *  `doorType`. The level-1 door-type gate, evaluated at connection establishment
 *  (the `token → contract_id` binding). An EMPTY or ABSENT `door_types` is a
 *  WILDCARD — the contract backs ANY door type (the {@link contractScopeMatches}
 *  "empty axis = any" convention, and the behaviour-preserving default at zero
 *  installs). A NON-empty `door_types` is a restriction: the contract backs ONLY
 *  the named types, so the ONLY way this returns `false` is an explicit door-type
 *  list that does not include `doorType`. Independent of lifecycle — the caller
 *  ANDs liveness (`isContractActive`) separately; a door-type mismatch is a
 *  configuration rejection, not a kill-switch. Pure. */
export const contractPermitsDoorType = (
  def: ContractDefinition,
  doorType: DoorType,
): boolean => {
  if (def.door_types === undefined || def.door_types.length === 0) return true;
  return def.door_types.includes(doorType);
};

/** True iff a row is an ordinary standing policy / door contract. This is the
 *  only default-open interpretation: absent/null/explicit `'standing'`.
 *  Every other known or future `grant_kind` is non-standing and must be
 *  handled by an opt-in consumer. */
export const isStandingContractDefinition = (
  def: Pick<ContractDefinition, 'grant_kind'>,
): boolean =>
  def.grant_kind === undefined
  || def.grant_kind === null
  || def.grant_kind === 'standing';

/** D-196 seller rows are managed on Seller-specific surfaces, not the generic
 *  non-seller contract inventories. */
export const isCustomerContractGrantKind = (
  value: unknown,
): value is Extract<ContractGrantKind, 'customer_template' | 'customer_instance'> =>
  value === 'customer_template' || value === 'customer_instance';

/** D-202 — true iff a row is a QUALITY delegation (the second delegation axis).
 *  The quality matcher (`matchesQualityDelegation`, `quality-delegation.ts`)
 *  requires this EXPLICIT literal and fails closed on every other value, so a
 *  quality delegation stays inert in every authorization-grant consumer (and
 *  vice-versa) — the disjoint-vocabulary posture the session/delegation kinds
 *  already hold. */
export const isQualityDelegation = (
  def: Pick<ContractDefinition, 'grant_kind'>,
): boolean => def.grant_kind === 'quality_delegation';

// ════════════════════════════════════════════════════════════════
// rpc DTOs — the `collection.contract.{mintContract,revokeContract,listContracts}` surface
// ════════════════════════════════════════════════════════════════

/** The `collection.contract.mintContract` wire request. `minted_by` is NOT a
 *  field — the handler stamps it from the authenticated client's provenance
 *  (the operator's device display name), and `contract_id` / `minted_at` are
 *  store-generated; everything here is the user's. `max_uses`, when present,
 *  seeds the contract's `uses_remaining`; `expiry_at` is epoch-ms. This is the
 *  user-supplied subset of {@link ContractDefinition} — the owner Contracts
 *  authoring surface is its sole writer (the family is reserved out of MCP). */
export interface MintContractRequest {
  /** Human-facing label for the owner Contracts row. */
  display_name: string;
  /** D-196 R3 — opt into the Seller customer-template authoring lane. Omit for
   * an ordinary standing agent contract. `customer_instance` is deliberately
   * unrepresentable here: only the server-side customer lifecycle may stamp
   * those rows from a selected template. */
  grant_kind?: 'customer_template';
  /** The surface the contract authorizes. An empty/absent axis is a wildcard;
   *  `{}` authorizes every channel × actor × ingredient × operation × connection. */
  scope: ContractScope;
  /** D-187 §6 (step 7) — the level-1 door types this contract may back
   *  ({@link DoorType}). Omit or `[]` = wildcard (any door type — the
   *  behaviour-preserving default). A non-empty list restricts the contract to
   *  ONLY those door types; see {@link ContractDefinition.door_types}. */
  door_types?: ReadonlyArray<DoorType>;
  /** Pre-authorized actions that bypass per-call approval (opaque). Omit for none. */
  approved_actions_template?: unknown;
  /** Epoch-ms after which the contract time-expires. Omit for never. */
  expiry_at?: number;
  /** Total dispatches the contract permits — seeds `uses_remaining`. Omit for
   *  unlimited. */
  max_uses?: number;
}

/** D-187 §6 (step 7 follow-on) — the `collection.contract.setDoorTypes` wire
 *  request: REPLACE an existing contract's level-1 {@link ContractDefinition.door_types}
 *  IN PLACE (no re-mint, so the `contract_id` + any bound MCP token survive — a
 *  re-mint would change the id and break the binding). `door_types` is REQUIRED:
 *  a (possibly empty) array — `[]` CLEARS the restriction (wildcard), a non-empty
 *  array RESTRICTS the contract to exactly those door types. Settings-only (the
 *  `collection.contract.*` family is reserved out of MCP — an agent must never
 *  reconfigure its own door). Returns the updated {@link ContractDefinitionView}. */
export interface SetContractDoorTypesRequest {
  contract_id: string;
  door_types: ReadonlyArray<DoorType>;
}

/** A {@link ContractDefinition} projected for the rpc + the Settings → Privacy →
 *  Contracts UI, with the server-resolved {@link ContractLifecycleState} attached
 *  (computed at response time via {@link contractLifecycleState}) so the UI renders
 *  the active / revoked / expired / exhausted pill without re-deriving it from
 *  the timestamps + a client clock. Returned by all three lifecycle methods. */
export interface ContractDefinitionView extends ContractDefinition {
  readonly lifecycle_state: ContractLifecycleState;
}

/** A bounded page over the owner-only contract inventory.
 *
 *  All fields are optional so the pre-pagination `void` / `{ grant_kind }`
 *  callers remain wire-compatible. `contract_id` is the direct-detail lookup
 *  seam used by deep links. The derived-door selectors let paged UIs separate
 *  server-managed reception/webhook contracts from human-authored standing
 *  contracts without deleting or weakening either family at the gate. */
export interface ContractListRequest {
  readonly grant_kind?: ContractGrantKind;
  readonly contract_id?: string;
  readonly exclude_derived_doors?: boolean;
  readonly derived_doors_only?: boolean;
  readonly limit?: number;
  /** Opaque keyset cursor returned by the previous page. */
  readonly cursor?: string;
}

/** `next_cursor` / `total` are present for bounded requests and omitted for
 *  legacy unbounded calls, preserving the old response shape for existing
 *  consumers. */
export interface ContractListResponse {
  readonly contracts: ContractDefinitionView[];
  readonly next_cursor?: string | null;
  readonly total?: number;
}

/** A dispatch's identity, matched against a `ContractScope`. `channel` / `actor`
 *  are always known (the `ExecutionSource` discriminants); the per-call axes are
 *  supplied when the dispatch resolves them. */
export interface ContractScopeContext {
  readonly channel: Channel;
  readonly actor: Actor;
  readonly ingredient_id?: string;
  readonly operation_id?: string;
  readonly connection_name?: string;
}

/** True when `scope` admits `ctx`. An EMPTY (or absent) scope axis is a wildcard
 *  (matches anything); a NON-empty axis must CONTAIN the ctx value. A per-call axis
 *  the ctx leaves undefined is only constraining when the scope restricts it — a
 *  scope that names `ingredient_ids` but a ctx with no `ingredient_id` does NOT
 *  match (the dispatch can't prove it's in-scope), failing closed. `channel` /
 *  `actor` are always present, so their axes always evaluate. Pure. */
export const contractScopeMatches = (
  scope: ContractScope,
  ctx: ContractScopeContext,
): boolean => {
  const axisAdmits = (
    allowed: ReadonlyArray<string> | undefined,
    value: string | undefined,
  ): boolean => {
    if (allowed === undefined || allowed.length === 0) return true; // wildcard
    return value !== undefined && allowed.includes(value);
  };
  return (
    axisAdmits(scope.channels, ctx.channel)
    && axisAdmits(scope.actors, ctx.actor)
    && axisAdmits(scope.ingredient_ids, ctx.ingredient_id)
    && axisAdmits(scope.operation_ids, ctx.operation_id)
    && axisAdmits(scope.connection_names, ctx.connection_name)
  );
};

// ════════════════════════════════════════════════════════════════
// D-186 Slice C — session-grant live-control surface
// (`collection.contract.session_grant.{list,revoke}`)
// ════════════════════════════════════════════════════════════════

/** The op-scope axes a session grant authorizes, projected for the live-control
 *  bubble. Drawn from the grant's {@link ContractScope}; the always-singleton
 *  `channels` / `actors` axes are dropped (they carry no user-facing signal for
 *  "what does this pass let through") — only the op-relevant axes surface so the
 *  "Active passes" row can render "what it permits" without leaking the full
 *  scope blob. An empty/absent axis means "any". */
export interface SessionGrantPermits {
  readonly ingredient_ids?: ReadonlyArray<string>;
  readonly operation_ids?: ReadonlyArray<string>;
  readonly connection_names?: ReadonlyArray<string>;
}

/** D-186 Slice C — a `grant_kind: 'session'` row projected for the live-control
 *  "Active passes" surface. A compact, render-ready view (NOT the full
 *  {@link ContractDefinition} — none of the identity hashes / projections leak
 *  here; a grant is never a bearer secret, N.3): what it permits, its mode, how
 *  long it has left, and the budget. `remaining_ttl_ms` is the server snapshot
 *  at list time (clamped ≥ 0); `expiry_at` is carried so the client can recompute
 *  the countdown at render time without a round-trip (and drop a pass once it
 *  hits zero). `lifecycle_state` is the server-resolved state (the list returns
 *  only `'active'` rows, but a `revoke` echoes back the now-`'revoked'` view). */
export interface SessionGrantView {
  readonly contract_id: string;
  /** Human label minted with the grant (e.g. "Batched approval — send-email
   *  (3 items)" / "Session grant (raw op) — …"). The row title. */
  readonly display_name: string;
  /** Resolved grant mode (`def.grant_mode ?? 'exact'`). */
  readonly grant_mode: 'exact' | 'batch' | 'open' | 'scoped' | 'raw_op';
  /** What the pass lets through — op-scope axes (see {@link SessionGrantPermits}). */
  readonly permits: SessionGrantPermits;
  /** The approved risk tier (present on every well-formed session row). */
  readonly risk_tier?: RiskTier;
  /** The D-153 channel session the grant is bound to (auto-retires with it). */
  readonly channel_session_id?: string;
  /** Epoch-ms the grant time-expires — the client's live-countdown anchor. */
  readonly expiry_at?: number;
  /** `max(0, expiry_at - now)` at list time. Absent when the row has no
   *  `expiry_at` (malformed — session grants are bounded by construction). */
  readonly remaining_ttl_ms?: number;
  /** Uses left before the grant is exhausted (decremented at the gate). */
  readonly uses_remaining?: number;
  /** The grant's total use budget. */
  readonly max_uses?: number;
  /** `'batch'` rows — the approved member count (`batch_members.length`). */
  readonly member_count?: number;
  /** Server-resolved lifecycle (`active` in a list response; `revoked` on the
   *  view a `revoke` echoes back). */
  readonly lifecycle_state: ContractLifecycleState;
}

/** `collection.contract.session_grant.list` request. `channel_session_id`, when
 *  present, narrows to ONE session's grants (the future per-chat surface);
 *  absent ⇒ every active session grant owner-wide (the global Runs "Active
 *  passes" bubble). */
export interface SessionGrantListRequest {
  channel_session_id?: string;
}

/** `collection.contract.session_grant.list` response — the active passes,
 *  soonest-expiring first (the most-urgent pass on top). */
export interface SessionGrantListResponse {
  readonly grants: SessionGrantView[];
}

/** `collection.contract.session_grant.revoke` request — the grant to expire
 *  early. */
export interface SessionGrantRevokeRequest {
  contract_id: string;
}
