/** D-160 P3 — messenger execution-source + dispatch-depth thread-through.
 *
 *  This file pins the places where a messenger turn must stay a messenger
 *  turn after it enters the shared chat substrate: tool dispatch identity,
 *  execute-handler policy gating, prompt-cache read permission, and the
 *  middleware framework's TurnContext.source stamp. The regression class is
 *  over-granting by silently falling back to chat-shaped or surface-derived
 *  identities when a real channel-minted source exists.
 */

import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';


import Database from 'better-sqlite3';
import {
  createInMemorySessionStore,
  type Channel,
  type ChannelInbound,
  type ChannelOutbound,
  type SessionStateStore,
  type SurfaceTag,
} from '@recued/chat';
import {
  createMiddlewareRegistry,
  runStream,
  type MiddlewareRegistry,
  type TurnExecutor,
} from '@recued/middleware';
import {
  registerPromptCacheMiddleware,
  type GateDeps,
  type PrefetchDeps,
} from '@recued/middleware-prompt-cache';
import { registerFirstPartyMiddlewares } from '@recued/middleware-recued';
import {
  type AIOutput,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ContractSnapshot,
  type ExecutionSource,
  type IngredientManifest,
  type InternalToolRegistry,
  type RecipeDefinition,
  type RecipeError,
  type RecuedServerSignature,
  type ScanFn,
  type ToolEntry,
} from '@recued/contracts';

