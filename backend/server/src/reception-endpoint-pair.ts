/** The pair binding an endpoint derives with a recipe — shared by the Reception rpcs and
 *  (D-299) the pack update that keeps a pair alive across a recipe change. Moved out of
 *  `reception-rpc-handler.ts` so the update path reads the SAME derivation the pair's own
 *  runtime consumer does, without importing the whole rpc surface. */

import type {
  EndpointSummary,
  IntakeFormConfig,
  ReceptionPairBinding,
  RecipeDefinition,
} from '@recued/contracts';

import { parseIntakeFormConfig } from './ports/reception/transformations/intake-form.js';
import { parseSchedulingLinkConfig } from './ports/reception/transformations/scheduling-link.js';
import { deriveReceptionIntakeRecipePairBinding } from './reception-intake-recipe-pair-derivation.js';
import { deriveReceptionSchedulingRecipePairBinding } from './reception-scheduling-recipe-pair-derivation.js';

/** D-210 R-2 slice 4 — derive the pair binding for ONE endpoint, whatever kind it is.
 *
 *  The kind fork lives HERE, once, because a pair's subject is per-kind but everything the
 *  rpcs do with the result — compare it to the stored row, prove the recipe id, mint the door
 *  from its closure — is not. The deriver a kind gets is the SAME one its runtime consumer
 *  re-derives with (`resolveReceptionIntakeRecipePair` for a form, the drain's
 *  `resolveReceptionSchedulingRecipePair` for a booking), which is what keeps a bind from
 *  writing a row its own consumer would immediately read as `stale`.
 *
 *  `config_incompatible` is distinct from `pair_incompatible`: the ENDPOINT's own config is
 *  unusable (unparseable, or a form whose declared source disagrees with it), rather than a
 *  usable config that cannot pair with this recipe. */
export type EndpointPairDerivation =
  | { readonly kind: 'ready'; readonly binding: ReceptionPairBinding }
  | { readonly kind: 'recipe_invalid' }
  | { readonly kind: 'pair_incompatible' }
  | { readonly kind: 'config_incompatible' };

export const deriveEndpointPairBinding = (
  endpoint: EndpointSummary,
  recipe: RecipeDefinition,
): EndpointPairDerivation => {
  switch (endpoint.kind) {
    case 'intake_form': {
      const config = intakePairConfigFor(endpoint);
      if (config === null) return { kind: 'config_incompatible' };
      return deriveReceptionIntakeRecipePairBinding({ form_config: config, recipe });
    }
    case 'scheduling_link': {
      const config = parseSchedulingLinkConfig(endpoint.metadata);
      if (config === null) return { kind: 'config_incompatible' };
      // ⛔ `required_visitor_fields` ONLY — the owner-ruled digest subject. Durations,
      // windows and copy change what the VISITOR sees, never what the recipe RECEIVES.
      return deriveReceptionSchedulingRecipePairBinding({
        required_visitor_fields: config.required_visitor_fields,
        recipe,
      });
    }
    default:
      // Unreachable through `requirePairableEndpoint`, which refuses every kind with no
      // consumer. Fail closed rather than assume the two lists agree.
      return { kind: 'config_incompatible' };
  }
};

export const intakePairConfigFor = (
  endpoint: EndpointSummary,
): IntakeFormConfig | null => {
  const config = parseIntakeFormConfig(endpoint.metadata);
  if (config === null) return null;
  const declaration = endpoint.packet_declaration;
  const source = declaration.source_query_ref;
  if (declaration.packet_kind !== 'intake_form_packet'
    || source.kind !== 'reception_form_definition'
    || source.form_definition_id !== config.form_definition.form_definition_id) {
    return null;
  }
  return config;
};
