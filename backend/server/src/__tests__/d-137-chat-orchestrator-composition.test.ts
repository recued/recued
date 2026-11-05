/** D-137 round-2 surgical extraction: chat orchestrator composition. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  ChatCatalogDeliveryMode,
  ChatModelSourceId,
  RecuedServerSignature,
  ValidatedConnectionMcpAnnotationInput,
  WebChatTab,
} from '@recued/contracts';
import { CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE, OWNER_CONTRACT_ID } from '@recued/contracts';
import { TOOLS_SEARCH_TOOL_NAME } from '../chat-tools-search-name.js';
import { handleSend } from '../chat-handler.js';
import {
  RECALL_REJECTED_NOTE,
  RECALL_SEARCH_TOOL_NAME,
  registerRecallTurnSource,
  type RecallSearchResult,
} from '../chat-recall-search-tool.js';
import { renderToolRow } from '../chat-tool-row.js';
import { noteWaitingInTurn } from '../chat-carries-on.js';
import type { MemoryRedactionRecord } from '../memory-rpc-handler.js';
import { createUserMemoryStore, type UserMemoryRow } from '../user-memory-store.js';
import { createHeldResultTurnStore, createHeldRunWatchStore } from '../storage/chat-held-result-store.js';
import type { BlobStore } from '../storage/blob-store.js';
import { isMcpWireRegistryTool } from '../mcp-server.js';
import { createInMemoryCollection, type AuditLogStore } from '@recued/storage';
import type { EventBus } from '../events/bus.js';
import type { KeyManager } from '../key-manager.js';
import type {
  ChatOrchestrator,
  ChatOrchestratorDeps,
} from '../chat-orchestrator.js';
import {
  composeChatOrchestrator,
  type ChatOrchestratorBundle,
  type ComposeChatOrchestratorDeps,
} from '../composition/bin/wire-chat-orchestrator.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { createRecipeStore } from '../recipe-store.js';
import { createScheduleStore } from '../schedule-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import type { ServerExecutorConfig } from '../server-executor.js';

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
const originalRecuedVersion = process.env.RECUED_VERSION;

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

const throwingGetter = <T,>(name: string): (() => T) =>
  vi.fn(() => {
    throw new Error(`${name} should not be resolved at compose time`);
  }) as unknown as () => T;

const throwingLateGetters = (): LateGetters => ({
  getContactStore: throwingGetter('getContactStore'),
  getCollectionRegistry: throwingGetter('getCollectionRegistry'),
  getEnrichmentStore: throwingGetter('getEnrichmentStore'),
  getConnectionStore: throwingGetter('getConnectionStore'),
  getExecutorConfig: throwingGetter('getExecutorConfig'),
  getExecuteDeps: throwingGetter('getExecuteDeps'),
  getScheduleDeps: throwingGetter('getScheduleDeps'),
});

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

const composeHarness = (
  overrides: Partial<ComposeChatOrchestratorDeps> = {},
  lateGetters: LateGetters = inertLateGetters(),
): { bundle: ChatOrchestratorBundle; deps: ComposeChatOrchestratorDeps } => {
  const deps = buildDeps(overrides, lateGetters);
  return { deps, bundle: composeChatOrchestrator(deps) };
};

const expectedBundleKeys = [
  'chatStore',
  // D-338 — makes a notification to a linked messenger a notice in that chat. The messenger
  // channels are composed after the chat, so the app context hands it to them.
  'chatNotices',
  'connectionMcpStore',
  'inboundTokenStore',
  'internalRegistry',
  'ownerDocumentSearch',
  'orchestrator',
  'chatDeps',
  // D-214 — retained for plan-cancel and approval-expiry finalization.
  'executionCaseLifecycle',
  // D-214 — deterministic post-write verification evidence producer.
  'executionCaseVerificationRecorder',
  // D-219 slice 9c — boot hand-off for the owner-facing offer. The notification
  // block is composed AFTER the chat substrate, so its owner pushes it in; the
  // ratchet's `not.toBeUndefined()` sweep is what keeps it from riding as an
  // undefined key.
  'publishExecutionCaseOfferNotifier',
  // D-137 — writes the RESULT half of a paired tool call when a held run
  // settles, long after the turn that asked for it ended. This list is a
  // deliberate ratchet on the bundle's surface: a new field is a decision, not
  // a diff to wave through.
  'runSettledSink',
  // D-318 step 5 — others told of the same settled runs: the email door writes
  // the follow-up of a run its turn left waiting for an approval.
  'onRunSettled',
  // D-337 — others told when a continuation's turn ends: the email door sends its
  // answer then, rather than at its next idle look.
  'onHeldResultTurnEnded',
  // D-336 slice O's open item — told once a Tier-1 call is held: a later save of a fact
  // marks the earlier held chat saves of it "Asked again". The execute deps are composed
  // apart from chat, so they reach it late-bound (`AppContext.tier1HeldRef`), as they
  // reach `internalRegistry`.
  'onTier1Held',
  // D-219 — the capture-only argument buffer, surfaced ONLY so the retention
  // pruner can bound it. ⛔ No read path consumes it.
  'executionCaseArgumentStore',
  // D-219 — the source-corpus retention sweep, narrowed to one method so this
  // hand-off cannot compile, rebuild, or delete a root.
  'executionCaseSourcePruner',
  // D-177 rule 5 slice B — per-session forwarded-sender candidate index
  'forwardedSenderIndex',
  // D-315 §4.3 — one model call through the chat's privacy layer, for work
  // held to the chat's standard outside a turn (ruling 30): the mail facts'
  // AI pass and Draft with AI. A ledger of its own per call, never a session's.
  'privateAiCall',
].sort();

const expectedChatDepsKeys = [
  'store',
  'connectionMcpStore',
  // D-228 slice 4 — the picker's visibility predicate. It counted tools the
  // owner had classified in `tool_overrides`; with that store deleted it counts
  // tools reachable as governed pack operations, and the count comes from the
  // composition rather than from the annotation row.
  'connectionMcpCoveredToolCount',
  'orchestrator',
  'broadcast',
  'selfSignature',
  'planApprovalStore',
  'inboundTokenStore',
  // D-327 — which contracts are their key's whole authority. A missing wiring
  // must be a red: without it the key rpcs would accept a checklist, a second
  // key or a chat setting on a key whose agreement never reads them.
  'keyAgreement',
  // D-171 slice 2c — the grant checklist's catalog source (a closure over
  // `internalRegistry.list()`).
  'catalogProvider',
  // D-167 P5 S4 — the session-delete PII alias-ledger purge callback.
  'dropSessionPiiLedger',
  // D-214 — source/privacy deletion cascades through derived case rows.
  'deleteSessionExecutionCases',
  'executionCaseFeedbackRecorder',
  'executionCaseDiagnostics',
  'executionCaseLifecycle',
  'executionSpanAnchorStore',
  // D-219 item 2/2b — the owner's own view of what became precedent: list it,
  // unlearn one case, and draft a recipe from one with their own model.
  'executionCaseLearned',
  'executionCaseForget',
  'executionCaseDraftRecipe',
  // D-219 — records that a drafted recipe was saved, so the Learning list can
  // say "you already made one of these".
  'executionCaseAuthored',
  // D-221 §3.3.3 — granting a Tier-2 recipe tool is an act of NON-OWNER
  // exposure, so the grant boundary re-runs the Records first-step refusal
  // check before the token is minted.
  'preflightExternalToolGrant',
  // Standing closure (MCP arm) — turns the owner's issuance-screen tick into a
  // bounded op list, using the SAME capability derivation the reception door
  // bind runs. Listed here because a missing wiring must be a red: without it
  // `chat.inbound_token.issue` REFUSES a standing_closure request rather than
  // minting a token whose promise nothing computed.
  'deriveGrantedToolClosure',
  // ALWAYS-CONTRACTED — issuance mints the carrier every token binds to, and
  // REFUSES if this is unwired rather than falling back to an unbound token.
  'mintTokenContract',
  // Best-effort orphan cleanup: the carrier is minted BEFORE the token, so a
  // failed issuance would otherwise leave a live contract bound to nothing.
  'revokeTokenContract',
  // Which sessions are running a turn. Listed here because a missing wiring
  // has to be a RED rather than a quiet degradation: `chat.sessions.list`
  // reports `busy_session_ids` only when this is present, and a client reads
  // the field's ABSENCE as "this server cannot tell me", falling back to
  // inferring liveness from its own sends. That fallback is invisible — the
  // list still returns, every session still opens — so nothing else in the
  // suite would notice the registry had quietly stopped being passed.
  'sessionBusy',
].sort();

/** ⚠ D-228 slice 6 — the `tool` / `classification` parameters are GONE, and
 *  they had already stopped meaning anything at slice 4: nothing downstream read
 *  a tool name or a classification off an annotation. Keeping them would have
 *  left every call site reading as though it configured something. */
