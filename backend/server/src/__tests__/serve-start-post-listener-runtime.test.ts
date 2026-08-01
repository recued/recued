import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stripSourceComments } from './helpers/source-guards.js';

const runtimeMocks = vi.hoisted(() => ({
  wrapServePeerCache: vi.fn(),
  startSchedulers: vi.fn(),
  composeCertStackLate: vi.fn(),
  startHousekeepingStartup: vi.fn(),
  startPostHousekeepingTail: vi.fn(),
  buildSellerAccessReconcileDepsIfReady: vi.fn(),
}));

vi.mock('../serve/wrap-peer-cache.js', () => ({
  wrapServePeerCache: runtimeMocks.wrapServePeerCache,
}));

vi.mock('../serve/start-schedulers.js', () => ({
  startSchedulers: runtimeMocks.startSchedulers,
}));

vi.mock('../serve/compose-cert-stack-late.js', () => ({
  composeCertStackLate: runtimeMocks.composeCertStackLate,
}));

vi.mock('../serve/start-housekeeping-startup.js', () => ({
  startHousekeepingStartup: runtimeMocks.startHousekeepingStartup,
}));

vi.mock('../serve/start-post-housekeeping-tail.js', () => ({
  startPostHousekeepingTail: runtimeMocks.startPostHousekeepingTail,
}));

vi.mock('../seller/access-reconcile-deps.js', () => ({
  buildSellerAccessReconcileDepsIfReady: runtimeMocks.buildSellerAccessReconcileDepsIfReady,
}));

// D-192 S4c2 — this wire calls `connectionStore.list()` eagerly once its
// `engagementStore` guard passes (which it does: the ref IS stubbed here).
// ⚠ NOT a missing product method — `ConnectionStore.list` is declared at
// storage/connection-store.ts:179 and implemented at :323; the tag-only stub
// in this ordering suite is what cannot serve it. Its sibling CRM wire escapes
// only because its own guard short-circuits on an unstubbed mirror ref.
vi.mock('../serve/compose-generic-engagement-reconciliation.js', () => ({
  composeGenericEngagementReconciliation: vi.fn(),
}));

import {
  startPostListenerRuntime,
  type StartPostListenerRuntimeOptions,
} from '../serve/start-post-listener-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const startPostListenerRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-listener-runtime.ts',
);
const startListenerExposureRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-listener-exposure-runtime.ts',
);

beforeEach(() => {
  runtimeMocks.wrapServePeerCache.mockReset();
  runtimeMocks.startSchedulers.mockReset();
  runtimeMocks.composeCertStackLate.mockReset();
  runtimeMocks.startHousekeepingStartup.mockReset();
  runtimeMocks.startPostHousekeepingTail.mockReset();
  runtimeMocks.buildSellerAccessReconcileDepsIfReady.mockReset();
});

