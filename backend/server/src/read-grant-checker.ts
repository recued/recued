/** Grant-foundation slice 3a (D-187 AMENDMENT `693b7d03`) — the per-dispatch
 *  read-grant checker: the read-site convenience over the unified grant store.
 *
 *  The amendment collapses the read-scope sprawl into the one `(contract × grant)`
 *  matrix: a topic read and a raw-collection read are PLAIN per-contract grants, the
 *  same shape as an op grant. This module is the read-site analog of the retired
 *  `enrichment-visibility-resolve.ts` — a per-dispatch object the read surfaces hold
 *  and query — but where that resolved a `toggle ?? authorDefault` VISIBILITY, this
 *  resolves a GRANT: `explicit grant row ?? author-default`, the uniform
 *  `resolveGrantEntry` rule.
 *
 *  ## What folds where (slice 6 — the scope-fence half retired)
 *  A read decision is ONE grant lookup, `explicit grant row ?? author-default`:
 *    - **author-default** = the registry `mcp_exposed` hint for a topic, admit-all for a
 *      raw collection (modulo the owner-default-only tightening). The D-177
 *      `scope_restrictions` path-fence that used to ∧ into this default was re-homed onto
 *      explicit `data.<collection>` grant rows in slice 5, so slice 6 dropped the
 *      `scopeRestrictions` parameter (it was always empty at every call site).
 *    - the **explicit grant row** (a `data.<collection>` / `enrichment.<topic>` entry in
 *      `contract_grant`) overlays that default — grant (`true`) or revoke (`false`).
 *  At ZERO installs the grant store is empty ⇒ every entry resolves to its author-default
 *  (mcp_exposed for topics, admit-all for collections), plus the grant-row override.
 *
 *  ## Liveness is gated by the PRODUCER, not here
 *  The pure {@link createReadGrantChecker} takes an ALREADY-liveness-gated `contract_id`
 *  (undefined ⇒ no contract / inactive / a gate-consumed `session`/`delegation` grant ⇒
 *  the checker honours NO grant rows → author-default reads). The two producers apply
 *  that gate, exactly as the retired `resolveEnrichmentVisibilityOverrides` (overlay,
 *  source-keyed — see `policy-contract-overlay.ts`) and `createGatedEnrichmentVisibilityResolver`
 *  (contract_id-keyed) did: the gate is the SAME `active ∧ ¬grant-kind` test, lifted so a
 *  grant id rebound as a door/chat contract can never govern reads. The verb-op half of
 *  the amendment §3 read gate (`verb-op ∧ entry`) is DEFERRED to 3b with the op-admission
 *  fold (the native MCP read tools carry no clean `core.*` op id today) — op admission is
 *  the upstream fail-closed backstop in the meantime (a door not granted the read op
 *  never reaches here).
 *
 *  ## Registry coupling (why backend, not `read-collection-grant.ts`)
 *  The topic author-default reads `resolveMCPExposure(topic)`, which THROWS on an
 *  unregistered topic — the same coupling the retired pair carried. Callers MUST gate
 *  `isEnrichmentTopic(topic)` before {@link ReadGrantChecker.isTopicReadGranted}, the
 *  identical contract the retired `isTopicMcpPrivate` required.
 *
 *  Spec: `docs/d-187-spec.md` AMENDMENT block §3; handover
 *  `handover_grant_slice3_session1_backend_3a_3b.md`. */

import {
  COLLECTION_GRANT_PREFIX,
  opGrantEntry,
  ownerOnlyAdjustedAuthorDefault,
  OWNER_CONTRACT_ID,
  resolveMCPExposure,
  topicGrantEntry,
  type EnrichmentTopic,
  type ExecutionSource,
} from '@recued/contracts';

