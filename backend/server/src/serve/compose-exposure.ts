import type Database from 'better-sqlite3';
import type { AuditLogStore } from '@recued/storage';

import { composeExposureSubstrate } from '../composition/bin/wire-exposure-substrate.js';
import type { ExposureStateMachine } from '../exposure/index.js';
import type { EventBus } from '../events/bus.js';
import type { ProductionPathListenerCoordinator } from '../network/path-listener-coordinator.js';

export interface ComposeServeExposureOptions {
  readonly args: string[];
  readonly db: Database.Database | undefined;
  readonly auditLog: AuditLogStore | undefined;
  readonly listenerCoordinator: ProductionPathListenerCoordinator;
  readonly webhooksEnabled: boolean;
  readonly lanBindAddress: string;
  readonly wsHandleClientCount: () => number;
  /** Whether the server has an address people outside can use; the
   *  Exposure grid refuses every Public choice while it says no. */
  readonly hasPublicAddress: () => boolean;
  readonly publishExposureMachine: (machine: ExposureStateMachine) => void;
  /** D-121 broadcast bus, threaded to the exposure `broadcast` side
   *  effect so a transition fans `exposure_changed` to paired clients
   *  (M-XSURF-1). Absent in the db-less harness → best-effort no-op. */
  readonly eventBus?: EventBus;
}

export const composeServeExposure = async (
  options: ComposeServeExposureOptions,
): Promise<ExposureStateMachine> => {
  const {
    args,
    db,
    auditLog,
    listenerCoordinator,
    webhooksEnabled,
    lanBindAddress,
    wsHandleClientCount,
    hasPublicAddress,
    publishExposureMachine,
    eventBus,
  } = options;

  const { exposureMachine, finalize } = await composeExposureSubstrate({
    args,
    db,
    auditLog,
    listenerCoordinator,
    webhooksEnabled,
    lanBindAddress,
    wsHandleClientCount,
    hasPublicAddress,
    eventBus,
  });

  publishExposureMachine(exposureMachine);
  await finalize();

  return exposureMachine;
};
