/** RPC handlers for `server.getBootstrap` / `stageBootstrap` /
 *  `requestRestart` / `getStatus` / `setPaused` / `getPauseState`.
 *
 *  Bootstrap fields live in the TOML `[bootstrap]` section and require
 *  a daemon restart to take effect. `stageBootstrap` validates a patch
 *  and writes it to the `server_state` table; `requestRestart` hands
 *  off to the supervisor (Phase A: just records an audit entry — the
 *  supervisor or operator performs the actual restart).
 *
 *  The kill switch is a first-class halt control — when active, every
 *  gated surface reports `halted` in `getStatus` and user-content
 *  writes are rejected. */

import type { StorageGate } from '@recued/storage-gate';
import type {
  HandlerSlice,
  PressureDetails,
  PressureSurfaceDetail,
  QualityGateSwitchStatus,
  ServerBootstrapStageResult,
  ServerBootstrapView,
  ServerRpcRegistry,
  ServerStatus,
  StorageState,
} from '@recued/contracts';
import { worstStorageState } from '@recued/contracts';
import type { BootstrapConfig } from '@recued/config';
import type { AuditLogStore } from '@recued/storage';
import type { ServerStateStore } from './server-state.js';
import type { PressureStateStore } from './pressure-state.js';
import type { WsClient } from './ws-server.js';

export interface BootstrapHandlerDeps {
  /** Live view of the bootstrap config loaded at process start. The
   *  handler never mutates this — staged patches live in SQLite until
   *  the next restart pulls them into the loaded config. */
  bootstrap: BootstrapConfig;
  /** Server-state store for staged patches + kill switch. */
  state: ServerStateStore;
  /** Every registered gated surface. Order matters — the first gate in
   *  the worst state wins for `ServerStatus.storage_state`. */
  gates?: StorageGate[];
  /** Server version string — surfaced in `getStatus`. Usually
   *  `package.json.version`. */
  version: string;
  /** Optional callback for `server.requestRestart`. Phase C: when
   *  present, this kicks off the drain pipeline (via
   *  `Lifecycle.requestDrain({ intent: 'restart', reason })`). Phase A
   *  compositions that only record the intent pass a simple logger
   *  and keep the Phase A semantics. */
  onRestartRequested?: (
    reason: string,
    /** Runs AFTER the drain has quiesced writers and CLOSED the database, before
     *  the process exits — the only window in a live server where the database
     *  FILE can be replaced. `drainOk` false means a writer may still hold it, so
     *  the callback must change nothing. Used by the update auto-revert. */
    onDrained?: (drainOk: boolean) => void | Promise<void>,
  ) => void;
  /** Optional predicate — when present, `handleRequestRestart`
   *  returns `{ accepted: false }` while a drain is already active.
   *  Absent → always `accepted: true` (Phase A compatibility). */
  isDraining?: () => boolean;
  /** Optional audit log — when wired, kill-switch toggles emit
   *  `crash_halt_toggle` activity entries. Absent → silent toggles
   *  (test / minimal compositions). */
  auditLog?: AuditLogStore;
  /** Phase B pressure-state store. When provided, every per-surface
   *  detail carries `entered_at` + `last_reclaim` fields from the
   *  persisted `server_state` rows — so the heartbeat + getStatus
   *  envelope match what Phase B writes across restart. Absent →
   *  the fields are omitted (Phase A behaviour). */
  pressureState?: PressureStateStore;
  /** D-188 — the master-pause side-effect seam. Fired on a real
   *  pause/resume TRANSITION (after the flag flips), wired by the serve
   *  layer (A4) to stop / re-arm the server's autonomous execution
   *  (cron / auto-run / housekeeping / reactive + watch). The flag is set
   *  BEFORE this runs so: on pause, schedulers stop after the gate begins
   *  denying; on resume, the gate stops denying before schedulers re-arm
   *  (a re-armed tick is never denied as paused). Absent (test / minimal
   *  compositions) ⇒ the flag still flips + audits, just no execution
   *  side-effect. */
  onPauseChanged?: (paused: boolean) => void | Promise<void>;
}

