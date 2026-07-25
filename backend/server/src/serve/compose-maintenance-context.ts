import { dirname, join, resolve } from 'node:path';

import {
  createAutoRunSettingsStore,
  createCircuitBreakerStore,
  type AutoRunSettingsStore,
  type CircuitBreakerStore,
} from '../auto-run-scheduler.js';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import type { SchedulersBundle } from '../composition/bin/wire-schedulers.js';
import type { MigrateDeps } from '../migration/auth-migrate-handler.js';
import { createMigrationStateStore } from '../migration/migration-state.js';
import { createVerificationStore } from '../migration/verification-store.js';
import type { DishHandlerDeps } from '../dish-handler.js';
import { createDishContextStore, type DishContextStore } from '../dish-context-store.js';
import { createDishStore, type DishStore } from '../dish-store.js';
import { createDishGroupStore, type DishGroupStore } from '../dish-group-store.js';
import type { ScheduleHandlerDeps } from '../schedule-handler.js';
import { createScheduleStore, type ScheduleStore } from '../schedule-store.js';
import type { EventTriggerDispatcher } from '../triggers/dispatcher.js';
import type { PollManagerHandle } from '../watch/poll-manager.js';
import type { AppContext } from './compose-app-context.js';
import type { StorageContext } from './compose-storage-context.js';

export interface MaintenanceContext {
  readonly scheduleStore: ScheduleStore | undefined;
  readonly scheduleDeps: ScheduleHandlerDeps | undefined;
  /** D-179 P1 — standing-dish store + per-dish continuity store +
   *  the `dishes.*` rpc deps. Same one-instance-per-boot posture as
   *  schedules; undefined on dbless boots. */
  readonly dishStore: DishStore | undefined;
  /** D-179 P3 — dish-group store (workflow containers). */
  readonly dishGroupStore: DishGroupStore | undefined;
  readonly dishContextStore: DishContextStore | undefined;
  readonly dishDeps: DishHandlerDeps | undefined;
  readonly circuitStoreRef: CircuitBreakerStore | undefined;
  /** Reactive-substrate slice 1 — per-recipe auto-run arm/disarm
   *  store. One instance threads to BOTH the scheduler boot
   *  (roster consult) and the `auto_run.*` rpc deps (toggle writes),
   *  mirroring how `circuitStoreRef` is shared. */
  readonly autoRunSettingsStoreRef: AutoRunSettingsStore | undefined;
  readonly migrateDeps: MigrateDeps | undefined;
  /** D-188 — stop / re-arm the server's autonomous execution. The SAME
   *  enter/exit the migration maintenance window uses; the master "Pause
   *  server" wires it to `bootstrapDeps.onPauseChanged`. Always present
   *  (the getters are late-bound, so it's safe to construct dbless). */
  readonly executionControl: AutonomousExecutionControl;
}

/** D-188 — the autonomous-execution pause primitive, shared by the master
 *  pause AND the migration maintenance window so the two can never drift.
 *  `stop()` halts every `kind:'scheduler'` background service (cron /
 *  auto-run / housekeeping + the trigger subscriptions + watch loops);
 *  `rearm()` rebuilds them. The owner's contract-free HID + the resume rpc
 *  are NOT background services, so they stay live across a stop (the
 *  "paired-live, can resume" property). */
export interface AutonomousExecutionControl {
  /** Halt all autonomous execution (pause engage / maintenance enter). */
  stop(): Promise<void>;
  /** Re-arm all autonomous execution (pause release / maintenance exit). */
  rearm(): Promise<void>;
}

/** Build an {@link AutonomousExecutionControl} over the late-bound
 *  scheduler / trigger / watch getters. Stateless; safe to construct
 *  before the bundles are published (the getters resolve at call time). */
export const createAutonomousExecutionControl = (refs: {
  backgroundServices: BackgroundServiceRegistry;
  getSchedulersBundle: () => SchedulersBundle | undefined;
  getEventTriggerDispatcher: () => EventTriggerDispatcher | undefined;
  getWatchManager: () => PollManagerHandle | undefined;
}): AutonomousExecutionControl => ({
  async stop() {
    // Stops cron / auto-run / housekeeping schedulers AND the disposes the
    // trigger subscriptions + watch loops (all registered `kind:'scheduler'`).
    await refs.backgroundServices.stopAll({ kind: 'scheduler' });
  },
  async rearm() {
    // Mirror of `stop()` — rebuild each subsystem the stopAll tore down.
    refs.getSchedulersBundle()?.rebuildAll();
    // Re-subscribe the enabled trigger set the stop disposed.
    refs.getEventTriggerDispatcher()?.rebuild();
    // Re-arm the watch loops the stop drained (recompute clears the stopped
    // latch + re-arms every demanded loop from persisted state).
    refs.getWatchManager()?.recompute();
  },
});

export type MaintenanceStorageContext = Omit<
  Pick<
    StorageContext,
    'db' | 'gateRegistry' | 'serverInstanceId' | 'auditLog' | 'eventBus'
  >,
  'db'
> & {
  readonly db: StorageContext['db'] | undefined;
};

