import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const ingressMocks = vi.hoisted(() => ({
  composeExposureAndTlsRpcDeps: vi.fn(),
  composeReceptionSubstrate: vi.fn(),
  composeMcpHttpTransport: vi.fn(),
  logMcpHttpBootBanner: vi.fn(),
  // The webclient servability probe reads the REAL filesystem: the deployment
  // dir, and — since the dev-serve tier landed — `apps/webclient/build` in this
  // checkout. Unmocked, `webclientBundlePresent` below would assert whatever
  // the developer last built, passing or failing by accident of the working
  // tree. Pinned here so the forwarded value is a decision, not an artifact.
  resolveServedWebclientBundleDir: vi.fn(),
  isVerifiedWebclientBundlePresent: vi.fn(),
}));

vi.mock('../webclient-bundle-loader.js', () => ({
  resolveServedWebclientBundleDir: ingressMocks.resolveServedWebclientBundleDir,
  isVerifiedWebclientBundlePresent: ingressMocks.isVerifiedWebclientBundlePresent,
}));

vi.mock('../composition/bin/wire-exposure-tls-rpc-deps.js', () => ({
  composeExposureAndTlsRpcDeps: ingressMocks.composeExposureAndTlsRpcDeps,
}));

vi.mock('../composition/bin/wire-reception-substrate.js', () => ({
  composeReceptionSubstrate: ingressMocks.composeReceptionSubstrate,
}));

vi.mock('../composition/bin/wire-mcp-http-transport.js', () => ({
  composeMcpHttpTransport: ingressMocks.composeMcpHttpTransport,
}));

import {
  composeIngressRpcContext,
  type ComposeIngressRpcContextOptions,
} from '../serve/compose-ingress-rpc-context.js';
import type { ExposureStateMachine } from '../exposure/index.js';
import type { WsServerHandle } from '../ws-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const ingressContextPath = join(
  repoRoot,
  'backend/server/src/serve/compose-ingress-rpc-context.ts',
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

const makeStorage = () =>
  ({
    db: { tag: 'db' },
    auditLog: { tag: 'audit-log' },
    eventBus: { tag: 'event-bus' },
    publicEndpointRegistryStoreRef: { tag: 'public-endpoint-registry' },
    receptionRegistryCacheRef: { tag: 'reception-registry-cache' },
    receptionRateLimiterRef: { tag: 'reception-rate-limiter' },
    previewHashStoreRef: { tag: 'preview-hash-store' },
    hostnameRegistryStore: { tag: 'hostname-registry-store' },
    schedulingFormNonceStoreRef: { tag: 'scheduling-form-nonce-store' },
    intakeRecipePairStoreRef: { tag: 'intake-recipe-pair-store' },
    intakeFormSubmissionStoreRef: { tag: 'intake-form-submission-store' },
    intakeFormNonceStoreRef: { tag: 'intake-form-nonce-store' },
    dropBlobStoreRef: { tag: 'drop-blob-store' },
    dropLinkNonceStoreRef: { tag: 'drop-link-nonce-store' },
    approvalIntentStoreRef: { tag: 'approval-intent-store' },
    approvalLinkNonceStoreRef: { tag: 'approval-link-nonce-store' },
    statusProjectionStoreRef: { tag: 'status-projection-store' },
    ipBlockStoreRef: { tag: 'ip-block-store' },
    workEntityStoreRef: { tag: 'work-entity-store' },
    vaultStore: { tag: 'vault-store' },
    mcpBodyVisibilityStore: { tag: 'mcp-body-visibility-store' },
    executeRecuedRequestPersist: vi.fn(),
    recipeStore: { tag: 'recipe-store' },
  }) as unknown as ComposeIngressRpcContextOptions['storage'];

