/** D-337 ruling 4, design (a) — an LLM gateway request waits for the owner's answer to a call it
 *  holds, and its model carries on with the call's outcome.
 *
 *  The owner, of a conversation under a contract: "that piece is held, until owner approves then
 *  it passed back to the model of that session". The gateway's conversation is one HTTP request,
 *  so the held call's dispatch waits (`settleHeldCall`, fed by the run-settled listener) and the
 *  model's next round reads the run's result in place of "waiting for approval". Past the request's
 *  limit it reads the held outcome, as before. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type {
  AIOutput,
  ChatDispatchResult,
  ContractSnapshot,
  InternalToolRegistry,
  RecuedServerSignature,
  ToolEntry,
} from '@recued/contracts';

import { createChatOrchestrator, type ExecuteChatAiCall, type LlmGatewayTurnInput } from '../chat-orchestrator.js';
import { LLM_GATEWAY_CARRIED_NOTE, LLM_GATEWAY_HELD_MESSAGE, llmGatewayStillWaitingNote } from '../ports/llm-gateway/held-calls.js';
import { HELD_RESULT_REFUSED_DETAIL } from '../chat-held-results.js';
import { createHeldRunWaiters, settledHeldCallResult } from '../held-run-waiters.js';
import type { PreflightRunSettled } from '../preflight-resumer.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const SELF_SIGNATURE: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'd337-gateway-held-wait',
};
const CONTRACT = 'customer-contract';
const SNAPSHOT: ContractSnapshot = {
  contract_id: CONTRACT,
  contract_version: '1',
  allowed_tools: ['seller-remove-event'],
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 1_000,
};
const RECIPE = 'seller/remove-event';
const ENTRY: ToolEntry = {
  name: RECIPE,
  tier: 2,
  description: 'remove an event',
  arg_schema: {
    type: 'object',
    properties: { title: { type: 'string' } },
    additionalProperties: false,
  },
  topic_tags: ['write'],
  classification: 'write',
  concurrency_safe: false,
};

/** What the run's dispatch returns while it waits for the owner. */
const heldResult = (run_id: string, kind: 'approval' | 'container_pick' = 'approval'): ChatDispatchResult => ({
  ok: true,
  result: { status: 'awaiting_approval', awaiting_approval: true, message: 'Held for the owner.' },
  run_held: { kind },
  run_id,
});

/** The run's own response once the owner approved it and it ran. */
const ranResponse = (title: string) => ({
  success: true,
  recipe_id: RECIPE,
  errors: [],
  steps: [{ id: 'removed', status: 'ok', result: { removed: title } }],
  output: { sidebar: [], render: [{ type: 'summary', fields: [{ label: 'Removed', value: `Event removed: ${title}` }] }] },
});

const harness = (input: {
  dispatch: InternalToolRegistry['dispatch'];
  rounds: AIOutput[];
  now?: () => number;
  waiters?: ReturnType<typeof createHeldRunWaiters>;
  failAiRound?: number;
}) => {
  const aiInputs: Record<string, unknown>[] = [];
  let round = 0;
  const executeAiCall: ExecuteChatAiCall = vi.fn(async (_manifest, aiInput) => {
    aiInputs.push(aiInput);
    const at = round++;
    if (input.failAiRound === at) {
      throw Object.assign(new Error('authority changed'), { code: 'llm_gateway_authority_changed' });
    }
    return { body: input.rounds[Math.min(at, input.rounds.length - 1)]! };
  });
  const registry: InternalToolRegistry = {
    list: () => [ENTRY],
    listByTier: (tier) => (tier === 2 ? [ENTRY] : []),
    getByName: (name) => (name === RECIPE ? ENTRY : null),
    dispatch: vi.fn(input.dispatch),
    subscribeRefresh: () => () => undefined,
  };
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const waiters = input.waiters ?? createHeldRunWaiters({ now: input.now ?? Date.now });
  const settleHeldCall = vi.fn(async (call: {
    run_id: string; held: ChatDispatchResult; until: number; signal?: AbortSignal;
  }) => {
    const settled = await waiters.wait(call.run_id, call.until, call.signal);
    return settled === undefined ? undefined : settledHeldCallResult(settled, call.held);
  });
  const orchestrator = createChatOrchestrator({
    chatStore: createChatStore(db),
    registry,
    selfSignature: SELF_SIGNATURE,
    now: input.now ?? Date.now,
    mintId: () => 'gateway-turn',
    executeAiCall,
    settleHeldCall,
  });
  const run = (
    held_wait?: { ms: number; signal?: AbortSignal },
    extra: Partial<LlmGatewayTurnInput> = {},
  ) => orchestrator.runLlmGatewayTurn!({
    session_id: 'llm_gateway:token-1:req-1',
    user_id: 'customer-token',
    contract_id: CONTRACT,
    content: { chat_tail: [], user_message: 'remove the dentist event' },
    allowed_tool_names: [RECIPE],
    resolve_contract_snapshot: async () => SNAPSHOT,
    execute_ai_call: executeAiCall,
    model_layer: 'byok',
    ...(held_wait !== undefined ? { held_wait } : {}),
    ...extra,
  });
  return { run, aiInputs, waiters, settleHeldCall, registry };
};

