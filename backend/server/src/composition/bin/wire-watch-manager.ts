/** Watch poll-manager composer (poll-manager / G6).
 *
 *  Boots the design § 3 pull mechanism alongside the event-trigger
 *  substrate: the persisted watch store (state + snapshots), the
 *  canonical poll fetch (one gated + audited `<entity>.search` walk-all
 *  per tick through the catalog gateway), and the manager that derives
 *  watch demand from enabled trigger rows × enrolled api connections,
 *  defers reconciler-covered keys, and runs ONE loop per active key.
 *
 *  Deps resolve from the SAME ExecuteHandlerDeps the dispatcher's
 *  `handleExecute` bridge uses, so the poll's gateway calls see the
 *  exact operation profiles / contract overrides / audit sink recipe
 *  runs see:
 *    - `executorConfig` → the bound ingredient executor (NO
 *      recipeContext ⇒ no L1 cache — the § 6 freshness-oracle pin)
 *    - `connectionOperationProfiles` → the gate's profile resolver
 *    - `connectionStore` → connection enumeration + vendor resolution
 *      (`resolveConnectionVendor`, the same resolver profile-seeding
 *      uses) + `subresource_path` scoping
 *    - `auditLog` → per-poll `connection_gateway` audit rows
 *    - `contractScan` → owner-override tightening
 *
 *  Reconciler deference reads the module-level housekeeping registry
 *  (`getHousekeepingTask(reconciliationTaskId(vendor, entity, conn))`)
 *  — the same registration the vendor boots (D-129 / D-130) write.
 *
 *  The composer recomputes once at compose time (arms persisted /
 *  freshly-demanded keys with the initial-poll delay); the composition
 *  hooks recompute to trigger CRUD, connection lifecycle, recipe-store
 *  mutations, and maintenance exit. Absent `db` → undefined and the
 *  `watch.*` rpc surface stays unregistered. */

import type Database from 'better-sqlite3';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import { createConnectionMcpHandler, type ResolvedCall } from '@recued/ingredients';

import type { EventBus } from '../../events/bus.js';
import type { ExecuteHandlerDeps } from '../../execute-handler.js';
import { connectionBaseUrlFromConfig } from '../../connection-base-url.js';
import { getHousekeepingTask } from '../../housekeeping/registry.js';
import { reconciliationTaskId } from '../../housekeeping/reconciliation/vendor-reconciler.js';
import type { LocalManifestStore } from '../../ingredient-authoring/local-manifest-store.js';
import { liveVendorRegistry } from '../../recipe-runnability-handler.js';
import { createGatewayAuditEmitter } from '../../server-executor.js';
import { resolveConnectionVendor } from '../../storage/connection-store.js';
import type { EventTriggersStore } from '../../triggers/store.js';
import { runCanonicalWatchPoll } from '../../watch/canonical-poll.js';
import { createConnectionApiPollSource } from '../../watch/connection-api-source.js';
import { createBridgeDomRead } from '../../watch/dom-bridge-read.js';
import { createDomPollSource } from '../../watch/dom-source.js';
import {
  createMcpResourcePollSource,
  type McpResourceReadOutcome,
} from '../../watch/mcp-resource-source.js';
import type { WatchRpcDeps } from '../../watch/handler.js';
import {
  createWatchPollManager,
  type PollManagerHandle,
  type WatchPollSource,
} from '../../watch/poll-manager.js';
import { createWatchStore } from '../../watch/snapshot-store.js';
import type { WatchSourceRegistry } from '../../watch/source-registry.js';

