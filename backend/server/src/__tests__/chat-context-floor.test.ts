/** ⛔⛔ THE FLOOR: THE SMALLEST CONTEXT WINDOW A RECUED SERVER CAN SERVE.
 *
 *  Below the floor the trim ladder is not degraded, it is DECORATIVE. Every
 *  rung in `chat-turn-executor` works BELOW the catalog — the catalog is the
 *  D-164 cacheable prefix and `composePrompt` passes it through unchanged on
 *  all six recompositions — so when catalog + system prompt alone exceed the
 *  budget, the search walks to `previewChars: 0`, still does not fit,
 *  ABANDONS, and the oversized prompt goes out anyway. Silently: the turn
 *  reports success and the provider either accepts it or rejects it on the
 *  wire. `chat-context-budget.ts` records a 113,616-token request that "went
 *  out and was accepted".
 *
 *  🔑 SO THE FLOOR IS A PRODUCT FACT, NOT A MICRO-BENCHMARK: it decides which
 *  endpoints a server can actually serve. And it DRIFTS — it is dominated by
 *  the catalog, which grows every time the owner installs a pack. Nobody would
 *  notice that happening.
 *
 *  This measures it as a FUNCTION of catalog size (fixed overhead + per-tool
 *  cost), because the absolute number is install-dependent and the shape is
 *  not. The ratchets below are deliberately loose — they exist to catch a
 *  step change in cost, not to freeze a number. */
import { describe, expect, it } from 'vitest';
import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';
import { DEFAULT_CHAT_SYSTEM_PROMPT } from '../llm-system-prompt.js';
import {
  estimateConservativeMessagesTokens,
  computeContextInputTokenBudget,
} from '@recued/llm';
import { TIER1_TOOL_DESCRIPTORS, TIER1_TOOL_NAMES } from '@recued/contracts';

/** A catalog entry at its LEANEST — slug only. That is roughly what
 *  `lean-core` delivers, so it measures the floor's floor. */
const leanTool = (i: number) => ({ recipe_slug: `publisher/recipe-${i}` });

/** ⛔ AND A REAL ONE, BECAUSE THE LEAN NUMBER IS NOT THE PRODUCT FACT. A bare
 *  slug costs ~19 tokens; a SHIPPED Tier-1 descriptor carries a description
 *  written for the model — `memory.search`'s alone runs past 1,500 characters —
 *  and an arg schema. Measuring only the lean shape reports a floor no real
 *  install has, which is how a ratchet ends up guarding a number nobody meets.
 *  These are the actual descriptors, cycled, so the cost is the shipped cost. */
const REAL_TIER1_CATALOG = TIER1_TOOL_NAMES.map((name) => {
  const d = TIER1_TOOL_DESCRIPTORS[name];
  return { recipe_slug: name, description: d.description, args_schema: d.arg_schema };
});

/** Estimator tokens for a turn carrying `count` tools and nothing else — no
 *  tail, no tool results, the shortest possible user message. */
const floorAt = (
  count: number,
  shape: (i: number) => unknown = leanTool,
): number => {
  const parts = composeChatMainTurnPromptParts({
    available_tools: Array.from({ length: count }, (_, i) => shape(i)),
    content: { chat_tail: [], user_message: 'hi' },
  } as never);
  return estimateConservativeMessagesTokens([
    { role: 'system', content: DEFAULT_CHAT_SYSTEM_PROMPT },
    { role: 'user', content: parts.body },
  ]);
};

/** What a window must be to leave ANY room, given the reserve the router takes.
 *  `computeContextInputTokenBudget(window, reserve)` is what production uses. */
const minimumWindowFor = (floor: number, reserve: number): number => {
  for (let window = floor; window < 1_000_000; window += 256) {
    const budget = computeContextInputTokenBudget(window, reserve);
    if (budget !== null && budget > floor) return window;
  }
  return Number.POSITIVE_INFINITY;
};

