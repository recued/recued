/** D-165 §"Contract namespace" — the schema-driven contract storage substrate.
 *
 *  The contract surface (pack-owned grants, user overrides, merge-card
 *  resolutions, installed-pack/ingredient inventory, and — once D-166 lands —
 *  connection records, the channel×actor×contract_id policy matrix, preflight
 *  gate state, and contract_id lifecycle) lives in ONE namespace-keyed table
 *  (`contract.*`, same storage pattern as `data.*`: sparse rows, prefix-scan
 *  reads) whose SCHEMA is itself stored as namespace entries. Not N typed
 *  tables — one self-describing namespace. Adding a contract dimension = append
 *  a `contract.schema.composite_keys.<scope>` entry; dispatch composes across
 *  every scope that declares a shared `applies_to` role.
 *
 *  This module is the CANONICAL CODE SEED for that schema — the spec-owned
 *  composite_keys + value_shapes D-165 contributes (its 5 entries). At runtime
 *  (a later slice) the seed is loaded into the namespace as data rows so the
 *  dispatcher reads schema + rows through one `scanNamespace` path and future
 *  Ds / packs append more entries as data. D-166 extends this same file with 4
 *  cross-spec entries (connection_record / policy_matrix / preflight_state /
 *  contract_definition) — see `docs/d-166-spec.md` § "Cross-spec composite_keys
 *  entries".
 *
 *  Scope of THIS slice: the schema-entry type system + D-165's 5 entries +
 *  their value_shapes + a pure self-consistency validator. No storage table, no
 *  `composeForRole` dispatcher, no gateway wiring (those are later slices).
 *
 *  Spec: `docs/d-165-spec.md` § "Contract namespace" (Schema entries / Dispatch
 *  roles / D-165's specific schema entries / Dispatch composition). */

// D-207 — the ONE source of truth for the door-type vocabulary. The
// `contract_definition.door_types` value_shape below is DERIVED from it, because spelling
// the members out a second time is exactly how `'reception'` ended up in the const and not
// in the schema — which made `ContractStore.put` reject every reception door.
import { DOOR_TYPES } from './contract-definition.js';

// ════════════════════════════════════════════════════════════════
// Dispatch roles — the `applies_to` vocabulary
// ════════════════════════════════════════════════════════════════

/** The composition surfaces the gateway evaluates separately. A composite_keys
 *  entry contributes to every role it lists in `applies_to`; `composeForRole`
 *  (a later slice) merges all contributing scopes per their `merge_rule`.
 *  Future Ds extend the vocabulary by adding a string here (D-166 adds
 *  `connection_lifecycle` + `contract_lifecycle`). */
export const DISPATCH_ROLES = [
  'ingredient_inventory',
  'pack_inventory',
  // D-170 gap #2 — connection → local-catalog binding inventory. An inventory-kind
  // role (returns the binding row, never policy-merged); read DIRECTLY by the
  // operation-profile seed + the grant gate, not via composeForRole. Kept ISOLATED
  // from `ingredient_inventory` so binding rows never pollute that inventory query.
  'connection_binding',
  'grant_resolution',
  'approval_composition',
  'risk_override',
  'timeout_override',
  'cache_ttl_override',
  // D-166 `contract_definition` — the contract_id lifecycle surface. Like the
  // inventory roles it returns a raw row SET (the contract definition keyed by
  // contract_id) rather than a merged policy; the use-resolution slice reads the
  // row to gate active/expired/revoked + decrement uses. (`connection_lifecycle`
  // for the still-unbuilt `connection_record` entry is added by that slice.)
  'contract_lifecycle',
  // D-177 N.13 (P6b) — `delegation_rule_suggestion` rows: the staged-trust
  // suggestion inventory the housekeeping learner upserts + the P6c
  // `#contracts` panel reads. An inventory-kind role (raw rows, never
  // policy-merged) kept ISOLATED from `contract_lifecycle` so suggestion rows
  // never mix into a contract-row dispatch; nothing gate-side consumes it
  // (N.9.8 — counting never touches the gate hot path).
  'delegation_suggestion',
  // D-177 N.11 rule 5 (5.c, slice C) — `scoped_grant_suggestion` rows: the
  // utterance-derived scoped-grant proposal inventory the D-160 parse
  // middleware files + the accept/dismiss rpc reads. Same isolated
  // inventory-kind posture as `delegation_suggestion`, and a SEPARATE role
  // by design (5.i.2 — scoped proposals never mix into the delegation
  // learner's surface).
  'scoped_grant_suggestion',
  // D-202 — `quality_delegation_suggestion` rows: the coarse (recipe, op)
  // quality-delegation suggestion inventory the (Slice 1) learner upserts + the
  // `#contracts` "Quality auto-accept" panel reads. Same isolated inventory-kind
  // posture as `delegation_suggestion`, a SEPARATE role (quality is a distinct
  // axis; these rows never mix into the authorization learner).
  'quality_delegation_suggestion',
  // D-202 Slice 1 — `quality_delegation_signal` rows: the durable reject/approve
  // VERDICTS the reject-driven learner reads (the quality-axis analogue of the
  // `grant_kind:'session'` rows the D-177 learner aggregates — a quality reject
  // mints no grant, so the signal is explicit). Kernel-written (the Slice 1b
  // capture at the answer path); learner-read on idle cycles only (never the gate
  // hot path). Isolated inventory-kind role — signals never mix into any policy,
  // contract, or suggestion dispatch, and are reserved out of MCP.
  'quality_delegation_signal',
  // D-182 §7.2 — `cli_reachability` rows: the per-(principal × cli-ingredient ×
  // OPERATION) reachability grant the catalog gateway's `cli` authorization stage
  // ENFORCES. cli is connection-less + pack-only, so this is the (contract ×
  // pack-op) grant shape. An inventory-kind role (raw rows, never policy-merged)
  // read DIRECTLY by the cli-reachability resolver, never via composeForRole, and
  // keyed by the PRINCIPAL (owner `user_self`, or a door/agent contract_id), so a
  // recipe run under that principal may reach the cli ingredient's op. Risk tier
  // is NOT a key — it's orthogonal (owner-notification only). An INDEPENDENT
  // per-principal grant (no baseline/overlay), absent ⇒ denied (fail-closed) —
  // the connection-less cli analogue of a connection profile.
  'cli_reachability',
  // Grant-foundation slice 3 (D-187 amendment `693b7d03`) — `contract_grant` rows:
  // the UNIFIED per-(contract_id × entry_key) grant set that collapses op-admission +
  // collection-read + topic-read into ONE namespace (entry_key ∈ `<operation_id>` |
  // `data.<collection>` | `enrichment.<topic>` — the `grant-entry.ts` taxonomy). An
  // inventory-kind role (raw rows, never policy-merged) read DIRECTLY by the grant
  // resolver: a row's `granted: true|false` is the explicit grant/revoke; absent ⇒ the
  // author default (the owner is seeded complete via the boot reconcile, so its rows are
  // never absent — a `granted:false` revoke survives the reconcile). Isolated from every
  // policy role so a grant row never enters a contract/policy dispatch.
  'contract_grant',
] as const;
export type DispatchRole = (typeof DISPATCH_ROLES)[number];
export const isDispatchRole = (v: unknown): v is DispatchRole =>
  typeof v === 'string' && (DISPATCH_ROLES as readonly string[]).includes(v);

/** The roles that return a raw row SET (installed inventory) rather than a merged
 *  policy — `composeForRole` lists their rows, and their scopes' value_shapes are
 *  NOT policy-projected (Slice 4a). Single source of truth for the inventory /
 *  policy role split, consumed by the dispatcher (Slice 4b) + the projection
 *  consistency ratchet (Slice 4a). */
