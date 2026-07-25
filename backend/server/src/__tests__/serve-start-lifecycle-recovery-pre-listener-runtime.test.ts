import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stripSourceComments } from './helpers/source-guards.js';

const bridgeMocks = vi.hoisted(() => ({
  composeServeLifecycle: vi.fn(),
  startBootRecoveryAndAdapters: vi.fn(),
  startPreListenerRuntime: vi.fn(),
}));

vi.mock('../serve/compose-lifecycle.js', () => ({
  composeServeLifecycle: bridgeMocks.composeServeLifecycle,
}));

vi.mock('../serve/start-boot-recovery-and-adapters.js', () => ({
  startBootRecoveryAndAdapters: bridgeMocks.startBootRecoveryAndAdapters,
}));

vi.mock('../serve/start-pre-listener-runtime.js', () => ({
  startPreListenerRuntime: bridgeMocks.startPreListenerRuntime,
}));

// `composeArchiveRpcDeps` eagerly builds the recovery-key store off the raw
// `db` handle (archive-runtime.ts, backup-M1 realm-ownership gate), which the
// tag-only stub here cannot serve. This suite asserts ORDERING and makes no
// archive assertions, so the seam is stubbed rather than the db widened —
// widening the stub is what let this couple in the first time.
vi.mock('../archive/archive-runtime.js', () => ({
  composeArchiveRpcDeps: vi.fn(() => ({ tag: 'archive-deps' })),
}));

import {
  startLifecycleRecoveryPreListenerRuntime,
  type StartLifecycleRecoveryPreListenerRuntimeOptions,
} from '../serve/start-lifecycle-recovery-pre-listener-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const bridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-lifecycle-recovery-pre-listener-runtime.ts',
);
const preListenerPath = join(
  repoRoot,
  'backend/server/src/serve/start-pre-listener-runtime.ts',
);
const postAppBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-app-collection-execution-runtime.ts',
);
const postExecutionBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-execution-bootstrap-maintenance-runtime.ts',
);

beforeEach(() => {
  bridgeMocks.composeServeLifecycle.mockReset();
  bridgeMocks.startBootRecoveryAndAdapters.mockReset();
  bridgeMocks.startPreListenerRuntime.mockReset();
});

const makeOptions = (
  overrides: Partial<StartLifecycleRecoveryPreListenerRuntimeOptions> = {},
): StartLifecycleRecoveryPreListenerRuntimeOptions =>
  ({
    lifecycle: {
      db: { tag: 'db' },
      bootstrapDeps: { tag: 'bootstrap-deps' },
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
      cascade: { tag: 'cascade' },
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
      runtimeConfig: {
        get: vi.fn((key: string) =>
          key === 'cloud.base_url' ? 'https://cloud.example' : undefined,
        ),
      },
      backgroundServices: { tag: 'background-services' },
      storage: { tag: 'storage' },
      app: { tag: 'app' },
      collection: { tag: 'collection' },
      execution: { tag: 'execution' },
      bootstrapDeps: { tag: 'bootstrap-deps' },
      scheduleDeps: { tag: 'schedule-deps' },
      migrateDeps: { tag: 'migrate-deps' },
      pressureDeps: { tag: 'pressure-deps' },
      schedulerRegistry: { tag: 'scheduler-registry' },
      executorConfig: { tag: 'executor-config' },
      scheduleStore: { tag: 'schedule-store' },
      executeDeps: { tag: 'execute-deps' },
      circuitStore: { tag: 'circuit-store' },
      enrichmentProducers: new Map(),
      env: { RECUED_MCP_HTTP_TOKEN: 'token' },
    },
    getSchedulersBundle: vi.fn(() => undefined),
    publishSchedulersBundle: vi.fn(),
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
    ...overrides,
  }) as unknown as StartLifecycleRecoveryPreListenerRuntimeOptions;

