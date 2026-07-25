import type { CalendarStack } from '../collections/calendar/compose.js';
import type { FileStack } from '../collections/file/compose.js';
import type { ServiceStack } from '../collections/service/compose.js';
import type { SupervisionStack } from '../supervision/compose-supervision-stack.js';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import type { EvictionCascade } from '../eviction-cascade.js';
import type { Lifecycle } from '../lifecycle/index.js';
import type { ListenerServerFacade } from './compose-listeners.js';

export interface ShutdownProcess {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code?: number): unknown;
}

export interface ShutdownDatabase {
  close(): unknown;
}

export interface InstallShutdownOptions {
  lifecycle: Pick<Lifecycle, 'install' | 'markBooted'> | undefined;
  backgroundServices: Pick<BackgroundServiceRegistry, 'stopAll'>;
  fileStack: Pick<FileStack, 'disposeAll'> | undefined;
  calendarStack: Pick<CalendarStack, 'disposeAll'> | undefined;
  serviceStack: Pick<ServiceStack, 'disposeAll'> | undefined;
  /** Optional — a db-less compose has no supervision stack; the real serve path
   *  always passes it. */
  supervisionStack?: Pick<SupervisionStack, 'disposeAll'> | undefined;
  cascade: Pick<EvictionCascade, 'close'> | undefined;
  server: Pick<ListenerServerFacade, 'close'>;
  db: ShutdownDatabase | undefined;
  processHandle?: ShutdownProcess;
  log?: (message?: unknown, ...optionalParams: unknown[]) => void;
}

export interface InstalledShutdown {
  /** Exposed for tests; production shutdown flows through SIGINT/SIGTERM. */
  fallbackShutdown?: () => Promise<void>;
}

export const installShutdown = (
  options: InstallShutdownOptions,
): InstalledShutdown => {
  const {
    lifecycle,
    backgroundServices,
    fileStack,
    calendarStack,
    serviceStack,
    supervisionStack,
    cascade,
    server,
    db,
  } = options;
  const processHandle = options.processHandle ?? process;
  const log = options.log ?? console.log;

  if (lifecycle) {
    // Phase C: the signal listener drives the drain + supervisor handoff.
    // markBooted flips booting -> running so rpc gating lifts +
    // `ServerStatus` surfaces the live uptime.
    lifecycle.install();
    lifecycle.markBooted();
    return {};
  }

  // Fallback for compositions without lifecycle (no db / no bootstrap
  // deps). Preserves Phase A/B behaviour.
  const shutdown = async (): Promise<void> => {
    log('\n  Shutting down...');
    // Stop every registered lifecycle service in one pass:
    // schedulers (cron / auto-run / housekeeping), periodic timers
    // (audit / s2s-preview / correction-events / reception snapshot).
    // The reverse-order walk + per-service try/catch in `stopAll`
    // matches the pre-extraction sequencing (housekeeping awaits
    // its in-flight cycle before db.close()). This path runs only
    // for compositions without lifecycle (no db / no bootstrap
    // deps); the lifecycle-driven shutdown uses filtered
    // `stopAll({ kind })` calls per drain step.
    await backgroundServices.stopAll();
    if (fileStack) {
      try { await fileStack.disposeAll(); } catch { /* swallow */ }
    }
    if (calendarStack) {
      try { await calendarStack.disposeAll(); } catch { /* swallow */ }
    }
    if (serviceStack) {
      try { await serviceStack.disposeAll(); } catch { /* swallow */ }
    }
    if (supervisionStack) {
      try { await supervisionStack.disposeAll(); } catch { /* swallow */ }
    }
    cascade?.close();
    try { await server.close(); } catch { /* swallow */ }
    if (db) db.close();
    log('  Bye.');
    processHandle.exit(0);
  };

  processHandle.on('SIGINT', () => { void shutdown(); });
  processHandle.on('SIGTERM', () => { void shutdown(); });
  return { fallbackShutdown: shutdown };
};