import {
  createPromptCacheGateDeps,
  createShortCircuitReadAuthorization,
} from '../chat-prompt-cache-gate.js';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import type { ExecuteRequest } from '../types.js';
import {
  createChatOrchestrator,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import type {
  ExecutionCaseLifecycle,
} from '../chat-execution-case-tools.js';
import type {
  ExecutionCaseProposalCritic,
} from '../execution-case-critic.js';
import {
  currentExecutionCaseVerificationContext,
} from '../execution-case-verification-context.js';
import {
  createChatStore,
  ensureChatSchema,
} from '../storage/chat-store.js';
import type { ContactStore } from '../storage/contact-store.js';
import { createManifestRegistry, type ManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import {
  handleExecute,
  type ExecuteHandlerDeps,
} from '../execute-handler.js';

const NOW = Date.UTC(2030, 0, 15, 12, 0, 0);
const SESSION = 'sess-d160-p3-source-threading';

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

const messengerUserSelfSource = (
  from = 'U-sender',
  vendor: 'slack' | 'telegram' = 'slack',
): ExecutionSource => ({
  channel: 'messenger',
  actor: 'user_self',
  vendor,
  from,
});

const messengerContractedSource: ExecutionSource = {
  channel: 'messenger',
  actor: 'contracted_user',
  vendor: 'slack',
  from: 'U1',
  contract_id: 'c1',
};

const chatSource = (
  sessionId = SESSION,
  turnId = 'turn-1',
): ExecutionSource => ({
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: sessionId,
  user_id: 'local',
  turn_id: turnId,
});

const mcpSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'stdio_local',
  tool_call_id: 'mcp-call-1',
  mcp_token_id: 'tok1',
  contract_id: 'tok1',
};

const mkTool = (name: string): ToolEntry => ({
  name,
  tier: 1,
  description: `desc for ${name}`,
  arg_schema: { type: 'object' },
  topic_tags: ['contact'],
  classification: 'read',
  concurrency_safe: true,
});

const registryWithCapture = (
  captured: ChatDispatchContext[],
): InternalToolRegistry => {
  const catalog = [mkTool('contact.search')];
  return {
    list: () => catalog,
    listByTier: (tier) => catalog.filter((entry) => entry.tier === tier),
    getByName: (name) => catalog.find((entry) => entry.name === name) ?? null,
    dispatch: vi.fn(
      async (
        _name: string,
        _args: unknown,
        ctx: ChatDispatchContext,
      ): Promise<ChatDispatchResult> => {
        captured.push(ctx);
        return { ok: true, result: { contacts: [] } };
      },
    ),
    subscribeRefresh: () => () => undefined,
  };
};

const firstPartyRegistry = (): MiddlewareRegistry => {
  const registry = createMiddlewareRegistry();
  registerFirstPartyMiddlewares(registry);
  return registry;
};

const toolCallingAi = (): ReturnType<typeof vi.fn<ExecuteChatAiCall>> => {
  let calls = 0;
  return vi.fn<ExecuteChatAiCall>(async () => {
    calls += 1;
    if (calls === 1) {
      return {
        body: {
          response: 'checking contacts',
          events: [],
          tool_calls: [
            { tool: 'contact.search', args: { query: 'Pat' } },
          ],
        } satisfies AIOutput,
      };
    }
    return {
      body: {
        response: 'done',
        events: [],
        tool_calls: [],
      } satisfies AIOutput,
    };
  });
};

interface CapturedSend {
  recipient: string;
  token: string;
  text: string;
}

const fakeMessengerChannel = (opts: {
  vendor: 'slack' | 'telegram';
  sessionStore: SessionStateStore;
  token: string;
  recipient: string;
  sessionId: string;
  parsedText: string;
  now: () => number;
  source?: ExecutionSource;
}): {
  channel: Channel & {
    ingest(payload: unknown, dispatch_depth?: number): Promise<ChannelInbound>;
  };
  sends: CapturedSend[];
} => {
  const sends: CapturedSend[] = [];
  const surface: SurfaceTag = `messenger-${opts.vendor}`;
  let handler: ((m: ChannelInbound) => void | Promise<void>) | null = null;
  const channel = {
    surface,
    async deliver(event: ChannelOutbound): Promise<void> {
      if (event.kind !== 'message') return;
      if (event.session_id !== opts.sessionId) return;
      sends.push({ recipient: opts.recipient, token: opts.token, text: event.text });
      opts.sessionStore.append({
        session_id: opts.sessionId,
        surface,
        role: 'assistant',
        text: event.text,
        ts: opts.now(),
      });
    },
    onInbound(h: (m: ChannelInbound) => void | Promise<void>): void {
      handler = h;
    },
    async ingest(_payload: unknown, dispatch_depth = 0): Promise<ChannelInbound> {
      const ts = opts.now();
      opts.sessionStore.append({
        session_id: opts.sessionId,
        surface,
        role: 'user',
        text: opts.parsedText,
        ts,
      });
      const inbound: ChannelInbound = {
        session_id: opts.sessionId,
        surface,
        text: opts.parsedText,
        from: 'U-sender',
        source: opts.source ?? messengerUserSelfSource('U-sender', opts.vendor),
        dispatch_depth,
        ts,
      };
      await handler?.(inbound);
      return inbound;
    },
  };
  return { channel, sends };
};

const runMessengerDispatchTurn = async (
  dispatchDepth: number,
  executionCaseLifecycle?: ExecutionCaseLifecycle,
): Promise<{
  inbound: ChannelInbound;
  captured: ChatDispatchContext[];
}> => {
  const db = new Database(':memory:');
  try {
    ensureChatSchema(db);
  // ⛔ Pin the brief OFF via the SETTER production uses — env is boot-critical only
  // (owner rule). This file's subject is not the brief; the fold would add a
  // call to the very dispatch/egress counts asserted here.
    const chatStore = createChatStore(db);
    chatStore.setRollingBriefEnabled(false);
    chatStore.createSession({ id: SESSION, now: NOW - 1_000 });
    const captured: ChatDispatchContext[] = [];
    const orchestrator = createChatOrchestrator({
      chatStore,
      registry: registryWithCapture(captured),
      broadcast: { emit: vi.fn() },
      selfSignature,
      executeAiCall: toolCallingAi(),
      middlewareRegistry: firstPartyRegistry(),
      ...(executionCaseLifecycle
        ? { getExecutionCaseLifecycle: () => executionCaseLifecycle }
        : {}),
      now: () => NOW,
    });

    const sessionStore = createInMemorySessionStore();
    const { channel } = fakeMessengerChannel({
      vendor: 'slack',
      sessionStore,
      token: 'byo-token',
      recipient: 'C-recipient',
      sessionId: SESSION,
      parsedText: 'find Pat',
      now: () => NOW,
    });

    let turnPromise: Promise<unknown> | undefined;
    channel.onInbound((inbound) => {
      turnPromise = orchestrator.runMessengerTurn({ channel, sessionStore, inbound });
    });
    const inbound = await channel.ingest({ vendor: 'slack' }, dispatchDepth);
    await turnPromise;
    return { inbound, captured };
  } finally {
    db.close();
  }
};

const contactStore = (): ContactStore =>
  ({
    list: () => [{ email: 'pat@x.com', name: 'Pat Lee' }],
    addressSet: (email: string) => [email],
  }) as unknown as ContactStore;

const noopPrefetch: PrefetchDeps = { search: () => [] };

const firstPartyRegistryWithPromptCache = (deps: GateDeps): MiddlewareRegistry => {
  const registry = createMiddlewareRegistry();
  registerFirstPartyMiddlewares(registry);
  registerPromptCacheMiddleware(registry, deps, noopPrefetch);
  return registry;
};

const runMessengerPromptCacheTurn = async (opts: {
  source?: ExecutionSource;
  aiResponse?: string;
} = {}): Promise<{
  sends: CapturedSend[];
  executeAiCall: ReturnType<typeof vi.fn<ExecuteChatAiCall>>;
}> => {
  const db = new Database(':memory:');
  try {
    ensureChatSchema(db);
    const chatStore = createChatStore(db);
    chatStore.setRollingBriefEnabled(false);
    chatStore.createSession({ id: SESSION, now: NOW - 1_000 });
    const executeAiCall = vi.fn<ExecuteChatAiCall>(async () => ({
      body: {
        response: opts.aiResponse ?? 'sentinel model path',
        events: [],
        tool_calls: [],
      } satisfies AIOutput,
    }));
    const gateDeps = createPromptCacheGateDeps(
      contactStore,
      () => undefined,
      undefined,
      undefined,
      undefined,
    );
    const orchestrator = createChatOrchestrator({
      chatStore,
      registry: registryWithCapture([]),
      broadcast: { emit: vi.fn() },
      selfSignature,
      executeAiCall,
      middlewareRegistry: firstPartyRegistryWithPromptCache(gateDeps),
      now: () => NOW,
    });

    const sessionStore = createInMemorySessionStore();
    const { channel, sends } = fakeMessengerChannel({
      vendor: 'slack',
      sessionStore,
      token: 'byo-token',
      recipient: 'C-recipient',
      sessionId: SESSION,
      parsedText: "what is Pat Lee's email address?",
      now: () => NOW,
      ...(opts.source ? { source: opts.source } : {}),
    });

    let turnPromise: Promise<unknown> | undefined;
    channel.onInbound((inbound) => {
      turnPromise = orchestrator.runMessengerTurn({ channel, sessionStore, inbound });
    });
    await channel.ingest({ vendor: 'slack' });
    await turnPromise;
    return { sends, executeAiCall };
  } finally {
    db.close();
  }
};

const buildManifest = (
  slug: string,
  kind: IngredientManifest['kind'],
  risk_tier: IngredientManifest['risk_tier'],
): IngredientManifest => ({
  slug,
  name: slug,
  description: `Test manifest for ${slug}`,
  author: 'test',
  kind,
  risk_tier,
  version: 1,
  category: 'data',
  input: {},
  output: { data: 'data' },
}) as unknown as IngredientManifest;

const ingredientStep = (
  id: string,
  ingredient: string,
): RecipeDefinition['steps'][number] => ({ id, ingredient, input: {} });

const buildRecipe = (
  recipe_id: string,
  ingredient: string,
): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 60,
  metadata: {
    name: recipe_id,
    description: 'Minimal D-160 P3 policy fixture.',
    author: 'test',
    supported_platforms: ['test'],
    tags: ['test', 'policy', 'gate'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [ingredientStep('call', ingredient)],
  output: { sidebar: [] },
}) as RecipeDefinition;

const registerManifests = (
  registry: ManifestRegistry,
  manifests: readonly IngredientManifest[],
): void => {
  for (const manifest of manifests) registry.register(manifest);
};

const makeExecuteDeps = (
  recipe: RecipeDefinition,
  manifests: readonly IngredientManifest[],
): ExecuteHandlerDeps => {
  const registry = createManifestRegistry('/nonexistent');
  registerManifests(registry, manifests);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  return {
    recipeStore,
    executorConfig: { manifests: registry },
    baseVault: {},
    instanceId: 'server-test-1',
  };
};

const buildContractSnapshot = (
  allowed_tools: readonly string[],
): ContractSnapshot => ({
  contract_id: 'c1',
  contract_version: '1',
  allowed_tools,
  approval_required: [],
  scope_restrictions: [],
  resolved_at: NOW,
});

const errorsContainCode = (
  errors: readonly unknown[],
  code: string,
): boolean =>
  errors.some((error) =>
    typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === code,
  );

const firstRecipeError = (errors: readonly unknown[]): RecipeError =>
  errors[0] as RecipeError;

// D-187 — the matrix `(messenger, user_self)` cell + its coarse `allowed_kinds`
// gate are retired; a no-op scan stands in to show the short-circuit read
// authorization ignores any store overlay for the owner (reads are never-class).
const ignoredScan: ScanFn = () => [];

const recordingChannel = (surface: SurfaceTag): Channel & {
  readonly events: ChannelOutbound[];
} => {
  const events: ChannelOutbound[] = [];
  return {
    surface,
    events,
    async deliver(event: ChannelOutbound): Promise<void> {
      events.push(event);
    },
    onInbound(): void {},
  };
};

describe('D-160 P3 dispatch identity through the real orchestrator', () => {
  it.each([0, 2] as const)(
    'threads the messenger source and I-7 hop token at depth %s',
    async (dispatchDepth) => {
      const { inbound, captured } = await runMessengerDispatchTurn(dispatchDepth);

      expect(captured).toHaveLength(1);
      const ctx = captured[0]!;
      expect(ctx.execution_source).toEqual(inbound.source);
      // This pin catches the old disguise: a messenger turn must not reach
      // the registry as a chat-shaped internal dispatch identity.
      expect(ctx.execution_source?.channel).toBe('messenger');
      expect(ctx.dispatch_depth).toBe(inbound.dispatch_depth);
    },
  );

  it('keeps the chat runTurn dispatch byte-compatible and explicit at depth 0', async () => {
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const chatStore = createChatStore(db);
      chatStore.setRollingBriefEnabled(false);
      chatStore.createSession({ id: SESSION, now: NOW - 1_000 });
      const captured: ChatDispatchContext[] = [];
      const orchestrator = createChatOrchestrator({
        chatStore,
        registry: registryWithCapture(captured),
        broadcast: { emit: vi.fn() },
        selfSignature,
        executeAiCall: toolCallingAi(),
        middlewareRegistry: firstPartyRegistry(),
        now: () => NOW,
      });

      const ack = await orchestrator.runTurn({
        session_id: SESSION,
        message: 'find Pat',
        picker_state: { current: 'self' },
      });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.execution_source).toEqual({
        channel: 'chat',
        actor: 'user_self',
        chat_session_id: SESSION,
        user_id: 'local',
        turn_id: ack.turn_id,
      });
      expect(captured[0]?.dispatch_depth).toBe(0);
    } finally {
      db.close();
    }
  });

  it('threads the exact direct-chat source into D-214 proposal scope resolution', async () => {
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const chatStore = createChatStore(db);
      chatStore.setRollingBriefEnabled(false);
      chatStore.createSession({ id: SESSION, now: NOW - 1_000 });
      const critique = vi.fn<ExecutionCaseProposalCritic['critique']>(
        async () => null,
      );
      const orchestrator = createChatOrchestrator({
        chatStore,
        registry: registryWithCapture([]),
        broadcast: { emit: vi.fn() },
        selfSignature,
        executeAiCall: toolCallingAi(),
        middlewareRegistry: firstPartyRegistry(),
        getExecutionCaseProposalCritic: () => ({ critique }),
        now: () => NOW,
      });

      const ack = await orchestrator.runTurn({
        session_id: SESSION,
        message: 'find Pat',
        picker_state: { current: 'self' },
      });

      expect(critique).toHaveBeenCalledTimes(1);
      expect(critique.mock.calls[0]?.[0]).toMatchObject({
        session_id: SESSION,
        turn_id: ack.turn_id,
        source: chatSource(SESSION, ack.turn_id),
      });
    } finally {
      db.close();
    }
  });

  it('attributes each direct-chat planner packet and trusted dispatch to its exact turn', async () => {
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const chatStore = createChatStore(db);
      chatStore.setRollingBriefEnabled(false);
      chatStore.createSession({ id: SESSION, now: NOW - 1_000 });
      const verificationContexts: unknown[] = [];
      const baseRegistry = registryWithCapture([]);
      const turnRegistry: InternalToolRegistry = {
        ...baseRegistry,
        dispatch: vi.fn(async (): Promise<ChatDispatchResult> => {
          verificationContexts.push(
            currentExecutionCaseVerificationContext(),
          );
          return { ok: true, result: { contacts: [] } };
        }),
      };
      const packetOrder: string[] = [];
      let aiRound = 0;
      const executeAiCall = vi.fn<ExecuteChatAiCall>(async () => {
        packetOrder.push(`model-${aiRound}`);
        aiRound += 1;
        return {
          body: aiRound === 1
            ? {
                response: 'checking contacts',
                events: [],
                tool_calls: [{
                  tool: 'contact.search',
                  args: { query: 'Pat' },
                }],
              }
            : { response: 'done', events: [], tool_calls: [] },
        };
      });
      const recordPlannerRounds = vi.fn();
      const lifecycle = {
        markPlannerEgress: vi.fn(() => {
          packetOrder.push(`egress-${aiRound}`);
        }),
        recordPlannerRounds,
      } as unknown as ExecutionCaseLifecycle;
      const orchestrator = createChatOrchestrator({
        chatStore,
        registry: turnRegistry,
        broadcast: { emit: vi.fn() },
        selfSignature,
        executeAiCall,
        middlewareRegistry: firstPartyRegistry(),
        getExecutionCaseLifecycle: () => lifecycle,
        now: () => NOW,
      });

      const ack = await orchestrator.runTurn({
        session_id: SESSION,
        message: 'find Pat',
        picker_state: { current: 'self' },
      });

      expect(packetOrder).toEqual([
        'egress-0',
        'model-0',
        'egress-1',
        'model-1',
      ]);
      expect(recordPlannerRounds).toHaveBeenCalledWith({
        session_id: SESSION,
        turn_id: ack.turn_id,
        rounds: 2,
      });
      expect(verificationContexts).toEqual([{
        session_id: SESSION,
        turn_id: ack.turn_id,
      }]);
    } finally {
      db.close();
    }
  });

  it('records planner rounds for messenger turns too', async () => {
    const recordPlannerRounds = vi.fn();
    const markPlannerEgress = vi.fn();
    const lifecycle = {
      markPlannerEgress,
      recordPlannerRounds,
    } as unknown as ExecutionCaseLifecycle;

    const { inbound } = await runMessengerDispatchTurn(0, lifecycle);

    expect(markPlannerEgress).toHaveBeenCalledTimes(2);
    expect(recordPlannerRounds).toHaveBeenCalledWith({
      session_id: inbound.session_id,
      turn_id: expect.any(String),
      rounds: 2,
    });
  });
});

