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

// ⚠ ALL THREE, AND THE STORES ARE NOT OPTIONAL. `start-post-listener-runtime`
// builds them INLINE AS ARGUMENTS to the composer, so mocking the composer alone
// still evaluates `createSqliteHandleStateStore({ db })` and re-raises the
// TypeError. The composer mock stops the background work; the store mocks stop
// the construction. Neither substitutes for the other.
vi.mock('../handle/sqlite-store.js', () => ({
  createSqliteHandleStateStore: vi.fn(() => ({
    load: vi.fn(async () => null),
    save: vi.fn(async () => {}),
  })),
}));

vi.mock('../storage/hostname-registry.js', () => ({
  createHostnameRegistryStore: vi.fn(() => ({
    getByHostname: vi.fn(() => null),
    upsert: vi.fn(),
    list: vi.fn(() => []),
  })),
}));

vi.mock('../composition/bin/wire-pro-cert-enrollment.js', () => ({
  composeProCertEnrollment: vi.fn(),
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

/** ⛔⛔ `composeProCertEnrollment` IS MOCKED, AND FINDING THE RIGHT SEAM TOOK
 *  THREE TRIES. Both wrong answers are recorded because each looked correct.
 *
 *  1. The fixture was `db: { tag: 'db' }` — fine until `1952f131c` wired the
 *     Pro-cert enrollment composer, which calls `createSqliteHandleStateStore`
 *     and `createHostnameRegistryStore` with it. A tag object is TRUTHY, so the
 *     `if (options.storage.db)` branch ran and all 9 tests died on
 *     `options.db.prepare is not a function`.
 *  2. Handing it a real in-memory `better-sqlite3` handle turned all 9 green —
 *     and turned this file into a SHARD KILLER. `vitest run backend --shard=1/4`
 *     produced 441 bytes: banner, no summary, not one test reported. Closing
 *     every handle did not help; nor did mocking the two stores instead.
 *
 *  🔑🔑 THE TELL WAS BACKWARDS FROM THE OBVIOUS READING. The shard summarised
 *  while these tests were FAILING and died once they PASSED — because the
 *  TypeError used to abort `startPostListenerRuntime` before it composed
 *  anything. Making the tests pass let the composer actually run, and
 *  `composeProCertEnrollment` registers a background service that fires an
 *  IMMEDIATE tick reaching for ACME/DDNS. A test that starts real work does not
 *  fail — it leaves the worker unable to exit, and the damage lands on the
 *  SHARD, nowhere near the file that caused it.
 *
 *  🔑 A GREEN FILE IS NOT A HARMLESS FILE. Attempt 2 traded 6 red tests for a
 *  shard that could not report at all — strictly worse, and invisible unless the
 *  whole sweep is re-run after the fix.
 *
 *  ⇒ This is a COMPOSITION test: it asserts what `startPostListenerRuntime`
 *  wires, not what the cert enroller does. Every other collaborator is already
 *  mocked one by one above; this one belongs in that list, and no assertion in
 *  this file mentions Pro-cert enrollment. `db` stays an opaque token whose only
 *  job is to be the identity threaded through — which the assertions check. */
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
      serverTimeZoneStore: {
        read: vi.fn(() => ({ mode: 'fixed', zone: 'Europe/Dublin', updated_at: 1 })),
      },
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
    autoRunSettingsStore: { tag: 'auto-run-settings-store' },
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
      autoRunSettingsStore: options.autoRunSettingsStore,
      serverTimeZone: expect.any(Function),
      // R21.1 — the vault-unlocked predicate gates the scheduler ticks.
      isVaultUnlocked: options.app.isVaultUnlocked,
    });
    const schedulerOptions = runtimeMocks.startSchedulers.mock.calls[0]![0];
    expect(schedulerOptions.serverTimeZone()).toBe('Europe/Dublin');
    vi.mocked(options.storage.serverTimeZoneStore.read).mockReturnValue({
      mode: 'fixed', zone: 'America/Los_Angeles', updated_at: 2,
    });
    expect(schedulerOptions.serverTimeZone()).toBe('America/Los_Angeles');
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
      // D-148 § A.5.6 lapse-recovery hop. Matched by SHAPE because the runtime
      // builds a closure here rather than forwarding a value.
      applyLifecycle: expect.any(Function),
    });

    // ...and the closure has to stay LAZY. `composeLate` fills the cert stack's
    // handle-state-machine ref, which can land AFTER this call, so a version
    // that read the ref eagerly would pin `undefined` and disable lapse
    // recovery while remaining fully typed and green — the failure mode
    // start-post-listener-runtime.ts:602-606 exists to warn about. Asserting
    // only `expect.any(Function)` above would not tell those two apart.
    const tailCall = runtimeMocks.startPostHousekeepingTail.mock.calls[0]?.[0] as
      { applyLifecycle: () => unknown };
    // Counted rather than compared by identity: it needs no stand-in
    // `HandleStateMachine` (a whole-object cast would silence the very
    // missing-member check that keeps this fixture honest), and it measures the
    // property that matters — the ref is read WHEN THE CLOSURE RUNS. An eager
    // version reads it once at wiring time and never again, so the count does
    // not move here and this reddens.
    let refReads = 0;
    options.certStack.getHandleStateMachineRef = () => { refReads += 1; return undefined; };
    const before = refReads;
    tailCall.applyLifecycle();
    expect(refReads).toBe(before + 1);
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
      // D-266 — the double now declares the ask surface the boot reaches
      // for. It previously carried `recoverPendingAsks` alone and passed
      // only because nothing CALLED the rest; `register()` is the first
      // eager call, so a partial double is now a real startup failure
      // rather than a latent one.
      notificationBlock: {
        recoverPendingAsks,
        ask: vi.fn(async (_m: unknown, _o: unknown, _h: unknown) => ({ ask_id: 'a1' })),
        cancelAsk: vi.fn(async (_id: string) => 'not_open' as const),
        listOpenAsks: vi.fn(async () => []),
        registerAskHandler: vi.fn((_k: string, _f: unknown) => undefined),
      } as never,
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

  it('registers local messenger ingress as a process-lifetime emitter', async () => {
    runtimeMocks.startSchedulers.mockReturnValue({ tag: 'schedulers-bundle' });
    runtimeMocks.composeCertStackLate.mockResolvedValue({
      tlsCertSource: undefined,
      tlsRenewerConfigured: false,
    });
    runtimeMocks.startHousekeepingStartup.mockResolvedValue({ scheduler: undefined });
    const stop = vi.fn(async () => undefined);
    const options = makeOptions({
      messengerIngressSupervisor: {
        start: vi.fn(async () => undefined),
        stop,
        reconcile: vi.fn(async () => undefined),
        status: vi.fn(() => null),
      },
    });

    await startPostListenerRuntime(options);

    const register = options.backgroundServices.register as ReturnType<typeof vi.fn>;
    const registration = register.mock.calls
      .map((call) => call[0] as { name: string; kind: string; stop(): Promise<void> })
      .find((service) => service.name === 'messenger-local-ingress');
    expect(registration).toMatchObject({
      name: 'messenger-local-ingress',
      kind: 'emitter',
    });
    await registration!.stop();
    expect(stop).toHaveBeenCalledTimes(1);
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

describe('D-232 § 24 — the retry sweep is REACHED at boot', () => {
  /** ⛔⛔ AN INERT COMPOSER IS THE FAILURE MODE THIS FEATURE KEPT PRODUCING. The
   *  planner and the sweep are each tested in isolation, and neither proves the
   *  thing is WIRED — a `composeExchangeRetry` nobody calls passes every one of
   *  those tests. There is no rpc that lists background services and boot logs
   *  no registrations, so the live drive cannot see it either; this composition
   *  test is the only place the question is answerable.
   *
   *  🔑 Asserted on the NAME, not on a call count: `registerInterval` is used by
   *  several composers, so "it was called" is true whether or not this one ran. */
  it('registers `exchange-retry` when an audit log is present', async () => {
    runtimeMocks.composeCertStackLate.mockResolvedValue({
      tlsCertSource: undefined, tlsRenewerConfigured: false,
    });
    runtimeMocks.startHousekeepingStartup.mockResolvedValue({ scheduler: undefined });
    const options = makeOptions();
    await startPostListenerRuntime(options);
    const names = (options.backgroundServices.registerInterval as unknown as {
      mock: { calls: Array<[{ name: string }]> };
    }).mock.calls.map((c) => c[0]?.name);
    expect(names).toContain('exchange-retry');
  });

  it('⛔ registers NOTHING when there is no audit log to read attempts from', async () => {
    runtimeMocks.composeCertStackLate.mockResolvedValue({
      tlsCertSource: undefined, tlsRenewerConfigured: false,
    });
    runtimeMocks.startHousekeepingStartup.mockResolvedValue({ scheduler: undefined });

    // Attempts are counted from the trail (§ 24 — "the audit log is the outbox").
    // With no trail there is no candidate set, and a sweep that ticks over
    // nothing is a timer pretending to be a feature.
    const options = makeOptions({ storage: { ...makeOptions().storage, auditLog: undefined } as never });
    await startPostListenerRuntime(options);
    const names = (options.backgroundServices.registerInterval as unknown as {
      mock: { calls: Array<[{ name: string }]> };
    }).mock.calls.map((c) => c[0]?.name);
    expect(names).not.toContain('exchange-retry');
  });

  it('D-235 — registers the custom-domain enrollment service', async () => {
    // ⛔ THE JOIN, NOT THE COMPONENT. `composeCustomDomainEnrollment` has its
    //    own suite asserting it registers an interval named this — but that
    //    suite calls the composer directly, so it stays green whether or not
    //    anything ever calls it. This asserts the boot path DOES. (Its sibling
    //    `composeProCertEnrollment` is mocked in this file, which is exactly
    //    how a service can be built, typed, tested and unreachable.)
    runtimeMocks.composeCertStackLate.mockResolvedValue({
      tlsCertSource: undefined, tlsRenewerConfigured: false,
    });
    runtimeMocks.startHousekeepingStartup.mockResolvedValue({ scheduler: undefined });
    const options = makeOptions();
    await startPostListenerRuntime(options);
    const names = (options.backgroundServices.registerInterval as unknown as {
      mock: { calls: Array<[{ name: string }]> };
    }).mock.calls.map((c) => c[0]?.name);
    expect(names).toContain('custom-domain-enrollment');
  });

  // ── D-268 ───────────────────────────────────────────────────────────────
  it('D-268 — the boot hands the scheduler a failure-notice seam bound to the notification block', async () => {
    // ⛔ THE JOIN, NOT THE HALVES. The scheduler's own suite proves it PRODUCES
    // a notice, and the notification block's suite proves `notify` DELIVERS
    // one. Neither proves this file connects them — and a seam nothing supplies
    // is a feature that is dead on the wire while every other suite is green.
    runtimeMocks.startSchedulers.mockReturnValue({ tag: 'schedulers-bundle' });
    runtimeMocks.composeCertStackLate.mockResolvedValue({
      tlsCertSource: undefined, tlsRenewerConfigured: false,
    });
    runtimeMocks.startHousekeepingStartup.mockResolvedValue({ scheduler: undefined });
    const notify = vi.fn(async (_m: unknown) => undefined);
    const options = makeOptions({
      notificationBlock: {
        notify,
        recoverPendingAsks: vi.fn(async () => undefined),
        ask: vi.fn(async (_m: unknown, _o: unknown, _h: unknown) => ({ ask_id: 'a1' })),
        cancelAsk: vi.fn(async (_id: string) => 'not_open' as const),
        listOpenAsks: vi.fn(async () => []),
        registerAskHandler: vi.fn((_k: string, _f: unknown) => undefined),
      } as never,
    });

    await startPostListenerRuntime(options);

    const passed = runtimeMocks.startSchedulers.mock.calls[0]![0] as {
      onAutomationFailure?: (n: unknown, u: unknown) => void;
    };
    expect(passed.onAutomationFailure).toBeInstanceOf(Function);
    // And it reaches `notify` — a seam that is present but bound to nothing
    // passes the assertion above and still delivers no notification.
    passed.onAutomationFailure!({ title: 't', text: 'x' }, { kind: 'schedule', id: 's1', recipe_id: 'r' });
    expect(notify).toHaveBeenCalledWith({ title: 't', text: 'x' });
  });

  it('D-268 — a boot with no notification block supplies no seam rather than a broken one', async () => {
    runtimeMocks.startSchedulers.mockReturnValue({ tag: 'schedulers-bundle' });
    runtimeMocks.composeCertStackLate.mockResolvedValue({
      tlsCertSource: undefined, tlsRenewerConfigured: false,
    });
    runtimeMocks.startHousekeepingStartup.mockResolvedValue({ scheduler: undefined });
    const options = makeOptions();
    await startPostListenerRuntime(options);
    const passed = runtimeMocks.startSchedulers.mock.calls[0]![0] as Record<string, unknown>;
    expect(passed).not.toHaveProperty('onAutomationFailure');
  });
});
