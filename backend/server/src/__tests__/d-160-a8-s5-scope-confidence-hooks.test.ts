/** D-160 spec § A.8 step 5 — the `scope-search` + `confidence-shape`
 *  before/after-turn hooks.
 *
 *  Step 5 binds the last two first-party concerns as registered chat turn
 *  hooks over the shared `state` (N.9), mirroring the step-4 catalog hook +
 *  the Stage-3 source adapters. Because the live scope-search /
 *  confidence-shape fan-out runs at TOOL-dispatch level today
 *  (`chat-tool-handlers.ts`), this slice is the SEAM: the hooks register +
 *  gate + delegate to the real `@recued/middleware-recued` middlewares, but
 *  are FAITHFUL NO-OPS until a turn-level producer (`getScopeSearchInput`)
 *  lands. These tests pin:
 *    1. registration + position in `createChatStreamMiddlewares`,
 *    2. the scope-search → confidence-shape chain through `runStream` when a
 *       producer is wired (DECIDE → `state`), and its faithful no-op without
 *       one / when registry-disabled,
 *    3. end-to-end through the real orchestrator — inert by default; the
 *       producer dep lights up the fan-out mid-turn (the seam is real).
 *
 *  The pure classifier / fan-out runner semantics are pinned by the
 *  middleware package's own tests (`d-137-phase-2-scope-search-runner`,
 *  `confidence-shape/__tests__`, `d-160-phase-2-adapters`); this file pins
 *  the chat-lane PLUMBING those now flow through.
 */

import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  createInMemorySessionStore,
  type Channel,
  type ChannelInbound,
  type ChannelOutbound,
} from '@recued/chat';
import {
  createMiddlewareRegistry,
  runStream,
  type Middleware,
  type MiddlewareRegistry,
  type TurnContext,
  type TurnExecutor,
} from '@recued/middleware';
import {
  registerFirstPartyMiddlewares,
  scopeSearchMiddleware,
  confidenceShapeMiddleware,
  type ScopeSearchSource,
} from '@recued/middleware-recued';
import {
  SCOPE_SEARCH_INPUT_STATE_KEY,
  SCOPE_SEARCH_RESULT_STATE_KEY,
} from '@recued/middleware-recued/scope-search/middleware.js';
import {
  CONFIDENCE_SHAPE_CANDIDATES_STATE_KEY,
  CONFIDENCE_SHAPE_RESULT_STATE_KEY,
} from '@recued/middleware-recued/confidence-shape/middleware.js';
import { type AIOutput, type InternalToolRegistry, type RecuedServerSignature } from '@recued/contracts';