export const INVENTORY_DISPATCH_ROLES = [
  'ingredient_inventory',
  'pack_inventory',
  // D-170 gap #2 — connection → local-catalog binding returns the binding row, not a
  // merged policy; its value_shape is therefore NOT policy-projected (exempted by the
  // projection-completeness ratchet, like the other inventory roles).
  'connection_binding',
  // D-166 `contract_definition` returns the contract row (keyed by contract_id),
  // not a merged policy — its value_shape is therefore NOT policy-projected (the
  // projection-completeness ratchet exempts inventory-only scopes).
  'contract_lifecycle',
  // D-177 N.13 (P6b) — suggestion rows are an owner-surface inventory, never a
  // merged policy; NOT policy-projected for the same reason.
  'delegation_suggestion',
  // D-177 N.11 rule 5 (slice C) — scoped proposals: same owner-surface
  // inventory posture.
  'scoped_grant_suggestion',
  // D-202 — quality-delegation suggestions: same owner-surface inventory posture.
  'quality_delegation_suggestion',
  // D-202 Slice 1 — quality signals: a kernel-written learner-input inventory,
  // never a merged policy → NOT policy-projected.
  'quality_delegation_signal',
  // D-182 §7.2 — per-(principal, cli-ingredient, operation) reachability grant:
  // an owner-surface inventory read directly by the cli-reachability resolver,
  // never a merged policy → NOT policy-projected.
  'cli_reachability',
  // Grant-foundation slice 3 — the unified (contract_id × entry_key) grant set: read
  // directly by the grant resolver, never a merged policy → NOT policy-projected.
  'contract_grant',
] as const satisfies readonly DispatchRole[];
export const isInventoryRole = (role: DispatchRole): boolean =>
  (INVENTORY_DISPATCH_ROLES as readonly string[]).includes(role);

// ════════════════════════════════════════════════════════════════
// Merge rules — how rows compose within a role
// ════════════════════════════════════════════════════════════════

/** The composition rule applied when merging rows that share an `applies_to`
 *  role (higher `merge_precedence` overrides lower; ties surface as a merge
 *  card). The per-field lattice + `applyMergeRule` are formalized in a later
 *  slice (D-166 P1); here we only enumerate the legal values so the schema
 *  validator can reject an unknown `merge_rule`. */
export const MERGE_RULES = [
  /** Set-union of contributing values (additive; e.g. inventory). */
  'union',
  /** Highest-precedence row wins wholesale. */
  'override',
  /** Per field, the stricter (more restrictive) value wins. */
  'stricter_wins',
  /** A write may only TIGHTEN the running aggregate, never loosen it
   *  (user overrides — they can restrict further, never grant more). */
  'tightening_only',
  /** Union the grant SET, but on a per-operation policy conflict the stricter
   *  policy wins (D-165 Q22 — pack grants). */
  'union_with_stricter_wins',
] as const;
export type MergeRule = (typeof MERGE_RULES)[number];
export const isMergeRule = (v: unknown): v is MergeRule =>
  typeof v === 'string' && (MERGE_RULES as readonly string[]).includes(v);

// ════════════════════════════════════════════════════════════════
// writeable_by — who may write rows under a scope
// ════════════════════════════════════════════════════════════════

/** Authorship gate for a scope's rows. `install_planner` = the pack install
 *  flow; `user` = explicit user action (Settings); `install_planner+user` =
 *  either; `kernel` = runtime/engine only. Enforced by the write-time validator
 *  (a later slice); declared here so the schema is complete + checkable. */
export const WRITEABLE_BY = [
  'install_planner',
  'user',
  'install_planner+user',
  'kernel',
  // D-166 P2 — `policy_matrix` cells: the USER writes baseline (channel × actor)
  // cells + contract overlays via Settings; the KERNEL writes them at boot-seed
  // and on contract mint/use. Both owners share the one scope (spec `:94`).
  'user+kernel',
] as const;
export type WriteableBy = (typeof WRITEABLE_BY)[number];
export const isWriteableBy = (v: unknown): v is WriteableBy =>
  typeof v === 'string' && (WRITEABLE_BY as readonly string[]).includes(v);

// ════════════════════════════════════════════════════════════════
// Schema-entry shapes
// ════════════════════════════════════════════════════════════════

/** `contract.schema.composite_keys.<scope_name>` — declares how a scope's rows
 *  are keyed (path segments), which dispatch roles they feed, and how they
 *  compose. */
export interface CompositeKeySchema {
  /** Ordered path-segment names — the row's key is
   *  `contract.<scope_name>.<seg0>.<seg1>…`. */
  segments: readonly string[];
  /** Segments that MUST be present at write time. Subset of `segments`. */
  required: readonly string[];
  /** Trailing segments that MAY be omitted; on a scan, an omitted tail segment
   *  resolves to "match-all" (prefix scan). Must be a contiguous SUFFIX of
   *  `segments` and disjoint from `required`. */
  optional_tail?: readonly string[];
  /** How an OMITTED optional-tail segment resolves at dispatch
   *  (`rowMatchesContext`):
   *    - `'match_all'` (DEFAULT) — an omitted tail keeps EVERY row, incl.
   *      tail-specific siblings, so a broad query inherits every per-tail
   *      tightening. This is the `override` fail-closed semantics: a broad
   *      ingredient eval (no operation_id) must inherit every per-operation deny.
   *    - `'baseline_only'` — an omitted tail keeps ONLY the bare row that also
   *      omits the segment (the baseline cell); tail-specific rows are DROPPED.
   *      D-166 P2: policy_matrix's `contract_id` overlay must NOT bleed into a
   *      no-contract call, so a no-contract lookup resolves the `(channel, actor)`
   *      baseline cell alone — unrelated contracts' overlays don't tighten it.
   *  The TARGETED case (context supplies the segment) is identical in both modes:
   *  baseline + the exact match, sibling specifics dropped. Governs all of a
   *  scope's optional_tail segments uniformly (every current scope has one). */
  optional_tail_match?: 'match_all' | 'baseline_only';
  /** References a `contract.schema.value_shapes.<value_shape>` template. */
  value_shape: string;
  /** Dispatch roles this scope contributes to. Non-empty. */
  applies_to: readonly DispatchRole[];
  /** Higher overrides lower when composing within a role. */
  merge_precedence: number;
  /** How rows compose within a role. */
  merge_rule: MergeRule;
  /** Who may write rows under this scope. */
  writeable_by: WriteableBy;
}

/** `contract.schema.value_shapes.<shape_name>` — a reusable value template. The
 *  `types` map carries STRING type descriptors (`"string"`, `"string[]"`,
 *  `"enum:a|b|c"`, `"datetime"`, `"json?"`, …) — the value rows are JSON, so the
 *  shape is data-level metadata the write-time validator + the Settings →
 *  Advanced inventory renderer consume, not a TypeScript type. A trailing `?`
 *  marks the descriptor nullable/optional. */
export interface ValueShape {
  fields: readonly string[];
  types: Readonly<Record<string, string>>;
  /** Subset of `fields` that must be present on every row. */
  required: readonly string[];
}

/** A bundle of schema entries a single spec contributes. */
export interface ContractSchemaRegistry {
  composite_keys: Readonly<Record<string, CompositeKeySchema>>;
  value_shapes: Readonly<Record<string, ValueShape>>;
}

// ════════════════════════════════════════════════════════════════
// D-165's value_shapes
//
// DERIVED: D-165 NAMES these 5 value_shapes (in its composite_keys entries) but
// does not define their fields anywhere; D-166 defines fields only for its own
// shapes. The fields below are grounded in the already-built catalog grant
// model (`ConnectionOperationProfile` — allowed_operations / risk_overrides /
// approval_defaults; the `connection_operation_grant` group store) and D-165
// Q22's stricter-wins merge sketch (default_approval / max_risk_without_approval
// / denied_*). They are the canonical seed but remain open to refinement when
// the merge algebra (later slice) consumes them.
// ════════════════════════════════════════════════════════════════

