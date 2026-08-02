/** Supervision feature — the cli-daemon keep-alive supervisor.
 *
 *  Folds the D-118 service supervised-keep-alive (health-check + auto-restart +
 *  restart-on-server-start) onto the D-179 detached-job model, so the retired
 *  `kind: service` templates can be deleted without losing supervised daemons
 *  (cloudflared tunnel, ollama serve).
 *
 *  Why a focused module rather than the D-118 service `createSupervisor`: the
 *  service supervisor's liveness model is an in-process `child.onExit` handle,
 *  but the locked v1 liveness signal is the detached job's pid + `.exit.<code>`
 *  marker file (it has to survive a server restart — the child is `unref`'d).
 *  Reusing the service supervisor would mean a marker-watching `SpawnedProcess`
 *  shim wedged into its spawn seam — at which point the only thing reused is the
 *  restart-decision constants, which this calls directly. It also keeps the
 *  shared, actively-edited `collections/service/` tree untouched.
 *
 *  Launch reuses the EXISTING detached cli executor (`cli-invocation-executor.ts`
 *  `runDetached`) verbatim — the supervisor builds a `CliInvocationCall` from
 *  the pack op's `CliMethodBinding` (resolved off the installed manifest) and
 *  hands it to the injected executor. Supervision is the watch+restart loop
 *  AROUND that launch; the one-shot `recipe run_detached` path is unchanged.
 *
 *  Liveness / death detection is a dual-signal poll of the result dir:
 *   - a `{key}.exit.<code>` marker (written by the launching process's
 *     `child.once('close')`) gives an exact exit code — the common case, every
 *     daemon WE launched; and
 *   - pid-liveness (`process.kill(pid, 0)`) catches the death of an ADOPTED
 *     daemon (one that survived a server restart) whose original marker-writer
 *     is gone — code unknown, treated as a crash.
 *  A DELIBERATE stop bypasses the marker entirely (we know we killed it).
 *
 *  Restart policy + backoff + crash ceiling reuse the D-118 contract constants
 *  (`SERVICE_RESTART_BACKOFF_MS`, `SERVICE_CONSECUTIVE_CRASHES_MAX`) so a
 *  supervised daemon behaves exactly like a supervised service did.
 */
import {
  mkdirSync as nodeMkdirSync,
  readdirSync as nodeReaddirSync,
  readFileSync as nodeReadFileSync,
  rmSync as nodeRmSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  SERVICE_CONSECUTIVE_CRASHES_MAX,
  SERVICE_RESTART_BACKOFF_MS,
  type CliMethodBinding,
  type IngredientManifest,
  type ServiceRestartPolicy,
  type ServiceState,
} from '@recued/contracts';
import type { CliInvocationCall, CliInvocationExecutor } from '@recued/engine';

import { killProcessGroup as defaultKillProcessGroup } from './process-group-kill.js';
import type { SupervisedDaemonConfig } from './supervised-daemon-store.js';

/** The fixed marker key under each daemon's server-owned result dir. The op's
 *  `result_dir` / `key` args are supervisor-injected (not user-supplied) so
 *  every marker lands in a confined directory the server controls. */
const DAEMON_MARKER_KEY = 'daemon';

/** Default exit-marker / pid poll cadence. Daemons are long-lived, so a few
 *  seconds of death-detection latency is fine. Tests shrink it. */
const DEFAULT_POLL_INTERVAL_MS = 3_000;

/** Grace after a stop's SIGTERM before escalating to SIGKILL on a wedged
 *  daemon. */
const STOP_SIGKILL_GRACE_MS = 5_000;

/** After a stop's SIGTERM, re-poll the pid this often until it actually exits. */
const STOP_POLL_MS = 200;

/** Hard cap on awaiting a stopped daemon's death (SIGKILL fires at the grace
 *  above; past this we stop waiting and treat the pid as gone — the daemon dir's
 *  markers are cleared on the next launch regardless). */
