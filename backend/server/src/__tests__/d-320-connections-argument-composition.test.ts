/** D-320 slice 2d / ruling 12 — the `connections` argument through the REAL chat
 *  wire (`composeChatOrchestrator`).
 *
 *  The owner's own catalog (`tier2OwnerCatalog`) names each slot's connections and
 *  aliases; the composed registry, which the MCP door lists and validates calls
 *  against, offers the slot and names none. Both read the per-listing choices the
 *  wire composes from the execute deps (`connectionChoices`): a harness that
 *  handed them in would test itself. The harness below is
 *  `chat-installed-pack-actions-composition.test.ts`'s, as written. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IngredientManifest, RecipeDefinition, ToolEntry, WebChatTab } from '@recued/contracts';
import type { ChatOrchestrator, ChatOrchestratorDeps } from '../chat-orchestrator.js';
import type { ComposeChatOrchestratorDeps } from '../composition/bin/wire-chat-orchestrator.js';
import type { EventBus } from '../events/bus.js';

type TestEventBus = EventBus & { emit: ReturnType<typeof vi.fn> };
type LateGetters = Pick<
  ComposeChatOrchestratorDeps,
  | 'getContactStore'
  | 'getCollectionRegistry'
  | 'getEnrichmentStore'
  | 'getConnectionStore'
  | 'getExecutorConfig'
  | 'getExecuteDeps'
  | 'getScheduleDeps'
>;

const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../chat-orchestrator.js');
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const makeDb = (): Database.Database => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  return db;
};

const eventBus = (): TestEventBus => {
  const emit = vi.fn((event: unknown) => ({
    ...(event as Record<string, unknown>),
    cursor: 1,
  }));
  return {
    cursor: vi.fn(() => 0),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    emit,
    replay: vi.fn(() => []),
    subscriberCount: vi.fn(() => 0),
  } as unknown as TestEventBus;
};

const inertLateGetters = (): LateGetters => ({
  getContactStore: vi.fn(() => undefined),
  getCollectionRegistry: vi.fn(() => undefined),
  getEnrichmentStore: vi.fn(() => undefined),
  getConnectionStore: vi.fn(() => undefined),
  getExecutorConfig: vi.fn(() => undefined),
  getExecuteDeps: vi.fn(() => undefined),
  getScheduleDeps: vi.fn(() => undefined),
});

const importComposerWithOrchestratorSpy = async () => {
  vi.resetModules();
  const stubOrchestrator: ChatOrchestrator = {
    runTurn: vi.fn(async () => ({ turn_id: 'stub-turn' })),
    runMessengerTurn: vi.fn(async () => ({ turn_id: 'stub-messenger-turn' })),
    sessionStore: { append: () => {}, history: () => [] },
    dispatch: { dispatchTool: vi.fn(async () => ({ ok: true as const, result: {} })) },
  };
  const createChatOrchestratorMock = vi.fn((
    _deps: ChatOrchestratorDeps,
  ): ChatOrchestrator => stubOrchestrator);
  vi.doMock('../chat-orchestrator.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chat-orchestrator.js')>();
    return {
      ...actual,
      createChatOrchestrator: createChatOrchestratorMock,
    };
  });
  const mod = await import('../composition/bin/wire-chat-orchestrator.js');
  return { compose: mod.composeChatOrchestrator, createChatOrchestratorMock };
};

const CATALOG = 'hubspot-catalog';
const KEY = 'hubspot-key';
const APP = 'hubspot-app';
const ALIAS: Readonly<Record<string, string>> = { [KEY]: 'Service Key', [APP]: 'Sales app' };
const TOOL = 'd320/read-the-deal';

const READ_THE_DEAL = {
  recipe_id: 'read-the-deal',
  version: 1,
  metadata: { name: 'Read the deal', description: 'One HubSpot read.', author: 'd320', tags: [] },
  chat_exposed: true,
  variables: { hubspot: { label: 'HubSpot connection', type: 'connection', default: '' } },
  prefetch_steps: [],
  steps: [{ id: 'deal', ingredient: CATALOG, connection: '{{config.hubspot}}', input: { operation: 'deal.read', args: {} } }],
} as unknown as RecipeDefinition;

const CATALOG_MANIFEST = {
  slug: CATALOG,
  name: 'HubSpot catalog',
  description: 'HubSpot.',
  author: 'recued-core',
  kind: 'connection',
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
  surfaces: { api: { transport: 'rest', default_base_url: 'https://api.hubapi.com', auth: { kind: 'none' }, executes: {} } },
} as unknown as IngredientManifest;

/** Two HubSpot connections on the pack's list, the key its stored default. */
const contractScan = (scope: string) => {
  if (scope === 'connection_catalog_binding') {
    return [KEY, APP].map((name) => ({
      segments: [name, CATALOG],
      value: { catalog_slug: CATALOG, installed_pack_id: 'hubspot', slot: 'hubspot' },
    }));
  }
  if (scope === 'pack_connection_default') {
    return [{ segments: ['hubspot', 'hubspot'], value: { connection_name: KEY } }];
  }
  return [];
};

const OWNER_SOURCE = { channel: 'chat', actor: 'user_self', chat_session_id: 'cs1', user_id: 'owner' };

