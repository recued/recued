import { beforeEach, describe, expect, it, vi } from 'vitest';

const tlsStoreMocks = vi.hoisted(() => ({
  tlsDomainStore: { kind: 'tls-domain-store' },
  createSqliteTlsDomainStore: vi.fn(),
  ensureTlsDomainSchema: vi.fn(),
}));

const tlsVerifierMocks = vi.hoisted(() => ({
  metadataReader: { kind: 'metadata-reader' },
  verifiers: { kind: 'verifiers' },
  createNodeTlsMetadataReader: vi.fn(),
  createNodeTlsVerifiers: vi.fn(),
}));

vi.mock('../tls/domain-store.js', () => ({
  createSqliteTlsDomainStore: tlsStoreMocks.createSqliteTlsDomainStore,
  ensureTlsDomainSchema: tlsStoreMocks.ensureTlsDomainSchema,
}));

vi.mock('../tls/cert-verifiers.js', () => ({
  createNodeTlsMetadataReader: tlsVerifierMocks.createNodeTlsMetadataReader,
  createNodeTlsVerifiers: tlsVerifierMocks.createNodeTlsVerifiers,
}));

import { composeExposureAndTlsRpcDeps } from '../composition/bin/wire-exposure-tls-rpc-deps.js';

const resetTlsMocks = (): void => {
  tlsStoreMocks.createSqliteTlsDomainStore.mockReset();
  tlsStoreMocks.createSqliteTlsDomainStore.mockReturnValue(tlsStoreMocks.tlsDomainStore);
  tlsStoreMocks.ensureTlsDomainSchema.mockReset();
  tlsVerifierMocks.createNodeTlsMetadataReader.mockReset();
  tlsVerifierMocks.createNodeTlsMetadataReader.mockReturnValue(
    tlsVerifierMocks.metadataReader,
  );
  tlsVerifierMocks.createNodeTlsVerifiers.mockReset();
  tlsVerifierMocks.createNodeTlsVerifiers.mockReturnValue(
    tlsVerifierMocks.verifiers,
  );
};

const makeDeps = (overrides: Record<string, unknown> = {}) => ({
  db: undefined,
  keys: undefined,
  getExposureMachine: vi.fn(() => undefined),
  getWsHandleForLockout: vi.fn(() => undefined),
  ...overrides,
});

const composeWithDeps = (overrides: Record<string, unknown> = {}) =>
  composeExposureAndTlsRpcDeps(makeDeps(overrides) as any) as any;

const lastStoreOptions = () => {
  const call = tlsStoreMocks.createSqliteTlsDomainStore.mock.calls.at(-1);
  if (!call) throw new Error('createSqliteTlsDomainStore was not called');
  return call[0] as any;
};

beforeEach(() => {
  resetTlsMocks();
});

describe('composeExposureAndTlsRpcDeps exposure rpc deps', () => {
  it('getMachine throws fail-loud when the exposure machine is missing', () => {
    const bundle = composeWithDeps();

    expect(() => bundle.exposureRpcDeps.getMachine()).toThrow(
      'exposure rpc dispatched before ExposureStateMachine was wired — boot-order invariant violated',
    );
  });

  it('getMachine returns the machine identity when present', () => {
    const machine = { kind: 'exposure-machine' };
    const bundle = composeWithDeps({
      getExposureMachine: vi.fn(() => machine),
    });

    expect(bundle.exposureRpcDeps.getMachine()).toBe(machine);
  });

  it('getMachine reads the getter on every call', () => {
    const machine = { kind: 'late-exposure-machine' };
    let currentMachine: unknown;
    const bundle = composeWithDeps({
      getExposureMachine: vi.fn(() => currentMachine),
    });

    expect(() => bundle.exposureRpcDeps.getMachine()).toThrow(
      'exposure rpc dispatched before ExposureStateMachine was wired — boot-order invariant violated',
    );

    currentMachine = machine;

    expect(bundle.exposureRpcDeps.getMachine()).toBe(machine);
  });

  it('closeWsClientsForLockout returns 0 when the ws handle is missing', () => {
    const getWsHandleForLockout = vi.fn(() => undefined);
    const bundle = composeWithDeps({ getWsHandleForLockout });

    expect(bundle.exposureRpcDeps.closeWsClientsForLockout('lockout')).toBe(0);
    expect(getWsHandleForLockout).toHaveBeenCalledTimes(1);
  });

  it('closeWsClientsForLockout invokes the ws lockout closer with the reason', () => {
    const handle = {
      closeAllForWsLockout: vi.fn(() => 4),
    };
    const bundle = composeWithDeps({
      getWsHandleForLockout: vi.fn(() => handle),
    });

    expect(bundle.exposureRpcDeps.closeWsClientsForLockout('manual')).toBe(4);
    expect(handle.closeAllForWsLockout).toHaveBeenCalledTimes(1);
    expect(handle.closeAllForWsLockout).toHaveBeenCalledWith('manual');
  });

  it('closeWsClientsForLockout returns the handle result', () => {
    const handle = {
      closeAllForWsLockout: vi.fn(() => 7),
    };
    const bundle = composeWithDeps({
      getWsHandleForLockout: vi.fn(() => handle),
    });

    expect(bundle.exposureRpcDeps.closeWsClientsForLockout('rotation')).toBe(7);
  });

  it('closeWsClientsForLockout reads the handle getter on every call', () => {
    const handle = {
      closeAllForWsLockout: vi.fn(() => 2),
    };
    let currentHandle: unknown;
    const bundle = composeWithDeps({
      getWsHandleForLockout: vi.fn(() => currentHandle),
    });

    expect(bundle.exposureRpcDeps.closeWsClientsForLockout('before')).toBe(0);

    currentHandle = handle;

    expect(bundle.exposureRpcDeps.closeWsClientsForLockout('after')).toBe(2);
    expect(handle.closeAllForWsLockout).toHaveBeenCalledWith('after');
  });
});

