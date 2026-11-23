/** The owner, 2026-11-19: "both" (after the 80% fold was checked on a real server,
 *  internal benchmarks). Two things kept a conversation from ever folding:
 *  - a quick message took the last turn's closing fold over and cancelled it, every time, so a conversation of quick
 *    messages grew past the budget (276,746 characters) and paid for every cancelled fold;
 *  - with no window learned, the in-turn fold's trigger was infinite (one turn reached 271,616 characters).
 *  Now a takeover waits for a fold the carry's SIZE made due. The in-turn trigger took the 128,000 default too, until
 *  2026-11-20: browser task P went from 4/4 with no fold inside the turn to 3/17 with two or three (the brief kept
 *  what was pending but not the current page). The owner: "on the slot that knows the limit ... we use that, from
 *  unknown yet, we let it bloat". So inside a turn it folds only against a known window. */
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { InternalToolRegistry, ToolEntry } from '@recued/contracts';
import { estimateConservativeMessagesTokens, noteContextAccepted, noteTokenRatio, resetEndpointCapabilities,
  type LLMConfig, type LLMSlot } from '@recued/llm';
import { resolveChatInputTokenBudget } from '../chat-context-budget.js';
import { createChatOrchestrator, type BroadcastChatEvent } from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { runChatTurn } from '../chat-turn-executor.js';
import { BRIEF_INSTRUCTION, __clearSessionBriefs, __clearUnfoldedUserMessages } from '../chat-rolling-brief.js';

afterEach(() => { __clearSessionBriefs(); __clearUnfoldedUserMessages(); resetEndpointCapabilities(); });
const read: ToolEntry = { name: 'fixture.read', tier: 1, classification: 'read', description: 'Read a file by name.',
  arg_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, topic_tags: ['files'],
  concurrency_safe: true };
const registryOf = (text: (name: string) => string): InternalToolRegistry => ({ list: () => [read], listByTier: () => [read],
  getByName: (n) => (n === read.name ? read : null), subscribeRefresh: () => () => {},
  dispatch: async (_tool, args) => ({ ok: true, result: { name: (args as { name: string }).name, text: text((args as { name: string }).name) } }) });
const words = (chars: number) => 'The section continues as agreed. '.repeat(Math.ceil(chars / 33)).slice(0, chars);

it('makes a quick message wait for a closing fold the results\' size made due, rather than take them over raw', async () => {
  const db = new Database(':memory:'); ensureChatSchema(db);
  const store = createChatStore(db); store.createSession({ id: 'big' }); store.setRollingBriefEnabled(true);
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const calls = { main: 0, brief: 0 }; const packets: Array<Record<string, unknown>> = [];
  const events: BroadcastChatEvent[] = [];
  const orchestrator = withQueuedChatTurns(createChatOrchestrator({ chatStore: store, registry: registryOf(() => words(230_000)),
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'fold' }, broadcast: { emit: (e) => { events.push(e); } },
    executeAiCall: async (_m, input, opts) => {
      const packet = JSON.parse(String(input['llm.prompt']));
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) {
        calls.brief++;
        await Promise.race([held, new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('LLM call was cancelled')), { once: true });
        })]);
        return { body: { intent: 'Read the contract', constraints: [], pending: [], findings: ['The contract continues as agreed.'] } };
      }
      calls.main++; packets.push(packet);
      return { body: calls.main === 1
        ? { response: '', events: [], tool_calls: [{ tool: read.name, args: { name: 'contract' } }] }
        : { response: calls.main === 2 ? 'Read.' : 'Continued.', events: [], tool_calls: [] } };
    } }), { db, store, pollMs: 5 });
  const queue = orchestrator.turnQueue!;
  try {
    await orchestrator.runTurn({ session_id: 'big', message: 'Read the contract file.', picker_state: { current: 'self' } });
    await vi.waitFor(() => expect(calls.brief).toBe(1), { timeout: 10_000 });
    await vi.waitFor(async () => expect((await queue.snapshot('big')).turns[0]?.status).toBe('completed'), { timeout: 10_000 });
    await queue.submit({ family: 'chat', session_id: 'big', message: 'Continue.',
      input: { session_id: 'big', message: 'Continue.', picker_state: { current: 'self' } } }, 'quick');
    // Taken over, the follow-up's call would start now, holding the 230,000 characters raw. It waits instead.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls.main).toBe(2);
    release();
    await vi.waitFor(() => expect(calls.main).toBe(3), { timeout: 10_000 });
    const follow = JSON.stringify(packets[2]!.prior_tool_calls ?? []);
    expect(follow).toContain('context.brief');
    expect(follow).not.toContain('The section continues as agreed.');
    expect(calls.brief).toBe(1); // the fold ran once, and was not cancelled
    expect(await store.readSessionBrief('big')).toContain('Read the contract');
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({
      kind: 'recued.rolling_brief.trail', decisions: expect.arrayContaining([expect.stringMatching(/^waited:/u)]) }) })), { timeout: 10_000 });
  } finally { release(); queue.close(); await new Promise((resolve) => setImmediate(resolve)); db.close(); }
});

