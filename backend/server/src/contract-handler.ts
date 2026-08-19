/** D-166 — rpc handlers for `collection.contract.*` (two families on one slice).
 *
 *  ── Override-write (Slice A1/B) ──────────────────────────────────────
 *  `upsertOverride` / `deleteOverride` / `listOverrides` author + read the
 *  user's `contract.override` rows — the editable, user-owned TIGHTENING layer
 *  the D-166 Slice 4d.4 catalog gateway reads at dispatch (`applyOverrideTightening`
 *  in `packages/engine/src/catalog-gateway.ts`). An override row is keyed
 *  `(actor:KIND, ingredient_id:slug, operation_id?:<slug>.<op>)` and carries an
 *  `override_policy` value; the write is gated by `ContractStore.put`, which both
 *  validates the value-shape AND enforces `tightening_only` — a net-looser write
 *  throws `ContractWriteLoosensError` (mapped to the `contract_write_loosens` rpc
 *  error). The same `app.contractStoreRef` the gateway's `ctx.contractScan` reads
 *  backs this rpc (4d.4 wired the read side over that exact handle), so a
 *  freshly-authored override TIGHTENS the very next dispatch with no reseed step.
 *
 *  ── contract_id lifecycle (the gating piece) ─────────────────────────
 *  `mintContract` / `revokeContract` / `listContracts` are the Settings → Privacy
 *  → Contracts surface over the `contract.contract_definition.*` store
 *  (`createContractDefinitionStore`, built here from the same `deps.store`). D-148's
 *  policy matrix referenced `contract_id` values; D-166's use-resolution slice wired
 *  the parked `policy-matrix-dispatch` overlay over `.<contract_id>` rows gated on
 *  `isContractActive` + scope — but until something MINTS a contract every overlay
 *  resolve hit `def === null` and stayed inert. THIS family mints them, and the
 *  store ops are authoritative: `mintContract` stamps `minted_by` from the
 *  authenticated client's `display_name` (provenance); `revokeContract` stamps
 *  `revoked_at` (→ the row is inert at `contractLifecycleState`); `listContracts`
 *  feeds the UI. Each returns a `ContractDefinitionView` (the row + a server-
 *  resolved `lifecycle_state`).
 *
 *  BINDING GAP (documented residual): the overlay resolver looks a definition up
 *  by the DISPATCH's `ExecutionSource.contract_id`, so a minted `ct_*` only
 *  governs a dispatch that CARRIES that id. No live path produces one yet — the
 *  MCP producer derives `contract_id` from the MCP token id and authorizes from
 *  token grants. So today this surface AUTHORS the lifecycle record (mint / list /
 *  revoke are real over the store) but is not yet a live kill-switch over a running
 *  agent; making revoke bite a live dispatch needs the MCP-token ↔ minted-contract
 *  binding (+ the approval-resume `recordUse`), the next slice. The substrate is
 *  correct — once a dispatch's `contract_id` names a minted contract, the overlay +
 *  revoke apply with no further change here.
 *
 *  Settings-only by construction: `collection.contract.` is in
 *  `MCP_RESERVED_RPC_PREFIXES` so an MCP-channel agent can never author / delete
 *  its own policy, mint itself a contract, nor enumerate the user's posture.
 *  Omitting `deps` (db-less harness, or a server with no catalog) leaves all
 *  methods returning `not_configured` (the whole slice is absent).
 *
 *  Spec: D-166 §"contract_definition lifecycle"; the use-resolution
 *  overlay this lights up is documented in the contract-definition handover. */

import { RpcError, isActor, isChannel, isCatalogForm, ACTORS, CHANNELS, ContractMergeError, OVERRIDE_SCOPE, overrideRowValue, isEmptyOverridePolicy, OWNER_OPERATION_SCOPE, ownerOperationRowValue, isEmptyOwnerOperationPolicy, ownerOperationIngredientViews, catalogIngredientViews, contractLifecycleState, DELEGATION_RULE_MAX_USES, DELEGATION_RULE_RISK_TIERS, DELEGATION_RULE_TTL_MS, DELEGATION_SUGGEST_LOOKBACK_MS, delegationRuleMintPlanFromSnapshot, delegationRuleSuggestionKeyHash, qualityDelegationMintPlanFromSnapshot, qualityDelegationSuggestionKeyHash, SCOPED_GRANT_MAX_USES_DEFAULT, SESSION_GRANT_RISK_TIERS, approvalFloorForRisk, isApprovalBelowRiskFloor, isOperationApproval, isRiskTier, RISK_TIER_RANK, renderScopedGrantSentence, scopedGrantSuggestionKeyHash, isDoorType, DOOR_TYPES, derivedDoorType, opGrantEntry, isReservedOwnerContractId, CONTRACT_GRANT_KINDS, isContractGrantKind, isStandingContractDefinition, type DoorType } from '@recued/contracts';
import type {
  Actor,
  CatalogIngredientView,
  Channel,
  ContractDefinition,
  ContractDefinitionView,
  ContractListRequest,
  ContractListResponse,
  ContractScope,
  DelegationRuleSuggestionRow,
  QualityDelegationSuggestionRow,
  ScopedGrantSuggestionRow,
  HandlerSlice,
  IngredientManifest,
  MintContractRequest,
  OperationApproval,
  OperationRiskTier,
  OperationSpec,
  OwnerOperationIngredientView,
  OwnerOperationPolicyInput,
  OwnerOperationView,
  OverridePolicyInput,
  OverrideView,
  ServerEvent,
  ServerRpcRegistry,
  SessionGrantListRequest,
  SessionGrantListResponse,
  SessionGrantPermits,
  SessionGrantRevokeRequest,
  SessionGrantView,
  SetContractDoorTypesRequest,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import type { WsClient } from './ws-server.js';
import {
  ContractWriteInvalidError,
  ContractWriteLoosensError,
  type ContractRow,
  type ContractStore,
} from './storage/contract-store.js';
import {
  DelegationRuleMintError,
  QualityDelegationMintError,
  ScopedGrantMintError,
  createContractDefinitionStore,
  type ContractDefinitionStore,
} from './storage/contract-definition-store.js';
import { createContractGrantEntryStore } from './storage/contract-grant-entry-store.js';
import {
  createDelegationSuggestionStore,
  type DelegationSuggestionStore,
} from './storage/delegation-suggestion-store.js';
import {
  createQualityDelegationSuggestionStore,
  type QualityDelegationSuggestionStore,
} from './storage/quality-delegation-suggestion-store.js';
import {
  createScopedGrantSuggestionStore,
  type ScopedGrantSuggestionStore,
} from './storage/scoped-grant-suggestion-store.js';
import { listScopedConnectionCandidates } from './scoped-grant-binding.js';
import { operationSpecHash } from './operation-spec-hash.js';
import { createConnectionCatalogBindingStore } from './storage/connection-catalog-binding-store.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import { readRecipeCoverageUsage } from './recipe-coverage-usage.js';
import { buildRecipeOpDependencyIndex } from './derive-recipe-capability.js';
import type { RecipeStore } from './recipe-store.js';

/** D-171 — the contract-family broadcast variants minus the bus-assigned
 *  `cursor` field. Mirrors `ServerEventInput` (events/bus.ts) but narrowed to
 *  the contract kinds this handler emits, so it emits a closed-list shape and
 *  the bus stamps the cursor. D-177 N.13 (P6c) widens the extract with the
 *  suggestion-resolved kind (accept/dismiss fan-out). (The distributive
 *  conditional is needed — a plain `Omit` over a union collapses to shared
 *  keys; see the `ServerEventInput` / `ReceptionBroadcastEvent` rationale.) */
export type ContractBroadcastEvent =
  Extract<
    ServerEvent,
    {
      kind:
        | 'contract.contract_definition_changed'
        | 'contract.delegation_rule_suggestion_resolved'
        // D-177 N.11 rule 5 (5.c, slice C) — scoped-proposal accept/dismiss.
        | 'contract.scoped_grant_suggestion_resolved';
    }
  > extends infer T
    ? T extends { cursor: number }
      ? Omit<T, 'cursor'>
      : never
    : never;

/** D-247 D13 — the coverage ledger's default window. 30 days matches the copy
 *  D11's op row renders ("ran 3× in the last 30 days") and is short enough that
 *  the answer describes CURRENT usage rather than the whole retained log. */
const DEFAULT_COVERAGE_WINDOW_DAYS = 30;

export interface ContractRpcDeps {
  /** D-177 N.14.8 fork 3 — counts the owner's D-173 rejects on one door, for the
   *  suggestion card's counter-evidence. OPTIONAL: absent ⇒ door rows carry no
   *  reject count at all, which the card renders as "not counted" — never as a
   *  false zero. [[feedback_declared_is_not_backed]] */
  countDoorRejects?: DoorRejectCounter;
  /** The local-only `contract.*` store. The SAME instance the catalog gateway's
   *  override-tightening scan reads (`app.contractStoreRef`), so an authored
   *  override is honoured on the next dispatch with no reseed. */
  store: ContractStore;
  /** D-171 — broadcast bus emit seam for the `contract_definition` lifecycle.
   *  The bus assigns the cursor; the handler supplies the kind + payload. Fired
   *  on every `mintContract` / `revokeContract` so paired clients' Contracts
   *  inspector + MCP-door Advanced summary re-list off the authoritative signal
   *  (replacing the `chat.inbound_token_changed` proxy — which missed the
   *  trailing bare `revokeContract`). Optional: a db-less / no-bus harness wires
   *  no broadcast (the lifecycle writes still succeed; only the live fan-out is
   *  absent). Emit failures are swallowed (observability-only — never abort the
   *  rpc), mirroring the chat-handler's `deps.broadcast` discipline. */
  broadcast?: (event: ContractBroadcastEvent) => void;
  /** Resolve an ingredient manifest by slug — catalog overrides validate a
   *  declared qualified operation; simple-form overrides validate their one
   *  slug-keyed operation. Returns null only for unknown ingredients. Wired
   *  from the server manifest registry (`executorConfig.manifests`). */
  getManifest: (slug: string) => IngredientManifest | null;
  /** Enumerate every loaded manifest — the source for `listCatalogOperations`
   *  (the picker inventory), which filters to catalog-form + projects. Wired
   *  from the manifest registry (`slugs()` → `get()`). */
  listManifests: () => IngredientManifest[];
  /** Clock (epoch-ms) for minted / revoked timestamps AND the response views'
   *  resolved `lifecycle_state`. One clock backs both the definition store and
   *  the view projection so a just-minted contract reads back `active`.
   *  Defaults to `Date.now`; tests inject a fixed/steppable now. */
  now?: () => number;
  /** `contract_id` factory for `mintContract`. MUST return a fresh unique id per
   *  call (the store upserts). Defaults to a `ct_`-prefixed v4 UUID; tests inject
   *  a deterministic counter. */
  newContractId?: () => string;
  /** D-177 N.13 (P6c) — the D-120 activity log for the reserve-class
   *  `delegation_rule_minted` audit row the suggestion-accept writes.
   *  Optional (db-less harnesses): absent ⇒ the mint still lands, only the
   *  audit breadcrumb is skipped — same posture as the session-grant
   *  resolver's `auditLog` dep. */
  auditLog?: AuditLogStore;
  /** D-247 D11 — the recipe roster, for the STATIC half of the op row ("which
   *  recipes could reach this op"). ⚠ Absent ⇒ `could` is empty everywhere, which
   *  the copy must render as "not computed" rather than "nothing uses this". */
  recipeStore?: Pick<RecipeStore, 'ids' | 'get'>;
  /** D-177 N.11 rule 5 (5.c, slice C) — the connection store, for the scoped
   *  accept rpc's LIVE connection-candidate validation (single candidate
   *  auto-filled, multiple human-picked, none ⇒ unmintable). Optional:
   *  absent ⇒ the accept refuses with `not_configured` (a proposal can
   *  never mint without the live candidate check). */
  getConnectionStore?: () => Pick<ConnectionStoreSqlite, 'list'> | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const ensureRecordArgs = (method: string, args: unknown): Record<string, unknown> => {
  if (!isRecord(args)) {
    throw new RpcError('bad_request', `${method}: args must be an object`);
  }
  return args;
};

const ensureActor = (method: string, value: unknown): Actor => {
  if (!isActor(value)) {
    throw new RpcError(
      'bad_request',
      `${method}: actor must be one of ${ACTORS.join(' / ')} (got '${String(value)}')`,
    );
  }
  return value;
};

const ensureIngredientId = (method: string, value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcError('bad_request', `${method}: ingredient_id is required`);
  }
  return value;
};

/** `operation_id` is optional on the key (absent ⇒ an ingredient-wide
 *  override). When present it must be a non-empty string; the declared-op check
 *  against the manifest is a separate, catalog-aware gate. */
const ensureOptionalOperationId = (method: string, value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcError(
      'bad_request',
      `${method}: operation_id, when present, must be a non-empty string`,
    );
  }
  return value;
};

