/** Phase D (D-106) + D-115 Phase 6C — webhook + hook listeners composer.
 *
 *  Two HTTP listeners gated on the same `bootstrap.webhook_port > 0`
 *  knob. D-096 keeps both inbound paths self-host-only — the cloud
 *  never relays webhook or `/hook/*` ingress, so the operator must
 *  bring their own public address (or user-hosted tunnel) and flip
 *  `RECUED_PUBLIC_REACHABLE=true` (read per-request so the toggle
 *  doesn't demand a restart).
 *
 *  - `webhookListener` backs `POST /webhook/{slug}` and dispatches to
 *    the registered webhook collection via `collectionRegistry`.
 *  - `hookListener` backs `POST /hook/{recipe_id}/{slug}` and enqueues
 *    into `webhookWatcherQueue` for the kernel `webhook-watcher`
 *    drain dispatcher.
 *
 *  WatchSource generalization — this composer also owns the THIRD
 *  inbound surface, the D-128 P3 vendor-connection webhook receiver
 *  (`POST /v1/connection/webhook/<vendor>/<connection_name>` →
 *  HMAC-verifying funnel → warehouse-bus emits). The receiver module +
 *  the server.ts route existed since D-128 but nothing composed them —
 *  the silent-dead-surface trap; closing it is what makes the webhook
 *  push source REAL rather than a status row about nothing. The funnel
 *  instance here sets `requireMessageAuth` — OAuth-bound vendors
 *  (Salesforce CometD) stay reachable ONLY through their authenticated
 *  in-process channel, never over unauthenticated public HTTP.
 *
 *  The same deps register the webhook push-source PROVIDER on the
 *  watch source registry: one governance row per (webhook-capable
 *  vendor × enrolled api connection), active when the delivery path is
 *  live end-to-end (port wired ∧ publicly reachable ∧ secret present —
 *  or the vendor's in-process subscription for OAuth-bound vendors).
 *  Provider registration is NOT gated on `webhookPort` — an inactive
 *  row that says WHY ("inbound webhook port not configured") is the
 *  governance value.
 *
 *  Gate: `webhookPort > 0` → the three listeners; otherwise all
 *  undefined and the caller's path-router 404s every inbound webhook /
 *  hook request. The shared `publicReachable` thunk reads
 *  `process.env.RECUED_PUBLIC_REACHABLE` per request — same shape both
 *  pre-existing listeners had; sharing the thunk preserves the
 *  per-request read semantic without coupling the listeners' internal
 *  state (the thunk is stateless). */

import {
  composeVendorEntityScope,
  readConnectionInboundSecret,
  type WatchSourceStatusEntry,
} from '@recued/contracts';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import type { CollectionRegistry } from '../../collections/registry.js';
import type { ConnectionWebhookRequestHandler } from '../../connection-webhook-listener.js';
import {
  getDefaultReconcilerRegistry,
  type ReconcilerRegistry,
} from '../../housekeeping/reconciliation/reconciler-registry.js';
import type { VendorReconciler } from '../../housekeeping/reconciliation/vendor-reconciler.js';
import type { EnrichmentStore } from '../../storage/enrichment-store.js';
import type { CrmRecordMirrorStore } from '../../storage/crm-record-mirror-store.js';
import {
  resolveConnectionVendor,
  type ConnectionStoreSqlite,
} from '../../storage/connection-store.js';
import {
  webhookSourceKey,
  type WatchSourceRegistry,
} from '../../watch/source-registry.js';
import type { WebhookWatcherQueue } from '../../watchers/webhook-watcher.js';
import type { WebhookRequestHandler } from '../../collections/webhook/webhook-listener.js';
import type { HookRequestHandler } from '../../watchers/webhook-hook-listener.js';

