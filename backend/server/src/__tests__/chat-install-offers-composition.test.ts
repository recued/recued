/** D-323 — the offers reach `tools.search` through the REAL chat wire
 *  (`composeChatOrchestrator`): present with the serve path's catalogue, absent
 *  without one, and off when the owner turns them off. The harness is
 *  `chat-installed-pack-actions-composition.test.ts`'s, cut to what this needs. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebChatTab } from '@recued/contracts';

import { TOOLS_SEARCH_TOOL_NAME } from '../chat-tools-search-name.js';
import type { ChatOrchestrator, ChatOrchestratorDeps } from '../chat-orchestrator.js';
import type { ComposeChatOrchestratorDeps } from '../composition/bin/wire-chat-orchestrator.js';
import type { MarketplaceCatalogue, MarketplaceCatalogueSnapshot } from '../install-offers/catalogue.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../chat-orchestrator.js');
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const SNAPSHOT: MarketplaceCatalogueSnapshot = {
  packs: [{ slug: 'rental-book', name: 'Rental Book', tags: ['rent'], publisher_id: 'recued-core', publisher_certified: true }],
  recipes: [{ recipe_id: 'collect-rent', name: 'Collect the rent', tags: [], publisher_id: 'recued-core', publisher_certified: true, recipe_bundle: 'recued-core/rental-book' }],
  fetched_at: 0,
};
const catalogue = (): MarketplaceCatalogue => ({
  current: () => SNAPSHOT, ensureFresh: () => undefined, refresh: async () => undefined, ready: async () => SNAPSHOT,
});

const deps = (db: Database.Database, overrides: Partial<ComposeChatOrchestratorDeps>): ComposeChatOrchestratorDeps => ({
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
  getExecuteDeps: vi.fn(() => undefined),
  getScheduleDeps: vi.fn(() => undefined),
  ...overrides,
});

const composedSearch = async (overrides: Partial<ComposeChatOrchestratorDeps>, before?: (db: Database.Database) => void) => {
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
  composeChatOrchestrator(deps(db, overrides));
  before?.(db);
  const registry = (create.mock.calls.at(-1)![0] as unknown as {
    registry: { dispatch: (name: string, args: unknown, ctx: unknown) => Promise<unknown> };
  }).registry;
  const res = await registry.dispatch(TOOLS_SEARCH_TOOL_NAME, { query: 'collect rent' }, {
    channel: 'internal_function_call',
    execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 'cs1', user_id: 'owner' },
  });
  return (res as { result: Record<string, unknown> }).result;
};

describe('install offers through the real chat wire (D-323)', () => {
  it('reach tools.search with the serve path’s catalogue', async () => {
    const result = await composedSearch({ installOfferCatalogue: catalogue() });
    expect((result.installable as Array<{ slug: string }>).map((offer) => offer.slug)).toEqual(['rental-book']);
  });

  it('are absent without a catalogue: a test or a drive makes no download', async () => {
    const result = await composedSearch({});
    expect(result).not.toHaveProperty('installable');
  });

  it('⛔ stop when the owner turns them off', async () => {
    const result = await composedSearch({ installOfferCatalogue: catalogue() }, (db) => {
      db.prepare(`INSERT OR REPLACE INTO chat_config (key, value) VALUES ('install_offers_enabled', '0')`).run();
    });
    expect(result).not.toHaveProperty('installable');
  });
});
