/** D-160 spec § A.8 step 4 — the `catalog` before-turn hook.
 *
 *  Step 4 of the chat-boundary migration wires the D-164 catalog consumer
 *  as a registered before-turn (`prompt`) hook over the shared `state`
 *  (N.9), replacing the former inline catalog gather in the orchestrator's
 *  `runTurn`. These tests pin the NEW wiring (so a regression back to an
 *  inline call is caught) at three levels:
 *    1. registration + position in `createChatStreamMiddlewares`,
 *    2. the hook's DECIDE → `state` contract (read seeded picker target →
 *       delegate to the bound `buildCatalog` → write `available_tools`),
 *    3. end-to-end through the real orchestrator — the catalog reaches the
 *       AI packet via the hook even when NO `middlewareRegistry` / PII is
 *       wired (the stream registry carries the lone catalog hook).
 *
 *  The catalog PROJECTION semantics (Tier 2/3 scope + annotation gating,
 *  peer isolation) are already pinned by
 *  `d-164-phase-6-3-chat-orchestrator-ratchet.test.ts`; this file pins the
 *  hook PLUMBING those semantics now flow through.
 */

import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { piiEgress } from '@recued/gateway';
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
  type TurnContext,
  type TurnExecutor,
} from '@recued/middleware';
import {
  type AIOutput,
  type ChatPickerTarget,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type ToolEntry,
} from '@recued/contracts';

