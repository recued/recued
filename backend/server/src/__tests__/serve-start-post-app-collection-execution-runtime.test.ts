import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stripSourceComments } from './helpers/source-guards.js';

const bridgeMocks = vi.hoisted(() => ({
  composeCollectionContext: vi.fn(),
  composeExecutionContext: vi.fn(),
  startPostExecutionBootstrapMaintenanceRuntime: vi.fn(),
  attemptPeerAskDelivery: vi.fn(),
  recoverPeerAskDeliveries: vi.fn(),
  journalOwnsInterruptedPeerDispatch: vi.fn(),
  createPeerAnswerStore: vi.fn(),
}));

vi.mock('../serve/compose-collection-context.js', () => ({
  composeCollectionContext: bridgeMocks.composeCollectionContext,
}));

vi.mock('../serve/compose-execution-context.js', () => ({
  composeExecutionContext: bridgeMocks.composeExecutionContext,
}));

vi.mock('../serve/start-post-execution-bootstrap-maintenance-runtime.js', () => ({
  startPostExecutionBootstrapMaintenanceRuntime:
    bridgeMocks.startPostExecutionBootstrapMaintenanceRuntime,
}));

vi.mock('../execute-handler.js', () => ({
  attemptPeerAskDelivery: bridgeMocks.attemptPeerAskDelivery,
}));

vi.mock('../peer-ask-delivery-recovery.js', () => ({
  recoverPeerAskDeliveries: bridgeMocks.recoverPeerAskDeliveries,
  journalOwnsInterruptedPeerDispatch:
    bridgeMocks.journalOwnsInterruptedPeerDispatch,
}));

vi.mock('../storage/peer-answer-store.js', () => ({
  createPeerAnswerStore: bridgeMocks.createPeerAnswerStore,
}));

import {
  startPostAppCollectionExecutionRuntime,
  type StartPostAppCollectionExecutionRuntimeOptions,
} from '../serve/start-post-app-collection-execution-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const postStorageBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-storage-app-collection-execution-runtime.ts',
);
const helperPath = join(
  repoRoot,
  'backend/server/src/serve/start-post-app-collection-execution-runtime.ts',
);
const postExecutionBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-execution-bootstrap-maintenance-runtime.ts',
);

beforeEach(() => {
  bridgeMocks.composeCollectionContext.mockReset();
  bridgeMocks.composeExecutionContext.mockReset();
  bridgeMocks.startPostExecutionBootstrapMaintenanceRuntime.mockReset();
  bridgeMocks.attemptPeerAskDelivery.mockReset();
  bridgeMocks.recoverPeerAskDeliveries.mockReset();
  bridgeMocks.journalOwnsInterruptedPeerDispatch.mockReset();
  bridgeMocks.createPeerAnswerStore.mockReset();
});

const makeOptions = (
  overrides: Partial<StartPostAppCollectionExecutionRuntimeOptions> = {},
): StartPostAppCollectionExecutionRuntimeOptions =>
  ({
    collection: {
      db: { tag: 'db' },
      dbPath: '/tmp/recued.db',
      runtimeConfig: { tag: 'runtime-config' },
      manifests: { tag: 'manifests' },
      baseVault: { token: 'secret' },
      auditLog: { tag: 'audit-log' },
      cacheBlobs: { tag: 'cache-blobs' },
      warehouseBus: { tag: 'warehouse-bus' },
      contactStore: { tag: 'contact-store' },
      gateRegistry: { tag: 'gate-registry' },
      accountStore: { tag: 'account-store' },
      eventBus: { tag: 'event-bus' },
      keys: { tag: 'keys' },
      connectionStore: { tag: 'connection-store' },
      workEntityStore: { tag: 'work-entity-store' },
      enrichmentCascade: { tag: 'enrichment-cascade' },
    },
    execution: {
      storage: { tag: 'storage' },
      app: { tag: 'app' },
      baseVault: { token: 'secret' },
      lateBound: { tag: 'late-bound' },
      env: { RECUED_SERVER_NAME: 'test-server' },
    },
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
        app: { tag: 'app' },
      },
      maintenance: {
        dbPath: '/tmp/recued.db',
        storage: { tag: 'storage' },
        app: { tag: 'app' },
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
          app: { tag: 'app' },
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
        getContactMergeCycleObserver: vi.fn(() => undefined),
      },
    },
    ...overrides,
  }) as unknown as StartPostAppCollectionExecutionRuntimeOptions;

