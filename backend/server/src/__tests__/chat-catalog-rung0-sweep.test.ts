/** ⛔⛔ RUNG 0 — THE CATALOG STEP-DOWN, SWEPT ACROSS THE BUDGET SPACE.
 *
 *  `fitCatalogModeToBudget` had NO direct test: the only reference to it in the
 *  suite is a COMMENT in `chat-budgeted-turn-error-contract` explaining why an
 *  error message is stale. It is the one rung that can reach the biggest field
 *  in the packet — every trim in the executor operates BELOW the catalog,
 *  because the catalog is the D-164 cacheable prefix and `composePrompt` passes
 *  it through unchanged on all six recompositions. So when the catalog alone
 *  exceeds the budget, nothing the executor does can help, and rung 0 is the
 *  entire remedy.
 *
 *  🔑 IT IS ALSO THE SWEEP THE EXECUTOR SWEEP CANNOT DO. There,
 *  `available_tools` is empty so rung 0 is a no-op, and the prefix invariant is
 *  the strong one (identical across every budget). Here the catalog CHANGES by
 *  design, so the correct invariant is the weaker one: the prefix is a FUNCTION
 *  OF THE MODE — stable across every budget that shares a mode, different when
 *  the mode differs. Asserting the strong form here would fail on correct
 *  behaviour. */
import { describe, expect, it } from 'vitest';
import { fitCatalogModeToBudget } from '../chat-context-budget.js';
import { composeChatMainTurnPromptParts } from '../chat-turn-executor.js';
import {
  CHAT_CATALOG_DELIVERY_MODES,
  type ChatCatalogDeliveryMode,
} from '@recued/contracts';

/** Monotonically cheaper as the mode gets leaner — the shape rung 0 assumes. */
const COST: Record<ChatCatalogDeliveryMode, number> = {
  full: 9_000,
  index: 4_000,
  'lean-core': 1_000,
};

const fit = (
  budget: number | undefined,
  from: ChatCatalogDeliveryMode = 'full',
  seen?: ChatCatalogDeliveryMode[],
): ChatCatalogDeliveryMode =>
  fitCatalogModeToBudget({
    mode: from,
    inputTokenBudget: budget,
    measureCatalogTokens: (m) => { seen?.push(m); return COST[m]; },
  });

describe('rung 0 — catalog step-down', () => {
  it('is monotone in the budget and never leaner than necessary', () => {
    const budgets = [50_000, 12_000, 9_001, 9_000, 8_999, 4_001, 4_000,
      3_999, 1_001, 1_000, 999, 1];
    let previousRank = -1;
    for (const budget of budgets) {
      const mode = fit(budget);
      const rank = CHAT_CATALOG_DELIVERY_MODES.indexOf(mode);

      // MONOTONE: a smaller budget never buys a RICHER catalog.
      expect(rank, `budget ${budget}: mode ${mode} richer than a larger budget's`)
        .toBeGreaterThanOrEqual(previousRank);
      previousRank = rank;

      // NEVER LEANER THAN NECESSARY: if a richer mode would have fitted, it
      // should have been chosen. Stepping down further than required throws
      // away tools the model could have used, for no gain.
      const richer = CHAT_CATALOG_DELIVERY_MODES.slice(0, rank);
      for (const r of richer) {
        expect(COST[r] < budget, `budget ${budget}: ${r} fitted but ${mode} chosen`)
          .toBe(false);
      }
    }
  });

  it('⛔ the boundary is STRICT — a catalog costing exactly the budget does not fit', () => {
    // `<` not `<=`, deliberately: a catalog that exactly fills the budget
    // leaves zero room for the conversation it exists to serve, so "fits" would
    // be true and useless.
    expect(fit(COST.full + 1)).toBe('full');
    expect(fit(COST.full)).toBe('index');
  });

  it('⛔ never steps UP, even when the budget is enormous', () => {
    // The search starts at the caller's mode and only walks leaner. A budget
    // that could afford `full` must not promote a caller who asked for
    // `lean-core` — the mode is the owner's setting, not a suggestion.
    expect(fit(1_000_000, 'lean-core')).toBe('lean-core');
    expect(fit(1_000_000, 'index')).toBe('index');
  });

  it('⛔ nothing fits ⇒ the LEANEST, not the original', () => {
    // Returning the caller's mode would be the obvious behaviour and is wrong:
    // the turn is tight either way, and the executor's rungs have more room to
    // work with under a lean catalog.
    expect(fit(1, 'full')).toBe('lean-core');
  });

  it('⛔ no budget ⇒ no measurement at all, not just no change', () => {
    // The cost claim is part of the contract ("called at most once per mode,
    // and NOT AT ALL when there is no budget") — on the overwhelmingly common
    // unbudgeted path this must add nothing.
    const seen: ChatCatalogDeliveryMode[] = [];
    expect(fit(undefined, 'full', seen)).toBe('full');
    expect(seen, 'measured despite having no budget').toEqual([]);
  });

  it('measures each mode at most once', () => {
    const seen: ChatCatalogDeliveryMode[] = [];
    fit(1, 'full', seen);
    expect(seen.length, `measured ${seen.join(',')}`).toBe(new Set(seen).size);
  });

  it('⛔ the cacheable prefix is a FUNCTION OF THE MODE, not of the budget', () => {
    // The property the executor sweep cannot express, because there the
    // catalog never changes. Same mode ⇒ byte-identical prefix at any budget;
    // different mode ⇒ different prefix, which is correct and is exactly why
    // the strong invariant does not belong here.
    const compose = (tools: ReadonlyArray<{ recipe_slug: string }>): string =>
      composeChatMainTurnPromptParts({
        available_tools: tools,
        content: { chat_tail: [], user_message: 'hi' },
      } as never).cacheable_prefix;

    const catalogFor = (mode: ChatCatalogDeliveryMode) =>
      Array.from({ length: mode === 'full' ? 6 : mode === 'index' ? 3 : 1 },
        (_, i) => ({ recipe_slug: `tool-${i}` }));

    const prefixes = new Map<ChatCatalogDeliveryMode, string>();
    for (const mode of CHAT_CATALOG_DELIVERY_MODES) {
      prefixes.set(mode, compose(catalogFor(mode)));
    }
    // Stable for a mode, however often it is composed.
    for (const mode of CHAT_CATALOG_DELIVERY_MODES) {
      expect(compose(catalogFor(mode)), `${mode} prefix stable`)
        .toBe(prefixes.get(mode));
    }
    // And genuinely distinct between modes — otherwise this test would pass
    // even if the catalog never reached the prefix at all.
    expect(new Set(prefixes.values()).size, 'each mode has its own prefix')
      .toBe(CHAT_CATALOG_DELIVERY_MODES.length);
  });
});