describe('startLifecycleRecoveryPreListenerRuntime', () => {
  it('orders lifecycle, locked recovery, and pre-listener runtime while keeping refs live', async () => {
    const order: string[] = [];
    const lifecycle = { tag: 'lifecycle' };
    const schedulerBundle = {
      autoRun: { getHandle: vi.fn(() => ({ tag: 'auto-run' })) },
    } as unknown as NonNullable<
      ReturnType<
        StartLifecycleRecoveryPreListenerRuntimeOptions['getSchedulersBundle']
      >
    >;
    const returnedSchedulers = { tag: 'returned-schedulers' };
    const updatedIdentity = { tag: 'identity-after-recovery' } as unknown as ReturnType<
      StartLifecycleRecoveryPreListenerRuntimeOptions['getSigningIdentity']
    >;
    let currentSchedulers:
      | ReturnType<
          StartLifecycleRecoveryPreListenerRuntimeOptions['getSchedulersBundle']
        >
      | undefined;
    let currentIdentity:
      | ReturnType<
          StartLifecycleRecoveryPreListenerRuntimeOptions['getSigningIdentity']
        >
      | undefined = { tag: 'identity-before-recovery' } as unknown as ReturnType<
      StartLifecycleRecoveryPreListenerRuntimeOptions['getSigningIdentity']
    >;
    let lifecycleOptions:
      | (StartLifecycleRecoveryPreListenerRuntimeOptions['lifecycle'] & {
          getHttpServer: () => unknown;
          getSchedulersBundle: () => unknown;
        })
      | undefined;
    const httpServer = { close: vi.fn(async () => undefined) };
    const exposureMachine = { tag: 'exposure-machine' };
    const wsHandle = { tag: 'ws-handle' };
    const vendorRefs = { tag: 'vendor-refs' };

    bridgeMocks.composeServeLifecycle.mockImplementation(async (options) => {
      order.push('lifecycle');
      lifecycleOptions = options;
      expect(options.getHttpServer()).toBeUndefined();
      expect(options.getSchedulersBundle()).toBeUndefined();
      return lifecycle;
    });
    bridgeMocks.startBootRecoveryAndAdapters.mockImplementation(async (options) => {
      order.push('recovery');
      expect(options.lifecycle).toBe(lifecycle);
      currentSchedulers = schedulerBundle;
      currentIdentity = updatedIdentity;
    });
    bridgeMocks.startPreListenerRuntime.mockImplementation(async (options) => {
      order.push('pre-listener');
      expect(options.lifecycle).toBe(lifecycle);
      expect(options.signingIdentity).toBe(updatedIdentity);
      expect(options.getAutoRunHandle()).toEqual({ tag: 'auto-run' });

      expect(options.getExposureMachine()).toBeUndefined();
      options.publishExposureMachine(exposureMachine);
      expect(options.getExposureMachine()).toBe(exposureMachine);

      expect(options.getWsHandleForLockout()).toBeUndefined();
      options.publishWsHandleForLockout(wsHandle);
      expect(options.getWsHandleForLockout()).toBe(wsHandle);

      expect(lifecycleOptions?.getHttpServer()).toBeUndefined();
      options.publishHttpServer(httpServer);
      expect(lifecycleOptions?.getHttpServer()).toBe(httpServer);

      options.publishVendorRefs(vendorRefs);
      options.setActiveContactMergeScanMode('full');
      return {
        actualPort: 4321,
        runtime: {
          schedulersBundle: returnedSchedulers,
          vendorRefs,
        },
      };
    });
    const options = makeOptions({
      getSchedulersBundle: vi.fn(() => currentSchedulers),
      getSigningIdentity: vi.fn(() => currentIdentity),
      publishSchedulersBundle: vi.fn(() => {
        order.push('publish-schedulers');
      }),
      publishVendorRefs: vi.fn(() => {
        order.push('publish-vendor');
      }),
      setActiveContactMergeScanMode: vi.fn(() => {
        order.push('scan-mode');
      }),
    });

    const result = await startLifecycleRecoveryPreListenerRuntime(options);

    expect(result.lifecycle).toBe(lifecycle);
    expect(result.listenerRuntime.runtime.schedulersBundle).toBe(returnedSchedulers);
    expect(order).toEqual([
      'lifecycle',
      'recovery',
      'pre-listener',
      'publish-vendor',
      'scan-mode',
      'publish-schedulers',
    ]);
    expect(bridgeMocks.composeServeLifecycle).toHaveBeenCalledWith({
      ...options.lifecycle,
      getHttpServer: expect.any(Function),
      getSchedulersBundle: options.getSchedulersBundle,
    });
    expect(bridgeMocks.startBootRecoveryAndAdapters).toHaveBeenCalledWith({
      ...options.recovery,
      lifecycle,
      // M5 S1 — the post-restart provenance hook's inputs.
      dbPath: options.lifecycle.base.dbPath,
      getSigningIdentity: options.getSigningIdentity,
    });
    expect(bridgeMocks.startPreListenerRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        ...options.preListener,
        lifecycle,
        signingIdentity: updatedIdentity,
        getUpstreamMergeRegistry: options.getUpstreamMergeRegistry,
        publishUpstreamMergeRegistry: options.publishUpstreamMergeRegistry,
        setActiveContactMergeScanMode: options.setActiveContactMergeScanMode,
        getApiConnectionLookup: options.getApiConnectionLookup,
        getRefreshAuth: options.getRefreshAuth,
        getRegisterSalesforceCallEntity: options.getRegisterSalesforceCallEntity,
        publishSchedulersBundle: options.publishSchedulersBundle,
        publishVendorRefs: options.publishVendorRefs,
        getActiveContactMergeScanMode: options.getActiveContactMergeScanMode,
        getContactMergeCycleObserver: options.getContactMergeCycleObserver,
        getSigningIdentity: options.getSigningIdentity,
        cascade: options.lifecycle.cascade,
      }),
    );
    expect(options.publishSchedulersBundle).toHaveBeenCalledWith(returnedSchedulers);
  });
});

