/** ⛔ THE FAILURE FENCED AGAINST is not "chat is unbudgeted". It is chat being
 *  budgeted WRONGLY — a ceiling learned from one endpoint applied to a turn
 *  another endpoint serves, or a budget below a size already known to fit.
 *  Either trims context silently, in the direction that loses it. So the tests
 *  that matter are the ones about NOT producing a budget. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  noteContextAccepted,
  noteContextRefused,
  resetEndpointCapabilities,
  type LLMConfig,
} from '@recued/llm';
import {
  fitCatalogModeToBudget,
  resolveChatInputTokenBudget,
} from '../chat-context-budget.js';

const byokSlot = (base_url: string) => ({
  provider: 'openai-compatible' as const,
  model: 'm',
  api_key: 'k',
  base_url,
});

const config = (): LLMConfig => ({
  slot_1: byokSlot('http://slot1.test'),
  slot_2: byokSlot('http://slot2.test'),
  free_pool: [{
    id: 'pool-a',
    type: 'api',
    provider: 'openai-compatible',
    model: 'free-m',
    api_key: 'fk',
    base_url: 'http://pool.test',
  }],
} as unknown as LLMConfig);

/** Learn a ceiling the way a real overflow does — through the same note the
 *  executor's seam calls, against a slot built the way routing builds it. */
const learnCeiling = (base_url: string, tokens: number) =>
  noteContextRefused(byokSlot(base_url), tokens);

describe('resolveChatInputTokenBudget', () => {
  beforeEach(() => { resetEndpointCapabilities(); });

  it('⛔ NOTHING LEARNED ⇒ NO BUDGET ⇒ today’s behaviour, byte-identical', () => {
    expect(resolveChatInputTokenBudget(config(), { layer: 'byok' })).toBeUndefined();
    expect(resolveChatInputTokenBudget(undefined, { layer: 'byok' })).toBeUndefined();
  });

  it('⛔ A FLOOR ALONE IS NOT A CEILING — what fit says nothing about what does not', () => {
    noteContextAccepted(byokSlot('http://slot1.test'), 113_616);
    noteContextAccepted(byokSlot('http://slot2.test'), 113_616);
    expect(resolveChatInputTokenBudget(config(), { layer: 'byok' })).toBeUndefined();
  });

  it('a learned ceiling produces a budget under it, with output reserved', () => {
    learnCeiling('http://slot1.test', 128_000);
    learnCeiling('http://slot2.test', 128_000);
    const got = resolveChatInputTokenBudget(config(), { layer: 'byok', hint: 'quality' });
    expect(got).toBeDefined();
    expect(got!).toBeLessThan(128_000);
    // 8000 for quality + the shared safety margin.
    expect(got!).toBeLessThanOrEqual(128_000 - 8_000);
  });

  it('⛔⛔ takes the MINIMUM across candidates, because routing draws at random', () => {
    learnCeiling('http://slot1.test', 128_000);
    learnCeiling('http://slot2.test', 32_000);
    const got = resolveChatInputTokenBudget(config(), { layer: 'byok', hint: 'quality' });
    expect(got!).toBeLessThan(32_000);
  });

  it('⚠ ONE unlearned candidate does not veto the bound, but IS the residual risk', () => {
    // slot_2 is unknown; the budget still comes from slot_1. Documented as a
    // bound rather than a guarantee — if slot_2 wins the draw and is smaller,
    // it overflows and teaches its own ceiling.
    learnCeiling('http://slot1.test', 128_000);
    expect(resolveChatInputTokenBudget(config(), { layer: 'byok' })).toBeDefined();
  });

  it('⛔ NEVER trims below an input a candidate has already ACCEPTED', () => {
    learnCeiling('http://slot1.test', 100_000);
    learnCeiling('http://slot2.test', 100_000);
    noteContextAccepted(byokSlot('http://slot1.test'), 99_000);
    // 100,000 - 8,000 output - safety < 99,000, so the proven floor wins.
    expect(resolveChatInputTokenBudget(config(), { layer: 'byok', hint: 'quality' }))
      .toBe(99_000);
  });

  describe('the candidate set matches what routing can actually reach', () => {
    it('⛔ a byok turn is NOT bounded by a free-pool endpoint’s ceiling', () => {
      // The pool cannot serve a `byok` turn, so its window must not shrink this
      // prompt. Getting this wrong is invisible: the turn just silently carries
      // less.
      //
      // ⚠ 40,000 IS LOAD-BEARING AND WAS ORIGINALLY 4,096, WHICH MADE THIS
      // TEST VACUOUS. At 4,096 the budget arithmetic underflows the 8,000
      // output reserve and returns undefined ANYWAY, so the assertion passed
      // whether or not the layer was respected — mutating `forceLayer` to
      // 'any' left all 11 tests green. The fixture has to be a window that
      // WOULD produce a budget if it were wrongly admitted.
      noteContextRefused({
        provider: 'openai-compatible', model: 'free-m', api_key: 'fk',
        base_url: 'http://pool.test',
      }, 40_000);
      expect(resolveChatInputTokenBudget(config(), { layer: 'byok' })).toBeUndefined();
    });

    it('a free_pool turn IS bounded by the pool endpoint, and not by the slots', () => {
      noteContextRefused({
        provider: 'openai-compatible', model: 'free-m', api_key: 'fk',
        base_url: 'http://pool.test',
      }, 16_000);
      learnCeiling('http://slot1.test', 128_000);
      const got = resolveChatInputTokenBudget(config(), { layer: 'free_pool', hint: 'fast' });
      expect(got!).toBeLessThan(16_000);
    });

    it('⛔ a PINNED slot is bounded by that slot alone', () => {
      learnCeiling('http://slot1.test', 128_000);
      learnCeiling('http://slot2.test', 16_000);
      const pinned = resolveChatInputTokenBudget(
        config(), { layer: 'byok', hint: 'quality', source_id: 'slot_1' });
      // Without the pin the 16,000 ceiling would dominate; with it, slot_1's
      // 128,000 is the only candidate.
      expect(pinned!).toBeGreaterThan(100_000);
    });

    it('⚠ a pin under free_pool is DROPPED, exactly as the executor drops it', () => {
      noteContextRefused({
        provider: 'openai-compatible', model: 'free-m', api_key: 'fk',
        base_url: 'http://pool.test',
      }, 16_000);
      learnCeiling('http://slot1.test', 128_000);
      const got = resolveChatInputTokenBudget(
        config(), { layer: 'free_pool', hint: 'fast', source_id: 'slot_1' });
      expect(got!).toBeLessThan(16_000);
    });
  });

  it('a ceiling with no room left yields no budget rather than a nonsense one', () => {
    learnCeiling('http://slot1.test', 2_000);
    learnCeiling('http://slot2.test', 2_000);
    expect(resolveChatInputTokenBudget(config(), { layer: 'byok', hint: 'quality' }))
      .toBeUndefined();
  });
});

