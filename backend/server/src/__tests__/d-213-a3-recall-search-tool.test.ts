/** D-213 Track A / A3 — chat-only recall broker, budgets, and turn state. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  NON_RETAINABLE_RECALL_TOOL_NAMES,
  partitionPriorToolCalls,
  type AIOutput,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ExecutionSource,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type ToolEntry,
} from '@recued/contracts';

import {
  RECALL_HISTORICAL_SESSIONS_PER_TURN,
  RECALL_SEARCH_BYTES_PER_CALL,
  RECALL_SEARCH_BYTES_PER_TURN,
  RECALL_SEARCH_CALLS_PER_TURN,
  RECALL_SEARCH_MATCHES_PER_CALL,
  RECALL_SEARCH_MATCHES_PER_TURN,
  RECALL_SEARCH_TOOL_ENTRY,
  RECALL_SEARCH_TOOL_NAME,
  RECALL_EXACT_BUDGET_HINT,
  RECALL_STALE_CONTINUATION_HINT,
  RECALL_TURN_BUDGET_HINT,
  recallJoinedPieces,
  registerRecallTurnSource,
  registerVisibleInteractionItemIds,
  registerVisibleRecallToolResult,
  wrapRegistryWithRecallSearch,
  type RecallSearchResult,
} from '../chat-recall-search-tool.js';
import {
  RECALL_INTERACTION_EXACT_MAX_BYTES,
  RECALL_QUERY_RAW_MAX_BYTES,
  type InteractionRecallCandidate,
  type RecallSearchBackend,
  type RecallSearchBackendResult,
} from '../chat-recall-search.js';
import {
  createChatOrchestrator,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import {
  createChatStore,
  ensureChatSchema,
} from '../storage/chat-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractStore } from '../storage/contract-store.js';

const NOW = 1_784_915_200_000;

const SELF_SIGNATURE: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'd213-a3',
};

const OWNER_SOURCE: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'current',
  user_id: 'local',
};

const MESSENGER_SOURCE: ExecutionSource = {
  channel: 'messenger',
  actor: 'user_self',
  vendor: 'slack',
  from: 'coworker',
};

const CONTRACTED_SOURCE: ExecutionSource = {
  channel: 'chat',
  actor: 'contracted_user',
  chat_session_id: 'contracted',
  user_id: 'customer',
  contract_id: 'ct_missing',
};

const MEMORY_TOOL_ENTRY: ToolEntry = {
  name: 'memory.search',
  tier: 1,
  description: 'Search saved memory.',
  arg_schema: { type: 'object' },
  topic_tags: ['memory'],
  classification: 'read',
  concurrency_safe: true,
};

const candidate = (
  item_id: string,
  session_id = 'prior',
  content = `content for ${item_id}`,
  timestamp = 1_000,
  kind: 'user' | 'assistant' = 'user',
): InteractionRecallCandidate => ({
  item_id,
  session_id,
  kind,
  timestamp,
  content,
  size_bytes: Buffer.byteLength(content, 'utf8'),
  score: 1,
});

const completeSearch = (
  matches: readonly InteractionRecallCandidate[] = [],
  overrides: Partial<RecallSearchBackendResult> = {},
): RecallSearchBackendResult => ({
  matches,
  complete: true,
  invalid_continuation: false,
  more_matches: false,
  inspected_rows: matches.length,
  ...overrides,
});

const memory = (
  memory_id: string,
  body = `body for ${memory_id}`,
  overrides: Record<string, unknown> = {},
) => ({
  memory_id,
  ts: 2_000,
  origin_actor: 'user_self',
  kind: 'note',
  summary: `summary ${memory_id}`,
  body,
  size_bytes: Buffer.byteLength(body, 'utf8'),
  truncated: false,
  ...overrides,
});

const memoryDispatchResult = (
  memories: readonly Record<string, unknown>[] = [],
  next_cursor?: string,
): ChatDispatchResult => ({
  ok: true,
  result: {
    memories,
    budget: {
      limit_bytes: 16 * 1024,
      used_bytes: 0,
      truncated_count: 0,
    },
    ...(next_cursor !== undefined ? { next_cursor } : {}),
  },
});

const makeRawRegistry = (
  memoryResult:
    | ChatDispatchResult
    | ((args: unknown, ctx: ChatDispatchContext) => ChatDispatchResult) =
    memoryDispatchResult(),
): {
  readonly raw: InternalToolRegistry;
  readonly dispatch: ReturnType<typeof vi.fn>;
} => {
  const dispatch = vi.fn(
    async (
      name: string,
      args: unknown,
      ctx: ChatDispatchContext,
    ): Promise<ChatDispatchResult> => {
      if (name !== 'memory.search') {
        return { ok: false, reason: 'unknown_tool' };
      }
      return typeof memoryResult === 'function'
        ? memoryResult(args, ctx)
        : memoryResult;
    },
  );
  const raw: InternalToolRegistry = {
    list: () => [MEMORY_TOOL_ENTRY],
    listByTier: (tier) => (tier === 1 ? [MEMORY_TOOL_ENTRY] : []),
    getByName: (name) => (name === 'memory.search' ? MEMORY_TOOL_ENTRY : null),
    dispatch,
    subscribeRefresh: () => () => {},
  };
  return { raw, dispatch };
};

const makeBackend = (
  search: RecallSearchBackend['search'] = async () => completeSearch(),
  fetchExact: RecallSearchBackend['fetchExact'] = async () => ({
    status: 'not_found',
  }),
): {
  readonly backend: RecallSearchBackend;
  readonly search: ReturnType<typeof vi.fn>;
  readonly fetchExact: ReturnType<typeof vi.fn>;
} => {
  const searchSpy = vi.fn(search);
  const fetchSpy = vi.fn(fetchExact);
  return {
    backend: {
      search: searchSpy,
      fetchExact: fetchSpy,
    },
    search: searchSpy,
    fetchExact: fetchSpy,
  };
};

/** A turn opened by a surface that MINTED `source` — what the orchestrator
 * scaffold does. The registered source, not `ctx.execution_source`, is the
 * authority the interaction lane admits on. */