const ensureOperationId = (method: string, value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcError('bad_request', `${method}: operation_id is required`);
  }
  return value;
};

const requireOverrideManifest = (
  deps: ContractRpcDeps,
  method: string,
  ingredient_id: string,
): IngredientManifest => {
  const manifest = deps.getManifest(ingredient_id);
  if (!manifest) {
    throw new RpcError(
      'bad_request',
      `${method}: '${ingredient_id}' is not a known ingredient`,
    );
  }
  return manifest;
};

/** Legacy actor-scoped contract overrides are catalog-only and continue to
 * tighten the existing operation admission flow. */
const requireCatalogManifest = (
  deps: ContractRpcDeps,
  method: string,
  ingredient_id: string,
): IngredientManifest => {
  const manifest = deps.getManifest(ingredient_id);
  if (!manifest || !isCatalogForm(manifest)) {
    throw new RpcError(
      'bad_request',
      `${method}: '${ingredient_id}' is not a known catalog-form ingredient`,
    );
  }
  return manifest;
};

/** Both manifest shapes expose one operation identity to owner rulings:
 * catalog form uses its declared qualified id; simple form is keyed by slug. */
const ensureOverrideOperation = (
  manifest: IngredientManifest,
  method: string,
  operation_id: string,
): OperationSpec => {
  if (isCatalogForm(manifest)) {
    return ensureDeclaredOperation(manifest, method, operation_id);
  }
  if (operation_id !== manifest.slug) {
    throw new RpcError(
      'bad_request',
      `${method}: simple-form ingredient '${manifest.slug}' has one operation, '${manifest.slug}'`,
    );
  }
  return { operation_id: manifest.slug, risk_tier: manifest.risk_tier };
};

/** Validate `operation_id` names a declared operation of the manifest and
 *  return its `OperationSpec` (the D-211 write-gate needs the declared
 *  `risk_tier` + the spec for the `op_hash` stamp). Operations are keyed in the
 *  manifest by short name but carry a fully-qualified `operation_id`
 *  (`<slug>.<op>`) — the override key uses the fully-qualified id (matching the
 *  4d.4 gateway scan), so we match on `operation_id`. */
const ensureDeclaredOperation = (
  manifest: IngredientManifest,
  method: string,
  operation_id: string,
): OperationSpec => {
  const declared = Object.values(manifest.operations ?? {}).find(
    (op) => op.operation_id === operation_id,
  );
  if (!declared) {
    throw new RpcError(
      'bad_request',
      `${method}: '${operation_id}' is not a declared operation of '${manifest.slug}'`,
    );
  }
  return declared;
};

const ownerOperationViewFromRow = (row: ContractRow): OwnerOperationView => {
  const value = row.value as Record<string, unknown>;
  const risk = isRiskTier(value.risk) ? value.risk : undefined;
  const approval = isOperationApproval(value.approval) ? value.approval : undefined;
  return {
    ingredient_id: row.segments[0],
    operation_id: row.segments[1],
    policy: {
      ...(risk !== undefined ? { risk } : {}),
      ...(approval !== undefined ? { approval } : {}),
    },
    ...(risk !== undefined ? { risk } : {}),
    ...(approval !== undefined ? { approval } : {}),
    ...(typeof value.op_hash === 'string' ? { op_hash: value.op_hash } : {}),
    written_at: row.written_at,
  };
};

const overrideViewFromRow = (row: ContractRow): OverrideView => ({
  actor: row.segments[0] as Actor,
  ingredient_id: row.segments[1],
  operation_id: row.segments[2] ?? null,
  policy: row.value as OverridePolicyInput,
  written_at: row.written_at,
});

const overrideSegments = (
  actor: Actor,
  ingredient_id: string,
  operation_id: string | undefined,
): string[] =>
  operation_id !== undefined
    ? [actor, ingredient_id, operation_id]
    : [actor, ingredient_id];

/** D-211 — reserve-class audit row for a global owner-operation write/delete, per the
 *  `delegation_rule_minted` template: guard the optional `deps.auditLog`,
 *  AWAIT (human-paced rpc — the response only returns once the reserve row
 *  landed), and a failure NEVER unwinds the write (warn + proceed: the row
 *  itself is the durable record and delete is the kill switch). */
const emitOverrideAudit = async (
  deps: ContractRpcDeps,
  action: 'owner_operation_override_written' | 'owner_operation_override_deleted',
  target: string,
  detail: Record<string, unknown>,
): Promise<void> => {
  if (deps.auditLog === undefined) return;
  try {
    await deps.auditLog.logActivity({
      activity_id: '',
      timestamp: (deps.now ?? Date.now)(),
      action,
      target,
      detail: JSON.stringify(detail),
    });
  } catch (err) {
    console.warn(
      `[contract-handler] ${action} audit failed for '${target}': `
        + (err instanceof Error ? err.message : String(err)),
    );
  }
};

export const upsertContractOverride = async (
  deps: ContractRpcDeps,
  args: { actor: Actor; ingredient_id: string; operation_id?: string; policy: OverridePolicyInput },
): Promise<OverrideView> => {
  const method = 'collection.contract.upsertOverride';
  const a = ensureRecordArgs(method, args);
  const actor = ensureActor(method, a.actor);
  const ingredient_id = ensureIngredientId(method, a.ingredient_id);
  const operation_id = ensureOptionalOperationId(method, a.operation_id);
  if (!isRecord(a.policy)) {
    throw new RpcError('bad_request', `${method}: policy must be an object`);
  }
  if (isEmptyOverridePolicy(a.policy)) {
    throw new RpcError(
      'bad_request',
      `${method}: policy must set at least one field — use deleteOverride to clear an override`,
    );
  }
  // Catalog validation BEFORE the write so an unknown ingredient/operation
  // surfaces a clear `bad_request` rather than a structural store rejection.
  const manifest = requireCatalogManifest(deps, method, ingredient_id);
  if (operation_id !== undefined) ensureDeclaredOperation(manifest, method, operation_id);

  const segments = overrideSegments(actor, ingredient_id, operation_id);
  try {
    deps.store.put(OVERRIDE_SCOPE, segments, overrideRowValue(a.policy));
  } catch (err) {
    if (err instanceof ContractWriteLoosensError) {
      throw new RpcError('contract_write_loosens', err.message, undefined, method, {
        loosened_fields: err.loosenedFields,
      });
    }
    if (err instanceof ContractWriteInvalidError) {
      throw new RpcError('bad_request', err.message, undefined, method, {
        issues: err.issues,
      });
    }
    // The store's `tightening_only` enforcement projects the policy onto the
    // merge lattice, which rejects a numeric field that passes the structural
    // `number?` value-shape gate but violates its domain (`timeout_ms` integer
    // ≥ 1, `cache_ttl_ms` integer ≥ 0) — e.g. `{ timeout_ms: 0 }` / `1.5` /
    // `{ cache_ttl_ms: -1 }`. That's a client-correctable payload error, not a
    // server fault, so map it to `bad_request` rather than letting it surface
    // as `internal`.
    if (err instanceof ContractMergeError) {
      throw new RpcError('bad_request', err.message, undefined, method);
    }
    throw err;
  }
  const row = deps.store.get(OVERRIDE_SCOPE, segments);
  if (!row) {
    // Unreachable — `put` just succeeded against the same synchronous store.
    throw new RpcError('internal', `${method}: override row missing after write`);
  }

  return overrideViewFromRow(row);
};

const handleContractDeleteOverride = async (
  deps: ContractRpcDeps,
  args: { actor: Actor; ingredient_id: string; operation_id?: string },
): Promise<{ deleted: boolean }> => {
  const method = 'collection.contract.deleteOverride';
  const a = ensureRecordArgs(method, args);
  const actor = ensureActor(method, a.actor);
  const ingredient_id = ensureIngredientId(method, a.ingredient_id);
  const operation_id = ensureOptionalOperationId(method, a.operation_id);
  // No catalog re-validation — an override for a since-uninstalled ingredient
  // must still be removable (revert that key to the grant floor).
  const segments = overrideSegments(actor, ingredient_id, operation_id);
  return { deleted: deps.store.delete(OVERRIDE_SCOPE, segments) };
};

const handleContractListOverrides = async (
  deps: ContractRpcDeps,
  args: { ingredient_id?: string } | void,
): Promise<{ overrides: OverrideView[] }> => {
  const method = 'collection.contract.listOverrides';
  const a = args === undefined || args === null ? {} : ensureRecordArgs(method, args);
  const ingredient_id = a.ingredient_id;
  if (ingredient_id !== undefined && (typeof ingredient_id !== 'string' || ingredient_id.trim() === '')) {
    throw new RpcError(
      'bad_request',
      `${method}: ingredient_id, when present, must be a non-empty string`,
    );
  }
  // `ingredient_id` is the SECOND key segment, not a scan prefix (the first is
  // `actor`), so the filter is applied post-scan over the whole scope — fine at
  // contract storage-scale (≤ ~175 rows).
  const rows = deps.store.scan(OVERRIDE_SCOPE);
  const filtered =
    typeof ingredient_id === 'string'
      ? rows.filter((r) => r.segments[1] === ingredient_id)
      : rows;
  return { overrides: filtered.map(overrideViewFromRow) };
};

// ════════════════════════════════════════════════════════════════
// D-211 global owner operation defaults
// ════════════════════════════════════════════════════════════════

export const upsertOwnerOperationOverride = async (
  deps: ContractRpcDeps,
  args: {
    ingredient_id: string;
    operation_id: string;
    policy: OwnerOperationPolicyInput;
  },
): Promise<OwnerOperationView> => {
  const method = 'collection.operation.upsertOwnerOverride';
  const a = ensureRecordArgs(method, args);
  const ingredient_id = ensureIngredientId(method, a.ingredient_id);
  const operation_id = ensureOperationId(method, a.operation_id);
  if (!isRecord(a.policy)) {
    throw new RpcError('bad_request', `${method}: policy must be an object`);
  }
  if (isEmptyOwnerOperationPolicy(a.policy)) {
    throw new RpcError(
      'bad_request',
      `${method}: policy must set risk and/or approval — use deleteOwnerOverride to clear`,
    );
  }

  const manifest = requireOverrideManifest(deps, method, ingredient_id);
  const opSpec = ensureOverrideOperation(manifest, method, operation_id);
  const rawRisk = a.policy.risk;
  if (rawRisk !== undefined && rawRisk !== null && !isRiskTier(rawRisk)) {
    throw new RpcError(
      'bad_request',
      `${method}: policy.risk must be one of read|write|admin|destructive`,
    );
  }
  const risk = isRiskTier(rawRisk) ? rawRisk : undefined;
  const rawApproval = a.policy.approval;
  if (
    rawApproval !== undefined
    && rawApproval !== null
    && !isOperationApproval(rawApproval)
  ) {
    throw new RpcError(
      'bad_request',
      `${method}: policy.approval must be one of never|ask|always`,
    );
  }
  const approval = isOperationApproval(rawApproval) ? rawApproval : undefined;
  const effectiveRisk = risk ?? opSpec.risk_tier;
  const segments = [ingredient_id, operation_id];
  const priorRow = deps.store.get(OWNER_OPERATION_SCOPE, segments);
  const priorValue = (priorRow?.value ?? {}) as Record<string, unknown>;
  const priorRisk = isRiskTier(priorValue.risk)
    ? priorValue.risk
    : opSpec.risk_tier;

  if (approval !== undefined && isApprovalBelowRiskFloor(approval, effectiveRisk)) {
    throw new RpcError(
      'owner_operation_below_floor',
      `${method}: approval '${approval}' is below the '${effectiveRisk}' risk floor `
        + `'${approvalFloorForRisk(effectiveRisk)}'`,
      undefined,
      method,
      {
        floor: approvalFloorForRisk(effectiveRisk),
        effective_risk: effectiveRisk,
        declared_risk: opSpec.risk_tier,
      },
    );
  }

  if (
    risk !== undefined
    && RISK_TIER_RANK[risk] < RISK_TIER_RANK[priorRisk]
    && a.policy.confirm_risk_downgrade !== true
  ) {
    throw new RpcError(
      'owner_operation_risk_downgrade_confirm',
      `${method}: reclassifying '${operation_id}' risk '${priorRisk}' → '${risk}' `
        + `moves its approval floor '${approvalFloorForRisk(priorRisk)}' → `
        + `'${approvalFloorForRisk(risk)}'; pass confirm_risk_downgrade: true to acknowledge`,
      undefined,
      method,
      {
        declared_risk: opSpec.risk_tier,
        previous_risk: priorRisk,
        new_risk: risk,
        floor_before: approvalFloorForRisk(priorRisk),
        floor_after: approvalFloorForRisk(risk),
        session_grantable_after: (SESSION_GRANT_RISK_TIERS as readonly string[]).includes(risk),
        delegation_learnable_after: (DELEGATION_RULE_RISK_TIERS as readonly string[]).includes(risk),
      },
    );
  }

  const policy = ownerOperationRowValue(a.policy);
  const op_hash = operationSpecHash(opSpec);
  try {
    deps.store.put(OWNER_OPERATION_SCOPE, segments, { ...policy, op_hash });
  } catch (err) {
    if (err instanceof ContractWriteInvalidError) {
      throw new RpcError('bad_request', err.message, undefined, method, {
        issues: err.issues,
      });
    }
    throw err;
  }
  const row = deps.store.get(OWNER_OPERATION_SCOPE, segments);
  if (row === null) {
    throw new RpcError('internal', `${method}: owner operation row missing after write`);
  }
  await emitOverrideAudit(deps, 'owner_operation_override_written', operation_id, {
    ingredient_id,
    operation_id,
    policy,
    prior_policy: priorRow?.value ?? null,
    declared_risk: opSpec.risk_tier,
    previous_risk: priorRisk,
    effective_risk: effectiveRisk,
    floor_before: approvalFloorForRisk(priorRisk),
    floor_after: approvalFloorForRisk(effectiveRisk),
    op_hash,
  });
  return ownerOperationViewFromRow(row);
};

