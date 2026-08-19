/** Grant-foundation slice 3b (D-187 AMENDMENT `693b7d03`) — the OP-ADMISSION gate over
 *  the unified grant store: "may the governing contract invoke this `operation_id`?".
 *
 *  This is the op-axis analog of the 3a {@link ./read-grant-checker.ts ReadGrantChecker}
 *  (which gates topic / collection READS). Together they make the unified
 *  `(contract × grant)` matrix the single admission authority: an `op` grant entry gates
 *  the verb, the `enrichment.<topic>` / `data.<collection>` entries gate the reads.
 *
 *  It folds **home #2** — the slice-1/2 standing-contract op scope (`scope.operation_ids`
 *  allow-list + the overlay cell's `denied_operation_ids` deny-list, matched through
 *  `contractScopeMatches`) — into `op` grant entries (`contract_grant`). And it is the
 *  mechanism by which the OWNER's own AI (`(chat | messenger, user_self)`, resolved to
 *  `OWNER_CONTRACT_ID` by {@link ./grant-governing-contract.ts}) is gated: the admit-all
 *  `user_self` cell for AI channels goes away — the owner contract is a REAL gate (seeded
 *  permissive + tightenable).
 *
 *  ## The author-default is PER-GOVERNING-CONTRACT (D-187 §6 home-#2 fold)
 *  The gate resolves `explicit grant row ?? author-default`, where the author-default
 *  depends on WHO governs:
 *    - **Owner** (`OWNER_CONTRACT_ID`) — PERMISSIVE (`true`): "the owner is one fully-
 *      granted contract," tightenable. The boot reconcile materializes explicit
 *      `granted:true` rows (so the UI shows them + a `granted:false` revoke survives), but
 *      the permissive default keeps the owner open even PRE-reconcile (test harness /
 *      first boot) + for any unenumerated id. An explicit revoke still wins.
 *    - **Door / standing contract** — the REGISTRY/PACK FLOOR (the home-#2 flip). The
 *      door's authored op allow-list (`scope.operation_ids`) is folded into explicit
 *      `granted:true` `contract_grant` op rows AT MINT ({@link ./contract-handler.ts}
 *      `handleContractMint`, atomic with the mint), so the unified grant store — not the
 *      per-token snapshot — is the door's op authority. The floor for an op the door holds
 *      NO row for:
 *        · a **WILDCARD** door (empty / absent `scope.operation_ids` = "any op") stays
 *          PERMISSIVE (`true`) — behaviour-preserving (a wildcard door is admitted any op
 *          today; its real gate is the per-token `ContractSnapshot.allowed_tools`), and it
 *          has no finite op set to materialize, so nothing was folded.
 *        · a **SCOPED** door fail-closes (`false`): it may invoke EXACTLY its
 *          `scope.operation_ids` — kernel `core.*` AND pack ops alike — for which the
 *          mint-time fold wrote an explicit `granted:true` row; every other op (incl. an
 *          unenumerated or future `core.*` verb) is DENIED. NO kernel carve-out: a door is
 *          a deliberately-authored fence, never owner-wide allow in disguise (D-187 §10) —
 *          a syntactic `isKernelOp` floor would silently auto-grant new kernel ops to
 *          every existing door (a version-skew escalation; codex 3b-follow-on HIGH).
 *      At zero installs no door exists, so the flip is behaviour-preserving; it sets the
 *      enforcement posture for when doors ship.
 *
 *  A contract-free dispatch (`(user, user_self)` HID + the system channels) has NO
 *  governing contract → the gate is SKIPPED (admit): internal ops + the human's direct
 *  HID stay outside the grant axis (owner-directed).
 *
 *  Spec: D-187 AMENDMENT block; handover
 *  `handover_grant_slice3_session1_3b_admission_actor.md` (step 4 / 5). */

import {
  opGrantEntry,
  ownerOnlyAdjustedAuthorDefault,
  OWNER_CONTRACT_ID,
  PUBLIC_CONTRACT_ID,
  type ExecutionSource,
} from '@recued/contracts';

import { createGrantEntryResolver } from './contract-grant-resolve.js';
import { resolveGrantGoverningContractId } from './grant-governing-contract.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from './storage/contract-grant-entry-store.js';

