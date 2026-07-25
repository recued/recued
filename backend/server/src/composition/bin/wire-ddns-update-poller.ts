/** D-148 § A.14 — DDNS update poller composer.
 *
 *  The cloud DDNS update API is the heartbeat replacement (D-088 Go
 *  relay retired; `last_seen_at` folds into the DDNS post's side-
 *  effect). This composer wires the per-process poller that:
 *
 *    1. Reads the current `HandleState` from the handle store.
 *    2. Gates on `subscription_state ∈ {'active', 'grace'}` —
 *       `'released'` skips the post; the state machine itself
 *       handles release lifecycle.
 *    3. Resolves the server's current public IPv4 via the injected
 *       resolver (production: `fetchIpify`).
 *    4. Compares to the last successfully-published IP from the
 *       state store. Matches → no-op (no network call). Mismatch
 *       or first-ever publish → signs + POSTs via the cloud client.
 *    5. On success, persists the new IP + timestamp so a restart
 *       doesn't re-POST a no-change update.
 *    6. On failure, logs via `console.warn` and lets the next tick
 *       retry. The `'ddns_subscription_lapsed'` code is recognised
 *       but the recovery path (transition the local handle store
 *       to `'grace'`) is outside this slice's scope — for now,
 *       subsequent ticks just keep failing until the operator
 *       takes action.
 *
 *  Registered as `kind: 'timer'` on the shared `backgroundServices`
 *  singleton at `DDNS_UPDATE_INTERVAL_MS` (5 min). The `fireImmediate`
 *  flag is `true` so a daemon restart immediately publishes the
 *  current IP if it changed during downtime (matching the audit /
 *  s2s_preview / correction-events pruner convention).
 *
 *  Absent prerequisites (no `db`, no handle store, no signer) leave
 *  the composer a no-op — the spec'd path requires every piece. */

import {
  DDNS_UPDATE_INTERVAL_MS,
  resolveProDdnsHost,
  canonicalizeHandle,
  isSingleLabelProDdnsHostname,
  type HostnameProjection,
} from '@recued/contracts';
import type { BackgroundServiceRegistry } from './wire-background-services.js';
import type { HandleStateStore } from '../../handle/index.js';
import type { DdnsUpdateClient } from '../../ddns/update-client.js';
import type { DdnsEnabledStore } from '../../ddns/ddns-enabled-store.js';
import type {
  DdnsIpStateSnapshot,
  DdnsIpStateStore,
} from '../../ddns/ip-state-store.js';
import type { ProSubscriptionStateStore } from '../../hostname/pro-subscription-state.js';
import type { HostnameRegistryStore } from '../../storage/hostname-registry.js';

export interface ComposeDdnsUpdatePollerDeps {
  /** Background-services registry (typically the module singleton).
   *  The composer registers a `kind: 'timer'` entry; the registry's
   *  drain + fallback shutdown paths stop it. */
  registry: BackgroundServiceRegistry;
  /** Reads the current handle state. Returning null → no handle
   *  reserved; the poller skips the tick. */
  handleStateStore: HandleStateStore;
  /** Public IPv4 resolver. Returning null → resolver failed (no
   *  network / probe down); the poller skips the tick. */
  fetchPublicIpv4: () => Promise<string | null>;
  /** Cloud DDNS update client. The poller only publishes IP updates, so it
   *  needs just `update` (the `pause` verb is the `ddns.setEnabled` handler's). */
  updateClient: Pick<DdnsUpdateClient, 'update'>;
  /** Persists the last-published IP across restarts. */
  ipStateStore: DdnsIpStateStore;
  /** R27 delta-B — server-local DDNS publish flag. When the user has paused
   *  (`isEnabled()` false), the poller skips the tick entirely — it stops
   *  REFRESHING the record (the cloud already pulled it via the
   *  `ddns.setEnabled` cloud call). Optional — absent → always-publish
   *  (the legacy behavior). */
  ddnsEnabled?: Pick<DdnsEnabledStore, 'isEnabled'>;
  /** Optional D-152 hostname registry. Active `ddns_managed` rows become
   *  additional DDNS update targets. */
  hostnameRegistry?: Pick<HostnameRegistryStore, 'list'>;
  /** Per-hostname Pro subscription mirror. Supplies publisher_id for
   *  registry-managed DDNS rows. */
  subscriptionState?: Pick<ProSubscriptionStateStore, 'get'>;
  /** Polling cadence. Defaults to `DDNS_UPDATE_INTERVAL_MS` (5 min). */
  intervalMs?: number;
  /** Clock override for tests. Defaults to `Date.now`. */
  now?: () => number;
}

type DdnsUpdateTargetSource = 'handle_state' | 'hostname_registry';

interface DdnsUpdateTarget {
  publisher_id: string;
  handle: string;
  source: DdnsUpdateTargetSource;
}

const activeHandleState = new Set(['active', 'grace']);

const targetKey = (target: DdnsUpdateTarget): string =>
  `${target.publisher_id}\0${target.handle}`;

const snapshotTargetKeys = (snapshot: DdnsIpStateSnapshot | null): Set<string> =>
  new Set(
    (snapshot?.published_targets ?? []).map(
      (target) => `${target.publisher_id}\0${target.handle}`,
    ),
  );

