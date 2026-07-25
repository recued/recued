/** The canonical `RiskTier` ladder / rank / label (ingredient.ts) — the single
 *  source of truth that retired the hand-maintained rank / order / label copies
 *  across the codebase. The tests below pin its order + internal consistency so
 *  an accidental reorder or a dropped label is caught, and lockstep the derived
 *  RANK / LABELS to the ladder (the drift the copies suffered can no longer
 *  recur). */

import { describe, expect, it } from 'vitest';

import {
  RISK_TIERS,
  RISK_TIER_SET,
  RISK_TIER_RANK,
  RISK_TIER_LABELS,
  isRiskTier,
  riskTierLabel,
} from '../ingredient.js';

describe('canonical RiskTier ladder', () => {
  it('pins the strictness order read < write < admin < destructive', () => {
    expect([...RISK_TIERS]).toEqual(['read', 'write', 'admin', 'destructive']);
  });

  it('RISK_TIER_RANK is the index of each tier, strictly increasing', () => {
    RISK_TIERS.forEach((tier, i) => expect(RISK_TIER_RANK[tier]).toBe(i));
    // strictly increasing along the ladder
    for (let i = 1; i < RISK_TIERS.length; i++) {
      expect(RISK_TIER_RANK[RISK_TIERS[i]]).toBeGreaterThan(RISK_TIER_RANK[RISK_TIERS[i - 1]]);
    }
    // an unknown tier has no rank (callers default the miss)
    expect(RISK_TIER_RANK['bogus']).toBeUndefined();
  });

  it('RISK_TIER_SET + isRiskTier accept exactly the ladder', () => {
    for (const tier of RISK_TIERS) {
      expect(RISK_TIER_SET.has(tier)).toBe(true);
      expect(isRiskTier(tier)).toBe(true);
    }
    expect(RISK_TIER_SET.size).toBe(RISK_TIERS.length);
    for (const bad of ['bogus', 'REVIEW', '', 'Read', undefined, null, 3]) {
      expect(isRiskTier(bad)).toBe(false);
    }
  });

  it('LOCKSTEP: every tier has a rank AND a label (no drift between ladder / rank / labels)', () => {
    for (const tier of RISK_TIERS) {
      expect(typeof RISK_TIER_RANK[tier]).toBe('number');
      expect(typeof RISK_TIER_LABELS[tier]).toBe('string');
      expect(RISK_TIER_LABELS[tier].length).toBeGreaterThan(0);
    }
    // the label / rank maps carry NO key beyond the ladder
    expect(Object.keys(RISK_TIER_LABELS).sort()).toEqual([...RISK_TIERS].sort());
    expect(Object.keys(RISK_TIER_RANK).sort()).toEqual([...RISK_TIERS].sort());
  });

  it('pins the display labels (title-case)', () => {
    expect(RISK_TIER_LABELS).toEqual({
      read: 'Read',
      write: 'Write',
      admin: 'Admin',
      destructive: 'Destructive',
    });
  });

  it('riskTierLabel: known tier → its label; unknown string → title-case fallback', () => {
    expect(riskTierLabel('admin')).toBe('Admin');
    expect(riskTierLabel('read')).toBe('Read');
    // fallback mirrors the retired `RISK_LABEL[r] ?? capitalize(r)` accessor
    expect(riskTierLabel('mystery')).toBe('Mystery');
    expect(riskTierLabel('')).toBe('');
  });
});
