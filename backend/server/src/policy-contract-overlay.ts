/** D-166 / D-187 — contract-governance resolution: the impure layer that gates a
 *  dispatch on the bound contract's lifecycle, then meters / fences it.
 *
 *  HISTORY (D-187 policy-matrix retirement, slice 5): this resolver used to also
 *  project the `policy_matrix` `.<contract_id>` overlay CELL (per-(channel×actor)
 *  ingredient denials / approval escalation / `scope_restrictions`) and return it
 *  for the matrix admission algebra. Slice 4 retired the matrix admission (approval
 *  is now op-risk × stage-trust); slice 5 re-homed the per-door `scope_restrictions`
 *  read-fence onto the unified `contract_grant` store (`data.<collection>` collection
 *  grants), so the overlay CELL is gone. What survives is the contract-governance
 *  surface every gate still needs — metering, liveness, door-type, the read-grant
 *  checker, and the grant-sourced door read-scope — all keyed off the
 *  `contract_definition` lifecycle + the `contract_grant` rows.
 *
 *  - `shouldMeterUse(source, ingredientSlug)` — true iff the source's contract is
 *    MINTED, `isContractActive(now)`, not a gate-consumed `session`/`delegation`
 *    grant, and its `scope` admits this `(channel, actor, ingredient)` (the OP axis
 *    is retired — `contract_grant` is the sole op authority). The signal the caller
 *    `recordUse`s on (per-call dispatches only). Replaces the old `resolve().active`.
 *  - `recordUse(source)` — decrements the contract's `uses_remaining` (the store's
 *    dumb-counter primitive; no clock, no active re-check). The caller fires it once
 *    per per-call dispatch `shouldMeterUse` reported true for, at the gateway's
 *    actual-proceed point (the `recordDispatchUse` seam) — i.e. once the call
 *    crosses the boundary, counting success / failure / in_doubt alike (spec :253
 *    "every gateway dispatch ... counter decrements"). Never on `deny`/`ask` (those
 *    refuse or pause before the boundary) and never on the static pre-run walk
 *    (per-run, not per-dispatch). Recording at the proceed point — rather than on
 *    the `'admit'` verdict back at the probe — is what counts the approval-resume
 *    path: a resumed dispatch re-enters with verdict `'ask'`, admitted by the
 *    engine's resume grant INSIDE the gateway, so an `'admit'`-gated probe record
 *    would miss it.
 *  - `resolveContractScopeRestrictions(source)` — the execute-path read-fence, DERIVED
 *    from the governing contract's `data.<collection>` grant rows (the same rows the
 *    read-grant checker reads). Entity access is per-CONTRACT (Layer 2 — there is no
 *    per-door access list; the grants apply to every door the contract backs). The
 *    granted readable-collection set → `scopeRestrictionsFromReadableCollections` → the
 *    `ContractSnapshot.scope_restrictions` the gateway's `evaluateScopeRestrictions`
 *    enforces. Admit-all (`[]`) for the owner / an unbound door / a contract that grants
 *    every collection.
 *  - `resolveReadGrantChecker(source)` — the per-dispatch read-grant checker (topic +
 *    collection reads as unified `contract_grant` entries); see the method doc.
 *
 *  Additive by construction: until a contract is minted, `shouldMeterUse` is false
 *  and `resolveContractScopeRestrictions` admits all. The live MCP path (a
 *  `contracted_user` source whose `contract_id` has no `contract_definition` row yet)
 *  meters nothing and reads all — the snapshot's `allowed_tools` stays the sole
 *  authority, unchanged.
 *
 *  Spec: D-166 §"contract_definition" + D-187
 *  AMENDMENT §3 / slice 5 (`[[project_policy_matrix_retirement]]`). */

import {
  contractPermitsDoorType,
  contractScopeMatches,
  executionSourceContractId,
  isContractActive,
  isStandingContractDefinition,
  READABLE_COLLECTIONS,
  scopeRestrictionsFromReadableCollections,
  type ContractDefinition,
  type ContractScopeContext,
  type DoorType,
  type ExecutionSource,
} from '@recued/contracts';