const makeOptions = (
  overrides: Partial<StartPostListenerRuntimeOptions> = {},
): StartPostListenerRuntimeOptions =>
  ({
    dbPath: '/tmp/server.db',
    runtimeConfig: { get: vi.fn() },
    backgroundServices: {
      stopAll: vi.fn(),
      register: vi.fn(),
      registerInterval: vi.fn(() => () => {}),
    },
    storage: {
      db: { tag: 'db' },
      recipeStore: { tag: 'recipe-store', size: vi.fn(() => 3) },
      eventBus: { tag: 'event-bus' },
      auditLog: { tag: 'audit-log' },
      workEntityStoreRef: { tag: 'work-entity-store' },
      manifests: { size: vi.fn(() => 7) },
      pairing: { getCode: vi.fn(() => 'PAIR-CODE') },
      recoveryKeyCheck: { exists: vi.fn(() => true) },
      auditRetention: { tag: 'audit-retention' },
      s2sPreviewStoreRef: { tag: 's2s-preview-store' },
      correctionEventsStoreRef: { tag: 'correction-events-store' },
      fileStack: { disposeAll: vi.fn() },
    },
    app: {
      cacheStore: { tag: 'cache-store' },
      housekeepingConfigRef: { tag: 'housekeeping-config' },
      housekeepingStateRef: { tag: 'housekeeping-state' },
      housekeepingTrustRef: { tag: 'housekeeping-trust' },
      enrichmentStoreRef: { tag: 'enrichment-store' },
      cacheBlobs: { tag: 'cache-blobs' },
      warehouseBus: { tag: 'warehouse-bus' },
      contactStoreRef: { tag: 'contact-store' },
      enrichmentCascadeRef: { tag: 'enrichment-cascade' },
      externalContextRegistryRef: { tag: 'external-context-registry' },
      connectionStoreRef: { tag: 'connection-store' },
      // D-196 §6.3 (s2b) — the seller stores the reconciler build reads.
      sellerStoreRef: { tag: 'seller-store' },
      contractStoreRef: { tag: 'contract-store' },
      chatInboundTokenStoreRef: { tag: 'inbound-token-store' },
      sellerClaimStoreRef: { tag: 'seller-claim-store' },
      keys: { tag: 'keys' },
      // R21.1 — vault-gate plumbing the runtime reads at boot.
      isVaultUnlocked: () => true,
      vaultStateBus: { subscribe: vi.fn(() => () => {}), emit: vi.fn() },
      engagementStoreRef: { tag: 'engagement-store' },
      upstreamMergeStoreRef: { tag: 'upstream-merge-store' },
      llmManager: { tag: 'llm-manager' },
      llmConfig: { slot_1: { provider: 'openai', model: 'gpt-4.1' } },
      llmQuota: { tag: 'llm-quota' },
      llmAdapterRegistry: { tag: 'llm-adapter-registry' },
      llmEmbeddingsAdapterRegistry: { tag: 'embeddings-registry' },
      emptyTabProbe: vi.fn(),
    },
    collection: {
      collectionRegistry: { tag: 'collection-registry' },
      calendarStack: { disposeAll: vi.fn() },
      serviceStack: { disposeAll: vi.fn() },
    },
    executorConfig: { cacheStore: { tag: 'bare-cache' } },
    server: {
      wsServer: { tag: 'ws-server' },
      port: 4747,
      close: vi.fn(async () => undefined),
    },
    scheduleStore: { tag: 'schedule-store' },
    executeDeps: {
      tag: 'execute-deps',
      // D-196 §6.3 (s2b) — the gateway-spine pieces the reconciler build reads.
      executorConfig: { tag: 'executor-config' },
      connectionOperationProfiles: { tag: 'conn-op-profiles' },
      connectionStore: { tag: 'exec-connection-store' },
      auditLog: { tag: 'exec-audit-log' },
      contractScan: { tag: 'contract-scan' },
    },
    circuitStore: { tag: 'circuit-store' },
    certStack: {
      tag: 'cert-stack',
      // D-175 — the Pro-convenience provisioning starter reads these post
      // composeCertStackLate; `undefined` (this orchestration harness runs
      // a mocked late-compose) makes it a clean no-op (no registry stub
      // needed). Its own behavior is covered in
      // `d-175-pro-convenience-provisioning-start.test.ts`.
      getHandleStateMachineRef: () => undefined,
      getBindingEntitlementSource: () => undefined,
    },
    tlsDomainStore: { tag: 'tls-domain-store' },
    lanAdvertisedAddress: '127.0.0.1',
    actualPort: 4747,
    upstreamMergeRegistry: new Map(),
    publishSchedulersBundle: vi.fn(),
    publishVendorRefs: vi.fn(),
    rotationEngine: { tag: 'rotation-engine' },
    getActiveContactMergeScanMode: vi.fn(() => 'delta'),
    getContactMergeCycleObserver: vi.fn(() => undefined),
    enrichmentProducers: new Map(),
    cloudBaseUrl: 'https://cloud.test',
    getSigningIdentity: vi.fn(() => ({ tag: 'identity' })),
    lifecycle: { install: vi.fn(), markBooted: vi.fn() },
    cascade: { close: vi.fn() },
    ...overrides,
  }) as unknown as StartPostListenerRuntimeOptions;