const annotationValue = (
  connection_name: string,
): ValidatedConnectionMcpAnnotationInput => ({
  connection_name,
  topic_tags: ['search'],
});

const createAuditLog = (): AuditLogStore =>
  ({
    logActivity: vi.fn(async () => undefined),
  }) as unknown as AuditLogStore;

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../chat-orchestrator.js');
  vi.doUnmock('../storage/chat-store.js');
  vi.doUnmock('@recued/middleware-recued');
  if (originalRecuedVersion === undefined) {
    delete process.env.RECUED_VERSION;
  } else {
    process.env.RECUED_VERSION = originalRecuedVersion;
  }
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('composeChatOrchestrator', () => {
  it('D-265 admits and mirrors through the actual boot-composed queue and Chat store', async () => {
    const { bundle } = composeHarness(); const bridge = bundle.orchestrator.messengerBridge!;
    cleanups.push(() => bundle.orchestrator.turnQueue!.close());
    const bound = bridge.bind('slack', 'C265', 'slack:T265:B265'); const sent: string[] = [];
    bridge.register('slack', { resolve: async () => ({ token: 'fixture', recipient: 'C265', account: 'slack:T265:B265' }),
      send: async message => { sent.push(message.text); return { ok: true, vendor_message_id: 'receipt' }; },
    });
    const ack = await handleSend(bundle.chatDeps, { session_id: bound.session_id, message: 'boot composition',
      submission_id: 'boot-send', picker_state: { current: 'self' } });
    expect(ack.disposition).toBe('accepted');
    await vi.waitFor(async () => expect((await bundle.orchestrator.turnQueue!.snapshot(bound.session_id)).turns[0]?.status).toBe('completed'));
    await vi.waitFor(async () => expect((await bridge.snapshot(bound.session_id)).pending_count).toBe(0), { timeout: 5000 });
    const messages = await bundle.chatStore.listMessages(bound.session_id);
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(messages[1]!.content).toContain('No AI model is available');
    expect(sent).toEqual(['Owner (via webclient)\nboot composition', messages[1]!.content]);
  });

  it('returns exactly the expected bundle fields with usable store and orchestrator shapes', () => {
    const { bundle } = composeHarness();

    expect(Object.keys(bundle).sort()).toEqual(expectedBundleKeys);
    for (const value of Object.values(bundle)) {
      expect(value).not.toBeUndefined();
    }
    expect(bundle.chatStore).toEqual(expect.objectContaining({
      createSession: expect.any(Function),
      getSession: expect.any(Function),
      listSessions: expect.any(Function),
      appendMessage: expect.any(Function),
      listMessages: expect.any(Function),
      deleteSession: expect.any(Function),
    }));
    expect(bundle.connectionMcpStore).toEqual(expect.objectContaining({
      getAnnotation: expect.any(Function),
      setAnnotation: expect.any(Function),
      listAnnotations: expect.any(Function),
      deleteAnnotation: expect.any(Function),
    }));
    expect(bundle.inboundTokenStore).toEqual(expect.objectContaining({
      issueToken: expect.any(Function),
      getTokenById: expect.any(Function),
      listTokens: expect.any(Function),
      verifyBearer: expect.any(Function),
    }));
    expect(bundle.internalRegistry).toEqual(expect.objectContaining({
      list: expect.any(Function),
      listByTier: expect.any(Function),
      getByName: expect.any(Function),
      dispatch: expect.any(Function),
      subscribeRefresh: expect.any(Function),
    }));
    expect(bundle.orchestrator).toEqual(expect.objectContaining({
      runTurn: expect.any(Function),
      turnQueue: expect.objectContaining({ submit: expect.any(Function) }),
      messengerBridge: expect.objectContaining({ snapshot: expect.any(Function), bind: expect.any(Function) }),
      dispatch: expect.objectContaining({
        dispatchTool: expect.any(Function),
      }),
    }));
    expect(bundle.executionCaseVerificationRecorder).toEqual(expect.objectContaining({
      record: expect.any(Function),
    }));
    expect(bundle.privateAiCall).toEqual(expect.any(Function));
  });

  it('injects recall.search only into the cooperative chat registry, never the raw MCP or grant catalog', async () => {
    const { compose, createChatOrchestratorMock } =
      await importComposerWithOrchestratorSpy();
    const bundle = compose(buildDeps());
    const orchestratorDeps = createChatOrchestratorMock.mock.calls[0]![0] as {
      registry: ChatOrchestratorDeps['registry'];
    };

    expect(orchestratorDeps.registry.getByName(RECALL_SEARCH_TOOL_NAME)).toMatchObject({
      name: RECALL_SEARCH_TOOL_NAME,
      tier: 1,
      classification: 'read',
      concurrency_safe: false,
    });
    expect(bundle.internalRegistry.getByName(RECALL_SEARCH_TOOL_NAME)).toBeNull();
    expect(bundle.internalRegistry.list().map((entry) => entry.name)).not.toContain(
      RECALL_SEARCH_TOOL_NAME,
    );
    expect(
      bundle.chatDeps.catalogProvider?.().map((entry) => entry.name) ?? [],
    ).not.toContain(RECALL_SEARCH_TOOL_NAME);
  });

  it('keeps chat\'s recipe.stop in the registry and out of the door grant catalog', async () => {
    // On the MCP wire the stop is the protocol utility `recued_stopRecipe`, so a
    // door is never offered a grant for chat's twin of it.
    const { compose } = await importComposerWithOrchestratorSpy();
    const bundle = compose(buildDeps());
    expect(bundle.internalRegistry.getByName('recipe.stop')).toMatchObject({ name: 'recipe.stop', tier: 1 });
    expect(
      bundle.chatDeps.catalogProvider?.().map((entry) => entry.name) ?? [],
    ).not.toContain('recipe.stop');
  });

  it('D-318 step 5 — tells each listener of a settled run, with chat’s own sink, until it stops', async () => {
    const { bundle } = composeHarness();
    const heard: string[] = [];
    const stop = bundle.onRunSettled((settled) => { heard.push(settled.run_id); });
    // A listener that throws keeps neither chat's sink nor another listener from it.
    bundle.onRunSettled(() => { throw new Error('listener failed'); });
    const settled = {
      execution_source: { channel: 'messenger', actor: 'user_self', vendor: 'email', from: 'me@owner.example' },
      run_id: 'run-1', tool_name: 'recipe.run', result: { success: true }, ts: 1,
    };
    await bundle.runSettledSink(settled);
    expect(heard).toEqual(['run-1']);
    stop();
    await bundle.runSettledSink({ ...settled, run_id: 'run-2' });
    expect(heard).toEqual(['run-1']);
  });

  it('D-337 — a run whose email chat carries on is recorded as continued before any listener hears it settled', async () => {
    // The email door is a listener: it writes its fixed follow-up for a settled run unless the
    // run continued, so the chat must decide first or the owner gets both.
    const db = makeDb();
    const { bundle } = composeHarness({ db });
    try {
      const session = 'mail:recued-chat:c1';
      bundle.chatStore.createSession({ id: session, now: 1 });
      createHeldRunWatchStore(db).watch({
        run_id: 'run-mail', session_id: session, turn_id: 'turn-asked', tool_name: 'recipe.run', called_at: 1,
      });
      const continued = createHeldResultTurnStore(db);
      const seen: boolean[] = [];
      bundle.onRunSettled((settled) => { seen.push(continued.continued(settled.run_id)); });
      await bundle.runSettledSink({
        execution_source: { channel: 'messenger', actor: 'user_self', vendor: 'email', from: 'me@owner.example' },
        run_id: 'run-mail', tool_name: 'recipe.run', result: { success: true }, state: 'succeeded', ts: 2,
      });
      expect(seen).toEqual([true]);
    } finally {
      bundle.orchestrator.turnQueue?.close();
    }
  });

  it('D-337 — tells each listener when a continuation\'s turn ends, as which chat, until it stops', async () => {
    const db = makeDb();
    const { bundle } = composeHarness({ db });
    try {
      const session = 'mail:recued-chat:c2';
      bundle.chatStore.createSession({ id: session, now: 1 });
      createHeldRunWatchStore(db).watch({
        run_id: 'run-mail', session_id: session, turn_id: 'turn-asked', tool_name: 'recipe.run', called_at: 1,
      });
      const ended: unknown[] = [];
      const stop = bundle.onHeldResultTurnEnded((turn) => { ended.push(turn); });
      // A listener that throws keeps neither the turn nor another listener from it.
      bundle.onHeldResultTurnEnded(() => { throw new Error('listener failed'); });
      const email = { channel: 'messenger', actor: 'user_self', vendor: 'email', from: 'me@owner.example' } as const;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await bundle.runSettledSink({
          execution_source: email, run_id: 'run-mail', tool_name: 'recipe.run', result: { success: true }, state: 'succeeded', ts: 2,
        });
        await vi.waitFor(() => expect(ended).toEqual([{ session_id: session, source: email }]), { timeout: 15_000, interval: 20 });
      } finally {
        errors.mockRestore();
      }
      // No model is composed here, so the turn stored a failure: nothing was told.
      expect(createHeldResultTurnStore(db).delivered(session).size).toBe(0);
      stop();
    } finally {
      bundle.orchestrator.turnQueue?.close();
    }
  }, 30_000);

  it('creates every chat SQLite table when composed against an empty in-memory db', () => {
    const db = makeDb();
    composeHarness({ db });

    const rows = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN (
           'chat_sessions',
           'chat_messages',
           'chat_tool_catalog_scope',
           'chat_connection_mcp_annotations',
           'chat_inbound_tokens',
           'chat_held_run_watches',
           'chat_held_result_turns'
         )
       ORDER BY name`,
    ).all() as Array<{ name: string }>;

    // ⛔ `chat_tool_catalog_scope` stays IN the query and OUT of the answer:
    // the per-kind chat scope is retired (D-137 W2.2, 2026-10-04), so a fresh
    // install no longer creates its table. An older install keeps its row,
    // which nothing reads.
    // D-337 — a run held in a messenger or email chat, and each continuation queued: the email
    // door's trigger owes a continuation's answer through the second.
    expect(rows.map((row) => row.name)).toEqual([
      'chat_connection_mcp_annotations',
      'chat_held_result_turns',
      'chat_held_run_watches',
      'chat_inbound_tokens',
      'chat_messages',
      'chat_sessions',
    ]);
  });

  it('does not invoke late-bound downstream getters at compose time', () => {
    const getters = throwingLateGetters();

    expect(() => composeHarness({}, getters)).not.toThrow();
    for (const getter of Object.values(getters)) {
      expect(getter).not.toHaveBeenCalled();
    }
  });

  it('omits cognitionStore from chatDeps entirely after D-164 P6a-2 (handler-side retirement)', async () => {
    const { compose, createChatOrchestratorMock } =
      await importComposerWithOrchestratorSpy();

    const bundle = compose(buildDeps());
    const orchestratorDeps = createChatOrchestratorMock.mock.calls[0]![0] as {
      cognitionStore?: unknown;
    };

    // D-164 P6a-2 — chatDeps no longer carries `cognitionStore`. The
    // orchestrator-side property was retired in P6a-1. The cognition
    // middleware slot itself retires in D-164 P6d.
    expect('cognitionStore' in bundle.chatDeps).toBe(false);
    expect(orchestratorDeps.cognitionStore).toBeUndefined();
  });

  it('D-164 P6a-2 keeps first-party middleware boot registration without cognition store wiring', async () => {
    const source = readFileSync(
      new URL('../composition/bin/wire-chat-orchestrator.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('createInMemoryCognitionStore');
    expect(source).not.toContain('cognitionStoreShared');

    vi.resetModules();
    const registerFirstPartyMiddlewaresMock = vi.fn();
    vi.doMock('@recued/middleware-recued', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@recued/middleware-recued')>();
      return {
        ...actual,
        registerFirstPartyMiddlewares: registerFirstPartyMiddlewaresMock,
      };
    });
    const mod = await import('../composition/bin/wire-chat-orchestrator.js');

    mod.composeChatOrchestrator(buildDeps());

    expect(registerFirstPartyMiddlewaresMock).toHaveBeenCalledTimes(1);
    expect(registerFirstPartyMiddlewaresMock).toHaveBeenCalledWith(
      expect.objectContaining({
        register: expect.any(Function),
        isEnabled: expect.any(Function),
      }),
    );
  });

  it('uses one shared plan approval store for orchestrator gating and chatDeps resolution', async () => {
    // ⚠ RE-VEHICLED, NOT WEAKENED. This used to dispatch a Tier-3
    // `<connection>.<tool>` name and infer sharing from a pending row appearing
    // in `chatDeps.planApprovalStore`. D-228 slice 4 retired Tier-3, so that
    // vehicle now resolves `unknown_tool` — and re-vehicling it onto another
    // approval-raising tool would keep the claim indirect.
    //
    // 🔑 The claim was always about IDENTITY: the store the orchestrator gates
    // on must be the same OBJECT the rpc deps resolve. Asserting that directly
    // is stronger than observing one row through it, and it cannot be satisfied
    // by two stores that merely behave alike.
    const { compose, createChatOrchestratorMock } =
      await importComposerWithOrchestratorSpy();
    const bundle = compose(buildDeps());

    const orchestratorDeps = createChatOrchestratorMock.mock.calls[0]?.[0];
    expect(orchestratorDeps).toBeDefined();
    expect(bundle.chatDeps.planApprovalStore).toBeDefined();
    expect(orchestratorDeps!.planApprovalStore).toBe(bundle.chatDeps.planApprovalStore);
  });

  it('uses the dbless plaintext chat-store fallback when keys is undefined', async () => {
    const { bundle } = composeHarness({ keys: undefined });
    const signature = bundle.chatDeps.selfSignature;
    bundle.chatStore.createSession({ id: 'sess-plain', now: 1 });

    await expect(bundle.chatStore.appendMessage({
      id: 'msg-plain',
      session_id: 'sess-plain',
      role: 'user',
      content: 'plaintext fallback',
      target_server: 'self',
      picker_at_send: { display_name: 'Self', signature },
      model_used: { provider: 'local', model_id: 'local' },
      ts: 2,
    })).resolves.toEqual(expect.objectContaining({
      content: 'plaintext fallback',
    }));
    await expect(bundle.chatStore.listMessages('sess-plain')).resolves.toEqual([
      expect.objectContaining({ content: 'plaintext fallback' }),
    ]);
  });

  it('requests the chat sub-DEK provider exactly once when KeyManager is present', () => {
    const provider = vi.fn(() => null);
    const keyProvider = vi.fn(() => provider);
    const keys = { keyProvider } as unknown as KeyManager;

    composeHarness({ keys });

    expect(keyProvider).toHaveBeenCalledTimes(1);
    expect(keyProvider).toHaveBeenCalledWith('chat');
    expect(provider).not.toHaveBeenCalled();
  });

  it('passes undefined as the chat key provider when KeyManager is absent', async () => {
    vi.resetModules();
    const createChatStoreMock = vi.fn();
    vi.doMock('../storage/chat-store.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../storage/chat-store.js')>();
      createChatStoreMock.mockImplementation(actual.createChatStore);
      return {
        ...actual,
        createChatStore: createChatStoreMock,
      };
    });
    const mod = await import('../composition/bin/wire-chat-orchestrator.js');

    mod.composeChatOrchestrator(buildDeps({ keys: undefined }));

    expect(createChatStoreMock).toHaveBeenCalledTimes(1);
    expect(createChatStoreMock.mock.calls[0]![1]).toBeUndefined();
  });

  it('captures RECUED_VERSION in selfSignature when the env var is set', () => {
    process.env.RECUED_VERSION = 'test-1.2.3';

    const { bundle } = composeHarness({ serverInstanceId: 'server-versioned' });

    expect(bundle.chatDeps.selfSignature).toEqual({
      server_kind: 'recued',
      version: 'test-1.2.3',
      instance_id: 'server-versioned',
    } satisfies RecuedServerSignature);
  });

  it('uses 0.0.0 in selfSignature when RECUED_VERSION is absent', () => {
    delete process.env.RECUED_VERSION;

    const { bundle } = composeHarness({ serverInstanceId: 'server-default' });

    expect(bundle.chatDeps.selfSignature).toEqual({
      server_kind: 'recued',
      version: '0.0.0',
      instance_id: 'server-default',
    } satisfies RecuedServerSignature);
  });

  it('completes the turn through the executor failure path when llmConfig is undefined', async () => {
    // D-164 P6.3 — the chat orchestrator dispatches the main turn
    // via the injected `executeAiCall` closure. When `llmConfig` is
    // undefined the closure rejects with `LLMError('AI_LLM_UNAVAILABLE')`;
    // the orchestrator surfaces this as an `engine.budget_exceeded`
    // transparency event + an empty-assistant `chat.message_complete`
    // (substrate stays reachable).
    const bus = eventBus();
    const { bundle } = composeHarness({ eventBus: bus, llmConfig: undefined });
    bundle.chatStore.createSession({ id: 'sess-llm', now: 1 });

    await expect(bundle.orchestrator.runTurn({
      session_id: 'sess-llm',
      message: 'Can you summarize the latest context?',
      picker_state: { current: 'self' },
    })).resolves.toEqual(expect.objectContaining({
      turn_id: expect.any(String),
    }));

    const events = bus.emit.mock.calls.map(([event]) => event as {
      kind: string;
      event?: { kind: string; reason?: string };
    });
    expect(events.some((event) =>
      event.kind === 'chat.transparency'
      && event.event?.kind === 'engine.budget_exceeded',
    )).toBe(true);
    expect(events.some((event) => event.kind === 'chat.message_complete')).toBe(true);
  });

  it('lets raw MCP annotations pass through when the connection store is not wired yet', async () => {
    // ⚠ The Tier-3 CATALOG half of this test is gone with the tier (slice 4).
    // What survives is the half that still means something: with no connection
    // store to check against, the annotationProvider must not filter — a peer
    // row is passed through rather than dropped for failing a lookup that
    // cannot run.
    const { compose, createChatOrchestratorMock } =
      await importComposerWithOrchestratorSpy();
    const bundle = compose(buildDeps({ getConnectionStore: vi.fn(() => undefined) }));
    bundle.connectionMcpStore.setAnnotation({
      value: annotationValue('ghost'),
      now: 20,
    });
    bundle.connectionMcpStore.setAnnotation({
      value: annotationValue('live'),
      now: 10,
    });
    const orchestratorDeps = createChatOrchestratorMock.mock.calls[0]![0] as {
      annotationProvider: () => ReadonlyArray<{ connection_name: string }>;
    };

    expect(orchestratorDeps.annotationProvider().map((a) => a.connection_name).sort())
      .toEqual(['ghost', 'live']);
  });

  it('filters annotationProvider rows whose MCP connection no longer resolves', async () => {
    const get = vi.fn((_kind: string, name: string) =>
      name === 'live' ? { name } : null,
    );
    const { compose, createChatOrchestratorMock } =
      await importComposerWithOrchestratorSpy();
    const bundle = compose(buildDeps({
      getConnectionStore: vi.fn(() => ({ get }) as never),
    }));
    bundle.connectionMcpStore.setAnnotation({
      value: annotationValue('ghost'),
      now: 20,
    });
    bundle.connectionMcpStore.setAnnotation({
      value: annotationValue('live'),
      now: 10,
    });
    const orchestratorDeps = createChatOrchestratorMock.mock.calls[0]![0] as {
      annotationProvider: () => ReadonlyArray<{ connection_name: string }>;
    };

    // ⛔ D-228 slice 4 — the tier-3 catalog assertion is gone with the tier; the
    // registry projects none. The FILTER this test is named for is the
    // annotationProvider one, and it survives.
    expect(bundle.internalRegistry.listByTier(3)).toEqual([]);
    expect(orchestratorDeps.annotationProvider().map((ann) => ann.connection_name)).toEqual([
      'live',
    ]);
    expect(get).toHaveBeenCalledWith('mcp', 'ghost');
    expect(get).toHaveBeenCalledWith('mcp', 'live');
    // D-171 slice 2c — the grant catalog never offered Tier-3 passthroughs
    // (they are rejected on the inbound MCP wire, so a toggle would save a
    // no-op). ⚠ Still asserted after slice 4, and it is not vacuous: it now
    // holds because nothing PRODUCES tier 3, and this is where that would be
    // noticed if a producer came back.
    const grantCatalog = bundle.chatDeps.catalogProvider?.() ?? [];
    expect(grantCatalog.every((e) => e.tier !== 3)).toBe(true);
    expect(grantCatalog).toEqual(
      bundle.internalRegistry.list().filter(isMcpWireRegistryTool),
    );
  });

  it('catalogProvider appends the legacy recued_* + recued_ingredient_* surface when the executor config is wired (D-171 slice-2c follow-on #1)', () => {
    const manifests = createManifestRegistry('/nonexistent');
    manifests.register({
      slug: 'fetch-thing',
      name: 'Fetch Thing',
      description: 'HTTP ingredient fixture.',
      author: 'recued-core',
      kind: 'http',
      version: 1,
      category: 'data',
      risk_tier: 'read',
      tags: [],
      input: { url: 'https://example.com', method: 'GET' },
      output: { body: 'body' },
    });
    const lateGetters: LateGetters = {
      ...inertLateGetters(),
      getExecutorConfig: () =>
        ({ manifests } as unknown as ServerExecutorConfig),
    };
    const { bundle } = composeHarness({}, lateGetters);

    const catalog = bundle.chatDeps.catalogProvider?.() ?? [];
    const names = new Set(catalog.map((e) => e.name));
    // The legacy meta tools + the per-ingredient tool are now grantable.
    expect(names.has('recued_runRecipe')).toBe(true);
    expect(names.has('recued_dataTimeline')).toBe(true);
    expect(names.has('recued_ingredient_fetch-thing')).toBe(true);
    // The registry-filter invariant still holds (no Tier 3 leaks through).
    expect(catalog.every((e) => e.tier !== 3)).toBe(true);
    // Additive: a strict superset of the registry-only view.
    const registryOnly = bundle.internalRegistry
      .list()
      .filter(isMcpWireRegistryTool);
    for (const e of registryOnly) expect(names.has(e.name)).toBe(true);
    expect(catalog.length).toBeGreaterThan(registryOnly.length);
  });

  it('builds chatDeps with exact field parity and no auditLog key when auditLog is absent', () => {
    const bus = eventBus();
    const { bundle } = composeHarness({ eventBus: bus, auditLog: undefined });

    expect(Object.keys(bundle.chatDeps).sort()).toEqual(expectedChatDepsKeys);
    expect(bundle.chatDeps.store).toBe(bundle.chatStore);
    expect(bundle.chatDeps.connectionMcpStore).toBe(bundle.connectionMcpStore);
    expect(bundle.chatDeps.orchestrator).toBe(bundle.orchestrator);
    expect(bundle.chatDeps.planApprovalStore).toBeDefined();
    expect(bundle.chatDeps.inboundTokenStore).toBe(bundle.inboundTokenStore);
    // D-171 slice 2c — the catalog provider reads the live internal registry
    // but EXCLUDES Tier 3 (peer-MCP passthroughs are rejected on the inbound
    // MCP wire, so they're not grantable). This harness seeds no connection
    // annotations, so the registry has no Tier 3 today; the load-bearing
    // exclusion is pinned in the Tier-3 filter test below (which does).
    const provided = bundle.chatDeps.catalogProvider?.() ?? [];
    expect(provided.every((e) => e.tier !== 3)).toBe(true);
    expect(provided).toEqual(
      bundle.internalRegistry.list().filter(isMcpWireRegistryTool),
    );
    expect(bundle.chatDeps).not.toHaveProperty('auditLog');

    bundle.chatDeps.broadcast?.emit({
      kind: 'chat.message_complete',
      session_id: 'sess-broadcast',
      turn_id: 'turn-broadcast',
      final: { id: 'msg-broadcast' },
    } as never);
    expect(bus.emit).toHaveBeenCalledWith({
      kind: 'chat.message_complete',
      session_id: 'sess-broadcast',
      turn_id: 'turn-broadcast',
      final: { id: 'msg-broadcast' },
    });
  });

  it('includes auditLog in chatDeps only when auditLog is provided', () => {
    const auditLog = createAuditLog();

    const { bundle } = composeHarness({ auditLog });

    expect(Object.keys(bundle.chatDeps).sort()).toEqual([
      ...expectedChatDepsKeys,
      'auditLog',
    ].sort());
    expect(bundle.chatDeps.auditLog).toBe(auditLog);
  });

  it('threads the durable callback mailbox into every token authority mutation', async () => {
    const sharedStore = {
      list: vi.fn(async () => []),
      read: vi.fn(async () => null),
      compareAndSet: vi.fn(),
    };
    const { bundle } = composeHarness({ sharedStore });
    const issued = bundle.inboundTokenStore.issueToken({
      value: {
        label: 'callback lifecycle',
        grants: { 'recued-core/query': true },
        concurrency_tier: 3,
        chat_mode: null,
        contract_id: 'ct_callbacks',
      },
      now: 1,
    });
    bundle.inboundTokenStore.revokeToken({
      token_id: issued.record.token_id,
      now: 2,
    });
    await bundle.inboundTokenStore.drainAuthorityChanges();

    expect(Object.keys(bundle.chatDeps).sort()).toEqual(expectedChatDepsKeys);
    expect(sharedStore.list).toHaveBeenCalledWith(
      `mcp.recipe-callback.${issued.record.token_id}`,
    );
  });

  it('wires owner-only D-214 aggregate diagnostics without raw rows', async () => {
    const { bundle } = composeHarness();
    const diagnostics = await bundle.chatDeps.executionCaseDiagnostics?.() as {
      active_experiment: boolean;
      compiler: {
        materialized_cases: number;
        request_shape_source_reports: {
          grounded_dissection: number;
          ungrounded_dissection_fallback: number;
          missing_dissection_fallback: number;
        };
      };
    };
    expect(diagnostics).toMatchObject({
      active_experiment: false,
      compiler: {
        materialized_cases: 0,
        request_shape_source_reports: {
          grounded_dissection: 0,
          ungrounded_dissection_fallback: 0,
          missing_dissection_fallback: 0,
        },
      },
    });
    expect(JSON.stringify(diagnostics)).not.toContain('root_request');
    expect(JSON.stringify(diagnostics)).not.toContain('payload_encrypted');
  });

  it('activates composed D-214 augmentation for a real owner-chat turn', async () => {
    const experimentEnv: Record<string, string> = {
      RECUED_D214_EXPERIMENT_ID: 'composed-augmentation',
      RECUED_D214_EXPERIMENT_SURFACE: 'request_augmentation',
      RECUED_D214_EXPERIMENT_START_MS: '0',
      RECUED_D214_EXPERIMENT_END_MS: '9999999999999',
      RECUED_D214_EXPERIMENT_MAX_ROOTS: '10',
      RECUED_D214_EXPERIMENT_MAX_CRITIQUES_PER_ROOT: '1',
      RECUED_D214_EXPERIMENT_MAX_EVIDENCE: '3',
      RECUED_D214_EXPERIMENT_MIN_RELEVANCE_SCORE: '1',
      RECUED_D214_EXPERIMENT_ELIGIBLE_POPULATION:
        'in-scope rooted turns reaching request augmentation',
      RECUED_D214_EXPERIMENT_DECISION_RULE: 'composition activation test',
      RECUED_D214_EXPERIMENT_PLANNER_FINGERPRINT: 'planner-test',
      RECUED_D214_EXPERIMENT_PROMPT_FINGERPRINT: 'prompt-test',
      RECUED_D214_EXPERIMENT_RETRIEVAL_FINGERPRINT: 'retrieval-test',
      RECUED_D214_EXPERIMENT_POLICY_FINGERPRINT: 'policy-test',
      RECUED_D214_EXPERIMENT_PRIMARY_AXES: 'verified_success',
      RECUED_D214_EXPERIMENT_MATERIAL_HARM_BOUNDS:
        '{"execution_failure":0}',
      RECUED_D214_EXPERIMENT_SECRET: 'composition-secret',
    };
    const prior = new Map(
      Object.keys(experimentEnv).map((key) => [key, process.env[key]]),
    );
    for (const [key, value] of Object.entries(experimentEnv)) {
      process.env[key] = value;
    }
    cleanups.push(() => {
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const db = makeDb();
    const { bundle } = composeHarness({
      db,
      llmConfig: undefined,
    });
    bundle.chatStore.createSession({ id: 'd214-live-session', now: 1 });

    await bundle.orchestrator.runTurn({
      session_id: 'd214-live-session',
      message: 'Summarize the latest context',
      picker_state: { current: 'self' },
    });

    const intervention = db.prepare(`
      SELECT experiment_id, governing_contract_id, principal_key, surface
        FROM case_interventions
    `).get() as {
      experiment_id: string;
      governing_contract_id: string;
      principal_key: string;
      surface: string;
    } | undefined;
    expect(intervention).toEqual({
      experiment_id: 'composed-augmentation',
      governing_contract_id: 'user_self',
      principal_key: 'user_self',
      surface: 'request_augmentation',
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM execution_span_anchors
       WHERE session_id = 'd214-live-session'
    `).get()).toEqual({ count: 1 });
  });

  it('D-329 — each turn reads where approval requests go now, from the execution deps published after it', async () => {
    let published: { approvalChannelsNow?: () => Promise<readonly string[]> } | undefined;
    const { compose, createChatOrchestratorMock } = await importComposerWithOrchestratorSpy();
    compose(buildDeps({}, { ...inertLateGetters(), getExecuteDeps: vi.fn(() => published) as never }));
    const deps = createChatOrchestratorMock.mock.calls.at(-1)![0] as unknown as {
      approvalChannels: () => Promise<readonly string[]>;
    };
    // Before the notification block exists: the app alone, so the bell.
    await expect(deps.approvalChannels()).resolves.toEqual([]);
    published = { approvalChannelsNow: async () => ['ui', 'telegram'] };
    await expect(deps.approvalChannels()).resolves.toEqual(['ui', 'telegram']);
  });

  it('D-337 — the composed chat does not list again a call a continuation told the model of', async () => {
    const db = makeDb();
    const { compose, createChatOrchestratorMock } = await importComposerWithOrchestratorSpy();
    const bundle = compose(buildDeps({ db }));
    const deps = createChatOrchestratorMock.mock.calls.at(-1)![0] as unknown as {
      buildInFlightContext: (source: unknown, telling?: ReadonlySet<string>) => string | undefined;
      carriedHeldResults: (session_id: string) => Promise<unknown>;
    };
    const source = { channel: 'chat', actor: 'user_self', chat_session_id: 'sess-waited', user_id: 'local' } as const;
    bundle.chatStore.createSession({ id: 'sess-waited', now: 1 });
    for (const run of ['run-told', 'run-untold']) {
      await bundle.chatStore.toolCalls!.start({
        id: `call-${run}`, session_id: 'sess-waited', turn_id: 'turn-asked', role: 'tool', tool_name: 'recipe.run',
        content: 'recipe.run({})', target_server: 'self',
        picker_at_send: { display_name: 'self', signature: { server_kind: 'recued', version: '1', instance_id: 'i' } },
        model_used: { provider: 'recued', model_id: 'tool-call' }, execution_source: source, ts: 1,
      });
      bundle.chatStore.toolCalls!.bind(`call-${run}`, run);
      bundle.chatStore.toolCalls!.hold(`call-${run}`);
    }
    const turns = createHeldResultTurnStore(db);
    turns.record({ turn_id: 'continuation-1', session_id: 'sess-waited', run_id: 'run-told', origin_turn_id: 'turn-asked' });
    turns.answered('continuation-1');
    const told = deps.buildInFlightContext(source) ?? '';
    expect(told).toContain('run=run-untold');
    expect(told).not.toContain('run=run-told');
    // §7.10 — nor one the turn carries: it is in front of the model, with its outcome.
    expect(deps.buildInFlightContext(source, new Set(['run-untold']))).toBeUndefined();
    // With no queue to read a call from (this composition stubs the orchestrator), nothing is carried.
    await expect(deps.carriedHeldResults('sess-waited')).resolves.toBeUndefined();
  });

  it('uses a conditional auditLog spread for orchestrator construction', async () => {
    const { compose, createChatOrchestratorMock } =
      await importComposerWithOrchestratorSpy();

    const absent = compose(buildDeps({ auditLog: undefined }));
    const absentDeps = createChatOrchestratorMock.mock.calls.at(-1)![0] as unknown as Record<
      string,
      unknown
    >;
    expect(absent.chatDeps).not.toHaveProperty('auditLog');
    expect(absentDeps).not.toHaveProperty('auditLog');

    const auditLog = createAuditLog();
    const present = compose(buildDeps({ auditLog }));
    const presentDeps = createChatOrchestratorMock.mock.calls.at(-1)![0] as unknown as Record<
      string,
      unknown
    >;
    expect(present.chatDeps.auditLog).toBe(auditLog);
    expect(presentDeps.auditLog).toBe(auditLog);
  });
});

