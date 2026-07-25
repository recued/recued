/** Crash-loop detector (Phase C).
 *
 *  Detects N consecutive unclean exits within M seconds and engages
 *  the kill switch to stop the loop while keeping the process alive
 *  so the operator can diagnose via `server.getLifecycleState` +
 *  `server.resetCrashLoop`.
 *
 *  "Unclean exit" = previous process did not write
 *  `lifecycle.shutdown_at` before exiting. `draining` → `restarting`
 *  or `shutting_down` both write shutdown_at; only `crashed` (or
 *  SIGKILL, hard reboot, OOM-kill) leaves it missing.
 *
 *  State tracked in `server_state`:
 *    lifecycle.shutdown_at      — written on clean exit; read at boot
 *    lifecycle.restart_count    — incremented per unclean boot
 *    lifecycle.last_crash       — most recent crash {at, reason, exit_code}
 *    lifecycle.crash_loop_active — 1 when THIS detector engaged the
 *                                  kill switch (distinguishes our
 *                                  engagement from a user-manual one,
 *                                  so reset only releases what we took).
 *
 *  Kill-switch coordination is routed through a callback rather than
 *  a hard dep on `ServerStateStore` — keeps the detector testable
 *  without a full server state store.
 */

import type { LifecycleStateStore } from './lifecycle-state.js';

const KEY_CRASH_LOOP_ACTIVE = 'lifecycle.crash_loop_active';

// Store helper: crash-loop has its own small key not covered by
// LifecycleStateStore's public interface. We reach into the underlying
// db via a getter/setter pair passed in deps.
export interface CrashLoopPersistence {
  isCrashLoopActive(): boolean;
  setCrashLoopActive(active: boolean): void;
}

/** Create persistence helpers that share the `server_state` table
 *  with `LifecycleStateStore`. Exposed as a standalone factory so
 *  the composition root can wire it alongside the lifecycle state
 *  store without reaching through the public interface. */