/** Three reads of 70,000 characters, then an answer; the order of the main and brief calls, with or without a
 *  window known for the turn. */
const readThree = async (input_token_budget?: number): Promise<string[]> => {
  const order: string[] = [];
  let main = 0;
  await runChatTurn({ session_id: 'in-turn', turn_id: 't', picker_target: 'self', dispatch_peer_name: null,
    available_tools: [{ recipe_slug: read.name }], content: { chat_tail: [], user_message: 'Read files a, b and c.' },
    correction_context: [], model_layer: 'byok', ...(input_token_budget !== undefined ? { input_token_budget } : {}) } as never, {
    rollingBriefEnabled: () => true,
    executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) {
        order.push('brief');
        return { body: { intent: 'Read files a, b and c', constraints: [], pending: [], findings: ['Each file continues as agreed.'] } };
      }
      main++; order.push('main');
      const next = ['a', 'b', 'c'][main - 1];
      return { body: next ? { response: '', events: [], tool_calls: [{ tool: read.name, args: { name: next } }] }
        : { response: 'All three read.', events: [], tool_calls: [] } };
    },
    registry: registryOf(() => words(70_000)),
    dispatchTool: async (r: { tool_name: string; arg_values: Record<string, unknown> }) =>
      ({ ok: true as const, result: { name: r.arg_values.name, text: words(70_000) } }),
    emit: () => undefined, now: () => 1_000,
  } as never);
  // All three reads and the answer ran: an absent fold is not a turn that stopped early.
  expect(order.filter((call) => call === 'main')).toHaveLength(4);
  return order;
};
const beforeAnswer = (order: string[]): string[] => order.slice(0, order.lastIndexOf('main'));

it('does not fold inside a turn when no window is known, however large its results', async () => {
  // 105,000 estimated tokens of results: past the 128,000 stand-in's trigger, which folded P mid-turn.
  expect(beforeAnswer(await readThree())).not.toContain('brief');
});

// 2026-11-20 (the owner: "go ahead", the brief's handoff) — after a fold inside the turn the next call kept only the
// brief, and on browser task P went back to an earlier page's refs; with the round that just landed beside the brief,
// it chose a fitting next step (recued-bridge-vs-browser-use/results/analysis/2026-11-20-P-four-way-handoff-386igzlf).
it('keeps the round that just landed beside the brief after a fold inside the turn, and drops the rounds before it', async () => {
  const order: string[] = [];
  const packets: string[] = [];
  let main = 0;
  const text = (name: string) => `FILE-${name.toUpperCase()} ` + words(70_000);
  await runChatTurn({ session_id: 'kept', turn_id: 't', picker_target: 'self', dispatch_peer_name: null,
    available_tools: [{ recipe_slug: read.name }], content: { chat_tail: [], user_message: 'Read files a, b and c.' },
    correction_context: [], model_layer: 'byok', input_token_budget: 128_000 } as never, {
    rollingBriefEnabled: () => true,
    executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) {
        order.push('brief');
        return { body: { intent: 'Read files a, b and c', constraints: [], pending: ['Read file c'], findings: ['Each file continues as agreed.'] } };
      }
      main++; order.push('main');
      packets.push(JSON.stringify(JSON.parse(String(input['llm.prompt'])).prior_tool_calls ?? []));
      const next = ['a', 'b', 'c'][main - 1];
      return { body: next ? { response: '', events: [], tool_calls: [{ tool: read.name, args: { name: next } }] }
        : { response: 'All three read.', events: [], tool_calls: [] } };
    },
    registry: registryOf(text),
    dispatchTool: async (r: { tool_name: string; arg_values: Record<string, unknown> }) =>
      ({ ok: true as const, result: { name: r.arg_values.name, text: text(String(r.arg_values.name)) } }),
    emit: () => undefined, now: () => 1_000,
  } as never);
  const firstFold = order.indexOf('brief');
  expect(firstFold).toBeGreaterThan(0);
  // The main call after the first fold: its packet holds the brief and the file read in the round just before it.
  const after = packets[order.slice(0, firstFold).filter((call) => call === 'main').length]!;
  const landed = ['a', 'b', 'c'][order.slice(0, firstFold).filter((call) => call === 'main').length - 1]!;
  expect(after).toContain('context.brief');
  expect(after).toContain(`FILE-${landed.toUpperCase()} `);
  for (const earlier of ['a', 'b', 'c'].slice(0, ['a', 'b', 'c'].indexOf(landed))) expect(after).not.toContain(`FILE-${earlier.toUpperCase()} `);
});

