import type {
  BulkPackManifest,
  CompositionIngredient,
  CompositionSurface,
  EntityFieldPrivacy,
  OperationApproval,
  OperationRiskTier,
  PackCompositionContentRef,
  PackContentRef,
} from '@recued/contracts';
import type { DecomposedArtifacts, PackDecomposition } from './decomposer.js';
import {
  validateComposition,
  validatePack,
  type CompositionValidationIssue,
} from './validators.js';

export type ReviewArtifactShape = '1x1' | 'multi' | 'unknown';

export interface ReviewOperationFamily {
  key: string;
  surface: CompositionSurface;
  risk_tier: OperationRiskTier;
  approval_mapping: OperationApproval;
}

export interface ReviewFieldPrivacy {
  path: string;
  privacy_kind: EntityFieldPrivacy;
}

export interface CompositionReviewCounts {
  compositions: number;
  operation_families: number;
  entity_fields: number;
  pii_fields: number;
  pack_contents: number;
  compiled_outputs: number;
}

export interface CompositionReviewSummary {
  catalog_slug: string | null;
  catalog_slugs: string[];
  artifact_shape: ReviewArtifactShape;
  counts: CompositionReviewCounts;
}

export interface CompositionReviewView {
  valid: boolean;
  summary: CompositionReviewSummary;
  operation_families: ReviewOperationFamily[];
  field_privacy: ReviewFieldPrivacy[];
  issues: CompositionValidationIssue[];
}

interface ProjectedComposition {
  catalog_slug: string | null;
  shape: ReviewArtifactShape;
  operation_families: ReviewOperationFamily[];
  field_privacy: ReviewFieldPrivacy[];
  entity_field_count: number;
  compiled_outputs: number;
}

