/** ⛔⛔ THE TAIL-EVICTION RUNG, SWEPT — the rung the other two sweeps skip.
 *
 *  `chat-trim-ladder-sweep` and `chat-catalog-rung0-sweep` both pass
 *  `chat_tail: []`, deliberately: one isolates the tool-result rungs, the other
 *  isolates the catalog. So eviction — the rung that drops the CONVERSATION —
 *  had no property coverage at all, and it is the one with the sharpest
 *  consequence.
 *
 *  🔑 A LIVE DRIVE SHOWED WHY IT MATTERS. At a 22k budget on an accumulating
 *  task the model carried its own running totals correctly across an active
 *  trim (689, then 1443 — both right), and then the eviction rung fired: the
 *  tail went from 3 rows to 1, the surviving row being the omission NOTICE, and
 *  with it went the model's own prior answers. It then reported "I don't have
 *  access to any data source or tool that contains information about rings
 *  09-12. I searched for relevant tools but found nothing" — while the catalog
 *  was intact and `work.search` was present in all ten packets. It
 *  MISATTRIBUTED A CONTEXT LOSS TO MISSING INFRASTRUCTURE, in a sentence that
 *  would send an owner to check their data sources.
 *
 *  ⚠ These properties pin the rung's SHAPE. They deliberately do not assert
 *  that the notice is uninformative — that is the defect a briefing would fix,
 *  and characterising it here (rather than asserting it as correct) is what
 *  makes such a change show up as a test edit instead of slipping through. */
import { describe, expect, it } from 'vitest';
import { runChatTurn } from '../chat-turn-executor.js';
import { estimateConservativeMessagesTokens } from '@recued/llm';
import {
  BRIEFING_MAX_CHARS,
  CONTEXT_OMISSION_NOTICE as NOTICE_FULL,
} from '../chat-eviction-briefing.js';

const NOTICE = '[llm_gateway context notice]';

/** A conversation of `pairs` complete user/assistant groups, oldest first. */
const tailOf = (pairs: number) =>
  Array.from({ length: pairs }, (_, i) => [
    { role: 'user' as const, content: `question ${i} ${'q'.repeat(400)}` },
    { role: 'assistant' as const, content: `answer ${i} ${'a'.repeat(400)}` },
  ]).flat();

/** One turn at one budget. No tools at all, so the ONLY thing the ladder can
 *  shed is the tail — which is what isolates this rung. */
const runAt = async (
  budget: number | undefined,
  pairs: number,
  opts: { providerCompacts?: boolean } = {},
) => {
  const prompts: string[] = [];
  const systems: string[] = [];
  await runChatTurn(
    {
      session_id: 's', turn_id: 't', picker_target: 'self',
      dispatch_peer_name: null, available_tools: [],
      content: { chat_tail: tailOf(pairs), user_message: 'THE-CURRENT-ASK' },
      correction_context: [], model_layer: 'byok',
      ...(opts.providerCompacts === true ? { provider_compacts_context: true } : {}),
      ...(budget === undefined ? {} : { input_token_budget: budget }),
    } as never,
    {
      executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
        prompts.push(String(input['llm.prompt']));
        systems.push(String(input['llm.system_prompt'] ?? ''));
        return { body: { response: 'done', events: [], tool_calls: [] } };
      },
      registry: {
        list: () => [], listByTier: () => [],
        getByName: () => null,
        dispatch: async () => ({ ok: true, result: {} }),
        subscribeRefresh: () => () => undefined,
      } as never,
      dispatchTool: async () => ({ ok: true as const, result: {} }),
      emit: () => undefined,
      now: () => 1_000,
    } as never,
  );
  const body = prompts[0] ?? '';
  const packet = JSON.parse(body) as {
    chat_tail: Array<{ role: string; content: string }>;
    user_message: string;
  };
  return {
    body,
    tail: packet.chat_tail,
    userMessage: packet.user_message,
    est: estimateConservativeMessagesTokens([
      { role: 'system', content: systems[0] ?? '' },
      { role: 'user', content: body },
    ]),
  };
};