const makeApp = () =>
  ({
    keys: { tag: 'keys' },
    llmConfig: { tag: 'llm-config' },
    llmManager: { getConfig: vi.fn(() => ({ tag: 'llm-live-config' })) },
    llmQuota: { tag: 'llm-quota' },
    llmAdapterRegistry: { tag: 'llm-adapter-registry' },
    emptyTabProbe: vi.fn(),
    housekeepingStateRef: { tag: 'housekeeping-state' },
    internalRegistryRef: { tag: 'internal-registry' },
    chatInboundTokenStoreRef: { tag: 'chat-inbound-token-store' },
    chatOrchestratorRef: {
      runLlmGatewayTurn: vi.fn(),
    },
    sellerStoreRef: { tag: 'seller-store' },
    sellerOrderStoreRef: { tag: 'seller-order-store' },
    sellerClaimStoreRef: { tag: 'seller-claim-store' },
    sharedStoreRef: { tag: 'shared-store' },
    connectionStoreRef: { tag: 'connection-store' },
    clientTokensRef: { tag: 'client-tokens' },
  }) as unknown as ComposeIngressRpcContextOptions['app'];

const makeOptions = (
  overrides: Partial<ComposeIngressRpcContextOptions> = {},
): ComposeIngressRpcContextOptions =>
  ({
    dbPath: '/tmp/recued/server.db',
    storage: makeStorage(),
    app: makeApp(),
    execution: {
      executeDeps: { tag: 'execute-deps' },
    },
    backgroundServices: { tag: 'background-services' },
    getExposureMachine: vi.fn(() => undefined),
    getWsHandleForLockout: vi.fn(() => undefined),
    ...overrides,
  }) as unknown as ComposeIngressRpcContextOptions;

beforeEach(() => {
  ingressMocks.composeExposureAndTlsRpcDeps.mockReset();
  ingressMocks.composeExposureAndTlsRpcDeps.mockReturnValue({
    exposureRpcDeps: { tag: 'exposure-rpc-deps' },
    tlsDomainStore: { tag: 'tls-domain-store' },
    tlsDomainRpcDeps: { tag: 'tls-domain-rpc-deps' },
  });

  ingressMocks.composeReceptionSubstrate.mockReset();
  ingressMocks.composeReceptionSubstrate.mockResolvedValue({
    receptionRpcDeps: { tag: 'reception-rpc-deps' },
    receptionPortDeps: { tag: 'reception-port-deps' },
  });

  // Default: a server with no bundle anywhere → dormant mount, probe false.
  ingressMocks.resolveServedWebclientBundleDir.mockReset();
  ingressMocks.resolveServedWebclientBundleDir.mockReturnValue(undefined);
  ingressMocks.isVerifiedWebclientBundlePresent.mockReset();
  ingressMocks.isVerifiedWebclientBundlePresent.mockResolvedValue(false);

  ingressMocks.logMcpHttpBootBanner.mockReset();
  ingressMocks.composeMcpHttpTransport.mockReset();
  ingressMocks.composeMcpHttpTransport.mockReturnValue({
    mcpHttpDeps: { tag: 'mcp-http-deps' },
    logBootBanner: ingressMocks.logMcpHttpBootBanner,
  });
});

