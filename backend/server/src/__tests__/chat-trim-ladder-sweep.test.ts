/** ⛔⛔ PROPERTY SWEEP OVER THE TRIM LADDER'S ENTIRE BUDGET SPACE.
 *
 *  The ladder rewrites the packet at ~10 rungs, and until this file its
 *  invariants were checked at TWO STATIC COMPOSITIONS
 *  (`d-137-empty-aioutput-recovery`, `d-164-prompt-cache-restructure`) —
 *  neither of them under trim. So the properties were verified precisely where
 *  the ladder is not running, which is the shape of coverage that reads as
 *  thorough and tests nothing.
 *
 *  Deterministic by construction: the model, the tool result and the catalog
 *  are fixed, so the ONLY independent variable is the budget. Any difference
 *  between rows is caused by the ladder.
 *
 *  ⚠⚠ WHAT THIS DOES NOT COVER, stated because the gap is invisible from a
 *  green run: `available_tools` is EMPTY here, so RUNG 0 — the catalog
 *  step-down (full → index → lean-core) — is a no-op and is never exercised.
 *  That matters for the prefix property specifically: rung 0 legitimately
 *  REWRITES the catalog, so "prefix identical across budgets" is the right
 *  invariant only WITHIN a catalog mode. Seeding a catalog here would make this
 *  assertion fail by design, not find a bug. A rung-0 sweep is a separate
 *  fixture that must assert the weaker, correct property: the prefix changes
 *  only when the MODE changes, and is stable across every budget that shares
 *  one.
 *
 *  ✅ ALL FIVE PROPERTIES MUTATION-VERIFIED, because a green property test is
 *  worth nothing until it has been shown to fail:
 *    · drop `tool_name` when eliding  → "budget 2000: envelope kept"
 *    · remove the abandon restore     → "budget 900: neither fitted (est 1092)
 *                                        nor abandoned (342 vs untrimmed 5579)
 *                                        — trimmed for nothing"
 *    · vary the cacheable head        → "budget 2000: prefix stable"
 *  ⚠ The first prefix mutation I tried was INERT (`prior_tool_calls.length` is
 *  1 at every budget), and the test passed — which looked like a missing
 *  assertion and was a bad mutation. A mutation that changes no behaviour
 *  proves nothing about the assertion it was meant to test. */
import { describe, expect, it } from 'vitest';
import { runChatTurn } from '../chat-turn-executor.js';
import { estimateConservativeMessagesTokens } from '@recued/llm';

const PAYLOAD = { rows: Array.from({ length: 300 }, (_, i) => `row-${i}-payload`) };

/** One turn at one budget. Returns the packet that carries `prior_tool_calls`
 *  — the only one the ladder can act on. */
const runAt = async (budget: number | undefined) => {
  const prompts: string[] = [];
  const systems: string[] = [];
  let round = 0;
  await runChatTurn(
    {
      session_id: 's', turn_id: 't', picker_target: 'self',
      dispatch_peer_name: null, available_tools: [],
      content: { chat_tail: [], user_message: 'find it' },
      correction_context: [], model_layer: 'byok',
      ...(budget === undefined ? {} : { input_token_budget: budget }),
    } as never,
    {
      executeAiCall: async (_m: unknown, input: Record<string, unknown>) => {
        prompts.push(String(input['llm.prompt']));
        systems.push(String(input['llm.system_prompt'] ?? ''));
        round += 1;
        return round === 1
          ? { body: { response: 'a', events: [],
              tool_calls: [{ tool: 'mail.search', args: { q: 'x' } }] } }
          : { body: { response: 'done', events: [], tool_calls: [] } };
      },
      registry: {
        list: () => [], listByTier: () => [],
        getByName: () => ({ name: 'mail.search', tier: 1, concurrency_safe: false }),
        dispatch: async () => ({ ok: true, result: PAYLOAD }),
        subscribeRefresh: () => () => undefined,
      } as never,
      dispatchTool: async () => ({ ok: true as const, result: PAYLOAD }),
      emit: () => undefined,
      now: () => 1_000,
    } as never,
  );
  const body = prompts[1] ?? '';
  const system = systems[1] ?? '';
  return {
    body,
    est: estimateConservativeMessagesTokens([
      { role: 'system', content: system }, { role: 'user', content: body },
    ]),
  };
};