const emptyCounts = (): CompositionReviewCounts => ({
  compositions: 0,
  operation_families: 0,
  entity_fields: 0,
  pii_fields: 0,
  pack_contents: 0,
  compiled_outputs: 0,
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isLikelyPack = (body: unknown): body is BulkPackManifest =>
  isPlainObject(body)
  && !Object.prototype.hasOwnProperty.call(body, 'schema_version')
  && (
    Object.prototype.hasOwnProperty.call(body, 'manifest_version')
    || Object.prototype.hasOwnProperty.call(body, 'contents')
    || Object.prototype.hasOwnProperty.call(body, 'publisher')
    || Object.prototype.hasOwnProperty.call(body, 'pack_kind')
  );

const isCompositionRef = (content: PackContentRef): content is PackCompositionContentRef =>
  content.type === 'composition';

const isDecomposedArtifacts = (
  decomposed: DecomposedArtifacts | PackDecomposition | undefined,
): decomposed is DecomposedArtifacts =>
  decomposed !== undefined && !Object.prototype.hasOwnProperty.call(decomposed, 'contents');

const isPackDecomposition = (
  decomposed: DecomposedArtifacts | PackDecomposition | undefined,
): decomposed is PackDecomposition =>
  decomposed !== undefined && Object.prototype.hasOwnProperty.call(decomposed, 'contents');

const sortedUnique = (values: Array<string | null>): string[] =>
  [...new Set(values.filter((value): value is string => value !== null))].sort();

const compiledOutputCount = (decomposed: DecomposedArtifacts): number =>
  (decomposed.ingredient === undefined ? 0 : 1)
  + (decomposed.catalog === undefined ? 0 : 1)
  + (decomposed.entity_schemas?.length ?? 0)
  + (decomposed.operation_groups?.length ?? 0)
  + (decomposed.default_grants?.length ?? 0);

/** A coarse `CompositionSurface` label from the ingredient's kind — `cli`
 *  lowers to a connector surface, every other kind (`http` / `connection` / …)
 *  to an api surface. The review projection keeps surfacing this label even
 *  though the two-table model no longer authors a per-op `surface`. */
const surfaceForKind = (kind: string | undefined): CompositionSurface =>
  kind === 'cli' ? 'connector' : 'api';

const projectComposition = (
  composition: unknown,
  decomposed: DecomposedArtifacts,
): ProjectedComposition | null => {
  if (!isPlainObject(composition)) return null;
  const typed = composition as unknown as CompositionIngredient;
  const operations = decomposed.catalog?.operations ?? {};
  const simpleRisk = decomposed.ingredient?.risk_tier as OperationRiskTier | undefined;
  const kindBySlug = new Map<string, string>(
    (typed.ingredients ?? []).map((ing) => [ing.slug, ing.kind]),
  );
  const fields = (typed.ingredients ?? []).flatMap((ing) =>
    Object.values(ing.entities ?? {}).flatMap((entity) => entity.fields));
  return {
    catalog_slug: typed.slug,
    shape: decomposed.ingredient === undefined ? 'multi' : '1x1',
    operation_families: (typed.operations ?? [])
      .map((op) => {
        const operation = operations[op.op];
        return {
          key: op.op,
          surface: surfaceForKind(kindBySlug.get(op.ingredient)),
          risk_tier: operation?.risk_tier ?? simpleRisk ?? op.risk,
          approval_mapping: operation?.approval ?? op.approval,
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key) || a.surface.localeCompare(b.surface)),
    field_privacy: fields
      .filter((field): field is typeof field & { pii: EntityFieldPrivacy } => field.pii !== undefined)
      .map((field) => ({
        path: field.field_path,
        privacy_kind: field.pii,
      }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.privacy_kind.localeCompare(b.privacy_kind)),
    entity_field_count: fields.length,
    compiled_outputs: compiledOutputCount(decomposed),
  };
};

const viewFromParts = (
  valid: boolean,
  shape: ReviewArtifactShape,
  packContentCount: number,
  projections: ProjectedComposition[],
  issues: CompositionValidationIssue[],
): CompositionReviewView => {
  const catalogSlugs = sortedUnique(projections.map((projection) => projection.catalog_slug));
  const counts = projections.reduce<CompositionReviewCounts>((acc, projection) => ({
    compositions: acc.compositions + 1,
    operation_families: acc.operation_families + projection.operation_families.length,
    entity_fields: acc.entity_fields + projection.entity_field_count,
    pii_fields: acc.pii_fields + projection.field_privacy.length,
    pack_contents: acc.pack_contents,
    compiled_outputs: acc.compiled_outputs + projection.compiled_outputs,
  }), {
    ...emptyCounts(),
    pack_contents: packContentCount,
  });
  return {
    valid,
    summary: {
      catalog_slug: catalogSlugs.length === 1 ? catalogSlugs[0] : null,
      catalog_slugs: catalogSlugs,
      artifact_shape: shape,
      counts,
    },
    operation_families: projections
      .flatMap((projection) => projection.operation_families)
      .sort((a, b) => a.key.localeCompare(b.key) || a.surface.localeCompare(b.surface)),
    field_privacy: projections
      .flatMap((projection) => projection.field_privacy)
      .sort((a, b) => a.path.localeCompare(b.path) || a.privacy_kind.localeCompare(b.privacy_kind)),
    issues,
  };
};

const compileCompositionForReview = (body: unknown): CompositionReviewView => {
  const result = validateComposition(body);
  const decomposed = isDecomposedArtifacts(result.decomposed) ? result.decomposed : undefined;
  const projection = decomposed === undefined ? null : projectComposition(body, decomposed);
  return viewFromParts(
    result.valid,
    projection?.shape ?? 'unknown',
    0,
    projection === null ? [] : [projection],
    result.issues,
  );
};

const compilePackForReview = (body: unknown): CompositionReviewView => {
  // ⚠ `warnUnboundedPatterns` is passed HERE and not on the install paths. Review
  //   is where an author can still act on it; an installer cannot fix a pack they
  //   did not write. See the option's own note in `validators.ts`.
  const result = validatePack(body, { warnUnboundedPatterns: true });
  const packDecomposition = isPackDecomposition(result.decomposed) ? result.decomposed : undefined;
  const contents = packDecomposition?.contents ?? [];
  const projections = contents
    .filter(isCompositionRef)
    .map((content) => {
      const compositionResult = validateComposition(content.composition, {
        warnUnboundedPatterns: true,
      });
      const decomposed = isDecomposedArtifacts(compositionResult.decomposed)
        ? compositionResult.decomposed
        : undefined;
      return decomposed === undefined
        ? null
        : projectComposition(content.composition, decomposed);
    })
    .filter((projection): projection is ProjectedComposition => projection !== null);
  return viewFromParts(
    result.valid,
    'multi',
    contents.length,
    projections,
    result.issues,
  );
};

export const compileForReview = (body: unknown): CompositionReviewView =>
  isLikelyPack(body)
    ? compilePackForReview(body)
    : compileCompositionForReview(body);
