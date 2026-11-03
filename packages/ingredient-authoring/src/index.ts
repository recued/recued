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
export { packConnectionNames, connectionHintFields, connectionHintValueFields, connectionHintAuthChoices } from './connection-authoring.js';
export { operationPaginationFields, operationPaginationStyleHelp, collectionResultPathHelp, authoredCollectionResultPath } from './pagination-authoring.js';
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
  recordsMetaFieldType,
  recordsActionArguments,
  recordsActionRiskFloor,
  recordsFieldListIssues,
  recordsFieldAliasSafe,
  type RecordsFieldList,
  normalizeRecordsEntityId,
  recordsSlots,
  stampRecordsCatalog,
  validateRecordsComposition,
  type RecordsAuthoringIssue,
  type RecordsHashes,
} from './records.js';
export { recordsFieldFields, recordsFieldChoices } from './records-field-authoring.js';
export { recordsBindingFields, recordsBindingActions } from './records-binding-authoring.js';
export { recordsAggregateFields, recordsAggregateFunctions, recordsAggregateFieldAllowed, recordsBatchFields } from './records-nested-authoring.js';
export { recordsRootFields, recordsRootHopFields } from './records-root-authoring.js';
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
export { operationPolicyFields, operationPolicyValues, operationPolicyValueHelp, OPERATION_SETTING_KEYS, type OperationPolicyField, type OperationPolicyKey } from './operation-policies.js';

export { tableAuthoringFields, tableAuthoringChoices, type TableAuthoringKind, type TableAuthoringField } from './table-authoring.js';

export { compositionArgumentFields, compositionBindingKinds, compositionBindingFields, compositionAuthoringChoices, type CompositionAuthoringField } from './composition-authoring.js';

export { recipeStepSupportsForeach, foreachAuthoringHelp, foreachResultFields } from './iteration-authoring.js';
export { declaredOperationArguments, checkDeclaredOperationArguments, type DeclaredArgumentFinding } from './operation-inputs.js';
export { closedInputMetadata, closedInputAt, closedInputHelp, checkClosedInputs, CLOSED_INPUT_MAX_NODES, CLOSED_INPUT_MAX_BYTES,
  type ClosedInputSchema, type ClosedInputFinding } from './closed-inputs.js';
export { closedSchemaFields, closedSchemaTypes, closedSchemaEntries, type ClosedInputPath, type ClosedSchemaEntry, type ClosedSchemaField } from './closed-schema-authoring.js';
export { closedInputScaffold } from './closed-input-scaffold.js';
export { inputPrimitive, inputHintType, inputEnumOptions, inputBindingCompatibility, inputBindingMessage, plainConfigBinding, checkClosedInputBindings,
  type InputPrimitive, type InputBindingFinding, type BindingInputSchema } from './input-binding-types.js';
export { valueHintTypes, valueHintTypeHelp } from './value-hint-types.js';
export { bindingArgumentTokens, bindingArgumentTokenAt, bindingArgumentValue, operationBindingArgumentReferences, assertBindingArgumentRename,
  type BindingArgumentPath, type BindingArgumentSyntax, type BindingArgumentReference } from './binding-argument-references.js';

export * from './file-transfer-authoring.js';

export * from './rest-json-authoring.js';

export * from './arg-edit-schema.js';
export * from './approval-review-details.js';
export * from './approval-authoring.js';
export * from './cli-authoring.js';
export * from './cli-setup-authoring.js';

export { restRequestFields, restMergeQueryNames, restBodyAuthNames, REST_REQUEST_CHOICE_LIMIT } from './rest-request-authoring.js';
export { API_SCHEMA_SOURCE_KEYS, API_SCHEMA_CHOICE_LIMIT, apiSchemaFields, openApiDocumentParameters,
  type ApiSchemaField, type ApiSchemaSection, type ApiSchemaSourceKey } from './api-schema-authoring.js';
export { compositionLoweringDecision, type CompositionLoweringDecision } from './decomposer.js';
export * from './response-schema-authoring.js';
export * from './operation-scopes.js';
export * from './vendor-entity-authoring.js';
export { normalizeEntityId as normalizeVendorEntityId } from './decomposer.js';
export { vendorEntitySchemaOrigins } from './vendor-entity-issues.js';

export * from './workflow-authoring.js';
export * from './engagement-authoring.js';
