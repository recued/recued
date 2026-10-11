/** Inbound webhook listeners composer: the D-128 vendor-connection receiver
 *  and its WatchSource rows. (Phase D's `/webhook/{slug}` listener lived here
 *  too until it was removed, below.)
 *
 *  HTTP listeners gated on the `bootstrap.webhooks_enabled` switch. D-096
 *  keeps the inbound paths self-host-only — the cloud never relays
 *  webhook ingress, so the operator must bring their own public address
 *  (or user-hosted tunnel) and switch on public reachability: the runtime
 *  key `collection.webhook.public_reachable`, or the older
 *  `RECUED_PUBLIC_REACHABLE=true` (`webhook-public-reachable.ts`, read per
 *  request so the key changes without a restart).
 *
 *  - ⛔ The Phase D `webhookListener` (`POST /webhook/{slug}`, into a
 *    `data.webhook.<slug>` warehouse collection) was REMOVED 2026-10-10.
 *    Nothing in production ever created a webhook collection, so every
 *    request answered 404; D-201's `/v1/webhooks/<id>` is the owner's
 *    inbound webhook (decisions-log, "D-106 follow-up").
 *  - ⛔ The D-115 6C `hookListener` (`POST /hook/{recipe_id}/{slug}`,
 *    feeding the `webhook-watcher`'s in-memory queue) was RETIRED
 *    2026-10-05 with that watcher: it verified nothing — the recipe id in
 *    its path was the only "secret", and a marketplace recipe's id is
 *    public — and what it queued was lost on restart. D-201 webhook
 *    triggers are the verified, durable path.
 *
 *  WatchSource generalization — this composer owns the D-128 P3
 *  vendor-connection webhook receiver
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
 *  Provider registration is NOT gated on `webhooksEnabled` — an inactive
 *  row that says WHY ("inbound webhooks are off") is the
 *  governance value.
 *
 *  Gate: `webhooksEnabled` → the receiver; otherwise undefined and the
 *  caller's path-router 404s every request to it. The receiver and the
 *  governance rows share one `publicReachable` thunk,
 *  read per request; the composition root passes the same one to D-201's
 *  intake, so all of them answer to one switch. */

import {
  composeVendorEntityScope,
  readConnectionInboundSecret,
  type WatchSourceStatusEntry,
} from '@recued/contracts';
import type { WarehouseEventBus } from '@recued/warehouse-events';
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
import { createWebhookPublicReachable } from './webhook-public-reachable.js';

export interface ComposeWebhookListenersDeps {
  readonly webhooksEnabled: boolean;
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
  /** D-188 — master "Pause server" flag. Forwarded to every inbound
   *  listener; a paused server rejects every inbound webhook
   *  (503 SERVER_PAUSED) without dispatching — the "close intake to stop
   *  the spam" half of pause (webhook intake is contract-free, so it
   *  bypasses the op-admission gate and must be closed here). Read
   *  per-request, so resume is instant. Absent ⇒ never paused. */
  readonly isPaused?: () => boolean;
  /** The public-reachability switch (`createWebhookPublicReachable`). The
   *  composition root builds it over its runtime config and passes the same
   *  thunk to D-201's intake. Absent ⇒ the environment alone. */
  readonly publicReachable?: () => boolean;
}

export interface WebhookListenersBundle {
  /** D-128 P3 `POST /v1/connection/webhook/<vendor>/<connection_name>`
   *  receiver. Undefined when the port gate or its stores are absent. */
  readonly connectionWebhookListener: ConnectionWebhookRequestHandler | undefined;
}

/** Register the webhook push-source provider — one row per
 *  (webhook-capable vendor × enrolled api connection). Reads the
 *  reconciler registry + connection store LIVE per list() so vendor
 *  boot order and enrollment changes surface without churn. Exported
 *  for direct unit coverage; production calls it through
 *  `composeWebhookListeners` with the default registries. */
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
          inactive_reason = 'inbound webhooks are off (webhooks_enabled)';
        } else if (!input.publicReachable()) {
          inactive_reason =
            'public reachability is off (collection.webhook.public_reachable)';
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

/** Compose the listeners. Async because the factories live in
 *  modules that the pre-extraction call site reached via dynamic
 *  `await import(...)` (subcommand-shape: non-serve invocations skip
 *  the import entirely). */
export const composeWebhookListeners = async (
  deps: ComposeWebhookListenersDeps,
): Promise<WebhookListenersBundle> => {
  const webhooksOn = deps.webhooksEnabled;
  const receiverComposable =
    webhooksOn &&
    deps.connectionStore !== undefined &&
    deps.enrichmentStore !== undefined &&
    deps.warehouseBus !== undefined;

  // One switch for every listener, read per request.
  const publicReachable = deps.publicReachable ?? createWebhookPublicReachable();

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

  if (!webhooksOn) {
    return { connectionWebhookListener: undefined };
  }

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

  return { connectionWebhookListener };
};
