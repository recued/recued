import { describe, expect, it } from 'vitest';

import {
  kitchenHierarchicalAddress,
  kitchenNewRecipeAddress,
  kitchenPackAddress,
  kitchenRecipeAddress,
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

  it('parses current routes and canonicalizes a bare Kitchen route to pack', () => {
    expect(parseKitchenAddress(parseShellRoute('#kitchen/pack/d-1')))
      .toEqual({ kind: 'pack', draftId: 'd-1' });
    expect(parseKitchenAddress(parseShellRoute('#kitchen/recipe/r-1')))
      .toEqual({ kind: 'recipe', recipeId: 'r-1' });
    expect(kitchenHierarchicalAddress(
      parseKitchenAddress(parseShellRoute('#kitchen'))!,
    ).hash).toBe('#kitchen/pack');
  });
});