const handleOwnerOperationDelete = async (
  deps: ContractRpcDeps,
  args: { ingredient_id: string; operation_id: string },
): Promise<{ deleted: boolean }> => {
  const method = 'collection.operation.deleteOwnerOverride';
  const a = ensureRecordArgs(method, args);
  const ingredient_id = ensureIngredientId(method, a.ingredient_id);
  const operation_id = ensureOperationId(method, a.operation_id);
  const segments = [ingredient_id, operation_id];
  const priorRow = deps.store.get(OWNER_OPERATION_SCOPE, segments);
  const deleted = deps.store.delete(OWNER_OPERATION_SCOPE, segments);
  if (deleted) {
    await emitOverrideAudit(deps, 'owner_operation_override_deleted', operation_id, {
      ingredient_id,
      operation_id,
      policy: null,
      prior_policy: priorRow?.value ?? null,
    });
  }
  return { deleted };
};

const handleOwnerOperationList = async (
  deps: ContractRpcDeps,
  args: { ingredient_id?: string } | void,
): Promise<{ overrides: OwnerOperationView[] }> => {
  const method = 'collection.operation.listOwnerOverrides';
  const a = args === undefined || args === null ? {} : ensureRecordArgs(method, args);
  const ingredient_id = a.ingredient_id;
  if (
    ingredient_id !== undefined
    && (typeof ingredient_id !== 'string' || ingredient_id.trim() === '')
  ) {
    throw new RpcError(
      'bad_request',
      `${method}: ingredient_id, when present, must be a non-empty string`,
    );
  }
  const rows = deps.store.scan(
    OWNER_OPERATION_SCOPE,
    typeof ingredient_id === 'string' ? [ingredient_id] : undefined,
  );
  const overrides = rows.map((row) => {
    const view = ownerOperationViewFromRow(row);
    if (view.op_hash === undefined) return view;
    const manifest = deps.getManifest(view.ingredient_id);
    let current: OperationSpec | undefined;
    if (manifest !== null) {
      if (isCatalogForm(manifest)) {
        current = Object.values(manifest.operations ?? {}).find(
          (op) => op.operation_id === view.operation_id,
        );
      } else if (manifest.slug === view.operation_id) {
        current = { operation_id: manifest.slug, risk_tier: manifest.risk_tier };
      }
    }
    return current === undefined || operationSpecHash(current) !== view.op_hash
      ? { ...view, stale: true }
      : view;
  });
  return { overrides };
};

/** ingredient_id → the AUTHORED slug of the pack that installed it.
 *
 *  ⛔ The Permissions tab used to derive pack membership on the CLIENT, from the
 *  manifest's composition slugs. That works only while a pack's ingredients are
 *  named after it. A Records pack registers its catalog under a
 *  content-addressed `records-<hash>` id — a name matching neither the pack nor
 *  its composition — so the guess missed every time and the tab rendered empty.
 *
 *  Ownership is not a guess: `installed_pack.ingredient_ids` records it, and
 *  `authored_pack_slug` carries the name the author gave the pack when the row is
 *  keyed by something else. Resolve it here, once, where the inventory lives. */
const packSlugByIngredientId = (deps: ContractRpcDeps): Map<string, string> => {
  const out = new Map<string, string>();
  for (const row of deps.store.scan('installed_pack')) {
    const value = (row.value ?? {}) as Record<string, unknown>;
    const authored = typeof value.authored_pack_slug === 'string'
      && value.authored_pack_slug.length > 0
      ? value.authored_pack_slug
      : (typeof value.pack_slug === 'string' ? value.pack_slug : row.segments[0]);
    if (typeof authored !== 'string' || authored.length === 0) continue;
    const ids = Array.isArray(value.ingredient_ids) ? value.ingredient_ids : [];
    for (const id of ids) {
      if (typeof id === 'string' && id.length > 0) out.set(id, authored);
    }
  }
  return out;
};

const handleOwnerOperationListOperations = async (
  deps: ContractRpcDeps,
): Promise<{ ingredients: OwnerOperationIngredientView[] }> => {
  const owners = packSlugByIngredientId(deps);
  return {
    // Additive: an ingredient with no inventory row (a bundled manifest no pack
    // installed) keeps its previous shape and the client's existing slug match.
    ingredients: ownerOperationIngredientViews(deps.listManifests()).map((view) => {
      const owner = owners.get(view.ingredient_id);
      return owner === undefined ? view : { ...view, pack_slug: owner };
    }),
  };
};

const handleContractListCatalogOperations = async (
  deps: ContractRpcDeps,
): Promise<{ ingredients: CatalogIngredientView[] }> => {
  // The catalog-form filter + projection + deterministic sort live in the pure
  // `catalogIngredientViews`; the handler supplies the manifest set and the one
  // fact the manifests cannot carry — which pack installed each ingredient.
  const owners = packSlugByIngredientId(deps);
  return {
    ingredients: catalogIngredientViews(deps.listManifests()).map((view) => {
      const owner = owners.get(view.ingredient_id);
      return owner === undefined ? view : { ...view, pack_slug: owner };
    }),
  };
};

// ════════════════════════════════════════════════════════════════
// contract_id lifecycle — mint / revoke / list (the gating piece)
// ════════════════════════════════════════════════════════════════

/** Project a stored definition into the rpc/UI view: the row + its lifecycle
 *  state resolved against the server clock at response time, so the UI renders
 *  the active / revoked / expired / exhausted pill without a client clock. */
const toContractView = (
  def: ContractDefinition,
  nowMs: number,
): ContractDefinitionView => ({
  ...def,
  lifecycle_state: contractLifecycleState(def, nowMs),
});

const ensureNonEmptyString = (
  method: string,
  field: string,
  value: unknown,
): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcError('bad_request', `${method}: ${field} is required`);
  }
  return value;
};

/** Validate an optional epoch-ms field — a finite number when present. */
const ensureOptionalEpochMs = (
  method: string,
  field: string,
  value: unknown,
): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RpcError(
      'bad_request',
      `${method}: ${field}, when present, must be an epoch-ms number`,
    );
  }
  return value;
};

/** Validate optional `max_uses` — an integer ≥ 1. A `0` would mint an
 *  immediately-exhausted (inert) contract, which is never the user's intent;
 *  absent ⇒ unlimited. */
const ensureOptionalMaxUses = (
  method: string,
  value: unknown,
): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RpcError(
      'bad_request',
      `${method}: max_uses, when present, must be an integer ≥ 1`,
    );
  }
  return value;
};

/** Validate the contract scope is a plain object. The deep per-axis `string[]`
 *  shape is enforced by the store's value_shape validator at write time — a
 *  malformed axis surfaces there as `ContractWriteInvalidError` → `bad_request`,
 *  so this only rejects a non-object up front for a clean message. */
const ensureScope = (method: string, value: unknown): ContractScope => {
  if (!isRecord(value)) {
    throw new RpcError('bad_request', `${method}: scope must be an object`);
  }
  return value as ContractScope;
};

/** D-187 §6 (step 7) — validate the optional level-1 `door_types`: absent / `null`
 *  ⇒ undefined (wildcard, the behaviour-preserving default); when present, an array
 *  whose every element is a known {@link DoorType}. Rejects a non-array or an
 *  unknown member up front for a clean message — the store's value_shape
 *  validator is the deep backstop. An empty array is admitted (it means the same
 *  as absent — wildcard — but a client may send it as an explicit "no
 *  restriction"). */
const ensureOptionalDoorTypes = (
  method: string,
  value: unknown,
): DoorType[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every(isDoorType)) {
    throw new RpcError(
      'bad_request',
      `${method}: door_types, when present, must be an array of [${DOOR_TYPES.join(', ')}]`,
    );
  }
  return value as DoorType[];
};

/** D-196 R3 — normal contract authoring has exactly one non-standing opt-in:
 * a human-authored customer template. Customer instances are stamped only by
 * the Seller lifecycle; session/delegation rows keep their dedicated mints. */
const ensureOptionalMintGrantKind = (
  method: string,
  value: unknown,
): 'customer_template' | undefined => {
  if (value === undefined || value === null) return undefined;
  if (value !== 'customer_template') {
    throw new RpcError(
      'bad_request',
      `${method}: grant_kind, when present, must be 'customer_template'`,
    );
  }
  return value;
};

/** D-171 — emit the `contract_definition` lifecycle broadcast (best-effort).
 *  Called AFTER a successful mint / revoke / in-place update (D-187 §6 step 7 —
 *  `setDoorTypes`), so a failed write never emits — a revoke of a missing contract
 *  throws `not_found` before this runs, and a malformed mint throws `bad_request`.
 *  Emit failures are swallowed: the bus is observability, never a reason to fail
 *  the rpc the user just made. (Subscribers re-list on ANY op, so `op` is an
 *  informational discriminant.) */
export const emitContractChanged = (
  broadcast: ContractRpcDeps['broadcast'],
  op: 'mint' | 'revoke' | 'update',
  contract_id: string,
): void => {
  if (!broadcast) return;
  try {
    broadcast({ kind: 'contract.contract_definition_changed', op, contract_id });
  } catch {
    // observability-only; never abort the rpc on emit failure.
  }
};

const handleContractMint = async (
  deps: ContractRpcDeps,
  definitionStore: ContractDefinitionStore,
  now: () => number,
  args: MintContractRequest,
  client: WsClient,
): Promise<ContractDefinitionView> => {
  const method = 'collection.contract.mintContract';
  const a = ensureRecordArgs(method, args);
  const display_name = ensureNonEmptyString(method, 'display_name', a.display_name);
  const grant_kind = ensureOptionalMintGrantKind(method, a.grant_kind);
  const scope = ensureScope(method, a.scope);
  const door_types = ensureOptionalDoorTypes(method, a.door_types);
  const expiry_at = ensureOptionalEpochMs(method, 'expiry_at', a.expiry_at);
  const max_uses = ensureOptionalMaxUses(method, a.max_uses);
  // Provenance: which paired device minted the contract. `display_name` is always
  // populated on a connected client; the `?.` + fallback is defensive for a
  // db-less / synthetic ctx (the family is reserved out of MCP, so the caller is
  // always an operator-channel client).
  const minted_by = client?.display_name?.trim() || 'operator';
  const grantEntryStore = createContractGrantEntryStore(deps.store);
  try {
    let def!: ContractDefinition;
    // D-187 §6 home-#2 — the DOOR OP-GRANT FOLD. Mint + grant-row materialization
    // land ATOMICALLY (one txn over the shared `deps.store`): a door is never
    // persisted with a partial op-grant set. The door's authored op allow-list
    // (`scope.operation_ids`) is written as explicit `granted:true` `contract_grant`
    // op rows so the unified grant store — not the per-token snapshot — becomes the
    // door's op authority (the op-admission gate's scoped-door floor then fail-closes
    // every un-granted pack op). A WILDCARD op-scope (empty / absent `operation_ids`)
    // writes nothing: the door stays op-wildcard (snapshot-gated), matching the gate's
    // wildcard-permissive default. `def.scope.operation_ids` is the value-shape-
    // validated `string[]` the mint just persisted, so the only throw is `opGrantEntry`
    // rejecting a reserved-prefix op id (a malformed payload — caught below).
    deps.store.transaction(() => {
      def = definitionStore.mint({
        minted_by,
        display_name,
        scope,
        ...(grant_kind !== undefined ? { grant_kind } : {}),
        ...(door_types !== undefined ? { door_types } : {}),
        ...(a.approved_actions_template !== undefined
          ? { approved_actions_template: a.approved_actions_template }
          : {}),
        ...(expiry_at !== undefined ? { expiry_at } : {}),
        ...(max_uses !== undefined ? { max_uses } : {}),
      });
      const ts = now();
      for (const opId of def.scope.operation_ids ?? []) {
        grantEntryStore.set(def.contract_id, opGrantEntry(opId), true, ts);
      }
    });
    return toContractView(def, now());
  } catch (err) {
    // A malformed scope axis (non-`string[]`, unknown key, etc.) fails the
    // store's value_shape gate — a client-correctable payload error, not a
    // server fault, so map it to `bad_request` rather than letting it surface
    // as `internal`.
    if (err instanceof ContractWriteInvalidError) {
      throw new RpcError('bad_request', err.message, undefined, method, {
        issues: err.issues,
      });
    }
    // The op-grant fold rejected a reserved-prefix `operation_id` (`data.*` /
    // `enrichment.*` can never be an op grant-entry key — `opGrantEntry` fails loud).
    // Client payload error; the atomic txn rolled the mint back, so nothing persisted.
    if (
      err instanceof Error &&
      err.message.startsWith('grant_entry_op_id_reserved_prefix')
    ) {
      throw new RpcError('bad_request', err.message, undefined, method);
    }
    throw err;
  }
};