const VALUE_SHAPES: Readonly<Record<string, ValueShape>> = {
  /** Inventory row for one installed ingredient. */
  installed_ingredient_info: {
    fields: ['ingredient_id', 'version', 'installed_at', 'catalog_kind', 'source_pack_slug'],
    types: {
      ingredient_id: 'string',
      version: 'string',
      installed_at: 'datetime',
      catalog_kind: 'enum:official|unofficial_acknowledged|private_byo?',
      source_pack_slug: 'string?',
    },
    required: ['ingredient_id', 'version', 'installed_at'],
  },
  /** Inventory row for one installed pack. D-182 Slice 4 (Tier-P resolution) —
   *  `publisher` records the pack's publisher handle so the inventory is the
   *  authoritative `pack_ref` (`<publisher>.<pack_slug>`) → catalog source the
   *  Tier-P op-step lowering resolves against (`buildPackOpResolution`). Optional
   *  in the schema (forward-safe — a row written before this field exists, or a
   *  test fixture that omits it, stays valid); the real writer
   *  (`recordPackInventory`) always sets it from `manifest.publisher` (always a
   *  non-empty string per `parseBulkPackManifest`), so every production row carries
   *  it and the resolution builder skips a publisher-less row fail-closed. */
  installed_pack_info: {
    fields: ['pack_slug', 'publisher', 'version', 'installed_at', 'ingredient_ids'],
    types: {
      pack_slug: 'string',
      publisher: 'string?',
      version: 'string',
      installed_at: 'datetime',
      ingredient_ids: 'string[]',
    },
    required: ['pack_slug', 'version', 'installed_at'],
  },
  /** D-170 gap #2 — binds a connection to the private/local composition catalog
   *  installed against it. Registered vendors resolve a connection → catalog via
   *  `config.vendor` → CATALOG_VENDOR_SLUGS; a local/private composition catalog has
   *  no vendor, so the install planner records this binding (from the composition's
   *  `auth.connection`) and the operation-profile seed + the grant gate resolve a
   *  local-catalog connection through it. Keyed by connection_name (one catalog per
   *  connection, matching the `ConnectionOperationProfile`'s single `catalog_slug`
   *  stamp); `installed_pack_id` attributes the row to its owning pack for uninstall. */
  catalog_binding_info: {
    fields: ['catalog_slug', 'installed_pack_id'],
    types: {
      catalog_slug: 'string',
      installed_pack_id: 'string',
    },
    required: ['catalog_slug', 'installed_pack_id'],
  },
  /** D-182 §7.2 — one per-(principal, cli-ingredient, risk_tier) reachability
   *  grant. A row's PRESENCE with `allowed: true` ⇒ a recipe run under the keyed
   *  principal may reach the cli ingredient at that risk tier; absent ⇒ DENIED
   *  (fail-closed — reachability defaults OFF). An independent allowlist row (not
   *  a baseline+overlay). `set_at` is epoch-ms. */
  cli_reachability_state: {
    fields: ['allowed', 'set_at'],
    types: {
      allowed: 'bool',
      set_at: 'datetime?',
    },
    required: ['allowed'],
  },
  /** Grant-foundation slice 3 (D-187 amendment `693b7d03`) — one entry in the
   *  UNIFIED per-contract grant set. Keyed `(contract_id, entry_key)`; `granted`
   *  is the explicit grant (`true`) / revoke (`false`); `set_at` the write stamp.
   *  Presence-with-`granted:true` = granted, a `granted:false` row = an explicit
   *  revoke (the owner toggles a seeded grant off — survives the boot reconcile),
   *  absence = the author default. Structurally identical to
   *  `cli_reachability_state` — `granted` names the grant rather than `allowed`.
   *
   *  D-182 §7.2 — `source_pack` stamps a row written by the "Install for everyone"
   *  op-admission fan-out with the owning `installed_pack_id`, so uninstall /
   *  reinstall can clear EXACTLY that pack's fanned-out grants
   *  (`clearForSourcePack`) without disturbing a hand-minted door's own
   *  `scope.operation_ids` grant or an owner/manual row (which carry no
   *  `source_pack`). Optional: mint-fold / owner / manual writes omit it. */
  grant_entry: {
    fields: ['granted', 'set_at', 'source_pack'],
    types: {
      granted: 'bool',
      set_at: 'datetime?',
      source_pack: 'string?',
    },
    required: ['granted'],
  },
  /** A pack-owned grant's policy for one (pack, ingredient, connection,
   *  group|operation). Grants default OFF; a row's presence unlocks the keyed
   *  group/operation. The optional fields carry the per-grant policy the
   *  `union_with_stricter_wins` merge composes (Q22). */
  grant_policy: {
    fields: [
      'allowed',
      'approval',
      'risk_tier',
      'denied_operation_ids',
      'approval_required_operation_ids',
      'max_risk_without_approval',
    ],
    types: {
      allowed: 'bool',
      approval: 'enum:never|ask|always?',
      risk_tier: 'enum:read|write|admin|destructive?',
      denied_operation_ids: 'string[]?',
      approval_required_operation_ids: 'string[]?',
      max_risk_without_approval: 'enum:read|write|admin|none?',
    },
    required: ['allowed'],
  },
  /** A user's merge-card resolution for one (pack, group) — the choice recorded
   *  when packs disagree on a group's policy (Q22 InstalledPackPolicyResolution).
   *  Highest precedence among the grant_resolution contributors except the user
   *  override. */
  merge_card_resolution: {
    fields: ['pack_slug', 'group_id', 'resolved_approval', 'resolved_operations', 'resolved_at', 'resolved_by'],
    types: {
      pack_slug: 'string',
      group_id: 'string',
      resolved_approval: 'enum:never|ask|always',
      resolved_operations: 'string[]',
      resolved_at: 'datetime',
      resolved_by: 'string',
    },
    required: ['pack_slug', 'group_id', 'resolved_approval'],
  },
  /** A user override for one (actor, ingredient, [operation]). `tightening_only`
   *  — every field can only RESTRICT further, so all are optional; a present
   *  field tightens the running aggregate. One row feeds five roles (denied →
   *  grant_resolution, approval → approval_composition, max_risk_without_approval
   *  → risk_override, timeout_ms → timeout_override, cache_ttl_ms →
   *  cache_ttl_override). D-166 Slice 4a projects `denied`→`allowed` (negated)
   *  and `max_risk_without_approval` onto its lattice; the field is named for the
   *  lattice (none|read|write|admin, stricter LOW — destructive always needs
   *  approval, so it has no place on the ceiling). */
  override_policy: {
    fields: ['denied', 'approval', 'max_risk_without_approval', 'timeout_ms', 'cache_ttl_ms'],
    types: {
      denied: 'bool?',
      approval: 'enum:never|ask|always?',
      max_risk_without_approval: 'enum:read|write|admin|none?',
      timeout_ms: 'number?',
      cache_ttl_ms: 'number?',
    },
    required: [],
  },
  // D-166 contract_definition — the (channels × actors × ingredient_ids ×
  // operation_ids × connection_names) scope a minted contract authorizes. Empty
  // array on any axis = "any" (the spec's wildcard). Referenced as a NESTED
  // value_shape by `contract_definition.scope`.
  contract_scope: {
    fields: ['channels', 'actors', 'ingredient_ids', 'operation_ids', 'connection_names'],
    types: {
      channels: 'string[]',
      actors: 'string[]',
      ingredient_ids: 'string[]',
      operation_ids: 'string[]',
      connection_names: 'string[]',
    },
    required: [],
  },

  // D-177 N.3 — the recipe identity a session grant is bound to. Referenced as a
  // NESTED value_shape by `contract_definition.bound_recipe`; both halves are
  // required so a session row can never be minted with a partial binding.
  bound_recipe_ref: {
    fields: ['recipe_id', 'recipe_hash'],
    types: {
      recipe_id: 'string',
      recipe_hash: 'string',
    },
    required: ['recipe_id', 'recipe_hash'],
  },

  // D-177 N.10 — one `grant_mode: 'batch'` member. `member_id` is the stable
  // per-item identity (duplicate payload hashes stay distinct members);
  // `consumed_at` is stamped when a dispatch atomically claims the member
  // (consumption machinery lands in P5a).
  session_batch_member: {
    fields: ['member_id', 'canonical_payload_hash', 'consumed_at'],
    types: {
      member_id: 'string',
      canonical_payload_hash: 'string',
      consumed_at: 'datetime?',
    },
    required: ['member_id', 'canonical_payload_hash'],
  },

  // D-166 contract_definition — the contract_id lifecycle record (spec
  // `:178-210`). `scope` is a NESTED value_shape reference (`contract_scope`);
  // `approved_actions_template` pre-authorizes actions that bypass per-call
  // approval. `expiry_at` / `max_uses` / `uses_remaining` / `revoked_at` drive the
  // active/expired/revoked lifecycle (`contract-definition.ts` helpers).
  //
  // D-177 N.3 — gate-grant extension: `grant_kind` discriminates standing
  // rows (absent ⇒ 'standing', every pre-D-177 row) from server-minted session
  // grants and — N.13 — owner-accepted delegation rules (scope-bound, no
  // channel session); the remaining fields are the grant value shape (mode +
  // bindings + per-mode payload identity). All optional at the SHAPE level —
  // the conditional requirements ("`channel_session_id` REQUIRED when
  // 'session', FORBIDDEN when 'delegation'", per-mode field presence) are
  // enforced by the mint primitives and fail-closed at the N.4 matcher, since
  // the value_shape mini-language has no conditional-required vocabulary.
  contract_definition: {
    fields: [
      'contract_id',
      'minted_at',
      'minted_by',
      'display_name',
      'scope',
      'door_types',
      'max_risk_without_approval',
      'approved_actions_template',
      'expiry_at',
      'max_uses',
      'uses_remaining',
      'revoked_at',
      'revocation_reason',
      'grant_kind',
      'grant_mode',
      'channel_session_id',
      'bound_recipe',
      'bound_contract_id',
      'arg_shape_hash',
      'canonical_payload_hash',
      'risk_tier',
      'batch_members',
      'pinned_projection_hash',
      'open_projection',
      'entity_scope',
      'approved_action_ref',
      'scoped_source',
    ],
    types: {
      contract_id: 'string',
      minted_at: 'datetime',
      minted_by: 'string',
      display_name: 'string',
      scope: 'contract_scope',
      // D-187 §6 + D-196 — the level-1 door-type axis.
      // Optional array-of-enum: absent / `[]` = wildcard (any door type — the
      // behaviour-preserving default); a non-empty list restricts the contract
      // to the named door types (the connection-establishment gate rejects
      // others). Schema admits the literals; `contractPermitsDoorType` owns the
      // wildcard semantics, the HTTP MCP transport owns the gate.
      //
      // ⛔ DERIVED FROM `DOOR_TYPES` — never hand-written. This line used to spell the
      // members out (`enum:mcp|mcp_chat|llm_gateway[]?`), which made it a SECOND source of
      // truth for a closed set that already had one. D-207 added `'reception'` to the const
      // and this string was not updated, so `ContractStore.put` — which validates every
      // minted row against this value_shape — REJECTED every reception door with
      // `ContractWriteInvalidError: type_mismatch`. The door could not be minted on any real
      // server, and every test stayed green because they all faked the definition store.
      // Deriving it means the two cannot drift again.
      door_types: `enum:${DOOR_TYPES.join('|')}[]?`,
      // D-209 #1 — the door's authored stage-trust ceiling (see
      // `ContractDefinition.max_risk_without_approval`). Same vocabulary as
      // `override_policy.max_risk_without_approval` above.
      max_risk_without_approval: 'enum:read|write|admin|none?',
      approved_actions_template: 'json?',
      expiry_at: 'datetime?',
      max_uses: 'number?',
      uses_remaining: 'number?',
      revoked_at: 'datetime?',
      revocation_reason: 'string?',
      // D-202 — `quality_delegation` is the owner-minted quality axis (a coarse
      // (recipe, op)-grain grant; the matcher / gate own its semantics, inert in
      // every authorization-grant consumer).
      grant_kind:
        'enum:standing|session|delegation|customer_template|customer_instance|quality_delegation?',
      // D-177 N.11 rule 5 (rev 10) — `'scoped'` is the utterance-derived
      // session-scope overlay (5.a). D-182 §8 — `'raw_op'` is the recipe-less
      // raw-op door grant (a session grant minted from a human's per-call
      // approval of a door's raw catalog op — no recipe to pin, op + connection
      // scope + exact payload instead). Schema admits the literals; the matcher
      // / consumption own their semantics and fail closed on every other surface.
      grant_mode: 'enum:exact|batch|open|scoped|raw_op?',
      channel_session_id: 'string?',
      bound_recipe: 'bound_recipe_ref?',
      // D-177 N.14 — the door binding (see `ContractDefinition.bound_contract_id`).
      // Optional at the shape level; the matcher's asymmetric clauses + the
      // mint primitives own the conditional requirements.
      bound_contract_id: 'string?',
      arg_shape_hash: 'string?',
      canonical_payload_hash: 'string?',
      // D-177 P3 (codex HIGH fold) — the approved tier; REQUIRED on session
      // rows at the mint primitive (the matcher requires EQUALITY — D7's
      // set-membership alone would let a write-approved grant absorb an
      // admin-tier ask after manifest drift). Optional at the shape level:
      // standing rows never carry it.
      risk_tier: 'enum:read|write|admin|destructive?',
      batch_members: 'session_batch_member[]?',
      pinned_projection_hash: 'string?',
      open_projection: 'json?',
      entity_scope: 'string?',
      approved_action_ref: 'string?',
      // D-177 N.11 rule 5 — `'scoped'` rows only (closed source enum, 5.b).
      scoped_source: 'enum:forwarded_item_sender?',
    },
    required: ['contract_id', 'minted_at', 'minted_by', 'display_name', 'scope'],
  },

  // D-177 N.13 (P6b) — the would-be delegation rule a suggestion stores
  // VERBATIM (the P6c accept mints from this snapshot — what the card showed,
  // the SessionGrantOffer snapshot-at-raise posture). One field per
  // authority-bearing clause of the N.13 key, plus the open arm's stored
  // projection. Referenced as a NESTED value_shape by
  // `delegation_rule_suggestion.snapshot`. `risk_tier` keeps the full tier
  // enum for shape-consistency with `contract_definition`; the learner's key
  // derivation + the P6c mint both enforce the DELEGATION_RULE_RISK_TIERS
  // ceiling (`write` only, fork 2) on top.
  delegation_rule_snapshot: {
    fields: [
      'channel',
      'actor',
      // D-177 N.14 — the door binding (present exactly on door-key
      // snapshots; the mint plan + store re-validate the conditional).
      'bound_contract_id',
      'ingredient_id',
      'operation_id',
      'connection_name',
      'recipe_id',
      'recipe_hash',
      'arg_shape_hash',
      'risk_tier',
      'entity_scope',
      'grant_mode',
      'canonical_payload_hash',
      'pinned_projection_hash',
      'open_projection',
    ],
    types: {
      channel: 'string',
      actor: 'string',
      bound_contract_id: 'string?',
      ingredient_id: 'string',
      operation_id: 'string?',
      connection_name: 'string?',
      recipe_id: 'string',
      recipe_hash: 'string',
      arg_shape_hash: 'string',
      risk_tier: 'enum:read|write|admin|destructive',
      entity_scope: 'string?',
      grant_mode: 'enum:exact|open',
      canonical_payload_hash: 'string?',
      pinned_projection_hash: 'string?',
      open_projection: 'json?',
    },
    required: [
      'channel',
      'actor',
      'ingredient_id',
      'recipe_id',
      'recipe_hash',
      'arg_shape_hash',
      'risk_tier',
      'grant_mode',
    ],
  },

  // D-177 N.13 (P6b) — the evidence block the learner recomputes onto a
  // suggestion row (count / distinct sessions / consumed uses / newest-first
  // sample contract_ids / first+last minted_at over the QUALIFYING rows).
  // Referenced as a NESTED value_shape by `delegation_rule_suggestion.evidence`.
  delegation_rule_evidence: {
    fields: [
      'row_count',
      'distinct_session_count',
      'consumed_uses',
      'sample_contract_ids',
      'first_minted_at',
      'last_minted_at',
    ],
    types: {
      row_count: 'number',
      distinct_session_count: 'number',
      consumed_uses: 'number',
      sample_contract_ids: 'string[]',
      first_minted_at: 'datetime',
      last_minted_at: 'datetime',
    },
    required: [
      'row_count',
      'distinct_session_count',
      'consumed_uses',
      'sample_contract_ids',
      'first_minted_at',
      'last_minted_at',
    ],
  },

  // D-177 N.13 (P6b) — one staged-trust suggestion, keyed by the canonical
  // N.13 key hash. `state` is the D-132 promotion-banner lifecycle: 'open'
  // rows are recomputed idempotently by the housekeeping learner; 'dismissed'
  // is per-key permanent; 'accepted' marks the P6c mint. `created_at` is the
  // first firing (stable across recomputes); `updated_at` moves only when a
  // recompute changes the row.
  delegation_rule_suggestion: {
    fields: ['key_hash', 'state', 'snapshot', 'evidence', 'created_at', 'updated_at'],
    types: {
      key_hash: 'string',
      state: 'enum:open|accepted|dismissed',
      snapshot: 'delegation_rule_snapshot',
      evidence: 'delegation_rule_evidence',
      created_at: 'datetime',
      updated_at: 'datetime',
    },
    required: ['key_hash', 'state', 'snapshot', 'evidence', 'created_at', 'updated_at'],
  },

  // D-202 — the would-be quality delegation a suggestion stores verbatim (the
  // accept mints from this snapshot). Coarse (recipe, op) grain: recipe identity
  // + the op, plus an optional display label. Nested value_shape referenced by
  // `quality_delegation_suggestion.snapshot`.
  quality_delegation_snapshot: {
    fields: ['recipe_id', 'recipe_hash', 'ingredient_id', 'operation_id', 'display_name'],
    types: {
      recipe_id: 'string',
      recipe_hash: 'string',
      ingredient_id: 'string',
      operation_id: 'string?',
      display_name: 'string?',
    },
    required: ['recipe_id', 'recipe_hash', 'ingredient_id'],
  },

  // D-202 — the evidence describing why a (recipe, op) earned a quality offer
  // (the Slice 1 learner recomputes it; a test source seeds it until then).
  quality_delegation_evidence: {
    fields: ['approve_count', 'distinct_session_count', 'sample_refs', 'first_at', 'last_at'],
    types: {
      approve_count: 'number',
      distinct_session_count: 'number',
      sample_refs: 'string[]',
      first_at: 'datetime',
      last_at: 'datetime',
    },
    required: ['approve_count', 'distinct_session_count', 'sample_refs', 'first_at', 'last_at'],
  },

  // D-202 — one quality-delegation suggestion, keyed by the canonical (recipe,
  // op) key hash. Same state machine as `delegation_rule_suggestion` ('open'
  // recomputed idempotently by the Slice 1 learner; 'dismissed' per-key
  // permanent; 'accepted' marks the owner mint).
  quality_delegation_suggestion: {
    fields: ['key_hash', 'state', 'snapshot', 'evidence', 'created_at', 'updated_at'],
    types: {
      key_hash: 'string',
      state: 'enum:open|accepted|dismissed',
      snapshot: 'quality_delegation_snapshot',
      evidence: 'quality_delegation_evidence',
      created_at: 'datetime',
      updated_at: 'datetime',
    },
    required: ['key_hash', 'state', 'snapshot', 'evidence', 'created_at', 'updated_at'],
  },

  // D-202 Slice 1 — one durable owner verdict on a quality-relevant (recipe, op)
  // send (the reject-driven learner's raw signal). `reason` carries the full §2
  // reason enum for shape-consistency; the learner trains only on the two
  // defaults (`quality_good`/`quality_bad` — `reasonTrainsQuality`). `at` is the
  // verdict event time; `audit_ref` is an optional back-pointer to the resolved
  // run/ask (surfaced in the suggestion evidence sample, never load-bearing).
  quality_delegation_signal: {
    fields: [
      'signal_id',
      'recipe_id',
      'recipe_hash',
      'ingredient_id',
      'operation_id',
      'channel_session_id',
      'reason',
      'at',
      'audit_ref',
    ],
    types: {
      signal_id: 'string',
      recipe_id: 'string',
      recipe_hash: 'string',
      ingredient_id: 'string',
      operation_id: 'string?',
      channel_session_id: 'string',
      reason: 'enum:quality_bad|policy|quality_good|ship_anyway',
      at: 'datetime',
      audit_ref: 'string?',
    },
    required: [
      'signal_id',
      'recipe_id',
      'recipe_hash',
      'ingredient_id',
      'channel_session_id',
      'reason',
      'at',
    ],
  },

  // D-177 N.11 rule 5 (5.c, slice C) — the would-be SCOPED grant a proposal
  // stores verbatim (the accept mints from this snapshot — what the card
  // showed; the N.13 snapshot-at-raise posture applied to the separate
  // scoped row kind). `risk_tier` keeps the full enum for shape-consistency;
  // the parse middleware + the mint both enforce the SESSION_GRANT_RISK_TIERS
  // ceiling on top. Referenced as a NESTED value_shape by
  // `scoped_grant_suggestion.snapshot`.
  scoped_grant_snapshot: {
    fields: [
      'channel',
      'channel_session_id',
      'ingredient_id',
      'operation_id',
      'risk_tier',
      'scoped_source',
      'ttl_ms',
      'entity',
      'action',
    ],
    types: {
      channel: 'string',
      channel_session_id: 'string',
      ingredient_id: 'string',
      operation_id: 'string',
      risk_tier: 'enum:read|write|admin|destructive',
      scoped_source: 'enum:forwarded_item_sender',
      ttl_ms: 'number',
      entity: 'string',
      action: 'string',
    },
    required: [
      'channel',
      'channel_session_id',
      'ingredient_id',
      'operation_id',
      'risk_tier',
      'scoped_source',
      'ttl_ms',
      'entity',
      'action',
    ],
  },

  // D-177 N.11 rule 5 (5.c, slice C) — one scoped-grant proposal, keyed by
  // the canonical session×op key hash. Same state machine as
  // `delegation_rule_suggestion` ('open' refreshed idempotently by the parse
  // middleware; 'dismissed' per-key permanent; 'accepted' marks the mint) —
  // but a SEPARATE row kind: scoped proposals never enter the delegation
  // learner's scan or key derivation (5.i.2). `triggering_excerpt` is shown
  // verbatim on the card; `connection_candidates` is the parse-time
  // enrollment snapshot (the accept re-validates LIVE).
  scoped_grant_suggestion: {
    fields: [
      'key_hash',
      'state',
      'snapshot',
      'triggering_excerpt',
      'connection_candidates',
      'created_at',
      'updated_at',
    ],
    types: {
      key_hash: 'string',
      state: 'enum:open|accepted|dismissed',
      snapshot: 'scoped_grant_snapshot',
      triggering_excerpt: 'string',
      connection_candidates: 'string[]',
      created_at: 'datetime',
      updated_at: 'datetime',
    },
    required: [
      'key_hash',
      'state',
      'snapshot',
      'triggering_excerpt',
      'connection_candidates',
      'created_at',
      'updated_at',
    ],
  },

  // D-187 AMENDMENT (`693b7d03`) — the `enrichment_visibility` value_shape is DELETED.
  // Per-topic read-visibility folded into the unified `grant_entry` value_shape (the
  // `contract_grant` scope below): a topic read is a plain `enrichment.<topic>` grant
  // (`granted: boolean`), no separate `visibility` enum. Pre-launch zero installs → no
  // migration.
};

