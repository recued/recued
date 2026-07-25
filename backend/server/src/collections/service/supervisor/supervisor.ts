/** D-118 Phase 5 — lifecycle supervisor.
 *
 *  Manages long-running `data.service.*` processes on the server.
 *  Responsibilities:
 *
 *    - Start / stop services per `lifecycle.start` / `lifecycle.stop`.
 *    - Track live pid in a `Map<slug, ProcessRecord>` so crash
 *      events can reach the right process handle.
 *    - Listen for `exit` via the `SpawnedProcess.onExit` hook and
 *      classify outcomes (`'stopped'` vs `'crashed'`) per
 *      `restart_policy`.
 *    - Apply the `SERVICE_RESTART_BACKOFF_MS` schedule indexed by
 *      `consecutive_crashes - 1`; flip to `permanently_crashed`
 *      once the counter hits `SERVICE_CONSECUTIVE_CRASHES_MAX`.
 *    - Write every transition to the Phase 2 state table and emit
 *      a matching `ServiceAuditEvent` via the injected seam.
 *
 *  Pending restarts live in a separate `pendingRestarts` map so
 *  manual start / stop / clearCrash can cancel them cleanly even
 *  though the live `ProcessRecord` was already torn down when the
 *  child exited.
 *
 *  Concurrency: Node's event loop serialises per-instance state
 *  mutations; the supervisor keeps a single `ProcessRecord` per
 *  slug, never two.
 */
import {
  SERVICE_CONSECUTIVE_CRASHES_MAX,
  SERVICE_RESTART_BACKOFF_MS,
  type ServiceAuditEvent,
  type ServiceRestartPolicy,
} from '@recued/contracts';

import type { ServiceInstanceStateStore } from '../service-state-table.js';
import { redactArgvForAudit, resolveArgv, resolveEnv } from './refs.js';
import type {
  ServiceInstanceSpec,
  SpawnedProcess,
  StartOutcome,
  StopOutcome,
  SupervisorContext,
} from './types.js';

interface ProcessRecord {
  slug: string;
  spec: ServiceInstanceSpec;
  process: SpawnedProcess;
  /** Resolved argv after `{{config.*}}` substitution, with vault
   *  values redacted — landed straight into the audit `argv` field. */
  auditArgv: string[];
  /** True when a manual `stop()` initiated the teardown. Used by
   *  `handleExit` to classify the outcome as `'stopped'` regardless
   *  of the exit shape. */
  shuttingDown: boolean;
  /** Callbacks registered by in-flight `stop()` calls — each
   *  promise resolves once the child actually exits (handleExit
   *  drains this list). */
  stopResolvers: Array<() => void>;
}

interface PendingRestart {
  slug: string;
  spec: ServiceInstanceSpec;
  timer: NodeJS.Timeout;
}

export interface Supervisor {
  /** Start the instance. No-op when already running — returns the
   *  current pid / started_at. Blocks until the child is spawned
   *  and the state row is written; health polling lives in the
   *  separate health-loop module. */
  start(spec: ServiceInstanceSpec): Promise<StartOutcome>;
  /** Stop the instance. Honours argv-based or signal-based
   *  `lifecycle.stop` per spec. Cancels any pending restart timer
   *  even when no live process is tracked. */
  stop(slug: string): Promise<StopOutcome>;
  /** Reset the crash counter + `last_crash_at` after user clicks
   *  `[Clear & retry]`. Immediately follows with `start(spec)`. */
  clearCrash(spec: ServiceInstanceSpec): Promise<StartOutcome>;
  /** True when a ProcessRecord exists for this slug. */
  isTracked(slug: string): boolean;
  /** List slugs the supervisor currently tracks. */
  trackedSlugs(): string[];
  /** True when a restart timer is scheduled for this slug (post-
   *  crash, pre-respawn window). */
  hasPendingRestart(slug: string): boolean;
  /** Graceful shutdown — stop every tracked instance in parallel.
   *  Returns once every `stop()` resolves. */
  shutdown(): Promise<void>;
}

