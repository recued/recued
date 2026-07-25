import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const securityMocks = vi.hoisted(() => ({
  createClientTokenStore: vi.fn(),
  createTokenRotationEmitter: vi.fn(),
  composeCertStack: vi.fn(),
  composePassportFetchSubstrate: vi.fn(),
}));

vi.mock('../pairing/client-tokens.js', () => ({
  createClientTokenStore: securityMocks.createClientTokenStore,
}));

vi.mock('../pairing/token-rotation-emitter.js', () => ({
  createTokenRotationEmitter: securityMocks.createTokenRotationEmitter,
}));

vi.mock('../composition/bin/wire-cert-stack.js', () => ({
  composeCertStack: securityMocks.composeCertStack,
}));

vi.mock('../composition/bin/wire-passport-fetch-substrate.js', () => ({
  composePassportFetchSubstrate: securityMocks.composePassportFetchSubstrate,
}));

import {
  composeClientSecurityContext,
  type ComposeClientSecurityContextOptions,
} from '../serve/compose-client-security-context.js';
import type { CertStack } from '../composition/bin/wire-cert-stack.js';
import type { WsServerHandle } from '../ws-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const composeClientSecurityPath = join(
  repoRoot,
  'backend/server/src/serve/compose-client-security-context.ts',
);
const startPostListenerRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-listener-runtime.ts',
);
const startPreListenerRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-pre-listener-runtime.ts',
);
const lifecycleRecoveryBridgePath = join(
  repoRoot,
  'backend/server/src/serve/start-lifecycle-recovery-pre-listener-runtime.ts',
);
const startListenerExposureRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-listener-exposure-runtime.ts',
);

const makeCertStack = (overrides: Partial<CertStack> = {}): CertStack =>
  ({
    rotationEngine: { tag: 'rotation-engine' },
    proAuthStateMachineRef: { tag: 'pro-auth-machine' },
    setProAuthResolver: vi.fn(),
    setPublisherIdResolver: vi.fn(),
    composeLate: vi.fn(),
    getTlsCertSourceRef: vi.fn(),
    getTlsRenewalHookRef: vi.fn(),
    getInitialAcmeDomainIssuerRef: vi.fn(),
    getHandleStateMachineRef: vi.fn(),
    getPassportCertSourceRef: vi.fn(),
    getTlsRenewerConfigured: vi.fn(),
    ...overrides,
  }) as unknown as CertStack;

const makeOptions = (
  overrides: Partial<ComposeClientSecurityContextOptions> = {},
): ComposeClientSecurityContextOptions =>
  ({
    db: { tag: 'db' },
    auditLog: { tag: 'audit-log' },
    signingIdentity: { tag: 'identity' },
    eventBus: { tag: 'event-bus' },
    cloudBaseUrl: 'https://api.recued.test',
    pairedInstances: { tag: 'paired-instances' },
    getWsHandleForLockout: vi.fn(() => undefined),
    ...overrides,
  }) as unknown as ComposeClientSecurityContextOptions;

beforeEach(() => {
  securityMocks.createClientTokenStore.mockReset();
  securityMocks.createTokenRotationEmitter.mockReset();
  securityMocks.composeCertStack.mockReset();
  securityMocks.composePassportFetchSubstrate.mockReset();

  securityMocks.createClientTokenStore.mockReturnValue({ tag: 'client-tokens' });
  securityMocks.createTokenRotationEmitter.mockReturnValue({
    tag: 'token-rotation-emitter',
  });
  securityMocks.composeCertStack.mockResolvedValue(makeCertStack());
  securityMocks.composePassportFetchSubstrate.mockReturnValue({
    passportFetchDeps: { tag: 'passport-fetch-deps' },
  });
});

