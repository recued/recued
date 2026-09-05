import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  createChatStore,
  ensureChatSchema,
  CHAT_MESSAGE_RECALL_ELIGIBILITY,
  type ChatStore,
} from '../storage/chat-store.js';
import { createRecallSearchBackend } from '../chat-recall-search.js';
import {
  wrapRegistryWithRecallSearch,
  registerRecallTurnSource,
  RECALL_SEARCH_TOOL_NAME,
} from '../chat-recall-search-tool.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ExecutionSource, InternalToolRegistry } from '@recued/contracts';

/** Recall's half of relative navigation, driven END TO END through the real
 *  store and the real backend.
 *
 *  🔑 THE ANSWER IN A CONVERSATION REPEATS NONE OF THE QUESTION'S WORDS:
 *      "are you sure you want to move from 30d to 90d?"   <- findable
 *      "no lets be fair & change it to 60d"               <- the ANSWER
 *  No search reaches the reply — not exact, not relaxed, not loose. Only
 *  stepping to it can. Chat has no thread_id, so adjacency is scoped to the
 *  SESSION, which IS the conversation.
 *
 *  ⛔ THIS IS AN INTEGRATION TEST ON PURPOSE. The MAIL equivalent compiled
 *  cleanly and still failed three separate ways in a live run — guidance in the
 *  wrong schema field, a method that existed on the table but not on the wrapper
 *  the caller iterates, and a path that returned rows with no body. Each was
 *  invisible to a unit test and to the type checker. */
const OWNER: ExecutionSource = {
  channel: 'chat', actor: 'user_self', chat_session_id: 'S1', user_id: 'local',
};
const PICKER = { display_name: 'self', signature: 'sig' } as never;

/** The owner corpus, spelled out rather than imported from a resolver, so this
 *  test keeps exercising the BACKEND rather than the scope rules (which
 *  `chat-recall-contract-corpus.test.ts` owns). */
const OWNER_RECALL_TEST_SCOPE = {
  governing_contract_id: 'user_self',
  row_eligibility: 'chat:owner_authenticated',
  recall_contract_id: null,
} as const;

