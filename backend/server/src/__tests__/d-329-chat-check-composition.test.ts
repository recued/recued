/** D-329 — a write's own check reaches the chat through the REAL chat wire
 *  (`composeChatOrchestrator`), every registry wrapper included.
 *
 *  ⛔ Found live (2026-10-25): each wrapper built its registry from the five methods it
 *  knew, so the registry the chat dispatched through had no `checkBeforeAsking`. "I moved
 *  my road bike to the shed" was put to the owner in 2 of 2 runs, though the check refuses
 *  it: the owner had typed that place. Every test had driven a bare registry or a fake
 *  one, so all were green. The harness is `chat-install-offers-composition.test.ts`'s. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatDispatchContext, ChatDispatchResult, WebChatTab } from '@recued/contracts';

import type { ChatOrchestrator, ChatOrchestratorDeps } from '../chat-orchestrator.js';
import type { ComposeChatOrchestratorDeps } from '../composition/bin/wire-chat-orchestrator.js';
import type { MarketplaceCatalogue, MarketplaceCatalogueSnapshot } from '../install-offers/catalogue.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../chat-orchestrator.js');
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const SNAPSHOT: MarketplaceCatalogueSnapshot = { packs: [], recipes: [], fetched_at: 0 };
/** The serve path passes one, and with it the needed-pack wrapper wraps the registry too. */
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

/** The registry `composeChatOrchestrator` hands the chat orchestrator. */
const composedRegistry = async (overrides: Partial<ComposeChatOrchestratorDeps>): Promise<ChatOrchestratorDeps['registry']> => {
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
  return create.mock.calls.at(-1)![0].registry;
};
const ownerChat: ChatDispatchContext = {
  channel: 'internal_function_call',
  session_id: 'cs1',
  execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 'cs1', user_id: 'owner' },
};

describe('D-329 — the chat asks a write\'s own check, through every wrapper', () => {
  it.each([
    ['with the marketplace catalogue the serve path passes', { installOfferCatalogue: catalogue() }],
    ['without one', {}],
  ] as const)('reaches the write\'s handler in its check mode, %s', async (_name, overrides) => {
    const registry = await composedRegistry(overrides);
    expect(typeof registry.checkBeforeAsking).toBe('function');
    // This harness has no work store, so the handler answers that, before any write: the
    // answer comes from the handler itself, through all five wrappers.
    for (const tool of ['work.create', 'work.update'] as const) {
      const refused = await registry.checkBeforeAsking!(tool, { kind: 'asset', id: 'a1', title: 'Road bike' }, ownerChat);
      expect(refused, tool).toEqual<ChatDispatchResult>({ ok: false, reason: 'execution_error', detail: 'work-entity write path unavailable' });
    }
    // A tool with no check of its own is asked about as before.
    expect(await registry.checkBeforeAsking!('calendar.search', {}, ownerChat)).toBeNull();
    // So does the lookup of the names an ask shows: this harness has no work store, so it
    // names nothing, through all five wrappers.
    expect(typeof registry.askValueLabels).toBe('function');
    expect(await registry.askValueLabels!('work.update', { kind: 'asset', id: 'a1' }, ownerChat)).toBeUndefined();
  });
});
