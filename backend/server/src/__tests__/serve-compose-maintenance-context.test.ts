import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const maintenanceMocks = vi.hoisted(() => ({
  createScheduleStore: vi.fn(),
  createDishStore: vi.fn(),
  createDishGroupStore: vi.fn(),
  createDishContextStore: vi.fn(),
  createCircuitBreakerStore: vi.fn(),
  createAutoRunSettingsStore: vi.fn(),
  createMigrationStateStore: vi.fn(),
  createVerificationStore: vi.fn(),
}));

vi.mock('../schedule-store.js', () => ({
  createScheduleStore: maintenanceMocks.createScheduleStore,
}));

vi.mock('../dish-store.js', () => ({
  createDishStore: maintenanceMocks.createDishStore,
}));

// D-179 P3 added createDishGroupStore to composeMaintenanceContext but this
// test's mocks were never updated → a real createDishGroupStore(fakeDb) threw
// `db.exec is not a function` (pre-existing red on HEAD, unrelated to D-188).
vi.mock('../dish-group-store.js', () => ({
  createDishGroupStore: maintenanceMocks.createDishGroupStore,
}));

vi.mock('../dish-context-store.js', () => ({
  createDishContextStore: maintenanceMocks.createDishContextStore,
}));

vi.mock('../auto-run-scheduler.js', () => ({
  createCircuitBreakerStore: maintenanceMocks.createCircuitBreakerStore,
  createAutoRunSettingsStore: maintenanceMocks.createAutoRunSettingsStore,
}));

vi.mock('../migration/migration-state.js', () => ({
  createMigrationStateStore: maintenanceMocks.createMigrationStateStore,
}));

vi.mock('../migration/verification-store.js', () => ({
  createVerificationStore: maintenanceMocks.createVerificationStore,
}));

import {
  composeMaintenanceContext,
  createAutonomousExecutionControl,
  type ComposeMaintenanceContextOptions,
} from '../serve/compose-maintenance-context.js';
import type { EventTriggerDispatcher } from '../triggers/dispatcher.js';
import type { SchedulersBundle } from '../composition/bin/wire-schedulers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const composeMaintenancePath = join(
  repoRoot,
  'backend/server/src/serve/compose-maintenance-context.ts',
);
const postExecutionBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-execution-bootstrap-maintenance-runtime.ts',
);

beforeEach(() => {
  maintenanceMocks.createScheduleStore.mockReset();
  maintenanceMocks.createCircuitBreakerStore.mockReset();
  maintenanceMocks.createMigrationStateStore.mockReset();
  maintenanceMocks.createVerificationStore.mockReset();

  maintenanceMocks.createScheduleStore.mockReturnValue({ tag: 'schedule-store' });
  maintenanceMocks.createDishStore.mockReturnValue({ tag: 'dish-store' });
  maintenanceMocks.createDishGroupStore.mockReturnValue({ tag: 'dish-group-store' });
  maintenanceMocks.createDishContextStore.mockReturnValue({ tag: 'dish-context-store' });
  maintenanceMocks.createCircuitBreakerStore.mockReturnValue({ tag: 'circuit-store' });
  maintenanceMocks.createAutoRunSettingsStore.mockReturnValue({ tag: 'auto-run-settings' });
  maintenanceMocks.createMigrationStateStore.mockReturnValue({ tag: 'migration-state' });
  maintenanceMocks.createVerificationStore.mockReturnValue({ tag: 'verification-store' });
});

const makeOptions = (
  overrides: Partial<ComposeMaintenanceContextOptions> = {},
): ComposeMaintenanceContextOptions =>
  ({
    dbPath: '/tmp/recued-maintenance/server.db',
    storage: {
      db: { tag: 'db' },
      gateRegistry: {
        schedules: {
          addUsed: vi.fn(),
        },
      },
      serverInstanceId: 'server-1',
      auditLog: { tag: 'audit-log' },
      eventBus: { tag: 'event-bus' },
    },
    app: {
      keys: { tag: 'keys' },
      bundleStoreRef: { tag: 'bundle-store' },
    },
    backgroundServices: {
      register: vi.fn(),
      registerInterval: vi.fn(),
      stopAll: vi.fn(async () => undefined),
      list: vi.fn(() => []),
    },
    getSchedulersBundle: vi.fn(() => undefined),
    getEventTriggerDispatcher: vi.fn(() => undefined),
    getWatchManager: vi.fn(() => undefined),
    ...overrides,
  }) as unknown as ComposeMaintenanceContextOptions;

