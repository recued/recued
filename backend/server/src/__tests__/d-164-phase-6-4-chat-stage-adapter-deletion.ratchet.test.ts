/** D-164 P6.4 — chat-stage adapter deletion ratchets.
 *
 * Pins:
 *   - The chat-stage1 + chat-stage2 adapter source files stay deleted.
 *   - `wire-chat-orchestrator.ts` no longer references the deleted
 *     adapter symbols (factories, executor types, orphan closures).
 *   - The composer registers the prompt-cache middleware after the
 *     first-party bundle (the registry has no live consumer today —
 *     P5/P6 prompt-cache consumers slot in without re-touching this
 *     boot per the P6.0 (b) decision).
 *   - The composer passes the inline `executeAiCall` closure to
 *     `createChatOrchestrator` and the closure honors the
 *     `ExecuteChatAiCall` shape from chat-orchestrator.ts.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  RecuedServerSignature,
  WebChatTab,
} from '@recued/contracts';
import type { EventBus } from '../events/bus.js';
import type {
  ChatOrchestrator,
  ChatOrchestratorDeps,
  ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import type {
  ChatOrchestratorBundle,
  ComposeChatOrchestratorDeps,
} from '../composition/bin/wire-chat-orchestrator.js';

const WIRE_SRC_URL = new URL(
  '../composition/bin/wire-chat-orchestrator.ts',
  import.meta.url,
);
const WIRE_SRC_PATH = fileURLToPath(WIRE_SRC_URL);

const STAGE1_ADAPTER_PATH = fileURLToPath(
  new URL('../chat-stage1-adapter.ts', import.meta.url),
);
const STAGE2_ADAPTER_PATH = fileURLToPath(
  new URL('../chat-stage2-adapter.ts', import.meta.url),
);

const readWireSource = (): string => readFileSync(WIRE_SRC_PATH, 'utf8');

const cleanups: Array<() => void> = [];

const makeDb = (): Database.Database => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  return db;
};

type TestEventBus = EventBus & { emit: ReturnType<typeof vi.fn> };

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

const inertLateGetters = () => ({
  getContactStore: vi.fn(() => undefined),
  getCollectionRegistry: vi.fn(() => undefined),
  getEnrichmentStore: vi.fn(() => undefined),
  getConnectionStore: vi.fn(() => undefined),
  getExecutorConfig: vi.fn(() => undefined),
  getExecuteDeps: vi.fn(() => undefined),
});

const buildDeps = (
  overrides: Partial<ComposeChatOrchestratorDeps> = {},
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
  ...inertLateGetters(),
  ...overrides,
});

const stubOrchestrator: ChatOrchestrator = {
  runTurn: vi.fn(async () => ({ turn_id: 'stub-turn' })),
  runMessengerTurn: vi.fn(async () => ({ turn_id: 'stub-messenger-turn' })),
  sessionStore: { append: () => {}, history: () => [] },
  dispatch: { dispatchTool: vi.fn(async () => ({ ok: true as const, result: {} })) },
};

const importComposerWithMocks = async (mocks: {
  registerFirstPartyMiddlewares?: ReturnType<typeof vi.fn>;
  registerPromptCacheMiddleware?: ReturnType<typeof vi.fn>;
  createChatOrchestrator?: ReturnType<typeof vi.fn>;
}): Promise<{
  compose: (deps: ComposeChatOrchestratorDeps) => ChatOrchestratorBundle;
}> => {
  vi.resetModules();
  if (mocks.registerFirstPartyMiddlewares) {
    const fpMock = mocks.registerFirstPartyMiddlewares;
    vi.doMock('@recued/middleware-recued', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@recued/middleware-recued')>();
      return { ...actual, registerFirstPartyMiddlewares: fpMock };
    });
  }
  if (mocks.registerPromptCacheMiddleware) {
    const pcMock = mocks.registerPromptCacheMiddleware;
    vi.doMock('@recued/middleware-prompt-cache', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@recued/middleware-prompt-cache')>();
      return { ...actual, registerPromptCacheMiddleware: pcMock };
    });
  }
  if (mocks.createChatOrchestrator) {
    const orchMock = mocks.createChatOrchestrator;
    vi.doMock('../chat-orchestrator.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../chat-orchestrator.js')>();
      return { ...actual, createChatOrchestrator: orchMock };
    });
  }
  const mod = await import('../composition/bin/wire-chat-orchestrator.js');
  return { compose: mod.composeChatOrchestrator };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@recued/middleware-recued');
  vi.doUnmock('@recued/middleware-prompt-cache');
  vi.doUnmock('../chat-orchestrator.js');
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('D-164 P6.4 chat-stage adapter source-file deletion', () => {
  it('[D-164 P6.4] chat-stage1-adapter.ts stays deleted', () => {
    // mutate: restore backend/server/src/chat-stage1-adapter.ts -> this fails.
    expect(existsSync(STAGE1_ADAPTER_PATH)).toBe(false);
  });

  it('[D-164 P6.4] chat-stage2-adapter.ts stays deleted', () => {
    // mutate: restore backend/server/src/chat-stage2-adapter.ts -> this fails.
    expect(existsSync(STAGE2_ADAPTER_PATH)).toBe(false);
  });
});

describe('D-164 P6.4 wire-chat-orchestrator import hygiene', () => {
  it('[D-164 P6.4] drops every chat-stage adapter symbol the composer used to wire', () => {
    // mutate: re-import the deleted adapter factories or stage-1 closure -> this fails.
    const source = readWireSource();
    for (const symbol of [
      'chat-stage1-adapter',
      'chat-stage2-adapter',
      'createChatStage1ApiAdapter',
      'createChatStage2ApiAdapter',
      'ChatStage1Executor',
      'ChatStage2Executor',
      'chatStage1Executor',
      'chatStage2Executor',
      'stage1Adapter',
      'stage2Adapter',
    ]) {
      expect(source).not.toContain(symbol);
    }
  });

  it('[D-164 P6.4] imports registerPromptCacheMiddleware from the prompt-cache package', () => {
    // mutate: remove the import -> this fails.
    const source = readWireSource();
    expect(source).toMatch(
      /import\s*\{\s*registerPromptCacheMiddleware\s*\}\s*from\s*['"]@recued\/middleware-prompt-cache['"]/,
    );
  });

  it('[D-164 P6.4] imports ExecuteChatAiCall from chat-orchestrator as the closure type instead of the deleted ChatStage2Executor', () => {
    // mutate: drop the ExecuteChatAiCall type import (or replace it with a
    // local alias declared in this file) -> this fails. The match anchors
    // on the multiline `from '../../chat-orchestrator.js'` import group
    // that brings in createChatOrchestrator + the closure shape, so a
    // local type alias wouldn't satisfy it.
    const source = readWireSource();
    expect(source).toMatch(
      /import\s*\{[^}]*\btype\s+ExecuteChatAiCall\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/chat-orchestrator\.js['"]/,
    );
  });
});

describe('D-164 P6.4 prompt-cache middleware registration', () => {
  it('[D-164 P6.4] registers the prompt-cache middleware exactly once with the same registry the first-party bundle received', async () => {
    // mutate: drop the registerPromptCacheMiddleware call -> this fails.
    const registerFirstPartyMiddlewaresMock = vi.fn();
    const registerPromptCacheMiddlewareMock = vi.fn();
    const { compose } = await importComposerWithMocks({
      registerFirstPartyMiddlewares: registerFirstPartyMiddlewaresMock,
      registerPromptCacheMiddleware: registerPromptCacheMiddlewareMock,
    });

    compose(buildDeps());

    expect(registerPromptCacheMiddlewareMock).toHaveBeenCalledTimes(1);
    expect(registerFirstPartyMiddlewaresMock).toHaveBeenCalledTimes(1);
    const fpRegistry = registerFirstPartyMiddlewaresMock.mock.calls[0]?.[0];
    const pcRegistry = registerPromptCacheMiddlewareMock.mock.calls[0]?.[0];
    expect(pcRegistry).toBeDefined();
    expect(pcRegistry).toBe(fpRegistry);
  });

  it('[D-164 P6.4] invokes registerPromptCacheMiddleware AFTER registerFirstPartyMiddlewares so the legacy bundle slots before prompt-cache', async () => {
    // mutate: swap the order or call prompt-cache before the first-party bundle -> this fails.
    const calls: string[] = [];
    const registerFirstPartyMiddlewaresMock = vi.fn(() => {
      calls.push('first-party');
    });
    const registerPromptCacheMiddlewareMock = vi.fn(() => {
      calls.push('prompt-cache');
    });
    const { compose } = await importComposerWithMocks({
      registerFirstPartyMiddlewares: registerFirstPartyMiddlewaresMock,
      registerPromptCacheMiddleware: registerPromptCacheMiddlewareMock,
    });

    compose(buildDeps());

    expect(calls).toEqual(['first-party', 'prompt-cache']);
  });
});

describe('D-164 P6.4 executeAiCall closure wiring', () => {
  it('[D-164 P6.4] passes the inline executeChatAiCall closure to createChatOrchestrator as executeAiCall', async () => {
    // mutate: drop the executeAiCall wiring or wire a different field -> this fails.
    const createChatOrchestratorMock = vi.fn(
      (_deps: ChatOrchestratorDeps): ChatOrchestrator => stubOrchestrator,
    );
    const { compose } = await importComposerWithMocks({
      createChatOrchestrator: createChatOrchestratorMock,
    });

    compose(buildDeps());

    expect(createChatOrchestratorMock).toHaveBeenCalledTimes(1);
    const orchestratorDeps = createChatOrchestratorMock.mock.calls[0]?.[0];
    expect(orchestratorDeps?.executeAiCall).toBeTypeOf('function');
  });

  it('[D-164 P6.4] surfaces AI_LLM_UNAVAILABLE when the executeAiCall closure runs without llmConfig (preserves the no-llm posture)', async () => {
    // mutate: stop throwing AI_LLM_UNAVAILABLE when llmConfig is undefined -> this fails.
    const createChatOrchestratorMock = vi.fn(
      (_deps: ChatOrchestratorDeps): ChatOrchestrator => stubOrchestrator,
    );
    const { compose } = await importComposerWithMocks({
      createChatOrchestrator: createChatOrchestratorMock,
    });

    compose(buildDeps({ llmConfig: undefined }));

    const orchestratorDeps = createChatOrchestratorMock.mock.calls[0]?.[0];
    const executeAiCall = orchestratorDeps?.executeAiCall as ExecuteChatAiCall;
    expect(executeAiCall).toBeTypeOf('function');
    await expect(
      executeAiCall(
        {
          slug: 'recued/test',
          name: 'test',
          description: 'test',
          author: 'recued',
          kind: 'ai',
          category: 'ai',
          risk_tier: 'read',
          input: {},
          output: {},
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'AI_LLM_UNAVAILABLE' });
  });
});

describe('D-164 P6.4 selfSignature is unchanged by the slice', () => {
  it('still composes a RecuedServerSignature shape', async () => {
    // Sanity ratchet — confirms the deletion didn't perturb the signature shape.
    const createChatOrchestratorMock = vi.fn(
      (_deps: ChatOrchestratorDeps): ChatOrchestrator => stubOrchestrator,
    );
    const { compose } = await importComposerWithMocks({
      createChatOrchestrator: createChatOrchestratorMock,
    });

    compose(buildDeps());

    const orchestratorDeps = createChatOrchestratorMock.mock.calls[0]?.[0];
    const sig = orchestratorDeps?.selfSignature as RecuedServerSignature;
    expect(sig.server_kind).toBe('recued');
    expect(sig.instance_id).toBe('server-test');
  });
});
