/** D-320 audit — both escalation families read the contract overlay the server composes.
 *
 *  `d-192-read-tools` and `d-192-crm-escalation-admission` hand the overlay in, so they
 *  would pass with nothing wired. This composes the real chat wire
 *  (`composeChatOrchestrator`) and reads back the deps it gives the chat tools: the
 *  overlay is the execute deps' own, late-bound beside the op gate, and the work-entity
 *  read tools are handed the same one. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebChatTab } from '@recued/contracts';
import type { ChatOrchestrator } from '../chat-orchestrator.js';
import type { ChatToolHandlerDeps } from '../chat-tool-handlers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../chat-orchestrator.js');
  vi.doUnmock('../chat-tool-handlers.js');
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Compose the chat wire with the orchestrator stubbed, and capture the deps it hands
 *  `buildChatToolRegistryInputs`: the chat tools' deps, as production builds them. */
const composeAndCapture = async (executeDeps: Record<string, unknown>) => {
  vi.resetModules();
  const stub: ChatOrchestrator = {
    runTurn: vi.fn(async () => ({ turn_id: 't' })),
    runMessengerTurn: vi.fn(async () => ({ turn_id: 'm' })),
    sessionStore: { append: () => {}, history: () => [] },
    dispatch: { dispatchTool: vi.fn(async () => ({ ok: true as const, result: {} })) },
  };
  vi.doMock('../chat-orchestrator.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('../chat-orchestrator.js')>(),
    createChatOrchestrator: vi.fn(() => stub),
  }));
  const captured: ChatToolHandlerDeps[] = [];
  vi.doMock('../chat-tool-handlers.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../chat-tool-handlers.js')>();
    return {
      ...actual,
      buildChatToolRegistryInputs: (deps: ChatToolHandlerDeps) => {
        captured.push(deps);
        return actual.buildChatToolRegistryInputs(deps);
      },
    };
  });
  const { composeChatOrchestrator } = await import('../composition/bin/wire-chat-orchestrator.js');
  const { workEntityReadToolsDeps } = await import('../chat-tool-handlers.js');
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  composeChatOrchestrator({
    db,
    keys: undefined,
    eventBus: {
      cursor: vi.fn(() => 0),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      emit: vi.fn((event: unknown) => ({ ...(event as Record<string, unknown>), cursor: 1 })),
      replay: vi.fn(() => []),
      subscriberCount: vi.fn(() => 0),
    } as never,
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
    getScheduleDeps: vi.fn(() => undefined),
    getExecuteDeps: vi.fn(() => executeDeps) as never,
  });
  expect(captured).toHaveLength(1);
  return { chat: captured[0]!, workEntity: workEntityReadToolsDeps(captured[0]!) };
};

describe('D-320 audit — the escalations read the composed contract overlay', () => {
  it("hands both families the execute deps' overlay, beside the op gate", async () => {
    const contractOverlay = { admitsConnection: vi.fn(() => false) };
    const opAdmissionGate = { isFrozenByPause: vi.fn(() => false), isOpGranted: vi.fn(() => true) };
    const { chat, workEntity } = await composeAndCapture({ contractOverlay, opAdmissionGate });

    expect(chat.getOpAdmissionGate?.()).toBe(opAdmissionGate);
    expect(chat.getContractOverlay?.()).toBe(contractOverlay);
    expect(workEntity.getOpAdmissionGate?.()).toBe(opAdmissionGate);
    expect(workEntity.getContractOverlay?.()).toBe(contractOverlay);
  });
});
