/** Typed hierarchy for Kitchen's sibling recipe and ingredient-pack editors. */

import {
  hierarchicalAddress,
  hierarchicalLevel,
  type HierarchicalAddress,
} from '../shell/hierarchical-navigation.js';
import type { KitchenNewRecipeSeed, ShellRoute } from '../shell/route.js';

export type KitchenAddress =
  /** D-333 — Kitchen home: New recipe, New pack and the work in progress. */
  | { readonly kind: 'home' }
  /** D-333 — a new recipe; it becomes an item of work in progress at its first change. */
  | { readonly kind: 'start-recipe' }
  | { readonly kind: 'import'; readonly draftId: string }
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

export const kitchenHomeAddress = (): HierarchicalAddress => hierarchicalAddress('kitchen');

export const kitchenStartRecipeAddress = (): HierarchicalAddress => hierarchicalAddress(
  'kitchen',
  hierarchicalLevel('kitchen-surface:recipe', 'new'),
  hierarchicalLevel('kitchen-start:recipe', 'recipe'),
);

/** An item of work in progress, wherever it came from (the route keeps its first name). */
export const kitchenWorkItemAddress = (draftId: string): HierarchicalAddress => hierarchicalAddress(
  'kitchen',
  hierarchicalLevel('kitchen-surface:import', 'import'),
  hierarchicalLevel(`kitchen-import:${draftId}`, draftId),
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
  if (route.segments.length === 0) return { kind: 'home' };
  const surface = route.segments[0];
  if (surface === 'new' && route.segments[1] === 'recipe' && route.segments.length === 2) return { kind: 'start-recipe' };
  if (surface === 'import' && route.segments[1]?.trim()) return { kind: 'import', draftId: route.segments[1] };
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
  if (address.kind === 'home') return kitchenHomeAddress();
  if (address.kind === 'start-recipe') return kitchenStartRecipeAddress();
  if (address.kind === 'import') return kitchenWorkItemAddress(address.draftId);
  if (address.kind === 'recipe') return kitchenRecipeAddress(address.recipeId);
  if (address.kind === 'new-recipe') return kitchenNewRecipeAddress(address.seed);
  return kitchenPackAddress(address.draftId);
};
