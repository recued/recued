import { describe, expect, it, vi } from 'vitest';
import type {
  AIOutput,
  ChatDispatchResult,
  InternalToolRegistry,
  ToolEntry,
} from '@recued/contracts';

import { runChatTurn } from '../chat-turn-executor.js';

/** ⛔⛔ THE SEAM, NOT THE PREDICATE. `tool-argument-grounding.test.ts` proves
 *  `ungroundedArgumentsInCall` computes the right answer and proves NOTHING
 *  about whether the tool loop consults it. That distinction is not theoretical
 *  here: earlier in this arc a nine-test pure-function suite stayed entirely
 *  GREEN while the call site it was written for had been reverted. These tests
 *  drive the REAL `runChatTurn` and assert on `dispatchTool` — the thing that
 *  would act on a fabricated value — so removing the check turns them red. */
const entry: ToolEntry = {
  name: 'add-unit',
  tier: 2,
  description: 'add a unit to a building',
  arg_schema: {},
  topic_tags: ['records'],
  classification: 'write',
  risk_tier: 'write',
  concurrency_safe: false,
};

const registry: InternalToolRegistry = {
  list: () => [entry],
  listByTier: () => [entry],
  getByName: (name) => (name === entry.name ? entry : null),
  dispatch: async () => ({ ok: true, result: {} }),
  subscribeRefresh: () => () => {},
};

const input = {
  session_id: 's1',
  turn_id: 't1',
  picker_target: 'self' as const,
  dispatch_peer_name: null,
  available_tools: [{ recipe_slug: 'add-unit', args_schema: {} }],
  content: {
    chat_tail: [],
    user_message: 'list my buildings and add a unit to the first one',
  },
  correction_context: [] as string[],
  model_layer: 'byok' as const,
};

const outputWith = (args: Record<string, unknown>): AIOutput => ({
  response: '',
  events: [],
  tool_calls: [{ tool: 'add-unit', args }],
});

const run = async (args: Record<string, unknown>) => {
  const dispatchTool = vi.fn(async (): Promise<ChatDispatchResult> => ({
    ok: true,
    result: { id: 'unit_777' },
  }));
  // One AI call emitting the offending batch, then a plain answer so the loop
  // terminates rather than looping on the refusal feedback.
  let call = 0;
  const executeAiCall = vi.fn(async () => ({
    body: call++ === 0
      ? outputWith(args)
      : ({ response: 'ok', events: [], tool_calls: [] } as AIOutput),
  }));
  const result = await runChatTurn(input as never, {
    registry,
    dispatchTool,
    executeAiCall,
    emit: () => {},
    now: () => 0,
  } as never);
  return { dispatchTool, result };
};

describe('the tool loop refuses an argument the model could not have read', () => {
  /** ⛔ Verbatim from bench 181: `add-unit` issued with a `building_id` no
   *  completed step returned. The dispatcher must never see it. */
  it('does NOT dispatch a call carrying an unsourced identifier', async () => {
    const { dispatchTool } = await run({ building_id: '__first__', label: 'Flat 2' });
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  /** ⛔⛔ THE PERMITTING WITNESS, and without it the test above cannot tell a
   *  grounding check from a loop that dispatches nothing at all. The owner's own
   *  message carries the id, so the identical call MUST go through. */
  it('DOES dispatch when the same identifier is in the owner message', async () => {
    const dispatchTool = vi.fn(async (): Promise<ChatDispatchResult> => ({
      ok: true, result: { id: 'unit_777' },
    }));
    let call = 0;
    const executeAiCall = vi.fn(async () => ({
      body: call++ === 0
        ? outputWith({ building_id: 'building_88421', label: 'Flat 2' })
        : ({ response: 'ok', events: [], tool_calls: [] } as AIOutput),
    }));
    await runChatTurn({
      ...input,
      content: {
        chat_tail: [],
        user_message: 'add Flat 2 to building building_88421',
      },
    } as never, {
      registry, dispatchTool, executeAiCall, emit: () => {}, now: () => 0,
    } as never);
    expect(dispatchTool).toHaveBeenCalledTimes(1);
  });

  /** ⛔ THE REFUSAL HAS TO REACH THE MODEL, or it is just a silent drop and the
   *  turn ends having done nothing. It travels the loop's ordinary feedback
   *  path — the next round's `prior_tool_calls` — NOT `runChatTurn`'s return
   *  value, which is where the first cut of this test looked and why it failed.
   *  Asserting on the SECOND packet is asserting the thing that matters. */
  it('puts the refusal and the remedy into the next packet the model reads', async () => {
    const prompts: string[] = [];
    const dispatchTool = vi.fn(async (): Promise<ChatDispatchResult> => ({
      ok: true, result: {},
    }));
    let call = 0;
    // ⚠ `(manifest, raw)` — the packet is the SECOND argument. Reading the
    // first gave an empty string and made this test fail against a working
    // implementation.
    const executeAiCall = vi.fn(async (
      _manifest: unknown,
      raw: Record<string, unknown>,
    ) => {
      prompts.push(String(raw['llm.prompt'] ?? ''));
      return {
        body: call++ === 0
          ? outputWith({ building_id: '__first__' })
          : ({ response: 'ok', events: [], tool_calls: [] } as AIOutput),
      };
    });
    await runChatTurn(input as never, {
      registry, dispatchTool, executeAiCall, emit: () => {}, now: () => 0,
    } as never);
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[1]).toContain('building_id');
    // ⚠ `__first__` is a PLACEHOLDER, so the remedy that reaches the packet is
    // the dependency one, not the fetch-first one. The test's purpose is
    // unchanged — the refusal AND an actionable remedy must reach the model —
    // but a placeholder is the model declaring a gap, and telling it "do not
    // guess an identifier" answers a mistake it did not make. The other branch
    // is covered by the sibling case below, driven through the same loop.
    expect(prompts[1]).toMatch(/placeholder/i);
    expect(prompts[1]).toMatch(/wait for its result/i);
    expect(prompts[1]).not.toMatch(/do not guess an identifier/i);
  });

  it('puts the FETCH-FIRST remedy into the packet when the value was a guess', async () => {
    const prompts: string[] = [];
    const dispatchTool = vi.fn(async (): Promise<ChatDispatchResult> => ({
      ok: true, result: {},
    }));
    let call = 0;
    const executeAiCall = vi.fn(async (
      _manifest: unknown,
      raw: Record<string, unknown>,
    ) => {
      prompts.push(String(raw['llm.prompt'] ?? ''));
      return {
        body: call++ === 0
          // Identifier-shaped and absent from the packet ⇒ `ungrounded`, not a
          // placeholder: the model supplied a value rather than flagging a gap.
          ? outputWith({ building_id: 'bld_9f2c41aa' })
          : ({ response: 'ok', events: [], tool_calls: [] } as AIOutput),
      };
    });
    await runChatTurn(input as never, {
      registry, dispatchTool, executeAiCall, emit: () => {}, now: () => 0,
    } as never);
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[1]).toContain('bld_9f2c41aa');
    expect(prompts[1]).toMatch(/run the step that returns it first/i);
    expect(prompts[1]).not.toMatch(/same set of tool calls/i);
  });
});

