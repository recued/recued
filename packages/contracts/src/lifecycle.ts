/** Lifecycle + supervisor shared wire types (Phase C).
 *
 *  One set of types reused by the heartbeat envelope, the
 *  `server.getLifecycleState` rpc response, and the drain orchestrator's
 *  observability surface — so the extension renders from one source of
 *  truth. Kept in contracts (not in backend/server) because the wire
 *  shape is cross-boundary.
 *
 *  `SupervisorMode` is intentionally narrow (5 concrete modes + the
 *  `'auto'` sentinel for config input). The server resolves `'auto'`
 *  to a concrete mode at boot via env detection; every wire surface
 *  (heartbeat, rpc) emits the resolved mode. */

/** Linear state machine. Transitions:
 *
 *   booting → running → draining → (restarting | shutting_down | crashed)
 *
 *  No re-entry. A second drain request while `draining` coalesces into
 *  the in-flight Promise. `crashed` is reserved for the unhandled-
 *  exception path where the process is about to exit 1 without running
 *  the drain pipeline. */
export type LifecycleState =
  | 'booting'
  | 'running'
  | 'draining'
  | 'restarting'
  | 'shutting_down'
  | 'crashed';

/** Why a drain started — picked at drain start, not at supervisor
 *  handoff. Determines which exit code the supervisor receives. */
export type DrainIntent = 'restart' | 'shutdown';

/** Fixed pipeline step names. The orchestrator runs them in this exact
 *  order; a timed-out step is recorded as `aborted` but the pipeline
 *  continues.
 *
 *  Phase D inserts `pause_collections` between `stop_accepting_rpc`
 *  and `pause_scheduler` — collections must stop first so in-flight
 *  scheduled ticks reading from the warehouse get a clean shutdown
 *  error rather than dangling on a half-closed IMAP socket or
 *  fs.watch handle. */
export const DRAIN_STEP_NAMES = [
  'flip_to_draining',
  'stop_accepting_rpc',
  'pause_collections',
  'pause_scheduler',
  'await_inflight',
  'close_ws',
  'stop_timers',
  'close_cascade',
  'flush_audit',
  'close_db',
  'release_lock',
] as const;

export type DrainStepName = (typeof DRAIN_STEP_NAMES)[number];

/** Live drain state — streamed onto the heartbeat envelope every beat
 *  while `active === true`. Operators watch `current_step` + the
 *  `completed_steps` / `aborted_steps` arrays to see drain progress
 *  without polling rpc. */
export interface DrainState {
  /** True from `requestDrain` until the last step resolves (or aborts). */
  active: boolean;
  /** Unix-ms timestamp the drain started. Present iff `active === true`. */
  started_at?: number;
  /** Free-form reason the caller supplied (signal name, rpc reason,
   *  etc.). Present iff `active === true`. */
  reason?: string;
  /** Restart vs shutdown — drives supervisor handoff code. Present iff
   *  `active === true`. */
  intent?: DrainIntent;
  /** Currently-executing step. Advances monotonically through
   *  `DRAIN_STEP_NAMES`. Present iff `active === true`. */
  current_step?: DrainStepName;
  /** Steps that finished cleanly. Append-only during the drain. */
  completed_steps: DrainStepName[];
  /** Steps that timed out. Append-only. A step appears in at most one
   *  of `completed_steps` / `aborted_steps`. */
  aborted_steps: DrainStepName[];
}

/** One crash record. Written to `server_state.lifecycle.last_crash`
 *  by the unhandled-exception handler. Cleared on reset via
 *  `server.resetCrashLoop` or on auto-reset after sustained uptime. */
export interface LifecycleLastCrash {
  /** Unix-ms timestamp of the crash. */
  at: number;
  /** Error message (best-effort — may be truncated for very long
   *  stacks). */
  reason: string;
  /** Exit code the process used. Typically 1 for uncaught exceptions. */
  exit_code: number;
}

/** Supervisor mode. Six concrete runtimes plus the `'auto'` sentinel
 *  used only as config input — resolved at boot to a concrete mode.
 *
 *  `docker-thin` is the D-178 `:managed` self-updating image: the baked
 *  launcher (not the docker restart policy) is the supervisor, so it keeps the
 *  STANDARD exit codes — `restart` stays `3` (NOT remapped to `1` like plain
 *  `docker`) so the launcher's verify-and-exec loop can tell a restart-intent
 *  from a crash from a clean shutdown. */
export type SupervisorMode =
  | 'auto'
  | 'native'
  | 'systemd'
  | 'launchd'
  | 'docker'
  | 'docker-thin'
  | 'dev';

/** The concrete modes the wire surfaces emit (post-auto-resolution). */
export type ResolvedSupervisorMode = Exclude<SupervisorMode, 'auto'>;

/** Read-only snapshot returned by `server.getLifecycleState`. Mirrors
 *  the heartbeat envelope's lifecycle fields. Cheap to compute — two
 *  `server_state` reads + in-memory state. */
export interface LifecycleStatus {
  state: LifecycleState;
  /** Unix-ms timestamp of the `booting → running` transition. */
  boot_at: number;
  /** Seconds since `boot_at`. Recomputed on every call — the server
   *  doesn't store this; callers should treat it as a live reading. */
  uptime_s: number;
  /** Count of crashed/unclean shutdowns on this `data_path` since the
   *  last explicit reset. Auto-decrements after sustained uptime. */
  restart_count: number;
  /** True iff a prior `stageBootstrap` patch is waiting for a restart
   *  to apply, OR a SIGHUP reload diff included bootstrap-only keys. */
  restart_pending: boolean;
  /** Most recent crash, if any. Cleared by `server.resetCrashLoop`. */
  last_crash?: LifecycleLastCrash;
  /** Live drain state. Omitted when `state !== 'draining'`. */
  drain?: DrainState;
  /** Resolved supervisor mode the daemon detected at boot. */
  supervisor_mode: ResolvedSupervisorMode;
}

/** Rank lifecycle states from least to most constrained. Used by
 *  callers that need to compare or gate on "at least draining" etc.
 *  Higher rank = further along the shutdown path. */
export const LIFECYCLE_STATE_RANK: Readonly<Record<LifecycleState, number>> = {
  booting: 0,
  running: 1,
  draining: 2,
  restarting: 3,
  shutting_down: 3,
  crashed: 4,
};

/** True when the state should accept new rpc calls. Everything other
 *  than `running` either isn't ready yet (`booting`) or is already
 *  winding down. Lifecycle-surface methods (`server.getStatus`,
 *  `server.getLifecycleState`, `server.resetCrashLoop`) carry their
 *  own allowlist and bypass this gate. */
export const isLifecycleAcceptingRpc = (state: LifecycleState): boolean =>
  state === 'running';

/** Compute seconds of uptime from a unix-ms `boot_at` timestamp.
 *  Returns 0 if `boot_at` is 0/missing/in-the-future. Kept as a helper
 *  so every caller (rpc handler, heartbeat builder, test harness)
 *  computes uptime identically. */
export const computeUptimeSeconds = (
  bootAt: number,
  now: number = Date.now(),
): number => {
  if (!bootAt || bootAt > now) return 0;
  return Math.max(0, Math.floor((now - bootAt) / 1000));
};
