/** The `core.storage.file.fetch-remote` predicate — "may bytes be fetched from a
 *  connected vendor?" — extracted from the composition root so its semantics are
 *  reachable by a test.
 *
 *  ⛔⛔ IT LIVES HERE BECAUSE THIS IS THE KIND OF RULE THAT INVERTS SILENTLY. Three
 *  states collapse into one boolean (`true` / `false` / no row), plus a fourth for a
 *  server with no contract substrate yet, and every wrong mapping still compiles and
 *  still reads plausibly. Inline in a 1,500-line composition file it was untestable;
 *  the logic did not get safer by being short.
 *
 *  ⛔ ONLY THE REVOKE HALF, DELIBERATELY. `isOpGranted` is the rule everywhere else and
 *  is not callable here: neither remote-read caller carries an `ExecutionSource`
 *  (`handleFileRead(deps, args)`; the CLI executor's reader is a bare
 *  `(record_id) => bytes`), so there is no governing contract to resolve an author
 *  default against. What IS unambiguous without a source is an EXPLICIT OWNER REVOKE —
 *  so that, and nothing more, is what this implements.
 *
 *  ⚠ Consequently this answers the same for every dispatch: owner chat, a scoped MCP
 *  door, a cron fire. It is a SERVER capability switch, not a per-contract grant.
 *  Per-door granularity needs the source threaded through kernel-op dispatch and is a
 *  separate slice — not pretended at here. */

import { OWNER_CONTRACT_ID, opGrantEntry } from '@recued/contracts';

import { createContractGrantEntryStore } from './storage/contract-grant-entry-store.js';
import type { ContractStore } from './storage/contract-store.js';

/** The kernel op this predicate reads. Exported so the test and the gate name the
 *  SAME string — a hand-typed second copy is how a gate ends up reading an id nothing
 *  ever writes, which reads as permanently-granted. */
export const FILE_FETCH_REMOTE_OP = 'core.storage.file.fetch-remote';

/** Build the predicate. `getStore` is read at CALL time — the contract store is
 *  assigned deep in the composition root's `if (db)` block, long after this is built.
 *
 *  ADMITS on: no store yet (a server with no contract substrate), no row (the pre-seed
 *  window — `reconcileOwnerGrants` writes a row for every `KERNEL_OP_REGISTRY` op at
 *  boot), and an explicit grant. DENIES only on an explicit `false`.
 *
 *  ⚠ The no-row case is the one worth stating: treating it as DENY would dark-boot
 *  every remote read before the seed ran, and a capability that silently stops working
 *  is the harm this gate exists to make legible. */
export const createRemoteFetchAdmitter = (
  getStore: () => ContractStore | undefined,
): (() => boolean) => () => {
  const store = getStore();
  if (!store) return true;
  return createContractGrantEntryStore(store)
    .get(OWNER_CONTRACT_ID, opGrantEntry(FILE_FETCH_REMOTE_OP)) !== false;
};