const handleContractRevoke = async (
  definitionStore: ContractDefinitionStore,
  now: () => number,
  args: { contract_id: string; reason?: string },
): Promise<ContractDefinitionView> => {
  const method = 'collection.contract.revokeContract';
  const a = ensureRecordArgs(method, args);
  const contract_id = ensureNonEmptyString(method, 'contract_id', a.contract_id);
  // `reason` is provenance on the revoked row; optional with a sensible default
  // (a revoke from the Settings UI rarely carries a typed reason).
  const reason =
    a.reason === undefined || a.reason === null
      ? 'Revoked from Settings'
      : ensureNonEmptyString(method, 'reason', a.reason);
  const def = definitionStore.revoke(contract_id, reason);
  if (def === null) {
    throw new RpcError(
      'not_found',
      `${method}: no contract '${contract_id}'`,
      404,
      method,
    );
  }
  return toContractView(def, now());
};

/** D-187 §6 (step 7 follow-on) — set the level-1 door types on an EXISTING
 *  standing contract or customer template in place (no re-mint; an agent's
 *  `contract_id` + any bound MCP token survive).
 *  The level-1 "door on/off" toggles 3c renders per door. `door_types` is REQUIRED
 *  (`[]` clears → wildcard); the reserved owner id is rejected (it is derived at
 *  the gate, never a stored door); a non-standing / missing row → `not_found`. */
const handleContractSetDoorTypes = async (
  definitionStore: ContractDefinitionStore,
  now: () => number,
  args: SetContractDoorTypesRequest,
): Promise<ContractDefinitionView> => {
  const method = 'collection.contract.setDoorTypes';
  const a = ensureRecordArgs(method, args);
  const contract_id = ensureNonEmptyString(method, 'contract_id', a.contract_id);
  // The reserved OWNER contract is DERIVED at the gate from an owner-AI source — it
  // has no `contract_definition` row and is not a door (the owner's own AI is not
  // an external door). Reject up front (defense in depth, mirroring the token-bind
  // fence in `handleInboundTokenUpdateContract`).
  if (isReservedOwnerContractId(contract_id)) {
    throw new RpcError(
      'bad_request',
      `${method}: contract_id '${contract_id}' is the reserved owner contract and has no editable door types`,
      400,
      method,
    );
  }
  // `door_types` is REQUIRED (the rpc's whole purpose). A missing key is a caller
  // bug; `[]` (or `null`) clears the restriction → wildcard. A present-but-invalid
  // member / non-array is rejected by `ensureOptionalDoorTypes` (bad_request).
  if (!Object.prototype.hasOwnProperty.call(a, 'door_types')) {
    throw new RpcError(
      'bad_request',
      `${method}: door_types is required (an array of door types; [] clears the restriction)`,
      400,
      method,
    );
  }
  const door_types = ensureOptionalDoorTypes(method, a.door_types) ?? [];
  const def = definitionStore.setDoorTypes(contract_id, door_types);
  if (def === null) {
    // No row, customer instance, or gate-consumed session/delegation grant.
    throw new RpcError(
      'not_found',
      `${method}: no editable standing contract or customer template '${contract_id}'`,
      404,
      method,
    );
  }
  return toContractView(def, now());
};

const CONTRACT_LIST_MAX_LIMIT = 100;
const CONTRACT_LIST_DEFAULT_LIMIT = 25;

interface ContractListCursor {
  readonly minted_at: number;
  readonly contract_id: string;
}

const encodeContractListCursor = (def: ContractDefinition): string =>
  `${def.minted_at}:${encodeURIComponent(def.contract_id)}`;

const parseContractListCursor = (
  method: string,
  value: unknown,
): ContractListCursor | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('bad_request', `${method}: cursor must be a non-empty string`);
  }
  const split = value.indexOf(':');
  if (split <= 0 || split === value.length - 1) {
    throw new RpcError('bad_request', `${method}: cursor is invalid`);
  }
  const minted_at = Number(value.slice(0, split));
  let contract_id: string;
  try {
    contract_id = decodeURIComponent(value.slice(split + 1));
  } catch {
    throw new RpcError('bad_request', `${method}: cursor is invalid`);
  }
  if (!Number.isSafeInteger(minted_at) || minted_at < 0 || contract_id.length === 0) {
    throw new RpcError('bad_request', `${method}: cursor is invalid`);
  }
  return { minted_at, contract_id };
};

const isAfterContractListCursor = (
  def: ContractDefinition,
  cursor: ContractListCursor,
): boolean =>
  def.minted_at < cursor.minted_at
  || (def.minted_at === cursor.minted_at && def.contract_id > cursor.contract_id);

const handleContractList = async (
  definitionStore: ContractDefinitionStore,
  now: () => number,
  args: ContractListRequest | void,
): Promise<ContractListResponse> => {
  const method = 'collection.contract.listContracts';
  const a = args === undefined || args === null ? {} : ensureRecordArgs(method, args);
  const grant_kind = a.grant_kind;
  if (
    grant_kind !== undefined
    && !isContractGrantKind(grant_kind)
  ) {
    throw new RpcError(
      'bad_request',
      `${method}: grant_kind, when present, must be one of ${CONTRACT_GRANT_KINDS.join(' | ')}`,
    );
  }
  const contract_id = a.contract_id;
  if (
    contract_id !== undefined
    && (typeof contract_id !== 'string' || contract_id.trim().length === 0)
  ) {
    throw new RpcError(
      'bad_request',
      `${method}: contract_id, when present, must be a non-empty string`,
    );
  }
  const excludeDerived = a.exclude_derived_doors;
  if (excludeDerived !== undefined && typeof excludeDerived !== 'boolean') {
    throw new RpcError(
      'bad_request',
      `${method}: exclude_derived_doors, when present, must be boolean`,
    );
  }
  const derivedOnly = a.derived_doors_only;
  if (derivedOnly !== undefined && typeof derivedOnly !== 'boolean') {
    throw new RpcError(
      'bad_request',
      `${method}: derived_doors_only, when present, must be boolean`,
    );
  }
  if (excludeDerived === true && derivedOnly === true) {
    throw new RpcError(
      'bad_request',
      `${method}: exclude_derived_doors and derived_doors_only cannot both be true`,
    );
  }
  const limitRaw = a.limit;
  if (
    limitRaw !== undefined
    && (!Number.isSafeInteger(limitRaw) || (limitRaw as number) < 1)
  ) {
    throw new RpcError(
      'bad_request',
      `${method}: limit, when present, must be a positive integer`,
    );
  }
  const paged = limitRaw !== undefined || a.cursor !== undefined;
  const limit = Math.min(
    (limitRaw as number | undefined) ?? CONTRACT_LIST_DEFAULT_LIMIT,
    CONTRACT_LIST_MAX_LIMIT,
  );
  const cursor = parseContractListCursor(method, a.cursor);
  // One clock read for the whole page so every row's `lifecycle_state` resolves
  // against the same instant.
  const at = now();
  const all = definitionStore.list();
  // D-177 N.13 (P6c — the P6a codex LOW): discriminate the listing. Absent ⇒
  // every row (the pre-P6c contract: grant rows surface for visibility +
  // revoke). `'standing'` matches rows carrying no gate-grant kind (the D-166
  // mints stamp none) plus an explicit `'standing'` literal; UNKNOWN future
  // `grant_kind` vocabulary on a JSON row deliberately matches no filter —
  // it appears only in the unfiltered listing, never misfiled as standing.
  let filtered =
    grant_kind === undefined
      ? all
      : grant_kind === 'standing'
        ? all.filter(isStandingContractDefinition)
        : all.filter((def) => def.grant_kind === grant_kind);
  if (typeof contract_id === 'string') {
    filtered = filtered.filter((def) => def.contract_id === contract_id);
  }
  if (excludeDerived === true) {
    filtered = filtered.filter((def) => derivedDoorType(def.door_types) === null);
  } else if (derivedOnly === true) {
    filtered = filtered.filter((def) => derivedDoorType(def.door_types) !== null);
  }
  if (!paged) {
    return { contracts: filtered.map((def) => toContractView(def, at)) };
  }

  const total = filtered.length;
  const afterCursor = cursor === undefined
    ? filtered
    : filtered.filter((def) => isAfterContractListCursor(def, cursor));
  const probe = afterCursor.slice(0, limit + 1);
  const page = probe.slice(0, limit);
  return {
    contracts: page.map((def) => toContractView(def, at)),
    total,
    next_cursor:
      probe.length > limit && page.length > 0
        ? encodeContractListCursor(page[page.length - 1]!)
        : null,
  };
};

// ════════════════════════════════════════════════════════════════
// D-186 Slice C — session-grant live-control ("Active passes")
// ════════════════════════════════════════════════════════════════

/** Project a `grant_kind: 'session'` row to the compact live-control
 *  {@link SessionGrantView}: resolved `grant_mode` (absent ⇒ `'exact'`), the
 *  lifecycle state + remaining TTL at `nowMs`, and the op-scope `permits` (the
 *  always-singleton channels/actors axes are dropped — they carry no "what does
 *  this pass permit" signal). No identity / projection hashes leak — a session
 *  grant is never returned as a bearer secret (D-177 N.3). */
const toSessionGrantView = (def: ContractDefinition, nowMs: number): SessionGrantView => {
  const permits: SessionGrantPermits = {
    ...(def.scope.ingredient_ids !== undefined
      ? { ingredient_ids: def.scope.ingredient_ids }
      : {}),
    ...(def.scope.operation_ids !== undefined
      ? { operation_ids: def.scope.operation_ids }
      : {}),
    ...(def.scope.connection_names !== undefined
      ? { connection_names: def.scope.connection_names }
      : {}),
  };
  return {
    contract_id: def.contract_id,
    display_name: def.display_name,
    grant_mode: def.grant_mode ?? 'exact',
    permits,
    ...(def.risk_tier !== undefined ? { risk_tier: def.risk_tier } : {}),
    ...(def.channel_session_id !== undefined
      ? { channel_session_id: def.channel_session_id }
      : {}),
    ...(def.expiry_at !== undefined
      ? { expiry_at: def.expiry_at, remaining_ttl_ms: Math.max(0, def.expiry_at - nowMs) }
      : {}),
    ...(def.uses_remaining !== undefined ? { uses_remaining: def.uses_remaining } : {}),
    ...(def.max_uses !== undefined ? { max_uses: def.max_uses } : {}),
    ...(def.batch_members !== undefined ? { member_count: def.batch_members.length } : {}),
    lifecycle_state: contractLifecycleState(def, nowMs),
  };
};

/** List the ACTIVE session grants as render-ready views, soonest-expiring
 *  first (the most-urgent pass on top) — the shared core behind BOTH the
 *  `collection.contract.session_grant.list` rpc (the webclient "Active passes"
 *  bubble) and the D-181 messenger live-control `/recued passes` surface, so
 *  the two never drift. Session-scoped when an id is supplied (the per-chat
 *  narrow); else every `grant_kind: 'session'` row owner-wide (the global
 *  bubble). Both paths filter to ACTIVE — revoked / expired / exhausted grants
 *  drop off (the auto-retire the bubble shows) — then re-sort (the global
 *  `list()` is newest-first, `listSessionGrants` already orders; one sort
 *  covers both). */
export const listActiveSessionGrantViews = (
  definitionStore: ContractDefinitionStore,
  nowMs: number,
  channel_session_id?: string,
): SessionGrantView[] => {
  const rows =
    channel_session_id !== undefined
      ? definitionStore.listSessionGrants(channel_session_id)
      : definitionStore.list().filter((def) => def.grant_kind === 'session');
  return rows
    .filter((def) => contractLifecycleState(def, nowMs) === 'active')
    .map((def) => toSessionGrantView(def, nowMs))
    .sort(
      (lhs, rhs) =>
        (lhs.remaining_ttl_ms ?? Number.POSITIVE_INFINITY)
        - (rhs.remaining_ttl_ms ?? Number.POSITIVE_INFINITY),
    );
};

/** Early-revoke one session grant + project the now-`revoked` view, or `null`
 *  when the store refuses (absent / non-`'session'` / already-inert — the
 *  store-side fail-closed session guard). The shared core behind the
 *  `session_grant.revoke` rpc + the messenger "Revoke" button: a standing
 *  contract / delegation rule is never revoked here (only from Settings →
 *  Privacy → Contracts via `revokeContract`). */
