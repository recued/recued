/** D-137 P1.2 — chat-handler rpc scaffold.
 *
 *  Acceptance per spec § Wire A + § Contract Tightening:
 *    - makeChatHandlers returns a slice that claims all ten CHAT_RPC_METHODS
 *    - chat.session.create persists a row + emits chat_session_created audit
 *    - chat.session.get returns the persisted session + messages + action list
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
import {
  CHAT_RPC_METHODS,
  RpcError,
  type ChatPlanProposal,
  type RecuedServerSignature,
} from '@recued/contracts';
import { planApproval } from '@recued/gateway';
import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../storage/chat-store.js';
import {
  handlePlanApprove,
  handlePlanCancel,
  handleDataDiagnosisResolve,
  handlePlansPendingList,
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
    expect(result.plans).toEqual([]);
  });

  it('chat.session.get includes durable reviewed-action recovery records', async () => {
    const planStore = planApproval.createPlanApprovalStore();
    const args = { to: 'owner@example.com', body: 'Send once' };
    planStore.put({
      plan_id: 'plan-handler-recovery',
      session_id: 'mint-stub',
      turn_id: 'turn-proposal',
      tool: 'mail.send',
      tier: 1,
      classification: 'write',
      args,
      args_hash: planApproval.computePlanArgsHash(args),
      status: 'approved',
      created_at: 2_000,
      resolved_at: 3_000,
      consumed_at: 4_000,
    });
    planStore.recordExecution('plan-handler-recovery', {
      status: 'unknown',
      turn_id: 'turn-execution',
    });
    deps.planApprovalStore = planStore;

    const result = await handleSessionGet(deps, { session_id: 'mint-stub' });

    expect(result.plans).toEqual([
      expect.objectContaining({
        plan: expect.objectContaining({
          plan_id: 'plan-handler-recovery',
          status: 'approved',
        }),
        execution: {
          status: 'unknown',
          turn_id: 'turn-execution',
        },
        payload_available: true,
      }),
    ]);
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

describe('Chat safe-check result closure', () => {
  let deps: ChatRpcDeps;
  beforeEach(async () => {
    deps = setup();
    await handleSessionCreate(deps);
    await store.appendMessage({
      id: 'msg-safe-check',
      session_id: 'mint-stub',
      role: 'assistant',
      content: 'The read-only lookup found the expected record.',
      target_server: 'self',
      picker_at_send: { display_name: 'Self', signature: selfSignature },
      model_used: { provider: 'local', model_id: 'local' },
      ts: 1_001,
      data_diagnosis: {
        kind: 'data_verification',
        plan_id: 'plan-one',
        run_id: 'run-one',
        intent: 'safe_check',
        run_correlation: 'matched',
      },
    });
  });

  it('persists, broadcasts, and idempotently returns owner closure', async () => {
    const first = await handleDataDiagnosisResolve(deps, {
      session_id: 'mint-stub',
      message_id: 'msg-safe-check',
      status: 'resolved',
    });

    expect(first).toEqual({
      resolution: { status: 'resolved', resolved_at: 1_000 },
    });
    expect((await store.listMessages('mint-stub'))[0])
      .toMatchObject({
        data_diagnosis_resolution: {
          status: 'resolved',
          resolved_at: 1_000,
        },
      });
    expect(broadcastedEvents).toEqual([{
      kind: 'chat.data_diagnosis_resolved',
      session_id: 'mint-stub',
      message_id: 'msg-safe-check',
      resolution: { status: 'resolved', resolved_at: 1_000 },
    }]);
    expect(orchestrator.runTurn).not.toHaveBeenCalled();

    const replay = await handleDataDiagnosisResolve(deps, {
      session_id: 'mint-stub',
      message_id: 'msg-safe-check',
      status: 'resolved',
    });
    expect(replay).toEqual(first);
    expect(broadcastedEvents).toHaveLength(1);

    const changed = await handleDataDiagnosisResolve(deps, {
      session_id: 'mint-stub',
      message_id: 'msg-safe-check',
      status: 'needs_new_action',
    });
    expect(changed.resolution).toEqual({
      status: 'needs_new_action',
      resolved_at: 1_001,
    });
    expect(broadcastedEvents.at(-1)).toMatchObject({
      kind: 'chat.data_diagnosis_resolved',
      resolution: {
        status: 'needs_new_action',
        resolved_at: 1_001,
      },
    });
  });

  it('rechecks an apparently idempotent choice at the store serialization point', async () => {
    await handleDataDiagnosisResolve(deps, {
      session_id: 'mint-stub',
      message_id: 'msg-safe-check',
      status: 'resolved',
    });
    broadcastedEvents.length = 0;
    const persist = store.setDataDiagnosisResolution!;
    const serialized = vi.fn(async (
      session_id: string,
      message_id: string,
      resolution: Parameters<typeof persist>[2],
    ) => {
      await persist(session_id, message_id, {
        status: 'needs_new_action',
        resolved_at: 1_001,
      });
      return persist(session_id, message_id, resolution);
    });
    deps.store.setDataDiagnosisResolution = serialized;

    const replay = await handleDataDiagnosisResolve(deps, {
      session_id: 'mint-stub',
      message_id: 'msg-safe-check',
      status: 'resolved',
    });

    expect(serialized).toHaveBeenCalledOnce();
    expect(replay.resolution).toEqual({
      status: 'resolved',
      resolved_at: 1_002,
    });
    expect(broadcastedEvents).toEqual([{
      kind: 'chat.data_diagnosis_resolved',
      session_id: 'mint-stub',
      message_id: 'msg-safe-check',
      resolution: {
        status: 'resolved',
        resolved_at: 1_002,
      },
    }]);
  });

  it('rejects closure on anything except an exact assistant safe check', async () => {
    await store.appendMessage({
      id: 'msg-explanation',
      session_id: 'mint-stub',
      role: 'assistant',
      content: 'Explanation only.',
      target_server: 'self',
      picker_at_send: { display_name: 'Self', signature: selfSignature },
      model_used: { provider: 'local', model_id: 'local' },
      ts: 1_002,
      data_diagnosis: {
        kind: 'data_verification',
        plan_id: 'plan-one',
        run_id: 'run-one',
        intent: 'explanation',
        run_correlation: 'matched',
      },
    });

    await expect(handleDataDiagnosisResolve(deps, {
      session_id: 'mint-stub',
      message_id: 'msg-explanation',
      status: 'resolved',
    })).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    await expect(handleDataDiagnosisResolve(deps, {
      session_id: 'mint-stub',
      message_id: 'msg-missing',
      status: 'resolved',
    })).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(handleDataDiagnosisResolve(deps, {
      session_id: 'mint-stub',
      message_id: 'msg-safe-check',
      status: 'model_claimed_success',
    })).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(broadcastedEvents).toEqual([]);
    expect(orchestrator.runTurn).not.toHaveBeenCalled();
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
    const deleteSessionExecutionCases = vi.fn(async () => 2);
    deps.deleteSessionExecutionCases = deleteSessionExecutionCases;
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
    expect(deleteSessionExecutionCases).toHaveBeenCalledOnce();
    expect(deleteSessionExecutionCases).toHaveBeenCalledWith('mint-stub');
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

  it('validates and forwards an explicit verify-before-retry origin', async () => {
    const approvalStore = planApproval.createPlanApprovalStore();
    const args = { to: 'owner@example.com', body: 'Send once' };
    const origin: ChatPlanProposal = {
      plan_id: 'plan-uncertain',
      session_id: 'mint-stub',
      turn_id: 'turn-proposal',
      tool: 'mail.send',
      tier: 1,
      classification: 'write',
      args,
      args_hash: planApproval.computePlanArgsHash(args),
      status: 'proposed',
      created_at: 1_100,
    };
    approvalStore.put(origin);
    approvalStore.resolve(origin.plan_id, 'approved', 1_200);
    approvalStore.markConsumed(
      origin.plan_id,
      1_300,
      'turn-origin-execution',
    );
    approvalStore.recordExecution(origin.plan_id, {
      status: 'unknown',
      turn_id: 'turn-origin-execution',
    });
    deps.planApprovalStore = approvalStore;

    await handleSend(deps, {
      session_id: 'mint-stub',
      message: 'Verify before trying this again.',
      picker_state: { current: 'self' },
      retry_of_plan_id: origin.plan_id,
    });

    expect(orchestrator.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        retry_of_plan_id: origin.plan_id,
      }),
    );
  });

  it('refuses retry lineage that is missing or not an uncertain consumed action', async () => {
    deps.planApprovalStore = planApproval.createPlanApprovalStore();
    await expect(handleSend(deps, {
      session_id: 'mint-stub',
      message: 'Try this again.',
      picker_state: { current: 'self' },
      retry_of_plan_id: 'plan-not-in-this-session',
    })).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
    expect(orchestrator.runTurn).not.toHaveBeenCalled();
  });

  it('validates and server-stamps an explicit safe-check intent', async () => {
    const approvalStore = planApproval.createPlanApprovalStore();
    const args = { to: 'owner@example.com', body: 'Send once' };
    const origin: ChatPlanProposal = {
      plan_id: 'plan-diagnosis',
      session_id: 'mint-stub',
      turn_id: 'turn-proposal',
      tool: 'mail.send',
      tier: 1,
      classification: 'write',
      args,
      args_hash: planApproval.computePlanArgsHash(args),
      status: 'proposed',
      created_at: 1_100,
    };
    approvalStore.put(origin);
    approvalStore.resolve(origin.plan_id, 'approved', 1_200);
    approvalStore.markConsumed(origin.plan_id, 1_300, 'turn-execution');
    approvalStore.recordExecution(origin.plan_id, {
      status: 'completed',
      turn_id: 'turn-execution',
      result_ref: 'result:one',
      run_id: 'run-one',
    });
    deps.planApprovalStore = approvalStore;

    const ack = await handleSend(deps, {
      session_id: 'mint-stub',
      message: 'Help me understand the linked evidence.',
      picker_state: { current: 'self' },
      data_diagnosis: {
        plan_id: origin.plan_id,
        run_id: 'run-one',
        intent: 'safe_check',
        relationship: 'derived',
      },
    });

    expect(orchestrator.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        data_diagnosis: {
          kind: 'data_verification',
          plan_id: origin.plan_id,
          run_id: 'run-one',
          intent: 'safe_check',
          relationship: 'derived',
          run_correlation: 'matched',
        },
      }),
    );
    expect(ack.data_diagnosis).toEqual({
      kind: 'data_verification',
      plan_id: origin.plan_id,
      run_id: 'run-one',
      intent: 'safe_check',
      relationship: 'derived',
      run_correlation: 'matched',
    });
  });

  it('keeps diagnosis run correlation unverified when the receipt has no run id', async () => {
    const approvalStore = planApproval.createPlanApprovalStore();
    const args = { id: 'record-one' };
    const origin: ChatPlanProposal = {
      plan_id: 'plan-diagnosis-unverified',
      session_id: 'mint-stub',
      turn_id: 'turn-proposal',
      tool: 'record.update',
      tier: 2,
      classification: 'write',
      args,
      args_hash: planApproval.computePlanArgsHash(args),
      status: 'proposed',
      created_at: 1_100,
    };
    approvalStore.put(origin);
    approvalStore.resolve(origin.plan_id, 'approved', 1_200);
    approvalStore.markConsumed(origin.plan_id, 1_300, 'turn-execution');
    approvalStore.recordExecution(origin.plan_id, {
      status: 'unknown',
      turn_id: 'turn-execution',
    });
    deps.planApprovalStore = approvalStore;

    const ack = await handleSend(deps, {
      session_id: 'mint-stub',
      message: 'Explain this without assuming the run belongs to the action.',
      picker_state: { current: 'self' },
      data_diagnosis: {
        plan_id: origin.plan_id,
        run_id: 'run-from-data',
      },
    });

    expect(ack.data_diagnosis).toEqual({
      kind: 'data_verification',
      plan_id: origin.plan_id,
      run_id: 'run-from-data',
      intent: 'explanation',
      run_correlation: 'unverified',
    });
  });

  it('rejects a diagnosis run that conflicts with the action receipt', async () => {
    const approvalStore = planApproval.createPlanApprovalStore();
    const args = { id: 'record-one' };
    const origin: ChatPlanProposal = {
      plan_id: 'plan-diagnosis-mismatch',
      session_id: 'mint-stub',
      turn_id: 'turn-proposal',
      tool: 'record.update',
      tier: 2,
      classification: 'write',
      args,
      args_hash: planApproval.computePlanArgsHash(args),
      status: 'proposed',
      created_at: 1_100,
    };
    approvalStore.put(origin);
    approvalStore.resolve(origin.plan_id, 'approved', 1_200);
    approvalStore.markConsumed(origin.plan_id, 1_300, 'turn-execution');
    approvalStore.recordExecution(origin.plan_id, {
      status: 'failed',
      turn_id: 'turn-execution',
      reason: 'execution_error',
      run_id: 'run-receipt',
    });
    deps.planApprovalStore = approvalStore;

    await expect(handleSend(deps, {
      session_id: 'mint-stub',
      message: 'Explain this result.',
      picker_state: { current: 'self' },
      data_diagnosis: {
        plan_id: origin.plan_id,
        run_id: 'run-other',
      },
    })).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
    expect(orchestrator.runTurn).not.toHaveBeenCalled();
  });

  it('never combines diagnosis grounding with retry lineage', async () => {
    await expect(handleSend(deps, {
      session_id: 'mint-stub',
      message: 'Explain this and retry it.',
      picker_state: { current: 'self' },
      retry_of_plan_id: 'plan-retry',
      data_diagnosis: {
        plan_id: 'plan-diagnosis',
        run_id: 'run-one',
      },
    })).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
    expect(orchestrator.runTurn).not.toHaveBeenCalled();
  });

  it('rejects an open-ended diagnosis intent before dispatch', async () => {
    await expect(handleSend(deps, {
      session_id: 'mint-stub',
      message: 'Check this and fix it.',
      picker_state: { current: 'self' },
      data_diagnosis: {
        plan_id: 'plan-diagnosis',
        run_id: 'run-one',
        intent: 'check_and_execute' as never,
      },
    })).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
    expect(orchestrator.runTurn).not.toHaveBeenCalled();
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
    // ⚠ RE-VEHICLED onto `'self'` — the only target that exists since D-228
    // slice 5 retired peer scoping. The claim (a set_picker persists and
    // announces itself) is unchanged; only the value it can carry is.
    handleSetPicker(deps, {
      session_id: 'mint-stub',
      picker_state: { current: 'self' },
    });
    const session = store.getSession('mint-stub')!;
    expect(session.picker_state.current).toBe('self');
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

  it('⛔⛔ set_picker REFUSES a connection.mcp.<name> target — peer scoping is retired', () => {
    // INVERTED, and the inversion is the point. This asserted that a peer target
    // was ACCEPTED. D-228 slice 5 retired the MCP scope-picker (dead on both
    // ends; a peer's tools now reach chat as contract-governed pack operations),
    // so no peer target is valid.
    //
    // ⚠ It must REFUSE rather than silently coerce to `'self'`: a caller asking
    // to scope a conversation at a peer is asking for something this server no
    // longer does, and answering "fine, I pointed you at yourself" would be a
    // different conversation than the one they asked for.
    expect(() =>
      handleSetPicker(deps, {
        session_id: 'mint-stub',
        picker_state: { current: 'connection.mcp.carol' },
      }),
    ).toThrow(/peer scoping was retired|is not available/);
    expect(store.getSession('mint-stub')!.picker_state.current).toBe('self');
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
  it('lists still-pending plans across sessions with durable message linkage', async () => {
    const deps = setup();
    const planStore = planApproval.createPlanApprovalStore();
    const makePlan = (
      plan_id: string,
      session_id: string,
      created_at: number,
    ): ChatPlanProposal => {
      const args = { to: `${session_id}@example.com` };
      return {
        plan_id,
        session_id,
        turn_id: `turn-${plan_id}`,
        tool: 'mail.send',
        tier: 2,
        classification: 'write',
        args,
        args_hash: planApproval.computePlanArgsHash(args),
        status: 'proposed',
        created_at,
      };
    };
    const old = makePlan('plan-old', 'session-a', 1_000);
    const pending = makePlan('plan-pending', 'session-b', 2_000);
    planStore.put(old);
    planStore.put(pending);
    planStore.linkTurnToMessage(
      pending.session_id,
      pending.turn_id,
      'message-pending',
    );
    planStore.resolve(old.plan_id, 'cancelled', 3_000);
    deps.planApprovalStore = planStore;

    await expect(handlePlansPendingList(deps)).resolves.toEqual({
      plans: [
        {
          plan: pending,
          message_id: 'message-pending',
          payload_available: true,
        },
      ],
    });
  });

  it('pending-plan recovery is explicitly unavailable without a durable store', async () => {
    const deps = setup();
    await expect(handlePlansPendingList(deps)).rejects.toMatchObject({
      code: 'not_configured',
      status: 501,
    });
  });

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
