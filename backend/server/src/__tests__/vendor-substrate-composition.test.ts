/** Vendor substrate extraction: registry, composer, and vendor boot wires. */

import BetterSqlite3 from 'better-sqlite3';
import type {
  ConnectionAuth,
  ConnectionRecord,
  ConnectionRow,
} from '@recued/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../events/bus.js';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import type { KeyManager } from '../key-manager.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import type { EngagementStore } from '../storage/engagement-store.js';
import type { EnrichmentStore } from '../storage/enrichment-store.js';
import type { ContactStore } from '../storage/contact-store.js';
import type { UpstreamMergeStore } from '../storage/upstream-merge-store.js';
import type {
  ComposeVendorSubstrateDeps,
  composeVendorSubstrate as ComposeVendorSubstrate,
} from '../composition/bin/wire-vendor-substrate.js';
import type {
  UpstreamMergeRegistry,
  VendorBootBundle,
  VendorBootDeps,
  VendorBootEntry,
  VendorRefreshAuth,
} from '../data/vendor-boot-registry.js';
import type {
  ConnectionLookup,
  VendorReconciler,
} from '../housekeeping/reconciliation/vendor-reconciler.js';
import type { VendorMergeClient } from '../data/vendor-merge.js';
import type { WireSalesforceCometDLifecycleInput } from '../data/salesforce/cometd-lifecycle.js';
import type { SalesforceCometDEvent } from '../data/salesforce/webhook-processor.js';

type ComposerImport = {
  compose: typeof ComposeVendorSubstrate;
  decodeAuthFromStorageMock: ReturnType<typeof vi.fn>;
  encodeAuthForStorageMock: ReturnType<typeof vi.fn>;
  refreshOAuth2Mock: ReturnType<typeof vi.fn>;
};

const Database = { default: BetterSqlite3 };
const NOW = Date.parse('2026-05-23T12:00:00.000Z');
const cleanups: Array<() => void> = [];

const mockedModulePaths = [
  '@recued/ingredients',
  '../connection-handler.js',
  '../data/vendor-boot-registry.js',
  '../data/hubspot/boot.js',
  '../data/salesforce/boot.js',
  '../upstream-merge-handler.js',
  '../housekeeping/reconciliation/reconciler-registry.js',
  '../housekeeping/reconciliation/vendor-reconciler.js',
  '../housekeeping/reconciliation/webhook-funnel.js',
  '../housekeeping/registry.js',
  '../data/hubspot/registration.js',
  '../data/hubspot/webhook-processor.js',
  '../data/hubspot/engagement-registration.js',
  '../data/hubspot/contact-merge-client.js',
  '../data/salesforce/registration.js',
  '../data/salesforce/webhook-processor.js',
  '../data/salesforce/cometd-lifecycle.js',
  '../data/salesforce/merge-client.js',
  '../data/salesforce/call-engagement-reconciler.js',
  '../data/vendor-merge.js',
] as const;

const keySet = (value: object): string[] => Object.keys(value).sort();

const makeDb = (): BetterSqlite3.Database => {
  const db = Database.default(':memory:');
  cleanups.push(() => db.close());
  return db;
};

const connectionStore = (): ConnectionStoreSqlite =>
  createConnectionStore(makeDb());

const warehouseBus = (): WarehouseEventBus =>
  ({ emit: vi.fn(), publish: vi.fn() }) as unknown as WarehouseEventBus;

const eventBus = (): EventBus =>
  ({ emit: vi.fn(), cursor: vi.fn(() => 0) }) as unknown as EventBus;

const engagementStore = (): EngagementStore =>
  ({ ingestEngagementWithEdges: vi.fn() }) as unknown as EngagementStore;

const enrichmentStore = (): EnrichmentStore =>
  ({ list: vi.fn(() => []) }) as unknown as EnrichmentStore;

const contactStore = (): ContactStore =>
  ({ get: vi.fn(() => null) }) as unknown as ContactStore;

const upstreamMergeStore = (): UpstreamMergeStore =>
  ({ listRecoverable: vi.fn(() => []) }) as unknown as UpstreamMergeStore;

const keyManager = (): KeyManager =>
  ({
    state: vi.fn(() => 'unlocked'),
    keyProvider: vi.fn(() => () => new Uint8Array([1, 2, 3])),
  }) as unknown as KeyManager;

const buildDeps = (
  overrides: Partial<ComposeVendorSubstrateDeps> = {},
): ComposeVendorSubstrateDeps => ({
  connectionStore: connectionStore(),
  keys: undefined,
  engagementStore: undefined,
  enrichmentStore: undefined,
  crmRecordMirror: undefined,
  contactStore: undefined,
  upstreamMergeStore: undefined,
  upstreamMergeRegistry: undefined,
  auditLog: undefined,
  warehouseBus: warehouseBus(),
  eventBus: eventBus(),
  ...overrides,
});

const buildVendorBootDeps = (
  overrides: Partial<VendorBootDeps> = {},
): VendorBootDeps => ({
  connectionStore: connectionStore(),
  engagementStore: undefined,
  enrichmentStore: undefined,
  crmRecordMirror: undefined,
  upstreamMergeRegistry: undefined,
  warehouseBus: warehouseBus(),
  lookupConnection: vi.fn(async () => null) as unknown as ConnectionLookup,
  refreshAuth: vi.fn(async () => ({ type: 'none' })) as unknown as VendorRefreshAuth,
  ...overrides,
});

const rowInput = (
  overrides: Partial<ConnectionRow> = {},
): Parameters<ConnectionStoreSqlite['upsert']>[0] => ({
  kind: 'api',
  name: 'crm',
  display_name: 'CRM',
  config_json: '{}',
  auth_ciphertext: 'stored-auth',
  enrolled_at: 1,
  updated_at: 2,
  ...overrides,
});