// ════════════════════════════════════════════════════════════════
// D-165's composite_keys entries (transcribed faithfully from the spec)
// ════════════════════════════════════════════════════════════════

const COMPOSITE_KEYS: Readonly<Record<string, CompositeKeySchema>> = {
  installed_ingredient: {
    segments: ['ingredient_id'],
    required: ['ingredient_id'],
    value_shape: 'installed_ingredient_info',
    applies_to: ['ingredient_inventory'],
    merge_precedence: 0,
    merge_rule: 'override',
    writeable_by: 'install_planner',
  },
  installed_pack: {
    segments: ['pack_slug'],
    required: ['pack_slug'],
    value_shape: 'installed_pack_info',
    applies_to: ['pack_inventory'],
    merge_precedence: 0,
    merge_rule: 'override',
    writeable_by: 'install_planner',
  },
  connection_catalog_binding: {
    // D-170 gap #2 — connection_name → the local composition catalog installed
    // against it. Keyed by connection_name alone (one catalog per connection, matching
    // the ConnectionOperationProfile's single `catalog_slug` stamp); `override` so a
    // reinstall replaces the binding. Read directly (not via composeForRole) by the
    // profile seed + the grant gate.
    segments: ['connection_name'],
    required: ['connection_name'],
    value_shape: 'catalog_binding_info',
    applies_to: ['connection_binding'],
    merge_precedence: 0,
    merge_rule: 'override',
    writeable_by: 'install_planner',
  },
  cli_reachability: {
    // D-182 §7.2 — per-(principal × cli-ingredient × OPERATION) reachability grant
    // (the Local-tools grid + the install dialog write it; absent ⇒ DENIED). cli is
    // connection-less + pack-only, so cli access is a (contract × pack-op) grant:
    // keyed by the PRINCIPAL (owner `user_self`, or a door/agent contract_id), the
    // cli catalog INGREDIENT (carries the pack/catalog binding → the cross-catalog
    // guard is structural, since a row for ingredient A can't authorize ingredient
    // B), and the OPERATION id (the granted callable pack-op). Risk tier is NOT a
    // key — it's orthogonal (it decides owner-notification for write/destructive,
    // never admission), so it lives in the gateway's approval stage, not here.
    // `override` so a per-op on/off replaces the row. An INDEPENDENT per-principal
    // grant, NOT a baseline+overlay — every contract-aware merge scope (`override` /
    // `policy_matrix`) is tightening-only and can't carry a per-contract LOOSEN, so
    // reachability is an allowlist read DIRECTLY (inventory role) by the
    // cli-reachability resolver the gateway's cli authorization stage ENFORCES,
    // never composed. Owner-written (Settings grid) + install-dialog-written →
    // `install_planner+user`.
    segments: ['principal', 'ingredient_id', 'operation_id'],
    required: ['principal', 'ingredient_id', 'operation_id'],
    value_shape: 'cli_reachability_state',
    applies_to: ['cli_reachability'],
    merge_precedence: 0,
    merge_rule: 'override',
    writeable_by: 'install_planner+user',
  },
  grant: {
    segments: ['installed_pack_id', 'ingredient_id', 'connection_name', 'group_id_or_operation_id'],
    // NB: D-165's composite_keys text lists only the first 3 as `required`, but
    // its grant IDENTITY (Q20 / D-166 Q20: keyed per the full 4-tuple) + D-165
    // Invariant 3 (operations default OFF — you grant a specific group/op, never
    // a whole connection) require the 4th. We require all 4 so a write can't
    // land a match-all `contract.grant.<pack>.<ingredient>.<connection>` row
    // (an unintended connection-wide grant). No `optional_tail` — every grant
    // names its group or operation.
    required: ['installed_pack_id', 'ingredient_id', 'connection_name', 'group_id_or_operation_id'],
    value_shape: 'grant_policy',
    applies_to: ['grant_resolution'],
    merge_precedence: 10,
    merge_rule: 'union_with_stricter_wins',
    // D-165 P3.grant migration — `install_planner+user`, not `install_planner`.
    // Pack-owned grants are written by the install planner; user-MANUAL grants
    // (the Settings → Connections grant panel) are written by the user under the
    // reserved `__user__` sentinel `installed_pack_id` (`contract-grant-store.ts`).
    // Both owners live in this one scope; the effective view unions them per
    // `(ingredient_id, connection_name)`. The declaration is honest now so a future
    // `writeable_by` enforcement admits the user-grant path rather than rejecting it.
    writeable_by: 'install_planner+user',
  },
  policy_resolution: {
    segments: ['pack_slug', 'group_id'],
    required: ['pack_slug', 'group_id'],
    value_shape: 'merge_card_resolution',
    applies_to: ['grant_resolution'],
    merge_precedence: 20,
    // D-166 Slice 4b: `union` (not `override`). A merge-card resolution carries
    // only the fields it speaks to (approval + allowed_operation_ids); `union`
    // composes from `{...acc}`, so it OVERLAYS those onto the lower-precedence
    // pack `grant` (prec 10) by take-last and leaves the grant's allowed /
    // risk_tier / denied_* intact. `override` here would replace the whole
    // accumulated policy and erase those fields when a partial resolution
    // composes after a grant.
    merge_rule: 'union',
    writeable_by: 'install_planner+user',
  },
  override: {
    segments: ['actor', 'ingredient_id', 'operation_id'],
    required: ['actor', 'ingredient_id'],
    optional_tail: ['operation_id'],
    value_shape: 'override_policy',
    applies_to: [
      'grant_resolution',
      'approval_composition',
      'risk_override',
      'timeout_override',
      'cache_ttl_override',
    ],
    merge_precedence: 30,
    merge_rule: 'tightening_only',
    writeable_by: 'user',
  },
  contract_definition: {
    // D-166 — the contract_id lifecycle record (spec `:170-210`). Keyed by a
    // single `contract_id`; the row carries the contract's scope, mint provenance,
    // and the expiry / max_uses / revoked state the use-resolution slice gates on.
    // `contract_lifecycle` is an INVENTORY-style role: dispatch returns the row,
    // it is not policy-merged (so the value_shape has no projection). `override`
    // merge_rule + precedence 0 because a contract_id keys exactly one definition
    // (no composition — there is never more than one row per contract_id).
    segments: ['contract_id'],
    required: ['contract_id'],
    value_shape: 'contract_definition',
    applies_to: ['contract_lifecycle'],
    merge_precedence: 0,
    merge_rule: 'override',
    writeable_by: 'user+kernel',
  },
  delegation_rule_suggestion: {
    // D-177 N.13 (P6b) — one row per canonical suggestion-key hash (a row
    // lives at `contract.delegation_rule_suggestion.<key_hash>`). The store's
    // keyed put IS the N.13 UNIQUE-key upsert; `override` + precedence 0
    // because a key hash names exactly one suggestion (no composition).
    // `user+kernel`: the KERNEL (housekeeping learner) writes/refreshes open
    // rows; the USER (P6c accept/dismiss rpc — owner-surface only, reserved
    // out of MCP) transitions state. Isolated `delegation_suggestion` role —
    // suggestion rows never enter a policy or contract-lifecycle dispatch.
    segments: ['key_hash'],
    required: ['key_hash'],
    value_shape: 'delegation_rule_suggestion',
    applies_to: ['delegation_suggestion'],
    merge_precedence: 0,
    merge_rule: 'override',
    writeable_by: 'user+kernel',
  },
  quality_delegation_suggestion: {
    // D-202 — one row per canonical (recipe, op) key hash (a row lives at
    // `contract.quality_delegation_suggestion.<key_hash>`). The store's keyed
    // put IS the UNIQUE-key upsert; `override` + precedence 0 because a key hash
    // names exactly one suggestion. `user+kernel`: the KERNEL (Slice 1 learner)
    // writes/refreshes open rows; the USER (accept/dismiss rpc — owner-surface
    // only, reserved out of MCP) transitions state. Isolated role — quality
    // suggestion rows never enter a policy or contract-lifecycle dispatch.
    segments: ['key_hash'],
    required: ['key_hash'],
    value_shape: 'quality_delegation_suggestion',
    applies_to: ['quality_delegation_suggestion'],
    merge_precedence: 0,
    merge_rule: 'override',
    writeable_by: 'user+kernel',
  },
  quality_delegation_signal: {
    // D-202 Slice 1 — one row per verdict, keyed by `signal_id` (a row lives at
    // `contract.quality_delegation_signal.<signal_id>`); the store's keyed put is
    // a plain append (each verdict is its own row — signals accumulate, they do
    // not upsert). `override` + precedence 0 because a signal_id names exactly one
    // verdict. `kernel`-only: the Slice 1b capture writes them; nothing user-side
    // edits a signal. Isolated role — signals never enter a policy, contract, or
    // suggestion dispatch, and are reserved out of MCP.
    segments: ['signal_id'],
    required: ['signal_id'],
    value_shape: 'quality_delegation_signal',
    applies_to: ['quality_delegation_signal'],
    merge_precedence: 0,
    merge_rule: 'override',
    writeable_by: 'kernel',
  },
  scoped_grant_suggestion: {
    // D-177 N.11 rule 5 (5.c, slice C) — one row per canonical scoped
    // proposal key (a row lives at
    // `contract.scoped_grant_suggestion.<key_hash>`). The store's keyed put
    // IS the unique-key upsert (a re-utterance refreshes, never stacks).
    // `user+kernel`: the KERNEL (the D-160 parse middleware) files/refreshes
    // open rows; the USER (the accept/dismiss rpc — owner-surface only,
    // reserved out of MCP) transitions state. Isolated role mirrors
    // `delegation_suggestion` — proposal rows never enter a policy or
    // contract-lifecycle dispatch, and never the delegation learner (5.i.2).
    segments: ['key_hash'],
    required: ['key_hash'],
    value_shape: 'scoped_grant_suggestion',
    applies_to: ['scoped_grant_suggestion'],
    merge_precedence: 0,
    merge_rule: 'override',
    writeable_by: 'user+kernel',
  },
  // D-187 AMENDMENT (`693b7d03`) — the `enrichment` scope (per-(contract_id × topic) MCP
  // read-visibility toggle, path `contract.enrichment.<contract_id>.<topic>`) is DELETED.
  // Topic read-visibility folded into the unified `contract_grant` scope below as an
  // `enrichment.<topic>` grant entry. Pre-launch zero installs → no migration.
  contract_grant: {
    // Grant-foundation slice 3 (D-187 amendment `693b7d03`) — the UNIFIED per-(contract_id
    // × entry_key) grant set. Path `contract.grant.<contract_id>.<entry_key>`; entry_key ∈
    // `<operation_id>` | `data.<collection>` | `enrichment.<topic>` (the `grant-entry.ts`
    // taxonomy — the seg_key codec escapes the entry_key's `.`/`%`, so a dotted op id keys
    // a single segment). Both segments REQUIRED — a row always names its contract + entry.
    // `override` + precedence 0 because a (contract_id, entry_key) keys exactly one grant
    // (no composition). Read DIRECTLY by the grant resolver via the isolated `contract_grant`
    // inventory role, never policy-merged. `user+kernel` (the policy_matrix precedent): the
    // USER writes per-entry toggles (Settings → contract grants), the KERNEL writes them at
    // pack-install seeding + the owner boot-reconcile + mint.
    segments: ['contract_id', 'entry_key'],
    required: ['contract_id', 'entry_key'],
    value_shape: 'grant_entry',
    applies_to: ['contract_grant'],
    merge_precedence: 0,
    merge_rule: 'override',
    writeable_by: 'user+kernel',
  },
};