describe('composeMaintenanceContext', () => {
  it('builds schedule, circuit-breaker, and migration deps', () => {
    const options = makeOptions();

    const context = composeMaintenanceContext(options);

    expect(maintenanceMocks.createScheduleStore).toHaveBeenCalledWith(
      options.storage.db,
      { onBytesChanged: expect.any(Function) },
    );
    expect(context.scheduleStore).toEqual({ tag: 'schedule-store' });
    expect(context.scheduleDeps).toEqual({
      store: { tag: 'schedule-store' },
      // D-179 P2 — create-time dish-binding validation handle.
      dishStore: { tag: 'dish-store' },
      // D-179 config-on-schedule — continuity clear on overlay-dish dissolve.
      dishContextStore: { tag: 'dish-context-store' },
      instanceId: 'server-1',
      gate: options.storage.gateRegistry?.schedules,
      auditLog: options.storage.auditLog,
      eventBus: options.storage.eventBus,
    });

    const scheduleOptions = maintenanceMocks.createScheduleStore.mock
      .calls[0]![1] as { onBytesChanged: (delta: number) => void };
    scheduleOptions.onBytesChanged(37);
    expect(options.storage.gateRegistry?.schedules.addUsed).toHaveBeenCalledWith(37);

    // D-179 P1 — dish store + per-dish continuity + dishes.* rpc deps.
    expect(maintenanceMocks.createDishStore).toHaveBeenCalledWith(options.storage.db);
    expect(maintenanceMocks.createDishContextStore).toHaveBeenCalledWith(options.storage.db);
    expect(context.dishStore).toEqual({ tag: 'dish-store' });
    expect(context.dishContextStore).toEqual({ tag: 'dish-context-store' });
    expect(context.dishDeps).toEqual({
      store: { tag: 'dish-store' },
      // D-179 P3 — dishDeps gained the group store (mock added above).
      groupStore: { tag: 'dish-group-store' },
      contextStore: { tag: 'dish-context-store' },
      auditLog: options.storage.auditLog,
    });

    expect(maintenanceMocks.createCircuitBreakerStore).toHaveBeenCalledWith(
      options.storage.db,
    );
    expect(context.circuitStoreRef).toEqual({ tag: 'circuit-store' });
    expect(maintenanceMocks.createAutoRunSettingsStore).toHaveBeenCalledWith(
      options.storage.db,
    );
    expect(context.autoRunSettingsStoreRef).toEqual({ tag: 'auto-run-settings' });
    expect(context.migrateDeps).toEqual(
      expect.objectContaining({
        db: options.storage.db,
        blobRoot: join(dirname(resolve(options.dbPath)), 'blobs'),
        keys: options.app.keys,
        bundleStore: options.app.bundleStoreRef,
        migrationState: { tag: 'migration-state' },
        verifications: { tag: 'verification-store' },
      }),
    );
  });

  it('keeps maintenance enter scheduler-only and maintenance exit live-bound', async () => {
    let currentBundle: SchedulersBundle | undefined;
    let currentDispatcher: EventTriggerDispatcher | undefined;
    const first = { rebuildAll: vi.fn() } as unknown as SchedulersBundle;
    const second = { rebuildAll: vi.fn() } as unknown as SchedulersBundle;
    const dispatcher = { rebuild: vi.fn() } as unknown as EventTriggerDispatcher;
    const options = makeOptions({
      getSchedulersBundle: vi.fn(() => currentBundle),
      getEventTriggerDispatcher: vi.fn(() => currentDispatcher),
      getWatchManager: vi.fn(() => undefined),
    });

    const context = composeMaintenanceContext(options);
    await context.migrateDeps?.onEnterMaintenance?.();
    expect(options.backgroundServices.stopAll).toHaveBeenCalledWith({
      kind: 'scheduler',
    });

    await context.migrateDeps?.onExitMaintenance?.();
    expect(first.rebuildAll).not.toHaveBeenCalled();

    currentBundle = first;
    await context.migrateDeps?.onExitMaintenance?.();
    expect(first.rebuildAll).toHaveBeenCalledTimes(1);

    currentBundle = second;
    await context.migrateDeps?.onExitMaintenance?.();
    expect(second.rebuildAll).toHaveBeenCalledTimes(1);

    // Reactive-substrate slice 1 (codex HIGH fold) — exit re-subscribes
    // the event-trigger dispatcher through the same late-bound contract.
    expect((dispatcher as unknown as { rebuild: ReturnType<typeof vi.fn> }).rebuild)
      .not.toHaveBeenCalled();
    currentDispatcher = dispatcher;
    await context.migrateDeps?.onExitMaintenance?.();
    expect((dispatcher as unknown as { rebuild: ReturnType<typeof vi.fn> }).rebuild)
      .toHaveBeenCalledTimes(1);
  });

  it('omits DB-backed deps when prerequisites are absent', () => {
    const noDb = composeMaintenanceContext(
      makeOptions({
        storage: {
          ...makeOptions().storage,
          db: undefined,
        },
      }),
    );
    expect(noDb).toEqual({
      scheduleStore: undefined,
      scheduleDeps: undefined,
      dishStore: undefined,
      dishGroupStore: undefined,
      dishContextStore: undefined,
      dishDeps: undefined,
      circuitStoreRef: undefined,
      autoRunSettingsStoreRef: undefined,
      migrateDeps: undefined,
      // D-188 — the execution control is always present (getters are late-bound).
      executionControl: expect.objectContaining({
        stop: expect.any(Function),
        rearm: expect.any(Function),
      }),
    });

    const noKeys = composeMaintenanceContext(
      makeOptions({
        app: {
          ...makeOptions().app,
          keys: undefined,
        },
      }),
    );
    expect(noKeys.scheduleStore).toBeDefined();
    expect(noKeys.circuitStoreRef).toBeDefined();
    expect(noKeys.migrateDeps).toBeUndefined();
  });
});

