import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stripSourceComments } from './helpers/source-guards.js';

const startupMocks = vi.hoisted(() => ({
  clearDefaultHousekeepingRegistry: vi.fn(),
  composeVendorSubstrateContext: vi.fn(),
  composeHousekeepingLlmCallables: vi.fn(),
  startServeHousekeepingScheduler: vi.fn(),
}));

vi.mock('../housekeeping/index.js', () => ({
  clearDefaultHousekeepingRegistry: startupMocks.clearDefaultHousekeepingRegistry,
}));

vi.mock('../serve/compose-vendor-substrate.js', () => ({
  composeVendorSubstrateContext: startupMocks.composeVendorSubstrateContext,
}));

vi.mock('../serve/compose-housekeeping-llm-callables.js', () => ({
  composeHousekeepingLlmCallables:
    startupMocks.composeHousekeepingLlmCallables,
}));

vi.mock('../serve/start-schedulers.js', () => ({
  startServeHousekeepingScheduler: startupMocks.startServeHousekeepingScheduler,
}));

import {
  startHousekeepingStartup,
  type StartHousekeepingStartupOptions,
} from '../serve/start-housekeeping-startup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
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

beforeEach(() => {
  startupMocks.clearDefaultHousekeepingRegistry.mockReset();
  startupMocks.composeVendorSubstrateContext.mockReset();
  startupMocks.composeHousekeepingLlmCallables.mockReset();
  startupMocks.startServeHousekeepingScheduler.mockReset();
});

const makeOptions = (
  overrides: Partial<StartHousekeepingStartupOptions> = {},
): StartHousekeepingStartupOptions =>
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
      enrichmentStoreRef: { tag: 'enrichment-store' },
      cacheBlobs: { tag: 'cache-blobs' },
      warehouseBus: { tag: 'warehouse-bus' },
      contactStoreRef: { tag: 'contact-store' },
      enrichmentCascadeRef: { tag: 'enrichment-cascade' },
      externalContextRegistryRef: { tag: 'external-context-registry' },
      connectionStoreRef: { tag: 'connection-store' },
      keys: { tag: 'keys' },
      engagementStoreRef: { tag: 'engagement-store' },
      upstreamMergeStoreRef: { tag: 'upstream-merge-store' },
      llmManager: { tag: 'llm-manager' },
      llmConfig: { tag: 'llm-config' },
      llmQuota: { tag: 'llm-quota' },
      llmAdapterRegistry: { tag: 'llm-adapter-registry' },
      llmEmbeddingsAdapterRegistry: { tag: 'llm-embeddings-adapter-registry' },
      emptyTabProbe: vi.fn(),
    },
    collection: {
      collectionRegistry: { tag: 'collection-registry' },
    },
    upstreamMergeRegistry: new Map(),
    publishVendorRefs: vi.fn(),
    rotationEngine: { tag: 'rotation-engine' },
    tlsCertSource: { tag: 'tls-cert-source' },
    tlsRenewerConfigured: true,
    getSchedulerBundle: vi.fn(() => ({ tag: 'schedulers-bundle' })),
    getActiveContactMergeScanMode: vi.fn(() => 'delta'),
    getContactMergeCycleObserver: vi.fn(() => undefined),
    enrichmentProducers: new Map(),
    ...overrides,
  }) as unknown as StartHousekeepingStartupOptions;

