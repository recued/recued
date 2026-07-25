/** Server heartbeat emitter composer (Tier 3 — half-open detection).
 *
 *  Wires the periodic `server_heartbeat` push that the D-109 ws-server
 *  handle (`broadcastServerHeartbeat`) has exposed-but-never-fired. The
 *  push lands on every PAIRED client (extensions/bridges + webclients —
 *  see `broadcastServerHeartbeat`); the webclient consumes its mere
 *  arrival as a liveness signal, the Bridge pill consumes the payload.
 *
 *  ── Why a server-PUSHED heartbeat ───────────────────────────────────
 *  A WebSocket can be HALF-OPEN: a restarting server accepts the socket
 *  (the client reads `connected`) before its rpc/warehouse layer is
 *  ready. Neither the socket-down fast-fail nor the offline banner fires
 *  in that window, so every rpc rides its full 30s timeout. Beats are the
 *  clean discriminator: their ARRIVAL proves the process is actually
 *  responsive (even on a half-open socket); their ABSENCE while connected
 *  means it is not. Recovery is automatic (the next beat = healthy), so a
 *  client can fast-fail safely without a probe rpc.
 *
 *  ── The READY gate (the load-bearing rule) ──────────────────────────
 *  The tick emits NOTHING unless the lifecycle is `running` (post-boot
 *  DDL, warehouse open). A half-open restart sits in `booting` → emits no
 *  beats → the client's stale timer fires. Once the boot completes and
 *  the state flips to `running`, beats resume → the client recovers. This
 *  is what makes the absence-of-beats signal trustworthy, so do NOT relax
 *  it to emit during `booting` / `draining` / etc.
 *
 *  Registered as a `kind: 'timer'` on the shared `backgroundServices`
 *  registry at {@link SERVER_HEARTBEAT_INTERVAL_MS} (5s). `fireImmediate`
 *  is `false` — an immediate tick at registration would run before
 *  `markBooted`, so it would be a no-op anyway; the first beat lands on
 *  the next interval, once `running`. The registry's drain + fallback
 *  shutdown paths stop it (the `'timer'` kind is swept by
 *  `lifecycle.drainSteps.stop_timers`). */

import {
  SERVER_HEARTBEAT_INTERVAL_MS,
  isLifecycleAcceptingRpc,
  type LifecycleStatus,
  type ServerHeartbeatSnapshot,
} from '@recued/contracts';
import type { BackgroundServiceRegistry } from './wire-background-services.js';

/** The running-server health the emitter merges into the snapshot so the pill
 *  can show **paused** (kill-switch) + **attention** (storage pressure). Both
 *  are conditions on a `running` server, so they ride the strict ready-gate
 *  without affecting Tier 3 (a draining server's transient "busy" stays the
 *  connection chip's domain). Built from the same `handleGetStatus` sources;
 *  absent on a db-less boot. (Collection-error attention is a deeper source —
 *  deferred; the pill simply won't show that sub-signal yet.) */
export type ServerHealthSnapshot = Pick<
  ServerHeartbeatSnapshot,
  'crash_halt_active' | 'paused' | 'pressure_details'
>;

export interface ComposeServerHeartbeatEmitterDeps {
  /** Background-services registry (typically the module singleton). The
   *  composer registers a `kind: 'timer'` entry. */
  registry: BackgroundServiceRegistry;
  /** Bound `wsServer.broadcastServerHeartbeat`. Fans the snapshot out to
   *  every paired client; a zero-client server is a cheap no-op loop. */
  broadcast: (payload: ServerHeartbeatSnapshot) => void;
  /** Live lifecycle snapshot. The tick reads `.state` for the READY gate
   *  and rides `uptime_s` / `restart_count` along for the pill. Returns
   *  `undefined` on a db-less / no-lifecycle boot → no beats (correct:
   *  such boots have no warehouse + no paired clients). */
  getLifecycleSnapshot: () => LifecycleStatus | undefined;
  /** Stable server id for the snapshot (the signing-identity fingerprint).
   *  `null` is allowed — the webclient ignores it (arrival is the signal)
   *  and the pill hides when it is null. */
  getServerId: () => string | null;
  /** Running-server health (kill-switch + pressure) merged into the snapshot
   *  for the pill's paused/attention states. Absent → the pill stays a plain
   *  green "running" (db-less boot, or before the sources are wired). */
  getServerHealth?: () => ServerHealthSnapshot | undefined;
  /** Polling cadence. Defaults to {@link SERVER_HEARTBEAT_INTERVAL_MS}. */
  intervalMs?: number;
  /** Clock override for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export const composeServerHeartbeatEmitter = (
  deps: ComposeServerHeartbeatEmitterDeps,
): void => {
  const intervalMs = deps.intervalMs ?? SERVER_HEARTBEAT_INTERVAL_MS;
  const now = deps.now ?? Date.now;

  const tick = (): void => {
    try {
      const snapshot = deps.getLifecycleSnapshot();
      // READY gate — emit only while the server would actually accept rpcs.
      // Reusing the canonical predicate (the same one the rpc gate uses)
      // keeps "a beat means the server is responsive" honest by definition.
      if (!snapshot || !isLifecycleAcceptingRpc(snapshot.state)) return;

      const payload: ServerHeartbeatSnapshot = {
        server_id: deps.getServerId(),
        last_seen_at: now(),
        lifecycle_state: snapshot.state,
        uptime_s: snapshot.uptime_s,
        restart_count: snapshot.restart_count,
        supervisor_mode: snapshot.supervisor_mode,
      };
      // Merge running-server health (kill-switch → paused; pressure →
      // attention). `crash_halt_active: false` is meaningful (NOT killed), so
      // include it whenever health resolves, not just when truthy.
      //
      // ISOLATED try — A2 enrichment is best-effort and must NEVER suppress the
      // base Tier 3 liveness beat. `getServerHealth` walks the storage gates;
      // if one hiccups, drop only the health fields and still broadcast, so a
      // non-critical status-read failure can't falsely stall a healthy server.
      let health: ServerHealthSnapshot | undefined;
      try {
        health = deps.getServerHealth?.();
      } catch (err) {
        console.warn('[server-heartbeat] health read failed; base beat only', err);
      }
      if (health) {
        payload.crash_halt_active = health.crash_halt_active;
        // D-188 — surface the master pause so the pill renders the neutral
        // paused glyph (distinct from the kill-switch red).
        payload.paused = health.paused;
        payload.pressure_details = health.pressure_details;
      }
      deps.broadcast(payload);
    } catch (err) {
      // A thrown tick would bubble to setInterval's default handler and
      // become an unhandled rejection — swallow + log like the sibling
      // background tickers.
      console.warn('[server-heartbeat] tick failed', err);
    }
  };

  deps.registry.registerInterval({
    name: 'server-heartbeat-emitter',
    intervalMs,
    tick,
    fireImmediate: false,
  });
};