describe('composeIngressRpcContext', () => {
  it('composes exposure/TLS, reception, and HTTP MCP deps from serve contexts', async () => {
    const storage = makeStorage();
    const app = makeApp();
    const execution = {
      executeDeps: { tag: 'execute-deps' },
    } as unknown as ComposeIngressRpcContextOptions['execution'];
    let currentMachine: ExposureStateMachine | undefined;
    let currentHandle: WsServerHandle | undefined;
    const machine = { tag: 'machine' } as unknown as ExposureStateMachine;
    const handle = { tag: 'ws-handle' } as unknown as WsServerHandle;

    const context = await composeIngressRpcContext(
      makeOptions({
        storage,
    app,
    execution,
        getExposureMachine: () => currentMachine,
        getWsHandleForLockout: () => currentHandle,
      }),
    );

    expect(context).toEqual({
      exposureRpcDeps: { tag: 'exposure-rpc-deps' },
      tlsDomainStore: { tag: 'tls-domain-store' },
      tlsDomainRpcDeps: { tag: 'tls-domain-rpc-deps' },
      receptionRpcDeps: { tag: 'reception-rpc-deps' },
      receptionPortDeps: { tag: 'reception-port-deps' },
      mcpHttpDeps: { tag: 'mcp-http-deps' },
      llmGatewayDeps: expect.objectContaining({
        inboundTokenStore: app.chatInboundTokenStoreRef,
        contractOverlay: execution.executeDeps.contractOverlay,
        sellerStore: app.sellerStoreRef,
        quota: app.llmQuota,
        completionProvider: expect.objectContaining({
          complete: expect.any(Function),
        }),
        getLlmConfig: expect.any(Function),
      }),
    });
    expect(context.llmGatewayDeps?.getLlmConfig()).toEqual({
      tag: 'llm-live-config',
    });

    expect(ingressMocks.composeExposureAndTlsRpcDeps).toHaveBeenCalledWith({
      db: storage.db,
      keys: app.keys,
      getExposureMachine: expect.any(Function),
      getWsHandleForLockout: expect.any(Function),
      webclientBundlePresent: false,
    });
    const exposureOptions =
      ingressMocks.composeExposureAndTlsRpcDeps.mock.calls[0]![0] as {
        getExposureMachine: () => ExposureStateMachine | undefined;
        getWsHandleForLockout: () => WsServerHandle | undefined;
      };
    expect(exposureOptions.getExposureMachine()).toBeUndefined();
    expect(exposureOptions.getWsHandleForLockout()).toBeUndefined();
    currentMachine = machine;
    currentHandle = handle;
    expect(exposureOptions.getExposureMachine()).toBe(machine);
    expect(exposureOptions.getWsHandleForLockout()).toBe(handle);

    expect(ingressMocks.composeReceptionSubstrate).toHaveBeenCalledWith({
      warehouseBus: app.warehouseBus,
      publicEndpointRegistryStore: storage.publicEndpointRegistryStoreRef,
      receptionRegistryCache: storage.receptionRegistryCacheRef,
      receptionRateLimiter: storage.receptionRateLimiterRef,
      previewHashStore: storage.previewHashStoreRef,
      auditLog: storage.auditLog,
      keys: app.keys,
      eventBus: storage.eventBus,
      dbPath: '/tmp/recued/server.db',
      db: storage.db,
      backgroundServices: { tag: 'background-services' },
      executeRecuedRequestPersist: storage.executeRecuedRequestPersist,
      llmConfig: app.llmConfig,
      llmQuota: app.llmQuota,
      // D-250 § D — Compose's propose call was the last provider call reaching
      // NEITHER a counter nor a record; it now advances the owner's daily
      // counter. This assertion is exhaustive, so the sink is named here.
      addOwnerTokenUsage: expect.any(Function),
      llmAdapterRegistry: app.llmAdapterRegistry,
      emptyTabProbe: app.emptyTabProbe,
      hostnameRegistryStore: storage.hostnameRegistryStore,
      approvalIntentStore: storage.approvalIntentStoreRef,
      statusProjectionStore: storage.statusProjectionStoreRef,
      statusEntitySourceReader: expect.objectContaining({
        read: expect.any(Function),
      }),
      workEntityStore: storage.workEntityStoreRef,
      // D-207 3d·6c (dfffb476d) DELETED the direct-checkout provider coordinator
      // + Stripe provider (zero production callers) and their wiring, so
      // `directCheckoutTaskStore` / `directCheckoutSellerStore` /
      // `directCheckoutProvider` are gone from `ComposeReceptionSubstrateDeps`.
      // Verified: zero non-test references remain anywhere in the tree.
      // D-207 slice 3c — what the reception RUNNER opens an order against.
      sellerOfferStore: app.sellerStoreRef,
      sellerOrderStore: app.sellerOrderStoreRef,
      sharedStore: app.sharedStoreRef,
      fireReceptionWorkflow: expect.any(Function),
      ipBlockStore: storage.ipBlockStoreRef,
      schedulingFormNonceStore: storage.schedulingFormNonceStoreRef,
      intakeFormSubmissionStore: storage.intakeFormSubmissionStoreRef,
      intakeRecipePairStore: storage.intakeRecipePairStoreRef,
      recipeStore: storage.recipeStore,
      // D-207 slice 1c — the reception door. The contract stores come from the SAME
      // execution bundle the Gateway was built from, so a grant the mint writes is a grant
      // the gate can read. `resolveRecipeOp` is absent here: this stub `executeDeps` has no
      // `contractScan`, so there is no pack inventory to resolve an ingredient step's op
      // against.
      contractDefinitionStore: execution.contractDefinitionStore,
      grantEntryStore: execution.grantEntryStore,
      executeDeps: execution.executeDeps,
      dishStore: execution.executeDeps.dishStore,
      connectionStore: app.connectionStoreRef,
      intakeFormNonceStore: storage.intakeFormNonceStoreRef,
      dropBlobStore: storage.dropBlobStoreRef,
      blobStore: app.cacheBlobs,
      dropLinkNonceStore: storage.dropLinkNonceStoreRef,
      approvalLinkNonceStore: storage.approvalLinkNonceStoreRef,
      sellerClaimStore: app.sellerClaimStoreRef,
    });

    expect(ingressMocks.composeMcpHttpTransport).toHaveBeenCalledWith({
      executeDeps: execution.executeDeps,
      vaultStore: storage.vaultStore,
      housekeepingStateStore: app.housekeepingStateRef,
      internalRegistry: app.internalRegistryRef,
      clientTokens: app.clientTokensRef,
      // D-171 lane-a s3 (`a928bc7c`) — external-door MCP transport threads the
      // chat inbound-token store so inbound door bearers authorize + bind their
      // contract. composeIngressRpcContext passes it as `inboundTokenStore`.
      inboundTokenStore: app.chatInboundTokenStoreRef,
      // D-196 — seller-customer admission rides alongside inbound-token auth.
      sellerStore: app.sellerStoreRef,
      // D-139 P6.B — the server-scoped body-content grant store flows from
      // storage-context into the MCP transport so the engagement read can
      // resolve `body_content_granted`.
      mcpBodyVisibilityStore: storage.mcpBodyVisibilityStore,
      // ⛔ D-220 — the live intake-form reader MUST reach the MCP transport, or
      // `recued_saveRecipe` writes straight to the store and the form-field
      // contract is bypassed entirely (Codex 3.2). Asserted as a function
      // because the identity is a factory product, not a shared ref — what
      // matters is that SOMETHING readable arrived.
      formDefinitionReader: expect.any(Function),
    });
    expect(ingressMocks.logMcpHttpBootBanner).toHaveBeenCalledTimes(1);
  });

  it('forwards webclientBundlePresent: TRUE when a verified bundle resolves', async () => {
    // The false case above cannot tell a wired probe from a hardcoded `false`
    // — only the input that would flip it can. This is also the dev-serve case:
    // `resolveServedWebclientBundleDir` answering with the source-tree build.
    ingressMocks.resolveServedWebclientBundleDir.mockReturnValue('/repo/apps/webclient/build');
    ingressMocks.isVerifiedWebclientBundlePresent.mockResolvedValue(true);

    await composeIngressRpcContext(makeOptions({ storage: makeStorage(), app: makeApp() }));

    expect(ingressMocks.isVerifiedWebclientBundlePresent).toHaveBeenCalledWith(
      '/repo/apps/webclient/build',
    );
    expect(ingressMocks.composeExposureAndTlsRpcDeps).toHaveBeenCalledWith(
      expect.objectContaining({ webclientBundlePresent: true }),
    );
  });

  it('skips the probe entirely when no bundle dir resolves', async () => {
    // Guards the `webclientBundleDir ? … : false` branch: an unresolvable dir
    // must not reach the filesystem probe at all.
    await composeIngressRpcContext(makeOptions({ storage: makeStorage(), app: makeApp() }));

    expect(ingressMocks.isVerifiedWebclientBundlePresent).not.toHaveBeenCalled();
    expect(ingressMocks.composeExposureAndTlsRpcDeps).toHaveBeenCalledWith(
      expect.objectContaining({ webclientBundlePresent: false }),
    );
  });

  it('preserves disabled reception and MCP transport gates', async () => {
    ingressMocks.composeReceptionSubstrate.mockResolvedValueOnce(undefined);
    ingressMocks.composeMcpHttpTransport.mockReturnValueOnce(undefined);

    const context = await composeIngressRpcContext(
      makeOptions({
        app: {
          ...makeApp(),
          clientTokensRef: undefined,
        } as unknown as ComposeIngressRpcContextOptions['app'],
      }),
    );

    expect(context.receptionRpcDeps).toBeUndefined();
    expect(context.receptionPortDeps).toBeUndefined();
    expect(context.mcpHttpDeps).toBeUndefined();
    expect(context.llmGatewayDeps).toBeDefined();
    expect(ingressMocks.composeMcpHttpTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        clientTokens: undefined,
      }),
    );
    expect(ingressMocks.logMcpHttpBootBanner).not.toHaveBeenCalled();
  });
});

