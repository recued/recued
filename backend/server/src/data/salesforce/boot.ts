/** D-130 Phase 2 — Salesforce vendor boot wire.
 *
 *  Two surfaces:
 *
 *    - `wireSalesforceReconciliation(...)` — the housekeeping-registry
 *      glue (boot-scan + connection-store observers for upsert /
 *      delete). Internal to this module; `bootSalesforce` calls it
 *      after constructing reconcilers.
 *
 *    - `bootSalesforce(deps)` — the registry-iterator entry point.
 *      Constructs every Salesforce-specific piece (Sales Cloud trio
 *      reconcilers, CometD subscription lifecycle, webhook funnel,
 *      lead / account merge clients, contact merge degraded-path,
 *      engagement reconcilers folded into the shared reconciler array,
 *      and the `registerSalesforceCallEntity` hook published on the
 *      bundle for the engagement-health reprobe rpc to swap the
 *      dual-schema call entity's housekeeping task per connection).
 *
 *  Glue mechanics mirror D-129 HubSpot:
 *
 *    1. At boot, scan every existing `kind: 'api'` connection with
 *       `config.vendor === 'salesforce'` and register the per-
 *       (reconciler, connection) tasks. Picks up reconciliation after
 *       process restart without losing cursor state.
 *    2. On `connection.upsert` for a Salesforce row, register tasks
 *       that weren't already present. Idempotent — token refreshes
 *       hit the same path but the registry de-dupes via `task_id`.
 *    3. On `connection.delete` for a Salesforce row, deregister the
 *       per-task entries. The `housekeeping_state` cursor row
 *       survives so re-enrollment under the same name resumes the
 *       cycle.
 *
 *  D-130 P2 widened the store's observer hooks to additive
 *  registration (`addOnUpsert` / `addOnDelete`), so this wire coexists
 *  cleanly with D-129's HubSpot wire on the same store; each handler
 *  filters by vendor and ignores non-matching rows.
 *
 *  Spec: `docs/d-130-spec.md` § A.5. */

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

import type { ConnectionRow, ConnectionRecord } from '@recued/contracts';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import type {
  VendorBootBundle,
  VendorBootDeps,
} from '../vendor-boot-registry.js';
import { buildSalesforceReconcilers, buildSalesforceEngagementReconcilers } from './registration.js';
import { createInMemoryReplayIdTracker } from './webhook-processor.js';
import { wireSalesforceCometDLifecycle } from './cometd-lifecycle.js';
import { createWebhookFunnel } from '../../housekeeping/reconciliation/webhook-funnel.js';
import { getDefaultReconcilerRegistry } from '../../housekeeping/reconciliation/reconciler-registry.js';
import {
  getDefaultWatchSourceRegistry,
  webhookSourceKey,
} from '../../watch/source-registry.js';
import { createSalesforceMergeClient } from './merge-client.js';
import { SALESFORCE_CONTACT_DEGRADED } from '../vendor-merge.js';
import { SalesforceCallEngagementReconciler } from './call-engagement-reconciler.js';

/** Vendor segment match — limits the boot wire to Salesforce
 *  connections. */
const SALESFORCE_VENDOR = 'salesforce';

/** Detect Salesforce api connections by inspecting the row's
 *  `config_json`. Non-api kinds + non-Salesforce api connections
 *  short-circuit. */
const isSalesforceApiConnection = (row: ConnectionRow): boolean => {
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
  return config.vendor === SALESFORCE_VENDOR;
};

/** D-130 P2 — task-registration glue. Builds + registers one
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

/** D-130 P2 — deregister every task bound to the deleted connection.
 *  No-op when the connection wasn't Salesforce or no tasks were
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
 *  pre-built reconciler array (Sales Cloud trio: opportunity + contact
 *  + account at P4). The lookup callback is what the harness threads
 *  through `step()` to fetch fresh `ConnectionRecord`s per cycle (auth
 *  refresh / config edits surface immediately). The optional replayId
 *  tracker (P5) is forgotten on connection delete so re-enrollment
 *  starts with a clean slate — recreated PushTopics on Salesforce's
 *  side may emit lower replayIds than the previous incarnation. */