import { createGrantEntryResolver } from './contract-grant-resolve.js';
import { resolveGrantGoverningContractId } from './grant-governing-contract.js';
import {
  usesExplicitOnlyGrantDefaults,
  verbOpAuthorDefaultForGoverningId,
} from './op-admission-gate.js';
import {
  AUTHOR_DEFAULT_ONLY_RESOLVER,
  createReadGrantChecker,
  type ReadGrantChecker,
} from './read-grant-checker.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from './storage/contract-grant-entry-store.js';

/** Shared frozen empty `scope_restrictions` — the admit-all baseline that the
 *  read-grant checker's scope-fence half now always takes: the per-door read fence
 *  re-homed onto explicit `data.<collection>` grant rows (slice 5), so the explicit
 *  rows carry the fence and the author-default scope source reduces to admit-all. */
const NO_SCOPE_RESTRICTIONS: ReadonlyArray<string> = Object.freeze([]);

type LiveBoundContractKind = 'standing' | 'customer_instance';

const liveBoundContractKind = (
  def: Pick<ContractDefinition, 'grant_kind'>,
): LiveBoundContractKind | undefined => {
  if (isStandingContractDefinition(def)) return 'standing';
  return def.grant_kind === 'customer_instance' ? 'customer_instance' : undefined;
};

const isLiveBoundContractKind = (
  def: Pick<ContractDefinition, 'grant_kind'>,
): boolean => liveBoundContractKind(def) !== undefined;

