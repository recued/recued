import { BACKUP_WATCHDOG_INTERVAL_MS } from '@recued/contracts';
import type { SchedulerBootContext, SchedulerSlot } from '../registry.js';
export const BACKUP_WATCHDOG_SCHEDULER_NAME = 'backup-watchdog';
export const bootBackupWatchdog = (ctx: Pick<SchedulerBootContext, 'registry' | 'backupWatchdog'>): SchedulerSlot<unknown> | undefined => {
  const service = ctx.backupWatchdog; if (!service) return undefined;
  ctx.registry.registerInterval({ name: 'backup-watchdog-ticks', intervalMs: BACKUP_WATCHDOG_INTERVAL_MS, tick: () => { void service.tick(); } });
  ctx.registry.register({ name: BACKUP_WATCHDOG_SCHEDULER_NAME, kind: 'scheduler', stop: () => service.stop(),
    settled: () => service.settled() });
  return { name: BACKUP_WATCHDOG_SCHEDULER_NAME, getHandle: () => service, rebuild: () => service.resume() };
};
