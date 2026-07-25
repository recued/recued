import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stripSourceComments } from './helpers/source-guards.js';

const bridgeMocks = vi.hoisted(() => ({
  composeBootstrapCascadeContext: vi.fn(),
  composeMaintenanceContext: vi.fn(),
  startLifecycleRecoveryPreListenerRuntime: vi.fn(),
}));

vi.mock('../serve/compose-bootstrap-cascade-context.js', () => ({
  composeBootstrapCascadeContext: bridgeMocks.composeBootstrapCascadeContext,
}));

vi.mock('../serve/compose-maintenance-context.js', () => ({
  composeMaintenanceContext: bridgeMocks.composeMaintenanceContext,
}));

vi.mock('../serve/start-lifecycle-recovery-pre-listener-runtime.js', () => ({
  startLifecycleRecoveryPreListenerRuntime:
    bridgeMocks.startLifecycleRecoveryPreListenerRuntime,
}));

import {
  startPostExecutionBootstrapMaintenanceRuntime,
  type StartPostExecutionBootstrapMaintenanceRuntimeOptions,
} from '../serve/start-post-execution-bootstrap-maintenance-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const postStorageBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-storage-app-collection-execution-runtime.ts',
);
const postAppBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-app-collection-execution-runtime.ts',
);
const helperPath = join(
  repoRoot,
  'backend/server/src/serve/start-post-execution-bootstrap-maintenance-runtime.ts',
);
const bootstrapPath = join(
  repoRoot,
  'backend/server/src/serve/compose-bootstrap-cascade-context.ts',
);
const maintenancePath = join(
  repoRoot,
  'backend/server/src/serve/compose-maintenance-context.ts',
);
const lifecycleRecoveryBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-lifecycle-recovery-pre-listener-runtime.ts',
);

beforeEach(() => {
  bridgeMocks.composeBootstrapCascadeContext.mockReset();
  bridgeMocks.composeMaintenanceContext.mockReset();
  bridgeMocks.startLifecycleRecoveryPreListenerRuntime.mockReset();
});

const makeOptions = (
  overrides: Partial<StartPostExecutionBootstrapMaintenanceRuntimeOptions> = {},
): StartPostExecutionBootstrapMaintenanceRuntimeOptions =>
  ({
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
      collection: { tag: 'collection' },
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
        collection: { tag: 'collection' },
        backgroundServices: { tag: 'background-services' },
      },
      recovery: {
        bootSigningIdentity: vi.fn(async () => undefined),
        notificationBlock: { tag: 'notification-block' },
        checkpointStore: { tag: 'checkpoint-store' },
        auditLog: { tag: 'audit-log' },
        commitStore: { tag: 'commit-store' },
        fileStack: { tag: 'file-stack' },
        collection: { tag: 'collection' },
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
        collection: { tag: 'collection' },
        execution: { tag: 'execution' },
        schedulerRegistry: { tag: 'scheduler-registry' },
        executorConfig: { tag: 'executor-config' },
        executeDeps: { tag: 'execute-deps' },
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
    ...overrides,
  }) as unknown as StartPostExecutionBootstrapMaintenanceRuntimeOptions;