describe('D-160 P3 execute-handler messenger policy gating', () => {
  it('admits a messenger user_self storage-read ExecuteRequest on the seeded baseline', async () => {
    const manifest = buildManifest('safe-storage', 'storage', 'read');
    const recipe = buildRecipe('messenger-storage-admit', manifest.slug);
    const result = await handleExecute(makeExecuteDeps(recipe, [manifest]), {
      recipe_id: recipe.recipe_id,
      trigger_source: 'chat',
      execution_source: messengerUserSelfSource('U1'),
    });

    expect(result.steps.map((step) => step.id)).toEqual(['call']);
    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
  });

  it('does NOT deny destructive at the static gate for messenger user_self just like chat (D-177 read-gate follow-on)', async () => {
    // D-177 read-gate follow-on (2026-06-11) — destructive is APPROVAL-gated
    // (not hard-denied) on the owner's messenger cell, exactly as on chat: the
    // static recipe gate no longer refuses it with RECIPE_POLICY_DENIED; the
    // per-call approval hold fires at dispatch (D-157 preflight suite +
    // verdict==='ask' contracts test). Still never auto-approvable —
    // destructive is outside SESSION_GRANT_RISK_TIERS, so it asks every time.
    const manifest = buildManifest('danger-storage', 'storage', 'destructive');
    const recipe = buildRecipe('messenger-destructive-not-denied', manifest.slug);
    const result = await handleExecute(makeExecuteDeps(recipe, [manifest]), {
      recipe_id: recipe.recipe_id,
      trigger_source: 'chat',
      execution_source: messengerUserSelfSource('U1'),
    });

    expect(errorsContainCode(result.errors, 'RECIPE_POLICY_DENIED')).toBe(false);
  });

  it('fails closed for a contracted messenger actor even when the channel is messenger', async () => {
    const manifest = buildManifest('contracted-safe-storage', 'storage', 'read');
    const recipe = buildRecipe('messenger-contracted-deny', manifest.slug);
    const result = await handleExecute(makeExecuteDeps(recipe, [manifest]), {
      recipe_id: recipe.recipe_id,
      trigger_source: 'chat',
      execution_source: messengerContractedSource,
      contract_snapshot: buildContractSnapshot([]),
    });

    expect(result.success).toBe(false);
    const error = firstRecipeError(result.errors);
    expect(error.code).toBe('RECIPE_POLICY_DENIED');
    const details = error.details as { denials?: readonly { decision: { code: string } }[] };
    expect(details.denials?.[0]?.decision.code).toBe('tool_not_in_contract');
  });
});