const connectionRecord = (
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord => ({
  name: 'crm',
  kind: 'api',
  display_name: 'CRM',
  config: {},
  auth: { type: 'none' },
  enrolled_at: 1,
  updated_at: 2,
  ...overrides,
});

const refreshableAuth = (
  overrides: Partial<Extract<ConnectionAuth, { type: 'oauth2_refresh' }>> = {},
): ConnectionAuth => ({
  type: 'oauth2_refresh',
  refresh_token: 'refresh-token',
  client_id: 'client-id',
  client_secret: 'client-secret',
  token_endpoint: 'https://auth.example.test/token',
  current_access_token: 'old-access',
  expires_at: NOW - 1,
  ...overrides,
});

const installComposerCoreMocks = (
  overrides: {
    decodedAuth?: ConnectionAuth;
    freshAuth?: ConnectionAuth;
    runtimeBase?:
      | { status: 'not_expected' }
      | { status: 'valid'; field: 'instance_url'; base_url: string }
      | { status: 'missing'; field: 'instance_url' }
      | { status: 'invalid'; field: 'instance_url'; reason: string };
  } = {},
) => {
  const decodedAuth = overrides.decodedAuth ?? { type: 'bearer', token: 'decoded-token' };
  const freshAuth = overrides.freshAuth ?? refreshableAuth({
    current_access_token: 'fresh-access',
    expires_at: NOW + 60_000,
  });

  const decodeAuthFromStorageMock = vi.fn(async () => decodedAuth);
  const encodeAuthForStorageMock = vi.fn(async () => 'encoded-fresh-auth');
  const refreshOAuth2Mock = vi.fn(async () => ({
    auth: freshAuth,
    runtime_base: overrides.runtimeBase ?? { status: 'not_expected' as const },
  }));

  vi.doMock('../connection-handler.js', () => ({
    decodeAuthFromStorage: decodeAuthFromStorageMock,
    encodeAuthForStorage: encodeAuthForStorageMock,
  }));
  vi.doMock('@recued/ingredients', () => ({
    refreshOAuth2WithMetadata: refreshOAuth2Mock,
  }));

  return {
    decodeAuthFromStorageMock,
    encodeAuthForStorageMock,
    refreshOAuth2Mock,
  };
};

const importComposerWithRegistry = async (
  entries: ReadonlyArray<VendorBootEntry> = [],
  coreOverrides: Parameters<typeof installComposerCoreMocks>[0] = {},
): Promise<ComposerImport> => {
  vi.resetModules();
  const core = installComposerCoreMocks(coreOverrides);

  vi.doMock('../data/vendor-boot-registry.js', () => ({
    VENDOR_BOOT_REGISTRY: entries,
  }));

  const mod = await import('../composition/bin/wire-vendor-substrate.js');
  return { compose: mod.composeVendorSubstrate, ...core };
};

const importComposerWithActualRegistry = async (
  options: {
    hubspotBundle?: VendorBootBundle;
    salesforceBundle?: VendorBootBundle;
  } = {},
) => {
  vi.resetModules();
  const core = installComposerCoreMocks();
  const bootHubSpotMock = vi.fn<
    (deps: VendorBootDeps) => Promise<VendorBootBundle>
  >(async () => options.hubspotBundle ?? {});
  const bootSalesforceMock = vi.fn<
    (deps: VendorBootDeps) => Promise<VendorBootBundle>
  >(async () => options.salesforceBundle ?? {});

  vi.doMock('../data/hubspot/boot.js', () => ({
    bootHubSpot: bootHubSpotMock,
  }));
  vi.doMock('../data/salesforce/boot.js', () => ({
    bootSalesforce: bootSalesforceMock,
  }));

  const mod = await import('../composition/bin/wire-vendor-substrate.js');
  return {
    compose: mod.composeVendorSubstrate,
    bootHubSpotMock,
    bootSalesforceMock,
    ...core,
  };
};

const installHousekeepingWireMocks = () => {
  const getHousekeepingTaskMock = vi.fn(() => undefined);
  const registerHousekeepingTaskMock = vi.fn();
  const unregisterHousekeepingTaskMock = vi.fn();
  const registerVendorReconcilerMock = vi.fn();
  const getDefaultReconcilerRegistryMock = vi.fn(() => ({
    listByVendor: vi.fn(() => []),
  }));
  const reconciliationTaskIdMock = vi.fn(
    (vendor: string, entity: string, name: string) => `${vendor}:${entity}:${name}`,
  );
  const buildVendorReconciliationTaskMock = vi.fn((input) => ({
    task_id: reconciliationTaskIdMock(
      input.reconciler.vendor,
      input.reconciler.entity,
      input.connection_name,
    ),
    input,
  }));

  vi.doMock('../housekeeping/registry.js', () => ({
    getHousekeepingTask: getHousekeepingTaskMock,
    registerHousekeepingTask: registerHousekeepingTaskMock,
    unregisterHousekeepingTask: unregisterHousekeepingTaskMock,
  }));
  vi.doMock('../housekeeping/reconciliation/reconciler-registry.js', () => ({
    registerVendorReconciler: registerVendorReconcilerMock,
    getDefaultReconcilerRegistry: getDefaultReconcilerRegistryMock,
  }));
  vi.doMock('../housekeeping/reconciliation/vendor-reconciler.js', () => ({
    reconciliationTaskId: reconciliationTaskIdMock,
    buildVendorReconciliationTask: buildVendorReconciliationTaskMock,
  }));

  return {
    getHousekeepingTaskMock,
    registerHousekeepingTaskMock,
    unregisterHousekeepingTaskMock,
    registerVendorReconcilerMock,
    getDefaultReconcilerRegistryMock,
    reconciliationTaskIdMock,
    buildVendorReconciliationTaskMock,
  };
};

const importHubSpotBootWithMocks = async () => {
  vi.resetModules();
  const housekeepingMocks = installHousekeepingWireMocks();
  const reconcilers = [
    { vendor: 'hubspot', entity: 'deal' },
    { vendor: 'hubspot', entity: 'contact' },
    { vendor: 'hubspot', entity: 'company' },
  ] as unknown as ReadonlyArray<VendorReconciler>;
  // D-184 — engagement reconcilers carry vendor/entity so they flow
  // through `wireHubSpotReconciliation`'s `registerVendorReconciler`
  // filter once folded into the shared reconciler array.
  const engagementSubstrate = {
    email: { vendor: 'hubspot', entity: 'email' },
    meeting: { vendor: 'hubspot', entity: 'meeting' },
    note: { vendor: 'hubspot', entity: 'note' },
    call: { vendor: 'hubspot', entity: 'call' },
    task: { vendor: 'hubspot', entity: 'task' },
  };
  const mergeClient = {
    object_type: 'hubspot:contact',
    describe: vi.fn(),
    merge: vi.fn(),
  } as unknown as VendorMergeClient;
  const buildHubSpotReconcilersMock = vi.fn<
    (input: Record<string, unknown>) => ReadonlyArray<VendorReconciler>
  >(() => reconcilers);
  const buildHubSpotWebhookProcessorMock = vi.fn((input) => ({
    processor: `hubspot:${input.entity}`,
    input,
  }));
  const buildHubSpotEngagementReconcilersMock = vi.fn<
    (input: Record<string, {
      search: { refreshAuth: VendorRefreshAuth };
      engagementStore: EngagementStore;
    }>) => typeof engagementSubstrate
  >(() => engagementSubstrate);
  const createHubSpotContactMergeClientMock = vi.fn(() => mergeClient);

  vi.doMock('../data/hubspot/registration.js', () => ({
    buildHubSpotReconcilers: buildHubSpotReconcilersMock,
  }));
  vi.doMock('../data/hubspot/webhook-processor.js', () => ({
    buildHubSpotWebhookProcessor: buildHubSpotWebhookProcessorMock,
  }));
  vi.doMock('../data/hubspot/engagement-registration.js', () => ({
    buildHubSpotEngagementReconcilers: buildHubSpotEngagementReconcilersMock,
  }));
  vi.doMock('../data/hubspot/contact-merge-client.js', () => ({
    createHubSpotContactMergeClient: createHubSpotContactMergeClientMock,
  }));

  const mod = await import('../data/hubspot/boot.js');
  return {
    bootHubSpot: mod.bootHubSpot,
    reconcilers,
    engagementSubstrate,
    mergeClient,
    buildHubSpotReconcilersMock,
    buildHubSpotWebhookProcessorMock,
    buildHubSpotEngagementReconcilersMock,
    createHubSpotContactMergeClientMock,
    ...housekeepingMocks,
  };
};

const installSalesforceInternalMocks = () => {
  const housekeepingMocks = installHousekeepingWireMocks();
  const replayIdTracker = { forgetConnection: vi.fn() };
  const reconcilers = [
    { vendor: 'salesforce', entity: 'opportunity' },
    { vendor: 'salesforce', entity: 'contact' },
    { vendor: 'salesforce', entity: 'account' },
  ] as unknown as ReadonlyArray<VendorReconciler>;
  // D-184 — engagement reconcilers carry vendor/entity so they flow
  // through `wireSalesforceReconciliation`'s `registerVendorReconciler`
  // filter once folded into the shared reconciler array.
  const engagementSubstrate = {
    task: { vendor: 'salesforce', entity: 'task' },
    event: { vendor: 'salesforce', entity: 'event' },
    email_message: { vendor: 'salesforce', entity: 'email_message' },
    webhookProcessors: new Map(),
  };
  const funnel = { handle: vi.fn(async () => ({ ok: true })) };
  const leadMergeClient = { object_type: 'salesforce:lead' } as unknown as VendorMergeClient;
  const accountMergeClient = { object_type: 'salesforce:account' } as unknown as VendorMergeClient;
  const degradedContactMergeClient = {
    object_type: 'salesforce:contact',
  } as unknown as VendorMergeClient;

  const buildSalesforceReconcilersMock = vi.fn<
    (input: Record<string, unknown>) => ReadonlyArray<VendorReconciler>
  >(() => reconcilers);
  const buildSalesforceEngagementReconcilersMock = vi.fn<
    (
      input: Record<string, {
        search?: { refreshAuth: VendorRefreshAuth };
        engagementStore: EngagementStore;
      }>,
      store: EngagementStore,
    ) => typeof engagementSubstrate
  >(() => engagementSubstrate);
  const createInMemoryReplayIdTrackerMock = vi.fn(() => replayIdTracker);
  const cometDLifecycle = { stopAll: vi.fn(async () => {}) };
  const wireSalesforceCometDLifecycleMock = vi.fn(
    (_input: WireSalesforceCometDLifecycleInput) => cometDLifecycle,
  );
  const createWebhookFunnelMock = vi.fn(() => funnel);
  const createSalesforceMergeClientMock = vi.fn((objectType) =>
    objectType === 'salesforce:lead' ? leadMergeClient : accountMergeClient,
  );
  const SalesforceCallEngagementReconcilerMock = vi.fn(function SalesforceCallEngagementReconciler(
    this: Record<string, unknown>,
    deps: Record<string, unknown>,
  ) {
    this.deps = deps;
    this.vendor = 'salesforce';
    this.entity = deps.callEntity;
  });

  vi.doMock('../data/salesforce/registration.js', () => ({
    buildSalesforceReconcilers: buildSalesforceReconcilersMock,
    buildSalesforceEngagementReconcilers: buildSalesforceEngagementReconcilersMock,
  }));
  vi.doMock('../data/salesforce/webhook-processor.js', () => ({
    createInMemoryReplayIdTracker: createInMemoryReplayIdTrackerMock,
  }));
  vi.doMock('../data/salesforce/cometd-lifecycle.js', () => ({
    wireSalesforceCometDLifecycle: wireSalesforceCometDLifecycleMock,
  }));
  vi.doMock('../housekeeping/reconciliation/webhook-funnel.js', () => ({
    createWebhookFunnel: createWebhookFunnelMock,
  }));
  vi.doMock('../data/salesforce/merge-client.js', () => ({
    createSalesforceMergeClient: createSalesforceMergeClientMock,
  }));
  vi.doMock('../data/vendor-merge.js', () => ({
    SALESFORCE_CONTACT_DEGRADED: degradedContactMergeClient,
  }));
  vi.doMock('../data/salesforce/call-engagement-reconciler.js', () => ({
    SalesforceCallEngagementReconciler: SalesforceCallEngagementReconcilerMock,
  }));

  return {
    replayIdTracker,
    cometDLifecycle,
    reconcilers,
    engagementSubstrate,
    funnel,
    leadMergeClient,
    accountMergeClient,
    degradedContactMergeClient,
    buildSalesforceReconcilersMock,
    buildSalesforceEngagementReconcilersMock,
    createInMemoryReplayIdTrackerMock,
    wireSalesforceCometDLifecycleMock,
    createWebhookFunnelMock,
    createSalesforceMergeClientMock,
    SalesforceCallEngagementReconcilerMock,
    ...housekeepingMocks,
  };
};

const importSalesforceBootWithMocks = async () => {
  vi.resetModules();
  const mocks = installSalesforceInternalMocks();
  const mod = await import('../data/salesforce/boot.js');
  return {
    bootSalesforce: mod.bootSalesforce,
    ...mocks,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of mockedModulePaths) {
    vi.doUnmock(path);
  }
  vi.resetModules();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('VENDOR_BOOT_REGISTRY shape and lazy loading', () => {
  it('exports the canonical HubSpot and Salesforce boot entries', async () => {
    vi.resetModules();
    const mod = await import('../data/vendor-boot-registry.js');
    const entries: ReadonlyArray<VendorBootEntry> = mod.VENDOR_BOOT_REGISTRY;

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.map((entry) => entry.slug)).toEqual(['hubspot', 'salesforce']);
    expect(entries.map((entry) => typeof entry.boot)).toEqual(['function', 'function']);
  });

  it('each boot entry returns a promise when invoked', async () => {
    vi.resetModules();
    const bootHubSpotMock = vi.fn(async () => ({}));
    const bootSalesforceMock = vi.fn(async () => ({}));
    vi.doMock('../data/hubspot/boot.js', () => ({
      bootHubSpot: bootHubSpotMock,
    }));
    vi.doMock('../data/salesforce/boot.js', () => ({
      bootSalesforce: bootSalesforceMock,
    }));

    const { VENDOR_BOOT_REGISTRY } = await import('../data/vendor-boot-registry.js');
    const deps = buildVendorBootDeps();

    const promises = VENDOR_BOOT_REGISTRY.map((entry) => entry.boot(deps));
    expect(promises.every((promise) => promise instanceof Promise)).toBe(true);
    await Promise.all(promises);
    expect(bootHubSpotMock).toHaveBeenCalledTimes(1);
    expect(bootSalesforceMock).toHaveBeenCalledTimes(1);
  });

  it('does not import vendor boot modules until each boot thunk is called', async () => {
    vi.resetModules();
    const hubspotModuleLoaded = vi.fn();
    const salesforceModuleLoaded = vi.fn();
    const bootHubSpotMock = vi.fn(async () => ({}));
    const bootSalesforceMock = vi.fn(async () => ({}));

    vi.doMock('../data/hubspot/boot.js', () => {
      hubspotModuleLoaded();
      return { bootHubSpot: bootHubSpotMock };
    });
    vi.doMock('../data/salesforce/boot.js', () => {
      salesforceModuleLoaded();
      return { bootSalesforce: bootSalesforceMock };
    });

    const { VENDOR_BOOT_REGISTRY } = await import('../data/vendor-boot-registry.js');
    expect(hubspotModuleLoaded).not.toHaveBeenCalled();
    expect(salesforceModuleLoaded).not.toHaveBeenCalled();

    const deps = buildVendorBootDeps();
    await VENDOR_BOOT_REGISTRY[0]!.boot(deps);
    expect(hubspotModuleLoaded).toHaveBeenCalledTimes(1);
    expect(salesforceModuleLoaded).not.toHaveBeenCalled();

    await VENDOR_BOOT_REGISTRY[1]!.boot(deps);
    expect(salesforceModuleLoaded).toHaveBeenCalledTimes(1);
    expect(bootHubSpotMock).toHaveBeenCalledWith(deps);
    expect(bootSalesforceMock).toHaveBeenCalledWith(deps);
  });
});

describe('composeVendorSubstrate substrate construction', () => {
  it('always returns lookupConnection and refreshAuth', async () => {
    const { compose } = await importComposerWithRegistry();
    const bundle = await compose(buildDeps());

    expect(keySet(bundle)).toEqual([
      'lookupConnection',
      'refreshAuth',
    ]);
    expect(bundle.lookupConnection).toEqual(expect.any(Function));
    expect(bundle.refreshAuth).toEqual(expect.any(Function));
  });

  it('omits registerSalesforceCallEntity when no vendor surfaces one', async () => {
    const { compose } = await importComposerWithActualRegistry({
      hubspotBundle: {},
      salesforceBundle: {},
    });
    const bundle = await compose(buildDeps());

    expect('registerSalesforceCallEntity' in bundle).toBe(false);
  });

  it('lookupConnection returns decoded records with conditional row fields', async () => {
    const decodedAuth: ConnectionAuth = { type: 'bearer', token: 'decoded' };
    const store = connectionStore();
    store.upsert(rowInput({
      subtype: 'hubspot',
      publisher_id: 'publisher-1',
      config_json: '{"vendor":"hubspot","base_url":"https://api.example.test"}',
      auth_ciphertext: 'ciphertext-1',
      enrolled_at: 10,
      updated_at: 20,
      last_used_at: 30,
      health_json: '{"status":"ok","last_probed_at":25}',
    }));
    const { compose, decodeAuthFromStorageMock } = await importComposerWithRegistry(
      [],
      { decodedAuth },
    );

    const bundle = await compose(buildDeps({ connectionStore: store }));
    await expect(bundle.lookupConnection('crm')).resolves.toEqual({
      name: 'crm',
      kind: 'api',
      subtype: 'hubspot',
      display_name: 'CRM',
      publisher_id: 'publisher-1',
      config: { vendor: 'hubspot', base_url: 'https://api.example.test' },
      auth: decodedAuth,
      enrolled_at: 10,
      updated_at: 20,
      last_used_at: 30,
    });
    expect(decodeAuthFromStorageMock).toHaveBeenCalledWith(
      'ciphertext-1',
      { kind: 'api', name: 'crm' },
      undefined,
    );
  });

  it('lookupConnection returns null for a missing api row', async () => {
    const { compose, decodeAuthFromStorageMock } = await importComposerWithRegistry();
    const bundle = await compose(buildDeps());

    await expect(bundle.lookupConnection('missing')).resolves.toBeNull();
    expect(decodeAuthFromStorageMock).not.toHaveBeenCalled();
  });

  it('lookupConnection treats malformed config_json as an empty config object', async () => {
    const decodedAuth: ConnectionAuth = { type: 'bearer', token: 'decoded' };
    const store = connectionStore();
    store.upsert(rowInput({ config_json: '{not-json' }));
    const { compose } = await importComposerWithRegistry([], { decodedAuth });

    const bundle = await compose(buildDeps({ connectionStore: store }));
    await expect(bundle.lookupConnection('crm')).resolves.toEqual(
      expect.objectContaining({ config: {}, auth: decodedAuth }),
    );
  });

  it('lookupConnection threads a live key provider whenever a key manager exists', async () => {
    const keys = keyManager();
    const store = connectionStore();
    store.upsert(rowInput({ auth_ciphertext: 'ciphertext-with-key' }));
    const { compose, decodeAuthFromStorageMock } = await importComposerWithRegistry();

    const bundle = await compose(buildDeps({ connectionStore: store, keys }));
    await bundle.lookupConnection('crm');

    // Not gated on `keys.state()` — a compose-time gate kept a new server's
    // first session key-less (driven live 2026-10-08).
    expect(keys.keyProvider).toHaveBeenCalledWith('connection');
    expect(decodeAuthFromStorageMock.mock.calls[0]![2]).toBe(
      (keys.keyProvider as ReturnType<typeof vi.fn>).mock.results[0]!.value,
    );
  });

  /** `refreshAuth` used to THROW "cannot refresh" on a non-oauth2 auth. `f8b81dc92`
   *  ("generic auth→bearer seam — HubSpot Service Key support") deliberately made it
   *  a pass-through: a static credential has nothing to refresh, so a vendor client's
   *  single-shot-refresh-on-401 degrades to "retry with the same token, then surface
   *  the honest 401" instead of masking a rotated key behind an unhelpful throw.
   *
   *  ⚠ The refusal was MOVED, not lost, and it moved somewhere strictly better. No
   *  caller uses this return value as evidence of a valid credential: every one
   *  funnels it through `resolveBearerAccessToken` FIRST — `describe-probe.ts:418`
   *  and `_hubspot-search.ts:269` throw `*AuthExpiredError`, both merge clients
   *  return `vendor_auth_expired` — and that resolver yields undefined for every
   *  non-bearer-yielding shape (pinned at `d-125-phase-1-1-connection.test.ts:335`
   *  for `{type:'none'}`). So a connection that cannot produce a token fails closed
   *  at the POINT OF USE, on the FIRST request, rather than only on the 401 retry
   *  path the old throw guarded. What this test must hold is the narrower promise:
   *  the pass-through neither runs the OAuth dance nor restamps the stored row. */
  it('refreshAuth passes a non-oauth2_refresh auth through untouched — no OAuth dance, no row rewrite', async () => {
    const store = connectionStore();
    const upsertSpy = vi.spyOn(store, 'upsert');
    const { compose, refreshOAuth2Mock, encodeAuthForStorageMock } =
      await importComposerWithRegistry();
    const bundle = await compose(buildDeps({ connectionStore: store }));

    // `none` (nothing to present) and a static `bearer` (a HubSpot Service Key —
    // the credential this change exists for) must degrade identically.
    for (const auth of [
      { type: 'none' } as const,
      { type: 'bearer', token: 'pat-na1-service-key' } as const,
    ]) {
      await expect(bundle.refreshAuth(connectionRecord({ auth })))
        .resolves.toEqual(auth);
    }

    expect(refreshOAuth2Mock).not.toHaveBeenCalled();
    expect(encodeAuthForStorageMock).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('refreshAuth refreshes, re-encodes, and upserts every present optional row field', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const freshAuth = refreshableAuth({ current_access_token: 'fresh-access' });
    const store = connectionStore();
    store.upsert(rowInput({
      subtype: 'salesforce',
      publisher_id: 'publisher-1',
      health_json: '{"status":"ok","last_probed_at":11}',
      last_used_at: 99,
    }));
    const upsertSpy = vi.spyOn(store, 'upsert');
    const { compose, refreshOAuth2Mock, encodeAuthForStorageMock } =
      await importComposerWithRegistry([], { freshAuth });

    const bundle = await compose(buildDeps({ connectionStore: store }));
    await expect(bundle.refreshAuth(connectionRecord({
      auth: refreshableAuth({ current_access_token: 'old-access' }),
    }))).resolves.toBe(freshAuth);

    expect(refreshOAuth2Mock).toHaveBeenCalledTimes(1);
    expect(refreshOAuth2Mock.mock.calls[0]![2]()).toBe(NOW);
    expect(encodeAuthForStorageMock).toHaveBeenCalledWith(
      freshAuth,
      { kind: 'api', name: 'crm' },
      undefined,
    );
    expect(upsertSpy).toHaveBeenCalledWith({
      kind: 'api',
      name: 'crm',
      subtype: 'salesforce',
      display_name: 'CRM',
      publisher_id: 'publisher-1',
      config_json: '{}',
      auth_ciphertext: 'encoded-fresh-auth',
      enrolled_at: 1,
      updated_at: NOW,
      last_used_at: 99,
      health_json: '{"status":"ok","last_probed_at":11}',
    });
  });

  it('refreshAuth atomically carries a validated Salesforce instance change into config_json', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const store = connectionStore();
    store.upsert(rowInput({
      config_json: JSON.stringify({
        vendor: 'salesforce',
        base_url: 'https://old.my.salesforce.com',
        cadence: '6h',
      }),
    }));
    const upsertSpy = vi.spyOn(store, 'upsert');
    const { compose, refreshOAuth2Mock } = await importComposerWithRegistry([], {
      runtimeBase: {
        status: 'valid',
        field: 'instance_url',
        base_url: 'https://new.my.salesforce.com',
      },
    });

    const bundle = await compose(buildDeps({ connectionStore: store }));
    await bundle.refreshAuth(connectionRecord({
      config: {
        vendor: 'salesforce',
        base_url: 'https://old.my.salesforce.com',
        cadence: '6h',
      },
      auth: refreshableAuth(),
    }));

    expect(refreshOAuth2Mock.mock.calls[0]?.[3]).toMatchObject({ vendor: 'salesforce' });
    const config = JSON.parse(upsertSpy.mock.calls[0]![0].config_json) as Record<string, unknown>;
    expect(config).toEqual({
      vendor: 'salesforce',
      base_url: 'https://new.my.salesforce.com',
      cadence: '6h',
    });
  });

  it('refreshAuth audits an ignored Salesforce instance without losing rotated auth', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const store = connectionStore();
    store.upsert(rowInput({
      config_json: JSON.stringify({
        vendor: 'salesforce',
        base_url: 'https://known.my.salesforce.com',
      }),
    }));
    const logActivity = vi.fn(async () => undefined);
    const upsertSpy = vi.spyOn(store, 'upsert');
    const { compose } = await importComposerWithRegistry([], {
      runtimeBase: {
        status: 'invalid',
        field: 'instance_url',
        reason: 'host is outside the provider allowlist',
      },
    });

    const bundle = await compose(buildDeps({
      connectionStore: store,
      auditLog: { logActivity },
    }));
    await bundle.refreshAuth(connectionRecord({
      config: {
        vendor: 'salesforce',
        base_url: 'https://known.my.salesforce.com',
      },
      auth: refreshableAuth(),
    }));

    const persisted = upsertSpy.mock.calls[0]![0];
    expect(JSON.parse(persisted.config_json).base_url)
      .toBe('https://known.my.salesforce.com');
    expect(persisted.auth_ciphertext).toBe('encoded-fresh-auth');
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({
      timestamp: NOW,
      action: 'connection_runtime_base_refresh_ignored',
      detail: JSON.stringify({
        kind: 'api',
        vendor: 'salesforce',
        status: 'invalid',
        field: 'instance_url',
        reason: 'host is outside the provider allowlist',
      }),
    }));
  });

  it('refreshAuth omits every absent optional row field from the upsert shape', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const store = connectionStore();
    store.upsert(rowInput());
    const upsertSpy = vi.spyOn(store, 'upsert');
    const { compose } = await importComposerWithRegistry();

    const bundle = await compose(buildDeps({ connectionStore: store }));
    await bundle.refreshAuth(connectionRecord({ auth: refreshableAuth() }));

    const upsertInput = upsertSpy.mock.calls[0]![0];
    expect(upsertInput).toEqual({
      kind: 'api',
      name: 'crm',
      display_name: 'CRM',
      config_json: '{}',
      auth_ciphertext: 'encoded-fresh-auth',
      enrolled_at: 1,
      updated_at: NOW,
    });
    expect('subtype' in upsertInput).toBe(false);
    expect('publisher_id' in upsertInput).toBe(false);
    expect('last_used_at' in upsertInput).toBe(false);
    expect('health_json' in upsertInput).toBe(false);
  });
});