describe('composeClientSecurityContext', () => {
  it('builds client-token, cert-stack, and passport-fetch deps', async () => {
    const options = makeOptions();

    const context = await composeClientSecurityContext(options);

    expect(securityMocks.createClientTokenStore).toHaveBeenCalledWith(options.db);
    expect(securityMocks.createTokenRotationEmitter).toHaveBeenCalledWith({
      clientTokens: { tag: 'client-tokens' },
      bus: options.eventBus,
    });
    expect(securityMocks.composeCertStack).toHaveBeenCalledWith(
      expect.objectContaining({
        db: options.db,
        auditLog: options.auditLog,
        signingIdentity: options.signingIdentity,
        eventBus: options.eventBus,
        cloudBaseUrl: 'https://api.recued.test',
        pairedInstances: options.pairedInstances,
        clientTokens: { tag: 'client-tokens' },
        closeAllActiveSessions: expect.any(Function),
      }),
    );
    expect(securityMocks.composePassportFetchSubstrate).toHaveBeenCalledWith({
      db: options.db,
      signingIdentity: options.signingIdentity,
      certStack: context.certStack,
      auditLog: options.auditLog,
      getExposureMachine: options.getExposureMachine,
      pairedInstances: options.pairedInstances,
    });
    expect(context).toEqual({
      clientTokens: { tag: 'client-tokens' },
      tokenRotationEmitter: { tag: 'token-rotation-emitter' },
      certStack: context.certStack,
      rotationEngine: { tag: 'rotation-engine' },
      proAuthStateMachineRef: { tag: 'pro-auth-machine' },
      passportFetchDeps: { tag: 'passport-fetch-deps' },
    });
  });

  it('keeps active-session revocation live-bound to the WS handle getter', async () => {
    let currentHandle: WsServerHandle | undefined;
    const firstHandle = {
      revokeAllConnectedInstances: vi.fn(() => 3),
    } as unknown as WsServerHandle;
    const secondHandle = {
      revokeAllConnectedInstances: vi.fn(() => 7),
    } as unknown as WsServerHandle;

    await composeClientSecurityContext(
      makeOptions({
        getWsHandleForLockout: vi.fn(() => currentHandle),
      }),
    );

    const certOptions = securityMocks.composeCertStack.mock.calls[0]![0] as {
      closeAllActiveSessions: () => number;
    };
    expect(certOptions.closeAllActiveSessions()).toBe(0);

    currentHandle = firstHandle;
    expect(certOptions.closeAllActiveSessions()).toBe(3);
    expect(firstHandle.revokeAllConnectedInstances).toHaveBeenCalledTimes(1);

    currentHandle = secondHandle;
    expect(certOptions.closeAllActiveSessions()).toBe(7);
    expect(secondHandle.revokeAllConnectedInstances).toHaveBeenCalledTimes(1);
  });

  it('preserves DB and identity gates while still composing the cert stack', async () => {
    const certStack = makeCertStack({
      rotationEngine: undefined,
      proAuthStateMachineRef: undefined,
    });
    securityMocks.composeCertStack.mockResolvedValue(certStack);
    securityMocks.composePassportFetchSubstrate.mockReturnValue(undefined);

    const options = makeOptions({
      db: undefined,
      signingIdentity: undefined,
    });
    const context = await composeClientSecurityContext(options);

    expect(securityMocks.createClientTokenStore).not.toHaveBeenCalled();
    expect(securityMocks.createTokenRotationEmitter).not.toHaveBeenCalled();
    expect(securityMocks.composeCertStack).toHaveBeenCalledWith(
      expect.objectContaining({
        db: undefined,
        signingIdentity: undefined,
        clientTokens: undefined,
      }),
    );
    expect(securityMocks.composePassportFetchSubstrate).toHaveBeenCalledWith({
      db: undefined,
      signingIdentity: undefined,
      certStack,
      auditLog: options.auditLog,
      getExposureMachine: options.getExposureMachine,
      pairedInstances: options.pairedInstances,
    });
    expect(context).toEqual({
      clientTokens: undefined,
      tokenRotationEmitter: undefined,
      certStack,
      rotationEngine: undefined,
      proAuthStateMachineRef: undefined,
      passportFetchDeps: undefined,
    });
  });
});

describe('compose-client-security-context source boundary', () => {
  it('keeps early client security construction behind the pre-listener bridge', () => {
    const lifecycleRecoveryBridgeSource = readFileSync(
      lifecycleRecoveryBridgePath,
      'utf8',
    );
    const preListenerSource = readFileSync(startPreListenerRuntimePath, 'utf8');
    const helperSource = readFileSync(composeClientSecurityPath, 'utf8');

    expect(lifecycleRecoveryBridgeSource).toMatch(
      /getWsHandleForLockout:\s*\(\) => wsHandleForLockoutRef/,
    );
    expect(preListenerSource).toMatch(/compose-client-security-context\.js/);
    expect(preListenerSource).toMatch(/await composeClientSecurityContext\(\{/);

    expect(helperSource).toMatch(/createClientTokenStore/);
    expect(helperSource).toMatch(/createTokenRotationEmitter/);
    expect(helperSource).toMatch(/composeCertStack/);
    expect(helperSource).toMatch(/composePassportFetchSubstrate/);
    expect(helperSource).toMatch(
      /getWsHandleForLockout\(\)\?\.revokeAllConnectedInstances\(\) \?\? 0/,
    );
  });

  it('preserves client security, RPC, listener, and late cert ordering', () => {
    const lifecycleRecoveryBridgeSource = readFileSync(
      lifecycleRecoveryBridgePath,
      'utf8',
    );
    const preListenerSource = readFileSync(startPreListenerRuntimePath, 'utf8');
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');
    const runtimeSource = readFileSync(startPostListenerRuntimePath, 'utf8');
    const preListenerIndex = lifecycleRecoveryBridgeSource.indexOf(
      'await startPreListenerRuntime({',
    );
    const securityIndex = preListenerSource.indexOf(
      'await composeClientSecurityContext({',
    );
    const rpcIndex = preListenerSource.indexOf('composeRpcContext({');
    const bridgeIndex = preListenerSource.indexOf(
      'return startListenerExposureRuntime({',
    );
    const listenerIndex = bridgeSource.indexOf('await composeListeners({');
    const runtimeStartIndex = bridgeSource.indexOf('await startPostListenerRuntime({');
    const certLateIndex = runtimeSource.indexOf('await composeCertStackLate({');

    expect(preListenerIndex).toBeGreaterThanOrEqual(0);
    expect(securityIndex).toBeGreaterThanOrEqual(0);
    expect(rpcIndex).toBeGreaterThan(securityIndex);
    expect(bridgeIndex).toBeGreaterThan(rpcIndex);
    expect(listenerIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeStartIndex).toBeGreaterThan(listenerIndex);
    expect(certLateIndex).toBeGreaterThanOrEqual(0);
  });

  it('keeps the helper focused on early client security deps', () => {
    const helperSource = readFileSync(composeClientSecurityPath, 'utf8');

    expect(helperSource).not.toMatch(/composeCertStackLate|composeServeExposure/);
    expect(helperSource).not.toMatch(/composeReceptionSubstrate|composeMcpHttpTransport/);
    expect(helperSource).not.toMatch(/composeRpcContext|composeListeners/);
    expect(helperSource).not.toMatch(/startSchedulers|startServeHousekeepingScheduler/);
    expect(helperSource).not.toMatch(/createLifecycle|installShutdown/);
    expect(helperSource).not.toMatch(/startRetentionPruners|startDdnsUpdatePoller/);
    expect(helperSource).not.toMatch(/logBootBanner/);
  });
});
