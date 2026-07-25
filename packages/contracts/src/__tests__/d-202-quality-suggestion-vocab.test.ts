/** D-202 Task 5A — the pure quality-suggestion vocab: key-hash identity + the
 *  accept-side mint-plan's fail-closed projection. */

import { describe, expect, it } from 'vitest';

import {
  qualityDelegationMintPlanFromSnapshot,
  qualityDelegationSuggestionKeyHash,
  type QualityDelegationSuggestionSnapshot,
} from '@recued/contracts';

const snap = (
  o: Partial<QualityDelegationSuggestionSnapshot> = {},
): QualityDelegationSuggestionSnapshot => ({
  recipe_id: 'recipe-1',
  recipe_hash: 'recipe-hash-1',
  ingredient_id: 'deliver-doc',
  operation_id: 'deliver-doc.send',
  ...o,
});

describe('D-202 qualityDelegationSuggestionKeyHash', () => {
  it('is stable for the same key, and discriminates recipe_hash + op presence', () => {
    expect(qualityDelegationSuggestionKeyHash(snap())).toBe(
      qualityDelegationSuggestionKeyHash(snap()),
    );
    expect(qualityDelegationSuggestionKeyHash(snap({ recipe_hash: 'h2' }))).not.toBe(
      qualityDelegationSuggestionKeyHash(snap()),
    );
    // op absent vs present hashes differently (both-absent-or-equal at the matcher).
    expect(
      qualityDelegationSuggestionKeyHash(snap({ operation_id: undefined })),
    ).not.toBe(qualityDelegationSuggestionKeyHash(snap()));
    // display_name is NOT part of the key.
    expect(qualityDelegationSuggestionKeyHash(snap({ display_name: 'x' }))).toBe(
      qualityDelegationSuggestionKeyHash(snap()),
    );
  });
});

describe('D-202 qualityDelegationMintPlanFromSnapshot', () => {
  it('projects an owner-provenance scope + bound_recipe', () => {
    const plan = qualityDelegationMintPlanFromSnapshot(snap());
    expect(plan).toEqual({
      scope: {
        actors: ['user_self'],
        ingredient_ids: ['deliver-doc'],
        operation_ids: ['deliver-doc.send'],
      },
      bound_recipe: { recipe_id: 'recipe-1', recipe_hash: 'recipe-hash-1' },
    });
  });

  it('omits the operation axis when the snapshot carries no op (any op under the ingredient)', () => {
    const plan = qualityDelegationMintPlanFromSnapshot(snap({ operation_id: undefined }));
    expect(plan?.scope.operation_ids).toBeUndefined();
    expect(plan?.scope.ingredient_ids).toEqual(['deliver-doc']);
  });

  it('fails closed on empty recipe identity / ingredient / an empty-string op', () => {
    expect(qualityDelegationMintPlanFromSnapshot(snap({ recipe_id: '' }))).toBeUndefined();
    expect(qualityDelegationMintPlanFromSnapshot(snap({ recipe_hash: '' }))).toBeUndefined();
    expect(qualityDelegationMintPlanFromSnapshot(snap({ ingredient_id: '' }))).toBeUndefined();
    expect(qualityDelegationMintPlanFromSnapshot(snap({ operation_id: '' }))).toBeUndefined();
  });
});
