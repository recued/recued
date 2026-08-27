/** Typed hierarchy for Kitchen's sibling recipe and ingredient-pack editors. */

import {
  hierarchicalAddress,
  hierarchicalLevel,
  type HierarchicalAddress,
} from '../shell/hierarchical-navigation.js';
import type { KitchenNewRecipeSeed, ShellRoute } from '../shell/route.js';

export type KitchenAddress =
  | { readonly kind: 'pack'; readonly draftId: string | null }
  | { readonly kind: 'recipe'; readonly recipeId: string }
  | { readonly kind: 'new-recipe'; readonly seed: KitchenNewRecipeSeed };

export const kitchenPackAddress = (
  draftId?: string | null,
): HierarchicalAddress => hierarchicalAddress(
  'kitchen',
  hierarchicalLevel('kitchen-surface:pack', 'pack'),
  ...(draftId === undefined || draftId === null || draftId.trim().length === 0
    ? []
    : [hierarchicalLevel(`kitchen-draft:${draftId}`, draftId)]),
);

export const kitchenRecipeAddress = (
  recipeId: string,
): HierarchicalAddress => hierarchicalAddress(
  'kitchen',
  hierarchicalLevel('kitchen-surface:recipe', 'recipe'),
  hierarchicalLevel(`kitchen-recipe:${recipeId}`, recipeId),
);

export const kitchenNewRecipeAddress = (
  seed: KitchenNewRecipeSeed,
): HierarchicalAddress => hierarchicalAddress(
  'kitchen',
  hierarchicalLevel('kitchen-surface:recipe', 'new'),
  hierarchicalLevel(
    `kitchen-seed:${seed.kind}`,
    seed.kind === 'form_response' ? 'form-response' : 'execution-case',
  ),
  hierarchicalLevel(
    `kitchen-seed-value:${seed.kind === 'form_response'
      ? seed.form_definition_id
      : seed.draft_key}`,
    seed.kind === 'form_response' ? seed.form_definition_id : seed.draft_key,
  ),
);

export const parseKitchenAddress = (route: ShellRoute): KitchenAddress | null => {
  if (route.surface !== 'kitchen') return null;
  const surface = route.segments[0];
  const id = route.segments[1];
  if (surface === 'recipe' && typeof id === 'string' && id.trim().length > 0) {
    return { kind: 'recipe', recipeId: id };
  }
  if (
    surface === 'new'
    && route.segments.length === 3
    && typeof route.segments[2] === 'string'
    && route.segments[2]!.trim().length > 0
  ) {
    if (id === 'form-response') {
      return {
        kind: 'new-recipe',
        seed: {
          kind: 'form_response',
          form_definition_id: route.segments[2]!,
        },
      };
    }
    if (id === 'execution-case') {
      return {
        kind: 'new-recipe',
        seed: { kind: 'execution_case', draft_key: route.segments[2]! },
      };
    }
  }
  return {
    kind: 'pack',
    draftId: surface === 'pack'
      && typeof id === 'string'
      && id.trim().length > 0
        ? id
        : null,
  };
};

export const kitchenHierarchicalAddress = (
  address: KitchenAddress,
): HierarchicalAddress => {
  if (address.kind === 'recipe') return kitchenRecipeAddress(address.recipeId);
  if (address.kind === 'new-recipe') return kitchenNewRecipeAddress(address.seed);
  return kitchenPackAddress(address.draftId);
};
