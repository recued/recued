import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stripSourceComments } from './helpers/source-guards.js';
import { resolveServerBundlePath } from '../server-bundle-store.js';

const bridgeMocks = vi.hoisted(() => ({
  composeStorageContext: vi.fn(),
  composeAppContext: vi.fn(),
  createExecutionLateBoundRefs: vi.fn(),
  startPostAppCollectionExecutionRuntime: vi.fn(),
}));

const singletonMocks = vi.hoisted(() => ({
  backgroundServices: { tag: 'default-background-services' },
  schedulerRegistry: {
    producers: vi.fn(() => new Map([['default-producer', { tag: 'producer' }]])),
  },
}));

vi.mock('../serve/compose-storage-context.js', () => ({
  composeStorageContext: bridgeMocks.composeStorageContext,
}));

vi.mock('../serve/compose-app-context.js', () => ({
  composeAppContext: bridgeMocks.composeAppContext,
}));

vi.mock('../serve/compose-execution-context.js', () => ({
  createExecutionLateBoundRefs: bridgeMocks.createExecutionLateBoundRefs,
}));

vi.mock('../serve/start-post-app-collection-execution-runtime.js', () => ({
  startPostAppCollectionExecutionRuntime:
    bridgeMocks.startPostAppCollectionExecutionRuntime,
}));

vi.mock('../composition/bin/background-services-instance.js', () => ({
  backgroundServices: singletonMocks.backgroundServices,
}));

vi.mock('../composition/bin/housekeeping-scheduler-instance.js', () => ({
  housekeepingSchedulerRegistry: singletonMocks.schedulerRegistry,
}));

import {
  startPostBaseStorageVaultRuntime,
  startPostStorageAppCollectionExecutionRuntime,
  type StartPostBaseStorageVaultRuntimeOptions,
  type StartPostStorageAppCollectionExecutionRuntimeOptions,
} from '../serve/start-post-storage-app-collection-execution-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const helperPath = join(
  repoRoot,
  'backend/server/src/serve/start-post-storage-app-collection-execution-runtime.ts',
);
const postAppBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-app-collection-execution-runtime.ts',
);

beforeEach(() => {
  bridgeMocks.composeStorageContext.mockReset();
  bridgeMocks.composeAppContext.mockReset();
  bridgeMocks.createExecutionLateBoundRefs.mockReset();
  bridgeMocks.startPostAppCollectionExecutionRuntime.mockReset();
  singletonMocks.schedulerRegistry.producers.mockClear();
});

const makePostBaseOptions = (
  overrides: Partial<StartPostBaseStorageVaultRuntimeOptions> = {},
): StartPostBaseStorageVaultRuntimeOptions =>
  ({
    base: {
      args: ['--reset-exposure'],
      subcommand: undefined,
      bootTrace: { mark: vi.fn() },
      dbPath: '/tmp/recued.db',
      port: 1234,
      distribution: 'source',
      loadedConfig: {
        source: '/tmp/config.toml',
        bootstrap: { webhook_port: 9876 },
        runtime: {},
      },
      runtimeConfig: { tag: 'runtime-config' },
      vaultQuotas: { totalBytes: 1024, perPublisherBytes: 256 },
    },
    serverVersion: '9.9.9',
    backgroundServices: { tag: 'background-services' },
    schedulerRegistry: {
      producers: vi.fn(() => new Map([['producer', { tag: 'producer' }]])),
    },
    env: { RECUED_SERVER_NAME: 'test-server' },
    ...overrides,
  }) as unknown as StartPostBaseStorageVaultRuntimeOptions;

