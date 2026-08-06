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
import type { HandleState, HandleStateMachine, HandleStateStore } from '../../handle/index.js';
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
  /** D-148 § A.5.6 — the handle state machine's lifecycle applier, resolved
   *  lazily because the cert stack fills its ref after this composer runs.
   *  Absent (db-less / test harnesses) → the poller still backs off, it just
   *  cannot record the state transition. */
  applyLifecycle?: () => Pick<HandleStateMachine, 'applyLifecycleUpdate'> | undefined;
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

  // ── first-publish warm-up ───────────────────────────────────────────
  //
  // ⛔ MEASURED 2026-08-05 on a fresh Pro server, left untouched after boot:
  //      reserve landed  ~26s
  //      first publish  +315s   ← one whole DDNS_UPDATE_INTERVAL_MS later
  //
  // Both this poller and the sibling provisioning timer register post-listener
  // and both `fireImmediate`, milliseconds apart in the same synchronous boot
  // path. The provisioner's reserve is an in-flight HTTP call at the moment
  // this tick runs, so `loadTargets()` legitimately returns empty — and the one
  // immediate fire is spent on a tick that COULD NOT have succeeded. Nothing
  // re-triggers it when the handle lands a second later, so a job that takes
  // ~1s waits out a full cadence. It self-heals (measured: slow, not stuck),
  // but a new Pro user's hostname does not resolve for five minutes after
  // setup — the least forgiving moment for a paid feature.
  //
  // So: an empty target list is NOT-STARTED-YET rather than NOTHING-TO-DO,
  // until the first time targets actually appear.
  //
  // Safe to run on a free server that will never have a handle: `loadTargets`
  // is purely local (SQLite handle-state + hostname registry) and the tick
  // returns before `fetchPublicIpv4`, so a warm-up poll costs two local reads —
  // no network, no cloud call, no rate token. Bounded anyway, so a handle-less
  // server settles onto the normal cadence quickly.
  const WARMUP_INTERVAL_MS = 2_000;
  const WARMUP_WINDOW_MS = 90_000;
  const warmupDeadline = now() + WARMUP_WINDOW_MS;
  let sawTargets = false;
  let warmupTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const clearWarmup = (): void => {
    if (warmupTimer !== undefined) {
      clearTimeout(warmupTimer);
      warmupTimer = undefined;
    }
  };

  /** Re-run soon while the precondition is still being produced by boot.
   *  Never stacks, never outlives the window, and is unref'd + cleared on stop
   *  so it cannot hold the process open or fire against torn-down stores. */
  const scheduleWarmup = (): void => {
    if (stopped || sawTargets || warmupTimer !== undefined) return;
    if (now() >= warmupDeadline) return;
    warmupTimer = setTimeout(() => {
      warmupTimer = undefined;
      if (stopped || sawTargets) return;
      void tick();
    }, WARMUP_INTERVAL_MS);
    warmupTimer.unref?.();
  };

  // ── lapse recovery (D-148 § A.5.6 deferral, closed 2026-08-05) ──────
  //
  // ⛔ MEASURED live: a cancelled subscription left `subscription_state` at
  //    'active' FOREVER. The handle stayed a publish target, so the poller
  //    issued one update per tick that the cloud refused with
  //    `ddns_subscription_lapsed` — 288 rejected requests/day, per lapsed
  //    server, indefinitely. Fail-closed (the zone stayed correct only because
  //    the CLOUD refused), but the server never stood down and its own state
  //    was user-visibly wrong after a cancellation.
  //
  // Two things must be true at once, which is what makes this more than a
  // "stop publishing" flag:
  //   1. STOP HAMMERING — bounded probes, not one per tick.
  //   2. STILL RECOVER UNATTENDED — a user who re-subscribes must not have to
  //      touch the server. The original note said "until the operator takes
  //      action"; for a paid product that is not an acceptable resting state.
  //
  // So: on a lapse we record 'grace' through the STATE MACHINE (never a direct
  // store write — `persist()` fires `onStateChanged`, which refreshes the cert
  // stack's publisher_id + DDNS-host snapshots; bypassing it would leave those
  // stale) and back off exponentially. A probe that succeeds transitions back
  // to 'active'.
  //
  // 🔑 The backoff is PER-PROCESS on purpose. The persisted 'grace' survives a
  //    restart but the timer does not, so a reboot always re-probes
  //    immediately — a restarted server recovers at once, while a long-running
  //    one recovers within the window. That is also why the cost is "at most
  //    one rejected request per boot", not zero: the probe IS the recovery
  //    mechanism.
  //
  // ⚠ 'released' is deliberately NOT written here. The cloud is the authority
  //   over active ↔ grace ↔ released, and 'released' is destructive
  //   (`applyLifecycleUpdate` closes the history row and clears
  //   `current_handle`). Inferring it from an error code could strand a handle
  //   the user still owns. 'grace' is the reversible half.
  const LAPSE_BACKOFF_START_MS = 60 * 60 * 1000;      // 1h
  const LAPSE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;    // 6h
  let lapseProbeAfter = 0;   // 0 → probe on the next tick (fresh process)
  let lapseBackoffMs = 0;

  const recordLapse = async (): Promise<void> => {
    lapseBackoffMs = lapseBackoffMs === 0
      ? LAPSE_BACKOFF_START_MS
      : Math.min(lapseBackoffMs * 2, LAPSE_BACKOFF_MAX_MS);
    lapseProbeAfter = now() + lapseBackoffMs;
    const lifecycle = deps.applyLifecycle?.();
    if (!lifecycle) return;
    try {
      await lifecycle.applyLifecycleUpdate({ state: 'grace', now: now() });
    } catch (err) {
      // Never let a bookkeeping failure abort the tick — the backoff above
      // has already bounded the damage this exists to prevent.
      console.warn('[ddns-update-poll] could not record lapse state', err);
    }
  };

  const recordRecovery = async (): Promise<void> => {
    lapseBackoffMs = 0;
    lapseProbeAfter = 0;
    const lifecycle = deps.applyLifecycle?.();
    if (!lifecycle) return;
    try {
      await lifecycle.applyLifecycleUpdate({ state: 'active', now: now() });
      console.info('[ddns-update-poll] subscription recovered — resuming publishes');
    } catch (err) {
      console.warn('[ddns-update-poll] could not record recovery state', err);
    }
  };

  const loadTargets = async (
    handleState: HandleState | null,
  ): Promise<ReadonlyArray<DdnsUpdateTarget>> => {
    const byHandle = new Map<string, DdnsUpdateTarget>();
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

      const handleState = await deps.handleStateStore.load();
      // A lapsed handle stays a publish TARGET ('grace' is in
      // `activeHandleState`, because the handle is still the user's) — so the
      // gate has to be here, not in `loadTargets`.
      //
      // ⛔ The gate must NOT depend on the persisted state alone. Without a
      //    lifecycle applier (db-less / harness boots) — or if the write
      //    throws — the state stays 'active', the gate never engages, and the
      //    server hammers exactly as before. The rate limiting cannot be
      //    contingent on the bookkeeping succeeding; the in-process timer is
      //    the authority for THIS process.
      const inBackoff = lapseProbeAfter > 0;
      const lapsed = handleState?.subscription_state === 'grace' || inBackoff;
      if (lapsed && now() < lapseProbeAfter) return;

      const targets = await loadTargets(handleState);
      if (targets.length === 0) {
        // Not "nothing to do" until we have proof there is something to do —
        // see the warm-up note above.
        scheduleWarmup();
        return;
      }
      sawTargets = true;
      clearWarmup();

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
          // A publish that succeeds while we believed we were lapsed IS the
          // recovery signal — the cloud only accepts an entitled handle.
          if (lapsed) await recordRecovery();
          publishedKeys.add(targetKey(target));
          deps.ipStateStore.save({
            ip_v4: ipv4,
            last_published_at: result.data.ddns_record_updated_at,
            published_targets: publishedTargetsFromKeys(publishedKeys),
          });
          // A SUCCESSFUL publish was the only outcome here that logged
          // nothing, which made a working DDNS server and a silently-gated
          // one indistinguishable from the outside: the dedup `continue`
          // above, the `ddnsEnabled` pause, an empty target list and a
          // healthy no-op all produced the same empty log. An operator
          // asking "is my hostname still updating?" had only the zone to
          // look at — and the zone is shared with the cloud, which dedups,
          // so it cannot answer the question either. Volume is bounded by
          // the dedup check: steady state is zero lines, not one per tick.
          console.info(
            `[ddns-update-poll] published ${target.handle} → ${ipv4}` +
              ` (source ${target.source})`,
          );
          continue;
        }

        // Failure → log + retry next tick. The poller does NOT update
        // the IP state on failure; the next tick re-detects the change
        // + retries.
        if (result.error === 'ddns_subscription_lapsed') {
          await recordLapse();
        }
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
    // Return the work so registry shutdown drains an update that is already
    // in flight before its stores and signing identity are torn down.
    tick,
    fireImmediate: true,
    // The warm-up timer is detached from the registry's promise tracking, so
    // cancel it explicitly rather than let it fire into closed stores.
    onStop: () => {
      stopped = true;
      clearWarmup();
    },
  });
};
