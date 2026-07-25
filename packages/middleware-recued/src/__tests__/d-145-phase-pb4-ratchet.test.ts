/** D-145 PB4 — closed-list ratchets across tier strategy + composition.
 *
 *  Drift requires substrate D-spec change. Pins:
 *    - PACKET_SHAPE_VIOLATION_KINDS = exactly 3 entries
 *    - COMPOSITION_STRATEGY_KINDS = exactly 3 entries
 *    - COST_CEILING_OUTCOMES = exactly 3 entries
 *    - TIER_POLICY_HALT_TO_PLAN_STATUS exhaustively maps the closed
 *      list of halt reasons to the substrate's PlanStatus taxonomy
 *    - selectSynthesisTier returns deterministically across iterations */

import { describe, it, expect } from 'vitest';

import {
  COMPOSITION_STRATEGIES,
  COMPOSITION_STRATEGY_KINDS,
} from '../tier-strategy/composition-strategy.js';
import {
  PACKET_SHAPE_VIOLATION_KINDS,
} from '../tier-strategy/packet-shape.js';
import { COST_CEILING_OUTCOMES } from '../tier-strategy/cost-ceiling.js';
import {
  TIER_POLICY_HALT_TO_FAILURE_CLASS,
  TIER_POLICY_HALT_TO_PLAN_STATUS,
} from '../tier-strategy/tier-policy.js';
import { selectSynthesisTier } from '../tier-strategy/select-tier.js';
import {
  FAILURE_CLASS_SET,
  MODEL_TIERS,
  PLAN_STATUS_SET,
} from '@recued/contracts';

describe('D-145 PB4 — closed-list ratchets', () => {
  it('PACKET_SHAPE_VIOLATION_KINDS is exactly 3 entries', () => {
    expect(PACKET_SHAPE_VIOLATION_KINDS.length).toBe(3);
    expect(new Set(PACKET_SHAPE_VIOLATION_KINDS)).toEqual(
      new Set(['packet_oversized', 'too_many_alternatives', 'too_many_rounds']),
    );
  });

  it('COMPOSITION_STRATEGY_KINDS is exactly 3 entries (one per tier)', () => {
    expect(COMPOSITION_STRATEGY_KINDS.length).toBe(3);
    expect(MODEL_TIERS.length).toBe(COMPOSITION_STRATEGY_KINDS.length);
    for (const tier of MODEL_TIERS) {
      expect(COMPOSITION_STRATEGIES).toHaveProperty(tier);
    }
  });

  it('COST_CEILING_OUTCOMES is exactly 3 entries (ok / demote / halt)', () => {
    expect(COST_CEILING_OUTCOMES.length).toBe(3);
    expect(new Set(COST_CEILING_OUTCOMES)).toEqual(new Set(['ok', 'demote', 'halt']));
  });

  it('TIER_POLICY_HALT mapping covers exactly 3 halt reasons', () => {
    const haltReasons = Object.keys(TIER_POLICY_HALT_TO_PLAN_STATUS);
    expect(haltReasons.length).toBe(3);
    expect(new Set(haltReasons)).toEqual(
      new Set([
        'standing_instruction_conflict',
        'cost_ceiling_min_floor',
        'cost_ceiling_no_lower',
      ]),
    );
  });

  it('TIER_POLICY_HALT_TO_PLAN_STATUS values are members of PLAN_STATUS_SET', () => {
    for (const status of Object.values(TIER_POLICY_HALT_TO_PLAN_STATUS)) {
      expect(PLAN_STATUS_SET.has(status)).toBe(true);
    }
  });

  it('TIER_POLICY_HALT_TO_FAILURE_CLASS values are members of FAILURE_CLASS_SET', () => {
    for (const fc of Object.values(TIER_POLICY_HALT_TO_FAILURE_CLASS)) {
      expect(FAILURE_CLASS_SET.has(fc)).toBe(true);
    }
  });

  it('selectSynthesisTier is deterministic across 50 iterations', () => {
    const inputs = {
      channelDefault: 'reasoning' as const,
      modelHint: 'reasoning' as const,
      siBounds: { min_tier: 'mid' as const },
      budget: { remaining_cents: 50, cost_ceiling_cents: 100 },
    };
    const first = selectSynthesisTier(inputs);
    for (let i = 0; i < 50; i++) {
      expect(selectSynthesisTier(inputs)).toEqual(first);
    }
  });
});
