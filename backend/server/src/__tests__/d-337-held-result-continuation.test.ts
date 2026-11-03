/** D-337 — an answered approval continues the conversation, as it does over MCP.
 *
 *  The owner: "it should be exactly like mcp, approval result reach model, because it continues
 *  the context and work in progress. and triggers the next action". A call held in the owner's
 *  app chat settled outside any turn and the model never read its result; now its settlement
 *  queues a turn that opens holding the call and its outcome. Then: "all channels should behave
 *  the same", so a run held in a Telegram or email chat, which keep no tool-call rows, is
 *  watched and carries its conversation on too. Through the REAL orchestrator and chat store (a
 *  scripted model reads the packet), the real run-settled sink, tool-call store and watch store,
 *  and the module over a recording queue. */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type {
  AIOutput,
  ChatDispatchResult,
  ExecutionSource,
  InternalToolRegistry,
  RecuedServerSignature,
} from '@recued/contracts';
import { CARRIED_HELD_RESULTS_NOTE, createChatOrchestrator, HELD_RESULT_TURN_NOTE, HELD_RESULTS_TURN_NOTE, type ExecuteChatAiCall } from '../chat-orchestrator.js';
import { withQueuedChatTurns, type ChatTurnQueue } from '../chat-turn-queue.js';
import { createChatTurnQueueStore } from '../storage/chat-turn-queue-store.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatRunSettledSink } from '../chat-run-settled-sink.js';
import { HELD_WRITE_EXPIRED_MESSAGE } from '../chat-held-writes.js';
import {
  createCarriedHeldResults,
  createHeldResultContinuations,
  createHeldRunReply,
  createWatchedRunSettlement,
  HELD_RESULT_MAX_RESULT_BYTES,
  HELD_RESULT_QUEUE_FAMILY,
  HELD_RESULT_RESUMED_LINE,
  HELD_RESULT_RETRIED_LINE,
  HELD_RESULT_RETRY_AFTER_MS,
  heldResultCall,
  heldResultFallback,
  heldResultRecord,
  watchHeldRunsIn,
  type HeldResultContinuation,
} from '../chat-held-results.js';
import { createHeldResultTurnStore, createHeldRunWatchStore } from '../storage/chat-held-result-store.js';
import type { PreflightRunSettled } from '../preflight-resumer.js';

const NOW = Date.UTC(2030, 3, 2, 10, 0, 0);
const signature: RecuedServerSignature = { server_kind: 'recued', version: '1', instance_id: 'test' };

const continuation = (over: Partial<HeldResultContinuation> = {}): HeldResultContinuation => ({
  session_id: 's1',
  turn_id: 't1',
  run_id: 'run-1',
  tool_name: 'calendar.create',
  tier: 1,
  args: { summary: 'Dentist' },
  outcome: 'ran',
  // A held call's settlement, as the resumer hands it over.
  result: { success: true, kind: 'completed', result: { event_id: 'evt-1' } },
  title: 'Add a calendar event',
  called_at: 1_000,
  settled_at: 2_000,
  ...over,
});

describe('D-337 — what the conversation is told', () => {
  it('records the answer in the owner\'s words, and never as theirs', () => {
    expect(heldResultRecord('ran', 'Add a calendar event')).toBe('Approved: Add a calendar event.');
    expect(heldResultRecord('refused', 'Add a calendar event')).toBe('You said no: Add a calendar event.');
    expect(heldResultRecord('failed', 'Add a calendar event'))
      .toBe('Approved, but it did not go through: Add a calendar event.');
    expect(heldResultRecord('expired', 'Add a calendar event')).toBe('No one answered in time: Add a calendar event.');
    expect(heldResultRecord('ran', undefined)).toBe('Approved: the action that waited for your approval.');
  });

  it('hands the model the call as if it had just returned, as a call in its own turn reads', () => {
    expect(heldResultCall(continuation())).toEqual({
      tool_name: 'calendar.create', tier: 1, args: { summary: 'Dentist' },
      started_at: 1_000, completed_at: 2_000, status: 'ok', result: { event_id: 'evt-1' },
    });
    // A tool's own result, and its failure.
    expect(heldResultCall(continuation({ result: { ok: true, result: { a: 1 } } })))
      .toMatchObject({ status: 'ok', result: { a: 1 } });
    expect(heldResultCall(continuation({ outcome: 'failed', result: { ok: false, reason: 'channel_denied', detail: 'no' } })))
      .toMatchObject({ status: 'error', reason: 'channel_denied', detail: 'no' });
    // A held run's response, and its failure.
    const ran = heldResultCall(continuation({ tool_name: 'recipe.run', tier: 2,
      result: { success: true, recipe_id: 'r', outputs: { summary: 'built' } } }));
    expect(ran).toMatchObject({ status: 'ok' });
    expect(JSON.stringify(ran.result)).toContain('built');
    expect(heldResultCall(continuation({ outcome: 'failed', result: { success: false, error: 'disk full' } })))
      .toMatchObject({ status: 'error', reason: 'execution_error' });
  });

  it('tells it the owner said no, or that no one answered, with nothing to read as a result', () => {
    const refused = heldResultCall(continuation({ outcome: 'refused' }));
    expect(refused).toMatchObject({ status: 'error', reason: 'plan_cancelled', detail: 'The owner said no to it, so it did not run.' });
    expect(refused).not.toHaveProperty('result');
    expect(heldResultCall(continuation({ outcome: 'expired' })))
      .toMatchObject({ status: 'error', reason: 'plan_cancelled', detail: HELD_WRITE_EXPIRED_MESSAGE });
  });

  it('§7.3 — Recued\'s own line for each outcome, for when the continuation\'s model does not answer', () => {
    const action = 'The action that waited for your approval, "Add a calendar event",';
    expect(heldResultFallback(continuation())).toBe(`${action} is done.`);
    expect(heldResultFallback(continuation({ outcome: 'refused' }))).toBe(`${action} was declined, so it was not done.`);
    expect(heldResultFallback(continuation({ outcome: 'expired' })))
      .toBe(`${action} expired before anyone answered it, so it was not done. Ask again if you still want it.`);
    // A failure in its own words: a run's, or a tool's.
    expect(heldResultFallback(continuation({ outcome: 'failed', result: { success: false, errors: [{ message: 'disk full' }] } })))
      .toBe(`${action} did not complete: disk full`);
    expect(heldResultFallback(continuation({ outcome: 'failed', result: { ok: false, reason: 'channel_denied', detail: 'The calendar refused it.' } })))
      .toBe(`${action} did not complete: The calendar refused it.`);
    // No title, no words: what it was, and where to look.
    const { title: _title, ...untitled } = continuation({ outcome: 'failed', result: {} });
    expect(heldResultFallback(untitled)).toBe('The action that waited for your approval did not complete. Open Recued to see why.');
  });

  it('cuts a result too large to keep, and says so, within its budget in bytes', () => {
    const huge = 'x'.repeat(HELD_RESULT_MAX_RESULT_BYTES + 10);
    const call = heldResultCall(continuation({ result: { ok: true, result: { text: huge } } }));
    expect(call.result).toMatchObject({ truncated: true, note: expect.stringContaining('bytes') });
    expect(JSON.stringify(call).length).toBeLessThan(HELD_RESULT_MAX_RESULT_BYTES);
    // Two bytes a character: a cut counted in characters would keep twice the budget.
    const accented = heldResultCall(continuation({ result: { ok: true, result: { text: 'é'.repeat(HELD_RESULT_MAX_RESULT_BYTES) } } }));
    const start = (accented.result as { start: string }).start;
    expect(Buffer.byteLength(start)).toBeLessThanOrEqual(HELD_RESULT_MAX_RESULT_BYTES / 2);
    expect(start.length).toBeGreaterThan(HELD_RESULT_MAX_RESULT_BYTES / 8);
  });
});

describe('D-337 §7.19 — a try waiting, kept across a stop', () => {
  it('however often the server\'s recovery looks, a turn waits once; its own end\'s wait included', async () => {
    let recovered!: () => void;
    let handler!: (command: unknown, turn: string, active: () => void, complete: () => void) => Promise<unknown>;
    const queue = {
      submit: vi.fn(), routing: () => ({ current: 'byok' }),
      register: (_family: string, run: typeof handler) => { handler = run; },
      whenRecovered: (listener: () => void) => { recovered = listener; return () => undefined; },
    };
    const dues: Array<{ turn_id: string; attempt: number; due_at: number }> = [{ turn_id: 't-1', attempt: 1, due_at: NOW + 30_000 }];
    const retryDue = vi.fn();
    const waits: Array<{ ms: number }> = [];
    createHeldResultContinuations({
      queue: queue as never, now: () => NOW,
      // No model answers.
      runTurn: async () => ({ turn_id: 't-2' }),
      turns: { record: vi.fn(), unanswered: () => undefined, retryDue, retriesDue: () => dues },
      later: (_run, ms) => { waits.push({ ms }); },
    });
    recovered();
    recovered();
    expect(waits).toEqual([{ ms: 30_000 }]);
    // A turn of this process ends unanswered: its wait is kept on its record, and waits once.
    await handler({ session_id: 's', message: 'Approved: Add a calendar event.',
      input: { held_results: [heldResultCall(continuation())] } }, 't-2', () => undefined, () => undefined);
    expect(retryDue).toHaveBeenCalledWith('t-2', 0, NOW + HELD_RESULT_RETRY_AFTER_MS[0]!);
    dues.push({ turn_id: 't-2', attempt: 0, due_at: NOW + HELD_RESULT_RETRY_AFTER_MS[0]! });
    recovered();
    expect(waits).toEqual([{ ms: 30_000 }, { ms: HELD_RESULT_RETRY_AFTER_MS[0] }]);
  });
});

