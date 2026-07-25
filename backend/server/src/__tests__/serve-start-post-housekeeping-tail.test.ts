import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stripSourceComments } from './helpers/source-guards.js';

const tailMocks = vi.hoisted(() => ({
  startRetentionPruners: vi.fn(),
  startDdnsUpdatePoller: vi.fn(),
  startHostnameReconciliationRunner: vi.fn(),
  logBootBanner: vi.fn(),
  installShutdown: vi.fn(),
}));

vi.mock('../serve/start-retention-pruners.js', () => ({
  startRetentionPruners: tailMocks.startRetentionPruners,
}));

vi.mock('../serve/start-ddns-update-poller.js', () => ({
  startDdnsUpdatePoller: tailMocks.startDdnsUpdatePoller,
}));

vi.mock('../serve/start-hostname-reconciliation-runner.js', () => ({
  startHostnameReconciliationRunner: tailMocks.startHostnameReconciliationRunner,
}));

vi.mock('../serve/log-boot-banner.js', () => ({
  logBootBanner: tailMocks.logBootBanner,
}));

vi.mock('../serve/install-shutdown.js', () => ({
  installShutdown: tailMocks.installShutdown,
}));

import {
  startPostHousekeepingTail,
  type StartPostHousekeepingTailOptions,
} from '../serve/start-post-housekeeping-tail.js';
import { SERVER_VERSION } from '../server-version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const startPostHousekeepingTailPath = join(
  repoRoot,
  'backend/server/src/serve/start-post-housekeeping-tail.ts',
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
  tailMocks.startRetentionPruners.mockReset();
  tailMocks.startDdnsUpdatePoller.mockReset();
  tailMocks.startHostnameReconciliationRunner.mockReset();
  tailMocks.logBootBanner.mockReset();
  tailMocks.installShutdown.mockReset();
  tailMocks.installShutdown.mockReturnValue({ tag: 'installed-shutdown' });
});

const makeOptions = (
  overrides: Partial<StartPostHousekeepingTailOptions> = {},
): StartPostHousekeepingTailOptions =>
  ({
    dbPath: '/tmp/server.db',
    runtimeConfig: { get: vi.fn() },
    backgroundServices: { stopAll: vi.fn() },
    storage: {
      db: { tag: 'db' },
      manifests: { size: vi.fn(() => 34) },
      recipeStore: { size: vi.fn(() => 12) },
      pairing: { getCode: vi.fn(() => 'PAIR-CODE') },
      recoveryKeyCheck: { exists: vi.fn(() => false) },
      auditRetention: { tag: 'audit-retention' },
      s2sPreviewStoreRef: { tag: 's2s-preview-store' },
      correctionEventsStoreRef: { tag: 'correction-events-store' },
      fileStack: { disposeAll: vi.fn() },
    },
    app: {
      llmConfig: { slot_1: { provider: 'openai', model: 'gpt-4.1' } },
      executionCaseLifecycle: { finalizeTurn: vi.fn() },
    },
    collection: {
      calendarStack: { disposeAll: vi.fn() },
      serviceStack: { disposeAll: vi.fn() },
    },
    cloudBaseUrl: 'https://cloud.test',
    getSigningIdentity: vi.fn(() => ({ tag: 'identity' })),
    lifecycle: { install: vi.fn(), markBooted: vi.fn() },
    cascade: { close: vi.fn() },
    server: { port: 4747, close: vi.fn(async () => undefined) },
    lanBindAddress: '192.168.1.7',
    webclientServed: true,
    ...overrides,
  }) as unknown as StartPostHousekeepingTailOptions;

