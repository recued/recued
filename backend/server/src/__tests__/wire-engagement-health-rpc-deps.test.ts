/**
 * Unit coverage for composeEngagementHealthRpcDeps.
 *
 * Mock shapes are based on:
 * - backend/server/src/composition/bin/wire-engagement-health-rpc-deps.ts
 * - backend/server/src/engagement-health-handler.ts
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ConnectionAuth,
  ConnectionRecord,
} from '@recued/contracts';
import type {
  ComposeEngagementHealthRpcDepsInput,
} from '../composition/bin/wire-engagement-health-rpc-deps.js';
import { composeEngagementHealthRpcDeps } from '../composition/bin/wire-engagement-health-rpc-deps.js';
import type { EngagementHealthDeps } from '../engagement-health-handler.js';
import type { ConnectionLookup } from '../housekeeping/reconciliation/vendor-reconciler.js';
import type { HousekeepingStateStore } from '../housekeeping/state-store.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { EngagementCapabilityStore } from '../storage/engagement-capability-store.js';
import type { EngagementRateControlStore } from '../storage/engagement-rate-control-store.js';

type ApiConnectionLookupMock = ConnectionLookup & ReturnType<typeof vi.fn>;
type RefreshAuthMock = (
  (connection: ConnectionRecord) => Promise<ConnectionAuth>
) & ReturnType<typeof vi.fn>;
type RegisterSalesforceCallEntityHook =
  NonNullable<EngagementHealthDeps['registerSalesforceCallEntity']>;
type RegisterSalesforceCallEntityInput = Parameters<
  RegisterSalesforceCallEntityHook
>[0];

const CONNECTION_LOOKUP_ERROR =
  'engagementHealth: connection lookup not initialized — cmdServe() has not yet '
  + 'wired the api-connection lookup helper. This indicates the rpc fired before '
  + 'connection substrate boot completed.';

const REFRESH_AUTH_ERROR =
  'engagementHealth: refresh-auth helper not initialized — cmdServe() has not yet '
  + 'wired the OAuth refresh path. This indicates the rpc fired before '
  + 'connection substrate boot completed.';

const makeConnectionStore = (): ConnectionStoreSqlite =>
  ({ kind: 'connection-store' }) as unknown as ConnectionStoreSqlite;

const makeHousekeepingState = (): HousekeepingStateStore =>
  ({ kind: 'housekeeping-state' }) as unknown as HousekeepingStateStore;

const makeRateControlStore = (): EngagementRateControlStore =>
  ({ kind: 'engagement-rate-control-store' }) as unknown as EngagementRateControlStore;

const makeCapabilityStore = (): EngagementCapabilityStore =>
  ({ kind: 'engagement-capability-store' }) as unknown as EngagementCapabilityStore;

const makeConnectionRecord = (
  overrides: Record<string, unknown> = {},
): ConnectionRecord => ({
  kind: 'api',
  subtype: 'salesforce',
  name: 'salesforce-main',
  display_name: 'Salesforce Main',
  publisher_id: 'publisher-salesforce',
  config: { vendor: 'salesforce' },
  auth: { type: 'none' },
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_500,
  health: {
    status: 'ok',
    last_probed_at: 1_700_000_000_750,
  },
  ...overrides,
}) as unknown as ConnectionRecord;

const makeConnectionAuth = (): ConnectionAuth =>
  ({ type: 'none' }) as unknown as ConnectionAuth;

const makeConnectionLookup = (
  connection: ConnectionRecord | null = makeConnectionRecord(),
): ApiConnectionLookupMock =>
  vi.fn(async () => connection) as unknown as ApiConnectionLookupMock;

const makeRefreshAuth = (
  auth: ConnectionAuth = makeConnectionAuth(),
): RefreshAuthMock =>
  vi.fn(async () => auth) as unknown as RefreshAuthMock;

const makeRegisterInput = (
  overrides: Partial<RegisterSalesforceCallEntityInput> = {},
): RegisterSalesforceCallEntityInput => ({
  connection: makeConnectionRecord(),
  winner: 'voice_call',
  prior: null,
  ...overrides,
});

const makeInput = (
  overrides: Partial<ComposeEngagementHealthRpcDepsInput> = {},
): ComposeEngagementHealthRpcDepsInput => ({
  connectionStore: makeConnectionStore(),
  housekeepingState: makeHousekeepingState(),
  rateControlStore: makeRateControlStore(),
  capabilityStore: makeCapabilityStore(),
  getApiConnectionLookup: vi.fn(() => undefined),
  getRefreshAuth: vi.fn(() => undefined),
  getRegisterSalesforceCallEntity: vi.fn(() => undefined),
  ...overrides,
});

const composeHarness = (
  overrides: Partial<ComposeEngagementHealthRpcDepsInput> = {},
): {
  input: ComposeEngagementHealthRpcDepsInput;
  deps: EngagementHealthDeps;
} => {
  const input = makeInput(overrides);
  const bundle = composeEngagementHealthRpcDeps(input);
  if (!bundle.engagementHealthDeps) {
    throw new Error('expected configured engagement health deps');
  }
  return {
    input,
    deps: bundle.engagementHealthDeps,
  };
};

const getRegisterSalesforceCallEntity_ = (
  deps: EngagementHealthDeps,
): NonNullable<EngagementHealthDeps['registerSalesforceCallEntity']> => {
  if (!deps.registerSalesforceCallEntity) {
    throw new Error('registerSalesforceCallEntity missing');
  }
  return deps.registerSalesforceCallEntity;
};

describe('composeEngagementHealthRpcDeps', () => {
  it.each([
    ['connectionStore', { connectionStore: undefined }],
    ['housekeepingState', { housekeepingState: undefined }],
    ['rateControlStore', { rateControlStore: undefined }],
    ['capabilityStore', { capabilityStore: undefined }],
  ] as const)(
    'returns undefined deps when %s is missing',
    (_storeName, overrides) => {
      const bundle = composeEngagementHealthRpcDeps(makeInput(overrides));

      expect(bundle).toEqual({
        engagementHealthDeps: undefined,
      });
    },
  );

  it('does not read late-bound getter thunks while returning undefined deps', () => {
    const getApiConnectionLookup = vi.fn(() => undefined);
    const getRefreshAuth = vi.fn(() => undefined);
    const getRegisterSalesforceCallEntity = vi.fn(() => undefined);

    const bundle = composeEngagementHealthRpcDeps(makeInput({
      connectionStore: undefined,
      getApiConnectionLookup,
      getRefreshAuth,
      getRegisterSalesforceCallEntity,
    }));

    expect(bundle).toEqual({
      engagementHealthDeps: undefined,
    });
    expect(getApiConnectionLookup).not.toHaveBeenCalled();
    expect(getRefreshAuth).not.toHaveBeenCalled();
    expect(getRegisterSalesforceCallEntity).not.toHaveBeenCalled();
  });

  it('passes required store references through directly when all are present', () => {
    const connectionStore = makeConnectionStore();
    const housekeepingState = makeHousekeepingState();
    const rateControlStore = makeRateControlStore();
    const capabilityStore = makeCapabilityStore();
    const { deps } = composeHarness({
      connectionStore,
      housekeepingState,
      rateControlStore,
      capabilityStore,
    });

    expect(deps.connectionStore).toBe(connectionStore);
    expect(deps.housekeepingState).toBe(housekeepingState);
    expect(deps.rateControlStore).toBe(rateControlStore);
    expect(deps.capabilityStore).toBe(capabilityStore);
  });

  it('lookupConnection invokes the late-bound lookup ref with the connection name', async () => {
    const connection = makeConnectionRecord({ name: 'salesforce-health' });
    const lookupConnection = makeConnectionLookup(connection);
    const getApiConnectionLookup = vi.fn(() => lookupConnection);
    const { deps } = composeHarness({ getApiConnectionLookup });

    await expect(deps.lookupConnection('salesforce-health')).resolves.toBe(connection);

    expect(getApiConnectionLookup).toHaveBeenCalledTimes(1);
    expect(lookupConnection).toHaveBeenCalledWith('salesforce-health');
  });

  it('lookupConnection throws the boot-order error when the lookup ref is missing', async () => {
    const getApiConnectionLookup = vi.fn(() => undefined);
    const { deps } = composeHarness({ getApiConnectionLookup });

    await expect(deps.lookupConnection('salesforce-health')).rejects.toEqual(
      new Error(CONNECTION_LOOKUP_ERROR),
    );

    expect(getApiConnectionLookup).toHaveBeenCalledTimes(1);
  });

  it('lookupConnection reacts to a lookup ref bound after the first rpc call', async () => {
    const connection = makeConnectionRecord({ name: 'salesforce-reactive' });
    const lookupConnection = makeConnectionLookup(connection);
    let lookup: ConnectionLookup | undefined;
    const getApiConnectionLookup = vi.fn(() => lookup);
    const { deps } = composeHarness({ getApiConnectionLookup });

    await expect(deps.lookupConnection('salesforce-reactive')).rejects.toEqual(
      new Error(CONNECTION_LOOKUP_ERROR),
    );

    lookup = lookupConnection;
    await expect(deps.lookupConnection('salesforce-reactive')).resolves.toBe(connection);

    expect(getApiConnectionLookup).toHaveBeenCalledTimes(2);
    expect(lookupConnection).toHaveBeenCalledWith('salesforce-reactive');
  });

  it('lookupConnection propagates errors thrown by the bound lookup ref', async () => {
    const boundError = new Error('lookup ref rejected');
    const lookupConnection = vi.fn(async () => {
      throw boundError;
    }) as unknown as ApiConnectionLookupMock;
    const getApiConnectionLookup = vi.fn(() => lookupConnection);
    const { deps } = composeHarness({ getApiConnectionLookup });

    await expect(deps.lookupConnection('salesforce-health')).rejects.toBe(boundError);
    expect(lookupConnection).toHaveBeenCalledWith('salesforce-health');
  });

  it('lookupConnection reads the latest lookup getter value on every rpc call', async () => {
    const firstConnection = makeConnectionRecord({ name: 'salesforce-first' });
    const secondConnection = makeConnectionRecord({ name: 'salesforce-second' });
    const firstLookup = makeConnectionLookup(firstConnection);
    const secondLookup = makeConnectionLookup(secondConnection);
    let lookup: ConnectionLookup | undefined = firstLookup;
    const getApiConnectionLookup = vi.fn(() => lookup);
    const { deps } = composeHarness({ getApiConnectionLookup });

    await expect(deps.lookupConnection('salesforce-first')).resolves.toBe(firstConnection);
    lookup = secondLookup;
    await expect(deps.lookupConnection('salesforce-second')).resolves.toBe(secondConnection);

    expect(getApiConnectionLookup).toHaveBeenCalledTimes(2);
    expect(firstLookup).toHaveBeenCalledWith('salesforce-first');
    expect(secondLookup).toHaveBeenCalledWith('salesforce-second');
  });

  it('refreshAuth invokes the late-bound refresh ref with the connection record', async () => {
    const connection = makeConnectionRecord({ name: 'salesforce-refresh' });
    const auth = makeConnectionAuth();
    const refreshAuth = makeRefreshAuth(auth);
    const getRefreshAuth = vi.fn(() => refreshAuth);
    const { deps } = composeHarness({ getRefreshAuth });

    await expect(deps.refreshAuth(connection)).resolves.toBe(auth);

    expect(getRefreshAuth).toHaveBeenCalledTimes(1);
    expect(refreshAuth).toHaveBeenCalledWith(connection);
  });

  it('refreshAuth throws the boot-order error when the refresh ref is missing', async () => {
    const connection = makeConnectionRecord({ name: 'salesforce-refresh' });
    const getRefreshAuth = vi.fn(() => undefined);
    const { deps } = composeHarness({ getRefreshAuth });

    await expect(deps.refreshAuth(connection)).rejects.toEqual(
      new Error(REFRESH_AUTH_ERROR),
    );

    expect(getRefreshAuth).toHaveBeenCalledTimes(1);
  });

  it('refreshAuth propagates errors thrown by the bound refresh ref', async () => {
    const connection = makeConnectionRecord({ name: 'salesforce-refresh' });
    const boundError = new Error('refresh ref rejected');
    const refreshAuth = vi.fn(async () => {
      throw boundError;
    }) as unknown as RefreshAuthMock;
    const getRefreshAuth = vi.fn(() => refreshAuth);
    const { deps } = composeHarness({ getRefreshAuth });

    await expect(deps.refreshAuth(connection)).rejects.toBe(boundError);
    expect(refreshAuth).toHaveBeenCalledWith(connection);
  });

  it('refreshAuth reads the latest refresh getter value on every rpc call', async () => {
    const firstConnection = makeConnectionRecord({ name: 'salesforce-first' });
    const secondConnection = makeConnectionRecord({ name: 'salesforce-second' });
    const firstAuth = makeConnectionAuth();
    const secondAuth = makeConnectionAuth();
    const firstRefreshAuth = makeRefreshAuth(firstAuth);
    const secondRefreshAuth = makeRefreshAuth(secondAuth);
    let refreshAuth: RefreshAuthMock | undefined = firstRefreshAuth;
    const getRefreshAuth = vi.fn(() => refreshAuth);
    const { deps } = composeHarness({ getRefreshAuth });

    await expect(deps.refreshAuth(firstConnection)).resolves.toBe(firstAuth);
    refreshAuth = secondRefreshAuth;
    await expect(deps.refreshAuth(secondConnection)).resolves.toBe(secondAuth);

    expect(getRefreshAuth).toHaveBeenCalledTimes(2);
    expect(firstRefreshAuth).toHaveBeenCalledWith(firstConnection);
    expect(secondRefreshAuth).toHaveBeenCalledWith(secondConnection);
  });

  // D-184 — the composer's registerSalesforceCallEntity is a thin delegator
  // to the late-bound boot hook (the housekeeping-task swap logic lives in the
  // Salesforce boot wire, where the engagement store + housekeeping registry
  // are in scope). Earlier (pre-D-184) the composer mutated the runonce
  // registry directly; the runonce stopgap is retired.
  it('registerSalesforceCallEntity delegates to the late-bound boot hook with the input', async () => {
    const hook = vi.fn(async () => undefined);
    const getRegisterSalesforceCallEntity = vi.fn(() => hook);
    const { deps } = composeHarness({ getRegisterSalesforceCallEntity });
    const registerSalesforceCallEntity = getRegisterSalesforceCallEntity_(deps);

    const input = makeRegisterInput({ prior: 'voice_call', winner: 'call_history' });
    await registerSalesforceCallEntity(input);

    expect(getRegisterSalesforceCallEntity).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(input);
  });

  it('registerSalesforceCallEntity no-ops when the hook getter returns undefined', async () => {
    const getRegisterSalesforceCallEntity = vi.fn(() => undefined);
    const { deps } = composeHarness({ getRegisterSalesforceCallEntity });
    const registerSalesforceCallEntity = getRegisterSalesforceCallEntity_(deps);

    await expect(
      registerSalesforceCallEntity(makeRegisterInput({ prior: null, winner: 'voice_call' })),
    ).resolves.toBeUndefined();
    expect(getRegisterSalesforceCallEntity).toHaveBeenCalledTimes(1);
  });

  it('registerSalesforceCallEntity reads the latest hook value on every rpc call', async () => {
    const firstHook = vi.fn(async () => undefined);
    const secondHook = vi.fn(async () => undefined);
    let hook: RegisterSalesforceCallEntityHook | undefined;
    const getRegisterSalesforceCallEntity = vi.fn(() => hook);
    const { deps } = composeHarness({ getRegisterSalesforceCallEntity });
    const registerSalesforceCallEntity = getRegisterSalesforceCallEntity_(deps);

    // First call: hook not yet bound → no-op.
    await registerSalesforceCallEntity(makeRegisterInput({ prior: null, winner: 'voice_call' }));
    expect(firstHook).not.toHaveBeenCalled();

    hook = firstHook;
    await registerSalesforceCallEntity(makeRegisterInput({ prior: null, winner: 'voice_call' }));
    hook = secondHook;
    await registerSalesforceCallEntity(makeRegisterInput({ prior: 'voice_call', winner: 'call_history' }));

    expect(getRegisterSalesforceCallEntity).toHaveBeenCalledTimes(3);
    expect(firstHook).toHaveBeenCalledTimes(1);
    expect(secondHook).toHaveBeenCalledTimes(1);
  });

  it('registerSalesforceCallEntity propagates errors thrown by the bound hook', async () => {
    const boundError = new Error('boot hook rejected');
    const hook = vi.fn(async () => { throw boundError; });
    const getRegisterSalesforceCallEntity = vi.fn(() => hook);
    const { deps } = composeHarness({ getRegisterSalesforceCallEntity });
    const registerSalesforceCallEntity = getRegisterSalesforceCallEntity_(deps);

    await expect(
      registerSalesforceCallEntity(makeRegisterInput({ prior: null, winner: 'voice_call' })),
    ).rejects.toBe(boundError);
  });

});