export const createSupervisor = (ctx: SupervisorContext): Supervisor => {
  const records = new Map<string, ProcessRecord>();
  const pendingRestarts = new Map<string, PendingRestart>();

  const emit = (evt: ServiceAuditEvent): void => { ctx.emitEvent(evt); };

  const writeStopped = (slug: string, exit_code: number): void => {
    ctx.stateStore.upsert(slug, {
      pid: null,
      started_at: null,
      last_exit_code: exit_code,
    });
  };

  const writeCrashed = (
    slug: string,
    exit_code: number,
    consecutive_crashes: number,
  ): void => {
    ctx.stateStore.upsert(slug, {
      pid: null,
      started_at: null,
      last_crash_at: ctx.now(),
      consecutive_crashes,
      last_exit_code: exit_code,
    });
  };

  const shouldRestart = (
    policy: ServiceRestartPolicy,
    exit_code: number | null,
    signal: NodeJS.Signals | null,
  ): boolean => {
    if (policy === 'never') return false;
    if (policy === 'always') return true;
    // on-crash — any non-zero exit OR any signal counts as a crash.
    return (exit_code ?? 0) !== 0 || signal !== null;
  };

  const scheduleRestart = (spec: ServiceInstanceSpec, delay: number): void => {
    const timer = ctx.setTimeout(() => {
      pendingRestarts.delete(spec.slug);
      // Ignore the promise — start() updates state + emits audit
      // on its own. Errors surface via audit, not via the timer.
      void start(spec);
    }, delay);
    pendingRestarts.set(spec.slug, { slug: spec.slug, spec, timer });
  };

  const cancelPendingRestart = (slug: string): boolean => {
    const pending = pendingRestarts.get(slug);
    if (!pending) return false;
    ctx.clearTimeout(pending.timer);
    pendingRestarts.delete(slug);
    return true;
  };

  const handleExit = (
    record: ProcessRecord,
    exit_code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    records.delete(record.slug);
    const effective_code = exit_code ?? -1;

    // Manual stop — classify as 'stopped' regardless of exit shape.
    if (record.shuttingDown) {
      writeStopped(record.slug, effective_code);
      emit({
        type: 'service_event',
        slug: record.slug,
        binary: record.auditArgv[0] ?? null,
        event_name: 'stopped',
        argv: record.auditArgv,
        error: null,
        timestamp: ctx.now(),
      });
      for (const r of record.stopResolvers) r();
      return;
    }

    const policy: ServiceRestartPolicy =
      record.spec.start?.restart_policy ?? 'on-crash';
    const willRestart = shouldRestart(policy, exit_code, signal);

    if (!willRestart) {
      writeStopped(record.slug, effective_code);
      emit({
        type: 'service_event',
        slug: record.slug,
        binary: record.auditArgv[0] ?? null,
        event_name: 'stopped',
        argv: record.auditArgv,
        error: null,
        timestamp: ctx.now(),
      });
      for (const r of record.stopResolvers) r();
      return;
    }

    // Crash path — bump the counter, decide backoff, schedule restart.
    const prior = ctx.stateStore.get(record.slug);
    const nextCount = (prior?.consecutive_crashes ?? 0) + 1;
    writeCrashed(record.slug, effective_code, nextCount);

    const errMsg =
      signal !== null
        ? `killed by ${signal}`
        : `exit ${effective_code}`;

    emit({
      type: 'service_event',
      slug: record.slug,
      binary: record.auditArgv[0] ?? null,
      event_name: 'crashed',
      argv: record.auditArgv,
      error: errMsg,
      timestamp: ctx.now(),
    });

    if (nextCount >= SERVICE_CONSECUTIVE_CRASHES_MAX) {
      for (const r of record.stopResolvers) r();
      return;
    }

    const backoff =
      SERVICE_RESTART_BACKOFF_MS[Math.min(
        nextCount - 1,
        SERVICE_RESTART_BACKOFF_MS.length - 1,
      )];
    scheduleRestart(record.spec, backoff);
    for (const r of record.stopResolvers) r();
  };

  const start = async (spec: ServiceInstanceSpec): Promise<StartOutcome> => {
    if (spec.start === null) {
      return { state: 'failed', pid: null, started_at: null, detail: 'no lifecycle.start' };
    }
    // A manual start supersedes any pending auto-restart.
    cancelPendingRestart(spec.slug);

    const existing = records.get(spec.slug);
    if (existing && existing.process.pid !== null) {
      const prior = ctx.stateStore.get(spec.slug);
      return {
        state: 'running',
        pid: existing.process.pid,
        started_at: prior?.started_at ?? null,
      };
    }

    const argv = resolveArgv(spec.start.argv, spec.config);
    const env = resolveEnv(
      spec.start.env,
      spec.config,
      spec.publisher_id,
      ctx.resolveVault,
    );
    const resolvedVault = new Map<string, string>();
    const vaultKeys = new Set<string>();
    if (spec.start.env) {
      for (const raw of Object.values(spec.start.env)) {
        const matches = raw.matchAll(/\{\{\s*vault\.([^}:\s]+)\s*\}\}/g);
        for (const m of matches) {
          const key = m[1];
          vaultKeys.add(key);
          const value = ctx.resolveVault?.(spec.publisher_id, key);
          if (value !== undefined) resolvedVault.set(key, value);
        }
      }
    }
    const auditArgv = redactArgvForAudit(argv, vaultKeys, resolvedVault);

    let child: SpawnedProcess;
    try {
      child = ctx.spawn(argv, {
        cwd: spec.start.cwd,
        env,
        detached: spec.start.detach ?? false,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const nextCount = (ctx.stateStore.get(spec.slug)?.consecutive_crashes ?? 0) + 1;
      writeCrashed(spec.slug, -1, nextCount);
      emit({
        type: 'service_event',
        slug: spec.slug,
        binary: auditArgv[0] ?? null,
        event_name: 'crashed',
        argv: auditArgv,
        error: `spawn failed: ${detail}`,
        timestamp: ctx.now(),
      });
      return { state: 'failed', pid: null, started_at: null, detail };
    }

    if (child.pid === null) {
      const nextCount = (ctx.stateStore.get(spec.slug)?.consecutive_crashes ?? 0) + 1;
      writeCrashed(spec.slug, -1, nextCount);
      emit({
        type: 'service_event',
        slug: spec.slug,
        binary: auditArgv[0] ?? null,
        event_name: 'crashed',
        argv: auditArgv,
        error: 'spawn returned null pid',
        timestamp: ctx.now(),
      });
      return { state: 'failed', pid: null, started_at: null };
    }

    const started_at = ctx.now();
    const record: ProcessRecord = {
      slug: spec.slug,
      spec,
      process: child,
      auditArgv,
      shuttingDown: false,
      stopResolvers: [],
    };
    records.set(spec.slug, record);
    ctx.stateStore.upsert(spec.slug, {
      pid: child.pid,
      started_at,
      last_crash_at: null,
    });
    child.onExit((code, signal) => { handleExit(record, code, signal); });

    emit({
      type: 'service_event',
      slug: spec.slug,
      binary: auditArgv[0] ?? null,
      event_name: 'started',
      argv: auditArgv,
      error: null,
      timestamp: started_at,
    });

    return { state: 'running', pid: child.pid, started_at };
  };

  const stop = async (slug: string): Promise<StopOutcome> => {
    // Cancel any pending auto-restart — no running process, no
    // need to signal, but the timer has to go.
    const hadPending = cancelPendingRestart(slug);
    const record = records.get(slug);
    if (!record) {
      if (hadPending) {
        // State store already marked stopped when the crash landed;
        // nothing more to write.
        return { state: 'stopped' };
      }
      return { state: 'stopped', detail: 'not running' };
    }
    record.shuttingDown = true;
    const stopSpec = record.spec.stop ?? {};
    const graceMs = stopSpec.grace_ms ?? 5_000;

    return new Promise<StopOutcome>((resolve) => {
      const graceTimer = ctx.setTimeout(() => {
        record.process.kill('SIGKILL');
      }, graceMs);
      record.stopResolvers.push(() => {
        ctx.clearTimeout(graceTimer);
        resolve({ state: 'stopped' });
      });

      if (stopSpec.argv && stopSpec.argv.length > 0) {
        try {
          // Kick off the stop argv — we don't await its exit; we
          // wait on the ORIGINAL child to exit (which handleExit
          // resolves).
          ctx.spawn(resolveArgv(stopSpec.argv, record.spec.config), {
            cwd: record.spec.start?.cwd,
          });
        } catch {
          // Fall back to signalling the child if we can't spawn
          // the stop cmd.
          record.process.kill(stopSpec.signal ?? 'SIGTERM');
        }
      } else {
        record.process.kill(stopSpec.signal ?? 'SIGTERM');
      }
    });
  };

  const clearCrash = async (spec: ServiceInstanceSpec): Promise<StartOutcome> => {
    cancelPendingRestart(spec.slug);
    ctx.stateStore.upsert(spec.slug, {
      consecutive_crashes: 0,
      last_crash_at: null,
    });
    return start(spec);
  };

  const shutdown = async (): Promise<void> => {
    // Cancel pending restarts first so shutdown doesn't race with
    // an auto-respawn.
    for (const slug of [...pendingRestarts.keys()]) {
      cancelPendingRestart(slug);
    }
    await Promise.all(
      [...records.keys()].map((slug) => stop(slug)),
    );
  };

  return {
    start,
    stop,
    clearCrash,
    isTracked: (slug) => records.has(slug),
    trackedSlugs: () => [...records.keys()],
    hasPendingRestart: (slug) => pendingRestarts.has(slug),
    shutdown,
  };
};
