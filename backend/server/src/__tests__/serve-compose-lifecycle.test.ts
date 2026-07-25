import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createStorageGate } from '@recued/storage-gate';

import { LockHeldError } from '../lifecycle/instance-lock.js';
import type {
  ComposeServeLifecycleOptions,
  ServeHttpServerRef,
} from '../serve/compose-lifecycle.js';

const lifecycleMocks = vi.hoisted(() => ({
  createLifecycle: vi.fn(),
}));

vi.mock('../lifecycle/index.js', () => ({
  createLifecycle: lifecycleMocks.createLifecycle,
}));

import { composeServeLifecycle } from '../serve/compose-lifecycle.js';
import type { SchedulersBundle } from '../composition/bin/wire-schedulers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const composeLifecyclePath = join(
  repoRoot,
  'backend/server/src/serve/compose-lifecycle.ts',
);
const lifecycleRecoveryBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-lifecycle-recovery-pre-listener-runtime.ts',
);

const makeLifecycle = (overrides: Record<string, unknown> = {}) => ({
  lock: { claim: vi.fn() },
  supervisor: { mode: 'dev', handoff: vi.fn(() => 7) },
  drain: { state: { active: false } },
  requestDrain: vi.fn(async () => ({ ok: true })),
  handlerSlice: {},
  ...overrides,
});

const makeOptions = (
  overrides: Record<string, unknown> = {},
): ComposeServeLifecycleOptions =>
  ({
    db: { close: vi.fn() },
    bootstrapDeps: { state: { tag: 'server-state', isCrashHaltActive: () => false } },
    base: {
      dbPath: '/tmp/recued-test/server.db',
      port: 4321,
      distribution: 'source',
      loadedConfig: {
        source: '/tmp/recued-test/config.toml',
        bootstrap: { tag: 'bootstrap' },
        runtime: { tag: 'runtime' },
      },
      runtimeConfig: { tag: 'runtime-store' },
    },
    serverVersion: '9.9.9',
    auditLog: { tag: 'audit-log' },
    storage: {
      fileStack: { disposeAll: vi.fn(async () => undefined) },
    },
    collection: {
      collectionRegistry: { dispose: vi.fn(async () => undefined) },
      calendarStack: { disposeAll: vi.fn(async () => undefined) },
      mailStack: { disposeAll: vi.fn(async () => undefined) },
      serviceStack: { disposeAll: vi.fn(async () => undefined) },
    },
    backgroundServices: {
      register: vi.fn(),
      registerInterval: vi.fn(),
      stopAll: vi.fn(async () => undefined),
      list: vi.fn(() => []),
    },
    cascade: { close: vi.fn() },
    getHttpServer: vi.fn(() => undefined),
    getSchedulersBundle: vi.fn(() => undefined),
    exit: vi.fn(),
    ...overrides,
  }) as unknown as ComposeServeLifecycleOptions;

beforeEach(() => {
  lifecycleMocks.createLifecycle.mockReset();
});

