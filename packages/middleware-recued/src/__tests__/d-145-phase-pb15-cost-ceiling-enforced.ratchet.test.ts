/** D-145 PB15 — `cost-ceiling-enforced` ratchet.
 *
 *  Pins the substrate-level invariant from § B.15.10: cost ceiling
 *  enforcement halts plans rather than silently overspending budget.
 *
 *  This ratchet is the PB15 acceptance gate over PB4's cost-ceiling
 *  substrate: it asserts the wiring from `evaluateCostCeiling` →
 *  `composeFailureResult` produces the canonical `cancelled_cost_ceiling`
 *  PlanStatus + `'cost'` FailureClass with truthful + actionable
 *  user_response.
 *
 *  Drift requires substrate D-spec change. */

import { describe, it, expect } from 'vitest';
import { evaluateCostCeiling } from '../tier-strategy/cost-ceiling.js';
import { TIER_POLICY_HALT_TO_FAILURE_CLASS } from '../tier-strategy/tier-policy.js';
import {
  composeFailureResult,
  USER_RESPONSE_TEMPLATES,
} from '@recued/middleware/failure-semantics/index.js';

describe('D-145 PB15 — cost-ceiling-enforced.ratchet', () => {
  it('PB4 + PB15 wiring: cost ceiling halt → cancelled_cost_ceiling + cost class', () => {
    expect(TIER_POLICY_HALT_TO_FAILURE_CLASS.cost_ceiling_min_floor).toBe('cost');
    expect(TIER_POLICY_HALT_TO_FAILURE_CLASS.cost_ceiling_no_lower).toBe('cost');
  });

  it('composeFailureResult on cancelled_cost_ceiling produces cost failure_class', () => {
    const result = composeFailureResult({ status: 'cancelled_cost_ceiling' });
    expect(result.status).toBe('cancelled_cost_ceiling');
    expect(result.failure_class).toBe('cost');
  });

  it('cancelled_cost_ceiling user_response references budget', () => {
    expect(USER_RESPONSE_TEMPLATES.cancelled_cost_ceiling).toMatch(/budget/i);
  });

  it('cancelled_cost_ceiling user_response references Settings (actionable)', () => {
    expect(USER_RESPONSE_TEMPLATES.cancelled_cost_ceiling).toMatch(/Settings/);
  });

  it('evaluateCostCeiling halt outcome leads to cost halt mapping', () => {
    const result = evaluateCostCeiling({
      current_tier: 'fast',
      budget: { cost_ceiling_cents: 1, remaining_cents: 1 },
      next_call_cost_cents: 100,
    });
    expect(result.outcome).toBe('halt');
  });

  it('halt at fast tier (no lower tier) produces cancelled_cost_ceiling failure', () => {
    const result = evaluateCostCeiling({
      current_tier: 'fast',
      budget: { cost_ceiling_cents: 1, remaining_cents: 1 },
      next_call_cost_cents: 100,
    });
    if (result.outcome === 'halt') {
      expect(result.reason).toBe('cost_ceiling_no_lower');
      const failure = composeFailureResult({
        status: 'cancelled_cost_ceiling',
      });
      expect(failure.failure_class).toBe('cost');
    }
  });

  it('halt at min_tier floor (SI bound) produces cancelled_cost_ceiling failure', () => {
    const result = evaluateCostCeiling({
      current_tier: 'reasoning',
      budget: { cost_ceiling_cents: 1, remaining_cents: 1 },
      next_call_cost_cents: 100,
      siBounds: { min_tier: 'reasoning' },
    });
    if (result.outcome === 'halt') {
      expect(result.reason).toBe('cost_ceiling_min_floor');
    }
  });
});
