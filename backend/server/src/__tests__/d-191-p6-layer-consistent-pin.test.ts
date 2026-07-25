/** D-191 P6 — layer-consistent slot pins.
 *
 * Covers the public chat turn and rpc seams for the layer/pin consistency fix:
 * a per-turn free-pool layer must not inherit a BYOK slot pin, while meaningful
 * BYOK pins still fail closed.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AIOutput,
  ChatDispatchContext,
  ChatDispatchResult,
  ChatModelRoutingLayer,
  ChatModelSourceId,
  InternalToolRegistry,
  RecuedServerSignature,
} from '@recued/contracts';

import {
  createChatOrchestrator,
  type ChatOrchestrator,
  type ChatTurnInput,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import {
  handleSend,
  handleSessionCreate,
  handleSetModelPref,
  type ChatRpcDeps,
} from '../chat-handler.js';
import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

const aiOk: AIOutput = { response: 'ok', events: [], tool_calls: [] };

const openDbs: Database.Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0).reverse()) db.close();
});

const makeDb = (): Database.Database => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  openDbs.push(db);
  return db;
};

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const mintCounter = (prefix: string): (() => string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

const nextClock = (): (() => number) => {
  let t = 1_000;
  return () => {
    t += 5;
    return t;
  };
};

const emptyRegistry = (): InternalToolRegistry => ({
  list: () => [],
  listByTier: () => [],
  getByName: () => null,
  dispatch: vi.fn(
    async (
      _name: string,
      _args: unknown,
      _ctx: ChatDispatchContext,
    ): Promise<ChatDispatchResult> => ({ ok: true, result: { ok: true } }),
  ) as InternalToolRegistry['dispatch'],
  subscribeRefresh: () => () => undefined,
});

const rpcDeps = (
  store: ChatStore,
  orchestrator: ChatOrchestrator,
): ChatRpcDeps =>
  ({
    store,
    orchestrator,
    broadcast: { emit: vi.fn() },
    auditLog: undefined,
    selfSignature,
    now: () => 1_000,
    mintId: mintCounter('rpc'),
  }) as unknown as ChatRpcDeps;

const pinSessionSource = (
  deps: ChatRpcDeps,
  sessionId: string,
  sourceId: ChatModelSourceId,
  current: ChatModelRoutingLayer = 'byok',
): void => {
  handleSetModelPref(deps, {
    session_id: sessionId,
    model_pref: { current, source_id: sourceId },
  });
};

interface TurnHarness {
  store: ChatStore;
  orchestrator: ChatOrchestrator;
  deps: ChatRpcDeps;
  aiInputs: Record<string, unknown>[];
}

const makeTurnHarness = (sessionId = 'sess'): TurnHarness => {
  const db = makeDb();
  const store = createChatStore(db);
  const aiInputs: Record<string, unknown>[] = [];
  const executeAiCall: ExecuteChatAiCall = vi.fn(async (_manifest, aiInput) => {
    aiInputs.push(aiInput);
    return { body: aiOk };
  });
  const orchestrator = createChatOrchestrator({
    chatStore: store,
    registry: emptyRegistry(),
    selfSignature,
    executeAiCall,
    mintId: mintCounter(sessionId),
    now: nextClock(),
  });
  store.createSession({ id: sessionId, now: 1_000 });
  return { store, orchestrator, deps: rpcDeps(store, orchestrator), aiInputs };
};

interface HandlerHarness {
  deps: ChatRpcDeps;
  runTurnInputs: ChatTurnInput[];
  orchestrator: ChatOrchestrator;
}

const makeHandlerHarness = async (): Promise<HandlerHarness> => {
  const db = makeDb();
  const store = createChatStore(db);
  const runTurnInputs: ChatTurnInput[] = [];
  const orchestrator = {
    runTurn: vi.fn(async (input: ChatTurnInput) => {
      runTurnInputs.push(input);
      return { turn_id: `turn-${runTurnInputs.length}` };
    }),
    dispatch: { dispatchTool: vi.fn() },
  } as unknown as ChatOrchestrator;
  const deps = rpcDeps(store, orchestrator);
  await handleSessionCreate(deps, { title: 'pin tests' });
  return { deps, runTurnInputs, orchestrator };
};

const sendArgs = (
  model_pref: NonNullable<Parameters<typeof handleSend>[1]['model_pref']>,
): Parameters<typeof handleSend>[1] => ({
  session_id: 'rpc-1',
  message: 'hello',
  picker_state: { current: 'self' },
  model_pref,
});

describe('D-191 P6 — chat turn layer-consistent slot pins', () => {
  it('drops a session slot pin when a free_pool turn override resolves the force layer to free', async () => {
    const { orchestrator, deps, aiInputs } = makeTurnHarness();
    pinSessionSource(deps, 'sess', 'slot_1');

    await orchestrator.runTurn({
      session_id: 'sess',
      message: 'use the pool',
      picker_state: { current: 'self' },
      model_pref: { current: 'free_pool' },
    });

    expect(aiInputs).toHaveLength(1);
    expect(aiInputs[0]!['llm.force_layer']).toBe('free');
    expect(hasOwn(aiInputs[0]!, 'llm.pin_slot')).toBe(false);
  });

  it('preserves a byok session slot pin when the turn has no model override', async () => {
    const { orchestrator, deps, aiInputs } = makeTurnHarness();
    pinSessionSource(deps, 'sess', 'slot_1');

    await orchestrator.runTurn({
      session_id: 'sess',
      message: 'use my configured model',
      picker_state: { current: 'self' },
    });

    expect(aiInputs).toHaveLength(1);
    expect(aiInputs[0]!['llm.force_layer']).toBe('byok');
    expect(aiInputs[0]!['llm.pin_slot']).toBe('slot_1');
  });

  it('maps a local display-layer turn override to byok and preserves the session slot pin', async () => {
    const { orchestrator, deps, aiInputs } = makeTurnHarness();
    pinSessionSource(deps, 'sess', 'slot_2');

    await orchestrator.runTurn({
      session_id: 'sess',
      message: 'use the local-badged slot',
      picker_state: { current: 'self' },
      model_pref: { current: 'local' as ChatModelRoutingLayer },
    });

    expect(aiInputs).toHaveLength(1);
    expect(aiInputs[0]!['llm.force_layer']).toBe('byok');
    expect(aiInputs[0]!['llm.pin_slot']).toBe('slot_2');
  });
});

describe('D-191 P6 — chat.send forwards optional model_pref.source_id', () => {
  it('forwards a valid slot source_id from chat.send model_pref', async () => {
    const { deps, runTurnInputs, orchestrator } = await makeHandlerHarness();

    await handleSend(deps, sendArgs({ current: 'byok', source_id: 'slot_2' }));

    expect(orchestrator.runTurn).toHaveBeenCalledTimes(1);
    expect(runTurnInputs[0]!.model_pref).toEqual({
      current: 'byok',
      source_id: 'slot_2',
    });
  });

  it('leniently drops malformed chat.send model_pref.source_id values without dropping current', async () => {
    const { deps, runTurnInputs, orchestrator } = await makeHandlerHarness();

    await handleSend(deps, sendArgs({ current: 'free_pool', source_id: 'garbage' }));
    await handleSend(
      deps,
      sendArgs({
        current: 'free_pool',
        source_id: 42,
      } as unknown as NonNullable<Parameters<typeof handleSend>[1]['model_pref']>),
    );

    expect(orchestrator.runTurn).toHaveBeenCalledTimes(2);
    expect(runTurnInputs[0]!.model_pref?.current).toBe('free_pool');
    expect(runTurnInputs[0]!.model_pref).not.toBeUndefined();
    expect(hasOwn(runTurnInputs[0]!.model_pref!, 'source_id')).toBe(false);
    expect(runTurnInputs[1]!.model_pref?.current).toBe('free_pool');
    expect(runTurnInputs[1]!.model_pref).not.toBeUndefined();
    expect(hasOwn(runTurnInputs[1]!.model_pref!, 'source_id')).toBe(false);
  });

  it('forwards free_pool as a valid chat.send model_pref.source_id', async () => {
    const { deps, runTurnInputs, orchestrator } = await makeHandlerHarness();

    await handleSend(deps, sendArgs({ current: 'free_pool', source_id: 'free_pool' }));

    expect(orchestrator.runTurn).toHaveBeenCalledTimes(1);
    expect(runTurnInputs[0]!.model_pref).toEqual({
      current: 'free_pool',
      source_id: 'free_pool',
    });
  });
});