import { createGrantEntryResolver, type GrantEntryResolver } from './contract-grant-resolve.js';
import {
  gateGrantGoverningContractId,
  resolveGrantGoverningContractId,
} from './grant-governing-contract.js';
import {
  usesExplicitOnlyGrantDefaults,
  verbOpAuthorDefaultForGoverningId,
} from './op-admission-gate.js';
import { createContractDefinitionStore } from './storage/contract-definition-store.js';
import { createContractGrantEntryStore } from './storage/contract-grant-entry-store.js';
import type { ContractStore } from './storage/contract-store.js';

/** A resolver that ignores the store and always returns the author-default — the
 *  fail-safe a producer uses when NO grant store is wired (test stubs / a pre-store
 *  path). Equivalent to the retired "empty visibility map ⇒ every topic at its registry
 *  author default": with no grant rows to overlay, every entry reads its author-default. */
export const AUTHOR_DEFAULT_ONLY_RESOLVER: GrantEntryResolver = {
  isGranted: (_contract_id, _entry_key, authorDefault) => authorDefault,
};

/** D-205 #3 — the ONE model-facing copy a fenced raw-collection read returns, shared by
 *  every Tier-1 read tool (`contact.search` / `mail.search` / `calendar.search` /
 *  `work.search` / `work.read`). It lives HERE, next to the gate, because the two
 *  consumers cannot share it any other way: `chat-tool-handlers.ts` imports
 *  `work-entity-read-tools.ts`, so the copy cannot live in the former without a cycle —
 *  and duplicating it is how the wording drifts between two tools the model reads
 *  identically.
 *
 *  🔑 **Why the copy is this emphatic.** A policy refusal that renders as ABSENCE is a
 *  FALSE NEGATIVE the model will state to the user AS FACT — *"you have no mail from
 *  Bob"*, *"that task doesn't exist"*. The tool envelopes make this easy to get wrong:
 *  mail/calendar's refusal shape is `{ matches: [] }` (indistinguishable from an empty
 *  mailbox) and `work.read`'s is `{ entity: null, found: false }` (indistinguishable from
 *  a deleted record). The hint is the ONLY thing separating "you may not see this" from
 *  "this is not there", so it says so explicitly.
 *
 *  It also carries **do-not-retry + tell-the-user**, the framing every non-recoverable
 *  Tier-1 outcome carries (`HELD_FOR_APPROVAL_MESSAGE`, `emptyMemoryResult`,
 *  `RECALL_WITHHELD_MESSAGE`): a refusal a reasoning model reads as a transient failure
 *  gets retried to timeout. Pinned by tests; see the D-205 entry in
 *  `docs/chat-prompt-optimization-log.md` before rewording. */
export const collectionReadFencedHint = (collection: string): string =>
  `the ${collection} collection is not read-granted to this contract (data.${collection}). `
  + `This is NOT an empty result and NOT "not found" — matching records may well exist, but `
  + `this contract may not read them. Tell the user their contract does not grant `
  + `data.${collection}, and do not retry this call.`;

/** The VERB-OP twin of {@link collectionReadFencedHint}, for the Tier-1
 *  `work.search` / `work.read` tools when the dispatching contract lacks
 *  `core.work-entity.read`.
 *
 *  A SEPARATE string from the collection hint because it is a separate axis and
 *  the two refusals are FIXED BY DIFFERENT GRANTS: the collection hint sends the
 *  user to `data.<kind>`, and following it here would be a wild goose chase —
 *  granting `data.task` cannot lift this refusal. Naming the wrong grant is
 *  worse than naming none, because the model states the remedy to the user as
 *  fact and they act on it.
 *
 *  Carries the same three loads as its twin, for the same reasons: **not-an-empty**
 *  (the envelopes lie by default — `{entities: [], total: 0}` reads as "you have
 *  no tasks"; `{entity: null, found: false}` reads as "that task was deleted"),
 *  **tell-the-user**, and **do-not-retry** (a refusal a reasoning model reads as
 *  transient gets retried to timeout — the Tier-1 anti-loop invariant). Rides the
 *  SUCCESS envelope (`ok: true`) for that last reason.
 *
 *  Pinned by tests; see the 2026-07-16 entry in
 *  `docs/chat-prompt-optimization-log.md` before rewording. */
