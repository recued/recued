import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EventBus } from '../events/bus.js';
import type { UpstreamMergeRegistry } from '../data/vendor-boot-registry.js';

const vendorMocks = vi.hoisted(() => ({
  composeVendorSubstrate: vi.fn(),
}));

vi.mock('../composition/bin/wire-vendor-substrate.js', () => ({
  composeVendorSubstrate: vendorMocks.composeVendorSubstrate,
}));

import {
  composeVendorSubstrateContext,
  type VendorSubstrateAppContext,
} from '../serve/compose-vendor-substrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const composeVendorSubstratePath = join(
  repoRoot,
  'backend/server/src/serve/compose-vendor-substrate.ts',
);
const startHousekeepingStartupPath = join(
  repoRoot,
  'backend/server/src/serve/start-housekeeping-startup.ts',
);
const startPostListenerRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-listener-runtime.ts',
);
const startListenerExposureRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-listener-exposure-runtime.ts',
);

const makeApp = (
  overrides: Partial<VendorSubstrateAppContext> = {},
): VendorSubstrateAppContext =>
  ({
    connectionStoreRef: { tag: 'connection-store' },
    keys: { tag: 'keys' },
    engagementStoreRef: { tag: 'engagement-store' },
    enrichmentStoreRef: { tag: 'enrichment-store' },
    contactStoreRef: { tag: 'contact-store' },
    upstreamMergeStoreRef: { tag: 'upstream-merge-store' },
    warehouseBus: { tag: 'warehouse-bus' },
    ...overrides,
  }) as unknown as VendorSubstrateAppContext;

beforeEach(() => {
  vendorMocks.composeVendorSubstrate.mockReset();
});

describe('composeVendorSubstrateContext', () => {
  it('does not compose vendor substrate without the connection store', async () => {
    const result = await composeVendorSubstrateContext({
      app: makeApp({ connectionStoreRef: undefined }),
      upstreamMergeRegistry: undefined,
      eventBus: { tag: 'event-bus' } as unknown as EventBus,
    });

    expect(result).toBeUndefined();
    expect(vendorMocks.composeVendorSubstrate).not.toHaveBeenCalled();
  });

  it('delegates the existing vendor inputs and returns publishable refs', async () => {
    const app = makeApp();
    const upstreamMergeRegistry = new Map() as UpstreamMergeRegistry;
    const eventBus = { tag: 'event-bus' };
    const lookupConnection = vi.fn();
    const refreshAuth = vi.fn();
    const registerSalesforceCallEntity = vi.fn();
    vendorMocks.composeVendorSubstrate.mockResolvedValue({
      lookupConnection,
      refreshAuth,
      registerSalesforceCallEntity,
    });

    const result = await composeVendorSubstrateContext({
      app,
      upstreamMergeRegistry,
      eventBus: eventBus as unknown as EventBus,
    });

    expect(vendorMocks.composeVendorSubstrate).toHaveBeenCalledTimes(1);
    expect(vendorMocks.composeVendorSubstrate).toHaveBeenCalledWith({
      connectionStore: app.connectionStoreRef,
      keys: app.keys,
      engagementStore: app.engagementStoreRef,
      enrichmentStore: app.enrichmentStoreRef,
      contactStore: app.contactStoreRef,
      upstreamMergeStore: app.upstreamMergeStoreRef,
      upstreamMergeRegistry,
      warehouseBus: app.warehouseBus,
      eventBus,
    });
    expect(result).toEqual({
      apiConnectionLookup: lookupConnection,
      refreshApiConnectionAuth: refreshAuth,
      registerSalesforceCallEntity,
    });
  });

  it('omits the Salesforce call-entity hook when the vendor bundle omits it', async () => {
    vendorMocks.composeVendorSubstrate.mockResolvedValue({
      lookupConnection: vi.fn(),
      refreshAuth: vi.fn(),
    });

    const result = await composeVendorSubstrateContext({
      app: makeApp(),
      upstreamMergeRegistry: undefined,
      eventBus: { tag: 'event-bus' } as unknown as EventBus,
    });

    expect(result).toBeDefined();
    expect('registerSalesforceCallEntity' in result!).toBe(false);
  });
});

describe('compose-vendor-substrate source boundary', () => {
  it('keeps vendor startup behind the housekeeping startup orchestrator', () => {
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');
    const runtimeSource = readFileSync(startPostListenerRuntimePath, 'utf8');
    const startupSource = readFileSync(startHousekeepingStartupPath, 'utf8');

    expect(bridgeSource).toMatch(/start-post-listener-runtime\.js/);
    expect(runtimeSource).toMatch(/start-housekeeping-startup\.js/);
    expect(runtimeSource).toMatch(/startHousekeepingStartup\(\{/);
    expect(startupSource).toMatch(/\.\/compose-vendor-substrate\.js/);
    expect(startupSource).toMatch(/composeVendorSubstrateContext\(\{/);
  });

  it('preserves registry clear, vendor, LLM callable, and scheduler order', () => {
    const source = readFileSync(startHousekeepingStartupPath, 'utf8');
    const clearIndex = source.indexOf('clearDefaultHousekeepingRegistry();');
    const vendorIndex = source.indexOf('const vendorRefs = await composeVendorSubstrateContext({');
    const llmCallablesIndex = source.indexOf(
      'const housekeepingLlmCallables = composeHousekeepingLlmCallables({',
    );
    const schedulerIndex = source.indexOf('return startServeHousekeepingScheduler({');

    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(vendorIndex).toBeGreaterThan(clearIndex);
    expect(llmCallablesIndex).toBeGreaterThan(vendorIndex);
    expect(schedulerIndex).toBeGreaterThan(llmCallablesIndex);
  });

  it('keeps the helper focused on vendor startup and returned late-bound refs', () => {
    const source = readFileSync(composeVendorSubstratePath, 'utf8');

    expect(source).toMatch(/composeWireVendorSubstrate/);
    expect(source).toMatch(/connectionStoreRef/);
    expect(source).toMatch(/upstreamMergeRegistry/);
    expect(source).toMatch(/apiConnectionLookup/);
    expect(source).toMatch(/refreshApiConnectionAuth/);
    expect(source).toMatch(/registerSalesforceCallEntity/);
    expect(source).not.toMatch(/clearDefaultHousekeepingRegistry/);
    expect(source).not.toMatch(/composeHousekeepingLlmCallables/);
    expect(source).not.toMatch(/composeSchedulers|composeHousekeepingScheduler/);
    expect(source).not.toMatch(/startRetentionPruners|startDdnsUpdatePoller/);
    expect(source).not.toMatch(/createServerHandlerSet|createProductionPathListenerCoordinator/);
    expect(source).not.toMatch(/createLifecycle|LockHeldError|process\.on|process\.exit/);
  });
});
