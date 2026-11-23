/** The owner, 2026-11-19: "do check against re-proposing an unconfirmed rename". An approved held write whose
 *  outcome is not known may already have taken effect. The same write is not proposed again until an earlier round
 *  of the turn has read the record; after that read it goes as usual, since the owner may want it again. Measured
 *  before: "The current title of calendar event EVENT-7 is Review. The earlier rename attempt failed, so I will retry
 *  it now." (2 of 10 resends of one request). */
import { expect, it } from 'vitest';
import type { ToolEntry } from '@recued/contracts';
import { runChatTurn, UNCONFIRMED_ATTEMPT_DETAIL } from '../chat-turn-executor.js';

const entry = (name: string, classification: 'read' | 'write'): ToolEntry => ({ name, tier: 1, classification,
  description: name, arg_schema: { type: 'object' }, topic_tags: ['calendar'], concurrency_safe: classification === 'read' });
const tools = [entry('calendar.rename', 'write'), entry('calendar.get', 'read'), entry('notes.clear', 'write')];
const RENAME = { tool: 'calendar.rename', args: { event_id: 'EVENT-7', title: 'Review' } };
type Call = { tool: string; args: Record<string, unknown> };

/** One owner turn: each model call answers with the next round of calls, then "Done.". */
const turn = async (rounds: Call[][], uncertain: ReadonlyArray<{ tool: string; args: unknown }> | undefined) => {
  const prompts: Array<Record<string, any>> = [];
  const dispatched: Call[] = [];
  await runChatTurn({ session_id: 's', turn_id: 't', picker_target: 'self', dispatch_peer_name: null,
    available_tools: tools.map((t) => ({ recipe_slug: t.name })),
    // The records are named, so the identifier guard (which refuses an invented id first) lets the calls through.
    content: { chat_tail: [], user_message: 'Continue the original rename of calendar event EVENT-7 (EVENT-8 is the other one).' },
    correction_context: [], model_layer: 'byok' } as never, {
    rollingBriefEnabled: () => false,
    ...(uncertain !== undefined ? { readUncertainHeldWrites: async () => uncertain } : {}),
    executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
      prompts.push(JSON.parse(String(input['llm.prompt'])));
      const next = rounds[prompts.length - 1];
      return { body: next ? { response: '', events: [], tool_calls: next } : { response: 'Done.', events: [], tool_calls: [] } };
    },
    registry: { list: () => tools, listByTier: () => tools, getByName: (n: string) => tools.find((t) => t.name === n) ?? null,
      dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => undefined } as never,
    dispatchTool: async (request: { tool_name: string; arg_values: Record<string, unknown> }) => {
      dispatched.push({ tool: request.tool_name, args: request.arg_values });
      return { ok: true as const, result: request.tool_name === 'calendar.get' ? { title: 'Review' } : { done: true } };
    },
    emit: () => undefined, now: () => 1_000,
  } as never);
  const refusals = prompts.flatMap((p) => (p.prior_tool_calls ?? []) as Array<Record<string, unknown>>)
    .filter((c) => c.reason === 'unconfirmed_attempt');
  return { dispatched, refusals };
};

it('refuses the same write without a read of the record, then lets it through after one', async () => {
  const t = await turn([[RENAME], [{ tool: 'calendar.get', args: { event_id: 'EVENT-7' } }], [RENAME]], [RENAME]);
  expect(t.dispatched.map((c) => c.tool)).toEqual(['calendar.get', 'calendar.rename']);
  expect(t.refusals[0]).toMatchObject({ tool_name: 'calendar.rename', status: 'error', reason: 'unconfirmed_attempt',
    detail: UNCONFIRMED_ATTEMPT_DETAIL('calendar.rename') });
});

it('does not count a read in the same batch, or a read of another record', async () => {
  const sameBatch = await turn([[{ tool: 'calendar.get', args: { event_id: 'EVENT-7' } }, RENAME]], [RENAME]);
  expect(sameBatch.dispatched.map((c) => c.tool)).toEqual(['calendar.get']);
  expect(sameBatch.refusals).not.toHaveLength(0);
  const other = await turn([[{ tool: 'calendar.get', args: { event_id: 'EVENT-8' } }], [RENAME]], [RENAME]);
  expect(other.dispatched.map((c) => c.tool)).toEqual(['calendar.get']);
});

it('leaves a different write, a write with no uncertain attempt, and a turn with no list alone', async () => {
  expect((await turn([[{ tool: 'calendar.rename', args: { event_id: 'EVENT-7', title: 'Retro' } }]], [RENAME])).dispatched)
    .toEqual([{ tool: 'calendar.rename', args: { event_id: 'EVENT-7', title: 'Retro' } }]);
  expect((await turn([[RENAME]], [])).dispatched).toEqual([RENAME]);
  expect((await turn([[RENAME]], undefined)).dispatched).toEqual([RENAME]);
});

it('takes any read for a write that names no record', async () => {
  const clear = { tool: 'notes.clear', args: {} };
  expect((await turn([[clear]], [clear])).dispatched).toEqual([]);
  expect((await turn([[{ tool: 'calendar.get', args: { event_id: 'EVENT-7' } }], [clear]], [clear])).dispatched.map((c) => c.tool))
    .toEqual(['calendar.get', 'notes.clear']);
});