/** The per-dispatch op-admission decision the admit sites query. */
export interface OpAdmissionGate {
  /** Is `opId` admitted for `source`'s governing contract?
   *   - `true` — no op axis to gate (`opId === undefined`), OR no governing contract
   *     (contract-free: `(user, user_self)` HID + system channels), OR the op resolves
   *     granted (`explicit grant row ?? author-default` — owner-permissive, a wildcard
   *     door, or a scoped door's explicitly-granted (folded) op).
   *   - `false` — the governing contract DENIES the op: an explicit `op` REVOKE row, OR a
   *     SCOPED door's op with no grant row (fail-closed — only its `scope.operation_ids`
   *     are granted; see {@link opAuthorDefault}). The caller turns `false` into a `deny`
   *     decision (`op_not_granted`).
   *
   *  `opId` is the dispatched op's DECLARED `operation_id` (the same value the overlay's
   *  op axis takes — catalog surface key → `operation_id`, or a kernel backing slug →
   *  its `core.*` op). Absent (a non-kernel simple-form slug) ⇒ no op axis ⇒ admit. */
  isOpGranted(source: ExecutionSource, opId: string | undefined): boolean;

  /** D-188 — is this dispatch FROZEN by the master "Pause server"
   *  circuit-breaker? `true` iff the server is paused AND `source` has a
   *  GOVERNING contract (owner-AI → {@link OWNER_CONTRACT_ID}, or a door).
   *  A contract-free dispatch (the owner's direct `(user, user_self)` HID +
   *  the system channels) resolves to no governing contract → `false`
   *  (NOT frozen), so the owner's hands-on control + the resume rpc stay
   *  live while everything contracted is halted — the SAME bypass the
   *  op-grant axis uses (reusing {@link resolveGrantGoverningContractId}
   *  so the two can never disagree about who is "governed").
   *
   *  Deliberately a DISTINCT axis from {@link isOpGranted}: pause is a
   *  transient server-wide halt, not a grant decision. The caller turns
   *  `true` into a `server_paused` deny — never `op_not_granted` — so a
   *  paused server never lies as "not granted". Always `false` when no
   *  `isPaused` thunk was injected (pause unenforced — dbless / unit). */
  isFrozenByPause(source: ExecutionSource): boolean;

  /** D-247 D5 — does the OWNER's contract grant this recipe? `entryKey` is the
   *  `recipe.<publisher>/<recipe_id>` key, formed once in
   *  `recipe-grant-identity.ts` so the seed and this read cannot disagree.
   *
   *  ⛔⛔ THE NAME SAYS OWNER BECAUSE IT ANSWERS ONLY FOR THE OWNER, AND THAT IS
   *  A DESIGN DECISION, NOT A GAP. A DOOR's recipe authority is its INBOUND TOKEN:
   *  `buildMcpContractSnapshot` folds granted recipe wire names into
   *  `allowed_tools` under `inboundTokenAuthorize` (D-232 § 20.19), and a derived
   *  reception / webhook door has no recipe grant at all — its capability comes
   *  from the one recipe it is bound to. Answering `true` here for a door would
   *  WIDEN it past what its token grants, which is a security regression wearing
   *  the costume of consistency. A non-owner governing contract therefore
   *  resolves `false`, and the door's answer stays where it already lives.
   *
   *  ⚠ CONTRACT-FREE RESOLVES `false`, WHICH INVERTS {@link isOpGranted}'s
   *  CONVENTION ON PURPOSE. There, absent-governance means "no gate → admit".
   *  Here the question is "is there a grant to ride", and a dispatch with no
   *  governing contract has none — it does not need one, because D12's gate is
   *  skipped for it entirely. Returning `true` would hand every HID run a
   *  coverage it never has to use, and the first reader to consult this outside
   *  the gate would inherit a lie. */
  isOwnerRecipeGranted(source: ExecutionSource, entryKey: string | undefined): boolean;

  /** D-247 — is this dispatch governed by the OWNER contract?
   *
   *  ⛔⛔ THIS EXISTS BECAUSE {@link isOwnerRecipeGranted}'s `false` IS AMBIGUOUS
   *  AND THE AMBIGUITY IS DANGEROUS. It answers `false` both for "the owner holds
   *  no grant" and for "this is a door, whose recipe authority is its inbound
   *  token, not the owner's contract". A caller that reads the second as the
   *  first HIDES OR REFUSES EVERY TIER-2 RECIPE ON EVERY DOOR — a total outage
   *  that looks like a working gate. Ask this FIRST, and only consult the grant
   *  when it says yes. */
  isOwnerGoverned(source: ExecutionSource): boolean;
}