describe('D-337 — queued in the conversation\'s own order', () => {
  const recordingQueue = (submit?: () => Promise<never>) => {
    const submitted: Array<{ command: Record<string, unknown>; submission: string }> = [];
    let handler: ((command: never, turn: string, active: () => void, complete: () => void) => Promise<unknown>) | undefined;
    const queue = {
      // As the real queue does: `beforeInsert` runs with the new turn's id, inside admission.
      submit: async (command: Record<string, unknown>, submission: string, _repeat?: boolean,
        beforeInsert?: (turn_id: string) => undefined) => {
        if (submit) return submit();
        const turn_id = `queued-${String(submitted.length + 1)}`;
        beforeInsert?.(turn_id);
        submitted.push({ command, submission });
        return { turn_id, status: 'queued', disposition: 'accepted' };
      },
      register: (family: string, run: typeof handler) => {
        expect(family).toBe(HELD_RESULT_QUEUE_FAMILY);
        handler = run;
      },
      routing: () => ({ current: 'byok' }),
    };
    return { queue, submitted, handler: () => handler! };
  };

  it('queues one continuation per settled call, with Recued\'s record and the call', async () => {
    const q = recordingQueue();
    const record = vi.fn();
    const continuations = createHeldResultContinuations({ queue: q.queue as never, runTurn: vi.fn(), turns: { record } });
    expect(await continuations.continueWith(continuation())).toBe(true);
    // The email door owes its answer, and skips its fixed follow-up, by this record.
    expect(record).toHaveBeenCalledWith({ turn_id: 'queued-1', session_id: 's1', run_id: 'run-1', origin_turn_id: 't1' });
    expect(q.submitted).toEqual([{
      command: {
        family: 'held_result',
        session_id: 's1',
        message: 'Approved: Add a calendar event.',
        input: {
          held_results: [heldResultCall(continuation())],
          // What the owner is told if the continuation's model does not answer.
          held_fallbacks: ['The action that waited for your approval, "Add a calendar event", is done.'],
          continuation_of_turn_id: 't1',
        },
        comparison: { run_id: 'run-1' },
      },
      submission: 'held-result:run-1',
    }]);
  });

  it('carries a Telegram or an email chat\'s own source, and continues no conversation under a contract', async () => {
    const q = recordingQueue();
    const continuations = createHeldResultContinuations({ queue: q.queue as never, runTurn: vi.fn() });
    const telegram: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' };
    expect(await continuations.continueWith(continuation({ source: telegram }))).toBe(true);
    expect(q.submitted[0]!.command.input).toMatchObject({ held_source: telegram });
    const app: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'owner' };
    expect(await continuations.continueWith(continuation({ run_id: 'run-2', source: app }))).toBe(true);
    expect(q.submitted[1]!.command.input).not.toHaveProperty('held_source');
    const household: ExecutionSource = { channel: 'messenger', actor: 'contracted_user', vendor: 'telegram', from: '7', contract_id: 'k-house' };
    const contracted: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'owner', contract_id: 'k-self' };
    expect(await continuations.continueWith(continuation({ run_id: 'run-3', source: household }))).toBe(false);
    expect(await continuations.continueWith(continuation({ run_id: 'run-4', source: contracted }))).toBe(false);
    // An email chat carries on too (the owner: "all channels should behave the same").
    const email: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'email', from: 'owner@example.com' };
    expect(await continuations.continueWith(continuation({ run_id: 'run-5', source: email }))).toBe(true);
    expect(q.submitted[2]!.command.input).toMatchObject({ held_source: email });
    expect(q.submitted).toHaveLength(3);
  });

  it('carries a scheduled conversation on as the chat it is; a scheduled recipe is no conversation', async () => {
    // The owner: "just a normal chat where the user prompt injected on schedule".
    const q = recordingQueue();
    const continuations = createHeldResultContinuations({ queue: q.queue as never, runTurn: vi.fn() });
    const scheduled: ExecutionSource = {
      channel: 'schedule', actor: 'system', schedule_id: 'sch-1', cron: '0 9 * * *',
      prompt_schedule: { schedule_id: 'sch-1', occurrence_id: 'occ-1', revision: 1, due_at: 1_000, cron: '0 9 * * *' },
      chat_session_id: 's1', turn_id: 't1',
    };
    expect(await continuations.continueWith(continuation({ source: scheduled }))).toBe(true);
    // It runs as the owner's chat in that conversation, as a message typed there would.
    expect(q.submitted[0]!.command.input).not.toHaveProperty('held_source');
    const recipe: ExecutionSource = { channel: 'schedule', actor: 'system', cron: '0 9 * * *', source_recipe: 'nightly-digest' };
    expect(await continuations.continueWith(continuation({ run_id: 'run-2', source: recipe }))).toBe(false);
    expect(q.submitted).toHaveLength(1);
  });

  it('says so when the queue refuses it, so the fixed reply stays', async () => {
    const q = recordingQueue(async () => { throw new Error('Chat vault is locked.'); });
    const continuations = createHeldResultContinuations({ queue: q.queue as never, runTurn: vi.fn() });
    expect(await continuations.continueWith(continuation())).toBe(false);
  });

  it('runs it as a turn of that conversation, opening with the call', async () => {
    const q = recordingQueue();
    const runTurn = vi.fn(async () => ({ turn_id: 'turn-9' }));
    const continuations = createHeldResultContinuations({ queue: q.queue as never, runTurn });
    await continuations.continueWith(continuation());
    const active = vi.fn();
    const complete = vi.fn();
    await q.handler()(q.submitted[0]!.command as never, 'turn-9', active, complete);
    expect(runTurn).toHaveBeenCalledWith({
      session_id: 's1',
      message: 'Approved: Add a calendar event.',
      picker_state: { current: 'self' },
      model_routing_snapshot: { current: 'byok' },
      held_results: [heldResultCall(continuation())],
      held_fallback: 'The action that waited for your approval, "Add a calendar event", is done.',
      // Told at the turn's first tool call: interrupted after it, it is not run again.
      held_acted: expect.any(Function),
      continuation_of_turn_id: 't1',
      queue_turn_id: 'turn-9',
      assert_active: active,
      complete_turn: complete,
    });
    const telegram: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' };
    await continuations.continueWith(continuation({ run_id: 'run-2', source: telegram }));
    await q.handler()(q.submitted[1]!.command as never, 'turn-10', active, complete);
    expect(runTurn).toHaveBeenLastCalledWith(expect.objectContaining({ held_source: telegram }));
  });

  it('refuses a continuation that carries no result', async () => {
    const q = recordingQueue();
    createHeldResultContinuations({ queue: q.queue as never, runTurn: vi.fn() });
    await expect(q.handler()({ family: 'held_result', session_id: 's1', message: 'x', input: {} } as never, 't', vi.fn(), vi.fn()))
      .rejects.toThrow(/no result/);
  });
});

describe('D-337 — the continuation turn', () => {
  it('stores Recued\'s record as a system row, and the model opens holding the call', async () => {
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const chatStore = createChatStore(db);
      chatStore.createSession({ id: 's1', now: NOW - 1_000 });
      const aiInputs: Record<string, unknown>[] = [];
      const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_manifest, aiInput) => {
        aiInputs.push(aiInput);
        return { body: { response: 'It is on your calendar now.', events: [], tool_calls: [] } satisfies AIOutput };
      });
      const registry: InternalToolRegistry = {
        list: () => [], listByTier: () => [], getByName: () => null,
        dispatch: vi.fn(async () => ({ ok: true, result: {} }) as const),
        subscribeRefresh: () => () => undefined,
      };
      const forwardedSenderIndex = { recordUserTurn: vi.fn() };
      const orchestrator = createChatOrchestrator({
        chatStore, registry, selfSignature: signature, executeAiCall, now: () => NOW, forwardedSenderIndex,
      } as never);
      const held = heldResultCall(continuation());
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await orchestrator.runTurn({
          session_id: 's1',
          message: 'Approved: Add a calendar event.',
          picker_state: { current: 'self' },
          held_results: [held],
        });
        // Its row is Recued's, not a pending source of the owner's words to finalize.
        expect(errors.mock.calls.map((c) => String(c[0]))).not.toContainEqual(expect.stringContaining('source finalization'));
      } finally {
        errors.mockRestore();
      }
      // Recued's record is not something the owner typed.
      expect(forwardedSenderIndex.recordUserTurn).not.toHaveBeenCalled();

      const messages = await chatStore.listMessages('s1');
      expect(messages.filter((m) => m.role === 'user')).toEqual([]);
      expect(messages.find((m) => m.role === 'system')).toMatchObject({ content: 'Approved: Add a calendar event.' });
      expect(messages.find((m) => m.role === 'assistant')).toMatchObject({ content: 'It is on your calendar now.' });
      expect(executeAiCall).toHaveBeenCalledTimes(1);
      const packet = JSON.parse(aiInputs[0]!['llm.prompt'] as string) as {
        user_message: string;
        prior_tool_calls?: Array<Record<string, unknown>>;
      };
      expect(packet.user_message).toBe(`${HELD_RESULT_TURN_NOTE}\nApproved: Add a calendar event.`);
      expect(packet.prior_tool_calls).toContainEqual(expect.objectContaining({
        tool_name: 'calendar.create', status: 'ok', result: { event_id: 'evt-1' },
      }));
    } finally {
      db.close();
    }
  });

  it('runs as the Telegram chat it continues: what it does next is that chat\'s', async () => {
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const chatStore = createChatStore(db);
      chatStore.createSession({ id: 'messenger:telegram:42', now: NOW - 1_000 });
      let calls = 0;
      const packets: Array<{ prior_tool_calls?: Array<Record<string, unknown>> }> = [];
      const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_manifest, aiInput) => {
        packets.push(JSON.parse(aiInput['llm.prompt'] as string) as { prior_tool_calls?: Array<Record<string, unknown>> });
        calls += 1;
        return { body: calls === 1
          ? { response: '', events: [], tool_calls: [{ tool: 'calendar.search', args: { query: 'Dentist' } }] }
          : { response: 'Done.', events: [], tool_calls: [] } } as { body: AIOutput };
      });
      const search = {
        name: 'calendar.search', tier: 1 as const, description: 'Find events', arg_schema: { type: 'object' },
        topic_tags: ['calendar'], classification: 'read' as const, concurrency_safe: true,
      };
      const dispatched: ExecutionSource[] = [];
      const registry: InternalToolRegistry = {
        list: () => [search], listByTier: (tier) => (tier === 1 ? [search] : []),
        getByName: (name) => (name === 'calendar.search' ? search : null),
        dispatch: vi.fn(async (_name, _args, ctx) => {
          if (ctx.execution_source !== undefined) dispatched.push(ctx.execution_source);
          return { ok: true, result: { events: [] } } as const;
        }),
        subscribeRefresh: () => () => undefined,
      };
      const orchestrator = createChatOrchestrator({
        chatStore, registry, selfSignature: signature, executeAiCall, now: () => NOW,
      } as never);
      const telegram = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' } as const;
      await orchestrator.runTurn({
        session_id: 'messenger:telegram:42',
        message: 'Approved: Add a calendar event.',
        picker_state: { current: 'self' },
        held_results: [heldResultCall(continuation())],
        held_source: telegram,
      });
      expect(dispatched).toEqual([telegram]);
      // Still in front of it on the call after its search, before what it just did.
      const afterSearch = packets.find((p) => p.prior_tool_calls?.some((c) => c.tool_name === 'calendar.search'));
      const names = afterSearch?.prior_tool_calls?.map((c) => c.tool_name) ?? [];
      expect(names.indexOf('calendar.create')).toBeGreaterThanOrEqual(0);
      expect(names.indexOf('calendar.create')).toBeLessThan(names.indexOf('calendar.search'));
      const messages = await chatStore.listMessages('messenger:telegram:42');
      expect(messages.find((m) => m.role === 'assistant')).toMatchObject({ content: 'Done.' });
    } finally {
      db.close();
    }
  });
});

