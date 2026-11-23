/** 2026-11-21 (the owner: "a,b,c yes", b: earned rounds; and "for the case when the 10 ceiling is hit ... can it be
 *  resumed manually by user (present to user on what already has and basically user can continue maybe?)"). Past the
 *  cap, a work round is earned by the round before it reaching a page or making a call the turn had not, up to the
 *  ceilings; a turn that stops at its rounds says which pages it reached, ahead of the stop reason. */
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_MAIN_TURN_TOOL_LOOP_CAP, CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE,
  type ChatPriorToolCall, type InternalToolRegistry, type ToolEntry } from '@recued/contracts';
import { BOUNDED_RUN_LAST_ROUND, CHAT_TURN_AFTER_ROUND_LIMIT, CHAT_TURN_EARNED_ROUND_CEILING, CHAT_TURN_EARNED_ROUND_TOKEN_CEILING,
  chatToolRoundBudget, freshTokens, reachedPages, reachedSomethingNew, toolBudgetStopAnswer } from '../chat-turn-budget.js';
import { runChatTurn } from '../chat-turn-executor.js';
import { __clearSessionBriefs, __clearUnfoldedUserMessages } from '../chat-rolling-brief.js';

afterEach(() => { __clearSessionBriefs(); __clearUnfoldedUserMessages(); });

const call = (tool: string, args: unknown, result: unknown, status: 'ok' | 'error' = 'ok'): ChatPriorToolCall =>
  ({ tool_name: tool, tier: 1, args, status, result } as ChatPriorToolCall);

describe('reachedSomethingNew', () => {
  it('counts a page by its address, without what follows #', () => {
    const reached = new Set<string>();
    expect(reachedSomethingNew([call('read', { p: 1 }, { url: 'https://example.org/a' })], reached)).toBe(true);
    expect(reachedSomethingNew([call('read', { p: 2 }, { url: 'https://example.org/a#history' })], reached)).toBe(false);
    expect(reachedSomethingNew([call('read', { p: 2 }, { view: { url: 'https://example.org/a?page=2' } })], reached)).toBe(true);
  });

  it('a page reached stays reached whatever it shows: browser task P stamps the note with the time at each save', () => {
    const reached = new Set<string>();
    reachedSomethingNew([call('act', { steps: ['save'] }, { view: { url: 'https://notes.example/app/', outline: 'Saved at 06:35:10' } })], reached);
    expect(reachedSomethingNew([call('act', { steps: ['save', 'again'] },
      { view: { url: 'https://notes.example/app/', outline: 'Saved at 06:36:02' } })], reached)).toBe(false);
  });

  it('a call that names no page counts as itself when it succeeded, whatever order its arguments came in', () => {
    const reached = new Set<string>();
    expect(reachedSomethingNew([call('mail.search', { q: 'invoice', limit: 5 }, { hits: [] })], reached)).toBe(true);
    expect(reachedSomethingNew([call('mail.search', { limit: 5, q: 'invoice' }, { hits: ['m1'] })], reached)).toBe(false);
    expect(reachedSomethingNew([call('mail.search', { q: 'invoice 1043' }, { hits: [] })], reached)).toBe(true);
    expect(reachedSomethingNew([call('mail.search', { q: 'refused' }, undefined, 'error')], reached)).toBe(false);
    // A browser call that failed after it reached a page did reach it.
    expect(reachedSomethingNew([call('act', { x: 1 }, { url: 'https://example.org/b' }, 'error')], reached)).toBe(true);
  });
});