const callRemove = (title = 'Dentist'): AIOutput => ({
  response: '', events: [], tool_calls: [{ tool: RECIPE, args: { title } }],
});
const answer = (text: string): AIOutput => ({ response: text, events: [], tool_calls: [] });
const settledFor = (run_id: string, result: unknown): PreflightRunSettled => ({
  execution_source: { channel: 'chat', actor: 'contracted_user', chat_session_id: 'llm_gateway:token-1', user_id: 'customer-token', contract_id: CONTRACT },
  run_id,
  tool_name: RECIPE,
  result,
  ts: Date.now(),
});

describe('D-337 ruling 4 (a) — the gateway request waits for the owner\'s answer', () => {
  it('approved within the limit: the model reads the run\'s result, not "waiting", and answers from it', async () => {
    let h!: ReturnType<typeof harness>;
    h = harness({
      // The owner answers shortly after the call is held, as from their phone.
      dispatch: async () => {
        setTimeout(() => h.waiters.settled(settledFor('run-1', ranResponse('Dentist'))), 20);
        return heldResult('run-1');
      },
      rounds: [callRemove(), answer('The dentist event is removed.')],
    });
    const result = await h.run({ ms: 60_000 });

    expect(result.assistant_content).toBe('The dentist event is removed.');
    expect(h.settleHeldCall).toHaveBeenCalledTimes(1);
    expect(h.settleHeldCall.mock.calls[0]![0]).toMatchObject({ run_id: 'run-1' });
    const second = String(h.aiInputs[1]?.['llm.prompt']);
    expect(second).toContain('Event removed: Dentist');
    expect(second).not.toContain('awaiting_approval');
    expect(result.post_effect_outcome).toBeUndefined();
  });

  it('not answered within the limit: the model reads the held outcome, as before', async () => {
    const h = harness({
      dispatch: async () => heldResult('run-2'),
      rounds: [callRemove(), answer('It is waiting for the owner\'s approval.')],
    });
    const result = await h.run({ ms: 30 });

    expect(result.assistant_content).toBe('It is waiting for the owner\'s approval.');
    expect(h.settleHeldCall).toHaveBeenCalledTimes(1);
    expect(String(h.aiInputs[1]?.['llm.prompt'])).toContain('awaiting_approval');
  });

  it('refused: the model reads that the owner said no, and that it did not run', async () => {
    let h!: ReturnType<typeof harness>;
    h = harness({
      dispatch: async () => {
        setTimeout(() => h.waiters.settled(settledFor('run-3', { denied: true, message: 'The owner denied it.' })), 10);
        return heldResult('run-3');
      },
      rounds: [callRemove(), answer('The owner declined the removal.')],
    });
    const result = await h.run({ ms: 60_000 });

    expect(result.assistant_content).toBe('The owner declined the removal.');
    const second = String(h.aiInputs[1]?.['llm.prompt']);
    expect(second).toContain(HELD_RESULT_REFUSED_DETAIL);
    expect(second).not.toContain('awaiting_approval');
  });

  it('⛔ CONTROL: with no limit given, a held call returns at once and nothing waits', async () => {
    const h = harness({
      dispatch: async () => heldResult('run-4'),
      rounds: [callRemove(), answer('Held.')],
    });
    await h.run();
    expect(h.settleHeldCall).not.toHaveBeenCalled();
  });

  it('a hold that needs the caller\'s own choice (a container pick) does not wait for the owner', async () => {
    const h = harness({
      dispatch: async () => heldResult('run-5', 'container_pick'),
      rounds: [callRemove(), answer('Pick a project.')],
    });
    await h.run({ ms: 60_000 });
    expect(h.settleHeldCall).not.toHaveBeenCalled();
  });

  it('the limit is for the whole request: a second held call waits only what is left of it', async () => {
    let clock = 1_000_000;
    const now = (): number => clock;
    const timers: Array<() => void> = [];
    const waiters = createHeldRunWaiters({
      now,
      setTimer: (run) => { timers.push(run); return timers.length - 1; },
      clearTimer: () => undefined,
    });
    let h!: ReturnType<typeof harness>;
    let calls = 0;
    h = harness({
      now,
      waiters,
      dispatch: async () => {
        const run_id = `run-6${String(calls++)}`;
        if (calls === 1) {
          // The owner answers the first 30 s after it was held.
          setTimeout(() => { clock += 30_000; h.waiters.settled(settledFor(run_id, ranResponse('A'))); }, 5);
        } else {
          // Nobody answers the second: its wait runs out.
          setTimeout(() => { clock += 60_000; timers[timers.length - 1]!(); }, 5);
        }
        return heldResult(run_id);
      },
      rounds: [callRemove('A'), callRemove('B'), answer('A is removed; B waits for the owner.')],
    });
    await h.run({ ms: 90_000 });

    expect(h.settleHeldCall).toHaveBeenCalledTimes(2);
    const [first, second] = h.settleHeldCall.mock.calls.map((c) => c[0]);
    // One deadline for the request: 90 s from the first wait. The second began 30 s in.
    expect(first!.until).toBe(1_090_000);
    expect(second!.until).toBe(1_090_000);
    expect(String(h.aiInputs[1]?.['llm.prompt'])).toContain('Event removed: A');
    expect(String(h.aiInputs[2]?.['llm.prompt'])).toContain('awaiting_approval');
  });

  it('once the limit is spent, a later held call is not waited on at all', async () => {
    let clock = 2_000_000;
    const now = (): number => clock;
    const timers: Array<() => void> = [];
    const waiters = createHeldRunWaiters({
      now,
      setTimer: (run) => { timers.push(run); return timers.length - 1; },
      clearTimer: () => undefined,
    });
    let calls = 0;
    const h = harness({
      now,
      waiters,
      dispatch: async () => {
        const run_id = `run-8${String(calls++)}`;
        if (calls === 1) setTimeout(() => { clock += 90_000; timers[timers.length - 1]!(); }, 5);
        return heldResult(run_id);
      },
      rounds: [callRemove('A'), callRemove('B'), answer('Both wait for the owner.')],
    });
    await h.run({ ms: 90_000 });

    expect(h.settleHeldCall).toHaveBeenCalledTimes(1);
    expect(h.registry.dispatch).toHaveBeenCalledTimes(2);
  });

  it('a settled call counts as work done: a failure after it is reported as completed work, not as nothing', async () => {
    let h!: ReturnType<typeof harness>;
    h = harness({
      dispatch: async () => {
        setTimeout(() => h.waiters.settled(settledFor('run-7', ranResponse('Dentist'))), 10);
        return heldResult('run-7');
      },
      rounds: [callRemove(), answer('unreached')],
      failAiRound: 1,
    });
    const result = await h.run({ ms: 60_000 });
    expect(result.post_effect_outcome).toMatchObject({
      status: 'completed',
      error_code: 'llm_gateway_authority_changed',
      dispatched_tool_calls: 1,
    });
  });
});