describe('compose-ingress-rpc-context source boundary', () => {
  it('keeps ingress-facing RPC deps behind the pre-listener bridge', () => {
    const lifecycleRecoveryBridgeSource = readFileSync(
      lifecycleRecoveryBridgePath,
      'utf8',
    );
    const preListenerSource = readFileSync(startPreListenerRuntimePath, 'utf8');
    const helperSource = readFileSync(ingressContextPath, 'utf8');

    expect(lifecycleRecoveryBridgeSource).toMatch(
      /getExposureMachine:\s*\(\) => exposureMachineRef/,
    );
    expect(lifecycleRecoveryBridgeSource).toMatch(
      /getWsHandleForLockout:\s*\(\) => wsHandleForLockoutRef/,
    );
    expect(preListenerSource).toMatch(/compose-ingress-rpc-context\.js/);
    expect(preListenerSource).toMatch(/await composeIngressRpcContext\(\{/);

    expect(helperSource).toMatch(/composeExposureAndTlsRpcDeps/);
    expect(helperSource).toMatch(/composeReceptionSubstrate/);
    expect(helperSource).toMatch(/composeMcpHttpTransport/);
    expect(helperSource).toMatch(/createLlmGatewaySharedChatCompletionProvider/);
    expect(helperSource).not.toMatch(/createLlmGatewayDirectCompletionProvider/);
    expect(helperSource).toMatch(/mcpHttpBundle\?\.logBootBanner\(\)/);
  });

  it('keeps the helper out of later serve phases', () => {
    const helperSource = readFileSync(ingressContextPath, 'utf8');
    const lifecycleRecoveryBridgeSource = readFileSync(
      lifecycleRecoveryBridgePath,
      'utf8',
    );
    const preListenerSource = readFileSync(startPreListenerRuntimePath, 'utf8');
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');

    const preListenerIndex = lifecycleRecoveryBridgeSource.indexOf(
      'await startPreListenerRuntime({',
    );
    const ingressIndex = preListenerSource.indexOf('await composeIngressRpcContext({');
    const securityIndex = preListenerSource.indexOf(
      'await composeClientSecurityContext({',
    );
    const rpcIndex = preListenerSource.indexOf('composeRpcContext({');
    const bridgeIndex = preListenerSource.indexOf(
      'return startListenerExposureRuntime({',
    );
    const listenerIndex = bridgeSource.indexOf('await composeListeners({');
    const exposureIndex = bridgeSource.indexOf('await composeServeExposure({');

    expect(preListenerIndex).toBeGreaterThanOrEqual(0);
    expect(ingressIndex).toBeGreaterThanOrEqual(0);
    expect(securityIndex).toBeGreaterThan(ingressIndex);
    expect(rpcIndex).toBeGreaterThan(securityIndex);
    expect(bridgeIndex).toBeGreaterThan(rpcIndex);
    expect(listenerIndex).toBeGreaterThanOrEqual(0);
    expect(exposureIndex).toBeGreaterThan(listenerIndex);

    expect(helperSource).not.toMatch(/composeClientSecurityContext/);
    expect(helperSource).not.toMatch(/createClientTokenStore/);
    expect(helperSource).not.toMatch(/composeCertStack\(|composePassportFetchSubstrate/);
    expect(helperSource).not.toMatch(/composeRpcContext/);
    expect(helperSource).not.toMatch(/composeListeners\(|createServerHandlerSet\(/);
    expect(helperSource).not.toMatch(/composeServeExposure/);
    expect(helperSource).not.toMatch(/composeCertStackLate/);
    expect(helperSource).not.toMatch(/startSchedulers|startServeHousekeepingScheduler/);
    expect(helperSource).not.toMatch(/composeServeLifecycle|createLifecycle/);
    expect(helperSource).not.toMatch(/startRetentionPruners|startDdnsUpdatePoller/);
    expect(helperSource).not.toMatch(/serve\/log-boot-banner/);
    expect(helperSource).not.toMatch(/installShutdown/);
  });
});
