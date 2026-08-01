/** Grant-foundation slice 3b (D-187 AMENDMENT `693b7d03`) — the OWNER-contract boot
 *  reconcile.
 *
 *  The owner is "one fully-granted contract" (D-187): seeded permissive + tightenable.
 *  Completeness is BOOT-MATERIALIZED, not resolved per-request (owner, 2026-06-22): new
 *  ops / collections / topics arrive ONLY via a server source-code update (the registry
 *  is compiled in — deterministic, never a runtime event), so at boot we ensure the
 *  owner contract holds a `granted:true` row for every registered id, **PRESERVING
 *  explicit `granted:false` revokes**. After it, the owner's grant rows mirror the UI
 *  1:1 (DB = UI) and the gate is a pure point lookup; the owner-permissive author-default
 *  (`true`, in {@link ./read-grant-checker.ts} + {@link ./op-admission-gate.ts}) keeps the
 *  owner open for any id NOT enumerated here (canonical-convention `core.crm.*` /
 *  `core.acct.*` ops, pack ops that arrive at install) and pre-reconcile.
 *
 *  Idempotent: a re-run finds every row present → seeds nothing. The reconcile only ever
 *  ADDS a `granted:true` row where NONE exists; it never overwrites — so an owner's
 *  explicit revoke (`granted:false`) survives every boot (the bug the bare "presence =
 *  granted" model had: re-seeding would re-grant a revoked op). `effective(id) = explicit
 *  row ?? author-default`; once reconciled the owner's `??` branch is never reached.
 *
 *  Runs at boot right after the contract-schema seed (`seedSchema`)
 *  on every surface (serve + MCP), inside one transaction so the writes land
 *  all-or-nothing. Local-only by construction — the contract store never syncs cloud
 *  (D-090/D-097/D-168).
 *
 *  Spec: D-187 AMENDMENT block §4 (Build-design refinements); handover
 *  `handover_grant_slice3_session1_3b_admission_actor.md` (step 6). */

import {
  collectionGrantEntry,
  ENRICHMENT_REGISTRY,
  KERNEL_OP_REGISTRY,
  opGrantEntry,
  OWNER_CONTRACT_ID,
  primitiveGrantEntry,
  READABLE_COLLECTIONS,
  TIER1_TOOL_NAMES,
  topicGrantEntry,
  type EnrichmentTopic,
} from '@recued/contracts';

import type { ContractStore } from './storage/contract-store.js';
import { createContractDefinitionStore } from './storage/contract-definition-store.js';
import { createContractGrantEntryStore } from './storage/contract-grant-entry-store.js';

/** Outcome of {@link grandfatherPrimitiveGrants}. */
export interface PrimitiveGrandfatherResult {
  /** Contracts that received at least one newly-seeded `primitive.*` row. */
  readonly contracts: number;
  /** Rows written across them. */
  readonly seeded: number;
}

/** ⛔⛔ D-228 slice 5 — THE ONE-TIME GRANDFATHER, and the reason wiring the gate
 *  does not break anyone.
 *
 *  Until the gate landed, EVERY mcp_wire caller reached the Tier-1 primitives
 *  subject only to its per-token checklist — no contract said anything about
 *  them, because there was no `primitive.*` id to say it with. Gating them now
 *  resolves each through `opAuthorDefault`, which is FAIL-CLOSED for a scoped
 *  door and for a D-196 customer instance. Those contracts hold no `primitive.*`
 *  row (none could exist before this slice), so the gate would silently strip
 *  `mail.search` / `recipe.run` from every one of them on upgrade.
 *
 *  🔑 So each EXISTING contract is grandfathered to exactly what it can do today:
 *  one `granted:true` row per primitive, written once. After this, absence of a
 *  row means something real — the owner removed it — which is the precondition a
 *  fail-closed gate needs to be honest.
 *
 *  ⚠ NOT a mint-time default, deliberately. A contract minted AFTER this runs
 *  gets what its minter chose in the grant UI (where primitives are now visible),
 *  and a scoped door that lists none legitimately has none. Grandfathering is for
 *  contracts minted when the choice could not be expressed; it is not a policy
 *  that new doors inherit.
 *
 *  Idempotent + revoke-preserving by the same three-state read the owner
 *  reconcile uses: a stored `false` is an owner tightening and is never
 *  overwritten. The OWNER contract is skipped — `reconcileOwnerGrants` owns it. */