const compose = async () => {
  const { compose: composeChat, createChatOrchestratorMock } = await importComposerWithOrchestratorSpy();
  composeChat({
    db: makeDb(),
    keys: undefined,
    eventBus: eventBus(),
    auditLog: undefined,
    serverInstanceId: 'server-test',
    recipeStore: {
      ids: vi.fn(() => [READ_THE_DEAL.recipe_id]),
      get: vi.fn((id: string) => (id === READ_THE_DEAL.recipe_id ? READ_THE_DEAL : null)),
      getStored: vi.fn(() => ({ publisher_id: 'd320', source: 'inline' })),
      listStored: vi.fn(() => []),
    } as never,
    llmConfig: undefined,
    getLlmConfig: () => undefined,
    llmQuota: {} as never,
    llmAdapterRegistry: {} as never,
    emptyTabProbe: vi.fn(async () => new Set<WebChatTab>()),
    pairedInstances: undefined,
    ...inertLateGetters(),
    getExecuteDeps: vi.fn(() => ({
      contractScan,
      connectionOperationProfiles: { list: () => [[KEY, {}], [APP, {}]] },
      connectionStore: { get: (_kind: string, name: string) => ({ display_name: ALIAS[name] }) },
      opAdmissionGate: {
        isOwnerGoverned: () => true,
        isOwnerRecipeGranted: () => true,
        isOpGranted: () => true,
      },
    })) as never,
    getExecutorConfig: vi.fn(() => ({ manifests: new Map([[CATALOG, CATALOG_MANIFEST]]) })) as never,
  });
  return createChatOrchestratorMock.mock.calls.at(-1)![0] as unknown as {
    tier2OwnerCatalog: (source?: unknown) => ReadonlyArray<ToolEntry> | null;
    registry: { getByName: (name: string) => ToolEntry | null };
  };
};

const connectionsArg = (entry: ToolEntry | null | undefined) =>
  ((entry?.arg_schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}).connections;

describe('D-320 slice 2d — the composed chat wire offers the choice', () => {
  it("names the connections in the owner's catalog", async () => {
    const deps = await compose();
    const owner = deps.tier2OwnerCatalog(OWNER_SOURCE)?.find((entry) => entry.name === TOOL);
    expect(connectionsArg(owner)).toMatchObject({
      properties: {
        hubspot: {
          enum: [APP, KEY],
          description: 'hubspot-app: Sales app; hubspot-key: Service Key (default)',
        },
      },
    });
  });

  it('offers the slot, and no names, in the registry a door lists', async () => {
    const deps = await compose();
    const door = deps.registry.getByName(TOOL);
    expect(connectionsArg(door)).toMatchObject({ properties: { hubspot: { type: 'string' } } });
    expect(JSON.stringify(door?.arg_schema)).not.toMatch(/hubspot-app|hubspot-key|Sales app|Service Key/);
  });
});

/** D-320 ruling 20 — a vendor-neutral recipe's FAMILY is offered too, through the
 *  same wire: its `core.crm.*` step names no pack, and the choices list the `crm`
 *  family with the connections the run's pick rule finds can serve it (the profiles'
 *  catalogs, here HubSpot's), not a pack's slot. */
describe('D-320 ruling 20 — the composed chat wire offers a vendor-neutral family', () => {
  const ANY_DEAL = {
    recipe_id: 'read-any-deal',
    version: 1,
    metadata: { name: 'Any deal', description: 'One vendor-neutral search.', author: 'd320', tags: [] },
    chat_exposed: true,
    variables: {},
    prefetch_steps: [],
    steps: [{ id: 'deals', op: 'core.crm.deal.search', args: {} }],
  } as unknown as RecipeDefinition;

  it("names the family's connections in the owner's catalog", async () => {
    const { compose: composeChat, createChatOrchestratorMock } = await importComposerWithOrchestratorSpy();
    composeChat({
      db: makeDb(),
      keys: undefined,
      eventBus: eventBus(),
      auditLog: undefined,
      serverInstanceId: 'server-test',
      recipeStore: {
        ids: vi.fn(() => [ANY_DEAL.recipe_id]),
        get: vi.fn((id: string) => (id === ANY_DEAL.recipe_id ? ANY_DEAL : null)),
        getStored: vi.fn(() => ({ publisher_id: 'd320', source: 'inline' })),
        listStored: vi.fn(() => []),
      } as never,
      llmConfig: undefined,
      getLlmConfig: () => undefined,
      llmQuota: {} as never,
      llmAdapterRegistry: {} as never,
      emptyTabProbe: vi.fn(async () => new Set<WebChatTab>()),
      pairedInstances: undefined,
      ...inertLateGetters(),
      getExecuteDeps: vi.fn(() => ({
        contractScan,
        connectionOperationProfiles: {
          list: () => [KEY, APP].map((name) => [name, { catalog_slug: CATALOG, allowed_operations: ['deal.search'] }]),
        },
        connectionStore: { get: (_kind: string, name: string) => ({ display_name: ALIAS[name] }) },
        opAdmissionGate: {
          isOwnerGoverned: () => true,
          isOwnerRecipeGranted: () => true,
          isOpGranted: () => true,
        },
      })) as never,
      getExecutorConfig: vi.fn(() => ({
        manifests: new Map([[CATALOG, { ...CATALOG_MANIFEST, operations: { 'deal.search': { risk_tier: 'read' } } }]]),
      })) as never,
    });
    const deps = createChatOrchestratorMock.mock.calls.at(-1)![0] as unknown as {
      tier2OwnerCatalog: (source?: unknown) => ReadonlyArray<ToolEntry> | null;
    };
    const owner = deps.tier2OwnerCatalog(OWNER_SOURCE)?.find((entry) => entry.name === 'd320/read-any-deal');
    expect(connectionsArg(owner)).toMatchObject({ properties: { crm: { enum: [APP, KEY] } } });
  });
});
