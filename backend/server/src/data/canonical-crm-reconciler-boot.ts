/** D-190 (generic reconciler MS4) — the generic CRM reconciler boot wire.
 *
 *  Mirrors the bespoke `wireHubSpotReconciliation` glue (boot-scan +
 *  `connectionStore` upsert/delete observers), but GENERICALLY: for every bound
 *  `kind:'api'` connection whose vendor declares a `crm_alias` entity in the live
 *  merged registry (built-ins + installed CRM packs) and has NO bespoke reconciler,
 *  it registers a `buildCanonicalCrmReconciler` housekeeping task per entity. So a
 *  Pipedrive (or any pack-declared CRM) connection mirrors EXACTLY like HubSpot /
 *  Salesforce — populating `crm_record_mirror` (MS2) and joining the local-mirror
 *  `deal.search` union (MS3) — with no per-vendor code.
 *
 *  Ordering: this MUST run AFTER the bespoke vendor boots (`composeVendorSubstrate`)
 *  so `bespokeScopes` captures every hb/sf `(vendor, entity)` and we never
 *  double-drive one (the bespoke reconcilers carry vendor-specific incremental
 *  filters + webhook acceleration the generic full-walk poll deliberately doesn't).
 *
 *  Spec: internal design notes (MS4). */

import {
  composeVendorEntityScope,
  type ConnectionVendorEntity,
  type EnrichmentScope,
} from '@recued/contracts';

import { resolveConnectionVendor, type ConnectionStoreSqlite } from '../storage/connection-store.js';
import {
  buildVendorReconciliationTask,
  reconciliationTaskId,
  type ConnectionLookup,
  type VendorReconciler,
} from '../housekeeping/reconciliation/vendor-reconciler.js';
import {
  listVendorReconcilers,
  registerVendorReconciler,
} from '../housekeeping/reconciliation/reconciler-registry.js';
import {
  getHousekeepingTask,
  registerHousekeepingTask,
  unregisterHousekeepingTask,
} from '../housekeeping/registry.js';
import type { CanonicalPollDeps } from '../watch/canonical-poll.js';
import { buildCanonicalCrmReconciler } from './canonical-crm-reconciler.js';

export interface WireCanonicalCrmReconciliationInput {
  connectionStore: ConnectionStoreSqlite;
  /** Shared fresh-`ConnectionRecord` lookup the harness threads per cycle (the
   *  same one the bespoke vendor boots use). */
  lookupConnection: ConnectionLookup;
  /** Canonical poll deps — `executorConfig` / `profiles` / `audit` /
   *  `contractScan` / the live vendor registry — injected into every generic
   *  reconciler so its `listUpdatedSince` runs the gated + audited canonical poll. */
  pollDeps: CanonicalPollDeps;
  /** The incremental seam — `mirror.listSnapshotHashes`. Lets each full-walk
   *  reconciler skip unchanged records (see `buildCanonicalCrmReconciler`). */
  getPriorHashes: (scope: EnrichmentScope) => Map<string, string>;
  /** The LIVE merged vendor registry (built-ins + installed CRM packs), resolved
   *  per scan so a runtime pack install is reflected. */
  resolveRegistry: () => ReadonlyArray<ConnectionVendorEntity>;
  /** Wall-clock threaded into the reconcilers (tests pin it). */
  now?: () => number;
}

/** D-190 MS4 — wire the generic CRM reconciliation glue. Idempotent: re-running
 *  (or a token-refresh upsert) only adds tasks that aren't already present. */
export const wireCanonicalCrmReconciliation = (
  input: WireCanonicalCrmReconciliationInput,
): void => {
  const { connectionStore, lookupConnection, pollDeps, getPriorHashes, resolveRegistry } = input;

  // Snapshot the `(vendor, entity)` scopes a BESPOKE reconciler already owns BEFORE
  // we register any generic one — so (a) hb/sf are never double-driven, and (b) our
  // OWN generic registrations below can't later read as "bespoke" and block a second
  // connection's task.
  const bespokeScopes = new Set<string>(
    listVendorReconcilers().map((r) => composeVendorEntityScope(r.vendor, r.entity)),
  );

  // One generic reconciler per `(vendor, entity)`, REUSED across every connection of
  // that vendor (the harness makes one TASK per connection over the shared reconciler).
  const genericReconcilers = new Map<string, VendorReconciler>();

  const registerForConnection = (connection_name: string): void => {
    const row = connectionStore.get('api', connection_name);
    if (row === null) return;
    const vendor = resolveConnectionVendor(row);
    if (vendor === undefined) return;
    for (const entity of resolveRegistry()) {
      if (entity.vendor !== vendor || entity.crm_alias === undefined) continue; // not this vendor / not CRM
      const scope = composeVendorEntityScope(vendor, entity.entity);
      if (bespokeScopes.has(scope)) continue; // a bespoke (hb/sf) reconciler owns it
      let reconciler = genericReconcilers.get(scope);
      if (reconciler === undefined) {
        reconciler = buildCanonicalCrmReconciler({
          vendor,
          entity: entity.entity,
          pollDeps,
          getPriorHashes,
          ...(input.now ? { now: input.now } : {}),
        });
        genericReconcilers.set(scope, reconciler);
        try {
          registerVendorReconciler(reconciler);
        } catch {
          // Already registered — fine on idempotent / multi-connection boots.
        }
      }
      const task_id = reconciliationTaskId(vendor, entity.entity, connection_name);
      if (getHousekeepingTask(task_id) === undefined) {
        registerHousekeepingTask(
          buildVendorReconciliationTask({ reconciler, connection_name, lookupConnection }),
        );
      }
    }
  };

  // Boot scan — every already-enrolled api connection.
  for (const row of connectionStore.list({ kind: 'api' })) registerForConnection(row.name);

  // Future enrollments — a newly-bound CRM connection gets its generic tasks. The
  // bespoke-vendor filter (`bespokeScopes` + the per-vendor `crm_alias` match) makes
  // this a no-op for hb/sf + non-CRM rows, so it coexists with the bespoke boots'
  // own `addOnUpsert` hooks on the same store.
  connectionStore.addOnUpsert((row) => {
    if (row.kind === 'api') registerForConnection(row.name);
  });

  // Deletions — deregister the generic tasks for the removed connection. The row is
  // already gone, so deregister blindly across every generic `(vendor, entity)` we
  // own (a no-op for ids that were never registered). The `housekeeping_state`
  // cursor row survives, so re-enrollment resumes the cycle.
  connectionStore.addOnDelete((kind, name) => {
    if (kind !== 'api') return;
    for (const reconciler of genericReconcilers.values()) {
      unregisterHousekeepingTask(reconciliationTaskId(reconciler.vendor, reconciler.entity, name));
    }
  });
};
