import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stripSourceComments } from './helpers/source-guards.js';

const schedulerMocks = vi.hoisted(() => ({
  composeSchedulers: vi.fn(),
  composeHousekeepingScheduler: vi.fn(),
  setHousekeepingScheduler: vi.fn(),
}));

vi.mock('../composition/bin/wire-schedulers.js', () => ({
  composeSchedulers: schedulerMocks.composeSchedulers,
}));

vi.mock('../composition/bin/wire-housekeeping-substrate.js', () => ({
  composeHousekeepingScheduler: schedulerMocks.composeHousekeepingScheduler,
}));

vi.mock('../composition/bin/housekeeping-scheduler-instance.js', () => ({
  housekeepingSchedulerRegistry: {
    setScheduler: schedulerMocks.setHousekeepingScheduler,
  },
}));

import {
  startHousekeepingScheduler,
  startSchedulers,
  startServeHousekeepingScheduler,
  type StartHousekeepingSchedulerOptions,
  type StartSchedulersOptions,
  type StartServeHousekeepingSchedulerOptions,
} from '../serve/start-schedulers.js';
import type { SchedulersBundle } from '../composition/bin/wire-schedulers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const startSchedulersPath = join(
  repoRoot,
  'backend/server/src/serve/start-schedulers.ts',
);
const startHousekeepingStartupPath = join(
  repoRoot,
  'backend/server/src/serve/start-housekeeping-startup.ts',
);
const startPostListenerRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-listener-runtime.ts',
);
const startListenerExposureRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-listener-exposure-runtime.ts',
);
const lifecycleRecoveryBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-lifecycle-recovery-pre-listener-runtime.ts',
);
const postExecutionBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-execution-bootstrap-maintenance-runtime.ts',
);
const composeLifecyclePath = join(
  repoRoot,
  'backend/server/src/serve/compose-lifecycle.ts',
);
const composeMaintenancePath = join(
  repoRoot,
  'backend/server/src/serve/compose-maintenance-context.ts',
);

beforeEach(() => {
  schedulerMocks.composeSchedulers.mockReset();
  schedulerMocks.composeHousekeepingScheduler.mockReset();
  schedulerMocks.setHousekeepingScheduler.mockReset();
});

const makeOptions = (): StartSchedulersOptions =>
  ({
    registry: { register: vi.fn(), stopAll: vi.fn(), list: vi.fn(() => []) },
    db: { tag: 'db' },
    scheduleStore: { tag: 'schedule-store' },
    executeDeps: { tag: 'execute-deps' },
    recipeStore: { tag: 'recipe-store' },
    circuitStore: { tag: 'circuit-store' },
  }) as unknown as StartSchedulersOptions;

const makeBundle = (): SchedulersBundle =>
  ({
    cron: undefined,
    autoRun: undefined,
    list: vi.fn(() => []),
    rebuildAll: vi.fn(),
  }) as unknown as SchedulersBundle;

const makeHousekeepingOptions = (): StartHousekeepingSchedulerOptions =>
  ({
    db: { tag: 'db' },
    stores: {
      configStore: { tag: 'config' },
      stateStore: { tag: 'state' },
      trustStore: { tag: 'trust' },
      tunableParamsStore: { tag: 'tunable-params-store' },
      llmResultCacheStore: { tag: 'llm-result-cache-store' },
    },
    enrichmentStore: { tag: 'enrichment-store' },
    recipeStore: { tag: 'recipe-store' },
    collectionRegistry: { tag: 'collection-registry' },
    cacheBlobs: { tag: 'cache-blobs' },
    eventBus: { tag: 'event-bus' },
    warehouseBus: { tag: 'warehouse-bus' },
    auditLog: { tag: 'audit-log' },
    llmCallables: { tag: 'llm-callables' },
    getAutoRunInFlight: vi.fn(() => false),
    getActiveContactMergeScanMode: vi.fn(() => 'delta'),
    getContactMergeCycleObserver: vi.fn(() => undefined),
    enrichmentProducers: new Map(),
  }) as unknown as StartHousekeepingSchedulerOptions;

