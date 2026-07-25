/** D-145 PB4 — tier strategy contracts tests.
 *
 *  Pins the closed-list constants + table semantics for tier
 *  inference (§ B.17.8), packet shape (§ B.3.1), latency / cost
 *  ceilings (§ C.3.6), and the pure helpers (`highestTier`,
 *  `nextLowerTier`, `clampToBounds`, `downgradeIfOverBudget`).
 *  Substrate ratchet — drift requires spec change. */

import { describe, it, expect } from 'vitest';

import {
  MODEL_TIERS,
  TIER_BY_RANK,
  TIER_ESTIMATED_COST_CENTS,
  TIER_LATENCY_CEILINGS,
  TIER_PACKET_BUDGETS,
  TIER_RANK,
  assertTierStrategyInvariants,
  clampToBounds,
  downgradeIfOverBudget,
  highestTier,
  lowestTier,
  nextLowerTier,
  tierAtLeast,
  type ModelTier,
} from '../index.js';

describe('D-145 PB4 — TIER_RANK / TIER_BY_RANK invariants', () => {
  it('TIER_RANK has fast=0 / mid=1 / reasoning=2 (closed list)', () => {
    expect(TIER_RANK.fast).toBe(0);
    expect(TIER_RANK.mid).toBe(1);
    expect(TIER_RANK.reasoning).toBe(2);
  });

  it('TIER_BY_RANK is the inverse of TIER_RANK', () => {
    expect(TIER_BY_RANK).toEqual(['fast', 'mid', 'reasoning']);
    for (const tier of MODEL_TIERS) {
      expect(TIER_BY_RANK[TIER_RANK[tier]]).toBe(tier);
    }
  });

  it('every MODEL_TIERS entry has rank / packet budget / latency ceiling / cost estimate', () => {
    for (const tier of MODEL_TIERS) {
      expect(TIER_RANK).toHaveProperty(tier);
      expect(TIER_PACKET_BUDGETS).toHaveProperty(tier);
      expect(TIER_LATENCY_CEILINGS).toHaveProperty(tier);
      expect(TIER_ESTIMATED_COST_CENTS).toHaveProperty(tier);
    }
  });

  it('assertTierStrategyInvariants passes', () => {
    expect(() => assertTierStrategyInvariants()).not.toThrow();
  });

  it('TIER_PACKET_BUDGETS pins § B.3.1 table values', () => {
    expect(TIER_PACKET_BUDGETS.fast.max_packet_bytes).toBe(1_024);
    expect(TIER_PACKET_BUDGETS.mid.max_packet_bytes).toBe(8_192);
    expect(TIER_PACKET_BUDGETS.reasoning.max_packet_bytes).toBe(32_768);
    expect(TIER_PACKET_BUDGETS.fast.max_alternatives).toBe(2);
    expect(TIER_PACKET_BUDGETS.mid.max_alternatives).toBe(5);
    expect(TIER_PACKET_BUDGETS.reasoning.max_alternatives).toBe(8);
    expect(TIER_PACKET_BUDGETS.fast.max_rounds).toBe(1);
    expect(TIER_PACKET_BUDGETS.mid.max_rounds).toBe(2);
    expect(TIER_PACKET_BUDGETS.reasoning.max_rounds).toBe(3);
  });

  it('TIER_LATENCY_CEILINGS pins § C.3.6 table values', () => {
    expect(TIER_LATENCY_CEILINGS.fast.p50_wall_clock_ms).toBe(800);
    expect(TIER_LATENCY_CEILINGS.fast.p95_wall_clock_ms).toBe(1_500);
    expect(TIER_LATENCY_CEILINGS.fast.p50_token_cost).toBe(800);
    expect(TIER_LATENCY_CEILINGS.fast.p95_token_cost).toBe(2_000);
    expect(TIER_LATENCY_CEILINGS.mid.p95_wall_clock_ms).toBe(4_000);
    expect(TIER_LATENCY_CEILINGS.mid.p95_token_cost).toBe(10_000);
    expect(TIER_LATENCY_CEILINGS.reasoning.p95_wall_clock_ms).toBe(20_000);
    expect(TIER_LATENCY_CEILINGS.reasoning.p95_token_cost).toBe(50_000);
  });

  it('TIER_ESTIMATED_COST_CENTS is monotonic ascending across rank', () => {
    expect(TIER_ESTIMATED_COST_CENTS.fast).toBeLessThan(TIER_ESTIMATED_COST_CENTS.mid);
    expect(TIER_ESTIMATED_COST_CENTS.mid).toBeLessThan(TIER_ESTIMATED_COST_CENTS.reasoning);
  });
});