describe('createAutonomousExecutionControl (D-188)', () => {
  type Refs = Parameters<typeof createAutonomousExecutionControl>[0];

  it('stop() halts the scheduler-kind background services', async () => {
    const stopAll = vi.fn(async () => undefined);
    const control = createAutonomousExecutionControl({
      backgroundServices: { stopAll },
      getSchedulersBundle: () => undefined,
      getEventTriggerDispatcher: () => undefined,
      getWatchManager: () => undefined,
    } as unknown as Refs);
    await control.stop();
    expect(stopAll).toHaveBeenCalledWith({ kind: 'scheduler' });
  });

  it('rearm() rebuilds schedulers + re-subscribes triggers + recomputes watches', async () => {
    const rebuildAll = vi.fn();
    const rebuild = vi.fn();
    const recompute = vi.fn();
    const control = createAutonomousExecutionControl({
      backgroundServices: { stopAll: vi.fn(async () => undefined) },
      getSchedulersBundle: () => ({ rebuildAll }),
      getEventTriggerDispatcher: () => ({ rebuild }),
      getWatchManager: () => ({ recompute }),
    } as unknown as Refs);
    await control.rearm();
    expect(rebuildAll).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(recompute).toHaveBeenCalledTimes(1);
  });

  it('rearm() is null-safe when the subsystems are not yet published', async () => {
    const control = createAutonomousExecutionControl({
      backgroundServices: { stopAll: vi.fn(async () => undefined) },
      getSchedulersBundle: () => undefined,
      getEventTriggerDispatcher: () => undefined,
      getWatchManager: () => undefined,
    } as unknown as Refs);
    await expect(control.rearm()).resolves.toBeUndefined();
  });
});

describe('compose-maintenance-context source boundary', () => {
  it('keeps maintenance construction and live refs in the post-execution bridge', () => {
    const helperSource = readFileSync(composeMaintenancePath, 'utf8');
    const bridgeSource = readFileSync(postExecutionBridgePath, 'utf8');

    expect(bridgeSource).toMatch(/compose-maintenance-context\.js/);
    expect(bridgeSource).toMatch(/composeMaintenanceContext\(\{/);
    expect(bridgeSource).toMatch(/getSchedulersBundle:\s*\(\) => schedulersBundle/);
    expect(bridgeSource).toMatch(/publishSchedulersBundle:\s*\(bundle\) => \{/);
    expect(helperSource).toMatch(/createScheduleStore/);
    expect(helperSource).toMatch(/createCircuitBreakerStore/);
    expect(helperSource).toMatch(/createMigrationStateStore/);
    expect(helperSource).toMatch(/createVerificationStore/);
    expect(helperSource).toMatch(/stopAll\(\{\s*kind:\s*'scheduler'\s*\}\)/);
    expect(helperSource).toMatch(/getSchedulersBundle\(\)\?\.rebuildAll\(\)/);
    expect(helperSource).toMatch(/join\(dirname\(resolve\(dbPath\)\), 'blobs'\)/);
  });

  it('keeps the helper focused on maintenance deps', () => {
    const helperSource = readFileSync(composeMaintenancePath, 'utf8');

    expect(helperSource).not.toMatch(/createLifecycle|LockHeldError/);
    expect(helperSource).not.toMatch(/composeListeners|createServerHandlerSet/);
    expect(helperSource).not.toMatch(/composeSchedulers|startSchedulers/);
    expect(helperSource).not.toMatch(/composeServeExposure|composeRpcContext/);
    expect(helperSource).not.toMatch(/logBootBanner|installShutdown/);
  });
});