export interface ComposeWatchManagerInput {
  /** SQLite handle. Absent (dbless harness) → substrate stays unwired. */
  db: Database.Database | undefined;
  /** Warehouse-events bus the poll diffs emit on (the dispatcher's
   *  subscription source). */
  warehouseBus: WarehouseEventBus;
  /** Shared execute deps — see the module doc for which fields the
   *  poll path consumes. */
  executeDeps: ExecuteHandlerDeps;
  /** The event-trigger store the manager derives demand from. Absent
   *  (event-trigger substrate unwired) → no demand source → unwired. */
  triggersStore: EventTriggersStore | undefined;
  /** D-121 broadcast bus — `automation_rule_changed {mechanism:
   *  'watch'}` on pause/resume, error-cap auto-disable, armed-set
   *  changes. */
  eventBus: EventBus | undefined;
  /** D-170 installed-manifest store — resolves the live merged vendor
   *  registry (built-ins + installed 3rd-party CRM packs) per poll via
   *  `liveVendorRegistry`, the SAME source install + runnability use.
   *  Absent → kernel built-ins only (3rd-party watches fail config
   *  until the store is wired, fail-closed). */
  localManifestStore: Pick<LocalManifestStore, 'listManifests' | 'getEntitySchemas'> | undefined;
  /** WatchSource model — push-source governance registry, threaded into
   *  the `watch.list` rpc as the `sources` rows. Absent → empty list. */
  sourceRegistry?: WatchSourceRegistry;
  /** R21.1 — live vault-unlocked predicate. `recompute()` disarms every
   *  loop while sealed; the coordinator re-arms on unlock. Absent →
   *  un-gated. */
  isVaultUnlocked?: () => boolean;
}

export interface WatchManagerBundle {
  manager: PollManagerHandle;
  watchDeps: WatchRpcDeps;
}

