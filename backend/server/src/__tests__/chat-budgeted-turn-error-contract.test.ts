/** A budgeted CHAT turn must keep chat's error contract, not inherit the
 *  gateway's.
 *
 *  ⛔⛔ THE BUG THIS EXISTS TO PREVENT ALREADY ALMOST SHIPPED. The branch in
 *  `chat-turn-executor.ts` that decides between propagating a typed
 *  context/authority failure and converting it to an in-turn assistant message
 *  was gated on `inputs.input_token_budget !== undefined` — with the comment
 *  "keep normal chat's historical fail-in-turn behavior byte-for-byte by
 *  propagating only on the gateway-only budgeted path". That gate identified
 *  the gateway ONLY because the gateway was the sole supplier of a budget.
 *
 *  Wiring learned context bounds into chat made chat a second supplier, and the
 *  gate silently flipped: a context overflow in normal chat would have stopped
 *  producing an assistant message and started throwing at the caller. Nothing
 *  in the type system, and nothing in 23,000 existing tests, said a word — the
 *  proxy was correct right up until the fact it stood for stopped being true.
 *
 *  So the contract is stated (`propagate_typed_errors`) and pinned here, from
 *  BOTH sides: a budgeted turn without the flag must not throw, and the same
 *  turn with it must. */
import { describe, expect, it } from 'vitest';
import { runChatTurn } from '../chat-turn-executor.js';
import { LLMError, estimateConservativeMessagesTokens } from '@recued/llm';

const baseInput = {
  session_id: 'budgeted-chat',
  turn_id: 'budgeted-chat-turn',
  picker_target: 'self' as const,
  dispatch_peer_name: null,
  available_tools: [],
  content: { chat_tail: [], user_message: 'summarise everything' },
  correction_context: [] as string[],
  model_layer: 'byok' as const,
};

const overflows = async () => {
  throw new LLMError(
    'AI_TOKEN_BUDGET_EXCEEDED',
    'LLM input too large (400): context_length_exceeded',
  );
};

const deps = {
  executeAiCall: overflows,
  registry: undefined as never,
  dispatchTool: async () => ({ ok: true as const, result: {} }),
  emit: () => undefined,
  now: () => 1_000,
};

/** ⛔⛔ A TRIM THAT DOES NOT REACH FIT MUST BE ABANDONED WHOLE.
 *
 *  This is the defect that shipping learned bounds introduced, and it does NOT
 *  announce itself. Measured before the fix, on a 60-tool catalog against a
 *  24,512 budget (a 32,768-token endpoint): the ladder evicted the chat_tail
 *  from 6 rows to 1 and the prompt was STILL 27,940 — over budget, with the
 *  conversation destroyed for nothing. The turn then REPORTS SUCCESS, because
 *  the estimator is UTF-8 BYTES (roughly 4x a real tokenizer on ASCII) so the
 *  provider counted ~7,000 against a 32,768 window and accepted it happily.
 *  Every turn, silently, forever.
 *
 *  The catalog is why no rung can win here: it is ~60% of the packet and is
 *  structurally exempt (the D-164 cacheable prefix — `composePrompt` passes
 *  `inputs.available_tools` unchanged on all six recompositions), so the
 *  ladder's floor is "catalog + system prompt", not zero. */
