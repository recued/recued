/** Long-horizon audit harness — instrumented REAL boot.
 *
 *  ⛔ The point of this file is that it boots the SAME composition root
 *  production uses (`serve-entry.ts` → `start-post-storage-app-collection-
 *  execution-runtime.ts` → …), not a hand-assembled subset. A subsystem
 *  that fails to register in production fails to register here, and the
 *  inventory below reports it as absent rather than silently omitting it.
 *
 *  Instrumentation is applied to the two module-level singletons BEFORE
 *  `serve()` runs, so every `registerInterval` / `register` call made
 *  anywhere in the boot chain is captured with its spec. The wrappers
 *  DELEGATE to the real registry — `.unref()`, `fireImmediate`, and the
 *  stop pathways all keep their production behaviour. We only additionally
 *  retain `spec.tick` so the sweep can drive a cadence-bound task more than
 *  once without waiting its real interval.
 *
 *  ⚠ Real intervals stay armed. Every registered cadence in this codebase
 *  is >= 60s and the sweep runs in seconds, so no timer fires on its own
 *  during a run. `fireImmediate: true` DOES fire at registration — that is
 *  real production behaviour and is recorded as cycle 0. */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { backgroundServices } from '../../src/composition/bin/background-services-instance.js';
import { installSqlMeter } from './sql-meter.js';
import { housekeepingSchedulerRegistry } from '../../src/composition/bin/housekeeping-scheduler-instance.js';
import { SCHEDULER_REGISTRY } from '../../src/composition/data/scheduler/registry.js';
import type { SchedulerEntry, SchedulerSlot } from '../../src/composition/data/scheduler/registry.js';
import type {
  BackgroundServiceRegistry,
  IntervalServiceSpec,
  StoppableService,
} from '../../src/composition/bin/wire-background-services.js';

export interface CapturedInterval {
  readonly name: string;
  readonly intervalMs: number;
  readonly fireImmediate: boolean;
  readonly hasOnStop: boolean;
  /** The real tick body, retained so the sweep can drive it K times. */
  readonly tick: () => Promise<void> | void;
  /** Registration order — surfaces double-registration. */
  readonly seq: number;
}

export interface CapturedService {
  readonly name: string;
  readonly kind: StoppableService['kind'];
  readonly seq: number;
}

export interface BootCapture {
  readonly intervals: readonly CapturedInterval[];
  readonly services: readonly CapturedService[];
  /** Live scheduler slots, by registry name. `getHandle()` reads through the
   *  per-boot `let` binding, so a maintenance-exit rebuild stays visible. */
  readonly schedulerSlots: ReadonlyMap<string, SchedulerSlot<unknown>>;
  /** Errors thrown/rejected out of any captured tick, by service name. */
  readonly tickErrors: ReadonlyMap<string, unknown[]>;
  readonly unhandledRejections: readonly unknown[];
  readonly bootMs: number;
}

/** Applied to the singleton registries before `serve()`. Returns the live
 *  capture object, filled in as the boot chain registers. */
const instrument = (): {
  capture: {
    intervals: CapturedInterval[];
    services: CapturedService[];
    schedulerSlots: Map<string, SchedulerSlot<unknown>>;
    tickErrors: Map<string, unknown[]>;
  };
  restore: () => void;
} => {
  const intervals: CapturedInterval[] = [];
  const services: CapturedService[] = [];
  const schedulerSlots = new Map<string, SchedulerSlot<unknown>>();
  const tickErrors = new Map<string, unknown[]>();
  let seq = 0;

  // ⛔ `backgroundServices.register({ kind: 'scheduler' })` exposes only a
  // `stop` closure, so the registry alone cannot reach a scheduler's tick.
  // `composeSchedulers` iterates SCHEDULER_REGISTRY at CALL time and each
  // `boot()` returns the live slot, so wrapping the entries before `serve()`
  // captures the handles without changing what gets composed.
  //
  // ⚠ The composer asserts `entry.name === slot.name` — a wrapper that drops
  // `name` would throw at boot rather than fail quietly.
  const registryArray = SCHEDULER_REGISTRY as SchedulerEntry[];
  const originalEntries = [...registryArray];
  for (let i = 0; i < registryArray.length; i++) {
    const entry = originalEntries[i];
    registryArray[i] = {
      name: entry.name,
      boot: (bootCtx) => {
        const slot = entry.boot(bootCtx);
        if (slot) schedulerSlots.set(entry.name, slot);
        return slot;
      },
    };
  }

  const realRegisterInterval = backgroundServices.registerInterval.bind(
    backgroundServices,
  ) as BackgroundServiceRegistry['registerInterval'];
  const realRegister = backgroundServices.register.bind(
    backgroundServices,
  ) as BackgroundServiceRegistry['register'];

  const recordTickError = (name: string, err: unknown): void => {
    const bucket = tickErrors.get(name) ?? [];
    bucket.push(err);
    tickErrors.set(name, bucket);
  };

  // ⚠ The wrapper must not swallow. The production registry already isolates
  // tick failures (it logs + continues); we observe them additionally so a
  // throw inside a scheduled path is distinguishable from "no work to do" —
  // which is precisely the confusion this audit exists to break.
  const observedTick = (
    name: string,
    tick: IntervalServiceSpec['tick'],
  ): IntervalServiceSpec['tick'] => () => {
    let outcome: Promise<void> | void;
    try {
      outcome = tick();
    } catch (err) {
      recordTickError(name, err);
      throw err;
    }
    if (!outcome) return outcome;
    return Promise.resolve(outcome).catch((err: unknown) => {
      recordTickError(name, err);
      throw err;
    });
  };

  (backgroundServices as { registerInterval: BackgroundServiceRegistry['registerInterval'] })
    .registerInterval = (spec: IntervalServiceSpec) => {
      const wrapped: IntervalServiceSpec = {
        ...spec,
        tick: observedTick(spec.name, spec.tick),
      };
      intervals.push({
        name: spec.name,
        intervalMs: spec.intervalMs,
        fireImmediate: spec.fireImmediate === true,
        hasOnStop: typeof spec.onStop === 'function',
        tick: wrapped.tick,
        seq: seq++,
      });
      return realRegisterInterval(wrapped);
    };

  (backgroundServices as { register: BackgroundServiceRegistry['register'] })
    .register = (service: StoppableService) => {
      services.push({ name: service.name, kind: service.kind, seq: seq++ });
      return realRegister(service);
    };

  return {
    capture: { intervals, services, schedulerSlots, tickErrors },
    restore: () => {
      for (let i = 0; i < registryArray.length; i++) {
        registryArray[i] = originalEntries[i];
      }
      (backgroundServices as { registerInterval: BackgroundServiceRegistry['registerInterval'] })
        .registerInterval = realRegisterInterval;
      (backgroundServices as { register: BackgroundServiceRegistry['register'] })
        .register = realRegister;
    },
  };
};

