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
export { referenceFormatHintHelp } from './reference-format-hints.js';
export { valueHintFields, valueHintField, valueHintUnsupportedFieldHelp, type ValueHintField } from './value-hint-fields.js';
export { recipePageBindingFields, recipePageBindingField, type RecipePageBindingField } from './value-hint-fields.js';
export { recipeStepKernelOperations, recipeStepTransforms, type RecipeStepGroup } from './recipe-step-choices.js';
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
  stampPackOwnedManifest,
  mcpPackReviewRows,
  mcpToolsDrift,
  mcpToolsDriftFromHashes,
  mcpMintedHashes,
  mcpMintedHashesFromCatalog,
  mcpToolNamesFromCatalog,
  mcpToolOperationsFromCatalog,
  mcpConnectionForPackSlug,
  looksLikeGeneratedMcpPackSlug,
  mcpPackManifest,
  subtractReflectedMcpTools,
  GENERATED_PACK_PUBLISHER,
} from './mcp-pack.js';
export type {
  McpPackGenerationInput,
  McpReflectionSubtraction,
  McpToolsDrift,
} from './mcp-pack.js';

// D-228 slice 1b — ingredient op ids. Exported so the wiring slice can reach
// them; NOTHING consumes these yet, deliberately (see `ingredient-op.ts`).
export {
  INGREDIENT_OP_PREFIX,
  ingredientDescriptorHash,
  ingredientOpId,
  type IngredientDescriptor,
} from './ingredient-op.js';
export { validateAuthoringSource } from './source-validation.js';
export type { AuthoringSourceKind, AuthoringSourceValidation, AuthoringRecipeValidator } from './source-validation.js';
export { kernelArguments, type KernelArgumentSchema } from './kernel-inputs.js';
export { outputSectionFields, outputTypeHelp, type OutputSectionField } from './output-fields.js';
export { stepControlFields, stepFailureKindHelp, stepCacheHelp, stepPolicyChoices, type StepControlField, type StepControlKey } from './step-controls.js';
export { operationPolicyFields, operationPolicyValues, operationPolicyValueHelp, type OperationPolicyField, type OperationPolicyKey } from './operation-policies.js';

export { tableAuthoringFields, tableAuthoringChoices, type TableAuthoringKind, type TableAuthoringField } from './table-authoring.js';

export { compositionArgumentFields, compositionBindingKinds, compositionBindingFields, compositionAuthoringChoices, type CompositionAuthoringField } from './composition-authoring.js';

export { recipeStepSupportsForeach, foreachAuthoringHelp, foreachResultFields } from './iteration-authoring.js';