export const workEntityReadVerbOpFencedHint = (): string =>
  `reading work items is not granted to this contract (core.work-entity.read). `
  + `This is NOT an empty result and NOT "not found" — matching tasks, notes, `
  + `commitments or projects may well exist, but this contract may not read any of `
  + `them. Granting a data.<kind> collection will NOT lift this — the missing grant `
  + `is the core.work-entity.read operation itself. Tell the user that, and do not `
  + `retry this call.`;

/** A bound contract's read-grant decisions, resolved for ONE dispatch. The read
 *  surfaces hold this (replacing the retired per-dispatch `EnrichmentVisibilityOverrides`
 *  map) and query it per topic / collection. */
export interface ReadGrantChecker {
  /** Is `topic` read-granted to the bound contract? `explicit enrichment.<topic> grant
   *  row ?? author-default`, where author-default = the registry `mcp_exposed` hint
   *  (slice 6 retired the D-177 scope-fence half — re-homed to explicit grant rows),
   *  except a customer instance whose stamped snapshot defaults every missing row off.
   *  Caller MUST have gated `isEnrichmentTopic(topic)` — the author default calls
   *  `resolveMCPExposure`, which throws on an unregistered topic. */
  isTopicReadGranted(topic: EnrichmentTopic): boolean;
  /** Is `collection` read-granted to the bound contract? `explicit data.<collection>
   *  grant row ?? author-default`, where author-default = admit-all (slice 6 retired the
   *  D-177 raw-collection scope-fence — re-homed to explicit grant rows), modulo the
   *  owner-default-only tightening (`data.webhook` / `data.form_response`);
   *  customer instances instead default
   *  every missing row off. Takes a plain string (the canonical
   *  collection name a timeline row carries); a non-collection key never matches a real
   *  grant row. */
  isCollectionReadGranted(collection: string): boolean;
  /** D-187 AMENDMENT §3 (slice 3) — does the bound contract hold the VERB-OP grant for
   *  a cross-topic read verb (`core.memory.timeline.read` /
   *  `core.data.enrichment.{read,vector-search,describe}`)? `explicit op grant row ??
   *  the contract's op author-default` — the SAME per-contract op posture the op-admission
   *  gate uses (owner / wildcard-door permissive, scoped-door fail-closed), so the verb-op
   *  term and the recipe-path op gate can never disagree. The native read handlers compose
   *  this with the entry term via `isGrantedReadAdmissible(verbOp, entry)`: a topic /
   *  collection grant does NOT imply the verb. Carried on the checker so the gate is
   *  channel-agnostic (mcp / chat / messenger resolve the same checker per source). */
  isVerbOpGranted(verbOpId: string): boolean;
}

/** Build a {@link ReadGrantChecker} over an ALREADY-liveness-gated `contract_id`
 *  (undefined ⇒ author-default reads), a {@link GrantEntryResolver} (the explicit
 *  grant-row overlay), and the contract's VERB-OP author-default (the `??` fallback for a
 *  cross-topic read verb with no explicit op row — the producer computes it via
 *  {@link ./op-admission-gate.ts opAuthorDefault}; defaults to `true` = admit, the
 *  no-contract / no-producer fail-safe that reduces the read gate to the entry term, i.e.
 *  pre-slice-3 behaviour). `explicitGrantRowsOnly` selects the D-196 customer-instance
 *  posture: every missing op/collection/topic row denies. Slice 6 dropped the per-call
 *  `scopeRestrictions` argument: the
 *  D-177 scope-fence that used to seed the topic / collection author-default re-homed onto
 *  explicit `data.<collection>` grant rows (slice 5), so it was always empty here. Pure
 *  beyond the injected resolver. */
