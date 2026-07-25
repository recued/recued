/** D-145 PB4 / D-164 P6.2 — `selectSynthesisTier` pure function tests.
 *
 *  Exhaustive coverage of:
 *    - baseline derivation from `sessionPref ?? channelDefault`
 *      (D-164 P6.2 replaced the retired `defaultTierForClassification`
 *      classification-keyed derivation with a caller-supplied
 *      channel default)
 *    - modelHint raise (rule 2)
 *    - SI bounds clamp + conflict (rule 3)
 *    - budget downgrade chain (rule 4)
 *    - composition of all four steps in one call
 *    - determinism (same inputs → same result) */

import { describe, it, expect } from 'vitest';

import { selectSynthesisTier } from '../tier-strategy/select-tier.js';
import type { TierBudget } from '@recued/contracts';

const generousBudget: TierBudget = { remaining_cents: 1_000, cost_ceiling_cents: 1_000 };
const tightBudget: TierBudget = { remaining_cents: 5, cost_ceiling_cents: 100 };
const reallyEmpty: TierBudget = { remaining_cents: 0, cost_ceiling_cents: 100 };

describe('D-145 PB4 — selectSynthesisTier baseline (no hint, no SI, generous budget)', () => {
  it('channelDefault fast → baseline fast', () => {
    const r = selectSynthesisTier({
      channelDefault: 'fast',
      budget: generousBudget,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('fast');
      expect(r.baseline_tier).toBe('fast');
      expect(r.demotion_steps).toBe(0);
      expect(r.hint_raised).toBe(false);
      expect(r.si_clamped).toBe(false);
    }
  });

  it('channelDefault reasoning → baseline reasoning', () => {
    const r = selectSynthesisTier({
      channelDefault: 'reasoning',
      budget: generousBudget,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('reasoning');
      expect(r.baseline_tier).toBe('reasoning');
    }
  });

  it('channelDefault mid → baseline mid', () => {
    const r = selectSynthesisTier({
      channelDefault: 'mid',
      budget: generousBudget,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('mid');
      expect(r.baseline_tier).toBe('mid');
    }
  });
});

describe('D-145 PB4 / D-164 P6.2 — sessionPref overrides channelDefault', () => {
  it('sessionPref reasoning overrides channelDefault fast', () => {
    const r = selectSynthesisTier({
      channelDefault: 'fast',
      sessionPref: 'reasoning',
      budget: generousBudget,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('reasoning');
      expect(r.baseline_tier).toBe('reasoning');
      // hint_raised is for modelHint, not sessionPref; both routes set
      // baseline. sessionPref is the user's explicit preference, NOT a
      // hint — it doesn't mark `hint_raised`.
      expect(r.hint_raised).toBe(false);
    }
  });

  it('sessionPref fast overrides channelDefault reasoning (DOWN)', () => {
    // sessionPref REPLACES channelDefault — it can lower as well as
    // raise. This mirrors a user who wants every turn cheap.
    const r = selectSynthesisTier({
      channelDefault: 'reasoning',
      sessionPref: 'fast',
      budget: generousBudget,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('fast');
      expect(r.baseline_tier).toBe('fast');
    }
  });

  it('sessionPref equal to channelDefault → no observable change', () => {
    const r = selectSynthesisTier({
      channelDefault: 'mid',
      sessionPref: 'mid',
      budget: generousBudget,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('mid');
      expect(r.baseline_tier).toBe('mid');
    }
  });

  it('sessionPref omitted (undefined) → baseline tracks channelDefault', () => {
    // Codex review fold: explicit guard that the `??` operator falls
    // through to `channelDefault` when `sessionPref` is undefined, not
    // when it is some other falsy value (e.g. empty string from a
    // misbehaving caller — TS would catch it but the runtime check
    // belongs here).
    const r = selectSynthesisTier({
      channelDefault: 'reasoning',
      // sessionPref intentionally omitted
      budget: generousBudget,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('reasoning');
      expect(r.baseline_tier).toBe('reasoning');
    }
  });
});

describe('D-145 PB4 — selectSynthesisTier with modelHint (rule 2)', () => {
  it('modelHint raises baseline (fast → reasoning)', () => {
    const r = selectSynthesisTier({
      channelDefault: 'fast',
      budget: generousBudget,
      modelHint: 'reasoning',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('reasoning');
      expect(r.baseline_tier).toBe('fast');
      expect(r.hint_raised).toBe(true);
    }
  });

  it('modelHint at or below baseline does NOT lower (highestOf)', () => {
    const r = selectSynthesisTier({
      channelDefault: 'reasoning',
      budget: generousBudget,
      modelHint: 'fast',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('reasoning');
      expect(r.baseline_tier).toBe('reasoning');
      expect(r.hint_raised).toBe(false);
    }
  });

  it('modelHint equal to baseline does NOT mark hint_raised', () => {
    const r = selectSynthesisTier({
      channelDefault: 'fast',
      budget: generousBudget,
      modelHint: 'fast',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('fast');
      expect(r.hint_raised).toBe(false);
    }
  });

  it('modelHint composes after sessionPref (sessionPref then hint raise)', () => {
    // channelDefault fast, sessionPref mid (override → baseline mid),
    // modelHint reasoning raises to reasoning.
    const r = selectSynthesisTier({
      channelDefault: 'fast',
      sessionPref: 'mid',
      modelHint: 'reasoning',
      budget: generousBudget,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('reasoning');
      expect(r.baseline_tier).toBe('mid');
      expect(r.hint_raised).toBe(true);
    }
  });
});

describe('D-145 PB4 — selectSynthesisTier with SI bounds (rule 3)', () => {
  it('min_tier raises floor', () => {
    const r = selectSynthesisTier({
      channelDefault: 'fast',
      siBounds: { min_tier: 'mid' },
      budget: generousBudget,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('mid');
      expect(r.baseline_tier).toBe('fast');
      expect(r.si_clamped).toBe(true);
    }
  });

  it('max_tier lowers ceiling', () => {
    const r = selectSynthesisTier({
      channelDefault: 'reasoning',
      siBounds: { max_tier: 'mid' },
      budget: generousBudget,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('mid');
      expect(r.baseline_tier).toBe('reasoning');
      expect(r.si_clamped).toBe(true);
    }
  });

  it('min > max halts with standing_instruction_conflict', () => {
    const r = selectSynthesisTier({
      channelDefault: 'fast',
      siBounds: { min_tier: 'reasoning', max_tier: 'fast' },
      budget: generousBudget,
    });
    expect(r.kind).toBe('halt');
    if (r.kind === 'halt') {
      expect(r.reason).toBe('standing_instruction_conflict');
    }
  });

  it('min == max returns exact tier (no conflict)', () => {
    const r = selectSynthesisTier({
      channelDefault: 'reasoning',
      siBounds: { min_tier: 'mid', max_tier: 'mid' },
      budget: generousBudget,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('mid');
      expect(r.si_clamped).toBe(true);
    }
  });

  it('SI bounds clamp BEFORE budget walker', () => {
    // baseline reasoning, max_tier mid → clamped to mid; mid (8¢) fits
    // 10¢ budget without demotion
    const r = selectSynthesisTier({
      channelDefault: 'reasoning',
      siBounds: { max_tier: 'mid' },
      budget: { remaining_cents: 10, cost_ceiling_cents: 100 },
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('mid');
      expect(r.demotion_steps).toBe(0);
    }
  });
});

describe('D-145 PB4 — selectSynthesisTier with budget walker (rule 4)', () => {
  it('demotes reasoning → mid when reasoning over budget', () => {
    const r = selectSynthesisTier({
      channelDefault: 'reasoning',
      budget: { remaining_cents: 10, cost_ceiling_cents: 100 }, // mid 8¢ fits
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('mid');
      expect(r.demotion_steps).toBe(1);
      expect(r.baseline_tier).toBe('reasoning');
      expect(r.clamped_tier).toBe('reasoning');
    }
  });

  it('demotes 2 steps reasoning → fast when budget very tight', () => {
    const r = selectSynthesisTier({
      channelDefault: 'reasoning',
      budget: tightBudget, // 5¢ → only fast (1¢) fits
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('fast');
      expect(r.demotion_steps).toBe(2);
    }
  });

  it('halts cost_ceiling_no_lower when 0 budget at fast tier', () => {
    const r = selectSynthesisTier({
      channelDefault: 'fast',
      budget: reallyEmpty,
    });
    expect(r.kind).toBe('halt');
    if (r.kind === 'halt') {
      expect(r.reason).toBe('cost_ceiling_no_lower');
      expect(r.halted_at_tier).toBe('fast');
    }
  });

  it('halts cost_ceiling_min_floor when SI min_tier prevents demotion', () => {
    const r = selectSynthesisTier({
      channelDefault: 'reasoning',
      siBounds: { min_tier: 'mid' },
      budget: tightBudget, // can't reach mid (8¢)
    });
    expect(r.kind).toBe('halt');
    if (r.kind === 'halt') {
      expect(r.reason).toBe('cost_ceiling_min_floor');
      expect(r.halted_at_tier).toBe('mid');
    }
  });

  it('walker reports baseline_tier even after demotion', () => {
    const r = selectSynthesisTier({
      channelDefault: 'reasoning',
      budget: tightBudget,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.baseline_tier).toBe('reasoning');
      expect(r.clamped_tier).toBe('reasoning');
      expect(r.tier).toBe('fast');
    }
  });
});

describe('D-145 PB4 — selectSynthesisTier composition (all four steps)', () => {
  it('hint raises + SI clamps + budget demotes (full chain)', () => {
    // baseline fast (channelDefault); hint raises to reasoning; SI
    // max_tier=mid clamps to mid; budget tight forces demote to fast.
    const r = selectSynthesisTier({
      channelDefault: 'fast',
      modelHint: 'reasoning',
      siBounds: { max_tier: 'mid' },
      budget: tightBudget,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('fast');
      expect(r.baseline_tier).toBe('fast');
      expect(r.clamped_tier).toBe('mid');
      expect(r.hint_raised).toBe(true);
      expect(r.si_clamped).toBe(true);
      expect(r.demotion_steps).toBe(1);
    }
  });

  it('sessionPref + hint + SI + budget (full chain with override)', () => {
    // channelDefault fast, sessionPref mid (override → baseline mid),
    // modelHint reasoning raises to reasoning, SI max_tier mid clamps
    // back to mid, budget tight forces demote to fast.
    const r = selectSynthesisTier({
      channelDefault: 'fast',
      sessionPref: 'mid',
      modelHint: 'reasoning',
      siBounds: { max_tier: 'mid' },
      budget: tightBudget,
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.tier).toBe('fast');
      expect(r.baseline_tier).toBe('mid');
      expect(r.clamped_tier).toBe('mid');
      expect(r.hint_raised).toBe(true);
      expect(r.si_clamped).toBe(true);
      expect(r.demotion_steps).toBe(1);
    }
  });

  it('determinism: same inputs always produce same output', () => {
    const inputs = {
      channelDefault: 'reasoning' as const,
      modelHint: 'reasoning' as const,
      siBounds: { min_tier: 'mid' as const },
      budget: { remaining_cents: 50, cost_ceiling_cents: 100 },
    };
    const a = selectSynthesisTier(inputs);
    const b = selectSynthesisTier(inputs);
    const c = selectSynthesisTier(inputs);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });
});