// A recall in the round a fold keeps stays a receipt, as every earlier recall does after a fold: the model's own query,
// with none of what was recalled. Only the round's other results ride as they came.
it('keeps a recall in the kept round as its receipt, without what it recalled', async () => {
  const order: string[] = [];
  const packets: string[] = [];
  let main = 0;
  await runChatTurn({ session_id: 'kept-recall', turn_id: 't', picker_target: 'self', dispatch_peer_name: null,
    available_tools: [{ recipe_slug: read.name }, { recipe_slug: 'memory.search' }], content: { chat_tail: [], user_message: 'Read files a, b and c, and recall the rate.' },
    correction_context: [], model_layer: 'byok', input_token_budget: 128_000 } as never, {
    rollingBriefEnabled: () => true,
    executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) {
        order.push('brief');
        return { body: { intent: 'Read files and recall the rate', constraints: [], pending: ['Answer'], findings: ['Each file continues as agreed.'] } };
      }
      main++; order.push('main');
      packets.push(String(input['llm.prompt']));
      const calls = [[{ tool: read.name, args: { name: 'a' } }], [{ tool: read.name, args: { name: 'b' } }],
        [{ tool: 'memory.search', args: { query: 'the agreed rate' } }, { tool: read.name, args: { name: 'c' } }]][main - 1];
      return { body: calls ? { response: '', events: [], tool_calls: calls } : { response: 'Done.', events: [], tool_calls: [] } };
    },
    registry: registryOf((name) => `FILE-${name.toUpperCase()} ` + words(name === 'c' ? 100_000 : 50_000)),
    dispatchTool: async (r: { tool_name: string; arg_values: Record<string, unknown> }) => r.tool_name === 'memory.search'
      ? ({ ok: true as const, result: { hits: [{ text: 'RECALLED: the agreed rate is 274 units' }] } })
      : ({ ok: true as const, result: { name: r.arg_values.name, text: `FILE-${String(r.arg_values.name).toUpperCase()} ` + words(r.arg_values.name === 'c' ? 100_000 : 50_000) } }),
    emit: () => undefined, now: () => 1_000,
  } as never);
  const firstFold = order.indexOf('brief');
  expect(firstFold).toBeGreaterThan(0);
  const after = packets[order.slice(0, firstFold).filter((call) => call === 'main').length]!;
  expect(after).toContain('FILE-C ');
  expect(after).toContain('the agreed rate');
  expect(after).not.toContain('RECALLED: the agreed rate is 274 units');
});

// The round a fold keeps rides in every later packet, so it takes the room the next results would have had: the next
// fold comes that much sooner (`heldTokens`). Against a 128,000 window, reads of 50,000, 50,000 and 100,000 characters
// fold at the third, which the fold keeps (about 50,000 estimated tokens). Three more of 50,000 then reach about 75,000:
// past the trigger with the kept read counted (about 48,000), short of it without (about 99,000).
it('counts the round a fold kept against the room, so the next fold comes sooner', async () => {
  const order: string[] = [];
  let main = 0;
  await runChatTurn({ session_id: 'held', turn_id: 't', picker_target: 'self', dispatch_peer_name: null,
    available_tools: [{ recipe_slug: read.name }], content: { chat_tail: [], user_message: 'Read files a to f.' },
    correction_context: [], model_layer: 'byok', input_token_budget: 128_000 } as never, {
    rollingBriefEnabled: () => true,
    executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) {
        order.push('brief');
        return { body: { intent: 'Read files a to f', constraints: [], pending: ['Read the rest'], findings: ['Each file continues as agreed.'] } };
      }
      main++; order.push('main');
      const next = ['a', 'b', 'c', 'd', 'e', 'f'][main - 1];
      return { body: next ? { response: '', events: [], tool_calls: [{ tool: read.name, args: { name: next } }] }
        : { response: 'All six read.', events: [], tool_calls: [] } };
    },
    registry: registryOf((name) => words(name === 'c' ? 100_000 : 50_000)),
    dispatchTool: async (r: { tool_name: string; arg_values: Record<string, unknown> }) =>
      ({ ok: true as const, result: { name: r.arg_values.name, text: words(r.arg_values.name === 'c' ? 100_000 : 50_000) } }),
    emit: () => undefined, now: () => 1_000,
  } as never);
  expect(beforeAnswer(order).filter((call) => call === 'brief')).toHaveLength(2);
});