export const revokeSessionGrantView = (
  definitionStore: ContractDefinitionStore,
  contract_id: string,
  nowMs: number,
): SessionGrantView | null => {
  const def = definitionStore.revokeSessionGrant(contract_id);
  return def === null ? null : toSessionGrantView(def, nowMs);
};

const handleSessionGrantList = async (
  definitionStore: ContractDefinitionStore,
  now: () => number,
  args: SessionGrantListRequest | void,
): Promise<SessionGrantListResponse> => {
  const method = 'collection.contract.session_grant.list';
  const a = args === undefined || args === null ? {} : ensureRecordArgs(method, args);
  const channel_session_id =
    a.channel_session_id === undefined || a.channel_session_id === null
      ? undefined
      : ensureNonEmptyString(method, 'channel_session_id', a.channel_session_id);
  return {
    grants: listActiveSessionGrantViews(definitionStore, now(), channel_session_id),
  };
};

const handleSessionGrantRevoke = async (
  definitionStore: ContractDefinitionStore,
  now: () => number,
  args: SessionGrantRevokeRequest,
): Promise<SessionGrantView> => {
  const method = 'collection.contract.session_grant.revoke';
  const a = ensureRecordArgs(method, args);
  const contract_id = ensureNonEmptyString(method, 'contract_id', a.contract_id);
  const view = revokeSessionGrantView(definitionStore, contract_id, now());
  if (view === null) {
    // Fail-closed session guard (store-side): a missing id AND a non-session
    // row both surface as `not_found` — the live-control surface only revokes
    // session grants (a standing contract / delegation rule is revoked from
    // Settings → Privacy → Contracts via `revokeContract`).
    throw new RpcError(
      'not_found',
      `${method}: no active session grant '${contract_id}'`,
      404,
      method,
    );
  }
  return view;
};

// ════════════════════════════════════════════════════════════════
// Lane A (D-166) — per-contract policy-overlay producer
// ════════════════════════════════════════════════════════════════

const ensureChannel = (method: string, value: unknown): Channel => {
  if (!isChannel(value)) {
    throw new RpcError(
      'bad_request',
      `${method}: channel must be one of ${CHANNELS.join(' / ')} (got '${String(value)}')`,
    );
  }
  return value;
};

// D-187 slice 5 — the per-contract policy-overlay handlers (ensurePolicyCellPair /
// emitPolicyOverlayChanged / policyOverlayViewFromRow / handleUpsert+Delete+List
// ContractPolicy) were DELETED with the rpc trio: the per-door read-fence re-homed onto
// the contract_grant collection rows (authored via contract.grant.write).


// ════════════════════════════════════════════════════════════════
// D-177 N.13 (P6c) — staged-trust suggestions: list / accept-mint / dismiss
// ════════════════════════════════════════════════════════════════

/** Emit the suggestion-resolved broadcast (best-effort, same swallow
 *  discipline as `emitContractChanged`) so every paired client's "Suggested
 *  rules" panel drops/refreshes the card. */
const emitSuggestionResolved = (
  broadcast: ContractRpcDeps['broadcast'],
  key_hash: string,
  resolution: 'accepted' | 'dismissed',
): void => {
  if (!broadcast) return;
  try {
    broadcast({
      kind: 'contract.delegation_rule_suggestion_resolved',
      key_hash,
      resolution,
    });
  } catch {
    // observability-only; never abort the rpc on emit failure.
  }
};

/** Validate an optional tighten-only bound: an integer ≥ 1 capped at
 *  `ceiling` (fork 3 — the accept card may tighten the code-constant bounds,
 *  never widen; an over-ceiling value is a client bug surfaced loudly, not
 *  clamped silently). */
const ensureOptionalTightenedBound = (
  method: string,
  field: string,
  value: unknown,
  ceiling: number,
): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RpcError(
      'bad_request',
      `${method}: ${field}, when present, must be an integer ≥ 1`,
    );
  }
  if (value > ceiling) {
    throw new RpcError(
      'bad_request',
      `${method}: ${field} exceeds the rule ceiling (${String(ceiling)} — tighten-only)`,
    );
  }
  return value;
};

/** Counts the owner's D-173 rejects on one door over `since_ms`. Injected as a
 *  seam so this read stays testable without the inbox's SQLite store, and so an
 *  absent wiring degrades to "not counted" rather than to a false zero. */
export type DoorRejectCounter = (
  door_contract_id: string,
  since_ms: number,
) => { count: number; last_rejected_at?: number };

const handleListDelegationSuggestions = async (
  suggestionStore: DelegationSuggestionStore,
  now: () => number,
  countDoorRejects?: DoorRejectCounter,
): Promise<{ suggestions: DelegationRuleSuggestionRow[] }> => {
  // Every state — the panel sections (open cards lead; resolved rows are the
  // panel's call to surface or drop). N.9.1: this read backs the owner panel
  // only; the family is reserved out of MCP, so no agent ever sees it.
  const suggestions = suggestionStore.list();
  if (countDoorRejects === undefined) return { suggestions };
  // D-177 N.14.8 fork 3 (owner: "surface") — decorate DOOR rows with the
  // counter-evidence the stored row never had: how often the owner refused this
  // form. Joined HERE, at read time, not in the learner scan, so a reject lands
  // on the card immediately instead of waiting for the next housekeeping sweep.
  //
  // ⚠ The window is the learner's OWN lookback, deliberately: the card puts
  // approvals and rejections in ONE sentence, and two different time ranges
  // there would be a false comparison. [[a_rendering_is_a_claim_about_what_it_shows]]
  //
  // ⛔ EVIDENCE, NOT A GATE — nothing below filters, reorders, or suppresses a
  // suggestion on this count. The owner reads it and decides (human-mint is the
  // backstop). A reception owner reviews strangers, so rejecting spam is normal
  // and must never mean "distrust this recipe".
  const since = now() - DELEGATION_SUGGEST_LOOKBACK_MS;
  return {
    suggestions: suggestions.map((row) => {
      const door = row.snapshot.bound_contract_id;
      if (door === undefined || door.length === 0) return row;
      const { count, last_rejected_at } = countDoorRejects(door, since);
      // A door with zero rejects still reports 0 — that is a real, earned "no
      // counter-evidence", which the card is entitled to say. It is only an
      // UNWIRED counter (above) that yields absent = "not counted".
      return {
        ...row,
        evidence: {
          ...row.evidence,
          door_rejected_count: count,
          ...(last_rejected_at !== undefined
            ? { door_last_rejected_at: last_rejected_at }
            : {}),
        },
      };
    }),
  };
};

