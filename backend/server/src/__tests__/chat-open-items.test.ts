/** The owner's "do the still open items" (2026-11-19).
 *  - A call with no arguments is written as a bare name (`renderToolRow`); the records read only `name(…)` rows, so a
 *    successful one had no receipt and a failed one no attempt record.
 *  - The continuation that reports a held call's error is told what its own read can and cannot show. */
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import type { ChatPriorToolCall, InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { createChatOrchestrator, heldResultsTurnNote, HELD_RESULT_TURN_NOTE, HELD_RESULTS_TURN_NOTE,
  HELD_RESULT_UNCONFIRMED_SENTENCE, HELD_RESULTS_UNCONFIRMED_SENTENCE } from '../chat-orchestrator.js';
import { requestExecutionEvidence } from '../chat-request-evidence.js';
import { runChatTurn, UNCHECKED_ABSENCE_NOTE } from '../chat-turn-executor.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const entry = (name: string, classification: 'read' | 'write'): ToolEntry => ({ name, tier: 1, classification,
  description: name, arg_schema: { type: 'object', properties: {}, additionalProperties: false }, topic_tags: ['fixture'],
  concurrency_safe: classification === 'read' });
const lookup = entry('fixture.lookup', 'read'), clear = entry('fixture.clear', 'write');

/** One owner turn whose model calls `tool` with no arguments, then answers; the stored rows' records. */
const turnWithNoArgs = async (tool: ToolEntry, outcome: 'ok' | 'error') => {
  const db = new Database(':memory:'); databases.push(db); ensureChatSchema(db);
  const store = createChatStore(db); store.createSession({ id: 's' });
  const registry: InternalToolRegistry = { list: () => [lookup, clear], listByTier: () => [lookup, clear],
    getByName: (n) => [lookup, clear].find(t => t.name === n) ?? null, subscribeRefresh: () => () => {},
    dispatch: async () => (outcome === 'ok' ? { ok: true, result: { cleared: 3 } }
      : { ok: false, reason: 'execution_error', detail: 'The store did not answer.' }) };
  let id = 0, last = 0;
  await createChatOrchestrator({ chatStore: store, registry, mintId: () => `id-${String(++id)}`,
    now: () => (last = Math.max(Date.now(), last + 1)), selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'no-args' },
    broadcast: { emit: () => {} },
    executeAiCall: async (_m, input) => {
      const packet = JSON.parse(String(input['llm.prompt']));
      const called = (packet.prior_tool_calls ?? []).some((c: { tool_name?: string }) => c.tool_name === tool.name);
      return { body: { response: called ? 'Done.' : '', events: [], tool_calls: called ? [] : [{ tool: tool.name, args: {} }] } };
    } }).runTurn({ session_id: 's', message: 'Clear the fixture.', picker_state: { current: 'self' } } as never);
  const rows = await store.listMessages('s');
  const turn = rows.find(m => m.role === 'user')!.turn_id!;
  expect(rows.find(m => m.role === 'tool')?.content).toBe(tool.name); // written as a bare name
  return requestExecutionEvidence(rows, 's', turn, registry)!;
};

it('gives a successful call with no arguments its receipt', async () => {
  const evidence = await turnWithNoArgs(lookup, 'ok');
  expect(evidence.successful_calls_for_current_request).toEqual([
    expect.objectContaining({ tool_name: 'fixture.lookup', args: {}, result: { cleared: 3 } })]);
});

it('records a failed write with no arguments as an attempt', async () => {
  const evidence = await turnWithNoArgs(clear, 'error');
  expect(evidence.unsuccessful_action_attempts).toEqual([
    expect.objectContaining({ tool_name: 'fixture.clear', args: {}, state: 'failed',
      effect_confirmation: 'not_established_by_failed_state' })]);
});

