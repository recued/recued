/** 2026-11-21 (the owner: "test all three for answers") — a fold reads each result's output once, as the main packet
 *  does. The engine writes a run's output twice, `output.render` and `output.sidebar` (an exact copy); the main packet
 *  has dropped the copy since D-335 slice Q (`withoutRenderAlias`), while the fold's `tool_results_since` still carried
 *  it: 41% of the control's fold input on browser task P
 *  (recued-bridge-vs-browser-use/results/analysis/2026-11-21-P-working-set-W-c3f0f3521). */
import { afterEach, expect, it } from 'vitest';
import type { InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { runChatTurn } from '../chat-turn-executor.js';
import { BRIEF_INSTRUCTION, __clearSessionBriefs, __clearUnfoldedUserMessages } from '../chat-rolling-brief.js';

afterEach(() => { __clearSessionBriefs(); __clearUnfoldedUserMessages(); });

const page: ToolEntry = { name: 'fixture.page', tier: 1, classification: 'read', description: 'Read a page by name.',
  arg_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, topic_tags: ['web'],
  concurrency_safe: true };
const registry: InternalToolRegistry = { list: () => [page], listByTier: () => [page], getByName: (n) => (n === page.name ? page : null),
  subscribeRefresh: () => () => {}, dispatch: async () => { throw Error('Use the native dispatch seam'); } };
const outline = (name: string, chars: number) => `OUTLINE-${name.toUpperCase()} ` + 'A heading and its links. '.repeat(Math.ceil(chars / 25)).slice(0, chars);
/** A run's result as the engine writes it: its sections in `render`, and in `sidebar` the same, or `sidebar` of its own. */
const runResult = (name: string, chars: number, sidebar?: unknown[]) => {
  const render = [{ type: 'json', data: { outline: outline(name, chars) } }];
  return { recipe_id: 'fixture-page', success: true, output: { render, sidebar: sidebar ?? [...render] }, steps: [], errors: [] };
};

/** Three page reads, then an answer: every fold prompt the turn sent, and the order of its main and fold calls. */
const readThree = async (opts: { chars: number; input_token_budget?: number; sidebar?: (name: string) => unknown[] }) => {
  const folds: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  let main = 0;
  await runChatTurn({ session_id: `once-${String(Math.random())}`, turn_id: 't', picker_target: 'self', dispatch_peer_name: null,
    available_tools: [{ recipe_slug: page.name }], content: { chat_tail: [], user_message: 'Read pages a, b and c.' },
    correction_context: [], model_layer: 'byok', ...(opts.input_token_budget !== undefined ? { input_token_budget: opts.input_token_budget } : {}) } as never, {
    rollingBriefEnabled: () => true,
    executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) {
        folds.push(JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>);
        order.push('fold');
        return { body: { intent: 'Read pages a, b and c', constraints: [], pending: [], findings: ['Each page lists its links.'] } };
      }
      main += 1;
      order.push('main');
      const next = ['a', 'b', 'c'][main - 1];
      return { body: next ? { response: '', events: [], tool_calls: [{ tool: page.name, args: { name: next } }] }
        : { response: 'All three read.', events: [], tool_calls: [] } };
    },
    registry,
    dispatchTool: async (r: { arg_values: Record<string, unknown> }) => {
      const name = String(r.arg_values.name);
      return { ok: true as const, result: runResult(name, opts.chars, opts.sidebar?.(name)) };
    },
    emit: () => undefined, now: () => 1_000,
  } as never);
  expect(main).toBe(4);
  return { folds, order };
};
type Since = Array<{ result: { output: Record<string, unknown> } }>;
const occurrences = (fold: Record<string, unknown>, marker: string): number => JSON.stringify(fold).split(marker).length - 1;

it('the closing fold reads each result\'s output once, all of it', async () => {
  const { folds, order } = await readThree({ chars: 2_000 });
  expect(order.at(-1)).toBe('fold');
  const closing = folds.at(-1)!;
  const since = closing.tool_results_since as Since;
  expect(since).toHaveLength(3);
  for (const call of since) expect(Object.keys(call.result.output)).toEqual(['render']);
  for (const name of ['A', 'B', 'C']) expect(occurrences(closing, `OUTLINE-${name} `)).toBe(1);
});

it('a fold inside the turn reads each result\'s output once', async () => {
  // 35,000 characters an outline, so 70,000 as the calls hold a result with its copy: a fold must still be able to
  // read one (its capacity is checked on the calls as they hold them).
  const { folds, order } = await readThree({ chars: 35_000, input_token_budget: 128_000 });
  // The turn folded before its answer, and every fold read each of its results once.
  expect(order.slice(0, order.lastIndexOf('main'))).toContain('fold');
  for (const fold of folds) {
    const since = fold.tool_results_since as Since;
    for (const call of since) expect(call.result.output.sidebar).toBeUndefined();
    for (const name of ['A', 'B', 'C']) expect(occurrences(fold, `OUTLINE-${name} `)).toBeLessThanOrEqual(1);
  }
});

it('keeps a sidebar that is not a copy of the render', async () => {
  const { folds } = await readThree({ chars: 2_000, sidebar: (name) => [{ type: 'text', text: `SIDEBAR-${name.toUpperCase()} of its own` }] });
  const since = folds.at(-1)!.tool_results_since as Since;
  expect(since.map((call) => (call.result.output.sidebar as Array<{ text: string }>)[0]!.text))
    .toEqual(['SIDEBAR-A of its own', 'SIDEBAR-B of its own', 'SIDEBAR-C of its own']);
});
