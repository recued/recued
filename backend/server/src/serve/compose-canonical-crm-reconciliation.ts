/** D-190 (generic reconciler MS4) — wire the generic CRM reconciliation glue.
 *
 *  Builds the `CanonicalPollDeps` from the composed `executeDeps` (the SAME
 *  ingredients the watch-manager's `connectionApiSource` assembles — executor /
 *  profiles / subresource-path / audit / contract-scan / live registry) and hands
 *  them, the connection store, the shared connection lookup, and the mirror-backed
 *  incremental seam to `wireCanonicalCrmReconciliation`.
 *
 *  MUST run AFTER the bespoke vendor boots (so the generic wire skips hb/sf) and
 *  BEFORE the watch-manager recompute (so the manager defers to the generic
 *  reconcilers' housekeeping tasks rather than arming a spurious poll loop). The
 *  caller (`start-post-listener-runtime`) places it exactly there. A db-less /
 *  keyless boot (no `executeDeps` / connection store / mirror / vendor lookup)
 *  collapses to a no-op. */

import type { ExecuteHandlerDeps } from '../execute-handler.js';
import { liveVendorRegistry } from '../recipe-runnability-handler.js';
import { buildCanonicalPollDeps } from '../watch/canonical-poll-deps.js';
import { wireCanonicalCrmReconciliation } from '../data/canonical-crm-reconciler-boot.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { CrmRecordMirrorStore } from '../storage/crm-record-mirror-store.js';
import type { ConnectionLookup } from '../housekeeping/reconciliation/vendor-reconciler.js';

export interface ComposeCanonicalCrmReconciliationInput {
  /** Late-bound — `executeDeps` is composed by listener-compose time (the watch
   *  manager already uses it), so this returns a value by the post-listener stage. */
  getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  connectionStore: ConnectionStoreSqlite | undefined;
  crmRecordMirror: CrmRecordMirrorStore | undefined;
  /** The shared vendor connection lookup published by `composeVendorSubstrate`. */
  lookupConnection: ConnectionLookup | undefined;
}

export const composeCanonicalCrmReconciliation = (
  input: ComposeCanonicalCrmReconciliationInput,
): void => {
  const executeDeps = input.getExecuteDeps();
  const { connectionStore, crmRecordMirror, lookupConnection } = input;
  if (
    executeDeps === undefined
    || connectionStore === undefined
    || crmRecordMirror === undefined
    || lookupConnection === undefined
  ) {
    return; // substrate not wired (db-less / keyless / no vendor substrate)
  }

  // The live merged registry (built-ins + installed CRM packs), resolved per call
  // so a runtime pack install is reflected. Used by the boot's crm_alias entity
  // enumeration (the poll deps build their own equivalent internally).
  const resolveRegistry = () => liveVendorRegistry(executeDeps.localManifestStore);

  // Same `CanonicalPollDeps` the chat S3 live-escalation leg builds (shared builder).
  const pollDeps = buildCanonicalPollDeps(executeDeps, connectionStore);

  wireCanonicalCrmReconciliation({
    connectionStore,
    lookupConnection,
    pollDeps,
    getPriorHashes: (scope) => crmRecordMirror.listSnapshotHashes(scope),
    resolveRegistry,
  });
};
