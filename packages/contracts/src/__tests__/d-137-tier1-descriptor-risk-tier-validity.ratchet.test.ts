/** D-137 Tier 1 descriptor risk-tier ratchet.
 *
 *  TIER1 tool descriptors are LLM-read at runtime, so their prose must not
 *  teach invalid policy literals. `review` is not a valid `RiskTier`; the
 *  gateway gates plan approval on PLAN_APPROVAL_WRITE_RISK_TIERS =
 *  {write, admin, destructive}.
 */

import { describe, expect, it } from 'vitest';

import { TIER1_TOOL_DESCRIPTORS } from '../chat.js';
import { RISK_TIERS } from '../ingredient.js';

// The canonical `RISK_TIERS` ladder (ingredient.ts) carries its OWN compile-time
// completeness ratchet, so this test covers every tier by construction — a future
// tier breaks the source of truth first, forcing the write-class prose assertions
// below to be revisited. read 0 / write 1 / admin 2 / destructive 3.
const WRITE_RISK_TIER = RISK_TIERS[1];
const ADMIN_RISK_TIER = RISK_TIERS[2];
const DESTRUCTIVE_RISK_TIER = RISK_TIERS[3];

describe('D-137 Tier 1 descriptor risk-tier validity ratchet', () => {
  const recipeRunDescription = TIER1_TOOL_DESCRIPTORS['recipe.run'].description;

  it("does not teach the invalid 'review' risk tier in recipe.run", () => {
    expect(recipeRunDescription).not.toContain("'review'");
  });

  it("does not pair risk_tier with the invalid 'review' literal in any Tier 1 descriptor", () => {
    for (const [name, descriptor] of Object.entries(TIER1_TOOL_DESCRIPTORS)) {
      expect(
        descriptor.description,
        `${name} descriptor must not teach risk_tier as invalid literal 'review'`,
      ).not.toMatch(/risk_tier[^.\n]{0,60}'review'/);
    }
  });

  it('keeps recipe.run prose locked to every valid write-class risk tier', () => {
    expect(recipeRunDescription).toContain(`'${WRITE_RISK_TIER}'`);
    expect(recipeRunDescription).toContain(`'${ADMIN_RISK_TIER}'`);
    expect(recipeRunDescription).toContain(`'${DESTRUCTIVE_RISK_TIER}'`);
  });
});