const STOP_HARD_CAP_MS = STOP_SIGKILL_GRACE_MS + 5_000;

/** When the poll sees the pid gone but no exit marker yet, re-check this often
 *  (up to the grace below) for the marker before concluding a marker-less death.
 *  A daemon WE launched writes its `.exit.<code>` marker asynchronously (the
 *  executor's `child.once('close')`), so the pid can read dead a tick before the
 *  marker lands; an ADOPTED daemon never gets a marker, so the grace expires and
 *  the death is treated as code-unknown (a crash). */
const DEATH_CONFIRM_POLL_MS = 250;
const DEATH_CONFIRM_GRACE_MS = 2_000;

/** Point-in-time view of a supervised daemon — the `supervision.status` /
 *  `supervision.list` row shape (runtime facts the durable config doesn't hold). */
export interface SupervisedDaemonStatus {
  ingredient_slug: string;
  op: string;
  /** Reuses the D-118 `ServiceState` vocabulary. */
  state: ServiceState;
  pid: number | null;
  started_at: number | null;
  consecutive_crashes: number;
  last_crash_at: number | null;
  last_exit_code: number | null;
}

/** A daemon's runtime-state TRANSITION, handed to the optional `audit` seam so
 *  the composition root writes one D-120 activity row per lifecycle change
 *  (started / crashed / stopped / permanently_crashed). The supervisor is not a
 *  recipe run, so this is an out-of-band activity row keyed by
 *  `(ingredient_slug, op)` — no run / dish attribution. Succeeds the D-118
 *  `ServiceAuditEvent` for the retired `kind: service` supervised templates. */
export interface DaemonAuditEvent {
  ingredient_slug: string;
  op: string;
  /** The state just entered (the post-transition `ServiceState`). */
  state: ServiceState;
  pid: number | null;
  last_exit_code: number | null;
  consecutive_crashes: number;
  /** Supervisor clock (epoch-ms) at the transition — the audit row's timestamp,
   *  threaded so a test's injected `now` stamps it deterministically. */
  at: number;
}

/** Minimal filesystem seam over the marker files — injected so the launch /
 *  liveness loop is unit-testable without touching disk. */
export interface SupervisorFs {
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  readdirSync(path: string): string[];
  rmSync(path: string, opts: { force: boolean }): void;
  readFileSync(path: string, enc: 'utf8'): string;
}

const defaultFs: SupervisorFs = {
  mkdirSync: (p, o) => { nodeMkdirSync(p, o); },
  readdirSync: (p) => nodeReaddirSync(p),
  rmSync: (p, o) => { nodeRmSync(p, o); },
  readFileSync: (p, e) => nodeReadFileSync(p, e),
};

/** Default pid-liveness probe — `process.kill(pid, 0)` raises `ESRCH` for a
 *  dead pid; `EPERM` means it's alive but owned by another user (still alive). */
const defaultIsPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export interface CliDaemonSupervisorDeps {
  /** The same detached-capable cli executor the engine uses (built in
   *  `wire-execute-deps.ts`). The supervisor hands it a `CliInvocationCall`
   *  whose binding carries `detached`, so it takes the `runDetached` path. */
  cliInvocationExecutor: CliInvocationExecutor;
  /** Resolve an installed ingredient manifest by slug (the serve path wires
   *  `executorConfig.manifests.get`). The daemon's `CliMethodBinding` lives at
   *  `manifest.surfaces.connector.executes[op]`. */
  getManifest: (slug: string) => IngredientManifest | undefined;
  /** Base data dir — each daemon's markers live under `<dataPath>/daemons/
   *  <pack>/<op>/`. */
  dataPath: string;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout?: (t: NodeJS.Timeout) => void;
  /** Cross-OS process-group kill (the detached `cancel` primitive). */
  killProcessGroup?: (pid: number, signal?: NodeJS.Signals) => void;
  isPidAlive?: (pid: number) => boolean;
  pollIntervalMs?: number;
  fs?: SupervisorFs;
  /** Structured log seam — defaults to `console`. */
  log?: (level: 'warn' | 'info', msg: string, meta?: Record<string, unknown>) => void;
  /** Live-state broadcast seam — invoked on a daemon's runtime-state TRANSITION
   *  (crash / auto-restart / ceiling / stop), so paired clients re-list the
   *  pack-detail controls without polling. Wired from `eventBus.emit` (a
   *  `supervision` broadcast); absent ⇒ no live push (the dbless harness, tests).
   *  Best-effort — the supervisor swallows a throw. */
  broadcast?: (change: { ingredient_slug: string; op: string }) => void;
  /** Audit seam — invoked on the SAME runtime-state transition as `broadcast`,
   *  so the composition root writes one D-120 activity row per daemon lifecycle
   *  change. Wired from `auditLog.logActivity` in `compose-supervision-stack`;
   *  absent ⇒ no audit (the dbless harness, tests). Best-effort — the supervisor
   *  swallows a throw (must never break the state machine), tracks an async
   *  writer without blocking transitions, and drains it at disposal. */
  audit?: (event: DaemonAuditEvent) => void | Promise<void>;
}

export interface CliDaemonSupervisor {
  /** Launch (or no-op if already running) a supervised daemon. A manual /
   *  explicit start resets the crash counter. */
  start(config: SupervisedDaemonConfig): Promise<SupervisedDaemonStatus>;
  /** Stop a daemon: cancel any pending restart + process-group kill + mark
   *  stopped. Bypasses the exit marker (we initiated the death). */
  stop(ingredient_slug: string, op: string): Promise<SupervisedDaemonStatus>;
  status(ingredient_slug: string, op: string): SupervisedDaemonStatus | null;
  list(): SupervisedDaemonStatus[];
  isTracked(ingredient_slug: string, op: string): boolean;
  /** Boot reconcile — adopt a surviving daemon, else fresh-start each enabled
   *  daemon that asked for `restart_on_server_start`. */
  startAll(configs: SupervisedDaemonConfig[]): Promise<void>;
  /** Server shutdown — close launch admission, cancel timers, drain active
   *  launches/audits, then drop in-memory tracking, but LEAVE the daemons
   *  running (they're detached; the next boot's `startAll` adopts survivors).
   *  Killing on every bounce would needlessly blip the tunnel. */
  disposeAll(): Promise<void>;
}

interface DaemonRecord {
  config: SupervisedDaemonConfig;
  resultDir: string;
  exitPrefix: string;
  // runtime
  pid: number | null;
  started_at: number | null;
  consecutive_crashes: number;
  last_crash_at: number | null;
  last_exit_code: number | null;
  state: ServiceState;
  // control
  pollTimer: NodeJS.Timeout | null;
  restartTimer: NodeJS.Timeout | null;
  /** The detached executor call currently establishing this daemon. A restart
   *  timer clears itself before that async call settles, so the Promise is the
   *  only reliable stop / shutdown drain handle after the timer has fired. */
  launchPromise: Promise<void> | null;
  /** True between a deliberate `stop()` and the daemon's actual exit — so a
   *  marker / pid-death isn't misclassified as a crash. */
  shuttingDown: boolean;
}

const recordKey = (ingredient_slug: string, op: string): string => [ingredient_slug, op].join(String.fromCharCode(0x1f));

/** Confine each daemon's marker dir to a server-owned path. pack/op come from
 *  the validated store (the handler already rejects path-separator / traversal
 *  segments), but sanitize defensively so even a stored crafted segment can't
 *  escape `<dataPath>/daemons/`: non-`[A-Za-z0-9_.-]` chars → `_`, and a
 *  pure-dot result (`.`, `..`, `...` — a `path.join` traversal) → `_`. */