describe('D-160 P3 ctx → ExecuteRequest hop (the R1 depth-drop fold)', () => {
  // The codex R1 HIGH was exactly this hop: the dispatch ctx carried the
  // turn identity but `buildExecuteRequest` copied only the source, so a
  // re-entrant messenger fire's recipe dispatch reached the Gateway at
  // depth 0. Pin BOTH fields surviving the Tier 1 `recipe.run` builder.
  it('threads the messenger source AND the I-7 hop token onto the ExecuteRequest', async () => {
    const captured: ExecuteRequest[] = [];
    const execute = vi.fn().mockImplementation(async (req: ExecuteRequest) => {
      captured.push(req);
      return {
        success: true,
        recipe_id: req.recipe_id ?? 'inline',
        steps: [],
        errors: [],
        duration_ms: 1,
      };
    });
    const handlers = buildChatTier1Handlers({
      getContactStore: () => undefined,
      getCollectionRegistry: () => undefined,
      getAuditLog: () => undefined,
      getEnrichmentStore: () => undefined,
      getRecipeStore: () =>
        ({
          ids: () => [],
          get: () => null,
          getStored: () => null,
          listStored: () => [],
        }) as never,
      getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
      getExecuteRecipe: () => execute,
    });
    const source = messengerUserSelfSource('U-reentrant');
    const ctx: ChatDispatchContext = {
      channel: 'internal_function_call',
      session_id: SESSION,
      turn_id: 'turn-reentrant',
      execution_source: source,
      dispatch_depth: 2,
    };

    const result = await handlers['recipe.run']!({ recipe_id: 'r1' }, ctx);

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.execution_source).toBe(source);
    expect(captured[0]?.dispatch_depth).toBe(2);
  });
});