export interface WireSalesforceReconciliationInput {
  connectionStore: ConnectionStoreSqlite;
  reconcilers: ReadonlyArray<VendorReconciler>;
  lookupConnection: ConnectionLookup;
  /** D-130 P5 — optional replayId tracker. The boot wire calls
   *  `forgetConnection(name)` on delete so the next re-enrollment
   *  doesn't reject events from a freshly-recreated PushTopic.
   *  Tests omit when they don't exercise reconnect semantics. */
  replayIdTracker?: import('./webhook-processor.js').SalesforceReplayIdTracker;
}

/** D-130 P2 — wire the Salesforce reconciliation glue.
 *
 *  Idempotent: each reconciler registers into the default
 *  `ReconcilerRegistry` exactly once; the boot scan + upsert hook only
 *  add tasks that aren't already present; the delete hook removes
 *  exactly the tasks for the named connection.
 *
 *  Returns nothing. The boot wire holds a strong reference to the
 *  store anyway via its other rpc deps; the observer handlers live on
 *  the store instance for the process lifetime. */
export const wireSalesforceReconciliation = (
  input: WireSalesforceReconciliationInput,
): void => {
  // Register every reconciler in the default registry (per-process,
  // module-level state). De-dupes against earlier registrations so
  // wiring the bin twice in a test harness doesn't throw.
  for (const reconciler of input.reconcilers) {
    if (reconciler.vendor !== SALESFORCE_VENDOR) continue;
    try {
      registerVendorReconciler(reconciler);
    } catch {
      // Already registered — fine on idempotent boot scenarios.
    }
  }

  // Register tasks for every existing Salesforce connection.
  for (const row of input.connectionStore.list({ kind: 'api' })) {
    if (!isSalesforceApiConnection(row)) continue;
    registerTasksForConnection(
      input.reconcilers,
      row.name,
      input.lookupConnection,
    );
  }

  // Hook future enrollments + deletions.
  input.connectionStore.addOnUpsert((row) => {
    if (!isSalesforceApiConnection(row)) return;
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
    // a no-op so non-Salesforce api deletions are cheap.
    unregisterTasksForConnection(input.reconcilers, name);
    // D-130 P5 — drop replayId state for the deleted connection so
    // re-enrollment under the same name doesn't reject events from a
    // freshly-recreated PushTopic that may emit lower replayIds.
    input.replayIdTracker?.forgetConnection(name);
  });
};

/** Registry entry — composes every Salesforce piece in dependency
 *  order + wires the reconciliation glue, the CometD subscription
 *  lifecycle, and the webhook funnel. Called once by
 *  `composeVendorSubstrate(...)` per the `VENDOR_BOOT_REGISTRY` array.
 *
 *  Construction sequence (each step gated on the deps it actually
 *  needs):
 *
 *    1. Sales Cloud trio reconcilers (opportunity / contact / account),
 *       each carrying its per-entity webhook processor and the shared
 *       in-memory replayId tracker (one instance shared across the
 *       trio for reconnect-with-replayId resume).
 *    2. `wireSalesforceReconciliation(...)` — boot scan + observer
 *       hooks.
 *    3. Upstream-merge clients — `salesforce:lead` + `salesforce:account`
 *       via SOAP `merge()`; `salesforce:contact` registers the degraded
 *       stub (the API doesn't expose contact merge). Only when
 *       `upstreamMergeRegistry` is wired.
 *    4. Webhook funnel + CometD subscription lifecycle. The funnel
 *       bridges CometD long-poll events into the same per-entity
 *       webhook processors HTTP-ingressed vendors use (HubSpot HTTP
 *       webhooks would route through the same funnel; for Salesforce
 *       it's the in-process CometD→processor bridge). `lookupConnectionConfig`
 *       reads parsed config straight off the store row;
 *       `webhook_secret` isn't populated for Salesforce, so the funnel
 *       takes the no-signature_header skip-HMAC path.
 *    5. Engagement reconcilers (task / event / email_message) folded
 *       into the shared reconciler array (D-184) so they ride the
 *       housekeeping cycle + connection-enroll activation. The call
 *       entity is registered lazily per connection via the returned
 *       `registerSalesforceCallEntity` hook — the capability probe
 *       determines voice_call vs call_history at reprobe time and the
 *       hook swaps the call entity's housekeeping task.
 *
 *  Returns a `VendorBootBundle` carrying `registerSalesforceCallEntity`
 *  for the engagement-health reprobe rpc to capture. */
