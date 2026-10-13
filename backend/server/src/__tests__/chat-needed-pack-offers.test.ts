/** D-323 — a recipe chat runs that needs a pack not installed: the run's REAL
 *  refusal (`handleExecute`'s `pack_not_installed`), kept as data by the chat
 *  tools that run recipes, and offered through the REAL chat wire
 *  (`composeChatOrchestrator`) on the owner's turn.
 *
 *  ⛔ The packs used to be lost at the chat tools: they caught the refusal and
 *  kept its message only, "…not installed: recued-core.docling. Install it and
 *  run again.", so nothing could offer the pack, and the model read an
 *  instruction it cannot follow. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatDispatchContext, ChatDispatchResult, RecipeDefinition, WebChatTab } from '@recued/contracts';

import { buildChatTier1Handlers, createChatTier2Dispatch, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import type { ChatOrchestrator, ChatOrchestratorDeps } from '../chat-orchestrator.js';
import type { ComposeChatOrchestratorDeps } from '../composition/bin/wire-chat-orchestrator.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import type { MarketplaceCatalogue, MarketplaceCatalogueSnapshot } from '../install-offers/catalogue.js';
import { neededPacksSentence } from '../install-offers/needed-packs.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';

/** A recipe whose one step is an op of `recued-core.docling`, which it declares. */
const PARSE_A_PDF = {
  recipe_id: 'parse-a-pdf',
  version: 1,
  ttl: 60,
  metadata: { name: 'Parse a PDF', description: 'calls a pack op', author: 'recued-core', supported_platforms: [] },
  depends_on: ['recued-core.docling'],
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 's0', op: 'recued-core.docling.document.to_markdown' }],
  output: { render: [] },
} as unknown as RecipeDefinition;

/** Execute deps with NO pack installed, so the run is refused as it is live. */
const executeDeps = (): ExecuteHandlerDeps => {
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(PARSE_A_PDF);
  return {
    recipeStore,
    executorConfig: { manifests: { ...createManifestRegistry('/nonexistent'), get: () => undefined } },
    baseVault: {},
    contractScan: () => [],
  } as unknown as ExecuteHandlerDeps;
};

const ownerCtx: ChatDispatchContext = {
  channel: 'internal_function_call',
  session_id: 's1',
  turn_id: 't1',
  execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'owner' },
};

const handlerDeps = (ex: ExecuteHandlerDeps): ChatToolHandlerDeps => ({
  getContactStore: () => undefined,
  getCollectionRegistry: () => undefined,
  getAuditLog: () => undefined,
  getEnrichmentStore: () => undefined,
  getRecipeStore: () => ex.recipeStore,
  getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
  getExecuteRecipe: () => (req) => handleExecute(ex, req),
});

const REFUSED = {
  ok: false,
  reason: 'execution_error',
  detail: expect.stringContaining('needs a pack that is not installed: recued-core.docling'),
  missing_packs: ['recued-core.docling'],
};

describe('the chat tools that run a recipe keep a refusal’s packs', () => {
  it('recipe.run', async () => {
    const run = buildChatTier1Handlers(handlerDeps(executeDeps()))['recipe.run']!;
    expect(await run({ recipe_id: 'parse-a-pdf' }, ownerCtx)).toEqual(REFUSED);
  });

  it('an installed recipe called by name', async () => {
    const dispatch = createChatTier2Dispatch(handlerDeps(executeDeps()));
    expect(await dispatch('recued-core/parse-a-pdf', {}, ownerCtx)).toEqual(REFUSED);
  });

  it('any other failure stays as it was, with no packs', async () => {
    const deps = { ...handlerDeps(executeDeps()), getExecuteRecipe: () => async () => { throw new Error('engine boom'); } };
    expect(await buildChatTier1Handlers(deps)['recipe.run']!({ recipe_id: 'parse-a-pdf' }, ownerCtx))
      .toEqual({ ok: false, reason: 'execution_error', detail: 'engine boom' });
  });
});

