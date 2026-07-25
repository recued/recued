import { dirname } from 'node:path';

import type Database from 'better-sqlite3';
import type { AuditLogStore } from '@recued/storage';

import type { KeyManager } from '../key-manager.js';
import type { BootstrapHandlerDeps } from '../bootstrap-handler.js';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import type { SchedulersBundle } from '../composition/bin/wire-schedulers.js';
import type { EvictionCascade } from '../eviction-cascade.js';
import { createLifecycle, type Lifecycle } from '../lifecycle/index.js';
import { LockHeldError } from '../lifecycle/instance-lock.js';
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
  readonly storage: Pick<StorageContext, 'fileStack'>;
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
          await collection.collectionRegistry.dispose();
          if (storage.fileStack) {
            await storage.fileStack.disposeAll();
          }
          if (collection.calendarStack) {
            await collection.calendarStack.disposeAll();
          }
          if (collection.mailStack) {
            await collection.mailStack.disposeAll();
          }
          if (collection.serviceStack) {
            await collection.serviceStack.disposeAll();
          }
          if (collection.supervisionStack) {
            // Cancel the daemon supervisor's poll / restart timers so a
            // crash mid-drain can't trigger a relaunch as the server exits.
            // The daemons themselves are detached and survive (re-adopted on
            // the next boot).
            await collection.supervisionStack.disposeAll();
          }
        },
        pause_scheduler: async () => {
          getSchedulersBundle()?.cron?.getHandle()?.pause();
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
          await backgroundServices.stopAll({ kind: 'timer' });
          await backgroundServices.stopAll({ kind: 'emitter' });
        },
        close_cascade: async () => {
          cascade?.close();
        },
        close_db: async () => {
          try {
            db.close();
          } catch {
            /* best effort */
          }
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
      // D-178 slice 5 — the legacy D-108 crash-loop → npm-rollback flag is
      // retired (the whole `upgrade/` subsystem is deleted). Crash-loop
      // DETECTION stays in the supervisor (it still emits the
      // `crash_loop_detected` audit); the auto-rollback it used to trigger is
      // superseded by D-178's binary boot-failure-counter + apply-orchestrator
      // auto-revert. No `onCrashLoopDetected` flag write remains.
    });
    lifecycle.lock.claim({ boot_at: Date.now(), bind_port: base.port });
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

  bootstrapDeps.onRestartRequested = (reason) => {
    const lc = lifecycle;
    if (!lc) return;
    void lc
      .requestDrain({ intent: 'restart', reason: reason || 'rpc' })
      .then(() => {
        const code = lc.supervisor.handoff('restart');
        exit(code);
      })
      .catch((err) => {
        console.error('[lifecycle] restart drain failed', err);
        exit(1);
      });
  };
  bootstrapDeps.isDraining = () => lifecycle!.drain.state.active;

  return lifecycle;
};