/** The contract-governance read + use-record surface the policy gates call. */
export interface ContractOverlayResolver {
  /** True iff an active, in-scope contract governs this dispatch — the signal the
   *  caller `recordUse`s on (per-call dispatches only). Read-only (no `recordUse`).
   *
   *  Matches the contract scope on the (channel, actor, ingredient) axes — the OP
   *  axis is deliberately NOT gated here. Grant-foundation slice 3 (home #2,
   *  `f78de9ee`) made the unified `contract_grant` store the SOLE op-admission
   *  authority: a scoped door's `scope.operation_ids` is folded into explicit
   *  op-grant rows at mint and enforced by `op-admission-gate.ts isOpGranted` at
   *  `admitOne` / `admitRawOp`. So metering keys on ingredient-scope alone; whether
   *  the op itself is admissible is the op gate's decision, layered on top.
   *
   *  Op-absent metering is a deliberate, fail-safe OVER-count: an op-scoped +
   *  bounded (`max_uses`) contract counts op-absent dispatches (native MCP
   *  meta-tools / non-kernel simple-form) too (spec `:253` "every gateway dispatch
   *  decrements"; the alternative re-adds op-aware metering and breaks the
   *  metering↔admission lockstep). All unobservable at zero installs. Replaces the
   *  retired `resolve().active` (the overlay-cell projection died with the matrix). */
  shouldMeterUse(source: ExecutionSource, ingredientSlug: string): boolean;
  /** Decrement the contract's use counter. No-op for a non-contract source. Call
   *  once per per-call dispatch the matching `resolve` reported `active` for, at the
   *  gateway's actual-proceed point (once the call crosses the boundary — success,
   *  failure, or in_doubt) — not on `deny`/`ask`, which never dispatch. */
  recordUse(source: ExecutionSource): void;
  /** D-166 P2 / D-196 token↔contract binding — true iff `contract_id` names a
   *  minted contract row whose lifecycle is active and whose kind is valid for a
   *  token-bound door. Ordinary standing contracts and D-196
   *  `customer_instance` rows are live here; customer templates, session grants,
   *  delegation grants, missing rows, revoked / expired / exhausted rows, and
   *  unknown future kinds fail closed. This method is the kill-switch probe the
   *  MCP transport consumes before applying any seller-customer admission
   *  overlay. */
  isContractLive(contract_id: string): boolean;
  /** D-196 R1a — classify a live token-bound contract from the authoritative
   *  `contract_definition` row. Seller admission uses this to distinguish an
   *  ordinary standing door (no Seller row required) from a
   *  `customer_instance` (exactly one Seller row + bearer required).
   *
   *  Returns `undefined` for a missing/dead row or a kind that cannot back a
   *  live token. Optional only so pre-D-196 test/embedding stubs remain source
   *  compatible; the production factory always implements it, and callers
   *  with a present resolver must treat an `undefined` result as unresolved,
   *  never as ordinary standing. */
  resolveBoundContractKind?(
    contract_id: string,
  ): LiveBoundContractKind | undefined;
  /** D-187 §6 (step 7) — the level-1 DOOR-TYPE gate: true iff `contract_id` names a
   *  contract ENABLED to back a door of type `doorType` (`contractPermitsDoorType`
   *  over the row's `door_types`). The HTTP MCP transport calls this at connection
   *  establishment (it holds only the bound `contract_id`, not a full
   *  `ExecutionSource`), ALONGSIDE {@link isContractLive}: a live contract whose
   *  `door_types` does not include the door it is binding through is rejected.
   *
   *  Liveness-INDEPENDENT by design (the door-type check is a configuration gate,
   *  not a kill-switch — the transport ANDs `isContractLive` separately): a
   *  non-existent / dead id resolves `true` here (no door-type restriction to
   *  enforce — the liveness probe owns the dead case), so the SOLE `false` is a
   *  LIVE contract with an explicit `door_types` that excludes `doorType`. An
   *  absent / empty `door_types` is the wildcard (any door) — behaviour-preserving
   *  at zero installs.
   *
   *  Optional on the interface so existing stubs need no change; a caller treats
   *  its absence as the wildcard-admit `true`. The SOLE production factory
   *  ({@link createContractOverlayResolver}) always implements it. */
  permitsDoorType?(contract_id: string, doorType: DoorType): boolean;
  /** The door's owner-confirmed standing closure — `scope.operation_ids` iff
   *  `door_execution_policy.standing_closure` is on, else `undefined`.
   *
   *  ⛔⛔ IT LIVES ON THE CONTRACT, NOT THE TOKEN. Lifecycle and limitation are
   *  the contract's job; a token is a bearer. The MCP arm first stored this on
   *  the token record and threaded it through the transport — two storage
   *  shapes for one concept, and the reception arm already had it right
   *  (`door_execution_policy.standing_closure` + `scope.operation_ids`, read by
   *  `buildReceptionContractSnapshot`). Both arms now read the same field off
   *  the same row.
   *
   *  ⚠ Liveness is NOT re-checked here, matching `permitsDoorType`: the caller
   *  already collapses everything on a dead contract. */
  standingClosureOperationIds?(contract_id: string): readonly string[] | undefined;
  /** D-187 slice 5 — resolve the governing CONTRACT's per-collection EXECUTE-path read
   *  fence for THIS dispatch, DERIVED from the contract's `data.<collection>` grant rows
   *  (the SAME rows {@link resolveReadGrantChecker} reads — one source of truth, so the
   *  execute-path scope gate and the native-tool collection fence can never diverge). The
   *  granted readable-collection set → `scopeRestrictionsFromReadableCollections` → the
   *  `ContractSnapshot.scope_restrictions` the gateway's `evaluateScopeRestrictions`
   *  enforces.
   *
   *  Entity access is a per-CONTRACT Layer-2 concern (owner-confirmed 2026-06-23 — there
   *  is no per-DOOR access list): the grant rows key on the contract, so EVERY door that
   *  contract backs shares this fence. It is contract-wide, NOT per-ingredient, so it
   *  takes no ingredient slug.
   *
   *  Returns `[]` (admit-all, the `evaluateScopeRestrictions` baseline) for a
   *  non-contract source, an absent/inactive/exhausted contract, a gate-consumed
   *  grant row, the owner (permissive), or any contract that grants every readable
   *  collection — i.e. every owner / unbound / unconfigured path reads all (the read
   *  fence is opt-in via explicit collection revokes). The non-collection scope
   *  families (`connection.*` / `data.enrichment.*` / `data.shared.*` /
   *  `data.memory.*`) stay admitted via `scopeRestrictionsFromReadableCollections`'s
   *  keep-patterns — only raw-collection reads narrow, exactly as the retired
   *  overlay-cell fence did.
   *
   *  Optional on the interface so existing stubs need no change; a caller treats its
   *  absence as the admit-all `[]`. The SOLE production factory
   *  ({@link createContractOverlayResolver}) always implements it, so a live dispatch
   *  never takes the absent-method admit-all path. */
  resolveContractScopeRestrictions?(source: ExecutionSource): ReadonlyArray<string>;
  /** D-187 AMENDMENT — resolve the bound contract's per-dispatch read-grant checker
   *  (topic + raw-collection reads as unified `contract_grant` entries) for THIS
   *  dispatch. Read-scope folded into the one `(contract × grant)` matrix: a topic /
   *  collection read is a plain grant (`explicit row ?? author-default`), the same shape
   *  as an op grant. Replaces the retired `resolveEnrichmentVisibilityOverrides` (the
   *  `toggle ?? authorDefault` visibility map) — the read site now queries
   *  {@link ReadGrantChecker.isTopicReadGranted} / `isCollectionReadGranted` instead of
   *  AND-ing `isTopicMcpPrivate` + the scope-fence by hand.
   *
   *  Same source→contract_id resolution + active / grant-kind gating as
   *  {@link resolveContractScopeRestrictions}: a non-contract source, an absent / inactive /
   *  exhausted contract, or a gate-consumed grant is liveness-gated OUT → the checker
   *  honours no grant rows → every entry reads its author-default (the scope-fence ∧ the
   *  registry `mcp_exposed` hint). The owner's unbound synthetic token (no
   *  `contract_definition` row) takes that path too — matching today's empty-table reads.
   *
   *  Optional on the interface so existing stubs need no change; absence reads as the
   *  author-default-only checker. The SOLE production factory always implements it; an
   *  absent grant store ⇒ {@link AUTHOR_DEFAULT_ONLY_RESOLVER} (additive, pre-seed
   *  behavior — no grant rows to overlay). */
  resolveReadGrantChecker?(source: ExecutionSource): ReadGrantChecker;
}