describe('D-145 PB4 — tier comparison helpers', () => {
  it('highestTier returns the stronger of two tiers', () => {
    expect(highestTier('fast', 'mid')).toBe('mid');
    expect(highestTier('reasoning', 'fast')).toBe('reasoning');
    expect(highestTier('mid', 'mid')).toBe('mid');
  });

  it('lowestTier returns the cheaper of two tiers', () => {
    expect(lowestTier('fast', 'mid')).toBe('fast');
    expect(lowestTier('reasoning', 'fast')).toBe('fast');
    expect(lowestTier('mid', 'reasoning')).toBe('mid');
  });

  it('tierAtLeast returns true iff tier ≥ floor', () => {
    expect(tierAtLeast('reasoning', 'fast')).toBe(true);
    expect(tierAtLeast('mid', 'mid')).toBe(true);
    expect(tierAtLeast('fast', 'mid')).toBe(false);
    expect(tierAtLeast('mid', 'reasoning')).toBe(false);
  });

  it('nextLowerTier walks reasoning → mid → fast → null', () => {
    expect(nextLowerTier('reasoning')).toBe('mid');
    expect(nextLowerTier('mid')).toBe('fast');
    expect(nextLowerTier('fast')).toBeNull();
  });
});

describe('D-145 PB4 — clampToBounds', () => {
  it('returns input tier when bounds undefined', () => {
    expect(clampToBounds('fast', {})).toBe('fast');
    expect(clampToBounds('mid', {})).toBe('mid');
    expect(clampToBounds('reasoning', {})).toBe('reasoning');
  });

  it('min_tier raises floor', () => {
    expect(clampToBounds('fast', { min_tier: 'mid' })).toBe('mid');
    expect(clampToBounds('mid', { min_tier: 'mid' })).toBe('mid');
    expect(clampToBounds('reasoning', { min_tier: 'mid' })).toBe('reasoning');
  });

  it('max_tier lowers ceiling', () => {
    expect(clampToBounds('reasoning', { max_tier: 'mid' })).toBe('mid');
    expect(clampToBounds('mid', { max_tier: 'mid' })).toBe('mid');
    expect(clampToBounds('fast', { max_tier: 'mid' })).toBe('fast');
  });

  it('both min + max applied in sequence', () => {
    expect(clampToBounds('reasoning', { min_tier: 'mid', max_tier: 'mid' })).toBe('mid');
    expect(clampToBounds('fast', { min_tier: 'mid', max_tier: 'reasoning' })).toBe('mid');
  });

  it('min > max → null (conflict)', () => {
    expect(clampToBounds('fast', { min_tier: 'reasoning', max_tier: 'fast' })).toBeNull();
    expect(clampToBounds('mid', { min_tier: 'reasoning', max_tier: 'mid' })).toBeNull();
  });

  it('min == max → exact tier (no conflict)', () => {
    expect(clampToBounds('reasoning', { min_tier: 'mid', max_tier: 'mid' })).toBe('mid');
    expect(clampToBounds('fast', { min_tier: 'fast', max_tier: 'fast' })).toBe('fast');
  });
});