/** The canonical contract-schema code seed loaded into `contract.schema.*` at
 *  runtime (the store seeds it; the gateway + dispatcher read it). Holds D-165's 5
 *  composite_keys + value_shapes AND D-166's cross-spec entries as they land
 *  (per the file header, D-166 extends THIS file rather than a sibling registry —
 *  every consumer already reads `D165_CONTRACT_SCHEMA`). D-166 P2 adds
 *  `policy_matrix` (+ `policy_matrix_cell`); `connection_record` / `preflight_state`
 *  / `contract_definition` remain unbuilt. The export name is kept for stability
 *  even though it now carries D-166 entries too. */
export const D165_CONTRACT_SCHEMA: ContractSchemaRegistry = {
  composite_keys: COMPOSITE_KEYS,
  value_shapes: VALUE_SHAPES,
};

// ════════════════════════════════════════════════════════════════
// Self-consistency validator
// ════════════════════════════════════════════════════════════════

/** Stable codes for a malformed schema registry. */
export type ContractSchemaIssueCode =
  | 'value_shape_missing'
  | 'required_not_a_segment'
  | 'optional_tail_not_a_segment'
  | 'optional_tail_overlaps_required'
  | 'optional_tail_not_suffix'
  | 'optional_tail_match_invalid'
  | 'applies_to_empty'
  | 'applies_to_unknown_role'
  | 'merge_rule_invalid'
  | 'writeable_by_invalid'
  | 'merge_precedence_invalid'
  | 'value_shape_required_not_a_field'
  | 'value_shape_field_untyped'
  | 'value_shape_type_unknown';