describe('composeServeLifecycle', () => {
  it('skips lifecycle composition when DB or bootstrap deps are absent', async () => {
    const base = makeOptions();

    await expect(composeServeLifecycle({ ...base, db: undefined })).resolves.toBeUndefined();
    await expect(
      composeServeLifecycle({ ...base, bootstrapDeps: undefined }),
    ).resolves.toBeUndefined();

    expect(lifecycleMocks.createLifecycle).not.toHaveBeenCalled();
  });

  it('constructs the lifecycle and claims the instance lock before returning', async () => {
    const lifecycle = makeLifecycle();
    lifecycleMocks.createLifecycle.mockReturnValue(lifecycle);
    const options = makeOptions();

    const result = await composeServeLifecycle(options);

    expect(result).toBe(lifecycle);
    expect(lifecycleMocks.createLifecycle).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.createLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        db: options.db,
        dataPath: '/tmp/recued-test',
        bindPort: 4321,
        version: '9.9.9',
        configPath: '/tmp/recued-test/config.toml',
        distribution: 'source',
        initialBootstrap: options.base.loadedConfig.bootstrap,
        initialRuntime: options.base.loadedConfig.runtime,
        runtimeStore: options.base.runtimeConfig,
        serverState: options.bootstrapDeps?.state,
        auditLog: options.auditLog,
        drainSteps: expect.any(Object),
        getInFlightCount: expect.any(Function),
        // D-178 slice 5 — `onCrashLoopDetected` (the legacy D-108 crash-loop →
        // npm-rollback flag write) is retired; no longer passed.
      }),
    );
    expect(lifecycle.lock.claim).toHaveBeenCalledWith({
      boot_at: expect.any(Number),
      bind_port: 4321,
    });
  });

  it('re-halts the storage gates on boot when the kill switch is persisted-active', async () => {
    lifecycleMocks.createLifecycle.mockReturnValue(makeLifecycle());
    const gate = createStorageGate({
      quota: 100 * 1024 * 1024,
      reservePct: 5,
      surface: 'shared_store',
    });
    expect(gate.info().state).toBe('running');
    const bootstrapDeps = {
      state: { isCrashHaltActive: () => true },
      gates: [gate],
    } as unknown as NonNullable<ComposeServeLifecycleOptions['bootstrapDeps']>;

    await composeServeLifecycle(makeOptions({ bootstrapDeps }));

    // The persisted kill switch is re-applied to the fresh gate at boot, so a
    // crash-loop halt that outlived the process keeps blocking writes.
    expect(gate.info().state).toBe('halted');
    expect(gate.info().haltReason).toBe('crash_halt');
  });

  it('leaves gates running on boot when the kill switch is not active', async () => {
    lifecycleMocks.createLifecycle.mockReturnValue(makeLifecycle());
    const gate = createStorageGate({
      quota: 100 * 1024 * 1024,
      reservePct: 5,
      surface: 'shared_store',
    });
    const bootstrapDeps = {
      state: { isCrashHaltActive: () => false },
      gates: [gate],
    } as unknown as NonNullable<ComposeServeLifecycleOptions['bootstrapDeps']>;

    await composeServeLifecycle(makeOptions({ bootstrapDeps }));

    expect(gate.info().state).toBe('running');
  });

  it('wires drain steps and keeps scheduler/http reads live', async () => {
    const order: string[] = [];
    const lifecycle = makeLifecycle();
    lifecycleMocks.createLifecycle.mockReturnValue(lifecycle);
    let currentHttpServer: ServeHttpServerRef | undefined;
    let currentSchedulerBundle: SchedulersBundle | undefined;
    const pause = vi.fn(() => { order.push('pause'); });
    const inFlight = vi.fn(() => true);
    const closeHttp = vi.fn(async () => { order.push('http'); });
    const options = makeOptions({
      storage: {
        fileStack: { disposeAll: vi.fn(async () => { order.push('file'); }) },
      },
      collection: {
        collectionRegistry: { dispose: vi.fn(async () => { order.push('collection'); }) },
        calendarStack: { disposeAll: vi.fn(async () => { order.push('calendar'); }) },
        mailStack: { disposeAll: vi.fn(async () => { order.push('mail'); }) },
        serviceStack: { disposeAll: vi.fn(async () => { order.push('service'); }) },
      },
      backgroundServices: {
        register: vi.fn(),
        registerInterval: vi.fn(),
        stopAll: vi.fn(async (filter) => { order.push(`stop:${filter?.kind}`); }),
        list: vi.fn(() => []),
      },
      cascade: { close: vi.fn(() => { order.push('cascade'); }) },
      db: { close: vi.fn(() => { order.push('db'); }) },
      getHttpServer: vi.fn(() => currentHttpServer),
      getSchedulersBundle: vi.fn(() => currentSchedulerBundle),
    });

    await composeServeLifecycle(options);

    const createOptions = lifecycleMocks.createLifecycle.mock.calls[0]![0];
    const drainSteps = createOptions.drainSteps;
    await drainSteps.pause_collections();
    expect(order).toEqual(['collection', 'file', 'calendar', 'mail', 'service']);

    currentSchedulerBundle = {
      cron: { getHandle: vi.fn(() => ({ pause, inFlight })) },
    } as unknown as SchedulersBundle;
    await drainSteps.pause_scheduler();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(createOptions.getInFlightCount()).toBe(1);

    currentHttpServer = { close: closeHttp };
    await drainSteps.close_ws();
    expect(closeHttp).toHaveBeenCalledTimes(1);

    await drainSteps.stop_timers();
    await drainSteps.close_cascade();
    await drainSteps.close_db();
    expect(order.slice(5)).toEqual([
      'pause',
      'http',
      'stop:timer',
      'stop:emitter',
      'cascade',
      'db',
    ]);

    currentSchedulerBundle = undefined;
    expect(createOptions.getInFlightCount()).toBe(0);
  });

  it('folds the in-flight registry active-run count into getInFlightCount', async () => {
    const lifecycle = makeLifecycle();
    lifecycleMocks.createLifecycle.mockReturnValue(lifecycle);
    let active = 0;
    let currentSchedulerBundle: SchedulersBundle | undefined;
    const inFlight = vi.fn(() => false);
    const options = makeOptions({
      getSchedulersBundle: vi.fn(() => currentSchedulerBundle),
      getActiveRunCount: () => active,
    });

    await composeServeLifecycle(options);
    const createOptions = lifecycleMocks.createLifecycle.mock.calls[0]![0];

    // No cron, no active runs.
    expect(createOptions.getInFlightCount()).toBe(0);

    // Active engine runs the scheduler can't see still hold the drain.
    active = 2;
    expect(createOptions.getInFlightCount()).toBe(2);

    // Cron in-flight + active runs sum.
    currentSchedulerBundle = {
      cron: { getHandle: vi.fn(() => ({ pause: vi.fn(), inFlight: () => true })) },
    } as unknown as SchedulersBundle;
    expect(createOptions.getInFlightCount()).toBe(3);

    void inFlight;
  });

  it('publishes restart and drain-state callbacks onto bootstrap deps', async () => {
    const lifecycle = makeLifecycle({
      drain: { state: { active: true } },
      requestDrain: vi.fn(async () => ({ drained: true })),
      supervisor: { mode: 'dev', handoff: vi.fn(() => 8) },
    });
    lifecycleMocks.createLifecycle.mockReturnValue(lifecycle);
    const bootstrapDeps = {
      bootstrap: { tag: 'bootstrap' },
      state: { tag: 'server-state', isCrashHaltActive: () => false },
      version: '9.9.9',
    } as unknown as NonNullable<ComposeServeLifecycleOptions['bootstrapDeps']>;
    const exit = vi.fn();

    await composeServeLifecycle(makeOptions({ bootstrapDeps, exit }));

    expect(bootstrapDeps.isDraining?.()).toBe(true);
    bootstrapDeps.onRestartRequested?.('');
    await Promise.resolve();
    await Promise.resolve();

    expect(lifecycle.requestDrain).toHaveBeenCalledWith({
      intent: 'restart',
      reason: 'rpc',
    });
    expect(lifecycle.supervisor.handoff).toHaveBeenCalledWith('restart');
    expect(exit).toHaveBeenCalledWith(8);
  });

  it('exits with code 4 when the instance lock is held', async () => {
    const lifecycle = makeLifecycle({
      lock: {
        claim: vi.fn(() => {
          throw new LockHeldError({ pid: 123, boot_at: 1, bind_port: 4321 });
        }),
      },
    });
    lifecycleMocks.createLifecycle.mockReturnValue(lifecycle);
    const exit = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await composeServeLifecycle(makeOptions({ exit }));

      expect(result).toBeUndefined();
      expect(exit).toHaveBeenCalledWith(4);
      expect(errorSpy).toHaveBeenCalledWith(
        '[lifecycle] another recued is already running on port 4321 (pid 123).',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('compose-lifecycle source boundary', () => {
  it('keeps lifecycle construction and lock handling behind the lifecycle bridge', () => {
    const bridgeSource = readFileSync(lifecycleRecoveryBridgePath, 'utf8');

    expect(bridgeSource).toMatch(/compose-lifecycle\.js/);
    expect(bridgeSource).toMatch(/await composeServeLifecycle\(\{/);
    expect(bridgeSource).toMatch(/getHttpServer:\s*\(\) => httpServerRef/);
    expect(bridgeSource).toMatch(/getSchedulersBundle:\s*options\.getSchedulersBundle/);
  });

  it('preserves lifecycle, boot recovery, and listener order', () => {
    const source = readFileSync(lifecycleRecoveryBridgePath, 'utf8');
    const lifecycleIndex = source.indexOf('await composeServeLifecycle({');
    const bootRecoveryIndex = source.indexOf('await startBootRecoveryAndAdapters({');
    const listenersIndex = source.indexOf('await startPreListenerRuntime({');

    expect(lifecycleIndex).toBeGreaterThanOrEqual(0);
    expect(bootRecoveryIndex).toBeGreaterThan(lifecycleIndex);
    expect(listenersIndex).toBeGreaterThan(bootRecoveryIndex);
  });

  it('keeps the helper focused on lifecycle construction and restart wiring', () => {
    const source = readFileSync(composeLifecyclePath, 'utf8');

    expect(source).toMatch(/createLifecycle/);
    expect(source).toMatch(/LockHeldError/);
    expect(source).toMatch(/lock\.claim/);
    expect(source).toMatch(/onRestartRequested/);
    expect(source).toMatch(/requestDrain/);
    expect(source).not.toMatch(/bootSigningIdentity/);
    expect(source).not.toMatch(/recoverNotificationBlockAtBoot/);
    expect(source).not.toMatch(/raiseInDoubtForSweptCommits/);
    expect(source).not.toMatch(/composeListeners|composeServeExposure/);
    expect(source).not.toMatch(/startSchedulers|startServeHousekeepingScheduler/);
    expect(source).not.toMatch(/startRetentionPruners|startDdnsUpdatePoller/);
    expect(source).not.toMatch(/logBootBanner|installShutdown/);
  });
});
