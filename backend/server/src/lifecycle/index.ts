/** Lifecycle composition root (Phase C).
 *
 *  Brings together the state store + state machine + supervisor +
 *  drain orchestrator + crash-loop detector + signal listener +
 *  config watcher + rpc handler slice into one `Lifecycle` surface
 *  that `bin.ts` composes with the rest of the server graph.
 *
 *  `createLifecycle` is the one-stop factory. `bin.ts` calls it after
 *  the lower deps (db, runtimeConfig, bootstrapConfig, auditLog) are
 *  ready; the returned `Lifecycle` exposes:
 *
 *    - `install()` / `uninstall()` — wire signals + start config
 *      watcher (if enabled)
 *    - `markBooted()` — flip booting → running after every boot step
 *      resolves
 *    - `requestDrain()` / `requestShutdown()` — convenience wrappers
 *      so bin.ts + bootstrap-handler can trigger a drain without
 *      reaching through `lifecycle.drain.drain(...)`
 *    - `getSnapshot()` — for rpc + heartbeat
 *    - Access to every subcomponent for granular composition
 */

import type Database from 'better-sqlite3';
import type {
  BootstrapConfig,
  Distribution,
  RuntimeConfig,
  RuntimeConfigStore,
} from '@recued/config';
import type {
  DrainIntent,
  LifecycleLastCrash,
  LifecycleStatus,
  ResolvedSupervisorMode,
  SupervisorMode,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import {
  createInstanceLock,
  type InstanceLock,
} from './instance-lock.js';
import {
  createLifecycleStateMachine,
  createLifecycleStateStore,
  buildLifecycleSnapshot,
  type LifecycleStateMachine,
  type LifecycleStateStore,
} from './lifecycle-state.js';
import {
  createSupervisor,
  resolveSupervisorMode,
  type Supervisor,
} from './supervisor.js';
import {
  createDrainOrchestrator,
  type DrainOrchestrator,
  type DrainStepFn,
  type DrainResult,
} from './drain-orchestrator.js';
import {
  createCrashLoopDetector,
  createCrashLoopPersistence,
  type CrashLoopDetector,
  type CrashLoopPersistence,
  type CrashLoopConfig,
} from './crash-loop.js';
import {
  createSignalListener,
  type SignalListener,
} from './signal-listener.js';
import {
  createConfigWatcher,
  type ConfigWatcher,
  type ReloadInfo,
} from './config-watcher.js';
import {
  makeLifecycleHandlers,
  type LifecycleHandlerDeps,
} from './lifecycle-handler.js';
import type { ServerStateStore } from '../server-state.js';
import type { DrainStepName } from '@recued/contracts';

export type LifecycleLogger = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>,
) => void;

export interface CreateLifecycleOptions {
  // ── Core deps ────────────────────────────────────────────────
  db: Database.Database;
  /** Data path — used for the default lock-file location. */
  dataPath: string;
  /** Explicit lock-file path override. Empty string / undefined falls
   *  back to `{dataPath}/recued-server.lock`. */
  lockPath?: string;
  /** Bind port written into the lock file + detected by supervisor mode. */
  bindPort: number;
  /** Server version — surfaces in heartbeat envelope + getLifecycleState. */
  version: string;

  // ── Config ──────────────────────────────────────────────────
  configPath: string | null;
  distribution: Distribution;
  initialBootstrap: BootstrapConfig;
  initialRuntime: RuntimeConfig;
  runtimeStore: RuntimeConfigStore;

  // ── Persistence ─────────────────────────────────────────────
  /** Existing server-state store (kill switch, staged bootstrap,
   *  pressure state). Lifecycle reuses it for kill-switch release
   *  during crash-loop reset. */
  serverState: ServerStateStore;

  // ── Observability ───────────────────────────────────────────
  log?: LifecycleLogger;
  auditLog?: AuditLogStore;