describe('the answer of a turn that stopped at its rounds', () => {
  it('names the pages it reached, by title, the last six, with the stop reason last', () => {
    const calls = Array.from({ length: 8 }, (_, i) => ({ result: { data: { url: `https://books.example/p${String(i)}`, title: `Page ${String(i)}` } } }));
    const text = toolBudgetStopAnswer(calls);
    expect(text.startsWith('So far this turn reached 8 pages, the last 6: “Page 2” (https://books.example/p2); “Page 3”')).toBe(true);
    expect(text).not.toContain('“Page 1”');
    expect(text.endsWith(`“Page 7” (https://books.example/p7).\n\n${CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE}`)).toBe(true);
    expect(reachedPages([{ result: { a: { url: 'https://x.example/#top', title: ' ' } } }])).toEqual([{ url: 'https://x.example/' }]);
  });

  it('is the stop reason alone when the turn reached no page', () => {
    expect(toolBudgetStopAnswer([{ result: { hits: [] } }])).toBe(CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE);
  });
});

// 2026-11-21 (the owner: "isnt the extra round non-model specific? so recued sees the limit, stop the model, show a
// continue") — the model is told how rounds are counted, never how many remain or how they are earned.
it('tells the model how rounds are counted, never how many remain or how they are earned', () => {
  const first = chatToolRoundBudget(CHAT_MAIN_TURN_TOOL_LOOP_CAP, 0, 0);
  const earned = chatToolRoundBudget(CHAT_MAIN_TURN_TOOL_LOOP_CAP + 3, CHAT_MAIN_TURN_TOOL_LOOP_CAP + 2, 0);
  expect(first).not.toHaveProperty('work_rounds_remaining');
  expect(earned).not.toHaveProperty('work_rounds_remaining');
  expect(earned.rules).toBe(first.rules);
  expect(first.rules).toContain('One round is one batch of tool calls');
  expect(first.rules).not.toMatch(/given one at a time|goes back over|ends them/u);
});

const browse: ToolEntry = { name: 'fixture.browse', tier: 1, classification: 'read', description: 'Open a page.',
  arg_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, topic_tags: ['web'],
  concurrency_safe: true };
const registry: InternalToolRegistry = { list: () => [browse], listByTier: () => [browse], getByName: (n) => (n === browse.name ? browse : null),
  subscribeRefresh: () => () => {}, dispatch: async () => { throw Error('Use the native dispatch seam'); } };

/** A turn whose model asks for one more page at each call: `next(n)` is its n-th call's address. Each call reports
 *  `usage` provider tokens when given. After 40 calls it answers, so a turn that never stops earning fails these
 *  assertions instead of hanging: its calls return at once, so the loop never yields to vitest's timeout. */
const STUB_ANSWERS_AFTER = 40;
const browsingTurn = async (next: (n: number) => string, opts: { toolRoundCap?: number; usage?: number; cached?: number;
  /** Answer at the call told no round remains, as a model given `BOUNDED_RUN_LAST_ROUND` does. */
  answerWhenTold?: boolean; /** Answer at this call. */ answerAt?: number;
  /** The answer before this turn's message stopped at its round limit. */ afterLimit?: boolean } = {}) => {
  const feedback: string[] = [];
  const counted: boolean[] = [];
  const rules: string[] = [];
  const previous: string[] = [];
  let calls = 0;
  let dispatched = 0;
  const result = await runChatTurn({ session_id: `earn-${String(Math.random())}`, turn_id: 't', picker_target: 'self', dispatch_peer_name: null,
    available_tools: [{ recipe_slug: browse.name }], content: { chat_tail: [], user_message: 'Research the three sites.' },
    correction_context: [], model_layer: 'byok', ...(opts.toolRoundCap !== undefined ? { tool_round_cap: opts.toolRoundCap } : {}),
    ...(opts.afterLimit === true ? { previous_turn_reached_round_limit: true } : {}) } as never, {
    rollingBriefEnabled: () => false,
    executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
      calls += 1;
      const packet = JSON.parse(String(input['llm.prompt'])) as { output_feedback?: string;
        tool_round_budget?: { rules?: string; previous_turn?: string } };
      feedback.push(String(packet.output_feedback ?? ''));
      counted.push(packet.tool_round_budget !== undefined && 'work_rounds_remaining' in packet.tool_round_budget);
      rules.push(String(packet.tool_round_budget?.rules ?? ''));
      previous.push(packet.tool_round_budget?.previous_turn ?? '');
      if (calls > STUB_ANSWERS_AFTER || calls === opts.answerAt
        || (opts.answerWhenTold === true && String(packet.output_feedback ?? '').includes(BOUNDED_RUN_LAST_ROUND))) {
        return { body: { response: 'Here is what I found so far.', events: [], tool_calls: [] } };
      }
      return { body: { response: '', events: [], tool_calls: [{ tool: browse.name, args: { url: next(calls) } }] },
        ...(opts.usage !== undefined ? { usage: { input_tokens: opts.usage, output_tokens: 0, total_tokens: opts.usage,
          ...(opts.cached !== undefined ? { cache_read_input_tokens: opts.cached } : {}) } } : {}) };
    },
    registry,
    dispatchTool: async (r: { arg_values: Record<string, unknown> }) => {
      dispatched += 1;
      return { ok: true as const, result: { url: String(r.arg_values.url), title: `Page ${String(dispatched)}` } };
    },
    emit: () => undefined, now: () => 1_000,
  } as never);
  return { content: result.assistant_content, calls, dispatched, feedback, counted, rules, previous, limit: result.reached_round_limit };
};
const lastRoundTold = (feedback: readonly string[]): number[] =>
  feedback.flatMap((text, index) => (text.includes(BOUNDED_RUN_LAST_ROUND) ? [index + 1] : []));