const makeServeHousekeepingOptions = (
  overrides: Partial<StartServeHousekeepingSchedulerOptions> = {},
): StartServeHousekeepingSchedulerOptions =>
  ({
    storage: {
      db: { tag: 'db' },
      recipeStore: { tag: 'recipe-store' },
      eventBus: { tag: 'event-bus' },
      auditLog: { tag: 'audit-log' },
      workEntityStoreRef: { tag: 'work-entity-store' },
    },
    app: {
      housekeepingConfigRef: { tag: 'config' },
      housekeepingStateRef: { tag: 'state' },
      housekeepingTrustRef: { tag: 'trust' },
      housekeepingTunableParamsRef: { tag: 'tunable-params-store' },
      housekeepingLlmResultCacheRef: { tag: 'llm-result-cache-store' },
      enrichmentStoreRef: { tag: 'enrichment-store' },
      cacheBlobs: { tag: 'cache-blobs' },
      warehouseBus: { tag: 'warehouse-bus' },
      contactStoreRef: { tag: 'contact-store' },
      enrichmentCascadeRef: { tag: 'enrichment-cascade' },
      externalContextRegistryRef: { tag: 'external-context-registry' },
    },
    collection: {
      collectionRegistry: { tag: 'collection-registry' },
    },
    llmCallables: { tag: 'llm-callables' },
    rotationEngine: { tag: 'rotation-engine' },
    tlsCertSource: { tag: 'tls-cert-source' },
    tlsRenewerConfigured: true,
    getSchedulerBundle: vi.fn(() => ({
      autoRun: {
        getHandle: vi.fn(() => ({ inFlight: vi.fn(() => false) })),
      },
    } as unknown as SchedulersBundle)),
    getActiveContactMergeScanMode: vi.fn(() => 'delta'),
    getContactMergeCycleObserver: vi.fn(() => undefined),
    enrichmentProducers: new Map(),
    ...overrides,
  }) as unknown as StartServeHousekeepingSchedulerOptions;

describe('startSchedulers', () => {
  it('returns the composeSchedulers bundle without hiding the boot context', () => {
    const options = makeOptions();
    const bundle = makeBundle();
    schedulerMocks.composeSchedulers.mockReturnValue(bundle);

    const result = startSchedulers(options);

    expect(result).toBe(bundle);
    expect(schedulerMocks.composeSchedulers).toHaveBeenCalledTimes(1);
    expect(schedulerMocks.composeSchedulers).toHaveBeenCalledWith(options);
  });
});