const makeOptions = (
  overrides: Partial<StartPostStorageAppCollectionExecutionRuntimeOptions> = {},
): StartPostStorageAppCollectionExecutionRuntimeOptions =>
  ({
    app: {
      db: { tag: 'db' },
      dbPath: '/tmp/recued.db',
      envLlmConfig: { tag: 'env-llm-config' },
      gateRegistry: { tag: 'gate-registry' },
      auditLog: { tag: 'audit-log' },
      eventBus: { tag: 'event-bus' },
      serverInstanceId: 'server-1',
      recipeStore: { tag: 'recipe-store' },
      pairedInstances: { tag: 'paired-instances' },
      workEntityStore: { tag: 'work-entity-store' },
    },
    collection: {
      runtimeConfig: { tag: 'runtime-config' },
      manifests: { tag: 'manifests' },
      baseVault: { token: 'secret' },
      accountStore: { tag: 'account-store' },
    },
    execution: {
      storage: { tag: 'storage' },
      baseVault: { token: 'secret' },
      env: { RECUED_SERVER_NAME: 'test-server' },
    },
    postApp: {
      postExecution: {
        bootstrapCascade: {
          base: {
            loadedConfig: {
              source: '/tmp/config.toml',
              bootstrap: { webhook_port: 9876 },
              runtime: {},
            },
            runtimeConfig: { tag: 'runtime-config' },
          },
          serverVersion: '9.9.9',
          storage: { tag: 'storage' },
        },
        maintenance: {
          dbPath: '/tmp/recued.db',
          storage: { tag: 'storage' },
          backgroundServices: { tag: 'background-services' },
        },
        runtime: {
          lifecycle: {
            db: { tag: 'db' },
            base: {
              dbPath: '/tmp/recued.db',
              port: 1234,
              distribution: 'source',
              loadedConfig: {
                source: '/tmp/config.toml',
                bootstrap: { webhook_port: 9876 },
                runtime: {},
              },
              runtimeConfig: { tag: 'runtime-config' },
            },
            serverVersion: '9.9.9',
            auditLog: { tag: 'audit-log' },
            storage: { tag: 'storage' },
            backgroundServices: { tag: 'background-services' },
          },
          recovery: {
            bootSigningIdentity: vi.fn(async () => undefined),
            checkpointStore: { tag: 'checkpoint-store' },
            auditLog: { tag: 'audit-log' },
            commitStore: { tag: 'commit-store' },
            fileStack: { tag: 'file-stack' },
          },
          preListener: {
            args: ['--reset-exposure'],
            dbPath: '/tmp/recued.db',
            port: 1234,
            webhookPort: 9876,
            runtimeConfig: { tag: 'runtime-config' },
            backgroundServices: { tag: 'background-services' },
            storage: { tag: 'storage' },
            schedulerRegistry: { tag: 'scheduler-registry' },
            enrichmentProducers: new Map(),
            env: { RECUED_MCP_HTTP_TOKEN: 'token' },
          },
          getSigningIdentity: vi.fn(() => ({ tag: 'signing-identity' })),
          getUpstreamMergeRegistry: vi.fn(() => ({ tag: 'upstream-registry' })),
          publishUpstreamMergeRegistry: vi.fn(),
          setActiveContactMergeScanMode: vi.fn(),
          getApiConnectionLookup: vi.fn(() => undefined),
          getRefreshAuth: vi.fn(() => undefined),
          getRegisterSalesforceCallEntity: vi.fn(() => undefined),
          publishVendorRefs: vi.fn(),
          getActiveContactMergeScanMode: vi.fn(() => 'delta'),
        },
      },
    },
    ...overrides,
  }) as unknown as StartPostStorageAppCollectionExecutionRuntimeOptions;

