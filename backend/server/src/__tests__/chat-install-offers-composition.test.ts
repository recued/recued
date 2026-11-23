/** D-323 — the offers reach `tools.search` through the REAL chat wire
 *  (`composeChatOrchestrator`): present with the serve path's catalogue, absent
 *  without one, and off when the owner turns them off. The harness is
 *  `chat-installed-pack-actions-composition.test.ts`'s, cut to what this needs. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebChatTab } from '@recued/contracts';

import { TOOLS_SEARCH_TOOL_NAME } from '../chat-tools-search-name.js';
import { createChatStore } from '../storage/chat-store.js';
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

const composedSearch = async (overrides: Partial<ComposeChatOrchestratorDeps>, before?: (db: Database.Database) => void | Promise<void>,
  session?: { session_id: string; turn_state?: Map<string, unknown> }) => {
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
  await before?.(db);
  const registry = (create.mock.calls.at(-1)![0] as unknown as {
    registry: { dispatch: (name: string, args: unknown, ctx: unknown) => Promise<unknown> };
  }).registry;
  const res = await registry.dispatch(TOOLS_SEARCH_TOOL_NAME, { query: 'collect rent' }, {
    channel: 'internal_function_call',
    execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 'cs1', user_id: 'owner' },
    // D-405 slice 8 — the conversation and turn the model's own call carries.
    ...(session !== undefined ? { session_id: session.session_id, turn_id: 't1', turn_state: session.turn_state ?? new Map<string, unknown>() } : {}),
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

  // D-405 slice 3 — "Not now" on the offer, kept where `chat.hints.not_now` keeps it.
  it('⛔ leave out one the owner said "Not now" to, until it comes back', async () => {
    const hide = (until: number) => (db: Database.Database) => {
      db.prepare('INSERT INTO chat_hint_not_now (key, label, until, at) VALUES (?, ?, ?, ?)').run('offer:pack:rental-book', 'Get Rental Book', until, 1);
    };
    expect(await composedSearch({ installOfferCatalogue: catalogue() }, hide(Date.now() + 86_400_000))).not.toHaveProperty('installable');
    const back = await composedSearch({ installOfferCatalogue: catalogue() }, hide(Date.now() - 1));
    expect((back.installable as Array<{ slug: string }>).map((offer) => offer.slug)).toEqual(['rental-book']);
  });

  // D-405 slice 8 — never the same offer twice in one conversation (P3): one an earlier answer there made
  // is left out, and the model is told what it is told when there is none to make.
  it('⛔ not made again in a conversation an earlier answer made it in; another conversation still gets it', async () => {
    const offeredIn = (session_id: string) => async (db: Database.Database) => {
      const chat = createChatStore(db);
      chat.createSession({ id: session_id, now: 1_000 });
      await chat.appendMessage({ id: `a-${session_id}`, session_id, role: 'assistant', content: 'Rental Book would.', ts: 1_002,
        target_server: 'self', model_used: { provider: 'test', model_id: 'test' },
        picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued', version: 'test', instance_id: 'local' } },
        install_offers: [{ kind: 'pack', slug: 'rental-book', name: 'Rental Book', publisher: 'recued-core', recipes: [] }] });
    };
    const again = await composedSearch({ installOfferCatalogue: catalogue() }, offeredIn('s1'), { session_id: 's1' });
    expect(again).not.toHaveProperty('installable');
    // The words a search with no offer gets (here the documentation's: the query matches some), never the
    // ones that point at an offer under the answer.
    const none = await composedSearch({ installOfferCatalogue: catalogue() }, (db) => {
      db.prepare(`INSERT OR REPLACE INTO chat_config (key, value) VALUES ('install_offers_enabled', '0')`).run();
    }, { session_id: 's1' });
    expect(again.guidance).toBe(none.guidance);
    const elsewhere = await composedSearch({ installOfferCatalogue: catalogue() }, offeredIn('s1'), { session_id: 's2' });
    expect((elsewhere.installable as Array<{ slug: string }>).map((offer) => offer.slug)).toEqual(['rental-book']);
    // With the offer, the words differ: so the two equal above say the offer is gone from them too.
    expect(elsewhere.guidance).not.toBe(none.guidance);
  });
});