describe('startPostAppCollectionExecutionRuntime', () => {
  it('orders collection, execution, and post-execution runtime while threading live refs', async () => {
    const order: string[] = [];
    const collection = {
      collectionRegistry: { tag: 'collection-registry' },
      startCollectionAdapters: vi.fn(async () => undefined),
    };
    const execution = {
      executorConfig: { tag: 'executor-config' },
      executeDeps: { tag: 'execute-deps' },
      notificationBlock: { tag: 'notification-block' },
      serverDisplayName: 'test-server',
    };
    const postExecution = {
      runtime: { tag: 'runtime' },
      schedulersBundle: { tag: 'schedulers' },
    };
    const options = makeOptions();
    bridgeMocks.composeCollectionContext.mockImplementation((actualOptions) => {
      order.push('collection');
      expect(actualOptions).toBe(options.collection);
      return collection;
    });
    bridgeMocks.composeExecutionContext.mockImplementation(async (actualOptions) => {
      order.push('execution');
      expect(actualOptions.collection).toBe(collection);
      return execution;
    });
    bridgeMocks.startPostExecutionBootstrapMaintenanceRuntime.mockImplementation(
      async (actualOptions) => {
        order.push('post-execution');
        expect(actualOptions.bootstrapCascade.collection).toBe(collection);
        expect(actualOptions.runtime.lifecycle.collection).toBe(collection);
        expect(actualOptions.runtime.recovery.collection).toBe(collection);
        expect(actualOptions.runtime.recovery.notificationBlock).toBe(
          execution.notificationBlock,
        );
        expect(actualOptions.runtime.preListener.collection).toBe(collection);
        expect(actualOptions.runtime.preListener.execution).toBe(execution);
        expect(actualOptions.runtime.preListener.executorConfig).toBe(
          execution.executorConfig,
        );
        expect(actualOptions.runtime.preListener.executeDeps).toBe(
          execution.executeDeps,
        );
        expect(actualOptions.runtime.publishVendorRefs).toBe(
          options.postExecution.runtime.publishVendorRefs,
        );
        return postExecution;
      },
    );

    const result = await startPostAppCollectionExecutionRuntime(options);

    expect(order).toEqual(['collection', 'execution', 'post-execution']);
    expect(result).toEqual({
      collection,
      execution,
      postExecution,
    });
    expect(bridgeMocks.composeCollectionContext).toHaveBeenCalledWith(
      options.collection,
    );
    expect(bridgeMocks.composeExecutionContext).toHaveBeenCalledWith({
      ...options.execution,
      collection,
    });
  });

  it('composes exact peer-delivery boot recovery and dispatch preservation', async () => {
    const peerOutbox = { tag: 'peer-outbox' };
    const peerAuditLog = { tag: 'peer-audit-log' };
    const peerCheckpoints = { tag: 'peer-checkpoints' };
    const peerDb = { tag: 'peer-db' };
    const gatedActionStore = { tag: 'gated-actions' };
    const peerAnswers = { tag: 'peer-answers' };
    const executeDeps = {
      peerAskOutbox: peerOutbox,
      auditLog: peerAuditLog,
      checkpointStore: peerCheckpoints,
      db: peerDb,
      gatedActionStore,
    };
    const execution = {
      executorConfig: { tag: 'executor-config' },
      executeDeps,
      notificationBlock: { tag: 'notification-block' },
      serverDisplayName: 'test-server',
    };
    bridgeMocks.composeCollectionContext.mockReturnValue({
      collectionRegistry: { tag: 'collection-registry' },
      startCollectionAdapters: vi.fn(async () => undefined),
    });
    bridgeMocks.composeExecutionContext.mockResolvedValue(execution);
    bridgeMocks.createPeerAnswerStore.mockReturnValue(peerAnswers);
    bridgeMocks.recoverPeerAskDeliveries.mockResolvedValue(undefined);
    bridgeMocks.journalOwnsInterruptedPeerDispatch.mockResolvedValue(true);
    bridgeMocks.startPostExecutionBootstrapMaintenanceRuntime.mockImplementation(
      async (actualOptions) => {
        const recovery = actualOptions.runtime.recovery;
        expect(recovery.recoverPeerDeliveries).toEqual(expect.any(Function));
        expect(recovery.preserveInterruptedDispatch).toEqual(expect.any(Function));

        await recovery.recoverPeerDeliveries();
        expect(bridgeMocks.createPeerAnswerStore).toHaveBeenCalledWith(peerDb);
        expect(bridgeMocks.recoverPeerAskDeliveries).toHaveBeenCalledWith({
          outbox: peerOutbox,
          auditLog: peerAuditLog,
          checkpoints: peerCheckpoints,
          answers: peerAnswers,
          gatedActions: gatedActionStore,
          deliver: expect.any(Function),
          retireUnanchoredStaged: true,
        });

        const record = { action_ref: 'action-1' };
        await expect(recovery.preserveInterruptedDispatch(record)).resolves.toBe(true);
        expect(bridgeMocks.journalOwnsInterruptedPeerDispatch).toHaveBeenCalledWith(
          record,
          {
            outbox: peerOutbox,
            auditLog: peerAuditLog,
            checkpoints: peerCheckpoints,
          },
        );
        return { runtime: { tag: 'runtime' }, schedulersBundle: { tag: 'schedulers' } };
      },
    );

    await startPostAppCollectionExecutionRuntime(makeOptions());

    const recoverCall = bridgeMocks.recoverPeerAskDeliveries.mock.calls[0]?.[0];
    const row = { exchange_ref: 'exchange-1' };
    const anchor = { run_id: 'run-1' };
    await recoverCall.deliver(row, anchor);
    expect(bridgeMocks.attemptPeerAskDelivery).toHaveBeenCalledWith(
      executeDeps,
      row,
      anchor,
    );
  });
});