describe('a trim that cannot reach fit is abandoned, not shipped', () => {
  const bigCatalog = Array.from({ length: 60 }, (_, i) => ({
    recipe_slug: `pack/recipe-${i}`,
    args_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'x'.repeat(300) } },
    },
  }));
  const sixRowTail = Array.from({ length: 6 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `conversation turn ${i}: ${'context '.repeat(60)}`,
  }));
  const unfittable = {
    ...baseInput,
    available_tools: bigCatalog,
    content: { chat_tail: sixRowTail, user_message: 'summarise everything' },
    // ⛔ DERIVED, NOT LITERAL. This has to be a budget the ladder genuinely
    //   cannot reach, and the only thing that guarantees that is the exempt
    //   floor itself: the catalog is passed through unchanged by every
    //   recomposition, so a budget under it is unreachable BY CONSTRUCTION,
    //   whatever the estimator's scale. The first version was `24_512`
    //   (32,768 - 8,000 output - 256 safety) and stopped being unreachable the
    //   moment the estimator's divisor was fixed.
    input_token_budget: Math.floor(
      estimateConservativeMessagesTokens([
        { role: 'user', content: JSON.stringify(bigCatalog) },
      ]) / 2,
    ),
  };
  const registry = {
    list: () => [],
    listByTier: () => [],
    getByName: () => null,
    dispatch: async () => ({ ok: true, result: { rows: 'z'.repeat(20_000) } }),
    subscribeRefresh: () => () => undefined,
  };

  it('⛔ CHAT keeps the whole conversation and the whole tool result', async () => {
    const packets: Array<Record<string, unknown>> = [];
    let round = 0;
    await runChatTurn(unfittable as never, {
      ...deps,
      registry: registry as never,
      executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
        packets.push(JSON.parse(String(input['llm.prompt'])) as Record<string, unknown>);
        round += 1;
        return round === 1
          ? { body: { response: '', events: [],
              tool_calls: [{ tool: 'pack/recipe-0', args: { query: 'invoices' } }] } }
          : { body: { response: 'done', events: [], tool_calls: [] } };
      },
      dispatchTool: async () => ({ ok: true, result: { rows: 'z'.repeat(20_000) } }),
    } as never);

    expect(packets).toHaveLength(2);
    for (const packet of packets) {
      // Before the fix this was 1. Nothing reported the other five.
      const rows = packet.chat_tail as Array<{ content: string }>;
      expect(rows.length).toBe(sixRowTail.length);
      // ⛔ And the model must not be TOLD context was dropped when none was —
      // the omission notice is prepended as an assistant row, so a stale
      // `omittedContext` would make the model hedge or re-fetch over nothing.
      expect(rows.some((r) => r.content.includes('omitted'))).toBe(false);
    }
    // And the tool result is whole, not a preview marker — dropping it is the
    // rung that MEASURES worst (2.6x, because the loop re-fetches what you
    // dropped), so paying it for a trim that does not fit is the worst trade
    // available.
    const priorCalls = packets[1]!.prior_tool_calls as Array<{ result: unknown }>;
    expect(priorCalls).toHaveLength(1);
    expect(JSON.stringify(priorCalls[0]!.result)).not.toContain('context_omitted');
  });

  it('⛔ the GATEWAY still fails truthfully — its window is DECLARED, not estimated', async () => {
    await expect(runChatTurn(
      { ...unfittable, propagate_typed_errors: true } as never,
      { ...deps, registry: registry as never,
        executeAiCall: async () => ({ body: { response: 'x', events: [], tool_calls: [] } }),
      } as never,
    )).rejects.toThrow();
  });
});