describe('composeVendorSubstrate registry iteration', () => {
  it('calls every vendor boot once in registry order with shared substrate identities', async () => {
    const { compose, bootHubSpotMock, bootSalesforceMock } =
      await importComposerWithActualRegistry();
    const deps = buildDeps();
    const bundle = await compose(deps);

    expect(bootHubSpotMock).toHaveBeenCalledTimes(1);
    expect(bootSalesforceMock).toHaveBeenCalledTimes(1);
    expect(bootHubSpotMock.mock.invocationCallOrder[0]).toBeLessThan(
      bootSalesforceMock.mock.invocationCallOrder[0]!,
    );
    const hubspotDeps = bootHubSpotMock.mock.calls[0]![0];
    const salesforceDeps = bootSalesforceMock.mock.calls[0]![0];
    expect(hubspotDeps.lookupConnection).toBe(salesforceDeps.lookupConnection);
    expect(hubspotDeps.refreshAuth).toBe(salesforceDeps.refreshAuth);
    expect(hubspotDeps.lookupConnection).toBe(bundle.lookupConnection);
    expect(hubspotDeps.refreshAuth).toBe(bundle.refreshAuth);
  });

  it('keeps the bundle hook undefined when HubSpot returns an empty bundle', async () => {
    const { compose, bootHubSpotMock } = await importComposerWithActualRegistry({
      hubspotBundle: {},
      salesforceBundle: {},
    });

    const bundle = await compose(buildDeps());

    expect(bootHubSpotMock).toHaveReturned();
    expect(bundle.registerSalesforceCallEntity).toBeUndefined();
  });

  it('aggregates the Salesforce call-entity hook surfaced by Salesforce boot', async () => {
    const registerSalesforceCallEntity = vi.fn();
    const { compose } = await importComposerWithActualRegistry({
      hubspotBundle: {},
      salesforceBundle: { registerSalesforceCallEntity },
    });

    const bundle = await compose(buildDeps());

    expect(bundle.registerSalesforceCallEntity).toBe(registerSalesforceCallEntity);
  });

  it('aggregates vendor drains in reverse order and coalesces repeated stop calls', async () => {
    let releaseSalesforce!: () => void;
    const hubspotStop = vi.fn(async () => {});
    const salesforceStop = vi.fn(() =>
      new Promise<void>((resolve) => {
        releaseSalesforce = resolve;
      }));
    const { compose } = await importComposerWithActualRegistry({
      hubspotBundle: { stop: hubspotStop },
      salesforceBundle: { stop: salesforceStop },
    });
    const bundle = await compose(buildDeps());

    const first = bundle.stop!();
    const second = bundle.stop!();
    expect(second).toBe(first);
    expect(salesforceStop).toHaveBeenCalledTimes(1);
    expect(hubspotStop).toHaveBeenCalledTimes(1);
    expect(salesforceStop.mock.invocationCallOrder[0]).toBeLessThan(
      hubspotStop.mock.invocationCallOrder[0]!,
    );

    releaseSalesforce();
    await first;
  });

  it('attempts every vendor drain before surfacing aggregate failure', async () => {
    const hubspotStop = vi.fn(async () => {
      throw new Error('hubspot-stop-failed');
    });
    const salesforceStop = vi.fn(async () => {
      throw new Error('salesforce-stop-failed');
    });
    const { compose } = await importComposerWithActualRegistry({
      hubspotBundle: { stop: hubspotStop },
      salesforceBundle: { stop: salesforceStop },
    });
    const bundle = await compose(buildDeps());

    await expect(bundle.stop!()).rejects.toThrow(
      'one or more vendor background services failed to stop',
    );
    expect(hubspotStop).toHaveBeenCalledTimes(1);
    expect(salesforceStop).toHaveBeenCalledTimes(1);
  });
});

