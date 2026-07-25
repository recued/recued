/** D-129 Phase 2 — HubSpot vendor boot wire.
 *
 *  Two surfaces:
 *
 *    - `wireHubSpotReconciliation(...)` — the housekeeping-registry
 *      glue (boot-scan + connection-store observers for upsert /
 *      delete). Internal to this module but exported for completeness;
 *      `bootHubSpot` calls it after constructing reconcilers.
 *
 *    - `bootHubSpot(deps)` — the registry-iterator entry point.
 *      Constructs every HubSpot-specific piece (deal / contact /
 *      company reconcilers + per-entity webhook processors + the
 *      contact upstream-merge client + the five engagement reconcilers),
 *      folds them all into one reconciler array, then wires the
 *      reconciliation glue. Returns the standard `VendorBootBundle`;
 *      HubSpot has no late-bound refs to surface.
 *
 *  Glue mechanics:
 *
 *    1. At boot, scan every existing `kind: 'api'` connection with
 *       `config.vendor === 'hubspot'` and register the per-(reconciler,
 *       connection) tasks. Picks up reconciliation after process
 *       restart without losing cursor state.
 *    2. On `connection.upsert` for a HubSpot row, register tasks that
 *       weren't already present. Idempotent — token refreshes hit the
 *       same path but the registry de-dupes via `task_id`.
 *    3. On `connection.delete` for a HubSpot row, deregister the
 *       per-task entries. The `housekeeping_state` cursor row survives
 *       so re-enrollment under the same name resumes the cycle.
 *
 *  Spec: `docs/d-129-spec.md` § A.5. */

import {
  reconciliationTaskId,
  type ConnectionLookup,
  type VendorReconciler,
} from '../../housekeeping/reconciliation/vendor-reconciler.js';
import { buildVendorReconciliationTask } from '../../housekeeping/reconciliation/vendor-reconciler.js';
import {
  getHousekeepingTask,
  registerHousekeepingTask,
  unregisterHousekeepingTask,
} from '../../housekeeping/registry.js';
import { registerVendorReconciler } from '../../housekeeping/reconciliation/reconciler-registry.js';

import {
  HUBSPOT_DEAL_PROPERTIES,
  HUBSPOT_CONTACT_PROPERTIES,
  HUBSPOT_COMPANY_PROPERTIES,
  type ConnectionRow,
} from '@recued/contracts';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import type { EngagementStore } from '../../storage/engagement-store.js';
import type {
  VendorBootBundle,
  VendorBootDeps,
} from '../vendor-boot-registry.js';
import { buildHubSpotReconcilers } from './registration.js';
import { buildHubSpotWebhookProcessor } from './webhook-processor.js';
import { buildHubSpotEngagementReconcilers } from './engagement-registration.js';
import { createHubSpotContactMergeClient } from './contact-merge-client.js';

/** Vendor segment match — limits the boot wire to HubSpot connections.
 *  D-130 (Salesforce) lands an analogous boot helper for `'salesforce'`. */
const HUBSPOT_VENDOR = 'hubspot';

/** Detect HubSpot api connections by inspecting the row's `config_json`.
 *  Non-api kinds + non-HubSpot api connections short-circuit. */
const isHubSpotApiConnection = (row: ConnectionRow): boolean => {
  if (row.kind !== 'api') return false;
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.config_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    return false;
  }
  return config.vendor === HUBSPOT_VENDOR;
};

/** D-129 P2 — task-registration glue. Builds + registers one
 *  `buildVendorReconciliationTask` per (reconciler, connection_name)
 *  pair, idempotent on `task_id`. */
const registerTasksForConnection = (
  reconcilers: ReadonlyArray<VendorReconciler>,
  connection_name: string,
  lookupConnection: ConnectionLookup,
): void => {
  for (const reconciler of reconcilers) {
    const task_id = reconciliationTaskId(
      reconciler.vendor,
      reconciler.entity,
      connection_name,
    );
    if (getHousekeepingTask(task_id) !== undefined) continue;
    registerHousekeepingTask(
      buildVendorReconciliationTask({
        reconciler,
        connection_name,
        lookupConnection,
      }),
    );
  }
};

/** D-129 P2 — deregister every task bound to the deleted connection.
 *  No-op when the connection wasn't HubSpot or no tasks were
 *  registered. The cursor row in `housekeeping_state` survives — the
 *  registry only drops the in-memory task instance. */
const unregisterTasksForConnection = (
  reconcilers: ReadonlyArray<VendorReconciler>,
  connection_name: string,
): void => {
  for (const reconciler of reconcilers) {
    const task_id = reconciliationTaskId(
      reconciler.vendor,
      reconciler.entity,
      connection_name,
    );
    unregisterHousekeepingTask(task_id);
  }
};