/** Whitelist of bootstrap fields a staged patch may touch. Mirrors
 *  `BootstrapConfig` keys except `data_path` — moving the data path
 *  mid-flight would split durable state across directories, so changing
 *  it requires an explicit migration command rather than a restart. */
const STAGEABLE_FIELDS: Array<keyof BootstrapConfig> = [
  'bind_host',
  'bind_port',
  'mcp_port',
  'webhook_port',
  'log_path',
];

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const validatePatch = (
  raw: unknown,
): { patch: Partial<BootstrapConfig>; errors: Record<string, string> } => {
  const errors = Object.create(null) as Record<string, string>;
  const patch: Partial<BootstrapConfig> = {};
  if (!isObject(raw)) {
    errors['<root>'] = 'patch must be a JSON object';
    return { patch, errors };
  }
  for (const [key, value] of Object.entries(raw)) {
    const k = key as keyof BootstrapConfig;
    if (!STAGEABLE_FIELDS.includes(k)) {
      errors[key] = `field '${key}' is not stageable (allowed: ${STAGEABLE_FIELDS.join(', ')})`;
      continue;
    }
    if (k === 'bind_host' || k === 'log_path') {
      if (typeof value !== 'string' || value.length === 0) {
        errors[key] = `${key} expects non-empty string`;
        continue;
      }
      patch[k] = value;
      continue;
    }
    if (k === 'bind_port' || k === 'mcp_port' || k === 'webhook_port') {
      if (
        typeof value !== 'number'
        || !Number.isInteger(value)
        || value < 0
        || value > 65535
      ) {
        errors[key] = `${key} expects integer in [0, 65535]`;
        continue;
      }
      patch[k] = value;
      continue;
    }
    // `data_path` is filtered upstream by STAGEABLE_FIELDS; falling out
    // of the explicit narrow branches is defensive only.
    errors[key] = `field '${key}' is not stageable`;
  }
  return { patch, errors };
};

/** Merge the staged patch into the live bootstrap view. Only fields
 *  the user actually staged appear in the pending diff; everything
 *  else reflects the currently-loaded config. */
export const handleGetBootstrap = (
  deps: BootstrapHandlerDeps,
): { config: ServerBootstrapView } => {
  const staged = deps.state.getStagedBootstrap() ?? {};
  return {
    config: {
      data_path: deps.bootstrap.data_path,
      bind_host: staged.bind_host ?? deps.bootstrap.bind_host,
      bind_port: staged.bind_port ?? deps.bootstrap.bind_port,
      mcp_port: staged.mcp_port ?? deps.bootstrap.mcp_port,
      webhook_port: staged.webhook_port ?? deps.bootstrap.webhook_port,
      log_path: staged.log_path ?? deps.bootstrap.log_path,
      pending_restart: Object.keys(staged).length > 0,
    },
  };
};

export const handleStageBootstrap = (
  deps: BootstrapHandlerDeps,
  args: { patch: unknown },
): ServerBootstrapStageResult => {
  const { patch, errors } = validatePatch(args.patch);
  if (Object.keys(errors).length > 0) {
    return { valid: false, errors, restart_required: false };
  }
  if (Object.keys(patch).length === 0) {
    // Clearing a staged patch is valid (no-op patch drops the row).
    deps.state.clearStagedBootstrap();
    return { valid: true, restart_required: false };
  }
  // Determine which fields would actually change — a patch that matches
  // the running config should not tell the user to restart.
  let anyChange = false;
  for (const [k, v] of Object.entries(patch)) {
    if (deps.bootstrap[k as keyof BootstrapConfig] !== v) {
      anyChange = true;
      break;
    }
  }
  deps.state.setStagedBootstrap(patch);
  return { valid: true, restart_required: anyChange };
};

export const handleRequestRestart = (
  deps: BootstrapHandlerDeps,
  args: { reason: string },
): { accepted: boolean } => {
  // Phase C: reject when a drain is already running (prevents the
  // operator from queueing contradictory restart/shutdown calls).
  // Phase A compositions without `isDraining` always accept.
  if (deps.isDraining?.()) {
    return { accepted: false };
  }
  // Hand off the request. When `onRestartRequested` is wired to the
  // Phase C lifecycle, this triggers the drain + supervisor handoff.
  // When wired to a no-op logger, this is still audit-only.
  deps.onRestartRequested?.(typeof args?.reason === 'string' ? args.reason : '');
  return { accepted: true };
};