describe('start-lifecycle-recovery-pre-listener-runtime source boundary', () => {
  it('keeps lifecycle/recovery/pre-listener orchestration behind the post-execution bridge', () => {
    const postAppBridgeSource = readFileSync(postAppBridgePath, 'utf8');
    const postExecutionBridgeSource = readFileSync(postExecutionBridgePath, 'utf8');
    const bridgeSource = readFileSync(bridgePath, 'utf8');

    expect(postAppBridgeSource).toMatch(
      /await startPostExecutionBootstrapMaintenanceRuntime\(\{/,
    );

    expect(postExecutionBridgeSource).toMatch(
      /start-lifecycle-recovery-pre-listener-runtime\.js/,
    );
    expect(postExecutionBridgeSource).toMatch(
      /await startLifecycleRecoveryPreListenerRuntime\(\{/,
    );
    expect(bridgeSource).toMatch(/compose-lifecycle\.js/);
    expect(bridgeSource).toMatch(/start-boot-recovery-and-adapters\.js/);
    expect(bridgeSource).toMatch(/start-pre-listener-runtime\.js/);
    expect(bridgeSource).toMatch(/await composeServeLifecycle\(\{/);
    expect(bridgeSource).toMatch(/await startBootRecoveryAndAdapters\(\{/);
    expect(bridgeSource).toMatch(/await startPreListenerRuntime\(\{/);
    expect(bridgeSource).toMatch(/getHttpServer:\s*\(\) => httpServerRef/);
    expect(bridgeSource).toMatch(/getSchedulersBundle:\s*options\.getSchedulersBundle/);
    expect(bridgeSource).toMatch(/signingIdentity:\s*options\.getSigningIdentity\(\)/);
    expect(bridgeSource).toMatch(/publishHttpServer:\s*\(serverRef\) => \{/);
  });

  it('preserves lifecycle, recovery, pre-listener, listener, and runtime order', () => {
    const postAppBridgeSource = readFileSync(postAppBridgePath, 'utf8');
    const postExecutionBridgeSource = readFileSync(postExecutionBridgePath, 'utf8');
    const bridgeSource = readFileSync(bridgePath, 'utf8');
    const preListenerSource = readFileSync(preListenerPath, 'utf8');

    const postExecutionBridgeIndex = postAppBridgeSource.indexOf(
      'await startPostExecutionBootstrapMaintenanceRuntime({',
    );
    const lifecycleRuntimeIndex = postExecutionBridgeSource.indexOf(
      'await startLifecycleRecoveryPreListenerRuntime({',
    );
    const lifecycleIndex = bridgeSource.indexOf('await composeServeLifecycle({');
    const recoveryIndex = bridgeSource.indexOf(
      'await startBootRecoveryAndAdapters({',
    );
    const preListenerIndex = bridgeSource.indexOf(
      'await startPreListenerRuntime({',
    );
    const listenerBridgeIndex = preListenerSource.indexOf(
      'return startListenerExposureRuntime({',
    );

    expect(postExecutionBridgeIndex).toBeGreaterThanOrEqual(0);
    expect(lifecycleRuntimeIndex).toBeGreaterThanOrEqual(0);
    expect(lifecycleIndex).toBeGreaterThanOrEqual(0);
    expect(recoveryIndex).toBeGreaterThan(lifecycleIndex);
    expect(preListenerIndex).toBeGreaterThan(recoveryIndex);
    expect(listenerBridgeIndex).toBeGreaterThanOrEqual(0);
  });

  it('keeps the helper focused on bridge orchestration', () => {
    const bridgeSource = readFileSync(bridgePath, 'utf8');

    expect(stripSourceComments(bridgeSource)).not.toMatch(/createLifecycle\(\{/);
    expect(stripSourceComments(bridgeSource)).not.toMatch(/recoverNotificationBlockAtBoot/);
    expect(stripSourceComments(bridgeSource)).not.toMatch(/composeIngressRpcContext/);
    expect(stripSourceComments(bridgeSource)).not.toMatch(/composeClientSecurityContext/);
    expect(stripSourceComments(bridgeSource)).not.toMatch(/composeRpcContext\(\{/);
    expect(stripSourceComments(bridgeSource)).not.toMatch(/composeListeners|createServerHandlerSet/);
    expect(stripSourceComments(bridgeSource)).not.toMatch(/composeServeExposure/);
    expect(stripSourceComments(bridgeSource)).not.toMatch(/startSchedulers|composeCertStackLate/);
    expect(stripSourceComments(bridgeSource)).not.toMatch(/startPostHousekeepingTail|installShutdown/);
  });
});