describe('D-337 — a held run settling in the owner\'s chat', () => {
  const source: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'session', turn_id: 'turn', user_id: 'owner' };
  const setup = async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 'session', now: 1_000 });
    await store.toolCalls!.start({
      id: 'call-1', session_id: 'session', turn_id: 'turn', role: 'tool',
      tool_name: 'acme/build-site', content: 'acme/build-site({"site":"docs"})',
      target_server: 'self', picker_at_send: { display_name: 'self', signature },
      model_used: { provider: 'recued', model_id: 'tool-call' }, execution_source: source, ts: 1_000,
    });
    store.toolCalls!.bind('call-1', 'run-1');
    store.toolCalls!.hold('call-1');
    const step = vi.fn(async (_c: HeldResultContinuation) => true);
    const sink = createChatRunSettledSink(store, signature, { emit: vi.fn() }, {
      continueWith: step,
      toolTitle: (name) => (name === 'build-site' ? 'Build the docs site' : undefined),
    });
    return { db, store, step, sink };
  };

  it('continues with what the run returned, under the name the model called it by and the recipe\'s title', async () => {
    const { db, step, sink } = await setup();
    try {
      const result: ChatDispatchResult = { ok: true, result: { stdout: 'built 12 pages' } };
      await sink({ execution_source: source, run_id: 'run-1', tool_name: 'build-site', result, state: 'succeeded', ts: 5_000 });
      expect(step).toHaveBeenCalledTimes(1);
      expect(step.mock.calls[0]![0]).toMatchObject({
        session_id: 'session', turn_id: 'turn', run_id: 'run-1', tool_name: 'acme/build-site', tier: 2,
        outcome: 'ran', result, title: 'Build the docs site', called_at: 1_000, settled_at: 5_000, source,
      });
    } finally {
      db.close();
    }
  });

  it('continues knowing the owner said no', async () => {
    const { db, step, sink } = await setup();
    try {
      await sink({ execution_source: source, run_id: 'run-1', tool_name: 'build-site',
        result: { denied: true, message: 'The owner denied it.' }, ts: 5_000 });
      expect(step.mock.calls[0]![0]).toMatchObject({ outcome: 'refused' });
      expect(step.mock.calls[0]![0]).not.toHaveProperty('result');
    } finally {
      db.close();
    }
  });

  it('continues knowing no one answered in time', async () => {
    const { db, step, sink } = await setup();
    try {
      await sink({ execution_source: source, run_id: 'run-1', tool_name: 'build-site',
        result: { success: false, expired: true, message: 'Its approval expired before anyone answered it, so nothing ran.' },
        ts: 5_000 });
      expect(step.mock.calls[0]![0]).toMatchObject({ outcome: 'expired' });
      expect(step.mock.calls[0]![0]).not.toHaveProperty('result');
    } finally {
      db.close();
    }
  });

  it('a scheduled conversation\'s held run settles in it, and carries it on', async () => {
    const scheduled: ExecutionSource = {
      channel: 'schedule', actor: 'system', schedule_id: 'sch-1', cron: '0 9 * * *',
      prompt_schedule: { schedule_id: 'sch-1', occurrence_id: 'occ-1', revision: 1, due_at: 1_000, cron: '0 9 * * *' },
      chat_session_id: 'session', turn_id: 'turn',
    };
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const store = createChatStore(db);
      store.createSession({ id: 'session', now: 1_000 });
      await store.toolCalls!.start({
        id: 'call-1', session_id: 'session', turn_id: 'turn', role: 'tool',
        tool_name: 'acme/build-site', content: 'acme/build-site({"site":"docs"})',
        target_server: 'self', picker_at_send: { display_name: 'self', signature },
        model_used: { provider: 'recued', model_id: 'tool-call' }, execution_source: scheduled, ts: 1_000,
      });
      store.toolCalls!.bind('call-1', 'run-1');
      store.toolCalls!.hold('call-1');
      const step = vi.fn(async (_c: HeldResultContinuation) => true);
      const sink = createChatRunSettledSink(store, signature, { emit: vi.fn() }, { continueWith: step });
      await sink({ execution_source: scheduled, run_id: 'run-1', tool_name: 'build-site',
        result: { success: true }, state: 'succeeded', ts: 5_000 });
      // The call settles in its conversation, as an app chat's does: it no longer waits.
      expect(store.toolCalls!.get('call-1')?.state).toBe('succeeded');
      expect(step).toHaveBeenCalledWith(expect.objectContaining({
        session_id: 'session', turn_id: 'turn', run_id: 'run-1', outcome: 'ran', source: scheduled,
      }));
    } finally {
      db.close();
    }
  });

  it('does not continue a conversation that is not the owner\'s', async () => {
    const { db, step, sink } = await setup();
    try {
      const door: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'a', tool_call_id: 't',
        mcp_token_id: 'tok', contract_id: 'k' };
      await sink({ execution_source: door, run_id: 'run-1', tool_name: 'build-site', result: { success: true }, ts: 5_000 });
      expect(step).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});