describe('D-337 follow-up 24 (b) — a call still waiting when the request ends', () => {
  it('is given its reference before any wait, and the reply names it; the model reads the gateway\'s words', async () => {
    const order: string[] = [];
    const h = harness({
      dispatch: async () => {
        order.push('dispatched');
        return { ...heldResult('run-b1'), result: {
          status: 'awaiting_approval', awaiting_approval: true, recipe_id: RECIPE,
          message: 'Approvals are answered in the Recued app, from the bell.',
          approval_elsewhere: 'It can also be answered on Telegram.',
        } } as ChatDispatchResult;
      },
      rounds: [callRemove(), answer('It is waiting for approval.')],
    });
    const on_held = vi.fn(async (call: { run_id: string; tool_name: string }) => {
      order.push(`registered ${call.run_id} ${call.tool_name}`);
      return 'mcpact_ref_b1';
    });
    h.settleHeldCall.mockImplementation(async () => { order.push('waited'); return undefined; });
    const result = await h.run({ ms: 30 }, { on_held, held_message: LLM_GATEWAY_HELD_MESSAGE });

    expect(order).toEqual(['dispatched', `registered run-b1 ${RECIPE}`, 'waited']);
    expect(result.waiting_refs).toEqual(['mcpact_ref_b1']);
    const second = String(h.aiInputs[1]?.['llm.prompt']);
    expect(second).toContain('queued for approval in Recued by the person who runs this service');
    expect(second).not.toContain('from the bell');
    expect(second).not.toContain('Telegram');
  });

  it('a call answered within the wait is told now, and its reference does not go on the reply', async () => {
    let h!: ReturnType<typeof harness>;
    h = harness({
      dispatch: async () => {
        setTimeout(() => h.waiters.settled(settledFor('run-b2', ranResponse('Dentist'))), 10);
        return heldResult('run-b2');
      },
      rounds: [callRemove(), answer('Removed.')],
    });
    const result = await h.run({ ms: 60_000 }, {
      on_held: async () => 'mcpact_ref_b2',
      held_message: LLM_GATEWAY_HELD_MESSAGE,
    });
    expect(result.waiting_refs).toBeUndefined();
    expect(String(h.aiInputs[1]?.['llm.prompt'])).toContain('Event removed: Dentist');
  });

  it('a registration that fails leaves the call held as before, with nothing on the reply', async () => {
    const h = harness({
      dispatch: async () => heldResult('run-b3'),
      rounds: [callRemove(), answer('Waiting.')],
    });
    const result = await h.run({ ms: 20 }, {
      on_held: async () => { throw new Error('store locked'); },
      held_message: LLM_GATEWAY_HELD_MESSAGE,
    });
    expect(result.waiting_refs).toBeUndefined();
    expect(String(h.aiInputs[1]?.['llm.prompt'])).toContain('queued for approval in Recued');
  });

  it('outcomes an earlier reply left waiting open the turn, with the note saying why', async () => {
    const h = harness({
      dispatch: async () => ({ ok: true, result: {} }),
      rounds: [answer('The dentist event was removed, as you asked earlier.')],
    });
    await h.run(undefined, {
      held_results: [{
        tool_name: RECIPE, tier: 2, args: {}, status: 'ok', result: { removed: 'Dentist (approved later)' },
        started_at: 1_000, completed_at: 2_000,
      }],
      in_flight_context: LLM_GATEWAY_CARRIED_NOTE,
    });
    const first = String(h.aiInputs[0]?.['llm.prompt']);
    expect(first).toContain('Dentist (approved later)');
    expect(first).toContain('have since been answered');
    expect(h.registry.dispatch).not.toHaveBeenCalled();
  });

  it('D-337 slice S — a turn whose call still waits reads that it cannot check on it or write first', async () => {
    const h = harness({
      dispatch: async () => ({ ok: true, result: {} }),
      rounds: [answer('It is still waiting for approval.')],
    });
    await h.run(undefined, { in_flight_context: llmGatewayStillWaitingNote(1, false) });
    const first = String(h.aiInputs[0]?.['llm.prompt']);
    expect(first).toContain('you cannot write to the user first');
    expect(first).toContain('when they next write in this conversation');
    expect(h.registry.dispatch).not.toHaveBeenCalled();
  });
});