import {
  createChatStreamMiddlewares,
  CHAT_CATALOG_INPUTS_STATE_KEY,
  CHAT_CATALOG_RESULT_STATE_KEY,
  type ChatCatalogBuilder,
} from '../chat-stream-middleware.js';
import {
  PII_PROTECT_MIDDLEWARE_ID,
  PII_RESTORE_MIDDLEWARE_ID,
  type PiiEgressHookDeps,
} from '../chat-pii-egress.js';
import {
  createChatOrchestrator,
  type ChatMainTurnTool,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const NOW = Date.UTC(2030, 0, 15, 12, 0, 0);

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

const baseDeps = { now: () => NOW, resolveTzClock: () => null };

/** A present-but-empty first-party registry — enough for the order test;
 *  the source adapters are pushed whenever `registry` is truthy (they
 *  resolve their real middleware at hook time, not build time). */
const fakeRegistry = () =>
  ({
    enabled: () => [],
    register: () => {},
    disable: () => {},
    enable: () => {},
  }) as never;

const pickerTool = (recipe_slug: string): ChatMainTurnTool => ({
  recipe_slug,
  args_schema: { type: 'object' },
});

/** A `buildCatalog` spy: records every picker target it was asked for and
 *  returns a fixed tool list. */
const spyBuildCatalog = (
  tools: ReadonlyArray<ChatMainTurnTool> = [pickerTool('mail.search')],
): { build: ChatCatalogBuilder; calls: () => ReadonlyArray<ChatPickerTarget> } => {
  const calls: ChatPickerTarget[] = [];
  const build: ChatCatalogBuilder = (picker_target) => {
    calls.push(picker_target);
    return tools;
  };
  return { build, calls: () => calls };
};

/** A minimal `TurnContext` carrying only the `state` the `prompt` hook
 *  touches. */
const promptCtx = (state: Map<string, unknown>): TurnContext =>
  ({ session_id: 'sess-1', surface: 'chat', state } as unknown as TurnContext);

describe('D-160 A.8 step 4 — catalog hook registration', () => {
  it('registers the catalog hook (prompt-only) when buildCatalog is wired', () => {
    const mws = createChatStreamMiddlewares({
      buildCatalog: spyBuildCatalog().build,
      ...baseDeps,
    });
    expect(mws.map((m) => m.id)).toEqual(['catalog']);
    const catalog = mws.find((m) => m.id === 'catalog')!;
    expect(typeof catalog.prompt).toBe('function');
    expect(catalog.update).toBeUndefined();
  });

  it('places catalog FIRST among the concerns — after pii-protect, before the source adapters', () => {
    const pii: PiiEgressHookDeps = { ledgerStore: piiEgress.createSessionLedgerStore() };
    const mws = createChatStreamMiddlewares({
      registry: fakeRegistry(),
      buildCatalog: spyBuildCatalog().build,
      pii,
      ...baseDeps,
    });
    expect(mws.map((m) => m.id)).toEqual([
      PII_PROTECT_MIDDLEWARE_ID,
      'catalog',
      'scope-search',
      'correction-learning',
      'confidence-shape',
      'personal-recipes',
      'prompt-cache',
      PII_RESTORE_MIDDLEWARE_ID,
    ]);
  });

  it('omits the catalog hook when buildCatalog is not wired (prior order preserved)', () => {
    const mws = createChatStreamMiddlewares({ registry: fakeRegistry(), ...baseDeps });
    expect(mws.map((m) => m.id)).toEqual([
      'scope-search',
      'correction-learning',
      'confidence-shape',
      'personal-recipes',
      'prompt-cache',
    ]);
  });

  it('omits the catalog hook even with pii + registry wired — the bookends + source adapters keep their order', () => {
    const pii: PiiEgressHookDeps = { ledgerStore: piiEgress.createSessionLedgerStore() };
    const mws = createChatStreamMiddlewares({ registry: fakeRegistry(), pii, ...baseDeps });
    expect(mws.map((m) => m.id)).not.toContain('catalog');
    expect(mws.map((m) => m.id)).toEqual([
      PII_PROTECT_MIDDLEWARE_ID,
      'scope-search',
      'correction-learning',
      'confidence-shape',
      'personal-recipes',
      'prompt-cache',
      PII_RESTORE_MIDDLEWARE_ID,
    ]);
  });
});

describe('D-160 A.8 step 4 — catalog hook DECIDE → state', () => {
  it('reads the seeded picker target, delegates to buildCatalog, writes available_tools to state', () => {
    const tools = [pickerTool('mail.search'), pickerTool('calendar.search')];
    const spy = spyBuildCatalog(tools);
    const [catalog] = createChatStreamMiddlewares({ buildCatalog: spy.build, ...baseDeps });
    const state = new Map<string, unknown>([
      [CHAT_CATALOG_INPUTS_STATE_KEY, { picker_target: 'self' }],
    ]);

    catalog!.prompt!(promptCtx(state));

    expect(spy.calls()).toEqual(['self']);
    expect(state.get(CHAT_CATALOG_RESULT_STATE_KEY)).toEqual(tools);
  });

  it('passes a peer picker target through verbatim', () => {
    const spy = spyBuildCatalog();
    const [catalog] = createChatStreamMiddlewares({ buildCatalog: spy.build, ...baseDeps });
    const state = new Map<string, unknown>([
      [CHAT_CATALOG_INPUTS_STATE_KEY, { picker_target: 'connection.mcp.peer' }],
    ]);

    catalog!.prompt!(promptCtx(state));

    expect(spy.calls()).toEqual(['connection.mcp.peer']);
  });

  it('no-ops (no buildCatalog call, no result key) when no picker target is seeded', () => {
    const spy = spyBuildCatalog();
    const [catalog] = createChatStreamMiddlewares({ buildCatalog: spy.build, ...baseDeps });
    const state = new Map<string, unknown>();

    catalog!.prompt!(promptCtx(state));

    expect(spy.calls()).toEqual([]);
    expect(state.has(CHAT_CATALOG_RESULT_STATE_KEY)).toBe(false);
  });

  it('no-ops on a malformed (non-string picker_target) inputs snapshot', () => {
    const spy = spyBuildCatalog();
    const [catalog] = createChatStreamMiddlewares({ buildCatalog: spy.build, ...baseDeps });
    const state = new Map<string, unknown>([
      [CHAT_CATALOG_INPUTS_STATE_KEY, { picker_target: 42 }],
    ]);

    catalog!.prompt!(promptCtx(state));

    expect(spy.calls()).toEqual([]);
    expect(state.has(CHAT_CATALOG_RESULT_STATE_KEY)).toBe(false);
  });
});

describe('D-160 A.8 step 4 — catalog hook drives the turn executor via shared state (runStream)', () => {
  const recordingChannel = (): Channel => ({
    surface: 'chat',
    async deliver(_event: ChannelOutbound): Promise<void> {},
    onInbound(): void {},
  });

  const inbound: ChannelInbound = {
    session_id: 'sess-1',
    surface: 'chat',
    text: 'hello',
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

  /** Drive the REAL `catalog` hook (+ optional extra before-turn hooks)
   *  through the framework `runStream` loop with a stub executor that reads
   *  `available_tools` off `ctx.state` — the exact before-turn → turn
   *  handoff the orchestrator's executor relies on. Returns what the
   *  executor saw, so a broken hook write / seed / read is observable. */
  const captureExecutorTools = async (opts: {
    buildCatalog: ChatCatalogBuilder;
    picker_target: ChatPickerTarget;
    extraHooks?: ReadonlyArray<Middleware>;
  }): Promise<unknown> => {
    const registry = createMiddlewareRegistry();
    for (const mw of createChatStreamMiddlewares({ buildCatalog: opts.buildCatalog, ...baseDeps })) {
      registry.register(mw);
    }
    for (const mw of opts.extraHooks ?? []) registry.register(mw);
    const sessionStore = createInMemorySessionStore();
    sessionStore.append({
      session_id: 'sess-1',
      surface: 'chat',
      role: 'user',
      text: 'hello',
      ts: NOW,
    });
    let seen: unknown;
    const executor: TurnExecutor = async (ctx) => {
      seen = ctx.state.get(CHAT_CATALOG_RESULT_STATE_KEY);
      return { text: '' };
    };
    const state = new Map<string, unknown>([
      [CHAT_CATALOG_INPUTS_STATE_KEY, { picker_target: opts.picker_target }],
    ]);
    await runStream({
      registry,
      channel: recordingChannel(),
      sessionStore,
      inbound,
      runTurn: executor,
      state,
    });
    return seen;
  };

  it('the catalog hook write is exactly what the turn executor reads (before-turn → turn)', async () => {
    const tools = [pickerTool('mail.search'), pickerTool('calendar.search')];
    const seen = await captureExecutorTools({
      buildCatalog: spyBuildCatalog(tools).build,
      picker_target: 'self',
    });
    expect(seen).toEqual(tools);
  });

  it('is state-driven not inline: a later before-turn hook overrides the catalog before the turn reads it', async () => {
    // A second `prompt` hook, registered AFTER the catalog hook, overwrites
    // the result key. The pre-A.8 executor recomputed `available_tools`
    // inline and would see the real tools; the step-4 executor reads `state`
    // and sees the sentinel — so this fails if the hook→state→executor
    // handoff ever regresses back to an inline call.
    const realTools = [pickerTool('mail.search')];
    const sentinel = [pickerTool('SENTINEL')];
    const overwrite: Middleware = {
      id: 'sentinel-overwrite',
      prompt(ctx) {
        ctx.state.set(CHAT_CATALOG_RESULT_STATE_KEY, sentinel);
      },
    };
    const seen = await captureExecutorTools({
      buildCatalog: spyBuildCatalog(realTools).build,
      picker_target: 'self',
      extraHooks: [overwrite],
    });
    expect(seen).toEqual(sentinel);
    expect(seen).not.toEqual(realTools);
  });
});

describe('D-160 A.8 step 4 — catalog hook end-to-end through the orchestrator', () => {
  const mkRegistry = (catalog: ReadonlyArray<ToolEntry>): InternalToolRegistry => ({
    list: () => catalog,
    listByTier: (tier) => catalog.filter((e) => e.tier === tier),
    getByName: (name) => catalog.find((e) => e.name === name) ?? null,
    dispatch: vi.fn(async () => ({ ok: true, result: {} }) as const),
    subscribeRefresh: () => () => undefined,
  });

  const tier1 = (name: string): ToolEntry => ({
    name,
    tier: 1,
    description: `desc for ${name}`,
    arg_schema: { type: 'object' },
    topic_tags: ['test'],
    classification: 'read',
    concurrency_safe: false,
  });

  it('delivers available_tools to the AI packet via the hook with NO middlewareRegistry / pii wired', async () => {
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const chatStore = createChatStore(db);
      chatStore.createSession({ id: 'sess-1', now: NOW - 1_000 });

      const packets: Record<string, unknown>[] = [];
      const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_manifest, input) => {
        packets.push(JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>);
        return { body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput };
      });

      const orchestrator = createChatOrchestrator({
        chatStore,
        registry: mkRegistry([tier1('mail.search'), tier1('calendar.search')]),
        broadcast: { emit: () => {} },
        selfSignature,
        executeAiCall,
        // Deliberately NO middlewareRegistry + NO piiLedgerStore: the stream
        // registry would have been EMPTY pre-step-4. The catalog hook is the
        // lone producer; if it (or the shell's seed / the executor's state
        // read) regressed, available_tools would be absent / empty.
        now: () => NOW,
      });

      await orchestrator.runTurn({
        session_id: 'sess-1',
        message: 'hello',
        picker_state: { current: 'self' },
      });

      const tools = packets[0]?.available_tools as
        | Array<{ recipe_slug: string }>
        | undefined;
      expect(tools?.map((t) => t.recipe_slug)).toEqual(['mail.search', 'calendar.search']);
    } finally {
      db.close();
    }
  });
});
