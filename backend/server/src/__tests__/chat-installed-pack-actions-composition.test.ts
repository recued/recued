/** D-225 § 9.5.1 — installed pack actions reach the owner's chat, through the REAL wire.
 *
 *  Split from `d-137-chat-orchestrator-composition.test.ts` (2026-10-06). These cases read the
 *  Home Assistant pack from the community catalog, which the public repository does not carry,
 *  and the public export drops a test file that reaches the catalog WHOLE: living there, they took
 *  that file's other 27 cases out of the 26.10.6 public suite. The harness below is that file's
 *  `buildDeps` / `importComposerWithOrchestratorSpy`, copied as written; keep the two in step. */
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebChatTab } from '@recued/contracts';
import { decomposeComposition } from '@recued/ingredient-authoring';
import { TOOLS_SEARCH_TOOL_NAME } from '../chat-tools-search-name.js';
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

const emptyRecipeStore = () =>
  ({
    ids: vi.fn(() => []),
    get: vi.fn(() => null),
    getStored: vi.fn(() => null),
    listStored: vi.fn(() => []),
  }) as never;

const inertLateGetters = (): LateGetters => ({
  getContactStore: vi.fn(() => undefined),
  getCollectionRegistry: vi.fn(() => undefined),
  getEnrichmentStore: vi.fn(() => undefined),
  getConnectionStore: vi.fn(() => undefined),
  getExecutorConfig: vi.fn(() => undefined),
  getExecuteDeps: vi.fn(() => undefined),
  getScheduleDeps: vi.fn(() => undefined),
});

const buildDeps = (
  overrides: Partial<ComposeChatOrchestratorDeps> = {},
  lateGetters: LateGetters = inertLateGetters(),
): ComposeChatOrchestratorDeps => ({
  db: overrides.db ?? makeDb(),
  keys: undefined,
  eventBus: overrides.eventBus ?? eventBus(),
  auditLog: undefined,
  serverInstanceId: 'server-test',
  recipeStore: emptyRecipeStore(),
  llmConfig: undefined,
  getLlmConfig: () => undefined,
  llmQuota: {} as never,
  llmAdapterRegistry: {} as never,
  emptyTabProbe: vi.fn(async () => new Set<WebChatTab>()),
  pairedInstances: undefined,
  ...lateGetters,
  ...overrides,
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

describe('installed pack actions reach the chat (D-225 § 9.5.1)', () => {
  // ⛔ THE RAW-OP SOURCE SHIPPED WITHOUT ITS PACK SCAN. `createChatRawOpSource`
  // takes the scan as optional ("absent ⇒ no raw ops") and the wire never
  // passed it, so from 2026-07-30 no installed pack action reached the owner's
  // chat in any catalog mode. Live: "take a snapshot of the camera" searched
  // three times and was told nothing could. These go through the REAL wire.
  const PACK_JSON = JSON.parse(readFileSync(
    new URL('../../../../community/packs/home-assistant.json', import.meta.url), 'utf8',
  )) as { contents: Array<{ composition?: { schema_version?: number } }> };
  const composition = PACK_JSON.contents.find((c) => c.composition !== undefined)!.composition!;
  const catalog = decomposeComposition[composition.schema_version ?? 1]!(composition as never).catalog!;
  const SNAPSHOT = 'recued_op_recued-core.home-assistant.camera.snapshot';
  const OWNER_SOURCE = { channel: 'chat', actor: 'user_self', chat_session_id: 'cs1', user_id: 'owner' };
  const withHomeAssistant = (): ComposeChatOrchestratorDeps => buildDeps({}, {
    ...inertLateGetters(),
    getExecuteDeps: vi.fn(() => ({
      contractScan: (kind: string) => (kind === 'installed_pack'
        ? [{ segments: ['home-assistant'], value: { publisher: 'recued-core', ingredient_ids: [catalog.slug] } }]
        : []),
    })) as never,
    getExecutorConfig: vi.fn(() => ({ manifests: new Map([[catalog.slug, catalog]]) })) as never,
  });

  it('gives the raw-op source the installed-pack inventory', async () => {
    const { compose, createChatOrchestratorMock } = await importComposerWithOrchestratorSpy();
    compose(withHomeAssistant());
    const deps = createChatOrchestratorMock.mock.calls.at(-1)![0] as unknown as {
      rawOpSource: (source?: unknown) => ReadonlyArray<{ name: string }>;
    };
    expect(deps.rawOpSource(OWNER_SOURCE).map((entry) => entry.name)).toContain(SNAPSHOT);
  });

  it('lets tools.search find a pack action through the composed registry', async () => {
    const { compose, createChatOrchestratorMock } = await importComposerWithOrchestratorSpy();
    compose(withHomeAssistant());
    const deps = createChatOrchestratorMock.mock.calls.at(-1)![0] as unknown as {
      registry: { dispatch: (name: string, args: unknown, ctx: unknown) => Promise<unknown> };
    };
    const res = await deps.registry.dispatch(TOOLS_SEARCH_TOOL_NAME, { query: 'camera snapshot' },
      { channel: 'internal_function_call', execution_source: OWNER_SOURCE });
    const matches = (res as { result: { matches: Array<{ recipe_slug: string }> } }).result.matches;
    expect(matches.map((m) => m.recipe_slug)).toContain(SNAPSHOT);
  });
});
