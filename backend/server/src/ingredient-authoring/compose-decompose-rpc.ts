/** D-170 #2 - `ingredient.compose.decompose` rpc handler.
 *
 *  Drafts may be saved while incomplete; this method is the boundary that
 *  validates one draft body, returns validator issues for invalid compositions,
 *  and, for valid compositions, returns the decomposed artifacts plus the
 *  `compileForReview` projection used by the install review UI. It is folded
 *  into `IngredientDraftRpcDeps` because it operates on the same per-pair draft
 *  store and should ride the same WS/server forward path. */

import {
  type AuthoringValidationIssue,
  type CompositionDecomposeArgs,
  type CompositionDecomposeArtifacts,
  type CompositionDecomposeResult,
  type CompositionReviewView,
} from '@recued/contracts';
import {
  compileForReview,
  validateComposition,
  type DecomposedArtifacts,
} from '@recued/ingredient-authoring';
import { validateRecipe } from '@recued/recipes';

import type { DraftStore } from './draft-store.js';

export interface CompositionDecomposeDeps {
  draftStore: Pick<DraftStore, 'get'>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isDecomposedArtifacts = (value: unknown): value is DecomposedArtifacts =>
  isPlainObject(value)
  && !Object.prototype.hasOwnProperty.call(value, 'contents');

const toArtifacts = (
  decomposed: DecomposedArtifacts,
): CompositionDecomposeArtifacts => ({
  ...(decomposed.ingredient ? { ingredient: decomposed.ingredient } : {}),
  ...(decomposed.catalog ? { catalog: decomposed.catalog } : {}),
  entity_schemas: decomposed.entity_schemas ?? [],
  operation_groups: decomposed.operation_groups ?? [],
  default_grants: decomposed.default_grants ?? [],
});

const issues = (
  values: readonly AuthoringValidationIssue[],
): AuthoringValidationIssue[] => [...values];

export const handleCompositionDecompose = (
  deps: CompositionDecomposeDeps,
  args: CompositionDecomposeArgs,
): CompositionDecomposeResult => {
  if (!isPlainObject(args) || typeof args.draft_id !== 'string' || args.draft_id === '') {
    return {
      ok: false,
      code: 'bad_request',
      message: 'ingredient.compose.decompose: draft_id is required',
      issues: [],
    };
  }
  const draft = deps.draftStore.get(args.draft_id);
  if (!draft) {
    return {
      ok: false,
      code: 'draft_not_found',
      message: `no draft '${args.draft_id}'`,
      issues: [],
    };
  }

  const validation = validateComposition(draft.body, { recipeValidator: validateRecipe });
  const review = compileForReview(draft.body) as CompositionReviewView;
  if (!validation.valid || !isDecomposedArtifacts(validation.decomposed)) {
    return {
      ok: false,
      code: 'validation_failed',
      message: 'draft composition failed validation',
      issues: issues(validation.issues),
      review,
    };
  }

  return {
    ok: true,
    draft_id: draft.draft_id,
    artifacts: toArtifacts(validation.decomposed),
    review,
  };
};
