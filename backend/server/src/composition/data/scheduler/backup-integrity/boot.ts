import type { SchedulerBootContext, SchedulerSlot } from '../registry.js';
export const BACKUP_INTEGRITY_SCHEDULER_NAME = 'backup-integrity';
export const bootBackupIntegrity = (ctx: Pick<SchedulerBootContext, 'registry' | 'backupIntegrity'>): SchedulerSlot<unknown> | undefined => {
  const service = ctx.backupIntegrity; if (!service) return undefined;
  ctx.registry.registerInterval({ name: 'backup-integrity-ticks', intervalMs: 60_000, tick: () => { void service.tick(); } });
  ctx.registry.register({ name: BACKUP_INTEGRITY_SCHEDULER_NAME, kind: 'scheduler', stop: () => service.stop(),
    settled: () => service.settled() });
  return { name: BACKUP_INTEGRITY_SCHEDULER_NAME, getHandle: () => service, rebuild: () => service.resume() };
};
