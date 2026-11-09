import type { SchedulersBundle } from '../composition/bin/wire-schedulers.js';
import type { ScheduleHandlerDeps } from '../schedule-handler.js';
import type { EventTriggerDispatcher } from '../triggers/dispatcher.js';
import type { PollManagerHandle } from '../watch/poll-manager.js';
import {
  composeBootstrapCascadeContext,
  type BootstrapCascadeContext,
  type ComposeBootstrapCascadeContextOptions,
} from './compose-bootstrap-cascade-context.js';
import {
  composeMaintenanceContext,
  type ComposeMaintenanceContextOptions,
  type MaintenanceContext,
} from './compose-maintenance-context.js';
import {
  startLifecycleRecoveryPreListenerRuntime,
  type LifecycleRecoveryPreListenerRuntimeResult,
  type StartLifecycleRecoveryPreListenerRuntimeOptions,
} from './start-lifecycle-recovery-pre-listener-runtime.js';
import { housekeepingSchedulerRegistry } from '../composition/bin/housekeeping-scheduler-instance.js';

type BootstrapCascadeLifecycleKeys = 'bootstrapDeps' | 'cascade';
type BootstrapMaintenancePreListenerKeys =
  | 'bootstrapDeps'
  | 'scheduleDeps'
  | 'dishDeps'
  | 'migrateDeps'
  | 'pressureDeps'
  | 'scheduleStore'
  | 'circuitStore'
  | 'autoRunSettingsStore';
type SchedulerBindingKeys = 'getSchedulersBundle' | 'publishSchedulersBundle';

export interface StartPostExecutionBootstrapMaintenanceRuntimeOptions {
  readonly bootstrapCascade: ComposeBootstrapCascadeContextOptions;
  readonly maintenance: Omit<
    ComposeMaintenanceContextOptions,
    'getSchedulersBundle' | 'getEventTriggerDispatcher' | 'getWatchManager'
  >;
  readonly runtime: Omit<
    StartLifecycleRecoveryPreListenerRuntimeOptions,
    SchedulerBindingKeys | 'lifecycle' | 'preListener'
  > & {
    readonly lifecycle: Omit<
      StartLifecycleRecoveryPreListenerRuntimeOptions['lifecycle'],
      BootstrapCascadeLifecycleKeys
    >;
    readonly preListener: Omit<
      StartLifecycleRecoveryPreListenerRuntimeOptions['preListener'],
      BootstrapMaintenancePreListenerKeys
    >;
  };
  readonly publishScheduleDeps?: (deps: ScheduleHandlerDeps | undefined) => void;
  /** D-188 — move the mail and calendar poll loops on the pause's edges
   *  (`CollectionContext.applyServerPause`). Absent ⇒ sync is not held by the pause. */
  readonly applyServerPause?: () => Promise<void>;
}

export interface PostExecutionBootstrapMaintenanceRuntimeResult {
  readonly bootstrapCascade: BootstrapCascadeContext;
  readonly maintenance: MaintenanceContext;
  readonly runtime: LifecycleRecoveryPreListenerRuntimeResult;
  readonly schedulersBundle: SchedulersBundle | undefined;
}

export const startPostExecutionBootstrapMaintenanceRuntime = async (
  options: StartPostExecutionBootstrapMaintenanceRuntimeOptions,
): Promise<PostExecutionBootstrapMaintenanceRuntimeResult> => {
  const bootstrapCascade = composeBootstrapCascadeContext(options.bootstrapCascade);

  let schedulersBundle: SchedulersBundle | undefined;
  let eventTriggerDispatcher: EventTriggerDispatcher | undefined;
  let watchManager: PollManagerHandle | undefined;
  const maintenance = composeMaintenanceContext({
    ...options.maintenance,
    getSchedulersBundle: () => schedulersBundle,
    // Reactive-substrate slice 1 (codex HIGH fold) — late-bound like
    // the schedulers bundle; assigned from the listener runtime result
    // below so maintenance exit can re-subscribe trigger patterns.
    getEventTriggerDispatcher: () => eventTriggerDispatcher,
    // Poll-manager / G6 — same late binding for the watch manager.
    getWatchManager: () => watchManager,
  });
  options.publishScheduleDeps?.(maintenance.scheduleDeps);

  // D-188 — wire the master-pause side-effect: engage → stop the server's
  // own autonomous execution (cron / auto-run / housekeeping / reactive +
  // watch); release → re-arm. The op-admission-gate freeze + webhook
  // closure read the persisted flag live; this seam covers the autonomous
  // work that is contract-free (so it bypasses the gate). Set before the
  // listener starts (below) — no pause rpc can arrive first. The control's
  // getters are late-bound, so the closure is safe to set before the
  // bundles publish during the runtime call.
  if (bootstrapCascade.bootstrapDeps) {
    // D-188 — and the mail and calendar poll loops hold or run with it: nothing comes in during
    // the emergency stop (the owner's ruling of 2026-11-08). Both run even when one throws.
    bootstrapCascade.bootstrapDeps.onPauseChanged = async (paused): Promise<void> => {
      const [work, sync] = await Promise.allSettled([
        paused
          ? maintenance.executionControl.stop()
          // Housekeeping too, which the shared re-arm leaves to a restart (a maintenance
          // window's rule, not a pause's).
          : maintenance.executionControl.rearm().finally(() => housekeepingSchedulerRegistry.resume()),
        options.applyServerPause?.(),
      ]);
      if (work.status === 'rejected') throw work.reason;
      if (sync.status === 'rejected') throw sync.reason;
    };
  }

  const runtime = await startLifecycleRecoveryPreListenerRuntime({
    ...options.runtime,
    lifecycle: {
      ...options.runtime.lifecycle,
      bootstrapDeps: bootstrapCascade.bootstrapDeps,
      cascade: bootstrapCascade.cascade,
    },
    recovery: options.runtime.recovery,
    preListener: {
      ...options.runtime.preListener,
      bootstrapDeps: bootstrapCascade.bootstrapDeps,
      scheduleDeps: maintenance.scheduleDeps,
      dishDeps: maintenance.dishDeps,
      migrateDeps: maintenance.migrateDeps,
      pressureDeps: bootstrapCascade.pressureDeps,
      scheduleStore: maintenance.scheduleStore,
      circuitStore: maintenance.circuitStoreRef,
      autoRunSettingsStore: maintenance.autoRunSettingsStoreRef,
    },
    getSchedulersBundle: () => schedulersBundle,
    publishSchedulersBundle: (bundle) => {
      schedulersBundle = bundle;
    },
    publishEventTriggerDispatcher: (dispatcher) => {
      eventTriggerDispatcher = dispatcher;
    },
    publishWatchManager: (manager) => {
      watchManager = manager;
    },
    // D-169 P0 follow-on (Codex 2026-05-28 Angle 2 fold) — forwarded so
    // composeListeners publishes the live dispatcher BEFORE schedulers.
    ...(options.runtime.publishBridgeDispatcher
      ? { publishBridgeDispatcher: options.runtime.publishBridgeDispatcher }
      : {}),
  });

  return {
    bootstrapCascade,
    maintenance,
    runtime,
    schedulersBundle,
  };
};