describe('startHousekeepingStartup', () => {
  it('preserves the previous serve-entry gate before startup orchestration', async () => {
    const base = makeOptions();
    const missingPrereqs: Array<Partial<StartHousekeepingStartupOptions>> = [
      { storage: { ...base.storage, db: undefined } },
      { app: { ...base.app, enrichmentStoreRef: undefined } },
      { app: { ...base.app, housekeepingConfigRef: undefined } },
      { app: { ...base.app, housekeepingStateRef: undefined } },
    ];

    for (const missing of missingPrereqs) {
      const publishVendorRefs = vi.fn();
      const result = await startHousekeepingStartup({
        ...base,
        publishVendorRefs,
        ...missing,
      });

      expect(result).toEqual({ scheduler: undefined });
      expect(startupMocks.clearDefaultHousekeepingRegistry).not.toHaveBeenCalled();
      expect(startupMocks.composeVendorSubstrateContext).not.toHaveBeenCalled();
      expect(startupMocks.composeHousekeepingLlmCallables).not.toHaveBeenCalled();
      expect(startupMocks.startServeHousekeepingScheduler).not.toHaveBeenCalled();
      expect(publishVendorRefs).not.toHaveBeenCalled();
    }
  });

  it('clears, composes vendor refs, publishes refs, composes LLM callables, then starts housekeeping', async () => {
    const order: string[] = [];
    const vendorRefs = {
      apiConnectionLookup: vi.fn(),
      refreshApiConnectionAuth: vi.fn(),
      registerSalesforceCallEntity: vi.fn(),
    };
    const llmCallables = { tag: 'llm-callables' };
    const schedulerBundle = { scheduler: { tag: 'scheduler' } };
    startupMocks.clearDefaultHousekeepingRegistry.mockImplementation(() => {
      order.push('clear');
    });
    startupMocks.composeVendorSubstrateContext.mockImplementation(async () => {
      order.push('vendor');
      return vendorRefs;
    });
    startupMocks.composeHousekeepingLlmCallables.mockImplementation(() => {
      order.push('llm');
      return llmCallables;
    });
    startupMocks.startServeHousekeepingScheduler.mockImplementation(async () => {
      order.push('scheduler');
      return schedulerBundle;
    });
    const options = makeOptions({
      publishVendorRefs: vi.fn(() => {
        order.push('publish');
      }),
    });

    const result = await startHousekeepingStartup(options);

    expect(result).toBe(schedulerBundle);
    expect(order).toEqual(['clear', 'vendor', 'publish', 'llm', 'scheduler']);
    expect(startupMocks.composeVendorSubstrateContext).toHaveBeenCalledWith({
      app: options.app,
      upstreamMergeRegistry: options.upstreamMergeRegistry,
      eventBus: options.storage.eventBus,
    });
    expect(options.publishVendorRefs).toHaveBeenCalledWith(vendorRefs);
    expect(startupMocks.composeHousekeepingLlmCallables).toHaveBeenCalledWith({
      substrate: options.app,
    });
    expect(startupMocks.startServeHousekeepingScheduler).toHaveBeenCalledWith({
      storage: options.storage,
      app: options.app,
      collection: options.collection,
      llmCallables,
      rotationEngine: options.rotationEngine,
      tlsCertSource: options.tlsCertSource,
      tlsRenewerConfigured: options.tlsRenewerConfigured,
      getSchedulerBundle: options.getSchedulerBundle,
      getActiveContactMergeScanMode: options.getActiveContactMergeScanMode,
      getContactMergeCycleObserver: options.getContactMergeCycleObserver,
      enrichmentProducers: options.enrichmentProducers,
    });
  });

  it('forwards sellerAccessReconcileDeps to the scheduler (D-196 §6.3 s2b), and omits it when absent', async () => {
    // The other threading layer where a dropped spread key would silently
    // un-register the reconciler — pinned the same way as start-schedulers.
    const sellerAccessReconcileDeps = { tag: 'seller-reconcile-deps' };
    startupMocks.composeVendorSubstrateContext.mockResolvedValue(undefined);
    startupMocks.composeHousekeepingLlmCallables.mockReturnValue({ tag: 'llm-callables' });
    startupMocks.startServeHousekeepingScheduler.mockResolvedValue({ scheduler: undefined });

    await startHousekeepingStartup(makeOptions({ sellerAccessReconcileDeps } as never));
    expect(startupMocks.startServeHousekeepingScheduler).toHaveBeenCalledWith(
      expect.objectContaining({ sellerAccessReconcileDeps }),
    );

    startupMocks.startServeHousekeepingScheduler.mockClear();
    await startHousekeepingStartup(makeOptions());
    expect(startupMocks.startServeHousekeepingScheduler.mock.calls[0]![0])
      .not.toHaveProperty('sellerAccessReconcileDeps');
  });

  it('continues through LLM and scheduler startup when vendor refs are absent', async () => {
    startupMocks.composeVendorSubstrateContext.mockResolvedValue(undefined);
    startupMocks.composeHousekeepingLlmCallables.mockReturnValue({ tag: 'llm-callables' });
    startupMocks.startServeHousekeepingScheduler.mockResolvedValue({
      scheduler: undefined,
    });
    const options = makeOptions();

    await startHousekeepingStartup(options);

    expect(options.publishVendorRefs).not.toHaveBeenCalled();
    expect(startupMocks.composeHousekeepingLlmCallables).toHaveBeenCalledTimes(1);
    expect(startupMocks.startServeHousekeepingScheduler).toHaveBeenCalledTimes(1);
  });
});

describe('start-housekeeping-startup source boundary', () => {
  it('keeps housekeeping startup orchestration behind post-listener runtime', () => {
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');
    const runtimeSource = readFileSync(startPostListenerRuntimePath, 'utf8');

    expect(bridgeSource).toMatch(/start-post-listener-runtime\.js/);
    expect(runtimeSource).toMatch(/start-housekeeping-startup\.js/);
    expect(runtimeSource).toMatch(/startHousekeepingStartup\(\{/);
  });

  it('keeps registry clear, vendor publication, LLM callables, and scheduler startup ordered', () => {
    const source = readFileSync(startHousekeepingStartupPath, 'utf8');
    const clearIndex = source.indexOf('clearDefaultHousekeepingRegistry();');
    const vendorIndex = source.indexOf('const vendorRefs = await composeVendorSubstrateContext({');
    const publishIndex = source.indexOf('options.publishVendorRefs(vendorRefs);');
    const llmIndex = source.indexOf('const housekeepingLlmCallables = composeHousekeepingLlmCallables({');
    const schedulerIndex = source.indexOf('return startServeHousekeepingScheduler({');

    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(vendorIndex).toBeGreaterThan(clearIndex);
    expect(publishIndex).toBeGreaterThan(vendorIndex);
    expect(llmIndex).toBeGreaterThan(publishIndex);
    expect(schedulerIndex).toBeGreaterThan(llmIndex);
  });

  it('keeps the helper out of unrelated serve phases', () => {
    const source = readFileSync(startHousekeepingStartupPath, 'utf8');

    expect(source).toMatch(/clearDefaultHousekeepingRegistry/);
    expect(source).toMatch(/composeVendorSubstrateContext/);
    expect(source).toMatch(/composeHousekeepingLlmCallables/);
    expect(source).toMatch(/startServeHousekeepingScheduler/);
    expect(stripSourceComments(source)).not.toMatch(/startRetentionPruners|startDdnsUpdatePoller/);
    expect(stripSourceComments(source)).not.toMatch(/logBootBanner|installShutdown/);
    expect(stripSourceComments(source)).not.toMatch(/composeServeExposure|composeServeLifecycle/);
    expect(stripSourceComments(source)).not.toMatch(/startBootRecoveryAndAdapters/);
    expect(stripSourceComments(source)).not.toMatch(/createServerHandlerSet|createProductionPathListenerCoordinator/);
  });
});