export interface ContractSchemaIssue {
  code: ContractSchemaIssueCode;
  /** `composite_keys.<scope>` or `value_shapes.<shape>` — where the issue is. */
  entry: string;
  detail: string;
}

const arraySuffixEquals = (
  arr: readonly string[],
  tail: readonly string[],
): boolean => {
  if (tail.length > arr.length) return false;
  const start = arr.length - tail.length;
  for (let i = 0; i < tail.length; i += 1) {
    if (arr[start + i] !== tail[i]) return false;
  }
  return true;
};

/** True when a descriptor BASE (after stripping `?` / `[]`) is a recognized
 *  primitive — `string` / `number` / `bool` / `datetime` / `json` / `enum:…`.
 *  Anything else is treated as a NESTED value_shape reference (D-166
 *  `contract_definition.scope: 'contract_scope'`). */
const isPrimitiveBase = (base: string): boolean =>
  base === 'string'
  || base === 'number'
  || base === 'bool'
  || base === 'datetime'
  || base === 'json'
  || base.startsWith('enum:');

/** Strip a `types` descriptor's trailing `?` (optional) then `[]` (array) to its
 *  base token — the primitive name or the nested value_shape name. */
const descriptorBase = (descriptor: string): string => {
  let d = descriptor.trim();
  if (d.endsWith('?')) d = d.slice(0, -1);
  if (d.endsWith('[]')) d = d.slice(0, -2);
  return d;
};