it('folds inside a turn whose results near a known window', async () => {
  // The same reads where the endpoint's window is known (it refused a request for size): the fold runs before the
  // answer's call, as the trim needs.
  expect(beforeAnswer(await readThree(128_000))).toContain('brief');
});

// 2026-11-20 (the owner: "go ahead", the estimate) — the chat reads its budget again before each fold it weighs, so the
// provider's count of the turn's first calls applies within the turn. The window is typed (128,000) and the reads are
// those that fold against it above. Each main call is recorded as the LLM executor records it: accepted, with the
// provider's count. Counted as the estimate counts, the reads fold; counted at half, as the provider counted browser
// task P, the window holds them and they do not.
const readThreeCounted = async (share: number): Promise<string[]> => {
  const slot = { provider: 'openai-compatible', model: 'counted', api_key: 'k', base_url: 'http://counted.test',
    context_window_tokens: 128_000 } as unknown as LLMSlot;
  const config = { slot_1: slot, slot_2: slot, free_pool: [] } as unknown as LLMConfig;
  const budget = () => resolveChatInputTokenBudget(config, { layer: 'byok' });
  const order: string[] = [];
  let main = 0;
  await runChatTurn({ session_id: `counted-${String(share)}`, turn_id: 't', picker_target: 'self', dispatch_peer_name: null,
    available_tools: [{ recipe_slug: read.name }], content: { chat_tail: [], user_message: 'Read files a, b and c.' },
    correction_context: [], model_layer: 'byok', input_token_budget: budget() } as never, {
    rollingBriefEnabled: () => true,
    resolveInputTokenBudget: budget,
    executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) {
        order.push('brief');
        return { body: { intent: 'Read files a, b and c', constraints: [], pending: [], findings: ['Each file continues as agreed.'] } };
      }
      main++; order.push('main');
      const attempted = estimateConservativeMessagesTokens([{ role: 'system', content: String(input['llm.system_prompt']) },
        { role: 'user', content: String(input['llm.prompt']) }]);
      noteContextAccepted(slot, attempted);
      noteTokenRatio(slot, attempted, Math.floor(attempted * share));
      const next = ['a', 'b', 'c'][main - 1];
      return { body: next ? { response: '', events: [], tool_calls: [{ tool: read.name, args: { name: next } }] }
        : { response: 'All three read.', events: [], tool_calls: [] } };
    },
    registry: registryOf(() => words(70_000)),
    dispatchTool: async (r: { tool_name: string; arg_values: Record<string, unknown> }) =>
      ({ ok: true as const, result: { name: r.arg_values.name, text: words(70_000) } }),
    emit: () => undefined, now: () => 1_000,
  } as never);
  expect(order.filter((call) => call === 'main')).toHaveLength(4);
  return order;
};

it('weighs each fold against the budget as the turn learns it, from the provider count of its first calls', async () => {
  expect(beforeAnswer(await readThreeCounted(1))).toContain('brief');
  resetEndpointCapabilities();
  expect(beforeAnswer(await readThreeCounted(0.5))).not.toContain('brief');
});

/** A typed 128,000 window, and a main call recorded as the LLM executor records it: accepted, with the provider's
 *  count at `share` of the estimate. */
const countedEndpoint = (share: number) => {
  const slot = { provider: 'openai-compatible', model: 'counted', api_key: 'k', base_url: 'http://counted.test',
    context_window_tokens: 128_000 } as unknown as LLMSlot;
  const config = { slot_1: slot, slot_2: slot, free_pool: [] } as unknown as LLMConfig;
  return {
    budget: () => resolveChatInputTokenBudget(config, { layer: 'byok' }),
    count: (input: Record<string, unknown>) => {
      const attempted = estimateConservativeMessagesTokens([{ role: 'system', content: String(input['llm.system_prompt']) },
        { role: 'user', content: String(input['llm.prompt']) }]);
      noteContextAccepted(slot, attempted);
      noteTokenRatio(slot, attempted, Math.floor(attempted * share));
    },
  };
};