const turnContext = (
  source: ExecutionSource,
  turn_state = new Map<string, unknown>(),
): ChatDispatchContext => {
  registerRecallTurnSource(turn_state, source);
  return {
    channel: 'internal_function_call',
    session_id: 'current',
    turn_id: 'turn-1',
    execution_source: source,
    turn_state,
  };
};

const ownerContext = (
  turn_state = new Map<string, unknown>(),
): ChatDispatchContext => turnContext(OWNER_SOURCE, turn_state);

const resultOf = async (
  registry: InternalToolRegistry,
  args: unknown,
  ctx = ownerContext(),
): Promise<RecallSearchResult> => {
  const dispatched = await registry.dispatch(RECALL_SEARCH_TOOL_NAME, args, ctx);
  expect(dispatched.ok).toBe(true);
  return (dispatched as Extract<ChatDispatchResult, { ok: true }>)
    .result as RecallSearchResult;
};

describe('D-213 A3 — recall.search broker', () => {
  let db: Database.Database;
  let definitions: ReturnType<typeof createContractDefinitionStore>;

  beforeEach(() => {
    db = new Database(':memory:');
    definitions = createContractDefinitionStore(
      createContractStore(db, { now: () => NOW }),
      { now: () => NOW },
    );
  });

  afterEach(() => db.close());

  const wrap = (input: {
    backend?: RecallSearchBackend;
    raw?: InternalToolRegistry;
  } = {}): InternalToolRegistry => {
    const raw = input.raw ?? makeRawRegistry().raw;
    return wrapRegistryWithRecallSearch(raw, {
      backend: input.backend ?? makeBackend().backend,
      getContractDefinitionStore: () => definitions,
      now: () => NOW,
    });
  };

  it('is a hand-built sequential Tier-1 tool only on the wrapped registry and routes through the central recall field', async () => {
    const { raw } = makeRawRegistry();
    const registry = wrap({ raw });

    expect(raw.getByName(RECALL_SEARCH_TOOL_NAME)).toBeNull();
    expect(raw.list().map((entry) => entry.name)).not.toContain(
      RECALL_SEARCH_TOOL_NAME,
    );
    expect(registry.getByName(RECALL_SEARCH_TOOL_NAME)).toEqual(
      RECALL_SEARCH_TOOL_ENTRY,
    );
    expect(RECALL_SEARCH_TOOL_ENTRY).toMatchObject({
      tier: 1,
      classification: 'read',
      concurrency_safe: false,
    });
    const schema = RECALL_SEARCH_TOOL_ENTRY.arg_schema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      'continuation',
      'item_id',
      'kinds',
      'memory_id',
      'query',
      'sources',
    ]);

    expect(NON_RETAINABLE_RECALL_TOOL_NAMES).toEqual(
      new Set(['memory.search', 'recall.search']),
    );
    const toolCall = (tool_name: string) => ({
      tool_name,
      tier: 1 as const,
      args: {},
      status: 'ok' as const,
      result: {},
      started_at: 1,
      completed_at: 2,
    });
    const partitioned = partitionPriorToolCalls([
      toolCall('contact.search'),
      toolCall('memory.search'),
      toolCall('recall.search'),
    ]);
    expect(partitioned.prior.map((call) => call.tool_name)).toEqual([
      'contact.search',
    ]);
    expect(partitioned.recall.map((call) => call.tool_name)).toEqual([
      'memory.search',
      'recall.search',
    ]);
  });

  it('interleaves independently ranked interaction and memory lanes without exposing private session handles', async () => {
    const backend = makeBackend(async () =>
      completeSearch([
        candidate('item-1', 'prior-a', 'alpha interaction', 3_000),
        candidate('item-2', 'prior-b', 'beta interaction', 2_000, 'assistant'),
      ]));
    const raw = makeRawRegistry(
      memoryDispatchResult([
        memory('memory-1', 'alpha memory'),
        memory('memory-2', 'beta memory'),
      ]),
    );
    const registry = wrap({ backend: backend.backend, raw: raw.raw });
    const state = new Map<string, unknown>();

    const result = await resultOf(
      registry,
      { query: 'ALPHA!!!' },
      ownerContext(state),
    );

    expect(result.matches.map((match) => [
      match.source,
      match.lane_rank,
    ])).toEqual([
      ['interaction', 1],
      ['memory', 1],
      ['interaction', 2],
      ['memory', 2],
    ]);
    expect(result.matches.every(
      (match) => match.trust === 'historical_untrusted',
    )).toBe(true);
    expect(result).toMatchObject({
      exhausted: true,
      partial: false,
    });
    expect(raw.dispatch).toHaveBeenCalledWith(
      'memory.search',
      { query: 'alpha' },
      expect.objectContaining({ turn_state: state }),
    );
    expect(recallJoinedPieces(state).map((piece) => piece.session_id)).toEqual([
      'prior-a',
      'prior-b',
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('prior-a');
    expect(serialized).not.toContain('prior-b');
    expect(serialized).not.toContain('session_id');
  });

  it('excludes visible chat and prior recall feedback, and kinds disables the memory lane', async () => {
    const backend = makeBackend(async (input) => {
      expect(input.excluded_item_ids).toEqual(
        new Set(['visible-3', 'visible-4', 'visible-5', 'visible-6']),
      );
      return completeSearch([candidate('fresh-item', 'prior-a')]);
    });
    const raw = makeRawRegistry(
      memoryDispatchResult([
        memory('already-visible-memory'),
        memory('fresh-memory'),
      ]),
    );
    const registry = wrap({
      backend: backend.backend,
      raw: raw.raw,
    });
    const state = new Map<string, unknown>();
    registerVisibleInteractionItemIds(state, [
      'visible-3',
      'visible-4',
      'visible-5',
      'visible-6',
    ]);
    registerVisibleRecallToolResult(
      state,
      'memory.search',
      memoryDispatchResult([memory('already-visible-memory')]),
    );

    const first = await resultOf(registry, {}, ownerContext(state));
    expect(first.matches.map((match) =>
      match.source === 'memory' ? match.memory_id : match.item_id)).toEqual([
      'fresh-item',
      'fresh-memory',
    ]);
    expect(first.partial).toBe(false);

    backend.search.mockImplementationOnce(async (input) => {
      expect(input.kinds).toEqual(new Set(['user']));
      expect(input.excluded_item_ids?.has('fresh-item')).toBe(true);
      return completeSearch();
    });
    await resultOf(
      registry,
      { kinds: ['user'] },
      ownerContext(state),
    );
    expect(raw.dispatch).toHaveBeenCalledTimes(1);
  });

  it('seeds exclusions from the exact prompt rows even when timestamps tie', async () => {
    ensureChatSchema(db);
    const chatStore = createChatStore(db);
    chatStore.createSession({ id: 'current', now: NOW });
    for (const [index, id] of [
      'b-tail',
      'c-tail',
      'd-tail',
      'e-tail',
    ].entries()) {
      await chatStore.appendMessage({
        id,
        session_id: 'current',
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `tail ${id}`,
        target_server: 'self',
        picker_at_send: {
          display_name: 'Self',
          signature: SELF_SIGNATURE,
        },
        model_used: { provider: 'test', model_id: 'test/model' },
        execution_source: OWNER_SOURCE,
        ts: NOW,
      });
    }

    const backend = makeBackend(async (input) => {
      expect(input.excluded_item_ids).toEqual(
        new Set(['c-tail', 'd-tail', 'e-tail', 'a-current']),
      );
      return completeSearch();
    });
    const registry = wrap({
      backend: backend.backend,
      raw: makeRawRegistry().raw,
    });
    let aiCall = 0;
    const executeAiCall: ExecuteChatAiCall = vi.fn(async () => {
      const body: AIOutput = aiCall++ === 0
        ? {
            response: '',
            events: [],
            tool_calls: [{
              tool: RECALL_SEARCH_TOOL_NAME,
              args: { sources: ['interaction'] },
            }],
          }
        : { response: 'done', events: [], tool_calls: [] };
      return { body };
    });
    const minted = ['turn-visible', 'a-current', 'assistant-final'];
    const orchestrator = createChatOrchestrator({
      chatStore,
      registry,
      selfSignature: SELF_SIGNATURE,
      executeAiCall,
      now: () => NOW,
      mintId: () => minted.shift() ?? 'unexpected-id',
    });

    await orchestrator.runTurn({
      session_id: 'current',
      message: 'recall the omitted history',
      picker_state: { current: 'self' },
    });

    expect(backend.search).toHaveBeenCalledTimes(1);
  });

  it('fails closed before either lane for messenger, contracted, and MCP-wire callers', async () => {
    const backend = makeBackend();
    const raw = makeRawRegistry(memoryDispatchResult([memory('secret')]));
    const registry = wrap({ backend: backend.backend, raw: raw.raw });

    for (const execution_source of [MESSENGER_SOURCE, CONTRACTED_SOURCE]) {
      const result = await resultOf(
        registry,
        {},
        turnContext(execution_source),
      );
      expect(result).toMatchObject({
        matches: [],
        exhausted: true,
        partial: false,
      });
    }
    // The turn's REGISTERED source governs, not the dispatch ctx's. A messenger
    // turn whose ctx carries the ctx-default owner shape is still refused.
    const spoofedCtx = turnContext(MESSENGER_SOURCE);
    const spoofed = await resultOf(registry, {}, {
      ...spoofedCtx,
      execution_source: OWNER_SOURCE,
    });
    expect(spoofed).toMatchObject({
      matches: [],
      exhausted: true,
      partial: false,
    });
    const wire = await resultOf(registry, {}, {
      channel: 'mcp_wire',
      mcp_token_id: 'tok',
      execution_source: {
        channel: 'mcp',
        actor: 'contracted_user',
        agent_id: 'agent',
        tool_call_id: 'call',
        mcp_token_id: 'tok',
        contract_id: 'ct_missing',
      },
    });
    expect(wire.matches).toEqual([]);
    expect(backend.search).not.toHaveBeenCalled();
    expect(backend.fetchExact).not.toHaveBeenCalled();
    expect(raw.dispatch).not.toHaveBeenCalled();
  });

  it('refuses a dispatch whose turn registered no source, even when the ctx carries the owner default', async () => {
    const backend = makeBackend();
    const raw = makeRawRegistry(memoryDispatchResult([memory('secret')]));
    const registry = wrap({ backend: backend.backend, raw: raw.raw });

    // `buildInternalDispatchCtx` hands an owner-shaped `(chat, user_self)`
    // source to ANY caller of the public dispatch seam that omits one. A caller
    // that never opened a turn registers nothing, so the lane must not open.
    const unregistered: ChatDispatchContext = {
      channel: 'internal_function_call',
      session_id: 'current',
      turn_id: 'turn-1',
      execution_source: OWNER_SOURCE,
      turn_state: new Map<string, unknown>(),
    };
    const result = await resultOf(registry, {}, unregistered);
    expect(result).toMatchObject({
      matches: [],
      exhausted: true,
      partial: false,
    });
    expect(backend.search).not.toHaveBeenCalled();
    expect(backend.fetchExact).not.toHaveBeenCalled();
    expect(raw.dispatch).not.toHaveBeenCalled();

    // Same ctx, once its turn registers the source it was opened with.
    registerRecallTurnSource(unregistered.turn_state!, OWNER_SOURCE);
    await resultOf(registry, {}, unregistered);
    expect(backend.search).toHaveBeenCalledTimes(1);
  });

  it('bounds the raw query arg at the ceiling its schema declares', async () => {
    const backend = makeBackend(async (input) => {
      // Normalization ran over the truncated raw arg, then capped the phrase.
      expect(
        Buffer.byteLength(input.query?.text ?? '', 'utf8'),
      ).toBeLessThanOrEqual(512);
      return completeSearch();
    });
    const registry = wrap({ backend: backend.backend });
    const schemaMax = (
      RECALL_SEARCH_TOOL_ENTRY.arg_schema as {
        properties: { query: { maxLength?: number } };
      }
    ).properties.query.maxLength;
    expect(schemaMax).toBe(RECALL_QUERY_RAW_MAX_BYTES);

    const result = await resultOf(registry, {
      query: `${'needle '.repeat(20_000)}tail`,
    });
    expect(result.matches).toEqual([]);
    expect(backend.search).toHaveBeenCalledTimes(1);
  });

  it('rejects open, oversized, and malformed arguments as guided empty before probing', async () => {
    const backend = makeBackend();
    const raw = makeRawRegistry(memoryDispatchResult([memory('secret')]));
    const registry = wrap({ backend: backend.backend, raw: raw.raw });

    for (const args of [
      { query: 'needle', injected_contract_id: 'user_self' },
      { sources: ['interaction', 'memory', 'interaction'] },
      { kinds: ['user', 'assistant', 'user'] },
      { item_id: 'x'.repeat(513) },
      { memory_id: 'x'.repeat(513) },
      { continuation: 'x'.repeat(1_025) },
      { item_id: ' item-id' },
      { memory_id: 'memory-id ' },
      { continuation: ' token\n' },
      { sources: ['unknown'] },
      { query: '!!!' },
    ]) {
      await expect(resultOf(registry, args, ownerContext())).resolves.toMatchObject({
        matches: [],
        exhausted: true,
        partial: false,
      });
    }
    expect(backend.search).not.toHaveBeenCalled();
    expect(backend.fetchExact).not.toHaveBeenCalled();
    expect(raw.dispatch).not.toHaveBeenCalled();
  });

  it('gives exact ids precedence, enforces the dual-id and exact-count rules, and byte-caps exact bodies', async () => {
    const oversized = '界'.repeat(30_000);
    const backend = makeBackend(
      async () => completeSearch(),
      async (item_id) =>
        item_id === 'item-large'
          ? {
              status: 'ok',
              match: candidate(
                item_id,
                'prior-exact',
                oversized,
                4_000,
              ),
            }
          : { status: 'not_found' },
    );
    const raw = makeRawRegistry(
      memoryDispatchResult([
        memory('memory-large', oversized, { truncated: true }),
      ]),
    );
    const registry = wrap({ backend: backend.backend, raw: raw.raw });
    const interactionState = new Map<string, unknown>();

    const interaction = await resultOf(
      registry,
      {
        item_id: 'item-large',
        sources: [],
        kinds: [],
        continuation: 'ignored-by-exact',
      },
      ownerContext(interactionState),
    );
    const interactionMatch = interaction.matches[0];
    expect(interactionMatch).toMatchObject({
      source: 'interaction',
      completeness: 'truncated_oversize',
      size_bytes: Buffer.byteLength(oversized, 'utf8'),
    });
    expect(
      Buffer.byteLength(
        interactionMatch?.source === 'interaction'
          ? interactionMatch.content
          : '',
        'utf8',
      ),
    ).toBeLessThanOrEqual(RECALL_INTERACTION_EXACT_MAX_BYTES);
    expect(recallJoinedPieces(interactionState).map((piece) => piece.session_id)).toEqual([
      'prior-exact',
    ]);

    const exactLimit = await resultOf(
      registry,
      { memory_id: 'memory-large' },
      ownerContext(interactionState),
    );
    expect(exactLimit).toMatchObject({
      matches: [],
      exhausted: false,
      partial: true,
      hint: RECALL_EXACT_BUDGET_HINT,
    });
    expect(raw.dispatch).not.toHaveBeenCalled();

    const memoryExact = await resultOf(
      registry,
      {
        memory_id: 'memory-large',
        sources: ['interaction'],
        kinds: ['user'],
      },
      ownerContext(),
    );
    const memoryMatch = memoryExact.matches[0];
    expect(memoryMatch).toMatchObject({
      source: 'memory',
      memory_id: 'memory-large',
      truncated: true,
    });
    expect(
      memoryMatch?.source === 'memory' ? memoryMatch.body : undefined,
    ).toBeUndefined();
    expect(
      Buffer.byteLength(
        memoryMatch?.source === 'memory'
          ? memoryMatch.body_preview ?? ''
          : '',
        'utf8',
      ),
    ).toBeLessThanOrEqual(RECALL_INTERACTION_EXACT_MAX_BYTES);

    const fetchCallsBeforeDual = backend.fetchExact.mock.calls.length;
    const dual = await resultOf(
      registry,
      { item_id: 'item-large', memory_id: 'memory-large' },
      ownerContext(),
    );
    expect(dual.matches).toEqual([]);
    expect(backend.fetchExact).toHaveBeenCalledTimes(fetchCallsBeforeDual);
  });

  it('suppresses mismatched exact ids and malformed memory coverage as incomplete', async () => {
    const mismatchedInteraction = makeBackend(
      async () => completeSearch(),
      async () => ({
        status: 'ok',
        match: candidate('different-item'),
      }),
    );
    const interaction = await resultOf(
      wrap({ backend: mismatchedInteraction.backend }),
      { item_id: 'requested-item' },
      ownerContext(),
    );
    expect(interaction).toMatchObject({
      matches: [],
      exhausted: false,
      partial: true,
    });

    const mismatchedMemory = await resultOf(
      wrap({
        raw: makeRawRegistry(
          memoryDispatchResult([memory('different-memory')]),
        ).raw,
      }),
      { memory_id: 'requested-memory' },
      ownerContext(),
    );
    expect(mismatchedMemory).toMatchObject({
      matches: [],
      exhausted: false,
      partial: true,
    });

    const malformedMemory = await resultOf(
      wrap({
        raw: makeRawRegistry(
          memoryDispatchResult([
            memory('malformed-memory', 'short body', {
              size_bytes: 1_000,
              truncated: false,
            }),
          ]),
        ).raw,
      }),
      { sources: ['memory'] },
      ownerContext(),
    );
    expect(malformedMemory).toMatchObject({
      matches: [],
      exhausted: false,
      partial: true,
    });

    const malformedEnvelope = await resultOf(
      wrap({
        raw: makeRawRegistry({
          ok: true,
          result: {
            memories: [memory('malformed-envelope')],
            budget: {
              limit_bytes: 1,
              used_bytes: 2,
              truncated_count: 0,
            },
            next_cursor: 42,
          },
        }).raw,
      }),
      { sources: ['memory'] },
      ownerContext(),
    );
    expect(malformedEnvelope).toMatchObject({
      matches: [],
      exhausted: false,
      partial: true,
    });
  });

  it('keeps scan incompleteness distinct from ordinary result truncation', async () => {
    const backend = makeBackend();
    backend.search
      .mockResolvedValueOnce(completeSearch(
        [candidate('partial-item')],
        {
          complete: false,
          continuation: 'signed-frontier',
        },
      ))
      .mockResolvedValueOnce(completeSearch(
        [candidate('ordinary-item')],
        { more_matches: true },
      ))
      .mockResolvedValueOnce(completeSearch([], {
        complete: false,
        invalid_continuation: true,
      }));
    const registry = wrap({
      backend: backend.backend,
      raw: makeRawRegistry(memoryDispatchResult([memory('memory-ok')])).raw,
    });

    const partial = await resultOf(
      registry,
      { sources: ['interaction', 'memory'] },
      ownerContext(),
    );
    expect(partial.matches.length).toBe(2);
    expect(partial).toMatchObject({
      exhausted: false,
      partial: true,
      continuation: 'signed-frontier',
    });

    const ordinary = await resultOf(
      registry,
      { sources: ['interaction'] },
      ownerContext(),
    );
    expect(ordinary).toMatchObject({
      exhausted: false,
      partial: false,
    });
    expect(ordinary.continuation).toBeUndefined();

    // R4/R5 — a tampered token and a token this server can no longer
    // authenticate (a restart rotates the per-process key) are indistinguishable
    // here, and NEITHER inspected the corpus. Reporting the definitive
    // complete-miss shape would tell the model no older history exists.
    const invalid = await resultOf(
      registry,
      { sources: ['interaction'], continuation: 'tampered' },
      ownerContext(),
    );
    expect(invalid).toMatchObject({
      matches: [],
      exhausted: false,
      partial: true,
      hint: RECALL_STALE_CONTINUATION_HINT,
    });
    expect(invalid.continuation).toBeUndefined();

    const truncatedMemory = await resultOf(
      wrap({
        raw: makeRawRegistry(memoryDispatchResult([
          memory('preview-only', '', {
            body: undefined,
            body_preview: 'bounded preview',
            size_bytes: 80 * 1024,
            truncated: true,
          }),
        ])).raw,
      }),
      { sources: ['memory'] },
      ownerContext(),
    );
    expect(truncatedMemory).toMatchObject({
      exhausted: false,
      partial: false,
    });

    const unavailableMemory = await resultOf(
      wrap({
        raw: makeRawRegistry({
          ok: true,
          result: {
            memories: [],
            budget: {
              limit_bytes: 16 * 1024,
              used_bytes: 0,
              truncated_count: 0,
            },
            coverage: 'unavailable',
          },
        }).raw,
      }),
      { sources: ['memory'] },
      ownerContext(),
    );
    expect(unavailableMemory).toMatchObject({
      exhausted: false,
      partial: true,
    });
  });

  it('enforces per-call and per-turn search budgets while leaving one exact fetch separate', async () => {
    const pageOne = Array.from(
      { length: RECALL_SEARCH_MATCHES_PER_CALL + 5 },
      (_, index) => candidate(`one-${index}`, 'current', 'small'),
    );
    const pageTwo = Array.from(
      { length: RECALL_SEARCH_MATCHES_PER_CALL },
      (_, index) => candidate(`two-${index}`, 'current', 'small'),
    );
    const backend = makeBackend();
    backend.search
      .mockResolvedValueOnce(completeSearch(pageOne))
      .mockResolvedValueOnce(completeSearch(pageTwo));
    backend.fetchExact.mockResolvedValue({
      status: 'ok',
      match: candidate('exact-after-search', 'current', 'exact body'),
    });
    const registry = wrap({
      backend: backend.backend,
      raw: makeRawRegistry().raw,
    });
    const state = new Map<string, unknown>();

    const first = await resultOf(
      registry,
      { sources: ['interaction'] },
      ownerContext(state),
    );
    const second = await resultOf(
      registry,
      { sources: ['interaction'] },
      ownerContext(state),
    );
    expect(first.matches).toHaveLength(RECALL_SEARCH_MATCHES_PER_CALL);
    expect(second.matches).toHaveLength(
      RECALL_SEARCH_MATCHES_PER_TURN - RECALL_SEARCH_MATCHES_PER_CALL,
    );
    expect(first.exhausted).toBe(false);
    expect(second.exhausted).toBe(false);
    expect(
      Buffer.byteLength(JSON.stringify(first.matches), 'utf8'),
    ).toBeLessThanOrEqual(RECALL_SEARCH_BYTES_PER_CALL);
    expect(
      Buffer.byteLength(JSON.stringify(second.matches), 'utf8'),
    ).toBeLessThanOrEqual(RECALL_SEARCH_BYTES_PER_CALL);
    expect(
      Buffer.byteLength(JSON.stringify(first.matches), 'utf8')
      + Buffer.byteLength(JSON.stringify(second.matches), 'utf8'),
    ).toBeLessThanOrEqual(RECALL_SEARCH_BYTES_PER_TURN);

    const overCalls = await resultOf(
      registry,
      { sources: ['interaction'] },
      ownerContext(state),
    );
    expect(overCalls).toMatchObject({
      matches: [],
      exhausted: false,
      partial: true,
      hint: RECALL_TURN_BUDGET_HINT,
    });
    expect(backend.search).toHaveBeenCalledTimes(RECALL_SEARCH_CALLS_PER_TURN);

    const exact = await resultOf(
      registry,
      { item_id: 'exact-after-search' },
      ownerContext(state),
    );
    expect(exact.matches).toHaveLength(1);
  });

  it('caps serialized bytes, reports three-valued clipping, and withholds a fifth historical session', async () => {
    const large = 'x'.repeat(80 * 1024);
    const byteBackend = makeBackend(async () =>
      completeSearch([candidate('large', 'current', large)]));
    const byteRegistry = wrap({
      backend: byteBackend.backend,
      raw: makeRawRegistry().raw,
    });
    const byteResult = await resultOf(
      byteRegistry,
      { sources: ['interaction'] },
      ownerContext(),
    );
    expect(
      Buffer.byteLength(JSON.stringify(byteResult.matches), 'utf8'),
    ).toBeLessThanOrEqual(RECALL_SEARCH_BYTES_PER_CALL);
    expect(byteResult.matches[0]).toMatchObject({
      completeness: 'truncated_oversize',
    });
    expect(byteResult).toMatchObject({
      exhausted: false,
      partial: false,
    });

    const historicalBackend = makeBackend(async () =>
      completeSearch(
        Array.from(
          { length: RECALL_HISTORICAL_SESSIONS_PER_TURN + 1 },
          (_, index) => candidate(`historical-${index}`, `prior-${index}`),
        ),
      ));
    const historicalState = new Map<string, unknown>();
    const historical = await resultOf(
      wrap({
        backend: historicalBackend.backend,
        raw: makeRawRegistry().raw,
      }),
      { sources: ['interaction'] },
      ownerContext(historicalState),
    );
    expect(historical.matches).toHaveLength(
      RECALL_HISTORICAL_SESSIONS_PER_TURN,
    );
    expect(historical).toMatchObject({
      exhausted: false,
      partial: true,
    });
    expect(recallJoinedPieces(historicalState).map((piece) => piece.session_id)).toHaveLength(
      RECALL_HISTORICAL_SESSIONS_PER_TURN,
    );
    expect(JSON.stringify(historical)).not.toContain('prior-4');
  });
});