describe('composeVendorSubstrate vendor boot deps passing', () => {
  it('passes the expected shared deps subset to each vendor by reference', async () => {
    const { compose, bootHubSpotMock, bootSalesforceMock } =
      await importComposerWithActualRegistry();
    const deps = buildDeps({
      engagementStore: engagementStore(),
      enrichmentStore: enrichmentStore(),
      upstreamMergeRegistry: new Map(),
    });

    await compose(deps);

    for (const bootMock of [bootHubSpotMock, bootSalesforceMock]) {
      const bootDeps = bootMock.mock.calls[0]![0];
      expect(keySet(bootDeps)).toEqual([
        'connectionStore',
        'crmRecordMirror',
        'engagementStore',
        'enrichmentStore',
        'lookupConnection',
        'refreshAuth',
        'upstreamMergeRegistry',
        'warehouseBus',
      ]);
      expect(bootDeps.connectionStore).toBe(deps.connectionStore);
      expect(bootDeps.crmRecordMirror).toBe(deps.crmRecordMirror);
      expect(bootDeps.engagementStore).toBe(deps.engagementStore);
      expect(bootDeps.enrichmentStore).toBe(deps.enrichmentStore);
      expect(bootDeps.upstreamMergeRegistry).toBe(deps.upstreamMergeRegistry);
      expect(bootDeps.warehouseBus).toBe(deps.warehouseBus);
      expect(bootDeps.lookupConnection).toEqual(expect.any(Function));
      expect(bootDeps.refreshAuth).toEqual(expect.any(Function));
    }
  });
});

