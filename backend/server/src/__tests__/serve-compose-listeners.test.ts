import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedLanAddress } from '../network/resolve-lan-address.js';

const listenerMocks = vi.hoisted(() => {
  const coordinator = {
    apply: vi.fn(),
    status: vi.fn(() => [
      {
        listener: 'lan',
        listening: true,
        port: 4711,
        bind_address: '192.168.1.10',
      },
    ]),
    stop: vi.fn(async () => undefined),
  };
  const handlerSet = {
    handlers: { health: vi.fn() },
    upgradeHandlers: { ws: vi.fn() },
    legacyAliases: [{ kind: 'exact', path: '/auth/pair', role: 'ws' }],
    rootHandler: vi.fn(),
    // Offline-pairing convenience — the LAN bare-`/` handler. Present on the
    // real `ServerHandlerSet` when a webclient bundle loaded; `composeListeners`
    // threads it onto the coordinator via a conditional spread. (Replaces the
    // stale `webclientHandler` field — R26.2 Delta 3 moved the webclient bundle
    // handler into `handlers.webclient`; it is no longer a top-level slot.)
    lanRootHandler: vi.fn(),
    wsHandle: {
      clientCount: vi.fn(() => 3),
      bridgeDispatcher: { tag: 'live-bridge-dispatcher' },
    },
    close: vi.fn(),
  };
  const certChain = { kind: 'cert-chain' };
  return {
    coordinator,
    handlerSet,
    certChain,
    webhookListener: vi.fn(),
    composeWebhookListeners: vi.fn(async () => ({
      webhookListener: vi.fn(),
    })),
    createServerHandlerSet: vi.fn(() => handlerSet),
    // Annotated with the real return type so an OPTIONAL field (today
    // `override_ignored`) can be supplied by a test without the inferred
    // literal type rejecting it.
    resolveLanAddress: vi.fn((): ResolvedLanAddress => ({
      address: '192.168.1.10',
      bind_address: '0.0.0.0',
      source: 'detected',
      candidates: [{ address: '192.168.1.10', iface: 'en0' }],
    })),
    // Mocked so unit tests neither read this host's routing table nor spawn
    // a `route` subprocess — and so the hint's arrival at the resolver is an
    // assertion rather than whatever the machine happens to answer.
    readDefaultRouteGateway: vi.fn(() => '192.168.1.1'),
    createCertChainHolder: vi.fn(() => certChain),
    createProductionPathListenerCoordinator: vi.fn(() => coordinator),
    reconcileInstalledPacksOnBoot: vi.fn(async () => ({ entries: [], updated: 0, held: 0 })),
    checkInstalledManifestsOnBoot: vi.fn(() => []),
    notifyUnrunnablePacks: vi.fn(async () => true),
  };
});

vi.mock('../composition/bin/wire-webhook-listeners.js', () => ({
  composeWebhookListeners:
    listenerMocks.composeWebhookListeners,
}));

vi.mock('../server.js', () => ({
  createServerHandlerSet: listenerMocks.createServerHandlerSet,
}));

vi.mock('../network/resolve-lan-address.js', () => ({
  resolveLanAddress: listenerMocks.resolveLanAddress,
}));

vi.mock('../network/read-default-route-gateway.js', () => ({
  readDefaultRouteGateway: listenerMocks.readDefaultRouteGateway,
}));

vi.mock('@recued/server-tls', () => ({
  createCertChainHolder: listenerMocks.createCertChainHolder,
  DEFAULT_PUBLIC_PORT: 443,
}));

vi.mock('../network/path-listener-coordinator.js', () => ({
  createProductionPathListenerCoordinator:
    listenerMocks.createProductionPathListenerCoordinator,
}));

vi.mock('../pack-reconciliation.js', () => ({
  reconcileInstalledPacksOnBoot: listenerMocks.reconcileInstalledPacksOnBoot,
}));

vi.mock('../ingredient-authoring/installed-manifest-boot-check.js', () => ({
  checkInstalledManifestsOnBoot: listenerMocks.checkInstalledManifestsOnBoot,
  notifyUnrunnablePacks: listenerMocks.notifyUnrunnablePacks,
}));

import {
  composeListeners,
  type ComposeListenersOptions,
} from '../serve/compose-listeners.js';
import { D165_CONTRACT_SCHEMA } from '@recued/contracts';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { recordPackInventory } from '../pack-inventory.js';
import { createWebhookIngressStore } from '../storage/webhook-ingress-store.js';
import { createWebhookDeliveryStore } from '../storage/webhook-delivery-store.js';
import { createWebhookConsumerStore } from '../storage/webhook-consumer-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import type { ChatRpcDeps } from '../chat-handler.js';
import { encodeAuthForStorage } from '../connection-handler.js';
import {
  createWebhookPrefixedPositiveDecimalIdCodec,
} from '../webhook-prefixed-positive-decimal-id-codec.js';
import {
  webhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset,
} from '../webhook-shared-profile-parser-presets.js';
import { webhookProfile } from '@recued/contracts';
import { createRecipeStore } from '../recipe-store.js';
import { createDishStore } from '../dish-store.js';
import { createDish, type DishHandlerDeps } from '../dish-handler.js';
import { bundledPacksShippingRecipe } from '../bundled-pack-source.js';
import {
  createPublicAddressService,
  createSqlitePublicAddressStore,
  type PublicHostnameRow,
} from '../public-address.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const telegramRemoteIdPreset =
  webhookPrefixedPositiveDecimalRegistrationRemoteIdProfilePreset(
    'telegram.bot-webhook.v1',
  );
if (telegramRemoteIdPreset === null) {
  throw new Error('Telegram registration remote-id test preset is unavailable');
}
const telegramRemoteIdCodec = createWebhookPrefixedPositiveDecimalIdCodec(
  telegramRemoteIdPreset.codec,
);
const telegramTestRemoteId = telegramRemoteIdCodec.format('123456');
if (telegramTestRemoteId === null) {
  throw new Error('Telegram registration remote-id test fixture is invalid');
}
const listenerContextPath = join(
  repoRoot,
  'backend/server/src/serve/compose-listeners.ts',
);

const resetListenerMocks = (): void => {
  listenerMocks.coordinator.apply.mockReset();
  listenerMocks.coordinator.status.mockReset();
  listenerMocks.coordinator.status.mockReturnValue([
    {
      listener: 'lan',
      listening: true,
      port: 4711,
      bind_address: '192.168.1.10',
    },
  ]);
  listenerMocks.coordinator.stop.mockReset();
  listenerMocks.coordinator.stop.mockResolvedValue(undefined);
  listenerMocks.handlerSet.close.mockReset();
  listenerMocks.handlerSet.wsHandle.clientCount.mockReset();
  listenerMocks.handlerSet.wsHandle.clientCount.mockReturnValue(3);
  listenerMocks.composeWebhookListeners.mockReset();
  listenerMocks.composeWebhookListeners.mockResolvedValue({
    webhookListener: listenerMocks.webhookListener,
  });
  listenerMocks.createServerHandlerSet.mockReset();
  listenerMocks.createServerHandlerSet.mockReturnValue(listenerMocks.handlerSet);
  listenerMocks.resolveLanAddress.mockReset();
  listenerMocks.resolveLanAddress.mockReturnValue({
    address: '192.168.1.10',
    bind_address: '0.0.0.0',
    source: 'detected',
    candidates: [{ address: '192.168.1.10', iface: 'en0' }],
  });
  listenerMocks.readDefaultRouteGateway.mockReset();
  listenerMocks.readDefaultRouteGateway.mockReturnValue('192.168.1.1');
  listenerMocks.createCertChainHolder.mockReset();
  listenerMocks.createCertChainHolder.mockReturnValue(listenerMocks.certChain);
  listenerMocks.createProductionPathListenerCoordinator.mockReset();
  listenerMocks.createProductionPathListenerCoordinator.mockReturnValue(
    listenerMocks.coordinator,
  );
  listenerMocks.reconcileInstalledPacksOnBoot.mockReset();
  listenerMocks.reconcileInstalledPacksOnBoot.mockResolvedValue({
    entries: [],
    updated: 0,
    held: 0,
  });
  listenerMocks.checkInstalledManifestsOnBoot.mockReset();
  listenerMocks.checkInstalledManifestsOnBoot.mockReturnValue([]);
  listenerMocks.notifyUnrunnablePacks.mockReset();
  listenerMocks.notifyUnrunnablePacks.mockResolvedValue(true);
};

// D-173 INT-3 — `composeListeners` eagerly builds the SQLite-backed
// reception-inbox subview store off `storage.db` (compose-listeners.ts:398),
// so the harness must supply a REAL per-pair db (production always opens one —
// `compose-storage-context.ts` types `db: Database.Database`, non-optional —
// so a real in-memory handle matches prod and the eager `ensureSchema` runs as
// it does at boot). A bare `undefined` mock was the test-harness gap that broke
// these once the eager build landed. One handle per test, closed in afterEach.
let storageDb: Database.Database;

beforeEach(() => {
  resetListenerMocks();
  storageDb = new Database(':memory:');
});

afterEach(() => {
  storageDb.close();
});

const makeOptions = (
  overrides: Record<string, unknown> = {},
): ComposeListenersOptions => ({
  port: 1234,
  webhookPort: 8080,
  storage: {
    db: storageDb,
    pairing: { tag: 'pairing' },
    serverInstanceId: 'server-instance-1',
    pairedInstances: { tag: 'paired-instances' },
    recoveryKeyCheck: { tag: 'recovery-key-check' },
    auditLog: undefined,
    fileStack: undefined,
    workEntityStoreRef: undefined,
    formResponseStoreRef: undefined,
    s2sPreviewStoreRef: undefined,
    localManifestStore: { tag: 'local-manifest-store' },
    draftStore: { tag: 'draft-store' },
    recipeStore: { tag: 'recipe-store' },
    hostnameRegistryStore: { tag: 'hostname-registry-store' },
    // Real, over no hostnames: every link reads `RECUED_PUBLIC_BASE_URL` live
    // through it, as in production.
    publicAddress: createPublicAddressService({
      configured: () => process.env.RECUED_PUBLIC_BASE_URL,
      hostnames: { list: () => [] },
      store: createSqlitePublicAddressStore(storageDb),
    }),
    checkpointStore: undefined,
    eventBus: undefined,
  },
  app: {
    authDeps: undefined,
    llmManager: undefined,
    cacheDeps: undefined,
    sharedDeps: undefined,
    annotationDeps: undefined,
    annotationStoreRef: undefined,
    enrichmentStoreRef: undefined,
    enrichmentCascadeRef: undefined,
    connectionStoreRef: undefined,
    contactStoreRef: undefined,
    chatDeps: undefined,
    workEntityCrudDepsRef: { current: null },
    calendarWriteDepsRef: { current: null },
    keys: undefined,
  },
  collection: {
    collectionRegistry: { tag: 'collection-registry' },
    watcherDispatcher: { tag: 'watcher-dispatcher' },
    calendarStack: undefined,
    mailStack: undefined,
    // D-315 §5 — the fact events held since the mailboxes started, which
    // composition opens once the triggers can hear them. ⚠ It RECORDS: an
    // opener that no-ops cannot tell "opened" from "never opened".
    mailFactEvents: { open: vi.fn(async () => {}) },
    // D-124 — the new mail's events a boot scan emitted before the dispatcher
    // subscribed: sealed as it composes, replayed once. Recording, as above.
    bootEvents: { seal: vi.fn(), replay: vi.fn(async () => {}) },
    serviceStack: undefined,
    channelDispatchers: undefined,
    oauthClientConfigDeps: undefined,
  },
  execution: {
    // G6 — the boot reconcile + mutation hook read these two members
    // (`recipeStore` is REQUIRED on ExecuteHandlerDeps in production); the
    // watch-manager composer reads `executeDeps.executorConfig.connectionMcp`
    // (mcp-resource poll source), so executeDeps carries its own executorConfig.
    executeDeps: {
      tag: 'execute-deps',
      recipeStore: { listStored: () => [], setOnMutated: () => {} },
      executorConfig: { connectionMcp: undefined },
    },
    executorConfig: {
      connectionApi: undefined,
      manifests: {
        get: vi.fn(() => null),
        slugs: vi.fn(() => []),
      },
    },
  },
  rpc: {
    // D-289 — `composeListeners` publishes the saved-view store into the rpc
    // context BEFORE the listeners start, so a pack installed by the very
    // first request has somewhere to put its views. A double without it threw
    // `publishSavedDataViewStore is not a function` out of composition, which
    // failed 39 of this file's 43 cases at once — none of them about saved
    // views. ⚠ It RECORDS rather than no-ops: a setter whose double forgets
    // the value cannot tell "published the store" from "published nothing".
    publishedSavedDataViewStore: undefined as unknown,
    publishSavedDataViewStore: vi.fn(function (
      this: { publishedSavedDataViewStore: unknown },
      store: unknown,
    ): void {
      // `this` is the rpc object — composition calls it as
      // `rpc.publishSavedDataViewStore(store)`. The literal cannot name itself
      // while it is still being built.
      this.publishedSavedDataViewStore = store;
    }),
    // D-296 — same publish-before-listen shape, for the trigger preview.
    publishTriggerPreview: vi.fn(),
    publishReceptionPairs: vi.fn(),
    // D-304 — the stores a recipe's own state lives in, for the uninstall preview.
    publishRecipeOwnedState: vi.fn(),
    housekeepingRpcDeps: undefined,
    upstreamMergeDeps: undefined,
    contactMergeDeps: undefined,
    engagementHealthDeps: undefined,
    observabilityBundle: {
      recipeListDeps: { tag: 'recipe-list-deps' },
      approvalDeps: { tag: 'approval-deps' },
      eventsDeps: { tag: 'events-deps' },
      auditExportDeps: undefined,
      executionFeedDeps: undefined,
      statusPageDeps: undefined,
    },
  },
  runtimeConfig: undefined,
  bootstrapDeps: undefined,
  scheduleDeps: undefined,
  migrateDeps: undefined,
  pressureDeps: undefined,
  lifecycle: undefined,
  clientTokens: undefined,
  exposureDeps: undefined,
  tlsDomainDeps: undefined,
  tokenRotationEmitter: undefined,
  rotationEngine: undefined,
  passportFetchDeps: undefined,
  proAuthMachine: undefined,
  receptionRpcDeps: undefined,
  receptionPortDeps: undefined,
  mcpHttpDeps: undefined,
  llmGatewayDeps: undefined,
  ...overrides,
}) as unknown as ComposeListenersOptions;

