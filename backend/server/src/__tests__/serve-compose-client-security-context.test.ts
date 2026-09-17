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

import { createServerIdentity } from '../identity/index.js';
import { buildIdentityProbePayload } from '@recued/contracts';
import { createInMemoryServerKeyStore, ed25519Verify } from '../keys/index.js';

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
      // D-148 — built from the signing identity; its per-request behaviour has
      // its own case below.
      identityProbeDeps: {
        serverIdentityKey: expect.any(Function),
        sign: expect.any(Function),
      },
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

  // D-148 identity probe — the ROUTE's own suite proves it reads the key per
  // request, but it hand-builds its deps, so it cannot see what THIS composer
  // passes. Caching the keypair here would leave every route test green and
  // make a rotated server keep answering to the pre-rotation fingerprint.
  it('hands the identity probe a per-request key reader, so a rotation lands', async () => {
    const identity = await createServerIdentity({ store: createInMemoryServerKeyStore() });
    const before = identity.serverIdentityKey().public_key_fingerprint;

    const context = await composeClientSecurityContext(
      makeOptions({ signingIdentity: { identity } as never }),
    );
    const probe = context.identityProbeDeps;
    expect(probe).toBeDefined();
    expect(probe!.serverIdentityKey().public_key_fingerprint).toBe(before);

    await identity.rotateServerIdentity();
    const after = identity.serverIdentityKey();
    expect(after.public_key_fingerprint).not.toBe(before);

    // Read through the SAME composed deps object the listener already holds.
    expect(probe!.serverIdentityKey().public_key_fingerprint).toBe(after.public_key_fingerprint);
    expect(probe!.serverIdentityKey().public_key_b64).toBe(after.public_key_b64);
  });

  it('⛔⛔ the composed `sign` uses the SERVER identity key, and is actually called', async () => {
    // ⚠ FOUND BY MUTATION. No test invoked the composer's `sign` at all: the
    // route suites build their own deps, and the cases here only asserted the
    // field was a Function. Swapping it to `signWithPublisherIdentity` passed
    // every test — a probe signing with the wrong key produces a signature no
    // client can verify, so address editing would be dead in production with a
    // green tree, and the publisher key would be answering unauthenticated
    // requests.
    const identity = await createServerIdentity({ store: createInMemoryServerKeyStore() });
    const context = await composeClientSecurityContext(
      makeOptions({ signingIdentity: { identity } as never }),
    );
    const probe = context.identityProbeDeps;
    expect(probe).toBeDefined();

    const payload = buildIdentityProbePayload({
      nonce: 'n'.repeat(43),
      server_public_key: identity.serverIdentityKey().public_key_b64,
    });
    const signature = probe!.sign(payload);

    // Verifies against the SERVER key…
    expect(ed25519Verify(identity.serverIdentityKey().public_key_b64, payload, signature))
      .toBe(true);
    // …and NOT against the publisher key, which is the mutation this exists for.
    expect(ed25519Verify(identity.publisherIdentityKey().public_key_b64, payload, signature))
      .toBe(false);
  });

  it('⚠ signs what it is handed, byte for byte — no re-canonicalisation on the way', async () => {
    // The route builds the payload and this only signs it. A composer that
    // wrapped or re-serialised the string would sign bytes the client never
    // rebuilds, and the failure would look like a bad key rather than a bad
    // layer.
    const identity = await createServerIdentity({ store: createInMemoryServerKeyStore() });
    const context = await composeClientSecurityContext(
      makeOptions({ signingIdentity: { identity } as never }),
    );
    const raw = 'an arbitrary string the route chose';
    expect(
      ed25519Verify(
        identity.serverIdentityKey().public_key_b64,
        raw,
        context.identityProbeDeps!.sign(raw),
      ),
    ).toBe(true);
  });

  it('leaves the identity probe unconfigured without a signing identity', async () => {
    const context = await composeClientSecurityContext(
      makeOptions({ signingIdentity: undefined }),
    );
    expect(context.identityProbeDeps).toBeUndefined();
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