export const createReadGrantChecker = (
  grantResolver: GrantEntryResolver,
  contract_id: string | undefined,
  verbOpAuthorDefault = true,
  explicitGrantRowsOnly = false,
): ReadGrantChecker => {
  // The store keys on a non-empty contract_id; an empty id reads as "no row" → the
  // resolver applies the author-default. So a gated-out (undefined) contract maps to ''.
  const boundId = contract_id ?? '';
  // D-187 AMENDMENT 3b — the OWNER contract is PERMISSIVE by default: the owner sees
  // every topic / collection unless they explicitly revoke it (the D-187 "owner is one
  // fully-granted contract"). So the owner's author-default is `true`, overriding the
  // door-facing `mcp_exposed` hint (the owner sees author-`private` topics too). The boot
  // reconcile materializes EXPLICIT `granted:true` rows so the UI shows them + revokes
  // survive; this permissive default keeps the owner open even pre-reconcile (test harness
  // / first boot) — an explicit revoke row still wins via the resolver's
  // `explicit ?? authorDefault`. (The `||` short-circuits, so the owner path never calls
  // the throw-on-unregistered `resolveMCPExposure`.)
  const ownerPermissive = boundId === OWNER_CONTRACT_ID;
  return {
    isTopicReadGranted(topic) {
      // Slice 6 — author-default = the registry `mcp_exposed` hint alone (the scope-fence
      // half re-homed to explicit grant rows). The owner is permissive over it.
      const authorDefault = !explicitGrantRowsOnly
        && (ownerPermissive || resolveMCPExposure(topic) === 'public');
      return grantResolver.isGranted(boundId, topicGrantEntry(topic), authorDefault);
    },
    isCollectionReadGranted(collection) {
      const entry = `${COLLECTION_GRANT_PREFIX}${collection}`;
      // Slice 6 — author-default = admit-all (the raw-collection scope-fence re-homed to
      // explicit grant rows), modulo the owner-default-only tightening below. Raw webhook
      // payloads and accepted free-form responses tighten to owner-default-on /
      // door-default-off here, exactly as in the op gate.
      return grantResolver.isGranted(
        boundId,
        entry,
        explicitGrantRowsOnly
          ? false
          : ownerOnlyAdjustedAuthorDefault(entry, boundId, true),
      );
    },
    isVerbOpGranted(verbOpId) {
      // The verb-op term reuses the OP grant entry + the contract's op author-default
      // (passed in by the producer via `opAuthorDefault`) — IDENTICAL resolution to the
      // op-admission gate's `isOpGranted`, so a cross-topic read verb and the recipe-path
      // op gate share one authority. An explicit op revoke row wins (tightenable).
      // D-187 slice 3b — `ownerOnlyAdjustedAuthorDefault` tightens the OWNER-default-only
      // sensitive verb-ops (engagements / audit) to owner-on / every-door-off, mirroring
      // the op gate so the two seams can never disagree.
      const entry = opGrantEntry(verbOpId);
      return grantResolver.isGranted(
        boundId,
        entry,
        explicitGrantRowsOnly
          ? false
          : ownerOnlyAdjustedAuthorDefault(entry, boundId, verbOpAuthorDefault),
      );
    },
  };
};

/** Shared frozen author-default-only checker — no bound contract, no grant rows: every
 *  topic reads its registry `mcp_exposed` author default, every collection admits-all. The
 *  fail-safe a read site uses when its producer wired no checker (test stubs / an unbound
 *  owner / no-overlay path) — the uniform replacement for the retired "undefined visibility
 *  map ⇒ registry defaults". */
export const AUTHOR_DEFAULT_READ_GRANT_CHECKER: ReadGrantChecker = createReadGrantChecker(
  AUTHOR_DEFAULT_ONLY_RESOLVER,
  undefined,
);

/** A contract_id-keyed read-grant resolver for the recipe / chat read sites — the
 *  analog of the overlay's source-keyed {@link ContractOverlayResolver.resolveReadGrantChecker}
 *  for callers that hold a bare `origin_contract_id` (the recipe-channel kernel
 *  dispatchers + the chat `mcp_wire` reject) rather than a full `ExecutionSource`.
 *  Replaces the retired `GatedEnrichmentVisibilityResolver`. */