/** Boot input. The bin wire passes the connection store + the
 *  pre-built reconciler array (today: `[HubSpotDealReconciler]`; P3 +
 *  P4 stack contact + company). The lookup callback is what the
 *  harness threads through `step()` to fetch fresh `ConnectionRecord`s
 *  per cycle (auth refresh / config edits surface immediately). */
export interface WireHubSpotReconciliationInput {
  connectionStore: ConnectionStoreSqlite;
  reconcilers: ReadonlyArray<VendorReconciler>;
  lookupConnection: ConnectionLookup;
  /** D-139 P1a.1.2 — optional engagement-store handle. When supplied,
   *  the connection-delete observer additionally tombstones every
   *  engagement row + edge scoped to the deleted connection per
   *  § A.10. Omitting it keeps the boot wire backwards-compatible
   *  with deployments that don't yet wire D-139 storage; the cascade
   *  is engagement-aware only when the substrate exists. The cascade
   *  is `connection_id`-scoped — a second connection of the same
   *  vendor is unaffected (per the connection-isolated invariant). */
  engagementStore?: EngagementStore;
}

/** D-129 P2 — wire the HubSpot reconciliation glue.
 *
 *  Idempotent: each reconciler registers into the default
 *  `ReconcilerRegistry` exactly once; the boot scan + upsert hook only
 *  add tasks that aren't already present; the delete hook removes
 *  exactly the tasks for the named connection.
 *
 *  Returns nothing. The boot wire holds a strong reference to the
 *  store anyway via its other rpc deps; the observer handlers live
 *  on the store instance for the process lifetime. */
export const wireHubSpotReconciliation = (
  input: WireHubSpotReconciliationInput,
): void => {
  // Register every reconciler in the default registry (per-process,
  // module-level state). De-dupes against earlier registrations so
  // wiring the bin twice in a test harness doesn't throw.
  for (const reconciler of input.reconcilers) {
    if (reconciler.vendor !== HUBSPOT_VENDOR) continue;
    try {
      registerVendorReconciler(reconciler);
    } catch {
      // Already registered — fine on idempotent boot scenarios.
    }
  }

  // Register tasks for every existing HubSpot connection.
  for (const row of input.connectionStore.list({ kind: 'api' })) {
    if (!isHubSpotApiConnection(row)) continue;
    registerTasksForConnection(
      input.reconcilers,
      row.name,
      input.lookupConnection,
    );
  }

  // Hook future enrollments + deletions. D-130 P2 widened the store's
  // observer hooks to additive registration (`addOnUpsert` /
  // `addOnDelete` returning unsubscribe), so this wire coexists with
  // D-130's Salesforce wire on the same store. The HubSpot-vendor
  // filter in `isHubSpotApiConnection` makes us a no-op for any other
  // vendor's row.
  input.connectionStore.addOnUpsert((row) => {
    if (!isHubSpotApiConnection(row)) return;
    registerTasksForConnection(
      input.reconcilers,
      row.name,
      input.lookupConnection,
    );
  });

  input.connectionStore.addOnDelete((kind, name) => {
    if (kind !== 'api') return;
    // We don't have the row anymore — deregister blindly per
    // (reconciler, name). Deregistration of a never-registered id is
    // a no-op so non-HubSpot api deletions are cheap.
    unregisterTasksForConnection(input.reconcilers, name);
    // D-139 P1a.1.2 — connection-delete cascade for engagement rows
    // + edges per § A.10. We don't have the row anymore so the
    // vendor-filter is implicit: the engagement-store cascade is
    // keyed on `connection_id`, and engagements only land under
    // HubSpot/Salesforce-named connections. Deletion of a connection
    // that never owned engagements is a no-op (zero rows
    // tombstoned). Same connection-isolated guarantee as the
    // task-deregister path above: a second connection of the same
    // vendor is unaffected.
    if (input.engagementStore !== undefined) {
      const now = Date.now();
      input.engagementStore.tombstoneEdgesForConnection(name, now);
      input.engagementStore.tombstoneEngagementRowsForConnection(name, now);
    }
  });
};

/** Registry entry — composes every HubSpot piece in dependency order
 *  + wires the reconciliation glue. Called once by
 *  `composeVendorSubstrate(...)` per the `VENDOR_BOOT_REGISTRY` array.
 *
 *  Construction sequence (each step gated on the deps it actually
 *  needs):
 *
 *    1. Deal / contact / company reconcilers — each carries an inline
 *       webhook processor closed over the shared `refreshAuth` +
 *       `lookupConnection`.
 *    2. Engagement reconcilers (email / meeting / note / call / task)
 *       — only when `engagementStore` is wired (D-184). Folded into the
 *       same reconciler array as the CRM trio.
 *    3. `wireHubSpotReconciliation(...)` — boot scan + observer
 *       hooks. Registers every reconciler (CRM trio + engagement) into
 *       the default vendor registry + walks existing HubSpot connections
 *       to install housekeeping tasks.
 *    4. Contact upstream-merge client — only when
 *       `upstreamMergeRegistry` is wired.
 *
 *  HubSpot has no late-bound refs to surface — the bundle is empty. */