  // ── Drain wiring ────────────────────────────────────────────
  /** Caller-wired drain step functions. Keys are `DrainStepName`
   *  values; missing entries → step is skipped. */
  drainSteps?: Partial<Record<DrainStepName, DrainStepFn>>;
  /** Live in-flight count for `await_inflight` step. */
  getInFlightCount?: () => number;

  // ── Supervisor / crash-loop config ──────────────────────────
  /** Override the supervisor-mode auto-detect. `undefined` → use
   *  `supervisor.mode` from runtime store (default 'auto'). */
  supervisorMode?: SupervisorMode;
  crashLoopConfig?: Partial<CrashLoopConfig>;

  // ── Config watcher ──────────────────────────────────────────
  watchConfigFile?: boolean;

  // ── Upgrade rollback wiring (Phase F, D-108) ────────────────
  /** Optional callback fired when the crash-loop detector trips.
   *  Phase F wires this to write `crash-loop.flag` next to the DB
   *  so the pre-boot `rollback.mjs` can decide whether to restore
   *  the previous version. Absent = no rollback integration. */
  onCrashLoopDetected?: () => void;

  /** Applies the kill-switch state to the storage gates — the call that
   *  ACTUALLY halts / resumes writes. Fired `true` when the crash-loop
   *  detector engages the kill switch, `false` on reset. Wired at
   *  composition to `gate.halt('crash_halt')` / `gate.resume()` over the
   *  gate registry. Absent (a gateless test harness) ⇒ the state flag flips
   *  but writes are not gated. Before this seam the ONLY `gate.halt` lived
   *  in the (now-removed) `server.setCrashHalt` rpc, so a crash-loop
   *  engaged the flag WITHOUT halting writes — the write-protection gap this
   *  closes. */
  onCrashHaltChange?: (active: boolean) => void;

  // ── Injected for tests ──────────────────────────────────────
  now?: () => number;
  exit?: (code: number) => void;
  processRef?: NodeJS.Process;
}

export interface Lifecycle {
  readonly store: LifecycleStateStore;
  readonly machine: LifecycleStateMachine;
  readonly drain: DrainOrchestrator;
  readonly crashLoop: CrashLoopDetector;
  readonly supervisor: Supervisor;
  readonly signals: SignalListener;
  readonly configWatcher: ConfigWatcher;
  readonly lock: InstanceLock;
  readonly crashLoopPersistence: CrashLoopPersistence;
  readonly handlerSlice: ReturnType<typeof makeLifecycleHandlers>;

  /** Live status snapshot — for heartbeat emitter + getLifecycleState. */
  getSnapshot(): LifecycleStatus;

  /** Flip `booting → running`. Called by bin.ts after every subsystem
   *  finishes its boot step. Writes boot_at + emits `server_boot` audit. */
  markBooted(): void;

  /** Trigger a drain. Used by `server.requestRestart` (via
   *  bootstrap-handler) and `server.requestShutdown` (via
   *  lifecycle-handler) and by signal-listener on SIGTERM/SIGINT. */
  requestDrain(opts: { intent: DrainIntent; reason: string; timeoutMs?: number }): Promise<DrainResult>;

  /** Called by the uncaught-exception path before exit(1). Writes
   *  `last_crash` and emits a `server_crashed` audit entry. */
  handleCrash(err: Error, origin: string): Promise<void>;

  /** Install signal listener + start config watcher (if enabled). */
  install(): void;
  /** Uninstall signal listener + stop config watcher. */
  uninstall(): void;

  /** The resolved supervisor mode — exposed for diagnostics. */
  readonly mode: ResolvedSupervisorMode;
}

const noopLog: LifecycleLogger = () => { /* silence */ };