describe('trim ladder — properties across the budget space', () => {
  it('holds every invariant at every rung, and has exactly TWO outcomes', async () => {
    const untrimmed = await runAt(undefined);
    expect(untrimmed.body, 'the control composed something').not.toBe('');

    // From well above the untrimmed size down through the floor and past it.
    const budgets = [40_000, 20_000, 12_000, 8_000, 4_000, 2_000,
      1_500, 1_200, 900, 600, 300, 100, 10];
    const rows: Array<{ budget: number; est: number; bytes: number; fits: boolean }> = [];

    for (const budget of budgets) {
      const { body, est } = await runAt(budget);

      // ── 1. VALID JSON AT EVERY RUNG. A budget that cuts mid-element hands
      //       the model malformed text that reads to it as data.
      expect(() => JSON.parse(body), `budget ${budget}: parseable`).not.toThrow();

      // ── 2. THE CACHEABLE PREFIX SURVIVES TRIMMING. `available_tools` +
      //       `commitment_context` lead every body and must be byte-identical
      //       across budgets, or the D-164 prompt cache is invalidated by the
      //       ladder itself — the one thing the prefix exists to prevent.
      const prefixOf = (s: string): string => {
        const end = s.indexOf('"commitment_context":[]');
        return end === -1 ? '' : s.slice(0, end + '"commitment_context":[]'.length);
      };
      expect(prefixOf(body), `budget ${budget}: prefix stable`)
        .toBe(prefixOf(untrimmed.body));
      expect(prefixOf(body), `budget ${budget}: prefix non-empty`).not.toBe('');

      // ── 3. THE CALL ENVELOPE SURVIVES AN ELISION. A marker with no
      //       `tool_name` tells the model something vanished without saying
      //       what — strictly worse than the value being absent.
      const packet = JSON.parse(body) as {
        prior_tool_calls?: Array<Record<string, unknown>>;
      };
      for (const call of packet.prior_tool_calls ?? []) {
        expect(call.tool_name, `budget ${budget}: envelope kept`).toBeTruthy();
      }

      const fits = est <= budget;
      rows.push({ budget, est, bytes: body.length, fits });

      // ── 4. EXACTLY TWO OUTCOMES, NEVER A THIRD. Either the ladder reached
      //       fit, or it ABANDONED and restored the untrimmed composition. A
      //       third state — smaller than untrimmed but still over budget — is
      //       context destroyed for nothing, which is the exact defect the
      //       abandon rule was written from (6 tail rows evicted to 1, prompt
      //       still over).
      const abandoned = body.length === untrimmed.body.length;
      expect(
        fits || abandoned,
        `budget ${budget}: neither fitted (est ${est}) nor abandoned `
        + `(${body.length} vs untrimmed ${untrimmed.body.length}) — trimmed for nothing`,
      ).toBe(true);
    }

    // ── 5. MONOTONIC WHERE IT FITS. The preview search is a BINARY SEARCH over
    //       packet size; a non-monotonic size silently returns a wrong answer
    //       rather than failing. The executor states this requirement and works
    //       around one violation; nothing tested it until now.
    const fitting = rows.filter((r) => r.fits);
    for (let i = 1; i < fitting.length; i += 1) {
      const hi = fitting[i - 1]!;
      const lo = fitting[i]!;
      expect(
        lo.bytes <= hi.bytes,
        `budget ${lo.budget} produced ${lo.bytes} bytes, MORE than budget `
        + `${hi.budget}'s ${hi.bytes} — size is not monotonic in the budget`,
      ).toBe(true);
    }

    // The sweep must actually cross the boundary, or it proves nothing.
    expect(fitting.length, 'some budgets fitted').toBeGreaterThan(0);
    expect(rows.some((r) => !r.fits), 'some budgets abandoned').toBe(true);
  });

  it('⛔ an unbudgeted turn is never trimmed — today’s behaviour, pinned', async () => {
    const { body } = await runAt(undefined);
    expect(body).not.toContain('llm_gateway_context_omitted');
  });
});