export const grandfatherPrimitiveGrants = (
  contractStore: ContractStore,
  now: () => number = () => Date.now(),
): PrimitiveGrandfatherResult => {
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  // Read-only use (`list`), so the id/clock opts never come into play — same
  // one-arg call shape as `reconcileOwnerGrants` for both boot sites.
  const definitionStore = createContractDefinitionStore(contractStore);
  const ts = now();
  let contracts = 0;
  let seeded = 0;
  contractStore.transaction(() => {
    for (const def of definitionStore.list()) {
      if (def.contract_id === OWNER_CONTRACT_ID) continue;
      let wrote = false;
      for (const name of TIER1_TOOL_NAMES) {
        const entry = primitiveGrantEntry(name);
        if (grantEntryStore.get(def.contract_id, entry) !== undefined) continue;
        grantEntryStore.set(def.contract_id, entry, true, ts);
        seeded += 1;
        wrote = true;
      }
      if (wrote) contracts += 1;
    }
  });
  return { contracts, seeded };
};

/** Outcome of {@link reconcileOwnerGrants} — for boot-log observability + tests. */
export interface OwnerGrantReconcileResult {
  /** Rows newly written (`granted:true`) this run — registered ids the owner had no
   *  row for yet (a fresh install seeds all; a steady-state boot seeds 0). */
  readonly seeded: number;
  /** Existing owner rows left UNTOUCHED — prior grants AND explicit revokes. The revoke
   *  count proving the reconcile preserves the owner's tightenings. */
  readonly preserved: number;
}

/** Ensure the owner contract holds a `granted:true` grant row for every COMPILED-IN
 *  registered id — the kernel ops ({@link KERNEL_OP_REGISTRY}), the readable warehouse
 *  collections ({@link READABLE_COLLECTIONS}), the enrichment topics
 *  ({@link ENRICHMENT_REGISTRY}), and (D-228 slice 5) the Tier-1 chat primitives
 *  ({@link TIER1_TOOL_NAMES}) — preserving any explicit row already present (grant or
 *  revoke). Idempotent; atomic (one `contractStore.transaction`). `now` defaults to
 *  `Date.now` (stamps the `set_at` of newly-seeded rows).
 *
 *  ⚠ All four sets share the one property this reconcile rests on: they are COMPILED
 *  IN, so the id space changes only on a server update and never as a runtime event.
 *  Anything arriving at runtime (pack ops at install, canonical-convention
 *  `core.crm.*`) is deliberately NOT seeded and rides the owner-permissive author
 *  default instead. */
export const reconcileOwnerGrants = (
  contractStore: ContractStore,
  now: () => number = () => Date.now(),
): OwnerGrantReconcileResult => {
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  const ts = now();
  let seeded = 0;
  let preserved = 0;
  contractStore.transaction(() => {
    const ensure = (entryKey: string): void => {
      // Three-state read: undefined = no row → seed; true/false = an explicit row
      // (grant or REVOKE) → preserve untouched (an owner revoke must survive the boot).
      if (grantEntryStore.get(OWNER_CONTRACT_ID, entryKey) === undefined) {
        grantEntryStore.set(OWNER_CONTRACT_ID, entryKey, true, ts);
        seeded += 1;
      } else {
        preserved += 1;
      }
    };
    for (const e of KERNEL_OP_REGISTRY) ensure(opGrantEntry(e.op));
    for (const c of READABLE_COLLECTIONS) ensure(collectionGrantEntry(c));
    for (const t of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
      ensure(topicGrantEntry(t));
    }
    // ⛔⛔ D-228 slice 5 — the Tier-1 chat primitives (`primitive.<tool>`). These
    // are the ALWAYS-ON tools — `mail.search`, `contact.search`, `recipe.run` —
    // and seeding them here is what makes them GOVERNABLE at all: until now the
    // owner had no row for them, so they could not be revoked from the contracts
    // UI (which mirrors these rows 1:1), and no gate could read a decision that
    // was never recorded.
    //
    // ⚠ SEEDING ONLY — nothing consults these yet, deliberately. Wiring the
    // dispatch gate is a separate step, because these are the tools a chat turn
    // cannot function without: a default-deny bug dark-boots the assistant. This
    // ordering is the whole point — the rows must exist BEFORE anything reads
    // them, or the first read of an unseeded id takes the author default, which
    // fails CLOSED for scoped doors and D-196 customer instances.
    //
    // 🔑 `TIER1_TOOL_NAMES` is the compiled-in registry, matching the three
    // above: the set changes only via a server source update, never at runtime,
    // which is the property this whole reconcile rests on. `primitiveGrantEntry`
    // namespaces them (a BARE `enrichment.search` collides with the reserved
    // topic prefix and `opGrantEntry` throws on it).
    for (const t of TIER1_TOOL_NAMES) ensure(primitiveGrantEntry(t));
  });
  return { seeded, preserved };
};