export interface GatedReadGrantResolver {
  /** A {@link ReadGrantChecker} bound to `contract_id` (liveness-gated here — an
   *  absent / inactive / `session`/`delegation` grant id resolves to a checker that
   *  honours no grant rows → author-default reads). Always returns a checker (no
   *  `undefined` path — the gated-out case is the author-default-only checker). */
  resolveForContract(contract_id: string | undefined): ReadGrantChecker;
  /** D-187 AMENDMENT 3b — the SOURCE-bearing entry point. Maps an OWNER-AI surface
   *  (`(chat | messenger, user_self)`) to the OWNER contract, a door (`contracted_user`
   *  / self-restricted `user_self`) to its bound contract, and a contract-free source
   *  (`(user, user_self)` HID + the system channels) to no governing contract (→
   *  author-default reads). Use this when the read site holds a full `ExecutionSource`
   *  (the chat tool handlers); {@link resolveForContract} is the bare-id sibling for the
   *  recipe-channel `origin_contract_id`. */
  resolveForSource(source: ExecutionSource): ReadGrantChecker;
}

/** Build a {@link GatedReadGrantResolver} over a {@link ContractStore}. Stateless —
 *  wraps a `ContractDefinitionStore` (for the standing-contract liveness gate) + the
 *  unified `ContractGrantEntryStore` (for the grant rows), both over the SAME store;
 *  safe to construct more than once. `now` defaults to `Date.now`. */
export const createGatedReadGrantResolver = (
  contractStore: ContractStore,
  now: () => number = () => Date.now(),
): GatedReadGrantResolver => {
  const definitionStore = createContractDefinitionStore(contractStore);
  const grantResolver = createGrantEntryResolver(createContractGrantEntryStore(contractStore));
  // The bound contract's VERB-OP author-default for the read gate's op term — the SAME
  // per-contract op posture {@link ./op-admission-gate.ts isOpGranted} uses (owner /
  // wildcard-door permissive, scoped-door fail-closed; undefined governing ⇒ admit). The
  // shared {@link verbOpAuthorDefaultForGoverningId} keeps the rule in one place.
  const verbOpAuthorDefaultForId = (gatedId: string | undefined): boolean =>
    verbOpAuthorDefaultForGoverningId(gatedId, definitionStore);
  const explicitGrantRowsOnlyForId = (gatedId: string | undefined): boolean =>
    gatedId !== undefined
    && usesExplicitOnlyGrantDefaults(gatedId, definitionStore);
  return {
    resolveForContract(contract_id) {
      // The recipe-channel `origin_contract_id` is a bound DOOR (the triggering door of
      // an MCP-triggered recipe) — never the owner sentinel (the owner's recipe reads
      // resolve via the source on `resolveForSource` / the overlay). So liveness-gate it
      // as a grant-governing bound contract (ordinary standing or D-196 customer
      // instance; an explicit `'user_self'` finds no def ⇒ dead ⇒ undefined — the
      // escalation fence), else author-default reads.
      const gatedId = gateGrantGoverningContractId(contract_id, definitionStore, now);
      return createReadGrantChecker(
        grantResolver,
        gatedId,
        verbOpAuthorDefaultForId(gatedId),
        explicitGrantRowsOnlyForId(gatedId),
      );
    },
    resolveForSource(source) {
      // Resolve the GOVERNING contract from the source (provenance-keyed): an OWNER-AI
      // surface → the owner contract (always live), a door / self-restricted source → its
      // bound contract (liveness-gated, never owner — the escalation fence), a
      // contract-free source → none. The owner's chat / messenger reads now honour the
      // owner's grants (revokes), permissive by default — no longer a user-permissive skip.
      const gatedId = resolveGrantGoverningContractId(source, definitionStore, now);
      return createReadGrantChecker(
        grantResolver,
        gatedId,
        verbOpAuthorDefaultForId(gatedId),
        explicitGrantRowsOnlyForId(gatedId),
      );
    },
  };
};
