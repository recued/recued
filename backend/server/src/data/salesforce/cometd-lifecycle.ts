/** D-130 Phase 5.2 — Per-Salesforce-connection CometD subscription
 *  lifecycle.
 *
 *  Pairs with `boot.ts` (which manages the housekeeping task
 *  registration). This module owns the subscriber lifecycle —
 *  PushTopic provisioning + CometD long-poll start/stop — and
 *  bridges every CometD event through the existing webhook funnel
 *  so the OAuth-bound Salesforce path reuses the same dedup +
 *  cascade-emit pipeline as HubSpot's HMAC-bound HTTP webhooks.
 *
 *  Lifecycle invariants:
 *
 *    1. **Boot scan** — for every existing `kind: 'api'` Salesforce
 *       connection in the store, ensure the trio of PushTopics
 *       exists on the org + start a long-poll subscriber. Resumes
 *       cleanly across process restart; the replayId tracker (if
 *       persistent) drives reconnect-with-replayId resume per
 *       channel.
 *    2. **`connection.upsert`** — first upsert under a name that
 *       doesn't already have a subscriber kicks the same
 *       provisioning + start sequence. Token-refresh upserts hit
 *       the same hook but the lifecycle's "already running" guard
 *       makes them a no-op.
 *    3. **`connection.delete`** — stop the subscriber gracefully,
 *       drop the lifecycle map entry. PushTopics on Salesforce's
 *       side are NOT deleted — re-enrollment under the same name
 *       finds them existing (idempotent SOQL short-circuit).
 *
 *  Subscriber.start() is awaited so enrollment-time misconfiguration
 *  (no instance_url, expired refresh token) surfaces in logs at
 *  upsert time rather than 110s later when the long-poll fails. The
 *  store-observer hook itself is sync — failures here log + swallow
 *  rather than block the rpc that triggered the upsert.
 *
 *  Spec: D-130 § A.5 + § Phase 5. */

import type {
  ConnectionAuth,
  ConnectionRecord,
  ConnectionRow,
  SalesforceEngagementEntityName,
  SalesforceRelationshipEntityName,
} from '@recued/contracts';

import {
  buildSalesforceCometDSubscriber,
  type SalesforceCometDSubscriber,
} from './cometd-subscriber.js';
import {
  ensurePushTopics,
  ensureEngagementPushTopics,
  type SalesforcePushTopicDeps,
} from './pushtopic-soap.js';
import type { SalesforceCometDEvent, SalesforceReplayIdTracker } from './webhook-processor.js';
import type { ConnectionLookup } from '../../housekeeping/reconciliation/vendor-reconciler.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';

const SALESFORCE_VENDOR = 'salesforce';

/** Detect Salesforce api connections by inspecting the row's
 *  `config_json`. Mirrors the predicate in `boot.ts`; duplicated
 *  here so this module stays standalone (no cross-import). */
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

/** Per-event delivery callback. Boot wire passes a handler that
 *  bridges into the webhook funnel — synthesizing a
 *  `WebhookFunnelInput` per event so the funnel's HMAC-skip + dedup
 *  + processor dispatch path runs uniformly with HubSpot's HTTP
 *  ingress. */
export type CometDEventBridge = (
  event: SalesforceCometDEvent,
  connection_name: string,
) => Promise<void>;

export interface WireSalesforceCometDLifecycleInput {
  connectionStore: ConnectionStoreSqlite;
  /** Resolves the live `ConnectionRecord` for a connection name —
   *  used by both PushTopic provisioning + the CometD subscriber's
   *  per-handshake auth read. Same callback the housekeeping wire
   *  uses. */
  lookupConnection: ConnectionLookup;
  /** OAuth single-flight refresh hook on 401. */
  refreshAuth: (connection: ConnectionRecord) => Promise<ConnectionAuth>;
  /** Shared replayId tracker across the trio. Wire-time the same
   *  tracker the webhook processor + boot wire use. */
  replayIdTracker: SalesforceReplayIdTracker;
  /** Per-event delivery — boot wire bridges into the webhook funnel. */
  onEvent: CometDEventBridge;
  /** HTTP fetcher. Defaults to the subscriber's bounded provider fetches. */
  fetcher?: typeof fetch;
  /** Sleep — passed through to subscribers for reconnect-backoff
   *  math. Defaults to a setTimeout-promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Best-effort logger. */
  log?: (
    level: 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ) => void;
  /** D-139 P1b — per-connection engagement-entity capability list.
   *  Returns the closed list of engagement / relationship entities the
   *  describe-probe (P1b) marked PushTopic-streamable for this
   *  connection. The lifecycle threads these through both:
   *    (1) `ensureEngagementPushTopics()` for SOAP-create at first
   *        enrollment (idempotent on re-enrollment), and
   *    (2) `buildSalesforceCometDSubscriber({ engagementEntities })`
   *        so `/meta/subscribe` widens to the engagement channels.
   *  When omitted (or returns empty array), the lifecycle stays at
   *  the D-130 P5 baseline — only the CRM trio. P1b Codex review
   *  fold #2 wired this dependency to close the gap where
   *  PushTopic-supported engagement objects never received
   *  PushTopics or subscriptions in production. */
  resolveEngagementEntities?: (
    connection_name: string,
  ) =>
    | ReadonlyArray<
        SalesforceEngagementEntityName | SalesforceRelationshipEntityName
      >
    | Promise<
        ReadonlyArray<
          SalesforceEngagementEntityName | SalesforceRelationshipEntityName
        >
      >;
}

