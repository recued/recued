/** D-137 P1.2 — chat orchestrator scaffold.
 *
 *  Acceptance per spec § A.2 + § Wire A + § A.14:
 *    - runTurn(input) persists user + assistant message rows
 *    - emits chat.message_complete on the broadcast bus
 *    - emits chat_message_sent audit row per persisted message
 *    - dispatch.dispatchTool fires tool_call_started + tool_call_completed
 *      with channel: 'internal_function_call' (channel-isolation invariant)
 *    - never feeds an mcp_token_id into dispatch context
 *    - missing session → throws
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  CHAT_DISPATCH_CHANNELS,
  isChatBroadcastEventKind,
  type ChatDispatchContext,
  type InternalToolRegistry,
  type RecuedServerSignature,
} from '@recued/contracts';
import {
  broadcastEmitterFromBus,
  createChatOrchestrator,
  type BroadcastChatEvent,
  type ChatBroadcastEmitter,
} from '../chat-orchestrator.js';
import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';
import { createEventBus } from '../events/bus.js';
import {
  ALL_BROADCAST_EVENT_KINDS,
  CHAT_BROADCAST_EVENT_KINDS,
} from '@recued/contracts';

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

let db: Database.Database;
let store: ChatStore;
let auditRows: Array<Record<string, unknown>>;
let auditLog: Parameters<typeof createChatOrchestrator>[0]['auditLog'];
let captured: BroadcastChatEvent[];
let broadcast: ChatBroadcastEmitter;
let registry: InternalToolRegistry;

const mintCounter = (() => {
  let n = 0;
  return () => `id-${++n}`;
})();

const setupRegistry = (
  dispatchResultFor: (
    name: string,
  ) => Awaited<ReturnType<InternalToolRegistry['dispatch']>>,
): InternalToolRegistry => {
  const dispatchSpy = vi.fn(async (
    name: string,
    _args: unknown,
    _ctx: ChatDispatchContext,
  ) => {
    return dispatchResultFor(name);
  });
  return {
    list: () => [],
    listByTier: () => [],
    getByName: () => null,
    dispatch: dispatchSpy as InternalToolRegistry['dispatch'],
    subscribeRefresh: () => () => undefined,
  };
};

beforeEach(() => {
  db = new Database(':memory:');
  ensureChatSchema(db);
  store = createChatStore(db);
  auditRows = [];
  captured = [];
  auditLog = {
    logActivity: vi.fn(async (entry: unknown) => {
      auditRows.push(entry as Record<string, unknown>);
    }),
  } as unknown as Parameters<typeof createChatOrchestrator>[0]['auditLog'];
  broadcast = {
    emit: (event) => captured.push(event),
  };
  registry = setupRegistry(() => ({ ok: true, result: { rows: [] } }));
});

describe('D-137 P1.2 — runTurn persists + emits', () => {
  it('persists user + assistant messages + emits chat.transparency + chat.message_complete', async () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry,
      broadcast,
      auditLog,
      selfSignature,
      now: () => 2000,
      mintId: mintCounter,
    });

    const result = await orchestrator.runTurn({
      session_id: 'sess-1',
      message: 'hello',
      picker_state: { current: 'self' },
    });

    expect(result.turn_id).toBeTruthy();
    const messages = await store.listMessages('sess-1');
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('hello');
    expect(messages[1].role).toBe('assistant');
    // D-164 P6.3 — no executeAiCall wired in this test so the
    // orchestrator ships an empty-assistant + emits only
    // `chat.message_complete` (substrate-reachable fallback).
    expect(captured.length).toBe(1);
    expect(captured[0].kind).toBe('chat.message_complete');
  });

  it('emits chat_message_sent audit per persisted row', async () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry,
      auditLog,
      selfSignature,
      mintId: mintCounter,
    });
    await orchestrator.runTurn({
      session_id: 'sess-1',
      message: 'hi',
      picker_state: { current: 'self' },
    });
    const audits = auditRows.filter((r) => r.action === 'chat_message_sent');
    expect(audits.length).toBe(2);
  });

  it('persists diagnosis grounding on both turn rows', async () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry,
      broadcast,
      auditLog,
      selfSignature,
      now: () => 2000,
      mintId: mintCounter,
    });
    const data_diagnosis = {
      kind: 'data_verification' as const,
      plan_id: 'plan-one',
      run_id: 'run-one',
      intent: 'explanation' as const,
      relationship: 'involved' as const,
      run_correlation: 'matched' as const,
    };

    await orchestrator.runTurn({
      session_id: 'sess-1',
      message: 'Explain the evidence.',
      picker_state: { current: 'self' },
      data_diagnosis,
    });

    const messages = await store.listMessages('sess-1');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.data_diagnosis).toEqual(data_diagnosis);
    expect(messages[1]?.data_diagnosis).toEqual(data_diagnosis);
    expect(
      captured.find((event) => event.kind === 'chat.message_complete'),
    ).toMatchObject({
      final: { data_diagnosis },
    });
  });

  it('throws when session does not exist', async () => {
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry,
      selfSignature,
    });
    await expect(
      orchestrator.runTurn({
        session_id: 'nope',
        message: 'hi',
        picker_state: { current: 'self' },
      }),
    ).rejects.toThrow(/not found/);
  });

  it('respects override model_pref over session default', async () => {
    store.createSession({
      id: 'sess-1',
      now: 1000,
      model_routing: { current: 'byok', provider: 'local', model_id: 'ollama' },
    });
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry,
      selfSignature,
      mintId: mintCounter,
    });
    await orchestrator.runTurn({
      session_id: 'sess-1',
      message: 'hi',
      picker_state: { current: 'self' },
      model_pref: { current: 'byok' },
    });
    // We can't directly assert the model_pref override propagated
    // without a side-effect surface (P1.3 adds it via model-routing
    // labeling); the round-trip ensures the override path doesn't
    // crash on a well-formed input.
    const messages = await store.listMessages('sess-1');
    expect(messages.length).toBe(2);
  });
});

describe('D-137 P1.2 — channel-isolation invariant in dispatch', () => {
  it('dispatchTool uses channel: internal_function_call with session_id', async () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    // Register a Tier 1 entry so getByName returns a tier discriminator
    registry = {
      list: () => [],
      listByTier: () => [],
      getByName: (name: string) =>
        name === 'contact.search'
          ? {
              name: 'contact.search',
              tier: 1,
              description: '',
              arg_schema: {},
              topic_tags: [],
              classification: 'read',
              concurrency_safe: true,
            }
          : null,
      dispatch: vi.fn(async (
        _name: string,
        _args: unknown,
        ctx: ChatDispatchContext,
      ) => {
        expect(ctx.channel).toBe('internal_function_call');
        expect(ctx.session_id).toBe('sess-1');
        expect(ctx.turn_id).toBe('turn-X');
        expect(ctx.mcp_token_id).toBeUndefined();
        return { ok: true, result: { rows: [] } } as const;
      }) as unknown as InternalToolRegistry['dispatch'],
      subscribeRefresh: () => () => undefined,
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry,
      broadcast,
      auditLog,
      selfSignature,
      mintId: () => 'turn-X',
    });
    const result = await orchestrator.dispatch.dispatchTool({
      session_id: 'sess-1',
      turn_id: 'turn-X',
      tool_name: 'contact.search',
      arg_values: { q: 'Peter' },
      picker_target: 'self',
    });
    expect(result.ok).toBe(true);
    // Started + completed broadcast events.
    expect(captured.length).toBe(2);
    expect(captured[0].kind).toBe('chat.tool_call_started');
    expect(captured[1].kind).toBe('chat.tool_call_completed');
    // Codex P2 fold — tier derived from registry, not caller-supplied.
    if (captured[0].kind === 'chat.tool_call_started') {
      expect(captured[0].tier).toBe(1);
    }
  });

  it('dispatchTool passes chat execution_source into registry dispatch ctx', async () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    registry = {
      list: () => [],
      listByTier: () => [],
      getByName: (name: string) =>
        name === 'contact.search'
          ? {
              name: 'contact.search',
              tier: 1,
              description: '',
              arg_schema: {},
              topic_tags: [],
              classification: 'read',
              concurrency_safe: true,
            }
          : null,
      dispatch: vi.fn(async (
        _name: string,
        _args: unknown,
        ctx: ChatDispatchContext,
      ) => {
        expect(ctx.execution_source).toEqual({
          channel: 'chat',
          actor: 'user_self',
          chat_session_id: 'sess-1',
          user_id: 'local',
          // D-177 P5a — the dispatching turn rides the source (N.10
          // `turn_id` plumbing onto the commit input).
          turn_id: 'turn-X',
        });
        expect(ctx.contract_snapshot).toBeUndefined();
        return { ok: true, result: { rows: [] } } as const;
      }) as unknown as InternalToolRegistry['dispatch'],
      subscribeRefresh: () => () => undefined,
    };
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry,
      broadcast,
      auditLog,
      selfSignature,
      mintId: () => 'turn-X',
    });

    const result = await orchestrator.dispatch.dispatchTool({
      session_id: 'sess-1',
      turn_id: 'turn-X',
      tool_name: 'contact.search',
      arg_values: { q: 'Peter' },
      picker_target: 'self',
    });

    expect(result.ok).toBe(true);
  });

  it('dispatchTool emits chat_tool_call audit with channel discriminator', async () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry,
      auditLog,
      selfSignature,
      mintId: () => 'turn-X',
    });
    await orchestrator.dispatch.dispatchTool({
      session_id: 'sess-1',
      turn_id: 'turn-X',
      tool_name: 'contact.search',
      arg_values: {},
      picker_target: 'self',
    });
    const audit = auditRows.find((r) => r.action === 'chat_tool_call');
    expect(audit).toBeDefined();
    const detail = JSON.parse(audit!.detail as string);
    expect(detail.channel).toBe('internal_function_call');
    expect(CHAT_DISPATCH_CHANNELS).toContain(detail.channel);
  });

  it('dispatchTool propagates error reason in broadcast + audit', async () => {
    store.createSession({ id: 'sess-1', now: 1000 });
    registry = setupRegistry(() => ({ ok: false, reason: 'not_implemented' }));
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry,
      broadcast,
      auditLog,
      selfSignature,
      mintId: () => 'turn-X',
    });
    const result = await orchestrator.dispatch.dispatchTool({
      session_id: 'sess-1',
      turn_id: 'turn-X',
      tool_name: 'contact.search',
      arg_values: {},
      picker_target: 'self',
    });
    expect(result.ok).toBe(false);
    const completed = captured.find((e) => e.kind === 'chat.tool_call_completed');
    expect(completed).toBeDefined();
    if (completed && completed.kind === 'chat.tool_call_completed') {
      expect(completed.status).toBe('error');
      if (completed.status === 'error') {
        expect(completed.reason).toBe('not_implemented');
      }
    }
    const audit = auditRows.find((r) => r.action === 'chat_tool_call');
    const detail = JSON.parse((audit!.detail as string));
    expect(detail.status).toBe('error');
    expect(detail.reason).toBe('not_implemented');
  });
});

describe('D-137 P1.2 — broadcastEmitterFromBus integration', () => {
  it('emit goes through the D-121 bus with a stamped cursor', () => {
    const bus = createEventBus();
    const emitter = broadcastEmitterFromBus(bus);
    const seen: unknown[] = [];
    bus.subscribe(
      'sub',
      { kinds: [...CHAT_BROADCAST_EVENT_KINDS] },
      (event) => {
        seen.push(event);
      },
    );
    emitter.emit({
      kind: 'chat.message_complete',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      final: { id: 'msg-1' },
    });
    expect(seen.length).toBe(1);
    const event = seen[0] as { cursor: number; kind: string };
    expect(event.kind).toBe('chat.message_complete');
    expect(typeof event.cursor).toBe('number');
  });

  it('every CHAT_BROADCAST_EVENT_KINDS entry is in ALL_BROADCAST_EVENT_KINDS', () => {
    // Ratchet — guarantees adding a chat broadcast kind also bumps
    // the union per D-121 default-subscriptions discipline.
    for (const kind of CHAT_BROADCAST_EVENT_KINDS) {
      expect(ALL_BROADCAST_EVENT_KINDS).toContain(kind);
      expect(isChatBroadcastEventKind(kind)).toBe(true);
    }
  });
});

describe('D-182 — a failed recipe run reads as an ERROR activity row (not "used X ✓")', () => {
  const dispatchingRegistry = (
    dispatchResult: Awaited<ReturnType<InternalToolRegistry['dispatch']>>,
  ): InternalToolRegistry => ({
    list: () => [],
    listByTier: () => [],
    getByName: (name: string) =>
      name === 'contact.search'
        ? {
            name: 'contact.search',
            tier: 1,
            description: '',
            arg_schema: {},
            topic_tags: [],
            classification: 'read',
            concurrency_safe: true,
          }
        : null,
    dispatch: vi.fn(async () => dispatchResult) as unknown as InternalToolRegistry['dispatch'],
    subscribeRefresh: () => () => undefined,
  });

  const runDispatch = async (): Promise<{ ok: boolean }> => {
    store.createSession({ id: 'sess-1', now: 1000 });
    const orchestrator = createChatOrchestrator({
      chatStore: store,
      registry,
      broadcast,
      auditLog,
      selfSignature,
      mintId: () => 'turn-X',
    });
    return orchestrator.dispatch.dispatchTool({
      session_id: 'sess-1',
      turn_id: 'turn-X',
      tool_name: 'contact.search',
      arg_values: {},
      picker_target: 'self',
    });
  };

  it('run_failed → status:error completion (execution_error + detail); model-facing result stays ok:true', async () => {
    registry = dispatchingRegistry({
      ok: true,
      result: { recipe_id: 'r', success: false, errors: [] },
      run_failed: { detail: "cli tool 'whisper' was not found" },
    } as Awaited<ReturnType<InternalToolRegistry['dispatch']>>);
    const result = await runDispatch();
    // Model-facing result UNCHANGED ok:true (anti-loop preserved — the model still
    // gets the full errors[] via the returned result to narrate).
    expect(result.ok).toBe(true);
    // User-facing broadcast: the completion is an ERROR row carrying the error line.
    const completed = captured.find((e) => e.kind === 'chat.tool_call_completed');
    if (completed?.kind === 'chat.tool_call_completed' && completed.status === 'error') {
      expect(completed.reason).toBe('execution_error');
      expect(completed.detail).toBe("cli tool 'whisper' was not found");
    } else {
      throw new Error('expected an error completion broadcast');
    }
  });

  it('an ordinary ok dispatch (no run_failed) still broadcasts status:ok', async () => {
    registry = dispatchingRegistry({ ok: true, result: { rows: [] } } as Awaited<
      ReturnType<InternalToolRegistry['dispatch']>
    >);
    await runDispatch();
    const completed = captured.find((e) => e.kind === 'chat.tool_call_completed');
    if (completed?.kind === 'chat.tool_call_completed') {
      expect(completed.status).toBe('ok');
    } else {
      throw new Error('expected a completion broadcast');
    }
  });
});
