/** D-192 S4c2 — the generic `delta_cursor` engagement reconciler boot wire.
 *
 *  Mirrors `wireCanonicalCrmReconciliation` (D-190 MS4) but for the ENGAGEMENT
 *  plane: for every bound `kind:'api'` connection whose vendor declares a
 *  `delta_cursor` engagement entity in the live merged registry (built-ins +
 *  installed packs) and has NO bespoke reconciler, it registers a
 *  `buildGenericEngagementReconciler` housekeeping task per entity. So a
 *  Dynamics 365 (or any pack-declared delta engagement CRM) connection reconciles
 *  its activities EXACTLY like the bespoke HubSpot / Salesforce engagement
 *  reconcilers — populating the `engagements` table + `engagement_edges`, feeding
 *  health / coverage / score — with no per-vendor code beyond the thin OData leaf.
 *
 *  Two filters keep this off the built-in vendors:
 *    - `bespokeScopes` snapshots the `(vendor, entity)` a bespoke reconciler
 *      already owns BEFORE any generic registration (so hb/sf are never
 *      double-driven, and our own generic registrations don't self-block).
 *    - `sync_kind === 'delta_cursor'` — HubSpot (`poll`) + Salesforce (`stream`)
 *      are excluded by construction; only a delta-token vendor rides this drain.
 *
 *  A vendor whose delta engagement entity has NO registered leaf (`resolveLeaf`
 *  returns undefined — the pack is declared but its OData leaf isn't wired yet, as
 *  in S4c2 before the S4c3 Dynamics leaf) is skipped: the declaration lights up the
 *  registry helpers (health/coverage) but reconciliation waits for the leaf.
 *
 *  Ordering: MUST run AFTER the bespoke vendor boots (`composeVendorSubstrate`) so
 *  `bespokeScopes` captures every hb/sf `(vendor, entity)`.
 *
 *  Spec: D-192 (S4c2); survey Wall-D + Wall-F. */

import {
  composeVendorEntityScope,
  type ConnectionVendorEntity,
} from '@recued/contracts';

import { resolveConnectionVendor, type ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { EngagementStore } from '../storage/engagement-store.js';
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
import {
  buildGenericEngagementReconciler,
  type GenericEngagementLeaf,
} from './generic-engagement-reconciler.js';

export interface WireGenericEngagementReconciliationInput {
  connectionStore: ConnectionStoreSqlite;
  /** Shared fresh-`ConnectionRecord` lookup the harness threads per cycle. */
  lookupConnection: ConnectionLookup;
  /** The engagement store every generic reconciler writes (ingest + tombstone). */
  engagementStore: EngagementStore;
  /** The LIVE merged vendor registry (built-ins + installed packs), resolved per
   *  scan so a runtime pack install is reflected. */
  resolveRegistry: () => ReadonlyArray<ConnectionVendorEntity>;
  /** Resolve the per-vendor thin leaf (OData fetch/parse/classify + projector +
   *  edge mapper) for a `delta_cursor` engagement entity. Returns undefined when
   *  the vendor has no registered leaf → the entity is skipped (declared but not
   *  yet reconcilable). S4c3 registers the Dynamics leaf. */
  resolveLeaf: (entity: ConnectionVendorEntity) => GenericEngagementLeaf | undefined;
  /** Wall-clock threaded into the reconcilers (tests pin it). */
  now?: () => number;
}

/** D-192 S4c2 — wire the generic engagement reconciliation glue. Idempotent:
 *  re-running (or a token-refresh upsert) only adds tasks that aren't already
 *  present. */
export const wireGenericEngagementReconciliation = (
  input: WireGenericEngagementReconciliationInput,
): void => {
  const { connectionStore, lookupConnection, engagementStore, resolveRegistry, resolveLeaf } = input;

  // Snapshot the `(vendor, entity)` scopes a BESPOKE reconciler already owns BEFORE
  // we register any generic one (so hb/sf aren't double-driven and our own generic
  // registrations don't later read as bespoke and block a second connection's task).
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
      if (entity.vendor !== vendor) continue;
      const facet = entity.engagement;
      if (facet === undefined || facet.sync_kind !== 'delta_cursor') continue; // not a delta engagement entity
      const scope = composeVendorEntityScope(vendor, entity.entity);
      if (bespokeScopes.has(scope)) continue; // a bespoke reconciler owns it
      let reconciler = genericReconcilers.get(scope);
      if (reconciler === undefined) {
        const leaf = resolveLeaf(entity);
        if (leaf === undefined) continue; // declared but no leaf wired yet — skip
        reconciler = buildGenericEngagementReconciler({
          entity,
          engagementStore,
          leaf,
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

  // Future enrollments — a newly-bound delta engagement connection gets its tasks.
  connectionStore.addOnUpsert((row) => {
    if (row.kind === 'api') registerForConnection(row.name);
  });

  // Deletions — deregister the generic tasks for the removed connection. The row is
  // already gone, so deregister blindly across every generic `(vendor, entity)` we
  // own (a no-op for ids that were never registered). The `housekeeping_state`
  // cursor row survives, so re-enrollment resumes the delta cursor.
  connectionStore.addOnDelete((kind, name) => {
    if (kind !== 'api') return;
    for (const reconciler of genericReconcilers.values()) {
      unregisterHousekeepingTask(reconciliationTaskId(reconciler.vendor, reconciler.entity, name));
    }
  });
};