describe('startHousekeepingScheduler', () => {
  it('returns the housekeeping scheduler bundle and publishes the scheduler', async () => {
    const options = makeHousekeepingOptions();
    const scheduler = { runOnce: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const bundle = { scheduler };
    schedulerMocks.composeHousekeepingScheduler.mockResolvedValue(bundle);

    const result = await startHousekeepingScheduler(options);

    expect(result).toBe(bundle);
    expect(schedulerMocks.composeHousekeepingScheduler).toHaveBeenCalledTimes(1);
    expect(schedulerMocks.composeHousekeepingScheduler).toHaveBeenCalledWith(options);
    expect(schedulerMocks.setHousekeepingScheduler).toHaveBeenCalledTimes(1);
    expect(schedulerMocks.setHousekeepingScheduler).toHaveBeenCalledWith(scheduler);
  });

  it('does not publish when the housekeeping composer returns no scheduler', async () => {
    const options = makeHousekeepingOptions();
    const bundle = { scheduler: undefined };
    schedulerMocks.composeHousekeepingScheduler.mockResolvedValue(bundle);

    const result = await startHousekeepingScheduler(options);

    expect(result).toBe(bundle);
    expect(schedulerMocks.composeHousekeepingScheduler).toHaveBeenCalledWith(options);
    expect(schedulerMocks.setHousekeepingScheduler).not.toHaveBeenCalled();
  });
});

describe('startServeHousekeepingScheduler', () => {
  it('preserves the serve-entry gate before composing housekeeping scheduler deps', async () => {
    const base = makeServeHousekeepingOptions();
    const missingPrereqs: Array<Partial<StartServeHousekeepingSchedulerOptions>> = [
      { storage: { ...base.storage, db: undefined } },
      { app: { ...base.app, enrichmentStoreRef: undefined } },
      { app: { ...base.app, housekeepingConfigRef: undefined } },
      { app: { ...base.app, housekeepingStateRef: undefined } },
    ];

    for (const missing of missingPrereqs) {
      schedulerMocks.composeHousekeepingScheduler.mockClear();
      const result = await startServeHousekeepingScheduler({
        ...base,
        ...missing,
      });

      expect(result).toEqual({ scheduler: undefined });
      expect(schedulerMocks.composeHousekeepingScheduler).not.toHaveBeenCalled();
      expect(schedulerMocks.setHousekeepingScheduler).not.toHaveBeenCalled();
    }
  });

  it('assembles the serve housekeeping scheduler options and publishes the scheduler', async () => {
    const options = makeServeHousekeepingOptions();
    const scheduler = { runOnce: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const bundle = { scheduler };
    schedulerMocks.composeHousekeepingScheduler.mockResolvedValue(bundle);

    const result = await startServeHousekeepingScheduler(options);

    expect(result).toBe(bundle);
    expect(schedulerMocks.composeHousekeepingScheduler).toHaveBeenCalledTimes(1);
    expect(schedulerMocks.composeHousekeepingScheduler).toHaveBeenCalledWith(
      expect.objectContaining({
        db: options.storage.db,
        stores: {
          configStore: options.app.housekeepingConfigRef,
          stateStore: options.app.housekeepingStateRef,
          trustStore: options.app.housekeepingTrustRef,
          tunableParamsStore: options.app.housekeepingTunableParamsRef,
          llmResultCacheStore: options.app.housekeepingLlmResultCacheRef,
        },
        enrichmentStore: options.app.enrichmentStoreRef,
        recipeStore: options.storage.recipeStore,
        collectionRegistry: options.collection.collectionRegistry,
        cacheBlobs: options.app.cacheBlobs,
        eventBus: options.storage.eventBus,
        warehouseBus: options.app.warehouseBus,
        auditLog: options.storage.auditLog,
        llmCallables: options.llmCallables,
        contactStore: options.app.contactStoreRef,
        workEntityStore: options.storage.workEntityStoreRef,
        enrichmentCascade: options.app.enrichmentCascadeRef,
        externalContextRegistry: options.app.externalContextRegistryRef,
        rotationEngine: options.rotationEngine,
        tlsCertSource: options.tlsCertSource,
        tlsRenewerConfigured: options.tlsRenewerConfigured,
        getActiveContactMergeScanMode: options.getActiveContactMergeScanMode,
        getContactMergeCycleObserver: options.getContactMergeCycleObserver,
        enrichmentProducers: options.enrichmentProducers,
      }),
    );
    expect(schedulerMocks.setHousekeepingScheduler).toHaveBeenCalledWith(scheduler);
  });

  it('forwards sellerAccessReconcileDeps to the composer (D-196 §6.3 s2b) — and omits the key when absent', async () => {
    // The threading assertion: this layer is where a dropped/typo'd spread key
    // would silently un-register the reconciler. A conditional spread is NOT
    // caught by excess-property checks, so tsc alone does not protect it.
    const sellerAccessReconcileDeps = { tag: 'seller-reconcile-deps' };
    schedulerMocks.composeHousekeepingScheduler.mockResolvedValue({ scheduler: undefined });

    await startServeHousekeepingScheduler(
      makeServeHousekeepingOptions({ sellerAccessReconcileDeps } as never),
    );
    expect(schedulerMocks.composeHousekeepingScheduler).toHaveBeenCalledWith(
      expect.objectContaining({ sellerAccessReconcileDeps }),
    );

    schedulerMocks.composeHousekeepingScheduler.mockClear();
    await startServeHousekeepingScheduler(makeServeHousekeepingOptions());
    expect(schedulerMocks.composeHousekeepingScheduler.mock.calls[0]![0])
      .not.toHaveProperty('sellerAccessReconcileDeps');
  });

  it('keeps auto-run in-flight reads late-bound through the scheduler bundle getter', async () => {
    const firstHandle = { inFlight: vi.fn(() => false) };
    const secondHandle = { inFlight: vi.fn(() => true) };
    let currentBundle = {
      autoRun: { getHandle: vi.fn(() => firstHandle) },
    } as unknown as SchedulersBundle;
    const options = makeServeHousekeepingOptions({
      getSchedulerBundle: vi.fn(() => currentBundle),
    });
    schedulerMocks.composeHousekeepingScheduler.mockResolvedValue({ scheduler: undefined });

    await startServeHousekeepingScheduler(options);

    const composedOptions = schedulerMocks.composeHousekeepingScheduler.mock
      .calls[0]![0] as StartHousekeepingSchedulerOptions;
    expect(composedOptions.getAutoRunInFlight?.()).toBe(false);

    currentBundle = {
      autoRun: { getHandle: vi.fn(() => secondHandle) },
    } as unknown as SchedulersBundle;
    expect(composedOptions.getAutoRunInFlight?.()).toBe(true);
    expect(firstHandle.inFlight).toHaveBeenCalledTimes(1);
    expect(secondHandle.inFlight).toHaveBeenCalledTimes(1);
  });

  it('omits auto-run in-flight when auto-run was not booted at scheduler startup', async () => {
    const options = makeServeHousekeepingOptions({
      getSchedulerBundle: vi.fn(() => ({}) as unknown as SchedulersBundle),
    });
    schedulerMocks.composeHousekeepingScheduler.mockResolvedValue({ scheduler: undefined });

    await startServeHousekeepingScheduler(options);

    const composedOptions = schedulerMocks.composeHousekeepingScheduler.mock
      .calls[0]![0] as StartHousekeepingSchedulerOptions;
    expect(composedOptions.getAutoRunInFlight).toBeUndefined();
  });
});

describe('start-schedulers source boundary', () => {
  it('owns scheduler startup and housekeeping option assembly without taking serve orchestration', () => {
    const source = readFileSync(startSchedulersPath, 'utf8');

    expect(source).toMatch(/composeSchedulers/);
    expect(source).toMatch(/composeHousekeepingScheduler/);
    expect(source).toMatch(/housekeepingSchedulerRegistry\.setScheduler/);
    expect(source).toMatch(/startServeHousekeepingScheduler/);
    expect(source).toMatch(/getAutoRunInFlight/);
    expect(source).toMatch(/options\.getSchedulerBundle\(\)\?\.autoRun/);
    expect(stripSourceComments(source)).not.toMatch(/backgroundServices/);
    expect(stripSourceComments(source)).not.toMatch(/createLifecycle|LockHeldError|process\.on|process\.exit/);
  });

  it('preserves late-bound scheduler bundle getters in the runtime bridges and lifecycle', () => {
    const postExecutionBridgeSource = readFileSync(postExecutionBridgePath, 'utf8');
    const lifecycleRecoveryBridgeSource = readFileSync(
      lifecycleRecoveryBridgePath,
      'utf8',
    );
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');
    const runtimeSource = readFileSync(startPostListenerRuntimePath, 'utf8');
    const startupSource = readFileSync(startHousekeepingStartupPath, 'utf8');
    const lifecycleSource = readFileSync(composeLifecyclePath, 'utf8');
    const maintenanceSource = readFileSync(composeMaintenancePath, 'utf8');

    expect(bridgeSource).toMatch(/start-post-listener-runtime\.js/);
    expect(runtimeSource).toMatch(/const schedulersBundle = startSchedulers\(\{/);
    expect(runtimeSource).toMatch(/options\.publishSchedulersBundle\(schedulersBundle\)/);
    expect(runtimeSource).toMatch(/await startHousekeepingStartup\(\{/);
    expect(startupSource).toMatch(/return startServeHousekeepingScheduler\(\{/);
    expect(postExecutionBridgeSource).toMatch(
      /getSchedulersBundle:\s*\(\) => schedulersBundle/,
    );
    expect(maintenanceSource).toMatch(/getSchedulersBundle\(\)\?\.rebuildAll\(\)/);
    expect(lifecycleRecoveryBridgeSource).toMatch(
      /getAutoRunHandle:\s*\(\) => options\.getSchedulersBundle\(\)\?\.autoRun\?\.getHandle\(\)/,
    );
    expect(runtimeSource).toMatch(
      /getSchedulerBundle:\s*\(\) => schedulersBundle/,
    );
    expect(postExecutionBridgeSource).toMatch(
      /getSchedulersBundle:\s*\(\) => schedulersBundle/,
    );
    expect(lifecycleSource).toMatch(
      /getSchedulersBundle\(\)\?\.cron\?\.getHandle\(\)\?\.pause\(\)/,
    );
    expect(lifecycleSource).toMatch(
      /getSchedulersBundle\(\)\?\.cron\?\.getHandle\(\)\?\.inFlight\(\)/,
    );
  });

  it('keeps cert-stack late composition before housekeeping scheduler startup', () => {
    const source = readFileSync(startPostListenerRuntimePath, 'utf8');
    const certLateIndex = source.indexOf('await composeCertStackLate({');
    const housekeepingStartIndex = source.indexOf('await startHousekeepingStartup');

    expect(certLateIndex).toBeGreaterThanOrEqual(0);
    expect(housekeepingStartIndex).toBeGreaterThan(certLateIndex);
  });
});