describe('D-160 P3 / D-164 P10 short-circuit real-source seam', () => {
  it('admits real owner sources only when they belong to the requested surface', () => {
    const authorize = createShortCircuitReadAuthorization();

    expect(authorize('messenger-slack', messengerUserSelfSource('U1', 'slack'))).toBe(true);
    expect(authorize('chat', chatSource())).toBe(true);
    expect(authorize('messenger-slack', messengerContractedSource)).toBe(false);
    expect(authorize('messenger-slack', messengerUserSelfSource('U1', 'telegram'))).toBe(false);
    expect(authorize('chat', mcpSource)).toBe(false);
  });

  it('keeps the P10 surface fallback for harness contexts without a real source', () => {
    const authorize = createShortCircuitReadAuthorization();

    expect(authorize('chat')).toBe(true);
    expect(authorize('messenger-slack')).toBe(true);
    expect(authorize('messenger-telegram')).toBe(true);
    expect(authorize('voice-call' as never)).toBe(false);
  });

  it('D-187: a store-edited messenger kind-lockdown no longer defers a real OWNER read', () => {
    // D-187 slice 4 — the matrix coarse `allowed_kinds` gate is retired and owner reads
    // are never-class (always admit). A store-edited cell dropping `storage` no longer
    // defers the OWNER's own read through this seam (the ignored scan is passed to show
    // it has no effect). Access control is for contracted actors, not the owner.
    const authorize = createShortCircuitReadAuthorization(() => ignoredScan);

    expect(authorize('messenger-slack', messengerUserSelfSource('U1', 'slack'))).toBe(true);
    expect(authorize('chat', chatSource())).toBe(true);
  });
});

