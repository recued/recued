import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const schedulerMocks = vi.hoisted(() => ({
  createScheduler: vi.fn(),
  createServerAutoRunScheduler: vi.fn(),
  createCircuitBreakerStore: vi.fn(),
  housekeepingSchedulerRegistry: {
    stop: vi.fn(),
  },
}));

vi.mock('../scheduler.js', () => ({
  createScheduler: schedulerMocks.createScheduler,
}));
vi.mock('../auto-run-scheduler.js', () => ({
  createServerAutoRunScheduler: schedulerMocks.createServerAutoRunScheduler,
  createCircuitBreakerStore: schedulerMocks.createCircuitBreakerStore,
}));
vi.mock('../composition/bin/housekeeping-scheduler-instance.js', () => ({
  housekeepingSchedulerRegistry: schedulerMocks.housekeepingSchedulerRegistry,
}));

import type Database from 'better-sqlite3';
import type {
  CircuitBreakerStore,
  ServerAutoRunHandle,
} from '../auto-run-scheduler.js';
import {
  createCircuitBreakerStore,
  createServerAutoRunScheduler,
} from '../auto-run-scheduler.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import type { RecipeStore } from '../recipe-store.js';
import type { ScheduleStore } from '../schedule-store.js';
import {
  createScheduler,
  type SchedulerHandle,
} from '../scheduler.js';
import {
  createBackgroundServiceRegistry,
  type BackgroundServiceRegistry,
  type StoppableService,
} from '../composition/bin/wire-background-services.js';
import { housekeepingSchedulerRegistry } from '../composition/bin/housekeeping-scheduler-instance.js';
import {
  composeSchedulers,
  type SchedulerBootContext,
} from '../composition/bin/wire-schedulers.js';
import {
  SCHEDULER_REGISTRY,
  CRON_SCHEDULER_NAME,
  AUTO_RUN_SCHEDULER_NAME,
  HOUSEKEEPING_SCHEDULER_NAME,
} from '../composition/data/scheduler/registry.js';
import { bootCronScheduler } from '../composition/data/scheduler/cron/boot.js';
import { bootAutoRunScheduler } from '../composition/data/scheduler/auto-run/boot.js';
import { bootHousekeepingRegistration } from '../composition/data/scheduler/housekeeping/boot.js';

type TestSchedulerHandle = {
  id: string;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  inFlight: ReturnType<typeof vi.fn>;
  tick: ReturnType<typeof vi.fn>;
  roster: Map<string, unknown>;
  refreshRoster: ReturnType<typeof vi.fn>;
  resetCircuit: ReturnType<typeof vi.fn>;
};

type TestCircuitStore = CircuitBreakerStore & {
  tag: string;
};

const schedulerNames = [
  CRON_SCHEDULER_NAME,
  AUTO_RUN_SCHEDULER_NAME,
  HOUSEKEEPING_SCHEDULER_NAME,
] as const;

let cronHandles: TestSchedulerHandle[] = [];
let autoRunHandles: TestSchedulerHandle[] = [];
let fallbackCircuitStores: TestCircuitStore[] = [];

const makeSchedulerHandle = (id: string): TestSchedulerHandle => ({
  id,
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn(),
  inFlight: vi.fn(() => false),
  tick: vi.fn().mockResolvedValue([]),
  roster: new Map(),
  refreshRoster: vi.fn(),
  resetCircuit: vi.fn(),
});

const makeCronHandle = (): SchedulerHandle => {
  const handle = makeSchedulerHandle(`cron-${cronHandles.length}`);
  cronHandles.push(handle);
  return handle as unknown as SchedulerHandle;
};

const makeAutoRunHandle = (): ServerAutoRunHandle => {
  const handle = makeSchedulerHandle(`auto-run-${autoRunHandles.length}`);
  autoRunHandles.push(handle);
  return handle as unknown as ServerAutoRunHandle;
};

const makeCircuitStore = (tag = 'circuit'): TestCircuitStore =>
  ({
    tag,
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    set: vi.fn(),
    clear: vi.fn(),
  }) as unknown as TestCircuitStore;