describe('composeExposureAndTlsRpcDeps tls domain deps', () => {
  it('skips tls store and rpc deps when db is undefined', () => {
    const bundle = composeWithDeps({ db: undefined });

    expect(bundle.tlsDomainStore).toBeUndefined();
    expect(bundle.tlsDomainRpcDeps).toBeUndefined();
    expect(tlsStoreMocks.ensureTlsDomainSchema).not.toHaveBeenCalled();
    expect(tlsStoreMocks.createSqliteTlsDomainStore).not.toHaveBeenCalled();
  });

  it('builds a tls store without getKey when db is present and keys are missing', () => {
    const db = { kind: 'db' };
    const bundle = composeWithDeps({ db });

    expect(bundle.tlsDomainStore).toBe(tlsStoreMocks.tlsDomainStore);
    expect(tlsStoreMocks.ensureTlsDomainSchema).toHaveBeenCalledTimes(1);
    expect(tlsStoreMocks.ensureTlsDomainSchema).toHaveBeenCalledWith(db);
    expect(tlsStoreMocks.createSqliteTlsDomainStore).toHaveBeenCalledTimes(1);
    expect(lastStoreOptions()).toEqual({
      db,
      verifiers: tlsVerifierMocks.verifiers,
      metadataReader: tlsVerifierMocks.metadataReader,
    });
    expect(lastStoreOptions()).not.toHaveProperty('getKey');
  });

  it('passes the tls_domains key provider when keys are present', () => {
    const db = { kind: 'db' };
    const getKey = vi.fn();
    const keyProvider = vi.fn(() => getKey);
    const keys = { keyProvider };

    composeWithDeps({ db, keys });

    expect(tlsStoreMocks.ensureTlsDomainSchema).toHaveBeenCalledWith(db);
    expect(keyProvider).toHaveBeenCalledTimes(1);
    expect(keyProvider).toHaveBeenCalledWith('tls_domains');
    expect(lastStoreOptions()).toEqual({
      db,
      verifiers: tlsVerifierMocks.verifiers,
      metadataReader: tlsVerifierMocks.metadataReader,
      getKey,
    });
  });

  it('creates node tls verifiers and metadata reader once when db and keys are present', () => {
    const db = { kind: 'db' };
    const keys = { keyProvider: vi.fn(() => vi.fn()) };

    composeWithDeps({ db, keys });

    expect(tlsVerifierMocks.createNodeTlsVerifiers).toHaveBeenCalledTimes(1);
    expect(tlsVerifierMocks.createNodeTlsMetadataReader).toHaveBeenCalledTimes(1);
  });

  it('tlsDomainRpcDeps.getStore returns the created store identity', () => {
    const bundle = composeWithDeps({ db: { kind: 'db' } });

    expect(bundle.tlsDomainRpcDeps.getStore()).toBe(tlsStoreMocks.tlsDomainStore);
  });

  it('omits getKey when keys.keyProvider returns undefined', () => {
    const db = { kind: 'db' };
    const keyProvider = vi.fn(() => undefined);
    const keys = { keyProvider };

    composeWithDeps({ db, keys });

    expect(keyProvider).toHaveBeenCalledTimes(1);
    expect(keyProvider).toHaveBeenCalledWith('tls_domains');
    expect(lastStoreOptions()).not.toHaveProperty('getKey');
  });
});