describe('composeVendorSubstrate upstream-merge boot recovery sweep', () => {
  it('runs the sweep when upstream store, registry, and contact store are all wired', async () => {
    const upstreamMergeModuleLoaded = vi.fn();
    const runUpstreamMergeRecoverySweepMock = vi.fn<
      (deps: unknown, pickConnectionName: unknown) => Promise<void>
    >(async () => undefined);
    vi.resetModules();
    vi.doMock('../upstream-merge-handler.js', () => {
      upstreamMergeModuleLoaded();
      return { runUpstreamMergeRecoverySweep: runUpstreamMergeRecoverySweepMock };
    });
    const { compose } = await importComposerWithRegistry();
    const mergeStore = upstreamMergeStore();
    const registry = new Map() as UpstreamMergeRegistry;
    const contacts = contactStore();
    const bus = eventBus();

    await compose(buildDeps({
      upstreamMergeStore: mergeStore,
      upstreamMergeRegistry: registry,
      contactStore: contacts,
      eventBus: bus,
    }));

    expect(upstreamMergeModuleLoaded).toHaveBeenCalledTimes(1);
    expect(runUpstreamMergeRecoverySweepMock).toHaveBeenCalledTimes(1);
    expect(runUpstreamMergeRecoverySweepMock.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        store: mergeStore,
        vendorMergers: registry,
        contactStore: contacts,
        eventBus: bus,
      }),
    );
  });

  it('publishes a stop hook that waits for the admitted recovery sweep', async () => {
    let releaseSweep!: () => void;
    const runUpstreamMergeRecoverySweepMock = vi.fn(() =>
      new Promise<void>((resolve) => {
        releaseSweep = resolve;
      }));
    vi.resetModules();
    vi.doMock('../upstream-merge-handler.js', () => ({
      runUpstreamMergeRecoverySweep: runUpstreamMergeRecoverySweepMock,
    }));
    const { compose } = await importComposerWithRegistry();
    const bundle = await compose(buildDeps({
      upstreamMergeStore: upstreamMergeStore(),
      upstreamMergeRegistry: new Map(),
      contactStore: contactStore(),
    }));

    expect(bundle.stop).toEqual(expect.any(Function));
    let stopped = false;
    const stopping = bundle.stop!().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseSweep();
    await stopping;
    expect(stopped).toBe(true);
  });

  it.each([
    ['upstreamMergeStore', { upstreamMergeStore: undefined }],
    ['upstreamMergeRegistry', { upstreamMergeRegistry: undefined }],
    ['contactStore', { contactStore: undefined }],
  ] as const)('skips the sweep import when %s is missing', async (_name, missing) => {
    const upstreamMergeModuleLoaded = vi.fn();
    const runUpstreamMergeRecoverySweepMock = vi.fn<
      (deps: unknown, pickConnectionName: unknown) => Promise<void>
    >(async () => undefined);
    vi.resetModules();
    vi.doMock('../upstream-merge-handler.js', () => {
      upstreamMergeModuleLoaded();
      return { runUpstreamMergeRecoverySweep: runUpstreamMergeRecoverySweepMock };
    });
    const { compose } = await importComposerWithRegistry();

    await compose(buildDeps({
      upstreamMergeStore: upstreamMergeStore(),
      upstreamMergeRegistry: new Map(),
      contactStore: contactStore(),
      ...missing,
    }));

    expect(upstreamMergeModuleLoaded).not.toHaveBeenCalled();
    expect(runUpstreamMergeRecoverySweepMock).not.toHaveBeenCalled();
  });
});