/** ⛔⛔ RUNG 0. Every other rung runs BELOW the catalog — `composePrompt()`
 *  passes `available_tools` through unchanged on all six recompositions,
 *  because it is the D-164 cacheable prefix — so when the catalog alone
 *  exceeds the budget the ladder evicts the whole conversation, drops every
 *  tool result, and still cannot fit. Measured at 6 tail rows down to 1 with
 *  the prompt still over budget. This is the only lever that reaches it. */
describe('fitCatalogModeToBudget', () => {
  // A realistic shape: each step down is materially cheaper.
  const COST: Record<string, number> = {
    full: 9_688, index: 2_400, 'lean-core': 400,
  };
  const measure = (calls: string[] = []) => (mode: string) => {
    calls.push(mode);
    return COST[mode]!;
  };

  it('⛔ NO BUDGET ⇒ no measurement at all ⇒ today’s behaviour', () => {
    const calls: string[] = [];
    expect(fitCatalogModeToBudget({
      mode: 'full', inputTokenBudget: undefined, measureCatalogTokens: measure(calls),
    })).toBe('full');
    // The measurement builds a catalog. On the overwhelmingly common path —
    // an endpoint that has never refused anything — it must not run.
    expect(calls).toEqual([]);
  });

  it('keeps the requested mode when its catalog fits', () => {
    expect(fitCatalogModeToBudget({
      mode: 'full', inputTokenBudget: 24_512, measureCatalogTokens: measure(),
    })).toBe('full');
  });

  it('steps down only as far as it must', () => {
    // 9,688 does not fit under 5,000; 2,400 does. `lean-core` is not reached.
    const calls: string[] = [];
    expect(fitCatalogModeToBudget({
      mode: 'full', inputTokenBudget: 5_000, measureCatalogTokens: measure(calls),
    })).toBe('index');
    expect(calls).toEqual(['full', 'index']);
  });

  it('⛔ never steps UP past the owner’s choice', () => {
    // An owner on `index` with a huge budget stays on `index`. Widening a
    // deliberately-thinned catalog is not this function's business.
    expect(fitCatalogModeToBudget({
      mode: 'index', inputTokenBudget: 1_000_000, measureCatalogTokens: measure(),
    })).toBe('index');
  });

  it('lands on the leanest mode when nothing fits, rather than giving up', () => {
    // The turn is tight either way; handing the lower rungs the smallest
    // catalog gives them the most room. What to do if even this is over is
    // `chat-turn-executor.ts`'s decision, not this one's.
    expect(fitCatalogModeToBudget({
      mode: 'full', inputTokenBudget: 100, measureCatalogTokens: measure(),
    })).toBe('lean-core');
  });
});
