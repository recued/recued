/** D-259 — `packs.unrunnable` rpc: installed packs this server's CURRENT
 *  validator would refuse to run.
 *
 *  🔑 WHY THIS EXISTS RATHER THAN A DURABLE NOTIFICATION. The boot check finds
 *  these packs and fires a best-effort `notify`, which is fire-and-forget: on
 *  an unattended server with nobody connected, the message is simply gone. The
 *  first cut solved that by raising a durable ASK instead — which put an error
 *  report into the owner's queue of pending DECISIONS, needed a restart-dedup
 *  so it did not mint a row every boot, needed a no-op answer handler so a
 *  dismissal could complete, and CLEARED THE FINDING when answered even though
 *  the packs were still broken.
 *
 *  The mistake was buying durability at the message layer. "These packs will
 *  not run" is not an event to persist; it is a STANDING CONDITION, and it is
 *  cheap to re-derive — `findUnrunnableInstalledManifests` is a pure
 *  re-validation of the installed manifests. Re-deriving per call means it can
 *  never go stale, can never accumulate, and can never be dismissed while it
 *  is still true. The notification goes back to being just the heads-up.
 *
 *  ⚠ Read-only and per-pair, behind the same `packs.` reserved prefix as the
 *  rest of the surface, so an MCP-channel agent cannot enumerate it. */

import type {
  HandlerSlice,
  PacksUnrunnableResult,
  ServerRpcRegistry,
} from '@recued/contracts';

import { findUnrunnableInstalledManifests } from './ingredient-authoring/installed-manifest-boot-check.js';
import { projectUnrunnableFindingsToPacks } from './unrunnable-pack-notice.js';
import type { ContractStore } from './storage/contract-store.js';
import type { WsClient } from './ws-server.js';

export interface PackUnrunnableRpcDeps {
  /** The installed local manifests to re-validate. Same source the boot check
   *  reads, so the rpc and the boot notification can never disagree. */
  listManifests: () => ReadonlyArray<Parameters<typeof findUnrunnableInstalledManifests>[0][number]>;
  /** Resolves catalog ids to owner-facing pack slugs. Absent (dbless harness)
   *  ⇒ findings are still reported, with `exact_pack_identities: false`. */
  getContractStore?: () => ContractStore | undefined;
}

export const handlePacksUnrunnable = (
  deps: PackUnrunnableRpcDeps,
): PacksUnrunnableResult => {
  const found = findUnrunnableInstalledManifests(deps.listManifests());
  // ⚠ Short-circuit the healthy case rather than letting the projection answer
  // it. With no findings there is no identity to prove, so `false` — which the
  // projection returns whenever it has no store — would read as "I could not
  // resolve these packs" about an EMPTY set, and a caller that warns on
  // unproven identity would warn about nothing.
  if (found.length === 0) return { findings: [], exact_pack_identities: true };
  const projected = projectUnrunnableFindingsToPacks(
    found,
    deps.getContractStore?.(),
  );
  return {
    findings: projected.findings.map((row) => ({
      slug: row.slug,
      ...(row.version !== undefined ? { version: row.version } : {}),
      codes: [...row.codes],
      detail: row.detail,
    })),
    exact_pack_identities: projected.exact_pack_identities,
  };
};

type PacksUnrunnableMethods = 'packs.unrunnable';

export const makePackUnrunnableHandlers = (
  deps: PackUnrunnableRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, PacksUnrunnableMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['packs.unrunnable'],
    handlers: {
      'packs.unrunnable': async () => handlePacksUnrunnable(deps),
    },
  };
};