const resetSchedulerMocks = (): void => {
  cronHandles = [];
  autoRunHandles = [];
  fallbackCircuitStores = [];

  vi.mocked(createScheduler).mockReset();
  vi.mocked(createScheduler).mockImplementation(() => makeCronHandle());

  vi.mocked(createServerAutoRunScheduler).mockReset();
  vi.mocked(createServerAutoRunScheduler).mockImplementation(() => makeAutoRunHandle());

  vi.mocked(createCircuitBreakerStore).mockReset();
  vi.mocked(createCircuitBreakerStore).mockImplementation((database) => {
    const store = makeCircuitStore(`fallback-${fallbackCircuitStores.length}`);
    fallbackCircuitStores.push(store);
    expect(database).toBeDefined();
    return store;
  });

  vi.mocked(housekeepingSchedulerRegistry.stop).mockReset();
  vi.mocked(housekeepingSchedulerRegistry.stop).mockResolvedValue(undefined);
};

beforeEach(resetSchedulerMocks);

afterEach(() => {
  vi.restoreAllMocks();
});

const makeDb = (): Database.Database =>
  ({ tag: 'db' }) as unknown as Database.Database;

const makeScheduleStore = (): ScheduleStore => ({
  list: vi.fn(() => []),
  listByRecipe: vi.fn(() => []),
  get: vi.fn(() => null),
  set: vi.fn(),
  delete: vi.fn(() => false),
  updateRun: vi.fn(),
});

const makeRecipeStore = (): RecipeStore => ({
  get: vi.fn(() => null),
  getBundled: vi.fn(() => null),
  getStored: vi.fn(() => null),
  size: vi.fn(() => 0),
  ids: vi.fn(() => []),
  register: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(() => false),
  listForPack: vi.fn(() => []),
  listStored: vi.fn(() => []),
  updateUpstream: vi.fn(),
  setOnUpgrade: vi.fn(),
  setOnMutated: vi.fn(),
});

const makeExecuteDeps = (recipeStore: RecipeStore): ExecuteHandlerDeps =>
  ({
    recipeStore,
    executorConfig: {},
    baseVault: {},
    eventBus: { emit: vi.fn() },
  }) as unknown as ExecuteHandlerDeps;

const makeContext = (
  overrides: Partial<SchedulerBootContext> = {},
): SchedulerBootContext => {
  const recipeStore = overrides.recipeStore ?? makeRecipeStore();
  return {
    registry: createBackgroundServiceRegistry(),
    db: makeDb(),
    scheduleStore: makeScheduleStore(),
    executeDeps: makeExecuteDeps(recipeStore),
    recipeStore,
    circuitStore: makeCircuitStore('ctx-circuit'),
    autoRunSettingsStore: undefined,
    ...overrides,
  };
};

const spyOnRegister = (
  registry: BackgroundServiceRegistry,
): ReturnType<typeof vi.spyOn> => vi.spyOn(registry, 'register');

const lastRegisteredService = (
  registerSpy: { mock: { calls: unknown[][] } },
): StoppableService => {
  const service = registerSpy.mock.calls.at(-1)?.[0] as StoppableService | undefined;
  if (!service) throw new Error('registry.register was not called');
  return service;
};