const publishedTargetsFromKeys = (
  keys: ReadonlySet<string>,
): DdnsIpStateSnapshot['published_targets'] =>
  [...keys]
    .map((key) => {
      const [publisher_id, handle] = key.split('\0');
      return { publisher_id: publisher_id ?? '', handle: handle ?? '' };
    })
    .filter((target) => target.publisher_id.length > 0 && target.handle.length > 0)
    .sort((a, b) =>
      a.publisher_id === b.publisher_id
        ? a.handle.localeCompare(b.handle)
        : a.publisher_id.localeCompare(b.publisher_id),
    );

const deriveHandleFromDdnsHostname = (hostname: string): string | null => {
  if (!isSingleLabelProDdnsHostname(hostname)) return null;
  return resolveProDdnsHost(hostname)?.handle ?? null;
};

const isPublishableManagedHostname = (row: HostnameProjection): boolean =>
  row.ddns_managed &&
  row.enabled &&
  row.ownership_status === 'verified' &&
  isSingleLabelProDdnsHostname(row.hostname);

export const composeDdnsUpdatePoller = (
  deps: ComposeDdnsUpdatePollerDeps,
): void => {
  const intervalMs = deps.intervalMs ?? DDNS_UPDATE_INTERVAL_MS;
  const now = deps.now ?? Date.now;

  const loadTargets = async (): Promise<ReadonlyArray<DdnsUpdateTarget>> => {
    const byHandle = new Map<string, DdnsUpdateTarget>();
    const handleState = await deps.handleStateStore.load();
    if (handleState && activeHandleState.has(handleState.subscription_state)) {
      const handle = canonicalizeHandle(handleState.current_handle);
      if (handle.length > 0) {
        byHandle.set(handle, {
          publisher_id: handleState.publisher_id,
          handle,
          source: 'handle_state',
        });
      }
    }

    for (const row of deps.hostnameRegistry?.list() ?? []) {
      if (!isPublishableManagedHostname(row)) continue;
      const handle = deriveHandleFromDdnsHostname(row.hostname);
      if (!handle) continue;

      const state = deps.subscriptionState?.get(row.hostname) ?? null;
      if (state?.status === 'active') {
        byHandle.set(handle, {
          publisher_id: state.publisher_id,
          handle,
          source: 'hostname_registry',
        });
        continue;
      }

      const fallback = byHandle.get(handle);
      if (state === null && fallback?.source === 'handle_state') {
        byHandle.set(handle, {
          publisher_id: fallback.publisher_id,
          handle,
          source: 'hostname_registry',
        });
      }
    }

    return [...byHandle.values()].sort((a, b) =>
      a.handle === b.handle
        ? a.publisher_id.localeCompare(b.publisher_id)
        : a.handle.localeCompare(b.handle),
    );
  };

  const tick = async (): Promise<void> => {
    try {
      // R27 delta-B — a user-paused server stops REFRESHING its DDNS record
      // (the cloud already pulled it when ddns.setEnabled fired). Skip the
      // whole tick so the poller neither re-publishes nor burns a rate token.
      if (deps.ddnsEnabled && !deps.ddnsEnabled.isEnabled()) return;
      const targets = await loadTargets();
      if (targets.length === 0) return;

      const ipv4 = await deps.fetchPublicIpv4();
      if (!ipv4) return;

      const prior = deps.ipStateStore.load();
      const priorMatchesIp = prior?.ip_v4 === ipv4;
      const publishedKeys = priorMatchesIp
        ? snapshotTargetKeys(prior)
        : new Set<string>();
      if (priorMatchesIp && prior?.published_targets === undefined) {
        for (const target of targets) {
          if (target.source === 'handle_state') publishedKeys.add(targetKey(target));
        }
      }

      for (const target of targets) {
        if (priorMatchesIp && publishedKeys.has(targetKey(target))) {
          // No change since this target's last successful publish. Save
          // the network call AND the cloud's rate-limit token.
          continue;
        }

        const result = await deps.updateClient.update({
          publisher_id: target.publisher_id,
          handle: target.handle,
          ip_v4: ipv4,
          timestamp: now(),
        });

        if (result.ok) {
          publishedKeys.add(targetKey(target));
          deps.ipStateStore.save({
            ip_v4: ipv4,
            last_published_at: result.data.ddns_record_updated_at,
            published_targets: publishedTargetsFromKeys(publishedKeys),
          });
          continue;
        }

        // Failure → log + retry next tick. The poller does NOT update
        // the IP state on failure; the next tick re-detects the change
        // + retries.
        console.warn(
          `[ddns-update-poll] cloud rejected update for ${target.handle}: ${result.error}`,
          result.message ? `(${result.message})` : '',
        );
      }
    } catch (err) {
      // Unexpected error inside the tick body (e.g., the handle
      // store throws). Log + continue — a thrown tick would bubble
      // to setInterval's default error handler and become an
      // unhandled rejection.
      console.warn('[ddns-update-poll] tick failed', err);
    }
  };

  deps.registry.registerInterval({
    name: 'ddns-update-poll',
    intervalMs,
    tick: () => {
      // Fire-and-forget — registerInterval's `tick` is synchronous-
      // typed. The async body is intentionally not awaited; failures
      // are swallowed inside `tick()` itself.
      void tick();
    },
    fireImmediate: true,
  });
};