export const createCrashLoopPersistence = (
  db: import('better-sqlite3').Database,
): CrashLoopPersistence => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const get = (key: string): string | undefined => {
    const row = db.prepare(`SELECT value FROM server_state WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  };
  const put = (key: string, value: string, updatedAt: number): void => {
    db.prepare(
      `INSERT OR REPLACE INTO server_state (key, value, updated_at) VALUES (?, ?, ?)`,
    ).run(key, value, updatedAt);
  };
  const del = (key: string): void => {
    db.prepare(`DELETE FROM server_state WHERE key = ?`).run(key);
  };
  return {
    isCrashLoopActive: () => get(KEY_CRASH_LOOP_ACTIVE) === '1',
    setCrashLoopActive(active) {
      if (active) put(KEY_CRASH_LOOP_ACTIVE, '1', Date.now());
      else del(KEY_CRASH_LOOP_ACTIVE);
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Detector
// ────────────────────────────────────────────────────────────────

export interface CrashLoopConfig {
  /** Rolling window (seconds) within which repeated crashes count. */
  window_s: number;
  /** Number of unclean exits within `window_s` that trips detection. */
  threshold: number;
  /** Sustained uptime (seconds) required before counters auto-reset. */
  auto_reset_after_s: number;
}

export const DEFAULT_CRASH_LOOP_CONFIG: CrashLoopConfig = {
  window_s: 60,
  threshold: 5,
  auto_reset_after_s: 3600,
};

export interface CrashLoopDetectorDeps {
  store: LifecycleStateStore;
  persistence: CrashLoopPersistence;
  /** Called when detection fires. Caller engages the kill switch.
   *  Synchronous — the detector's boot-time reconcile is synchronous. */
  onDetected?: (info: {
    restart_count: number;
    last_crash: import('@recued/contracts').LifecycleLastCrash | null;
  }) => void;
  /** Called by `reset()` to release the kill switch iff we engaged
   *  it (tracked via the crash_loop_active persistence flag). */
  releaseCrashHalt?: () => void;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  config?: Partial<CrashLoopConfig>;
}

export interface CrashLoopReconcileResult {
  /** True when the current boot followed an unclean exit. */
  was_unclean: boolean;
  /** Restart count AFTER any increment from this boot. */
  restart_count: number;
  /** True when detection fired on this boot (threshold crossed within
   *  window). The caller should engage the kill switch. */
  detected: boolean;
}

export interface CrashLoopResetResult {
  restart_count_cleared: boolean;
  last_crash_cleared: boolean;
  crash_halt_released: boolean;
}

export interface CrashLoopDetector {
  /** Reconcile at boot — inspect previous exit, increment counters,
   *  detect loop. Caller engages kill switch based on `detected`. */
  reconcileBoot(): CrashLoopReconcileResult;
  /** Periodic tick (e.g. on a 5-minute cron). Clears counters iff
   *  current uptime exceeds `auto_reset_after_s`. Returns true when
   *  an auto-reset fired. */
  autoResetIfStable(): boolean;
  /** Admin-triggered reset. Clears restart_count + last_crash + the
   *  crash_loop_active flag, and invokes `releaseCrashHalt` iff we
   *  engaged it. Safe to call when nothing is set — every cleared
   *  flag is reported in the result. */
  reset(): CrashLoopResetResult;
  readonly config: CrashLoopConfig;
}

const noopLog: NonNullable<CrashLoopDetectorDeps['log']> = () => { /* silence */ };

export const createCrashLoopDetector = (
  deps: CrashLoopDetectorDeps,
): CrashLoopDetector => {
  const log = deps.log ?? noopLog;
  const now = deps.now ?? (() => Date.now());
  const config: CrashLoopConfig = {
    ...DEFAULT_CRASH_LOOP_CONFIG,
    ...deps.config,
  };

  return {
    config,

    reconcileBoot() {
      const shutdownAt = deps.store.getShutdownAt();
      const wasUnclean = shutdownAt === null;

      let restartCount: number;
      if (wasUnclean) {
        restartCount = deps.store.incrementRestartCount();
        log('warn', 'boot after unclean exit', {
          restart_count: restartCount,
        });
      } else {
        // Clean exit — clear the shutdown marker so next boot doesn't
        // double-count, but preserve restart_count (it may reflect
        // earlier uncleans).
        deps.store.clearShutdownAt();
        restartCount = deps.store.getRestartCount();
      }

      // Check the crash window. `last_crash` stores the most recent
      // unclean exit's timestamp; if that's within `window_s` AND the
      // count has crossed threshold, we're in a loop.
      const lastCrash = deps.store.getLastCrash();
      const windowMs = config.window_s * 1000;
      const inWindow =
        lastCrash !== null && now() - lastCrash.at < windowMs;

      const detected =
        wasUnclean &&
        inWindow &&
        restartCount >= config.threshold;

      if (detected) {
        log('error', 'crash-loop detected — engaging kill switch', {
          restart_count: restartCount,
          threshold: config.threshold,
          window_s: config.window_s,
          last_crash_at: lastCrash?.at,
        });
        deps.persistence.setCrashLoopActive(true);
        deps.onDetected?.({ restart_count: restartCount, last_crash: lastCrash });
      }

      return {
        was_unclean: wasUnclean,
        restart_count: restartCount,
        detected,
      };
    },

    autoResetIfStable() {
      const bootAt = deps.store.getBootAt();
      if (bootAt === null) return false;
      const uptimeS = Math.max(0, Math.floor((now() - bootAt) / 1000));
      if (uptimeS < config.auto_reset_after_s) return false;

      const currentCount = deps.store.getRestartCount();
      const currentCrash = deps.store.getLastCrash();
      if (currentCount === 0 && currentCrash === null) return false;

      log('info', 'crash-loop auto-reset — sustained uptime', {
        uptime_s: uptimeS,
        cleared_restart_count: currentCount,
      });
      deps.store.resetRestartCount();
      deps.store.clearLastCrash();
      // Don't touch crash_loop_active or the kill switch — if the user
      // hit `reset` via rpc we've already released; if the counters
      // hit the auto-reset threshold without detection firing, the
      // kill switch was never engaged by us.
      return true;
    },

    reset() {
      const hadRestartCount = deps.store.getRestartCount() > 0;
      const hadLastCrash = deps.store.getLastCrash() !== null;
      const weEngagedCrashHalt = deps.persistence.isCrashLoopActive();

      deps.store.resetRestartCount();
      deps.store.clearLastCrash();
      if (weEngagedCrashHalt) {
        deps.persistence.setCrashLoopActive(false);
        deps.releaseCrashHalt?.();
      }

      return {
        restart_count_cleared: hadRestartCount,
        last_crash_cleared: hadLastCrash,
        crash_halt_released: weEngagedCrashHalt,
      };
    },
  };
};