export const buildPressureDetails = (
  gates: ReadonlyArray<StorageGate>,
  crashHaltActive: boolean,
  pressureState?: PressureStateStore,
): PressureDetails => {
  const per_surface: PressureSurfaceDetail[] = gates.map((g) => {
    const info = g.info();
    const pct =
      info.quota > 0
        ? Math.round((info.used / info.quota) * 1000) / 10
        : 0;
    const detail: PressureSurfaceDetail = {
      surface: info.surface,
      state: info.state,
      used_bytes: info.used,
      quota_bytes: info.quota,
      pct,
    };
    // Phase B: enrich with persisted pressure-window metadata when
    // the state store is wired. Omitted in Phase A composition roots.
    if (pressureState) {
      const enteredAt = pressureState.getEnteredAt(info.surface);
      if (enteredAt !== null) detail.entered_at = enteredAt;
      const lastReclaim = pressureState.getLastReclaim(info.surface);
      if (lastReclaim !== null) {
        detail.last_reclaim = {
          at: lastReclaim.at,
          bytes_freed: lastReclaim.bytes_freed,
          success: lastReclaim.success,
        };
      }
    }
    return detail;
  });
  // Stable ordering — renderers can key on surface name without
  // having to re-sort.
  per_surface.sort((a, b) => a.surface.localeCompare(b.surface));
  const worstGate = worstStorageState(per_surface.map((d) => d.state));
  const worst_state: StorageState = crashHaltActive ? 'halted' : worstGate;
  return { worst_state, per_surface };
};

export const handleGetStatus = (deps: BootstrapHandlerDeps): ServerStatus => {
  const crashHaltActive = deps.state.isCrashHaltActive();
  const pressure_details = buildPressureDetails(
    deps.gates ?? [],
    crashHaltActive,
    deps.pressureState,
  );
  return {
    version: deps.version,
    storage_state: pressure_details.worst_state,
    crash_halt_active: crashHaltActive,
    // D-188 — the master pause is a distinct axis (does not touch storage
    // state); the pill reads it for the neutral paused glyph.
    paused: deps.state.isPaused(),
    pressure_details,
  };
};

// The kill switch (crash-loop write-halt) is no longer a user-toggleable
// rpc — `server.setCrashHalt` / `server.getCrashHalt` are removed (no
// UI/MCP caller). The crash-loop detector engages it directly via
// `serverState.setCrashHalt` and halts the gates through the lifecycle's
// `onCrashHaltChange` seam (`compose-lifecycle.ts`); `server.getStatus`
// still surfaces `crash_halt_active`, and recovery is `server.resetCrashLoop`.

// ────────────────────────────────────────────────────────────────
// Master "Pause server" circuit-breaker (D-188)
// ────────────────────────────────────────────────────────────────

/** Engage / release the master pause. Flips the persisted flag, then
 *  fires the `onPauseChanged` seam (the serve layer's scheduler
 *  pause/resume + webhook closure) and audits — both ONLY on a real
 *  transition (idempotent re-assert is a silent no-op, like the kill
 *  switch). Async so the rpc response means "pause fully applied"; a
 *  failing side-effect is logged but never fails the flag flip (the
 *  authoritative state is the persisted flag the gate reads). */
export const handleSetPaused = async (
  deps: BootstrapHandlerDeps,
  args: { active: boolean },
): Promise<{ ok: true; active_since: number | null }> => {
  const wasActive = deps.state.isPaused();
  const active = !!args?.active;
  const result = deps.state.setPaused(active);
  if (wasActive !== active) {
    try {
      await deps.onPauseChanged?.(active);
    } catch (err) {
      // The flag is the source of truth (the gate + webhook listeners read
      // it live); a scheduler stop/re-arm hiccup must not fail the toggle.
      console.warn('[pause] onPauseChanged side-effect failed', err);
    }
    if (deps.auditLog) {
      void deps.auditLog.logActivity({
        activity_id: '',
        timestamp: Date.now(),
        action: 'server_pause_toggle',
        target: 'server',
        detail: active ? 'paused' : 'resumed',
      }).catch(() => { /* best-effort */ });
    }
  }
  return { ok: true, active_since: result.active_since };
};