describe('context floor', () => {
  it('reports the floor, and what rung 0 buys', () => {
    const empty = floorAt(0);
    const lean60 = floorAt(60);
    const leanPerTool = (lean60 - empty) / 60;

    // The REAL catalog, every shipped Tier-1 tool at full fidelity.
    const fullParts = composeChatMainTurnPromptParts({
      available_tools: REAL_TIER1_CATALOG,
      content: { chat_tail: [], user_message: 'hi' },
    } as never);
    const full = estimateConservativeMessagesTokens([
      { role: 'system', content: DEFAULT_CHAT_SYSTEM_PROMPT },
      { role: 'user', content: fullParts.body },
    ]);
    const richPerTool = (full - empty) / REAL_TIER1_CATALOG.length;
    const leanEquivalent = floorAt(REAL_TIER1_CATALOG.length);

    // The NUMBER is the deliverable; a ratchet that never shows its value
    // teaches nobody what it guards.
    console.log(
      `[floor] fixed ${empty} tok (system prompt + envelope)\n`
      + `[floor] FULL  ${REAL_TIER1_CATALOG.length} shipped Tier-1 tools = ${full} tok`
      + ` (~${richPerTool.toFixed(0)}/tool — the DESCRIPTION dominates)\n`
      + `[floor] LEAN  same count, slug only = ${leanEquivalent} tok`
      + ` (~${leanPerTool.toFixed(1)}/tool)\n`
      + `[floor] minimum window — FULL: fast ${minimumWindowFor(full, 4_000)}`
      + ` / quality ${minimumWindowFor(full, 8_000)}`
      + ` · LEAN: fast ${minimumWindowFor(leanEquivalent, 4_000)}`
      + ` / quality ${minimumWindowFor(leanEquivalent, 8_000)}`,
    );

    expect(empty, 'a catalog-free turn still costs the system prompt').toBeGreaterThan(0);
    expect(richPerTool, 'a described tool costs far more than a bare slug')
      .toBeGreaterThan(leanPerTool * 10);

    // ── Ratchets, CALIBRATED against the measured values rather than picked ──
    // ⛔ The first cut used 6,000 / 20 and I checked them by mutation: a SIX-FOLD
    //   system prompt still passed, because 6 x ~900 lands under 6,000. A
    //   ratchet nobody has watched fail is decoration — it reads as a guard and
    //   guards nothing. These are set at roughly 2x the measured value: loose
    //   enough that ordinary edits do not trip them, tight enough that a step
    //   change does. Both are mutation-verified.
    expect(empty, `fixed overhead ${empty} (was 962) — did the system prompt grow?`)
      .toBeLessThan(2_000);
    expect(leanPerTool, `lean per-tool ${leanPerTool.toFixed(1)} (was 18.9) — still lean?`)
      .toBeLessThan(30);

    // ── THE PRODUCT FACT, and the reason rung 0 exists ──
    // At FULL fidelity the shipped catalog alone needs a large endpoint. At
    // LEAN it fits almost anything. Rung 0 is not an optimisation — it is what
    // makes a small endpoint servable at all, and this pins both ends.
    expect(
      minimumWindowFor(full, 8_000),
      `the FULL catalog needs ${minimumWindowFor(full, 8_000)} — a 32k endpoint `
      + 'can no longer serve it even before the conversation',
    ).toBeLessThanOrEqual(32_768);
    expect(
      minimumWindowFor(leanEquivalent, 8_000),
      'the LEAN catalog must fit a 16k endpoint, or rung 0 buys nothing',
    ).toBeLessThanOrEqual(16_384);
  });

  it('⛔ grows LINEARLY in the catalog, so the floor is predictable', () => {
    // Measured on the LEAN shape deliberately: the real descriptors vary in
    // size by an order of magnitude, so a slope over a mixed catalog reports
    // the sampling order, not the growth law.
    // If cost per tool were superlinear, the ratchet above would hold at 60 and
    // break silently at 120 — and an owner installing packs would fall off a
    // cliff with no warning.
    const counts = [0, 20, 40, 80];
    // ⛔ NOT `counts.map(floorAt)`. `map` passes (value, INDEX, array), so the
    //   index lands in `floorAt`'s optional second parameter and the shape
    //   becomes a number — "shape is not a function". This call site was
    //   correct until that parameter was added, and adding an optional
    //   parameter to a function used as a `map` callback breaks every such
    //   caller silently, with no type error, because the extra arguments were
    //   always being passed and were always being ignored.
    const measured = counts.map((n) => floorAt(n));
    const slopes: number[] = [];
    for (let i = 1; i < counts.length; i += 1) {
      slopes.push((measured[i]! - measured[i - 1]!) / (counts[i]! - counts[i - 1]!));
    }
    const spread = Math.max(...slopes) - Math.min(...slopes);
    expect(
      spread,
      `per-tool cost varies by ${spread.toFixed(2)} tok across the range `
      + `(${slopes.map((s) => s.toFixed(2)).join(', ')}) — not linear`,
    ).toBeLessThan(1);
  });

  it('⛔ below the floor there is NO budget at all, which is the failure to see', () => {
    // Not "a small budget": `computeContextInputTokenBudget` returns null once
    // the reserve alone exceeds the window. The caller then has no budget, the
    // ladder never runs, and nothing is trimmed — the same end state as
    // abandoning, reached a different way.
    expect(computeContextInputTokenBudget(4_000, 8_000)).toBeNull();
    expect(computeContextInputTokenBudget(8_000, 8_000)).toBeNull();
    // And a window that clears the reserve but not the floor yields a budget
    // the ladder cannot satisfy — this is the silent-abandon zone.
    const budget = computeContextInputTokenBudget(16_000, 8_000);
    expect(budget).not.toBeNull();
    const fullParts = composeChatMainTurnPromptParts({
      available_tools: REAL_TIER1_CATALOG,
      content: { chat_tail: [], user_message: 'hi' },
    } as never);
    const full = estimateConservativeMessagesTokens([
      { role: 'system', content: DEFAULT_CHAT_SYSTEM_PROMPT },
      { role: 'user', content: fullParts.body },
    ]);
    expect(budget!, 'a 16k endpoint at the quality reserve cannot fit the FULL '
      + 'shipped catalog — this is the silent-abandon zone rung 0 exists for')
      .toBeLessThan(full);
  });
});