/** Validate a contract schema registry is internally well-formed — every
 *  composite_key references a declared value_shape, segment/required/optional_tail
 *  relationships hold, roles + merge_rule + writeable_by are in their
 *  vocabularies, and every value_shape's `required` ⊆ `fields` with a type per
 *  field. Pure; returns every issue (empty array ⇒ valid). Used by the build to
 *  prove D-165's seed is consistent and (later) to gate spec contributions as
 *  they are merged into the runtime schema. */
export const validateContractSchemaRegistry = (
  registry: ContractSchemaRegistry,
): ContractSchemaIssue[] => {
  const issues: ContractSchemaIssue[] = [];
  const add = (code: ContractSchemaIssueCode, entry: string, detail: string): void => {
    issues.push({ code, entry, detail });
  };

  for (const [name, ck] of Object.entries(registry.composite_keys)) {
    const where = `composite_keys.${name}`;
    const segmentSet = new Set(ck.segments);

    if (!Object.prototype.hasOwnProperty.call(registry.value_shapes, ck.value_shape)) {
      add('value_shape_missing', where, `references undeclared value_shape '${ck.value_shape}'`);
    }
    for (const seg of ck.required) {
      if (!segmentSet.has(seg)) {
        add('required_not_a_segment', where, `required segment '${seg}' is not in segments`);
      }
    }
    const requiredSet = new Set(ck.required);
    const tail = ck.optional_tail ?? [];
    for (const seg of tail) {
      if (!segmentSet.has(seg)) {
        add('optional_tail_not_a_segment', where, `optional_tail segment '${seg}' is not in segments`);
      }
      if (requiredSet.has(seg)) {
        add('optional_tail_overlaps_required', where, `segment '${seg}' is both required and optional_tail`);
      }
    }
    if (tail.length > 0 && !arraySuffixEquals(ck.segments, tail)) {
      add('optional_tail_not_suffix', where, `optional_tail ${JSON.stringify(tail)} must be a contiguous suffix of segments ${JSON.stringify(ck.segments)}`);
    }
    if (
      ck.optional_tail_match !== undefined
      && ck.optional_tail_match !== 'match_all'
      && ck.optional_tail_match !== 'baseline_only'
    ) {
      add('optional_tail_match_invalid', where, `invalid optional_tail_match '${String(ck.optional_tail_match)}' (expected 'match_all' | 'baseline_only')`);
    }
    if (ck.applies_to.length === 0) {
      add('applies_to_empty', where, 'applies_to must list at least one dispatch role');
    }
    for (const role of ck.applies_to) {
      if (!isDispatchRole(role)) {
        add('applies_to_unknown_role', where, `unknown dispatch role '${String(role)}'`);
      }
    }
    if (!isMergeRule(ck.merge_rule)) {
      add('merge_rule_invalid', where, `invalid merge_rule '${String(ck.merge_rule)}'`);
    }
    if (!isWriteableBy(ck.writeable_by)) {
      add('writeable_by_invalid', where, `invalid writeable_by '${String(ck.writeable_by)}'`);
    }
    if (!Number.isInteger(ck.merge_precedence) || ck.merge_precedence < 0) {
      add('merge_precedence_invalid', where, `merge_precedence must be a non-negative integer (got ${String(ck.merge_precedence)})`);
    }
  }

  for (const [name, vs] of Object.entries(registry.value_shapes)) {
    const where = `value_shapes.${name}`;
    const fieldSet = new Set(vs.fields);
    for (const req of vs.required) {
      if (!fieldSet.has(req)) {
        add('value_shape_required_not_a_field', where, `required '${req}' is not in fields`);
      }
    }
    for (const field of vs.fields) {
      if (!Object.prototype.hasOwnProperty.call(vs.types, field)) {
        add('value_shape_field_untyped', where, `field '${field}' has no entry in types`);
        continue;
      }
      // D-166 contract_definition — a descriptor's base must be a known PRIMITIVE
      // or a declared value_shape NAME (nested value_shape, e.g.
      // `contract_definition.scope: 'contract_scope'`). A typo'd ref would
      // silently fail every write at the scalar gate, so catch it at seed time.
      const base = descriptorBase(vs.types[field]);
      if (
        !isPrimitiveBase(base)
        && !Object.prototype.hasOwnProperty.call(registry.value_shapes, base)
      ) {
        add(
          'value_shape_type_unknown',
          where,
          `field '${field}' type '${vs.types[field]}' is neither a primitive descriptor nor a declared value_shape`,
        );
      }
    }
  }

  return issues;
};

// ════════════════════════════════════════════════════════════════
// Write-time validation (the per-row structural gate)
//
// Validates a single contract DATA row against the schema: the path's segments
// satisfy the scope's `required` / `optional_tail`, and the value satisfies the
// referenced value_shape's `required` + per-field type descriptors. Pure +
// storage-agnostic — it operates on (scope, segments[], value), never on a
// joined storage key (key encoding is the store's concern).
//
// NOT here: the merge-aware `tightening_only` rule ("a write may not LOOSEN the
// running aggregate"). That needs the running aggregate + the merge algebra (a
// later slice). This is the per-row structural gate only.
// ════════════════════════════════════════════════════════════════

