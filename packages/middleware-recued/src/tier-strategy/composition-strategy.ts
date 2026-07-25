/** D-145 PB4 — tier-specific composition strategies.
 *
 *  Per § B.3.1 + § B.3.3:
 *
 *  | Tier      | Strategy                                                         |
 *  |-----------|------------------------------------------------------------------|
 *  | fast      | Engine narrows + ranks; AI synthesizes a bounded packet          |
 *  | mid       | Engine narrows; AI synthesizes over a moderate packet            |
 *  | reasoning | Engine governs; AI explores alternatives over a wider but still |
 *  |           | governed packet (multi-source merge with provenance breadcrumbs) |
 *
 *  PB4 ships the *strategy descriptor* — a closed-list rule bag the
 *  orchestrator policy + the synthesis composer read to decide:
 *    - whether the engine should pre-rank context (fast tier)
 *    - whether the engine should attach provenance breadcrumbs to
 *      each context item (reasoning tier)
 *    - whether multi-turn rounds are allowed (reasoning tier)
 *    - the per-tier alternative count + packet budget (already in
 *      `TIER_PACKET_BUDGETS`)
 *
 *  The strategy descriptor is a *contract* between PB4 (substrate)
 *  and the orchestrator policy. The synthesis composer reads it
 *  and shapes the AI packet accordingly; PC3 benchmark fixtures
 *  pin per-tier composition expectations.
 *
 *  Pure constants + pure resolver — no IO, no side effects.
 *
 *  Spec: § B.3.1 + § B.3.3. */

import { TIER_PACKET_BUDGETS, type ModelTier, type TierPacketBudget } from '@recued/contracts';

export const COMPOSITION_STRATEGY_KINDS = [
  'narrow_and_rank',
  'narrow_and_merge',
  'governed_exploration',
] as const;
export type CompositionStrategyKind = (typeof COMPOSITION_STRATEGY_KINDS)[number];
export const COMPOSITION_STRATEGY_KIND_SET: ReadonlySet<CompositionStrategyKind> = new Set(
  COMPOSITION_STRATEGY_KINDS,
);

export interface CompositionStrategy {
  readonly tier: ModelTier;
  readonly kind: CompositionStrategyKind;
  /** Whether the engine should pre-rank context items by recency /
   *  authorship / topic before passing the packet to AI. § B.3.3
   *  fast tier: engine pre-ranks; mid + reasoning: pass the wider
   *  packet and let AI compose. */
  readonly engine_pre_ranks: boolean;
  /** Whether the engine should attach provenance breadcrumbs to
   *  each context item. § B.3.3 reasoning tier: each piece of
   *  context tagged with source + recency so AI can reason across
   *  the packet with attribution. */
  readonly attach_provenance_breadcrumbs: boolean;
  /** Whether the AI may emit a reasoning trace that surfaces in the
   *  Transparency Stream. § B.3.3 reasoning tier: AI explores +
   *  emits reasoning-trace events. */
  readonly allows_reasoning_trace: boolean;
  /** Per-tier packet budget (proxies to `TIER_PACKET_BUDGETS`). */
  readonly budget: TierPacketBudget;
}

export const COMPOSITION_STRATEGIES: { readonly [K in ModelTier]: CompositionStrategy } =
  Object.freeze({
    fast: Object.freeze({
      tier: 'fast' as ModelTier,
      kind: 'narrow_and_rank' as CompositionStrategyKind,
      engine_pre_ranks: true,
      attach_provenance_breadcrumbs: false,
      allows_reasoning_trace: false,
      budget: TIER_PACKET_BUDGETS.fast,
    }),
    mid: Object.freeze({
      tier: 'mid' as ModelTier,
      kind: 'narrow_and_merge' as CompositionStrategyKind,
      engine_pre_ranks: false,
      attach_provenance_breadcrumbs: false,
      allows_reasoning_trace: false,
      budget: TIER_PACKET_BUDGETS.mid,
    }),
    reasoning: Object.freeze({
      tier: 'reasoning' as ModelTier,
      kind: 'governed_exploration' as CompositionStrategyKind,
      engine_pre_ranks: false,
      attach_provenance_breadcrumbs: true,
      allows_reasoning_trace: true,
      budget: TIER_PACKET_BUDGETS.reasoning,
    }),
  });

/** Resolve the per-tier composition strategy. Pure helper for callers
 *  that want a single function call rather than indexing the table. */
export const resolveCompositionStrategy = (tier: ModelTier): CompositionStrategy =>
  COMPOSITION_STRATEGIES[tier];
