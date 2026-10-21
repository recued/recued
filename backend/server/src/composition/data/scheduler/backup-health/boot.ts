import type { SchedulerBootContext, SchedulerSlot } from '../registry.js';
export const BACKUP_HEALTH_SCHEDULER_NAME = 'backup-health';
/** Passive observation never waits for notification delivery in the tick. */
export const bootBackupHealth = (ctx: Pick<SchedulerBootContext, 'registry' | 'backupHealth'>): SchedulerSlot<unknown> | undefined => {
  const service = ctx.backupHealth; if (!service) return undefined;
  ctx.registry.registerInterval({ name: 'backup-health-ticks', intervalMs: 60_000, tick: () => { void service.tick(); } });
  ctx.registry.register({ name: BACKUP_HEALTH_SCHEDULER_NAME, kind: 'scheduler', stop: () => service.stop() });
  return { name: BACKUP_HEALTH_SCHEDULER_NAME, getHandle: () => service, rebuild: () => service.resume() };
};
