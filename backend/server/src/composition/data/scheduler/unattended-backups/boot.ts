import type { SchedulerBootContext, SchedulerSlot } from '../registry.js';
export const UNATTENDED_BACKUP_SCHEDULER_NAME = 'unattended-backups';
export const bootUnattendedBackups = (ctx: Pick<SchedulerBootContext, 'registry' | 'unattendedBackups'>): SchedulerSlot<unknown> | undefined => {
  const service = ctx.unattendedBackups; if (!service) return undefined;
  ctx.registry.registerInterval({ name: 'unattended-backup-ticks', intervalMs: 60_000, tick: () => service.tick() });
  ctx.registry.register({ name: UNATTENDED_BACKUP_SCHEDULER_NAME, kind: 'scheduler', stop: () => service.stop() });
  return { name: UNATTENDED_BACKUP_SCHEDULER_NAME, getHandle: () => service, rebuild: () => service.resume() };
};
