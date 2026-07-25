/** Phase G (D-109) — server status pill shared logic.
 *
 *  One shared `computePillState(snapshot)` so the popup + sidebar pill
 *  renderers compute severity identically. Same pattern D-104 used for
 *  `buildPressureDetails` — the single source of truth for the "what
 *  color is the dot, what word is the label" decision lives here, not
 *  duplicated per surface.
 *
 *  Severity order (most → least severe):
 *    red      — kill switch active OR lifecycle `crashed` OR any gate halted
 *    orange   — lifecycle draining / restarting / shutting_down OR writes_blocked
 *    amber    — any gate pressure_managed OR any collection in `error`
 *    gray     — no heartbeat received in ≥ HEARTBEAT_STALE_MS
 *    green    — steady-state running
 *
 *  Ties resolve in listed order — kill-switch wins over lifecycle,
 *  lifecycle wins over pressure. */

import type { LifecycleState, ResolvedSupervisorMode } from './lifecycle.js';
import type { PressureDetails, StorageState } from './pressure.js';
import type { CollectionHealth } from './collections.js';

/** Max age (ms) a snapshot can be before the pill turns gray/offline. */
export const HEARTBEAT_STALE_MS = 30_000;

/** Cadence (ms) the server pushes `server_heartbeat` at while it is
 *  READY (lifecycle `running`). Chosen so a client's stale window can sit
 *  at a small multiple of it (the webclient uses 3× — see
 *  `WEBCLIENT_HEARTBEAT_STALE_MS`) and still be comfortably tighter than
 *  the pill's generous {@link HEARTBEAT_STALE_MS}. The server emits NOTHING
 *  until `running`, so a half-open restart (socket accepted, rpc/warehouse
 *  layer not yet up) is detectable purely by the ABSENCE of beats. */
export const SERVER_HEARTBEAT_INTERVAL_MS = 5_000;

/** Composite snapshot fed into the pill computer. The ext caches one of
 *  these under `chrome.storage.session('recued.server-heartbeat')` and
 *  re-renders every time it updates. All fields optional so partial
 *  heartbeats (e.g. a pre-Phase-D server that doesn't emit `collections`)
 *  degrade gracefully. */
export interface ServerHeartbeatSnapshot {
  /** Stable UUID of the paired server. Null when the pill is asked to
   *  render without a paired server — the caller should hide the pill
   *  entirely in that case. */
  server_id: string | null;
  /** Display name the server set on register. */
  server_name?: string;
  /** Unix-ms of the most recent heartbeat that arrived. Used for the
   *  stale-offline check. `0` before the first tick. */
  last_seen_at: number;
  /** Optional — heartbeat ride-alongs. */
  lifecycle_state?: LifecycleState;
  uptime_s?: number;
  restart_count?: number;
  supervisor_mode?: ResolvedSupervisorMode;
  crash_halt_active?: boolean;
  crash_halt_reason?: 'user' | 'crash_loop' | 'manual';
  /** D-188 — the master "Pause server" circuit-breaker is engaged. A
   *  DISTINCT axis from `crash_halt_active` (the crash-loop write-halt):
   *  pause is a user-intended halt of execution + doors, rendered as a
   *  neutral pause glyph (NOT the red of a kill switch / crash). */
  paused?: boolean;
  pressure_details?: PressureDetails;
  collections?: readonly CollectionHealth[];
  /** True iff a reclaim is in-flight on any surface right now. The
   *  server doesn't currently emit this on heartbeat — reserved for a
   *  future extension that pipes the in-flight reclaim map through. */
  reclaim_in_flight?: boolean;
}

/** Labels the pill renderer uses. These words show up verbatim in the
 *  popup + sidebar — change carefully. */
export type PillLabel =
  | 'offline'
  | 'paused'
  | 'busy'
  | 'attention'
  | 'running';

export type PillDot = 'gray' | 'red' | 'orange' | 'amber' | 'green';

/** Optional non-dot indicator. D-188 — the master "Pause server" state
 *  renders a neutral PAUSE glyph instead of a severity dot, so it reads
 *  as a deliberate user state, not an error color. The renderer draws it
 *  token-colored (theme-adapting); `dot` is then a structural fallback. */
export type PillGlyph = 'pause';

/** Computed pill state. The renderer consumes dot + label; `uptime`
 *  is only used when the label is `running` (green) to render
 *  "Server · 12h". */
export interface PillState {
  dot: PillDot;
  /** D-188 — when set, the renderer draws this glyph in place of the
   *  severity `dot` (today only the master-pause state, `'pause'`). */
  glyph?: PillGlyph;
  label: PillLabel;
  /** Seconds of uptime. Renderers format as `12h`, `3d`, etc. `0`
   *  when unknown. */
  uptime_s: number;
  /** Short accessibility string, e.g. `"Server paused — kill switch
   *  is on"`. Feeds `aria-label`. */
  aria: string;
}