describe('per-scheduler boot prerequisites and slot shape', () => {
  it('bootCronScheduler returns undefined when scheduleStore is undefined', () => {
    const ctx = makeContext({ scheduleStore: undefined });
    const registerSpy = spyOnRegister(ctx.registry);

    const slot = bootCronScheduler(ctx);

    expect(slot).toBeUndefined();
    expect(createScheduler).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('bootCronScheduler returns a named slot when scheduleStore is present', () => {
    const ctx = makeContext();

    const slot = bootCronScheduler(ctx);

    expect(slot?.name).toBe(CRON_SCHEDULER_NAME);
    expect(ctx.registry.list({ kind: 'scheduler' })).toEqual([CRON_SCHEDULER_NAME]);
  });

  it('bootAutoRunScheduler returns undefined when db is undefined', () => {
    const ctx = makeContext({ db: undefined });
    const registerSpy = spyOnRegister(ctx.registry);

    const slot = bootAutoRunScheduler(ctx);

    expect(slot).toBeUndefined();
    expect(createServerAutoRunScheduler).not.toHaveBeenCalled();
    expect(createCircuitBreakerStore).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('bootAutoRunScheduler returns a named slot when db is present', () => {
    const ctx = makeContext();

    const slot = bootAutoRunScheduler(ctx);

    expect(slot?.name).toBe(AUTO_RUN_SCHEDULER_NAME);
    expect(ctx.registry.list({ kind: 'scheduler' })).toEqual([AUTO_RUN_SCHEDULER_NAME]);
  });

  it('bootHousekeepingRegistration always returns a named slot', () => {
    const ctx = makeContext({
      db: undefined,
      scheduleStore: undefined,
      circuitStore: undefined,
    });

    const slot = bootHousekeepingRegistration(ctx);

    expect(slot.name).toBe(HOUSEKEEPING_SCHEDULER_NAME);
    expect(ctx.registry.list({ kind: 'scheduler' })).toEqual([HOUSEKEEPING_SCHEDULER_NAME]);
  });

  it('exposes rebuild only for cron and auto-run slots', () => {
    const ctx = makeContext();

    const cron = bootCronScheduler(ctx);
    const autoRun = bootAutoRunScheduler(ctx);
    const housekeeping = bootHousekeepingRegistration(ctx);

    expect(cron?.rebuild).toEqual(expect.any(Function));
    expect(autoRun?.rebuild).toEqual(expect.any(Function));
    expect(housekeeping.rebuild).toBeUndefined();
  });

  it('getHandle returns live handles for cron and auto-run and undefined for housekeeping', () => {
    const ctx = makeContext();

    const cron = bootCronScheduler(ctx);
    const autoRun = bootAutoRunScheduler(ctx);
    const housekeeping = bootHousekeepingRegistration(ctx);

    expect(cron?.getHandle()).toBe(cronHandles[0]);
    expect(autoRun?.getHandle()).toBe(autoRunHandles[0]);
    expect(housekeeping.getHandle()).toBeUndefined();
  });
});

describe('per-scheduler boot side effects', () => {
  it('cron boot constructs, starts, and registers the scheduler stop closure', () => {
    const ctx = makeContext();
    const registerSpy = spyOnRegister(ctx.registry);

    bootCronScheduler(ctx);

    expect(createScheduler).toHaveBeenCalledWith({
      store: ctx.scheduleStore,
      executeDeps: ctx.executeDeps,
    });
    expect(cronHandles[0]?.start).toHaveBeenCalledOnce();
    expect(registerSpy).toHaveBeenCalledWith({
      name: CRON_SCHEDULER_NAME,
      kind: 'scheduler',
      stop: expect.any(Function),
    });
  });

  it('auto-run boot falls back to createCircuitBreakerStore(db), starts, and registers', () => {
    const ctx = makeContext({ circuitStore: undefined });
    const registerSpy = spyOnRegister(ctx.registry);

    bootAutoRunScheduler(ctx);

    expect(createCircuitBreakerStore).toHaveBeenCalledWith(ctx.db);
    expect(createServerAutoRunScheduler).toHaveBeenCalledWith({
      recipeStore: ctx.recipeStore,
      executeDeps: ctx.executeDeps,
      circuitStore: fallbackCircuitStores[0],
      onFired: expect.any(Function),
    });
    expect(autoRunHandles[0]?.start).toHaveBeenCalledOnce();
    expect(registerSpy).toHaveBeenCalledWith({
      name: AUTO_RUN_SCHEDULER_NAME,
      kind: 'scheduler',
      stop: expect.any(Function),
    });
  });

  it('auto-run boot uses ctx.circuitStore directly when present', () => {
    const circuitStore = makeCircuitStore('provided');
    const ctx = makeContext({ circuitStore });

    bootAutoRunScheduler(ctx);

    expect(createCircuitBreakerStore).not.toHaveBeenCalled();
    expect(createServerAutoRunScheduler).toHaveBeenCalledWith({
      recipeStore: ctx.recipeStore,
      executeDeps: ctx.executeDeps,
      circuitStore,
      onFired: expect.any(Function),
    });
    expect(autoRunHandles[0]?.start).toHaveBeenCalledOnce();
  });

  it('reports a rejected detached auto-run start', async () => {
    const failure = new Error('auto-run hydration failed');
    vi.mocked(createServerAutoRunScheduler).mockImplementationOnce(() => {
      const handle = makeAutoRunHandle() as unknown as TestSchedulerHandle;
      handle.start.mockRejectedValueOnce(failure);
      return handle as unknown as ServerAutoRunHandle;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    bootAutoRunScheduler(makeContext());
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      '[auto-run] scheduler start failed',
      failure,
    );
  });

  it('housekeeping boot registers stop only and constructs no schedulers', () => {
    const ctx = makeContext();
    const registerSpy = spyOnRegister(ctx.registry);

    bootHousekeepingRegistration(ctx);

    expect(registerSpy).toHaveBeenCalledWith({
      name: HOUSEKEEPING_SCHEDULER_NAME,
      kind: 'scheduler',
      stop: expect.any(Function),
    });
    expect(createScheduler).not.toHaveBeenCalled();
    expect(createServerAutoRunScheduler).not.toHaveBeenCalled();
    expect(createCircuitBreakerStore).not.toHaveBeenCalled();
  });
});

describe('registered stop closures', () => {
  it('cron stop reads the live handle and routes to the rebuilt handle', async () => {
    const ctx = makeContext();
    const registerSpy = spyOnRegister(ctx.registry);
    const slot = bootCronScheduler(ctx);
    const service = lastRegisteredService(registerSpy);
    const first = cronHandles[0]!;

    await service.stop();
    expect(first.stop).toHaveBeenCalledOnce();

    first.stop.mockClear();
    slot?.rebuild?.();
    const second = cronHandles[1]!;
    await service.stop();

    expect(first.stop).not.toHaveBeenCalled();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(slot?.getHandle()).toBe(second);
  });

  it('auto-run stop reads the live handle and routes to the rebuilt handle', async () => {
    const ctx = makeContext();
    const registerSpy = spyOnRegister(ctx.registry);
    const slot = bootAutoRunScheduler(ctx);
    const service = lastRegisteredService(registerSpy);
    const first = autoRunHandles[0]!;

    await service.stop();
    expect(first.stop).toHaveBeenCalledOnce();

    first.stop.mockClear();
    slot?.rebuild?.();
    const second = autoRunHandles[1]!;
    await service.stop();

    expect(first.stop).not.toHaveBeenCalled();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(slot?.getHandle()).toBe(second);
  });

  it('housekeeping stop delegates to housekeepingSchedulerRegistry.stop', async () => {
    const ctx = makeContext();
    const registerSpy = spyOnRegister(ctx.registry);

    bootHousekeepingRegistration(ctx);
    await lastRegisteredService(registerSpy).stop();

    expect(housekeepingSchedulerRegistry.stop).toHaveBeenCalledOnce();
  });
});

describe('rebuild semantics', () => {
  it('cron rebuild reassigns getHandle to a fresh handle', () => {
    const slot = bootCronScheduler(makeContext());
    const first = slot?.getHandle();

    slot?.rebuild?.();

    expect(slot?.getHandle()).toBe(cronHandles[1]);
    expect(slot?.getHandle()).not.toBe(first);
  });

  it('cron rebuild starts the fresh handle', () => {
    const slot = bootCronScheduler(makeContext());

    slot?.rebuild?.();

    expect(cronHandles[1]?.start).toHaveBeenCalledOnce();
  });

  it('auto-run rebuild reassigns getHandle to a fresh handle', () => {
    const slot = bootAutoRunScheduler(makeContext());
    const first = slot?.getHandle();

    slot?.rebuild?.();

    expect(slot?.getHandle()).toBe(autoRunHandles[1]);
    expect(slot?.getHandle()).not.toBe(first);
  });

  it('auto-run rebuild starts the fresh handle', () => {
    const slot = bootAutoRunScheduler(makeContext());

    slot?.rebuild?.();

    expect(autoRunHandles[1]?.start).toHaveBeenCalledOnce();
  });
});

describe('composeSchedulers slot collection', () => {
  it('iterates the registry, boots all slots, and preserves registration order', () => {
    const ctx = makeContext();

    const bundle = composeSchedulers(ctx);

    expect(SCHEDULER_REGISTRY.map((entry) => entry.name)).toEqual(schedulerNames);
    expect(bundle.list()).toEqual(schedulerNames);
    expect(ctx.registry.list({ kind: 'scheduler' })).toEqual(schedulerNames);
    expect(createScheduler).toHaveBeenCalledOnce();
    expect(createServerAutoRunScheduler).toHaveBeenCalledOnce();
  });

  it('skips the cron slot when scheduleStore is missing', () => {
    const ctx = makeContext({ scheduleStore: undefined });

    const bundle = composeSchedulers(ctx);

    expect(bundle.cron).toBeUndefined();
    expect(bundle.autoRun?.name).toBe(AUTO_RUN_SCHEDULER_NAME);
    expect(bundle.list()).toEqual([AUTO_RUN_SCHEDULER_NAME, HOUSEKEEPING_SCHEDULER_NAME]);
    expect(createScheduler).not.toHaveBeenCalled();
    expect(createServerAutoRunScheduler).toHaveBeenCalledOnce();
  });

  it('skips the auto-run slot when db is missing', () => {
    const ctx = makeContext({ db: undefined });

    const bundle = composeSchedulers(ctx);

    expect(bundle.cron?.name).toBe(CRON_SCHEDULER_NAME);
    expect(bundle.autoRun).toBeUndefined();
    expect(bundle.list()).toEqual([CRON_SCHEDULER_NAME, HOUSEKEEPING_SCHEDULER_NAME]);
    expect(createScheduler).toHaveBeenCalledOnce();
    expect(createServerAutoRunScheduler).not.toHaveBeenCalled();
  });

  it('exposes the typed cron and auto-run slots when both boot', () => {
    const bundle = composeSchedulers(makeContext());

    expect(bundle.cron?.name).toBe(CRON_SCHEDULER_NAME);
    expect(bundle.autoRun?.name).toBe(AUTO_RUN_SCHEDULER_NAME);
    expect(bundle.cron?.getHandle()).toBe(cronHandles[0]);
    expect(bundle.autoRun?.getHandle()).toBe(autoRunHandles[0]);
  });

  it('returns distinct bundles and slots across consecutive compose calls', () => {
    const first = composeSchedulers(makeContext());
    const second = composeSchedulers(makeContext());

    expect(second).not.toBe(first);
    expect(second.cron).not.toBe(first.cron);
    expect(second.autoRun).not.toBe(first.autoRun);
    expect(first.list()).toEqual(schedulerNames);
    expect(second.list()).toEqual(schedulerNames);
  });
});

describe('composeSchedulers drift guard', () => {
  it('throws when a registry entry name differs from the returned slot name', async () => {
    vi.resetModules();
    vi.doMock('../composition/data/scheduler/registry.js', () => ({
      CRON_SCHEDULER_NAME,
      AUTO_RUN_SCHEDULER_NAME,
      SCHEDULER_REGISTRY: [
        {
          name: 'registry-name',
          boot: () => ({
            name: 'slot-name',
            getHandle: () => undefined,
          }),
        },
      ],
    }));

    try {
      const { composeSchedulers: composeWithMockedRegistry } = await import(
        '../composition/bin/wire-schedulers.js'
      );

      expect(() => composeWithMockedRegistry(makeContext())).toThrow(
        'entry/slot name mismatch: entry.name=registry-name slot.name=slot-name',
      );
    } finally {
      vi.doUnmock('../composition/data/scheduler/registry.js');
      vi.resetModules();
    }
  });
});

describe('composeSchedulers rebuildAll', () => {
  it('rebuilds every booted slot with rebuild and skips housekeeping', () => {
    const bundle = composeSchedulers(makeContext());

    bundle.rebuildAll();

    expect(createScheduler).toHaveBeenCalledTimes(2);
    expect(createServerAutoRunScheduler).toHaveBeenCalledTimes(2);
    expect(cronHandles[1]?.start).toHaveBeenCalledOnce();
    expect(autoRunHandles[1]?.start).toHaveBeenCalledOnce();
    expect(housekeepingSchedulerRegistry.stop).not.toHaveBeenCalled();
    expect(bundle.list()).toEqual(schedulerNames);
  });

  it('logs one rebuild failure and continues rebuilding later slots', () => {
    const err = new Error('cron rebuild failed');
    vi.mocked(createScheduler)
      .mockImplementationOnce(() => makeCronHandle())
      .mockImplementationOnce(() => {
        throw err;
      });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bundle = composeSchedulers(makeContext());

    bundle.rebuildAll();

    expect(createScheduler).toHaveBeenCalledTimes(2);
    expect(createServerAutoRunScheduler).toHaveBeenCalledTimes(2);
    expect(autoRunHandles[1]?.start).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      `[scheduler-rebuild] ${CRON_SCHEDULER_NAME} rebuild failed`,
      err,
    );
  });
});
