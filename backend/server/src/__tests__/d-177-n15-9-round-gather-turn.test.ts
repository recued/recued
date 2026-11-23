/** D-177 §N.15.9 — Q7 in a turn of the owner's app chat ("After each round"): the round's held calls
 *  of one op are kept, asked once when the round ends, and the round waits for that approval (the
 *  owner's 3a); the model's next round reads every one's result.
 *
 *  Through the REAL orchestrator and turn loop. The registry's dispatch does what the tool handlers
 *  do (`roundGatherFor`, slice L): a call its round gathers goes ahead and keeps its hold for the
 *  round's end (`deferToRound`); any other call that would ask is not asked while one waits. Its
 *  notifier records the asks; the owner's answer comes through the same waiters the server feeds. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type {
  AIOutput, ChatDispatchResult, Checkpoint, InternalToolRegistry, RecuedServerSignature, ToolEntry,
} from '@recued/contracts';
import { PREFLIGHT_GATHERED_HANDLER_KIND, PREFLIGHT_HANDLER_KIND, type PreflightNotifier } from '@recued/gateway';

import { askAfterWaiting, notAskedYetMessage } from '../chat-carries-on.js';
import { createChatOrchestrator, type ExecuteChatAiCall } from '../chat-orchestrator.js';
import { deferToRound, gatherCallKey, gatherOpKey, gathersInRound, readsOnceAsked, roundAccepts } from '../chat-gather.js';
import { createHeldRunWaiters, settledHeldCallResult } from '../held-run-waiters.js';
import type { PreflightRunSettled } from '../preflight-resumer.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const SIGNATURE: RecuedServerSignature = { server_kind: 'recued', version: '1', instance_id: 'round-gather-turn' };
const SEND = 'kitchen/tell-guest';
const NOTE = 'kitchen/note-guest';
const READ = 'kitchen/read-guest';
const entry = (name: string): ToolEntry => ({
  name, tier: 2, description: name,
  arg_schema: { type: 'object', properties: { to: { type: 'string' } }, additionalProperties: false },
  topic_tags: [], classification: 'unknown', concurrency_safe: false,
});
const NOW = Date.UTC(2030, 3, 2, 10, 0, 0);
const GUESTS = ['dana@example.com', 'priya@example.com', 'omar@example.com'];
const LATE = 'lee@example.com';

const ran = (to: string) => ({
  success: true, recipe_id: 'tell-guest', errors: [],
  steps: [{ id: 'send', status: 'ok', result: { sent: to } }],
  output: { sidebar: [], render: [{ type: 'summary', fields: [{ label: 'Sent', value: `told ${to}` }] }] },
});
const settledFor = (run_id: string, result: unknown): PreflightRunSettled => ({
  execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'local' },
  run_id, tool_name: SEND, result, ts: NOW + 2_000,
});

interface Kept { readonly run_id: string; readonly to: string }

const turn = async (options: {
  rounds: AIOutput[];
  /** The owner answers once the round's approval is out; without it, nobody answers in time. */
  answer?: (waiters: ReturnType<typeof createHeldRunWaiters>, kept: readonly Kept[]) => void;
  /** Where the approval goes, as its ask's record reads (D-329). */
  channels?: readonly string[];
}) => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  const store = createChatStore(db);
  store.createSession({ id: 's1', now: NOW - 10_000 });
  const packets: string[] = [];
  const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_manifest, aiInput) => {
    packets.push(String(aiInput['llm.prompt']));
    return { body: options.rounds[Math.min(packets.length, options.rounds.length) - 1]! };
  });
  const waiters = createHeldRunWaiters({ now: () => NOW });
  const asks: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const kept: Kept[] = [];
  const notifier = {
    ask: vi.fn(async (_m: unknown, _o: unknown, handler: { kind: string; payload: Record<string, unknown> }) => {
      asks.push(handler);
      if (options.answer !== undefined) setTimeout(() => options.answer!(waiters, [...kept]), 10);
      return { ask_id: `ask-${String(asks.length)}` };
    }),
    registerAskHandler: vi.fn(), notify: vi.fn(),
  } as unknown as PreflightNotifier;
  let seq = 0;
  const dispatch = vi.fn<InternalToolRegistry['dispatch']>(async (name, args, ctx) => {
    if (name === READ) return { ok: true, result: { guest: 'found' } };
    const to = String((args as { to?: unknown }).to);
    const call_key = gatherCallKey(name, args);
    // As a tool handler does: a call its round gathers goes ahead; any other waits while one waits.
    const gathering = gathersInRound(ctx.turn_state, ctx.execution_source, name, args)
      && roundAccepts(ctx.turn_state, call_key);
    const waitingFor = gathering ? undefined : askAfterWaiting(ctx.execution_source, ctx.turn_state);
    if (waitingFor !== undefined) return { ok: false, reason: 'not_asked_yet', detail: notAskedYetMessage(waitingFor) };
    seq += 1;
    const run_id = `run-${String(seq)}`;
    const held: ChatDispatchResult = {
      ok: true, result: { status: 'awaiting_approval', awaiting_approval: true }, run_held: { kind: 'approval' }, run_id,
    };
    if (gathering && deferToRound(ctx.turn_state, {
      run_id, tool_name: name, call_key, op_key: gatherOpKey({ ingredient_slug: 'mail-send', recipe_id: name }), notifier,
      checkpoint: {
        checkpoint_id: `cp-${run_id}`, run_id, gated_step_id: 'send', created_at: seq, step_state: {},
        preflight_context: { tool_slug: 'mail-send', risk_tier: 'write', recipe_title: 'Tell a guest' },
      } as unknown as Checkpoint,
      context: { recipe_id: name, gated_step_id: 'send', tool_slug: 'mail-send', risk_tier: 'write' },
      item: { summary: 'mail-send', args_preview: { to } },
      link: async () => undefined,
      ...(options.channels !== undefined ? { askChannels: async () => options.channels } : {}),
    })) {
      kept.push({ run_id, to });
      const gathered: ChatDispatchResult = { ...held, run_held: { kind: 'approval', gathered: true } };
      // As the handler says how the held result reads once the ask is out.
      readsOnceAsked(ctx.turn_state, run_id, (approval_channels) => ({
        ...gathered, result: { ...held.result as object, approval_elsewhere: `goes to ${approval_channels.join(' and ')}` },
      }));
      return gathered;
    }
    await notifier.ask({ title: 'own', text: 'own' } as never, [], { kind: PREFLIGHT_HANDLER_KIND, payload: { run_id } } as never);
    return held;
  });
  const entries = [entry(SEND), entry(NOTE), entry(READ)];
  const registry: InternalToolRegistry = {
    list: () => entries, listByTier: (tier) => (tier === 2 ? entries : []),
    getByName: (name) => entries.find((e) => e.name === name) ?? null, dispatch, subscribeRefresh: () => () => undefined,
  };
  const settleHeldCall = vi.fn(async (call: { run_id: string; held: ChatDispatchResult; until: number; signal?: AbortSignal }) => {
    // Nobody answers: the round's minute runs out (at once here).
    if (options.answer === undefined) return undefined;
    const settled = await waiters.wait(call.run_id, call.until, call.signal);
    return settled === undefined ? undefined : settledHeldCallResult(settled, call.held);
  });
  const orchestrator = createChatOrchestrator({ chatStore: store, registry, selfSignature: SIGNATURE, executeAiCall,
    now: () => NOW, settleHeldCall } as never);
  // The addresses are the owner's own words: a call may only carry values the model was given.
  await orchestrator.runTurn({ session_id: 's1', picker_state: { current: 'self' },
    message: `Tell ${[...GUESTS, LATE].join(', ')} the new time.` } as never);
  db.close();
  return { packets, asks, settleHeldCall, dispatch, kept };
};