/** Stable codes for a malformed contract data-row write. */
export type ContractWriteIssueCode =
  | 'unknown_scope'
  | 'missing_required_segment'
  | 'too_many_segments'
  | 'invalid_segment'
  | 'value_not_object'
  | 'missing_required_field'
  | 'unknown_field'
  | 'type_mismatch';

export interface ContractWriteIssue {
  code: ContractWriteIssueCode;
  /** `<scope>` (segment-level issue) or `<scope>.<field>` (value-level issue). */
  entry: string;
  detail: string;
}

/** Check one non-null JSON scalar against a value_shape base type descriptor
 *  (`string` | `number` | `bool` | `datetime` | `json` | `enum:a|b|c`).
 *  `datetime` is an epoch-ms number (the store's `now()` convention); `json` is
 *  any non-null value. An unrecognized base fails closed so a malformed schema
 *  surfaces as a rejected write. */
const conformsToScalar = (base: string, value: unknown): boolean => {
  switch (base) {
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'datetime':
      return typeof value === 'number' && Number.isFinite(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'json':
      return value !== null && value !== undefined;
    default:
      if (base.startsWith('enum:')) {
        return typeof value === 'string' && base.slice(5).split('|').includes(value);
      }
      return false;
  }
};

/** Shared empty `seen` set for the top-level descriptor check (no value_shape is
 *  on the recursion stack yet). Never mutated (`conformsToValueShape` copies). */
const EMPTY_SEEN: ReadonlySet<string> = new Set<string>();

/** Validate `value` against the nested value_shape `shapeName` declared in
 *  `registry` — a plain object whose `required` fields are present and whose every
 *  present field conforms to its descriptor (recursing through
 *  `conformsToDescriptor`, so a value_shape may nest another). Unknown nested
 *  fields are rejected (mirrors the top-level write gate). `seen` carries the
 *  value_shapes already on the recursion stack and FAILS CLOSED on re-entry, so a
 *  cyclic schema can't loop forever. D-166 `contract_definition.scope:
 *  'contract_scope'` is the first nested reference. */
const conformsToValueShape = (
  registry: ContractSchemaRegistry,
  shapeName: string,
  value: unknown,
  seen: ReadonlySet<string>,
): boolean => {
  if (seen.has(shapeName)) return false;
  const vs = registry.value_shapes[shapeName];
  if (!vs || !isPlainObject(value)) return false;
  for (const req of vs.required) {
    if (!Object.prototype.hasOwnProperty.call(value, req)) return false;
  }
  const fieldSet = new Set(vs.fields);
  const nextSeen = new Set(seen).add(shapeName);
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!fieldSet.has(key)) return false;
    if (!conformsToDescriptor(vs.types[key], fieldValue, registry, nextSeen)) return false;
  }
  return true;
};

/** Check a JSON value against one value_shape type descriptor (the `types`
 *  mini-language). A trailing `?` makes the field nullable/optional (`null` /
 *  `undefined` conform only then). A `<base>[]` descriptor requires an array
 *  whose every element conforms to `<base>` (elements must be non-null). The base
 *  is a PRIMITIVE (`conformsToScalar`) or, when `registry` is supplied and names
 *  it, a nested value_shape (`conformsToValueShape`). With no `registry`, a
 *  non-primitive base fails closed — the pre-D-166 behaviour for every existing
 *  shape (all primitive). */
const conformsToDescriptor = (
  descriptor: string,
  value: unknown,
  registry?: ContractSchemaRegistry,
  seen: ReadonlySet<string> = EMPTY_SEEN,
): boolean => {
  let d = descriptor.trim();
  const optional = d.endsWith('?');
  if (optional) d = d.slice(0, -1);
  if (value === null || value === undefined) return optional;
  const isArray = d.endsWith('[]');
  const base = isArray ? d.slice(0, -2) : d;
  const conformsBase = (element: unknown): boolean => {
    if (isPrimitiveBase(base)) return conformsToScalar(base, element);
    if (registry && Object.prototype.hasOwnProperty.call(registry.value_shapes, base)) {
      return conformsToValueShape(registry, base, element, seen);
    }
    return false;
  };
  if (isArray) {
    if (!Array.isArray(value)) return false;
    // Index-walk (not `.every`, which SKIPS holes) so a sparse array — a hole
    // serializes to `null` via JSON.stringify, violating the non-null element
    // contract — is rejected alongside wrong-typed elements.
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value) || !conformsBase(value[i])) return false;
    }
    return true;
  }
  return conformsBase(value);
};

/** A true plain JSON object — rejects arrays AND exotic objects (`Date`, `Map`,
 *  class instances) whose `JSON.stringify` form (a scalar string, `{}`, …) would
 *  silently corrupt the persisted row shape past an empty-required value_shape. */
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

/** Validate a single contract DATA-row write against the schema registry.
 *  `scope` names a `composite_keys` entry; `segments` are the ordered path
 *  segment VALUES (not a joined key); `value` is the row value. Returns every
 *  structural issue (empty ⇒ the write is well-formed).
 *
 *  Assumes `registry` is itself well-formed — the store seeds only registries
 *  that pass `validateContractSchemaRegistry`, so `optional_tail` is a suffix
 *  and `required` is therefore the segment prefix; a length-range check on
 *  `segments` is then exact (any length in `[required, segments]` provides the
 *  required prefix and an in-order optional-tail extension). */
export const validateContractWrite = (
  registry: ContractSchemaRegistry,
  scope: string,
  segments: readonly unknown[],
  value: unknown,
): ContractWriteIssue[] => {
  if (!Object.prototype.hasOwnProperty.call(registry.composite_keys, scope)) {
    return [{ code: 'unknown_scope', entry: scope, detail: `no composite_keys entry '${scope}'` }];
  }
  const ck = registry.composite_keys[scope];
  const issues: ContractWriteIssue[] = [];

  // Path segments — required (prefix) present, no overflow, each a non-empty string.
  if (segments.length < ck.required.length) {
    issues.push({
      code: 'missing_required_segment',
      entry: scope,
      detail: `expected at least ${ck.required.length} segment(s) [${ck.required.join(', ')}], got ${segments.length}`,
    });
  }
  if (segments.length > ck.segments.length) {
    issues.push({
      code: 'too_many_segments',
      entry: scope,
      detail: `expected at most ${ck.segments.length} segment(s) [${ck.segments.join(', ')}], got ${segments.length}`,
    });
  }
  segments.forEach((seg, i) => {
    if (typeof seg !== 'string' || seg.length === 0) {
      issues.push({
        code: 'invalid_segment',
        entry: scope,
        detail: `segment ${i} (${ck.segments[i] ?? '?'}) must be a non-empty string`,
      });
    }
  });

  // Value — a JSON object matching the referenced value_shape.
  if (!Object.prototype.hasOwnProperty.call(registry.value_shapes, ck.value_shape)) {
    // Unreachable for a registry that passed validateContractSchemaRegistry;
    // surfaced as a write rejection rather than silently accepted.
    issues.push({ code: 'type_mismatch', entry: `${scope}.${ck.value_shape}`, detail: `value_shape '${ck.value_shape}' is not declared` });
    return issues;
  }
  if (!isPlainObject(value)) {
    issues.push({ code: 'value_not_object', entry: scope, detail: 'value must be a JSON object' });
    return issues;
  }
  const vs = registry.value_shapes[ck.value_shape];
  const fieldSet = new Set(vs.fields);
  for (const req of vs.required) {
    if (!Object.prototype.hasOwnProperty.call(value, req)) {
      issues.push({ code: 'missing_required_field', entry: `${scope}.${req}`, detail: `required field '${req}' is absent` });
    }
  }
  for (const field of Object.keys(value)) {
    if (!fieldSet.has(field)) {
      issues.push({ code: 'unknown_field', entry: `${scope}.${field}`, detail: `field '${field}' is not in value_shape '${ck.value_shape}'` });
      continue;
    }
    // `registry` is threaded so a value_shape-reference descriptor (D-166
    // `contract_definition.scope: 'contract_scope'`) recurses into the nested
    // value_shape; a primitive descriptor ignores it.
    if (!conformsToDescriptor(vs.types[field], value[field], registry)) {
      issues.push({ code: 'type_mismatch', entry: `${scope}.${field}`, detail: `value for '${field}' does not match type '${vs.types[field]}'` });
    }
  }

  return issues;
};