describe('recall neighbours (end to end)', () => {
  let db: Database.Database;
  let store: ChatStore;

  beforeEach(async () => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    store = createChatStore(db);
    store.createSession({ id: 'S1', now: 1_000 });
    const say = async (id: string, role: 'user' | 'assistant', content: string, ts: number) => {
      await store.appendMessage({
        id, session_id: 'S1', role, content,
        target_server: 'self', picker_at_send: PICKER,
        model_used: { provider: 't', model_id: 't' },
        execution_source: OWNER, ts,
      });
    };
    await say('m1', 'user',
      'are you sure you want to move the Ridgeway renewal notice period from 30d to 90d?', 2_000);
    await say('m2', 'user', 'no lets be fair & change it to 60d so we can both be happy', 3_000);
    await say('m3', 'assistant', 'understood, recording 60d', 4_000);
  });
  afterEach(() => { db.close(); });

  it('the anchor is recall-eligible (otherwise the rest is vacuous)', async () => {
    const row = await store.getRecallMessage?.({
      row_eligibility: CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
        recall_contract_id: null,
      tool_session_id: null,
      item_id: 'm1',
    });
    expect(row, 'seed must be eligible or every assertion below passes trivially')
      .not.toBeNull();
  });

  it('steps FORWARD to the reply the question cannot find', async () => {
    const rows = await store.getRecallNeighbours?.({
      row_eligibility: CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
        recall_contract_id: null,
      tool_session_id: null,
      item_id: 'm1', next: 2,
    });
    expect(rows?.map((r) => r.item_id)).toEqual(['m2', 'm3']);
  });

  it('steps BACKWARD for context', async () => {
    const rows = await store.getRecallNeighbours?.({
      row_eligibility: CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
        recall_contract_id: null,
      tool_session_id: null,
      item_id: 'm3', prev: 1,
    });
    expect(rows?.map((r) => r.item_id)).toEqual(['m2']);
  });

  it('carries CONTENT — the mail path returned rows with no body', async () => {
    const rows = await store.getRecallNeighbours?.({
      row_eligibility: CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
        recall_contract_id: null,
      tool_session_id: null,
      item_id: 'm1', next: 1,
    });
    const first = rows?.[0] as { readable: boolean; content?: string } | undefined;
    expect(first?.readable).toBe(true);
    expect(first?.content).toContain('60d');
  });

  it('the BACKEND exposes it — a method the caller cannot see is the mail bug', async () => {
    const backend = createRecallSearchBackend(store);
    expect(typeof backend.neighbours,
      '`neighbours()` existed on CollectionTable but not the wrapper the handler iterated')
      .toBe('function');
    // ⚠ `scope` is REQUIRED now, and it was not when this test was written.
    // `neighbours` used to hardcode the owner bucket while `search` and
    // `fetchExact` took a scope — harmless while the owner corpus was the only
    // one, and a cross-tenant leak once a door corpus existed: a contracted
    // caller's search would return its own rows and then step to the OWNER's
    // neighbours around them.
    const got = await backend.neighbours?.({
      anchor_id: 'm1', next: 1, scope: OWNER_RECALL_TEST_SCOPE,
    });
    expect(got?.[0]?.content).toContain('60d');
    expect(got?.[0]?.score, 'stepped rows matched nothing and must not outrank a real hit')
      .toBe(0);
  });

  it('does not cross session boundaries', async () => {
    store.createSession({ id: 'S2', now: 1_000 });
    await store.appendMessage({
      id: 'other', session_id: 'S2', role: 'user', content: 'unrelated 60d chatter',
      target_server: 'self', picker_at_send: PICKER,
      model_used: { provider: 't', model_id: 't' },
      execution_source: { ...OWNER, chat_session_id: 'S2' }, ts: 3_500,
    });
    const rows = await store.getRecallNeighbours?.({
      row_eligibility: CHAT_MESSAGE_RECALL_ELIGIBILITY.OWNER_AUTHENTICATED_CHAT,
        recall_contract_id: null,
      tool_session_id: null,
      item_id: 'm1', next: 5,
    });
    expect(rows?.map((r) => r.item_id)).not.toContain('other');
  });

  it('DISPATCHES through the tool — the layer the mail bug actually lived in', async () => {
    // ⛔ The mail failure was not in the table or the backend: `neighbours()`
    // existed on both and the handler still got nothing, because the wrapper it
    // iterated did not expose the method. Backend-level assertions passed the
    // whole time. This drives the same path the model does.
    const cdb = new Database(':memory:');
    try {
      const definitions = createContractDefinitionStore(
        createContractStore(cdb, { now: () => 5_000 }), { now: () => 5_000 },
      );
      const raw: InternalToolRegistry = {
        list: () => [], listByTier: () => [], getByName: () => null,
        dispatch: async () => ({ ok: false, reason: 'unknown_tool' }),
        subscribeRefresh: () => () => {},
      } as never;
      const registry = wrapRegistryWithRecallSearch(raw, {
        backend: createRecallSearchBackend(store),
        getContractDefinitionStore: () => definitions,
        now: () => 5_000,
      });
      const turn_state = new Map<string, unknown>();
      registerRecallTurnSource(turn_state, OWNER);
      const out = await registry.dispatch(
        RECALL_SEARCH_TOOL_NAME,
        { near_id: 'm1', next: 2 },
        {
          channel: 'internal_function_call', session_id: 'S1', turn_id: 'T1',
          execution_source: OWNER, turn_state,
        } as never,
      );
      expect(out.ok, 'the dispatch itself must succeed').toBe(true);
      const res = (out as { result: { matches: Array<{ content?: string }> } }).result;
      expect(res.matches.length, 'the reply must reach the caller').toBeGreaterThan(0);
      expect(JSON.stringify(res.matches)).toContain('60d');
    } finally { cdb.close(); }
  });
  it('FENCES stepping behind the same anchor a search is fenced by', async () => {
    // Drives the authority question rather than reading it. `search` resolves
    // `interactionScope` and returns guided-empty when it is null; the

    const cdb = new Database(':memory:');
    try {
      const definitions = createContractDefinitionStore(
        createContractStore(cdb, { now: () => 5_000 }), { now: () => 5_000 },
      );
      const raw: InternalToolRegistry = {
        list: () => [], listByTier: () => [], getByName: () => null,
        dispatch: async () => ({ ok: false, reason: 'unknown_tool' }),
        subscribeRefresh: () => () => {},
      } as never;
      const registry = wrapRegistryWithRecallSearch(raw, {
        backend: createRecallSearchBackend(store),
        getContractDefinitionStore: () => definitions,
        now: () => 5_000,
      });
      const turn_state = new Map<string, unknown>();
      // ⛔ DELIBERATELY NOT registering a turn source.
      const out = await registry.dispatch(
        RECALL_SEARCH_TOOL_NAME,
        { near_id: 'm1', next: 2 },
        {
          channel: 'internal_function_call', session_id: 'S1', turn_id: 'T1',
          execution_source: OWNER, turn_state,
        } as never,
      );
      const res = (out as { result: { matches: unknown[] } }).result;
      expect(
        res.matches.length,
        'a turn with NO registered source must not reach rows by stepping',
      ).toBe(0);
    } finally { cdb.close(); }
  });
  it('a budget-exhausted turn cannot keep stepping', async () => {
    // ⛔ Navigation used to return above the `search_calls` counter, so it was
    // UNBUDGETED — unlimited steps per turn, which is the exact shape a model
    // that invents anchors falls into.
    const cdb = new Database(':memory:');
    try {
      const definitions = createContractDefinitionStore(
        createContractStore(cdb, { now: () => 5_000 }), { now: () => 5_000 },
      );
      const raw: InternalToolRegistry = {
        list: () => [], listByTier: () => [], getByName: () => null,
        dispatch: async () => ({ ok: false, reason: 'unknown_tool' }),
        subscribeRefresh: () => () => {},
      } as never;
      const registry = wrapRegistryWithRecallSearch(raw, {
        backend: createRecallSearchBackend(store),
        getContractDefinitionStore: () => definitions,
        now: () => 5_000,
      });
      const turn_state = new Map<string, unknown>();
      registerRecallTurnSource(turn_state, OWNER);
      const ctx = {
        channel: 'internal_function_call', session_id: 'S1', turn_id: 'T1',
        execution_source: OWNER, turn_state,
      } as never;
      const counts: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const out = await registry.dispatch(
          RECALL_SEARCH_TOOL_NAME, { near_id: 'm1', next: 2 }, ctx,
        );
        counts.push((out as { result: { matches: unknown[] } }).result.matches.length);
      }
      expect(counts[0], 'the first step must work').toBeGreaterThan(0);
      expect(
        counts[counts.length - 1],
        'stepping must run out of budget like a search does',
      ).toBe(0);
    } finally { cdb.close(); }
  });

  it('says an unknown anchor is UNKNOWN rather than answering empty', async () => {
    // ⛔⛔ The two answers were one observation: "no neighbour that way" and "no
    // such message" both rendered as an empty page, which reads as "the
    // conversation ends here" and invites no correction. A live model on the
    // sibling mail path invented six anchors off the corpus's id scheme and got
    // a clean empty for every one.
    const cdb = new Database(':memory:');
    try {
      const definitions = createContractDefinitionStore(
        createContractStore(cdb, { now: () => 5_000 }), { now: () => 5_000 },
      );
      const raw: InternalToolRegistry = {
        list: () => [], listByTier: () => [], getByName: () => null,
        dispatch: async () => ({ ok: false, reason: 'unknown_tool' }),
        subscribeRefresh: () => () => {},
      } as never;
      const registry = wrapRegistryWithRecallSearch(raw, {
        backend: createRecallSearchBackend(store),
        getContractDefinitionStore: () => definitions,
        now: () => 5_000,
      });
      const turn_state = new Map<string, unknown>();
      registerRecallTurnSource(turn_state, OWNER);
      const out = await registry.dispatch(
        RECALL_SEARCH_TOOL_NAME,
        { near_id: 'mail:pobm0001pob', next: 2 },
        {
          channel: 'internal_function_call', session_id: 'S1', turn_id: 'T1',
          execution_source: OWNER, turn_state,
        } as never,
      );
      const res = (out as { result: { matches: unknown[]; hint?: string } }).result;
      expect(res.matches.length).toBe(0);
      expect(
        res.hint ?? '',
        'an invented anchor must be NAMED as unknown, not answered with silence',
      ).toContain('does not match any message');
    } finally { cdb.close(); }
  });
});
