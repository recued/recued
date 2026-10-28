import { describe, expect, it } from 'vitest';

import {
  kitchenHierarchicalAddress,
  kitchenHomeAddress,
  kitchenNewRecipeAddress,
  kitchenPackAddress,
  kitchenRecipeAddress,
  kitchenStartRecipeAddress,
  kitchenWorkItemAddress,
  parseKitchenAddress,
} from '../kitchen-navigation.js';
import { parseShellRoute } from '../../shell/route.js';

describe('Kitchen hierarchical navigation contract', () => {
  it('models pack workspace -> saved draft depth', () => {
    expect(kitchenPackAddress().hash).toBe('#kitchen/pack');
    expect(kitchenPackAddress('draft/one').hash)
      .toBe('#kitchen/pack/draft%2Fone');
    expect(kitchenPackAddress('draft/one').levels).toHaveLength(2);
  });

  it('keeps recipe and generated draft seeds as typed sibling places', () => {
    expect(kitchenRecipeAddress('recipe/one').hash)
      .toBe('#kitchen/recipe/recipe%2Fone');
    expect(kitchenNewRecipeAddress({
      kind: 'form_response',
      form_definition_id: 'lead/form',
    }).hash).toBe('#kitchen/new/form-response/lead%2Fform');
  });

  it('parses current routes; a bare Kitchen route is the home and stays bare (D-333)', () => {
    expect(parseKitchenAddress(parseShellRoute('#kitchen/pack/d-1')))
      .toEqual({ kind: 'pack', draftId: 'd-1' });
    expect(parseKitchenAddress(parseShellRoute('#kitchen/recipe/r-1')))
      .toEqual({ kind: 'recipe', recipeId: 'r-1' });
    expect(parseKitchenAddress(parseShellRoute('#kitchen'))).toEqual({ kind: 'home' });
    expect(kitchenHierarchicalAddress({ kind: 'home' }).hash).toBe('#kitchen');
    expect(kitchenHomeAddress().hash).toBe('#kitchen');
  });

  it('gives a new recipe and an item of work in progress their own places (D-333)', () => {
    expect(parseKitchenAddress(parseShellRoute('#kitchen/new/recipe'))).toEqual({ kind: 'start-recipe' });
    expect(kitchenHierarchicalAddress({ kind: 'start-recipe' }).hash).toBe('#kitchen/new/recipe');
    expect(kitchenStartRecipeAddress().hash).toBe('#kitchen/new/recipe');
    // A seeded new recipe has three segments, so it never reads as a plain new recipe.
    expect(parseKitchenAddress(parseShellRoute('#kitchen/new/form-response/lead')))
      .toEqual({ kind: 'new-recipe', seed: { kind: 'form_response', form_definition_id: 'lead' } });
    expect(parseKitchenAddress(parseShellRoute('#kitchen/import/w-1'))).toEqual({ kind: 'import', draftId: 'w-1' });
    expect(kitchenWorkItemAddress('w/1').hash).toBe('#kitchen/import/w%2F1');
    expect(kitchenHierarchicalAddress({ kind: 'import', draftId: 'w-1' }).hash).toBe('#kitchen/import/w-1');
  });
});