export interface ComposeWebhookAndHookListenersDeps {
  readonly webhookPort: number;
  readonly collectionRegistry: CollectionRegistry;
  readonly webhookWatcherQueue: WebhookWatcherQueue;
  /** Connection store — backs the D-128 receiver's config lookup AND
   *  the webhook push-source provider rows. Absent (daemon-less
   *  harness) ⇒ neither composes. */
  readonly connectionStore?: ConnectionStoreSqlite;
  /** Enrichment store — the funnel's hash-diff + meta-refresh sink.
   *  Absent ⇒ the D-128 receiver stays unwired (provider rows still
   *  register; their `active` reflects the missing receiver). */
  readonly enrichmentStore?: EnrichmentStore;
  /** D-190 — the dedicated CRM record mirror, threaded into the funnel so
   *  HTTP-webhook-accelerated CRM changes mirror records immediately (parity
   *  with the reconciliation cycle + the Salesforce CometD funnel). Absent ⇒
   *  the funnel skips the mirror write; the cycle catches up. */
  readonly crmRecordMirror?: CrmRecordMirrorStore;
  /** Warehouse bus the funnel's synthetic events emit on. */
  readonly warehouseBus?: WarehouseEventBus;
  /** WatchSource governance registry — receives the webhook provider +
   *  the funnel's `last_event_at` marks. */
  readonly sourceRegistry?: WatchSourceRegistry;
  /** D-188 — master "Pause server" flag. Forwarded to all three inbound
   *  listeners; a paused server rejects every inbound webhook / hook
   *  (503 SERVER_PAUSED) without dispatching — the "close intake to stop
   *  the spam" half of pause (webhook intake is contract-free, so it
   *  bypasses the op-admission gate and must be closed here). Read
   *  per-request, so resume is instant. Absent ⇒ never paused. */
  readonly isPaused?: () => boolean;
}

export interface WebhookAndHookListenersBundle {
  readonly webhookListener: WebhookRequestHandler | undefined;
  readonly hookListener: HookRequestHandler | undefined;
  /** D-128 P3 `POST /v1/connection/webhook/<vendor>/<connection_name>`
   *  receiver. Undefined when the port gate or its stores are absent. */
  readonly connectionWebhookListener: ConnectionWebhookRequestHandler | undefined;
}

const readPublicReachable = (): boolean => {
  const v = process.env.RECUED_PUBLIC_REACHABLE;
  return v === 'true' || v === '1';
};

/** Register the webhook push-source provider — one row per
 *  (webhook-capable vendor × enrolled api connection). Reads the
 *  reconciler registry + connection store LIVE per list() so vendor
 *  boot order and enrollment changes surface without churn. Exported
 *  for direct unit coverage; production calls it through
 *  `composeWebhookAndHookListeners` with the default registries. */
export const registerWebhookSourceProvider = (input: {
  sourceRegistry: WatchSourceRegistry;
  connectionStore: Pick<ConnectionStoreSqlite, 'list'>;
  reconcilerRegistry: Pick<ReconcilerRegistry, 'list'>;
  receiverLive: boolean;
  publicReachable: () => boolean;
}): void => {
  input.sourceRegistry.register('webhook', {
    list(): WatchSourceStatusEntry[] {
      const byVendor = new Map<string, VendorReconciler[]>();
      for (const reconciler of input.reconcilerRegistry.list()) {
        if (reconciler.webhookProcessor === undefined) continue;
        const list = byVendor.get(reconciler.vendor) ?? [];
        list.push(reconciler);
        byVendor.set(reconciler.vendor, list);
      }

      const rows: WatchSourceStatusEntry[] = [];
      for (const row of input.connectionStore.list({ kind: 'api' })) {
        const vendor = resolveConnectionVendor(row);
        if (vendor === undefined) continue;
        const reconcilers = byVendor.get(vendor);
        if (reconcilers === undefined) continue;

        const emits = reconcilers.map(
          (r) => `data.${composeVendorEntityScope(r.vendor, r.entity)}.${row.name}.**`,
        );
        const hmacBound = reconcilers.some(
          (r) => r.webhookProcessor?.signature_header !== undefined,
        );

        if (!hmacBound) {
          // OAuth-bound vendor (Salesforce CometD) — deliveries arrive
          // over the in-process authenticated subscription, which arms
          // off enrollment at vendor boot. The public receiver plays no
          // part (and rejects the vendor by design).
          rows.push({
            source_key: webhookSourceKey(vendor, row.name),
            mechanism: 'webhook',
            label: `${vendor} change feed — ${row.name}`,
            emits,
            active: true,
            inactive_reason: null,
            last_event_at: null,
          });
          continue;
        }

        let inactive_reason: string | null = null;
        if (!input.receiverLive) {
          inactive_reason = 'inbound webhook port not configured';
        } else if (!input.publicReachable()) {
          inactive_reason = 'public reachability is off (RECUED_PUBLIC_REACHABLE)';
        } else {
          let config: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = JSON.parse(row.config_json);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
              config = parsed as Record<string, unknown>;
            }
          } catch {
            config = null;
          }
          if (!readConnectionInboundSecret(config ?? {}, 'webhook_secret')) {
            inactive_reason = 'webhook_secret missing in connection config';
          }
        }

        rows.push({
          source_key: webhookSourceKey(vendor, row.name),
          mechanism: 'webhook',
          label: `${vendor} webhook — ${row.name}`,
          emits,
          active: inactive_reason === null,
          inactive_reason,
          last_event_at: null,
        });
      }
      return rows;
    },
  });
};

