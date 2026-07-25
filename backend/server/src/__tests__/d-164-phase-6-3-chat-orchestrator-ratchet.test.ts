/** D-164 P6.3 - chat-orchestrator rewrite ratchets.
 *
 * Pins the inline main-turn packet, direct executeAiCall seam, catalog
 * projection, and preserved cooperative tool-loop behavior after the
 * Stage-1 / Stage-2 substrate was removed from chat-orchestrator.ts.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  CHAT_MAIN_TURN_INGREDIENT_SLUG,
  KERNEL_AUTHOR,
  CHAT_MAIN_TURN_TOOL_LOOP_CAP,
  modelTierToModelHint,
  type AIOutput,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ChatModelRoutingLayer,
  type ChatModelSourceId,
  type ChatToolCatalogScopeState,
  type ConnectionMcpAnnotationState,
  type IngredientManifest,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type TokenUsageReport,
  type ToolCall,
  type ToolEntry,
} from '@recued/contracts';
import {
  createChatOrchestrator,
  type BroadcastChatEvent,
  type ChatCatalogProjectionConfig,
  type ExecuteChatAiCall,
  type PeerDispatcher,
} from '../chat-orchestrator.js';
import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-self',
};

const peerSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-peer',
};

const mkTool = (
  name: string,
  tier: 1 | 2 | 3,
  overrides: Partial<ToolEntry> = {},
): ToolEntry => ({
  name,
  tier,
  description: `desc for ${name}`,
  arg_schema: { type: 'object' },
  topic_tags: ['test'],
  classification: 'read',
  concurrency_safe: false,
  ...overrides,
});

const mkRegistry = (
  catalog: ReadonlyArray<ToolEntry>,
  dispatchImpl?: (name: string, args: unknown, ctx: ChatDispatchContext) => Promise<ChatDispatchResult>,
): InternalToolRegistry => ({
  list: () => catalog,
  listByTier: (tier) => catalog.filter((e) => e.tier === tier),
  getByName: (name) => catalog.find((e) => e.name === name) ?? null,
  dispatch: dispatchImpl ?? (async () => ({ ok: true, result: { ok: true } })),
  subscribeRefresh: () => () => undefined,
});

const mkPeerDispatcher = (
  catalog: ReadonlyArray<ToolEntry>,
  dispatchImpl?: PeerDispatcher['dispatch'],
): PeerDispatcher => ({
  dispatch: dispatchImpl ?? (async () => ({ ok: true, result: { peer: true } })),
  listToolEntries: () => catalog,
  getPeerSignature: () => peerSignature,
});

type AiStep =
  | { body: unknown; usage?: TokenUsageReport }
  | { throws: Error };

interface CapturedAiCall {
  readonly manifest: IngredientManifest;
  readonly input: Record<string, unknown>;
}

const aiOutput = (
  response: string,
  tool_calls: ReadonlyArray<ToolCall> = [],
): AIOutput => ({
  response,
  events: [],
  tool_calls,
});

const toolCall = (
  tool = 'mail.search',
  args: Readonly<Record<string, unknown>> = { q: 'x' },
): ToolCall => ({
  tool,
  args,
});

const mkExecuteAiCall = (
  steps: ReadonlyArray<AiStep> | ((index: number) => AiStep),
  calls: CapturedAiCall[],
): ExecuteChatAiCall => async (manifest, input) => {
  const index = calls.length;
  calls.push({ manifest, input });
  const step = typeof steps === 'function'
    ? steps(index)
    : (steps[index] ?? steps[steps.length - 1]);
  if ('throws' in step) throw step.throws;
  return {
    body: step.body,
    ...(step.usage ? { usage: step.usage } : {}),
  };
};

let db: Database.Database;
let store: ChatStore;
let captured: BroadcastChatEvent[];
let harnessCounter: number;

const mintCounter = (prefix: string): (() => string) => {
  let n = 0;
  return () => `${prefix}-id-${++n}`;
};

const nextClock = (): (() => number) => {
  let t = 1000;
  return () => {
    t += 5;
    return t;
  };
};

const setup = (input: {
  sessionId?: string;
  catalog?: ReadonlyArray<ToolEntry>;
  dispatchImpl?: (name: string, args: unknown, ctx: ChatDispatchContext) => Promise<ChatDispatchResult>;
  executeAiCall?: ExecuteChatAiCall;
  peerDispatcher?: PeerDispatcher;
  scopeProvider?: () => ChatToolCatalogScopeState | null;
  annotationProvider?: () => ReadonlyArray<ConnectionMcpAnnotationState> | null;
  modelRouting?: { current: ChatModelRoutingLayer };
  catalogProjection?: ChatCatalogProjectionConfig;
  catalogProjectionForSource?: (
    source: ChatModelSourceId | undefined,
  ) => ChatCatalogProjectionConfig;
} = {}) => {
  const sessionId = input.sessionId ?? 'sess';
  const harnessId = `h${++harnessCounter}`;
  const registry = mkRegistry(input.catalog ?? [], input.dispatchImpl);
  const orchestrator = createChatOrchestrator({
    chatStore: store,
    registry,
    broadcast: { emit: (event) => captured.push(event) },
    selfSignature,
    mintId: mintCounter(harnessId),
    now: nextClock(),
    ...(input.executeAiCall ? { executeAiCall: input.executeAiCall } : {}),
    ...(input.peerDispatcher ? { peerDispatcher: input.peerDispatcher } : {}),
    ...(input.scopeProvider ? { scopeProvider: input.scopeProvider } : {}),
    ...(input.annotationProvider ? { annotationProvider: input.annotationProvider } : {}),
    ...(input.catalogProjection ? { catalogProjection: input.catalogProjection } : {}),
    ...(input.catalogProjectionForSource
      ? { catalogProjectionForSource: input.catalogProjectionForSource }
      : {}),
  });
  store.createSession({
    id: sessionId,
    now: 1000,
    ...(input.modelRouting ? { model_routing: input.modelRouting } : {}),
  });
  return { orchestrator, sessionId, registry };
};

const promptBody = <T extends Record<string, unknown>>(call: CapturedAiCall): T =>
  JSON.parse(String(call.input['llm.prompt'])) as T;

const transparencyEvents = (): Array<Record<string, unknown> & { kind: string }> =>
  captured
    .filter((event): event is Extract<BroadcastChatEvent, { kind: 'chat.transparency' }> =>
      event.kind === 'chat.transparency')
    .map((event) => event.event as Record<string, unknown> & { kind: string });

const eventsByKind = (kind: string): Array<Record<string, unknown> & { kind: string }> =>
  transparencyEvents().filter((event) => event.kind === kind);

const finalAssistant = async (sessionId: string) => {
  const messages = await store.listMessages(sessionId);
  return messages.find((message) => message.role === 'assistant');
};

beforeEach(() => {
  db = new Database(':memory:');
  ensureChatSchema(db);
  store = createChatStore(db, undefined);
  captured = [];
  harnessCounter = 0;
});

describe('D-164 P6.3 inline main-turn packet', () => {
  it('passes the synthetic kernel manifest and JSON output contract to executeAiCall', async () => {
    // Mutation caught: manifest slug/author/kind/risk_tier/output_format changed or omitted.
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([{ body: aiOutput('ok') }], calls);
    const { orchestrator, sessionId } = setup({ executeAiCall });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'hello',
      picker_state: { current: 'self' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.manifest.slug).toBe(CHAT_MAIN_TURN_INGREDIENT_SLUG);
    expect(calls[0]!.manifest.author).toBe(KERNEL_AUTHOR);
    expect(calls[0]!.manifest.kind).toBe('ai');
    expect(calls[0]!.manifest.risk_tier).toBe('read');
    expect(calls[0]!.manifest.input['llm.output_format']).toBe('json');
    expect(calls[0]!.input['llm.output_format']).toBe('json');
  });

  it('serializes prompt-body keys in the deterministic P6.3 order', async () => {
    // Mutation caught: prompt-body order changes, commitment_context drops, or prior_tool_calls appears initially.
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([{ body: aiOutput('ok') }], calls);
    const { orchestrator, sessionId } = setup({ executeAiCall });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'shape check',
      picker_state: { current: 'self' },
    });

    const parsed = promptBody(calls[0]!);
    expect(Object.keys(parsed)).toEqual([
      'available_tools',
      'commitment_context',
      'chat_tail',
      'current_date',
      'user_message',
    ]);
    expect(parsed.commitment_context).toEqual([]);
    // Current-instant clock anchor (weekday + YYYY-MM-DD + 24h time +
    // current UTC offset; deliberately NO zone name — a city-bearing IANA
    // id invites location-flavored answers) — per-turn tail only, never
    // inside the cacheable prefix. Time-granular (D-193) so the model can
    // resolve "remind me at 3pm" to an absolute instant.
    expect(parsed.current_date).toMatch(/^\w+ \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/);
    expect(parsed).not.toHaveProperty('prior_tool_calls');
  });

  it('pins the internal chat channel default tier to fast', async () => {
    // Mutation caught: CHAT_CHANNEL_DEFAULT_TIER changes away from fast.
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      { body: aiOutput('plan', [toolCall()]) },
      { body: aiOutput('done') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'search',
      picker_state: { current: 'self' },
    });

    expect(calls[0]!.input['llm.model_hint']).toBe(modelTierToModelHint('fast'));
    expect(eventsByKind('recued.multi_turn.round_started')).toMatchObject([
      { tier: 'fast' },
    ]);
  });
});

describe('D-164 P6.3 routing options', () => {
  it.each([
    ['free_pool', 'free'],
    ['byok', 'byok'],
  ] as const)('maps %s routing to llm.force_layer=%s', async (layer, expected) => {
    // Mutation caught: llm.force_layer mapping changes for a routing layer.
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([{ body: aiOutput('ok') }], calls);
    const { orchestrator, sessionId } = setup({
      sessionId: `sess-force-${layer}`,
      modelRouting: { current: layer },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'force layer',
      picker_state: { current: 'self' },
    });

    expect(calls[0]!.input['llm.force_layer']).toBe(expected);
  });
});

describe('D-164 P6.3 catalog projection', () => {
  it('applies only mechanical Tier 2 and Tier 3 gates to self catalogs', async () => {
    // Mutation caught: mechanical exclusion logic changes or empty descriptions serialize.
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([{ body: aiOutput('ok') }], calls);
    const catalog = [
      mkTool('tier1.always', 1),
      mkTool('recipe.blocked', 2, { requires_kinds: ['dom'] }),
      mkTool('recipe.allowed', 2, { requires_kinds: ['http'] }),
      mkTool('peer.blocked', 3),
      mkTool('peer.allowed', 3, { description: '' }),
    ];
    const annotationProvider = (): ReadonlyArray<ConnectionMcpAnnotationState> => [{
      connection_name: 'peer',
      topic_tags: [],
      tool_overrides: Object.create(null) as Record<string, never>,
      tools_list_cache: { tools: [{ name: 'blocked' }], cached_at: 1 },
      updated_at: 1,
    }];
    const scopeProvider = (): ChatToolCatalogScopeState => ({
      enabled_kinds: ['http'],
      updated_at: 1,
    });
    const { orchestrator, sessionId } = setup({
      catalog,
      executeAiCall,
      scopeProvider,
      annotationProvider,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'catalog',
      picker_state: { current: 'self' },
    });

    const tools = promptBody<{ available_tools: Array<Record<string, unknown>> }>(
      calls[0]!,
    ).available_tools;
    expect(tools.map((tool) => tool.recipe_slug)).toEqual([
      'tier1.always',
      'recipe.allowed',
      'peer.allowed',
    ]);
    expect(tools.find((tool) => tool.recipe_slug === 'peer.allowed')).not.toHaveProperty('description');
    expect(tools.find((tool) => tool.recipe_slug === 'recipe.allowed')).toMatchObject({
      args_schema: { type: 'object' },
      description: 'desc for recipe.allowed',
    });
  });

  it('isolates peer-target catalogs from self fallback and local gates', async () => {
    // Mutation caught: peer target falls back to Self catalog or applies Mary's local gates.
    const peerCalls: CapturedAiCall[] = [];
    const peerExecute = mkExecuteAiCall([{ body: aiOutput('peer ok') }], peerCalls);
    const peerCatalog = [
      mkTool('peer.recipe.blocked-if-self', 2, { requires_kinds: ['dom'] }),
      mkTool('peer.blocked-if-self', 3),
    ];
    const annotationProvider = (): ReadonlyArray<ConnectionMcpAnnotationState> => [{
      connection_name: 'peer',
      topic_tags: [],
      tool_overrides: Object.create(null) as Record<string, never>,
      tools_list_cache: { tools: [{ name: 'blocked-if-self' }], cached_at: 1 },
      updated_at: 1,
    }];
    const scopeProvider = (): ChatToolCatalogScopeState => ({ enabled_kinds: [], updated_at: 1 });
    const peerHarness = setup({
      sessionId: 'sess-peer',
      catalog: [mkTool('self.only', 1)],
      executeAiCall: peerExecute,
      peerDispatcher: mkPeerDispatcher(peerCatalog),
      scopeProvider,
      annotationProvider,
    });

    await peerHarness.orchestrator.runTurn({
      session_id: peerHarness.sessionId,
      message: 'peer',
      picker_state: { current: 'connection.mcp.peer' },
    });
    const peerTools = promptBody<{ available_tools: Array<Record<string, unknown>> }>(
      peerCalls[0]!,
    ).available_tools;
    expect(peerTools.map((tool) => tool.recipe_slug)).toEqual([
      'peer.recipe.blocked-if-self',
      'peer.blocked-if-self',
    ]);

    const missingPeerCalls: CapturedAiCall[] = [];
    const missingPeerExecute = mkExecuteAiCall([{ body: aiOutput('empty') }], missingPeerCalls);
    const missingPeerHarness = setup({
      sessionId: 'sess-peer-missing',
      catalog: [mkTool('self.only', 1)],
      executeAiCall: missingPeerExecute,
    });
    await missingPeerHarness.orchestrator.runTurn({
      session_id: missingPeerHarness.sessionId,
      message: 'missing peer',
      picker_state: { current: 'connection.mcp.peer' },
    });
    expect(promptBody<{ available_tools: unknown[] }>(missingPeerCalls[0]!).available_tools).toEqual([]);
  });
});

describe('Lever-2 index-mode catalog projection', () => {
  const runCatalogTurn = async (
    catalog: ReadonlyArray<ToolEntry>,
    catalogProjection: ChatCatalogProjectionConfig | undefined,
    sessionId = 'sess',
  ): Promise<Array<Record<string, unknown>>> => {
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([{ body: aiOutput('ok') }], calls);
    const { orchestrator } = setup({
      sessionId,
      catalog,
      executeAiCall,
      ...(catalogProjection ? { catalogProjection } : {}),
    });
    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'catalog',
      picker_state: { current: 'self' },
    });
    return promptBody<{ available_tools: Array<Record<string, unknown>> }>(calls[0]!)
      .available_tools;
  };

  const bySlug = (
    tools: Array<Record<string, unknown>>,
    slug: string,
  ): Record<string, unknown> => {
    const found = tools.find((tool) => tool.recipe_slug === slug);
    if (!found) throw new Error(`no projected tool for ${slug}`);
    return found;
  };

  const mixedCatalog: ReadonlyArray<ToolEntry> = [
    mkTool('tier1.always', 1),
    mkTool('recued-core/recipe.a', 2),
    mkTool('peer.tool', 3),
  ];

  it('leans ONLY Tier-2 entries in index mode — Tier-1 and Tier-3 keep args_schema', async () => {
    // Mutation caught: leaning the wrong tier(s) would strip a schema the model
    // still needs (Tier-1/Tier-3 are not in the tools.search recall pool).
    const tools = await runCatalogTurn(mixedCatalog, { mode: 'index' });

    const tier2 = bySlug(tools, 'recued-core/recipe.a');
    expect(tier2).not.toHaveProperty('args_schema');
    expect(tier2).toEqual({
      recipe_slug: 'recued-core/recipe.a',
      description: 'desc for recued-core/recipe.a',
    });

    expect(bySlug(tools, 'tier1.always')).toMatchObject({
      args_schema: { type: 'object' },
      description: 'desc for tier1.always',
    });
    expect(bySlug(tools, 'peer.tool')).toMatchObject({
      args_schema: { type: 'object' },
      description: 'desc for peer.tool',
    });
  });

  it('keeps every entry full in default (absent) and explicit full mode', async () => {
    // Mutation caught: the default path drifting off the launch baseline.
    const projections: Array<ChatCatalogProjectionConfig | undefined> = [
      undefined,
      { mode: 'full' },
    ];
    for (const [i, projection] of projections.entries()) {
      const tools = await runCatalogTurn(mixedCatalog, projection, `full-${i}`);
      for (const slug of ['tier1.always', 'recued-core/recipe.a', 'peer.tool']) {
        expect(bySlug(tools, slug)).toHaveProperty('args_schema', { type: 'object' });
      }
    }
  });

  it('caps Tier-2 descriptions (only) when indexDescriptionMaxChars is set', async () => {
    const longDesc = 'Draft a personalized follow-up email summarizing the agreed next steps';
    const shortDesc = 'Short one';
    const catalog: ReadonlyArray<ToolEntry> = [
      mkTool('tier1.always', 1, { description: longDesc }),
      mkTool('recued-core/recipe.long', 2, { description: longDesc }),
      mkTool('recued-core/recipe.short', 2, { description: shortDesc }),
    ];
    const tools = await runCatalogTurn(catalog, {
      mode: 'index',
      indexDescriptionMaxChars: 20,
    });

    const long = bySlug(tools, 'recued-core/recipe.long');
    expect(String(long.description).length).toBeLessThanOrEqual(21);
    expect(String(long.description).endsWith('…')).toBe(true);
    expect(long).not.toHaveProperty('args_schema');

    // A Tier-2 description already within the cap is left intact (no ellipsis).
    expect(bySlug(tools, 'recued-core/recipe.short').description).toBe(shortDesc);

    // Tier-1 descriptions are never capped (kernel entries stay full).
    expect(bySlug(tools, 'tier1.always').description).toBe(longDesc);
  });

  it('is presentation-only — index mode preserves BOTH the kind and Tier-3 annotation gates', async () => {
    // Mutation caught: index mode resurrecting a gated entry, OR a
    // mode-conditional skip of EITHER gate (kind on Tier-2, MCP annotation
    // on Tier-3). Authorization must not change with the delivery mode —
    // only the arg_schema presentation does. Mirrors the full-mode gate
    // ratchet above, run under `{ mode: 'index' }`.
    const catalog: ReadonlyArray<ToolEntry> = [
      mkTool('tier1.always', 1),
      mkTool('recipe.blocked', 2, { requires_kinds: ['dom'] }),
      mkTool('recipe.allowed', 2, { requires_kinds: ['http'] }),
      mkTool('peer.blocked', 3),
      mkTool('peer.allowed', 3),
    ];
    const annotationProvider = (): ReadonlyArray<ConnectionMcpAnnotationState> => [{
      connection_name: 'peer',
      topic_tags: [],
      tool_overrides: Object.create(null) as Record<string, never>,
      tools_list_cache: { tools: [{ name: 'blocked' }], cached_at: 1 },
      updated_at: 1,
    }];
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([{ body: aiOutput('ok') }], calls);
    const { orchestrator, sessionId } = setup({
      catalog,
      executeAiCall,
      scopeProvider: (): ChatToolCatalogScopeState => ({
        enabled_kinds: ['http'],
        updated_at: 1,
      }),
      annotationProvider,
      catalogProjection: { mode: 'index' },
    });
    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'catalog',
      picker_state: { current: 'self' },
    });
    const tools = promptBody<{ available_tools: Array<Record<string, unknown>> }>(calls[0]!)
      .available_tools;
    // Both gates applied identically to full mode: kind drops recipe.blocked,
    // annotation drops peer.blocked.
    expect(tools.map((tool) => tool.recipe_slug)).toEqual([
      'tier1.always',
      'recipe.allowed',
      'peer.allowed',
    ]);
    // Only the surviving Tier-2 entry is leaned; Tier-1 + Tier-3 stay full.
    expect(bySlug(tools, 'recipe.allowed')).not.toHaveProperty('args_schema');
    expect(bySlug(tools, 'tier1.always')).toHaveProperty('args_schema', { type: 'object' });
    expect(bySlug(tools, 'peer.allowed')).toHaveProperty('args_schema', { type: 'object' });
  });

  it('lean-core mode DROPS every Tier-2 entry — only Tier-1 + Tier-3 survive, both full', async () => {
    // Mutation caught: lean-core leaning (not dropping) Tier-2, or dropping the
    // wrong tier. Discoverability is preserved by the wire wrapper's own
    // listByTier(2) recall corpus (independent of THIS projection), so dropping
    // here costs only the turn-invariant prefix, not authorization.
    const tools = await runCatalogTurn(mixedCatalog, { mode: 'lean-core' });
    expect(tools.map((tool) => tool.recipe_slug)).toEqual(['tier1.always', 'peer.tool']);
    // No Tier-2 entry survives in ANY shape (not even leaned to slug+desc).
    expect(tools.find((tool) => tool.recipe_slug === 'recued-core/recipe.a')).toBeUndefined();
    // The surviving Tier-1 + Tier-3 entries keep their full args_schema.
    expect(bySlug(tools, 'tier1.always')).toHaveProperty('args_schema', { type: 'object' });
    expect(bySlug(tools, 'peer.tool')).toHaveProperty('args_schema', { type: 'object' });
  });

  it('is presentation-only — lean-core still applies the Tier-3 annotation gate (then drops all Tier-2)', async () => {
    // Mirror of the index gate ratchet under `{ mode: 'lean-core' }`. What this
    // MEANINGFULLY proves for lean-core: the Tier-3 annotation gate still drops
    // peer.blocked (a mutation skipping it would resurrect peer.blocked). The
    // Tier-2 KIND gate is subsumed here — lean-core drops recipe.blocked AND
    // recipe.allowed regardless of kind, so the projection can't distinguish a
    // kind-gate skip. The authorization-relevant Tier-2 kind gate is the SEARCH
    // corpus (a kind-disabled recipe must stay non-rediscoverable), covered
    // mode-independently in chat-tools-search.test.ts. Authorization is
    // identical across modes.
    const catalog: ReadonlyArray<ToolEntry> = [
      mkTool('tier1.always', 1),
      mkTool('recipe.blocked', 2, { requires_kinds: ['dom'] }),
      mkTool('recipe.allowed', 2, { requires_kinds: ['http'] }),
      mkTool('peer.blocked', 3),
      mkTool('peer.allowed', 3),
    ];
    const annotationProvider = (): ReadonlyArray<ConnectionMcpAnnotationState> => [{
      connection_name: 'peer',
      topic_tags: [],
      tool_overrides: Object.create(null) as Record<string, never>,
      tools_list_cache: { tools: [{ name: 'blocked' }], cached_at: 1 },
      updated_at: 1,
    }];
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([{ body: aiOutput('ok') }], calls);
    const { orchestrator, sessionId } = setup({
      catalog,
      executeAiCall,
      scopeProvider: (): ChatToolCatalogScopeState => ({
        enabled_kinds: ['http'],
        updated_at: 1,
      }),
      annotationProvider,
      catalogProjection: { mode: 'lean-core' },
    });
    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'catalog',
      picker_state: { current: 'self' },
    });
    const tools = promptBody<{ available_tools: Array<Record<string, unknown>> }>(calls[0]!)
      .available_tools;
    // Kind + annotation gates applied identically to full mode, THEN every
    // Tier-2 (incl. the kind-allowed recipe.allowed) dropped by lean-core.
    expect(tools.map((tool) => tool.recipe_slug)).toEqual(['tier1.always', 'peer.allowed']);
    expect(bySlug(tools, 'tier1.always')).toHaveProperty('args_schema', { type: 'object' });
    expect(bySlug(tools, 'peer.allowed')).toHaveProperty('args_schema', { type: 'object' });
  });

  it('lean-core drops ALL Tier-2 even when the catalog is Tier-2-only (no keep-one fallback)', async () => {
    // Mutation caught: "if lean-core would project no Tier-2, keep/lean one".
    // An all-Tier-2 catalog must project to ZERO recipe tools — the model then
    // relies wholly on tools.search for discovery.
    const allTier2: ReadonlyArray<ToolEntry> = [
      mkTool('recued-core/recipe.a', 2),
      mkTool('recued-core/recipe.b', 2),
    ];
    const tools = await runCatalogTurn(allTier2, { mode: 'lean-core' });
    expect(tools).toEqual([]);
  });

  it('per-slot: the per-turn projection is resolved from the turn LLM source', async () => {
    // The core per-slot switch, end-to-end through the real orchestrator: the
    // SAME orchestrator serves a free_pool turn as `index` (Tier-2 leaned) and a
    // slot_1 turn as `full` (Tier-2 keeps args_schema — byte-identical baseline),
    // driven only by `catalogProjectionForSource` + the turn's `model_pref`.
    const catalog: ReadonlyArray<ToolEntry> = [
      mkTool('tier1.always', 1),
      mkTool('recued-core/recipe.a', 2),
    ];
    const catalogProjectionForSource = (
      source: ChatModelSourceId | undefined,
    ): ChatCatalogProjectionConfig =>
      source === 'free_pool' ? { mode: 'index' } : { mode: 'full' };
    const runFor = async (
      source_id: ChatModelSourceId,
      sessionId: string,
    ): Promise<Array<Record<string, unknown>>> => {
      const calls: CapturedAiCall[] = [];
      const executeAiCall = mkExecuteAiCall([{ body: aiOutput('ok') }], calls);
      const { orchestrator } = setup({ sessionId, catalog, executeAiCall, catalogProjectionForSource });
      await orchestrator.runTurn({
        session_id: sessionId,
        message: 'x',
        picker_state: { current: 'self' },
        model_pref: {
          current: source_id === 'free_pool' ? 'free_pool' : 'byok',
          source_id,
        },
      });
      return promptBody<{ available_tools: Array<Record<string, unknown>> }>(calls[0]!)
        .available_tools;
    };
    const freePoolTools = await runFor('free_pool', 'sess-fp');
    const slot1Tools = await runFor('slot_1', 'sess-s1');
    const bySlug = (tools: Array<Record<string, unknown>>, slug: string) =>
      tools.find((t) => t.recipe_slug === slug)!;
    // free_pool → index: the Tier-2 entry is leaned (no args_schema).
    expect(bySlug(freePoolTools, 'recued-core/recipe.a')).not.toHaveProperty('args_schema');
    // slot_1 → full: the Tier-2 entry keeps its args_schema (baseline).
    expect(bySlug(slot1Tools, 'recued-core/recipe.a')).toHaveProperty('args_schema', {
      type: 'object',
    });
    // Tier-1 always full in both.
    expect(bySlug(freePoolTools, 'tier1.always')).toHaveProperty('args_schema');
    expect(bySlug(slot1Tools, 'tier1.always')).toHaveProperty('args_schema');
  });

  it('per-slot: a full turn DROPS the tools.search entry from presentation (byte-identical baseline)', async () => {
    // The wrapper is enabled construction-wide (enable-if-any-source-thins), so
    // tools.search appears in the registry on every turn. Presentation must drop
    // it on `full` turns so they stay byte-identical, while a thinning turn keeps
    // it. Model the wrapper's injection by putting a Tier-1 'tools.search' entry
    // in the catalog directly.
    const catalog: ReadonlyArray<ToolEntry> = [
      mkTool('tier1.always', 1),
      mkTool('tools.search', 1),
      mkTool('recued-core/recipe.a', 2),
    ];
    const catalogProjectionForSource = (
      source: ChatModelSourceId | undefined,
    ): ChatCatalogProjectionConfig =>
      source === 'free_pool' ? { mode: 'index' } : { mode: 'full' };
    const runFor = async (source_id: ChatModelSourceId, sessionId: string) => {
      const calls: CapturedAiCall[] = [];
      const executeAiCall = mkExecuteAiCall([{ body: aiOutput('ok') }], calls);
      const { orchestrator } = setup({ sessionId, catalog, executeAiCall, catalogProjectionForSource });
      await orchestrator.runTurn({
        session_id: sessionId,
        message: 'x',
        picker_state: { current: 'self' },
        model_pref: { current: source_id === 'free_pool' ? 'free_pool' : 'byok', source_id },
      });
      return promptBody<{ available_tools: Array<Record<string, unknown>> }>(calls[0]!)
        .available_tools.map((t) => t.recipe_slug);
    };
    // full (slot_1) → tools.search dropped from presentation.
    expect(await runFor('slot_1', 'sess-full-drop')).not.toContain('tools.search');
    // index (free_pool) → tools.search kept (its recall path).
    expect(await runFor('free_pool', 'sess-index-keep')).toContain('tools.search');
  });
});

describe('D-164 P6.3 tool-loop prompt threading', () => {
  it('threads per-round cumulative prior_tool_calls counts on reinvokes', async () => {
    // Mutation caught: reinvoke threads the wrong cumulative count of
    // prior_tool_calls per round (off-by-one, double-push, missing
    // push, or dropping `args` payload per round). The orchestrator's
    // `.slice()` snapshot at `priorToolCalls.slice()` is NOT directly
    // observable here — the inline composer serialises synchronously
    // before the executor sees the wire input, so the captured prompt
    // body is always a fresh JSON.parse'd object. This ratchet pins
    // the OBSERVABLE serialised contract: round 0 carries no
    // prior_tool_calls, round 1 carries exactly the round-0 dispatch,
    // round 2 carries the cumulative round-0 + round-1 dispatch in
    // chronological order.
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      { body: aiOutput('plan one', [toolCall('mail.search', { q: 'one' })]) },
      { body: aiOutput('plan two', [toolCall('mail.search', { q: 'two' })]) },
      { body: aiOutput('done') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'multi',
      picker_state: { current: 'self' },
    });

    const initial = promptBody(calls[0]!);
    const first = promptBody<{ prior_tool_calls: ReadonlyArray<{ args: { q: string } }> }>(calls[1]!);
    const second = promptBody<{ prior_tool_calls: ReadonlyArray<{ args: { q: string } }> }>(calls[2]!);
    expect(initial).not.toHaveProperty('prior_tool_calls');
    expect(first.prior_tool_calls).toHaveLength(1);
    expect(first.prior_tool_calls[0]?.args.q).toBe('one');
    expect(second.prior_tool_calls).toHaveLength(2);
    expect(second.prior_tool_calls[0]?.args.q).toBe('one');
    expect(second.prior_tool_calls[1]?.args.q).toBe('two');
  });
});

describe('D-164 P6.3 failure paths', () => {
  it('keeps validation failure details internal while shipping empty assistant content', async () => {
    // Mutation caught: validation issues leak externally, the orchestrator
    // persists the malformed body verbatim, OR validation runs AFTER
    // tool dispatch (the body's `tool_calls` is deliberately non-empty
    // so a `validate-after-dispatch` mutation would dispatch the call
    // and surface a non-zero `dispatched` count).
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([{
      body: {
        response: 42, // response_not_string — validation rejects
        events: [],
        tool_calls: [{ tool: 'mail.search', args: { q: 'should-not-fire' } }],
      },
    }], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: {} };
      },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'bad json',
      picker_state: { current: 'self' },
    });

    expect(dispatched).toBe(0);
    expect(eventsByKind('chat.tool_call_started')).toHaveLength(0);
    const finalMsg = await finalAssistant(sessionId);
    expect(finalMsg).toMatchObject({ content: '' });
    expect(finalMsg?.tool_calls).toBeUndefined();
    expect(eventsByKind('engine.budget_exceeded')).toHaveLength(1);
    expect(captured.find((event) => event.kind === 'chat.message_complete')).toBeDefined();
    expect(JSON.stringify(captured)).not.toContain('validation_issues');
    expect(JSON.stringify(captured)).not.toContain('response_not_string');
  });

  it('keeps the no-executor path silent but emits budget_exceeded on executor throw', async () => {
    // Mutation caught: no-executor fallback emits engine.budget_exceeded as if a provider failed.
    const noExecutor = setup({
      sessionId: 'sess-no-executor',
      catalog: [mkTool('mail.search', 1)],
    });
    await noExecutor.orchestrator.runTurn({
      session_id: noExecutor.sessionId,
      message: 'quiet',
      picker_state: { current: 'self' },
    });
    expect(await finalAssistant(noExecutor.sessionId)).toMatchObject({ content: '' });
    expect(captured.find((event) => event.kind === 'chat.message_complete')).toBeDefined();
    expect(eventsByKind('engine.budget_exceeded')).toHaveLength(0);

    captured = [];
    const throwing = setup({
      sessionId: 'sess-throw',
      executeAiCall: mkExecuteAiCall([{ throws: new Error('upstream down') }], []),
    });
    await throwing.orchestrator.runTurn({
      session_id: throwing.sessionId,
      message: 'throw',
      picker_state: { current: 'self' },
    });
    expect(eventsByKind('engine.budget_exceeded')).toHaveLength(1);
  });

  it('preserves prior assistant content and dispatch provenance on mid-loop abort', async () => {
    // Mutation caught: mid-loop abort clears the last valid AI response.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      { body: aiOutput('I will search first.', [toolCall()]) },
      { throws: new Error('reinvoke failed') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { hits: [1] } };
      },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'abort after tool',
      picker_state: { current: 'self' },
    });

    expect(dispatched).toBe(1);
    expect(eventsByKind('recued.multi_turn.round_completed')).toMatchObject([{ outcome: 'aborted' }]);
    expect(eventsByKind('engine.budget_exceeded')).toMatchObject([{ total_calls: 2 }]);
    expect(eventsByKind('recued.multi_turn.loop_terminated')).toMatchObject([
      { termination_reason: 'aborted' },
    ]);
    const assistant = await finalAssistant(sessionId);
    expect(assistant?.content).toBe('I will search first.');
    expect(assistant?.tool_calls?.[0]).toMatchObject({ tool_name: 'mail.search', status: 'ok' });
  });
});

describe('D-164 P6.3 multi-round loop boundaries', () => {
  it('keeps round_started tier + every executeAiCall model_hint at fast across reinvoke rounds', async () => {
    // Mutation caught: multi-round tier drifts to mid or reasoning, OR
    // the reinvoke `llm.model_hint` diverges from the initial call's
    // hint while the transparency event still echoes 'fast'. The
    // broadcast-only check would silently pass when the LLM routing
    // hint drifts; pinning every captured `executeAiCall` input
    // catches that.
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      { body: aiOutput('round 0', [toolCall()]) },
      { body: aiOutput('round 1', [toolCall()]) },
      { body: aiOutput('done') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'rounds',
      picker_state: { current: 'self' },
    });

    const started = eventsByKind('recued.multi_turn.round_started');
    expect(started).toHaveLength(2);
    expect(started.every((event) => event.tier === 'fast')).toBe(true);
    // Initial + two reinvokes = 3 captured `executeAiCall` invocations.
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.input['llm.model_hint'] === modelTierToModelHint('fast'))).toBe(true);
  });

  it('aggregates token usage from initial and reinvoke calls', async () => {
    // Mutation caught: token usage aggregation only counts the last round.
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      { body: aiOutput('round 0', [toolCall()]), usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
      { body: aiOutput('round 1', [toolCall()]), usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 } },
      { body: aiOutput('done'), usage: { input_tokens: 6, output_tokens: 7, total_tokens: 13 } },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      executeAiCall,
    });

    const ack = await orchestrator.runTurn({
      session_id: sessionId,
      message: 'usage',
      picker_state: { current: 'self' },
    });

    const expected = { input_tokens: 11, output_tokens: 14, total_tokens: 25 };
    expect(ack.total_usage).toEqual(expected);
    expect(eventsByKind('recued.token_usage')).toMatchObject([expected]);
  });

  it('lets the cap-boundary reinvoke synthesize and terminate completed', async () => {
    // Mutation caught: loop cap fires before the final allowed AI reinvoke.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall((index) => ({
      body: index < CHAT_MAIN_TURN_TOOL_LOOP_CAP
        ? aiOutput(`tool-${index}`, [toolCall()])
        : aiOutput('final synthesis'),
    }), calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { dispatched } };
      },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'cap boundary',
      picker_state: { current: 'self' },
    });

    expect(calls).toHaveLength(CHAT_MAIN_TURN_TOOL_LOOP_CAP + 1);
    expect(dispatched).toBe(CHAT_MAIN_TURN_TOOL_LOOP_CAP);
    expect(eventsByKind('recued.multi_turn.loop_terminated')).toMatchObject([
      { termination_reason: 'completed' },
    ]);
    expect(await finalAssistant(sessionId)).toMatchObject({ content: 'final synthesis' });
  });

  it('halts always-more-tools exactly at max_rounds_exhausted', async () => {
    // Mutation caught: always-more-tools loop exits before the configured cap.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall(() => ({
      body: aiOutput('more tools', [toolCall()]),
    }), calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { dispatched } };
      },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'always more',
      picker_state: { current: 'self' },
    });

    const completed = eventsByKind('recued.multi_turn.round_completed');
    expect(calls).toHaveLength(CHAT_MAIN_TURN_TOOL_LOOP_CAP + 1);
    expect(dispatched).toBe(CHAT_MAIN_TURN_TOOL_LOOP_CAP);
    expect(completed).toHaveLength(CHAT_MAIN_TURN_TOOL_LOOP_CAP);
    expect(completed.every((event) => event.outcome === 'continue')).toBe(true);
    expect(eventsByKind('recued.multi_turn.loop_terminated')).toMatchObject([
      { termination_reason: 'max_rounds_exhausted' },
    ]);
  });
});

describe('D-164 P6.3 chat history and retired emissions', () => {
  it('captures chat_tail before appending the current user message', async () => {
    // Mutation caught: current user message is duplicated into chat_tail.
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([{ body: aiOutput('ok') }], calls);
    const { orchestrator, sessionId } = setup({ executeAiCall });
    await store.appendMessage({
      id: 'prior-user',
      session_id: sessionId,
      role: 'user',
      content: 'prior question',
      target_server: 'self',
      picker_at_send: { display_name: 'Self', signature: selfSignature },
      model_used: { provider: 'local', model_id: 'm' },
      ts: 1001,
    });
    await store.appendMessage({
      id: 'prior-assistant',
      session_id: sessionId,
      role: 'assistant',
      content: 'prior answer',
      target_server: 'self',
      picker_at_send: { display_name: 'Self', signature: selfSignature },
      model_used: { provider: 'local', model_id: 'm' },
      ts: 1002,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'current question',
      picker_state: { current: 'self' },
    });

    const parsed = promptBody<{ chat_tail: Array<{ content: string }>; user_message: string }>(
      calls[0]!,
    );
    expect(parsed.chat_tail.map((message) => message.content)).toEqual([
      'prior question',
      'prior answer',
    ]);
    expect(parsed.user_message).toBe('current question');
    expect(parsed.chat_tail.some((message) => message.content === 'current question')).toBe(false);
  });

  it('does not emit retired context_filtered or stage1_fallback transparency events', async () => {
    // Mutation caught: retired Stage-1 transparency paths are reintroduced.
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      { body: aiOutput('plan', [toolCall()]) },
      { body: aiOutput('done') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'retired events',
      picker_state: { current: 'self' },
    });

    const emittedKinds = transparencyEvents().map((event) => event.kind);
    expect(emittedKinds).not.toContain('engine.context_filtered');
    expect(emittedKinds).not.toContain('engine.stage1_fallback');
    expect(emittedKinds).toContain('recued.multi_turn.round_started');
  });
});

// ────────────────────────────────────────────────────────────────
// D-164 § 6 — chat-orchestrator wires `dispatchToolCalls`.
//
// The orchestrator's tool-loop replaced its sequential for-loop with
// the framework's `dispatchToolCalls` primitive. Strategy is decided
// per-batch from each emitted tool's `concurrency_safe` flag (off the
// resolved ToolEntry). All-safe → parallel; any-unsafe → sequential.
// These cases observe the strategy via per-call timing through a
// stub `dispatchImpl` that records start-order vs completion-order
// and pauses on a controllable async barrier.
// ────────────────────────────────────────────────────────────────

describe('D-164 § 6 chat-orchestrator dispatchToolCalls wiring', () => {
  // A barrier-style stub: each invocation pushes a deferred and waits
  // for the test to release it. Records start order on push and resolve
  // order on settle so we can compare "parallel" (all start before any
  // resolve) vs "sequential" (each starts only after the previous
  // resolves).
  interface DispatchTrace {
    readonly starts: ReadonlyArray<string>;
    readonly settles: ReadonlyArray<string>;
  }

  const makeBarrierDispatch = (): {
    dispatchImpl: (name: string, args: unknown, ctx: ChatDispatchContext) => Promise<ChatDispatchResult>;
    releaseAll: () => void;
    trace: DispatchTrace;
  } => {
    const starts: string[] = [];
    const settles: string[] = [];
    const pending: Array<() => void> = [];
    const release = (): void => {
      for (const resolve of pending) resolve();
      pending.length = 0;
    };
    const dispatchImpl = async (name: string): Promise<ChatDispatchResult> => {
      starts.push(name);
      await new Promise<void>((resolve) => { pending.push(resolve); });
      settles.push(name);
      return { ok: true, result: { name } };
    };
    return {
      dispatchImpl,
      releaseAll: release,
      trace: { starts, get settles() { return settles; } },
    };
  };

  it('all-concurrency_safe tool batch dispatches in parallel (every call starts before any resolves)', async () => {
    // Mutation caught: orchestrator falls back to a sequential for-loop
    // (the pre-fold code path). Sequential dispatch would start `b`
    // only after `a` resolved, but the barrier holds every call before
    // resolution — so a sequential loop would deadlock here. Parallel
    // dispatch starts both calls THEN waits for the batch to settle.
    const { dispatchImpl, releaseAll, trace } = makeBarrierDispatch();
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      {
        body: aiOutput('plan', [
          toolCall('mail.search', { q: 'a' }),
          toolCall('calendar.search', { q: 'b' }),
        ]),
      },
      { body: aiOutput('done') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [
        mkTool('mail.search', 1, { concurrency_safe: true }),
        mkTool('calendar.search', 1, { concurrency_safe: true }),
      ],
      dispatchImpl,
      executeAiCall,
    });

    // Schedule release after the orchestrator has had time to start
    // both calls in parallel mode. A sequential implementation would
    // call `mail.search`, await it (hang on the barrier), and never
    // call `calendar.search` until release. Releasing once is enough
    // because parallel mode awaits a single allSettled batch.
    const turnPromise = orchestrator.runTurn({
      session_id: sessionId,
      message: 'parallel',
      picker_state: { current: 'self' },
    });
    // Pump the microtask queue so dispatchToolCalls' parallel
    // Promise.allSettled wrap kicks off all `executeOne` invocations
    // before we release.
    await new Promise((resolve) => setImmediate(resolve));
    expect([...trace.starts]).toEqual(['mail.search', 'calendar.search']);
    expect(trace.settles).toEqual([]);
    releaseAll();
    await turnPromise;

    expect([...trace.starts]).toEqual(['mail.search', 'calendar.search']);
    expect([...trace.settles].sort()).toEqual(['calendar.search', 'mail.search']);
  });

  it('any-unsafe tool batch collapses to sequential dispatch (later calls wait for earlier to settle)', async () => {
    // Mutation caught: orchestrator runs unsafe batches in parallel
    // (corruption hazard for mutation recipes through the gateway). A
    // single false in the batch must force sequential; observed by the
    // start-order pause — `b` doesn't appear in `starts` until `a`
    // has resolved.
    const { dispatchImpl, releaseAll, trace } = makeBarrierDispatch();
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      {
        body: aiOutput('plan', [
          toolCall('mail.search', { q: 'a' }),
          toolCall('recipe.run', { recipe_id: 'b' }),
        ]),
      },
      { body: aiOutput('done') },
    ], calls);
    // Drive the unsafe flag from the registry — recipe.run is sealed
    // false in production by TIER1_CONCURRENCY_SAFE, so this fixture
    // mirrors the real default. mail.search keeps its production-true
    // value to prove "any false collapses the batch."
    const { orchestrator, sessionId } = setup({
      catalog: [
        mkTool('mail.search', 1, { concurrency_safe: true }),
        mkTool('recipe.run', 1, { classification: 'unknown', concurrency_safe: false }),
      ],
      dispatchImpl,
      executeAiCall,
    });

    const turnPromise = orchestrator.runTurn({
      session_id: sessionId,
      message: 'sequential',
      picker_state: { current: 'self' },
    });
    // After microtask flush, sequential mode has started only the
    // first call.
    await new Promise((resolve) => setImmediate(resolve));
    expect([...trace.starts]).toEqual(['mail.search']);
    // Release pending calls one at a time. The framework's sequential
    // loop awaits each before issuing the next, so releasing once
    // resolves the first, and the second starts on the next
    // microtask.
    releaseAll();
    await new Promise((resolve) => setImmediate(resolve));
    expect([...trace.starts]).toEqual(['mail.search', 'recipe.run']);
    releaseAll();
    await turnPromise;

    // Sequential preserves emit order in both start and settle.
    expect([...trace.starts]).toEqual(['mail.search', 'recipe.run']);
    expect([...trace.settles]).toEqual(['mail.search', 'recipe.run']);
  });

  it('parallel batch preserves emit order in prior_tool_calls even when calls settle out of order', async () => {
    // Mutation caught: parallel mode re-orders `prior_tool_calls` by
    // settle order (or by Promise.allSettled fulfilment order) rather
    // than by emit order. The framework's `dispatchToolCalls` returns
    // `results` in input order even when settles are out of order; the
    // orchestrator's accumulator iterates `results[i]` by index, so
    // order is pinned all the way through to the reinvoke's
    // `prior_tool_calls` array. Test releases the SECOND call before
    // the first to force out-of-order settle.
    const starts: string[] = [];
    const settles: string[] = [];
    const pending: Map<string, () => void> = new Map();
    const dispatchImpl = async (name: string): Promise<ChatDispatchResult> => {
      starts.push(name);
      await new Promise<void>((resolve) => { pending.set(name, resolve); });
      settles.push(name);
      return { ok: true, result: { name } };
    };
    const releaseByName = (name: string): void => {
      const resolve = pending.get(name);
      if (resolve) {
        pending.delete(name);
        resolve();
      }
    };
    const aiCalls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      {
        body: aiOutput('plan', [
          toolCall('mail.search', { q: 'a' }),
          toolCall('calendar.search', { q: 'b' }),
        ]),
      },
      { body: aiOutput('done') },
    ], aiCalls);
    const { orchestrator, sessionId } = setup({
      catalog: [
        mkTool('mail.search', 1, { concurrency_safe: true }),
        mkTool('calendar.search', 1, { concurrency_safe: true }),
      ],
      dispatchImpl,
      executeAiCall,
    });

    const turnPromise = orchestrator.runTurn({
      session_id: sessionId,
      message: 'parallel out-of-order',
      picker_state: { current: 'self' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect([...starts]).toEqual(['mail.search', 'calendar.search']);
    // Release the SECOND call first; this lands its settle before the
    // first call's.
    releaseByName('calendar.search');
    await new Promise((resolve) => setImmediate(resolve));
    releaseByName('mail.search');
    await turnPromise;

    expect([...settles]).toEqual(['calendar.search', 'mail.search']);
    // Reinvoke (the AI's second turn) sees prior_tool_calls in EMIT
    // order, not settle order. The contract is "the LLM observes the
    // batch as a whole" in input order regardless of dispatch
    // strategy. `ChatPriorToolCall.tool_name` is the canonical key.
    const second = promptBody<{ prior_tool_calls: ReadonlyArray<{ tool_name: string }> }>(
      aiCalls[1]!,
    );
    expect(second.prior_tool_calls.map((p) => p.tool_name)).toEqual([
      'mail.search',
      'calendar.search',
    ]);
  });

  it('peer-target parallel batch routes through peerDispatcher.listToolEntries and dispatches in parallel', async () => {
    // Mutation caught: the peer-target branch of the
    // `resolveConcurrencySafe` helper falls back to `false` regardless
    // of peer ToolEntry flags (a regression on the
    // `peerDispatcher.listToolEntries(peerName)` lookup) — the peer-
    // routed batch would collapse to sequential even when every peer
    // tool declared `concurrency_safe: true`. Exercises the same
    // barrier-stub pattern as the self-target case but via the peer
    // dispatcher.
    const starts: string[] = [];
    const settles: string[] = [];
    const pending: Array<() => void> = [];
    const peerDispatchImpl: PeerDispatcher['dispatch'] = async (args) => {
      starts.push(args.tool_name);
      await new Promise<void>((resolve) => { pending.push(resolve); });
      settles.push(args.tool_name);
      return { ok: true, result: { tool: args.tool_name } };
    };
    const releaseAll = (): void => {
      for (const resolve of pending) resolve();
      pending.length = 0;
    };
    const peerCatalog: ReadonlyArray<ToolEntry> = [
      mkTool('peer.alpha', 3, {
        classification: 'read',
        concurrency_safe: true,
      }),
      mkTool('peer.beta', 3, {
        classification: 'read',
        concurrency_safe: true,
      }),
    ];
    const aiCalls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      {
        body: aiOutput('plan', [
          toolCall('peer.alpha', { q: 'a' }),
          toolCall('peer.beta', { q: 'b' }),
        ]),
      },
      { body: aiOutput('done') },
    ], aiCalls);
    const { orchestrator, sessionId } = setup({
      // Self registry is empty — peer-target lookups go through the
      // peer dispatcher's `listToolEntries`. If a mutation swapped the
      // resolver to use `deps.registry.getByName` on the peer path,
      // both tools would default to `false` (unknown to the self
      // registry) and collapse to sequential.
      catalog: [],
      peerDispatcher: mkPeerDispatcher(peerCatalog, peerDispatchImpl),
      executeAiCall,
    });

    const turnPromise = orchestrator.runTurn({
      session_id: sessionId,
      message: 'peer parallel',
      picker_state: { current: 'connection.mcp.peer' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect([...starts]).toEqual(['peer.alpha', 'peer.beta']);
    expect(settles).toEqual([]);
    releaseAll();
    await turnPromise;

    expect([...starts]).toEqual(['peer.alpha', 'peer.beta']);
    expect([...settles].sort()).toEqual(['peer.alpha', 'peer.beta']);
  });

  it('absent registry entry defaults the per-call flag to false (sequential dispatch)', async () => {
    // Mutation caught: the orchestrator falls through to `true` (or any
    // truthy default) when a tool is not in the registry. Defense in
    // depth: unknown tools MUST default sequential — a parallel dispatch
    // on an unclassifiable tool could batch a mutation with a read.
    const { dispatchImpl, releaseAll, trace } = makeBarrierDispatch();
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      {
        body: aiOutput('plan', [
          toolCall('mail.search', { q: 'a' }),
          toolCall('ghost.tool', { q: 'b' }),
        ]),
      },
      { body: aiOutput('done') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      // Only mail.search is in the registry; ghost.tool is unknown.
      catalog: [mkTool('mail.search', 1, { concurrency_safe: true })],
      dispatchImpl,
      executeAiCall,
    });

    const turnPromise = orchestrator.runTurn({
      session_id: sessionId,
      message: 'unknown collapses',
      picker_state: { current: 'self' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Sequential — only the first call started. (If unknown defaulted
    // to true, both would have started.)
    expect([...trace.starts]).toEqual(['mail.search']);
    releaseAll();
    await new Promise((resolve) => setImmediate(resolve));
    releaseAll();
    await turnPromise;
    expect([...trace.starts]).toEqual(['mail.search', 'ghost.tool']);
  });
});

describe('D-164 P6.3 cap-exit empty-content fail-loud', () => {
  const budgetMessageNeedle = 'tool budget before finishing an answer';
  const continueNeedle = 'Ask it to continue';

  it('replaces cap-empty always-more-tools content without an extra model call', async () => {
    // Mutation caught: cap-empty branch persists a silent assistant bubble or spends past the cap.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall(() => ({
      body: aiOutput('', [toolCall()]),
    }), calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { dispatched } };
      },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'always more empty',
      picker_state: { current: 'self' },
    });

    const assistant = await finalAssistant(sessionId);
    expect(assistant?.content).toContain(budgetMessageNeedle);
    expect(assistant?.content).toContain(continueNeedle);
    expect(calls).toHaveLength(CHAT_MAIN_TURN_TOOL_LOOP_CAP + 1);
    expect(dispatched).toBe(CHAT_MAIN_TURN_TOOL_LOOP_CAP);
    expect(eventsByKind('recued.multi_turn.loop_terminated')).toMatchObject([
      {
        total_rounds: CHAT_MAIN_TURN_TOOL_LOOP_CAP,
        termination_reason: 'max_rounds_exhausted',
      },
    ]);
  });

  it('treats whitespace-only cap planning response as empty content', async () => {
    // Mutation caught: cap-empty trigger checks raw length instead of trimmed response text.
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall((index) => ({
      body: aiOutput(
        index < CHAT_MAIN_TURN_TOOL_LOOP_CAP ? `round-${index}` : '  \n',
        [toolCall()],
      ),
    }), calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'whitespace at cap',
      picker_state: { current: 'self' },
    });

    const assistant = await finalAssistant(sessionId);
    expect(assistant?.content).toContain(budgetMessageNeedle);
    expect(assistant?.content).toContain(continueNeedle);
    expect(calls).toHaveLength(CHAT_MAIN_TURN_TOOL_LOOP_CAP + 1);
    expect(eventsByKind('recued.multi_turn.loop_terminated')).toMatchObject([
      { termination_reason: 'max_rounds_exhausted' },
    ]);
  });

  it('ships non-empty cap planning response unchanged', async () => {
    // Mutation caught: cap-exit fail-loud message overwrites a useful partial answer.
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall((index) => ({
      body: aiOutput(
        index < CHAT_MAIN_TURN_TOOL_LOOP_CAP
          ? `round-${index}`
          : 'partial answer from cap',
        [toolCall()],
      ),
    }), calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'partial at cap',
      picker_state: { current: 'self' },
    });

    const assistant = await finalAssistant(sessionId);
    expect(assistant?.content).toBe('partial answer from cap');
    expect(assistant?.content).not.toContain(budgetMessageNeedle);
    expect(calls).toHaveLength(CHAT_MAIN_TURN_TOOL_LOOP_CAP + 1);
    expect(eventsByKind('recued.multi_turn.loop_terminated')).toMatchObject([
      { termination_reason: 'max_rounds_exhausted' },
    ]);
  });

  it('does not let non-empty cap events gate the empty-content message', async () => {
    // Mutation caught: cap-empty trigger requires events to be empty before replacing the bubble.
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall((index) => ({
      body: index < CHAT_MAIN_TURN_TOOL_LOOP_CAP
        ? aiOutput(`round-${index}`, [toolCall()])
        : ({
            response: '',
            events: [
              {
                kind: 'extraction.note',
                confidence: 0.9,
                args: { note: 'cap marker' },
              },
            ],
            tool_calls: [toolCall()],
          } satisfies AIOutput),
    }), calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'events at cap',
      picker_state: { current: 'self' },
    });

    const assistant = await finalAssistant(sessionId);
    expect(assistant?.content).toContain(budgetMessageNeedle);
    expect(assistant?.content).toContain(continueNeedle);
    expect(calls).toHaveLength(CHAT_MAIN_TURN_TOOL_LOOP_CAP + 1);
    expect(eventsByKind('recued.multi_turn.loop_terminated')).toMatchObject([
      { termination_reason: 'max_rounds_exhausted' },
    ]);
  });

  it('keeps loop-final double-empty recovery on the completed branch', async () => {
    // Mutation caught: loop-final empty recovery collides with the cap-exit budget message.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      { body: aiOutput('plan', [toolCall()]) },
      { body: {} },
      { body: aiOutput('') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { dispatched } };
      },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'double empty after tool',
      picker_state: { current: 'self' },
    });

    const assistant = await finalAssistant(sessionId);
    expect(assistant?.content).toContain('returned an empty reply twice');
    expect(assistant?.content).not.toContain(budgetMessageNeedle);
    expect(calls).toHaveLength(3);
    expect(dispatched).toBe(1);
    expect(eventsByKind('recued.multi_turn.round_completed')).toMatchObject([
      { outcome: 'completed' },
    ]);
    expect(eventsByKind('recued.multi_turn.loop_terminated')).toMatchObject([
      { total_rounds: 1, termination_reason: 'completed' },
    ]);
  });

  it('preserves dispatched tool provenance on the cap-empty assistant message', async () => {
    // Mutation caught: cap-empty replacement clears persisted assistant tool_call provenance.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall(() => ({
      body: aiOutput('', [toolCall()]),
    }), calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { dispatched } };
      },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'cap provenance',
      picker_state: { current: 'self' },
    });

    const assistant = await finalAssistant(sessionId);
    expect(assistant?.content).toContain(budgetMessageNeedle);
    expect(assistant?.tool_calls).toHaveLength(CHAT_MAIN_TURN_TOOL_LOOP_CAP);
    expect(assistant?.tool_calls?.[0]).toMatchObject({
      tool_name: 'mail.search',
      status: 'ok',
      args: { q: 'x' },
    });
    expect(assistant?.tool_calls?.[CHAT_MAIN_TURN_TOOL_LOOP_CAP - 1]).toMatchObject({
      tool_name: 'mail.search',
      status: 'ok',
    });
    expect(calls).toHaveLength(CHAT_MAIN_TURN_TOOL_LOOP_CAP + 1);
    expect(dispatched).toBe(CHAT_MAIN_TURN_TOOL_LOOP_CAP);
  });
});

describe('D-164 P6.3 abort-exit provider-failure fail-loud', () => {
  const providerFailedNeedle = 'provider failed partway';
  const toolsRanNeedle = 'tools had already run';
  const noSourceNeedle = 'No AI model is available';

  it('replaces round-0 abort-empty stale planning with the provider-failed message', async () => {
    // Mutation caught: abort-empty branch persists a silent assistant bubble or loses abort accounting.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      { body: aiOutput('', [toolCall()]) },
      { throws: new Error('socket hang up') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { dispatched } };
      },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'abort empty',
      picker_state: { current: 'self' },
    });

    const assistant = await finalAssistant(sessionId);
    expect(assistant?.content).toContain(providerFailedNeedle);
    expect(assistant?.content).toContain(toolsRanNeedle);
    expect(calls).toHaveLength(2);
    expect(dispatched).toBe(1);
    expect(eventsByKind('recued.multi_turn.round_completed')).toMatchObject([
      { outcome: 'aborted' },
    ]);
    expect(eventsByKind('recued.multi_turn.loop_terminated')).toMatchObject([
      { termination_reason: 'aborted' },
    ]);
    expect(eventsByKind('engine.budget_exceeded')).toMatchObject([{ total_calls: 2 }]);
  });

  it('uses the no-source message when the abort detail is a matcher no-source failure', async () => {
    // Mutation caught: abort-empty no-source failures show the generic provider-failed copy.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      { body: aiOutput('', [toolCall()]) },
      { throws: new Error('No LLM source matches requirements (speed: fast, json)') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { dispatched } };
      },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'abort no source',
      picker_state: { current: 'self' },
    });

    const assistant = await finalAssistant(sessionId);
    expect(assistant?.content).toContain(noSourceNeedle);
    expect(assistant?.content).not.toContain(providerFailedNeedle);
    expect(calls).toHaveLength(2);
    expect(dispatched).toBe(1);
    expect(eventsByKind('recued.multi_turn.round_completed')).toMatchObject([
      { outcome: 'aborted' },
    ]);
    expect(eventsByKind('engine.budget_exceeded')).toMatchObject([{ total_calls: 2 }]);
  });

  it('ships non-empty stale planning text unchanged on abort', async () => {
    // Mutation caught: abort-exit fail-loud copy overwrites a useful partial planning response.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      { body: aiOutput('Checking your contacts now.', [toolCall()]) },
      { throws: new Error('socket hang up') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { dispatched } };
      },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'abort with partial planning',
      picker_state: { current: 'self' },
    });

    const assistant = await finalAssistant(sessionId);
    expect(assistant?.content).toBe('Checking your contacts now.');
    expect(assistant?.content).not.toContain(providerFailedNeedle);
    expect(calls).toHaveLength(2);
    expect(dispatched).toBe(1);
    expect(eventsByKind('recued.multi_turn.loop_terminated')).toMatchObject([
      { termination_reason: 'aborted' },
    ]);
  });

  it('treats whitespace-only abort stale response as empty content', async () => {
    // Mutation caught: abort-empty trigger checks raw response length instead of trimmed response text.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      { body: aiOutput('  \n', [toolCall()]) },
      { throws: new Error('socket hang up') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { dispatched } };
      },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'abort whitespace',
      picker_state: { current: 'self' },
    });

    const assistant = await finalAssistant(sessionId);
    expect(assistant?.content).toContain(providerFailedNeedle);
    expect(assistant?.content).toContain(toolsRanNeedle);
    expect(calls).toHaveLength(2);
    expect(dispatched).toBe(1);
    expect(eventsByKind('engine.budget_exceeded')).toMatchObject([{ total_calls: 2 }]);
  });

  it('accounts for a round-1 abort after one successful continue round', async () => {
    // Mutation caught: abort accounting drops the completed prior round or fails to replace empty round-1 stale content.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      { body: aiOutput('', [toolCall()]) },
      { body: aiOutput('', [toolCall()]) },
      { throws: new Error('boom') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { dispatched } };
      },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'abort on second round',
      picker_state: { current: 'self' },
    });

    const assistant = await finalAssistant(sessionId);
    expect(assistant?.content).toContain(providerFailedNeedle);
    expect(calls).toHaveLength(3);
    expect(dispatched).toBe(2);
    expect(eventsByKind('recued.multi_turn.round_completed')).toMatchObject([
      { outcome: 'continue' },
      { outcome: 'aborted' },
    ]);
    expect(eventsByKind('recued.multi_turn.loop_terminated')).toMatchObject([
      { termination_reason: 'aborted' },
    ]);
    expect(eventsByKind('engine.budget_exceeded')).toMatchObject([{ total_calls: 3 }]);
  });

  it('includes the initial empty-output recovery retry in abort total_calls', async () => {
    // Mutation caught: abort `total_calls` omits the initial empty-output recovery retry.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      { body: {} },
      { body: aiOutput('', [toolCall()]) },
      { throws: new Error('boom') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { dispatched } };
      },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'empty recovery then abort',
      picker_state: { current: 'self' },
    });

    const assistant = await finalAssistant(sessionId);
    expect(assistant?.content).toContain(providerFailedNeedle);
    expect(calls).toHaveLength(3);
    expect(dispatched).toBe(1);
    expect(eventsByKind('recued.multi_turn.round_completed')).toMatchObject([
      { outcome: 'aborted' },
    ]);
    expect(eventsByKind('engine.budget_exceeded')).toMatchObject([{ total_calls: 3 }]);
  });

  it('preserves dispatched tool provenance on the abort-empty assistant message', async () => {
    // Mutation caught: abort-empty replacement clears persisted assistant tool_call provenance.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const executeAiCall = mkExecuteAiCall([
      { body: aiOutput('', [toolCall()]) },
      { body: aiOutput('', [toolCall()]) },
      { throws: new Error('boom') },
    ], calls);
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { dispatched } };
      },
      executeAiCall,
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'abort provenance',
      picker_state: { current: 'self' },
    });

    const assistant = await finalAssistant(sessionId);
    const toolCalls = assistant?.tool_calls ?? [];
    expect(assistant?.content).toContain(providerFailedNeedle);
    expect(toolCalls).toHaveLength(dispatched);
    expect(toolCalls.map(({ tool_name, status }) => ({ tool_name, status }))).toEqual([
      { tool_name: 'mail.search', status: 'ok' },
      { tool_name: 'mail.search', status: 'ok' },
    ]);
    expect(calls).toHaveLength(3);
    expect(dispatched).toBe(2);
  });
});

describe('D-164 P6.3 decoder_unavailable emission', () => {
  const decoderEvents = () =>
    eventsByKind('engine.decoder_unavailable').map((event) => ({
      reason: event.reason,
      site: event.site,
    }));

  const expectDecoderAfterBudget = () => {
    const order = transparencyEvents().map((event) => event.kind);
    const budgetIndex = order.lastIndexOf('engine.budget_exceeded');
    const decoderIndex = order.lastIndexOf('engine.decoder_unavailable');
    expect(budgetIndex).toBeGreaterThanOrEqual(0);
    expect(decoderIndex).toBeGreaterThan(budgetIndex);
  };

  it('emits initial provider_failure after budget accounting and leaves the assistant body empty', async () => {
    // Mutation caught: initial executor throw emits no decoder event, emits it before budget accounting, or leaks provider detail into chat.
    const { orchestrator, sessionId } = setup({
      executeAiCall: mkExecuteAiCall([{ throws: new Error('upstream down') }], []),
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'provider failure',
      picker_state: { current: 'self' },
    });

    expect(decoderEvents()).toEqual([
      { reason: 'provider_failure', site: 'initial' },
    ]);
    expectDecoderAfterBudget();
    expect(await finalAssistant(sessionId)).toMatchObject({ content: '' });
  });

  it('classifies initial matcher no-source failures and ships the model-source message', async () => {
    // Mutation caught: matcher no-source details fall through to provider_failure or keep the silent empty body.
    const { orchestrator, sessionId } = setup({
      executeAiCall: mkExecuteAiCall([
        { throws: new Error('No LLM source matches requirements (speed: fast)') },
      ], []),
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'need a model',
      picker_state: { current: 'self' },
    });

    expect(decoderEvents()).toEqual([
      { reason: 'no_source', site: 'initial' },
    ]);
    expectDecoderAfterBudget();
    expect((await finalAssistant(sessionId))?.content).toContain(
      'No AI model is available',
    );
  });

  it('classifies present-but-wrong-typed AIOutput fields as invalid_output', async () => {
    // Mutation caught: validation failures are collapsed into provider_failure or masked by coerceAIOutput.
    const calls: CapturedAiCall[] = [];
    const { orchestrator, sessionId } = setup({
      executeAiCall: mkExecuteAiCall([{ body: { response: 42 } }], calls),
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'bad output',
      picker_state: { current: 'self' },
    });

    expect(calls).toHaveLength(1);
    expect(decoderEvents()).toEqual([
      { reason: 'invalid_output', site: 'initial' },
    ]);
    expectDecoderAfterBudget();
  });

  it('emits exactly one tool-loop provider_failure decoder event after the abort budget event', async () => {
    // Mutation caught: mid-loop abort misses the decoder event, emits duplicates, or paints it before abort accounting.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { hits: [1] } };
      },
      executeAiCall: mkExecuteAiCall([
        { body: aiOutput('I will search first.', [toolCall()]) },
        { throws: new Error('reinvoke failed') },
      ], calls),
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'abort after tool',
      picker_state: { current: 'self' },
    });

    expect(calls).toHaveLength(2);
    expect(dispatched).toBe(1);
    expect(decoderEvents()).toEqual([
      { reason: 'provider_failure', site: 'tool_loop' },
    ]);
    expectDecoderAfterBudget();
    expect(eventsByKind('recued.multi_turn.loop_terminated')).toMatchObject([
      { termination_reason: 'aborted' },
    ]);
  });

  it('keeps no-executor turns silent for decoder and budget failure events', async () => {
    // Mutation caught: no-executor fallback is reported as a provider failure.
    const { orchestrator, sessionId } = setup({
      sessionId: 'sess-decoder-no-executor',
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'quiet substrate',
      picker_state: { current: 'self' },
    });

    expect(await finalAssistant(sessionId)).toMatchObject({ content: '' });
    expect(eventsByKind('engine.budget_exceeded')).toHaveLength(0);
    expect(decoderEvents()).toEqual([]);
  });

  it('classifies tool-loop matcher no-source aborts as no_source', async () => {
    // Mutation caught: mid-loop no-source abort details fall through to provider_failure.
    let dispatched = 0;
    const calls: CapturedAiCall[] = [];
    const { orchestrator, sessionId } = setup({
      catalog: [mkTool('mail.search', 1)],
      dispatchImpl: async () => {
        dispatched += 1;
        return { ok: true, result: { hits: [1] } };
      },
      executeAiCall: mkExecuteAiCall([
        { body: aiOutput('', [toolCall()]) },
        { throws: new Error('No LLM source matches requirements (speed: fast, json)') },
      ], calls),
    });

    await orchestrator.runTurn({
      session_id: sessionId,
      message: 'abort no source',
      picker_state: { current: 'self' },
    });

    expect(calls).toHaveLength(2);
    expect(dispatched).toBe(1);
    expect(decoderEvents()).toEqual([
      { reason: 'no_source', site: 'tool_loop' },
    ]);
    expectDecoderAfterBudget();
    expect(eventsByKind('recued.multi_turn.loop_terminated')).toMatchObject([
      { termination_reason: 'aborted' },
    ]);
    expect((await finalAssistant(sessionId))?.content).toContain(
      'No AI model is available',
    );
  });
});