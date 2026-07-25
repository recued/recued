/** D-137 § A.11 — cross-turn plan-approval consumption.
 *
 *  Focused ratchet for the single-use approval lookup/spend path:
 *  store-level `(session, tool, args_hash)` consumption, then the
 *  orchestrator `dispatchTool` gate that consumes approved plans
 *  across turns and audits the spend. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  type ChatDispatchResult,
  type ChatPlanProposal,
  type InternalToolRegistry,
  type RecuedServerSignature,
  type ToolEntry,
} from '@recued/contracts';
import { planApproval } from '@recued/gateway';
import type { AuditLogStore } from '@recued/storage';
import {
  createChatStore,
  ensureChatSchema,
} from '../storage/chat-store.js';
import {
  createChatOrchestrator,
  type ChatBroadcastEmitter,
} from '../chat-orchestrator.js';

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-plan-consumption',
};

const mailArgsA = {
  to: 'alice@example.com',
  subject: 'D-137',
  body: 'approve once',
};

const mailArgsB = {
  to: 'bob@example.com',
  subject: 'D-137',
  body: 'different args',
};

let seedCounter = 0;

const seedPlan = (
  store: planApproval.SynchronousPlanApprovalStore,
  overrides: Partial<ChatPlanProposal> = {},
): ChatPlanProposal => {
  const args = overrides.args ?? mailArgsA;
  const plan: ChatPlanProposal = {
    plan_id: `seed-plan-${++seedCounter}`,
    session_id: 'sess-store',
    turn_id: 'turn_1',
    tool: 'mail.send',
    tier: 1,
    classification: 'write',
    args,
    args_hash: planApproval.computePlanArgsHash(args),
    status: 'proposed',
    created_at: 1_000,
    ...overrides,
  };
  store.put(plan);
  return plan;
};

const approvePlan = (
  store: planApproval.SynchronousPlanApprovalStore,
  plan_id: string,
  resolved_at: number,
): ChatPlanProposal => {
  const approved = store.resolve(plan_id, 'approved', resolved_at);
  if (!approved || approved.status !== 'approved') {
    throw new Error(`expected ${plan_id} to resolve approved`);
  }
  return approved;
};

describe('D-137 § A.11 — PlanApprovalStore approval consumption', () => {
  it('findApprovedForDispatch matches an approved proposal across turns by session/tool/args_hash', () => {
    const store = planApproval.createPlanApprovalStore();
    const proposal = seedPlan(store, {
      session_id: 'sess-cross-turn',
      turn_id: 'turn_1',
      created_at: 10_000,
    });
    const approved = approvePlan(store, proposal.plan_id, 11_000);

    const hit = store.findApprovedForDispatch(
      'sess-cross-turn',
      'mail.send',
      approved.args_hash,
      12_000,
    );

    expect(hit?.plan_id).toBe(proposal.plan_id);
    expect(hit?.turn_id).toBe('turn_1');
  });

  it('skips consumed approvals and markConsumed is first-spend-wins/idempotent', () => {
    const store = planApproval.createPlanApprovalStore();
    const approved = approvePlan(
      store,
      seedPlan(store, { plan_id: 'approved-plan' }).plan_id,
      2_000,
    );
    const proposed = seedPlan(store, {
      plan_id: 'proposed-plan',
      status: 'proposed',
    });
    const cancelled = seedPlan(store, {
      plan_id: 'cancelled-plan',
      status: 'cancelled',
      resolved_at: 2_100,
    });

    const firstSpend = store.markConsumed(approved.plan_id, 3_000);
    const secondSpend = store.markConsumed(approved.plan_id, 4_000);

    expect(firstSpend?.consumed_at).toBe(3_000);
    expect(secondSpend?.consumed_at).toBe(3_000);
    expect(store.get(approved.plan_id)?.consumed_at).toBe(3_000);
    expect(
      store.findApprovedForDispatch(
        approved.session_id,
        approved.tool,
        approved.args_hash,
        3_001,
      ),
    ).toBeUndefined();
    expect(store.markConsumed(proposed.plan_id, 3_000)).toBeUndefined();
    expect(store.markConsumed(cancelled.plan_id, 3_000)).toBeUndefined();
    expect(store.markConsumed('missing-plan', 3_000)).toBeUndefined();
  });

  it('bounds consumption by TTL, including exact edge, negative age, and created_at fallback', () => {
    const ttl = planApproval.PLAN_APPROVAL_CONSUMPTION_TTL_MS;
    const approvedAt = 100_000;

    const edgeStore = planApproval.createPlanApprovalStore();
    const edgePlan = approvePlan(
      edgeStore,
      seedPlan(edgeStore, { plan_id: 'ttl-edge', created_at: approvedAt - 10 }).plan_id,
      approvedAt,
    );
    expect(
      edgeStore.findApprovedForDispatch(
        edgePlan.session_id,
        edgePlan.tool,
        edgePlan.args_hash,
        approvedAt + ttl,
      )?.plan_id,
    ).toBe(edgePlan.plan_id);
    expect(
      edgeStore.findApprovedForDispatch(
        edgePlan.session_id,
        edgePlan.tool,
        edgePlan.args_hash,
        approvedAt + ttl + 1,
      ),
    ).toBeUndefined();

    const negativeAgeStore = planApproval.createPlanApprovalStore();
    const futureApproved = approvePlan(
      negativeAgeStore,
      seedPlan(negativeAgeStore, { plan_id: 'ttl-negative-age' }).plan_id,
      approvedAt,
    );
    expect(
      negativeAgeStore.findApprovedForDispatch(
        futureApproved.session_id,
        futureApproved.tool,
        futureApproved.args_hash,
        approvedAt - 1,
      )?.plan_id,
    ).toBe(futureApproved.plan_id);

    const fallbackStore = planApproval.createPlanApprovalStore();
    const fallbackPlan = seedPlan(fallbackStore, {
      plan_id: 'ttl-created-at-fallback',
      status: 'approved',
      created_at: approvedAt,
    });
    expect(
      fallbackStore.findApprovedForDispatch(
        fallbackPlan.session_id,
        fallbackPlan.tool,
        fallbackPlan.args_hash,
        approvedAt + ttl,
      )?.plan_id,
    ).toBe(fallbackPlan.plan_id);
  });

  it('binds consumable approvals to the exact session/tool/args_hash tuple', () => {
    const store = planApproval.createPlanApprovalStore();
    const approved = approvePlan(
      store,
      seedPlan(store, {
        session_id: 'sess-binding',
        tool: 'mail.send',
        args: mailArgsA,
      }).plan_id,
      2_000,
    );

    expect(
      store.findApprovedForDispatch(
        approved.session_id,
        approved.tool,
        planApproval.computePlanArgsHash(mailArgsB),
        2_500,
      ),
    ).toBeUndefined();
    expect(
      store.findApprovedForDispatch(
        'different-session',
        approved.tool,
        approved.args_hash,
        2_500,
      ),
    ).toBeUndefined();
    expect(
      store.findApprovedForDispatch(
        approved.session_id,
        'calendar.create',
        approved.args_hash,
        2_500,
      ),
    ).toBeUndefined();
  });

  it('selects the latest approved plan and prefers later insertion on timestamp ties', () => {
    const store = planApproval.createPlanApprovalStore();
    const older = approvePlan(
      store,
      seedPlan(store, {
        plan_id: 'approved-older',
        session_id: 'sess-latest',
        turn_id: 'turn_1',
      }).plan_id,
      2_000,
    );
    const newer = approvePlan(
      store,
      seedPlan(store, {
        plan_id: 'approved-newer',
        session_id: older.session_id,
        turn_id: 'turn_2',
      }).plan_id,
      3_000,
    );

    expect(
      store.findApprovedForDispatch(
        newer.session_id,
        newer.tool,
        newer.args_hash,
        3_500,
      )?.plan_id,
    ).toBe(newer.plan_id);

    const tieStore = planApproval.createPlanApprovalStore();
    const firstTie = approvePlan(
      tieStore,
      seedPlan(tieStore, {
        plan_id: 'approved-tie-first',
        session_id: 'sess-tie',
        created_at: 2_000,
      }).plan_id,
      4_000,
    );
    const secondTie = approvePlan(
      tieStore,
      seedPlan(tieStore, {
        plan_id: 'approved-tie-second',
        session_id: firstTie.session_id,
        created_at: 2_000,
      }).plan_id,
      4_000,
    );
    expect(
      tieStore.findApprovedForDispatch(
        secondTie.session_id,
        secondTie.tool,
        secondTie.args_hash,
        4_500,
      )?.plan_id,
    ).toBe(secondTie.plan_id);

    const latestStore = planApproval.createPlanApprovalStore();
    const sameTurnFirst = seedPlan(latestStore, {
      plan_id: 'same-turn-first',
      session_id: 'sess-find-latest-tie',
      turn_id: 'turn_same',
      created_at: 8_000,
    });
    const sameTurnSecond = seedPlan(latestStore, {
      plan_id: 'same-turn-second',
      session_id: sameTurnFirst.session_id,
      turn_id: sameTurnFirst.turn_id,
      created_at: sameTurnFirst.created_at,
    });
    expect(
      latestStore.findLatest(
        sameTurnSecond.session_id,
        sameTurnSecond.turn_id,
        sameTurnSecond.tool,
        sameTurnSecond.args_hash,
      )?.plan_id,
    ).toBe(sameTurnSecond.plan_id);
  });
});

// ────────────────────────────────────────────────────────────────
// Orchestrator-side plan-approval gate
// ────────────────────────────────────────────────────────────────

const writeEntry: ToolEntry = {
  name: 'mail.send',
  tier: 1,
  description: 'send mail',
  arg_schema: { type: 'object' },
  topic_tags: ['mail', 'send'],
  classification: 'write',
  concurrency_safe: false,
};

let harnessCounter = 0;

const buildOrchestratorHarness = (
  entries: Record<string, ToolEntry> = { 'mail.send': writeEntry },
) => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const chatStore = createChatStore(db);
  const session_id = `sess-orc-${++harnessCounter}`;
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
    async (): Promise<ChatDispatchResult> => ({
      ok: true,
      result: { rows: [] },
    }),
  );
  const registry: InternalToolRegistry = {
    list: () => Object.values(entries),
    listByTier: (tier) =>
      Object.values(entries).filter((entry) => entry.tier === tier),
    getByName: (name) => entries[name] ?? null,
    dispatch: dispatchFn,
    subscribeRefresh: () => () => undefined,
  };
  const planApprovalStore = planApproval.createPlanApprovalStore();
  const auditRows: Array<Parameters<AuditLogStore['logActivity']>[0]> = [];
  const auditLog = {
    logActivity: vi.fn(
      async (entry: Parameters<AuditLogStore['logActivity']>[0]) => {
        auditRows.push(entry);
      },
    ),
  } as unknown as AuditLogStore;
  let nowMs = 5_000;
  let mintCounter = 0;
  const orchestrator = createChatOrchestrator({
    chatStore,
    registry,
    broadcast,
    auditLog,
    selfSignature,
    planApprovalStore,
    now: () => nowMs,
    mintId: () => `mint-${harnessCounter}-${++mintCounter}`,
  });

  return {
    orchestrator,
    broadcasted,
    dispatchFn,
    planApprovalStore,
    auditRows,
    session_id,
    setNow: (next: number) => {
      nowMs = next;
    },
  };
};

type OrchestratorHarness = ReturnType<typeof buildOrchestratorHarness>;

const dispatchMail = (
  h: OrchestratorHarness,
  turn_id: string,
  arg_values: unknown = mailArgsA,
): Promise<ChatDispatchResult> =>
  h.orchestrator.dispatch.dispatchTool({
    session_id: h.session_id,
    turn_id,
    tool_name: 'mail.send',
    arg_values,
    picker_target: 'self',
  });

const expectAwaitingApproval = (result: ChatDispatchResult): string => {
  if (result.ok) {
    throw new Error('expected awaiting_approval result');
  }
  expect(result.reason).toBe('awaiting_approval');
  expect(result.detail).toMatch(/^plan_id=/);
  return result.detail!.slice('plan_id='.length);
};

const expectPlanCancelled = (result: ChatDispatchResult): string => {
  if (result.ok) {
    throw new Error('expected plan_cancelled result');
  }
  expect(result.reason).toBe('plan_cancelled');
  expect(result.detail).toMatch(/^plan_id=/);
  return result.detail!.slice('plan_id='.length);
};

const approveHarnessPlan = (
  h: OrchestratorHarness,
  plan_id: string,
  resolved_at: number,
): ChatPlanProposal => {
  const approved = h.planApprovalStore.resolve(plan_id, 'approved', resolved_at);
  if (!approved || approved.status !== 'approved') {
    throw new Error(`expected ${plan_id} to resolve approved`);
  }
  return approved;
};

const cancelHarnessPlan = (
  h: OrchestratorHarness,
  plan_id: string,
  resolved_at: number,
): ChatPlanProposal => {
  const cancelled = h.planApprovalStore.resolve(plan_id, 'cancelled', resolved_at);
  if (!cancelled || cancelled.status !== 'cancelled') {
    throw new Error(`expected ${plan_id} to resolve cancelled`);
  }
  return cancelled;
};

const consumeApprovedPlanOnce = async (
  h: OrchestratorHarness,
): Promise<string> => {
  const proposed = await dispatchMail(h, 't1');
  const planId = expectAwaitingApproval(proposed);
  approveHarnessPlan(h, planId, 6_000);
  h.setNow(7_000);

  const consumed = await dispatchMail(h, 't2');

  expect(consumed.ok).toBe(true);
  expect(h.dispatchFn).toHaveBeenCalledTimes(1);
  expect(h.planApprovalStore.get(planId)?.consumed_at).toBe(7_000);
  return planId;
};

describe('D-137 § A.11 — orchestrator dispatchTool approval consumption', () => {
  it('persists and broadcasts a trusted SELF run address with the execution receipt', async () => {
    const h = buildOrchestratorHarness();
    h.dispatchFn.mockResolvedValueOnce({
      ok: true,
      result: { rows: [] },
      run_id: 'run-exact-1',
    });

    const planId = await consumeApprovedPlanOnce(h);

    expect(
      h.planApprovalStore.listForSession(h.session_id).find(
        (record) => record.plan.plan_id === planId,
      )?.execution,
    ).toEqual({
      status: 'completed',
      turn_id: 't2',
      result_ref: `${h.session_id}:t2:mail.send`,
      run_id: 'run-exact-1',
    });
    expect(
      h.broadcasted.find(
        (event) =>
          event.kind === 'chat.tool_call_completed'
          && event.turn_id === 't2',
      ),
    ).toMatchObject({
      kind: 'chat.tool_call_completed',
      status: 'ok',
      plan_id: planId,
      run_id: 'run-exact-1',
    });
  });

  it('consumes an approved turn_1 plan on turn_2 dispatch and audits the spend', async () => {
    const h = buildOrchestratorHarness();
    const proposed = await dispatchMail(h, 't1');
    const planId = expectAwaitingApproval(proposed);
    expect(
      h.broadcasted.find(
        (event) =>
          event.kind === 'chat.tool_call_completed'
          && event.turn_id === 't1',
      ),
    ).not.toHaveProperty('plan_id');
    approveHarnessPlan(h, planId, 6_000);
    h.setNow(7_000);

    const result = await dispatchMail(h, 't2');

    expect(result.ok).toBe(true);
    expect(h.dispatchFn).toHaveBeenCalledTimes(1);
    expect(h.planApprovalStore.get(planId)?.consumed_at).toBe(7_000);
    const consumedAudit = h.auditRows.find(
      (row) => row.action === 'chat_plan_consumed',
    );
    expect(consumedAudit?.target).toBe(`${h.session_id}:t2:mail.send`);
    const detail = JSON.parse(consumedAudit?.detail ?? '{}') as {
      plan_id?: string;
      approved_turn_id?: string;
      tier?: number;
    };
    expect(detail).toMatchObject({
      plan_id: planId,
      approved_turn_id: 't1',
      tier: 1,
    });
    expect(
      h.broadcasted.filter(
        (event) =>
          (
            event.kind === 'chat.tool_call_started'
            || event.kind === 'chat.tool_call_completed'
          )
          && event.turn_id === 't2',
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'chat.tool_call_started',
        plan_id: planId,
      }),
      expect.objectContaining({
        kind: 'chat.tool_call_completed',
        status: 'ok',
        plan_id: planId,
      }),
    ]);
    expect(
      h.planApprovalStore.listForSession(h.session_id).find(
        (record) => record.plan.plan_id === planId,
      )?.execution,
    ).toEqual({
      status: 'completed',
      turn_id: 't2',
      result_ref: `${h.session_id}:t2:mail.send`,
    });
  });

  it('fails closed without a receipt link when approval consumption cannot be confirmed', async () => {
    const h = buildOrchestratorHarness();
    const proposed = await dispatchMail(h, 't1');
    const planId = expectAwaitingApproval(proposed);
    approveHarnessPlan(h, planId, 6_000);
    vi.spyOn(
      h.planApprovalStore,
      'consumeForDispatch',
    ).mockReturnValueOnce(undefined);
    h.setNow(7_000);

    const result = await dispatchMail(h, 't2');

    expect(result).toEqual({
      ok: false,
      reason: 'execution_error',
      detail:
        'The one-time approval could not be confirmed as used; '
        + 'no tool call was started.',
    });
    expect(h.dispatchFn).not.toHaveBeenCalled();
    expect(h.planApprovalStore.get(planId)?.consumed_at).toBeUndefined();
    const completion = h.broadcasted.find(
      (event) =>
        event.kind === 'chat.tool_call_completed'
        && event.turn_id === 't2',
    );
    expect(completion).toEqual(expect.objectContaining({
      status: 'error',
      reason: 'execution_error',
    }));
    expect(completion).not.toHaveProperty('plan_id');
  });

  it('falls back to durable uncertainty when terminal receipt persistence fails', async () => {
    const h = buildOrchestratorHarness();
    const proposed = await dispatchMail(h, 't1');
    const planId = expectAwaitingApproval(proposed);
    approveHarnessPlan(h, planId, 6_000);
    const recordExecution =
      h.planApprovalStore.recordExecution.bind(h.planApprovalStore);
    const receiptSpy = vi.spyOn(h.planApprovalStore, 'recordExecution')
      .mockImplementation((id, receipt) => {
        if (receipt.status === 'completed') {
          throw new Error('vault locked during terminal receipt');
        }
        return recordExecution(id, receipt);
      });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.setNow(7_000);

    try {
      expect(await dispatchMail(h, 't2')).toMatchObject({ ok: true });
      expect(
        receiptSpy.mock.calls.map(([, receipt]) => receipt.status),
      ).toEqual(['completed', 'unknown']);
      expect(
        h.planApprovalStore.listForSession(h.session_id).find(
          (record) => record.plan.plan_id === planId,
        )?.execution,
      ).toEqual({
        status: 'unknown',
        turn_id: 't2',
      });
    } finally {
      receiptSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });

  it('links a consumed plan to a failed completion so the receipt cannot hang at running', async () => {
    const h = buildOrchestratorHarness();
    const proposed = await dispatchMail(h, 't1');
    const planId = expectAwaitingApproval(proposed);
    approveHarnessPlan(h, planId, 6_000);
    h.dispatchFn.mockImplementationOnce(
      async (): Promise<ChatDispatchResult> => ({
        ok: false,
        reason: 'execution_error',
        detail: 'provider did not confirm completion',
      }),
    );
    h.setNow(7_000);

    const result = await dispatchMail(h, 't2');

    expect(result).toMatchObject({ ok: false, reason: 'execution_error' });
    expect(
      h.broadcasted.find(
        (event) =>
          event.kind === 'chat.tool_call_completed'
          && event.turn_id === 't2',
      ),
    ).toMatchObject({
      status: 'error',
      reason: 'execution_error',
      detail: 'provider did not confirm completion',
      plan_id: planId,
    });
    expect(
      h.planApprovalStore.listForSession(h.session_id).find(
        (record) => record.plan.plan_id === planId,
      )?.execution,
    ).toEqual({
      status: 'failed',
      turn_id: 't2',
      reason: 'execution_error',
      detail: 'provider did not confirm completion',
    });
  });

  it('closes a consumed-plan receipt when the registry throws instead of returning', async () => {
    const h = buildOrchestratorHarness();
    const proposed = await dispatchMail(h, 't1');
    const planId = expectAwaitingApproval(proposed);
    approveHarnessPlan(h, planId, 6_000);
    h.dispatchFn.mockRejectedValueOnce(new Error('dispatch exploded'));
    h.setNow(7_000);

    await expect(dispatchMail(h, 't2')).rejects.toThrow('dispatch exploded');

    expect(
      h.broadcasted.find(
        (event) =>
          event.kind === 'chat.tool_call_completed'
          && event.turn_id === 't2',
      ),
    ).toMatchObject({
      status: 'error',
      reason: 'execution_error',
      plan_id: planId,
    });
    expect(
      h.planApprovalStore.listForSession(h.session_id).find(
        (record) => record.plan.plan_id === planId,
      )?.execution,
    ).toEqual({
      status: 'failed',
      turn_id: 't2',
      reason: 'execution_error',
    });
  });

  it('marks a successful-but-held plan dispatch as paused rather than completed', async () => {
    const h = buildOrchestratorHarness();
    const proposed = await dispatchMail(h, 't1');
    const planId = expectAwaitingApproval(proposed);
    approveHarnessPlan(h, planId, 6_000);
    h.dispatchFn.mockImplementationOnce(
      async (): Promise<ChatDispatchResult> => ({
        ok: true,
        result: { status: 'awaiting_approval' },
        run_held: { kind: 'approval' },
      }),
    );
    h.setNow(7_000);

    const result = await dispatchMail(h, 't2');

    expect(result).toMatchObject({
      ok: true,
      run_held: { kind: 'approval' },
    });
    expect(
      h.broadcasted.find(
        (event) =>
          event.kind === 'chat.tool_call_completed'
          && event.turn_id === 't2',
      ),
    ).toMatchObject({
      status: 'ok',
      run_held: 'approval',
      plan_id: planId,
    });
    expect(
      h.planApprovalStore.listForSession(h.session_id).find(
        (record) => record.plan.plan_id === planId,
      )?.execution,
    ).toEqual({
      status: 'held',
      turn_id: 't2',
      result_ref: `${h.session_id}:t2:mail.send`,
      hold_kind: 'approval',
    });
  });

  it('treats consumed approvals as single-use and mints a fresh later-turn proposal', async () => {
    const h = buildOrchestratorHarness();
    const consumedPlanId = await consumeApprovedPlanOnce(h);
    h.setNow(8_000);

    const result = await dispatchMail(h, 't3');

    const freshPlanId = expectAwaitingApproval(result);
    expect(freshPlanId).not.toBe(consumedPlanId);
    expect(h.planApprovalStore.get(freshPlanId)?.status).toBe('proposed');
    expect(h.dispatchFn).toHaveBeenCalledTimes(1);
  });

  it('mints a fresh same-turn proposal after a same-turn approval is already spent', async () => {
    const h = buildOrchestratorHarness();
    const proposed = await dispatchMail(h, 't1');
    const spentPlanId = expectAwaitingApproval(proposed);
    approveHarnessPlan(h, spentPlanId, 6_000);
    h.setNow(7_000);
    const spent = await dispatchMail(h, 't1');
    expect(spent.ok).toBe(true);
    expect(h.planApprovalStore.get(spentPlanId)?.consumed_at).toBe(7_000);

    h.setNow(8_000);
    const result = await dispatchMail(h, 't1');

    const freshPlanId = expectAwaitingApproval(result);
    expect(freshPlanId).not.toBe(spentPlanId);
    expect(h.planApprovalStore.get(freshPlanId)?.status).toBe('proposed');
    expect(h.dispatchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps cancelled plans turn-scoped: same turn blocks, later turn re-proposes', async () => {
    const h = buildOrchestratorHarness();
    const proposed = await dispatchMail(h, 't1');
    const cancelledPlanId = expectAwaitingApproval(proposed);
    cancelHarnessPlan(h, cancelledPlanId, 6_000);

    const sameTurn = await dispatchMail(h, 't1');
    expect(expectPlanCancelled(sameTurn)).toBe(cancelledPlanId);

    h.setNow(7_000);
    const laterTurn = await dispatchMail(h, 't2');

    const freshPlanId = expectAwaitingApproval(laterTurn);
    expect(freshPlanId).not.toBe(cancelledPlanId);
    expect(h.planApprovalStore.get(freshPlanId)?.status).toBe('proposed');
    expect(h.dispatchFn).not.toHaveBeenCalled();
  });

  it('lets same-turn cancel beat an older unconsumed approval for the same args', async () => {
    const h = buildOrchestratorHarness();
    const proposedT2 = await dispatchMail(h, 't2');
    const cancelledT2PlanId = expectAwaitingApproval(proposedT2);
    cancelHarnessPlan(h, cancelledT2PlanId, 6_000);
    const approvedT1 = seedPlan(h.planApprovalStore, {
      plan_id: 'seed-approved-t1',
      session_id: h.session_id,
      turn_id: 't1',
      status: 'approved',
      created_at: 5_500,
      resolved_at: 6_500,
    });
    h.setNow(7_000);

    const result = await dispatchMail(h, 't2');

    expect(expectPlanCancelled(result)).toBe(cancelledT2PlanId);
    expect(h.dispatchFn).not.toHaveBeenCalled();
    expect(h.planApprovalStore.get(approvedT1.plan_id)?.consumed_at).toBeUndefined();
  });

  it('does not let a different args payload inherit an approved plan', async () => {
    const h = buildOrchestratorHarness();
    const proposedA = await dispatchMail(h, 't1', mailArgsA);
    const approvedPlanId = expectAwaitingApproval(proposedA);
    approveHarnessPlan(h, approvedPlanId, 6_000);
    h.setNow(7_000);

    const result = await dispatchMail(h, 't2', mailArgsB);

    const freshPlanId = expectAwaitingApproval(result);
    expect(freshPlanId).not.toBe(approvedPlanId);
    expect(h.planApprovalStore.get(approvedPlanId)?.consumed_at).toBeUndefined();
    expect(h.planApprovalStore.get(freshPlanId)?.args).toEqual(mailArgsB);
    expect(h.dispatchFn).not.toHaveBeenCalled();
  });
});