export const bootHubSpot = async (
  deps: VendorBootDeps,
): Promise<VendorBootBundle> => {
  // D-129 P2 + P5 — reconcilers + per-entity webhook processors. The
  // webhook processors share the same auth deps as the reconcilers;
  // each looks up the connection via the shared `lookupConnection`
  // for the per-event follow-up GET on `*.creation` / `*.propertyChange`.
  const hubspotWebhookSearchDeps = { refreshAuth: deps.refreshAuth };
  const hubspotReconcilers = buildHubSpotReconcilers({
    deal: {
      search: { refreshAuth: deps.refreshAuth },
      webhookProcessor: buildHubSpotWebhookProcessor({
        entity: 'deal',
        search: hubspotWebhookSearchDeps,
        lookupConnection: deps.lookupConnection,
        properties: HUBSPOT_DEAL_PROPERTIES,
      }),
    },
    contact: {
      search: { refreshAuth: deps.refreshAuth },
      webhookProcessor: buildHubSpotWebhookProcessor({
        entity: 'contact',
        search: hubspotWebhookSearchDeps,
        lookupConnection: deps.lookupConnection,
        properties: HUBSPOT_CONTACT_PROPERTIES,
      }),
    },
    company: {
      search: { refreshAuth: deps.refreshAuth },
      webhookProcessor: buildHubSpotWebhookProcessor({
        entity: 'company',
        search: hubspotWebhookSearchDeps,
        lookupConnection: deps.lookupConnection,
        properties: HUBSPOT_COMPANY_PROPERTIES,
      }),
    },
  });

  // D-184 — engagement reconcilers (email / meeting / note / call / task)
  // join the SAME reconciler array as the CRM trio so they inherit the
  // connection-enroll → HousekeepingTaskInstance activation + boot-scan +
  // delete-deregister and the shared per-(connection, vendor) rate gate,
  // exactly like deal/contact/company. Each carries a `selfIngest` hook
  // (its richer engagements-table + edges + dedupe write) so the harness
  // calls it INSTEAD of the default plain-enrichment write; they declare
  // no `webhookProcessor`, so the webhook funnel skips them (engagement
  // stays pull-only, as it was on the retired runonce path). Built BEFORE
  // the wire so the boot-scan registration pass installs their tasks for
  // every already-enrolled connection. Gated on `engagementStore` —
  // absent → engagement reconcile is simply not wired (same as before).
  const hubspotEngagementReconcilers: VendorReconciler[] = [];
  if (deps.engagementStore) {
    const engagementStore = deps.engagementStore;
    const substrate = buildHubSpotEngagementReconcilers({
      email: { search: { refreshAuth: deps.refreshAuth }, engagementStore },
      meeting: { search: { refreshAuth: deps.refreshAuth }, engagementStore },
      note: { search: { refreshAuth: deps.refreshAuth }, engagementStore },
      call: { search: { refreshAuth: deps.refreshAuth }, engagementStore },
      task: { search: { refreshAuth: deps.refreshAuth }, engagementStore },
    });
    hubspotEngagementReconcilers.push(
      substrate.email,
      substrate.meeting,
      substrate.note,
      substrate.call,
      substrate.task,
    );
  }

  wireHubSpotReconciliation({
    connectionStore: deps.connectionStore,
    reconcilers: [...hubspotReconcilers, ...hubspotEngagementReconcilers],
    lookupConnection: deps.lookupConnection,
    ...(deps.engagementStore ? { engagementStore: deps.engagementStore } : {}),
  });

  // D-138 P5 — register the HubSpot upstream-merge client onto the
  // shared registry. The driver looks up by `object_type`;
  // `hubspot:contact` is the only HubSpot variant in v1.
  if (deps.upstreamMergeRegistry) {
    deps.upstreamMergeRegistry.set(
      'hubspot:contact',
      createHubSpotContactMergeClient({ refreshAuth: deps.refreshAuth }),
    );
  }

  // D-184 — HubSpot engagement reconcilers were wired into the shared
  // reconciler array above (alongside the CRM trio), so they ride the
  // housekeeping cycle + connection-enroll activation directly. The
  // retired `reconciler-runonce` stopgap (recipe escape hatch) is gone;
  // there is no separate engagement registration here anymore.
  return {};
};