import {
  createChatStreamMiddlewares,
  type ChatScopeSearchInput,
} from '../chat-stream-middleware.js';
import {
  createChatOrchestrator,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const NOW = Date.UTC(2030, 0, 15, 12, 0, 0);
const baseDeps = { now: () => NOW, resolveTzClock: () => null };

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

/** A first-party registry carrying ONLY the two step-5 middlewares (both
 *  register enabled). Each test mutates enabled-state as needed. */
const scopeConfidenceRegistry = (): MiddlewareRegistry => {
  const registry = createMiddlewareRegistry();
  registry.register(scopeSearchMiddleware);
  registry.register(confidenceShapeMiddleware);
  return registry;
};

/** A two-candidate fan-out source: top 0.9, runner-up 0.4 → confidence
 *  Pattern 1 (single dominant). `query` is a spy so the orchestrator e2e
 *  can prove the hook reached the source through `runStream`. */
const spyContactSource = (): {
  source: ScopeSearchSource<unknown, unknown>;
  calls: () => number;
} => {
  let calls = 0;
  const source: ScopeSearchSource<unknown, unknown> = {
    id: 'local',
    query: async () => {
      calls += 1;
      return [
        { record: { id: 'alice' }, score: 0.9 },
        { record: { id: 'bob' }, score: 0.4 },
      ];
    },
  };
  return { source, calls: () => calls };
};

const recordingChannel = (): Channel => ({
  surface: 'chat',
  async deliver(_event: ChannelOutbound): Promise<void> {},
  onInbound(): void {},
});

const inbound: ChannelInbound = {
  session_id: 'sess-1',
  surface: 'chat',
  text: 'find alice',
  from: 'user-1',
  source: {
    channel: 'chat',
    actor: 'user_self',
    chat_session_id: 'sess-1',
    user_id: 'user-1',
  },
  dispatch_depth: 0,
  ts: NOW,
};

/** Build the step-5 stream over a fresh framework registry + run one turn
 *  through `runStream` with a stub executor. Returns the shared `state`
 *  map AFTER the turn — so the before-turn scope-search write AND the
 *  after-turn confidence-shape write are both observable (or absent). */
const runChainTurn = async (opts: {
  firstParty: MiddlewareRegistry;
  getScopeSearchInput?: () => ChatScopeSearchInput | undefined;
}): Promise<Map<string, unknown>> => {
  const streamRegistry = createMiddlewareRegistry();
  for (const mw of createChatStreamMiddlewares({
    registry: opts.firstParty,
    ...(opts.getScopeSearchInput ? { getScopeSearchInput: opts.getScopeSearchInput } : {}),
    ...baseDeps,
  })) {
    streamRegistry.register(mw);
  }
  const sessionStore = createInMemorySessionStore();
  sessionStore.append({
    session_id: 'sess-1',
    surface: 'chat',
    role: 'user',
    text: 'find alice',
    ts: NOW,
  });
  const state = new Map<string, unknown>();
  const executor: TurnExecutor = async () => ({ text: '' });
  await runStream({
    registry: streamRegistry,
    channel: recordingChannel(),
    sessionStore,
    inbound,
    runTurn: executor,
    state,
  });
  return state;
};

describe('D-160 A.8 step 5 — scope-search + confidence-shape registration', () => {
  it('registers scope-search (prompt-only) + confidence-shape (update-only) when a registry is wired', () => {
    const mws = createChatStreamMiddlewares({
      registry: scopeConfidenceRegistry(),
      ...baseDeps,
    });
    const scope = mws.find((m) => m.id === 'scope-search')!;
    const confidence = mws.find((m) => m.id === 'confidence-shape')!;
    expect(typeof scope.prompt).toBe('function');
    expect(scope.update).toBeUndefined();
    expect(typeof confidence.update).toBe('function');
    expect(confidence.prompt).toBeUndefined();
  });

  it('places scope-search first and confidence-shape after correction-learning', () => {
    const mws = createChatStreamMiddlewares({
      registry: scopeConfidenceRegistry(),
      ...baseDeps,
    });
    // The full first-party adapter order (no PII / catalog wired here) —
    // mirrors `FIRST_PARTY_MIDDLEWARES`: scope-search → correction →
    // confidence-shape → personal-recipes, then the D-164 prompt-cache
    // (entity prefetch) adapter last in the prompt phase.
    expect(mws.map((m) => m.id)).toEqual([
      'scope-search',
      'correction-learning',
      'confidence-shape',
      'personal-recipes',
      'prompt-cache',
    ]);
  });

  it('omits both when no registry is wired (the source adapters need the registry)', () => {
    const mws = createChatStreamMiddlewares({ ...baseDeps });
    expect(mws.map((m) => m.id)).not.toContain('scope-search');
    expect(mws.map((m) => m.id)).not.toContain('confidence-shape');
    expect(mws).toEqual([]);
  });
});

describe('D-160 A.8 step 5 — the scope-search → confidence-shape chain (runStream)', () => {
  it('lights up the whole chain when getScopeSearchInput is wired', async () => {
    const spy = spyContactSource();
    const state = await runChainTurn({
      firstParty: scopeConfidenceRegistry(),
      getScopeSearchInput: () => ({ args: { query: 'alice' }, sources: [spy.source] }),
    });

    // scope-search (before-turn) seeded its input + the real middleware
    // wrote the fan-out result.
    expect(spy.calls()).toBe(1);
    expect(state.get(SCOPE_SEARCH_INPUT_STATE_KEY)).toMatchObject({
      args: { query: 'alice' },
    });
    expect(state.get(SCOPE_SEARCH_RESULT_STATE_KEY)).toEqual({
      candidates: [
        { source: 'local', record: { id: 'alice' }, score: 0.9 },
        { source: 'local', record: { id: 'bob' }, score: 0.4 },
      ],
    });

    // confidence-shape (after-turn) chained off that result → classified
    // the distribution (Pattern 1 — single dominant top).
    expect(state.get(CONFIDENCE_SHAPE_CANDIDATES_STATE_KEY)).toEqual([
      { record: { id: 'alice' }, score: 0.9 },
      { record: { id: 'bob' }, score: 0.4 },
    ]);
    expect(state.get(CONFIDENCE_SHAPE_RESULT_STATE_KEY)).toMatchObject({
      pattern: 1,
      top: { id: 'alice' },
      alternatives: [{ id: 'bob' }],
      measures: { candidate_count: 2, top_score: 0.9 },
    });
  });

  it('is a faithful no-op chain without a producer (production today)', async () => {
    const state = await runChainTurn({ firstParty: scopeConfidenceRegistry() });
    // No producer → scope-search no-ops → no fan-out result → confidence-shape
    // no-ops. Nothing written; the turn ran exactly as before step 5.
    expect(state.has(SCOPE_SEARCH_INPUT_STATE_KEY)).toBe(false);
    expect(state.has(SCOPE_SEARCH_RESULT_STATE_KEY)).toBe(false);
    expect(state.has(CONFIDENCE_SHAPE_CANDIDATES_STATE_KEY)).toBe(false);
    expect(state.has(CONFIDENCE_SHAPE_RESULT_STATE_KEY)).toBe(false);
  });

  it('honours the registry enabled-state: a disabled scope-search collapses the whole chain', async () => {
    const spy = spyContactSource();
    const firstParty = scopeConfidenceRegistry();
    firstParty.disable('scope-search');
    const state = await runChainTurn({
      firstParty,
      getScopeSearchInput: () => ({ args: { query: 'alice' }, sources: [spy.source] }),
    });
    // The D-160 gate short-circuits BEFORE the producer read — the source
    // is never queried, and NOTHING is seeded (input included): a regression
    // that seeded the fan-out input ahead of the enabled-state gate would
    // trip the `SCOPE_SEARCH_INPUT_STATE_KEY` assertion. Confidence-shape
    // (which chains off the result) no-ops too.
    expect(spy.calls()).toBe(0);
    expect(state.has(SCOPE_SEARCH_INPUT_STATE_KEY)).toBe(false);
    expect(state.has(SCOPE_SEARCH_RESULT_STATE_KEY)).toBe(false);
    expect(state.has(CONFIDENCE_SHAPE_CANDIDATES_STATE_KEY)).toBe(false);
    expect(state.has(CONFIDENCE_SHAPE_RESULT_STATE_KEY)).toBe(false);
  });

  it('confidence-shape gates independently: disabled → fan-out still runs, no classification', async () => {
    const spy = spyContactSource();
    const firstParty = scopeConfidenceRegistry();
    firstParty.disable('confidence-shape');
    const state = await runChainTurn({
      firstParty,
      getScopeSearchInput: () => ({ args: { query: 'alice' }, sources: [spy.source] }),
    });
    expect(spy.calls()).toBe(1);
    expect(state.has(SCOPE_SEARCH_RESULT_STATE_KEY)).toBe(true);
    // confidence-shape's gate short-circuits BEFORE seeding candidates — a
    // regression that mapped + seeded ahead of the enabled-state gate would
    // trip the `CONFIDENCE_SHAPE_CANDIDATES_STATE_KEY` assertion.
    expect(state.has(CONFIDENCE_SHAPE_CANDIDATES_STATE_KEY)).toBe(false);
    expect(state.has(CONFIDENCE_SHAPE_RESULT_STATE_KEY)).toBe(false);
  });
});

describe('D-160 A.8 step 5 — end-to-end through the orchestrator', () => {
  const internalRegistry = (): InternalToolRegistry => ({
    list: () => [],
    listByTier: () => [],
    getByName: () => null,
    dispatch: vi.fn(async () => ({ ok: true, result: {} }) as const),
    subscribeRefresh: () => () => undefined,
  });

  const firstPartyRegistry = (): MiddlewareRegistry => {
    const registry = createMiddlewareRegistry();
    registerFirstPartyMiddlewares(registry);
    return registry;
  };

  const runOrchestratorTurn = async (
    getScopeSearchInput?: () => ChatScopeSearchInput | undefined,
  ): Promise<{ turn_id: string }> => {
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const chatStore = createChatStore(db);
      chatStore.createSession({ id: 'sess-1', now: NOW - 1_000 });
      const executeAiCall = vi.fn<ExecuteChatAiCall>(async () => ({
        body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput,
      }));
      const orchestrator = createChatOrchestrator({
        chatStore,
        registry: internalRegistry(),
        broadcast: { emit: () => {} },
        selfSignature,
        executeAiCall,
        middlewareRegistry: firstPartyRegistry(),
        ...(getScopeSearchInput ? { getScopeSearchInput } : {}),
        now: () => NOW,
      });
      return await orchestrator.runTurn({
        session_id: 'sess-1',
        message: 'find alice',
        picker_state: { current: 'self' },
      });
    } finally {
      db.close();
    }
  };

  it('inert by default: a turn runs normally with the hooks registered but no producer', async () => {
    const result = await runOrchestratorTurn();
    expect(typeof result.turn_id).toBe('string');
  });

  it('wiring getScopeSearchInput lights up the fan-out mid-turn (the seam is real)', async () => {
    const spy = spyContactSource();
    await runOrchestratorTurn(() => ({
      args: { query: 'alice' },
      sources: [spy.source],
    }));
    // The orchestrator threaded the producer dep into the stream registry's
    // scope-search hook, and `runStream` drove it in the before-turn phase —
    // so the source was queried during the real turn.
    expect(spy.calls()).toBe(1);
  });
});