export const createLifecycle = (
  opts: CreateLifecycleOptions,
): Lifecycle => {
  const log = opts.log ?? noopLog;
  const now = opts.now ?? (() => Date.now());

  // Supervisor mode — resolve from the runtime store if not overridden.
  const configuredMode: SupervisorMode =
    opts.supervisorMode ?? (() => {
      try {
        const v = opts.runtimeStore.get('supervisor.mode');
        return typeof v === 'string' ? (v as SupervisorMode) : 'auto';
      } catch {
        return 'auto';
      }
    })();
  const mode = resolveSupervisorMode(configuredMode);
  const supervisor = createSupervisor(mode);

  // Instance lock.
  const lockPath = opts.lockPath && opts.lockPath.length > 0
    ? opts.lockPath
    : `${opts.dataPath}/recued-server.lock`;
  const lock = createInstanceLock({ lockPath });

  // State store + machine.
  const store = createLifecycleStateStore(opts.db);
  const machine = createLifecycleStateMachine('booting');

  // Crash-loop.
  const crashLoopPersistence = createCrashLoopPersistence(opts.db);
  const crashLoop = createCrashLoopDetector({
    store,
    persistence: crashLoopPersistence,
    onDetected: (info) => {
      // Engage kill switch with a "crash_loop" reason. The existing
      // server-state store has no reason field — we use the
      // crash_loop_active flag (set inside the detector) as a
      // marker.
      opts.serverState.setCrashHalt(true, now());
      // Actually halt writes at the gates (the state flag alone does not —
      // the gate is an in-memory latch that rejects only when explicitly
      // halted). Closes the crash-loop write-protection gap.
      opts.onCrashHaltChange?.(true);
      logAudit('crash_loop_detected', {
        restart_count: info.restart_count,
        threshold: crashLoop.config.threshold,
        window_s: crashLoop.config.window_s,
      });
      // Phase F (D-108): give the launcher-side rollback runner a
      // file-based signal so it can decide whether to restore the
      // previous version on the next pre-start hook. Best-effort —
      // a failing flag write must not crash the detector.
      try { opts.onCrashLoopDetected?.(); } catch { /* swallow */ }
    },
    releaseCrashHalt: () => {
      opts.serverState.setCrashHalt(false);
      // Resume the gates halted on engage (symmetric with onDetected).
      opts.onCrashHaltChange?.(false);
      logAudit('crash_loop_reset', {});
    },
    log: (lvl, msg, data) => log(lvl, msg, data),
    now,
    config: opts.crashLoopConfig,
  });

  // Drain orchestrator. Default timeout read from runtime store, with a
  // conservative fallback if the key isn't wired in the schema yet
  // (config schema additions land in commit 15).
  const defaultDrainTimeoutMs = (() => {
    try {
      const v = opts.runtimeStore.get('lifecycle.drain_timeout_s');
      if (typeof v === 'number' && v > 0) return v * 1000;
    } catch { /* fall through */ }
    return 30_000;
  })();
  const drain = createDrainOrchestrator({
    machine,
    lock,
    getInFlightCount: opts.getInFlightCount,
    steps: opts.drainSteps,
    defaultTimeoutMs: defaultDrainTimeoutMs,
    log: (lvl, msg, data) => log(lvl, msg, data),
    now,
  });

  // Config watcher.
  const watchConfigFile = opts.watchConfigFile ?? (() => {
    try {
      const v = opts.runtimeStore.get('lifecycle.watch_config');
      return v === true;
    } catch { return false; }
  })();
  const configWatcher = createConfigWatcher({
    configPath: opts.configPath,
    distribution: opts.distribution,
    initialBootstrap: opts.initialBootstrap,
    initialRuntime: opts.initialRuntime,
    runtimeStore: opts.runtimeStore,
    lifecycleStore: store,
    watchFile: watchConfigFile,
    log: (lvl, msg, data) => log(lvl, msg, data),
    onReloaded: (info: ReloadInfo) => {
      logAudit('config_hot_reloaded', {
        reason: info.reason,
        runtime_changed: info.runtime_changed,
        bootstrap_changed: info.bootstrap_changed,
        restart_required: info.restart_required,
      });
    },
  });

  // Signal listener.
  const signals = createSignalListener({
    onShutdown: async (reason) => {
      logAudit('signal_received', { signal: reason });
      await lifecycle.requestDrain({
        intent: 'shutdown',
        reason,
      });
      // Handoff — lifecycle.requestDrain() resolves after the drain
      // pipeline finishes. Exit with the supervisor's code.
      const code = supervisor.handoff('shutdown');
      if (opts.exit) opts.exit(code);
      else process.exit(code);
    },
    onReload: async (reason) => {
      logAudit('signal_received', { signal: reason });
      await configWatcher.reload(reason);
    },
    onDumpSnapshot: () => {
      log('info', 'lifecycle snapshot', lifecycle.getSnapshot() as unknown as Record<string, unknown>);
    },
    onUncaughtException: async (err, origin) => {
      await lifecycle.handleCrash(err, origin);
    },
    log: (lvl, msg, data) => log(lvl, msg, data),
    exit: opts.exit,
    processRef: opts.processRef,
  });

  // Audit helper — best-effort; silent when auditLog isn't wired (tests).
  const logAudit = (
    action: import('@recued/storage').ActivityAction,
    detail: Record<string, unknown>,
  ): void => {
    if (!opts.auditLog) return;
    try {
      void opts.auditLog.logActivity({
        activity_id: `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: now(),
        action,
        target: 'server',
        detail: JSON.stringify(detail),
      });
    } catch (err) {
      log('warn', 'audit emit failed', {
        action,
        err: err instanceof Error ? err.message : err,
      });
    }
  };

  // Handler deps — assembled after the graph is complete.
  const handlerDeps: LifecycleHandlerDeps = {
    getSnapshot: () =>
      buildLifecycleSnapshot({
        store,
        machine,
        supervisor_mode: mode,
        drain: drain.state,
        stagedBootstrapPending: (() => {
          try {
            return opts.serverState.getStagedBootstrap() !== null;
          } catch { return false; }
        })(),
        now,
      }),
    drain,
    onDrainComplete: (intent, reason) => {
      // After a drain completes, the caller (signal or rpc) is
      // responsible for invoking supervisor handoff. The rpc path
      // also wires this — but the signal path is what actually exits.
      // This callback is the audit-emission hook.
      logAudit('drain_completed', { intent, reason });
    },
    crashLoop,
  };

  const lifecycle: Lifecycle = {
    store,
    machine,
    drain,
    crashLoop,
    supervisor,
    signals,
    configWatcher,
    lock,
    crashLoopPersistence,
    handlerSlice: makeLifecycleHandlers(handlerDeps),
    mode,

    getSnapshot() {
      return handlerDeps.getSnapshot();
    },

    markBooted() {
      if (machine.state !== 'booting') return;
      machine.transition('running');
      store.setBootAt(now());
      logAudit('server_boot', {
        version: opts.version,
        mode,
      });
    },

    async requestDrain({ intent, reason, timeoutMs }) {
      const isNew = !drain.state.active;
      if (isNew) {
        logAudit('drain_started', { intent, reason });
        if (intent === 'restart') logAudit('server_restart', { reason });
        else logAudit('server_shutdown', { reason });
      }
      // Mark clean shutdown BEFORE the drain — the `close_db` drain task closes
      // the warehouse db that backs this lifecycle-state store, so writing the
      // marker AFTER `drain.drain()` hit a CLOSED connection. That threw, which
      // rejected `requestDrain` and ABORTED the archive-restore commit that
      // awaits this drain (`then(onDrained)` to swap the db). A normal restart
      // never noticed — nothing awaits its drain — but it also meant the marker
      // was never written, so `reconcileBoot` mis-counted every restart as an
      // unclean exit. Recording it here (db still open) is correct: an orderly
      // drain has been initiated. Best-effort — a marker write must NEVER fail a
      // drain (the audit sink is console-based, so it's unaffected by close_db).
      try {
        store.markCleanShutdown(now());
      } catch {
        /* db unexpectedly unavailable — the marker is a crash-detection hint */
      }
      const result = await drain.drain({ intent, reason, timeoutMs });
      // Emit drain_completed / drain_aborted only for the initiating
      // call (avoid duplicate emissions from coalesced callers).
      if (isNew) {
        const action = result.aborted.length > 0
          ? 'drain_aborted'
          : 'drain_completed';
        logAudit(action, {
          intent: result.intent,
          reason: result.reason,
          completed: result.completed,
          aborted: result.aborted,
          duration_ms: result.duration_ms,
        });
      }
      // Flip state machine into its terminal state.
      if (machine.state === 'draining') {
        const target = intent === 'restart' ? 'restarting' : 'shutting_down';
        try {
          machine.transition(target);
        } catch {
          // A concurrent crash path may have flipped to 'crashed' already.
        }
      }
      return result;
    },

    async handleCrash(err, origin) {
      const crash: LifecycleLastCrash = {
        at: now(),
        reason: `${origin}: ${err.message ?? String(err)}`.slice(0, 512),
        exit_code: 1,
      };
      try {
        store.setLastCrash(crash);
      } catch {
        /* persistence best-effort — we're crashing */
      }
      logAudit('server_crashed', {
        origin,
        reason: crash.reason,
      });
      try {
        machine.transition('crashed');
      } catch {
        /* already terminal */
      }
    },

    install() {
      signals.install();
      configWatcher.start();
      crashLoopAutoResetTimer?.start();
    },

    uninstall() {
      signals.uninstall();
      configWatcher.stop();
      crashLoopAutoResetTimer?.stop();
    },
  };

  // Phase G (D-109) — crash-loop auto-reset tick. Wires
  // `autoResetIfStable()` into a periodic tick so stale counters clear without
  // operator intervention once the server has been stable for
  // `lifecycle.crash_loop_auto_reset_after_s`.
  //
  // ⚠ This cadence used to be read from the runtime store as
  // `crash_loop.auto_reset_interval_s` — a key that was NEVER in
  // `RUNTIME_SCHEMA`. Verified back to the commit that introduced the read
  // (`a29ca9b66`, D-109): it never touched `schema.ts`, so the key was born
  // dead. `RuntimeConfigStore.get` throws on unknown keys, the surrounding
  // `catch` swallowed it, and the cadence was ALWAYS this fallback. The
  // "disabled entirely when the interval config is 0" branch was likewise
  // unreachable.
  //
  // Made an explicit constant rather than given a real schema key: the tick is
  // an implementation detail (it was clamped to >=10s regardless), and the
  // operator knob that matters already exists — `crash_loop_auto_reset_after_s`
  // sets how long the server must be STABLE, which is the meaningful axis. How
  // often we check that is not worth a Settings control.
  const CRASH_LOOP_AUTO_RESET_TICK_MS = 60_000;
  const crashLoopAutoResetTimer = (
      () => {
        const intervalMs = CRASH_LOOP_AUTO_RESET_TICK_MS;
        let timer: ReturnType<typeof setInterval> | null = null;
        return {
          start() {
            if (timer !== null) return;
            timer = setInterval(() => {
              try {
                const fired = crashLoop.autoResetIfStable();
                if (fired) {
                  logAudit('crash_loop_reset', { origin: 'auto' });
                }
              } catch (err) {
                log('warn', 'crash-loop auto-reset tick failed', {
                  err: err instanceof Error ? err.message : String(err),
                });
              }
            }, intervalMs);
            // Don't hold the event loop open on Node — the server's
            // other timers already keep it alive.
            if (typeof (timer as { unref?: () => void })?.unref === 'function') {
              (timer as { unref: () => void }).unref();
            }
          },
          stop() {
            if (timer === null) return;
            clearInterval(timer);
            timer = null;
          },
        };
      })();

  return lifecycle;
};