describe('the context-overflow retry', () => {
  /** ⛔⛔ THE WHOLE POINT IS THAT THE SECOND CALL IS DIFFERENT. Retrying a
   *  provider failure with the same request would be spending a call on the
   *  same outage — the policy this carves out of says so explicitly. What makes
   *  this case different is that the refusal IS the measurement: before it the
   *  endpoint's window was unknown and the prompt went out unbudgeted; after
   *  it, a real ceiling exists. So the test asserts the retry composes under a
   *  budget that DID NOT EXIST on the first attempt. */
  it('retries once under the budget the failure just taught, and TRIMS to it', async () => {
    // ⚠ ASSERTING THE RETRY HAPPENED IS NOT ENOUGH, and an earlier version of
    // this test made exactly that mistake: deleting the line that applies the
    // relearned budget left it green, because a stub `executeAiCall` succeeds
    // whatever it is handed. The retry is only worth anything if the SECOND
    // PROMPT IS SMALLER — so that is what is measured.
    const prompts: string[] = [];
    let round = 0;
    await runChatTurn(
      {
        ...baseInput,
        content: {
          chat_tail: Array.from({ length: 12 }, (_, i) => ({
            role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
            content: `turn ${i} ${'padding '.repeat(200)}`,
          })),
          user_message: 'summarise everything',
        },
      },
      {
        ...deps,
        executeAiCall: async (_manifest: unknown, input: Record<string, unknown>) => {
          prompts.push(String(input['llm.prompt']));
          round += 1;
          if (round === 1) {
            throw new LLMError(
              'AI_TOKEN_BUDGET_EXCEEDED',
              'LLM input too large (400): context_length_exceeded',
            );
          }
          return { body: { response: 'fitted', events: [], tool_calls: [] } };
        },
        // Nothing before the first call — the endpoint's window is unknown.
        // The refusal teaches it, so the retry has a ceiling to compose under.
        //
        // ⚠ REACHABLE ON PURPOSE, AND DERIVED FROM THE FIRST PROMPT rather
        // than guessed. An UNreachable budget is a different case entirely —
        // the trim is abandoned whole (see the describe above) — and this test
        // would then pass VACUOUSLY with two identical prompts. It was a
        // literal `12_000`, calibrated when the estimator returned one token
        // per UTF-8 byte; fixing the divisor made it larger than the whole
        // packet, so nothing needed trimming and the assertion below flipped.
        // Measuring what round 1 actually sent, and asking for less, keeps the
        // "reachable but binding" property true at any estimator scale.
        resolveInputTokenBudget: () => (round === 0
          ? undefined
          : Math.floor(estimateConservativeMessagesTokens([
              { role: 'user', content: prompts[0] ?? '' },
            ]) * 0.6)),
      } as never,
    );
    expect(round).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.length).toBeLessThan(prompts[0]!.length);
  });

  it('⛔ does NOT retry when the re-resolved budget is no smaller — no loop to cap', async () => {
    let round = 0;
    await runChatTurn(
      { ...baseInput, input_token_budget: 50_000 },
      {
        ...deps,
        executeAiCall: async () => {
          round += 1;
          throw new LLMError('AI_TOKEN_BUDGET_EXCEEDED', 'too large');
        },
        resolveInputTokenBudget: () => 50_000,
      } as never,
    );
    expect(round).toBe(1);
  });

  it('⛔ does NOT retry a NON-context failure — that would be the same outage twice', async () => {
    let round = 0;
    await runChatTurn(
      { ...baseInput },
      {
        ...deps,
        executeAiCall: async () => {
          round += 1;
          throw new LLMError('AI_LLM_UNAVAILABLE', 'LLM server error (503)', {}, true);
        },
        resolveInputTokenBudget: () => 10_000,
      } as never,
    );
    expect(round).toBe(1);
  });
});

/** ⛔⛔ A SIZE REFUSAL MUST SAY SOMETHING THE OWNER CAN ACT ON.
 *
 *  The abandon-the-trim rule means chat sends the untrimmed prompt and lets the
 *  provider judge. When the provider DOES refuse, the turn fails in-turn — and
 *  before this, `assistantContent` stayed EMPTY: the swap-in is gated on
 *  `NO_LLM_SOURCE_DETAIL_RE`, which `AI_TOKEN_BUDGET_EXCEEDED` does not match,
 *  so it fell into the generic `provider_failure` bucket and the user read a
 *  blank assistant turn. It then repeats on EVERY subsequent message, because
 *  nothing about the situation changes on its own. */
describe('a size refusal is actionable, not a blank turn', () => {
  const overflowDeps = {
    ...deps,
    executeAiCall: async () => {
      throw new LLMError(
        'AI_TOKEN_BUDGET_EXCEEDED',
        'LLM input too large (400): context_length_exceeded',
      );
    },
  };

  it('names a lever that exists in Settings → AI / Models', async () => {
    const result = await runChatTurn(baseInput as never, overflowDeps as never);
    const text = JSON.stringify(result);
    expect(text).toContain('Settings → AI / Models');
    // Verified present on that page — a message naming a control the owner
    // cannot find is worse than no message.
    expect(text).toContain('context window');
  });

  it('⛔ does NOT tell the owner to thin the catalog — rung 0 already did', async () => {
    // `fitCatalogModeToBudget` steps full → index → lean-core before the turn
    // starts whenever the catalog alone would not fit, so by the time this
    // message is reachable the advice would be stale. Advising a change the
    // system already made teaches the owner nothing about why it failed.
    const result = await runChatTurn(baseInput as never, overflowDeps as never);
    const text = JSON.stringify(result);
    expect(text).not.toContain('Index (lean list)');
    expect(text).not.toContain('Lean core (search)');
  });

  it('⛔ does NOT suggest a shorter message — the catalog is what is large', async () => {
    const result = await runChatTurn(baseInput as never, overflowDeps as never);
    const text = JSON.stringify(result).toLowerCase();
    expect(text).not.toContain('shorter');
    expect(text).not.toContain('new conversation');
  });

  it('a NON-size provider failure keeps the historical empty turn', async () => {
    const result = await runChatTurn(baseInput as never, {
      ...deps,
      executeAiCall: async () => {
        throw new LLMError('AI_TIMEOUT', 'Request timed out after 60000ms');
      },
    } as never);
    expect(JSON.stringify(result)).not.toContain('Settings → AI / Models');
  });
});

