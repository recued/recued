/** D-210 R-2 — source-checked resolution of a persisted SCHEDULING pair.
 *
 *  The scheduling sibling of `intake-recipe-pair.ts`. Same posture, one different subject:
 *  a `scheduling_link` endpoint has no form, so what the paired recipe RECEIVES is fixed by
 *  the closed `required_visitor_fields` map plus the slot the visitor picked. That map is
 *  therefore the whole config half of the digest (owner-ruled 2026-07-17 —
 *  `receptionSchedulingPairBinding` carries the reasoning).
 *
 *  ## Why `stale` is a HOLD here, not a fallback
 *
 *  For intake, `stale` means "do not treat this row as paired" and the visitor gets generic
 *  intake. For scheduling there is no generic behaviour to fall back TO: the alternative is
 *  the pack's compiled default recipe, which materializes a calendar event. Silently taking
 *  it would run the recipe the owner did NOT choose, on a booking, and write an artifact —
 *  the exact substitution the pair exists to prevent. So a drifted pair leaves the booking
 *  PENDING (retryable; it dispatches once the owner re-binds) rather than dispatching the
 *  default. The caller owns that decision; this module only names the state.
 *
 *  ⚠ No `renders_response` here, and the absence is structural rather than an oversight.
 *  Intake resolves that because its pair runs INLINE at submit and its response may carry a
 *  product. Scheduling never auto-books (D-173 I-7) and runs from the DRAIN, after the
 *  visitor's success page has already been sent — there is no response left to render into,
 *  so there is nothing for the answer to gate.
 */

import {
  isReceptionSchedulingPairBinding,
  receptionPairBindingEquals,
  type ReceptionSchedulingPairBinding,
  type RecipeDefinition,
  type SchedulingLinkVisitorFieldRequirements,
} from '@recued/contracts';
import type { ReceptionIntakeRecipePairStore } from '../../storage/reception-intake-recipe-pair-store.js';

export type ReceptionSchedulingRecipePairResolution =
  | { readonly kind: 'unpaired' }
  | {
      readonly kind: 'ready';
      readonly binding: ReceptionSchedulingPairBinding;
    }
  | { readonly kind: 'stale' };

export type ReceptionSchedulingRecipePairDerivation =
  | {
      readonly kind: 'ready';
      readonly binding: ReceptionSchedulingPairBinding;
    }
  | { readonly kind: 'recipe_invalid' }
  | { readonly kind: 'pair_incompatible' };

/** Resolve only when the stored row still matches both current source snapshots — the
 *  endpoint's visitor-field map and the exact saved recipe. A missing row means an unpaired
 *  endpoint (the pack's default owns it); any corrupt row, missing recipe, or drift is
 *  explicitly `stale`.
 *
 *  ⚠ The store is GENERAL since the owner-ruled rebuild — it holds form pairs (v1/v2) and
 *  scheduling pairs (v3) alike, and its `intake` name is legacy (the store header says so).
 *  So this resolver must NARROW, exactly as its intake sibling does in the other direction:
 *  a FORM pair found on a scheduling endpoint is a kind mismatch that no visitor-field map
 *  can ever re-derive, and it reads `stale` — never `unpaired`, which would hand the booking
 *  to the pack's default on an endpoint the owner believes is paired. */
export const resolveReceptionSchedulingRecipePair = (input: {
  readonly endpoint_id: string;
  /** `null` when the endpoint's config blob does not parse. That is not a reason to treat a
   *  paired endpoint as unpaired — it is a source snapshot we cannot re-derive the binding
   *  from, which is the same state as a missing recipe: `stale`. An UNPAIRED endpoint with a
   *  corrupt config is unaffected and keeps its existing behaviour. */
  readonly required_visitor_fields: SchedulingLinkVisitorFieldRequirements | null;
  readonly store: Pick<ReceptionIntakeRecipePairStore, 'findByEndpoint'>;
  readonly getRecipe: (recipe_id: string) => RecipeDefinition | null;
  readonly deriveBinding: (input: {
    readonly required_visitor_fields: SchedulingLinkVisitorFieldRequirements;
    readonly recipe: RecipeDefinition;
  }) => ReceptionSchedulingRecipePairDerivation;
}): ReceptionSchedulingRecipePairResolution => {
  try {
    const stored = input.store.findByEndpoint(input.endpoint_id);
    if (stored === null) return { kind: 'unpaired' };
    if (!isReceptionSchedulingPairBinding(stored.binding)) return { kind: 'stale' };
    // Checked AFTER the row read on purpose: an unpaired endpoint with a corrupt config must
    // keep behaving exactly as it does today, so the config only matters once a pair exists.
    const requiredVisitorFields = input.required_visitor_fields;
    if (requiredVisitorFields === null) return { kind: 'stale' };
    const recipe = input.getRecipe(stored.binding.recipe_id);
    if (recipe === null) return { kind: 'stale' };
    const current = input.deriveBinding({
      required_visitor_fields: requiredVisitorFields,
      recipe,
    });
    if (current.kind !== 'ready'
      || !receptionPairBindingEquals(
        stored.binding,
        current.binding,
      )) {
      return { kind: 'stale' };
    }
    return { kind: 'ready', binding: { ...stored.binding } };
  } catch {
    // `findByEndpoint` THROWS on a corrupt binding blob rather than returning null. A
    // corrupt pair is not an unpaired endpoint.
    return { kind: 'stale' };
  }
};