describe('composeChatOrchestrator — Lever-2 per-slot catalog modes (Phase 2)', () => {
  // The wire reads two catalog env knobs at compose time; clear them so these
  // tests exercise the pure "user per-source setting" path (env-global = full,
  // smart-defaults flag OFF) deterministically regardless of the ambient env.
  const CATALOG_ENV = ['RECUED_CHAT_CATALOG_MODE', 'RECUED_CHAT_CATALOG_SMART_DEFAULTS'] as const;
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of CATALOG_ENV) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    // Deterministic baseline for the per-source-override tests: smart-defaults
    // EXPLICITLY off (`=0`) so an unconfigured source resolves to the env-global
    // (full), isolating the override path. (The wire now DEFAULTS smart-defaults
    // ON when unset — covered by its own test below.)
    process.env.RECUED_CHAT_CATALOG_SMART_DEFAULTS = '0';
  });
  afterEach(() => {
    for (const k of CATALOG_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('enables the tools.search wrapper ALWAYS — dispatchable even under inert config', async () => {
    // THE key Phase-2 wire change. With no catalog_modes, no env mode and the
    // flag off, Phase 1's construction-time enable snapshot would have DISABLED
    // the wrapper — a later live full→index flip on a source would then present
    // a leaned catalog + tools.search guidance while the tool is un-dispatchable.
    // Phase 2 passes the full possible-modes set, so tools.search is always in
    // the chat registry (a full turn still drops it from PRESENTATION per the
    // per-turn projection, tested in the ratchet).
    const { compose, createChatOrchestratorMock } = await importComposerWithOrchestratorSpy();
    compose(buildDeps({ getLlmConfig: () => undefined }));
    const orchestratorDeps = createChatOrchestratorMock.mock.calls.at(-1)![0] as {
      registry: { getByName: (name: string) => unknown };
    };
    expect(orchestratorDeps.registry.getByName(TOOLS_SEARCH_TOOL_NAME)).not.toBeNull();
  });

  it('catalogProjectionForSource reads catalog_modes LIVE from getLlmConfig', async () => {
    const { compose, createChatOrchestratorMock } = await importComposerWithOrchestratorSpy();
    // A MUTABLE live config — the wire must re-read it per call, not snapshot at
    // construction (matches the D-174 R28 per-use config read).
    let modes: Partial<Record<ChatModelSourceId, ChatCatalogDeliveryMode>> | undefined = {
      slot_1: 'index',
    };
    compose(buildDeps({ getLlmConfig: () => ({ catalog_modes: modes }) }));
    const resolve = (createChatOrchestratorMock.mock.calls.at(-1)![0] as {
      catalogProjectionForSource: (
        s: ChatModelSourceId | undefined,
      ) => { mode: ChatCatalogDeliveryMode };
    }).catalogProjectionForSource;

    // slot_1 has an explicit override → index, even with the smart-defaults flag
    // explicitly OFF (=0) and no env-global mode (the exact user-setting path).
    expect(resolve('slot_1')).toEqual({ mode: 'index' });
    // free_pool has no override, flag off (=0), env full → full.
    expect(resolve('free_pool')).toEqual({ mode: 'full' });

    // Flip the live config → the NEXT resolve reflects it without recompose.
    modes = { free_pool: 'lean-core' };
    expect(resolve('free_pool')).toEqual({ mode: 'lean-core' });
    expect(resolve('slot_1')).toEqual({ mode: 'full' });

    // Config cleared entirely → every source falls back to full.
    modes = undefined;
    expect(resolve('slot_1')).toEqual({ mode: 'full' });
    expect(resolve('free_pool')).toEqual({ mode: 'full' });
  });

  it('smart-defaults default ON (flag unset) → every KNOWN source thins', async () => {
    // ⚠ THE MODE IS READ FROM THE MAP, NOT PINNED HERE. This test is about the
    // FLAG — unset means smart-defaults ON, `=0` opts out — and it pinned the
    // literal `index`, so the 2026-08-05 flip to `lean-core` reddened it for a
    // correct change it does not govern. The shipped value has its own named
    // test in `lever-2-index-mode-catalog.test.ts`, which is where changing it
    // should show up.
    //
    // History for the flag itself: free_pool went to `index` on 2026-07-03,
    // the BYOK slots followed on 2026-07-26, and every source moved to
    // `lean-core` on 2026-08-05.
    delete process.env.RECUED_CHAT_CATALOG_SMART_DEFAULTS; // unset → default ON
    const { compose, createChatOrchestratorMock } = await importComposerWithOrchestratorSpy();
    compose(buildDeps({ getLlmConfig: () => undefined }));
    const resolve = (createChatOrchestratorMock.mock.calls.at(-1)![0] as {
      catalogProjectionForSource: (
        s: ChatModelSourceId | undefined,
      ) => { mode: ChatCatalogDeliveryMode };
    }).catalogProjectionForSource;
    for (const source of ['free_pool', 'slot_1', 'slot_2'] as const) {
      expect(resolve(source).mode, source)
        .toBe(CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE[source]);
      // ...and "thins" is the claim in the name: never `full`.
      expect(resolve(source).mode, source).not.toBe('full');
    }
    // An unknown/unpinned source never thins (can't predict the matched slot).
    expect(resolve(undefined)).toEqual({ mode: 'full' });

    // Opt-out (`=0`) restores the pre-flip full-everywhere behavior.
    process.env.RECUED_CHAT_CATALOG_SMART_DEFAULTS = '0';
    compose(buildDeps({ getLlmConfig: () => undefined }));
    const resolveOptOut = (createChatOrchestratorMock.mock.calls.at(-1)![0] as {
      catalogProjectionForSource: (
        s: ChatModelSourceId | undefined,
      ) => { mode: ChatCatalogDeliveryMode };
    }).catalogProjectionForSource;
    expect(resolveOptOut('free_pool')).toEqual({ mode: 'full' });
  });
});

// ⛔ A case that reads a pack from the community catalog goes in
// `chat-installed-pack-actions-composition.test.ts`, not here. The public export
// drops a test file that reaches the catalog WHOLE: the Home Assistant cases took
// every case in this file out of the 26.10.6 public suite.

describe("chat's recipe.schedule reaches the schedule store through the wire (D-193 amendment)", () => {
  // ⛔ Every other `recipe.schedule` test hands the tool its scheduler. This one
  // composes it through the REAL wire, so a composition that stopped passing
  // the schedule deps through fails HERE, instead of the owner's chat saying
  // "scheduling is unavailable" while every handler test stays green.
  const OWNER_SOURCE = { channel: 'chat', actor: 'user_self', chat_session_id: 'cs1', user_id: 'owner' };

  it("the owner's call lands a row in the store the composition was given", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd137-recipe-schedule-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const recipes = createRecipeStore(dir, makeDb());
    recipes.save({
      recipe_id: 'daily-digest',
      version: 1,
      metadata: { name: 'Daily digest', description: 'fixture', author: 'recued-core', tags: [] },
      steps: [],
    } as never, 'recued-core', 'bundled');
    const schedules = createScheduleStore(makeDb());
    const contracts = createContractStore(makeDb(), { now: () => 1 });
    const gate = createOpAdmissionGate({
      grantEntryStore: createContractGrantEntryStore(contracts),
      definitionStore: createContractDefinitionStore(contracts),
      now: () => 1,
    });
    const { compose, createChatOrchestratorMock } = await importComposerWithOrchestratorSpy();
    compose(buildDeps({
      recipeStore: recipes,
      getScheduleDeps: () => ({ store: schedules, instanceId: 'server-test' }) as never,
    }, {
      ...inertLateGetters(),
      getExecuteDeps: vi.fn(() => ({ opAdmissionGate: gate })) as never,
    }));
    const deps = createChatOrchestratorMock.mock.calls.at(-1)![0] as unknown as {
      registry: { dispatch: (name: string, args: unknown, ctx: unknown) => Promise<unknown> };
    };
    const res = await deps.registry.dispatch(
      'recipe.schedule',
      { recipe_id: 'daily-digest', mode: 'recurring', cron_expression: '0 8 * * 1' },
      { channel: 'internal_function_call', session_id: 'cs1', turn_id: 't1', execution_source: OWNER_SOURCE },
    );
    expect(res).toMatchObject({ ok: true, result: { status: 'scheduled', recipe_id: 'recued-core/daily-digest' } });
    expect(schedules.list()).toEqual([
      expect.objectContaining({ recipe_id: 'daily-digest', publisher_id: 'recued-core', cron_expression: '0 8 * * 1' }),
    ]);
  });
});

