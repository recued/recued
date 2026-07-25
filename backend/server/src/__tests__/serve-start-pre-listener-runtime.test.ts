import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stripSourceComments } from './helpers/source-guards.js';

const preListenerMocks = vi.hoisted(() => ({
  composeIngressRpcContext: vi.fn(),
  composeClientSecurityContext: vi.fn(),
  composeRpcContext: vi.fn(),
  startListenerExposureRuntime: vi.fn(),
}));

vi.mock('../serve/compose-ingress-rpc-context.js', () => ({
  composeIngressRpcContext: preListenerMocks.composeIngressRpcContext,
}));

vi.mock('../serve/compose-client-security-context.js', () => ({
  composeClientSecurityContext: preListenerMocks.composeClientSecurityContext,
}));

vi.mock('../serve/compose-rpc-context.js', () => ({
  composeRpcContext: preListenerMocks.composeRpcContext,
}));

vi.mock('../serve/start-listener-exposure-runtime.js', () => ({
  startListenerExposureRuntime: preListenerMocks.startListenerExposureRuntime,
}));

import {
  startPreListenerRuntime,
  type StartPreListenerRuntimeOptions,
} from '../serve/start-pre-listener-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const helperPath = join(
  repoRoot,
  'backend/server/src/serve/start-pre-listener-runtime.ts',
);
const lifecycleRecoveryBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-lifecycle-recovery-pre-listener-runtime.ts',
);
const postExecutionBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-execution-bootstrap-maintenance-runtime.ts',
);
const listenerBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-listener-exposure-runtime.ts',
);

beforeEach(() => {
  preListenerMocks.composeIngressRpcContext.mockReset();
  preListenerMocks.composeClientSecurityContext.mockReset();
  preListenerMocks.composeRpcContext.mockReset();
  preListenerMocks.startListenerExposureRuntime.mockReset();
});

const makeOptions = (
  overrides: Partial<StartPreListenerRuntimeOptions> = {},
): StartPreListenerRuntimeOptions =>
  ({
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
    storage: {
      db: { tag: 'db' },
      auditLog: { tag: 'audit-log' },
      eventBus: { tag: 'event-bus' },
      pairedInstances: { tag: 'paired-instances' },
    },
    app: { tag: 'app' },
    collection: { tag: 'collection' },
    execution: { executeDeps: { tag: 'execute-deps' } },
    bootstrapDeps: { tag: 'bootstrap-deps' },
    scheduleDeps: { tag: 'schedule-deps' },
    migrateDeps: { tag: 'migrate-deps' },
    pressureDeps: { tag: 'pressure-deps' },
    lifecycle: { tag: 'lifecycle' },
    signingIdentity: { tag: 'signing-identity' },
    schedulerRegistry: { tag: 'scheduler-registry' },
    getExposureMachine: vi.fn(() => ({ tag: 'exposure-machine' })),
    publishExposureMachine: vi.fn(),
    getWsHandleForLockout: vi.fn(() => ({ tag: 'ws-handle' })),
    publishWsHandleForLockout: vi.fn(),
    publishHttpServer: vi.fn(),
    getUpstreamMergeRegistry: vi.fn(() => ({ tag: 'existing-upstream' })),
    publishUpstreamMergeRegistry: vi.fn(),
    setActiveContactMergeScanMode: vi.fn(),
    getApiConnectionLookup: vi.fn(() => undefined),
    getRefreshAuth: vi.fn(() => undefined),
    getRegisterSalesforceCallEntity: vi.fn(() => undefined),
    executorConfig: { tag: 'executor-config' },
    scheduleStore: { tag: 'schedule-store' },
    executeDeps: { tag: 'execute-deps' },
    circuitStore: { tag: 'circuit-store' },
    getAutoRunHandle: vi.fn(() => undefined),
    publishSchedulersBundle: vi.fn(),
    publishVendorRefs: vi.fn(),
    getActiveContactMergeScanMode: vi.fn(() => 'delta'),
    getContactMergeCycleObserver: vi.fn(() => undefined),
    enrichmentProducers: new Map(),
    getSigningIdentity: vi.fn(() => undefined),
    cascade: { tag: 'cascade' },
    env: { RECUED_MCP_HTTP_TOKEN: 'token' },
    ...overrides,
  }) as unknown as StartPreListenerRuntimeOptions;

