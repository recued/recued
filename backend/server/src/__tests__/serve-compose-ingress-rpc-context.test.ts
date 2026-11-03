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
import { createInMemoryCollection } from '@recued/storage';
import { createMcpActionStore, type McpActionRecord } from '../mcp-action-store.js';
import { resolveLlmGatewayRoute } from '../ports/llm-gateway/handler.js';
import { llmGatewayWaitingTrailer } from '../ports/llm-gateway/held-calls.js';
import { HELD_WRITE_EXPIRED_MESSAGE } from '../chat-held-writes.js';

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
    publicAddress: { tag: 'public-address' },
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
      publicAddress: storage.publicAddress,
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
      // D-207 — the owner's address, for the link in a turned-away notice. This context
      // has no notification block, so no `notifier` is passed and nobody is told.
      getOwnerBaseUrl: expect.any(Function),
      sharedStore: app.sharedStoreRef,
      fireReceptionWorkflow: expect.any(Function),
      ipBlockStore: storage.ipBlockStoreRef,
      schedulingFormNonceStore: storage.schedulingFormNonceStoreRef,
      intakeFormSubmissionStore: storage.intakeFormSubmissionStoreRef,
      intakeRecipePairStore: storage.intakeRecipePairStoreRef,
      recipeStore: storage.recipeStore,
      // D-220 Slice B — the store the pack install writes shipped intake templates
      // into; `reception.template.list` reads them back through it. Named here so
      // the exhaustive literal records the wire even while the fixture app carries
      // no store (the store → rpc-dep join is driven for real in
      // `d-220-slice-b-pack-reception-templates.test.ts`).
      contractStore: app.contractStoreRef,
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

  it('D-207 — hands Reception the notification block, and the owner\u2019s own address for its links', async () => {
    const notificationBlock = { notify: vi.fn() };
    const storage = makeStorage();
    const baseUrl = vi.fn(() => 'https://me.example');
    (storage as unknown as { publicAddress: Record<string, unknown> }).publicAddress = {
      tag: 'public-address',
      baseUrl,
    };
    await composeIngressRpcContext(makeOptions({
      storage,
      execution: { executeDeps: { tag: 'execute-deps' }, notificationBlock } as never,
    }));

    const [deps] = ingressMocks.composeReceptionSubstrate.mock.calls[0] as unknown as [
      { notifier?: unknown; getOwnerBaseUrl: () => string | null },
    ];
    expect(deps.notifier).toBe(notificationBlock);
    expect(deps.getOwnerBaseUrl()).toBe('https://me.example');
    expect(baseUrl).toHaveBeenCalledWith('root');
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

describe('composeIngressRpcContext — the gateway snapshot admits a kernel op granted by its op id', () => {
  // ⛔ D-232 § 20.20 at the gateway: the slugs its contract snapshot allows are what the engine's
  //   policy gate reads, so a key granted `core.data.calendar.delete` must allow `calendar-delete`,
  //   as the MCP door's snapshot and the approval resume's do. Without it a gateway step of the
  //   ingredient died `tool_not_in_contract` (found 2026-11-02, driving D-337 ruling 4 live).
  const allowedFor = async (grants: Record<string, boolean>): Promise<ReadonlyArray<string>> => {
    const execution = {
      executeDeps: {
        executorConfig: {
          manifests: { slugs: () => ['calendar-delete', 'calendar-list', 'mail-read'], get: () => undefined },
        },
      },
    } as unknown as ComposeIngressRpcContextOptions['execution'];
    const context = await composeIngressRpcContext(makeOptions({ execution }));
    return context.llmGatewayDeps!.listContractAllowedToolSlugs!({ grants } as never);
  };

  it('allows the ingredient of a granted kernel op', async () => {
    expect(await allowedFor({ 'core.data.calendar.delete': true })).toEqual(['calendar-delete']);
  });

  it('⛔ CONTROL: nothing without the grant; a raw slug grant still counts', async () => {
    expect(await allowedFor({})).toEqual([]);
    expect(await allowedFor({ 'mail-read': true })).toEqual(['mail-read']);
  });
});

describe('composeIngressRpcContext — the gateway tells a late outcome from the server\'s action records', () => {
  // ⛔ The provider tests hand it the action records. This composes it through the REAL ingress
  //   wire, from the execute deps' own store (the one the resumer settles), so a composition that
  //   stopped passing it fails HERE: a call answered after its request ended would reach nobody.
  /** The conversation's next request, its latest reply naming `ref`, through the composed gateway. */
  const nextRequest = async (executeDeps: Record<string, unknown>, ref: string) => {
    const app = makeApp();
    const runLlmGatewayTurn = vi.fn(async () => ({ turn_id: 't', assistant_content: 'It was removed.' }));
    (app as unknown as { chatOrchestratorRef: { runLlmGatewayTurn: unknown } }).chatOrchestratorRef.runLlmGatewayTurn =
      runLlmGatewayTurn;
    const execution = {
      executeDeps: { ...executeDeps, executorConfig: { manifests: { slugs: () => [], get: () => undefined } } },
    } as unknown as ComposeIngressRpcContextOptions['execution'];
    const context = await composeIngressRpcContext(makeOptions({ app, execution }));
    const config = {
      llm_gateway_default_route: 'slot:slot_1',
      llm_gateway_model_alias: 'seller-primary',
      slot_1: { provider: 'openai', model: 'gpt-4o-mini', api_key: 'sk-test', speed: 'fast', supports_json: true, context_window_tokens: 128_000 },
    } as never;
    const resolved = resolveLlmGatewayRoute(config);
    if (!resolved.ok) throw new Error(resolved.message);
    const result = await context.llmGatewayDeps!.completionProvider.complete({
      route: resolved.route,
      system_prompt: 'p', system_prompt_direct: 'p', system_role: 'system',
      emit_caller_application_instructions: false,
      messages: [
        { role: 'user', content: 'remove the dentist event' },
        { role: 'assistant', content: `It waits for approval.${llmGatewayWaitingTrailer([ref])}` },
        { role: 'user', content: 'done yet?' },
      ],
      requested_model: 'x', model_alias: 'seller-primary', config, now: 1_000, system_tools_allowed: true,
      token: { token_id: 'tok-1', grants: {} } as never,
      contract_id: 'ct-1', allowed_tool_names: [], input_token_budget: 100_000,
      resolve_contract_snapshot: () => null,
    });
    const turnInput = (runLlmGatewayTurn.mock.calls as unknown as Array<[{ held_results?: unknown[] }]>)[0]![0];
    return { turnInput, content: result.content };
  };
  const heldAs = async (run_id: string) => {
    const mcpActionStore = createMcpActionStore(createInMemoryCollection<McpActionRecord>());
    const ref = (await mcpActionStore.createHeld({
      run_id, principal_id: 'tok-1', tool_name: 'kitchen/remove-event', kind: 'recipe',
    })).action_ref;
    return { mcpActionStore, ref };
  };

  it('a settled call the latest reply named opens the next request\'s turn', async () => {
    const { mcpActionStore, ref } = await heldAs('run-late');
    await mcpActionStore.finish('run-late', { status: 'completed', status_message: 'done', result: { removed: 'Dentist' } });
    const { turnInput } = await nextRequest({ mcpActionStore }, ref);
    expect(turnInput.held_results).toHaveLength(1);
    expect(turnInput.held_results![0]).toMatchObject({ tool_name: 'kitchen/remove-event', result: { removed: 'Dentist' } });
  });

  it('⛔ an approval that expired is told as expired, though retention retired only its run', async () => {
    // `checkpoint-retention` retires a recipe run nobody answered in time (its anchor `failed`,
    // `RECIPE_APPROVAL_TIMEOUT`) and deletes its checkpoint, but never touches the record. Through
    // the REAL wire the gateway reads the record as the MCP door's status read does
    // (`reconcileMcpAction`), from the execute deps' own audit log and checkpoints.
    const { mcpActionStore, ref } = await heldAs('run-expired');
    const auditLog = {
      get: async (run_id: string) => run_id === 'run-expired'
        ? {
            run_id, commit_status: 'failed', finished_at: Date.now() - 60_000,
            // As `checkpoint-retention`'s `buildExpiryEntry` writes it.
            errors: [{
              code: 'RECIPE_APPROVAL_TIMEOUT',
              message: "Preflight approval at step 'remove' was not answered within 30 days — the staleness guard expired the paused run. Re-run the recipe to try again.",
            }],
          }
        : null,
    };
    const checkpointStore = { get: async () => null, listByRun: async () => [] };
    const { turnInput, content } = await nextRequest({ mcpActionStore, auditLog, checkpointStore }, ref);
    expect(turnInput.held_results).toHaveLength(1);
    expect(turnInput.held_results![0]).toMatchObject({ reason: 'plan_cancelled', detail: HELD_WRITE_EXPIRED_MESSAGE });
    expect((await mcpActionStore.getOwned(ref, 'tok-1'))?.status).toBe('failed');
    expect(content).not.toContain(ref);
  });

  it('⛔ CONTROL: a call whose run still waits for the owner stays waiting, its reference on the reply', async () => {
    const { mcpActionStore, ref } = await heldAs('run-waiting');
    const checkpoint = { checkpoint_id: 'cp-1', run_id: 'run-waiting' };
    const auditLog = {
      get: async (run_id: string) => ({ run_id, commit_status: 'awaiting_approval', checkpoint_id: 'cp-1' }),
    };
    const checkpointStore = { get: async () => checkpoint, listByRun: async () => [checkpoint] };
    const { turnInput, content } = await nextRequest({ mcpActionStore, auditLog, checkpointStore }, ref);
    expect(turnInput.held_results).toBeUndefined();
    expect(content).toBe(`It was removed.${llmGatewayWaitingTrailer([ref])}`);
    expect((await mcpActionStore.getOwned(ref, 'tok-1'))?.status).toBe('awaiting_approval');
  });

  /** A run retired a moment ago: the door's reconcile keeps a grace after a run's terminal record,
   *  for the answer path to write its exact result. */
  const retiredJustNow = async (run_id: string, code: string) => {
    const { mcpActionStore, ref } = await heldAs(run_id);
    const auditLog = {
      get: async (id: string) => ({
        run_id: id, commit_status: 'failed', finished_at: Date.now(),
        errors: [{ code, message: code === 'RECIPE_APPROVAL_TIMEOUT'
          ? "Preflight approval at step 'remove' was not answered within 30 days — the staleness guard expired the paused run. Re-run the recipe to try again."
          : 'The calendar could not be reached.' }],
      }),
    };
    const checkpointStore = { get: async () => null, listByRun: async () => [] };
    return { ref, ...(await nextRequest({ mcpActionStore, auditLog, checkpointStore }, ref)) };
  };

  it('⛔ D-337 slice T — an approval that expired a moment ago is told at once: retention writes nothing the grace waits for', async () => {
    // Live, 2026-11-02: the gateway's next request, 15 s after the expiry, still said "waiting".
    const { ref, turnInput, content } = await retiredJustNow('run-expired-now', 'RECIPE_APPROVAL_TIMEOUT');
    expect(turnInput.held_results).toHaveLength(1);
    expect(turnInput.held_results![0]).toMatchObject({ reason: 'plan_cancelled', detail: HELD_WRITE_EXPIRED_MESSAGE });
    expect(content).not.toContain(ref);
  });

  it('⛔ CONTROL: a run that failed a moment ago waits out the grace, for the answer path\'s own result', async () => {
    const { ref, turnInput, content } = await retiredJustNow('run-failed-now', 'CONNECTION_UNAVAILABLE');
    expect(turnInput.held_results).toBeUndefined();
    expect(content).toContain(ref);
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
