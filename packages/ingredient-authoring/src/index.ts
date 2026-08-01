export {
  COMPOSITION_MAX_FIELDS,
  COMPOSITION_MAX_OPERATIONS,
  COMPOSITION_MAX_SERIALIZED_BYTES,
  COMPOSITION_SCHEMA_VERSION,
} from './schema.js';
export type {
  CompositionAuthModel,
  CompositionSurface,
  CompositionIngredient,
  IngredientRow,
  IngredientEntity,
  IngredientEntityField,
  PackOperationRow,
  RecipeTemplateRow,
  CanonicalWorkflowTemplate,
  ArgEditField,
  EntityFieldRow,
  OperationRow,
} from './schema.js';
export { canonicalHash } from './canonical-hash.js';
export {
  hashRecordsDeclaration,
  isRecordsComposition,
  recordsEntitySchemas,
  recordsCatalogSlug,
  recordsSchemaSnapshot,
  recordsSlots,
  stampRecordsCatalog,
  validateRecordsComposition,
  type RecordsAuthoringIssue,
  type RecordsHashes,
} from './records.js';
export {
  decomposeComposition,
  decomposePack,
  type DecomposedArtifacts,
  type PackDecomposition,
} from './decomposer.js';
export {
  validateComposition,
  validateCompositionStructure,
  validatePack,
  validatePackStructure,
  type CompositionValidationIssue,
  type CompositionValidationResult,
} from './validators.js';
export {
  compileForReview,
  type CompositionReviewCounts,
  type CompositionReviewSummary,
  type CompositionReviewView,
  type ReviewArtifactShape,
  type ReviewFieldPrivacy,
  type ReviewOperationFamily,
} from './review.js';

// D-225 Slice 2 — generate a pack composition from an MCP `tools/list`.
export {
  mcpToolDescriptorHash,
  mcpToolOpSegment,
  mcpGeneratedPackSlug,
  generateMcpPackComposition,
  stampGeneratedMcpCatalog,
  mcpPackReviewRows,
  mcpToolsDrift,
  mcpToolsDriftFromHashes,
  mcpMintedHashes,
  mcpMintedHashesFromCatalog,
  mcpConnectionForPackSlug,
  looksLikeGeneratedMcpPackSlug,
  mcpPackManifest,
  GENERATED_PACK_PUBLISHER,
} from './mcp-pack.js';
export type { McpPackGenerationInput, McpToolsDrift } from './mcp-pack.js';

// D-228 slice 1b — ingredient op ids. Exported so the wiring slice can reach
// them; NOTHING consumes these yet, deliberately (see `ingredient-op.ts`).
export {
  INGREDIENT_OP_PREFIX,
  ingredientDescriptorHash,
  ingredientOpId,
  type IngredientDescriptor,
} from './ingredient-op.js';