export const composeWatchManager = (
  input: ComposeWatchManagerInput,
): WatchManagerBundle | undefined => {
  const { db, warehouseBus, executeDeps, triggersStore, eventBus, localManifestStore, isVaultUnlocked } = input;
  if (!db || !triggersStore) return undefined;

  const store = createWatchStore(db);
  const auditEmitter = executeDeps.auditLog
    ? createGatewayAuditEmitter(executeDeps.auditLog)
    : undefined;

  // WatchSource generalization — the connection-api poll source is the
  // founding `WatchPollSource` instance; the manager core is
  // source-agnostic.
  const connectionApiSource = createConnectionApiPollSource({
    listApiConnections: () =>
      (executeDeps.connectionStore?.list({ kind: 'api' }) ?? []).map((row) => ({
        name: row.name,
        vendor: resolveConnectionVendor(row),
      })),
    hasReconciler: (vendor, entity, connection_name) =>
      getHousekeepingTask(reconciliationTaskId(vendor, entity, connection_name)) !== undefined,
    poll: (pollInput) =>
      runCanonicalWatchPoll(
        {
          executorConfig: executeDeps.executorConfig,
          profiles: {
            get: (name) => executeDeps.connectionOperationProfiles?.get(name) ?? null,
          },
          ...(executeDeps.connectionStore
            ? {
                getSubresourcePath: (name: string) =>
                  executeDeps.connectionStore!.get('api', name)?.subresource_path ?? undefined,
                // D-192 H4 — per-tenant base URL, so a paginating Source op's
                // absolute next-page link resolves same-origin (else page-1 truncation).
                getBaseUrl: (name: string) =>
                  connectionBaseUrlFromConfig(
                    executeDeps.connectionStore!.get('api', name)?.config_json,
                  ),
              }
            : {}),
          ...(auditEmitter ? { onGatewayAudit: auditEmitter } : {}),
          ...(executeDeps.contractScan ? { contractScan: executeDeps.contractScan } : {}),
          // Live merged registry (built-ins + installed 3rd-party CRM
          // packs) — resolved per poll so a runtime pack install is
          // reflected without recompose.
          resolveVendorRegistry: () => liveVendorRegistry(localManifestStore),
        },
        pollInput,
      ),
  });

  // WatchSource generalization — the 2nd poll source: mcp-resource
  // content polling (`resources/read` of one enrolled `connection.mcp`
  // resource, hash-diffed). Composed only when the mcp adapter deps +
  // the connection store are both wired (absent in dbless / keyless
  // harnesses, exactly like the api handler). The fetch plug builds a
  // dedicated `connection.mcp` handler over the SAME deps the executor
  // uses (a separate in-memory client pool — harmless; each runtime
  // keeps its own per the adapter doc) and dispatches the read-only
  // `resources/read` DIRECTLY — resources are ungated by MCP spec, so
  // the connection-mcp classification gate (tool-only) does not apply.
  const mcpHandlerDeps = executeDeps.executorConfig.connectionMcp;
  const connectionStore = executeDeps.connectionStore;
  const mcpResourceSource: WatchPollSource | undefined =
    mcpHandlerDeps && connectionStore
      ? (() => {
          const mcpHandler = createConnectionMcpHandler(mcpHandlerDeps);
          return createMcpResourcePollSource({
            listMcpConnections: () =>
              (connectionStore.list({ kind: 'mcp' }) ?? []).map((row) => row.name),
            readResource: async ({ connection_name, uri }): Promise<McpResourceReadOutcome> => {
              const row = connectionStore.get('mcp', connection_name);
              if (row === null) {
                return {
                  ok: false,
                  kind: 'config',
                  reason: `mcp connection '${connection_name}' is not enrolled`,
                };
              }
              const call: ResolvedCall = {
                slug: 'watch-mcp-resource-poll',
                risk_tier: 'read',
                input: {},
                output: {},
              };
              let raw: unknown;
              try {
                raw = await mcpHandler(row, { resource: uri }, call);
              } catch (e) {
                // Auth / transport / network / malformed-endpoint
                // IngredientErrors land here — the error bucket counts
                // toward the manager's error cap + surfaces in #automation.
                return {
                  ok: false,
                  kind: 'error',
                  reason: e instanceof Error ? e.message : String(e),
                };
              }
              const shaped = raw as { status?: unknown; result?: unknown } | null;
              if (shaped?.status === 'ok') return { ok: true, result: shaped.result };
              // `tool_error` — the server answered but raised (unknown
              // uri / server-side resource error). A read failure for
              // watch purposes; summarize the JSON-RPC error envelope.
              return {
                ok: false,
                kind: 'error',
                reason: `mcp resources/read on '${connection_name}' returned an error: ${JSON.stringify(
                  shaped?.result ?? null,
                )}`,
              };
            },
          });
        })()
      : undefined;

  // WatchSource generalization — the 3rd poll source: dom content polling
  // (`read_dom` of one selector on a bridge-served tab, hash-diffed). Like
  // mcp-resource it is a POLL source (governed by the manager's
  // `WatchStatusEntry` rows, NOT the push-source registry — that registry
  // is webhook / messenger / reception only). Composed only when the bridge
  // dispatcher ref is wired (absent in dbless / bridgeless harnesses); the
  // ref is late-bound, so the read reports `'unavailable'` until the WS
  // server publishes the live dispatcher post-compose. The synthetic
  // `recued/dom-watch` ingredient + the per-tick fresh idempotency key live
  // in the `createBridgeDomRead` plug.
  const bridgeDispatcherRef = executeDeps.executorConfig.bridgeDispatcherRef;
  const domSource: WatchPollSource | undefined = bridgeDispatcherRef
    ? createDomPollSource({
        readDom: createBridgeDomRead({ getDispatcher: bridgeDispatcherRef }),
      })
    : undefined;

  const sources: WatchPollSource[] = [connectionApiSource];
  if (mcpResourceSource) sources.push(mcpResourceSource);
  if (domSource) sources.push(domSource);

  const manager = createWatchPollManager({
    store,
    triggersStore,
    sources,
    bus: warehouseBus,
    ...(eventBus ? { eventBus } : {}),
    ...(isVaultUnlocked ? { isVaultUnlocked } : {}),
  });
  // Deliberately NO initial recompute here: vendor reconcilers register
  // with the housekeeping registry in `startHousekeepingStartup` (the
  // post-listener runtime), AFTER this composer runs — an immediate
  // recompute would miss the deference check and arm poll loops for
  // kernel-vendor keys the reconciler already covers. The post-listener
  // runtime runs the first recompute right after housekeeping startup.

  return {
    manager,
    watchDeps: {
      getManager: () => manager,
      getSourceRegistry: () => input.sourceRegistry,
    },
  };
};