describe('startPostBaseStorageVaultRuntime', () => {
  it('orders storage, vault init, and post-storage runtime while preserving cleanup and live refs', async () => {
    const order: string[] = [];
    const initialVault = { token: 'initial' };
    const refreshedVault = { token: 'refreshed' };
    const initialIdentity = { tag: 'initial-signing-identity' };
    const updatedIdentity = { tag: 'updated-signing-identity' };
    let currentVault = initialVault;
    let currentIdentity: unknown = initialIdentity;
    const db = { close: vi.fn() };
    const storage = {
      db,
      manifests: { tag: 'manifests' },
      recipeStore: { tag: 'recipe-store' },
      eventBus: { tag: 'event-bus' },
      envLlmConfig: { tag: 'env-llm-config' },
      gateRegistry: { tag: 'gate-registry' },
      auditLog: { tag: 'audit-log' },
      serverInstanceId: 'server-1',
      pairedInstances: { tag: 'paired-instances' },
      workEntityStoreRef: { tag: 'work-entity-store' },
      accountStore: { tag: 'account-store' },
      checkpointStore: { tag: 'checkpoint-store' },
      commitStore: { tag: 'commit-store' },
      fileStack: { tag: 'file-stack' },
      get baseVault() {
        return currentVault;
      },
      initVault: vi.fn(async () => {
        order.push('vault-init');
        currentVault = refreshedVault;
      }),
      get signingIdentity() {
        return currentIdentity;
      },
      bootSigningIdentity: vi.fn(async () => {
        currentIdentity = updatedIdentity;
      }),
    };
    let publishedCleanup: (() => void) | undefined;
    const cleanupPublish = vi.fn((cleanup: () => void) => {
      order.push('cleanup-published');
      publishedCleanup = cleanup;
    });
    const options = makePostBaseOptions({ publishDbCleanup: cleanupPublish });
    const lateBound = { tag: 'late-bound' };
    const app = {
      cacheBlobs: { tag: 'cache-blobs' },
      warehouseBus: { tag: 'warehouse-bus' },
      contactStoreRef: { tag: 'contact-store' },
      keys: { tag: 'keys' },
      connectionStoreRef: { tag: 'connection-store' },
      enrichmentCascadeRef: { tag: 'enrichment-cascade' },
      contactMergeCycleObserverRef: { tag: 'contact-observer' },
    };
    const postApp = { tag: 'post-app-result' };

    bridgeMocks.composeStorageContext.mockImplementation(async (actualOptions) => {
      order.push('storage');
      expect(actualOptions).toEqual({
        dbPath: options.base.dbPath,
        bootTrace: options.base.bootTrace,
        runtimeConfig: options.base.runtimeConfig,
        vaultQuotas: options.base.vaultQuotas,
        // slice 4 — late-bound vault key.
        getVaultKey: expect.any(Function),
      });
      return storage;
    });
    bridgeMocks.createExecutionLateBoundRefs.mockImplementation(() => {
      order.push('late-bound');
      return lateBound;
    });
    bridgeMocks.composeAppContext.mockImplementation((actualOptions) => {
      order.push('app');
      expect(actualOptions.db).toBe(db);
      expect(actualOptions.dbPath).toBe(options.base.dbPath);
      expect(actualOptions.serverBundleStore.path).toBe(
        resolveServerBundlePath(options.base.dbPath),
      );
      expect(actualOptions.recipeStore).toBe(storage.recipeStore);
      expect(actualOptions.chatLateBound).toBe(lateBound);
      return app;
    });
    bridgeMocks.startPostAppCollectionExecutionRuntime.mockImplementation(
      async (actualOptions) => {
        order.push('post-app');
        // 🔑 The runtime hands down ONE STABLE baseVault container and MUTATES
        // it in place on re-load (start-post-storage-...ts:164-173) — the
        // executor captures this reference and reads it live at dispatch, so a
        // post-unlock reassign would strand it on the empty pre-unlock
        // snapshot and drop persisted `{{vault.*}}` creds. So it is NOT the
        // storage context's own object; assert its CONTENTS synced, and that
        // both consumers share the SAME container (the invariant that matters).
        expect(actualOptions.collection.baseVault).toEqual(refreshedVault);
        expect(actualOptions.collection.baseVault).not.toBe(refreshedVault);
        expect(actualOptions.collection.cacheBlobs).toBe(app.cacheBlobs);
        expect(actualOptions.execution.baseVault).toBe(actualOptions.collection.baseVault);
        expect(actualOptions.execution.app).toBe(app);
        expect(actualOptions.execution.lateBound).toBe(lateBound);
        expect(actualOptions.postExecution.bootstrapCascade.base).toEqual({
          loadedConfig: options.base.loadedConfig,
          runtimeConfig: options.base.runtimeConfig,
        });
        expect(actualOptions.postExecution.runtime.lifecycle.base)
          .toMatchObject({
            dbPath: options.base.dbPath,
            port: options.base.port,
            distribution: options.base.distribution,
          });
        expect(actualOptions.postExecution.runtime.preListener).toMatchObject({
          args: options.base.args,
          dbPath: options.base.dbPath,
          port: options.base.port,
          webhookPort: options.base.loadedConfig.bootstrap.webhook_port,
        });
        expect(
          actualOptions.postExecution.runtime.getSigningIdentity(),
        ).toBe(initialIdentity);
        await actualOptions.postExecution.runtime.recovery.bootSigningIdentity();
        expect(
          actualOptions.postExecution.runtime.getSigningIdentity(),
        ).toBe(updatedIdentity);

        const upstream = new Map();
        actualOptions.postExecution.runtime.publishUpstreamMergeRegistry(
          upstream,
        );
        expect(
          actualOptions.postExecution.runtime.getUpstreamMergeRegistry(),
        ).toBe(upstream);
        expect(
          actualOptions.postExecution.runtime.getActiveContactMergeScanMode(),
        ).toBe('delta');
        actualOptions.postExecution.runtime.setActiveContactMergeScanMode('full');
        expect(
          actualOptions.postExecution.runtime.getActiveContactMergeScanMode(),
        ).toBe('full');

        const vendorRefs = {
          apiConnectionLookup: vi.fn(),
          refreshApiConnectionAuth: vi.fn(),
          registerSalesforceCallEntity: vi.fn(),
        };
        actualOptions.postExecution.runtime.publishVendorRefs(vendorRefs);
        expect(
          actualOptions.postExecution.runtime.getApiConnectionLookup(),
        ).toBe(vendorRefs.apiConnectionLookup);
        // D-184 — publishVendorRefs wires the late-bound call-entity hook.
        expect(
          actualOptions.postExecution.runtime.getRegisterSalesforceCallEntity(),
        ).toBe(vendorRefs.registerSalesforceCallEntity);
        return postApp;
      },
    );

    const result = await startPostBaseStorageVaultRuntime(options);

    expect(order).toEqual([
      'storage',
      'cleanup-published',
      'vault-init',
      'late-bound',
      'app',
      'post-app',
    ]);
    expect(options.base.bootTrace.mark).toHaveBeenCalledWith(
      'shared-setup-complete',
    );
    expect(options.base.bootTrace.mark).toHaveBeenCalledWith('vault-init-start');
    expect(options.base.bootTrace.mark).toHaveBeenCalledWith(
      'vault-init-complete',
    );
    expect(options.base.bootTrace.mark).toHaveBeenCalledWith(
      'dispatch-subcommand',
      'serve',
    );
    publishedCleanup?.();
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      storage,
      postStorage: {
        lateBound,
        app,
        postApp,
      },
      getBaseVault: expect.any(Function),
      getSigningIdentity: expect.any(Function),
    });
    // Same stable container (see the post-app assertions above), contents synced.
    expect(result.getBaseVault()).toEqual(refreshedVault);
    expect(result.getSigningIdentity()).toBe(updatedIdentity);
  });

  it('defaults production singleton registries behind the post-base boundary', async () => {
    const producerMap = new Map([['default-producer', { tag: 'producer' }]]);
    singletonMocks.schedulerRegistry.producers.mockReturnValueOnce(producerMap);
    const storage = {
      db: { close: vi.fn() },
      manifests: { tag: 'manifests' },
      recipeStore: { tag: 'recipe-store' },
      eventBus: { tag: 'event-bus' },
      envLlmConfig: { tag: 'env-llm-config' },
      gateRegistry: { tag: 'gate-registry' },
      auditLog: { tag: 'audit-log' },
      serverInstanceId: 'server-1',
      pairedInstances: { tag: 'paired-instances' },
      workEntityStoreRef: { tag: 'work-entity-store' },
      accountStore: { tag: 'account-store' },
      checkpointStore: { tag: 'checkpoint-store' },
      commitStore: { tag: 'commit-store' },
      fileStack: { tag: 'file-stack' },
      baseVault: { token: 'secret' },
      initVault: vi.fn(async () => undefined),
      signingIdentity: { tag: 'signing-identity' },
      bootSigningIdentity: vi.fn(async () => undefined),
    };
    const app = {
      cacheBlobs: { tag: 'cache-blobs' },
      warehouseBus: { tag: 'warehouse-bus' },
      contactStoreRef: { tag: 'contact-store' },
      keys: { tag: 'keys' },
      connectionStoreRef: { tag: 'connection-store' },
      enrichmentCascadeRef: { tag: 'enrichment-cascade' },
      contactMergeCycleObserverRef: { tag: 'contact-observer' },
    };
    const options = makePostBaseOptions({
      backgroundServices: undefined,
      schedulerRegistry: undefined,
    });

    bridgeMocks.composeStorageContext.mockResolvedValue(storage);
    bridgeMocks.createExecutionLateBoundRefs.mockReturnValue({ tag: 'late-bound' });
    bridgeMocks.composeAppContext.mockReturnValue(app);
    bridgeMocks.startPostAppCollectionExecutionRuntime.mockResolvedValue({
      tag: 'post-app-result',
    });

    await startPostBaseStorageVaultRuntime(options);

    const actualOptions =
      bridgeMocks.startPostAppCollectionExecutionRuntime.mock.calls[0]![0];
    expect(actualOptions.postExecution.maintenance.backgroundServices).toBe(
      singletonMocks.backgroundServices,
    );
    expect(actualOptions.postExecution.runtime.lifecycle.backgroundServices).toBe(
      singletonMocks.backgroundServices,
    );
    expect(
      actualOptions.postExecution.runtime.preListener.backgroundServices,
    ).toBe(singletonMocks.backgroundServices);
    expect(actualOptions.postExecution.runtime.preListener.schedulerRegistry).toBe(
      singletonMocks.schedulerRegistry,
    );
    expect(
      actualOptions.postExecution.runtime.preListener.enrichmentProducers,
    ).toBe(producerMap);
    expect(singletonMocks.schedulerRegistry.producers).toHaveBeenCalledTimes(1);
  });
});