describe('D-337 — every channel carries on: a run held in a Telegram or email chat', () => {
  const telegram: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' };
  const email: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'email', from: 'owner@example.com' };
  const withChat = () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const chatStore = createChatStore(db);
    chatStore.createSession({ id: 'messenger:telegram:42', now: NOW - 1_000 });
    chatStore.createSession({ id: 'mail:recued-chat:c1', now: NOW - 1_000 });
    return { db, chatStore, watches: createHeldRunWatchStore(db, () => NOW) };
  };
  const watched = (run_id: string, session_id = 'messenger:telegram:42') => ({
    run_id, session_id, turn_id: 'turn-asked', tool_name: 'recipe.run', called_at: NOW - 60_000,
  });
  const settledRun = (over: Partial<PreflightRunSettled> = {}): PreflightRunSettled => ({
    execution_source: telegram, run_id: 'run-1', tool_name: 'remove-calendar-event',
    result: { success: true, output: { removed: true } }, state: 'succeeded', ts: NOW, ...over,
  });

  it('watches a run held in the owner\'s own messenger or email chat, and no other conversation\'s', () => {
    const { db, watches } = withChat();
    try {
      const watching = watchHeldRunsIn(watches);
      const app: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'owner' };
      const household: ExecutionSource = {
        channel: 'messenger', actor: 'contracted_user', vendor: 'telegram', from: '7', contract_id: 'k-house',
      };
      watching.watch({ ...watched('run-tg'), source: telegram });
      watching.watch({ ...watched('run-mail', 'mail:recued-chat:c1'), source: email });
      // The app's chat keeps a row for the call instead; a contracted chat never continues.
      watching.watch({ ...watched('run-app'), source: app });
      watching.watch({ ...watched('run-house'), source: household });
      expect(['run-tg', 'run-mail', 'run-app', 'run-house'].map((id) => watches.get(id)?.session_id ?? null))
        .toEqual(['messenger:telegram:42', 'mail:recued-chat:c1', null, null]);
    } finally {
      db.close();
    }
  });

  it('carries the conversation on from the run, as that conversation, under its recipe\'s title', async () => {
    const { db, watches } = withChat();
    try {
      watches.watch(watched('run-1'));
      const continueWith = vi.fn(async (_c: HeldResultContinuation) => true);
      const reply = vi.fn(async () => undefined);
      const settle = createWatchedRunSettlement({
        watches, continueWith, reply,
        toolTitle: (name) => (name === 'remove-calendar-event' ? 'Remove a calendar event' : undefined),
      });
      expect(await settle(settledRun())).toBe(true);
      expect(continueWith).toHaveBeenCalledWith({
        source: telegram, session_id: 'messenger:telegram:42', turn_id: 'turn-asked', run_id: 'run-1',
        tool_name: 'recipe.run', tier: 2, outcome: 'ran', result: { success: true, output: { removed: true } },
        title: 'Remove a calendar event', called_at: NOW - 60_000, settled_at: NOW,
      });
      expect(reply).not.toHaveBeenCalled();
      // Done: told again, the run is no longer this conversation's to carry on.
      expect(watches.get('run-1')).toBeUndefined();
      expect(await settle(settledRun())).toBe(false);
    } finally {
      db.close();
    }
  });

  it('tells a refusal, and waits on a run held again', async () => {
    const { db, watches } = withChat();
    try {
      watches.watch(watched('run-1'));
      const continueWith = vi.fn(async (_c: HeldResultContinuation) => true);
      const settle = createWatchedRunSettlement({ watches, continueWith });
      // Held again (a second approval): not settled, and still watched.
      expect(await settle(settledRun({ result: { ok: true, result: {}, run_held: { kind: 'approval' } } }))).toBe(false);
      expect(watches.get('run-1')).toBeDefined();
      expect(await settle(settledRun({ state: undefined, result: { denied: true, message: 'denied' } }))).toBe(true);
      expect(continueWith.mock.calls[0]![0]).toMatchObject({ outcome: 'refused' });
      expect(continueWith.mock.calls[0]![0]).not.toHaveProperty('result');
    } finally {
      db.close();
    }
  });

  it('when the conversation cannot carry on, a Telegram chat still hears Recued\'s line; an email chat\'s is the door\'s', async () => {
    const { db, chatStore, watches } = withChat();
    try {
      watches.watch(watched('run-1'));
      watches.watch(watched('run-2', 'mail:recued-chat:c1'));
      const emitted: unknown[] = [];
      const settle = createWatchedRunSettlement({
        watches,
        continueWith: async () => false,
        toolTitle: () => 'Remove a calendar event',
        reply: createHeldRunReply({ chatStore, signature, broadcast: { emit: (e) => { emitted.push(e); } }, now: () => NOW }),
      });
      expect(await settle(settledRun())).toBe(true);
      const said = (await chatStore.listMessages('messenger:telegram:42')).filter((m) => m.role === 'assistant');
      expect(said).toEqual([expect.objectContaining({
        content: 'The action that waited for your approval, "Remove a calendar event", is done.',
        // In the turn that made the call, so the chat's delivery sends it as that turn's answer.
        turn_id: 'turn-asked',
      })]);
      expect(emitted).toEqual([expect.objectContaining({ kind: 'chat.message_complete', session_id: 'messenger:telegram:42' })]);
      // An email chat: the door writes its own follow-up (`follow-ups.ts`); none is written here.
      expect(await settle(settledRun({ run_id: 'run-2', execution_source: email }))).toBe(true);
      expect((await chatStore.listMessages('mail:recued-chat:c1')).filter((m) => m.role === 'assistant')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('a run nobody watched settles as before', async () => {
    const { db, watches } = withChat();
    try {
      const continueWith = vi.fn(async () => true);
      const settle = createWatchedRunSettlement({ watches, continueWith });
      expect(await settle(settledRun({ run_id: 'run-unknown' }))).toBe(false);
      const app: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'owner' };
      watches.watch(watched('run-app'));
      expect(await settle(settledRun({ run_id: 'run-app', execution_source: app }))).toBe(false);
      expect(continueWith).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('the orchestrator watches a run held in a Telegram chat, and leaves the app\'s chat to its rows', async () => {
    const { db, chatStore } = withChat();
    try {
      chatStore.createSession({ id: 's-app', now: NOW - 1_000 });
      const run = {
        name: 'recipe.run', tier: 1 as const, description: 'Run a recipe', arg_schema: { type: 'object' },
        topic_tags: ['recipes'], classification: 'unknown' as const, concurrency_safe: false,
      };
      let calls = 0;
      const executeAiCall = vi.fn<ExecuteChatAiCall>(async () => {
        calls += 1;
        return { body: calls % 2 === 1
          ? { response: '', events: [], tool_calls: [{ tool: 'recipe.run', args: { recipe_id: 'remove-calendar-event' } }] }
          : { response: 'It is waiting for your approval.', events: [], tool_calls: [] } } as { body: AIOutput };
      });
      let held = 0;
      const registry: InternalToolRegistry = {
        list: () => [run], listByTier: (tier) => (tier === 1 ? [run] : []),
        getByName: (name) => (name === 'recipe.run' ? run : null),
        dispatch: vi.fn(async (): Promise<ChatDispatchResult> => ({
          ok: true, result: { awaiting_approval: true }, run_held: { kind: 'approval' }, run_id: `run-held-${String((held += 1))}`,
        })),
        subscribeRefresh: () => () => undefined,
      };
      const watch = vi.fn();
      const orchestrator = createChatOrchestrator({
        chatStore, registry, selfSignature: signature, executeAiCall, now: () => NOW, heldRunWatches: { watch },
      } as never);
      // A Telegram chat's turn (here a continuation, which runs as that chat) holds a run.
      await orchestrator.runTurn({
        session_id: 'messenger:telegram:42', message: 'Approved: Add a calendar event.', picker_state: { current: 'self' },
        held_results: [heldResultCall(continuation())], held_source: telegram,
      });
      expect(watch).toHaveBeenCalledTimes(1);
      expect(watch).toHaveBeenCalledWith(expect.objectContaining({
        run_id: 'run-held-1', session_id: 'messenger:telegram:42', tool_name: 'recipe.run', source: telegram,
      }));
      const turn = (await chatStore.listMessages('messenger:telegram:42')).find((m) => m.role === 'assistant')!.turn_id;
      expect(watch.mock.calls[0]![0]).toMatchObject({ turn_id: turn });
      // The owner's app chat keeps a row for the call, which its settlement finds: no watch.
      await orchestrator.runTurn({ session_id: 's-app', message: 'Remove it, please.', picker_state: { current: 'self' } });
      expect(registry.dispatch).toHaveBeenCalledTimes(2);
      expect(watch).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});

describe('D-337 — approvals answered together carry the conversation on once', () => {
  /** The real queue over SQLite, the real orchestrator and chat store, and a scripted model.
   *  The first continuation's wait for others holds until the test has queued them behind it
   *  (`release`), so what it folds in does not depend on the machine's speed. */
  const withQueue = (options: { failModel?: boolean } = {}) => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const chatStore = createChatStore(db);
    chatStore.createSession({ id: 's1', now: Date.now() - 1_000 });
    const packets: Array<{ user_message: string; prior_tool_calls?: Array<Record<string, unknown>> }> = [];
    let holdModel: Promise<void> | undefined;
    const executeAiCall: ExecuteChatAiCall = async (_manifest, aiInput) => {
      let packet: (typeof packets)[number] | undefined;
      try { packet = JSON.parse(aiInput['llm.prompt'] as string) as (typeof packets)[number]; } catch { packet = undefined; }
      if (typeof packet?.user_message !== 'string') return { body: { response: 'ok', events: [], tool_calls: [] } };
      packets.push(packet);
      if (options.failModel) throw new Error('No model is reachable.');
      if (packets.length === 1 && holdModel !== undefined) await holdModel;
      return { body: { response: `Answer ${String(packets.length)}.`, events: [], tool_calls: [] } };
    };
    const registry: InternalToolRegistry = {
      list: () => [], listByTier: () => [], getByName: () => null,
      dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => undefined,
    };
    const raw = createChatOrchestrator({ chatStore, registry, selfSignature: signature, executeAiCall } as never);
    const orchestrator = withQueuedChatTurns(raw, { db, store: chatStore, pollMs: 5 });
    const queue = orchestrator.turnQueue!;
    const turns = createHeldResultTurnStore(db);
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    let offset = 0;
    let sleeps = 0;
    const ended: Array<{ session_id: string; source?: ExecutionSource }> = [];
    const waits: number[] = [];
    const continuations = createHeldResultContinuations({
      queue, runTurn: (input) => raw.runTurn(input), turns,
      gather: { quiet_ms: 60_000, max_ms: 120_000 },
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) await opened;
      },
      now: () => Date.now() + offset,
      afterTurn: (turn) => { ended.push(turn); },
      later: (_run, ms) => { waits.push(ms); },
    });
    return {
      db, chatStore, queue, turns, packets, continuations, ended, waits,
      /** The first continuation is waiting for others to be answered with it. */
      waiting: () => vi.waitFor(() => expect(sleeps).toBe(1), { timeout: 8_000, interval: 5 }),
      /** The wait is over: as long has passed as it waits for. */
      release: () => { offset = 60_000; open(); },
      holdModel: (until: Promise<void>) => { holdModel = until; },
      settled: () => vi.waitFor(async () => {
        const live = (await queue.snapshot('s1')).turns.filter((t) => ['queued', 'running', 'cancelling'].includes(t.status));
        expect(live).toEqual([]);
      }, { timeout: 8_000, interval: 10 }),
      close: () => { queue.close(); db.close(); },
    };
  };
  const removed = { tool_name: 'calendar.delete', title: 'Remove a calendar event', result: { ok: true, result: { removed: true } } };

  it('three approved together: one turn holding all three calls, one record, one answer', async () => {
    const q = withQueue();
    try {
      await q.continuations.continueWith(continuation({ run_id: 'run-a' }));
      await q.waiting();
      await q.continuations.continueWith(continuation({ run_id: 'run-b', ...removed }));
      await q.continuations.continueWith(continuation({ run_id: 'run-c', tool_name: 'mail.send', title: 'Email Bob', outcome: 'refused' }));
      q.release();
      await q.settled();
      expect(q.packets).toHaveLength(1);
      const record = 'Approved: Add a calendar event.\nApproved: Remove a calendar event.\nYou said no: Email Bob.';
      expect(q.packets[0]!.user_message).toBe(`${HELD_RESULTS_TURN_NOTE}\n${record}`);
      const held = (q.packets[0]!.prior_tool_calls ?? [])
        .filter((call) => ['calendar.create', 'calendar.delete', 'mail.send'].includes(call.tool_name as string));
      expect(held.map((call) => [call.tool_name, call.status])).toEqual([
        ['calendar.create', 'ok'], ['calendar.delete', 'ok'], ['mail.send', 'error'],
      ]);
      const messages = await q.chatStore.listMessages('s1');
      expect(messages.map((m) => [m.role, m.content])).toEqual([['system', record], ['assistant', 'Answer 1.']]);
      const turns = (await q.queue.snapshot('s1')).turns;
      expect(turns.map((t) => t.status)).toEqual(['completed', 'completed', 'completed']);
      // The two folded in are recorded as carried on in the first's turn, and all three as told.
      expect(q.db.prepare('SELECT run_id, into_turn_id FROM chat_held_result_turns ORDER BY rowid').all()).toEqual([
        { run_id: 'run-a', into_turn_id: null },
        { run_id: 'run-b', into_turn_id: turns[0]!.turn_id },
        { run_id: 'run-c', into_turn_id: turns[0]!.turn_id },
      ]);
      expect([...q.turns.delivered('s1')].sort()).toEqual(['run-a', 'run-b', 'run-c']);
      // Told once that its turn ended: the email door's cue.
      expect(q.ended).toEqual([{ session_id: 's1' }]);
    } finally {
      q.close();
    }
  });

  it('a message the owner sent between them keeps its place: the continuations either side carry on apart', async () => {
    const q = withQueue();
    try {
      await q.continuations.continueWith(continuation({ run_id: 'run-a' }));
      await q.waiting();
      const message = 'Also, what is on today?';
      await q.queue.submit({ family: 'chat', session_id: 's1', message,
        input: { session_id: 's1', message, picker_state: { current: 'self' } } }, 'owner-1');
      await q.continuations.continueWith(continuation({ run_id: 'run-b', ...removed }));
      q.release();
      await q.settled();
      expect(q.packets.map((p) => p.user_message)).toEqual([
        `${HELD_RESULT_TURN_NOTE}\nApproved: Add a calendar event.`,
        message,
        `${HELD_RESULT_TURN_NOTE}\nApproved: Remove a calendar event.`,
      ]);
    } finally {
      q.close();
    }
  });

  it('one answered once the first has begun runs after it, on its own', async () => {
    const q = withQueue();
    try {
      let resume!: () => void;
      q.holdModel(new Promise<void>((resolve) => { resume = resolve; }));
      await q.continuations.continueWith(continuation({ run_id: 'run-a' }));
      q.release();
      await vi.waitFor(() => expect(q.packets).toHaveLength(1), { timeout: 8_000, interval: 10 });
      await q.continuations.continueWith(continuation({ run_id: 'run-b', ...removed }));
      resume();
      await q.settled();
      expect(q.packets.map((p) => p.user_message)).toEqual([
        `${HELD_RESULT_TURN_NOTE}\nApproved: Add a calendar event.`,
        `${HELD_RESULT_TURN_NOTE}\nApproved: Remove a calendar event.`,
      ]);
    } finally {
      q.close();
    }
  });

  it('a continuation whose model failed told it nothing: the queue calls the turn done, and its calls are not', async () => {
    const q = withQueue({ failModel: true });
    try {
      await q.continuations.continueWith(continuation({ run_id: 'run-a' }));
      await q.continuations.continueWith(continuation({ run_id: 'run-b', ...removed }));
      q.release();
      await q.settled();
      // The turn stored the provider's failure as its answer, and the queue counts it completed.
      expect((await q.queue.snapshot('s1')).turns.map((t) => t.status)).toEqual(['completed', 'completed']);
      // D-337 §7.3 — and the owner still hears what became of each call, in Recued's words: in a
      // Telegram or an email chat, where Recued's record never goes, the failure was all they heard.
      expect((await q.chatStore.listMessages('s1')).find((m) => m.role === 'assistant')?.content)
        .toBe('The AI provider failed before answering.\n\nThe action that waited for your approval, "Add a calendar event", is done.\n'
          + 'The action that waited for your approval, "Remove a calendar event", is done.');
      expect(q.turns.delivered('s1').size).toBe(0);
      // Its end is told all the same: an answer it wrote would be owed by email.
      expect(q.ended).toHaveLength(1);
      // D-337 §7.17 — and it is tried again on its own, after the first wait.
      expect(q.waits).toEqual([HELD_RESULT_RETRY_AFTER_MS[0]]);
    } finally {
      q.close();
    }
  });

  it('while a continuation runs, its calls are in front of the model: told, for that turn too', async () => {
    const q = withQueue();
    try {
      let resume!: () => void;
      q.holdModel(new Promise<void>((resolve) => { resume = resolve; }));
      await q.continuations.continueWith(continuation({ run_id: 'run-a' }));
      await q.continuations.continueWith(continuation({ run_id: 'run-b', ...removed }));
      q.release();
      await vi.waitFor(() => expect(q.packets).toHaveLength(1), { timeout: 8_000, interval: 10 });
      expect([...q.turns.delivered('s1')].sort()).toEqual(['run-a', 'run-b']);
      resume();
      await q.settled();
      expect([...q.turns.delivered('s1')].sort()).toEqual(['run-a', 'run-b']);
    } finally {
      q.close();
    }
  });
});

describe('D-337 — a chained continuation answers the request that began it', () => {
  it('a call made in a continuation records the request the continuation answered', () => {
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      createChatStore(db).createSession({ id: 's', now: 1_000 });
      const turns = createHeldResultTurnStore(db);
      // The email turn that asked; its continuation, which asked again; and that one's.
      turns.record({ turn_id: 'cont-1', session_id: 's', run_id: 'run-1', origin_turn_id: 'email-turn' });
      turns.record({ turn_id: 'cont-2', session_id: 's', run_id: 'run-2', origin_turn_id: 'cont-1' });
      turns.record({ turn_id: 'cont-3', session_id: 's', run_id: 'run-3', origin_turn_id: 'cont-2' });
      expect(db.prepare('SELECT turn_id, origin_turn_id FROM chat_held_result_turns ORDER BY rowid').all()).toEqual([
        { turn_id: 'cont-1', origin_turn_id: 'email-turn' },
        { turn_id: 'cont-2', origin_turn_id: 'email-turn' },
        { turn_id: 'cont-3', origin_turn_id: 'email-turn' },
      ]);
    } finally {
      db.close();
    }
  });
});

describe('D-337 §7.9, §7.10 — a continuation that never answered', () => {
  /** The records over the real queue's table, each continuation's turn in the status given. */
  const withRecords = () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    createChatStore(db).createSession({ id: 's', now: 1_000 });
    createChatTurnQueueStore(db);
    let at = 10_000;
    const turns = createHeldResultTurnStore(db, () => at);
    const queued = (turn_id: string, status: string): void => {
      db.prepare(`INSERT INTO chat_turn_queue (turn_id, session_id, family, status, fingerprint, payload, created_at)
        VALUES (?, 's', 'held_result', ?, 'f', 'p', 1)`).run(turn_id, status);
    };
    const continued = (turn_id: string, run_id: string, status: string): void => {
      queued(turn_id, status);
      turns.record({ turn_id, session_id: 's', run_id, origin_turn_id: 'asked' });
      at += 1;
    };
    return { db, turns, queued, continued, at: () => at };
  };

  it('untold: a continuation that completed with no answer, failed or was interrupted; newest first', () => {
    const r = withRecords();
    try {
      r.continued('t-answered', 'run-answered', 'completed');
      r.turns.answered('t-answered');
      r.continued('t-no-model', 'run-no-model', 'completed');
      r.continued('t-threw', 'run-threw', 'failed');
      r.continued('t-stopped', 'run-stopped', 'interrupted');
      // Still to run, or running: their own turn tells them. Cancelled by the owner: not carried.
      r.continued('t-queued', 'run-queued', 'queued');
      r.continued('t-running', 'run-running', 'running');
      r.continued('t-cancelled', 'run-cancelled', 'cancelled');
      expect(r.turns.untold('s', 0, 10).map((row) => row.run_id)).toEqual(['run-stopped', 'run-threw', 'run-no-model']);
      // Within the window, and at most the limit.
      expect(r.turns.untold('s', r.at(), 10)).toEqual([]);
      expect(r.turns.untold('s', 0, 2).map((row) => row.run_id)).toEqual(['run-stopped', 'run-threw']);
      // Told in another turn: no longer untold, and delivered.
      r.turns.told(['t-no-model']);
      expect(r.turns.untold('s', 0, 10).map((row) => row.run_id)).toEqual(['run-stopped', 'run-threw']);
      expect(r.turns.delivered('s').has('run-no-model')).toBe(true);
    } finally {
      r.db.close();
    }
  });

  it('§7.17 unanswered: the untold calls of a turn the queue ended, folded ones too, and whether it acted', () => {
    const r = withRecords();
    try {
      r.continued('t-a', 'run-a', 'completed');
      r.continued('t-b', 'run-b', 'completed');
      r.turns.fold(['t-b'], 't-a');
      expect(r.turns.unanswered('t-a')).toEqual({
        session_id: 's', acted: false, turns: ['t-a', 't-b'], run_id: 'run-a', origin_turn_id: 'asked',
      });
      expect(r.turns.untoldIn('t-a')).toBe(true);
      // One told in another turn is not tried again.
      r.turns.told(['t-a']);
      expect(r.turns.unanswered('t-a')?.turns).toEqual(['t-b']);
      // It acted: a step it took could be taken twice.
      r.turns.acted('t-a');
      expect(r.turns.unanswered('t-a')?.acted).toBe(true);
      // Every call told: nothing left.
      r.turns.told(['t-b']);
      expect(r.turns.unanswered('t-a')).toBeUndefined();
      expect(r.turns.untoldIn('t-a')).toBe(false);
      // Still to run or running: its own turn tells them. Cancelled by the owner, or interrupted
      // (§7.9 runs that one again): not tried again.
      for (const status of ['queued', 'running', 'cancelled', 'interrupted']) {
        r.continued(`t-${status}`, `run-${status}`, status);
        expect(r.turns.unanswered(`t-${status}`)).toBeUndefined();
      }
      r.continued('t-failed', 'run-failed', 'failed');
      expect(r.turns.unanswered('t-failed')?.turns).toEqual(['t-failed']);
    } finally {
      r.db.close();
    }
  });

  it('§7.17 a try again carries its calls by their records; folded into another turn, they go with it', () => {
    const r = withRecords();
    try {
      r.continued('t-first', 'run-x', 'completed');
      // Tried again: the try's own record, and the call now its.
      r.queued('t-try', 'completed');
      r.turns.record({ turn_id: 't-try', session_id: 's', run_id: 'run-x', origin_turn_id: 'asked', retry_of: 't-first' });
      r.turns.refold('t-first', 't-try');
      expect(r.turns.unanswered('t-first')).toBeUndefined();
      expect(r.turns.unanswered('t-try')).toMatchObject({ turns: ['t-first'], run_id: 'run-x' });
      expect(r.turns.untoldIn('t-try')).toBe(true);
      // Queued behind a fresh continuation, the try is folded into it, and so is the call it carries.
      r.continued('t-fresh', 'run-y', 'completed');
      r.turns.fold(['t-try'], 't-fresh');
      expect(r.turns.unanswered('t-fresh')?.turns).toEqual(['t-first', 't-fresh']);
      // Answered, that turn told both: the next carries neither.
      r.turns.answered('t-fresh');
      expect([...r.turns.delivered('s')].sort()).toEqual(['run-x', 'run-y']);
      expect(r.turns.untold('s', 0, 10)).toEqual([]);
    } finally {
      r.db.close();
    }
  });

  it('§7.19 retriesDue: a try waiting on a turn the queue ended, with a call untold and no step taken', () => {
    const r = withRecords();
    try {
      r.continued('t-wait', 'run-wait', 'completed');
      r.turns.retryDue('t-wait', 0, 50_000);
      expect(r.turns.retriesDue(0)).toEqual([{ turn_id: 't-wait', attempt: 0, due_at: 50_000 }]);
      // Due before the window: not picked up.
      expect(r.turns.retriesDue(60_000)).toEqual([]);
      // Its calls told meanwhile: nothing to try.
      r.continued('t-told', 'run-told', 'completed');
      r.turns.retryDue('t-told', 0, 50_000);
      r.turns.told(['t-told']);
      // It took a step: never tried again.
      r.continued('t-acted', 'run-acted', 'failed');
      r.turns.retryDue('t-acted', 1, 50_000);
      r.turns.acted('t-acted');
      // Not ended by the queue as completed or failed: still to run, running, cancelled, or
      // interrupted (§7.9 runs that one again).
      for (const status of ['queued', 'running', 'cancelled', 'interrupted']) {
        r.continued(`t-${status}`, `run-${status}`, status);
        r.turns.retryDue(`t-${status}`, 0, 50_000);
      }
      // Tried since: its calls are the try's, and the try's own wait is the one.
      r.continued('t-tried', 'run-tried', 'completed');
      r.turns.retryDue('t-tried', 0, 40_000);
      r.queued('t-try', 'failed');
      r.turns.record({ turn_id: 't-try', session_id: 's', run_id: 'run-tried', origin_turn_id: 'asked', retry_of: 't-tried' });
      r.turns.refold('t-tried', 't-try');
      r.turns.retryDue('t-try', 1, 70_000);
      expect(r.turns.retriesDue(0)).toEqual([
        { turn_id: 't-wait', attempt: 0, due_at: 50_000 },
        { turn_id: 't-try', attempt: 1, due_at: 70_000 },
      ]);
    } finally {
      r.db.close();
    }
  });

  it('interrupted: by the turn it ran in, with whether it had begun acting, and its run again folded in', () => {
    const r = withRecords();
    try {
      r.continued('t-clean', 'run-clean', 'interrupted');
      r.continued('t-acted', 'run-acted', 'interrupted');
      r.turns.acted('t-acted');
      // A fold: two calls in one interrupted turn.
      r.continued('t-fold', 'run-fold-1', 'interrupted');
      r.continued('t-folded', 'run-fold-2', 'completed');
      r.turns.fold(['t-folded'], 't-fold');
      const groups = r.turns.interrupted(0);
      expect(groups.map((g) => [g.turn_id, g.acted, g.retried, g.turns])).toEqual([
        ['t-clean', false, false, ['t-clean']],
        ['t-acted', true, false, ['t-acted']],
        ['t-fold', false, false, ['t-fold', 't-folded']],
      ]);
      expect(groups[0]!.origin_turn_id).toBe('asked');
      // Run again: the retry's own record, the interrupted calls now its own.
      r.queued('t-retry', 'queued');
      r.turns.record({ turn_id: 't-retry', session_id: 's', run_id: 'run-fold-1', origin_turn_id: 'asked', retry_of: 't-fold' });
      r.turns.refold('t-fold', 't-retry');
      expect(r.turns.interrupted(0).map((g) => g.turn_id)).toEqual(['t-clean', 't-acted']);
      // Interrupted again, the run again is not run a third time.
      r.db.prepare("UPDATE chat_turn_queue SET status = 'interrupted' WHERE turn_id = 't-retry'").run();
      const again = r.turns.interrupted(0).find((g) => g.turn_id === 't-retry')!;
      expect(again).toMatchObject({ retried: true, turns: ['t-fold', 't-folded'] });
      // Its calls are carried by their own records, never twice by the retry's.
      expect(r.turns.untold('s', 0, 10).map((row) => row.turn_id).sort())
        .toEqual(['t-acted', 't-clean', 't-fold', 't-folded']);
      // Answered, the retry tells every call it carried.
      r.turns.answered('t-retry');
      expect([...r.turns.delivered('s')].sort()).toEqual(['run-fold-1', 'run-fold-2']);
    } finally {
      r.db.close();
    }
  });
});

describe('D-337 §7.9, §7.10, §7.17 — through the real queue and orchestrator', () => {
  const search = {
    name: 'calendar.search', tier: 1 as const, description: 'Find events', arg_schema: { type: 'object' },
    topic_tags: ['calendar'], classification: 'read' as const, concurrency_safe: true,
  };
  const registry: InternalToolRegistry = {
    list: () => [search], listByTier: (tier) => (tier === 1 ? [search] : []),
    getByName: (name) => (name === 'calendar.search' ? search : null),
    dispatch: async () => ({ ok: true, result: { events: [] } }),
    subscribeRefresh: () => () => undefined,
  };
  type Packet = { user_message: string; prior_tool_calls?: Array<Record<string, unknown>> };
  const packetOf = (aiInput: Record<string, unknown>): Packet | undefined => {
    try {
      const packet = JSON.parse(aiInput['llm.prompt'] as string) as Packet;
      return typeof packet.user_message === 'string' ? packet : undefined;
    } catch { return undefined; }
  };
  const said = (response: string, tool_calls: AIOutput['tool_calls'] = []) =>
    ({ body: { response, events: [], tool_calls } satisfies AIOutput });
  /** One server's queue, orchestrator and continuations, over the database they share. */
  const boot = (db: Database.Database, chatStore: ReturnType<typeof createChatStore>, model: ExecuteChatAiCall,
    recoverAlive?: (pid: number, started: number) => boolean,
    /** Where a try again waits (§7.17). None by default: a test that runs them takes them. */
    later: (run: () => Promise<void>, ms: number) => void = () => undefined,
    /** The continuations' clock (§7.19: a wait kept across a stop). */
    now?: () => number) => {
    let carry: ReturnType<typeof createCarriedHeldResults> | undefined;
    const raw = createChatOrchestrator({
      chatStore, registry, selfSignature: signature, executeAiCall: model,
      carriedHeldResults: (session_id: string) => carry?.(session_id) ?? Promise.resolve(undefined),
    } as never);
    const orchestrator = withQueuedChatTurns(raw, { db, store: chatStore, pollMs: 5, ...(recoverAlive ? { recoverAlive } : {}) });
    const queue = orchestrator.turnQueue!;
    const turns = createHeldResultTurnStore(db);
    const notes: Array<{ session_id: string; turn_id: string; content: string }> = [];
    const continuations = createHeldResultContinuations({
      queue, runTurn: (input) => raw.runTurn(input), turns, gather: { quiet_ms: 0, max_ms: 0 },
      note: async (note) => { notes.push({ session_id: note.session_id, turn_id: note.turn_id, content: note.content }); },
      later,
      ...(now !== undefined ? { now } : {}),
    });
    carry = createCarriedHeldResults({ turns, queue });
    return { queue, turns, continuations, notes };
  };
  const world = (session: string) => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const chatStore = createChatStore(db);
    chatStore.createSession({ id: session, now: Date.now() - 1_000 });
    return { db, chatStore };
  };
  const settled = (queue: ChatTurnQueue, session: string) => vi.waitFor(async () => {
    const live = (await queue.snapshot(session)).turns.filter((t) => ['queued', 'running', 'cancelling'].includes(t.status));
    expect(live).toEqual([]);
  }, { timeout: 8_000, interval: 10 });
  const DONE = 'The action that waited for your approval, "Add a calendar event", is done.';

  it('§7.9 — interrupted before it acted, it runs once more when the server is back', async () => {
    const { db, chatStore } = world('s1');
    const queues: ChatTurnQueue[] = [];
    try {
      let asked!: () => void;
      const askedOnce = new Promise<void>((resolve) => { asked = resolve; });
      // The first server's model is asked, and never answers: the server stops in the turn.
      const first = boot(db, chatStore, async (_manifest, aiInput) => {
        if (packetOf(aiInput) === undefined) return said('ok');
        asked();
        return new Promise<never>(() => undefined);
      });
      queues.push(first.queue);
      await first.continuations.continueWith(continuation({ run_id: 'run-a' }));
      await askedOnce;
      first.queue.close();
      const packets: Packet[] = [];
      // Back up: the turn the stopped server left running is interrupted, and runs again.
      const second = boot(db, chatStore, async (_manifest, aiInput) => {
        const packet = packetOf(aiInput);
        if (packet !== undefined) packets.push(packet);
        return said(packet === undefined ? 'ok' : 'It is on your calendar.');
      }, () => false);
      queues.push(second.queue);
      await vi.waitFor(async () => expect((await chatStore.listMessages('s1')).some((m) => m.role === 'assistant')).toBe(true),
        { timeout: 8_000, interval: 10 });
      await settled(second.queue, 's1');
      expect((await chatStore.listMessages('s1')).map((m) => [m.role, m.content])).toEqual([
        ['system', 'Approved: Add a calendar event.'],
        ['system', `${HELD_RESULT_RESUMED_LINE}\nApproved: Add a calendar event.`],
        ['assistant', 'It is on your calendar.'],
      ]);
      expect(packets[0]!.user_message).toBe(`${HELD_RESULT_TURN_NOTE}\n${HELD_RESULT_RESUMED_LINE}\nApproved: Add a calendar event.`);
      expect(packets[0]!.prior_tool_calls?.some((call) => call.tool_name === 'calendar.create')).toBe(true);
      expect((await second.queue.snapshot('s1')).turns.map((t) => t.status)).toEqual(['interrupted', 'completed']);
      // Told, and not run a third time.
      expect(second.turns.delivered('s1').has('run-a')).toBe(true);
      expect(second.turns.interrupted(0)).toEqual([]);
    } finally {
      for (const queue of queues) queue.close();
      db.close();
    }
  });

  it('§7.9 — interrupted once it had acted, it is not run again: a Telegram chat is told the outcome', async () => {
    const session = 'messenger:telegram:42';
    const telegram: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' };
    const { db, chatStore } = world(session);
    const queues: ChatTurnQueue[] = [];
    try {
      let searched!: () => void;
      const searchedOnce = new Promise<void>((resolve) => { searched = resolve; });
      // It takes a step (a search), and the server stops before the model answers after it.
      const first = boot(db, chatStore, async (_manifest, aiInput) => {
        const packet = packetOf(aiInput);
        if (packet === undefined) return said('ok');
        if (!(packet.prior_tool_calls ?? []).some((call) => call.tool_name === 'calendar.search')) {
          return said('', [{ tool: 'calendar.search', args: { query: 'Dentist' } }]);
        }
        searched();
        return new Promise<never>(() => undefined);
      });
      queues.push(first.queue);
      await first.continuations.continueWith(continuation({ run_id: 'run-b', session_id: session, source: telegram }));
      await searchedOnce;
      first.queue.close();
      const asked = vi.fn(async () => said('never'));
      const second = boot(db, chatStore, asked, () => false);
      queues.push(second.queue);
      await vi.waitFor(() => expect(second.notes).toHaveLength(1), { timeout: 8_000, interval: 10 });
      const interrupted = (await second.queue.snapshot(session)).turns;
      expect(interrupted.map((t) => t.status)).toEqual(['interrupted']);
      expect(second.notes[0]).toEqual({ session_id: session, turn_id: interrupted[0]!.turn_id, content: DONE });
      // No turn ran again, so no model was asked; its call waits for the conversation's next turn.
      expect(asked).not.toHaveBeenCalled();
      expect(second.turns.untold(session, 0, 5).map((row) => row.run_id)).toEqual(['run-b']);
    } finally {
      for (const queue of queues) queue.close();
      db.close();
    }
  });

  it('§7.9 — one the stopping server already settled as interrupted runs again on the next boot', async () => {
    // A graceful stop settles its running turn `interrupted` itself: the next boot's recovery finds
    // no stale turn, and the continuation must run again all the same.
    const { db, chatStore } = world('s1');
    const queues: ChatTurnQueue[] = [];
    try {
      let asked!: () => void;
      const askedOnce = new Promise<void>((resolve) => { asked = resolve; });
      const first = boot(db, chatStore, async (_manifest, aiInput) => {
        if (packetOf(aiInput) === undefined) return said('ok');
        asked();
        return new Promise<never>(() => undefined);
      });
      queues.push(first.queue);
      await first.continuations.continueWith(continuation({ run_id: 'run-g' }));
      await askedOnce;
      first.queue.close();
      db.prepare("UPDATE chat_turn_queue SET status = 'interrupted' WHERE status = 'running'").run();
      const second = boot(db, chatStore, async (_manifest, aiInput) => said(packetOf(aiInput) === undefined ? 'ok' : 'Done.'));
      queues.push(second.queue);
      await vi.waitFor(async () => expect((await chatStore.listMessages('s1')).some((m) => m.role === 'assistant')).toBe(true),
        { timeout: 8_000, interval: 10 });
      expect(second.turns.delivered('s1').has('run-g')).toBe(true);
    } finally {
      for (const queue of queues) queue.close();
      db.close();
    }
  });

  it('§7.9 — run again and interrupted again, it is not run a third time: a Telegram chat is told', async () => {
    const session = 'messenger:telegram:42';
    const telegram: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' };
    const { db, chatStore } = world(session);
    const queues: ChatTurnQueue[] = [];
    try {
      const hangs = () => {
        let asked!: () => void;
        const askedOnce = new Promise<void>((resolve) => { asked = resolve; });
        const model: ExecuteChatAiCall = async (_manifest, aiInput) => {
          if (packetOf(aiInput) === undefined) return said('ok');
          asked();
          return new Promise<never>(() => undefined);
        };
        return { model, askedOnce };
      };
      const one = hangs();
      const first = boot(db, chatStore, one.model);
      queues.push(first.queue);
      await first.continuations.continueWith(continuation({ run_id: 'run-h', session_id: session, source: telegram }));
      await one.askedOnce;
      first.queue.close();
      // Back once: it runs again, and the server stops in that run too.
      const two = hangs();
      const second = boot(db, chatStore, two.model, () => false);
      queues.push(second.queue);
      await two.askedOnce;
      second.queue.close();
      const asked = vi.fn(async () => said('never'));
      const third = boot(db, chatStore, asked, () => false);
      queues.push(third.queue);
      await vi.waitFor(() => expect(third.notes).toHaveLength(1), { timeout: 8_000, interval: 10 });
      expect(third.notes[0]!.content).toBe(DONE);
      expect(asked).not.toHaveBeenCalled();
      expect((await third.queue.snapshot(session)).turns.map((t) => t.status)).toEqual(['interrupted', 'interrupted']);
    } finally {
      for (const queue of queues) queue.close();
      db.close();
    }
  });

  it('§7.9 — once it had acted in the app chat, it is not run again, and no line is written: the record is there', async () => {
    const { db, chatStore } = world('s1');
    const queues: ChatTurnQueue[] = [];
    try {
      let searched!: () => void;
      const searchedOnce = new Promise<void>((resolve) => { searched = resolve; });
      const first = boot(db, chatStore, async (_manifest, aiInput) => {
        const packet = packetOf(aiInput);
        if (packet === undefined) return said('ok');
        if (!(packet.prior_tool_calls ?? []).some((call) => call.tool_name === 'calendar.search')) {
          return said('', [{ tool: 'calendar.search', args: { query: 'Dentist' } }]);
        }
        searched();
        return new Promise<never>(() => undefined);
      });
      queues.push(first.queue);
      await first.continuations.continueWith(continuation({ run_id: 'run-i' }));
      await searchedOnce;
      first.queue.close();
      const asked = vi.fn(async () => said('never'));
      const second = boot(db, chatStore, asked, () => false);
      queues.push(second.queue);
      await vi.waitFor(async () => expect((await second.queue.snapshot('s1')).turns.map((t) => t.status)).toEqual(['interrupted']),
        { timeout: 8_000, interval: 10 });
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      expect(second.notes).toEqual([]);
      expect(asked).not.toHaveBeenCalled();
      expect(second.turns.untold('s1', 0, 5).map((row) => row.run_id)).toEqual(['run-i']);
    } finally {
      for (const queue of queues) queue.close();
      db.close();
    }
  });

  it('§7.10 — a turn that carried them but whose model failed too leaves them to the next', async () => {
    const { db, chatStore } = world('s1');
    const live = boot(db, chatStore, async (_manifest, aiInput) => {
      if (packetOf(aiInput) === undefined) return said('ok');
      throw new Error('No model is reachable.');
    });
    try {
      await live.continuations.continueWith(continuation({ run_id: 'run-j' }));
      await settled(live.queue, 's1');
      const message = 'Hello?';
      await live.queue.submit({ family: 'chat', session_id: 's1', message,
        input: { session_id: 's1', message, picker_state: { current: 'self' } } }, 'owner-1');
      await settled(live.queue, 's1');
      expect(live.turns.untold('s1', 0, 5).map((row) => row.run_id)).toEqual(['run-j']);
    } finally {
      live.queue.close();
      db.close();
    }
  });

  it('§7.10 — no model answered it: the conversation\'s next turn carries the call, and it is told then', async () => {
    const { db, chatStore } = world('s1');
    let failing = true;
    const packets: Array<Packet & { raw: string }> = [];
    const live = boot(db, chatStore, async (_manifest, aiInput) => {
      const packet = packetOf(aiInput);
      if (packet === undefined) return said('ok');
      packets.push({ ...packet, raw: aiInput['llm.prompt'] as string });
      if (failing) throw new Error('No model is reachable.');
      return said('Noted, and the event is on your calendar.');
    });
    try {
      await live.continuations.continueWith(continuation({ run_id: 'run-c' }));
      await settled(live.queue, 's1');
      expect(live.turns.untold('s1', 0, 5).map((row) => row.run_id)).toEqual(['run-c']);
      // The model is back; the owner writes.
      failing = false;
      const message = 'Thanks. Anything else on today?';
      await live.queue.submit({ family: 'chat', session_id: 's1', message,
        input: { session_id: 's1', message, picker_state: { current: 'self' } } }, 'owner-1');
      await settled(live.queue, 's1');
      const turn = packets.find((p) => p.user_message === message)!;
      expect(turn.prior_tool_calls?.[0]).toMatchObject({ tool_name: 'calendar.create', status: 'ok', result: { event_id: 'evt-1' } });
      expect(turn.raw).toContain(CARRIED_HELD_RESULTS_NOTE);
      // Told once the model answered: the turn after this one carries nothing.
      expect(live.turns.untold('s1', 0, 5)).toEqual([]);
      expect(live.turns.delivered('s1').has('run-c')).toBe(true);
    } finally {
      live.queue.close();
      db.close();
    }
  });

  /** §7.17 — the tries again a continuation leaves waiting, run by hand. */
  const triesAgain = () => {
    const pending: Array<{ run: () => Promise<void>; ms: number }> = [];
    return {
      pending,
      later: (run: () => Promise<void>, ms: number) => { pending.push({ run, ms }); },
      /** The wait is over: the try is queued, or there was nothing left to try. */
      next: async () => { await pending.shift()!.run(); },
    };
  };
  /** The conversation's turns, once there are `count` and none is still to run. */
  const turnsIn = (queue: ChatTurnQueue, session: string, count: number) => vi.waitFor(async () => {
    const all = (await queue.snapshot(session)).turns;
    expect(all).toHaveLength(count);
    expect(all.filter((t) => ['queued', 'running', 'cancelling'].includes(t.status))).toEqual([]);
    return all;
  }, { timeout: 8_000, interval: 10 });
  const lines = async (chatStore: ReturnType<typeof createChatStore>, session: string) =>
    (await chatStore.listMessages(session)).map((m) => [m.role, m.content]);
  const RETRIED = `${HELD_RESULT_RETRIED_LINE}\nApproved: Add a calendar event.`;
  const removedCall = { tool_name: 'calendar.delete', title: 'Remove a calendar event', result: { ok: true, result: { removed: true } } };
  const owner = (queue: ChatTurnQueue, message: string) => queue.submit({ family: 'chat', session_id: 's1', message,
    input: { session_id: 's1', message, picker_state: { current: 'self' } } }, `owner-${message}`);

  it('§7.17 — no model answered it: tried again on its own after a wait, and told then', async () => {
    const { db, chatStore } = world('s1');
    const tries = triesAgain();
    let failing = true;
    const packets: Packet[] = [];
    const live = boot(db, chatStore, async (_manifest, aiInput) => {
      const packet = packetOf(aiInput);
      if (packet === undefined) return said('ok');
      packets.push(packet);
      if (failing) throw new Error('No model is reachable.');
      return said('It is on your calendar.');
    }, undefined, tries.later);
    try {
      await live.continuations.continueWith(continuation({ run_id: 'run-r' }));
      await turnsIn(live.queue, 's1', 1);
      // The first time, the owner had its record and what became of the call.
      const failed = await lines(chatStore, 's1');
      expect(failed.map(([role]) => role)).toEqual(['system', 'assistant']);
      expect(failed[1]![1]).toContain(DONE);
      expect(tries.pending.map((t) => t.ms)).toEqual([HELD_RESULT_RETRY_AFTER_MS[0]]);
      // A model is back within the wait. Nobody writes.
      failing = false;
      await tries.next();
      await turnsIn(live.queue, 's1', 2);
      expect(await lines(chatStore, 's1')).toEqual([...failed, ['system', RETRIED], ['assistant', 'It is on your calendar.']]);
      // The model read the call again, as the first time.
      expect(packets).toHaveLength(2);
      expect(packets[1]!.user_message).toBe(`${HELD_RESULT_TURN_NOTE}\n${RETRIED}`);
      expect(packets[1]!.prior_tool_calls?.some((call) => call.tool_name === 'calendar.create')).toBe(true);
      // Told: not tried again, and the conversation's next turn carries nothing.
      expect(tries.pending).toEqual([]);
      expect(live.turns.untold('s1', 0, 5)).toEqual([]);
      expect(live.turns.delivered('s1').has('run-r')).toBe(true);
    } finally {
      live.queue.close();
      db.close();
    }
  });

  it('§7.17 — a try whose model fails again writes and sends nothing; each waits longer, and past the last none', async () => {
    const { db, chatStore } = world('s1');
    const tries = triesAgain();
    let asked = 0;
    const live = boot(db, chatStore, async (_manifest, aiInput) => {
      if (packetOf(aiInput) === undefined) return said('ok');
      asked += 1;
      throw new Error('No model is reachable.');
    }, undefined, tries.later);
    try {
      await live.continuations.continueWith(continuation({ run_id: 'run-q' }));
      await turnsIn(live.queue, 's1', 1);
      const failed = await lines(chatStore, 's1');
      for (const [i, wait] of HELD_RESULT_RETRY_AFTER_MS.entries()) {
        expect(tries.pending.map((t) => t.ms)).toEqual([wait]);
        await tries.next();
        await turnsIn(live.queue, 's1', i + 2);
      }
      // A model was asked each time, and no try wrote a line: no record, no answer, nothing to send.
      expect(asked).toBe(1 + HELD_RESULT_RETRY_AFTER_MS.length);
      expect(await lines(chatStore, 's1')).toEqual(failed);
      expect(live.notes).toEqual([]);
      // Past the last wait, none: the conversation's next turn carries the call (§7.10).
      expect(tries.pending).toEqual([]);
      expect(live.turns.untold('s1', 0, 5).map((row) => row.run_id)).toEqual(['run-q']);
    } finally {
      live.queue.close();
      db.close();
    }
  });

  it('§7.17 — told meanwhile, by the conversation\'s next turn: not tried again', async () => {
    const { db, chatStore } = world('s1');
    const tries = triesAgain();
    let failing = true;
    let asked = 0;
    const live = boot(db, chatStore, async (_manifest, aiInput) => {
      if (packetOf(aiInput) === undefined) return said('ok');
      asked += 1;
      if (failing) throw new Error('No model is reachable.');
      return said('Yes, it is on your calendar.');
    }, undefined, tries.later);
    try {
      await live.continuations.continueWith(continuation({ run_id: 'run-t' }));
      const [first] = await turnsIn(live.queue, 's1', 1);
      failing = false;
      await owner(live.queue, 'Is it on my calendar?');
      await turnsIn(live.queue, 's1', 2);
      expect(live.turns.unanswered(first!.turn_id)).toBeUndefined();
      // The wait ends with nothing left to say: no turn, no model asked.
      expect(tries.pending).toHaveLength(1);
      await tries.next();
      expect((await live.queue.snapshot('s1')).turns).toHaveLength(2);
      expect(asked).toBe(2);
    } finally {
      live.queue.close();
      db.close();
    }
  });

  it('§7.17 — a try queued behind the turn that tells its calls has nothing left to say', async () => {
    const { db, chatStore } = world('s1');
    const tries = triesAgain();
    let failing = true;
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    let ownerAsked!: () => void;
    const ownerTurn = new Promise<void>((resolve) => { ownerAsked = resolve; });
    let asked = 0;
    const live = boot(db, chatStore, async (_manifest, aiInput) => {
      if (packetOf(aiInput) === undefined) return said('ok');
      asked += 1;
      if (failing) throw new Error('No model is reachable.');
      ownerAsked();
      await resumed;
      return said('Yes, it is on your calendar.');
    }, undefined, tries.later);
    try {
      await live.continuations.continueWith(continuation({ run_id: 'run-u' }));
      await turnsIn(live.queue, 's1', 1);
      failing = false;
      await owner(live.queue, 'Is it on my calendar?');
      // The owner's turn holds the call in front of the model; the wait ends meanwhile.
      await ownerTurn;
      await tries.next();
      expect((await live.queue.snapshot('s1')).turns.map((t) => t.status)).toEqual(['completed', 'running', 'queued']);
      resume();
      await turnsIn(live.queue, 's1', 3);
      // Only the owner's turn asked a model: the try wrote nothing, and waits for nothing.
      expect(asked).toBe(2);
      expect((await lines(chatStore, 's1')).some(([, content]) => String(content).startsWith(HELD_RESULT_RETRIED_LINE)))
        .toBe(false);
      expect(tries.pending).toEqual([]);
      expect(live.turns.untold('s1', 0, 5)).toEqual([]);
    } finally {
      live.queue.close();
      db.close();
    }
  });

  it('§7.17 — a try gathers no continuation behind it: one answered meanwhile has its own turn and record', async () => {
    const { db, chatStore } = world('s1');
    const tries = triesAgain();
    let up = false;
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    let ownerAsked!: () => void;
    const ownerTurn = new Promise<void>((resolve) => { ownerAsked = resolve; });
    const message = 'Is it on my calendar?';
    const packets: Packet[] = [];
    const live = boot(db, chatStore, async (_manifest, aiInput) => {
      const packet = packetOf(aiInput);
      if (packet === undefined) return said('ok');
      packets.push(packet);
      // The owner's turn carries the call, and its model fails too: the call stays untold.
      if (packet.user_message === message) {
        ownerAsked();
        await resumed;
        throw new Error('No model is reachable.');
      }
      if (!up) throw new Error('No model is reachable.');
      return said('Done.');
    }, undefined, tries.later);
    try {
      await live.continuations.continueWith(continuation({ run_id: 'run-m' }));
      await turnsIn(live.queue, 's1', 1);
      await owner(live.queue, message);
      await ownerTurn;
      // Behind the owner's turn: the try again, then an approval answered meanwhile.
      await tries.next();
      await live.continuations.continueWith(continuation({
        run_id: 'run-n', tool_name: 'calendar.delete', title: 'Remove a calendar event', result: { ok: true, result: { removed: true } },
      }));
      up = true;
      resume();
      await turnsIn(live.queue, 's1', 4);
      expect(packets.slice(2).map((packet) => packet.user_message)).toEqual([
        `${HELD_RESULT_TURN_NOTE}\n${RETRIED}`,
        `${HELD_RESULT_TURN_NOTE}\nApproved: Remove a calendar event.`,
      ]);
      expect((await lines(chatStore, 's1')).filter(([role]) => role === 'system').map(([, content]) => content))
        .toEqual(['Approved: Add a calendar event.', RETRIED, 'Approved: Remove a calendar event.']);
      expect([...live.turns.delivered('s1')].sort()).toEqual(['run-m', 'run-n']);
    } finally {
      live.queue.close();
      db.close();
    }
  });

  it('§7.17 — one that had begun acting is not tried again: a step it took may have run', async () => {
    const { db, chatStore } = world('s1');
    const tries = triesAgain();
    let asked = 0;
    const live = boot(db, chatStore, async (_manifest, aiInput) => {
      const packet = packetOf(aiInput);
      if (packet === undefined) return said('ok');
      asked += 1;
      // It takes a step (a search); its model fails after it.
      if (!(packet.prior_tool_calls ?? []).some((call) => call.tool_name === 'calendar.search')) {
        return said('', [{ tool: 'calendar.search', args: { query: 'Dentist' } }]);
      }
      throw new Error('No model is reachable.');
    }, undefined, tries.later);
    try {
      await live.continuations.continueWith(continuation({ run_id: 'run-s' }));
      const [first] = await turnsIn(live.queue, 's1', 1);
      expect(live.turns.unanswered(first!.turn_id)).toMatchObject({ acted: true });
      const before = asked;
      expect(tries.pending).toHaveLength(1);
      await tries.next();
      expect((await live.queue.snapshot('s1')).turns).toHaveLength(1);
      expect(asked).toBe(before);
      // Its call waits for the conversation's next turn instead (§7.10).
      expect(live.turns.untold('s1', 0, 5).map((row) => row.run_id)).toEqual(['run-s']);
    } finally {
      live.queue.close();
      db.close();
    }
  });

  it('§7.17 — a try that takes a step before its model fails is not quiet: its record goes in before the step', async () => {
    const { db, chatStore } = world('s1');
    const tries = triesAgain();
    let down = true;
    const live = boot(db, chatStore, async (_manifest, aiInput) => {
      const packet = packetOf(aiInput);
      if (packet === undefined) return said('ok');
      if (down) throw new Error('No model is reachable.');
      if (!(packet.prior_tool_calls ?? []).some((call) => call.tool_name === 'calendar.search')) {
        return said('', [{ tool: 'calendar.search', args: { query: 'Dentist' } }]);
      }
      throw new Error('No model is reachable.');
    }, undefined, tries.later);
    try {
      await live.continuations.continueWith(continuation({ run_id: 'run-v' }));
      await turnsIn(live.queue, 's1', 1);
      const failed = await lines(chatStore, 's1');
      down = false;
      await tries.next();
      await turnsIn(live.queue, 's1', 2);
      const added = (await lines(chatStore, 's1')).slice(failed.length);
      // Its record, the step it took, and what became of the turn: the owner sees what ran.
      expect(added[0]).toEqual(['system', RETRIED]);
      expect(added.slice(1, -1).length).toBeGreaterThan(0);
      expect(added.slice(1, -1).every(([role]) => role === 'tool')).toBe(true);
      expect(added.at(-1)![0]).toBe('assistant');
      // It acted: not tried again.
      expect(tries.pending).toHaveLength(1);
      await tries.next();
      expect((await live.queue.snapshot('s1')).turns).toHaveLength(2);
    } finally {
      live.queue.close();
      db.close();
    }
  });

  it('§7.17 — one the owner cancelled is not tried again', async () => {
    const { db, chatStore } = world('s1');
    const tries = triesAgain();
    let asked!: () => void;
    const askedOnce = new Promise<void>((resolve) => { asked = resolve; });
    let fail!: () => void;
    const failing = new Promise<void>((resolve) => { fail = resolve; });
    const live = boot(db, chatStore, async (_manifest, aiInput) => {
      if (packetOf(aiInput) === undefined) return said('ok');
      asked();
      await failing;
      throw new Error('No model is reachable.');
    }, undefined, tries.later);
    try {
      await live.continuations.continueWith(continuation({ run_id: 'run-w' }));
      await askedOnce;
      const [turn] = (await live.queue.snapshot('s1')).turns;
      await live.queue.cancel('s1', turn!.turn_id);
      fail();
      const [ended] = await turnsIn(live.queue, 's1', 1);
      expect(ended!.status).toBe('cancelled');
      expect(tries.pending).toHaveLength(1);
      await tries.next();
      expect((await live.queue.snapshot('s1')).turns).toHaveLength(1);
    } finally {
      live.queue.close();
      db.close();
    }
  });

  it('§7.17 — a Telegram chat\'s try runs as that chat; one that fails again sends it nothing', async () => {
    const session = 'messenger:telegram:42';
    const telegram: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' };
    const { db, chatStore } = world(session);
    const tries = triesAgain();
    const live = boot(db, chatStore, async (_manifest, aiInput) => {
      if (packetOf(aiInput) === undefined) return said('ok');
      throw new Error('No model is reachable.');
    }, undefined, tries.later);
    try {
      await live.continuations.continueWith(continuation({ run_id: 'run-tg', session_id: session, source: telegram }));
      await turnsIn(live.queue, session, 1);
      // The first time, Telegram heard what became of the call (its answer row is what is sent).
      const failed = await lines(chatStore, session);
      expect(failed.at(-1)).toEqual(['assistant', expect.stringContaining(DONE)]);
      await tries.next();
      const [, tried] = await turnsIn(live.queue, session, 2);
      expect((await live.queue.commandOf(tried!.turn_id))?.input).toMatchObject({ held_source: telegram, held_retry: true });
      // The try's failure is quiet: no row, so nothing is sent; no line of Recued's either.
      expect(await lines(chatStore, session)).toEqual(failed);
      expect(live.notes).toEqual([]);
    } finally {
      live.queue.close();
      db.close();
    }
  });

  it('§7.19 — a try waiting when the server stopped is picked up where it was: it waits what is left', async () => {
    const { db, chatStore } = world('s1');
    const queues: ChatTurnQueue[] = [];
    try {
      let clock = Date.now();
      const before = triesAgain();
      const down = boot(db, chatStore, async (_manifest, aiInput) => {
        if (packetOf(aiInput) === undefined) return said('ok');
        throw new Error('No model is reachable.');
      }, undefined, before.later, () => clock);
      queues.push(down.queue);
      await down.continuations.continueWith(continuation({ run_id: 'run-k' }));
      await turnsIn(down.queue, 's1', 1);
      const failed = await lines(chatStore, 's1');
      expect(before.pending.map((t) => t.ms)).toEqual([HELD_RESULT_RETRY_AFTER_MS[0]]);
      // The server stops 90 s into the wait: its timer goes with it.
      down.queue.close();
      clock += 90_000;
      const after = triesAgain();
      const up = boot(db, chatStore, async (_manifest, aiInput) =>
        said(packetOf(aiInput) === undefined ? 'ok' : 'It is on your calendar.'), undefined, after.later, () => clock);
      queues.push(up.queue);
      await vi.waitFor(() => expect(after.pending.map((t) => t.ms)).toEqual([HELD_RESULT_RETRY_AFTER_MS[0]! - 90_000]),
        { timeout: 8_000, interval: 10 });
      await after.next();
      await turnsIn(up.queue, 's1', 2);
      expect(await lines(chatStore, 's1')).toEqual([...failed, ['system', RETRIED], ['assistant', 'It is on your calendar.']]);
      expect(up.turns.untold('s1', 0, 5)).toEqual([]);
    } finally {
      for (const queue of queues) queue.close();
      db.close();
    }
  });

  it('§7.19 — overdue when the server is back, the try runs at once', async () => {
    const { db, chatStore } = world('s1');
    const queues: ChatTurnQueue[] = [];
    try {
      let clock = Date.now();
      const down = boot(db, chatStore, async (_manifest, aiInput) => {
        if (packetOf(aiInput) === undefined) return said('ok');
        throw new Error('No model is reachable.');
      }, undefined, triesAgain().later, () => clock);
      queues.push(down.queue);
      await down.continuations.continueWith(continuation({ run_id: 'run-o' }));
      await turnsIn(down.queue, 's1', 1);
      down.queue.close();
      // Down for ten minutes, past the two-minute wait.
      clock += 10 * 60_000;
      const after = triesAgain();
      const up = boot(db, chatStore, async (_manifest, aiInput) =>
        said(packetOf(aiInput) === undefined ? 'ok' : 'It is on your calendar.'), undefined, after.later, () => clock);
      queues.push(up.queue);
      await vi.waitFor(() => expect(after.pending.map((t) => t.ms)).toEqual([0]), { timeout: 8_000, interval: 10 });
      await after.next();
      await turnsIn(up.queue, 's1', 2);
      expect(up.turns.delivered('s1').has('run-o')).toBe(true);
    } finally {
      for (const queue of queues) queue.close();
      db.close();
    }
  });

  it('§7.19 — after the last try, or with its calls told before the stop, nothing waits when the server is back', async () => {
    const { db, chatStore } = world('s1');
    const queues: ChatTurnQueue[] = [];
    try {
      let failing = true;
      const before = triesAgain();
      const model: ExecuteChatAiCall = async (_manifest, aiInput) => {
        if (packetOf(aiInput) === undefined) return said('ok');
        if (failing) throw new Error('No model is reachable.');
        return said('Noted.');
      };
      const down = boot(db, chatStore, model, undefined, before.later);
      queues.push(down.queue);
      // One continuation through every try.
      await down.continuations.continueWith(continuation({ run_id: 'run-x' }));
      await turnsIn(down.queue, 's1', 1);
      for (const [i] of HELD_RESULT_RETRY_AFTER_MS.entries()) {
        await before.next();
        await turnsIn(down.queue, 's1', i + 2);
      }
      expect(before.pending).toEqual([]);
      // Another, whose calls the owner's next turn told while its try waited.
      await down.continuations.continueWith(continuation({ run_id: 'run-y', ...removedCall }));
      await turnsIn(down.queue, 's1', 5);
      failing = false;
      await owner(down.queue, 'Anything else?');
      await turnsIn(down.queue, 's1', 6);
      expect(before.pending).toHaveLength(1);
      down.queue.close();
      const after = triesAgain();
      const up = boot(db, chatStore, model, undefined, after.later);
      queues.push(up.queue);
      // Recovery has looked once the queue takes a new turn.
      await owner(up.queue, 'Thanks.');
      await turnsIn(up.queue, 's1', 7);
      expect(after.pending).toEqual([]);
    } finally {
      for (const queue of queues) queue.close();
      db.close();
    }
  });

  it('§7.19 — a try the server stopped in runs again once, as that try, and tells nobody', async () => {
    const session = 'messenger:telegram:42';
    const telegram: ExecutionSource = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' };
    const { db, chatStore } = world(session);
    const queues: ChatTurnQueue[] = [];
    try {
      let hang = false;
      let asked!: () => void;
      const tryAsked = new Promise<void>((resolve) => { asked = resolve; });
      const before = triesAgain();
      const first = boot(db, chatStore, async (_manifest, aiInput) => {
        if (packetOf(aiInput) === undefined) return said('ok');
        if (!hang) throw new Error('No model is reachable.');
        asked();
        return new Promise<never>(() => undefined);
      }, undefined, before.later);
      queues.push(first.queue);
      await first.continuations.continueWith(continuation({ run_id: 'run-s', session_id: session, source: telegram }));
      await turnsIn(first.queue, session, 1);
      const failed = await lines(chatStore, session);
      // The first try fails too; the second's model is asked, and the server stops in it.
      await before.next();
      await turnsIn(first.queue, session, 2);
      hang = true;
      await before.next();
      await tryAsked;
      first.queue.close();
      const second = boot(db, chatStore, async (_manifest, aiInput) =>
        said(packetOf(aiInput) === undefined ? 'ok' : 'It is on your calendar.'), () => false);
      queues.push(second.queue);
      const all = await turnsIn(second.queue, session, 4);
      expect(all.map((t) => t.status)).toEqual(['completed', 'completed', 'interrupted', 'completed']);
      // The second try again, by its number: its failure waits the third wait, not the first.
      expect((await second.queue.commandOf(all[3]!.turn_id))?.input)
        .toMatchObject({ held_retry: true, held_retry_attempt: 2, held_retry_resumed: true, held_source: telegram });
      // As that try: quiet until answered, and no line of Recued's again.
      expect(await lines(chatStore, session)).toEqual([...failed, ['system', RETRIED], ['assistant', 'It is on your calendar.']]);
      expect(second.notes).toEqual([]);
      expect(second.turns.untold(session, 0, 5)).toEqual([]);
    } finally {
      for (const queue of queues) queue.close();
      db.close();
    }
  });

  it('§7.19 — stopped in again, it is left to the conversation\'s next turn, and tells nobody', async () => {
    const { db, chatStore } = world('s1');
    const queues: ChatTurnQueue[] = [];
    try {
      let hang = false;
      const hangs = () => {
        let asked!: () => void;
        const askedOnce = new Promise<void>((resolve) => { asked = resolve; });
        const model: ExecuteChatAiCall = async (_manifest, aiInput) => {
          if (packetOf(aiInput) === undefined) return said('ok');
          if (!hang) throw new Error('No model is reachable.');
          asked();
          return new Promise<never>(() => undefined);
        };
        return { model, askedOnce };
      };
      const before = triesAgain();
      const one = hangs();
      const first = boot(db, chatStore, one.model, undefined, before.later);
      queues.push(first.queue);
      await first.continuations.continueWith(continuation({ run_id: 'run-z' }));
      await turnsIn(first.queue, 's1', 1);
      const failed = await lines(chatStore, 's1');
      hang = true;
      await before.next();
      await one.askedOnce;
      first.queue.close();
      // Run again once the server is back, and stopped in again.
      const two = hangs();
      const second = boot(db, chatStore, two.model, () => false);
      queues.push(second.queue);
      await two.askedOnce;
      second.queue.close();
      const asked = vi.fn(async () => said('never'));
      const third = boot(db, chatStore, asked, () => false);
      queues.push(third.queue);
      await owner(third.queue, 'Hello?');
      await turnsIn(third.queue, 's1', 4);
      // Not run a third time: the owner's turn asked the only model, and carried the call.
      expect((await third.queue.snapshot('s1')).turns.map((t) => t.status))
        .toEqual(['completed', 'interrupted', 'interrupted', 'completed']);
      expect(asked).toHaveBeenCalled();
      expect(third.notes).toEqual([]);
      expect((await lines(chatStore, 's1')).slice(0, failed.length)).toEqual(failed);
      expect(third.turns.untold('s1', 0, 5)).toEqual([]);
    } finally {
      for (const queue of queues) queue.close();
      db.close();
    }
  });
});
