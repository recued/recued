import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExposureStateMachine } from '../exposure/index.js';
import type { ComposeServeExposureOptions } from '../serve/compose-exposure.js';

const exposureMocks = vi.hoisted(() => ({
  composeExposureSubstrate: vi.fn(),
}));

vi.mock('../composition/bin/wire-exposure-substrate.js', () => ({
  composeExposureSubstrate: exposureMocks.composeExposureSubstrate,
}));

import { composeServeExposure } from '../serve/compose-exposure.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const composeExposurePath = join(
  repoRoot,
  'backend/server/src/serve/compose-exposure.ts',
);
const lifecycleRecoveryBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-lifecycle-recovery-pre-listener-runtime.ts',
);
const startListenerExposureRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-listener-exposure-runtime.ts',
);
const startPostListenerRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-listener-runtime.ts',
);

const makeOptions = (
  overrides: Partial<ComposeServeExposureOptions> = {},
): ComposeServeExposureOptions =>
  ({
    args: ['--reset-exposure'],
    db: { tag: 'db' },
    auditLog: { tag: 'audit-log' },
    listenerCoordinator: { tag: 'listener-coordinator' },
    webhookPort: 8732,
    lanBindAddress: '192.168.1.10',
    wsHandleClientCount: vi.fn(() => 4),
    publishExposureMachine: vi.fn(),
    eventBus: { tag: 'event-bus' },
    ...overrides,
  }) as unknown as ComposeServeExposureOptions;

beforeEach(() => {
  exposureMocks.composeExposureSubstrate.mockReset();
});

describe('composeServeExposure', () => {
  it('delegates exposure composition and publishes the machine before finalizing', async () => {
    const order: string[] = [];
    const exposureMachine = {
      tag: 'exposure-machine',
    } as unknown as ExposureStateMachine;
    const finalize = vi.fn(async () => {
      order.push('finalize');
    });
    exposureMocks.composeExposureSubstrate.mockImplementation(async () => {
      order.push('compose');
      return { exposureMachine, finalize };
    });
    const publishExposureMachine = vi.fn((machine: ExposureStateMachine) => {
      order.push('publish');
      expect(machine).toBe(exposureMachine);
    });
    const options = makeOptions({ publishExposureMachine });

    const result = await composeServeExposure(options);

    expect(result).toBe(exposureMachine);
    expect(exposureMocks.composeExposureSubstrate).toHaveBeenCalledTimes(1);
    expect(exposureMocks.composeExposureSubstrate).toHaveBeenCalledWith({
      args: options.args,
      db: options.db,
      auditLog: options.auditLog,
      listenerCoordinator: options.listenerCoordinator,
      webhookPort: options.webhookPort,
      lanBindAddress: options.lanBindAddress,
      wsHandleClientCount: options.wsHandleClientCount,
      eventBus: options.eventBus,
    });
    expect(publishExposureMachine).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['compose', 'publish', 'finalize']);
  });
});

describe('compose-exposure source boundary', () => {
  it('keeps exposure publish/finalize orchestration behind the listener bridge', () => {
    const lifecycleRecoveryBridgeSource = readFileSync(
      lifecycleRecoveryBridgePath,
      'utf8',
    );
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');

    expect(bridgeSource).toMatch(/compose-exposure\.js/);
    expect(bridgeSource).toMatch(/await composeServeExposure\(\{/);
    expect(lifecycleRecoveryBridgeSource).toMatch(
      /publishExposureMachine:\s*\(machine\) => \{/,
    );
    expect(bridgeSource).not.toMatch(/composeExposureSubstrate/);
    expect(bridgeSource).not.toMatch(/finalizeExposure/);
  });

  it('preserves listener, exposure, publication, peer-cache, and scheduler ordering', () => {
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');
    const runtimeSource = readFileSync(startPostListenerRuntimePath, 'utf8');
    const listenerIndex = bridgeSource.indexOf('await composeListeners({');
    const exposureIndex = bridgeSource.indexOf('await composeServeExposure({');
    const actualPortIndex = bridgeSource.indexOf(
      'const actualPort = listeners.server.port;',
    );
    const httpPublishIndex = bridgeSource.indexOf('options.publishHttpServer({');
    const runtimeStartIndex = bridgeSource.indexOf('await startPostListenerRuntime({');
    const wsPublishIndex = runtimeSource.indexOf('options.executorConfig.wsServer = options.server.wsServer;');
    const peerCacheIndex = runtimeSource.indexOf('wrapServePeerCache({');
    const schedulerIndex = runtimeSource.indexOf('const schedulersBundle = startSchedulers({');

    expect(listenerIndex).toBeGreaterThanOrEqual(0);
    expect(exposureIndex).toBeGreaterThan(listenerIndex);
    expect(actualPortIndex).toBeGreaterThan(exposureIndex);
    expect(httpPublishIndex).toBeGreaterThan(actualPortIndex);
    expect(runtimeStartIndex).toBeGreaterThan(httpPublishIndex);
    expect(wsPublishIndex).toBeGreaterThanOrEqual(0);
    expect(peerCacheIndex).toBeGreaterThan(wsPublishIndex);
    expect(schedulerIndex).toBeGreaterThan(peerCacheIndex);
  });

  it('keeps the helper focused on exposure composition and finalization only', () => {
    const source = readFileSync(composeExposurePath, 'utf8');

    expect(source).toMatch(/composeExposureSubstrate/);
    expect(source).toMatch(/publishExposureMachine/);
    expect(source).toMatch(/await finalize\(\)/);
    expect(source).not.toMatch(/wrapServePeerCache|wrapStoreWithPeer|PeerCacheTransport/);
    expect(source).not.toMatch(/startSchedulers|startServeHousekeepingScheduler/);
    expect(source).not.toMatch(/composeCertStackLate|startRetentionPruners|startDdnsUpdatePoller/);
    expect(source).not.toMatch(/logBootBanner|installShutdown/);
    expect(source).not.toMatch(/createServerHandlerSet|createProductionPathListenerCoordinator/);
    expect(source).not.toMatch(/executorConfig|wsServer/);
  });
});
