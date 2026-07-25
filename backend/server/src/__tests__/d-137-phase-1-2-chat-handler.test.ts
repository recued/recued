/** D-137 P1.2 — chat-handler rpc scaffold.
 *
 *  Acceptance per spec § Wire A + § Contract Tightening:
 *    - makeChatHandlers returns a slice that claims all ten CHAT_RPC_METHODS
 *    - chat.session.create persists a row + emits chat_session_created audit
 *    - chat.session.get returns the persisted session + messages list
 *    - chat.session.delete cascades + emits chat_session_deleted
 *    - chat.session.export returns the export bundle + emits chat_export
 *    - chat.send is a thin wrapper over the orchestrator
 *    - chat.session.set_picker / set_model_pref persist + broadcast
 *      chat.session_changed
 *    - chat.plan.approve / cancel return not_implemented until P3
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { CHAT_RPC_METHODS, RpcError, type RecuedServerSignature } from '@recued/contracts';
import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';
import {
  handlePlanApprove,
  handlePlanCancel,
  handleEgressGet,
  handleSend,
  handleSessionCreate,
  handleSessionDelete,
  handleSessionExport,
  handleSessionGet,
  handleSessionsList,
  handleSetModelPref,
  handleSetPicker,
  makeChatHandlers,
  type ChatRpcDeps,
} from '../chat-handler.js';
import type { ChatBroadcastEmitter, ChatOrchestrator } from '../chat-orchestrator.js';

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

let db: Database.Database;
let store: ChatStore;
let orchestrator: ChatOrchestrator;
let broadcastedEvents: Array<Parameters<ChatBroadcastEmitter['emit']>[0]>;
let broadcast: ChatBroadcastEmitter;
let auditRows: Array<Record<string, unknown>>;
let auditLog: ChatRpcDeps['auditLog'];

const setup = (): ChatRpcDeps => {
  db = new Database(':memory:');
  ensureChatSchema(db);
  store = createChatStore(db);
  broadcastedEvents = [];
  broadcast = {
    emit: (event) => {
      broadcastedEvents.push(event);
    },
  };
  auditRows = [];
  auditLog = {
    logActivity: vi.fn(async (entry) => {
      auditRows.push(entry as unknown as Record<string, unknown>);
    }),
    logExecution: vi.fn(),
    listActivity: vi.fn(),
    listExecutions: vi.fn(),
    getRecentByRecipe: vi.fn(),
  } as unknown as ChatRpcDeps['auditLog'];
  // Lean fake orchestrator for handler unit tests.
  orchestrator = {
    runTurn: vi.fn(async () => ({ turn_id: 'turn-stub' })),
    dispatch: {
      dispatchTool: vi.fn(),
    },
  } as unknown as ChatOrchestrator;
  return {
    store,
    orchestrator,
    broadcast,
    auditLog,
    selfSignature,
    now: () => 1000,
    mintId: () => 'mint-stub',
  };
};

describe('D-137 P1.2 — makeChatHandlers slice', () => {
  it('claims every method in CHAT_RPC_METHODS', () => {
    const deps = setup();
    const slice = makeChatHandlers(deps);
    expect(slice).toBeDefined();
    const claimed = new Set(slice!.methods);
    for (const method of CHAT_RPC_METHODS) {
      expect(claimed.has(method)).toBe(true);
    }
    expect(claimed.size).toBe(CHAT_RPC_METHODS.length);
  });

  it('returns undefined when deps are unwired (composeHandlers drops slice)', () => {
    expect(makeChatHandlers(undefined)).toBeUndefined();
  });
});

describe('D-137 P1.2 — chat.session.create', () => {
  let deps: ChatRpcDeps;
  beforeEach(() => {
    deps = setup();
  });

  it('persists a new session + audit row + returns the id', async () => {
    const result = await handleSessionCreate(deps, { title: 'My Session' });
    expect(result.session_id).toBe('mint-stub');
    const fetched = store.getSession('mint-stub');
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('My Session');
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].action).toBe('chat_session_created');
    expect(auditRows[0].target).toBe('mint-stub');
  });

  it('drops empty / whitespace titles', async () => {
    await handleSessionCreate(deps, { title: '   ' });
    expect(store.getSession('mint-stub')!.title).toBeUndefined();
  });

  it('accepts void args (sidebar-create-no-title path)', async () => {
    await handleSessionCreate(deps, undefined);
    expect(store.getSession('mint-stub')).not.toBeNull();
  });
});

describe('D-137 P1.2 — chat.sessions.list / chat.session.get', () => {
  let deps: ChatRpcDeps;
  beforeEach(async () => {
    deps = setup();
    await handleSessionCreate(deps, { title: 'A' });
  });

  it('chat.sessions.list returns the session summary', () => {
    const result = handleSessionsList(deps);
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].id).toBe('mint-stub');
  });

  it('chat.session.get returns the session + messages array', async () => {
    const result = await handleSessionGet(deps, { session_id: 'mint-stub' });
    expect(result.id).toBe('mint-stub');
    expect(result.messages).toEqual([]);
  });

  it('chat.session.get on missing session → not_found', async () => {
    await expect(
      handleSessionGet(deps, { session_id: 'nonexistent' }),
    ).rejects.toThrow(RpcError);
  });

  it('chat.session.get rejects empty session_id', async () => {
    await expect(
      handleSessionGet(deps, { session_id: '' }),
    ).rejects.toThrow(/required/);
  });
});

describe('D-167 — chat.egress.get', () => {
  let deps: ChatRpcDeps;
  beforeEach(async () => {
    deps = setup();
    await handleSessionCreate(deps);
    await store.appendMessage({
      id: 'msg-egress-1',
      session_id: 'mint-stub',
      role: 'assistant',
      content: 'assistant response',
      target_server: 'self',
      picker_at_send: { display_name: 'Self', signature: selfSignature },
      model_used: { provider: 'local', model_id: 'local' },
      ts: 1001,
    });
  });

  it('returns the stored egress packets for an existing session/message', async () => {
    await store.appendEgress('mint-stub', 'msg-egress-1', [
      {
        call_index: 1,
        prompt: 'second prompt sent to the model',
        model_id: 'local/llama-3',
        ts: 1200,
      },
      {
        call_index: 0,
        prompt: 'first prompt sent to the model',
        model_id: 'openai/gpt-4.1-mini',
        ts: 1100,
      },
    ]);

    await expect(
      handleEgressGet(deps, {
        session_id: 'mint-stub',
        message_id: 'msg-egress-1',
      }),
    ).resolves.toEqual({
      packets: [
        {
          call_index: 0,
          prompt: 'first prompt sent to the model',
          model_id: 'openai/gpt-4.1-mini',
          ts: 1100,
        },
        {
          call_index: 1,
          prompt: 'second prompt sent to the model',
          model_id: 'local/llama-3',
          ts: 1200,
        },
      ],
    });
  });

  it('rejects missing or empty message_id', async () => {
    await expect(
      handleEgressGet(deps, {
        session_id: 'mint-stub',
      } as unknown as { session_id: string; message_id: string }),
    ).rejects.toThrow(/message_id is required/);

    await expect(
      handleEgressGet(deps, {
        session_id: 'mint-stub',
        message_id: '   ',
      }),
    ).rejects.toThrow(/message_id is required/);
  });
});

describe('D-137 P1.2 — chat.session.delete', () => {
  let deps: ChatRpcDeps;
  beforeEach(async () => {
    deps = setup();
    await handleSessionCreate(deps);
  });

  it('deletes the row + emits chat_session_deleted audit with deleted message count', async () => {
    await store.appendMessage({
      id: 'msg-delete-1',
      session_id: 'mint-stub',
      role: 'user',
      content: 'delete me',
      target_server: 'self',
      picker_at_send: { display_name: 'Self', signature: selfSignature },
      model_used: { provider: 'local', model_id: 'local' },
      ts: 1001,
    });
    auditRows.length = 0;

    await expect(
      handleSessionDelete(deps, { session_id: 'mint-stub' }),
    ).resolves.toEqual({ ok: true });

    expect(store.getSession('mint-stub')).toBeNull();
    expect(auditRows[0].action).toBe('chat_session_deleted');
    expect(auditRows[0].target).toBe('mint-stub');
    expect(auditRows[0].detail).toBeTypeOf('string');
    expect(JSON.parse(auditRows[0].detail as string)).toEqual({
      message_count_deleted: 1,
    });
  });

  it('missing session → not_found', async () => {
    await expect(
      handleSessionDelete(deps, { session_id: 'nope' }),
    ).rejects.toThrow(RpcError);
  });

  it('D-164 P6a-2 keeps ChatRpcDeps closed to retired cognitionStore wiring', () => {
    const depsWithRetiredField: ChatRpcDeps = {
      ...setup(),
      // @ts-expect-error D-164 P6a-2 retired the handler-side cognition store dep.
      cognitionStore: { clear: vi.fn() },
    };

    expect(depsWithRetiredField.store).toBe(store);
  });

  it('D-164 P6a-2 keeps chat-handler source free of cognition store hooks', () => {
    const source = readFileSync(new URL('../chat-handler.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('CognitionStore');
    expect(source).not.toContain('cognitionStore');
  });

  it('D-164 P6d keeps the retired cognition-store.ts file absent', () => {
    const cognitionStorePath = fileURLToPath(
      new URL('../storage/cognition-store.ts', import.meta.url),
    );

    expect(existsSync(cognitionStorePath)).toBe(false);
  });
});

describe('D-137 P1.2 — chat.session.export', () => {
  let deps: ChatRpcDeps;
  beforeEach(async () => {
    deps = setup();
    await handleSessionCreate(deps, { title: 'Export Me' });
  });

  it('returns session + messages + recued_signature + emits chat_export', async () => {
    auditRows.length = 0;
    const bundle = await handleSessionExport(deps, { session_id: 'mint-stub' });
    expect(bundle.session.id).toBe('mint-stub');
    expect(bundle.format).toBe('json');
    expect(bundle.recued_signature.server_kind).toBe('recued');
    expect(bundle.recued_signature.instance_id).toBe('inst-test');
    expect(bundle.messages).toEqual([]);
    expect(auditRows[0].action).toBe('chat_export');
  });
});

describe('D-137 P1.2 — chat.send', () => {
  let deps: ChatRpcDeps;
  beforeEach(async () => {
    deps = setup();
    await handleSessionCreate(deps);
  });

  it('proxies to orchestrator.runTurn', async () => {
    const result = await handleSend(deps, {
      session_id: 'mint-stub',
      message: 'hello',
      picker_state: { current: 'self' },
    });
    expect(result.turn_id).toBe('turn-stub');
    expect(orchestrator.runTurn).toHaveBeenCalledTimes(1);
  });

  it('threads the request time_zone into orchestrator.runTurn (D-193)', async () => {
    await handleSend(deps, {
      session_id: 'mint-stub',
      message: 'remind me at 3pm',
      picker_state: { current: 'self' },
      time_zone: 'America/New_York',
    });
    expect(
      vi.mocked(orchestrator.runTurn).mock.calls.at(-1)?.[0]?.time_zone,
    ).toBe('America/New_York');
  });

  it('drops a blank time_zone so the turn falls back to server-local (D-193)', async () => {
    await handleSend(deps, {
      session_id: 'mint-stub',
      message: 'hello',
      picker_state: { current: 'self' },
      time_zone: '   ',
    });
    expect(
      vi.mocked(orchestrator.runTurn).mock.calls.at(-1)?.[0]?.time_zone,
    ).toBeUndefined();
  });

  it('rejects when session_id is empty', async () => {
    await expect(
      handleSend(deps, {
        session_id: '',
        message: 'hi',
        picker_state: { current: 'self' },
      }),
    ).rejects.toThrow(/required/);
  });

  it('rejects when message is empty', async () => {
    await expect(
      handleSend(deps, {
        session_id: 'mint-stub',
        message: '   ',
        picker_state: { current: 'self' },
      }),
    ).rejects.toThrow(/required/);
  });

  it('rejects when picker_state is missing', async () => {
    await expect(
      handleSend(deps, {
        session_id: 'mint-stub',
        message: 'hi',
        picker_state: { current: '' },
      }),
    ).rejects.toThrow(/picker_state/);
  });

  it('rejects when model_pref.current is invalid', async () => {
    await expect(
      handleSend(deps, {
        session_id: 'mint-stub',
        message: 'hi',
        picker_state: { current: 'self' },
        model_pref: { current: 'not-a-valid-layer' },
      }),
    ).rejects.toThrow(/model_pref/);
  });

  it('rejects when session does not exist', async () => {
    await expect(
      handleSend(deps, {
        session_id: 'nope',
        message: 'hi',
        picker_state: { current: 'self' },
      }),
    ).rejects.toThrow(RpcError);
  });
});

describe('D-137 P1.2 — chat.session.set_picker / set_model_pref', () => {
  let deps: ChatRpcDeps;
  beforeEach(async () => {
    deps = setup();
    await handleSessionCreate(deps);
    broadcastedEvents.length = 0;
  });

  it('set_picker persists + emits chat.session_changed', () => {
    handleSetPicker(deps, {
      session_id: 'mint-stub',
      picker_state: { current: 'connection.mcp.bob' },
    });
    const session = store.getSession('mint-stub')!;
    expect(session.picker_state.current).toBe('connection.mcp.bob');
    expect(broadcastedEvents.length).toBe(1);
    const event = broadcastedEvents[0];
    if (event.kind !== 'chat.session_changed') {
      throw new Error('expected chat.session_changed');
    }
    expect(event.field).toBe('picker');
  });

  it('set_model_pref persists + emits chat.session_changed', () => {
    handleSetModelPref(deps, {
      session_id: 'mint-stub',
      model_pref: { current: 'byok' },
    });
    expect(store.getSession('mint-stub')!.model_routing.current).toBe('byok');
    const event = broadcastedEvents[0];
    if (event.kind !== 'chat.session_changed') {
      throw new Error('expected chat.session_changed');
    }
    expect(event.field).toBe('model_pref');
  });

  it('set_model_pref rejects invalid layer', () => {
    expect(() =>
      handleSetModelPref(deps, {
        session_id: 'mint-stub',
        model_pref: { current: 'invalid' },
      }),
    ).toThrow(RpcError);
  });

  it('set_picker rejects empty picker_state.current', () => {
    expect(() =>
      handleSetPicker(deps, {
        session_id: 'mint-stub',
        picker_state: { current: '' },
      }),
    ).toThrow(/required/);
  });

  it('set_picker on missing session → not_found', () => {
    expect(() =>
      handleSetPicker(deps, {
        session_id: 'nope',
        picker_state: { current: 'self' },
      }),
    ).toThrow(RpcError);
  });

  // Codex P2 fold (D-137 P1.2 review) — picker target prefix validation.
  it('set_picker rejects an arbitrary string (must be self or connection.mcp.<name>)', () => {
    expect(() =>
      handleSetPicker(deps, {
        session_id: 'mint-stub',
        picker_state: { current: 'random-garbage' },
      }),
    ).toThrow(/picker_state\.current must be/);
  });

  it('set_picker accepts connection.mcp.<name> prefix', () => {
    expect(() =>
      handleSetPicker(deps, {
        session_id: 'mint-stub',
        picker_state: { current: 'connection.mcp.carol' },
      }),
    ).not.toThrow();
    expect(store.getSession('mint-stub')!.picker_state.current).toBe(
      'connection.mcp.carol',
    );
  });

  it('set_picker rejects connection.mcp. with empty <name>', () => {
    expect(() =>
      handleSetPicker(deps, {
        session_id: 'mint-stub',
        picker_state: { current: 'connection.mcp.' },
      }),
    ).toThrow(/picker_state\.current must be/);
  });
});

describe('D-137 P1.2 — args-shape validation (Codex P2 fold)', () => {
  let deps: ChatRpcDeps;
  beforeEach(() => {
    deps = setup();
  });

  it('handleSessionGet rejects non-object args with bad_request', async () => {
    await expect(
      handleSessionGet(deps, 'not-an-object' as unknown as { session_id: string }),
    ).rejects.toThrow(/args must be an object/);
  });

  it('handleSessionGet rejects null args', async () => {
    await expect(
      handleSessionGet(deps, null as unknown as { session_id: string }),
    ).rejects.toThrow(/args must be an object/);
  });

  it('handleSessionGet rejects array args (would dereference index)', async () => {
    await expect(
      handleSessionGet(deps, ['a', 'b'] as unknown as { session_id: string }),
    ).rejects.toThrow(/args must be an object/);
  });

  it('handleSend rejects non-object args', async () => {
    await expect(
      handleSend(deps, 42 as unknown as Parameters<typeof handleSend>[1]),
    ).rejects.toThrow(/args must be an object/);
  });

  it('handleSetPicker rejects null args', () => {
    expect(() =>
      handleSetPicker(
        deps,
        null as unknown as { session_id: string; picker_state: { current: string } },
      ),
    ).toThrow(/args must be an object/);
  });
});

describe('D-137 P3 § A.11 — plan-approval rpc handlers (was P1.2 not_implemented)', () => {
  it('chat.plan.approve throws not_configured (501) when no planApprovalStore is wired', async () => {
    const deps = setup();
    // deps without a `planApprovalStore` must surface a clean 501,
    // mirroring the W2.2 / W2.3 store-unavailable posture.
    await expect(
      handlePlanApprove(deps, { plan_id: 'p1' }),
    ).rejects.toThrow(RpcError);
  });

  it('chat.plan.cancel throws not_configured (501) when no planApprovalStore is wired', async () => {
    const deps = setup();
    await expect(
      handlePlanCancel(deps, { plan_id: 'p1' }),
    ).rejects.toThrow(RpcError);
  });
});