/** D-196 — customer instances carry a finite stamped grant snapshot. Every
 * missing grant row is therefore denied across op, collection, and topic
 * checks; ordinary standing doors retain their author-default behavior. */
export const usesExplicitOnlyGrantDefaults = (
  governingId: string,
  definitionStore: ContractDefinitionStore,
): boolean => {
  if (governingId === OWNER_CONTRACT_ID) return false;
  // D-207 slice 1b — the PUBLIC sentinel and every reception door are explicit-only.
  //
  // Deny-by-default MUST NOT be expressed as an empty scope. `opAuthorDefault` below
  // reads an empty / absent `scope.operation_ids` as a WILDCARD door and returns TRUE
  // (permissive) — so:
  //   - the PUBLIC floor, which by definition grants nothing, would fail OPEN if it
  //     tried to say so with an empty scope; and
  //   - a paired recipe whose derived op closure is legitimately EMPTY (a pure-transform
  //     recipe — validate-and-render, no ops at all) would take a WILDCARD door, which
  //     is the worst possible reading of "this recipe needs no operations".
  // Both are caught here instead: an explicit `contract_grant` row is the ONLY thing
  // that authorizes an op on a public door, whatever its scope happens to contain.
  if (governingId === PUBLIC_CONTRACT_ID) return true;
  const def = definitionStore.get(governingId);
  if (def?.door_types?.includes('reception') === true) return true;
  return def?.grant_kind === 'customer_instance';
};

/** The author-default — the `??` fallback the resolver applies for an op the governing
 *  contract holds NO explicit `contract_grant` row for (see the module jsdoc). It is a
 *  per-CONTRACT property (independent of the op): the door's op authority is its set of
 *  explicit grant rows, and the default only answers "what about an op with no row".
 *    - OWNER → permissive (`true`).
 *    - DOOR with a WILDCARD op-scope (empty / absent `scope.operation_ids`) → permissive
 *      (`true`): behaviour-preserving, its real gate is the per-token snapshot.
 *    - DOOR with a SCOPED op-list → FAIL-CLOSED (`false`): only the ops the mint-time fold
 *      materialized from `scope.operation_ids` are granted (kernel + pack alike); no
 *      kernel carve-out (see the module jsdoc — D-187 §10).
 *    - CUSTOMER INSTANCE → FAIL-CLOSED (`false`): only its stamped explicit rows grant.
 *  `governingId` is the LIVENESS-GATED value {@link resolveGrantGoverningContractId}
 *  returned (a live door, or the owner sentinel), so `definitionStore.get` reads that same
 *  live def with no intervening await — no TOCTOU. A missing def (logically impossible for
 *  a live governing id) falls to the wildcard branch (permissive), harmless: a dead door's
 *  snapshot is `[]`, so nothing dispatches regardless.
 *
 *  Exported so the D-187 slice-3 read-gate VERB-OP term ({@link ./read-grant-checker.ts})
 *  resolves the cross-topic read verbs through the SAME per-contract op author-default the
 *  op-admission gate uses — the "one decision, many seams" consolidation: the verb-op term
 *  and the recipe-path op gate can never disagree about a contract's default op posture. */
export const opAuthorDefault = (
  governingId: string,
  definitionStore: ContractDefinitionStore,
): boolean => {
  if (governingId === OWNER_CONTRACT_ID) return true; // owner: permissive, tightenable
  // D-196 customer contracts carry a finite, self-contained grant list. Missing
  // rows must therefore fail closed even when an imported/legacy instance has an
  // empty `scope.operation_ids`; only explicit contract grants authorize it.
  if (usesExplicitOnlyGrantDefaults(governingId, definitionStore)) return false;
  const def = definitionStore.get(governingId);
  const ops = def?.scope.operation_ids;
  return ops === undefined || ops.length === 0; // wildcard door permissive; scoped fail-closed
};

/** D-187 slice-3 read gate — the VERB-OP author-default for an ALREADY-liveness-gated
 *  governing id, the value the read-grant producers pass into
 *  {@link ./read-grant-checker.ts createReadGrantChecker}. `undefined` (a contract-free
 *  source, or a gated-out / dead door) ⇒ `true` (admit) — matching {@link OpAdmissionGate.isOpGranted}
 *  returning `true` when no governing contract gates the op; else the contract's
 *  {@link opAuthorDefault}. Single source of the "undefined ⇒ admit" rule so the two
 *  producers ({@link ./read-grant-checker.ts} + {@link ./policy-contract-overlay.ts}) can't
 *  drift, and the verb-op term resolves identically to `isOpGranted`. */