it('earns a round past the cap after each round that reached a new page, one at a time, up to the ceiling', async () => {
  const t = await browsingTurn((n) => `https://books.example/page/${String(n)}`);
  expect(t.dispatched).toBe(CHAT_TURN_EARNED_ROUND_CEILING);
  expect(t.calls).toBe(CHAT_TURN_EARNED_ROUND_CEILING + 1);
  // Only the call after the last round earned is told none remain; no call is told a count or how rounds are earned.
  expect(lastRoundTold(t.feedback)).toEqual([CHAT_TURN_EARNED_ROUND_CEILING + 1]);
  expect(t.counted.some(Boolean)).toBe(false);
  expect(new Set(t.rules).size).toBe(1);
  // It stopped with tools still wanted: what it reached, then the stop reason, and Chat offers Continue under it.
  expect(t.content).toContain(`“Page ${String(CHAT_TURN_EARNED_ROUND_CEILING)}” (https://books.example/page/${String(CHAT_TURN_EARNED_ROUND_CEILING)})`);
  expect(t.content.endsWith(CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE)).toBe(true);
  expect(t.limit).toBe(true);
});

it('earns nothing when its rounds go back over the same page, and stops at the cap', async () => {
  const t = await browsingTurn(() => 'https://notes.example/app/');
  expect(t.dispatched).toBe(CHAT_MAIN_TURN_TOOL_LOOP_CAP);
  expect(new Set(t.rules).size).toBe(1);
  expect(lastRoundTold(t.feedback)).toEqual([CHAT_MAIN_TURN_TOOL_LOOP_CAP + 1]);
  expect(t.content).toBe(`So far this turn reached “Page 1” (https://notes.example/app/).\n\n${CHAT_TOOL_BUDGET_EXHAUSTED_MESSAGE}`);
  expect(t.limit).toBe(true);
});