const SNAPSHOT: MarketplaceCatalogueSnapshot = {
  packs: [{ slug: 'docling', name: 'Docling', tags: ['documents'], publisher_id: 'recued-core', publisher_certified: true }],
  recipes: [],
  fetched_at: 0,
};
const catalogue = (): MarketplaceCatalogue => ({
  current: () => SNAPSHOT, ensureFresh: () => undefined, refresh: async () => undefined, ready: async () => SNAPSHOT,
});
const DOCLING = { kind: 'pack' as const, slug: 'docling', name: 'Docling', publisher: 'recued-core', recipes: [] };

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../chat-orchestrator.js');
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const wireDeps = (db: Database.Database, overrides: Partial<ComposeChatOrchestratorDeps>): ComposeChatOrchestratorDeps => ({
  db,
  keys: undefined,
  eventBus: { cursor: vi.fn(() => 0), subscribe: vi.fn(), unsubscribe: vi.fn(), emit: vi.fn(() => ({ cursor: 1 })),
    replay: vi.fn(() => []), subscriberCount: vi.fn(() => 0) } as never,
  auditLog: undefined,
  serverInstanceId: 'server-test',
  recipeStore: { ids: vi.fn(() => []), get: vi.fn(() => null), getStored: vi.fn(() => null), listStored: vi.fn(() => []) } as never,
  llmConfig: undefined,
  getLlmConfig: () => undefined,
  llmQuota: {} as never,
  llmAdapterRegistry: {} as never,
  emptyTabProbe: vi.fn(async () => new Set<WebChatTab>()),
  pairedInstances: undefined,
  getContactStore: vi.fn(() => undefined),
  getCollectionRegistry: vi.fn(() => undefined),
  getEnrichmentStore: vi.fn(() => undefined),
  getConnectionStore: vi.fn(() => undefined),
  getExecutorConfig: vi.fn(() => undefined),
  getExecuteDeps: vi.fn(() => executeDeps()),
  getScheduleDeps: vi.fn(() => undefined),
  ...overrides,
});

/** `recipe.run` of the recipe, through the registry the composed chat hands
 *  its orchestrator. */
const composedRun = async (
  overrides: Partial<ComposeChatOrchestratorDeps>,
  before?: (db: Database.Database) => void,
): Promise<ChatDispatchResult> => {
  vi.resetModules();
  const create = vi.fn((_deps: ChatOrchestratorDeps): ChatOrchestrator => ({
    runTurn: vi.fn(async () => ({ turn_id: 't' })),
    runMessengerTurn: vi.fn(async () => ({ turn_id: 't' })),
    sessionStore: { append: () => {}, history: () => [] },
    dispatch: { dispatchTool: vi.fn(async () => ({ ok: true as const, result: {} })) },
  }));
  vi.doMock('../chat-orchestrator.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../chat-orchestrator.js')>()),
    createChatOrchestrator: create,
  }));
  const { composeChatOrchestrator } = await import('../composition/bin/wire-chat-orchestrator.js');
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  composeChatOrchestrator(wireDeps(db, overrides));
  before?.(db);
  const registry = (create.mock.calls.at(-1)![0] as unknown as {
    registry: { dispatch: (name: string, args: unknown, ctx: unknown) => Promise<ChatDispatchResult> };
  }).registry;
  return registry.dispatch('recipe.run', { recipe_id: 'parse-a-pdf' }, ownerCtx);
};

describe('a refused run’s packs, offered through the real chat wire', () => {
  it('the owner’s turn gets the pack as an offer, and the model is told it is a link under the answer', async () => {
    const result = await composedRun({ installOfferCatalogue: catalogue() });
    const refusal = "Recipe 'parse-a-pdf' needs a pack that is not installed: recued-core.docling. Install it and run again.";
    expect(result).toEqual({
      ok: true,
      result: { status: 'needs_pack', message: refusal, hint: neededPacksSentence([DOCLING]) },
      // ⛔ The owner's activity row: the refusal's own words, never the model's.
      run_failed: { detail: refusal },
      missing_packs: ['recued-core.docling'],
      install_offers: [DOCLING],
    });
  });

  it('⛔ none once the owner turns offers off: the refusal reads as before', async () => {
    const result = await composedRun({ installOfferCatalogue: catalogue() }, (db) => {
      db.prepare(`INSERT OR REPLACE INTO chat_config (key, value) VALUES ('install_offers_enabled', '0')`).run();
    });
    expect(result).toEqual(REFUSED);
    expect(result.ok ? '' : result.detail).not.toContain('link under your answer');
  });

  it('none without a catalogue: a test or a drive makes no download', async () => {
    expect(await composedRun({})).toEqual(REFUSED);
  });

  it('⛔ none on a turn the owner does not govern: the wire hands the wrapper tools.search’s guard', async () => {
    // A gate that governs nothing as the owner, and admits everything else, so
    // the run is refused exactly as on the owner's turn and only the guard
    // differs. ⚠ The refusal arriving is asserted too: without it, "no offer"
    // would prove nothing.
    const gate = {
      isOwnerGoverned: () => false,
      isOpGranted: () => true,
      isOwnerRecipeGranted: () => true,
      isFrozenByPause: () => false,
    };
    const result = await composedRun({
      installOfferCatalogue: catalogue(),
      getExecuteDeps: vi.fn(() => ({ ...executeDeps(), opAdmissionGate: gate }) as unknown as ExecuteHandlerDeps),
    });
    expect(result).toEqual(REFUSED);
  });
});