export interface SalesforceCometDLifecycle {
  /** Stop every active subscriber + clear the map. Called from the
   *  server shutdown path. Idempotent. */
  stopAll(): Promise<void>;
  /** Test-only — list active connection names. */
  listActive(): ReadonlyArray<string>;
}

/** Wire the CometD subscription lifecycle into the connection store.
 *  Returns a handle the boot path can use to stop every subscriber
 *  during graceful shutdown. */
export const wireSalesforceCometDLifecycle = (
  input: WireSalesforceCometDLifecycleInput,
): SalesforceCometDLifecycle => {
  const log = input.log ?? noopLog;
  const subscribers = new Map<string, SalesforceCometDSubscriber>();
  /** Connections that should currently have a subscriber. Keeping desired
   *  state separate from the active map lets a delete/upsert race converge on
   *  the latest store event instead of leaving the connection permanently
   *  stopped. */
  const desired = new Set<string>();
  /** Per-connection in-flight provisioning promise. Prevents a fast
   *  upsert→upsert→upsert from racing through `ensurePushTopics`
   *  multiple times before the first call settles. */
  const inflight = new Map<string, Promise<void>>();
  /** Per-connection stop single-flight. A replacement start waits for this
   *  drain to finish before publishing another subscriber. */
  const stopping = new Map<string, Promise<void>>();
  let closed = false;
  let stopAllPromise: Promise<void> | undefined;

  const pushTopicDeps: SalesforcePushTopicDeps = {
    refreshAuth: input.refreshAuth,
    ...(input.fetcher !== undefined ? { fetcher: input.fetcher } : {}),
  };

  const shouldRun = (connection_name: string): boolean =>
    !closed && desired.has(connection_name);

  const logFailure = (
    action: string,
    connection_name: string,
    error: unknown,
  ): void => {
    log('error', `cometd-lifecycle: ${action} failed`, {
      connection: connection_name,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const observe = (
    promise: Promise<void>,
    action: string,
    connection_name: string,
  ): void => {
    void promise.catch((error) => {
      logFailure(action, connection_name, error);
    });
  };

  const startForConnection = (connection_name: string): Promise<void> => {
    if (!shouldRun(connection_name)) return Promise.resolve();
    if (subscribers.has(connection_name)) return Promise.resolve();
    const activeStop = stopping.get(connection_name);
    if (activeStop) return activeStop;
    const existing = inflight.get(connection_name);
    if (existing) return existing;

    const provisioning = (async () => {
      try {
        // Step 1 — ensure PushTopics. Idempotent — re-enrollment short-
        // circuits via the SOQL existence check in the SOAP module.
        const record = await input.lookupConnection(connection_name);
        if (!record) {
          log('warn', 'cometd-lifecycle: connection not found at start', {
            connection: connection_name,
          });
          return;
        }
        if (!shouldRun(connection_name)) return;
        try {
          const result = await ensurePushTopics(record, pushTopicDeps);
          if (result.created.length > 0) {
            log('info', 'cometd-lifecycle: created PushTopics', {
              connection: connection_name,
              created: result.created,
              existed: result.existed,
            });
          }
        } catch (e) {
          logFailure('ensurePushTopics', connection_name, e);
          return; // Don't start the subscriber if PushTopics aren't in place.
        }
        if (!shouldRun(connection_name)) return;

        // D-139 P1b Codex review fold #2 — engagement-entity provisioning.
        // When the boot wire supplies `resolveEngagementEntities`, look
        // up the per-connection capability list + SOAP-create the
        // engagement PushTopics + thread the same list into the
        // subscriber so `/meta/subscribe` widens. Failure here logs but
        // does NOT abort subscriber start — the CRM trio is still useful
        // and degraded engagement coverage is the documented
        // `coverage.sources_unavailable` substrate path.
        let engagementEntities:
          | ReadonlyArray<
              SalesforceEngagementEntityName | SalesforceRelationshipEntityName
            >
          | undefined;
        if (input.resolveEngagementEntities !== undefined) {
          try {
            const list = await Promise.resolve(
              input.resolveEngagementEntities(connection_name),
            );
            engagementEntities = list;
            if (list.length > 0) {
              const result = await ensureEngagementPushTopics(
                record,
                list,
                pushTopicDeps,
              );
              if (result.created.length > 0) {
                log('info', 'cometd-lifecycle: created engagement PushTopics', {
                  connection: connection_name,
                  created: result.created,
                  existed: result.existed,
                });
              }
            }
          } catch (e) {
            log('warn', 'cometd-lifecycle: ensureEngagementPushTopics failed (continuing)', {
              connection: connection_name,
              error: e instanceof Error ? e.message : String(e),
            });
            // Don't widen subscriber's channel set when engagement
            // PushTopics didn't land — substrate falls back to
            // reconciler-only for those entities.
            engagementEntities = undefined;
          }
        }
        if (!shouldRun(connection_name)) return;

        // Step 2 — build + start the subscriber.
        const subscriber = buildSalesforceCometDSubscriber({
          connection_name,
          lookupConnection: input.lookupConnection,
          refreshAuth: input.refreshAuth,
          replayIdTracker: input.replayIdTracker,
          onEvent: (event) => input.onEvent(event, connection_name),
          ...(input.fetcher !== undefined ? { fetcher: input.fetcher } : {}),
          ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
          ...(engagementEntities !== undefined
            ? { engagementEntities }
            : {}),
          log,
        });
        try {
          await subscriber.start();
        } catch (e) {
          logFailure('subscriber start', connection_name, e);
          try {
            await subscriber.stop();
          } catch (stopError) {
            logFailure('failed-start cleanup', connection_name, stopError);
          }
          return;
        }
        if (!shouldRun(connection_name)) {
          await subscriber.stop();
          return;
        }
        subscribers.set(connection_name, subscriber);
        log('info', 'cometd-lifecycle: subscriber started', {
          connection: connection_name,
        });
      } catch (e) {
        logFailure('provisioning', connection_name, e);
      }
    })();

    let tracked!: Promise<void>;
    tracked = provisioning.finally(() => {
      if (inflight.get(connection_name) === tracked) {
        inflight.delete(connection_name);
      }
    });
    inflight.set(connection_name, tracked);
    return tracked;
  };

  const stopForConnection = (connection_name: string): Promise<void> => {
    const existing = stopping.get(connection_name);
    if (existing) return existing;
    // Capture an already-active subscriber. If an upsert arrives while this
    // stop is draining, that old instance must still stop; the finally branch
    // below will then start a fresh replacement.
    const activeAtRequest = subscribers.get(connection_name);
    const work = (async () => {
      const pending = inflight.get(connection_name);
      if (pending) await pending;

      const subscriber = activeAtRequest
        ?? (!shouldRun(connection_name)
          ? subscribers.get(connection_name)
          : undefined);
      if (!subscriber) return;
      try {
        await subscriber.stop();
      } finally {
        if (subscribers.get(connection_name) === subscriber) {
          subscribers.delete(connection_name);
        }
      }
      log('info', 'cometd-lifecycle: subscriber stopped', {
        connection: connection_name,
      });
    })();

    let tracked!: Promise<void>;
    tracked = work.finally(() => {
      if (stopping.get(connection_name) === tracked) {
        stopping.delete(connection_name);
      }
      if (shouldRun(connection_name)) {
        observe(startForConnection(connection_name), 'replacement start', connection_name);
      }
    });
    stopping.set(connection_name, tracked);
    return tracked;
  };

  const activate = (connection_name: string): void => {
    if (closed) return;
    desired.add(connection_name);
    observe(startForConnection(connection_name), 'start', connection_name);
  };

  const deactivate = (connection_name: string): void => {
    desired.delete(connection_name);
    observe(stopForConnection(connection_name), 'stop', connection_name);
  };

  // Boot scan — start every existing Salesforce connection's
  // subscriber. Each start is fire-and-forget at the wiring level;
  // errors land in the log via the per-step catches above.
  for (const row of input.connectionStore.list({ kind: 'api' })) {
    if (!isSalesforceApiConnection(row)) continue;
    activate(row.name);
  }

  // Future enrollments — trigger provisioning + subscriber start.
  input.connectionStore.addOnUpsert((row) => {
    if (!isSalesforceApiConnection(row)) return;
    activate(row.name);
  });

  // Future deletions — stop the subscriber + drop from the map.
  input.connectionStore.addOnDelete((kind, name) => {
    if (kind !== 'api') return;
    deactivate(name);
  });

  return {
    stopAll() {
      if (stopAllPromise) return stopAllPromise;
      // Close admission synchronously before taking the drain snapshot. Store
      // observers may still fire because ConnectionStore hooks are process-
      // lifetime, but activate() becomes inert after this point.
      closed = true;
      desired.clear();
      stopAllPromise = (async () => {
        const names = new Set([
          ...subscribers.keys(),
          ...inflight.keys(),
          ...stopping.keys(),
        ]);
        const results = await Promise.allSettled(
          [...names].map((name) => stopForConnection(name)),
        );
        const errors = results
          .filter((result): result is PromiseRejectedResult =>
            result.status === 'rejected')
          .map((result) => result.reason);
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            'one or more Salesforce CometD subscribers failed to stop',
          );
        }
      })();
      return stopAllPromise;
    },
    listActive() {
      return Array.from(subscribers.keys());
    },
  };
};

const noopLog: NonNullable<WireSalesforceCometDLifecycleInput['log']> = () => {};