// 2026-11-21 (the owner: "recued sees the limit, stop the model, show a continue") — Chat offers Continue under a turn
// that ended at its limit whatever its last call wrote: an answer there is marked as much as a stop.
it('marks a turn that answered at its limit, and not one that answered before it', async () => {
  const atLimit = await browsingTurn(() => 'https://notes.example/app/', { answerWhenTold: true });
  expect(atLimit.dispatched).toBe(CHAT_MAIN_TURN_TOOL_LOOP_CAP);
  expect(lastRoundTold(atLimit.feedback)).toEqual([CHAT_MAIN_TURN_TOOL_LOOP_CAP + 1]);
  expect(atLimit.content).toBe('Here is what I found so far.');
  expect(atLimit.limit).toBe(true);
  // Past the cap too: the earned round that was the last.
  const earned = await browsingTurn((n) => `https://books.example/page/${String(n)}`, { answerWhenTold: true });
  expect(earned.dispatched).toBe(CHAT_TURN_EARNED_ROUND_CEILING);
  expect(earned.limit).toBe(true);
  // Before the limit, in the base rounds or in an earned one, there is nothing to continue.
  for (const answerAt of [3, CHAT_MAIN_TURN_TOOL_LOOP_CAP + 3]) {
    const early = await browsingTurn((n) => `https://books.example/page/${String(n)}`, { answerAt });
    expect(early.dispatched).toBe(answerAt - 1);
    expect(lastRoundTold(early.feedback)).toEqual([]);
    expect(early.limit).toBeUndefined();
  }
});

// 2026-11-21 (the owner: "finish the followups") — the answer before a Continue often said the rounds were gone, and the
// packet carries no count. The turn after an answer at the limit is told it has rounds of its own until its first work
// round, and no other turn is.
it('tells a turn after one that stopped at its limit that it has rounds of its own, until its first work round', async () => {
  const after = await browsingTurn((n) => `https://books.example/page/${String(n)}`, { afterLimit: true, answerAt: 4 });
  expect(after.dispatched).toBe(3);
  expect(after.previous).toEqual([CHAT_TURN_AFTER_ROUND_LIMIT, '', '', '']);
  expect(new Set(after.rules).size).toBe(1);
  const ordinary = await browsingTurn((n) => `https://books.example/page/${String(n)}`, { answerAt: 4 });
  expect(ordinary.previous).toEqual(['', '', '', '']);
  expect(chatToolRoundBudget(CHAT_MAIN_TURN_TOOL_LOOP_CAP, 0, 0, true)).toMatchObject({ previous_turn: CHAT_TURN_AFTER_ROUND_LIMIT });
  expect(chatToolRoundBudget(CHAT_MAIN_TURN_TOOL_LOOP_CAP, 0, 0)).not.toHaveProperty('previous_turn');
});

it('counts the tokens a turn had the provider newly process: all but its cached input', () => {
  expect(freshTokens(undefined)).toBe(0);
  expect(freshTokens({ input_tokens: 1_000, output_tokens: 100, total_tokens: 1_100 })).toBe(1_100);
  expect(freshTokens({ input_tokens: 1_000, output_tokens: 100, total_tokens: 1_100, cache_read_input_tokens: 800 })).toBe(300);
});

it('keeps earning while most of each call is the cached call before it', async () => {
  // A tenth of the ceiling a call, nine tenths of it cached: counted whole, the turn would stop at the cap.
  const usage = Math.ceil(CHAT_TURN_EARNED_ROUND_TOKEN_CEILING / CHAT_MAIN_TURN_TOOL_LOOP_CAP);
  const t = await browsingTurn((n) => `https://books.example/page/${String(n)}`, { usage, cached: Math.floor(usage * 0.9) });
  expect(t.dispatched).toBe(CHAT_TURN_EARNED_ROUND_CEILING);
});

it('earns nothing once the turn has spent its token ceiling', async () => {
  const usage = Math.ceil(CHAT_TURN_EARNED_ROUND_TOKEN_CEILING / CHAT_MAIN_TURN_TOOL_LOOP_CAP);
  const t = await browsingTurn((n) => `https://books.example/page/${String(n)}`, { usage });
  expect(t.dispatched).toBe(CHAT_MAIN_TURN_TOOL_LOOP_CAP);
});

it('a managed run keeps the rounds it was given, however new its pages', async () => {
  const t = await browsingTurn((n) => `https://books.example/page/${String(n)}`, { toolRoundCap: 3 });
  expect(t.dispatched).toBe(3);
  expect(lastRoundTold(t.feedback)).toEqual([4]);
});