describe('D-145 PB4 — downgradeIfOverBudget', () => {
  it('returns ok with steps=0 when budget covers current tier', () => {
    const r = downgradeIfOverBudget('reasoning', {
      remaining_cents: 100,
      cost_ceiling_cents: 100,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('reasoning');
      expect(r.steps).toBe(0);
    }
  });

  it('demotes one step when current tier exceeds budget', () => {
    // reasoning ≈ 70¢; mid ≈ 8¢; budget 10¢ → demote to mid (1 step)
    const r = downgradeIfOverBudget('reasoning', {
      remaining_cents: 10,
      cost_ceiling_cents: 100,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('mid');
      expect(r.steps).toBe(1);
    }
  });

  it('demotes multiple steps until budget fits', () => {
    // reasoning 70¢, mid 8¢, fast 1¢; budget 5¢ → demote 2 steps to fast
    const r = downgradeIfOverBudget('reasoning', {
      remaining_cents: 5,
      cost_ceiling_cents: 100,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('fast');
      expect(r.steps).toBe(2);
    }
  });

  it('halts cost_ceiling_no_lower when budget < fast cost', () => {
    const r = downgradeIfOverBudget('reasoning', {
      remaining_cents: 0,
      cost_ceiling_cents: 100,
    });
    expect(r.kind).toBe('halt');
    if (r.kind === 'halt') {
      expect(r.reason).toBe('cost_ceiling_no_lower');
      expect(r.halted_at_tier).toBe('fast');
    }
  });

  it('halts cost_ceiling_min_floor when SI min_tier prevents demotion below floor', () => {
    // SI min_tier='mid' + budget 5¢ — cannot demote past mid
    const r = downgradeIfOverBudget(
      'reasoning',
      { remaining_cents: 5, cost_ceiling_cents: 100 },
      { min_tier: 'mid' },
    );
    expect(r.kind).toBe('halt');
    if (r.kind === 'halt') {
      expect(r.reason).toBe('cost_ceiling_min_floor');
      expect(r.halted_at_tier).toBe('mid');
    }
  });

  it('SI min_tier does NOT block budget-fits-current-tier ok', () => {
    const r = downgradeIfOverBudget(
      'reasoning',
      { remaining_cents: 100, cost_ceiling_cents: 100 },
      { min_tier: 'mid' },
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.tier).toBe('reasoning');
  });

  it('starting at fast with insufficient budget → halt no_lower at fast', () => {
    const r = downgradeIfOverBudget('fast', {
      remaining_cents: 0,
      cost_ceiling_cents: 100,
    });
    expect(r.kind).toBe('halt');
    if (r.kind === 'halt') {
      expect(r.reason).toBe('cost_ceiling_no_lower');
      expect(r.halted_at_tier).toBe('fast');
    }
  });
});

describe('D-145 PB4 — Codex P1 fold: downgradeIfOverBudget costFor override', () => {
  it('honors costFor override at every walker step', () => {
    // Caller-supplied per-tier estimates: reasoning 100¢, mid 30¢,
    // fast 5¢. Budget 20¢ → demote past mid (30¢ > 20¢) to fast (5¢).
    const r = downgradeIfOverBudget(
      'reasoning',
      { remaining_cents: 20, cost_ceiling_cents: 100 },
      {},
      (tier) => ({ reasoning: 100, mid: 30, fast: 5 } as const)[tier],
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('fast');
      expect(r.steps).toBe(2);
    }
  });

  it('costFor returning negative falls back to substrate default', () => {
    // Override returns -1 (invalid); walker should fall back to
    // TIER_ESTIMATED_COST_CENTS (reasoning=70). Budget 100¢ → ok at
    // reasoning.
    const r = downgradeIfOverBudget(
      'reasoning',
      { remaining_cents: 100, cost_ceiling_cents: 100 },
      {},
      () => -1,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.tier).toBe('reasoning');
  });

  it('costFor returning Infinity falls back to substrate default (defensive)', () => {
    const r = downgradeIfOverBudget(
      'reasoning',
      { remaining_cents: 100, cost_ceiling_cents: 100 },
      {},
      () => Number.POSITIVE_INFINITY,
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.tier).toBe('reasoning');
  });

  it('walker terminates within bounded iterations (defensive)', () => {
    // Construct a cost function that ALWAYS returns a value the
    // budget can never cover at any tier. The walker should halt at
    // fast with no_lower (no infinite loop).
    const r = downgradeIfOverBudget(
      'reasoning',
      { remaining_cents: 0, cost_ceiling_cents: 100 },
      {},
      () => 999,
    );
    expect(r.kind).toBe('halt');
    if (r.kind === 'halt') {
      expect(r.reason).toBe('cost_ceiling_no_lower');
      expect(r.halted_at_tier).toBe('fast');
    }
  });
});

describe('D-145 PB4 — closed-list ratchets', () => {
  it('MODEL_TIERS membership across all helpers', () => {
    const expected = new Set<ModelTier>(MODEL_TIERS);
    expect(new Set(Object.keys(TIER_RANK) as ModelTier[])).toEqual(expected);
    expect(new Set(Object.keys(TIER_PACKET_BUDGETS) as ModelTier[])).toEqual(expected);
    expect(new Set(Object.keys(TIER_LATENCY_CEILINGS) as ModelTier[])).toEqual(expected);
    expect(new Set(Object.keys(TIER_ESTIMATED_COST_CENTS) as ModelTier[])).toEqual(expected);
  });

  it('TIER_BY_RANK matches MODEL_TIERS order', () => {
    expect(TIER_BY_RANK).toEqual([...MODEL_TIERS]);
  });
});