const worstGateRank: Readonly<Record<StorageState, number>> = {
  running: 0,
  pressure_managed: 1,
  writes_blocked: 2,
  halted: 3,
};

const worstGate = (details: PressureDetails | undefined): StorageState => {
  if (!details) return 'running';
  return details.worst_state;
};

const anyCollectionError = (
  collections: readonly CollectionHealth[] | undefined,
): boolean => {
  if (!collections) return false;
  for (const c of collections) if (c.state === 'error') return true;
  return false;
};

/** Pure decision function. Same inputs → same output. No side effects,
 *  no Date.now() reads — callers pass `now` for deterministic tests. */
export const computePillState = (
  snapshot: ServerHeartbeatSnapshot,
  now: number = Date.now(),
): PillState => {
  const uptime = snapshot.uptime_s ?? 0;

  // Offline wins over everything else — if we haven't heard from the
  // server in HEARTBEAT_STALE_MS, we don't trust the other fields.
  if (
    snapshot.last_seen_at === 0 ||
    now - snapshot.last_seen_at >= HEARTBEAT_STALE_MS
  ) {
    return {
      dot: 'gray',
      label: 'offline',
      uptime_s: uptime,
      aria: 'Server offline — no heartbeat received recently',
    };
  }

  // Red tier: kill switch OR crashed OR any gate halted.
  if (snapshot.crash_halt_active) {
    const reason =
      snapshot.crash_halt_reason === 'crash_loop'
        ? 'Server paused — crash loop detected'
        : 'Server paused — kill switch is on';
    return { dot: 'red', label: 'paused', uptime_s: uptime, aria: reason };
  }
  if (snapshot.lifecycle_state === 'crashed') {
    return {
      dot: 'red',
      label: 'paused',
      uptime_s: uptime,
      aria: 'Server paused — crashed and awaiting restart',
    };
  }
  const gate = worstGate(snapshot.pressure_details);
  if (gate === 'halted') {
    return {
      dot: 'red',
      label: 'attention',
      uptime_s: uptime,
      aria: 'Server attention — one or more surfaces halted',
    };
  }

  // D-188 — master "Pause server" tier. A user-intended halt of execution
  // + doors, rendered as a neutral PAUSE glyph (NOT red — red is reserved
  // for kill switch / crash / halt above). Ranked BELOW the red failure
  // tier (a crash while paused still surfaces red) but ABOVE pressure
  // attention (a paused server reads as "paused" first; nothing is running
  // to relieve pressure anyway). `dot` is a structural fallback only — the
  // renderer draws the glyph.
  if (snapshot.paused) {
    return {
      dot: 'amber',
      glyph: 'pause',
      label: 'paused',
      uptime_s: uptime,
      aria: 'Server paused — execution halted; open to resume',
    };
  }

  // Orange tier: draining / restarting / shutting_down OR writes_blocked.
  const lifecycle = snapshot.lifecycle_state;
  if (
    lifecycle === 'draining' ||
    lifecycle === 'restarting' ||
    lifecycle === 'shutting_down'
  ) {
    return {
      dot: 'orange',
      label: 'busy',
      uptime_s: uptime,
      aria: `Server busy — ${lifecycle}`,
    };
  }
  if (gate === 'writes_blocked') {
    return {
      dot: 'orange',
      label: 'attention',
      uptime_s: uptime,
      aria: 'Server attention — writes blocked by pressure',
    };
  }

  // Amber tier: pressure_managed OR any collection error.
  if (worstGateRank[gate] >= worstGateRank.pressure_managed) {
    return {
      dot: 'amber',
      label: 'attention',
      uptime_s: uptime,
      aria: 'Server attention — pressure managed on one or more surfaces',
    };
  }
  if (anyCollectionError(snapshot.collections)) {
    return {
      dot: 'amber',
      label: 'attention',
      uptime_s: uptime,
      aria: 'Server attention — collection in error state',
    };
  }
  if (snapshot.reclaim_in_flight) {
    return {
      dot: 'orange',
      label: 'busy',
      uptime_s: uptime,
      aria: 'Server busy — reclaim in progress',
    };
  }

  // Green — steady state.
  return {
    dot: 'green',
    label: 'running',
    uptime_s: uptime,
    aria: 'Server running',
  };
};

/** Format uptime for the pill label. 60s → `1m`, 3600s → `1h`,
 *  86400s → `1d`. Always one unit — renderers want tight copy. */
export const formatPillUptime = (uptimeS: number): string => {
  if (uptimeS < 60) return `${Math.max(0, Math.floor(uptimeS))}s`;
  if (uptimeS < 3600) return `${Math.floor(uptimeS / 60)}m`;
  if (uptimeS < 86400) return `${Math.floor(uptimeS / 3600)}h`;
  return `${Math.floor(uptimeS / 86400)}d`;
};
