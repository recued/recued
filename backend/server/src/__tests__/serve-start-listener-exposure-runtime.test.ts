import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => ({
  composeListeners: vi.fn(),
  composeServeExposure: vi.fn(),
  startPostListenerRuntime: vi.fn(),
}));

vi.mock('../serve/compose-listeners.js', () => ({
  composeListeners: bridgeMocks.composeListeners,
}));

vi.mock('../serve/compose-exposure.js', () => ({
  composeServeExposure: bridgeMocks.composeServeExposure,
}));

vi.mock('../serve/start-post-listener-runtime.js', () => ({
  startPostListenerRuntime: bridgeMocks.startPostListenerRuntime,
}));

import {
  startListenerExposureRuntime,
  type StartListenerExposureRuntimeOptions,
} from '../serve/start-listener-exposure-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const preListenerPath = join(
  repoRoot,
  'backend/server/src/serve/start-pre-listener-runtime.ts',
);
const lifecycleRecoveryBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-lifecycle-recovery-pre-listener-runtime.ts',
);
const bridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-listener-exposure-runtime.ts',
);
const runtimePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-listener-runtime.ts',
);

beforeEach(() => {
  bridgeMocks.composeListeners.mockReset();
  bridgeMocks.composeServeExposure.mockReset();
  bridgeMocks.startPostListenerRuntime.mockReset();
});

const makeOptions = (
  overrides: Partial<StartListenerExposureRuntimeOptions> = {},
): StartListenerExposureRuntimeOptions =>
  ({
    listener: { tag: 'listener-options' },
    exposure: {
      args: ['--reset-exposure'],
      db: { tag: 'db' },
      auditLog: { tag: 'audit-log' },
      webhookPort: 9876,
      publishExposureMachine: vi.fn(),
    },
    runtime: {
      dbPath: '/tmp/recued.db',
      runtimeConfig: { tag: 'runtime-config' },
      backgroundServices: { tag: 'background-services' },
      storage: { tag: 'storage' },
      app: { tag: 'app' },
      collection: { tag: 'collection' },
      executorConfig: { tag: 'executor-config' },
      scheduleStore: { tag: 'schedule-store' },
      executeDeps: { tag: 'execute-deps' },
      circuitStore: { tag: 'circuit-store' },
      certStack: { tag: 'cert-stack' },
      tlsDomainStore: { tag: 'tls-domain-store' },
      upstreamMergeRegistry: { tag: 'upstream-merge-registry' },
      publishSchedulersBundle: vi.fn(),
      publishVendorRefs: vi.fn(),
      rotationEngine: { tag: 'rotation-engine' },
      getActiveContactMergeScanMode: vi.fn(() => 'delta'),
      getContactMergeCycleObserver: vi.fn(() => undefined),
      enrichmentProducers: new Map(),
      cloudBaseUrl: 'https://cloud.example',
      getSigningIdentity: vi.fn(() => undefined),
      lifecycle: { tag: 'lifecycle' },
      cascade: { tag: 'cascade' },
    },
    publishWsHandleForLockout: vi.fn(),
    publishHttpServer: vi.fn(),
    ...overrides,
  }) as unknown as StartListenerExposureRuntimeOptions;

describe('startListenerExposureRuntime', () => {
  it('orders listener composition, WS publication, exposure, HTTP publication, and runtime startup', async () => {
    const order: string[] = [];
    const wsHandle = { clientCount: vi.fn(() => 5) };
    const server = {
      wsServer: wsHandle,
      port: 4711,
      close: vi.fn(async () => undefined),
    };
    const listeners = {
      serverHandlerSet: { wsHandle },
      listenerCoordinator: { tag: 'listener-coordinator' },
      // DISTINCT values on purpose: the exposure machine must receive what the
      // listener binds, the post-listener runtime what the server is reachable
      // at (its cert stack publishes `wss://<addr>/ws` pairing hints, and
      // `0.0.0.0` is not somewhere a peer dials). Equal values here would let a
      // swapped wiring pass.
      lanBindAddress: '0.0.0.0',
      lanAdvertisedAddress: '192.168.1.44',
      server,
    };
    const runtime = {
      schedulersBundle: { tag: 'schedulers-bundle' },
      vendorRefs: { tag: 'vendor-refs' },
    };
    bridgeMocks.composeListeners.mockImplementation(async () => {
      order.push('listeners');
      return listeners;
    });
    bridgeMocks.composeServeExposure.mockImplementation(async (options) => {
      order.push('exposure');
      expect(options.wsHandleClientCount()).toBe(5);
      return { tag: 'exposure-machine' };
    });
    bridgeMocks.startPostListenerRuntime.mockImplementation(async (options) => {
      order.push('runtime');
      expect(options.server).toBe(server);
      expect(options.lanAdvertisedAddress).toBe('192.168.1.44');
      expect(options.actualPort).toBe(4711);
      return runtime;
    });
    let httpRef: { close(): Promise<void> } | undefined;
    const options = makeOptions({
      publishWsHandleForLockout: vi.fn((handle) => {
        order.push('publish-ws');
        expect(handle).toBe(wsHandle);
      }),
      publishHttpServer: vi.fn((serverRef) => {
        order.push('publish-http');
        httpRef = serverRef;
      }),
    });

    const result = await startListenerExposureRuntime(options);

    expect(result).toEqual({
      ...listeners,
      actualPort: 4711,
      runtime,
    });
    expect(order).toEqual([
      'listeners',
      'publish-ws',
      'exposure',
      'publish-http',
      'runtime',
    ]);
    expect(bridgeMocks.composeListeners).toHaveBeenCalledWith(options.listener);
    expect(bridgeMocks.composeServeExposure).toHaveBeenCalledWith({
      ...options.exposure,
      listenerCoordinator: listeners.listenerCoordinator,
      lanBindAddress: '0.0.0.0',
      wsHandleClientCount: expect.any(Function),
    });
    expect(bridgeMocks.startPostListenerRuntime).toHaveBeenCalledWith({
      ...options.runtime,
      server,
      lanAdvertisedAddress: '192.168.1.44',
      actualPort: 4711,
    });

    await httpRef?.close();
    expect(server.close).toHaveBeenCalledTimes(1);
  });
});