export const verbOpAuthorDefaultForGoverningId = (
  gatedId: string | undefined,
  definitionStore: ContractDefinitionStore,
): boolean => (gatedId === undefined ? true : opAuthorDefault(gatedId, definitionStore));

/** Build an {@link OpAdmissionGate} over the unified grant store + the contract
 *  definition store (the latter for the door-liveness half of
 *  {@link resolveGrantGoverningContractId} AND the scoped-door op floor in
 *  {@link opAuthorDefault}). Stateless beyond the injected clock; safe to
 *  construct per request or once at boot (it reads the stores live each call). */
export const createOpAdmissionGate = (deps: {
  readonly grantEntryStore: ContractGrantEntryStore;
  readonly definitionStore: ContractDefinitionStore;
  /** D-188 — the master pause flag (server-state). When injected, a paused
   *  server FREEZES every governed dispatch via {@link OpAdmissionGate.isFrozenByPause}.
   *  Absent ⇒ pause is unenforced at this gate (dbless / unit) — the
   *  scheduler-pause + webhook-closure halves still apply where wired. */
  readonly isPaused?: () => boolean;
  readonly now?: () => number;
}): OpAdmissionGate => {
  const now = deps.now ?? ((): number => Date.now());
  const grantResolver = createGrantEntryResolver(deps.grantEntryStore);
  return {
    isFrozenByPause(source) {
      if (!(deps.isPaused?.() ?? false)) return false;
      // Frozen iff GOVERNED — the IDENTICAL "who governs" resolution the op
      // axis uses. Contract-free (HID + system channels) ⇒ undefined ⇒ not
      // frozen (the owner's direct control + the resume rpc bypass pause).
      return (
        resolveGrantGoverningContractId(source, deps.definitionStore, now)
        !== undefined
      );
    },
    isOpGranted(source, opId) {
      if (opId === undefined) return true; // no op axis → nothing to gate
      const governingId = resolveGrantGoverningContractId(source, deps.definitionStore, now);
      if (governingId === undefined) return true; // contract-free → no grant gate
      // `explicit grant row ?? author-default`: owner-permissive, wildcard-door-permissive,
      // or a scoped door fail-closed — see `opAuthorDefault` + the module jsdoc. The door's
      // op authority is its explicit grant rows (the mint fold wrote them); an explicit
      // revoke row always wins. D-187 slice 3b — `ownerOnlyAdjustedAuthorDefault` TIGHTENS
      // the author-default for the OWNER-default-only sensitive surfaces (engagements /
      // audit / webhook): owner-default-on, EVERY door (incl. wildcard) default-off, so a
      // door must be explicitly granted them. Applied identically in the read-grant checker.
      const entry = opGrantEntry(opId);
      return grantResolver.isGranted(
        governingId,
        entry,
        ownerOnlyAdjustedAuthorDefault(
          entry,
          governingId,
          opAuthorDefault(governingId, deps.definitionStore),
        ),
      );
    },
    isOwnerGoverned(source) {
      return resolveGrantGoverningContractId(source, deps.definitionStore, now)
        === OWNER_CONTRACT_ID;
    },
    isOwnerRecipeGranted(source, entryKey) {
      // No grant address (no publisher resolved) ⇒ no grant. Never granted-by-absence.
      if (entryKey === undefined) return false;
      const governingId = resolveGrantGoverningContractId(source, deps.definitionStore, now);
      // Contract-free and every DOOR resolve false — see the interface doc. The
      // same `resolveGrantGoverningContractId` the op axis and the pause axis use,
      // so the three can never disagree about who is governed.
      if (governingId !== OWNER_CONTRACT_ID) return false;
      // The author default is D7's inversion: `ownerOnlyAdjustedAuthorDefault`
      // short-circuits every `recipe.*` key to FALSE, owner included. The
      // `normalDefault` passed here is therefore never consulted; it is written as
      // `true` so that a future reader who removes the inversion gets the
      // owner-permissive behaviour every other kind has, rather than a silent
      // deny-everything that would look like this line's intent.
      return grantResolver.isGranted(
        governingId,
        entryKey,
        ownerOnlyAdjustedAuthorDefault(entryKey, governingId, true),
      );
    },
  };
};