export interface ComposeMaintenanceContextOptions {
  readonly dbPath: string;
  readonly storage: MaintenanceStorageContext;
  readonly app: Pick<AppContext, 'keys' | 'bundleStoreRef'>;
  readonly backgroundServices: BackgroundServiceRegistry;
  readonly getSchedulersBundle: () => SchedulersBundle | undefined;
  /** Reactive-substrate slice 1 (codex HIGH fold) — late-bound
   *  event-trigger dispatcher. Maintenance enter stops it via the
   *  background-services `kind: 'scheduler'` walk; exit re-subscribes
   *  the enabled trigger set here, alongside `rebuildAll()`. Without
   *  this, a migration would leave every armed trigger silently
   *  unsubscribed until daemon restart or an unrelated trigger CRUD
   *  call. Same late-binding contract as `getSchedulersBundle` — the
   *  dispatcher composes with the listeners, after this context. */
  readonly getEventTriggerDispatcher: () => EventTriggerDispatcher | undefined;
  /** Poll-manager / G6 — late-bound watch manager, same contract as
   *  the dispatcher getter above. Maintenance enter stops it via the
   *  background-services `kind: 'scheduler'` walk; exit recomputes
   *  here (recompute clears the manager's stopped latch + re-arms
   *  every demanded loop from persisted state). */
  readonly getWatchManager: () => PollManagerHandle | undefined;
}

export const composeMaintenanceContext = (
  options: ComposeMaintenanceContextOptions,
): MaintenanceContext => {
  const {
    dbPath,
    storage,
    app,
    backgroundServices,
    getSchedulersBundle,
    getEventTriggerDispatcher,
    getWatchManager,
  } = options;
  const {
    db,
    gateRegistry,
    serverInstanceId,
    auditLog,
    eventBus,
  } = storage;

  // D-188 — one control shared by the master pause + migration maintenance.
  const executionControl = createAutonomousExecutionControl({
    backgroundServices,
    getSchedulersBundle,
    getEventTriggerDispatcher,
    getWatchManager,
  });

  // D-179 P1 — dishes (built before scheduleDeps so the schedule rpc
  // can validate dish bindings at create time). No Phase B gate: the
  // gate registry has no `dishes` namespace yet; dish rows are small
  // (name + overlay) and user-pruned.
  const dishStore: DishStore | undefined = db ? createDishStore(db) : undefined;
  // D-179 P3 — groups share the dishes' no-gate posture.
  const dishGroupStore: DishGroupStore | undefined = db
    ? createDishGroupStore(db)
    : undefined;
  const dishContextStore: DishContextStore | undefined = db
    ? createDishContextStore(db)
    : undefined;
  const dishDeps: DishHandlerDeps | undefined = dishStore
    ? {
        store: dishStore,
        ...(dishGroupStore ? { groupStore: dishGroupStore } : {}),
        ...(dishContextStore ? { contextStore: dishContextStore } : {}),
        auditLog,
      }
    : undefined;

  const scheduleStore: ScheduleStore | undefined = db
    ? createScheduleStore(db, {
        onBytesChanged: (delta) => {
          if (gateRegistry) gateRegistry.schedules.addUsed(delta);
        },
      })
    : undefined;
  const scheduleDeps: ScheduleHandlerDeps | undefined = scheduleStore
    ? {
        store: scheduleStore,
        // D-179 P2 — create-time dish-binding validation.
        ...(dishStore ? { dishStore } : {}),
        // D-179 config-on-schedule — clear the managed dish's continuity
        // snapshot when a schedule's overlay dish is dissolved on delete.
        ...(dishContextStore ? { dishContextStore } : {}),
        instanceId: serverInstanceId,
        gate: gateRegistry?.schedules,
        auditLog,
        eventBus,
      }
    : undefined;

  const circuitStoreRef: CircuitBreakerStore | undefined = db
    ? createCircuitBreakerStore(db)
    : undefined;

  const autoRunSettingsStoreRef: AutoRunSettingsStore | undefined = db
    ? createAutoRunSettingsStore(db)
    : undefined;

  let migrateDeps: MigrateDeps | undefined;
  if (db && app.keys && app.bundleStoreRef) {
    const blobRoot = join(dirname(resolve(dbPath)), 'blobs');
    migrateDeps = {
      db,
      blobRoot,
      keys: app.keys,
      bundleStore: app.bundleStoreRef,
      migrationState: createMigrationStateStore(db),
      verifications: createVerificationStore(),
      // D-188 — the maintenance window stops/re-arms autonomous execution
      // through the SAME control the master pause uses (extracted so the two
      // can't drift). Behaviour-preserving: stop() = stopAll({scheduler});
      // rearm() = rebuildAll + triggerDispatcher.rebuild + watchManager.recompute.
      onEnterMaintenance: () => executionControl.stop(),
      onExitMaintenance: () => executionControl.rearm(),
    };
  }

  return {
    scheduleStore,
    scheduleDeps,
    dishStore,
    dishGroupStore,
    dishContextStore,
    dishDeps,
    circuitStoreRef,
    autoRunSettingsStoreRef,
    migrateDeps,
    executionControl,
  };
};