/** Compose the three listeners. Async because the factories live in
 *  modules that the pre-extraction call site reached via dynamic
 *  `await import(...)` (subcommand-shape: non-serve invocations skip
 *  the import entirely). */
export const composeWebhookAndHookListeners = async (
  deps: ComposeWebhookAndHookListenersDeps,
): Promise<WebhookAndHookListenersBundle> => {
  const portLive = deps.webhookPort > 0;
  const receiverComposable =
    portLive &&
    deps.connectionStore !== undefined &&
    deps.enrichmentStore !== undefined &&
    deps.warehouseBus !== undefined;

  // Single shared thunk — every listener reads it per-request, the
  // closure is stateless so sharing one preserves the live-toggle
  // semantic without affecting any listener's behavior.
  const publicReachable = readPublicReachable;

  // Governance rows register regardless of the port gate — an inactive
  // webhook row that names its blocker is the surface's whole point.
  if (deps.sourceRegistry && deps.connectionStore) {
    registerWebhookSourceProvider({
      sourceRegistry: deps.sourceRegistry,
      connectionStore: deps.connectionStore,
      reconcilerRegistry: getDefaultReconcilerRegistry(),
      receiverLive: receiverComposable,
      publicReachable,
    });
  }

  if (!portLive) {
    return {
      webhookListener: undefined,
      hookListener: undefined,
      connectionWebhookListener: undefined,
    };
  }

  const { createWebhookListener } = await import(
    '../../collections/webhook/webhook-listener.js'
  );
  const { createHookListener } = await import(
    '../../watchers/webhook-hook-listener.js'
  );

  const webhookListener = createWebhookListener({
    registry: deps.collectionRegistry,
    publicReachable,
    ...(deps.isPaused ? { isPaused: deps.isPaused } : {}),
  });

  const hookListener = createHookListener({
    queue: deps.webhookWatcherQueue,
    publicReachable,
    ...(deps.isPaused ? { isPaused: deps.isPaused } : {}),
  });

  let connectionWebhookListener: ConnectionWebhookRequestHandler | undefined;
  if (receiverComposable) {
    const connectionStore = deps.connectionStore!;
    const sourceRegistry = deps.sourceRegistry;
    const { createWebhookFunnel } = await import(
      '../../housekeeping/reconciliation/webhook-funnel.js'
    );
    const { createConnectionWebhookListener } = await import(
      '../../connection-webhook-listener.js'
    );
    const funnel = createWebhookFunnel({
      registry: getDefaultReconcilerRegistry(),
      lookupConnectionConfig: (vendor, connection_name) => {
        const row = connectionStore.get('api', connection_name);
        if (!row) return null;
        // A name enrolled under a DIFFERENT vendor is "not enrolled"
        // for this path — never let vendor A's secret verify vendor
        // B's payload.
        if (resolveConnectionVendor(row) !== vendor) return null;
        try {
          const parsed: unknown = JSON.parse(row.config_json);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          return {};
        }
        return {};
      },
      enrichmentStore: deps.enrichmentStore!,
      bus: deps.warehouseBus!,
      // D-190 — mirror records on accelerated HTTP-webhook changes too.
      ...(deps.crmRecordMirror ? { crmRecordMirror: deps.crmRecordMirror } : {}),
      // Public HTTP receiver: per-message auth REQUIRED. OAuth-bound
      // vendors stay in-process-only (see module doc).
      requireMessageAuth: true,
      ...(sourceRegistry
        ? {
            onEmit: (info: {
              vendor: string;
              connection_name: string;
              at: number;
            }): void =>
              sourceRegistry.markEvent(
                webhookSourceKey(info.vendor, info.connection_name),
                info.at,
              ),
          }
        : {}),
    });
    connectionWebhookListener = createConnectionWebhookListener({
      funnel: funnel.handle,
      publicReachable,
      ...(deps.isPaused ? { isPaused: deps.isPaused } : {}),
    });
  }

  return { webhookListener, hookListener, connectionWebhookListener };
};
