import { describe, expect, it, vi } from 'vitest';
import { RpcError } from '@recued/contracts';

import {
  handleExecutionCaseDiagnostics,
  handleExecutionCaseFeedback,
  handleExecutionCaseFeedbackRetract,
  handlePlanCancel,
  handleSend,
  type ChatRpcDeps,
} from '../chat-handler.js';

const deps = (
  recorder: Partial<
    NonNullable<ChatRpcDeps['executionCaseFeedbackRecorder']>
  >,
): ChatRpcDeps => ({
  store: {
    getSession: (id: string) => id === 's1' ? { id: 's1' } : undefined,
  },
  executionCaseFeedbackRecorder: {
    record: async () => ({ ok: true, recorded: false }),
    retract: async () => ({ ok: true, retracted: false }),
    ...recorder,
  },
  orchestrator: {},
  selfSignature: {
    server_kind: 'recued',
    version: 'test',
    instance_id: 'self',
  },
} as unknown as ChatRpcDeps);

describe('D-214 explicit feedback RPC', () => {
  it('accepts a typed same-session correlation handle and never accepts a case id', async () => {
    const record = vi.fn(async () => ({ ok: true as const, recorded: true }));
    await expect(handleExecutionCaseFeedback(deps({ record }), {
      session_id: 's1',
      turn_id: 't1',
      kind: 'corrected',
      source_plan_id: 'p1',
    })).resolves.toEqual({ recorded: true });
    expect(record).toHaveBeenCalledWith({
      session_id: 's1',
      turn_id: 't1',
      kind: 'corrected',
      source_plan_id: 'p1',
    });

    await expect(handleExecutionCaseFeedback(deps({ record }), {
      session_id: 's1',
      turn_id: 't1',
      kind: 'accepted',
      case_id: 'case-attacker-chosen',
    })).rejects.toBeInstanceOf(RpcError);
  });

  it('fails closed on an unanchored turn and rejects silence-like kinds', async () => {
    await expect(handleExecutionCaseFeedback(deps({
      record: async () => ({ ok: false, reason: 'span_not_found' }),
    }), {
      session_id: 's1',
      turn_id: 'missing',
      kind: 'accepted',
    })).rejects.toMatchObject({ status: 404 });

    await expect(handleExecutionCaseFeedback(deps({
      record: async () => ({ ok: true, recorded: true }),
    }), {
      session_id: 's1',
      turn_id: 't1',
      kind: 'no_complaint',
    })).rejects.toMatchObject({ status: 400 });
  });

  it('retracts only the same server-resolved typed target', async () => {
    const retract = vi.fn(async () => ({
      ok: true as const,
      retracted: true,
    }));
    await expect(handleExecutionCaseFeedbackRetract(deps({ retract }), {
      session_id: 's1',
      turn_id: 't1',
      kind: 'rejected',
      source_plan_id: 'p1',
    })).resolves.toEqual({ retracted: true });
    expect(retract).toHaveBeenCalledWith({
      session_id: 's1',
      turn_id: 't1',
      kind: 'rejected',
      source_plan_id: 'p1',
    });

    await expect(handleExecutionCaseFeedbackRetract(deps({ retract }), {
      session_id: 's1',
      turn_id: 't1',
      kind: 'rejected',
      case_id: 'case-attacker-chosen',
    })).rejects.toMatchObject({ status: 400 });
    await expect(handleExecutionCaseFeedbackRetract(deps({ retract }), {
      session_id: 's1',
      turn_id: 't1',
      kind: 'rejected',
      feedback_id: 'feedback-attacker-chosen',
    })).rejects.toMatchObject({ status: 400 });
    await expect(handleExecutionCaseFeedbackRetract(deps({
      retract: async () => ({ ok: false, reason: 'span_not_found' }),
    }), {
      session_id: 's1',
      turn_id: 'missing',
      kind: 'rejected',
    })).rejects.toMatchObject({ status: 404 });
  });
});