describe('D-198 §13 — the composed recall says where a saved note stands now', () => {
  it('a recalled memory.write row from this chat says the owner has since deleted its note', async () => {
    const { compose, createChatOrchestratorMock } = await importComposerWithOrchestratorSpy();
    const noBlobs = { root: '/none' } as unknown as BlobStore; // a summary-only note never touches blobs
    const memory = createUserMemoryStore(createInMemoryCollection<UserMemoryRow>(), noBlobs, {});
    const redactions = createInMemoryCollection<MemoryRedactionRecord>();
    // Recall resolves the owner's corpus through the contract view; without one
    // the interaction lane fails closed, so the composed path needs a real store.
    const contracts = createContractStore(makeDb());
    const bundle = compose(buildDeps({
      getUserMemoryStore: () => memory,
      getMemoryRedactionStore: () => redactions,
      getContractStore: () => contracts,
    }));
    const registry = (createChatOrchestratorMock.mock.calls[0]![0] as {
      registry: ChatOrchestratorDeps['registry'];
    }).registry;
    const owner = { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'local' } as const;

    // An agent saved a note in this chat, and its save call is a row of the chat.
    const note = await memory.writeAuthored({
      origin_actor: 'contracted_user', author_contract_id: OWNER_CONTRACT_ID,
      kind: 'chat_memory', summary: 'Dana prefers phone calls',
    });
    bundle.chatStore.createSession({ id: 's1', now: 1_000 });
    await bundle.chatStore.appendMessage({
      id: 'tool-1', session_id: 's1', role: 'tool',
      content: renderToolRow('memory.write', { summary: 'Dana prefers phone calls' }, { memory_id: note.memory_id }),
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' }, execution_source: owner, ts: 2_000, turn_id: 'turn-a',
    } as never);
    // Then the owner deleted the note.
    await redactions.set(note.memory_id, { memory_id: note.memory_id, redacted_at: Date.UTC(2026, 10, 2), deleted: true });

    const turn_state = new Map<string, unknown>();
    registerRecallTurnSource(turn_state, owner);
    const dispatched = await registry.dispatch(
      RECALL_SEARCH_TOOL_NAME,
      { query: 'Dana phone calls', sources: ['interaction'] },
      { channel: 'internal_function_call', session_id: 's1', turn_id: 'turn-b', execution_source: owner, turn_state },
    );
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const row = (dispatched as { result: RecallSearchResult }).result.matches
      .find((m) => m.source === 'interaction' && m.kind === 'tool');
    expect(row, 'the memory.write row is recalled: ' + JSON.stringify((dispatched as { result: unknown }).result)).toBeDefined();
    expect(row?.source === 'interaction' ? row.memory_now : undefined)
      .toEqual([`${note.memory_id}: no longer in memory (removed 2026-11-02).`]);
  });

  /** Measured live first (bench task 404, 2026-10-30): asked the name after the owner
   *  revoked the note, the model called recall.search, not memory.search, and answered
   *  the revoked claim from the user's own earlier "remember that…", because the broker
   *  passed on the memory leg's matches and dropped its rejections. */
  it("a revoked note reaches recall as the owner's rejection, beside the old chat that states it", async () => {
    const { compose, createChatOrchestratorMock } = await importComposerWithOrchestratorSpy();
    const noBlobs = { root: '/none' } as unknown as BlobStore;
    const memory = createUserMemoryStore(createInMemoryCollection<UserMemoryRow>(), noBlobs, {});
    const redactions = createInMemoryCollection<MemoryRedactionRecord>();
    const contracts = createContractStore(makeDb());
    // The memory leg asks the gate whether this caller may read the pool; with no gate it
    // answers "not granted", and the leg (and its rejections) never reach recall.
    const gate = createOpAdmissionGate({
      grantEntryStore: createContractGrantEntryStore(contracts),
      definitionStore: createContractDefinitionStore(contracts),
      now: () => 1,
    });
    const bundle = compose(buildDeps({
      getUserMemoryStore: () => memory,
      getMemoryRedactionStore: () => redactions,
      getContractStore: () => contracts,
    }, {
      ...inertLateGetters(),
      getExecuteDeps: vi.fn(() => ({ opAdmissionGate: gate })) as never,
    }));
    const registry = (createChatOrchestratorMock.mock.calls[0]![0] as {
      registry: ChatOrchestratorDeps['registry'];
    }).registry;
    const owner = { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'local' } as const;

    // An earlier chat said it, and an agent saved it…
    bundle.chatStore.createSession({ id: 's0', now: 1_000 });
    await bundle.chatStore.appendMessage({
      id: 'user-0', session_id: 's0', role: 'user',
      content: "Remember that Dana Whitfield's daughter is called Mia.",
      target_server: 'self', picker_at_send: { current: 'self' },
      model_used: { provider: 'openai', model_id: 'm' },
      execution_source: { ...owner, chat_session_id: 's0' }, ts: 2_000, turn_id: 'turn-0',
    } as never);
    const note = await memory.writeAuthored({
      origin_actor: 'contracted_user', author_contract_id: OWNER_CONTRACT_ID,
      kind: 'chat_memory', summary: "Dana Whitfield's daughter is called Mia.",
    });
    // …then the owner marked it wrong.
    const revokedAt = Date.UTC(2026, 10, 2);
    await redactions.set(note.memory_id, { memory_id: note.memory_id, redacted_at: revokedAt, revoked: true, revoke_of: note.memory_id });

    bundle.chatStore.createSession({ id: 's1', now: 3_000 });
    const turn_state = new Map<string, unknown>();
    registerRecallTurnSource(turn_state, owner);
    const dispatched = await registry.dispatch(
      RECALL_SEARCH_TOOL_NAME,
      { query: 'Dana Whitfield daughter' },
      { channel: 'internal_function_call', session_id: 's1', turn_id: 'turn-1', execution_source: owner, turn_state },
    );
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const result = (dispatched as { result: RecallSearchResult }).result;
    expect(result.rejected).toEqual([{
      memory_id: note.memory_id,
      summary: "Dana Whitfield's daughter is called Mia.",
      revoked_at: revokedAt,
      note: RECALL_REJECTED_NOTE,
    }]);
    expect(result.matches.some((m) => m.source === 'memory' && m.memory_id === note.memory_id)).toBe(false);
    expect(
      result.matches.some((m) => m.source === 'interaction' && m.content.includes('is called Mia')),
      'the old chat is recalled too: ' + JSON.stringify(result),
    ).toBe(true);
  });
});