describe('composeListeners', () => {
  it('reads Chat receive health from the live supervisor and overrides it when paused or locked', async () => {
    const base = makeOptions(); const connectionStore = createConnectionStore(storageDb);
    connectionStore.upsert({ kind: 'notification', name: 'telegram', subtype: 'telegram', display_name: 'Telegram',
      config_json: JSON.stringify({ chat_id: '1', webhook_secret: 'fixture-secret' }),
      auth_ciphertext: Buffer.from(JSON.stringify({ type: 'bearer', token: 'fixture-token' })).toString('base64'),
      enrolled_at: 1, updated_at: 1 });
    ensureChatSchema(storageDb); const store = createChatStore(storageDb);
    const selfSignature = { server_kind: 'recued' as const, version: '1', instance_id: 'health-composition' };
    const orchestrator = createChatOrchestrator({ chatStore: store, selfSignature,
      registry: { list: () => [], listByTier: () => [], getByName: () => null,
        dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} } });
    const chatDeps: ChatRpcDeps = { store, orchestrator, selfSignature };
    let locked = false; let paused = false;
    const result = await composeListeners(makeOptions({ app: { ...base.app, chatDeps, connectionStoreRef: connectionStore,
      isVaultUnlocked: () => !locked, serverState: { isPaused: () => paused } } }));
    try {
      expect(result.messengerIngressSupervisor?.status('telegram', 'telegram')?.state).toBe('webhook');
      expect(chatDeps.messengerReceiveStatus?.('telegram')).toBe('webhook');
      paused = true; expect(chatDeps.messengerReceiveStatus?.('telegram')).toBe('paused');
      locked = true; expect(chatDeps.messengerReceiveStatus?.('telegram')).toBe('locked');
      paused = false; locked = false;
      connectionStore.upsert({ ...connectionStore.get('notification', 'telegram')!, config_json: '{broken', updated_at: 2 });
      await vi.waitFor(() => expect(chatDeps.messengerReceiveStatus?.('telegram')).toBe('invalid'));
      expect(chatDeps.messengerReceiveStatus?.('slack')).toBe('unknown');
    } finally { await result.server.close(); }
  });

  it('reconciles installed packs before composing any intake surface, then validates the result', async () => {
    const contractStore = createContractStore(storageDb, { now: () => 1 });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
    const base = makeOptions();
    const localManifestStore = {
      listManifests: vi.fn(() => []),
    };

    await composeListeners(makeOptions({
      storage: {
        ...(base.storage as unknown as Record<string, unknown>),
        localManifestStore,
      },
      app: {
        ...(base.app as unknown as Record<string, unknown>),
        contractStoreRef: contractStore,
      },
    }));

    expect(listenerMocks.reconcileInstalledPacksOnBoot).toHaveBeenCalledWith(
      expect.objectContaining({ contractStore, localManifestStore }),
    );
    expect(listenerMocks.checkInstalledManifestsOnBoot).toHaveBeenCalledOnce();
    expect(listenerMocks.reconcileInstalledPacksOnBoot.mock.invocationCallOrder[0])
      .toBeLessThan(listenerMocks.checkInstalledManifestsOnBoot.mock.invocationCallOrder[0]!);
    expect(listenerMocks.checkInstalledManifestsOnBoot.mock.invocationCallOrder[0])
      .toBeLessThan(listenerMocks.composeWebhookListeners.mock.invocationCallOrder[0]!);
    expect(listenerMocks.composeWebhookListeners.mock.invocationCallOrder[0])
      .toBeLessThan(listenerMocks.createServerHandlerSet.mock.invocationCallOrder[0]!);
  });

  // ⛔ THE DELIVERY, NOT THE MESSAGE. A boot finding that only reaches
  //    `console.warn` does not reach the unattended owner it exists for, and
  //    this tree already carries two owner-ping producers marked "ready-to-wire,
  //    boot wiring DEFERRED" that nothing calls. So what is pinned here is that
  //    composeListeners INVOKES the ping — the half those two are missing.

  it('notifies the owner when the boot check finds packs that no longer run', async () => {
    const found = [{ slug: 'codex-pack', version: 1, codes: ['CLI_LEGACY_UNSUPERVISED_DETACH'], detail: 'x' }];
    // ⚠ The hoisted `vi.fn(() => [])` infers `never[]`, so both the override and
    //   the call-arg read need the real row shape named rather than inferred.
    (listenerMocks.checkInstalledManifestsOnBoot as unknown as {
      mockReturnValueOnce: (v: typeof found) => void;
    }).mockReturnValueOnce(found);
    const base = makeOptions();

    await composeListeners(makeOptions({
      storage: {
        ...(base.storage as unknown as Record<string, unknown>),
        localManifestStore: { listManifests: vi.fn(() => []) },
      },
      execution: {
        ...(base.execution as unknown as Record<string, unknown>),
        notificationBlock: {
          ask: vi.fn(async () => ({ ask_id: 'ask-1' })),
          listOpenAsks: vi.fn(async () => []),
        },
      },
    }));

    expect(listenerMocks.notifyUnrunnablePacks).toHaveBeenCalledOnce();
    expect(
      (listenerMocks.notifyUnrunnablePacks.mock.calls as unknown as ReadonlyArray<ReadonlyArray<unknown>>)[0]![0],
    ).toEqual(found);
  });

  /** The third argument — the deep link. Pinned HERE and not only in the
   *  builder's own unit test, because the composition root is where the base
   *  URL and the "one pack or many?" choice actually meet; the builder alone
   *  cannot be wrong about either. */
  it('threads a pack-detail deep link when the server is publicly named', async () => {
    const prior = process.env.RECUED_PUBLIC_BASE_URL;
    process.env.RECUED_PUBLIC_BASE_URL = 'https://home.example.net';
    try {
      // The validator sees the persisted decomposed catalog (`codex`), not the
      // owner-facing pack (`codex-pack`). The inventory join must cross that
      // identity seam before constructing the detail route.
      const found = [{ slug: 'codex', version: 1, codes: ['CLI_LEGACY_SUPERVISION'], detail: 'x' }];
      (listenerMocks.checkInstalledManifestsOnBoot as unknown as {
        mockReturnValueOnce: (v: typeof found) => void;
      }).mockReturnValueOnce(found);
      const contractStore = createContractStore(storageDb, { now: () => 1 });
      contractStore.seedSchema(D165_CONTRACT_SCHEMA);
      recordPackInventory(contractStore, {
        pack_slug: 'codex-pack',
        publisher: 'recued-core',
        pack_version: 1,
        contents: [],
        local_catalogs: [{
          ingredient_id: 'codex',
          version: 1,
          catalog_kind: 'official',
        }],
        installed_at: 1,
      });
      const base = makeOptions();
      await composeListeners(makeOptions({
        storage: {
          ...(base.storage as unknown as Record<string, unknown>),
          localManifestStore: { listManifests: vi.fn(() => []) },
        },
        app: {
          ...(base.app as unknown as Record<string, unknown>),
          contractStoreRef: contractStore,
        },
        execution: {
          ...(base.execution as unknown as Record<string, unknown>),
          notificationBlock: {
            ask: vi.fn(async () => ({ ask_id: 'ask-1' })),
            listOpenAsks: vi.fn(async () => []),
          },
        },
      }));
      expect(
        (listenerMocks.notifyUnrunnablePacks.mock.calls as unknown as ReadonlyArray<ReadonlyArray<unknown>>)[0]![0],
      ).toEqual([{ ...found[0], slug: 'codex-pack' }]);
      expect(
        (listenerMocks.notifyUnrunnablePacks.mock.calls as unknown as ReadonlyArray<ReadonlyArray<unknown>>)[0]![2],
      ).toBe('https://home.example.net/#packs/codex-pack');
    } finally {
      if (prior === undefined) delete process.env.RECUED_PUBLIC_BASE_URL;
      else process.env.RECUED_PUBLIC_BASE_URL = prior;
    }
  });

  it('links to the LIST when several packs are unrunnable — no single destination', async () => {
    const prior = process.env.RECUED_PUBLIC_BASE_URL;
    process.env.RECUED_PUBLIC_BASE_URL = 'https://home.example.net';
    try {
      const found = [
        { slug: 'codex-pack', version: 1, codes: ['CLI_LEGACY_SUPERVISION'], detail: 'x' },
        { slug: 'rental-book', version: 1, codes: ['CLI_LEGACY_PROGRESS'], detail: 'y' },
      ];
      (listenerMocks.checkInstalledManifestsOnBoot as unknown as {
        mockReturnValueOnce: (v: typeof found) => void;
      }).mockReturnValueOnce(found);
      const base = makeOptions();
      await composeListeners(makeOptions({
        storage: {
          ...(base.storage as unknown as Record<string, unknown>),
          localManifestStore: { listManifests: vi.fn(() => []) },
        },
        execution: {
          ...(base.execution as unknown as Record<string, unknown>),
          notificationBlock: {
            ask: vi.fn(async () => ({ ask_id: 'ask-1' })),
            listOpenAsks: vi.fn(async () => []),
          },
        },
      }));
      expect(
        (listenerMocks.notifyUnrunnablePacks.mock.calls as unknown as ReadonlyArray<ReadonlyArray<unknown>>)[0]![2],
      ).toBe('https://home.example.net/#packs');
    } finally {
      if (prior === undefined) delete process.env.RECUED_PUBLIC_BASE_URL;
      else process.env.RECUED_PUBLIC_BASE_URL = prior;
    }
  });

  it('passes NO link on a server with no public base URL', async () => {
    const prior = process.env.RECUED_PUBLIC_BASE_URL;
    delete process.env.RECUED_PUBLIC_BASE_URL;
    try {
      const found = [{ slug: 'codex-pack', version: 1, codes: ['CLI_LEGACY_SUPERVISION'], detail: 'x' }];
      (listenerMocks.checkInstalledManifestsOnBoot as unknown as {
        mockReturnValueOnce: (v: typeof found) => void;
      }).mockReturnValueOnce(found);
      const base = makeOptions();
      await composeListeners(makeOptions({
        storage: {
          ...(base.storage as unknown as Record<string, unknown>),
          localManifestStore: { listManifests: vi.fn(() => []) },
        },
        execution: {
          ...(base.execution as unknown as Record<string, unknown>),
          notificationBlock: {
            ask: vi.fn(async () => ({ ask_id: 'ask-1' })),
            listOpenAsks: vi.fn(async () => []),
          },
        },
      }));
      expect(
        (listenerMocks.notifyUnrunnablePacks.mock.calls as unknown as ReadonlyArray<ReadonlyArray<unknown>>)[0]![2],
      ).toBeUndefined();
    } finally {
      if (prior !== undefined) process.env.RECUED_PUBLIC_BASE_URL = prior;
    }
  });

  it('stays silent on a healthy boot — an ask every start is an ask nobody reads', async () => {
    const base = makeOptions();
    await composeListeners(makeOptions({
      storage: {
        ...(base.storage as unknown as Record<string, unknown>),
        localManifestStore: { listManifests: vi.fn(() => []) },
      },
    }));
    expect(listenerMocks.notifyUnrunnablePacks).not.toHaveBeenCalled();
  });

  it('removes a retired shipped recipe at boot, through the store whose deletion hooks it registered', async () => {
    // D-193 amendment (owner: "yes remove the dead schedule-recipe at boot").
    // The removal is pinned in `retired-recipe-removal.test.ts`; this pins that
    // the REAL composition runs it, on the store the hooks are on.
    const dir = mkdtempSync(join(tmpdir(), 'compose-listeners-retired-'));
    try {
      const recipes = createRecipeStore(dir, storageDb);
      const shipped = (recipe_id: string, steps: unknown[]) => ({
        recipe_id, version: 1, steps,
        metadata: { name: recipe_id, description: 'fixture', author: 'recued-core', tags: [] },
      }) as never;
      recipes.save(shipped('schedule-recipe', [{ id: 'schedule', op: 'core.schedule.recipe', args: {} }]),
        'recued-core', 'bundled', 1, 'personal-organizer-foundation');
      recipes.save(shipped('today', []), 'recued-core', 'bundled', 1, 'personal-organizer-foundation');
      const base = makeOptions();
      const execution = base.execution as unknown as { executeDeps: Record<string, unknown> };
      await composeListeners(makeOptions({
        execution: { ...execution, executeDeps: { ...execution.executeDeps, recipeStore: recipes } },
      }));
      expect(recipes.getStored('schedule-recipe')).toBeNull();
      expect(recipes.getStored('today')).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops listeners despite a sibling teardown failure and coalesces close', async () => {
    const failure = new Error('synthetic handler drain failure');
    listenerMocks.handlerSet.close.mockRejectedValueOnce(failure);
    const result = await composeListeners(makeOptions());

    const first = result.server.close();
    const second = result.server.close();
    expect(second).toBe(first);
    await expect(first).rejects.toSatisfy((error: unknown) =>
      error instanceof AggregateError && error.errors.includes(failure));
    expect(listenerMocks.handlerSet.close).toHaveBeenCalledTimes(1);
    expect(listenerMocks.coordinator.stop).toHaveBeenCalledTimes(1);
  });

  it('opens the mail-fact events held since the mailboxes started, once', async () => {
    const options = makeOptions();
    await composeListeners(options);
    const { open } = (options.collection as unknown as { mailFactEvents: { open: ReturnType<typeof vi.fn> } }).mailFactEvents;
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('seals the boot scan’s recorded mail events as the dispatcher composes, and replays them once, after', async () => {
    const options = makeOptions();
    await composeListeners(options);
    const { seal, replay } = (options.collection as unknown as {
      bootEvents: { seal: ReturnType<typeof vi.fn>; replay: ReturnType<typeof vi.fn> };
    }).bootEvents;
    expect(seal).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(seal.mock.invocationCallOrder[0]!).toBeLessThan(replay.mock.invocationCallOrder[0]!);
  });

  it('publishes the live bridge dispatcher after handler assembly and before listener coordination', async () => {
    const publishBridgeDispatcher = vi.fn();

    await composeListeners(makeOptions({ publishBridgeDispatcher }));

    expect(publishBridgeDispatcher).toHaveBeenCalledOnce();
    expect(publishBridgeDispatcher).toHaveBeenCalledWith(
      listenerMocks.handlerSet.wsHandle.bridgeDispatcher,
    );
    expect(listenerMocks.createServerHandlerSet.mock.invocationCallOrder[0])
      .toBeLessThan(publishBridgeDispatcher.mock.invocationCallOrder[0]);
    expect(publishBridgeDispatcher.mock.invocationCallOrder[0])
      .toBeLessThan(
        listenerMocks.createProductionPathListenerCoordinator.mock.invocationCallOrder[0],
      );
  });

  it('threads live D-201 stores and binding-count retirement authority into WS', async () => {
    const options = makeOptions();
    const store = { tag: 'webhook-ingress-store' };
    const deliveryStore = { tag: 'webhook-delivery-store' };
    const consumerStore = {
      listBindings: vi.fn(() => [
        { ingress_id: 'whi_targettargettargettargettargettarget12' },
        { ingress_id: 'whi_otherotherotherotherotherother123' },
      ]),
    };
    (options.app as unknown as Record<string, unknown>).webhookIngressStoreRef = store;
    (options.app as unknown as Record<string, unknown>).webhookDeliveryStoreRef = deliveryStore;
    (options.app as unknown as Record<string, unknown>).webhookConsumerStoreRef = consumerStore;
    (options.app as unknown as Record<string, unknown>).connectionStoreRef = {
      get: vi.fn(() => null),
    };
    (options.app as unknown as Record<string, unknown>).keys = {
      state: vi.fn(() => 'uninitialized'),
      keyProvider: vi.fn(() => () => new Uint8Array(32).fill(9)),
    };

    await composeListeners(options);

    expect(listenerMocks.createServerHandlerSet).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookIngressDeps: expect.objectContaining({
          store,
          deliveryStore,
          runtimeReadiness: expect.any(Function),
          managedRegistration: expect.objectContaining({
            reconcile: expect.any(Function),
            cleanup: expect.any(Function),
            rebind: expect.any(Function),
          }),
          countConsumerBindings: expect.any(Function),
        }),
      }),
    );
    const serverConfig = (
      listenerMocks.createServerHandlerSet.mock.calls as unknown as Array<[unknown]>
    )[0]?.[0];
    const webhookIngressDeps = (serverConfig as {
      webhookIngressDeps?: { countConsumerBindings?: (ingressId: string) => number };
    }).webhookIngressDeps;
    expect(webhookIngressDeps?.countConsumerBindings?.(
      'whi_targettargettargettargettargettarget12',
    )).toBe(1);
    expect((options.execution.executeDeps as {
      operationBoundWebhook?: unknown;
    }).operationBoundWebhook).toEqual(expect.any(Function));
    expect(serverConfig).not.toHaveProperty('webhookProfileListener');
  });

  it('composes managed Stripe registration through the encrypted paired connection', async () => {
    const originalBase = process.env.RECUED_PUBLIC_BASE_URL;
    const originalFetch = globalThis.fetch;
    const connectionKey = new Uint8Array(32).fill(8);
    const webhookKey = new Uint8Array(32).fill(4);
    const ingressStore = createWebhookIngressStore(storageDb, {
      getEncryptionKey: () => webhookKey,
      newIngressId: () => 'whi_0123456789abcdef0123456789abcdef',
      newPublicId: () => 'opaquePublicId_0123456789abcdef',
      newCredentialSetRef: () => 'whc_0123456789abcdef0123456789abcdef',
    });
    const connectionStore = createConnectionStore(storageDb);
    const authCiphertext = await encodeAuthForStorage({
      type: 'basic',
      username: 'sk_test_COMPOSEDKEY123',
      password: '',
    }, { kind: 'api', name: 'stripe-test' }, () => connectionKey);
    connectionStore.upsert({
      kind: 'api',
      name: 'stripe-test',
      display_name: 'Stripe test account',
      config_json: JSON.stringify({
        vendor: 'stripe',
        base_url: 'https://api.stripe.com',
      }),
      auth_ciphertext: authCiphertext,
      enrolled_at: 1,
      updated_at: 1,
    });
    const rotatedAuthCiphertext = await encodeAuthForStorage({
      type: 'basic',
      username: 'sk_test_COMPOSEDKEY123',
      password: '',
    }, { kind: 'api', name: 'stripe-test-rotated' }, () => connectionKey);
    connectionStore.upsert({
      kind: 'api',
      name: 'stripe-test-rotated',
      display_name: 'Stripe test account rotated key',
      config_json: JSON.stringify({
        vendor: 'stripe',
        base_url: 'https://api.stripe.com',
      }),
      auth_ciphertext: rotatedAuthCiphertext,
      enrolled_at: 2,
      updated_at: 2,
    });
    const ingress = ingressStore.create({
      display_name: 'Managed Stripe events',
      profile_id: 'stripe.event.v1',
      environment: 'test',
      paired_connection_id: 'stripe-test',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['invoice.paid'],
    });
    const endpointUrl = `https://hooks.example.test/v1/webhooks/${ingress.public_id}`;
    const stripeEndpoint = (withSecret: boolean): Record<string, unknown> => ({
      id: 'we_composed123456789',
      object: 'webhook_endpoint',
      livemode: false,
      status: 'enabled',
      url: endpointUrl,
      enabled_events: ['invoice.paid'],
      metadata: {
        recued_ingress_id: ingress.ingress_id,
        recued_profile_id: 'stripe.event.v1',
        recued_environment: 'test',
      },
      ...(withSecret ? { secret: 'whsec_ComposedSecret123' } : {}),
    });
    let deleted = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (init?.method === 'GET' && value.includes('?')) {
        return new Response(JSON.stringify({
          object: 'list',
          has_more: false,
          data: [],
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (init?.method === 'DELETE') {
        deleted = true;
        return new Response(JSON.stringify({
          id: 'we_composed123456789',
          object: 'webhook_endpoint',
          deleted: true,
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (init?.method === 'GET' && deleted) {
        return new Response(JSON.stringify({ error: { type: 'invalid_request_error' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(stripeEndpoint(init?.method === 'POST')), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    process.env.RECUED_PUBLIC_BASE_URL = 'https://hooks.example.test';
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const options = makeOptions();
      (options.app as unknown as Record<string, unknown>).webhookIngressStoreRef = ingressStore;
      (options.app as unknown as Record<string, unknown>).connectionStoreRef = connectionStore;
      (options.app as unknown as Record<string, unknown>).keys = {
        state: vi.fn(() => 'unlocked'),
        keyProvider: vi.fn((subkey: string) => () =>
          subkey === 'connection' ? connectionKey : webhookKey),
      };

      await composeListeners(options);
      const serverConfig = (
        listenerMocks.createServerHandlerSet.mock.calls as unknown as Array<[unknown]>
      )[0]?.[0] as {
        webhookIngressDeps?: {
          managedRegistration?: {
            reconcile(ingressId: string): Promise<unknown>;
            cleanup(ingressId: string, intent: 'disable' | 'retire'): Promise<unknown>;
            rebind(ingressId: string, pairedConnectionId: string): Promise<unknown>;
          };
        };
      };
      await expect(serverConfig.webhookIngressDeps?.managedRegistration?.reconcile(
        ingress.ingress_id,
      )).resolves.toMatchObject({
        remote_endpoint_id: 'we_composed123456789',
        registration_state: 'registered',
        intake_state: 'ready',
      });
      expect(JSON.stringify(await ingressStore.readActiveCredentialVersions(
        ingress.ingress_id,
      ))).toContain('whsec_ComposedSecret123');
      await expect(serverConfig.webhookIngressDeps?.managedRegistration?.rebind(
        ingress.ingress_id,
        'stripe-test-rotated',
      )).resolves.toMatchObject({
        paired_connection_id: 'stripe-test-rotated',
        remote_endpoint_id: 'we_composed123456789',
        registration_state: 'registered',
        intake_state: 'ready',
      });
      await expect(serverConfig.webhookIngressDeps?.managedRegistration?.cleanup(
        ingress.ingress_id,
        'disable',
      )).resolves.toMatchObject({
        remote_endpoint_id: null,
        registration_state: 'managed_pending',
        intake_state: 'disabled',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(6);
      for (const [, init] of fetchImpl.mock.calls) {
        const headers = init?.headers as Headers;
        expect(Buffer.from(
          headers.get('Authorization')!.slice('Basic '.length),
          'base64',
        ).toString('utf8')).toBe('sk_test_COMPOSEDKEY123:');
      }
      await expect(ingressStore.readActiveCredentialVersions(ingress.ingress_id))
        .resolves.toEqual([]);
      expect(ingressStore.listCredentialVersions(ingress.ingress_id))
        .toEqual([expect.objectContaining({ active: false })]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBase === undefined) delete process.env.RECUED_PUBLIC_BASE_URL;
      else process.env.RECUED_PUBLIC_BASE_URL = originalBase;
    }
  });

  it('composes Telegram singleton registration and preserves its generated secret on update', async () => {
    const originalBase = process.env.RECUED_PUBLIC_BASE_URL;
    const originalFetch = globalThis.fetch;
    const connectionKey = new Uint8Array(32).fill(8);
    const webhookKey = new Uint8Array(32).fill(4);
    const ingressStore = createWebhookIngressStore(storageDb, {
      getEncryptionKey: () => webhookKey,
      newIngressId: () => 'whi_abcdef0123456789abcdef0123456789',
      newPublicId: () => 'opaqueTelegram_0123456789abcdef',
      newCredentialSetRef: () => 'whc_abcdef0123456789abcdef0123456789',
    });
    const connectionStore = createConnectionStore(storageDb);
    const botToken = '123456:ComposedTelegramBotToken_123456789';
    const authCiphertext = await encodeAuthForStorage({
      type: 'bearer',
      token: botToken,
    }, { kind: 'notification', name: 'telegram-bot' }, () => connectionKey);
    connectionStore.upsert({
      kind: 'notification',
      subtype: 'telegram',
      name: 'telegram-bot',
      display_name: 'Telegram bot',
      config_json: JSON.stringify({ vendor: 'telegram' }),
      auth_ciphertext: authCiphertext,
      enrolled_at: 1,
      updated_at: 1,
    });
    const ingress = ingressStore.create({
      display_name: 'Managed Telegram updates',
      profile_id: 'telegram.bot-webhook.v1',
      environment: 'custom',
      paired_connection_id: 'telegram-bot',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['message'],
    });
    const endpointUrl = `https://hooks.example.test/v1/webhooks/${ingress.public_id}`;
    let remoteUrl = '';
    let remoteEvents: string[] = [];
    let remoteSecret: string | null = null;
    const setSecrets: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      expect(value).toContain(
        `https://api.telegram.org/bot${encodeURIComponent(botToken)}/`,
      );
      if (value.endsWith('/getMe')) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            id: 123456,
            is_bot: true,
            first_name: 'Recued test bot',
          },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (value.endsWith('/getWebhookInfo')) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            url: remoteUrl,
            has_custom_certificate: false,
            pending_update_count: 0,
            ...(remoteUrl.length > 0 ? { allowed_updates: remoteEvents } : {}),
          },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (value.endsWith('/setWebhook')) {
        const body = JSON.parse(String(init?.body)) as {
          url: string;
          allowed_updates: string[];
          secret_token: string;
          drop_pending_updates: boolean;
        };
        expect(body.drop_pending_updates).toBe(false);
        remoteUrl = body.url;
        remoteEvents = body.allowed_updates.slice();
        remoteSecret = body.secret_token;
        setSecrets.push(body.secret_token);
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (value.endsWith('/deleteWebhook')) {
        expect(JSON.parse(String(init?.body))).toEqual({ drop_pending_updates: false });
        remoteUrl = '';
        remoteEvents = [];
        remoteSecret = null;
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error('unexpected Telegram Bot API method');
    });
    process.env.RECUED_PUBLIC_BASE_URL = 'https://hooks.example.test';
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const options = makeOptions();
      (options.app as unknown as Record<string, unknown>).webhookIngressStoreRef = ingressStore;
      (options.app as unknown as Record<string, unknown>).connectionStoreRef = connectionStore;
      (options.app as unknown as Record<string, unknown>).keys = {
        state: vi.fn(() => 'unlocked'),
        keyProvider: vi.fn((subkey: string) => () =>
          subkey === 'connection' ? connectionKey : webhookKey),
      };

      await composeListeners(options);
      const serverConfig = (
        listenerMocks.createServerHandlerSet.mock.calls as unknown as Array<[unknown]>
      )[0]?.[0] as {
        webhookIngressDeps?: {
          managedRegistration?: {
            reconcile(ingressId: string): Promise<unknown>;
            cleanup(ingressId: string, intent: 'disable' | 'retire'): Promise<unknown>;
          };
        };
      };
      const managed = serverConfig.webhookIngressDeps?.managedRegistration;
      await expect(managed?.reconcile(ingress.ingress_id)).resolves.toMatchObject({
        remote_endpoint_id: telegramTestRemoteId,
        registration_state: 'registered',
        intake_state: 'ready',
      });
      const firstSecret = remoteSecret;
      expect(firstSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await expect(ingressStore.readActiveCredentialVersions(ingress.ingress_id))
        .resolves.toEqual([
          expect.objectContaining({ credentials: { secret_token: firstSecret } }),
        ]);

      ingressStore.update(ingress.ingress_id, {
        selected_event_types: ['callback_query'],
      });
      await expect(managed?.reconcile(ingress.ingress_id)).resolves.toMatchObject({
        registration_state: 'registered',
        selected_event_types: ['callback_query'],
      });
      expect(remoteEvents).toEqual(['callback_query']);
      expect(remoteSecret).toBe(firstSecret);
      expect(setSecrets).toEqual([firstSecret, firstSecret]);

      await expect(managed?.cleanup(ingress.ingress_id, 'disable'))
        .resolves.toMatchObject({
          remote_endpoint_id: null,
          registration_state: 'managed_pending',
          intake_state: 'disabled',
        });
      expect(remoteUrl).toBe('');
      expect(remoteSecret).toBeNull();
      await expect(ingressStore.readActiveCredentialVersions(ingress.ingress_id))
        .resolves.toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(14);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBase === undefined) delete process.env.RECUED_PUBLIC_BASE_URL;
      else process.env.RECUED_PUBLIC_BASE_URL = originalBase;
    }
  });

  it('composes target-scoped GitHub registration only through personal access tokens', async () => {
    const originalBase = process.env.RECUED_PUBLIC_BASE_URL;
    const originalFetch = globalThis.fetch;
    const connectionKey = new Uint8Array(32).fill(8);
    const webhookKey = new Uint8Array(32).fill(4);
    const ingressIds = [
      'whi_11111111111111111111111111111111',
      'whi_22222222222222222222222222222222',
    ];
    const publicIds = [
      'opaqueGithubRepo_0123456789abcdef',
      'opaqueGithubOrg_0123456789abcdef',
    ];
    const credentialRefs = [
      'whc_11111111111111111111111111111111',
      'whc_22222222222222222222222222222222',
    ];
    const ingressStore = createWebhookIngressStore(storageDb, {
      getEncryptionKey: () => webhookKey,
      newIngressId: () => ingressIds.shift()!,
      newPublicId: () => publicIds.shift()!,
      newCredentialSetRef: () => credentialRefs.shift()!,
    });
    const connectionStore = createConnectionStore(storageDb);
    const pat = 'github_pat_ComposedPersonalAccessToken_123456789';
    const patCiphertext = await encodeAuthForStorage({
      type: 'bearer',
      token: pat,
    }, { kind: 'api', name: 'github-pat' }, () => connectionKey);
    connectionStore.upsert({
      kind: 'api',
      name: 'github-pat',
      display_name: 'GitHub personal token',
      config_json: JSON.stringify({
        vendor: 'github',
        base_url: 'https://api.github.com',
      }),
      auth_ciphertext: patCiphertext,
      enrolled_at: 1,
      updated_at: 1,
    });
    const oauthCiphertext = await encodeAuthForStorage({
      type: 'bearer',
      token: 'gho_ComposedOAuthAccessToken_123456789',
    }, { kind: 'api', name: 'github-oauth' }, () => connectionKey);
    connectionStore.upsert({
      kind: 'api',
      name: 'github-oauth',
      display_name: 'GitHub OAuth token',
      config_json: JSON.stringify({
        vendor: 'github',
        base_url: 'https://api.github.com',
      }),
      auth_ciphertext: oauthCiphertext,
      enrolled_at: 2,
      updated_at: 2,
    });
    const repositoryIngress = ingressStore.create({
      display_name: 'Managed GitHub repository events',
      profile_id: 'github.webhook.v1',
      environment: 'live',
      paired_connection_id: 'github-pat',
      registration_target: { kind: 'repository', key: 'openai/example' },
      registration_mode: 'managed_endpoint',
      selected_event_types: ['issues'],
    });
    const organizationIngress = ingressStore.create({
      display_name: 'Managed GitHub organization events',
      profile_id: 'github.webhook.v1',
      environment: 'live',
      paired_connection_id: 'github-oauth',
      registration_target: { kind: 'organization', key: 'openai' },
      registration_mode: 'managed_endpoint',
      selected_event_types: ['repository'],
    });
    const endpointUrl =
      `https://hooks.example.test/v1/webhooks/${repositoryIngress.public_id}`;
    let remoteEvents = ['issues'];
    let remoteSecret: string | null = null;
    const sentSecrets: string[] = [];
    const githubHook = (): Record<string, unknown> => ({
      id: 987,
      name: 'web',
      type: 'Repository',
      active: true,
      events: remoteEvents.slice(),
      config: {
        url: endpointUrl,
        content_type: 'json',
        insecure_ssl: '0',
      },
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      expect(value.startsWith('https://api.github.com/')).toBe(true);
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${pat}`);
      if (value.startsWith('https://api.github.com/orgs/openai/hooks')) {
        return new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (init?.method === 'GET' && value.includes('?')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          name: string;
          active: boolean;
          events: string[];
          config: { url: string; secret: string };
        };
        expect(body).toMatchObject({ name: 'web', active: true });
        expect(body.config.url).toBe(endpointUrl);
        remoteEvents = body.events.slice();
        remoteSecret = body.config.secret;
        sentSecrets.push(body.config.secret);
        return new Response(JSON.stringify(githubHook()), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as {
          active: boolean;
          events: string[];
          config: { url: string; secret: string };
          name?: unknown;
        };
        expect(body.name).toBeUndefined();
        expect(body.config.url).toBe(endpointUrl);
        remoteEvents = body.events.slice();
        remoteSecret = body.config.secret;
        sentSecrets.push(body.config.secret);
        return new Response(JSON.stringify(githubHook()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (init?.method === 'GET' && value.endsWith('/hooks/987')) {
        return new Response(JSON.stringify(githubHook()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected GitHub API request: ${init?.method} ${value}`);
    });
    process.env.RECUED_PUBLIC_BASE_URL = 'https://hooks.example.test';
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const options = makeOptions();
      (options.app as unknown as Record<string, unknown>).webhookIngressStoreRef = ingressStore;
      (options.app as unknown as Record<string, unknown>).connectionStoreRef = connectionStore;
      (options.app as unknown as Record<string, unknown>).keys = {
        state: vi.fn(() => 'unlocked'),
        keyProvider: vi.fn((subkey: string) => () =>
          subkey === 'connection' ? connectionKey : webhookKey),
      };

      await composeListeners(options);
      const serverConfig = (
        listenerMocks.createServerHandlerSet.mock.calls as unknown as Array<[unknown]>
      )[0]?.[0] as {
        webhookIngressDeps?: {
          managedRegistration?: {
            reconcile(ingressId: string): Promise<unknown>;
          };
        };
      };
      const managed = serverConfig.webhookIngressDeps?.managedRegistration;
      await expect(managed?.reconcile(repositoryIngress.ingress_id))
        .resolves.toMatchObject({
          remote_endpoint_id: '987',
          registration_state: 'registered',
          intake_state: 'ready',
        });
      expect(remoteSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await expect(ingressStore.readActiveCredentialVersions(
        repositoryIngress.ingress_id,
      )).resolves.toEqual([
        expect.objectContaining({ credentials: { webhook_secret: remoteSecret } }),
      ]);

      ingressStore.update(repositoryIngress.ingress_id, {
        selected_event_types: ['pull_request'],
      });
      await expect(managed?.reconcile(repositoryIngress.ingress_id))
        .resolves.toMatchObject({
          registration_state: 'registered',
          selected_event_types: ['pull_request'],
        });
      expect(remoteEvents).toEqual(['pull_request']);
      expect(sentSecrets).toEqual([remoteSecret, remoteSecret]);

      const requestsBeforeOAuth = fetchImpl.mock.calls.length;
      await expect(managed?.reconcile(organizationIngress.ingress_id))
        .rejects.toMatchObject({ code: 'connection_unavailable' });
      expect(fetchImpl).toHaveBeenCalledTimes(requestsBeforeOAuth);

      const replacementCiphertext = await encodeAuthForStorage({
        type: 'bearer',
        token: pat,
      }, { kind: 'api', name: 'github-oauth' }, () => connectionKey);
      connectionStore.upsert({
        kind: 'api',
        name: 'github-oauth',
        display_name: 'GitHub replacement personal token',
        config_json: JSON.stringify({
          vendor: 'github',
          base_url: 'https://api.github.com',
        }),
        auth_ciphertext: replacementCiphertext,
        enrolled_at: 2,
        updated_at: 3,
      });
      await expect(managed?.reconcile(organizationIngress.ingress_id))
        .rejects.toMatchObject({ code: 'upstream_rejected' });
      expect(fetchImpl).toHaveBeenCalledTimes(requestsBeforeOAuth + 1);
      expect(String(fetchImpl.mock.calls.at(-1)?.[0])).toBe(
        'https://api.github.com/orgs/openai/hooks?per_page=100&page=1',
      );
      expect(fetchImpl.mock.calls.at(-1)?.[1]?.method).toBe('GET');
      expect(ingressStore.get(organizationIngress.ingress_id)).toMatchObject({
        remote_endpoint_id: null,
        registration_state: 'managed_pending',
        intake_state: 'draft',
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBase === undefined) delete process.env.RECUED_PUBLIC_BASE_URL;
      else process.env.RECUED_PUBLIC_BASE_URL = originalBase;
    }
  });

  it('composes Paddle registration through modern environment-bound API keys', async () => {
    const originalBase = process.env.RECUED_PUBLIC_BASE_URL;
    const originalFetch = globalThis.fetch;
    const connectionKey = new Uint8Array(32).fill(8);
    const webhookKey = new Uint8Array(32).fill(4);
    const ingressIds = [
      'whi_33333333333333333333333333333333',
      'whi_44444444444444444444444444444444',
    ];
    const publicIds = [
      'opaquePaddleManaged_0123456789abcdef',
      'opaquePaddleLegacy_0123456789abcdef',
    ];
    const credentialRefs = [
      'whc_33333333333333333333333333333333',
      'whc_44444444444444444444444444444444',
    ];
    const ingressStore = createWebhookIngressStore(storageDb, {
      getEncryptionKey: () => webhookKey,
      newIngressId: () => ingressIds.shift()!,
      newPublicId: () => publicIds.shift()!,
      newCredentialSetRef: () => credentialRefs.shift()!,
    });
    const connectionStore = createConnectionStore(storageDb);
    const apiKey =
      `pdl_sdbx_apikey_${'a'.repeat(26)}_${'B'.repeat(22)}_${'C'.repeat(3)}`;
    const enrollBearer = async (name: string, token: string, updatedAt: number) => {
      const ciphertext = await encodeAuthForStorage({
        type: 'bearer',
        token,
      }, { kind: 'api', name }, () => connectionKey);
      connectionStore.upsert({
        kind: 'api',
        name,
        display_name: name,
        config_json: JSON.stringify({
          vendor: 'paddle',
          base_url: 'https://sandbox-api.paddle.com',
        }),
        auth_ciphertext: ciphertext,
        enrolled_at: 1,
        updated_at: updatedAt,
      });
    };
    await enrollBearer('paddle-sandbox', apiKey, 1);
    await enrollBearer('paddle-sandbox-alias', apiKey, 2);
    await enrollBearer('paddle-legacy', 'a'.repeat(50), 3);

    const ingress = ingressStore.create({
      display_name: 'Managed Paddle sandbox events',
      profile_id: 'paddle.notification.v1',
      environment: 'test',
      paired_connection_id: 'paddle-sandbox',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['subscription.updated'],
    });
    const legacyIngress = ingressStore.create({
      display_name: 'Rejected legacy Paddle key',
      profile_id: 'paddle.notification.v1',
      environment: 'test',
      paired_connection_id: 'paddle-legacy',
      registration_mode: 'managed_endpoint',
      selected_event_types: ['transaction.completed'],
    });
    const endpointUrl =
      `https://hooks.example.test/v1/webhooks/${ingress.public_id}`;
    const remoteId = `ntfset_${'a'.repeat(26)}`;
    const endpointSecret = `pdl_${remoteId}_${'S'.repeat(32)}`;
    const expectedDescription =
      `Recued managed webhook | paddle.notification.v1 | test | ${ingress.ingress_id}`;
    let remoteExists = false;
    let remoteDescription = expectedDescription;
    let remoteDestination = endpointUrl;
    let remoteActive = true;
    let remoteApiVersion = 1;
    let remoteSensitive = false;
    let remoteEvents = ['subscription.updated'];
    let remoteTraffic: 'all' | 'platform' | 'simulation' = 'all';
    let searchesBeforeCreate = 0;
    const setting = (): Record<string, unknown> => ({
      id: remoteId,
      description: remoteDescription,
      type: 'url',
      destination: remoteDestination,
      active: remoteActive,
      api_version: remoteApiVersion,
      include_sensitive_fields: remoteSensitive,
      subscribed_events: remoteEvents.map((name) => ({
        name,
        description: `Fixture for ${name}`,
        group: 'Fixture',
        available_versions: [1],
      })),
      endpoint_secret_key: endpointSecret,
      traffic_source: remoteTraffic,
    });
    const responseMeta = { request_id: 'paddle-composition-fixture' };
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.origin).toBe('https://sandbox-api.paddle.com');
      expect(headers.get('Authorization')).toBe(`Bearer ${apiKey}`);
      expect(headers.get('Paddle-Version')).toBe('1');
      if (url.pathname === '/notification-settings' && init?.method === 'GET') {
        if (!remoteExists) searchesBeforeCreate += 1;
        expect(url.searchParams.get('per_page')).toBe('25');
        expect(url.searchParams.get('order_by')).toBe('id[ASC]');
        expect(headers.get('Skip-Count')).toBe('true');
        return json({
          data: remoteExists ? [setting()] : [],
          meta: {
            ...responseMeta,
            pagination: {
              per_page: 25,
              estimated_total: -1,
              next: `https://sandbox-api.paddle.com/notification-settings?after=${remoteId}`,
              has_more: false,
            },
          },
        });
      }
      if (url.pathname === '/notification-settings' && init?.method === 'POST') {
        expect(searchesBeforeCreate).toBe(2);
        expect(headers.has('Idempotency-Key')).toBe(false);
        expect(JSON.parse(String(init.body))).toEqual({
          type: 'url',
          description: expectedDescription,
          destination: endpointUrl,
          api_version: 1,
          include_sensitive_fields: false,
          subscribed_events: ['subscription.updated'],
          traffic_source: 'all',
        });
        remoteExists = true;
        remoteDescription = expectedDescription;
        remoteDestination = endpointUrl;
        remoteActive = true;
        remoteApiVersion = 1;
        remoteSensitive = false;
        remoteEvents = ['subscription.updated'];
        remoteTraffic = 'all';
        return json({ data: setting(), meta: responseMeta }, 201);
      }
      if (url.pathname === `/notification-settings/${remoteId}`
        && init?.method === 'GET') {
        return remoteExists
          ? json({ data: setting(), meta: responseMeta })
          : json({ error: { code: 'not_found' }, meta: responseMeta }, 404);
      }
      if (url.pathname === `/notification-settings/${remoteId}`
        && init?.method === 'PATCH') {
        expect(headers.has('Idempotency-Key')).toBe(false);
        expect(JSON.parse(String(init.body))).toEqual({
          description: expectedDescription,
          destination: endpointUrl,
          active: true,
          api_version: 1,
          include_sensitive_fields: false,
          subscribed_events: ['subscription.updated'],
          traffic_source: 'all',
        });
        remoteDescription = expectedDescription;
        remoteDestination = endpointUrl;
        remoteActive = true;
        remoteApiVersion = 1;
        remoteSensitive = false;
        remoteEvents = ['subscription.updated'];
        remoteTraffic = 'all';
        return json({ data: setting(), meta: responseMeta });
      }
      if (url.pathname === `/notification-settings/${remoteId}`
        && init?.method === 'DELETE') {
        remoteExists = false;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected Paddle API request: ${init?.method} ${url.href}`);
    });
    process.env.RECUED_PUBLIC_BASE_URL = 'https://hooks.example.test';
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const options = makeOptions();
      (options.app as unknown as Record<string, unknown>).webhookIngressStoreRef = ingressStore;
      (options.app as unknown as Record<string, unknown>).connectionStoreRef = connectionStore;
      (options.app as unknown as Record<string, unknown>).keys = {
        state: vi.fn(() => 'unlocked'),
        keyProvider: vi.fn((subkey: string) => () =>
          subkey === 'connection' ? connectionKey : webhookKey),
      };

      await composeListeners(options);
      const serverConfig = (
        listenerMocks.createServerHandlerSet.mock.calls as unknown as Array<[unknown]>
      )[0]?.[0] as {
        webhookIngressDeps?: {
          managedRegistration?: {
            reconcile(ingressId: string): Promise<unknown>;
            rebind(ingressId: string, connectionId: string): Promise<unknown>;
            cleanup(ingressId: string, intent: 'disable' | 'retire'): Promise<unknown>;
          };
        };
      };
      const managed = serverConfig.webhookIngressDeps?.managedRegistration;
      await expect(managed?.reconcile(ingress.ingress_id)).resolves.toMatchObject({
        remote_endpoint_id: remoteId,
        registration_state: 'registered',
        intake_state: 'ready',
      });
      await expect(ingressStore.readActiveCredentialVersions(ingress.ingress_id))
        .resolves.toEqual([
          expect.objectContaining({
            credentials: { endpoint_secret_key: endpointSecret },
          }),
        ]);

      remoteDescription = 'Drifted Paddle destination';
      remoteActive = false;
      remoteApiVersion = 2;
      remoteSensitive = true;
      remoteEvents = [];
      remoteTraffic = 'simulation';
      await expect(managed?.reconcile(ingress.ingress_id)).resolves.toMatchObject({
        remote_endpoint_id: remoteId,
        registration_state: 'registered',
      });
      expect(remoteDescription).toBe(expectedDescription);
      expect(remoteActive).toBe(true);
      expect(remoteApiVersion).toBe(1);
      expect(remoteSensitive).toBe(false);
      expect(remoteEvents).toEqual(['subscription.updated']);
      expect(remoteTraffic).toBe('all');

      await expect(managed?.rebind(
        ingress.ingress_id,
        'paddle-sandbox-alias',
      )).resolves.toMatchObject({
        paired_connection_id: 'paddle-sandbox-alias',
        remote_endpoint_id: remoteId,
        registration_state: 'registered',
      });
      expect(remoteExists).toBe(true);

      await expect(managed?.cleanup(ingress.ingress_id, 'disable'))
        .resolves.toMatchObject({
          paired_connection_id: 'paddle-sandbox-alias',
          remote_endpoint_id: null,
          registration_state: 'managed_pending',
          intake_state: 'disabled',
        });
      expect(remoteExists).toBe(false);
      await expect(ingressStore.readActiveCredentialVersions(ingress.ingress_id))
        .resolves.toEqual([]);

      const callsBeforeLegacy = fetchImpl.mock.calls.length;
      await expect(managed?.reconcile(legacyIngress.ingress_id))
        .rejects.toMatchObject({ code: 'connection_unavailable' });
      expect(fetchImpl).toHaveBeenCalledTimes(callsBeforeLegacy);
      expect(ingressStore.get(legacyIngress.ingress_id)).toMatchObject({
        remote_endpoint_id: null,
        registration_state: 'managed_pending',
        intake_state: 'draft',
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBase === undefined) delete process.env.RECUED_PUBLIC_BASE_URL;
      else process.env.RECUED_PUBLIC_BASE_URL = originalBase;
    }
  });

  it('mounts only the live non-timestamped generic runtime and reports trusted readiness', async () => {
    const originalBase = process.env.RECUED_PUBLIC_BASE_URL;
    const originalReachable = process.env.RECUED_PUBLIC_REACHABLE;
    const originalClockAuthority = process.env.RECUED_WEBHOOK_CLOCK_AUTHORITY_URL;
    const base = makeOptions();
    const ingressStore = createWebhookIngressStore(storageDb, {
      getEncryptionKey: () => new Uint8Array(32).fill(4),
    });
    const consumerStore = createWebhookConsumerStore(storageDb, { ingressStore });
    const deliveryStore = createWebhookDeliveryStore(storageDb, {
      getEncryptionKey: () => new Uint8Array(32).fill(5),
      hasDispatchTarget: (ingressId, eventType) =>
        consumerStore.hasDispatchTarget(ingressId, eventType),
    });
    const auditLog = { get: vi.fn(async () => null) };
    const availableConnections = new Set<string>();
    const connectionStore = {
      get: vi.fn((kind: string, name: string) =>
        kind === 'api' && availableConnections.has(name) ? { kind, name } : null),
    };
    process.env.RECUED_PUBLIC_BASE_URL = 'https://hooks.example.test';
    process.env.RECUED_PUBLIC_REACHABLE = 'true';
    delete process.env.RECUED_WEBHOOK_CLOCK_AUTHORITY_URL;
    try {
      listenerMocks.coordinator.status.mockReturnValue([
        {
          listener: 'lan',
          listening: true,
          port: 4711,
          bind_address: '192.168.1.10',
        },
        {
          listener: 'public',
          listening: true,
          port: 443,
          bind_address: '0.0.0.0',
        },
      ]);
      const result = await composeListeners(makeOptions({
        storage: { ...base.storage, auditLog },
        app: {
          ...base.app,
          webhookIngressStoreRef: ingressStore,
          webhookDeliveryStoreRef: deliveryStore,
          webhookConsumerStoreRef: consumerStore,
          connectionStoreRef: connectionStore,
          isVaultUnlocked: () => true,
        },
        exposureDeps: {
          getMachine: () => ({
            current: async () => ({
              resolution: { webhooks: { lan: true, public: true } },
            }),
          }),
        },
      }));
      const config = (
        listenerMocks.createServerHandlerSet.mock.calls as unknown as Array<[
          Record<string, unknown>,
        ]>
      )[0]![0];
      expect(config.webhookProfileListener).toEqual(expect.any(Function));
      expect(config.recipeSaveDeps).toMatchObject({
        webhookConsumerStore: consumerStore,
      });
      expect(config.webhookIngressDeps).toMatchObject({
        profileCapabilities: [
          {
            profile_id: 'generic.static-header-token.v1',
            registration_modes: ['manual', 'operation_bound'],
          },
          {
            profile_id: 'generic.http-basic.v1',
            registration_modes: ['manual'],
          },
          {
            profile_id: 'generic.raw-body-hmac-sha256.v1',
            registration_modes: ['manual'],
          },
          // ⚠ ORDER IS THE ASSERTION HERE — `toMatchObject` matches an array
          // POSITIONALLY, so this list mirrors the mount order in
          // `createBuiltinWebhookDeliveryProfileAdapters`: the always-mounted
          // primitives, then cal, then telegram / github / lemonsqueezy.
          //
          // ⛔ THIS ENTRY WAS MISSING FOR THREE WEEKS AND THE SUITE WAS RED
          // THE WHOLE TIME. `cal.webhook.v1` landed with the Cal.com meeting
          // pack (`0cb353072`) and this inventory was never updated, so the
          // file failed on every run — training everyone to skim past it,
          // which is the expensive part, not the missing line.
          {
            profile_id: 'cal.webhook.v1',
            registration_modes: ['manual'],
          },
          {
            profile_id: 'telegram.bot-webhook.v1',
            registration_modes: ['manual'],
          },
          {
            profile_id: 'github.webhook.v1',
            registration_modes: ['manual'],
          },
          {
            profile_id: 'lemonsqueezy.webhook.v1',
            registration_modes: ['manual'],
          },
        ],
        testDelivery: {
          supports: expect.any(Function),
          deliver: expect.any(Function),
        },
      });
      const runtimeReadiness = (
        config.webhookIngressDeps as {
          runtimeReadiness: (
            ingress: ReturnType<typeof ingressStore.create>,
            profile: NonNullable<ReturnType<typeof webhookProfile>>,
          ) => Promise<Record<string, unknown>>;
        }
      ).runtimeReadiness;
      const raw = ingressStore.create({
        display_name: 'Raw HMAC',
        profile_id: 'generic.raw-body-hmac-sha256.v1',
        environment: 'live',
        paired_connection_id: null,
        registration_mode: 'manual',
        selected_event_types: ['delivery'],
      });
      await expect(runtimeReadiness(
        raw,
        webhookProfile(raw.profile_id)!,
      )).resolves.toMatchObject({
        endpoint_url: `https://hooks.example.test/v1/webhooks/${raw.public_id}`,
        profile_runtime_available: true,
        paired_connection_available: true,
        listener_available: true,
        public_reachability_enabled: true,
        tls_ready: true,
        clock_ready: true,
        test_delivery_supported: false,
        vault_unlocked: true,
        server_unpaused: true,
      });
      const operationBound = ingressStore.create({
        display_name: 'Operation-bound provider callback',
        profile_id: 'generic.static-header-token.v1',
        environment: 'test',
        paired_connection_id: 'provider-api',
        registration_mode: 'operation_bound',
        selected_event_types: ['delivery'],
      });
      await expect(runtimeReadiness(
        operationBound,
        webhookProfile(operationBound.profile_id)!,
      )).resolves.toMatchObject({ paired_connection_available: false });
      availableConnections.add('provider-api');
      await expect(runtimeReadiness(
        operationBound,
        webhookProfile(operationBound.profile_id)!,
      )).resolves.toMatchObject({ paired_connection_available: true });
      await expect(runtimeReadiness(
        { ...raw, environment: 'test' },
        webhookProfile(raw.profile_id)!,
      )).resolves.toMatchObject({
        test_delivery_supported: true,
      });
      process.env.RECUED_PUBLIC_BASE_URL =
        'https://operator:secret@hooks.example.test/base?leak=true';
      await expect(runtimeReadiness(
        raw,
        webhookProfile(raw.profile_id)!,
      )).resolves.toMatchObject({
        endpoint_url: null,
        tls_ready: false,
      });
      process.env.RECUED_PUBLIC_BASE_URL = 'https://hooks.example.test/?';
      await expect(runtimeReadiness(
        raw,
        webhookProfile(raw.profile_id)!,
      )).resolves.toMatchObject({
        endpoint_url: null,
        tls_ready: false,
      });
      process.env.RECUED_PUBLIC_BASE_URL = 'https://hooks.example.test';
      const timestamped = {
        ...raw,
        profile_id: 'generic.timestamped-raw-body-hmac-sha256.v1' as const,
      };
      await expect(runtimeReadiness(
        timestamped,
        webhookProfile(timestamped.profile_id)!,
      )).resolves.toMatchObject({
        profile_runtime_available: false,
        clock_ready: false,
        test_delivery_supported: false,
      });
      const stripe = {
        ...raw,
        profile_id: 'stripe.event.v1' as const,
      };
      await expect(runtimeReadiness(
        stripe,
        webhookProfile(stripe.profile_id)!,
      )).resolves.toMatchObject({
        profile_runtime_available: false,
        clock_ready: false,
        test_delivery_supported: false,
      });
      const paddle = {
        ...raw,
        profile_id: 'paddle.notification.v1' as const,
        selected_event_types: ['subscription.updated'],
      };
      await expect(runtimeReadiness(
        paddle,
        webhookProfile(paddle.profile_id)!,
      )).resolves.toMatchObject({
        profile_runtime_available: false,
        clock_ready: false,
        test_delivery_supported: false,
      });
      const slack = {
        ...raw,
        profile_id: 'slack.request.v0' as const,
      };
      await expect(runtimeReadiness(
        slack,
        webhookProfile(slack.profile_id)!,
      )).resolves.toMatchObject({
        profile_runtime_available: false,
        clock_ready: false,
        test_delivery_supported: false,
      });
      const telegram = {
        ...raw,
        profile_id: 'telegram.bot-webhook.v1' as const,
      };
      await expect(runtimeReadiness(
        telegram,
        webhookProfile(telegram.profile_id)!,
      )).resolves.toMatchObject({
        profile_runtime_available: true,
        clock_ready: true,
        test_delivery_supported: false,
      });
      const github = {
        ...raw,
        profile_id: 'github.webhook.v1' as const,
        selected_event_types: ['issues'],
      };
      await expect(runtimeReadiness(
        github,
        webhookProfile(github.profile_id)!,
      )).resolves.toMatchObject({
        profile_runtime_available: true,
        clock_ready: true,
        test_delivery_supported: false,
      });
      await expect(runtimeReadiness(
        { ...github, environment: 'test' },
        webhookProfile(github.profile_id)!,
      )).resolves.toMatchObject({
        profile_runtime_available: true,
        clock_ready: true,
        test_delivery_supported: true,
      });
      process.env.RECUED_PUBLIC_BASE_URL = 'https://hooks.example.test:9443';
      await expect(runtimeReadiness(
        telegram,
        webhookProfile(telegram.profile_id)!,
      )).resolves.toMatchObject({
        endpoint_url:
          `https://hooks.example.test:9443/v1/webhooks/${telegram.public_id}`,
        profile_runtime_available: true,
        tls_ready: false,
      });
      await result.server.close();
    } finally {
      if (originalBase === undefined) delete process.env.RECUED_PUBLIC_BASE_URL;
      else process.env.RECUED_PUBLIC_BASE_URL = originalBase;
      if (originalReachable === undefined) delete process.env.RECUED_PUBLIC_REACHABLE;
      else process.env.RECUED_PUBLIC_REACHABLE = originalReachable;
      if (originalClockAuthority === undefined) {
        delete process.env.RECUED_WEBHOOK_CLOCK_AUTHORITY_URL;
      } else {
        process.env.RECUED_WEBHOOK_CLOCK_AUTHORITY_URL = originalClockAuthority;
      }
    }
  });

  /** ⛔ A vendor keeps this address and a confirmed registration is matched
   *  against it, so it must not follow the probe: a Pro server without
   *  `RECUED_PUBLIC_BASE_URL` gets its own name, and keeps it through a probe
   *  that found nothing answering. */
  it('gives a webhook the server\'s own name, whatever the probe says', async () => {
    const originalBase = process.env.RECUED_PUBLIC_BASE_URL;
    const originalReachable = process.env.RECUED_PUBLIC_REACHABLE;
    const base = makeOptions();
    const ingressStore = createWebhookIngressStore(storageDb, {
      getEncryptionKey: () => new Uint8Array(32).fill(4),
    });
    const consumerStore = createWebhookConsumerStore(storageDb, { ingressStore });
    const deliveryStore = createWebhookDeliveryStore(storageDb, {
      getEncryptionKey: () => new Uint8Array(32).fill(5),
      hasDispatchTarget: (ingressId, eventType) =>
        consumerStore.hasDispatchTarget(ingressId, eventType),
    });
    const addressStore = createSqlitePublicAddressStore(storageDb);
    const publicAddress = createPublicAddressService({
      configured: () => process.env.RECUED_PUBLIC_BASE_URL,
      hostnames: {
        list: () => [{
          hostname: 'alice.recued.net', listener_ports: [443], enabled: true,
          ownership_status: 'verified', tls_topology: 'server_terminated',
          cert_source: 'recued_acme', cert_fingerprint: 'sha256:ab',
        }],
      },
      store: addressStore,
    });
    delete process.env.RECUED_PUBLIC_BASE_URL;
    process.env.RECUED_PUBLIC_REACHABLE = 'true';
    try {
      const result = await composeListeners(makeOptions({
        storage: { ...base.storage, auditLog: { get: vi.fn(async () => null) }, publicAddress },
        app: {
          ...base.app,
          webhookIngressStoreRef: ingressStore,
          webhookDeliveryStoreRef: deliveryStore,
          webhookConsumerStoreRef: consumerStore,
          connectionStoreRef: { get: vi.fn(() => null) },
          isVaultUnlocked: () => true,
        },
      }));
      const config = (
        listenerMocks.createServerHandlerSet.mock.calls as unknown as Array<[
          Record<string, unknown>,
        ]>
      )[0]![0];
      const runtimeReadiness = (
        config.webhookIngressDeps as {
          runtimeReadiness: (
            ingress: ReturnType<typeof ingressStore.create>,
            profile: NonNullable<ReturnType<typeof webhookProfile>>,
          ) => Promise<Record<string, unknown>>;
        }
      ).runtimeReadiness;
      const raw = ingressStore.create({
        display_name: 'Raw HMAC',
        profile_id: 'generic.raw-body-hmac-sha256.v1',
        environment: 'live',
        paired_connection_id: null,
        registration_mode: 'manual',
        selected_event_types: ['delivery'],
      });
      const endpoint = `https://alice.recued.net/v1/webhooks/${raw.public_id}`;
      await expect(runtimeReadiness(raw, webhookProfile(raw.profile_id)!))
        .resolves.toMatchObject({ endpoint_url: endpoint });
      // Handing it out keeps it: a name added later moves nothing.
      expect(publicAddress.addressUse('webhooks'))
        .toMatchObject({ source: 'first_use', hostname: 'alice.recued.net' });

      addressStore.putVerdict({
        hostname: 'alice.recued.net', port: 443, probed_at: Date.now(),
        port_open: false, https_ok: false, last_error: 'timeout',
      });
      expect(publicAddress.ownBaseUrls()).toEqual(['https://alice.recued.net']);
      await expect(runtimeReadiness(raw, webhookProfile(raw.profile_id)!))
        .resolves.toMatchObject({ endpoint_url: endpoint });

      // A configured address a vendor may not be given is skipped, not fatal.
      process.env.RECUED_PUBLIC_BASE_URL = 'https://operator:secret@hooks.example.test';
      await expect(runtimeReadiness(raw, webhookProfile(raw.profile_id)!))
        .resolves.toMatchObject({ endpoint_url: endpoint });
      await result.server.close();
    } finally {
      if (originalBase === undefined) delete process.env.RECUED_PUBLIC_BASE_URL;
      else process.env.RECUED_PUBLIC_BASE_URL = originalBase;
      if (originalReachable === undefined) delete process.env.RECUED_PUBLIC_REACHABLE;
      else process.env.RECUED_PUBLIC_REACHABLE = originalReachable;
    }
  });

  it('mounts timestamped HMAC only with a healthy boot-pinned HTTPS clock authority', async () => {
    const originalBase = process.env.RECUED_PUBLIC_BASE_URL;
    const originalReachable = process.env.RECUED_PUBLIC_REACHABLE;
    const originalClockAuthority = process.env.RECUED_WEBHOOK_CLOCK_AUTHORITY_URL;
    const base = makeOptions();
    const ingressStore = createWebhookIngressStore(storageDb, {
      getEncryptionKey: () => new Uint8Array(32).fill(4),
    });
    const consumerStore = createWebhookConsumerStore(storageDb, { ingressStore });
    const deliveryStore = createWebhookDeliveryStore(storageDb, {
      getEncryptionKey: () => new Uint8Array(32).fill(5),
      hasDispatchTarget: (ingressId, eventType) =>
        consumerStore.hasDispatchTarget(ingressId, eventType),
    });
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      const nonce = new URL(String(input)).searchParams.get('_recued_clock_probe')!;
      return new Response(null, {
        status: 204,
        headers: {
          Date: new Date(Date.now()).toUTCString(),
          'X-Recued-Clock-Nonce': nonce,
        },
      });
    });
    process.env.RECUED_PUBLIC_BASE_URL = 'https://hooks.example.test';
    process.env.RECUED_PUBLIC_REACHABLE = 'true';
    process.env.RECUED_WEBHOOK_CLOCK_AUTHORITY_URL =
      'https://clock.example.test/current-time';
    vi.stubGlobal('fetch', fetchImpl);
    try {
      listenerMocks.coordinator.status.mockReturnValue([
        {
          listener: 'lan',
          listening: true,
          port: 4711,
          bind_address: '192.168.1.10',
        },
        {
          listener: 'public',
          listening: true,
          port: 443,
          bind_address: '0.0.0.0',
        },
      ]);
      const result = await composeListeners(makeOptions({
        storage: { ...base.storage, auditLog: { get: vi.fn(async () => null) } },
        app: {
          ...base.app,
          webhookIngressStoreRef: ingressStore,
          webhookDeliveryStoreRef: deliveryStore,
          webhookConsumerStoreRef: consumerStore,
          isVaultUnlocked: () => true,
        },
        exposureDeps: {
          getMachine: () => ({
            current: async () => ({
              resolution: { webhooks: { lan: true, public: true } },
            }),
          }),
        },
      }));
      expect(fetchImpl).not.toHaveBeenCalled();
      const config = (
        listenerMocks.createServerHandlerSet.mock.calls as unknown as Array<[
          Record<string, unknown>,
        ]>
      )[0]![0];
      const runtimeReadiness = (
        config.webhookIngressDeps as {
          runtimeReadiness: (
            ingress: ReturnType<typeof ingressStore.create>,
            profile: NonNullable<ReturnType<typeof webhookProfile>>,
          ) => Promise<Record<string, unknown>>;
        }
      ).runtimeReadiness;
      const timestamped = ingressStore.create({
        display_name: 'Timestamped test ingress',
        profile_id: 'generic.timestamped-raw-body-hmac-sha256.v1',
        environment: 'test',
        paired_connection_id: null,
        registration_mode: 'manual',
        selected_event_types: ['delivery'],
      });
      await expect(runtimeReadiness(
        timestamped,
        webhookProfile(timestamped.profile_id)!,
      )).resolves.toMatchObject({
        profile_runtime_available: true,
        clock_ready: true,
        test_delivery_supported: true,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const requestUrl = new URL(String(fetchImpl.mock.calls[0]![0]));
      expect(requestUrl.origin + requestUrl.pathname)
        .toBe('https://clock.example.test/current-time');
      expect(requestUrl.searchParams.get('_recued_clock_probe'))
        .toMatch(/^[0-9a-f]{32}$/);
      expect(fetchImpl.mock.calls[0]![1]).toMatchObject({
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      });
      expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers)
        .get('x-recued-clock-nonce')).toBe(
        requestUrl.searchParams.get('_recued_clock_probe'),
      );
      await expect(runtimeReadiness(
        timestamped,
        webhookProfile(timestamped.profile_id)!,
      )).resolves.toMatchObject({
        profile_runtime_available: true,
        clock_ready: true,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const stripe = ingressStore.create({
        display_name: 'Stripe profile runtime proof',
        profile_id: 'stripe.event.v1',
        environment: 'test',
        paired_connection_id: 'stripe-test',
        registration_mode: 'managed_endpoint',
        selected_event_types: ['invoice.paid'],
      });
      await expect(runtimeReadiness(
        stripe,
        webhookProfile(stripe.profile_id)!,
      )).resolves.toMatchObject({
        profile_runtime_available: true,
        clock_ready: true,
        test_delivery_supported: true,
      });
      const paddle = ingressStore.create({
        display_name: 'Paddle profile runtime proof',
        profile_id: 'paddle.notification.v1',
        environment: 'test',
        paired_connection_id: null,
        registration_mode: 'manual',
        selected_event_types: ['subscription.updated'],
      });
      await expect(runtimeReadiness(
        paddle,
        webhookProfile(paddle.profile_id)!,
      )).resolves.toMatchObject({
        profile_runtime_available: true,
        clock_ready: true,
        test_delivery_supported: false,
      });
      const slack = ingressStore.create({
        display_name: 'Slack profile runtime proof',
        profile_id: 'slack.request.v0',
        environment: 'test',
        paired_connection_id: null,
        registration_mode: 'manual',
        selected_event_types: ['event_callback'],
      });
      await expect(runtimeReadiness(
        slack,
        webhookProfile(slack.profile_id)!,
      )).resolves.toMatchObject({
        profile_runtime_available: true,
        clock_ready: true,
        test_delivery_supported: false,
      });
      const slackSlashCommand = ingressStore.create({
        display_name: 'Slack slash-command runtime proof',
        profile_id: 'slack.slash-command.v1',
        environment: 'test',
        paired_connection_id: null,
        registration_mode: 'manual',
        selected_event_types: ['slash_command'],
      });
      await expect(runtimeReadiness(
        slackSlashCommand,
        webhookProfile(slackSlashCommand.profile_id)!,
      )).resolves.toMatchObject({
        profile_runtime_available: true,
        clock_ready: true,
        test_delivery_supported: false,
      });
      // All timestamped adapters share the same bounded authority evidence;
      // composing Stripe, Paddle, and either Slack profile does not add an
      // unpinned clock path.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await result.server.close();
    } finally {
      vi.unstubAllGlobals();
      if (originalBase === undefined) delete process.env.RECUED_PUBLIC_BASE_URL;
      else process.env.RECUED_PUBLIC_BASE_URL = originalBase;
      if (originalReachable === undefined) delete process.env.RECUED_PUBLIC_REACHABLE;
      else process.env.RECUED_PUBLIC_REACHABLE = originalReachable;
      if (originalClockAuthority === undefined) {
        delete process.env.RECUED_WEBHOOK_CLOCK_AUTHORITY_URL;
      } else {
        process.env.RECUED_WEBHOOK_CLOCK_AUTHORITY_URL = originalClockAuthority;
      }
    }
  });

  it('returns the handler set, path listener coordinator, LAN bind address, and server facade', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = await composeListeners(makeOptions());

      expect(result.serverHandlerSet).toBe(listenerMocks.handlerSet);
      expect(result.listenerCoordinator).toBe(listenerMocks.coordinator);
      // Bind and advertised are DIFFERENT values now, deliberately: binding a
      // single LAN address stops serving loopback, which is the one origin the
      // bundled webclient can boot from. `0.0.0.0` serves both; the LAN IP is
      // what the pairing address hints publish.
      expect(result.lanBindAddress).toBe('0.0.0.0');
      expect(result.lanAdvertisedAddress).toBe('192.168.1.10');
      expect(result.server.wsServer).toBe(listenerMocks.handlerSet.wsHandle);
      expect(result.server.port).toBe(4711);
      // ⚠⚠ THIS ASSERTED `1` AND THEREBY PINNED A DEFECT (audit P2-14). Resolving
      // ONCE is right for the BIND — the listener's address must not move under
      // a running socket — and wrong for the port mapping, which closed over the
      // same boot-time value and kept naming a host we may no longer be after a
      // DHCP renewal. The planner's DHCP-move branch could never fire because
      // production never supplied a changed address.
      // ⇒ What must hold is that the BIND is resolved once and the value it
      // produced is the one the listener got; the additional reads are the
      // mapping asking "where am I now".
      expect(listenerMocks.resolveLanAddress.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(listenerMocks.createCertChainHolder).toHaveBeenCalledWith(null);
      expect(
        listenerMocks.createProductionPathListenerCoordinator,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          handlers: listenerMocks.handlerSet.handlers,
          upgradeHandlers: listenerMocks.handlerSet.upgradeHandlers,
          legacyAliases: listenerMocks.handlerSet.legacyAliases,
          rootHandler: listenerMocks.handlerSet.rootHandler,
          lanRootHandler: listenerMocks.handlerSet.lanRootHandler,
          cert_chain: listenerMocks.certChain,
          lan_port: 1234,
          public_port: 443,
          log: expect.any(Function),
        }),
      );

      await result.server.close();

      expect(listenerMocks.handlerSet.close).toHaveBeenCalledTimes(1);
      expect(listenerMocks.coordinator.stop).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        '[network] LAN bind: 0.0.0.0 (reachable at 127.0.0.1 + 192.168.1.10;'
        + ' source=detected; candidates=1)',
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  // ── LAN bind override + default-route hint ──────────────────────────
  //
  // `resolveLanAddress` has accepted both inputs since the W3.5 P2 fold and
  // the boot path supplied NEITHER — it called `resolveLanAddress()` bare, so
  // the documented "Settings → Server → Network override" reached nothing and
  // every multi-homed host resolved ambiguously and bound loopback.

  it('threads the owner override AND the default-route hint into the resolver', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const runtimeConfig = {
      get: vi.fn((key: string) => {
        if (key === 'network.lan_bind_address') return '192.168.1.121';
        if (key === 'public_port') return 443;
        // D-273 — the composer now also reads the port-mapping toggle.
        if (key === 'network.auto_port_mapping') return false;
        throw new Error(`unexpected key ${key}`);
      }),
    };

    try {
      await composeListeners(makeOptions({ runtimeConfig }));

      expect(runtimeConfig.get).toHaveBeenCalledWith('network.lan_bind_address');
      expect(listenerMocks.resolveLanAddress).toHaveBeenCalledWith({
        override: '192.168.1.121',
        defaultRouteGateway: '192.168.1.1',
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('passes an undefined override when there is no config store (dbless boot)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await composeListeners(makeOptions());
      expect(listenerMocks.resolveLanAddress).toHaveBeenCalledWith({
        override: undefined,
        defaultRouteGateway: '192.168.1.1',
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('WARNS loudly when the resolver rejected the override, naming the alternatives', async () => {
    // A dropped override reads exactly like one that was never saved. The
    // owner set this value precisely because the server was unreachable, so
    // silence here sends them looking in the wrong place.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listenerMocks.resolveLanAddress.mockReturnValue({
      address: '10.0.0.5',
      bind_address: '0.0.0.0',
      source: 'detected',
      candidates: [{ address: '10.0.0.5', iface: 'en0' }],
      override_ignored: { value: '192.168.1.121', reason: 'not_bindable_on_this_host' },
    });

    try {
      await composeListeners(makeOptions());

      const warning = String(warnSpy.mock.calls.at(-1)?.[0] ?? '');
      expect(warning).toContain('192.168.1.121'); // the value that lost
      expect(warning).toContain('not_bindable_on_this_host'); // why
      expect(warning).toContain('10.0.0.5'); // what bound instead
      expect(warning).toContain('en0'); // what the machine does offer
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('stays quiet when the override was honoured', async () => {
    // Without this, an unconditional warning would satisfy the assertion
    // above and stand as a permanent false alarm on every healthy boot.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listenerMocks.resolveLanAddress.mockReturnValue({
      address: '192.168.1.121',
      bind_address: '192.168.1.121',
      source: 'override',
      candidates: [{ address: '192.168.1.121', iface: 'en0' }],
    });

    try {
      await composeListeners(makeOptions());
      const warnings = warnSpy.mock.calls
        .map((c) => String(c[0] ?? ''))
        .filter((m) => m.includes('lan_bind_address'));
      expect(warnings).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('threads the configured public_port into the path listener coordinator', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const runtimeConfig = {
      get: vi.fn((key: string) => {
        if (key === 'public_port') return 8443;
        if (key === 'network.lan_bind_address') return '';
        throw new Error(`unexpected key ${key}`);
      }),
    };

    try {
      await composeListeners(makeOptions({ runtimeConfig }));

      expect(runtimeConfig.get).toHaveBeenCalledWith('public_port');
      expect(
        listenerMocks.createProductionPathListenerCoordinator,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          lan_port: 1234,
          public_port: 8443,
        }),
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('threads the canonical form-response store into the owner read RPC deps', async () => {
    const base = makeOptions();
    const formResponseStore = { tag: 'form-response-store' };

    await composeListeners(makeOptions({
      storage: {
        ...base.storage,
        formResponseStoreRef: formResponseStore,
      },
    }));

    expect(listenerMocks.createServerHandlerSet).toHaveBeenCalledWith(
      expect.objectContaining({
        formResponseDeps: { store: formResponseStore },
      }),
    );
  });

  it('threads the sealed seller claim store and Reception URL authority into the server handler set', async () => {
    const base = makeOptions();
    const sellerClaimStore = { tag: 'seller-claim-store' };
    const receptionRpcDeps = { getShareBaseUrl: () => 'https://seller.example' };

    await composeListeners(makeOptions({
      app: {
        ...base.app,
        sellerClaimStoreRef: sellerClaimStore,
      },
      receptionRpcDeps,
    }));

    expect(listenerMocks.createServerHandlerSet).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerClaimStore,
        receptionRpcDeps,
      }),
    );
  });
});

describe('composeListeners — D-299 the Reception pair carry reaches the pack install', () => {
  it('publishes an accessor that reads the Reception substrate at call time', async () => {
    const endpoints = { tag: 'endpoints' };
    const pairs = { tag: 'pairs' };
    const door = { tag: 'door' };
    let pairStore: unknown = pairs;
    const options = makeOptions({
      receptionRpcDeps: {
        getStore: () => endpoints,
        getIntakeRecipePairStore: () => pairStore,
        getDoorBindDeps: () => door,
      },
    });
    await composeListeners(options);
    const publish = (options as unknown as { rpc: { publishReceptionPairs: ReturnType<typeof vi.fn> } })
      .rpc.publishReceptionPairs;
    expect(publish).toHaveBeenCalledTimes(1);
    const get = publish.mock.calls[0]![0] as () => Record<string, unknown> | undefined;
    expect(get()).toMatchObject({ endpoints, pairs, door });
    // No pair store (yet) ⇒ nothing to carry, and the install proceeds as before.
    pairStore = undefined;
    expect(get()).toBeUndefined();
  });

  it('publishes nothing on a server with no Reception substrate', async () => {
    const options = makeOptions();
    await composeListeners(options);
    expect((options as unknown as { rpc: { publishReceptionPairs: ReturnType<typeof vi.fn> } })
      .rpc.publishReceptionPairs).not.toHaveBeenCalled();
  });
});

describe('composeListeners — D-165 vendor OAuth wiring (slice 2b Piece W)', () => {
  const SIGNING_IDENTITY = { identity: { tag: 'server-identity' } };

  const appWith = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    ...makeOptions().app,
    ...over,
  });

  const configFromCall = (): Record<string, unknown> => {
    const calls = listenerMocks.createServerHandlerSet.mock
      .calls as unknown as Array<[Record<string, unknown>]>;
    return calls[0]![0];
  };

  it('hands the connection rpc deps the key provider even while keys are uninitialized', async () => {
    // ⛔ A new server composes with keys 'uninitialized' and its first pairing
    // unlocks the vault IN-PROCESS. Gating `getEncryptionKey` on the compose-time
    // state left that whole first session key-less: connections were stored as
    // base64 JSON, probes said `unknown` with no reason, and after a restart the
    // rows failed AEAD (driven live against HubSpot 2026-10-08). The provider's
    // closure re-reads the state per call, so it is always safe to hand over.
    const provider = vi.fn(() => null);
    const keyProvider = vi.fn(() => provider);
    await composeListeners(
      makeOptions({
        app: appWith({
          connectionStoreRef: { tag: 'connection-store' },
          keys: { state: vi.fn(() => 'uninitialized'), keyProvider },
        }),
      }),
    );

    const connectionDeps = configFromCall().connectionDeps as
      | { getEncryptionKey?: () => Uint8Array | null }
      | undefined;
    expect(keyProvider).toHaveBeenCalledWith('connection');
    expect(connectionDeps?.getEncryptionKey).toBe(provider);
  });

  it('wires both the start rpc deps + the /oauth/complete port deps off ONE shared flow + result store when signing identity + connection store are present', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await composeListeners(
        makeOptions({
          signingIdentity: SIGNING_IDENTITY,
          app: appWith({ connectionStoreRef: { tag: 'connection-store' } }),
        }),
      );

      const config = configFromCall();
      const connectionDeps = config.connectionDeps as
        | {
            vendorOAuthStart?: Record<string, unknown>;
            vendorOAuthResult?: Record<string, unknown>;
          }
        | undefined;
      const oauthCompletePortDeps = config.oauthCompletePortDeps as
        | Record<string, unknown>
        | undefined;

      // start-side deps (under connectionDeps, gated on the connection store)
      expect(connectionDeps?.vendorOAuthStart).toBeDefined();
      expect(connectionDeps?.vendorOAuthStart?.identity).toBe(
        SIGNING_IDENTITY.identity,
      );
      expect(connectionDeps?.vendorOAuthStart?.flowStore).toBeDefined();
      expect(typeof connectionDeps?.vendorOAuthStart?.serverPublicUrl).toBe(
        'function',
      );
      // result-claim deps (slice 3 — under connectionDeps, same gate)
      expect(connectionDeps?.vendorOAuthResult?.resultStore).toBeDefined();

      // complete-side deps (independent mount seam)
      expect(oauthCompletePortDeps).toBeDefined();
      expect(oauthCompletePortDeps?.identity).toBe(SIGNING_IDENTITY.identity);
      expect(oauthCompletePortDeps?.resultStore).toBeDefined();
      expect(typeof oauthCompletePortDeps?.onCompleted).toBe('function');

      // The start handler and the complete handler MUST share the SAME flow
      // store instance — that's the start↔complete handoff (put then take).
      expect(oauthCompletePortDeps?.flowStore).toBe(
        connectionDeps?.vendorOAuthStart?.flowStore,
      );
      // ...and the complete handler + the result-claim rpc MUST share the SAME
      // result store — that's the owner-bound handoff (complete put → claim
      // take). Without this, the claim rpc would read a different empty map.
      expect(oauthCompletePortDeps?.resultStore).toBe(
        connectionDeps?.vendorOAuthResult?.resultStore,
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('onCompleted fans a { flow_id }-only completion broadcast (never the token)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const emit = vi.fn();
    try {
      await composeListeners(
        makeOptions({
          signingIdentity: SIGNING_IDENTITY,
          app: appWith({ connectionStoreRef: { tag: 'connection-store' } }),
          rpc: {
            // ⚠ This literal hand-copies `base.rpc` instead of spreading it,
            // which is why it needed the D-289 method separately from the 38
            // cases that share the base. A copied double drifts from the
            // original exactly when the original gains something.
            publishSavedDataViewStore: vi.fn(),
            publishTriggerPreview: vi.fn(),
            publishReceptionPairs: vi.fn(),
            publishRecipeOwnedState: vi.fn(),
            housekeepingRpcDeps: undefined,
            upstreamMergeDeps: undefined,
            contactMergeDeps: undefined,
            engagementHealthDeps: undefined,
            observabilityBundle: {
              recipeListDeps: { tag: 'recipe-list-deps' },
              approvalDeps: { tag: 'approval-deps' },
              eventsDeps: { bus: { emit } },
              auditExportDeps: undefined,
              executionFeedDeps: undefined,
              statusPageDeps: undefined,
            },
          },
        }),
      );

      const oauthCompletePortDeps = configFromCall().oauthCompletePortDeps as {
        onCompleted: (flow_id: string) => void;
      };
      oauthCompletePortDeps.onCompleted('flow-xyz');

      expect(emit).toHaveBeenCalledWith({
        kind: 'connection.vendor_oauth_completed',
        flow_id: 'flow-xyz',
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  /** ⛔ It read ONLY the variable, so a Pro server that never set it — the
   *  variable is terminal-only, and Pro exists so nobody needs one — refused
   *  every vendor sign-in "server public URL not configured". */
  it('serverPublicUrl reads RECUED_PUBLIC_BASE_URL live, then every own verified name', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const original = process.env.RECUED_PUBLIC_BASE_URL;
    const rows: PublicHostnameRow[] = [];
    const base = makeOptions();
    try {
      await composeListeners(
        makeOptions({
          signingIdentity: SIGNING_IDENTITY,
          app: appWith({ connectionStoreRef: { tag: 'connection-store' } }),
          storage: {
            ...base.storage,
            publicAddress: createPublicAddressService({
              configured: () => process.env.RECUED_PUBLIC_BASE_URL,
              hostnames: { list: () => rows },
              store: createSqlitePublicAddressStore(storageDb),
            }),
          },
        }),
      );
      const serverPublicUrl = (
        configFromCall().oauthCompletePortDeps as {
          serverPublicUrl: () => readonly string[];
        }
      ).serverPublicUrl;

      process.env.RECUED_PUBLIC_BASE_URL = '  https://mary.recued.cloud  ';
      expect(serverPublicUrl()).toEqual(['https://mary.recued.cloud']);
      delete process.env.RECUED_PUBLIC_BASE_URL;
      expect(serverPublicUrl()).toEqual([]);

      // A Pro server with no variable: its verified hostname answers, read
      // live; a name not yet verified does not.
      rows.push(
        { hostname: 'alice.recued.net', listener_ports: [443], enabled: true, ownership_status: 'verified', tls_topology: 'server_terminated', cert_source: 'recued_acme', cert_fingerprint: 'sha256:ab' },
        { hostname: 'pending.example.com', listener_ports: [443], enabled: true, ownership_status: 'pending', tls_topology: 'server_terminated', cert_source: 'byo_uploaded', cert_fingerprint: 'sha256:cd' },
      );
      expect(serverPublicUrl()).toEqual(['https://alice.recued.net']);
      // The variable still comes first.
      process.env.RECUED_PUBLIC_BASE_URL = 'https://mary.recued.cloud';
      expect(serverPublicUrl()).toEqual(['https://mary.recued.cloud', 'https://alice.recued.net']);
    } finally {
      if (original === undefined) delete process.env.RECUED_PUBLIC_BASE_URL;
      else process.env.RECUED_PUBLIC_BASE_URL = original;
      logSpy.mockRestore();
    }
  });

  /** ⛔ THE JOIN: the resolver's suite binds its own facts, so it stays green
   *  whether or not the listener ever binds the real ones — and unbound, no
   *  hostname reaches a live link. */
  it('binds the listener\'s facts to the public address: grid on a round, pushed on change', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const original = process.env.RECUED_PUBLIC_BASE_URL;
    delete process.env.RECUED_PUBLIC_BASE_URL;
    listenerMocks.coordinator.status.mockReturnValue([
      { listener: 'lan', listening: true, port: 4711, bind_address: '192.168.1.10' },
      { listener: 'public', listening: true, port: 443, bind_address: '0.0.0.0' },
    ]);
    const publicAll = { lan: true, public: true };
    const resolution = {
      health: publicAll, ws: publicAll, mcp: publicAll, llm_gateway: publicAll, webhooks: publicAll,
      reception: publicAll, oauth: publicAll, ask: publicAll, webclient: publicAll,
    };
    let push: ((event: Record<string, unknown>) => void) | undefined;
    const eventBus = {
      subscribe: vi.fn((_id: unknown, _req: unknown, onEvent: (event: Record<string, unknown>) => void) => {
        push = onEvent;
        return { cursor: 0, replayed: 0 };
      }),
      unsubscribe: vi.fn(),
      emit: vi.fn(),
    };
    const publicAddress = createPublicAddressService({
      configured: () => process.env.RECUED_PUBLIC_BASE_URL,
      hostnames: {
        list: () => [{
          hostname: 'alice.recued.net', listener_ports: [443], enabled: true,
          ownership_status: 'verified', tls_topology: 'server_terminated',
          cert_source: 'recued_acme', cert_fingerprint: 'sha256:ab',
        }],
      },
      store: createSqlitePublicAddressStore(storageDb),
    });
    const base = makeOptions();
    try {
      const composed = await composeListeners(makeOptions({
        storage: { ...base.storage, publicAddress, eventBus },
        exposureDeps: { getMachine: () => ({ current: async () => ({ resolution }) }) },
      }));
      // The grid is not read at compose (the machine is published later).
      expect(publicAddress.baseUrl('ask')).toBeNull();
      await publicAddress.probeDue();
      expect(publicAddress.baseUrl('ask')).toBe('https://alice.recued.net');
      // `redirect` apex: a Pro address's root lands on the webclient.
      expect(publicAddress.baseUrl('root')).toBe('https://alice.recued.net');

      expect(eventBus.subscribe).toHaveBeenCalledWith(
        expect.anything(), { kinds: ['exposure_changed'] }, expect.any(Function),
      );
      push?.({ kind: 'exposure_changed', resolution: { ...resolution, ask: { lan: true, public: false } } });
      expect(publicAddress.baseUrl('ask')).toBeNull();

      await composed.server.close();
      expect(eventBus.unsubscribe).toHaveBeenCalledWith(eventBus.subscribe.mock.calls[0]![0]);
    } finally {
      if (original === undefined) delete process.env.RECUED_PUBLIC_BASE_URL;
      else process.env.RECUED_PUBLIC_BASE_URL = original;
      logSpy.mockRestore();
    }
  });

  it('counts the webhooks a move of the webhooks address would stop', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const base = makeOptions();
    const list = vi.fn(() => [
      { confirmed_endpoint_url: 'https://alice.recued.net/v1/webhooks/a', registration_mode: 'manual' },
      { confirmed_endpoint_url: 'https://alice.recued.net/v1/webhooks/b', registration_mode: 'managed_endpoint' },
      // Carries its address per call, so a move cannot stop it.
      { confirmed_endpoint_url: 'https://alice.recued.net/v1/webhooks/c', registration_mode: 'operation_bound' },
      // Never set up at a vendor.
      { confirmed_endpoint_url: null, registration_mode: 'manual' },
    ]);
    try {
      const options = makeOptions({
        app: { ...base.app, webhookIngressStoreRef: { list } },
      });
      await composeListeners(options);
      const hostnameDeps = configFromCall().hostnameDeps as {
        countRegisteredWebhooks: () => number;
        publicAddress: unknown;
      };
      expect(hostnameDeps.publicAddress).toBe(options.storage.publicAddress);
      expect(hostnameDeps.countRegisteredWebhooks()).toBe(2);
      expect(list).toHaveBeenCalledWith();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('leaves the entire vendor OAuth substrate unwired when no signing identity is booted', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      // connection store present, but NO signing identity → start-side absent
      // (the state signer is missing) AND complete-side absent.
      await composeListeners(
        makeOptions({
          app: appWith({ connectionStoreRef: { tag: 'connection-store' } }),
        }),
      );
      const config = configFromCall();
      const connectionDeps = config.connectionDeps as
        | { vendorOAuthStart?: unknown }
        | undefined;
      expect(connectionDeps).toBeDefined();
      expect(connectionDeps?.vendorOAuthStart).toBeUndefined();
      expect(config.oauthCompletePortDeps).toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('mounts the complete-side port deps even without a connection store, but not the start-side (gating asymmetry)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      // signing identity present, connection store absent → the complete
      // handler only needs the identity (it verifies the echoed state), so it
      // mounts; the start rpc lives under connectionDeps, which is gated on
      // the store, so it stays unwired.
      await composeListeners(makeOptions({ signingIdentity: SIGNING_IDENTITY }));
      const config = configFromCall();
      expect(config.connectionDeps).toBeUndefined();
      expect(config.oauthCompletePortDeps).toBeDefined();
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('composeListeners — D-319 a recipe the server only ships cannot be switched on', () => {
  // ⚠ Through the composition's own binding of the REAL recipe store: a
  // handler test that supplies `recipeInstall` itself proves the refusal, not
  // that a server has it. Pack counts are read from the roster, never
  // hard-coded — a checkout ships ~1,000 packs, a release only its foundation.
  it('refuses a shipped recipe that starts on its own until it is installed, and nothing else', async () => {
    const recipeStore = createRecipeStore(undefined, storageDb);
    const shipped = 'reminder-due-notifier';
    expect(recipeStore.get(shipped)?.auto_run).toBeDefined();
    expect(recipeStore.getStored(shipped)).toBeNull();
    const dishDeps: DishHandlerDeps = { store: createDishStore(storageDb) };
    const base = makeOptions() as unknown as {
      execution: { executeDeps: Record<string, unknown> } & Record<string, unknown>;
    };
    await composeListeners(makeOptions({
      dishDeps,
      execution: { ...base.execution, executeDeps: { ...base.execution.executeDeps, recipeStore } },
    }));

    const packs = bundledPacksShippingRecipe(shipped);
    expect(packs.map((pack) => pack.ref)).toContain('recued-core.personal-organizer-foundation');
    let refused: unknown;
    try {
      createDish(dishDeps, { recipe_id: shipped });
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({
      code: 'pack_not_installed',
      message: expect.stringContaining(`'${recipeStore.get(shipped)!.metadata!.name}' comes with`),
      details: packs.length === 1 ? { missing_packs: [packs[0]!.ref] } : undefined,
    });
    expect(dishDeps.store.listByRecipe(shipped)).toEqual([]);

    // A shipped recipe that runs only when the owner runs it saves settings.
    expect(recipeStore.getStored('remind-me-of')).toBeNull();
    expect(createDish(dishDeps, { recipe_id: 'remind-me-of' }).dish.enabled).toBe(true);

    // Installed, the same switch goes ahead.
    recipeStore.save(recipeStore.get(shipped)!, 'recued-core', 'pair-sync');
    expect(createDish(dishDeps, { recipe_id: shipped }).dish).toMatchObject({ recipe_id: shipped, enabled: true });
  });
});

describe('composeListeners — D-209 a webhook door follows the main dish', () => {
  // ⚠ Through the composition's own late binding of `dishDeps.webhookDoors`: the
  // handler suite (`d-209-webhook-door-follows-main-dish.test.ts`) wires the hook
  // by hand, which proves the hook, not that a server has it. The dish store the
  // rpc writes and the one the door reads (`executeDeps.dishStore`) are separate
  // instances over one database, as in production.
  it('a main dish made with the account opens the door a fresh install could not', async () => {
    let stamp = 2_099_999_999_999;
    const ingressStore = createWebhookIngressStore(storageDb, {
      now: () => stamp,
      getEncryptionKey: () => new Uint8Array(32).fill(5),
    });
    const ingress = ingressStore.create({
      display_name: 'Acme order events',
      profile_id: 'generic.static-header-token.v1',
      environment: 'test',
      paired_connection_id: null,
      registration_mode: 'manual',
      selected_event_types: ['delivery'],
    });
    await ingressStore.writeCredentialVersion(ingress.ingress_id, {
      header_name: 'x-fixture-token',
      header_token: 'fixture-token',
    });
    ingressStore.confirmManualRegistration(ingress.ingress_id, {
      requires_handshake: false,
      endpoint_url: `https://home.example.test/v1/webhooks/${ingress.public_id}`,
    });
    ingressStore.enable(ingress.ingress_id);
    const consumerStore = createWebhookConsumerStore(storageDb, { ingressStore, now: () => ++stamp });
    const contractStore = createContractStore(storageDb, { now: () => ++stamp });
    const definitionStore = createContractDefinitionStore(contractStore);
    const recipeStore = createRecipeStore('/path/that/does/not/exist', storageDb);
    // A vendor webhook recipe: its account is a dish setting with a blank default.
    recipeStore.save({
      recipe_id: 'acme-order-paid',
      version: 1,
      ttl: 60,
      metadata: {
        name: 'Acme order paid',
        description: 'D-209 composition fixture',
        author: 'fixture-publisher',
        supported_platforms: [],
        tags: [],
      },
      variables: { acme: { type: 'connection', label: 'Acme account', default: '' } },
      prefetch_steps: [],
      steps: [{
        id: 'order',
        ingredient: 'acme-widgets',
        input: { operation: 'order.read' },
        connection: '{{config.acme}}',
      }],
      output: { sidebar: [] },
      webhook_triggers: [{ binding: 'generic_delivery', event_types: ['delivery'] }],
    } as never, 'fixture-publisher', 'pair-sync');
    // A fresh install's trigger rows: door-less, since no dish names the account yet.
    consumerStore.replaceConsumer({
      consumer_kind: 'pack_install',
      consumer_id: 'acme-webhook-pack',
      requirements: [{
        binding: 'generic_delivery',
        profile_ids: ['generic.static-header-token.v1'],
        required_event_types: ['delivery'],
        registration_modes: ['manual'],
        environment_policy: 'any',
        decoded_payload_access: 'metadata_only',
        source_truth_policy: 'delivery_payload_allowed',
      }],
      selections: [{ binding: 'generic_delivery', ingress_id: ingress.ingress_id }],
      recipes: [{
        recipe_id: 'acme-order-paid',
        publisher_id: 'fixture-publisher',
        webhook_triggers: [{ binding: 'generic_delivery', event_types: ['delivery'] }],
      }],
    });
    const doorId = () => consumerStore.doorContractIdForRecipe(
      'pack_install', 'acme-webhook-pack', 'acme-order-paid', 'fixture-publisher',
    );
    expect(doorId()).toBeNull();

    const dishDeps: DishHandlerDeps = { store: createDishStore(storageDb) };
    const base = makeOptions() as unknown as {
      storage: Record<string, unknown>;
      app: Record<string, unknown>;
      execution: { executeDeps: Record<string, unknown> } & Record<string, unknown>;
    };
    await composeListeners(makeOptions({
      dishDeps,
      // The door's Records exposure preflight reads these: no Records pack installed.
      storage: {
        ...base.storage,
        recordsStore: { isInstalledOperationId: () => false, isInstalledCatalogOperation: () => false },
      },
      app: { ...base.app, webhookConsumerStoreRef: consumerStore },
      execution: {
        ...base.execution,
        contractDefinitionStore: definitionStore,
        grantEntryStore: createContractGrantEntryStore(contractStore),
        executeDeps: {
          ...base.execution.executeDeps,
          recipeStore,
          dishStore: createDishStore(storageDb),
        },
      },
    }));

    const made = createDish(dishDeps, { recipe_id: 'acme-order-paid', config_overlay: { acme: 'acme-prod' } });

    expect(made.webhook_doors).toEqual([expect.objectContaining({
      recipe_id: 'acme-order-paid',
      state: 'opened',
    })]);
    // Stamped on the rows the dispatcher reads, and held in the store the Gateway reads.
    expect(doorId()).not.toBeNull();
    expect(definitionStore.get(doorId()!)?.scope.connection_names).toEqual(['acme-prod']);
  });
});

describe('composeListeners — MCP manual-probe transport wiring', () => {
  it('reuses the websocket and stdio capabilities composed for live execution', async () => {
    const options = makeOptions();
    const wsConnect = vi.fn();
    const spawnStdioMcp = vi.fn();
    (options.app as unknown as Record<string, unknown>).connectionStoreRef = {
      tag: 'connection-store',
    };
    (options.execution.executorConfig as unknown as Record<string, unknown>)
      .connectionMcp = { wsConnect, spawnStdioMcp };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await composeListeners(options);
      const calls = listenerMocks.createServerHandlerSet.mock
        .calls as unknown as Array<[Record<string, unknown>]>;
      const connectionDeps = calls[0]![0].connectionDeps as {
        wsConnect?: unknown;
        spawnStdioMcp?: unknown;
      };

      expect(connectionDeps.wsConnect).toBe(wsConnect);
      expect(connectionDeps.spawnStdioMcp).toBe(spawnStdioMcp);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('compose-listeners source boundary', () => {
  it('owns webhook listeners, handler-set assembly, and path listener coordinator construction', () => {
    const source = readFileSync(listenerContextPath, 'utf8');

    expect(source).toMatch(/composeWebhookListeners/);
    expect(source).toMatch(/createServerHandlerSet/);
    expect(source).toMatch(/resolveLanAddress/);
    expect(source).toMatch(/createCertChainHolder/);
    expect(source).toMatch(/createProductionPathListenerCoordinator/);
    // D-148 P9 § A.13 — vendor webhook port is composed at this layer.
    expect(source).toMatch(/composeVendorWebhookPort/);
    // D-165 slice 2b Piece W — the shared start↔complete OAuth stores are
    // constructed here so the start rpc + /oauth/complete handler share them.
    expect(source).toMatch(/createVendorOAuthFlowStore/);
    expect(source).toMatch(/createVendorOAuthResultStore/);
    expect(source).not.toMatch(/composeExposureSubstrate|finalizeExposure|reapply/);
    expect(source).not.toMatch(/composeSchedulers|composeHousekeepingScheduler/);
    expect(source).not.toMatch(/createLifecycle|LockHeldError|process\.on|process\.exit/);
    expect(source).not.toMatch(/backgroundServices|stopAll|shutdown/);
    // This layer may thread the already-composed MCP stream capabilities into
    // connection probing, but it must not construct an MCP server/client
    // transport itself.
    expect(source).not.toMatch(/mcp-server|StdioClientTransport/);
  });
});

describe('composeListeners — computeWouldWorsen wiring (R1 registry-shrink)', () => {
  it('binds the uninstall walk over the REAL contract store + manifest store into the thunk', async () => {
    // The unit suites cover the walk with injected fakes; THIS pins the compose
    // seam — `recipeRunnabilityDeps` must carry the connection store, recipe store,
    // local-manifest store AND the privateByoDropIds-backed drop-ids callback into
    // `packUninstallDeps.computeWouldWorsen`. Dropping any one (e.g. the contract
    // store the drop-ids callback closes over, or the manifest store) silently
    // shrinks the disclosure while every unit test stays green.
    const contractStore = createContractStore(storageDb, { now: () => 1 });
    contractStore.seedSchema(D165_CONTRACT_SCHEMA);
    // `the-pack` owns a LOCAL composition catalog `acme-pack` (private_byo) — its
    // uninstall deletes that catalog, so `privateByoDropIds('the-pack')` = ['acme-pack'].
    recordPackInventory(contractStore, {
      pack_slug: 'the-pack',
      pack_version: 1,
      installed_at: 1,
      contents: [],
      local_catalogs: [{ ingredient_id: 'acme-pack', version: 1, catalog_kind: 'private_byo' }],
    });
    // The local manifest store lifts vendor `acme` → the crm family from that catalog.
    const acmeSchema = {
      ingredient_id: 'acme-crm',
      wraps_vendor: 'acme',
      entity_id: 'acmedeal',
      scope: 'connection.api.acme.acmedeal',
      projection_mode: 'platform_reference',
      schema_mode: 'static',
      crm_alias: 'deal',
      target_id: { fields: ['id'], template: 'acmedeal_{id}' },
      meta_fields: [{ key: 'id', type: 'string', source_path: 'id' }],
      source_operations: {},
    };
    const localManifestStore = {
      listManifests: () => [{ slug: 'acme-pack' }],
      getEntitySchemas: (slug: string) => (slug === 'acme-pack' ? [acmeSchema] : []),
    };
    const acmeRow = {
      pk: 'api:acme',
      kind: 'api',
      name: 'acme',
      display_name: 'acme',
      config_json: JSON.stringify({ vendor: 'acme' }),
      auth_ciphertext: '',
      enrolled_at: 0,
      updated_at: 0,
    };
    const connectionStoreRef = {
      list: (q?: { kind?: string }) => (!q?.kind || q.kind === 'api' ? [acmeRow] : []),
    };
    // A canonical WRITE recipe: crm bound → runnable; after `acme` leaves the
    // registry → unbound → fail closed (blocked).
    const recipe = {
      recipe_id: 'r',
      version: 1,
      ttl: 300,
      metadata: { name: 'r', description: 'unit', author: 'test', supported_platforms: [] },
      variables: {},
      steps: [{ id: 's0', op: 'core.crm.deal.create' }],
      output: { sidebar: [] },
    };
    const recipeStore = { ids: () => ['r'], get: (id: string) => (id === 'r' ? recipe : null) };

    const base = makeOptions();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await composeListeners(
        makeOptions({
          storage: {
            ...(base.storage as unknown as Record<string, unknown>),
            recipeStore,
            localManifestStore,
          },
          app: {
            ...(base.app as unknown as Record<string, unknown>),
            connectionStoreRef,
            contractStoreRef: contractStore,
          },
          execution: {
            executeDeps: {
              tag: 'execute-deps',
              recipeStore: { listStored: () => [], setOnMutated: () => {} },
              executorConfig: { connectionMcp: undefined },
            },
            connectionOperationProfileStore: undefined,
            executorConfig: {
              connectionApi: undefined,
              manifests: { get: vi.fn(() => null), slugs: vi.fn(() => []) },
            },
          },
          rpc: {
            ...(base.rpc as unknown as Record<string, unknown>),
            packUninstallDeps: { recipeStore },
          },
        }),
      );
    } finally {
      logSpy.mockRestore();
    }

    const calls = listenerMocks.createServerHandlerSet.mock.calls as unknown as Array<
      [{ packUninstallDeps?: { computeWouldWorsen?: (slug: string) => unknown } }]
    >;
    const worsen = calls[0]![0].packUninstallDeps?.computeWouldWorsen;
    expect(typeof worsen).toBe('function');
    // The thunk runs the REAL walk over the composed stores: uninstalling `the-pack`
    // deletes the `acme-pack` catalog → `acme` leaves the merged registry → the crm
    // family unbinds → the canonical WRITE recipe blocks. A transition can only
    // surface if the connection store, recipe store, local-manifest store AND the
    // contract-store-backed drop-ids callback all reached the walk.
    expect(worsen!('the-pack')).toEqual([
      { recipe_id: 'r', before: 'runnable', after: 'blocked' },
    ]);
    // An unrelated pack drops no local catalog → the registry is unchanged → [].
    expect(worsen!('some-other-pack')).toEqual([]);
  });
});

/** D-220 Slice A2b — the composition WIRING, not the gate's logic.
 *
 *  ⚠ This test exists because a mutation deleting `formDefinitionReader` from
 *  `compose-listeners.ts` broke NOTHING: the gate's own unit suite
 *  (`d-220-save-form-contract.test.ts`) injects its own reader, so it proves the
 *  logic while being structurally blind to whether production ever passes one.
 *  A dep that no composition supplies is a gate that silently never runs — the
 *  declared-not-backed shape. So this drives the real `composeListeners` and
 *  asserts the reader arrives on `recipeSaveDeps` AND resolves a seeded form.
 */
describe('D-220 A2b — recipeSaveDeps carries a live form-definition reader', () => {
  const intakeConfig = (fields: Array<Record<string, unknown>>) => ({
    display_name: 'Drop-off',
    form_definition: { form_definition_id: 'wired-form-v1', fields },
    submission_processing_rule: {
      target_kind: 'form_response',
      fields_to_include_in_target: [],
      fields_to_attach_as_metadata: [],
    },
    anti_spam: {
      honeypot_fields: [],
      rate_limit_per_ip: 5,
      require_proof_of_work: false,
      require_captcha: false,
    },
    required_visitor_fields: { email: 'required' },
  });

  it('resolves a live intake form and returns null for an unknown id', async () => {
    const endpointStore = {
      list: (filter?: { kind?: string }) => (filter?.kind === 'intake_form'
        ? [{
            endpoint_id: 'ep-wired',
            kind: 'intake_form',
            revoked_at: null,
            metadata: intakeConfig([
              { name: 'item_description', type: 'textarea', label: 'Item', required: true },
            ]),
          }]
        : []),
    };
    const base = makeOptions();
    await composeListeners(makeOptions({
      storage: { ...base.storage, publicEndpointRegistryStoreRef: endpointStore },
    }));
    const config = (
      listenerMocks.createServerHandlerSet.mock.calls as unknown as Array<[
        Record<string, unknown>,
      ]>
    )[0]![0];
    const deps = config.recipeSaveDeps as {
      formDefinitionReader?: (id: string) => { fields: Array<{ name: string }> } | null;
    };
    // The wiring exists…
    expect(deps.formDefinitionReader).toEqual(expect.any(Function));
    // …and it reads the real registry rather than being a stub that returns null.
    expect(deps.formDefinitionReader!('wired-form-v1')?.fields.map((f) => f.name))
      .toEqual(['item_description']);
    expect(deps.formDefinitionReader!('no-such-form')).toBeNull();
  });

  it('omits the reader when there is no endpoint registry to read', async () => {
    const base = makeOptions();
    await composeListeners(makeOptions({
      storage: { ...base.storage },
    }));
    const config = (
      listenerMocks.createServerHandlerSet.mock.calls as unknown as Array<[
        Record<string, unknown>,
      ]>
    )[0]![0];
    expect(
      (config.recipeSaveDeps as Record<string, unknown>).formDefinitionReader,
    ).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// D-228 slice 3 — the generated-pack install closure, driven for real
// ════════════════════════════════════════════════════════════════════

/** ⛔⛔ THE TEST THAT WAS MISSING, and the defect it would have caught.
 *
 *  `installGeneratedPack` passed `{ manifest, install_scope? }` to
 *  `handlePacksInstall` and OMITTED `granted_permissions`, which
 *  `parsePacksInstallArgs` requires to be an array. Every generated-pack
 *  install therefore threw `bad_request` and `install_scope` never reached
 *  provisioning — slice 3 was inert in production while its own table entry
 *  said "covered by typecheck and by reading". A whole-object `as` cast was
 *  hiding it from the compiler, and read-verification demonstrably missed it.
 *
 *  ⚠ THIS DRIVES THE REAL CLOSURE against the REAL `handlePacksInstall`. Earlier
 *  attempts tried to reach it through `handleMcpPackCommit`, which first runs a
 *  live `handleConnectionProbe` (module-level `probeMcpStreamTools`, not
 *  injectable) — but the defect was never in the probe. It was in what
 *  `compose-listeners` builds, so that is where this drives.
 *
 *  🔑 `parsePacksInstallArgs` validates `granted_permissions` BEFORE the
 *  manifest, so a deliberately thin manifest still exercises the check: the
 *  assertion is about WHICH failure, not whether one happens. */
describe('D-228 slice 3 — installGeneratedPack builds a valid packs.install call', () => {
  const composeWithPackInstall = async () => {
    const base = makeOptions();
    // ⚠ BOTH are required: `connectionDeps` is spread only when a connection
    // store exists, and the closure inside it only when a pack installer does.
    // Omitting either yields no closure and a test that proves nothing.
    await composeListeners(makeOptions({
      rpc: { ...(base.rpc as Record<string, unknown>), packInstallDeps: { tag: 'pack-install' } },
      app: { ...(base.app as Record<string, unknown>), connectionStoreRef: { get: () => null } },
    }));
    const config = (
      listenerMocks.createServerHandlerSet.mock.calls as unknown as Array<[
        Record<string, unknown>,
      ]>
    ).at(-1)![0];
    const connectionDeps = config.connectionDeps as Record<string, unknown>;
    return connectionDeps.installGeneratedPack as
      ((m: unknown, s?: unknown) => Promise<void>) | undefined;
  };

  const errorOf = async (fn: () => Promise<unknown>): Promise<string> => {
    try { await fn(); return ''; } catch (e) { return (e as Error).message ?? String(e); }
  };

  it('the closure exists once a pack installer is wired', async () => {
    expect(await composeWithPackInstall()).toBeTypeOf('function');
  });

  /** ⛔⛔ THE REGRESSION GUARD. Before the fix this failed with
   *  `granted_permissions must be an array of strings`, every single time. */
  it('does NOT fail on missing granted_permissions', async () => {
    const install = await composeWithPackInstall();
    const msg = await errorOf(() => install!({ slug: 'generated-x', schema_version: 1 }));
    expect(msg).not.toContain('granted_permissions');
  });

  /** ⚠ THE KNOWN POSITIVE — without it, "does not contain granted_permissions"
   *  passes just as well when the call never reaches `parsePacksInstallArgs` at
   *  all. This proves the probe can SEE the defect: hand the same handler an
   *  args object missing the field and it says so. */
  it('…and the same handler DOES say so when the field is absent', async () => {
    const { handlePacksInstall } = await import('../pack-install-handler.js');
    const msg = await errorOf(() => handlePacksInstall(
      { tag: 'pack-install' } as never,
      { manifest: { slug: 'generated-x', schema_version: 1 } } as never,
      'recued-generated',
    ));
    expect(msg).toContain('granted_permissions must be an array of strings');
  });

  /** An absent selection must stay ABSENT rather than becoming an explicit
   *  `undefined` — the parser reads the two differently (`install_scope !==
   *  undefined` gates a shape check whose failure is a loud `bad_request`). */
  it('an absent install_scope does not become an explicit undefined', async () => {
    const install = await composeWithPackInstall();
    const msg = await errorOf(() => install!({ slug: 'generated-x', schema_version: 1 }));
    expect(msg).not.toContain('install_scope');
  });
});

// ──────────────────────────────────────────────────────────────────
// Audit P2-14 / P2-15 — the composition root's own obligations.
//
// ⚠ SOURCE-LEVEL, for the reason the D-273 wiring test is: both defects were a
// MISSING LINE IN A COMPOSITION ROOT, and every layer below passed its own tests
// without it. The supervisor's `stop()` is unit-tested; only this proves anyone
// calls it.
// ──────────────────────────────────────────────────────────────────
describe('composeListeners — the port-mapping supervisor is wired to teardown', () => {
  const SRC = readFileSync(
    resolve(import.meta.dirname, '..', 'serve', 'compose-listeners.ts'),
    'utf-8',
  );

  it('⛔⛔ closeServer DRAINS it — it was started and never stopped', () => {
    // Its renewal timer and config subscription outlived listener teardown, so a
    // reconcile could be writing its record while the database closed underneath.
    const drains = SRC.slice(SRC.indexOf('const closeServer'), SRC.indexOf('const closeServer') + 2500);
    expect(drains).toMatch(/portMappingSupervisorRef\?\.stop\(\)/);
  });

  it('⛔ the mapping resolves THIS MACHINE’S ADDRESS PER RECONCILE, not at boot', () => {
    // It closed over the boot-time value, so a DHCP move left the mapping naming
    // a host we no longer are — and the planner's DHCP-move branch could never
    // fire, because production never supplied a changed address.
    expect(SRC).toMatch(/const readLanAddressNow = \(\): string =>/);
    // ⚠ Both consumers: the desired mapping AND the actuator resolution (which
    // is also the interface SSDP leaves by).
    expect(SRC.match(/lanAddress: readLanAddressNow\(\)/g) ?? []).toHaveLength(2);
    // ...and the BIND still uses the once-resolved value: a listener's address
    // must not move under a running socket.
    expect(SRC).toMatch(/const lanBindAddress = lanResolution\.bind_address;/);
  });

  /** D-273 — the LIVE `public_port` move, driven through the seam production
   *  actually uses.
   *
   *  ⛔⛔ THIS HANDLER WAS THE COMPOSITION ROOT NOBODY DROVE. The coordinator's
   *  own move is covered (`d-273-coordinator-port-move.test.ts` calls
   *  `apply({ports})` directly), and compose is covered for THREADING the
   *  configured port at boot — but nothing fired `runtimeConfig.onChange`, so
   *  neither branch of the handler that decides WHETHER to move, and what to do
   *  when the move fails, had ever run.
   *
   *  ⚠ THE READBACK IS THE HANDLER'S OWN GUARD. `boundPublicPort` is a closure
   *  local with no accessor from out here, but `if (wanted === boundPublicPort)
   *  return` makes it observable: re-firing with the SAME port re-applies iff
   *  the port was NOT adopted. That distinguishes the two branches without
   *  reaching inside, and it is the exact invariant the code's own comment says
   *  must never come back. */
  describe('D-273 — a live public_port edit moves the listener', () => {
    const composeWithConfigWatcher = async (opts: {
      initialPort: number;
      applyResult: (ports: unknown) => { public: { listening: boolean; failure?: string } };
    }) => {
      let port = opts.initialPort;
      const listeners: Array<() => void> = [];
      const runtimeConfig = {
        get: vi.fn((key: string) => {
          if (key === 'public_port') return port;
          if (key === 'network.lan_bind_address') return '';
          return undefined;
        }),
        onChange: vi.fn((fn: () => void) => {
          listeners.push(fn);
          return () => undefined;
        }),
      };
      listenerMocks.coordinator.apply.mockImplementation(
        async (args: { ports?: unknown }) => opts.applyResult(args.ports),
      );
      await composeListeners(makeOptions({
        runtimeConfig,
        exposureDeps: {
          getMachine: () => ({
            current: async () => ({ resolution: { ws: { lan: true, public: true } } }),
          }),
        },
      }));
      return {
        /** Set the config key and fire every subscriber, as a real write does. */
        setPort: async (next: number) => {
          port = next;
          for (const fn of listeners) fn();
          // the handler's work is a detached async IIFE — let it settle
          await new Promise((r) => setTimeout(r, 0));
        },
        applyCalls: () => listenerMocks.coordinator.apply.mock.calls.filter(
          (c: unknown[]) => (c[0] as { ports?: unknown })?.ports !== undefined,
        ),
        /** What `network.local_urls` would hand a client, via networkDeps. */
        advertisedPort: () => {
          const cfg = (
            listenerMocks.createServerHandlerSet.mock.calls as unknown as Array<[
              Record<string, unknown>,
            ]>
          )[0]![0];
          return (cfg.networkDeps as { getPublicPort: () => number }).getPublicPort();
        },
      };
    };

    afterEach(() => {
      listenerMocks.coordinator.apply.mockReset();
    });

    it('⛔ a successful rebind ADOPTS the new port, and downstream follows', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const h = await composeWithConfigWatcher({
          initialPort: 443,
          applyResult: () => ({ public: { listening: true } }),
        });
        expect(h.advertisedPort()).toBe(443);

        await h.setPort(8443);
        expect(h.applyCalls()).toHaveLength(1);
        expect(h.applyCalls()[0]![0]).toMatchObject({ ports: { public: 8443 } });
        expect(
          h.advertisedPort(),
          'the move succeeded but clients are still told the old port',
        ).toBe(8443);

        // Re-firing with the SAME port must be a no-op — proof it was adopted.
        await h.setPort(8443);
        expect(
          h.applyCalls(),
          'an unchanged port re-bound the listener, dropping live connections for nothing',
        ).toHaveLength(1);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('⛔⛔ a FAILED rebind keeps serving the old port and never advertises the new one', async () => {
      // ⛔ THE ONE THING THAT MUST NOT COME BACK, per the code's own comment:
      // "a failed rebind must not make three surfaces start advertising a port
      // nothing is listening on. That was the original bug."
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const h = await composeWithConfigWatcher({
          initialPort: 443,
          applyResult: () => ({ public: { listening: false, failure: 'EADDRINUSE' } }),
        });

        await h.setPort(8443);
        expect(h.applyCalls()).toHaveLength(1);
        expect(
          h.advertisedPort(),
          'a failed rebind advertised a port nothing is listening on',
        ).toBe(443);

        // Re-firing with the same port MUST retry — the port was not adopted,
        // so the guard must not mistake the wish for the bind.
        await h.setPort(8443);
        expect(
          h.applyCalls(),
          'a failed move was remembered as done; the owner has no way to retry',
        ).toHaveLength(2);

        // ⚠ THE ONLY REPORT THE OWNER GETS IS THIS LINE, ON THE SERVER'S STDOUT.
        // `server.setConfigField` already resolved OK and the settings field now
        // reads 8443, so the config and the bind diverge with nothing on any
        // client surface saying so. Pinned because it is currently the whole of
        // "and says so" that the schema copy promises.
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('did not bind'),
        );
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('443'));
      } finally {
        warnSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it('⚠ a config change that does not touch the port rebinds nothing', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const h = await composeWithConfigWatcher({
          initialPort: 443,
          applyResult: () => ({ public: { listening: true } }),
        });
        // Every subscriber is called on ANY key's write — the supervisor shares
        // this seam — so the port handler must decide for itself.
        await h.setPort(443);
        expect(
          h.applyCalls(),
          'an unrelated config write rebound the public listener',
        ).toHaveLength(0);
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});