// With no fold, the prompt itself is fitted to the budget: three reads of 80,000 characters pass the uncounted budget
// and are cut to fit it; counted at half, the window holds them whole.
const lastPacketOfFour = async (share: number): Promise<string> => {
  const endpoint = countedEndpoint(share);
  const packets: string[] = [];
  await runChatTurn({ session_id: `fit-${String(share)}`, turn_id: 't', picker_target: 'self', dispatch_peer_name: null,
    available_tools: [{ recipe_slug: read.name }], content: { chat_tail: [], user_message: 'Read files a, b and c.' },
    correction_context: [], model_layer: 'byok', input_token_budget: endpoint.budget() } as never, {
    rollingBriefEnabled: () => false,
    resolveInputTokenBudget: endpoint.budget,
    executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
      endpoint.count(input);
      packets.push(JSON.stringify(JSON.parse(String(input['llm.prompt'])).prior_tool_calls ?? []));
      const next = ['a', 'b', 'c'][packets.length - 1];
      return { body: next ? { response: '', events: [], tool_calls: [{ tool: read.name, args: { name: next } }] }
        : { response: 'All three read.', events: [], tool_calls: [] } };
    },
    registry: registryOf(() => words(80_000)),
    dispatchTool: async (r: { tool_name: string; arg_values: Record<string, unknown> }) =>
      ({ ok: true as const, result: { name: r.arg_values.name, text: words(80_000) } }),
    emit: () => undefined, now: () => 1_000,
  } as never);
  expect(packets).toHaveLength(4);
  return packets[3]!;
};

it('fits each prompt to the budget as the turn learns it', async () => {
  const whole = words(80_000);
  expect((await lastPacketOfFour(1)).split(whole).length - 1).toBeLessThan(3);
  resetEndpointCapabilities();
  expect((await lastPacketOfFour(0.5)).split(whole).length - 1).toBe(3);
});

// The turn's closing decision too: two reads of 100,000 characters and the answer. The third call completes the count,
// so only a budget read after it sees the window in the provider's units: the results then ride to the next turn raw
// (`carried_raw`) where the uncounted budget closed with a fold (`carry_due`).
const closingOfTwoReads = async (share: number): Promise<string[]> => {
  const endpoint = countedEndpoint(share);
  const db = new Database(':memory:'); ensureChatSchema(db);
  const store = createChatStore(db); const sid = `closing-${String(share)}`;
  store.createSession({ id: sid }); store.setRollingBriefEnabled(true);
  const decisions: string[] = [];
  let main = 0;
  const orchestrator = createChatOrchestrator({ chatStore: store, registry: registryOf(() => words(100_000)),
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'closing' },
    broadcast: { emit: (e: unknown) => {
      const heard = e as { kind?: string; event?: { kind?: string; decisions?: string[] } };
      if (heard.kind === 'chat.transparency' && heard.event?.kind === 'recued.rolling_brief.trail') decisions.push(...(heard.event.decisions ?? []));
    } },
    resolveInputTokenBudget: endpoint.budget,
    executeAiCall: async (_m, input) => {
      if (String(input['llm.system_prompt']).startsWith(BRIEF_INSTRUCTION)) {
        return { body: { intent: 'Read files a and b', constraints: [], pending: [], findings: ['Each file continues as agreed.'] } };
      }
      endpoint.count(input);
      main++;
      const next = ['a', 'b'][main - 1];
      return { body: next ? { response: '', events: [], tool_calls: [{ tool: read.name, args: { name: next } }] }
        : { response: 'Both read.', events: [], tool_calls: [] } };
    } });
  try {
    await orchestrator.runTurn({ session_id: sid, message: 'Read files a and b.', picker_state: { current: 'self' } });
  } finally { db.close(); }
  expect(main).toBe(3);
  return decisions.filter((d) => /^carr(ied_raw|y_due|y_refused)/.test(d)).map((d) => /^[a-z_]+/.exec(d)![0]);
};

it('closes the turn against the budget as the turn learned it, its last call included', async () => {
  expect(await closingOfTwoReads(1)).toEqual(['carry_due']);
  resetEndpointCapabilities();
  expect(await closingOfTwoReads(0.5)).toEqual(['carried_raw']);
});
