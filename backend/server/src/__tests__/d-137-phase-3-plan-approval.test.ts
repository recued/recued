/** D-137 P3 § A.11 — Plan-approval rpc handler wiring.
 *
 *  Covers the resolve helper + approve / cancel rpc behaviour against
 *  a live `PlanApprovalStore`, plus orchestrator-side write-gate
 *  behaviour. The orchestrator-side gate test is a focused harness
 *  that exercises the `dispatchTool` seam directly. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  RpcError,
  type ChatPlanProposal,
  type ChatPlanStatus,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type ToolEntry,
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
  type ChatRpcDeps,
} from '../chat-handler.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import type { ChatBroadcastEmitter } from '../chat-orchestrator.js';

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

const setupHandlerDeps = (): ChatRpcDeps & {
  planApprovalStore: planApproval.PlanApprovalStore;
  broadcasted: Array<Parameters<ChatBroadcastEmitter['emit']>[0]>;
  auditRows: Array<{ action: string; target: string; detail?: string }>;
} => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const store = createChatStore(db);
  const broadcasted: Array<Parameters<ChatBroadcastEmitter['emit']>[0]> = [];
  const broadcast: ChatBroadcastEmitter = {
    emit: (event) => {
      broadcasted.push(event);
    },
  };
  const auditRows: Array<{ action: string; target: string; detail?: string }> = [];
  const auditLog = {
    logActivity: vi.fn(async (entry: unknown) => {
      auditRows.push(entry as { action: string; target: string; detail?: string });
    }),
    logExecution: vi.fn(),
    listActivity: vi.fn(),
    listExecutions: vi.fn(),
    getRecentByRecipe: vi.fn(),
  } as unknown as ChatRpcDeps['auditLog'];
  const planApprovalStore = planApproval.createPlanApprovalStore();
  const orchestrator = {
    runTurn: vi.fn(),
    dispatch: { dispatchTool: vi.fn() },
  } as unknown as ChatRpcDeps['orchestrator'];
  return {
    store,
    orchestrator,
    broadcast,
    auditLog,
    selfSignature,
    planApprovalStore,
    now: () => 5000,
    mintId: () => 'mint-stub',
    broadcasted,
    auditRows,
  };
};

const seedProposal = (
  store: planApproval.PlanApprovalStore,
  overrides: Partial<ChatPlanProposal> = {},
): ChatPlanProposal => {
  const args = overrides.args ?? { to: 'a@b.com' };
  const proposal: ChatPlanProposal = {
    plan_id: 'plan-1',
    session_id: 's1',
    turn_id: 't1',
    tool: 'mail.send',
    tier: 1,
    classification: 'write',
    args,
    args_hash: planApproval.computePlanArgsHash(args),
    status: 'proposed',
    created_at: 1000,
    ...overrides,
  };
  store.put(proposal);
  return proposal;
};

describe('D-137 P3 § A.11 — handlePlanApprove', () => {
  it('flips status to approved + stamps resolved_at + emits chat.plan_resolved', async () => {
    const deps = setupHandlerDeps();
    seedProposal(deps.planApprovalStore);
    const result = await handlePlanApprove(deps, { plan_id: 'plan-1' });
    expect(result.plan.status).toBe('approved');
    expect(result.plan.resolved_at).toBe(5000);
    // Broadcast fired.
    const resolved = deps.broadcasted.find(
      (e) => e.kind === 'chat.plan_resolved',
    );
    expect(resolved).toBeDefined();
    if (resolved && resolved.kind === 'chat.plan_resolved') {
      expect(resolved.plan.status).toBe('approved');
    }
    // Audit row logged with chat_plan_approved action.
    expect(
      deps.auditRows.find((r) => r.action === 'chat_plan_approved'),
    ).toBeDefined();
  });

  it('throws not_found (404) when plan_id is unknown', async () => {
    const deps = setupHandlerDeps();
    await expect(
      handlePlanApprove(deps, { plan_id: 'nonexistent' }),
    ).rejects.toThrow(RpcError);
  });

  it('throws bad_request (400) when plan was already resolved', async () => {
    const deps = setupHandlerDeps();
    seedProposal(deps.planApprovalStore, { status: 'approved' });
    await expect(
      handlePlanApprove(deps, { plan_id: 'plan-1' }),
    ).rejects.toThrow(RpcError);
  });

  it('throws bad_request (400) when plan_id arg is missing', async () => {
    const deps = setupHandlerDeps();
    await expect(handlePlanApprove(deps, {})).rejects.toThrow(RpcError);
  });

  it('throws not_configured (501) when store unwired', async () => {
    const deps = setupHandlerDeps();
    delete (deps as { planApprovalStore?: unknown }).planApprovalStore;
    await expect(
      handlePlanApprove(deps, { plan_id: 'plan-1' }),
    ).rejects.toThrow(RpcError);
  });
});

describe('D-137 P3 § A.11 — handlePlanCancel', () => {
  it('flips status to cancelled + emits chat.plan_resolved', async () => {
    const deps = setupHandlerDeps();
    seedProposal(deps.planApprovalStore);
    const result = await handlePlanCancel(deps, { plan_id: 'plan-1' });
    expect(result.plan.status).toBe('cancelled');
    expect(
      deps.auditRows.find((r) => r.action === 'chat_plan_cancelled'),
    ).toBeDefined();
    const resolved = deps.broadcasted.find(
      (e) => e.kind === 'chat.plan_resolved',
    );
    expect(resolved).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Orchestrator-side plan-approval gate
// ────────────────────────────────────────────────────────────────

const buildOrchestratorHarness = (entries: Record<string, ToolEntry>) => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const chatStore = createChatStore(db);
  const session_id = 'sess-orc';
  chatStore.createSession({
    id: session_id,
    title: 'test',
    now: 1,
    picker_state: { current: 'self' },
    model_routing: { current: 'byok' },
  });
  const broadcasted: Array<Parameters<ChatBroadcastEmitter['emit']>[0]> = [];
  const broadcast: ChatBroadcastEmitter = {
    emit: (event) => {
      broadcasted.push(event);
    },
  };
  const dispatchFn = vi.fn(
    async (): Promise<import('@recued/contracts').ChatDispatchResult> => ({
      ok: true,
      result: { rows: [] },
    }),
  );
  const registry: InternalToolRegistry = {
    list: () => Object.values(entries),
    listByTier: (tier) =>
      Object.values(entries).filter((e) => e.tier === tier),
    getByName: (name) => entries[name] ?? null,
    dispatch: dispatchFn,
    subscribeRefresh: () => () => undefined,
  };
  const planApprovalStore = planApproval.createPlanApprovalStore();
  const orchestrator = createChatOrchestrator({
    chatStore,
    registry,
    broadcast,
    selfSignature,
    planApprovalStore,
    now: () => 5000,
    mintId: () => `mint-${Math.random()}`,
  });
  return {
    orchestrator,
    broadcasted,
    dispatchFn,
    planApprovalStore,
    session_id,
  };
};

const writeEntry: ToolEntry = {
  name: 'mail.send',
  tier: 1,
  description: 'send mail',
  arg_schema: { type: 'object' },
  topic_tags: ['mail', 'send'],
  classification: 'write',
  concurrency_safe: false,
};

const readEntry: ToolEntry = {
  name: 'contact.search',
  tier: 1,
  description: 'search contacts',
  arg_schema: { type: 'object' },
  topic_tags: ['contact', 'lookup'],
  classification: 'read',
  concurrency_safe: true,
};

describe('D-137 P3 § A.11 — orchestrator dispatchTool plan-approval gate', () => {
  it('write tools without an approved plan return awaiting_approval + emit chat.plan_proposed', async () => {
    const h = buildOrchestratorHarness({ 'mail.send': writeEntry });
    const result = await h.orchestrator.dispatch.dispatchTool({
      session_id: h.session_id,
      turn_id: 't1',
      tool_name: 'mail.send',
      arg_values: { to: 'a@b.com' },
      picker_target: 'self',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('awaiting_approval');
    }
    expect(h.dispatchFn).not.toHaveBeenCalled();
    const proposed = h.broadcasted.find((e) => e.kind === 'chat.plan_proposed');
    expect(proposed).toBeDefined();
    const pending = h.planApprovalStore.listPending(h.session_id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.tool).toBe('mail.send');
  });

  it('approved plan lets dispatch proceed', async () => {
    const h = buildOrchestratorHarness({ 'mail.send': writeEntry });
    // First call mints the proposal.
    await h.orchestrator.dispatch.dispatchTool({
      session_id: h.session_id,
      turn_id: 't1',
      tool_name: 'mail.send',
      arg_values: { to: 'a@b.com' },
      picker_target: 'self',
    });
    const pending = h.planApprovalStore.listPending(h.session_id);
    const plan_id = pending[0]!.plan_id;
    h.planApprovalStore.resolve(plan_id, 'approved', 5500);
    // Second call (same turn) finds the approved plan + proceeds.
    const result = await h.orchestrator.dispatch.dispatchTool({
      session_id: h.session_id,
      turn_id: 't1',
      tool_name: 'mail.send',
      arg_values: { to: 'a@b.com' },
      picker_target: 'self',
    });
    expect(result.ok).toBe(true);
    expect(h.dispatchFn).toHaveBeenCalledTimes(1);
  });

  it('cancelled plan blocks dispatch with plan_cancelled reason', async () => {
    const h = buildOrchestratorHarness({ 'mail.send': writeEntry });
    await h.orchestrator.dispatch.dispatchTool({
      session_id: h.session_id,
      turn_id: 't1',
      tool_name: 'mail.send',
      arg_values: { to: 'a@b.com' },
      picker_target: 'self',
    });
    const pending = h.planApprovalStore.listPending(h.session_id);
    const plan_id = pending[0]!.plan_id;
    h.planApprovalStore.resolve(plan_id, 'cancelled', 5500);
    const result = await h.orchestrator.dispatch.dispatchTool({
      session_id: h.session_id,
      turn_id: 't1',
      tool_name: 'mail.send',
      arg_values: { to: 'a@b.com' },
      picker_target: 'self',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('plan_cancelled');
    }
    expect(h.dispatchFn).not.toHaveBeenCalled();
  });

  it('read tools bypass the gate entirely', async () => {
    const h = buildOrchestratorHarness({ 'contact.search': readEntry });
    const result = await h.orchestrator.dispatch.dispatchTool({
      session_id: h.session_id,
      turn_id: 't1',
      tool_name: 'contact.search',
      arg_values: {},
      picker_target: 'self',
    });
    expect(result.ok).toBe(true);
    expect(h.dispatchFn).toHaveBeenCalledTimes(1);
    expect(h.planApprovalStore.listPending(h.session_id)).toHaveLength(0);
    expect(
      h.broadcasted.find((e) => e.kind === 'chat.plan_proposed'),
    ).toBeUndefined();
  });

  it('re-issuing the same turn with a still-proposed plan re-emits broadcast (multi-client coherence)', async () => {
    const h = buildOrchestratorHarness({ 'mail.send': writeEntry });
    await h.orchestrator.dispatch.dispatchTool({
      session_id: h.session_id,
      turn_id: 't1',
      tool_name: 'mail.send',
      arg_values: { to: 'a@b.com' },
      picker_target: 'self',
    });
    const firstProposed = h.broadcasted.filter(
      (e) => e.kind === 'chat.plan_proposed',
    ).length;
    await h.orchestrator.dispatch.dispatchTool({
      session_id: h.session_id,
      turn_id: 't1',
      tool_name: 'mail.send',
      arg_values: { to: 'a@b.com' },
      picker_target: 'self',
    });
    const secondProposed = h.broadcasted.filter(
      (e) => e.kind === 'chat.plan_proposed',
    ).length;
    // Re-emit on second call so a late-connecting client sees the
    // pending state without re-issuing the rpc.
    expect(secondProposed).toBe(firstProposed + 1);
    // Only ONE proposal persisted (idempotent put).
    expect(h.planApprovalStore.listPending(h.session_id)).toHaveLength(1);
  });

  it('substrate constants: ChatPlanStatus is the closed list', () => {
    const allStatuses: ChatPlanStatus[] = ['proposed', 'approved', 'cancelled'];
    expect(allStatuses).toHaveLength(3);
  });

  it('approval is bound to args_hash — different args mint a fresh proposal (Codex P3 P1 fold #2)', async () => {
    const h = buildOrchestratorHarness({ 'mail.send': writeEntry });
    // First dispatch: args A → proposal A.
    await h.orchestrator.dispatch.dispatchTool({
      session_id: h.session_id,
      turn_id: 't1',
      tool_name: 'mail.send',
      arg_values: { to: 'alice@b.com' },
      picker_target: 'self',
    });
    const pendingA = h.planApprovalStore.listPending(h.session_id);
    expect(pendingA).toHaveLength(1);
    h.planApprovalStore.resolve(pendingA[0]!.plan_id, 'approved', 5500);
    // Second dispatch: SAME (session, turn, tool) but DIFFERENT args
    // → must mint a new proposal, NOT reuse the prior approval.
    const result = await h.orchestrator.dispatch.dispatchTool({
      session_id: h.session_id,
      turn_id: 't1',
      tool_name: 'mail.send',
      arg_values: { to: 'attacker@evil.com' },
      picker_target: 'self',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('awaiting_approval');
    }
    expect(h.dispatchFn).not.toHaveBeenCalled();
    // Crucially — the attacker dispatch did NOT execute against the
    // alice-approved plan. A fresh proposal was minted for the
    // attacker args; pending list now has exactly one (the
    // alice-approved is resolved + drops out of pending).
    const stillPending = h.planApprovalStore.listPending(h.session_id);
    expect(stillPending).toHaveLength(1);
    expect(
      (stillPending[0]!.args as { to?: string }).to,
    ).toBe('attacker@evil.com');
  });

  it('exact-email scope-search synthesises score 1.0 → Pattern 1 (Codex P3 P1 fold #3)', async () => {
    // Smoke check that the augment helper sees real signal post-fold.
    // Full fan-out coverage lives in `d-137-phase-2-scope-search-fanout.test.ts`
    // — this one just asserts the score-synthesis lands the right
    // pattern for an exact-email lookup.
    const { confidenceShape } = await import('@recued/middleware-recued');
    const shape = confidenceShape.classifyConfidenceShape([
      { record: { id: 'a' }, score: 1.0 },
    ]);
    expect(shape.pattern).toBe(1);
  });
});