describe('startPostStorageAppCollectionExecutionRuntime', () => {
  it('orders late-bound refs, app context, and post-app runtime while threading app-owned refs', async () => {
    const order: string[] = [];
    const lateBound = { tag: 'late-bound' };
    const app = {
      cacheBlobs: { tag: 'cache-blobs' },
      warehouseBus: { tag: 'warehouse-bus' },
      contactStoreRef: { tag: 'contact-store' },
      keys: { tag: 'keys' },
      connectionStoreRef: { tag: 'connection-store' },
      enrichmentCascadeRef: { tag: 'enrichment-cascade' },
      contactMergeCycleObserverRef: { tag: 'contact-observer' },
    };
    const postApp = {
      collection: { tag: 'collection' },
      execution: { tag: 'execution' },
      postExecution: { tag: 'post-execution' },
    };
    const options = makeOptions();
    bridgeMocks.createExecutionLateBoundRefs.mockImplementation(() => {
      order.push('late-bound');
      return lateBound;
    });
    bridgeMocks.composeAppContext.mockImplementation((actualOptions) => {
      order.push('app');
      expect(actualOptions).toEqual({
        ...options.app,
        chatLateBound: lateBound,
      });
      return app;
    });
    bridgeMocks.startPostAppCollectionExecutionRuntime.mockImplementation(
      async (actualOptions) => {
        order.push('post-app');
        expect(actualOptions.collection).toEqual({
          ...options.collection,
          db: options.app.db,
          dbPath: options.app.dbPath,
          auditLog: options.app.auditLog,
          cacheBlobs: app.cacheBlobs,
          warehouseBus: app.warehouseBus,
          contactStore: app.contactStoreRef,
          gateRegistry: options.app.gateRegistry,
          eventBus: options.app.eventBus,
          keys: app.keys,
          connectionStore: app.connectionStoreRef,
          workEntityStore: options.app.workEntityStore,
          enrichmentCascade: app.enrichmentCascadeRef,
          // D-192 P4b — late-bound work-entity write executor.
          getWorkEntityWriteExecutor: expect.any(Function),
        });
        expect(actualOptions.execution).toEqual({
          ...options.execution,
          app,
          lateBound,
        });
        expect(actualOptions.postExecution.bootstrapCascade).toEqual({
          ...options.postApp.postExecution.bootstrapCascade,
          app,
        });
        expect(actualOptions.postExecution.maintenance).toEqual({
          ...options.postApp.postExecution.maintenance,
          app,
        });
        expect(actualOptions.postExecution.runtime.preListener).toEqual({
          ...options.postApp.postExecution.runtime.preListener,
          app,
        });
        expect(
          actualOptions.postExecution.runtime.getContactMergeCycleObserver(),
        ).toBe(app.contactMergeCycleObserverRef);
        expect(actualOptions.postExecution.runtime.publishVendorRefs).toBe(
          options.postApp.postExecution.runtime.publishVendorRefs,
        );
        return postApp;
      },
    );

    const result = await startPostStorageAppCollectionExecutionRuntime(options);

    expect(order).toEqual(['late-bound', 'app', 'post-app']);
    expect(result).toEqual({
      lateBound,
      app,
      postApp,
    });
  });
});