export interface BootOptions {
  /** Scratch directory. Wiped and recreated. */
  readonly workDir: string;
  /** Path to the enrolled bench seed db. Copied — never booted in place. */
  readonly seedDb: string;
  /** Path to the seed identity json. Copied to `recued-server-identity.json`. */
  readonly seedIdentity: string;
  readonly port: number;
  /** Runs against the COPIED db before `serve()`.
   *
   *  ⛔ Needed by any subsystem whose in-memory state is rehydrated AT BOOT.
   *  The reception rate limiter calls `reload()` during composition
   *  (`wire-per-pair-stores.ts`), so rows seeded after boot would sit in
   *  SQLite while the in-memory map — the half the snapshot tick actually
   *  evicts from — stayed empty. Seeding pre-boot drives both halves. */
  readonly preBootSeed?: (db: import('better-sqlite3').Database) => void;
  /** Reuse an existing workDir instead of wiping it.
   *
   *  ⛔ Needed for a TWO-PHASE boot. The chat orchestrator takes a BOOT
   *  SNAPSHOT of the LLM config and picks the default model source from it, so
   *  a `server.setLLMConfig` write only takes effect on the NEXT boot. Phase 1
   *  persists the slot; phase 2 re-boots on the same database so the snapshot
   *  carries it. */
  readonly reuseWorkDir?: boolean;
}

export interface BootedServer {
  readonly dbPath: string;
  readonly capture: BootCapture;
  readonly housekeepingScheduler: ReturnType<
    typeof housekeepingSchedulerRegistry.getScheduler
  >;
  readonly shutdown: () => Promise<void>;
}

export const bootInstrumentedServer = async (
  opts: BootOptions,
): Promise<BootedServer> => {
  const dbPath = join(opts.workDir, 'horizon.db');
  if (!opts.reuseWorkDir) {
    if (existsSync(opts.workDir)) rmSync(opts.workDir, { recursive: true, force: true });
    mkdirSync(opts.workDir, { recursive: true });
    cpSync(opts.seedDb, dbPath);
  }
  if (!opts.reuseWorkDir) {
    // ⚠ The identity filename MATTERS — the boot resolves it by name next to
    // the db, not by flag.
    cpSync(opts.seedIdentity, join(opts.workDir, 'recued-server-identity.json'));
  }

  if (opts.preBootSeed && !opts.reuseWorkDir) {
    // ⚠ Through the D-212 chokepoint like every other db touch in this
    // harness — the seed db is plaintext today but the sealed case must not
    // silently write garbage.
    const { openDatabase } = await import('../../src/open-database.js');
    const seedDb = await openDatabase(dbPath);
    try {
      opts.preBootSeed(seedDb);
    } finally {
      // Closed before `serve()` so the server opens the file itself.
      seedDb.close();
    }
  }

  const unhandledRejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  // ⛔ BEFORE serve(). Every store prepares its statements during composition;
  // a meter installed afterwards never sees them and reads a confident zero —
  // which the optimization check would render as "does no work when idle", the
  // most flattering possible result. `assertMeterLive` re-proves it after boot.
  installSqlMeter();

  const { capture, restore } = instrument();

  const started = Date.now();
  const { serve } = await import('../../src/serve-entry.js');
  await serve(['--db', dbPath, '--bind-port', String(opts.port)]);
  const bootMs = Date.now() - started;

  restore();

  return {
    dbPath,
    capture: {
      intervals: capture.intervals,
      services: capture.services,
      schedulerSlots: capture.schedulerSlots,
      tickErrors: capture.tickErrors,
      unhandledRejections,
      bootMs,
    },
    housekeepingScheduler: housekeepingSchedulerRegistry.getScheduler(),
    shutdown: async () => {
      process.off('unhandledRejection', onUnhandled);
      try {
        await housekeepingSchedulerRegistry.stop();
      } catch {
        /* best effort */
      }
      try {
        await backgroundServices.stopAll();
      } catch {
        /* stopAll aggregates; a stop failure is not a sweep finding */
      }
    },
  };
};