describe('bootHubSpot behavior', () => {
  it('folds five HubSpot engagement reconcilers into the shared reconciler array when engagementStore is wired', async () => {
    const boot = await importHubSpotBootWithMocks();
    const store = engagementStore();
    const refreshAuth = vi.fn(async () => refreshableAuth()) as unknown as VendorRefreshAuth;

    await boot.bootHubSpot(buildVendorBootDeps({
      engagementStore: store,
      refreshAuth,
    }));

    expect(boot.buildHubSpotEngagementReconcilersMock).toHaveBeenCalledTimes(1);
    const engagementInput = boot.buildHubSpotEngagementReconcilersMock.mock.calls[0]![0];
    for (const entity of ['email', 'meeting', 'note', 'call', 'task'] as const) {
      expect(engagementInput[entity].engagementStore).toBe(store);
      expect(engagementInput[entity].search.refreshAuth).toBe(refreshAuth);
    }
    // D-184 — the 5 engagement reconcilers join the CRM trio (3) in the
    // reconciler array passed to wireHubSpotReconciliation, so all 8 get
    // registered into the default vendor registry. No runonce registration.
    expect(boot.registerVendorReconcilerMock).toHaveBeenCalledTimes(8);
  });

  it('does not build HubSpot engagement reconcilers when engagementStore is absent', async () => {
    const boot = await importHubSpotBootWithMocks();

    await boot.bootHubSpot(buildVendorBootDeps({ engagementStore: undefined }));

    expect(boot.buildHubSpotEngagementReconcilersMock).not.toHaveBeenCalled();
    // Only the CRM trio is registered.
    expect(boot.registerVendorReconcilerMock).toHaveBeenCalledTimes(3);
  });

  it('registers the HubSpot contact merge client when upstreamMergeRegistry is wired', async () => {
    const boot = await importHubSpotBootWithMocks();
    const refreshAuth = vi.fn(async () => refreshableAuth()) as unknown as VendorRefreshAuth;
    const registry = new Map() as UpstreamMergeRegistry;

    await boot.bootHubSpot(buildVendorBootDeps({
      refreshAuth,
      upstreamMergeRegistry: registry,
    }));

    expect(boot.createHubSpotContactMergeClientMock).toHaveBeenCalledWith({
      refreshAuth,
    });
    expect(registry.get('hubspot:contact')).toBe(boot.mergeClient);
  });

  it('does not create a HubSpot merge client when upstreamMergeRegistry is absent', async () => {
    const boot = await importHubSpotBootWithMocks();

    await boot.bootHubSpot(buildVendorBootDeps({ upstreamMergeRegistry: undefined }));

    expect(boot.createHubSpotContactMergeClientMock).not.toHaveBeenCalled();
  });

  it('always builds HubSpot reconcilers, webhook processors, and reconciliation observers', async () => {
    const boot = await importHubSpotBootWithMocks();
    const store = connectionStore();
    const addOnUpsertSpy = vi.spyOn(store, 'addOnUpsert');
    const addOnDeleteSpy = vi.spyOn(store, 'addOnDelete');
    const lookupConnection = vi.fn(async () => null) as unknown as ConnectionLookup;
    const refreshAuth = vi.fn(async () => refreshableAuth()) as unknown as VendorRefreshAuth;

    await boot.bootHubSpot(buildVendorBootDeps({
      connectionStore: store,
      lookupConnection,
      refreshAuth,
    }));

    expect(boot.buildHubSpotWebhookProcessorMock.mock.calls.map((call) => call[0].entity))
      .toEqual(['deal', 'contact', 'company']);
    for (const call of boot.buildHubSpotWebhookProcessorMock.mock.calls) {
      expect(call[0].lookupConnection).toBe(lookupConnection);
      expect(call[0].search.refreshAuth).toBe(refreshAuth);
    }
    expect(boot.buildHubSpotReconcilersMock).toHaveBeenCalledTimes(1);
    expect(boot.registerVendorReconcilerMock).toHaveBeenCalledTimes(3);
    expect(addOnUpsertSpy).toHaveBeenCalledTimes(1);
    expect(addOnDeleteSpy).toHaveBeenCalledTimes(1);
  });
});