const tellAll: AIOutput = { response: '', events: [], tool_calls: GUESTS.map((to) => ({ tool: SEND, args: { to } })) };
const done = (response: string): AIOutput => ({ response, events: [], tool_calls: [] });
/** The count of a round's results the model read as not asked. */
const notAskedIn = (packet: string | undefined): number => (packet ?? '').split('"reason":"not_asked_yet"').length - 1;

describe('D-177 §N.15.9 — a round\'s held calls of one op are asked once, when the round ends', () => {
  it('one approval for the three; answered in time, the next round reads all three results', async () => {
    const { packets, asks, settleHeldCall, kept } = await turn({
      rounds: [tellAll, done('All three were told.')],
      answer: (waiters, runs) => runs.forEach((run) => waiters.settled(settledFor(run.run_id, ran(run.to)))),
    });
    expect(kept.map((k) => k.run_id)).toEqual(['run-1', 'run-2', 'run-3']);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.kind).toBe(PREFLIGHT_GATHERED_HANDLER_KIND);
    expect(settleHeldCall).toHaveBeenCalledTimes(3);
    for (const to of GUESTS) expect(packets[1]).toContain(`told ${to}`);
    expect(packets[1]).not.toContain('awaiting_approval');
  });

  it('refused: the model reads that the owner said no, for each', async () => {
    const { packets } = await turn({
      rounds: [tellAll, done('Not sent.')],
      answer: (waiters, runs) => runs.forEach((run) => waiters.settled(settledFor(run.run_id, { success: false, denied: true }))),
    });
    expect(packets[1]).not.toContain('awaiting_approval');
    expect(packets[1]!.split('plan_cancelled').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('not answered in time: all three stay held, and the next round\'s send is not asked', async () => {
    const { packets, asks } = await turn({
      rounds: [tellAll, { response: '', events: [], tool_calls: [{ tool: SEND, args: { to: LATE } }] }, done('Waiting.')],
    });
    expect(asks).toHaveLength(1);
    expect(packets[1]!.split('awaiting_approval').length - 1).toBeGreaterThanOrEqual(3);
    // It waits after the three (slice K): not asked, and no second approval.
    expect(notAskedIn(packets[2])).toBe(1);
  });

  it('D-329: not answered, each still held is told where the approval went', async () => {
    const { packets } = await turn({ rounds: [tellAll, done('Waiting.')], channels: ['ui', 'slack'] });
    expect(packets[1]!.split('goes to ui and slack').length - 1).toBe(3);
  });

  it('a round that does not repeat a call asks at once, as before', async () => {
    const { asks, kept } = await turn({
      rounds: [{ response: '', events: [], tool_calls: [{ tool: SEND, args: { to: GUESTS[0] } }] }, done('Asked.')],
    });
    expect(kept).toEqual([]);
    expect(asks.map((ask) => ask.kind)).toEqual([PREFLIGHT_HANDLER_KIND]);
  });

  it('a read between them runs; the round still asks once', async () => {
    const { asks, dispatch } = await turn({
      rounds: [{ response: '', events: [], tool_calls: [
        { tool: SEND, args: { to: GUESTS[0] } }, { tool: READ, args: { to: GUESTS[0] } }, { tool: SEND, args: { to: GUESTS[1] } },
      ] }, done('Done.')],
    });
    expect(dispatch.mock.calls.map(([name]) => name)).toEqual([SEND, READ, SEND]);
    expect(asks.map((ask) => ask.kind)).toEqual([PREFLIGHT_GATHERED_HANDLER_KIND]);
  });

  it('another op the round repeats is not asked: it comes after the first op\'s approval', async () => {
    const { packets, asks, kept } = await turn({
      rounds: [{ response: '', events: [], tool_calls: [
        { tool: SEND, args: { to: GUESTS[0] } }, { tool: SEND, args: { to: GUESTS[1] } },
        { tool: NOTE, args: { to: GUESTS[0] } }, { tool: NOTE, args: { to: GUESTS[1] } },
      ] }, done('The notes come after.')],
    });
    expect(kept.map((k) => k.to)).toEqual([GUESTS[0], GUESTS[1]]);
    expect(asks.map((ask) => ask.kind)).toEqual([PREFLIGHT_GATHERED_HANDLER_KIND]);
    expect(notAskedIn(packets[1])).toBe(2);
  });

  it('a call not asked closes the round: a later repeat of the first op does not jump ahead of it', async () => {
    const { packets, asks, kept } = await turn({
      rounds: [{ response: '', events: [], tool_calls: [
        { tool: SEND, args: { to: GUESTS[0] } }, { tool: NOTE, args: { to: GUESTS[0] } }, { tool: SEND, args: { to: GUESTS[1] } },
      ] }, done('One asked; the rest come after.')],
    });
    expect(kept.map((k) => k.to)).toEqual([GUESTS[0]]);
    // One kept hold asks as its own would have.
    expect(asks.map((ask) => ask.kind)).toEqual([PREFLIGHT_HANDLER_KIND]);
    expect(notAskedIn(packets[1])).toBe(2);
  });
});