describe('startPostListenerRuntime', () => {
  it('starts runtime services in order and returns/publishes mutable refs', async () => {
    const order: string[] = [];
    const schedulersBundle = { tag: 'schedulers-bundle' };
    const vendorRefs = {
      apiConnectionLookup: vi.fn(),
      refreshApiConnectionAuth: vi.fn(),
      registerSalesforceCallEntity: vi.fn(),
    };
    runtimeMocks.wrapServePeerCache.mockImplementation((options) => {
      order.push(options.executorConfig.wsServer === options.wsServer
        ? 'ws-published'
        : 'ws-missing');
      order.push('peer-cache');
    });
    runtimeMocks.startSchedulers.mockImplementation(() => {
      order.push('schedulers');
      return schedulersBundle;
    });
    runtimeMocks.composeCertStackLate.mockImplementation(async () => {
      order.push('cert-late');
      return {
        tlsCertSource: { tag: 'tls-cert-source' },
        tlsRenewerConfigured: true,
      };
    });
    runtimeMocks.startHousekeepingStartup.mockImplementation(async (options) => {
      order.push('housekeeping');
      expect(options.getSchedulerBundle()).toBe(schedulersBundle);
      options.publishVendorRefs(vendorRefs);
      return { scheduler: { tag: 'housekeeping-scheduler' } };
    });
    runtimeMocks.startPostHousekeepingTail.mockImplementation(() => {
      order.push('post-tail');
    });
    const options = makeOptions({
      publishSchedulersBundle: vi.fn(() => {
        order.push('publish-schedulers');
      }),
      publishVendorRefs: vi.fn(() => {
        order.push('publish-vendor');
      }),
    });

    const result = await startPostListenerRuntime(options);

    expect(result).toEqual({
      schedulersBundle,
      vendorRefs,
    });
    expect(order).toEqual([
      'ws-published',
      'peer-cache',
      'schedulers',
      'publish-schedulers',
      'cert-late',
      'housekeeping',
      'publish-vendor',
      'post-tail',
    ]);
    expect(options.executorConfig.wsServer).toBe(options.server.wsServer);
    expect(options.publishSchedulersBundle).toHaveBeenCalledWith(schedulersBundle);
    expect(options.publishVendorRefs).toHaveBeenCalledWith(vendorRefs);
    expect(runtimeMocks.startSchedulers).toHaveBeenCalledWith({
      registry: options.backgroundServices,
      db: options.storage.db,
      scheduleStore: options.scheduleStore,
      executeDeps: options.executeDeps,
      recipeStore: options.storage.recipeStore,
      circuitStore: options.circuitStore,
      // R21.1 — the vault-unlocked predicate gates the scheduler ticks.
      isVaultUnlocked: options.app.isVaultUnlocked,
    });
    expect(runtimeMocks.composeCertStackLate).toHaveBeenCalledWith({
      certStack: options.certStack,
      tlsDomainStore: options.tlsDomainStore,
      lanAdvertisedAddress: options.lanAdvertisedAddress,
      actualPort: options.actualPort,
    });
    expect(runtimeMocks.startPostHousekeepingTail).toHaveBeenCalledWith({
      dbPath: options.dbPath,
      runtimeConfig: options.runtimeConfig,
      backgroundServices: options.backgroundServices,
      storage: options.storage,
      app: options.app,
      collection: options.collection,
      cloudBaseUrl: options.cloudBaseUrl,
      getSigningIdentity: options.getSigningIdentity,
      lifecycle: options.lifecycle,
      cascade: options.cascade,
      server: options.server,
      // The tail also receives the LAN bind + the three optional handles it
      // forwards (start-post-listener-runtime.ts:522-525). Pinned by NAME so a
      // future value change surfaces here instead of drifting silently.
      webclientServed: options.webclientServed,
      notificationBlock: options.notificationBlock,
      runUpdateBootReconcile: options.runUpdateBootReconcile,
    });
  });

  it('returns undefined vendor refs when housekeeping startup publishes none', async () => {
    const schedulersBundle = { tag: 'schedulers-bundle' };
    runtimeMocks.startSchedulers.mockReturnValue(schedulersBundle);
    runtimeMocks.composeCertStackLate.mockResolvedValue({
      tlsCertSource: undefined,
      tlsRenewerConfigured: false,
    });
    runtimeMocks.startHousekeepingStartup.mockResolvedValue({
      scheduler: undefined,
    });
    const options = makeOptions();

    const result = await startPostListenerRuntime(options);

    expect(result).toEqual({
      schedulersBundle,
      vendorRefs: undefined,
    });
    expect(options.publishVendorRefs).not.toHaveBeenCalled();
  });

  it('D-196 §6.3 (s2b) — builds the reconciler deps from executeDeps + the seller refs, and passes them to housekeeping startup', async () => {
    // ⛔ The one place both halves exist: the gateway spine (executeDeps) AND
    // the seller stores (app). This test proves the post-listener actually
    // reaches into BOTH — a ref left off the reach is a reconciler wired to
    // nothing, the exact bug the Pick comment warns about. It asserts the
    // INPUTS the build reads AND that its output is forwarded, not merely that
    // some object flowed through.
    const built = { tag: 'built-seller-reconcile-deps' };
    runtimeMocks.buildSellerAccessReconcileDepsIfReady.mockReturnValue(built);
    runtimeMocks.startSchedulers.mockReturnValue({ tag: 'schedulers-bundle' });
    runtimeMocks.composeCertStackLate.mockResolvedValue({
      tlsCertSource: undefined,
      tlsRenewerConfigured: false,
    });
    runtimeMocks.startHousekeepingStartup.mockResolvedValue({ scheduler: undefined });
    const options = makeOptions();

    await startPostListenerRuntime(options);

    expect(runtimeMocks.buildSellerAccessReconcileDepsIfReady).toHaveBeenCalledWith({
      gateway: {
        executorConfig: (options.executeDeps as any).executorConfig,
        connectionOperationProfiles: (options.executeDeps as any).connectionOperationProfiles,
        connectionStore: (options.executeDeps as any).connectionStore,
        auditLog: (options.executeDeps as any).auditLog,
        contractScan: (options.executeDeps as any).contractScan,
      },
      seller: {
        sellerStore: (options.app as any).sellerStoreRef,
        contractStore: (options.app as any).contractStoreRef,
        inboundTokenStore: (options.app as any).chatInboundTokenStoreRef,
        sellerClaimStore: (options.app as any).sellerClaimStoreRef,
      },
    });
    expect(runtimeMocks.startHousekeepingStartup).toHaveBeenCalledWith(
      expect.objectContaining({ sellerAccessReconcileDeps: built }),
    );
  });

  it('D-196 §6.3 (s2b) — omits sellerAccessReconcileDeps when the build returns undefined (no seller substrate)', async () => {
    runtimeMocks.buildSellerAccessReconcileDepsIfReady.mockReturnValue(undefined);
    runtimeMocks.startSchedulers.mockReturnValue({ tag: 'schedulers-bundle' });
    runtimeMocks.composeCertStackLate.mockResolvedValue({
      tlsCertSource: undefined,
      tlsRenewerConfigured: false,
    });
    runtimeMocks.startHousekeepingStartup.mockResolvedValue({ scheduler: undefined });

    await startPostListenerRuntime(makeOptions());

    expect(runtimeMocks.startHousekeepingStartup.mock.calls[0]![0])
      .not.toHaveProperty('sellerAccessReconcileDeps');
  });

  it('R21.1 — registers the vault-gated-executors coordinator as kind:emitter so auth-migration maintenance cannot dispose it', async () => {
    runtimeMocks.startSchedulers.mockReturnValue({ tag: 'schedulers-bundle' });
    runtimeMocks.composeCertStackLate.mockResolvedValue({
      tlsCertSource: undefined,
      tlsRenewerConfigured: false,
    });
    runtimeMocks.startHousekeepingStartup.mockResolvedValue({ scheduler: undefined });
    let onVaultState: ((next: 'unlocked' | 'locked' | 'uninitialized') => void) | undefined;
    const recoverPendingAsks = vi.fn(async () => undefined);
    const options = makeOptions({
      notificationBlock: { recoverPendingAsks } as never,
    });
    (options.app.vaultStateBus.subscribe as ReturnType<typeof vi.fn>)
      .mockImplementation((listener) => {
        onVaultState = listener;
        return () => undefined;
      });

    await startPostListenerRuntime(options);

    const register = options.backgroundServices.register as ReturnType<typeof vi.fn>;
    const coordinatorReg = register.mock.calls
      .map((c) => c[0] as { name: string; kind: string })
      .find((s) => s.name === 'vault-gated-executors');
    expect(coordinatorReg).toBeDefined();
    // Maintenance does `stopAll({ kind: 'scheduler' })`; a 'scheduler' tag
    // would dispose the coordinator's bus subscription mid-migration and
    // lose the post-unlock resume kick. 'emitter' survives that scoped
    // stop yet is still disposed by shutdown's unfiltered stopAll().
    expect(coordinatorReg!.kind).toBe('emitter');
    // It also subscribes to the vault-state bus exactly once.
    expect((options.app.vaultStateBus.subscribe as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    onVaultState?.('unlocked');
    await new Promise((resolve) => setImmediate(resolve));
    expect(recoverPendingAsks).toHaveBeenCalledTimes(1);
  });
});

describe('start-post-listener-runtime source boundary', () => {
  it('keeps post-listener runtime startup behind the listener/exposure bridge', () => {
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');

    expect(bridgeSource).toMatch(/start-post-listener-runtime\.js/);
    expect(bridgeSource).toMatch(/startPostListenerRuntime\(\{/);
  });

  it('preserves WS, peer-cache, scheduler, cert, housekeeping, and tail order', () => {
    const source = readFileSync(startPostListenerRuntimePath, 'utf8');
    const wsPublishIndex = source.indexOf('options.executorConfig.wsServer = options.server.wsServer;');
    const peerCacheIndex = source.indexOf('wrapServePeerCache({');
    const schedulerIndex = source.indexOf('const schedulersBundle = startSchedulers({');
    const publishSchedulerIndex = source.indexOf('options.publishSchedulersBundle(schedulersBundle);');
    const certLateIndex = source.indexOf('await composeCertStackLate({');
    const housekeepingIndex = source.indexOf('await startHousekeepingStartup({');
    const vendorPublishIndex = source.indexOf('options.publishVendorRefs(refs);');
    const postTailIndex = source.indexOf('startPostHousekeepingTail({');

    expect(wsPublishIndex).toBeGreaterThanOrEqual(0);
    expect(peerCacheIndex).toBeGreaterThan(wsPublishIndex);
    expect(schedulerIndex).toBeGreaterThan(peerCacheIndex);
    expect(publishSchedulerIndex).toBeGreaterThan(schedulerIndex);
    expect(certLateIndex).toBeGreaterThan(publishSchedulerIndex);
    expect(housekeepingIndex).toBeGreaterThan(certLateIndex);
    expect(vendorPublishIndex).toBeGreaterThan(housekeepingIndex);
    expect(postTailIndex).toBeGreaterThan(housekeepingIndex);
  });

  it('keeps the helper out of listener, exposure, lifecycle, and boot recovery', () => {
    const source = readFileSync(startPostListenerRuntimePath, 'utf8');

    expect(source).toMatch(/wrapServePeerCache/);
    expect(source).toMatch(/startSchedulers/);
    expect(source).toMatch(/composeCertStackLate/);
    expect(source).toMatch(/startHousekeepingStartup/);
    expect(source).toMatch(/startPostHousekeepingTail/);
    expect(stripSourceComments(source)).not.toMatch(/composeListeners|createServerHandlerSet/);
    expect(stripSourceComments(source)).not.toMatch(/composeServeExposure|composeExposureSubstrate/);
    expect(stripSourceComments(source)).not.toMatch(/composeServeLifecycle|createLifecycle/);
    expect(stripSourceComments(source)).not.toMatch(/startBootRecoveryAndAdapters/);
  });
});