const handleAcceptDelegationSuggestion = async (
  deps: ContractRpcDeps,
  suggestionStore: DelegationSuggestionStore,
  definitionStore: ContractDefinitionStore,
  now: () => number,
  args: { key_hash: string; ttl_ms?: number; max_uses?: number },
): Promise<{ rule: ContractDefinitionView; suggestion: DelegationRuleSuggestionRow }> => {
  const method = 'collection.contract.acceptDelegationSuggestion';
  const a = ensureRecordArgs(method, args);
  const key_hash = ensureNonEmptyString(method, 'key_hash', a.key_hash);
  const ttl_ms = ensureOptionalTightenedBound(
    method,
    'ttl_ms',
    a.ttl_ms,
    DELEGATION_RULE_TTL_MS,
  );
  const max_uses = ensureOptionalTightenedBound(
    method,
    'max_uses',
    a.max_uses,
    DELEGATION_RULE_MAX_USES,
  );

  const suggestion = suggestionStore.get(key_hash);
  if (suggestion === null) {
    throw new RpcError('not_found', `${method}: no suggestion '${key_hash}'`, 404, method);
  }
  // Snapshot↔key integrity (codex HIGH fold): the row stores `key_hash` and
  // `snapshot` independently, so a hand-shaped row could anchor approval +
  // idempotence on key K while its snapshot mints a rule whose fields derive
  // key K2 — the minted rule would then never suppress re-suggestion of K
  // (the learner's LIVE-rule join is by derived key). Recompute the hash
  // from the snapshot the mint will consume and refuse any divergence —
  // BEFORE every other branch (a malformed row must not leak state
  // semantics or ride the idempotent-twin path).
  if (delegationRuleSuggestionKeyHash(suggestion.snapshot) !== key_hash) {
    throw new RpcError(
      'bad_request',
      `${method}: suggestion '${key_hash}' carries a snapshot that does not derive its key (malformed row)`,
    );
  }
  if (suggestion.state === 'dismissed') {
    throw new RpcError(
      'bad_request',
      `${method}: suggestion '${key_hash}' was dismissed (dismissal is per-key permanent)`,
    );
  }

  // At-least-once idempotence — the mint runs BEFORE the state flip, so a
  // crash between them leaves an open suggestion + a minted rule; the retry
  // finds the rule by its anchor (`approved_action_ref` = the suggestion key
  // hash) and completes the flip instead of minting a twin. Matched against
  // ALL rules (live or dead): a retry must not re-mint a rule the owner
  // already revoked.
  const twin = definitionStore
    .listDelegationRules()
    .find((rule) => rule.approved_action_ref === key_hash);
  if (twin !== undefined) {
    const flip = suggestionStore.setState(key_hash, 'accepted');
    if (flip.outcome === 'changed') {
      emitSuggestionResolved(deps.broadcast, key_hash, 'accepted');
    }
    return {
      rule: toContractView(twin, now()),
      suggestion: flip.row ?? suggestion,
    };
  }
  if (suggestion.state !== 'open') {
    // 'accepted' with NO anchored rule (unreachable via this rpc — the mint
    // precedes the flip) or unknown future state vocabulary on a JSON row:
    // fail closed rather than minting standing authority from a row whose
    // lifecycle this handler can't vouch for.
    throw new RpcError(
      'bad_request',
      `${method}: suggestion '${key_hash}' is not open (state '${suggestion.state}')`,
    );
  }

  // N.13 — the mint consumes the STORED snapshot (what the card showed), and
  // the projection re-validates the vocabulary rather than trusting storage
  // (a hand-shaped row passes the structural value_shape gate while carrying
  // e.g. an `admin` tier). The store mint re-refuses the same vocabulary —
  // defense in depth.
  const plan = delegationRuleMintPlanFromSnapshot(suggestion.snapshot);
  if (plan === undefined) {
    throw new RpcError(
      'bad_request',
      `${method}: suggestion '${key_hash}' carries a snapshot that cannot mint a delegation rule`,
    );
  }
  const minted_at = now();
  let rule: ContractDefinition;
  try {
    rule = definitionStore.mintDelegationRule({
      // N.9.7 — the owner is the only approver in the single-user model;
      // the accept reaches this rpc owner-surface-only (reserved out of
      // MCP), so the row's provenance is the role (mirrors the session-
      // grant mint's posture).
      minted_by: 'owner',
      display_name: `Delegation rule — ${
        suggestion.snapshot.operation_id ?? suggestion.snapshot.ingredient_id
      }`,
      scope: plan.scope,
      grant_mode: plan.grant_mode,
      bound_recipe: { recipe_id: plan.recipe_id, recipe_hash: plan.recipe_hash },
      // D-177 N.14 — a door suggestion's plan carries the binding; the rule
      // inherits it (the matcher binds on it, the store re-validates).
      ...(plan.bound_contract_id !== undefined
        ? { bound_contract_id: plan.bound_contract_id }
        : {}),
      arg_shape_hash: plan.arg_shape_hash,
      risk_tier: plan.risk_tier,
      ...(plan.canonical_payload_hash !== undefined
        ? { canonical_payload_hash: plan.canonical_payload_hash }
        : {}),
      ...(plan.pinned_projection_hash !== undefined
        ? { pinned_projection_hash: plan.pinned_projection_hash }
        : {}),
      ...(plan.open_projection !== undefined
        ? { open_projection: plan.open_projection }
        : {}),
      ...(plan.entity_scope !== undefined ? { entity_scope: plan.entity_scope } : {}),
      approved_action_ref: key_hash,
      // Fork 3 — code-constant bounds, tightened by the card when the owner
      // chose to; the store re-enforces both ceilings.
      expiry_at: minted_at + (ttl_ms ?? DELEGATION_RULE_TTL_MS),
      max_uses: max_uses ?? DELEGATION_RULE_MAX_USES,
    });
  } catch (err) {
    if (err instanceof DelegationRuleMintError) {
      // A snapshot the plan projection admitted but the store refused — a
      // client-correctable / data-shape error, not a server fault.
      throw new RpcError('bad_request', err.message, undefined, method);
    }
    throw err;
  }

  const flip = suggestionStore.setState(key_hash, 'accepted');

  // D-120 — the mint is audited reserve-class: a delegation rule is STANDING
  // cross-session authority (ladder 7), the clearest access-surface change in
  // this family. AWAITED (codex MEDIUM fold) — unlike the gateway-side
  // session-grant mint (a hot-path resume that must not block on
  // observability), this is a human-paced rpc, so the response only returns
  // once the reserve row landed; a process exit right after the mint can no
  // longer lose the audit. An audit FAILURE still never unwinds the mint
  // (warn + proceed): the rule row itself is the durable record and revoke
  // is the kill switch — aborting here would leave the suggestion flipped
  // with the owner told nothing minted.
  if (deps.auditLog !== undefined) {
    try {
      await deps.auditLog.logActivity({
        activity_id: '',
        timestamp: minted_at,
        action: 'delegation_rule_minted',
        target: rule.contract_id,
        detail: JSON.stringify({
          // The full authority-bearing axis set (codex LOW fold — actor +
          // entity_scope included so the reserve row alone reconstructs the
          // delegated surface even if the rule row is later unreadable).
          ingredient_id: suggestion.snapshot.ingredient_id,
          ...(suggestion.snapshot.operation_id !== undefined
            ? { operation_id: suggestion.snapshot.operation_id }
            : {}),
          ...(suggestion.snapshot.connection_name !== undefined
            ? { connection_name: suggestion.snapshot.connection_name }
            : {}),
          risk_tier: plan.risk_tier,
          recipe_id: plan.recipe_id,
          channel: suggestion.snapshot.channel,
          actor: suggestion.snapshot.actor,
          ...(plan.entity_scope !== undefined
            ? { entity_scope: plan.entity_scope }
            : {}),
          grant_mode: plan.grant_mode,
          expiry_at: rule.expiry_at,
          max_uses: rule.max_uses,
          suggestion_key_hash: key_hash,
        }),
      });
    } catch (err) {
      console.warn(
        `[contract-handler] delegation_rule_minted audit failed for '${rule.contract_id}': `
          + (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // The minted rule rides the authoritative contract-lifecycle kind (the
  // inspector re-lists); the suggestion resolution rides its own kind (the
  // panel drops the card).
  emitContractChanged(deps.broadcast, 'mint', rule.contract_id);
  emitSuggestionResolved(deps.broadcast, key_hash, 'accepted');

  return {
    rule: toContractView(rule, now()),
    suggestion: flip.row ?? { ...suggestion, state: 'accepted' },
  };
};

const handleDismissDelegationSuggestion = async (
  deps: ContractRpcDeps,
  suggestionStore: DelegationSuggestionStore,
  definitionStore: ContractDefinitionStore,
  args: { key_hash: string },
): Promise<{ suggestion: DelegationRuleSuggestionRow }> => {
  const method = 'collection.contract.dismissDelegationSuggestion';
  const a = ensureRecordArgs(method, args);
  const key_hash = ensureNonEmptyString(method, 'key_hash', a.key_hash);
  const suggestion = suggestionStore.get(key_hash);
  if (suggestion === null) {
    throw new RpcError('not_found', `${method}: no suggestion '${key_hash}'`, 404, method);
  }
  // Idempotent re-dismiss (at-least-once rpc safety) — no broadcast: the
  // first dismissal already fanned, and re-fanning would churn panels.
  if (suggestion.state === 'dismissed') return { suggestion };
  if (suggestion.state === 'accepted') {
    throw new RpcError(
      'bad_request',
      `${method}: suggestion '${key_hash}' was accepted — revoke the minted rule via revokeContract instead`,
    );
  }
  // Crash-recovery guard (codex HIGH fold) — the accept mints BEFORE it
  // flips, so a crash between them leaves an OPEN suggestion with a live
  // anchored rule. Dismissing that row would lie twice: the owner believes
  // they declined while standing authority keeps auto-approving, and the
  // learner's dismissed-is-permanent suppression would hide the key forever.
  // Heal the row to the truth (`accepted` — the mint happened), fan the
  // resolution, and refuse the dismiss with a pointer at the kill switch.
  const orphanRule = definitionStore
    .listDelegationRules()
    .find((rule) => rule.approved_action_ref === key_hash);
  if (orphanRule !== undefined) {
    const heal = suggestionStore.setState(key_hash, 'accepted');
    if (heal.outcome === 'changed') {
      emitSuggestionResolved(deps.broadcast, key_hash, 'accepted');
    }
    throw new RpcError(
      'bad_request',
      `${method}: suggestion '${key_hash}' already minted rule '${orphanRule.contract_id}' `
        + '(an accept completed against it) — revoke the rule via revokeContract instead',
    );
  }
  const flip = suggestionStore.setState(key_hash, 'dismissed');
  if (flip.outcome !== 'changed' || flip.row === null) {
    // 'refused' here means an unknown stored state (the open/accepted/
    // dismissed branches are all handled above) — fail closed.
    throw new RpcError(
      'bad_request',
      `${method}: suggestion '${key_hash}' could not be dismissed (state '${suggestion.state}')`,
    );
  }
  emitSuggestionResolved(deps.broadcast, key_hash, 'dismissed');
  return { suggestion: flip.row };
};

// ════════════════════════════════════════════════════════════════
// D-202 — quality-delegation suggest→accept + governance (list/revoke)
//
// Mirrors the P6c delegation family: the (Slice 1) learner surfaces open
// suggestions, the owner accepts (→ mintQualityDelegation) or dismisses, and the
// active grants list/revoke is the coarse (recipe, op) governance surface (§5).
// Owner-only by the family's MCP reservation; the accept mints from the stored
// snapshot with the same snapshot↔key + at-least-once + crash-heal guards. The
// grant emits `contract.contract_definition_changed`; the suggestion card drops
// optimistically on the panel (a `*_suggestion_resolved` broadcast kind is
// deferred with the Slice 1 learner). Quality grants are STANDING — the accept's
// optional `ttl_ms` self-expires with no ceiling (the kill-switch reclaims).
// ════════════════════════════════════════════════════════════════

const handleListQualityDelegationSuggestions = async (
  suggestionStore: QualityDelegationSuggestionStore,
): Promise<{ suggestions: QualityDelegationSuggestionRow[] }> => ({
  suggestions: suggestionStore.list(),
});

const handleAcceptQualityDelegationSuggestion = async (
  deps: ContractRpcDeps,
  suggestionStore: QualityDelegationSuggestionStore,
  definitionStore: ContractDefinitionStore,
  now: () => number,
  args: { key_hash: string; ttl_ms?: number },
): Promise<{ grant: ContractDefinitionView; suggestion: QualityDelegationSuggestionRow }> => {
  const method = 'collection.contract.acceptQualityDelegationSuggestion';
  const a = ensureRecordArgs(method, args);
  const key_hash = ensureNonEmptyString(method, 'key_hash', a.key_hash);
  // Quality delegations are STANDING by default; an OPTIONAL ttl_ms self-expires.
  // No ceiling — the kill-switch reclaims, not a TTL — just a positive integer.
  let ttl_ms: number | undefined;
  if (a.ttl_ms !== undefined && a.ttl_ms !== null) {
    if (typeof a.ttl_ms !== 'number' || !Number.isInteger(a.ttl_ms) || a.ttl_ms < 1) {
      throw new RpcError(
        'bad_request',
        `${method}: ttl_ms, when present, must be an integer ≥ 1`,
      );
    }
    ttl_ms = a.ttl_ms;
  }

  const suggestion = suggestionStore.get(key_hash);
  if (suggestion === null) {
    throw new RpcError('not_found', `${method}: no suggestion '${key_hash}'`, 404, method);
  }
  // Snapshot↔key integrity — refuse a hand-shaped row whose snapshot does not
  // derive its key (mirrors the delegation accept, BEFORE every other branch).
  if (qualityDelegationSuggestionKeyHash(suggestion.snapshot) !== key_hash) {
    throw new RpcError(
      'bad_request',
      `${method}: suggestion '${key_hash}' carries a snapshot that does not derive its key (malformed row)`,
    );
  }
  if (suggestion.state === 'dismissed') {
    throw new RpcError(
      'bad_request',
      `${method}: suggestion '${key_hash}' was dismissed (dismissal is per-key permanent)`,
    );
  }
  // At-least-once idempotence — the mint runs BEFORE the flip; a retry finds the
  // grant by its anchor (`approved_action_ref` === key_hash) and completes the
  // flip instead of minting a twin.
  const twin = definitionStore
    .listQualityDelegations()
    .find((g) => g.approved_action_ref === key_hash);
  if (twin !== undefined) {
    const flip = suggestionStore.setState(key_hash, 'accepted');
    return { grant: toContractView(twin, now()), suggestion: flip.row ?? suggestion };
  }
  if (suggestion.state !== 'open') {
    throw new RpcError(
      'bad_request',
      `${method}: suggestion '${key_hash}' is not open (state '${suggestion.state}')`,
    );
  }

  const plan = qualityDelegationMintPlanFromSnapshot(suggestion.snapshot);
  if (plan === undefined) {
    throw new RpcError(
      'bad_request',
      `${method}: suggestion '${key_hash}' carries a snapshot that cannot mint a quality delegation`,
    );
  }
  const minted_at = now();
  let grant: ContractDefinition;
  try {
    grant = definitionStore.mintQualityDelegation({
      minted_by: 'owner',
      display_name:
        suggestion.snapshot.display_name
        ?? `Quality auto-accept — ${
          suggestion.snapshot.operation_id ?? suggestion.snapshot.ingredient_id
        }`,
      scope: plan.scope,
      bound_recipe: plan.bound_recipe,
      approved_action_ref: key_hash,
      ...(ttl_ms !== undefined ? { expiry_at: minted_at + ttl_ms } : {}),
    });
  } catch (err) {
    if (err instanceof QualityDelegationMintError) {
      throw new RpcError('bad_request', err.message, undefined, method);
    }
    throw err;
  }

  const flip = suggestionStore.setState(key_hash, 'accepted');

  // Reserve-class audit (mirrors the delegation mint): a quality delegation is a
  // standing auto-accept surface. Awaited; a failure warns but never unwinds.
  if (deps.auditLog !== undefined) {
    try {
      await deps.auditLog.logActivity({
        activity_id: '',
        timestamp: minted_at,
        action: 'quality_delegation_minted',
        target: grant.contract_id,
        detail: JSON.stringify({
          ingredient_id: suggestion.snapshot.ingredient_id,
          ...(suggestion.snapshot.operation_id !== undefined
            ? { operation_id: suggestion.snapshot.operation_id }
            : {}),
          recipe_id: plan.bound_recipe.recipe_id,
          expiry_at: grant.expiry_at ?? null,
          suggestion_key_hash: key_hash,
        }),
      });
    } catch (err) {
      console.warn(
        `[contract-handler] quality_delegation_minted audit failed for '${grant.contract_id}': `
          + (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  emitContractChanged(deps.broadcast, 'mint', grant.contract_id);

  return {
    grant: toContractView(grant, now()),
    suggestion: flip.row ?? { ...suggestion, state: 'accepted' },
  };
};

const handleDismissQualityDelegationSuggestion = async (
  deps: ContractRpcDeps,
  suggestionStore: QualityDelegationSuggestionStore,
  definitionStore: ContractDefinitionStore,
  args: { key_hash: string },
): Promise<{ suggestion: QualityDelegationSuggestionRow }> => {
  const method = 'collection.contract.dismissQualityDelegationSuggestion';
  const a = ensureRecordArgs(method, args);
  const key_hash = ensureNonEmptyString(method, 'key_hash', a.key_hash);
  const suggestion = suggestionStore.get(key_hash);
  if (suggestion === null) {
    throw new RpcError('not_found', `${method}: no suggestion '${key_hash}'`, 404, method);
  }
  // Idempotent re-dismiss (at-least-once rpc safety).
  if (suggestion.state === 'dismissed') return { suggestion };
  if (suggestion.state === 'accepted') {
    throw new RpcError(
      'bad_request',
      `${method}: suggestion '${key_hash}' was accepted — revoke the minted grant via revokeQualityDelegation instead`,
    );
  }
  // Crash-recovery heal (mirrors the delegation dismiss): an orphaned grant
  // means the accept minted but didn't flip — heal to 'accepted', refuse, and
  // point at the kill switch (revoke).
  const orphan = definitionStore
    .listQualityDelegations()
    .find((g) => g.approved_action_ref === key_hash);
  if (orphan !== undefined) {
    suggestionStore.setState(key_hash, 'accepted');
    throw new RpcError(
      'bad_request',
      `${method}: suggestion '${key_hash}' already minted grant '${orphan.contract_id}' `
        + '(an accept completed against it) — revoke it via revokeQualityDelegation instead',
    );
  }
  const flip = suggestionStore.setState(key_hash, 'dismissed');
  if (flip.outcome !== 'changed' || flip.row === null) {
    throw new RpcError(
      'bad_request',
      `${method}: suggestion '${key_hash}' could not be dismissed (state '${suggestion.state}')`,
    );
  }
  return { suggestion: flip.row };
};

const handleListQualityDelegations = async (
  definitionStore: ContractDefinitionStore,
  now: () => number,
): Promise<{ contracts: ContractDefinitionView[] }> => {
  const at = now();
  return {
    contracts: definitionStore.listQualityDelegations().map((g) => toContractView(g, at)),
  };
};

const handleRevokeQualityDelegation = async (
  definitionStore: ContractDefinitionStore,
  now: () => number,
  args: { contract_id: string; reason?: string },
): Promise<ContractDefinitionView> => {
  const method = 'collection.contract.revokeQualityDelegation';
  const a = ensureRecordArgs(method, args);
  const contract_id = ensureNonEmptyString(method, 'contract_id', a.contract_id);
  const reason =
    typeof a.reason === 'string' && a.reason.trim() !== '' ? a.reason : 'owner-revoked';
  // READ + kind-check BEFORE revoke — this rpc revokes ONLY quality delegations
  // (a caller must never reach a session / delegation / standing row through it).
  const existing = definitionStore.get(contract_id);
  if (existing === null) {
    throw new RpcError('not_found', `${method}: no contract '${contract_id}'`, 404, method);
  }
  if (existing.grant_kind !== 'quality_delegation') {
    throw new RpcError(
      'bad_request',
      `${method}: contract '${contract_id}' is not a quality delegation`,
    );
  }
  const def = definitionStore.revoke(contract_id, reason);
  if (def === null) {
    throw new RpcError('not_found', `${method}: no contract '${contract_id}'`, 404, method);
  }
  return toContractView(def, now());
};

// ════════════════════════════════════════════════════════════════
// D-177 N.11 rule 5 (5.c, slice C) — scoped-grant proposals:
// list / accept-mint / dismiss. Mirrors the P6c family's shape over the
// SEPARATE scoped row kind (5.i.2) and `mintScopedSessionGrant`.
// ════════════════════════════════════════════════════════════════

const emitScopedSuggestionResolved = (
  broadcast: ContractRpcDeps['broadcast'],
  key_hash: string,
  resolution: 'accepted' | 'dismissed',
): void => {
  if (!broadcast) return;
  try {
    broadcast({
      kind: 'contract.scoped_grant_suggestion_resolved',
      key_hash,
      resolution,
    });
  } catch {
    // observability-only; never abort the rpc on emit failure.
  }
};

const handleListScopedGrantSuggestions = async (
  suggestionStore: ScopedGrantSuggestionStore,
): Promise<{ suggestions: ScopedGrantSuggestionRow[] }> => ({
  // Every state — the card surface filters by state + session. N.9.1: this
  // read backs the owner surface only (family reserved out of MCP).
  suggestions: suggestionStore.list(),
});

const handleAcceptScopedGrantSuggestion = async (
  deps: ContractRpcDeps,
  suggestionStore: ScopedGrantSuggestionStore,
  definitionStore: ContractDefinitionStore,
  now: () => number,
  args: { key_hash: string; connection_name?: string; ttl_ms?: number; max_uses?: number },
): Promise<{
  grant: ContractDefinitionView;
  suggestion: ScopedGrantSuggestionRow;
  sentence: string;
}> => {
  const method = 'collection.contract.acceptScopedGrantSuggestion';
  const a = ensureRecordArgs(method, args);
  const key_hash = ensureNonEmptyString(method, 'key_hash', a.key_hash);

  const suggestion = suggestionStore.get(key_hash);
  if (suggestion === null) {
    throw new RpcError('not_found', `${method}: no proposal '${key_hash}'`, 404, method);
  }
  // Snapshot↔key integrity (the P6c codex HIGH fold applied here): refuse a
  // hand-shaped row whose snapshot does not derive its own key — BEFORE any
  // state branch.
  if (scopedGrantSuggestionKeyHash(suggestion.snapshot) !== key_hash) {
    throw new RpcError(
      'bad_request',
      `${method}: proposal '${key_hash}' carries a snapshot that does not derive its key (malformed row)`,
    );
  }
  // Tighten-only bounds (5.c): the TTL the card showed (the snapshot's —
  // already ceiling-clamped at parse) and the default use budget are the
  // accept-time ceilings; the store mint re-enforces the absolute ceilings.
  const ttl_ms = ensureOptionalTightenedBound(
    method,
    'ttl_ms',
    a.ttl_ms,
    suggestion.snapshot.ttl_ms,
  );
  const max_uses = ensureOptionalTightenedBound(
    method,
    'max_uses',
    a.max_uses,
    SCOPED_GRANT_MAX_USES_DEFAULT,
  );
  if (suggestion.state === 'dismissed') {
    throw new RpcError(
      'bad_request',
      `${method}: proposal '${key_hash}' was dismissed (dismissal is per-key permanent)`,
    );
  }

  // At-least-once idempotence — the mint runs BEFORE the state flip; a retry
  // finds the minted twin by its anchor among the session's grants (live or
  // dead — a retry must not re-mint a grant the owner already revoked).
  const twin = definitionStore
    .listSessionGrants(suggestion.snapshot.channel_session_id)
    .find((grant) => grant.approved_action_ref === key_hash);
  if (twin !== undefined) {
    const flip = suggestionStore.setState(key_hash, 'accepted');
    if (flip.outcome === 'changed') {
      emitScopedSuggestionResolved(deps.broadcast, key_hash, 'accepted');
    }
    return {
      grant: toContractView(twin, now()),
      suggestion: flip.row ?? suggestion,
      // The retry's sentence reports the MINTED grant's actual bounds, not
      // the original card values (codex LOW fold) — the first accept may
      // have tightened them.
      sentence: renderScopedGrantSentence({
        operation_id: suggestion.snapshot.operation_id,
        ...(twin.scope.connection_names?.[0] !== undefined
          ? { connection_name: twin.scope.connection_names[0] }
          : {}),
        ttl_ms:
          twin.expiry_at !== undefined && twin.expiry_at !== null
            ? twin.expiry_at - twin.minted_at
            : suggestion.snapshot.ttl_ms,
        max_uses: twin.max_uses ?? SCOPED_GRANT_MAX_USES_DEFAULT,
      }),
    };
  }
  if (suggestion.state !== 'open') {
    throw new RpcError(
      'bad_request',
      `${method}: proposal '${key_hash}' is not open (state '${suggestion.state}')`,
    );
  }

  // 5.c — the connection is validated against the LIVE enrolled set, not the
  // parse-time snapshot: single candidate auto-filled, multiple require the
  // human's pick, none ⇒ unmintable.
  const connectionStore = deps.getConnectionStore?.();
  if (connectionStore === undefined) {
    throw new RpcError('not_configured', `${method}: connection store unavailable`);
  }
  const liveCandidates = listScopedConnectionCandidates(
    connectionStore,
    createConnectionCatalogBindingStore(deps.store),
    suggestion.snapshot.ingredient_id,
  );
  if (liveCandidates.length === 0) {
    throw new RpcError(
      'bad_request',
      `${method}: no enrolled connection resolves to catalog '${suggestion.snapshot.ingredient_id}' — unmintable (5.c)`,
    );
  }
  let connection_name: string;
  if (a.connection_name !== undefined && a.connection_name !== null) {
    const picked = ensureNonEmptyString(method, 'connection_name', a.connection_name);
    if (!liveCandidates.includes(picked)) {
      throw new RpcError(
        'bad_request',
        `${method}: connection '${picked}' is not an enrolled candidate for catalog '${suggestion.snapshot.ingredient_id}'`,
      );
    }
    connection_name = picked;
  } else if (liveCandidates.length === 1) {
    connection_name = liveCandidates[0];
  } else {
    throw new RpcError(
      'bad_request',
      `${method}: connection_name is required (${String(liveCandidates.length)} enrolled candidates)`,
    );
  }

  const minted_at = now();
  const effective_ttl_ms = ttl_ms ?? suggestion.snapshot.ttl_ms;
  const effective_max_uses = max_uses ?? SCOPED_GRANT_MAX_USES_DEFAULT;
  let grant: ContractDefinition;
  try {
    grant = definitionStore.mintScopedSessionGrant({
      // N.9.7 — the owner is the only approver; this rpc is owner-surface
      // only (reserved out of MCP).
      minted_by: 'owner',
      display_name: `Scoped grant — ${suggestion.snapshot.operation_id}`,
      scope: {
        channels: [suggestion.snapshot.channel as Channel],
        ingredient_ids: [suggestion.snapshot.ingredient_id],
        operation_ids: [suggestion.snapshot.operation_id],
        connection_names: [connection_name],
      },
      channel_session_id: suggestion.snapshot.channel_session_id,
      risk_tier: suggestion.snapshot.risk_tier,
      scoped_source: suggestion.snapshot.scoped_source,
      approved_action_ref: key_hash,
      expiry_at: minted_at + effective_ttl_ms,
      max_uses: effective_max_uses,
    });
  } catch (err) {
    if (err instanceof ScopedGrantMintError) {
      throw new RpcError('bad_request', err.message, undefined, method);
    }
    throw err;
  }

  const flip = suggestionStore.setState(key_hash, 'accepted');

  // Reserve-class audit, AWAITED (human-paced rpc — the P6c posture). An
  // audit failure never unwinds the mint: the grant row is the durable
  // record and revoke is the kill switch.
  if (deps.auditLog !== undefined) {
    try {
      await deps.auditLog.logActivity({
        activity_id: '',
        timestamp: minted_at,
        action: 'scoped_grant_minted',
        target: grant.contract_id,
        detail: JSON.stringify({
          ingredient_id: suggestion.snapshot.ingredient_id,
          operation_id: suggestion.snapshot.operation_id,
          connection_name,
          risk_tier: suggestion.snapshot.risk_tier,
          scoped_source: suggestion.snapshot.scoped_source,
          channel: suggestion.snapshot.channel,
          channel_session_id: suggestion.snapshot.channel_session_id,
          expiry_at: grant.expiry_at,
          max_uses: grant.max_uses,
          suggestion_key_hash: key_hash,
          triggering_excerpt: suggestion.triggering_excerpt,
        }),
      });
    } catch (err) {
      console.warn(
        `[contract-handler] scoped_grant_minted audit failed for '${grant.contract_id}': `
          + (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  emitContractChanged(deps.broadcast, 'mint', grant.contract_id);
  emitScopedSuggestionResolved(deps.broadcast, key_hash, 'accepted');

  return {
    grant: toContractView(grant, now()),
    suggestion: flip.row ?? { ...suggestion, state: 'accepted' },
    sentence: renderScopedGrantSentence({
      operation_id: suggestion.snapshot.operation_id,
      connection_name,
      ttl_ms: effective_ttl_ms,
      max_uses: effective_max_uses,
    }),
  };
};

const handleDismissScopedGrantSuggestion = async (
  deps: ContractRpcDeps,
  suggestionStore: ScopedGrantSuggestionStore,
  definitionStore: ContractDefinitionStore,
  args: { key_hash: string },
): Promise<{ suggestion: ScopedGrantSuggestionRow }> => {
  const method = 'collection.contract.dismissScopedGrantSuggestion';
  const a = ensureRecordArgs(method, args);
  const key_hash = ensureNonEmptyString(method, 'key_hash', a.key_hash);
  const suggestion = suggestionStore.get(key_hash);
  if (suggestion === null) {
    throw new RpcError('not_found', `${method}: no proposal '${key_hash}'`, 404, method);
  }
  if (suggestion.state === 'dismissed') return { suggestion };
  if (suggestion.state === 'accepted') {
    throw new RpcError(
      'bad_request',
      `${method}: proposal '${key_hash}' was accepted — revoke the minted grant via revokeContract instead`,
    );
  }
  // Crash-recovery guard (the P6c codex HIGH fold applied here): an accept
  // that minted but crashed pre-flip leaves an OPEN proposal with a live
  // anchored grant — heal to the truth and point at the kill switch.
  const orphanGrant = definitionStore
    .listSessionGrants(suggestion.snapshot.channel_session_id)
    .find((grant) => grant.approved_action_ref === key_hash);
  if (orphanGrant !== undefined) {
    const heal = suggestionStore.setState(key_hash, 'accepted');
    if (heal.outcome === 'changed') {
      emitScopedSuggestionResolved(deps.broadcast, key_hash, 'accepted');
    }
    throw new RpcError(
      'bad_request',
      `${method}: proposal '${key_hash}' already minted grant '${orphanGrant.contract_id}' `
        + '(an accept completed against it) — revoke the grant via revokeContract instead',
    );
  }
  const flip = suggestionStore.setState(key_hash, 'dismissed');
  if (flip.outcome !== 'changed' || flip.row === null) {
    throw new RpcError(
      'bad_request',
      `${method}: proposal '${key_hash}' could not be dismissed (state '${suggestion.state}')`,
    );
  }
  emitScopedSuggestionResolved(deps.broadcast, key_hash, 'dismissed');
  return { suggestion: flip.row };
};

type ContractMethods =
  | 'collection.contract.upsertOverride'
  | 'collection.contract.deleteOverride'
  | 'collection.contract.listOverrides'
  | 'collection.contract.listCatalogOperations'
  | 'contract.recipeOpUsage'
  | 'collection.operation.listOperations'
  | 'collection.operation.upsertOwnerOverride'
  | 'collection.operation.deleteOwnerOverride'
  | 'collection.operation.listOwnerOverrides'
  | 'collection.contract.mintContract'
  | 'collection.contract.revokeContract'
  | 'collection.contract.setDoorTypes'
  | 'collection.contract.listContracts'
  | 'collection.contract.session_grant.list'
  | 'collection.contract.session_grant.revoke'
  | 'collection.contract.listDelegationSuggestions'
  | 'collection.contract.acceptDelegationSuggestion'
  | 'collection.contract.dismissDelegationSuggestion'
  | 'collection.contract.listScopedGrantSuggestions'
  | 'collection.contract.acceptScopedGrantSuggestion'
  | 'collection.contract.dismissScopedGrantSuggestion'
  | 'collection.contract.listQualityDelegationSuggestions'
  | 'collection.contract.acceptQualityDelegationSuggestion'
  | 'collection.contract.dismissQualityDelegationSuggestion'
  | 'collection.contract.listQualityDelegations'
  | 'collection.contract.revokeQualityDelegation';

export const makeContractHandlers = (
  deps: ContractRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ContractMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  // One clock + the contract_definition lifecycle store over the SAME `deps.store`
  // the override path writes (a single store handle backs both families). Built
  // once at slice construction so its id-gen + clock are stable across calls.
  const now = deps.now ?? ((): number => Date.now());
  const definitionStore = createContractDefinitionStore(deps.store, {
    now,
    ...(deps.newContractId ? { newId: deps.newContractId } : {}),
  });
  // D-177 N.13 (P6c) — the suggestion store over the SAME store handle the
  // P6b learner writes, so the panel lists exactly what the learner surfaced
  // and an accept/dismiss is immediately visible to the next learner cycle.
  const suggestionStore = createDelegationSuggestionStore(deps.store, { now });
  // D-177 N.11 rule 5 (5.c, slice C) — the scoped-proposal store over the
  // SAME store handle the parse middleware writes (separate row kind from
  // the delegation store, 5.i.2).
  const scopedSuggestionStore = createScopedGrantSuggestionStore(deps.store, { now });
  // D-202 — the quality-delegation suggestion store over the SAME store handle
  // (the Slice 1 learner will write here; a test source seeds it until then).
  const qualitySuggestionStore = createQualityDelegationSuggestionStore(deps.store, { now });
  return {
    methods: [
      'collection.contract.upsertOverride',
      'collection.contract.deleteOverride',
      'collection.contract.listOverrides',
      'collection.contract.listCatalogOperations',
      'contract.recipeOpUsage',
      'collection.operation.listOperations',
      'collection.operation.upsertOwnerOverride',
      'collection.operation.deleteOwnerOverride',
      'collection.operation.listOwnerOverrides',
      'collection.contract.mintContract',
      'collection.contract.revokeContract',
      'collection.contract.setDoorTypes',
      'collection.contract.listContracts',
      'collection.contract.session_grant.list',
      'collection.contract.session_grant.revoke',
      'collection.contract.listDelegationSuggestions',
      'collection.contract.acceptDelegationSuggestion',
      'collection.contract.dismissDelegationSuggestion',
      'collection.contract.listScopedGrantSuggestions',
      'collection.contract.acceptScopedGrantSuggestion',
      'collection.contract.dismissScopedGrantSuggestion',
      'collection.contract.listQualityDelegationSuggestions',
      'collection.contract.acceptQualityDelegationSuggestion',
      'collection.contract.dismissQualityDelegationSuggestion',
      'collection.contract.listQualityDelegations',
      'collection.contract.revokeQualityDelegation',
    ],
    handlers: {
      'collection.contract.upsertOverride': async (args) =>
        upsertContractOverride(
          deps,
          args as Parameters<typeof upsertContractOverride>[1],
        ),
      'collection.contract.deleteOverride': async (args) =>
        handleContractDeleteOverride(
          deps,
          args as Parameters<typeof handleContractDeleteOverride>[1],
        ),
      'collection.contract.listOverrides': async (args) =>
        handleContractListOverrides(
          deps,
          args as Parameters<typeof handleContractListOverrides>[1],
        ),
      'collection.contract.listCatalogOperations': async () =>
        handleContractListCatalogOperations(deps),
      // D-247 D13 + D11 — the coverage ledger's READ path. Shipped with the
      // write, because a capture-only ledger is precisely the artefact this
      // decision exists to remove (`buildRecipeOpDependencyIndex`: written,
      // tested, called by nothing).
      'contract.recipeOpUsage': async (args) => {
        const window_days = typeof args?.window_days === 'number' && args.window_days > 0
          ? Math.min(args.window_days, 365)
          : DEFAULT_COVERAGE_WINDOW_DAYS;
        // ⚠ No audit store wired ⇒ an EMPTY result carrying its window, never a
        // throw and never a silent zero: the caller's copy already has to say
        // "in the retained window", and that sentence is honest here too.
        // ⛔⛔ BOTH HALVES IN ONE ROUND TRIP, AND THAT IS NOT A PERFORMANCE
        // CHOICE. D11's row puts the STATIC "which recipes could reach this op"
        // beside the ACTUAL "which runs did" — two fetches could describe two
        // different moments, and the row would contradict itself on screen.
        const dependency = deps.recipeStore === undefined
          ? { byOp: new Map<string, readonly string[]>(), underivable: [] as readonly string[] }
          : buildRecipeOpDependencyIndex(
              deps.recipeStore.ids().flatMap((id) => {
                const recipe = deps.recipeStore!.get(id);
                return recipe === null ? [] : [{ id, recipe }];
              }),
            );
        const usage = deps.auditLog
          ? await readRecipeCoverageUsage(deps.auditLog, { window_days, now: () => Date.now() })
          : { byOperation: new Map(), window_days, oldest_scanned_at: null };

        // Union the two key sets: an op can have dependents and no runs (never
        // fired in the window) or runs and no derivable dependents (a templated
        // recipe). Rendering only the intersection would drop both.
        const opIds = new Set<string>([...dependency.byOp.keys(), ...usage.byOperation.keys()]);
        return {
          operations: [...opIds].sort().map((operation_id) => ({
            operation_id,
            could: [...(dependency.byOp.get(operation_id) ?? [])],
            count: usage.byOperation.get(operation_id)?.count ?? 0,
            recipes: [...(usage.byOperation.get(operation_id)?.recipes ?? [])],
          })),
          window_days: usage.window_days,
          oldest_scanned_at: usage.oldest_scanned_at,
          underivable: [...dependency.underivable],
        };
      },
      'collection.operation.listOperations': async () =>
        handleOwnerOperationListOperations(deps),
      'collection.operation.upsertOwnerOverride': async (args) =>
        upsertOwnerOperationOverride(
          deps,
          args as Parameters<typeof upsertOwnerOperationOverride>[1],
        ),
      'collection.operation.deleteOwnerOverride': async (args) =>
        handleOwnerOperationDelete(
          deps,
          args as Parameters<typeof handleOwnerOperationDelete>[1],
        ),
      'collection.operation.listOwnerOverrides': async (args) =>
        handleOwnerOperationList(
          deps,
          args as Parameters<typeof handleOwnerOperationList>[1],
        ),
      // contract_id lifecycle. `mintContract` reads the authenticated client
      // (`ctx`) for `minted_by` provenance; revoke/list don't need it. Both
      // mutators emit `contract.contract_definition_changed` AFTER a successful
      // write (D-171) so paired clients re-list off the authoritative signal.
      'collection.contract.mintContract': async (args, client) => {
        const view = await handleContractMint(
          deps,
          definitionStore,
          now,
          args as Parameters<typeof handleContractMint>[3],
          client,
        );
        emitContractChanged(deps.broadcast, 'mint', view.contract_id);
        return view;
      },
      'collection.contract.revokeContract': async (args) => {
        const view = await handleContractRevoke(
          definitionStore,
          now,
          args as Parameters<typeof handleContractRevoke>[2],
        );
        emitContractChanged(deps.broadcast, 'revoke', view.contract_id);
        return view;
      },
      // D-187 §6 (step 7) — in-place door-type edit (the level-1 "door on/off"
      // toggles 3c flips). Emits op `update` (an existing row changed, not a
      // mint/revoke) so every paired client's door surface re-lists.
      'collection.contract.setDoorTypes': async (args) => {
        const view = await handleContractSetDoorTypes(
          definitionStore,
          now,
          args as Parameters<typeof handleContractSetDoorTypes>[2],
        );
        emitContractChanged(deps.broadcast, 'update', view.contract_id);
        return view;
      },
      'collection.contract.listContracts': async (args) =>
        handleContractList(
          definitionStore,
          now,
          args as Parameters<typeof handleContractList>[2],
        ),
      // D-186 Slice C — live-control "Active passes". Owner-only by the same
      // gate as every sibling here: the `collection.contract.` MCP-reserved
      // prefix (a session grant is never agent-visible — N.9.1) + the
      // bearer-verified WS. `list` is a pure read; `revoke` is a TIGHTENING
      // (removes future auto-admit → matching ops re-ask) and emits
      // `contract.contract_definition_changed` (op `revoke`) so the bubble on
      // every paired client re-lists. No bridge-approval gate (unlike the
      // `execution.*` mutators): revoke only ever ADDS caution, and the sibling
      // `revokeContract` is ungated too — a consistent posture across the family.
      'collection.contract.session_grant.list': async (args) =>
        handleSessionGrantList(
          definitionStore,
          now,
          args as Parameters<typeof handleSessionGrantList>[2],
        ),
      'collection.contract.session_grant.revoke': async (args) => {
        const view = await handleSessionGrantRevoke(
          definitionStore,
          now,
          args as Parameters<typeof handleSessionGrantRevoke>[2],
        );
        emitContractChanged(deps.broadcast, 'revoke', view.contract_id);
        return view;
      },
      // D-177 N.13 (P6c) — staged-trust suggestion surface. Owner-only by the
      // family's MCP reservation; the accept emits BOTH contract kinds (the
      // minted rule's lifecycle + the suggestion resolution), the dismiss
      // emits the resolution only.
      'collection.contract.listDelegationSuggestions': async () =>
        handleListDelegationSuggestions(suggestionStore, now, deps.countDoorRejects),
      'collection.contract.acceptDelegationSuggestion': async (args) =>
        handleAcceptDelegationSuggestion(
          deps,
          suggestionStore,
          definitionStore,
          now,
          args as Parameters<typeof handleAcceptDelegationSuggestion>[4],
        ),
      'collection.contract.dismissDelegationSuggestion': async (args) =>
        handleDismissDelegationSuggestion(
          deps,
          suggestionStore,
          definitionStore,
          args as Parameters<typeof handleDismissDelegationSuggestion>[3],
        ),
      // D-177 N.11 rule 5 (5.c, slice C) — scoped-grant proposal surface.
      // Owner-only by the family's MCP reservation; the accept emits BOTH
      // contract kinds (the minted grant's lifecycle + the proposal
      // resolution), the dismiss emits the resolution only.
      'collection.contract.listScopedGrantSuggestions': async () =>
        handleListScopedGrantSuggestions(scopedSuggestionStore),
      'collection.contract.acceptScopedGrantSuggestion': async (args) =>
        handleAcceptScopedGrantSuggestion(
          deps,
          scopedSuggestionStore,
          definitionStore,
          now,
          args as Parameters<typeof handleAcceptScopedGrantSuggestion>[4],
        ),
      'collection.contract.dismissScopedGrantSuggestion': async (args) =>
        handleDismissScopedGrantSuggestion(
          deps,
          scopedSuggestionStore,
          definitionStore,
          args as Parameters<typeof handleDismissScopedGrantSuggestion>[3],
        ),
      // D-202 — quality-delegation suggest→accept + governance. Owner-only by
      // the family's MCP reservation. The accept mints (emits the grant's
      // lifecycle kind); the revoke is a tightening (emits `revoke`); list +
      // dismiss are non-broadcasting (the panel drops the card optimistically).
      'collection.contract.listQualityDelegationSuggestions': async () =>
        handleListQualityDelegationSuggestions(qualitySuggestionStore),
      'collection.contract.acceptQualityDelegationSuggestion': async (args) =>
        handleAcceptQualityDelegationSuggestion(
          deps,
          qualitySuggestionStore,
          definitionStore,
          now,
          args as Parameters<typeof handleAcceptQualityDelegationSuggestion>[4],
        ),
      'collection.contract.dismissQualityDelegationSuggestion': async (args) =>
        handleDismissQualityDelegationSuggestion(
          deps,
          qualitySuggestionStore,
          definitionStore,
          args as Parameters<typeof handleDismissQualityDelegationSuggestion>[3],
        ),
      'collection.contract.listQualityDelegations': async () =>
        handleListQualityDelegations(definitionStore, now),
      'collection.contract.revokeQualityDelegation': async (args) => {
        const view = await handleRevokeQualityDelegation(
          definitionStore,
          now,
          args as Parameters<typeof handleRevokeQualityDelegation>[2],
        );
        emitContractChanged(deps.broadcast, 'revoke', view.contract_id);
        return view;
      },
    },
  };
};