export const handleGetPauseState = (
  deps: BootstrapHandlerDeps,
): { active: boolean; since?: number } => {
  const active = deps.state.isPaused();
  const since = deps.state.pausedSince();
  return since !== null ? { active, since } : { active };
};

// ────────────────────────────────────────────────────────────────
// Quality-delegation kill-switch — Switch A/B (D-202 §4)
// ────────────────────────────────────────────────────────────────

/** Engage / release one quality kill-switch. `which: 'all'` is Switch A (pause
 *  BOTH delegation axes → full manual approve); `which: 'quality'` is Switch B
 *  (pause the quality axis only → per-artifact review, authorization grants stay
 *  live). A GATE-OVERRIDE (§12.12): the persisted flag is the source of truth
 *  the (later) quality-gate pass reads to suppress the matching delegation — it
 *  NEVER touches learner state, so it is instantly + losslessly reversible.
 *  Audits ONLY on a real transition (an idempotent re-assert is a silent no-op,
 *  like the master pause). Owner-only by transport (`server.*` is bearer-gated,
 *  never MCP-bridged). */
export const handleSetQualitySwitch = async (
  deps: BootstrapHandlerDeps,
  args: { which: 'all' | 'quality'; active: boolean },
): Promise<QualityGateSwitchStatus> => {
  // No safe default for a kill-switch axis — reject an unknown `which` rather
  // than silently toggling the wrong (or a coerced) one.
  if (args?.which !== 'all' && args?.which !== 'quality') {
    throw new Error(
      `server.setQualitySwitch: 'which' must be 'all' | 'quality' (got ${String(args?.which)})`,
    );
  }
  const which = args.which;
  const active = !!args.active;
  const before = deps.state.getQualityGateSwitches();
  const wasActive = which === 'all' ? before.all_paused : before.quality_paused;
  const status = deps.state.setQualityGateSwitch(which, active);
  if (wasActive !== active && deps.auditLog) {
    void deps.auditLog.logActivity({
      activity_id: '',
      timestamp: Date.now(),
      action: 'quality_gate_switch_toggle',
      target: 'server',
      detail: `${which}:${active ? 'paused' : 'resumed'}`,
    }).catch(() => { /* best-effort */ });
  }
  return status;
};

/** Current two-switch status for the #contracts control's initial render. */
export const handleGetQualitySwitches = (
  deps: BootstrapHandlerDeps,
): QualityGateSwitchStatus => deps.state.getQualityGateSwitches();

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type BootstrapMethods =
  | 'server.getBootstrap'
  | 'server.stageBootstrap'
  | 'server.requestRestart'
  | 'server.getStatus'
  | 'server.setPaused'
  | 'server.getPauseState'
  | 'server.setQualitySwitch'
  | 'server.getQualitySwitches';

export const makeBootstrapHandlers = (
  deps: BootstrapHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, BootstrapMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'server.getBootstrap',
      'server.stageBootstrap',
      'server.requestRestart',
      'server.getStatus',
      'server.setPaused',
      'server.getPauseState',
      'server.setQualitySwitch',
      'server.getQualitySwitches',
    ],
    handlers: {
      'server.getBootstrap': async () => handleGetBootstrap(deps),
      'server.stageBootstrap': async (args) => handleStageBootstrap(deps, args),
      'server.requestRestart': async (args) => handleRequestRestart(deps, args),
      'server.getStatus': async () => handleGetStatus(deps),
      'server.setPaused': async (args) => handleSetPaused(deps, args),
      'server.getPauseState': async () => handleGetPauseState(deps),
      'server.setQualitySwitch': async (args) => handleSetQualitySwitch(deps, args),
      'server.getQualitySwitches': async () => handleGetQualitySwitches(deps),
    },
  };
};