describe('start-post-storage-app-collection-execution-runtime source boundary', () => {
  it('keeps storage, app, and post-app runtime wiring in the post-base bridge', () => {
    const helperSource = readFileSync(helperPath, 'utf8');

    expect(helperSource).toMatch(/compose-storage-context\.js/);
    expect(helperSource).toMatch(/background-services-instance\.js/);
    expect(helperSource).toMatch(/housekeeping-scheduler-instance\.js/);
    expect(helperSource).toMatch(/options\.backgroundServices \?\? defaultBackgroundServices/);
    expect(helperSource).toMatch(/options\.schedulerRegistry \?\? defaultSchedulerRegistry/);
    expect(helperSource).toMatch(/startPostBaseStorageVaultRuntime/);
    expect(helperSource).toMatch(/reconcileServerBundleSwap\(base\.dbPath, /);
    expect(helperSource).toMatch(/createServerBundleStore\(base\.dbPath\)/);
    expect(helperSource).toMatch(/serverBundleStore\.load\(\)/);
    expect(helperSource).toMatch(/await composeStorageContext\(\{/);
    expect(helperSource).toMatch(/await startPostStorageAppCollectionExecutionRuntime\(\{/);
    expect(helperSource).toMatch(/compose-app-context\.js/);
    expect(helperSource).toMatch(/compose-execution-context\.js/);
    expect(helperSource).toMatch(
      /start-post-app-collection-execution-runtime\.js/,
    );
    expect(helperSource).toMatch(/createExecutionLateBoundRefs\(\)/);
    expect(helperSource).toMatch(/composeAppContext\(\{/);
    expect(helperSource).toMatch(/startPostAppCollectionExecutionRuntime\(\{/);
  });

  it('preserves storage, late-bound refs, app context, and post-app order', () => {
    const helperSource = readFileSync(helperPath, 'utf8');
    const postAppBridgeSource = readFileSync(postAppBridgePath, 'utf8');

    const storageIndex = helperSource.indexOf('await composeStorageContext({');
    const bundleRecoveryIndex = helperSource.indexOf(
      'reconcileServerBundleSwap(base.dbPath,',
    );
    const bundleSidecarIndex = helperSource.indexOf(
      'createServerBundleStore(base.dbPath)',
    );
    const bundleLoadIndex = helperSource.indexOf('serverBundleStore.load()');
    const vaultInitIndex = helperSource.indexOf(
      "base.bootTrace.mark('vault-init-start')",
    );
    const postStorageIndex = helperSource.indexOf(
      'await startPostStorageAppCollectionExecutionRuntime({',
    );
    const lateBoundIndex = helperSource.indexOf('createExecutionLateBoundRefs()');
    const appIndex = helperSource.indexOf('composeAppContext({');
    const postAppIndex = helperSource.indexOf(
      'await startPostAppCollectionExecutionRuntime({',
    );
    const collectionIndex = postAppBridgeSource.indexOf(
      'composeCollectionContext(options.collection)',
    );

    expect(bundleRecoveryIndex).toBeGreaterThanOrEqual(0);
    expect(bundleSidecarIndex).toBeGreaterThan(bundleRecoveryIndex);
    expect(bundleLoadIndex).toBeGreaterThan(bundleSidecarIndex);
    expect(storageIndex).toBeGreaterThan(bundleLoadIndex);
    expect(bundleSidecarIndex).toBeGreaterThanOrEqual(0);
    expect(storageIndex).toBeGreaterThan(bundleSidecarIndex);
    expect(storageIndex).toBeGreaterThanOrEqual(0);
    expect(vaultInitIndex).toBeGreaterThan(storageIndex);
    expect(postStorageIndex).toBeGreaterThan(storageIndex);
    expect(lateBoundIndex).toBeGreaterThanOrEqual(0);
    expect(appIndex).toBeGreaterThan(lateBoundIndex);
    expect(postAppIndex).toBeGreaterThan(appIndex);
    expect(collectionIndex).toBeGreaterThanOrEqual(0);
  });

  it('keeps signing, upstream, vendor, and scan-mode refs explicit', () => {
    const helperSource = readFileSync(helperPath, 'utf8');

    expect(helperSource).toMatch(/getSigningIdentity:\s*\(\) => signingIdentityRef/);
    expect(helperSource).toMatch(/getUpstreamMergeRegistry:\s*\(\) => upstreamMergeRegistryRef/);
    expect(helperSource).toMatch(/publishUpstreamMergeRegistry:\s*\(registry\) => \{/);
    expect(helperSource).toMatch(/publishVendorRefs:\s*\(vendorRefs\) => \{/);
    expect(helperSource).toMatch(
      /getActiveContactMergeScanMode:\s*\(\) => activeContactMergeScanMode/,
    );
    expect(helperSource).toMatch(
      /getContactMergeCycleObserver:\s*\(\) => app\.contactMergeCycleObserverRef/,
    );
    expect(stripSourceComments(helperSource)).not.toMatch(/composeListeners|composeServeExposure/);
    expect(stripSourceComments(helperSource)).not.toMatch(/startSchedulers|installShutdown/);
  });
});
