/** D-170 #4 — `ingredient.saveAsNew` local publish handler.
 *
 *  Takes a saved composition draft, reuses the #2 decompose/validate path, and
 *  persists the compiled local manifest body to `local_manifest`. This is the
 *  local authoring save-as-new half only: no marketplace publish, inventory row,
 *  or live registry install side effect is created here. */

import type {
  AuthoringValidationIssue,
  CompositionDecomposeResult,
  IngredientSaveAsNewArgs,
  IngredientSaveAsNewResult,
} from '@recued/contracts';

import type { DraftStore } from './draft-store.js';
import type { LocalManifestStore } from './local-manifest-store.js';
import { handleCompositionDecompose } from './compose-decompose-rpc.js';

export interface IngredientSaveAsNewDeps {
  draftStore: Pick<DraftStore, 'get'>;
  localManifestStore: Pick<LocalManifestStore, 'getManifest' | 'put'>;
}

const warningsFrom = (
  issues: readonly AuthoringValidationIssue[],
): AuthoringValidationIssue[] =>
  issues.filter((issue) => issue.severity !== 'error');

const mapDecomposeFailure = (
  result: Extract<CompositionDecomposeResult, { ok: false }>,
): Extract<IngredientSaveAsNewResult, { ok: false }> => ({
  ok: false,
  code: result.code,
  message: result.message,
  issues: [...result.issues],
  ...(result.review ? { review: result.review } : {}),
});

export const handleIngredientSaveAsNew = (
  deps: IngredientSaveAsNewDeps,
  args: IngredientSaveAsNewArgs,
): IngredientSaveAsNewResult => {
  const decomposed = handleCompositionDecompose(
    { draftStore: deps.draftStore },
    args,
  );
  if (decomposed.ok === false) return mapDecomposeFailure(decomposed);

  const manifest = decomposed.artifacts.catalog ?? decomposed.artifacts.ingredient;
  if (manifest === undefined) {
    return {
      ok: false,
      code: 'unexpected',
      message: 'composition decomposed to no local manifest',
      issues: [],
      review: decomposed.review,
    };
  }

  if (deps.localManifestStore.getManifest(manifest.slug) !== null) {
    return {
      ok: false,
      code: 'slug_conflict',
      message: `local ingredient '${manifest.slug}' already exists; choose a different draft slug before saveAsNew`,
      issues: [],
      review: decomposed.review,
    };
  }

  try {
    deps.localManifestStore.put({
      manifest,
      entity_schemas: decomposed.artifacts.entity_schemas,
    });
  } catch (error) {
    return {
      ok: false,
      code: 'unexpected',
      message: error instanceof Error ? error.message : String(error),
      issues: [],
      review: decomposed.review,
    };
  }

  return {
    ok: true,
    draft_id: decomposed.draft_id,
    saved: {
      ingredient_id: manifest.slug,
      version: manifest.version ?? 1,
      kind: decomposed.artifacts.catalog ? 'catalog' : 'ingredient',
      entity_schema_count: decomposed.artifacts.entity_schemas.length,
      operation_group_count: decomposed.artifacts.operation_groups.length,
      default_grant_count: decomposed.artifacts.default_grants.length,
    },
    manifest,
    warnings: warningsFrom(decomposed.review.issues),
    review: decomposed.review,
  };
};