describe('D-164 prompt-cache (entity prefetch) adapter', () => {
  const PROMPT_CACHE_ID = 'prompt-cache';
  const FIRED_KEY = 'test:prompt-cache-prompt-fired';

  /** A stand-in `prompt-cache` middleware whose `prompt` hook stamps a sentinel
   *  into the shared `state`, so a turn can prove the adapter delegated to the
   *  real (registered + enabled) middleware. */
  const fakePromptCache = (): Middleware => ({
    id: PROMPT_CACHE_ID,
    prompt(ctx: TurnContext): void {
      ctx.state.set(FIRED_KEY, true);
    },
  });

  /** Build the chat stream over `firstParty`, optionally mutate the registry
   *  AFTER construction (to prove the adapter re-resolves enabled-state per turn
   *  rather than baking in a snapshot), then run one turn through `runStream`.
   *  Returns the shared `state` map after the turn. */
  const runPromptCacheTurn = async (
    firstParty: MiddlewareRegistry,
    afterBuild?: () => void,
  ): Promise<Map<string, unknown>> => {
    const streamRegistry = createMiddlewareRegistry();
    for (const mw of createChatStreamMiddlewares({ registry: firstParty, ...baseDeps })) {
      streamRegistry.register(mw);
    }
    afterBuild?.();
    const sessionStore = createInMemorySessionStore();
    sessionStore.append({ session_id: 'sess-1', surface: 'chat', role: 'user', text: 'find alice', ts: NOW });
    const state = new Map<string, unknown>();
    const executor: TurnExecutor = async () => ({ text: '' });
    await runStream({
      registry: streamRegistry,
      channel: recordingChannel(),
      sessionStore,
      inbound,
      runTurn: executor,
      state,
    });
    return state;
  };

  it('delegates to a registered + enabled prompt-cache middleware (the LIVE seam)', async () => {
    const firstParty = createMiddlewareRegistry();
    firstParty.register(fakePromptCache());
    const state = await runPromptCacheTurn(firstParty);
    expect(state.get(FIRED_KEY)).toBe(true);
  });

  it('re-resolves enabled-state per turn — a prompt-cache disabled AFTER construction stops firing', async () => {
    const firstParty = createMiddlewareRegistry();
    firstParty.register(fakePromptCache());
    // Disable AFTER `createChatStreamMiddlewares` already ran: the adapter must
    // re-query the live registry at prompt time, never bake in the object (the
    // five source adapters' discipline; the prior find+push approach kept
    // firing here — the regression this pins).
    const state = await runPromptCacheTurn(firstParty, () => firstParty.disable(PROMPT_CACHE_ID));
    expect(state.get(FIRED_KEY)).toBeUndefined();
  });

  it('no-ops when no prompt-cache middleware is registered (faithful subset)', async () => {
    const state = await runPromptCacheTurn(scopeConfidenceRegistry());
    expect(state.get(FIRED_KEY)).toBeUndefined();
  });
});