describe('D-160 P3 prompt-cache middleware e2e with real TurnContext.source', () => {
  it('short-circuits a messenger owner read when the real source is present', async () => {
    const { sends, executeAiCall } = await runMessengerPromptCacheTurn();

    expect(executeAiCall).not.toHaveBeenCalled();
    expect(sends.map((send) => send.text)).toContain("Pat Lee's email address is pat@x.com.");
  });

  it('defers a contracted messenger inbound to the model instead of using the fallback map', async () => {
    const { sends, executeAiCall } = await runMessengerPromptCacheTurn({
      source: messengerContractedSource,
      aiResponse: 'sentinel model path',
    });

    // If runStream failed to stamp ctx.source, the P10 fallback map would
    // over-grant this surface. Deferral proves the real contracted source
    // reached the backend authorizer.
    expect(executeAiCall).toHaveBeenCalledTimes(1);
    expect(sends.map((send) => send.text)).toEqual(['sentinel model path']);
  });
});

describe('D-160 P3 runStream framework source pin', () => {
  it('populates TurnContext.source from inbound.source on every turn of one stream', async () => {
    const sessionStore = createInMemorySessionStore();
    const source = messengerUserSelfSource('U-probe', 'slack');
    const inbound: ChannelInbound = {
      session_id: SESSION,
      surface: 'messenger-slack',
      text: 'probe',
      from: 'U-probe',
      source,
      dispatch_depth: 0,
      ts: NOW,
    };
    sessionStore.append({
      session_id: inbound.session_id,
      surface: inbound.surface,
      role: 'user',
      text: inbound.text,
      ts: inbound.ts,
    });
    const registry = createMiddlewareRegistry();
    const seen: Array<ExecutionSource | undefined> = [];
    registry.register({
      id: 'source-probe',
      prompt(ctx): void {
        seen.push(ctx.source);
      },
      update(ctx): void {
        if (ctx.turn_index === 0) ctx.requestContinue();
      },
    });
    const runTurn: TurnExecutor = async (ctx) => ({ text: `answer ${ctx.turn_index}` });

    await runStream({
      registry,
      channel: recordingChannel('messenger-slack'),
      sessionStore,
      inbound,
      runTurn,
      capacity: { max_turns: 2 },
      mintId: (() => {
        let n = 0;
        return () => `turn-${n++}`;
      })(),
    });

    expect(seen).toEqual([source, source]);
    expect(seen.every((value) => value === source)).toBe(true);
  });
});