describe('start-post-app-collection-execution-runtime source boundary', () => {
  it('keeps collection, execution, and post-execution runtime behind the post-storage bridge', () => {
    const postStorageBridgeSource = readFileSync(postStorageBridgePath, 'utf8');
    const helperSource = readFileSync(helperPath, 'utf8');

    expect(postStorageBridgeSource).toMatch(
      /start-post-app-collection-execution-runtime\.js/,
    );
    expect(postStorageBridgeSource).toMatch(
      /await startPostAppCollectionExecutionRuntime\(\{/,
    );
    expect(helperSource).toMatch(/compose-collection-context\.js/);
    expect(helperSource).toMatch(/compose-execution-context\.js/);
    expect(helperSource).toMatch(
      /start-post-execution-bootstrap-maintenance-runtime\.js/,
    );
    expect(helperSource).toMatch(/composeCollectionContext\(options\.collection\)/);
    expect(helperSource).toMatch(/await composeExecutionContext\(\{/);
    expect(helperSource).toMatch(
      /await startPostExecutionBootstrapMaintenanceRuntime\(\{/,
    );
  });

  it('preserves app, collection, execution, and downstream runtime order', () => {
    const postStorageBridgeSource = readFileSync(postStorageBridgePath, 'utf8');
    const helperSource = readFileSync(helperPath, 'utf8');
    const postExecutionBridgeSource = readFileSync(postExecutionBridgePath, 'utf8');

    const appIndex = postStorageBridgeSource.indexOf('composeAppContext({');
    const postAppBridgeIndex = postStorageBridgeSource.indexOf(
      'await startPostAppCollectionExecutionRuntime({',
    );
    const collectionIndex = helperSource.indexOf(
      'const collection = composeCollectionContext(options.collection);',
    );
    const executionIndex = helperSource.indexOf(
      'const execution = await composeExecutionContext({',
    );
    const postExecutionIndex = helperSource.indexOf(
      'const postExecution = await startPostExecutionBootstrapMaintenanceRuntime({',
    );
    const bootstrapIndex = postExecutionBridgeSource.indexOf(
      'composeBootstrapCascadeContext(options.bootstrapCascade)',
    );

    expect(appIndex).toBeGreaterThanOrEqual(0);
    expect(postAppBridgeIndex).toBeGreaterThan(appIndex);
    expect(collectionIndex).toBeGreaterThanOrEqual(0);
    expect(executionIndex).toBeGreaterThan(collectionIndex);
    expect(postExecutionIndex).toBeGreaterThan(executionIndex);
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
  });

  it('keeps live upstream, vendor, and scan-mode refs explicit', () => {
    const postStorageBridgeSource = readFileSync(postStorageBridgePath, 'utf8');
    const helperSource = readFileSync(helperPath, 'utf8');

    expect(postStorageBridgeSource).toMatch(
      /getRegisterSalesforceCallEntity:\s*\(\) => registerSalesforceCallEntityRef/,
    );
    expect(postStorageBridgeSource).toMatch(/getUpstreamMergeRegistry:\s*\(\) => upstreamMergeRegistryRef/);
    expect(postStorageBridgeSource).toMatch(/publishUpstreamMergeRegistry:\s*\(registry\) => \{/);
    expect(postStorageBridgeSource).toMatch(/publishVendorRefs:\s*\(vendorRefs\) => \{/);
    expect(postStorageBridgeSource).toMatch(
      /getActiveContactMergeScanMode:\s*\(\) => activeContactMergeScanMode/,
    );
    expect(stripSourceComments(helperSource)).not.toMatch(/composeListeners|composeServeExposure/);
    expect(stripSourceComments(helperSource)).not.toMatch(/startSchedulers|installShutdown/);
  });
});