describe('startPostHousekeepingTail', () => {
  it('runs retention, DDNS, hostname reconciliation, banner, then shutdown with the preserved live handles', () => {
    const order: string[] = [];
    tailMocks.startRetentionPruners.mockImplementation(() => {
      order.push('retention');
    });
    tailMocks.startDdnsUpdatePoller.mockImplementation(() => {
      order.push('ddns');
    });
    tailMocks.startHostnameReconciliationRunner.mockImplementation(() => {
      order.push('hostname');
    });
    tailMocks.logBootBanner.mockImplementation(() => {
      order.push('banner');
    });
    tailMocks.installShutdown.mockImplementation(() => {
      order.push('shutdown');
      return { tag: 'installed-shutdown' };
    });
    const options = makeOptions();

    const result = startPostHousekeepingTail(options);

    expect(result).toEqual({ tag: 'installed-shutdown' });
    expect(order).toEqual(['retention', 'ddns', 'hostname', 'banner', 'shutdown']);
    expect(tailMocks.startRetentionPruners).toHaveBeenCalledWith({
      backgroundServices: options.backgroundServices,
      runtimeConfig: options.runtimeConfig,
      auditRetention: options.storage.auditRetention,
      s2sPreviewStore: options.storage.s2sPreviewStoreRef,
      correctionEventsStore: options.storage.correctionEventsStoreRef,
      checkpointStore: options.storage.checkpointStore,
      auditLog: options.storage.auditLog,
      executionCaseLifecycle: options.app.executionCaseLifecycle,
      notificationBlock: options.notificationBlock,
    });
    expect(tailMocks.startDdnsUpdatePoller).toHaveBeenCalledWith({
      db: options.storage.db,
      backgroundServices: options.backgroundServices,
      cloudBaseUrl: options.cloudBaseUrl,
      getSigningIdentity: options.getSigningIdentity,
    });
    expect(tailMocks.startHostnameReconciliationRunner).toHaveBeenCalledWith({
      db: options.storage.db,
      backgroundServices: options.backgroundServices,
    });
    expect(tailMocks.logBootBanner).toHaveBeenCalledWith({
      version: SERVER_VERSION,
      port: 4747,
      lanBindAddress: '192.168.1.7',
      webclientServed: true,
      dbPath: '/tmp/server.db',
      recipeCount: 12,
      ingredientCount: 34,
      llmConfig: options.app.llmConfig,
      pairingCode: 'PAIR-CODE',
      notEnrolled: true,
    });
    expect(tailMocks.installShutdown).toHaveBeenCalledWith({
      lifecycle: options.lifecycle,
      backgroundServices: options.backgroundServices,
      fileStack: options.storage.fileStack,
      calendarStack: options.collection.calendarStack,
      serviceStack: options.collection.serviceStack,
      cascade: options.cascade,
      server: options.server,
      db: options.storage.db,
    });
  });

  it('keeps banner enrollment status false without a recovery-key store', () => {
    const options = makeOptions({
      storage: {
        ...makeOptions().storage,
        recoveryKeyCheck: undefined,
      },
    });

    startPostHousekeepingTail(options);

    expect(tailMocks.logBootBanner).toHaveBeenCalledWith(
      expect.objectContaining({ notEnrolled: false }),
    );
  });
});

describe('start-post-housekeeping-tail source boundary', () => {
  it('keeps post-housekeeping tail orchestration behind post-listener runtime', () => {
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');
    const runtimeSource = readFileSync(startPostListenerRuntimePath, 'utf8');

    expect(bridgeSource).toMatch(/start-post-listener-runtime\.js/);
    expect(runtimeSource).toMatch(/start-post-housekeeping-tail\.js/);
    expect(runtimeSource).toMatch(/startPostHousekeepingTail\(\{/);
  });

  it('keeps retention, DDNS, hostname reconciliation, banner, and shutdown ordered in the tail helper', () => {
    const source = readFileSync(startPostHousekeepingTailPath, 'utf8');
    const retentionIndex = source.indexOf('startRetentionPruners({');
    const ddnsIndex = source.indexOf('startDdnsUpdatePoller({');
    const hostnameIndex = source.indexOf('startHostnameReconciliationRunner({');
    const bannerIndex = source.indexOf('logBootBanner({');
    const shutdownIndex = source.indexOf('installShutdown({');

    expect(retentionIndex).toBeGreaterThanOrEqual(0);
    expect(ddnsIndex).toBeGreaterThan(retentionIndex);
    expect(hostnameIndex).toBeGreaterThan(ddnsIndex);
    expect(bannerIndex).toBeGreaterThan(hostnameIndex);
    expect(shutdownIndex).toBeGreaterThan(bannerIndex);
  });

  it('keeps the tail helper focused after housekeeping startup', () => {
    const source = readFileSync(startPostHousekeepingTailPath, 'utf8');

    expect(source).toMatch(/startRetentionPruners/);
    expect(source).toMatch(/startDdnsUpdatePoller/);
    expect(source).toMatch(/startHostnameReconciliationRunner/);
    expect(source).toMatch(/logBootBanner/);
    expect(source).toMatch(/installShutdown/);
    expect(stripSourceComments(source)).not.toMatch(/startHousekeepingStartup/);
    expect(stripSourceComments(source)).not.toMatch(/composeServeExposure|composeServeLifecycle/);
    expect(stripSourceComments(source)).not.toMatch(/startBootRecoveryAndAdapters/);
    expect(stripSourceComments(source)).not.toMatch(/composeSchedulers|composeHousekeepingScheduler/);
    expect(stripSourceComments(source)).not.toMatch(/createServerHandlerSet|createProductionPathListenerCoordinator/);
  });
});
