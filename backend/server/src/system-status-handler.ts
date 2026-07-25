/** D-169 P1 — `system.status` rpc handler.
 *
 *  Bridge side-panel section #1 (N.5 / O-2) sources its rich server
 *  status snapshot from here on mount + each periodic refresh. The
 *  webclient server dashboard adopts the same rpc when it ships (O-7);
 *  the shape is the dashboard-shared baseline.
 *
 *  Composition shape (matches the other reserved-prefix handler
 *  bundles): a deps object the composer fills with optional sources
 *  (memory store for execution counters, ws-server handle for live
 *  client count, scheduler for queue depth, ask store for pending
 *  asks). Each counter that has no backing returns `null` — the side
 *  panel renders "—" for null fields, surfacing dbless / boot-race
 *  state without faking zeros. */

import type {
  HandlerSlice,
  ServerRpcRegistry,
  ServerSystemStatus,
} from '@recued/contracts';

import type { WsClient, WsServerHandle } from './ws-server.js';

/** Injected snapshot sources. Every field is optional so a partially-
 *  composed boot (dbless harness / lifecycle-recover window) still
 *  serves a meaningful status frame — absent counters surface as
 *  `null`. */
export interface SystemStatusDeps {
  /** Server display name (`SERVER_DISPLAY_NAME` env / config). */
  getServerDisplayName(): string;
  /** Server build version (`__RECUED_SERVER_VERSION__` define). */
  getServerVersion(): string;
  /** Whole seconds since the boot snapshot (`process.uptime()` or test
   *  override). */
  getUptimeSeconds(): number;
  /** Live WS roster — counts connected clients. Lazy thunk because
   *  `compose-listeners.ts` constructs the deps BEFORE the
   *  `ServerHandlerSet`'s `wsHandle` materialises (`createServerHandlerSet`
   *  receives the deps as input + returns the handle). Returning
   *  `undefined` resolves the snapshot to `ws_state: 'offline'`. */
  getWsServer?: () => WsServerHandle | undefined;
  /** Most-recent inbound timestamp tracker. Each authenticated rpc /
   *  register-frame updates this; the snapshot reads it. */
  getLastSyncAt(): number | null;
  /** Best-effort execution counters; absent → `null`. */
  countExecutionsInWindow?: (window_ms: number) => Promise<number | null>;
  /** Pending ask count via the notification block's
   *  `countOutstandingAsks`. Absent → `null`. */
  countPendingAsks?: () => Promise<number | null>;
  /** D-169 P1 Codex fold (Angle 6 MINOR) — durable paired-device count
   *  (includes offline pairs). Required by spec § N.5 #1: the snapshot
   *  must report the durable count separately from the live-connected
   *  count so the side panel can render "Serving 1/2" when one of two
   *  paired devices is offline. Absent → falls back to the connected
   *  count (degraded shape but still functional for the bridge solo-
   *  pair case). */
  getPairedClientCount?: () => Promise<number> | number;
  /** Scheduler queue depth (cron + reactive). Absent → `null`. */
  getScheduleQueueDepth?: () => Promise<number | null>;
  /** Recent error count (audit log `status='error'` rows in last 1h).
   *  Absent → `null`. */
  countRecentErrors?: () => Promise<number | null>;
  /** Clock — defaults to `Date.now`. */
  now?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** D-169 P1 — compose the status snapshot. Read-only over the injected
 *  sources; absent sources surface as `null` counters so the side panel
 *  can render "—" without faking zeros. */
export const handleSystemStatus = async (
  deps: SystemStatusDeps,
): Promise<{ status: ServerSystemStatus }> => {
  const now = (deps.now ?? Date.now)();

  // Roster — durable paired count + live connected count are reported
  // separately per spec § N.5 #1. The durable count comes from the
  // injected `getPairedClientCount` thunk (joins `client_tokens` etc.
  // at the composition layer); the connected count rides off the
  // live WS handle. An offline server (no WS handle yet) lands
  // `'offline'` so the side panel's "boot in progress" copy renders
  // truthfully.
  const wsServer = deps.getWsServer ? deps.getWsServer() : undefined;
  const connected = wsServer?.clientCount() ?? 0;
  const pairedCount = deps.getPairedClientCount
    ? await deps.getPairedClientCount()
    : connected;
  const ws_state: ServerSystemStatus['ws_state'] = wsServer
    ? connected > 0
      ? 'serving'
      : 'idle'
    : 'offline';

  // Counters — each fires only when its backing is wired. The await is
  // sequential rather than parallel because a partially-composed boot
  // typically supplies one source at a time (parallelism would obscure
  // which counter is missing in a stack trace).
  const executions_last_hour = deps.countExecutionsInWindow
    ? await deps.countExecutionsInWindow(HOUR_MS)
    : null;
  const executions_last_24h = deps.countExecutionsInWindow
    ? await deps.countExecutionsInWindow(DAY_MS)
    : null;
  const pending_asks = deps.countPendingAsks ? await deps.countPendingAsks() : null;
  const schedule_queue_depth = deps.getScheduleQueueDepth
    ? await deps.getScheduleQueueDepth()
    : null;
  const recent_error_count = deps.countRecentErrors
    ? await deps.countRecentErrors()
    : null;

  return {
    status: {
      name: deps.getServerDisplayName(),
      version: deps.getServerVersion(),
      uptime_seconds: deps.getUptimeSeconds(),
      paired_client_count: pairedCount,
      paired_client_connected: connected,
      ws_state,
      last_sync_at: deps.getLastSyncAt(),
      executions_last_hour,
      executions_last_24h,
      pending_asks,
      schedule_queue_depth,
      recent_error_count,
      snapshot_at: now,
    },
  };
};

type SystemMethods = 'system.status';

/** Compose the `system.*` handler slice. Always returns a slice (no
 *  upstream gate beyond what's already on `deps`) — the snapshot
 *  itself self-gates per-field via the `null` counter pattern. */
export const makeSystemStatusHandlers = (
  deps: SystemStatusDeps | undefined,
): HandlerSlice<ServerRpcRegistry, SystemMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['system.status'],
    handlers: {
      'system.status': async () => handleSystemStatus(deps),
    },
  };
};
