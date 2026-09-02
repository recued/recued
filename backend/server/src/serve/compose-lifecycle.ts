import { DRAIN_STEP_NAMES } from '@recued/contracts';
import { dirname } from 'node:path';

import type Database from 'better-sqlite3';
import type { AuditLogStore } from '@recued/storage';

import type { KeyManager } from '../key-manager.js';
import type { BootstrapHandlerDeps } from '../bootstrap-handler.js';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import type { SchedulersBundle } from '../composition/bin/wire-schedulers.js';
import type { EvictionCascade } from '../eviction-cascade.js';
import { createLifecycle, type Lifecycle
} from '../lifecycle/index.js';
import { LockHeldError } from '../lifecycle/instance-lock.js';
import { EXIT_LOCK_HELD } from '../launcher/managed-launcher.js';
import { inspectUpdateLease, updateLeasePathFor } from '../update/update-lease.js';
import { releaseEarlyBootUpdateLease } from '../update/early-boot-update-lease.js';
import { resolveUpdateBinaryPath } from '../update/release-config.js';
import type { CollectionContext } from './compose-collection-context.js';
import type { StorageContext } from './compose-storage-context.js';
import type { BaseContext } from './compose-base-context.js';

export interface ServeHttpServerRef {
  close(): Promise<void>;
}

export interface ComposeServeLifecycleOptions {
  readonly db: Database.Database | undefined;
  readonly bootstrapDeps: BootstrapHandlerDeps | undefined;
  readonly base: Pick<
    BaseContext,
    'dbPath' | 'port' | 'distribution' | 'loadedConfig' | 'runtimeConfig'
  >;
  readonly serverVersion: string;
  readonly auditLog: AuditLogStore | undefined;
  /** Late-bound accessor for the live server KeyManager (`app.keys`), passed
   *  straight through to the archive rpc deps (blob-encryption fix Phase 2 —
   *  export decrypts the encrypted cache_blobs root under it). A getter because
   *  the KeyManager is published after this bag is assembled in the boot order;
   *  `composeServeLifecycle` itself never calls it. Absent on a keyless /
   *  db-less boot. */
  readonly getKeys?: () => KeyManager | undefined;
  readonly storage: Pick<StorageContext, 'fileStack' | 'drainAuditWrites'>;
  readonly collection: Pick<
    CollectionContext,
    'collectionRegistry' | 'calendarStack' | 'mailStack' | 'serviceStack' | 'supervisionStack'
  >;
  readonly backgroundServices: BackgroundServiceRegistry;
  readonly cascade: EvictionCascade | undefined;
  readonly getHttpServer: () => ServeHttpServerRef | undefined;
  readonly getSchedulersBundle: () => SchedulersBundle | undefined;
  /** D-178 P1 restart-drain follow-up — live count of runs the cron
   *  in-flight counter does NOT see (owner / MCP / chat / reactive /
   *  scheduled runs tracked by the in-flight registry between
   *  `registerRun` and `completeRun`). Folded into the drain's
   *  `await_inflight` step so a restart waits for engine work the
   *  scheduler is blind to, not just the cron tick. Absent → 0. */
  readonly getActiveRunCount?: () => number;
  readonly exit?: (code: number) => void;
}