describe('D-214 owner diagnostics RPC', () => {
  it('returns only the wired aggregate and fails closed when unwired', async () => {
    const aggregate = {
      active_experiment: false,
      compiler: { materialized_cases: 0 },
    };
    const wired = {
      ...deps({ record: async () => ({ ok: true, recorded: true }) }),
      executionCaseDiagnostics: vi.fn(async () => aggregate),
    };
    await expect(handleExecutionCaseDiagnostics(wired))
      .resolves.toEqual(aggregate);
    expect(wired.executionCaseDiagnostics).toHaveBeenCalledOnce();

    await expect(handleExecutionCaseDiagnostics(
      deps({ record: async () => ({ ok: true, recorded: true }) }),
    )).rejects.toMatchObject({ status: 501 });
  });
});

describe('D-214 explicit conversational continuation RPC', () => {
  const sendDeps = (
    anchorLookup?: (session: string, turn: string) => unknown,
  ): { deps: ChatRpcDeps; runTurn: ReturnType<typeof vi.fn> } => {
    const runTurn = vi.fn(async () => ({ turn_id: 'turn-new' }));
    return {
      deps: {
        store: {
          getSession: (id: string) =>
            id === 's1' ? { id: 's1' } : undefined,
        },
        orchestrator: { runTurn },
        ...(anchorLookup
          ? {
              executionSpanAnchorStore: {
                getAnchor: anchorLookup,
              },
            }
          : {}),
        selfSignature: {
          server_kind: 'recued',
          version: 'test',
          instance_id: 'self',
        },
      } as unknown as ChatRpcDeps,
      runTurn,
    };
  };

  it('accepts only a prior same-session turn and forwards no caller root id', async () => {
    const { deps: wired, runTurn } = sendDeps((session, turn) =>
      session === 's1' && turn === 'turn-prior'
        ? {
            session_id: session,
            turn_id: turn,
            root_request_id: 'server-root',
            created_at: 1,
          }
        : undefined);
    await expect(handleSend(wired, {
      session_id: 's1',
      message: 'try a different approach',
      picker_state: { current: 'self' },
      continuation_of_turn_id: 'turn-prior',
    })).resolves.toEqual({ turn_id: 'turn-new' });
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      continuation_of_turn_id: 'turn-prior',
    }));
    expect(runTurn.mock.calls[0]![0]).not.toHaveProperty('root_request_id');
  });

  it('fails closed when the turn is not in-session or anchor history is unwired', async () => {
    const wired = sendDeps(() => undefined).deps;
    await expect(handleSend(wired, {
      session_id: 's1',
      message: 'continue',
      picker_state: { current: 'self' },
      continuation_of_turn_id: 'foreign-turn',
    })).rejects.toMatchObject({ status: 400 });

    await expect(handleSend(sendDeps().deps, {
      session_id: 's1',
      message: 'continue',
      picker_state: { current: 'self' },
      continuation_of_turn_id: 'turn-prior',
    })).rejects.toMatchObject({ status: 501 });
  });
});

describe('D-214 plan-resolution closure', () => {
  it('finalizes the deferred span immediately after durable cancellation', async () => {
    const finalizeTurn = vi.fn(async () => undefined);
    const plan = {
      plan_id: 'plan-1',
      session_id: 's1',
      turn_id: 't1',
      tool: 'mail.send',
      tier: 2,
      classification: 'write',
      args: {},
      args_hash: 'hash',
      status: 'cancelled',
      created_at: 1,
      resolved_at: 2,
    } as const;
    const wired = {
      store: {},
      orchestrator: {},
      planApprovalStore: {
        resolve: vi.fn(async () => plan),
      },
      executionCaseLifecycle: { finalizeTurn },
      selfSignature: {
        server_kind: 'recued',
        version: 'test',
        instance_id: 'self',
      },
    } as unknown as ChatRpcDeps;

    await expect(handlePlanCancel(wired, { plan_id: 'plan-1' }))
      .resolves.toEqual({ plan });
    expect(finalizeTurn).toHaveBeenCalledWith({
      session_id: 's1',
      turn_id: 't1',
    });
  });
});
