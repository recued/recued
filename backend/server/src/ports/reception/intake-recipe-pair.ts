/** D-200 Slice 6g.2 — source-checked resolution of a persisted intake pair. */

import {
  isReceptionFormPairBinding,
  receptionPairBindingEquals,
  recipeOutputSections,
  type IntakeFormConfig,
  type ReceptionFormPairBinding,
  type RecipeDefinition,
} from '@recued/contracts';
import type { ReceptionIntakeRecipePairStore } from '../../storage/reception-intake-recipe-pair-store.js';

export type ReceptionIntakeRecipePairResolution =
  | { readonly kind: 'unpaired' }
  | {
      readonly kind: 'ready';
      readonly binding: ReceptionFormPairBinding;
      /** D-207 slice 2c — does this pair's recipe declare output blocks?
       *
       *  It decides whether a REJECTED submission on this form may still be told
       *  "Submission received". A form whose response carries a product — a
       *  checkout button, a quote — cannot hide its anti-spam outcome from a bot
       *  anyway: the product's ABSENCE is the tell. So the silence buys nothing
       *  there, and its only remaining victim is the human (a domain-rejected
       *  visitor, or a real person whose password manager filled the honeypot)
       *  who is thanked and never heard from again. On such a form, rejection
       *  becomes honest. On a plain D-149 form the response carries nothing, the
       *  silence still works, and it is left exactly as it was.
       *
       *  ⛔ Derived with `recipeOutputSections` — the SAME rule the engine uses to
       *  build `output.render`. A second rule here could disagree with the engine
       *  about whether this recipe renders, and would then fire (or fail to fire)
       *  on the wrong forms. */
      readonly renders_response: boolean;
    }
  | { readonly kind: 'stale' };

export type ReceptionIntakeRecipePairDerivation =
  | {
      readonly kind: 'ready';
      readonly binding: ReceptionFormPairBinding;
    }
  | { readonly kind: 'recipe_invalid' }
  | { readonly kind: 'pair_incompatible' };

/** Resolve only when the compact row still matches both current source
 * snapshots. A missing row means ordinary generic intake; any corrupt row,
 * missing recipe, or form/recipe drift is explicitly stale and must not
 * silently fall back to unpaired submission behavior. */
export const resolveReceptionIntakeRecipePair = (input: {
  readonly endpoint_id: string;
  readonly form_config: IntakeFormConfig;
  readonly store: ReceptionIntakeRecipePairStore;
  readonly getRecipe: (recipe_id: string) => RecipeDefinition | null;
  readonly deriveBinding: (input: {
    readonly form_config: IntakeFormConfig;
    readonly recipe: RecipeDefinition;
  }) => ReceptionIntakeRecipePairDerivation;
}): ReceptionIntakeRecipePairResolution => {
  try {
    const stored = input.store.findByEndpoint(input.endpoint_id);
    if (stored === null) return { kind: 'unpaired' };
    // D-210 R-2 — the store is general since the owner-ruled rebuild; this resolver is
    // the INTAKE one and its whole job is proving a stored pair still matches the FORM
    // the visitor is being shown. A scheduling pair (v3) on an intake endpoint is a kind
    // mismatch that no form snapshot can ever re-derive, so it is `stale` — never
    // `unpaired`, which would silently fall back to generic intake behaviour on an
    // endpoint the owner believes is paired.
    if (!isReceptionFormPairBinding(stored.binding)) return { kind: 'stale' };
    const recipe = input.getRecipe(stored.binding.recipe_id);
    if (recipe === null) return { kind: 'stale' };
    const current = input.deriveBinding({
      form_config: input.form_config,
      recipe,
    });
    if (current.kind !== 'ready'
      || !receptionPairBindingEquals(
        stored.binding,
        current.binding,
      )) {
      return { kind: 'stale' };
    }
    // The recipe is already in hand — this resolver read it to prove the stored
    // binding still matches its current snapshot — so whether it renders costs
    // nothing extra to answer, and answering it HERE means the answer is always
    // re-derived from the recipe that will actually process this submission. A
    // column cached at bind could go stale against a recipe edited afterwards;
    // this cannot, because a drifted recipe never reaches this line (it returns
    // `stale` above).
    return {
      kind: 'ready',
      binding: { ...stored.binding },
      renders_response: recipeOutputSections(recipe).length > 0,
    };
  } catch {
    return { kind: 'stale' };
  }
};
