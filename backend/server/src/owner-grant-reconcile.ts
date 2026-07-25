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
  READABLE_COLLECTIONS,
  topicGrantEntry,
  type EnrichmentTopic,
} from '@recued/contracts';

import type { ContractStore } from './storage/contract-store.js';
import { createContractGrantEntryStore } from './storage/contract-grant-entry-store.js';

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
 *  collections ({@link READABLE_COLLECTIONS}), and the enrichment topics
 *  ({@link ENRICHMENT_REGISTRY}) — preserving any explicit row already present (grant or
 *  revoke). Idempotent; atomic (one `contractStore.transaction`). `now` defaults to
 *  `Date.now` (stamps the `set_at` of newly-seeded rows). */
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
  });
  return { seeded, preserved };
};