describe('a budgeted chat turn keeps chat’s error contract', () => {
  it('⛔ FAILS IN-TURN on a context overflow — it does not throw at the caller', async () => {
    // The budget is present (chat now supplies one from learned bounds) and the
    // flag is not. Chat's user gets an assistant message, as it always has.
    const result = await runChatTurn(
      { ...baseInput, input_token_budget: 100_000 },
      deps as never,
    );
    expect(result).toBeDefined();
  });

  it('⛔ the GATEWAY, which asks for typed errors, still gets them thrown', async () => {
    await expect(runChatTurn(
      { ...baseInput, input_token_budget: 100_000, propagate_typed_errors: true },
      deps as never,
    )).rejects.toThrow();
  });

  it('an UNBUDGETED turn is unchanged — the historical path', async () => {
    const result = await runChatTurn(baseInput, deps as never);
    expect(result).toBeDefined();
  });
});

/** ⛔⛔ THE BRANCH, NOT THE PREDICATE. `isNonTerminalToolResult` and
 *  `planRunSettledRow` are unit-tested; the LOOP that decides what each
 *  dispatch contributes is not, and a mutation refolding held-ness back into
 *  pairability compiles and leaves those green. This drives the real tool loop
 *  and reads what it emitted. */
describe('what a dispatch contributes to the durable rows', () => {
  const registry = {
    list: () => [], listByTier: () => [], getByName: () => null,
    dispatch: async () => ({ ok: true as const, result: {} }),
    subscribeRefresh: () => () => undefined,
  } as never;

  const driveWith = async (dispatchResult: unknown) => {
    let round = 0;
    return runChatTurn({ ...baseInput } as never, {
      ...deps,
      registry,
      executeAiCall: async () => {
        round += 1;
        return round === 1
          ? { body: { response: '', events: [],
              tool_calls: [{ tool: 'acme/send', args: { q: 'x' } }] } }
          : { body: { response: 'done', events: [], tool_calls: [] } };
      },
      dispatchTool: async () => dispatchResult,
    } as never) as Promise<{
      tool_results?: ReadonlyArray<Record<string, unknown>>;
    }>;
  };

  it('⛔ a HELD dispatch contributes the ASK ONLY — never the "queued" text', async () => {
    const out = await driveWith({
      ok: true,
      result: { status: 'awaiting_approval', awaiting_approval: true },
      run_held: { kind: 'approval' },
      run_id: 'run-55',
    });
    const rows = out.tool_results ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pair_id: 'run-55' });
    // The row that would answer this does not exist yet, so it must carry no
    // result at all. Storing the acknowledgement makes recall return "queued"
    // as the answer to whatever was asked.
    expect('result' in rows[0]!).toBe(false);
  });

  it('⛔⛔ a HELD dispatch with NO run id still contributes no result', async () => {
    // Held-ness and pairability are separate questions. Folding them meant an
    // unpairable hold fell into the result branch and stored the projection.
    const out = await driveWith({
      ok: true,
      result: { status: 'awaiting_approval', awaiting_approval: true },
      run_held: { kind: 'approval' },
    });
    const rows = out.tool_results ?? [];
    expect(rows).toHaveLength(1);
    expect('result' in rows[0]!).toBe(false);
    // Unpairable: it earns its ask row but can never be joined to an answer.
    expect('pair_id' in rows[0]!).toBe(false);
  });

  it('a TERMINAL dispatch contributes the result and no pair', async () => {
    const out = await driveWith({ ok: true, result: { matches: ['a'] } });
    const rows = out.tool_results ?? [];
    expect(rows).toHaveLength(1);
    expect('result' in rows[0]!).toBe(true);
    expect('pair_id' in rows[0]!).toBe(false);
  });
});