const held = (status: 'ok' | 'error', reason?: string): ChatPriorToolCall => ({ tool_name: 'calendar.rename', tier: 1,
  args: { event_id: 'EVENT-7' }, started_at: 1, completed_at: 2, status,
  ...(status === 'error' ? { reason: reason as never, detail: 'Transport failed.' } : { result: { ok: true } }) } as ChatPriorToolCall);

it('tells the continuation what a read can show only when a held call returned an error', () => {
  expect(heldResultsTurnNote([held('ok')])).toBe(HELD_RESULT_TURN_NOTE);
  expect(heldResultsTurnNote([held('error', 'plan_cancelled')])).toBe(HELD_RESULT_TURN_NOTE); // refused: did not run
  expect(heldResultsTurnNote([held('error', 'invalid_args')])).toBe(HELD_RESULT_TURN_NOTE); // refused before it ran
  expect(heldResultsTurnNote([held('error', 'execution_error')])).toBe(HELD_RESULT_TURN_NOTE
    .replace(' The owner sent no new message.]', `${HELD_RESULT_UNCONFIRMED_SENTENCE} The owner sent no new message.]`));
  expect(heldResultsTurnNote([held('ok'), held('error', 'execution_error')])).toBe(HELD_RESULTS_TURN_NOTE
    .replace(' The owner sent no new message.]', `${HELD_RESULTS_UNCONFIRMED_SENTENCE} The owner sent no new message.]`));
  // The wording measured (internal benchmarks): change it, measure it again.
  expect(HELD_RESULT_UNCONFIRMED_SENTENCE).toBe(' If the call returned an error, its effect is unconfirmed: a read shows the'
    + ' current state, not that this call took effect, so never say it succeeded.');
});


// ── An absence said again after the host asked the model to look ──────────────────────────────────────────────
/** Two replies scripted for one owner turn: the first and the retry the absence guard sends. */
const absenceTurn = async (retry: { response: string; tool_calls?: Array<{ tool: string; args: Record<string, unknown> }>;
  events?: unknown[] }) => {
  const prompts: string[] = [];
  const result = await runChatTurn({ session_id: 'absence', turn_id: 't', picker_target: 'self', dispatch_peer_name: null,
    available_tools: [{ recipe_slug: 'work.search' }], content: { chat_tail: [], user_message: 'NOTES GO' },
    correction_context: [], model_layer: 'byok' } as never, {
    rollingBriefEnabled: () => false,
    executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
      prompts.push(String(input['llm.prompt']));
      return prompts.length === 1
        ? { body: { response: 'There are no pending note exports at the moment.', events: [], tool_calls: [] } }
        : prompts.length === 2 ? { body: { events: [], tool_calls: [], ...retry } }
          : { body: { response: 'Done.', events: [], tool_calls: [] } };
    },
    registry: { list: () => [], listByTier: () => [], getByName: () => undefined, dispatch: async () => ({ ok: true, result: {} }),
      subscribeRefresh: () => () => undefined } as never,
    dispatchTool: async () => ({ ok: true as const, result: { hits: [] } }), emit: () => undefined, now: () => 1_000,
  } as never);
  return { prompts, content: result.assistant_content };
};

it('shows an absence said again after the host asked to look, with the host line, instead of discarding it', async () => {
  const { prompts, content } = await absenceTurn({ response: 'There are no note exports waiting to be released.' });
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain('output_feedback');
  expect(content).toBe(`${UNCHECKED_ABSENCE_NOTE}\n\nThere are no note exports waiting to be released.`);
  expect(content).not.toContain('could not verify');
});

it('takes the retry as usual when it looks, and keeps refusing an invented value', async () => {
  const looked = await absenceTurn({ response: '', tool_calls: [{ tool: 'work.search', args: { query: 'note exports' } }] });
  expect(looked.prompts.length).toBeGreaterThan(2); // the search ran and the turn answered from it
  expect(looked.content).not.toContain(UNCHECKED_ABSENCE_NOTE);
  const acknowledged = await absenceTurn({ response: 'Note exports are no longer held.' });
  expect(acknowledged.content).toBe('Note exports are no longer held.');
});
