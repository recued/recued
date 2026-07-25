/** D-202 Slice 0 — the quality-delegation PURE substrate: the coarse
 *  (recipe, op)-grain matcher, the Switch A/B kill-switch resolvers, the
 *  three-conjunct send gate, and the reserved reason-code training predicate.
 *
 *  These lock the definitional invariants (§12) the whole trust posture rests
 *  on, independent of any (unbuilt) learner: a quality delegation never grants
 *  authority (§12.1), the whole-document conjunct is never skipped (§12.2), only
 *  default-reason verdicts train (§12.3), and the kill-switch suppresses without
 *  touching state (§12.12). */

import { describe, expect, it } from 'vitest';

import {
  authorizationDelegationPaused,
  evaluateThreeConjunctGate,
  matchesQualityDelegation,
  NO_QUALITY_GATE_PAUSE,
  qualityDelegationPaused,
  QUALITY_DELEGATION_GRANT_KIND,
  reasonTrainsQuality,
  type ContractDefinition,
  type QualityDelegationMatchContext,
  type QualityGateSwitches,
  type ThreeConjunctGateInputs,
} from '@recued/contracts';

const NOW_MS = 1_800_000_000_000;

const baseQualityGrant = (
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => ({
  contract_id: 'ct_quality_1',
  minted_at: NOW_MS - 1_000,
  minted_by: 'owner:user-1',
  display_name: 'Auto-accept delivery quality',
  scope: {
    channels: ['chat'],
    actors: ['user_self'],
    ingredient_ids: ['mail.send'],
    operation_ids: ['mail.send'],
    connection_names: ['gmail-primary'],
  },
  grant_kind: QUALITY_DELEGATION_GRANT_KIND,
  bound_recipe: {
    recipe_id: 'recipe-1',
    recipe_hash: 'recipe-hash-1',
  },
  // A quality delegation MAY be standing; give it an expiry so the "active"
  // fixtures are unambiguous. The "standing (no bounds)" case is exercised
  // explicitly below.
  expiry_at: NOW_MS + 60_000,
  ...overrides,
});

const baseCtx = (
  overrides: Partial<QualityDelegationMatchContext> = {},
): QualityDelegationMatchContext => ({
  ingredient_slug: 'mail.send',
  operation_id: 'mail.send',
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  ...overrides,
});

const withoutGrantKeys = (
  grant: ContractDefinition,
  keys: readonly (keyof ContractDefinition)[],
): ContractDefinition => {
  const copy = { ...grant } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as unknown as ContractDefinition;
};

const matches = (
  grant: ContractDefinition,
  ctx: QualityDelegationMatchContext = baseCtx(),
): boolean => matchesQualityDelegation(grant, ctx, NOW_MS);

// ════════════════════════════════════════════════════════════════
// matchesQualityDelegation — coarse (recipe, op) grain, fail-closed
// ════════════════════════════════════════════════════════════════

describe('D-202 matchesQualityDelegation — happy path + grant_kind fence', () => {
  it('admits an active quality delegation for the matching (recipe, op)', () => {
    expect(matches(baseQualityGrant())).toBe(true);
  });

  it('admits a STANDING quality delegation (no expiry / no use budget)', () => {
    // Unlike the authorization gate grants (bounded by construction), a quality
    // delegation may be standing — governed by the ladder + kill-switch, not a
    // use budget. isContractActive treats absent bounds as unbounded-active.
    const standing = withoutGrantKeys(baseQualityGrant(), [
      'expiry_at',
      'max_uses',
      'uses_remaining',
    ]);
    expect(matches(standing)).toBe(true);
  });

  it('fails closed on every non-quality grant_kind (disjoint vocabulary)', () => {
    for (const kind of [
      'standing',
      'session',
      'delegation',
      'customer_template',
      'customer_instance',
    ] as const) {
      expect(matches(baseQualityGrant({ grant_kind: kind }))).toBe(false);
    }
    // Absent grant_kind (= a legacy standing row) is also inert on this axis.
    expect(matches(withoutGrantKeys(baseQualityGrant(), ['grant_kind']))).toBe(false);
  });
});

describe('D-202 matchesQualityDelegation — lifecycle', () => {
  it('rejects a revoked / expired / exhausted grant', () => {
    expect(matches(baseQualityGrant({ revoked_at: NOW_MS - 10 }))).toBe(false);
    expect(matches(baseQualityGrant({ expiry_at: NOW_MS - 10 }))).toBe(false);
    expect(matches(baseQualityGrant({ uses_remaining: 0 }))).toBe(false);
  });
});

describe('D-202 matchesQualityDelegation — recipe identity (whole-template reset, v1)', () => {
  it('rejects a recipe_id or recipe_hash mismatch (content drift re-asks)', () => {
    expect(matches(baseQualityGrant(), baseCtx({ recipe_id: 'recipe-2' }))).toBe(false);
    expect(matches(baseQualityGrant(), baseCtx({ recipe_hash: 'recipe-hash-2' }))).toBe(
      false,
    );
  });

  it('rejects a grant missing bound_recipe, and a recipe-less dispatch', () => {
    expect(matches(withoutGrantKeys(baseQualityGrant(), ['bound_recipe']))).toBe(false);
    expect(
      matches(baseQualityGrant(), baseCtx({ recipe_id: undefined, recipe_hash: undefined })),
    ).toBe(false);
  });
});

describe('D-202 matchesQualityDelegation — op grain', () => {
  it('requires the ingredient axis to EXPLICITLY name the slug (never wildcard)', () => {
    // Empty ingredient axis is a wildcard for standing contracts but NEVER for a
    // gate grant — else a quality grant leaks across tools sharing a recipe.
    const wildcardIngredient = baseQualityGrant({
      scope: { ingredient_ids: [], operation_ids: ['mail.send'] },
    });
    expect(matches(wildcardIngredient)).toBe(false);

    const wrongIngredient = baseQualityGrant({
      scope: { ingredient_ids: ['deal.update'], operation_ids: ['mail.send'] },
    });
    expect(matches(wrongIngredient)).toBe(false);
  });

  it('treats an empty operation axis as wildcard-any-op under the ingredient', () => {
    const anyOp = baseQualityGrant({
      scope: { ingredient_ids: ['mail.send'], operation_ids: [] },
    });
    expect(matches(anyOp)).toBe(true);
    // ...even when the dispatch carries no operation_id at all.
    expect(matches(anyOp, baseCtx({ operation_id: undefined }))).toBe(true);
  });

  it('fails closed when a restricted operation axis is not satisfied', () => {
    const restricted = baseQualityGrant({
      scope: { ingredient_ids: ['mail.send'], operation_ids: ['mail.send'] },
    });
    expect(matches(restricted, baseCtx({ operation_id: 'mail.draft' }))).toBe(false);
    // A restricted op axis with NO op on the dispatch cannot be satisfied.
    expect(matches(restricted, baseCtx({ operation_id: undefined }))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// Switch A/B — the kill-switch as a gate-override (§4)
// ════════════════════════════════════════════════════════════════

describe('D-202 Switch A/B resolvers', () => {
  it('the default pauses nothing', () => {
    expect(authorizationDelegationPaused(NO_QUALITY_GATE_PAUSE)).toBe(false);
    expect(qualityDelegationPaused(NO_QUALITY_GATE_PAUSE)).toBe(false);
  });

  it('Switch A pauses BOTH axes', () => {
    const switchA: QualityGateSwitches = { all_paused: true, quality_paused: false };
    expect(authorizationDelegationPaused(switchA)).toBe(true);
    expect(qualityDelegationPaused(switchA)).toBe(true);
  });

  it('Switch B pauses the quality axis ONLY (authorization stays live)', () => {
    const switchB: QualityGateSwitches = { all_paused: false, quality_paused: true };
    expect(authorizationDelegationPaused(switchB)).toBe(false);
    expect(qualityDelegationPaused(switchB)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// evaluateThreeConjunctGate — send iff authz ∧ quality ∧ whole-document
// ════════════════════════════════════════════════════════════════

const gate = (overrides: Partial<ThreeConjunctGateInputs> = {}) =>
  evaluateThreeConjunctGate({
    authorization: 'admit',
    qualityDelegationMatches: true,
    switches: NO_QUALITY_GATE_PAUSE,
    wholeDocumentPasses: true,
    ...overrides,
  });

describe('D-202 evaluateThreeConjunctGate — authorization is independent (§12.1)', () => {
  it('denies on authorization deny, regardless of a matching quality delegation', () => {
    expect(gate({ authorization: 'deny' })).toEqual({
      verdict: 'deny',
      reason: 'authorization_denied',
    });
  });

  it('reviews on authorization ask — quality never subsumes authorization', () => {
    // Even with quality fully delegated + un-paused, an authz 'ask' still routes
    // to the owner: a quality delegation NEVER grants authority to send.
    expect(
      gate({ authorization: 'ask', qualityDelegationMatches: true }),
    ).toEqual({ verdict: 'review', reason: 'authorization_ask' });
  });
});

describe('D-202 evaluateThreeConjunctGate — quality conjunct', () => {
  it('sends when all three conjuncts pass', () => {
    expect(gate()).toEqual({ verdict: 'send', reason: 'all_conjuncts_pass' });
  });

  it('reviews when authorization admits but no quality delegation matches', () => {
    expect(gate({ qualityDelegationMatches: false })).toEqual({
      verdict: 'review',
      reason: 'quality_not_delegated',
    });
  });

  it('reviews when quality matches but the axis is paused (Switch A or B)', () => {
    const switchA: QualityGateSwitches = { all_paused: true, quality_paused: false };
    const switchB: QualityGateSwitches = { all_paused: false, quality_paused: true };
    expect(gate({ switches: switchA })).toEqual({
      verdict: 'review',
      reason: 'quality_not_delegated',
    });
    expect(gate({ switches: switchB })).toEqual({
      verdict: 'review',
      reason: 'quality_not_delegated',
    });
  });
});

describe('D-202 evaluateThreeConjunctGate — whole-document is never skipped (§12.2)', () => {
  it('reviews when authz admits + quality delegated + un-paused, but whole-doc flags', () => {
    expect(gate({ wholeDocumentPasses: false })).toEqual({
      verdict: 'review',
      reason: 'whole_document_flagged',
    });
  });
});

// ════════════════════════════════════════════════════════════════
// reasonTrainsQuality — only default-reason verdicts train (§12.3)
// ════════════════════════════════════════════════════════════════

describe('D-202 reasonTrainsQuality (reserved for the Slice 1 learner)', () => {
  it('trains on the two DEFAULT reasons, never on the overrides', () => {
    expect(reasonTrainsQuality('quality_bad')).toBe(true);
    expect(reasonTrainsQuality('quality_good')).toBe(true);
    expect(reasonTrainsQuality('policy')).toBe(false);
    expect(reasonTrainsQuality('ship_anyway')).toBe(false);
  });
});