export const bootSalesforce = async (
  deps: VendorBootDeps,
): Promise<VendorBootBundle> => {
  // D-130 P5 + P5.2 — reconcilers + per-entity webhook processors.
  // The Sales Cloud trio shares one replayId tracker for reconnect-
  // with-replayId resume across the trio (CometD long-poll restart
  // resumes from the latest acknowledged event per connection).
  const salesforceReplayIdTracker = createInMemoryReplayIdTracker();
  const salesforceReconcilers = buildSalesforceReconcilers({
    opportunity: { search: { refreshAuth: deps.refreshAuth } },
    contact: { search: { refreshAuth: deps.refreshAuth } },
    account: { search: { refreshAuth: deps.refreshAuth } },
    replayIdTracker: salesforceReplayIdTracker,
  });

  // D-184 — Salesforce engagement reconcilers (task / event / email_message)
  // join the SAME reconciler array as the Sales Cloud trio so they inherit
  // the connection-enroll → HousekeepingTaskInstance activation + boot-scan +
  // delete-deregister and the shared per-(connection, vendor) rate gate.
  // Each carries a `selfIngest` hook (its richer engagements-table + edges +
  // dedupe write); the CometD funnel skips them (it only drives default-write
  // reconcilers — see the webhook-funnel.ts guard), so engagement stays
  // pull-only, exactly as it was on the retired runonce path. The dual-schema
  // `call` entity is NOT folded here — it's per-connection capability-
  // determined, registered lazily by `registerSalesforceCallEntity` (below)
  // once the probe picks voice_call vs call_history. Built BEFORE the wire so
  // the boot-scan installs their tasks for every already-enrolled connection.
  const salesforceEngagementReconcilers: VendorReconciler[] = [];
  if (deps.engagementStore) {
    const engagementStore = deps.engagementStore;
    const substrate = buildSalesforceEngagementReconcilers(
      {
        task: {
          search: { refreshAuth: deps.refreshAuth },
          engagementStore,
          authorship: {},
        },
        event: {
          search: { refreshAuth: deps.refreshAuth },
          engagementStore,
          authorship: {},
        },
        email_message: {
          search: { refreshAuth: deps.refreshAuth },
          engagementStore,
          authorship: {},
        },
        replayIdTracker: salesforceReplayIdTracker,
      },
      engagementStore,
    );
    salesforceEngagementReconcilers.push(
      substrate.task,
      substrate.event,
      substrate.email_message,
    );
  }

  wireSalesforceReconciliation({
    connectionStore: deps.connectionStore,
    reconcilers: [...salesforceReconcilers, ...salesforceEngagementReconcilers],
    lookupConnection: deps.lookupConnection,
    replayIdTracker: salesforceReplayIdTracker,
  });

  // D-138 P5 — upstream-merge clients. SOAP `merge()` covers
  // `salesforce:lead` + `salesforce:account`; `salesforce:contact` is
  // NOT exposed in the standard API and routes through the degraded-
  // path stub registered alongside.
  if (deps.upstreamMergeRegistry) {
    deps.upstreamMergeRegistry.set(
      'salesforce:lead',
      createSalesforceMergeClient('salesforce:lead', {
        refreshAuth: deps.refreshAuth,
      }),
    );
    deps.upstreamMergeRegistry.set(
      'salesforce:account',
      createSalesforceMergeClient('salesforce:account', {
        refreshAuth: deps.refreshAuth,
      }),
    );
    deps.upstreamMergeRegistry.set(
      'salesforce:contact',
      SALESFORCE_CONTACT_DEGRADED,
    );
  }

  // P5.2 — webhook funnel + CometD subscription lifecycle. The funnel
  // is the same instance HubSpot HTTP webhooks would route through;
  // for Salesforce it's the in-process bridge between the CometD long-
  // poll subscriber and the per-entity WebhookProcessors.
  // `lookupConnectionConfig` reads parsed config straight off the
  // store row — `webhook_secret` isn't populated for Salesforce, so
  // the funnel takes the no-signature_header skip-HMAC path.
  if (deps.enrichmentStore) {
    const enrichmentStore = deps.enrichmentStore;
    const salesforceFunnel = createWebhookFunnel({
      registry: getDefaultReconcilerRegistry(),
      lookupConnectionConfig: (vendor, name) => {
        if (vendor !== 'salesforce') return null;
        const row = deps.connectionStore.get('api', name);
        if (!row) return null;
        try {
          const parsed: unknown = JSON.parse(row.config_json);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          return {};
        }
        return {};
      },
      enrichmentStore,
      bus: deps.warehouseBus,
      // D-190 — mirror records on CometD-accelerated changes so deal.search's
      // mirror stays fresh between reconciliation cycles. Absent ⇒ the cycle
      // catches up on its next pass.
      ...(deps.crmRecordMirror ? { crmRecordMirror: deps.crmRecordMirror } : {}),
      // WatchSource governance — CometD deliveries stamp the salesforce
      // webhook row's last_event_at on the process-default registry.
      onEmit: (info) =>
        getDefaultWatchSourceRegistry().markEvent(
          webhookSourceKey(info.vendor, info.connection_name),
          info.at,
        ),
    });
    wireSalesforceCometDLifecycle({
      connectionStore: deps.connectionStore,
      lookupConnection: deps.lookupConnection,
      refreshAuth: deps.refreshAuth,
      replayIdTracker: salesforceReplayIdTracker,
      onEvent: async (event, connection_name) => {
        const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
        await salesforceFunnel.handle({
          vendor: 'salesforce',
          connection_name,
          payload: event,
          headers: {},
          rawBody,
        });
      },
    });
  }

  // D-184 — the dual-schema call entity (voice_call vs call_history) is
  // per-connection capability-determined, so it can't sit in the static
  // reconciler array above. The engagement-health reprobe rpc resolves the
  // winner per connection and calls this hook to register / swap the call
  // entity's HOUSEKEEPING task for that connection — replacing the retired
  // runonce-runner swap. Per-connection: unregister the prior winner's task
  // (when it flips), then register the new winner's task if absent. The
  // reconciler closes over the engagement store + shared refresh; the
  // harness re-fetches fresh auth per cycle via `lookupConnection`. Like the
  // pre-D-184 runonce path, the call task is established by reprobe (not the
  // boot scan), so it must be re-established by a reprobe after a restart.
  if (deps.engagementStore) {
    const engagementStore = deps.engagementStore;
    // D-184 — the dynamically-registered call-entity task (minted per reprobe,
    // below) is NOT in the static reconciler array, so wireSalesforceReconciliation's
    // connection-delete observer won't deregister it. Add a second additive
    // observer that drops BOTH possible call task ids for a deleted connection
    // (a no-op when that connection never had a call task — unregistering an
    // unknown id is a no-op). Without this, a reprobed call task would linger
    // after its connection is deleted (dormant — it yields `no_work` since the
    // lookup returns null — but a registry leak). The cursor row in
    // housekeeping_state survives, mirroring the record-reconciler delete path.
    deps.connectionStore.addOnDelete((kind, name) => {
      if (kind !== 'api') return;
      unregisterHousekeepingTask(reconciliationTaskId('salesforce', 'voice_call', name));
      unregisterHousekeepingTask(reconciliationTaskId('salesforce', 'call_history', name));
    });
    const registerSalesforceCallEntity = (input: {
      connection: ConnectionRecord;
      winner: 'voice_call' | 'call_history' | null;
      prior: 'voice_call' | 'call_history' | null;
    }): void => {
      const { connection, winner, prior } = input;
      if (prior !== null && prior !== winner) {
        unregisterHousekeepingTask(
          reconciliationTaskId('salesforce', prior, connection.name),
        );
      }
      if (winner !== null) {
        const taskId = reconciliationTaskId(
          'salesforce',
          winner,
          connection.name,
        );
        if (getHousekeepingTask(taskId) === undefined) {
          const reconciler = new SalesforceCallEngagementReconciler({
            search: { refreshAuth: deps.refreshAuth },
            engagementStore,
            authorship: {},
            callEntity: winner,
          });
          registerHousekeepingTask(
            buildVendorReconciliationTask({
              reconciler,
              connection_name: connection.name,
              lookupConnection: deps.lookupConnection,
            }),
          );
        }
      }
    };
    return { registerSalesforceCallEntity };
  }

  // No engagementStore — engagement reconcile isn't wired; nothing to
  // surface for the call-entity reprobe.
  return {};
};
