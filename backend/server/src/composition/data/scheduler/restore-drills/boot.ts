import type { SchedulerBootContext, SchedulerSlot } from '../registry.js';
export const RESTORE_DRILL_SERVICE_NAME = 'restore-drills';
/** Drills have no timer. Register them with the same maintenance/drain owner
 * as backups so admitted disk work settles before the server closes storage. */
export const bootRestoreDrills = (ctx: Pick<SchedulerBootContext, 'registry' | 'restoreDrills'>): SchedulerSlot<unknown> | undefined => {
  const service = ctx.restoreDrills; if (!service) return undefined;
  ctx.registry.register({ name: RESTORE_DRILL_SERVICE_NAME, kind: 'scheduler', stop: () => service.stop() });
  return { name: RESTORE_DRILL_SERVICE_NAME, getHandle: () => service, rebuild: () => service.resume() };
};