describe('startPreListenerRuntime', () => {
  it('orders ingress, client security, generic RPC, upstream publication, and listener bridge startup', async () => {
    const order: string[] = [];
    const ingress = {
      exposureRpcDeps: { tag: 'exposure-rpc-deps' },
      tlsDomainStore: { tag: 'tls-domain-store' },
      tlsDomainRpcDeps: { tag: 'tls-domain-rpc-deps' },
      receptionRpcDeps: { tag: 'reception-rpc-deps' },
      receptionPortDeps: { tag: 'reception-port-deps' },
      mcpHttpDeps: { tag: 'mcp-http-deps' },
    };
    const clientSecurity = {
      clientTokens: { tag: 'client-tokens' },
      tokenRotationEmitter: { tag: 'token-rotation-emitter' },
      certStack: { tag: 'cert-stack' },
      rotationEngine: { tag: 'rotation-engine' },
      proAuthStateMachineRef: { tag: 'pro-auth-machine' },
      passportFetchDeps: { tag: 'passport-fetch-deps' },
    };
    const rpc = {
      housekeepingRpcDeps: { tag: 'housekeeping-rpc-deps' },
      upstreamMergeDeps: { tag: 'upstream-merge-deps' },
      upstreamMergeRegistry: { tag: 'new-upstream-registry' },
      contactMergeDeps: { tag: 'contact-merge-deps' },
      engagementHealthDeps: { tag: 'engagement-health-deps' },
      observabilityBundle: { tag: 'observability-bundle' },
    };
    const result = {
      actualPort: 4321,
      runtime: {
        schedulersBundle: { tag: 'schedulers-bundle' },
        vendorRefs: undefined,
      },
    };
    preListenerMocks.composeIngressRpcContext.mockImplementation(async () => {
      order.push('ingress');
      return ingress;
    });
    preListenerMocks.composeClientSecurityContext.mockImplementation(async () => {
      order.push('security');
      return clientSecurity;
    });
    preListenerMocks.composeRpcContext.mockImplementation(() => {
      order.push('rpc');
      return rpc;
    });
    preListenerMocks.startListenerExposureRuntime.mockImplementation(async () => {
      order.push('listener');
      return result;
    });
    const options = makeOptions({
      publishUpstreamMergeRegistry: vi.fn(() => {
        order.push('publish-upstream');
      }),
    });

    const actual = await startPreListenerRuntime(options);

    expect(actual).toBe(result);
    expect(order).toEqual([
      'ingress',
      'security',
      'rpc',
      'publish-upstream',
      'listener',
    ]);
    expect(options.runtimeConfig.get).toHaveBeenCalledWith('cloud.base_url');
    expect(preListenerMocks.composeIngressRpcContext).toHaveBeenCalledWith({
      dbPath: options.dbPath,
      storage: options.storage,
      app: options.app,
      // D-172 P3 — the file collection + registry threaded for the drop_link drain.
      collection: options.collection,
      execution: options.execution,
      backgroundServices: options.backgroundServices,
      getExposureMachine: options.getExposureMachine,
      getWsHandleForLockout: options.getWsHandleForLockout,
      env: options.env,
      // R26.2 Delta 2 — apex get/set on the exposure rpc deps.
      runtimeConfig: options.runtimeConfig,
    });
    expect(preListenerMocks.composeClientSecurityContext).toHaveBeenCalledWith({
      db: options.storage.db,
      auditLog: options.storage.auditLog,
      signingIdentity: options.signingIdentity,
      eventBus: options.storage.eventBus,
      cloudBaseUrl: 'https://cloud.example',
      pairedInstances: options.storage.pairedInstances,
      getWsHandleForLockout: options.getWsHandleForLockout,
      getExposureMachine: options.getExposureMachine,
      env: options.env,
    });
    expect(preListenerMocks.composeRpcContext).toHaveBeenCalledWith({
      storage: options.storage,
      app: options.app,
      // D-163 Slice C — `composeRpcContext` reads
      // `execution.notificationBlock` to build the
      // `notifications.*` rpc bundle. The pre-listener forwards the
      // ExecutionContext slice it already holds.
      execution: options.execution,
      schedulerRegistry: options.schedulerRegistry,
      upstreamMergeRegistry: { tag: 'existing-upstream' },
      setActiveContactMergeScanMode: options.setActiveContactMergeScanMode,
      getApiConnectionLookup: options.getApiConnectionLookup,
      getRefreshAuth: options.getRefreshAuth,
      getRegisterSalesforceCallEntity: options.getRegisterSalesforceCallEntity,
      circuitStore: options.circuitStore,
      getAutoRunHandle: options.getAutoRunHandle,
    });
    expect(options.publishUpstreamMergeRegistry).toHaveBeenCalledWith(
      rpc.upstreamMergeRegistry,
    );
    expect(preListenerMocks.startListenerExposureRuntime).toHaveBeenCalledWith({
      listener: expect.objectContaining({
        port: options.port,
        webhookPort: options.webhookPort,
        rpc,
        clientTokens: clientSecurity.clientTokens,
        exposureDeps: ingress.exposureRpcDeps,
        tlsDomainDeps: ingress.tlsDomainRpcDeps,
        tokenRotationEmitter: clientSecurity.tokenRotationEmitter,
        rotationEngine: clientSecurity.rotationEngine,
        passportFetchDeps: clientSecurity.passportFetchDeps,
        proAuthMachine: clientSecurity.proAuthStateMachineRef,
        receptionRpcDeps: ingress.receptionRpcDeps,
        receptionPortDeps: ingress.receptionPortDeps,
        mcpHttpDeps: ingress.mcpHttpDeps,
      }),
      exposure: expect.objectContaining({
        args: options.args,
        db: options.storage.db,
        auditLog: options.storage.auditLog,
        webhookPort: options.webhookPort,
        publishExposureMachine: options.publishExposureMachine,
      }),
      runtime: expect.objectContaining({
        dbPath: options.dbPath,
        executorConfig: options.executorConfig,
        certStack: clientSecurity.certStack,
        tlsDomainStore: ingress.tlsDomainStore,
        upstreamMergeRegistry: rpc.upstreamMergeRegistry,
        rotationEngine: clientSecurity.rotationEngine,
        cloudBaseUrl: 'https://cloud.example',
      }),
      publishWsHandleForLockout: options.publishWsHandleForLockout,
      publishHttpServer: options.publishHttpServer,
    });
  });

  it('does not publish an upstream registry when RPC composition returns none', async () => {
    preListenerMocks.composeIngressRpcContext.mockResolvedValue({
      exposureRpcDeps: undefined,
      tlsDomainStore: undefined,
      tlsDomainRpcDeps: undefined,
      receptionRpcDeps: undefined,
      receptionPortDeps: undefined,
      mcpHttpDeps: undefined,
    });
    preListenerMocks.composeClientSecurityContext.mockResolvedValue({
      clientTokens: undefined,
      tokenRotationEmitter: undefined,
      certStack: { tag: 'cert-stack' },
      rotationEngine: undefined,
      proAuthStateMachineRef: undefined,
      passportFetchDeps: undefined,
    });
    preListenerMocks.composeRpcContext.mockReturnValue({
      housekeepingRpcDeps: undefined,
      upstreamMergeDeps: undefined,
      upstreamMergeRegistry: undefined,
      contactMergeDeps: undefined,
      engagementHealthDeps: undefined,
      observabilityBundle: { tag: 'observability-bundle' },
    });
    preListenerMocks.startListenerExposureRuntime.mockResolvedValue({
      runtime: { schedulersBundle: { tag: 'schedulers-bundle' } },
    });
    const options = makeOptions();

    await startPreListenerRuntime(options);

    expect(options.publishUpstreamMergeRegistry).not.toHaveBeenCalled();
    expect(
      preListenerMocks.startListenerExposureRuntime.mock.calls[0]![0].runtime
        .upstreamMergeRegistry,
    ).toEqual({ tag: 'existing-upstream' });
  });
});