describe('startPostExecutionBootstrapMaintenanceRuntime', () => {
  it('orders bootstrap/cascade, maintenance, and runtime while keeping scheduler refs live', async () => {
    const order: string[] = [];
    const bootstrapCascade = {
      cascade: { tag: 'cascade' },
      bootstrapDeps: { tag: 'bootstrap-deps' },
      pressureDeps: { tag: 'pressure-deps' },
    };
    const publishScheduleDeps = vi.fn();
    const maintenance = {
      scheduleStore: { tag: 'schedule-store' },
      scheduleDeps: { tag: 'schedule-deps' },
      circuitStoreRef: { tag: 'circuit-store' },
      migrateDeps: { tag: 'migrate-deps' },
    };
    const firstSchedulers = { tag: 'first-schedulers' };
    const finalSchedulers = { tag: 'final-schedulers' };
    const runtimeResult = {
      lifecycle: { tag: 'lifecycle' },
      listenerRuntime: {
        actualPort: 4321,
        runtime: {
          schedulersBundle: finalSchedulers,
          vendorRefs: undefined,
        },
      },
    };
    let maintenanceGetSchedulers: (() => unknown) | undefined;

    bridgeMocks.composeBootstrapCascadeContext.mockImplementation(() => {
      order.push('bootstrap-cascade');
      return bootstrapCascade;
    });
    bridgeMocks.composeMaintenanceContext.mockImplementation((options) => {
      order.push('maintenance');
      maintenanceGetSchedulers = options.getSchedulersBundle;
      expect(options.getSchedulersBundle()).toBeUndefined();
      return maintenance;
    });
    bridgeMocks.startLifecycleRecoveryPreListenerRuntime.mockImplementation(
      async (options) => {
        order.push('runtime');
        expect(options.getSchedulersBundle()).toBeUndefined();
        options.publishSchedulersBundle(firstSchedulers);
        expect(options.getSchedulersBundle()).toBe(firstSchedulers);
        expect(maintenanceGetSchedulers?.()).toBe(firstSchedulers);
        options.publishSchedulersBundle(finalSchedulers);
        return runtimeResult;
      },
    );
    const options = makeOptions({ publishScheduleDeps });

    const result = await startPostExecutionBootstrapMaintenanceRuntime(options);

    expect(order).toEqual(['bootstrap-cascade', 'maintenance', 'runtime']);
    expect(publishScheduleDeps).toHaveBeenCalledWith(maintenance.scheduleDeps);
    expect(result).toEqual({
      bootstrapCascade,
      maintenance,
      runtime: runtimeResult,
      schedulersBundle: finalSchedulers,
    });
    expect(bridgeMocks.composeBootstrapCascadeContext).toHaveBeenCalledWith(
      options.bootstrapCascade,
    );
    expect(bridgeMocks.composeMaintenanceContext).toHaveBeenCalledWith({
      ...options.maintenance,
      getSchedulersBundle: expect.any(Function),
      // Reactive-substrate slice 1 + poll-manager / G6 — the late-bound
      // dispatcher + watch-manager getters ride alongside the
      // schedulers getter (the slice-1 pin update was missed at
      // landing; caught here when G6 widened the same call).
      getEventTriggerDispatcher: expect.any(Function),
      getWatchManager: expect.any(Function),
    });

    const runtimeOptions =
      bridgeMocks.startLifecycleRecoveryPreListenerRuntime.mock.calls[0]![0];
    expect(runtimeOptions.lifecycle).toEqual({
      ...options.runtime.lifecycle,
      bootstrapDeps: bootstrapCascade.bootstrapDeps,
      cascade: bootstrapCascade.cascade,
    });
    expect(runtimeOptions.preListener).toEqual({
      ...options.runtime.preListener,
      bootstrapDeps: bootstrapCascade.bootstrapDeps,
      scheduleDeps: maintenance.scheduleDeps,
      migrateDeps: maintenance.migrateDeps,
      pressureDeps: bootstrapCascade.pressureDeps,
      scheduleStore: maintenance.scheduleStore,
      circuitStore: maintenance.circuitStoreRef,
    });
    expect(runtimeOptions.recovery).toBe(options.runtime.recovery);
    expect(runtimeOptions.getSigningIdentity).toBe(
      options.runtime.getSigningIdentity,
    );
    expect(runtimeOptions.getUpstreamMergeRegistry).toBe(
      options.runtime.getUpstreamMergeRegistry,
    );
    expect(runtimeOptions.publishVendorRefs).toBe(options.runtime.publishVendorRefs);
    expect(runtimeOptions.setActiveContactMergeScanMode).toBe(
      options.runtime.setActiveContactMergeScanMode,
    );
  });
});