describe('bootSalesforce behavior', () => {
  it('folds three Salesforce engagement reconcilers into the shared array and returns the call-entity hook', async () => {
    const boot = await importSalesforceBootWithMocks();
    const store = engagementStore();

    const bundle = await boot.bootSalesforce(buildVendorBootDeps({
      engagementStore: store,
    }));

    expect(boot.buildSalesforceEngagementReconcilersMock).toHaveBeenCalledTimes(1);
    const engagementInput = boot.buildSalesforceEngagementReconcilersMock.mock.calls[0]![0];
    for (const entity of ['task', 'event', 'email_message'] as const) {
      expect(engagementInput[entity].engagementStore).toBe(store);
    }
    // D-184 — the 3 engagement reconcilers join the Sales Cloud trio (3) in
    // the reconciler array passed to wireSalesforceReconciliation, so all 6
    // get registered into the default vendor registry. No runonce registration.
    expect(boot.registerVendorReconcilerMock).toHaveBeenCalledTimes(6);
    expect(bundle.registerSalesforceCallEntity).toEqual(expect.any(Function));
  });

  it('returns an empty Salesforce bundle and no call-entity hook when engagementStore is absent', async () => {
    const boot = await importSalesforceBootWithMocks();

    const bundle = await boot.bootSalesforce(buildVendorBootDeps({
      engagementStore: undefined,
    }));

    expect(bundle).toEqual({});
    expect(boot.buildSalesforceEngagementReconcilersMock).not.toHaveBeenCalled();
    // Only the Sales Cloud trio is registered.
    expect(boot.registerVendorReconcilerMock).toHaveBeenCalledTimes(3);
  });

  it('deregisters both call-entity task ids on connection delete (D-184 cleanup)', async () => {
    const boot = await importSalesforceBootWithMocks();
    const store = connectionStore();
    const addOnDeleteSpy = vi.spyOn(store, 'addOnDelete');

    await boot.bootSalesforce(buildVendorBootDeps({
      connectionStore: store,
      engagementStore: engagementStore(),
    }));

    // Two delete observers when engagementStore is wired: the reconciliation
    // wire's (static array) + the D-184 call-entity cleanup observer.
    expect(addOnDeleteSpy).toHaveBeenCalledTimes(2);
    // Fire every registered delete observer for an api-connection deletion.
    for (const call of addOnDeleteSpy.mock.calls) {
      (call[0] as (kind: string, name: string) => void)('api', 'acme-salesforce');
    }
    expect(boot.unregisterHousekeepingTaskMock).toHaveBeenCalledWith(
      'salesforce:voice_call:acme-salesforce',
    );
    expect(boot.unregisterHousekeepingTaskMock).toHaveBeenCalledWith(
      'salesforce:call_history:acme-salesforce',
    );
  });

  it('registers a call-entity housekeeping task after boot using the captured refreshAuth and engagementStore', async () => {
    const boot = await importSalesforceBootWithMocks();
    const store = engagementStore();
    const refreshAuth = vi.fn(async () => refreshableAuth()) as unknown as VendorRefreshAuth;
    const lookupConnection = vi.fn(async () => null) as unknown as ConnectionLookup;
    const bundle = await boot.bootSalesforce(buildVendorBootDeps({
      engagementStore: store,
      refreshAuth,
      lookupConnection,
    }));
    boot.SalesforceCallEngagementReconcilerMock.mockClear();
    boot.buildVendorReconciliationTaskMock.mockClear();
    boot.registerHousekeepingTaskMock.mockClear();

    const connection = { name: 'acme-salesforce' } as unknown as Parameters<
      NonNullable<typeof bundle.registerSalesforceCallEntity>
    >[0]['connection'];
    bundle.registerSalesforceCallEntity!({ connection, winner: 'voice_call', prior: null });

    // D-184 — the hook builds the winning call reconciler + registers its
    // housekeeping task for the connection (no runonce runner).
    expect(boot.SalesforceCallEngagementReconcilerMock).toHaveBeenCalledTimes(1);
    expect(boot.SalesforceCallEngagementReconcilerMock.mock.calls[0]![0]).toEqual({
      search: { refreshAuth },
      engagementStore: store,
      authorship: {},
      callEntity: 'voice_call',
    });
    expect(boot.buildVendorReconciliationTaskMock).toHaveBeenCalledWith({
      reconciler: boot.SalesforceCallEngagementReconcilerMock.mock.instances[0],
      connection_name: 'acme-salesforce',
      lookupConnection,
    });
    expect(boot.registerHousekeepingTaskMock).toHaveBeenCalledTimes(1);
  });

  it('wires Salesforce CometD lifecycle and funnel when enrichmentStore is wired', async () => {
    const boot = await importSalesforceBootWithMocks();
    const enrichments = enrichmentStore();
    const bus = warehouseBus();
    const store = connectionStore();
    store.upsert(rowInput({
      name: 'sf',
      subtype: 'salesforce',
      config_json: '{"vendor":"salesforce","base_url":"https://sf.example.test"}',
    }));

    const bundle = await boot.bootSalesforce(buildVendorBootDeps({
      connectionStore: store,
      enrichmentStore: enrichments,
      warehouseBus: bus,
    }));

    expect(boot.createWebhookFunnelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        registry: expect.any(Object),
        enrichmentStore: enrichments,
        bus,
      }),
    );
    expect(boot.wireSalesforceCometDLifecycleMock).toHaveBeenCalledTimes(1);
    expect(bundle.stop).toEqual(expect.any(Function));
    await bundle.stop!();
    expect(boot.cometDLifecycle.stopAll).toHaveBeenCalledTimes(1);
    const lifecycleInput = boot.wireSalesforceCometDLifecycleMock.mock.calls[0]![0];
    expect(lifecycleInput.replayIdTracker).toBe(boot.replayIdTracker);
    const event: SalesforceCometDEvent = {
      channel: '/topic/RecuedOpportunityFeed',
      data: {
        event: { type: 'updated', replayId: 42 },
        sobject: { Id: '006A0000005XYZAB' },
      },
    };
    await lifecycleInput.onEvent(event, 'sf');
    expect(boot.funnel.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: 'salesforce',
        connection_name: 'sf',
        payload: event,
        headers: {},
        rawBody: expect.any(Buffer),
      }),
    );
  });

  it('skips Salesforce CometD lifecycle and funnel when enrichmentStore is absent', async () => {
    const boot = await importSalesforceBootWithMocks();

    await boot.bootSalesforce(buildVendorBootDeps({ enrichmentStore: undefined }));

    expect(boot.createWebhookFunnelMock).not.toHaveBeenCalled();
    expect(boot.wireSalesforceCometDLifecycleMock).not.toHaveBeenCalled();
  });

  it('registers all Salesforce upstream merge clients when registry is wired', async () => {
    const boot = await importSalesforceBootWithMocks();
    const refreshAuth = vi.fn(async () => refreshableAuth()) as unknown as VendorRefreshAuth;
    const registry = new Map() as UpstreamMergeRegistry;

    await boot.bootSalesforce(buildVendorBootDeps({
      refreshAuth,
      upstreamMergeRegistry: registry,
    }));

    expect(boot.createSalesforceMergeClientMock).toHaveBeenCalledWith(
      'salesforce:lead',
      { refreshAuth },
    );
    expect(boot.createSalesforceMergeClientMock).toHaveBeenCalledWith(
      'salesforce:account',
      { refreshAuth },
    );
    expect(registry.get('salesforce:lead')).toBe(boot.leadMergeClient);
    expect(registry.get('salesforce:account')).toBe(boot.accountMergeClient);
    expect(registry.get('salesforce:contact')).toBe(boot.degradedContactMergeClient);
  });

  it('always wires Salesforce reconciliation and replayId tracking', async () => {
    const boot = await importSalesforceBootWithMocks();
    const store = connectionStore();
    const addOnUpsertSpy = vi.spyOn(store, 'addOnUpsert');
    const addOnDeleteSpy = vi.spyOn(store, 'addOnDelete');
    const lookupConnection = vi.fn(async () => null) as unknown as ConnectionLookup;
    const refreshAuth = vi.fn(async () => refreshableAuth()) as unknown as VendorRefreshAuth;

    await boot.bootSalesforce(buildVendorBootDeps({
      connectionStore: store,
      lookupConnection,
      refreshAuth,
    }));

    expect(boot.createInMemoryReplayIdTrackerMock).toHaveBeenCalledTimes(1);
    expect(boot.buildSalesforceReconcilersMock).toHaveBeenCalledWith({
      opportunity: { search: { refreshAuth } },
      contact: { search: { refreshAuth } },
      account: { search: { refreshAuth } },
      replayIdTracker: boot.replayIdTracker,
    });
    expect(boot.registerVendorReconcilerMock).toHaveBeenCalledTimes(3);
    expect(addOnUpsertSpy).toHaveBeenCalledTimes(1);
    expect(addOnDeleteSpy).toHaveBeenCalledTimes(1);
  });
});