describe('start-listener-exposure-runtime source boundary', () => {
  it('keeps listener/exposure/runtime orchestration behind the pre-listener bridge', () => {
    const lifecycleRecoveryBridgeSource = readFileSync(
      lifecycleRecoveryBridgePath,
      'utf8',
    );
    const preListenerSource = readFileSync(preListenerPath, 'utf8');
    const bridgeSource = readFileSync(bridgePath, 'utf8');

    expect(preListenerSource).toMatch(/start-listener-exposure-runtime\.js/);
    expect(preListenerSource).toMatch(/startListenerExposureRuntime\(\{/);
    expect(lifecycleRecoveryBridgeSource).toMatch(
      /publishWsHandleForLockout:\s*\(wsHandle\) => \{/,
    );
    expect(lifecycleRecoveryBridgeSource).toMatch(
      /publishHttpServer:\s*\(serverRef\) => \{/,
    );
    expect(bridgeSource).toMatch(/await composeListeners\(\{/);
    expect(bridgeSource).toMatch(
      /publishWsHandleForLockout\(listeners\.serverHandlerSet\.wsHandle\)/,
    );
    expect(bridgeSource).toMatch(/await composeServeExposure\(\{/);
    expect(bridgeSource).toMatch(/const actualPort = listeners\.server\.port;/);
    expect(bridgeSource).toMatch(/publishHttpServer\(\{ close: \(\) => listeners\.server\.close\(\) \}\)/);
    expect(bridgeSource).toMatch(/await startPostListenerRuntime\(\{/);
  });

  it('preserves listener, exposure, publication, and runtime-start order', () => {
    const bridgeSource = readFileSync(bridgePath, 'utf8');
    const runtimeSource = readFileSync(runtimePath, 'utf8');

    const listenerIndex = bridgeSource.indexOf('await composeListeners({');
    const wsPublishIndex = bridgeSource.indexOf(
      'options.publishWsHandleForLockout(listeners.serverHandlerSet.wsHandle);',
    );
    const exposureIndex = bridgeSource.indexOf('await composeServeExposure({');
    const actualPortIndex = bridgeSource.indexOf(
      'const actualPort = listeners.server.port;',
    );
    const httpPublishIndex = bridgeSource.indexOf('options.publishHttpServer({');
    const runtimeStartIndex = bridgeSource.indexOf(
      'await startPostListenerRuntime({',
    );
    const executorWsIndex = runtimeSource.indexOf(
      'options.executorConfig.wsServer = options.server.wsServer;',
    );
    const peerCacheIndex = runtimeSource.indexOf('wrapServePeerCache({');
    const schedulerIndex = runtimeSource.indexOf(
      'const schedulersBundle = startSchedulers({',
    );

    expect(listenerIndex).toBeGreaterThanOrEqual(0);
    expect(wsPublishIndex).toBeGreaterThan(listenerIndex);
    expect(exposureIndex).toBeGreaterThan(wsPublishIndex);
    expect(actualPortIndex).toBeGreaterThan(exposureIndex);
    expect(httpPublishIndex).toBeGreaterThan(actualPortIndex);
    expect(runtimeStartIndex).toBeGreaterThan(httpPublishIndex);
    expect(executorWsIndex).toBeGreaterThanOrEqual(0);
    expect(peerCacheIndex).toBeGreaterThan(executorWsIndex);
    expect(schedulerIndex).toBeGreaterThan(peerCacheIndex);
  });
});