export const composeServeLifecycle = async (
  options: ComposeServeLifecycleOptions,
): Promise<Lifecycle | undefined> => {
  const {
    db,
    bootstrapDeps,
    base,
    serverVersion,
    auditLog,
    storage,
    collection,
    backgroundServices,
    cascade,
    getHttpServer,
    getSchedulersBundle,
    getActiveRunCount,
    exit = (code: number): never => process.exit(code),
  } = options;

  if (!db || !bootstrapDeps) return undefined;

  let lifecycle: Lifecycle | undefined;
  const dataPath = dirname(base.dbPath);

  // Apply the crash-loop kill switch to the storage gates — the call that
  // ACTUALLY halts writes. The `serverState.setCrashHalt` flag alone does
  // NOT block writes (the gate is an in-memory latch that rejects only when
  // explicitly halted); before this, the only `gate.halt` lived in the
  // now-removed `server.setCrashHalt` rpc, so a crash-loop set the flag
  // WITHOUT halting writes. On release we resume ONLY gates halted BY the
  // kill switch, so a crash-loop reset never clears an independent storage-
  // pressure / admin-override halt.
  const applyCrashHaltToGates = (active: boolean): void => {
    for (const g of bootstrapDeps.gates ?? []) {
      if (active) g.halt('crash_halt');
      else if (g.info().haltReason === 'crash_halt') g.resume();
    }
  };

  try {
    lifecycle = createLifecycle({
      db,
      dataPath,
      bindPort: base.port,
      version: serverVersion,
      configPath: base.loadedConfig.source,
      distribution: base.distribution,
      initialBootstrap: base.loadedConfig.bootstrap,
      initialRuntime: base.loadedConfig.runtime,
      runtimeStore: base.runtimeConfig,
      serverState: bootstrapDeps.state,
      onCrashHaltChange: applyCrashHaltToGates,
      auditLog,
      log: (level, msg, data) => {
        const fn = level === 'error' ? console.error : console.log;
        fn(`[lifecycle] ${msg}`, data ?? '');
      },
      drainSteps: {
        pause_collections: async () => {
          const begin = (stop: () => Promise<void>): Promise<void> => {
            try { return Promise.resolve(stop()); }
            catch (err) { return Promise.reject(err); }
          };
          // Begin every stop before awaiting any one of them. A failed file
          // watcher must not prevent calendar, mail, service, or daemon
          // admission from closing during the same drain.
          const drains = [
            begin(() => collection.collectionRegistry.dispose()),
            ...(storage.fileStack
              ? [begin(() => storage.fileStack!.disposeAll())]
              : []),
            ...(collection.calendarStack
              ? [begin(() => collection.calendarStack!.disposeAll())]
              : []),
            ...(collection.mailStack
              ? [begin(() => collection.mailStack!.disposeAll())]
              : []),
            ...(collection.serviceStack
              ? [begin(() => collection.serviceStack!.disposeAll())]
              : []),
            // Cancel daemon supervisor poll/restart timers. Detached daemons
            // survive and are re-adopted on the next boot.
            ...(collection.supervisionStack
              ? [begin(() => collection.supervisionStack!.disposeAll())]
              : []),
          ];
          const results = await Promise.allSettled(drains);
          const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map((result) => result.reason);
          if (errors.length > 0) {
            throw new AggregateError(errors, 'one or more collection stacks failed to stop');
          }
        },
        pause_scheduler: async () => {
          // Stop the complete autonomous-execution family, not only cron. The
          // registry owns cron, auto-run, housekeeping, trigger subscriptions,
          // and watch loops under the scheduler kind; each stop closes its own
          // admission and drains admitted work before await_inflight observes a
          // stable zero. A cron-only pause left every sibling able to enqueue
          // database work after that fence.
          await backgroundServices.stopAll({ kind: 'scheduler' });
        },
        close_ws: async () => {
          const httpServer = getHttpServer();
          if (httpServer) {
            try {
              await httpServer.close();
            } catch {
              /* best effort */
            }
          }
        },
        stop_timers: async () => {
          // Close both admissions before waiting for either class. A slow timer
          // drain must not leave an emitter able to enqueue fresh DB work.
          const results = await Promise.allSettled([
            backgroundServices.stopAll({ kind: 'timer' }),
            backgroundServices.stopAll({ kind: 'emitter' }),
          ]);
          const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .flatMap((result) => result.reason instanceof AggregateError
              ? result.reason.errors
              : [result.reason]);
          if (errors.length > 0) {
            throw new AggregateError(errors, 'one or more background services failed to stop');
          }
        },
        close_cascade: async () => {
          await cascade?.close();
        },
        flush_audit: async () => {
          await storage.drainAuditWrites?.();
        },
        close_db: async () => {
          // Do not disguise a failed close as a completed drain step. Normal
          // shutdown still proceeds best-effort, while online archive restore
          // uses the aborted result to refuse an unsafe database swap.
          db.close();
        },
      },
      // D-178 P1 restart-drain follow-up — the `await_inflight` drain step
      // now awaits BOTH the cron in-flight counter AND the in-flight
      // registry's active runs (owner / MCP / chat / reactive / scheduled
      // work the scheduler tick doesn't see). Benefits every restart
      // trigger, closing the check→restart admission window the apply-path
      // quiesce check left open. Late-bound (`getActiveRunCount`) — absent → 0.
      getInFlightCount: () => {
        const cron = getSchedulersBundle()?.cron?.getHandle()?.inFlight() ? 1 : 0;
        const active = getActiveRunCount?.() ?? 0;
        return cron + active;
      },
      exit,
      // D-178 slice 5 — the legacy D-108 crash-loop → npm-rollback flag is
      // retired (the whole `upgrade/` subsystem is deleted). Crash-loop
      // DETECTION stays in the supervisor (it still emits the
      // `crash_loop_detected` audit); the auto-rollback it used to trigger is
      // superseded by D-178's binary boot-failure-counter + apply-orchestrator
      // auto-revert. No `onCrashLoopDetected` flag write remains.
    });
    lifecycle.lock.claim({ boot_at: Date.now(), bind_port: base.port });
    // `bin.ts` took the HOST-wide update lease before it touched an interrupted
    // pair and kept it across the native-addon/database-open graph. The realm is
    // now claimed, so release that early lease: an updater arriving afterwards
    // sees this realm, while a boot arriving during an updater cannot reach the
    // database at all. Holding it for the server lifetime would block every
    // other realm on this install from updating.
    releaseEarlyBootUpdateLease();
    // A CLI can claim in the instant after the release above. Inspect once more
    // so both participants back off cleanly; its mandatory post-claim realm
    // re-check sees our claim and will not touch the database.
    //
    // ⚠ EXIT 4, NOT A CRASH. `EXIT_LOCK_HELD` is the code both supervisors
    // already read as "someone else owns this — halt cleanly", so this cannot be
    // mistaken for a boot failure. It matters: a boot failure DURING an apply is
    // counted against the release being staged, and three would revert it.
    // ⚠ THE SAME DERIVATION, FROM THE SAME INPUT, AS THE OTHER SIDE. The lease
    // path is `dirname(<the binary an update would swap>)`, and this reads it via
    // the function the CLI uses off the environment the CLI reads — not off
    // `base.distribution`, which is this composition's own view and could differ.
    // Two participants computing one path by two routes is a lock neither holds.
    const updateHolder = inspectUpdateLease(
      updateLeasePathFor(resolveUpdateBinaryPath(process.env)),
    );
    if (updateHolder !== null && updateHolder.pid !== process.pid) {
      lifecycle.lock.release();
      console.error(
        `[lifecycle] an update is in progress on this install (pid ${updateHolder.pid}, `
        + `${updateHolder.operation}) — not starting, because it is about to replace the `
        + 'binary and may restore the database. Start the server again once it finishes.',
      );
      exit(EXIT_LOCK_HELD);
      return undefined;
    }
    // Boot-persistence: the kill-switch flag survives a restart, but the
    // storage gates are freshly constructed in the `running` state, so a
    // crash-loop halt that outlived the process would silently lapse. Replay
    // the persisted flag onto the gates at boot so writes stay blocked until
    // `server.resetCrashLoop`. (`getStatus` already reports it from the flag.)
    if (bootstrapDeps.state.isCrashHaltActive()) {
      applyCrashHaltToGates(true);
    }
  } catch (err) {
    if (err instanceof LockHeldError) {
      console.error(
        `[lifecycle] another recued is already running on port ${err.holder.bind_port} (pid ${err.holder.pid}).`,
      );
      if (lifecycle?.supervisor.mode === 'dev') {
        console.error(
          '  stop the other instance or pick a different --db path before starting again.',
        );
      }
      exit(4);
      return undefined;
    }
    throw err;
  }

  bootstrapDeps.onRestartRequested = (reason, onDrained) => {
    const lc = lifecycle;
    if (!lc) return;
    void lc
      .requestDrain({ intent: 'restart', reason: reason || 'rpc' })
      .then(async (result) => {
        // ⛔ "Drained" means EVERY step ran and none aborted — the same bar the
        // archive runtime's staged-restore commit uses, for the same reason:
        // `close_db` is one of those steps, and a caller that replaces the
        // database FILE needs it to have actually happened. A partial drain can
        // leave a writer holding it, so that reports NOT ok.
        // ⛔ READ THE RESULT DEFENSIVELY. A shape without these arrays threw here,
        // and the throw escaped into `.catch` — which does NOT restart, it exits
        // 1. So a malformed drain result cost the RESTART, not just the revert.
        // Missing data reads as "not drained": the disk work is skipped (safe)
        // and the handoff still happens (correct).
        const completed: readonly string[] = result?.completed ?? [];
        const aborted: readonly unknown[] = result?.aborted ?? [];
        const drainOk =
          aborted.length === 0
          && DRAIN_STEP_NAMES.every((step) => completed.includes(step));
        if (onDrained) await onDrained(drainOk);
        const code = lc.supervisor.handoff('restart');
        exit(code);
      })
      .catch(async (err) => {
        console.error('[lifecycle] restart drain failed', err);
        // A drain that REJECTED did not complete, so it takes the same
        // change-nothing path rather than being skipped silently.
        if (onDrained) {
          try { await onDrained(false); } catch { /* the restart is what matters */ }
        }
        exit(1);
      });
  };
  bootstrapDeps.isDraining = () => lifecycle!.drain.state.active;

  return lifecycle;
};