describe('D-337 slice O — the composed chat reads a vendor-neutral CRM write on the owner\'s CRM', () => {
  // ⛔ The handler tests hand the recipe check its CRM operations. This composes them through the
  // REAL wire, from the run's own stores (the connections, their operation profiles, the
  // manifests), so a composition that stopped passing them through fails HERE.
  const OWNER_SOURCE = { channel: 'chat', actor: 'user_self', chat_session_id: 'cs1', user_id: 'owner' };
  const run = async (approval: 'ask' | 'always') => {
    const dir = mkdtempSync(join(tmpdir(), 'd137-neutral-write-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const recipes = createRecipeStore(dir, makeDb());
    recipes.save({
      recipe_id: 'move-deal',
      version: 1,
      metadata: { name: 'Move a deal', description: 'fixture', author: 'recued-core', tags: [] },
      steps: [{ id: 'moved', op: 'core.crm.deal.update', args: { id: 'd1' } }],
    } as never, 'recued-core', 'bundled');
    const hubspot = { slug: 'hubspot-catalog', operations: {
      'deal.update': { operation_id: 'hubspot.deal.update', risk_tier: 'write', approval },
    } };
    const { compose, createChatOrchestratorMock } = await importComposerWithOrchestratorSpy();
    compose(buildDeps({ recipeStore: recipes }, {
      ...inertLateGetters(),
      getExecutorConfig: vi.fn(() => ({ manifests: { get: (slug: string) => (slug === 'hubspot-catalog' ? hubspot : null) } })) as never,
      getExecuteDeps: vi.fn(() => ({
        connectionStore: { list: () => [{ name: 'hs' }] },
        connectionOperationProfiles: { get: () => ({ allowed_operations: ['deal.update'], catalog_slug: 'hubspot-catalog' }) },
      })) as never,
    }));
    const deps = createChatOrchestratorMock.mock.calls.at(-1)![0] as unknown as {
      registry: { dispatch: (name: string, args: unknown, ctx: unknown) => Promise<unknown> };
    };
    // A call of this turn waits for the owner's answer.
    const turn_state = new Map<string, unknown>();
    noteWaitingInTurn(turn_state, 'calendar.create');
    return deps.registry.dispatch('recipe.run', { recipe_id: 'move-deal' }, {
      channel: 'internal_function_call', session_id: 'cs1', turn_id: 't1', execution_source: OWNER_SOURCE, turn_state,
    }).catch((error: unknown) => ({ thrown: String(error) }));
  };

  it('a recipe whose CRM write the owner\'s CRM makes without asking is not held back; one it asks for is', async () => {
    expect(await run('always')).toMatchObject({ ok: false, reason: 'not_asked_yet' });
    // Past the check it goes on to run (here into an executor the test stubs).
    expect(await run('ask')).not.toMatchObject({ reason: 'not_asked_yet' });
  });
});

describe('D-337 ruling 4 (a) — the composed gateway wait hears the server\'s settled runs', () => {
  // ⛔ The orchestrator tests hand the gateway turn its own wait. This composes it through the REAL
  // wire, so a composition that stopped passing the wait, or stopped telling it of settled runs,
  // fails HERE: the gateway would then answer "waiting for approval" after the owner approved.
  const GATEWAY_SOURCE = {
    channel: 'chat', actor: 'contracted_user', chat_session_id: 'llm_gateway:token-1', user_id: 'customer', contract_id: 'c1',
  };
  it('a held gateway call\'s wait ends with the run the run-settled sink is told of', async () => {
    const { compose, createChatOrchestratorMock } = await importComposerWithOrchestratorSpy();
    const bundle = compose(buildDeps());
    const deps = createChatOrchestratorMock.mock.calls.at(-1)![0] as ChatOrchestratorDeps;
    expect(deps.settleHeldCall).toBeDefined();
    const held = {
      ok: true as const, result: { awaiting_approval: true }, run_held: { kind: 'approval' as const }, run_id: 'run-g1',
    };
    // Short, so a wiring that never tells it fails as an answer, not as a test timeout.
    const waiting = deps.settleHeldCall!({ run_id: 'run-g1', held, until: Date.now() + 2_000 });
    await bundle.runSettledSink({
      execution_source: GATEWAY_SOURCE,
      run_id: 'run-g1',
      tool_name: 'seller/remove-event',
      result: { success: true, recipe_id: 'seller/remove-event', errors: [], steps: [] },
      ts: Date.now(),
    });
    await expect(waiting).resolves.toMatchObject({ ok: true, run_id: 'run-g1' });
    await expect(waiting).resolves.not.toHaveProperty('run_held');
  });
});

describe('D-337 ruling 4 (a) — the composed chat runs a recipe tool under the name it was called by', () => {
  // ⛔ The Tier-2 dispatch's own test hands it a fake executor. This runs the dispatch through the
  //   REAL wire, so a composition that dropped the tool name on its way to `handleExecute` fails
  //   HERE: a contracted run (the LLM gateway's) would then be checked against
  //   `<metadata.author>/<recipe_id>` before each local write, and refused.
  it('hands the run the tool the recipe was called by (`entry_tool_name`)', async () => {
    vi.resetModules();
    const handleExecute = vi.fn(async (_deps: unknown, _request: unknown, _internal?: unknown) => ({
      success: true, recipe_id: 'say-hello', errors: [], steps: [], output: { render: [], sidebar: [] },
    }));
    vi.doMock('../execute-handler.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../execute-handler.js')>()),
      handleExecute,
    }));
    try {
      const mod = await import('../composition/bin/wire-chat-orchestrator.js');
      const dir = mkdtempSync(join(tmpdir(), 'd137-entry-tool-'));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      const recipes = createRecipeStore(dir, makeDb());
      recipes.save({
        recipe_id: 'say-hello',
        version: 1,
        metadata: { name: 'Say hello', description: 'fixture', author: 'someone-else', tags: [] },
        steps: [{ id: 'card', transform: 'to_summary', fields: [{ label: 'Hello', value: 'there' }] }],
      } as never, 'kitchen', 'inline');
      const bundle = mod.composeChatOrchestrator(buildDeps({ recipeStore: recipes }, {
        ...inertLateGetters(),
        getExecuteDeps: vi.fn(() => ({})) as never,
      }));
      await bundle.internalRegistry.dispatch('kitchen/say-hello', {}, {
        channel: 'internal_function_call', session_id: 'cs1', turn_id: 't1',
        execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 'cs1', user_id: 'owner' },
      } as never);
      expect(handleExecute).toHaveBeenCalledTimes(1);
      expect(handleExecute.mock.calls[0]![1]).toMatchObject({ recipe_id: 'say-hello' });
      expect(handleExecute.mock.calls[0]![2]).toEqual({
        entry_tool_name: 'kitchen/say-hello',
        // D-336 (spec §53) — and chat's look at each record change the run makes.
        record_change_check: expect.any(Function),
      });
    } finally {
      vi.doUnmock('../execute-handler.js');
    }
  });
});