describe('tail eviction', () => {
  it('holds its shape at every budget', async () => {
    const PAIRS = 6;
    const untrimmed = await runAt(undefined, PAIRS);
    expect(untrimmed.tail, 'the control keeps every row')
      .toHaveLength(PAIRS * 2);

    const budgets = [40_000, 4_000, 2_000, 1_500, 1_200, 1_000, 800, 600, 400];
    // ⛔ CLASSIFY EACH ROW BEFORE ASSERTING ANYTHING ABOUT IT. Below the floor
    //   the ladder cannot reach fit and ABANDONS, restoring the untrimmed
    //   composition — so a SMALLER budget legitimately yields MORE rows. A
    //   monotonicity claim that ignores that reports the abandon rule as a bug;
    //   my first cut did exactly that ("budget 1000 kept 12 rows, more than
    //   budget 1200's 0").
    const survivors: Array<{ budget: number; rows: number; fits: boolean }> = [];

    for (const budget of budgets) {
      const { tail, userMessage, body, est } = await runAt(budget, PAIRS);
      const fits = est <= budget;
      const evicted = tail.some((r) => r.content.startsWith(NOTICE));
      const real = tail.filter((r) => !r.content.startsWith(NOTICE));

      // Properties below hold for a composition the ladder ACTUALLY produced.
      // An abandoned one is the untrimmed packet by definition and says
      // nothing about eviction.
      if (!fits) {
        expect(body, `budget ${budget}: abandoned ⇒ untrimmed`)
          .toBe(untrimmed.body);
        survivors.push({ budget, rows: untrimmed.tail.length, fits });
        continue;
      }

      // ── 1. THE CURRENT ASK IS NEVER EVICTED. It lives in `user_message`, not
      //       the tail — a turn that drops the question it is answering is not
      //       a smaller turn, it is a different one.
      expect(userMessage, `budget ${budget}: current ask survives`)
        .toBe('THE-CURRENT-ASK');

      // ── 2. OLDEST-FIRST. Whatever survives is a SUFFIX of the original
      //       conversation — eviction takes from the front, never the middle,
      //       or the model reads a discontinuous history as a continuous one.
      const originalSuffix = untrimmed.tail.slice(untrimmed.tail.length - real.length);
      expect(real, `budget ${budget}: survivors are the newest rows`)
        .toEqual(originalSuffix);

      // ── 3. WHOLE GROUPS. What remains starts at a `user` row. A dangling
      //       assistant answer whose question was evicted reads as an
      //       unprompted assertion, which is worse than omitting both.
      if (real.length > 0) {
        expect(real[0]!.role, `budget ${budget}: survivors start at a question`)
          .toBe('user');
      }

      // ── 4. THE NOTICE APPEARS EXACTLY WHEN SOMETHING WENT. Not before (it
      //       would be a lie) and not omitted after (silent loss is the whole
      //       failure mode this rung has).
      expect(evicted, `budget ${budget}: notice iff rows were dropped`)
        .toBe(real.length < untrimmed.tail.length);

      // ── 5. Valid JSON at every rung, as everywhere else in the ladder.
      expect(() => JSON.parse(body), `budget ${budget}: parseable`).not.toThrow();

      survivors.push({ budget, rows: real.length, fits });
    }

    // ── 6. MONOTONE WHERE IT FITS: a smaller budget never keeps MORE
    //       conversation. Compared only among fitted rows, for the reason above.
    const fitted = survivors.filter((r) => r.fits);
    for (let i = 1; i < fitted.length; i += 1) {
      expect(
        fitted[i]!.rows <= fitted[i - 1]!.rows,
        `budget ${fitted[i]!.budget} kept ${fitted[i]!.rows} rows, more than `
        + `budget ${fitted[i - 1]!.budget}'s ${fitted[i - 1]!.rows}`,
      ).toBe(true);
    }

    // Vacuity guards: the sweep must span intact → evicted, and must contain a
    // row that evicted AND fitted, or nothing above was exercised.
    expect(fitted[0]!.rows, 'a generous budget keeps everything').toBe(PAIRS * 2);
    expect(
      fitted.some((r) => r.rows < PAIRS * 2),
      'no budget both evicted and fitted — the sweep never entered the rung',
    ).toBe(true);
  });

  it('⛔ the briefing NAMES what went, and says what the absence means', async () => {
    // This replaces a characterisation of the old bare notice. That notice said
    // THAT context went and never WHAT, and a live drive showed the cost: the
    // model lost its own prior answers and reported "I don't have access to any
    // data source or tool that contains information about rings 09-12" while
    // the catalog was intact. Naming the loss is half the fix; saying what the
    // absence MEANS is the other half.
    const { tail } = await runAt(2_000, 6);
    const notice = tail.find((r) => r.content.startsWith(NOTICE));
    expect(notice, 'a briefing was emitted').toBeDefined();
    const text = notice!.content;

    expect(text, 'still opens with the shipped notice').toContain(NOTICE);
    expect(text, 'names what was omitted').toMatch(/you were asked|you answered/);
    expect(text, 'quotes the evicted turn rather than paraphrasing it')
      .toMatch(/question \d/);
    expect(text, 'says what the absence MEANS — the misattribution guard')
      .toContain('not missing data');

    // ⛔ AND IT STAYS BOUNDED. The briefing is the entire tail at the floor, so
    //   an unbounded one raises the ladder's irreducible floor and turns an
    //   evict-and-fit into an ABANDON — measured: budget 1200 evicted and fitted
    //   with the bare notice and abandons with an uncapped briefing.
    expect(
      text.length - NOTICE_FULL.length,
      `briefing added ${text.length - NOTICE_FULL.length} chars over the notice`,
    ).toBeLessThanOrEqual(BRIEFING_MAX_CHARS);
  });

  it('⛔ defers to the provider when the endpoint compacts its own context', async () => {
    // Summarising here would be a second, worse copy of a job already being
    // done, paid for in the input room the provider is about to reclaim.
    const { tail } = await runAt(2_000, 6, { providerCompacts: true });
    const notice = tail.find((r) => r.content.startsWith(NOTICE));
    expect(notice, 'something was still omitted').toBeDefined();
    expect(notice!.content, 'bare notice, no briefing')
      .toBe(NOTICE_FULL);
  });

});