describe('composeVendorSubstrate late-bound publish identities', () => {
  it('returns the same lookupConnection identity that vendor boots receive for late-bound readers', async () => {
    const { compose, bootHubSpotMock, bootSalesforceMock } =
      await importComposerWithActualRegistry();

    const bundle = await compose(buildDeps());
    const resumerLookupRef = bundle.lookupConnection;
    const runonceDispatcherLookupRef = bundle.lookupConnection;

    expect(resumerLookupRef).toBe(bootHubSpotMock.mock.calls[0]![0].lookupConnection);
    expect(runonceDispatcherLookupRef).toBe(
      bootSalesforceMock.mock.calls[0]![0].lookupConnection,
    );
  });

  it('keeps the real Salesforce call-entity hook callable after compose returns', async () => {
    vi.resetModules();
    installComposerCoreMocks();
    const salesforceMocks = installSalesforceInternalMocks();
    const engagement = engagementStore();
    const bootHubSpotMock = vi.fn(async () => ({}));
    vi.doMock('../data/hubspot/boot.js', () => ({
      bootHubSpot: bootHubSpotMock,
    }));

    const mod = await import('../composition/bin/wire-vendor-substrate.js');
    const bundle = await mod.composeVendorSubstrate(buildDeps({
      engagementStore: engagement,
    }));
    salesforceMocks.SalesforceCallEngagementReconcilerMock.mockClear();
    salesforceMocks.registerHousekeepingTaskMock.mockClear();

    const connection = { name: 'acme-salesforce' } as unknown as Parameters<
      NonNullable<typeof bundle.registerSalesforceCallEntity>
    >[0]['connection'];
    bundle.registerSalesforceCallEntity!({ connection, winner: 'call_history', prior: null });

    expect(bootHubSpotMock).toHaveBeenCalledTimes(1);
    expect(salesforceMocks.SalesforceCallEngagementReconcilerMock.mock.calls[0]![0])
      .toEqual(expect.objectContaining({
        engagementStore: engagement,
        callEntity: 'call_history',
      }));
    // The hook registers a housekeeping task for the connection (not a runonce runner).
    expect(salesforceMocks.registerHousekeepingTaskMock).toHaveBeenCalledTimes(1);
  });
});