describe('start-pre-listener-runtime source boundary', () => {
  it('keeps pre-listener orchestration behind the lifecycle bridge', () => {
    const lifecycleRecoveryBridgeSource = readFileSync(
      lifecycleRecoveryBridgePath,
      'utf8',
    );
    const postExecutionBridgeSource = readFileSync(
      postExecutionBridgePath,
      'utf8',
    );
    const helperSource = readFileSync(helperPath, 'utf8');

    expect(postExecutionBridgeSource).toMatch(
      /await startLifecycleRecoveryPreListenerRuntime\(\{/,
    );
    expect(lifecycleRecoveryBridgeSource).toMatch(
      /await startPreListenerRuntime\(\{/,
    );
    expect(lifecycleRecoveryBridgeSource).toMatch(
      /getExposureMachine:\s*\(\) => exposureMachineRef/,
    );

    expect(helperSource).toMatch(/await composeIngressRpcContext\(\{/);
    expect(helperSource).toMatch(/runtimeConfig\.get\('cloud\.base_url'\)/);
    expect(helperSource).toMatch(/await composeClientSecurityContext\(\{/);
    expect(helperSource).toMatch(/composeRpcContext\(\{/);
    expect(helperSource).toMatch(/publishUpstreamMergeRegistry/);
    expect(helperSource).toMatch(/startListenerExposureRuntime\(\{/);
  });

  it('preserves pre-listener and listener bridge order', () => {
    const helperSource = readFileSync(helperPath, 'utf8');
    const listenerBridgeSource = readFileSync(listenerBridgePath, 'utf8');

    const ingressIndex = helperSource.indexOf('await composeIngressRpcContext({');
    const cloudBaseUrlIndex = helperSource.indexOf(
      "options.runtimeConfig.get('cloud.base_url')",
    );
    const securityIndex = helperSource.indexOf(
      'await composeClientSecurityContext({',
    );
    const rpcIndex = helperSource.indexOf('composeRpcContext({');
    const publishUpstreamIndex = helperSource.indexOf(
      'options.publishUpstreamMergeRegistry(',
    );
    const listenerBridgeIndex = helperSource.indexOf(
      'return startListenerExposureRuntime({',
    );
    const listenerIndex = listenerBridgeSource.indexOf('await composeListeners({');
    const exposureIndex = listenerBridgeSource.indexOf('await composeServeExposure({');
    const runtimeIndex = listenerBridgeSource.indexOf(
      'await startPostListenerRuntime({',
    );

    expect(ingressIndex).toBeGreaterThanOrEqual(0);
    expect(cloudBaseUrlIndex).toBeGreaterThan(ingressIndex);
    expect(securityIndex).toBeGreaterThan(cloudBaseUrlIndex);
    expect(rpcIndex).toBeGreaterThan(securityIndex);
    expect(publishUpstreamIndex).toBeGreaterThan(rpcIndex);
    expect(listenerBridgeIndex).toBeGreaterThan(publishUpstreamIndex);
    expect(listenerIndex).toBeGreaterThanOrEqual(0);
    expect(exposureIndex).toBeGreaterThan(listenerIndex);
    expect(runtimeIndex).toBeGreaterThan(exposureIndex);
  });

  it('keeps the helper out of lifecycle, boot recovery, schedulers, and shutdown internals', () => {
    const source = readFileSync(helperPath, 'utf8');

    expect(source).toMatch(/composeIngressRpcContext/);
    expect(source).toMatch(/composeClientSecurityContext/);
    expect(source).toMatch(/composeRpcContext/);
    expect(source).toMatch(/startListenerExposureRuntime/);
    expect(stripSourceComments(source)).not.toMatch(/composeServeLifecycle|createLifecycle|LockHeldError/);
    expect(stripSourceComments(source)).not.toMatch(/startBootRecoveryAndAdapters|bootSigningIdentity/);
    expect(stripSourceComments(source)).not.toMatch(/startSchedulers|composeCertStackLate/);
    expect(stripSourceComments(source)).not.toMatch(/startPostHousekeepingTail|installShutdown/);
  });
});