describe('start-post-execution-bootstrap-maintenance-runtime source boundary', () => {
  it('keeps the post-execution bridge behind the post-app bridge', () => {
    const postStorageBridgeSource = readFileSync(postStorageBridgePath, 'utf8');
    const postAppBridgeSource = readFileSync(postAppBridgePath, 'utf8');
    const helperSource = readFileSync(helperPath, 'utf8');

    expect(postStorageBridgeSource).toMatch(
      /start-post-app-collection-execution-runtime\.js/,
    );
    expect(postStorageBridgeSource).toMatch(
      /await startPostAppCollectionExecutionRuntime\(\{/,
    );
    expect(postAppBridgeSource).toMatch(
      /start-post-execution-bootstrap-maintenance-runtime\.js/,
    );
    expect(postAppBridgeSource).toMatch(
      /await startPostExecutionBootstrapMaintenanceRuntime\(\{/,
    );
    expect(helperSource).toMatch(/compose-bootstrap-cascade-context\.js/);
    expect(helperSource).toMatch(/compose-maintenance-context\.js/);
    expect(helperSource).toMatch(
      /start-lifecycle-recovery-pre-listener-runtime\.js/,
    );
    expect(helperSource).toMatch(/composeBootstrapCascadeContext/);
    expect(helperSource).toMatch(/composeMaintenanceContext/);
    expect(helperSource).toMatch(/startLifecycleRecoveryPreListenerRuntime/);
  });

  it('preserves execution, bootstrap/cascade, maintenance, lifecycle, recovery, and listener order', () => {
    const postStorageBridgeSource = readFileSync(postStorageBridgePath, 'utf8');
    const postAppBridgeSource = readFileSync(postAppBridgePath, 'utf8');
    const helperSource = readFileSync(helperPath, 'utf8');
    const lifecycleRecoveryBridgeSource = readFileSync(
      lifecycleRecoveryBridgePath,
      'utf8',
    );

    const postStorageBridgeIndex = postStorageBridgeSource.indexOf(
      'await startPostAppCollectionExecutionRuntime({',
    );
    const executionIndex = postAppBridgeSource.indexOf(
      'await composeExecutionContext({',
    );
    const postExecutionBridgeIndex = postAppBridgeSource.indexOf(
      'await startPostExecutionBootstrapMaintenanceRuntime({',
    );
    const bootstrapIndex = helperSource.indexOf(
      'composeBootstrapCascadeContext(options.bootstrapCascade)',
    );
    const schedulerBindingIndex = helperSource.indexOf(
      'let schedulersBundle',
    );
    const maintenanceIndex = helperSource.indexOf(
      'const maintenance = composeMaintenanceContext({',
    );
    const runtimeIndex = helperSource.indexOf(
      'await startLifecycleRecoveryPreListenerRuntime({',
    );
    const lifecycleIndex = lifecycleRecoveryBridgeSource.indexOf(
      'await composeServeLifecycle({',
    );
    const recoveryIndex = lifecycleRecoveryBridgeSource.indexOf(
      'await startBootRecoveryAndAdapters({',
    );
    const preListenerIndex = lifecycleRecoveryBridgeSource.indexOf(
      'await startPreListenerRuntime({',
    );

    expect(postStorageBridgeIndex).toBeGreaterThanOrEqual(0);
    expect(executionIndex).toBeGreaterThanOrEqual(0);
    expect(postExecutionBridgeIndex).toBeGreaterThan(executionIndex);
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(schedulerBindingIndex).toBeGreaterThan(bootstrapIndex);
    expect(maintenanceIndex).toBeGreaterThan(schedulerBindingIndex);
    expect(runtimeIndex).toBeGreaterThan(maintenanceIndex);
    expect(lifecycleIndex).toBeGreaterThanOrEqual(0);
    expect(recoveryIndex).toBeGreaterThan(lifecycleIndex);
    expect(preListenerIndex).toBeGreaterThan(recoveryIndex);
  });

  it('keeps the helper focused on bridge orchestration and live scheduler binding', () => {
    const helperSource = readFileSync(helperPath, 'utf8');

    expect(helperSource).toMatch(/getSchedulersBundle:\s*\(\) => schedulersBundle/);
    expect(helperSource).toMatch(/publishSchedulersBundle:\s*\(bundle\) => \{/);
    expect(helperSource).toMatch(/schedulersBundle = bundle/);
    expect(stripSourceComments(helperSource)).not.toMatch(/createEvictionCascade/);
    expect(stripSourceComments(helperSource)).not.toMatch(/createScheduleStore/);
    expect(stripSourceComments(helperSource)).not.toMatch(/createLifecycle|LockHeldError/);
    expect(stripSourceComments(helperSource)).not.toMatch(/recoverNotificationBlockAtBoot/);
    expect(stripSourceComments(helperSource)).not.toMatch(/composeIngressRpcContext/);
    expect(stripSourceComments(helperSource)).not.toMatch(/composeClientSecurityContext/);
    expect(stripSourceComments(helperSource)).not.toMatch(/composeRpcContext\(\{/);
    expect(stripSourceComments(helperSource)).not.toMatch(/composeListeners|createServerHandlerSet/);
    expect(stripSourceComments(helperSource)).not.toMatch(/composeServeExposure/);
    expect(stripSourceComments(helperSource)).not.toMatch(/startSchedulers|composeCertStackLate/);
    expect(stripSourceComments(helperSource)).not.toMatch(/startPostHousekeepingTail|installShutdown/);
  });

  it('leaves the existing focused helpers as owners of their internals', () => {
    const bootstrapSource = readFileSync(bootstrapPath, 'utf8');
    const maintenanceSource = readFileSync(maintenancePath, 'utf8');
    const lifecycleRecoveryBridgeSource = readFileSync(
      lifecycleRecoveryBridgePath,
      'utf8',
    );

    expect(bootstrapSource).toMatch(/createEvictionCascade/);
    expect(maintenanceSource).toMatch(/createScheduleStore/);
    expect(lifecycleRecoveryBridgeSource).toMatch(/composeServeLifecycle/);
    expect(lifecycleRecoveryBridgeSource).toMatch(/startBootRecoveryAndAdapters/);
    expect(lifecycleRecoveryBridgeSource).toMatch(/startPreListenerRuntime/);
  });
});