export interface CreateContractOverlayResolverDeps {
  /** The `contract.contract_definition.*` lifecycle store — `get` (active-check) +
   *  `recordUse` (counter decrement). */
  readonly definitionStore: ContractDefinitionStore;
  /** D-187 AMENDMENT / slice 5 — the unified per-contract grant store
   *  (`contract.contract_grant.<contract_id>.*`), the read source for BOTH
   *  {@link ContractOverlayResolver.resolveReadGrantChecker} (topic + collection read
   *  grants) AND {@link ContractOverlayResolver.resolveContractScopeRestrictions} (the
   *  execute-path collection fence, derived from the `data.<collection>` rows).
   *  Optional: absent ⇒ the author-default-only checker + admit-all door scope
   *  (pre-seed / no-store behavior). Wraps the SAME `ContractStore` as
   *  `definitionStore`. */
  readonly grantEntryStore?: ContractGrantEntryStore;
  /** Clock for the lifecycle active-check (epoch-ms). Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Build a {@link ContractOverlayResolver} over a `ContractDefinitionStore` + the
 *  unified `contract_grant` store. Stateless beyond the injected clock; safe to
 *  construct once per run (or once at boot — it reads the stores live each call). */
export const createContractOverlayResolver = (
  deps: CreateContractOverlayResolverDeps,
): ContractOverlayResolver => {
  const now = deps.now ?? ((): number => Date.now());
  // Shared per-dispatch read-grant checker build — the ONE place that resolves the
  // governing contract + overlays the grant rows. BOTH `resolveReadGrantChecker` (the
  // native-tool read gate) and `resolveContractScopeRestrictions` (the execute-path
  // collection fence) read it, so the two fences can never diverge.
  const buildReadGrantChecker = (source: ExecutionSource): ReadGrantChecker => {
    // No wired grant store ⇒ pre-seed / no-store path: the author-default-only resolver
    // (no grant rows to overlay → every entry reads its registry author default).
    const grantResolver = deps.grantEntryStore
      ? createGrantEntryResolver(deps.grantEntryStore)
      : AUTHOR_DEFAULT_ONLY_RESOLVER;
    // Resolve the GOVERNING contract via the shared primitive (the same one the
    // op-admission gate + the recipe / chat read producers use): an OWNER-AI surface →
    // the owner contract (always live, permissive-by-default), a door → its bound
    // contract (active ∧ ¬grant-kind), a contract-free source / dead door / gate-consumed
    // grant / the owner's unbound synthetic mcp token (no `contract_definition` row) →
    // undefined → the checker honours no grant rows → every entry reads its author-default.
    const gatedId = resolveGrantGoverningContractId(source, deps.definitionStore, now);
    // D-187 slice 5 — the contract read FENCE re-homed onto explicit
    // `data.<collection>` rows. Ordinary doors keep the author defaults; D-196
    // customer instances are finite stamped snapshots, so every absent op /
    // collection / topic row defaults off.
    return createReadGrantChecker(
      grantResolver,
      gatedId,
      verbOpAuthorDefaultForGoverningId(gatedId, deps.definitionStore),
      gatedId !== undefined
        && usesExplicitOnlyGrantDefaults(gatedId, deps.definitionStore),
    );
  };
  return {
    shouldMeterUse(source, ingredientSlug): boolean {
      // Contract-free sources (system / unrestricted user_self / anonymous) carry no
      // contract_id and never meter a contract. A self-restricted user_self DOES carry
      // one (D-161 N.3) and meters like any contracted source — read it
      // variant-agnostically rather than narrowing on the actor.
      const contract_id = executionSourceContractId(source);
      if (contract_id === undefined) return false;
      const def = deps.definitionStore.get(contract_id);
      // Absent (never minted, or an id the producer can't back with a row) OR not
      // active (revoked / expired / exhausted) ⇒ the contract "doesn't match"
      // (spec :450); nothing to meter.
      if (!def || !isContractActive(def, now())) return false;
      // D-177 / D-196 — only ordinary standing contracts are policy-metered here.
      // Gate-consumed grants and seller customer/template rows are handled by their
      // own opt-in substrates; treating any of them as standing would silently burn
      // the wrong counters or widen access.
      if (!isStandingContractDefinition(def)) return false;
      // Match the scope on (channel, actor, ingredient) only. The OP axis is RETIRED —
      // `contract_grant` (op-admission-gate.ts `isOpGranted`) is the sole op-admission
      // authority since the home-#2 fold — so neutralize `operation_ids` to a wildcard
      // (`[]` ⇒ match-any in `axisAdmits`) before matching: metering keys on ingredient
      // alone, and the op restriction is enforced by the op gate. (`connection_name` is
      // unthreaded as before — a scope that sets `connection_names` still fails closed
      // here; that axis is unchanged by this slice.)
      const ctx: ContractScopeContext = {
        channel: source.channel,
        actor: source.actor,
        ingredient_id: ingredientSlug,
      };
      // Out-of-scope for THIS (channel, actor, ingredient) ⇒ the contract governs other
      // calls but not this one; nothing to meter here.
      return contractScopeMatches({ ...def.scope, operation_ids: [] }, ctx);
    },
    recordUse(source): void {
      const contract_id = executionSourceContractId(source);
      if (contract_id === undefined) return;
      // The store's `recordUse` is a dumb counter (no clock, no active re-check) —
      // the active gate was the matching `shouldMeterUse` above. Unbounded contracts no-op.
      deps.definitionStore.recordUse(contract_id);
    },
    isContractLive(contract_id): boolean {
      const def = deps.definitionStore.get(contract_id);
      return def !== null
        && isContractActive(def, now())
        && isLiveBoundContractKind(def);
    },
    resolveBoundContractKind(contract_id): LiveBoundContractKind | undefined {
      const def = deps.definitionStore.get(contract_id);
      if (def === null || !isContractActive(def, now())) return undefined;
      return liveBoundContractKind(def);
    },
    standingClosureOperationIds(contract_id): readonly string[] | undefined {
      const def = deps.definitionStore.get(contract_id);
      if (def === null) return undefined;
      if (def.door_execution_policy?.standing_closure !== true) return undefined;
      // ⚠ An EMPTY list is returned as empty, never as absent: a contract whose
      // scope names no op has nothing to admit, and the gate reads that
      // correctly as "this op is not in the closure". `undefined` would be
      // indistinguishable from "no opt-in". Same rule the reception builder
      // states.
      return def.scope?.operation_ids ?? [];
    },
    permitsDoorType(contract_id, doorType): boolean {
      // No def ⇒ no door-type restriction to enforce here; the dead/absent case is
      // owned by the transport's `isContractLive` AND (fail-closed for a bound
      // token). So the SOLE `false` is a real contract row whose explicit
      // `door_types` excludes `doorType` (`contractPermitsDoorType` treats an
      // absent/empty list as the wildcard). Liveness is NOT re-checked: the
      // transport ANDs it separately, and a door-type mismatch is a configuration
      // rejection distinct from a revoke/expiry kill-switch.
      const def = deps.definitionStore.get(contract_id);
      if (def === null) return true;
      return contractPermitsDoorType(def, doorType);
    },
    resolveContractScopeRestrictions(source): ReadonlyArray<string> {
      // Only a dispatch governed by a real (active, non-grant-kind) contract is fenced.
      // A contract-free source, the OWNER's unbound stdio / canonical-CLI client (a
      // synthetic mcp token with no `contract_definition`), an unminted / dead / revoked
      // / gate-consumed contract — all resolve to NO governing contract → admit-all
      // (`[]`), matching the retired overlay's `[]`-for-no-contract behaviour (the owner
      // reads all their own data, incl. the owner-default-only collections like
      // `data.webhook`; the per-tool read-tool grant is the fail-closed backstop for an
      // unbound external door). Without this short-circuit, `ownerOnlyAdjustedAuthorDefault`
      // would fence `data.webhook` for an empty `boundId` and wrongly narrow the owner's
      // own stdio reads.
      if (
        resolveGrantGoverningContractId(source, deps.definitionStore, now) === undefined
      ) {
        return NO_SCOPE_RESTRICTIONS;
      }
      // A governed door: derive the fence from the SAME read-grant checker the native
      // read tools use (one source of truth). The granted readable-collection set →
      // `scopeRestrictionsFromReadableCollections` (which keeps `connection.*` /
      // `data.enrichment.*` / `data.shared.*` / `data.memory.*` admitted and narrows only
      // raw collections, exactly as the retired overlay-cell fence did). A door defaults
      // to fencing the owner-default-only collections (`data.webhook`) — consistent with
      // the read-grant checker — and honours explicit per-collection revokes on top.
      const checker = buildReadGrantChecker(source);
      const granted = new Set(
        READABLE_COLLECTIONS.filter((c) => checker.isCollectionReadGranted(c)),
      );
      return scopeRestrictionsFromReadableCollections(granted);
    },
    resolveReadGrantChecker(source): ReadGrantChecker {
      return buildReadGrantChecker(source);
    },
  };
};