/** ⛔⛔ THE REFUSAL IS ONLY HALF A GUARD IF THE MODEL CAN IGNORE IT FOR FREE.
 *  Measured on the bench: a user message saying "14 October 2026" had the model
 *  normalise it to `2026-10-14` and pass it to a tool; the gate refused it as
 *  "not in anything you have been given" and told it to "run the step that
 *  returns it first" — advice with no step to run, because the value came from
 *  the USER. The model re-emitted the byte-identical call every round: 15
 *  requests, zero dispatches, the turn dead at its timeout and the NEXT turn
 *  truncated to an empty answer. The loop cap bounds this, but ten rounds of a
 *  call that cannot succeed spends the whole turn budget. */
describe('an identical call, once refused, is not sent through the gate again', () => {
  /** Emits the SAME offending call `repeats` times, then answers. */
  const runRepeating = async (
    args: Record<string, unknown>,
    repeats: number,
    secondArgs?: Record<string, unknown>,
  ) => {
    const prompts: string[] = [];
    const dispatchTool = vi.fn(async (): Promise<ChatDispatchResult> => ({
      ok: true, result: {},
    }));
    let call = 0;
    const executeAiCall = vi.fn(async (
      _manifest: unknown,
      raw: Record<string, unknown>,
    ) => {
      prompts.push(String(raw['llm.prompt'] ?? ''));
      const n = call++;
      if (n < repeats) {
        return { body: outputWith(n === 1 && secondArgs ? secondArgs : args) };
      }
      return { body: { response: 'ok', events: [], tool_calls: [] } as AIOutput };
    });
    await runChatTurn(input as never, {
      registry, dispatchTool, executeAiCall, emit: () => {}, now: () => 0,
    } as never);
    return { prompts, dispatchTool };
  };

  it('answers the SECOND identical call differently, naming the repetition', async () => {
    const { prompts } = await runRepeating({ building_id: 'bld_9f2c41aa' }, 2);
    expect(prompts.length).toBeGreaterThan(2);
    // Round 1 gets the corrective advice.
    expect(prompts[1]).toMatch(/run the step that returns it first/i);
    // Round 2 must NOT RE-ISSUE it — the model already had that advice and
    // answered it by sending the same call, so restating it invites a third.
    // ⚠ ASSERT THE COUNT, NOT THE ABSENCE. `prior_tool_calls` ACCUMULATES, so
    // round 1's refusal is still in round 2's packet and always will be — a
    // bare `not.toMatch` fails against a correct implementation, which is how
    // this test first went red.
    expect(prompts[2]).toMatch(/already refused in this turn/i);
    expect(prompts[2]).toMatch(/cannot succeed/i);
    const advice = prompts[2].match(/run the step that returns it first/gi) ?? [];
    expect(advice).toHaveLength(1);
  });

  it('never dispatches the repeated call', async () => {
    const { dispatchTool } = await runRepeating({ building_id: 'bld_9f2c41aa' }, 3);
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  /** 🔑 THE GUARD MUST NOT BLOCK A MODEL THAT IS CORRECTING ITSELF. Only a
   *  byte-identical `(tool, args)` pair is short-circuited; change an argument
   *  and the call is evaluated fresh — which for a grounded value means it
   *  DISPATCHES. A guard that swallowed the corrected call would convert one
   *  wasted round into a permanently broken turn. */
  it('still evaluates a call whose arguments CHANGED, and dispatches it', async () => {
    const { dispatchTool } = await runRepeating(
      { building_id: 'bld_9f2c41aa' },
      2,
      // Present verbatim in the owner message ⇒ grounded ⇒ must dispatch.
      { building_id: 'buildings' },
    );
    expect(dispatchTool).toHaveBeenCalledTimes(1);
  });

  /** Key order is not identity. `{a,b}` and `{b,a}` are the same call, and a
   *  model that re-serialises its own arguments must not slip past the guard. */
  it('treats re-ordered arguments as the SAME call', async () => {
    const { prompts } = await runRepeating(
      { building_id: 'bld_9f2c41aa', note: 'x' },
      2,
      { note: 'x', building_id: 'bld_9f2c41aa' },
    );
    expect(prompts[2]).toMatch(/already refused in this turn/i);
  });
});