const segment = (s: string): string => {
  const cleaned = s.replace(/[^A-Za-z0-9_.-]/g, '_');
  return cleaned === '' || /^\.+$/.test(cleaned) ? '_' : cleaned;
};
const daemonResultDir = (dataPath: string, ingredient_slug: string, op: string): string =>
  join(dataPath, 'daemons', segment(ingredient_slug), segment(op));

/** Re-launch decision for a daemon that exited on its own. `null` code (an
 *  adopted daemon's marker-less death, or a launch failure) counts as a crash. */
const shouldRestart = (policy: ServiceRestartPolicy, code: number | null): boolean => {
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  return code === null || code !== 0; // on-crash
};

export const createCliDaemonSupervisor = (
  deps: CliDaemonSupervisorDeps,
): CliDaemonSupervisor => {
  const now = deps.now ?? ((): number => Date.now());
  const setTimeoutFn = deps.setTimeout ?? ((fn, ms): NodeJS.Timeout => setTimeout(fn, ms));
  const clearTimeoutFn = deps.clearTimeout ?? ((t): void => { clearTimeout(t); });
  const killGroup = deps.killProcessGroup ?? defaultKillProcessGroup;
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const fs = deps.fs ?? defaultFs;
  const log = deps.log ?? ((level, msg, meta): void => {
    // eslint-disable-next-line no-console
    console[level === 'warn' ? 'warn' : 'log'](`[cli-daemon-supervisor] ${msg}`, meta ?? '');
  });

  const records = new Map<string, DaemonRecord>();
  const pendingAudits = new Set<Promise<void>>();
  let closed = false;
  let disposePromise: Promise<void> | undefined;

  const newRecord = (config: SupervisedDaemonConfig): DaemonRecord => ({
    config,
    resultDir: daemonResultDir(deps.dataPath, config.ingredient_slug, config.op),
    exitPrefix: `${DAEMON_MARKER_KEY}.exit.`,
    pid: null,
    started_at: null,
    consecutive_crashes: 0,
    last_crash_at: null,
    last_exit_code: null,
    state: 'unknown',
    pollTimer: null,
    restartTimer: null,
    launchPromise: null,
    shuttingDown: false,
  });

  const statusOf = (r: DaemonRecord): SupervisedDaemonStatus => ({
    ingredient_slug: r.config.ingredient_slug,
    op: r.config.op,
    state: r.state,
    pid: r.pid,
    started_at: r.started_at,
    consecutive_crashes: r.consecutive_crashes,
    last_crash_at: r.last_crash_at,
    last_exit_code: r.last_exit_code,
  });

  /** Set a daemon's live state, emitting a `supervision` broadcast on a real
   *  TRANSITION so paired clients re-list (the async crash / restart / ceiling
   *  moves a user action can't see; a user's own stop/start also fans so OTHER
   *  clients update). Best-effort — a bus throw never breaks the state machine. */
  const setState = (r: DaemonRecord, state: ServiceState): void => {
    const prior = r.state;
    if (prior === state) return; // no-op transition — don't fan a non-change
    r.state = state;
    if (closed) return;
    try {
      deps.broadcast?.({ ingredient_slug: r.config.ingredient_slug, op: r.config.op });
    } catch {
      /* best-effort live push */
    }
    // One audit row per real lifecycle transition (handleExit / launch have
    // already stamped r.pid / r.last_exit_code / r.consecutive_crashes to match
    // this state). EXCEPTION — boot reconciliation: a fresh record starts
    // 'unknown', and startAll moves an enabled-but-dead, non-boot-persistent
    // daemon 'unknown' -> 'stopped'. That daemon never ran this boot, so a
    // durable reserve-class 'stopped' row would be a false breadcrumb that
    // re-accrues every boot — suppress it (broadcast still fires for the live
    // list). The 'unknown' -> 'running' adopt is intentionally KEPT: "supervisor
    // began tracking a live daemon at boot" is a true, forensically useful
    // 'started' event (it carries the adopted pid).
    const isBootStopReconciliation = prior === 'unknown' && state === 'stopped';
    if (!isBootStopReconciliation) {
      try {
        const pending = deps.audit?.({
          ingredient_slug: r.config.ingredient_slug,
          op: r.config.op,
          state,
          pid: r.pid,
          last_exit_code: r.last_exit_code,
          consecutive_crashes: r.consecutive_crashes,
          at: now(),
        });
        if (pending && typeof pending.then === 'function') {
          const task = Promise.resolve(pending);
          pendingAudits.add(task);
          const clear = (): void => { pendingAudits.delete(task); };
          // Attach both branches so a best-effort audit rejection is observed
          // even when no shutdown drain is active yet.
          void task.then(clear, clear);
        }
      } catch {
        /* best-effort audit emit */
      }
    }
  };

  const resolveBinding = (config: SupervisedDaemonConfig): CliMethodBinding | null => {
    const binding = deps.getManifest(config.ingredient_slug)?.surfaces?.connector?.executes?.[config.op];
    if (!binding || binding.kind !== 'cli_invocation' || !binding.detached) return null;
    return binding;
  };

  const readPidMarker = (r: DaemonRecord): number | null => {
    try {
      const pid = parseInt(fs.readFileSync(join(r.resultDir, `${DAEMON_MARKER_KEY}.pid`), 'utf8').trim(), 10);
      return Number.isInteger(pid) && pid > 1 ? pid : null;
    } catch {
      return null;
    }
  };

  const findExitMarker = (r: DaemonRecord): { present: boolean; code: number | null } => {
    let names: string[];
    try {
      names = fs.readdirSync(r.resultDir);
    } catch {
      return { present: false, code: null };
    }
    for (const name of names) {
      if (name.startsWith(r.exitPrefix)) {
        const code = parseInt(name.slice(r.exitPrefix.length), 10);
        return { present: true, code: Number.isInteger(code) ? code : null };
      }
    }
    return { present: false, code: null };
  };

  const clearExitMarkers = (r: DaemonRecord): void => {
    let names: string[];
    try {
      names = fs.readdirSync(r.resultDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(r.exitPrefix)) {
        try { fs.rmSync(join(r.resultDir, name), { force: true }); } catch { /* best-effort */ }
      }
    }
  };

  const stopPoll = (r: DaemonRecord): void => {
    if (r.pollTimer !== null) {
      clearTimeoutFn(r.pollTimer);
      r.pollTimer = null;
    }
  };

  const cancelRestart = (r: DaemonRecord): void => {
    if (r.restartTimer !== null) {
      clearTimeoutFn(r.restartTimer);
      r.restartTimer = null;
    }
  };

  const startPoll = (r: DaemonRecord): void => {
    stopPoll(r);
    const tick = (): void => {
      r.pollTimer = null;
      if (r.state !== 'running') return; // stopped / restarting — poll obsolete
      const marker = findExitMarker(r);
      if (marker.present) { handleExit(r, marker.code); return; }
      // pid gone but no marker yet — confirm before concluding (the marker write
      // races the pid death for a daemon we launched; an adopted daemon has none).
      if (r.pid !== null && !isPidAlive(r.pid)) { confirmDeath(r); return; }
      r.pollTimer = setTimeoutFn(tick, pollIntervalMs);
    };
    r.pollTimer = setTimeoutFn(tick, pollIntervalMs);
  };

  /** The poll saw the pid gone with no exit marker. Re-check briefly for the
   *  marker (a daemon WE launched writes it a tick behind the pid death) before
   *  concluding a marker-less death (an adopted daemon — code unknown → crash).
   *  Reuses `r.pollTimer` so a concurrent `stop()` / `handleExit` cancels it. */
  const confirmDeath = (r: DaemonRecord): void => {
    const deadline = now() + DEATH_CONFIRM_GRACE_MS;
    const recheck = (): void => {
      r.pollTimer = null;
      if (r.state !== 'running') return; // a concurrent stop() took over
      const marker = findExitMarker(r);
      if (marker.present) { handleExit(r, marker.code); return; }
      if (now() >= deadline) { handleExit(r, null); return; }
      r.pollTimer = setTimeoutFn(recheck, DEATH_CONFIRM_POLL_MS);
    };
    r.pollTimer = setTimeoutFn(recheck, DEATH_CONFIRM_POLL_MS);
  };

  const scheduleRestart = (r: DaemonRecord, delay: number): void => {
    if (closed) return;
    cancelRestart(r);
    r.restartTimer = setTimeoutFn(() => {
      r.restartTimer = null;
      if (closed) return;
      void runLaunch(r).catch((err) => {
        log('warn', `daemon '${r.config.ingredient_slug}/${r.config.op}' restart failed`, {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }, delay);
  };

  /** A daemon exited on its own (marker / pid-death) OR a launch threw. */
  const handleExit = (r: DaemonRecord, code: number | null): void => {
    stopPoll(r);
    r.pid = null;
    r.started_at = null;
    r.last_exit_code = code;

    if (closed) return;

    if (r.shuttingDown) {
      r.shuttingDown = false;
      setState(r, 'stopped');
      return;
    }

    if (!shouldRestart(r.config.restart_policy, code)) {
      setState(r, code === 0 ? 'stopped' : 'crashed');
      return;
    }

    // Crash + restart-eligible: bump the counter, apply the ceiling, back off.
    r.consecutive_crashes += 1;
    r.last_crash_at = now();
    if (r.consecutive_crashes >= SERVICE_CONSECUTIVE_CRASHES_MAX) {
      setState(r, 'permanently_crashed');
      log('warn', `daemon '${r.config.ingredient_slug}/${r.config.op}' permanently crashed`, {
        consecutive_crashes: r.consecutive_crashes,
      });
      return;
    }
    setState(r, 'crashed');
    const backoff = SERVICE_RESTART_BACKOFF_MS[
      Math.min(r.consecutive_crashes - 1, SERVICE_RESTART_BACKOFF_MS.length - 1)
    ];
    scheduleRestart(r, backoff);
  };

  /** Kill any live prior-lifetime survivor, clear stale markers, then launch
   *  the detached job via the cli executor + arm the liveness poll. Reused by
   *  the initial `start()` and by `scheduleRestart` (which keeps the crash
   *  counter — only `start()` resets it). */
  const launch = async (r: DaemonRecord): Promise<void> => {
    if (closed) return;
    const binding = resolveBinding(r.config);
    if (!binding) {
      // The daemon never launched — stamp the runtime fields so the 'crashed'
      // audit row is honest (no pid, no exit code) instead of carrying a stale
      // code from a prior lifetime (a restart whose binding no longer resolves).
      // Control flow is unchanged: a binding-resolution failure stays 'crashed'
      // with no restart (a config / uninstall error won't fix itself on retry).
      r.pid = null;
      r.started_at = null;
      r.last_exit_code = null;
      setState(r, 'crashed');
      log('warn', `daemon '${r.config.ingredient_slug}/${r.config.op}' has no resolvable detached cli binding`, {
        ingredient_slug: r.config.ingredient_slug,
      });
      return;
    }

    try { fs.mkdirSync(r.resultDir, { recursive: true }); } catch { /* executor re-creates */ }
    // Drop any stale exit marker so the poll only ever sees THIS run's death.
    // NB: we deliberately do NOT group-kill a `.pid`-marker "survivor" here. A
    // stale pid from a PRIOR server lifetime is very likely RECYCLED to an
    // unrelated process (killing it would take down a random process group). The
    // only place a live survivor is genuinely OUR daemon is the boot adopt path
    // (`startAll`), which adopts rather than kills; every other launch() path
    // reaches here only when our daemon is already dead (crash-restart / reconcile
    // fresh-start) or was just reaped (stop() awaits death before start()).
    clearExitMarkers(r);

    const call: CliInvocationCall = {
      slug: r.config.ingredient_slug,
      operation_key: r.config.op,
      operation_id: r.config.op,
      binding,
      // result_dir / key are server-owned (not from config.args) so markers land
      // in the confined daemon dir.
      args: { ...r.config.args, result_dir: r.resultDir, key: DAEMON_MARKER_KEY },
    };

    let result: { pid?: number | null };
    try {
      result = (await deps.cliInvocationExecutor(call)) as { pid?: number | null };
    } catch (err) {
      log('warn', `daemon '${r.config.ingredient_slug}/${r.config.op}' launch failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
      if (closed) return;
      // Treat a failed launch as a crash → backoff retry per policy.
      handleExit(r, -1);
      return;
    }

    // disposeAll deliberately leaves detached daemons alive, but it must not
    // re-arm tracking after shutdown started. The executor/marker contract lets
    // the next server boot adopt a launch that crossed this boundary.
    if (closed) return;

    r.pid = typeof result.pid === 'number' ? result.pid : null;
    r.started_at = now();
    // A stop that raced this executor is waiting on launchPromise. Publish the
    // pid for it to terminate, but do not briefly resurrect the daemon or arm a
    // poll while the explicit stop is pending.
    if (r.shuttingDown) return;
    setState(r, 'running');
    startPoll(r);
  };

  /** Coalesce every path that can establish a daemon (manual start, boot
   *  reconcile, timer restart) onto one Promise so stop and dispose have a
   *  complete async lifecycle handle. */
  const runLaunch = (r: DaemonRecord): Promise<void> => {
    if (r.launchPromise) return r.launchPromise;
    const task = launch(r);
    r.launchPromise = task;
    const clear = (): void => {
      if (r.launchPromise === task) r.launchPromise = null;
    };
    void task.then(clear, clear);
    return task;
  };

  /** Adopt a daemon that survived the server restart — record it + arm the
   *  poll, but DON'T relaunch (it's already running). Its future death is caught
   *  by the poll's pid-liveness arm (no marker writer survives from its original
   *  launch). Audited as `supervised_daemon_started` (via setState) — the
   *  process didn't start this instant, but "supervisor began tracking this live
   *  daemon at boot" is the forensically meaningful lifecycle event. */
  const adopt = (r: DaemonRecord, pid: number): void => {
    r.pid = pid;
    r.started_at = now();
    setState(r, 'running');
    startPoll(r);
  };

  const start = async (config: SupervisedDaemonConfig): Promise<SupervisedDaemonStatus> => {
    if (closed) throw new Error('cli daemon supervisor is disposed');
    const key = recordKey(config.ingredient_slug, config.op);
    let r = records.get(key);
    if (r) {
      r.config = config;
      if (r.state === 'running' && r.pid !== null) return statusOf(r);
      cancelRestart(r);
    } else {
      r = newRecord(config);
      records.set(key, r);
    }
    // A manual / explicit start clears the crash history (cf. service clearCrash).
    r.consecutive_crashes = 0;
    r.shuttingDown = false;
    await runLaunch(r);
    return statusOf(r);
  };

  /** Wait for a SIGTERM'd process group to actually exit, escalating to SIGKILL
   *  at the grace window and giving up at the hard cap. `stop()` awaits this so a
   *  subsequent `start()` launches only once the old daemon is truly gone — a
   *  lingering old child's late `.exit.<code>` marker can't then pollute the new
   *  run's poll. Bounded + never throws. */
  const awaitPidDeath = (pid: number): Promise<void> =>
    new Promise((resolve) => {
      const startedAt = now();
      let escalated = false;
      const check = (): void => {
        if (!isPidAlive(pid)) { resolve(); return; }
        const elapsed = now() - startedAt;
        if (!escalated && elapsed >= STOP_SIGKILL_GRACE_MS) {
          escalated = true;
          killGroup(pid, 'SIGKILL');
        }
        if (elapsed >= STOP_HARD_CAP_MS) { resolve(); return; }
        setTimeoutFn(check, STOP_POLL_MS);
      };
      check();
    });

  const stop = async (ingredient_slug: string, op: string): Promise<SupervisedDaemonStatus> => {
    const r = records.get(recordKey(ingredient_slug, op));
    if (!r) {
      return {
        ingredient_slug, op, state: 'stopped', pid: null, started_at: null,
        consecutive_crashes: 0, last_crash_at: null, last_exit_code: null,
      };
    }
    cancelRestart(r);
    stopPoll(r);
    r.shuttingDown = true;
    // A restart timer clears its handle before awaiting the detached executor.
    // Drain that launch so its eventual pid cannot appear after stop returns.
    if (r.launchPromise) {
      try { await r.launchPromise; } catch { /* launch owns failure state */ }
      cancelRestart(r);
      stopPoll(r);
    }
    const pid = r.pid;
    if (pid !== null) {
      killGroup(pid, 'SIGTERM');
      // Block until the group is actually gone (SIGKILL escalation inside) so a
      // following start() can't race a lingering old child's marker write.
      await awaitPidDeath(pid);
    }
    r.pid = null;
    r.started_at = null;
    r.shuttingDown = false;
    setState(r, 'stopped');
    return statusOf(r);
  };

  const startAll = async (configs: SupervisedDaemonConfig[]): Promise<void> => {
    if (closed) throw new Error('cli daemon supervisor is disposed');
    for (const config of configs) {
      if (closed) return;
      if (!config.enabled) continue; // disabled = the user stopped it; leave it
      const key = recordKey(config.ingredient_slug, config.op);
      const r = newRecord(config);
      records.set(key, r);
      const survivor = readPidMarker(r);
      const marker = findExitMarker(r);
      if (!marker.present && survivor !== null && isPidAlive(survivor)) {
        // Survived our restart — adopt regardless of restart_on_server_start.
        adopt(r, survivor);
      } else if (config.restart_on_server_start) {
        // Dead + boot-persistent → relaunch fresh.
        try { await runLaunch(r); }
        catch (err) {
          log('warn', `daemon '${config.ingredient_slug}/${config.op}' reconcile launch failed`, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        // Dead + not boot-persistent → leave stopped.
        setState(r, 'stopped');
      }
    }
  };

  const disposeAll = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    // Close admission synchronously so no public start or queued restart can
    // enter outside the launch snapshot below.
    closed = true;
    const current = [...records.values()];
    for (const r of current) {
      cancelRestart(r);
      stopPoll(r);
      // Intentionally NOT killing — daemons are detached and survive the bounce.
    }
    const activeLaunches = current.flatMap((r) =>
      r.launchPromise ? [r.launchPromise] : []
    );
    const activeAudits = [...pendingAudits];
    disposePromise = Promise.allSettled([...activeLaunches, ...activeAudits]).then(() => {
      // A launch may have reached its completion edge while disposal waited.
      // Clean again before dropping the only references to its timers.
      for (const r of current) {
        cancelRestart(r);
        stopPoll(r);
      }
      records.clear();
      pendingAudits.clear();
    });
    return disposePromise;
  };

  return {
    start,
    stop,
    status: (ingredient_slug, op) => {
      const r = records.get(recordKey(ingredient_slug, op));
      return r ? statusOf(r) : null;
    },
    list: () => [...records.values()].map(statusOf),
    isTracked: (ingredient_slug, op) => records.has(recordKey(ingredient_slug, op)),
    startAll,
    disposeAll,
  };
};
