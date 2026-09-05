export {
  validateRecipe,
  isValidRecipe,
  assertValidRecipe,
} from './validate.js';
export type {
  ValidationSeverity,
  ValidationIssue,
  ValidationResult,
} from './validate.js';

export { analyzeRecipe } from './analyze.js';
export type { RecipeSummary } from './analyze.js';

export { buildStepGraph, findForwardReferences } from './graph.js';
export type { StepGraph, StepNode, StepPhase, ForwardRef } from './graph.js';

export {
  normalizeRecipe,
  canonicalJsonString,
  recipesEqual,
  hashRecipe,
} from './canonical.js';

export { planExecution, isPlanCurrent } from './plan.js';
export type { ExecutionPlan, StepPlan } from './plan.js';

export { diffRecipes, changeCount } from './diff.js';
export type {
  RecipeDiff,
  FieldChange,
  StepAddition,
  StepRemoval,
  StepModification,
  StepReorder,
  VariableModification,
} from './diff.js';

export { parseRecipe, issuesBySeverity, canonicalRecipeDefinition } from './parse.js';
export type { ParseResult } from './parse.js';

// D-200 Slice 6g.6 — bounded, side-effect-free submit-time pair mapper
// admission. Pair authoring itself remains on the standard open parser.

// D-119 Phase 2 — typed `RecipeBundle` parser used by every install path.
export { parseBundle } from './parse-bundle.js';

// D-119 Phase 2 — bundle install planner (pure orchestrator).
export { planBundleInstall } from './install-plan.js';
export type {
  PlanBundleInstallInput,
  PlanBundleInstallOutcome,
} from './install-plan.js';

export { validateIngredientRefs, isBreakingIngredientPin } from './validate-ingredients.js';
export type { IngredientIssue, IssueSeverity as IngredientIssueSeverity } from './validate-ingredients.js';

// Auto-PII flow validation (design § 7) — classifier-aware validator over
// the contracts `tracePiiFlow` taint trace.
export { validateRecipePii } from './validate-pii.js';
export type { PiiIssue, PiiIssueSeverity, RecipePiiValidation } from './validate-pii.js';

// §5 recipe-publish policy — the marketplace publish gate (op-steps + transforms +
// guards + core-* capability ingredient steps only; richer kinds via pack ops).
export { validateRecipePublishPolicy } from './validate-recipe-publish-policy.js';
export type { PublishPolicyResult, PublishPolicyViolation } from './validate-recipe-publish-policy.js';

// Auto-PII application (design § 7 follow-on) — llm.pii_fields injection +
// pii-protect/pii-restore bracket synthesis, verification-gated.
export { applyAutoPiiProtection } from './apply-pii.js';
export type {
  AppliedPiiBracket,
  AppliedPiiBracketSource,
  AutoPiiApplication,
  AutoPiiResidual,
  AutoPiiResidualOutcome,
} from './apply-pii.js';

// Auto-PII posture summary (design § 7 surfacing slice) — the install /
// save / Kitchen disclosure built from the validator + the applicator.
export { summarizeRecipePiiPosture } from './summarize-pii.js';
export type { SummarizePiiOptions } from './summarize-pii.js';

// Phase 7 (D-110) — install-time caps validator for file-write /
// file-delete / file-move steps.
export { validateFileInstanceCaps } from './validate-file-caps.js';
export type {
  FileInstanceCaps,
  FileInstanceLookup,
  FileCapsIssue,
} from './validate-file-caps.js';

// D-117 Phase 6 — install-time caps validator for calendar mutation
// + search ingredients.
export { validateCalendarInstanceCaps } from './validate-calendar-caps.js';
export type {
  CalendarInstanceCaps,
  CalendarInstanceLookup,
  CalendarCapsIssue,
  CalendarCapIngredient,
} from './validate-calendar-caps.js';

// D-116 — install-time `on_failure` handler check + runtime helper
// for collecting source recipes bound to a given handler.
export { checkOnFailureInstallable, failureSourcesFor } from './validate-on-failure.js';
export type {
  OnFailureInstallIssue,
  OnFailureHandlerLookup,
} from './validate-on-failure.js';

// D-116 Phase 6 — ingredient probe manifest validator.
export { validateProbeManifest } from './validate-probe.js';
export type { ProbeIssue } from './validate-probe.js';

export { qualityPrecheck } from './quality-precheck.js';
export type { QualityFinding } from './quality-precheck.js';

// D-120 Phase 2 — recipe → flattened action summary used as the
// `recipe_insights.flattened` payload. Pure; manifest enrichment
// optional. Insert callers (extension installRecipe + server
// recipeStore.save) feed the result through `getOrCreateRecipeInsight`
// (storage / memory-schema layer).
export {
  flattenRecipe,
  serializeFlattenedInsight,
} from './flatten.js';
export type {
  FlattenedInsight,
  FlattenedStep,
  FlattenedTrigger,
  FlattenedActionKind,
  FlattenOptions,
} from './flatten.js';

// D-120 Phase 4.5 — `context.recipe.*` static analyzer. Extracts the
// step IDs a recipe reads from prior-run state so the engine knows
// which step outputs to snapshot at run end.
export { extractContextRecipeRefs } from './context-recipe-refs.js';

// D-125 Phase 6.3 — kernel + recued-core enrichment-first lint rule.
// Marketplace submission gate runs this for kernel + recued-core
// publishers; third-party recipes are unaffected.
export { lintEnrichmentFirst } from './lint/enrichment-first.js';
export type { EnrichmentLintIssue } from './lint/enrichment-first.js';

// D-137 Wave 2.1 — pure helpers for projecting installed recipes into
// the chat agent's Tier 2 catalog (chat_exposed gate + step-graph
// requires_kinds projection + Tier 2 ToolEntry assembly). Consumed by
// the engine's `InternalToolRegistry` factory.
export {
  DEFAULT_PACK_RECIPE_CHAT_EXPOSED,
  DEFAULT_AUTHORED_RECIPE_CHAT_EXPOSED,
  isRecipeChatExposed,
  deriveRecipeRequiresKinds,
  formatTier2ToolName,
  buildTier2ToolEntry,
  buildTier2Catalog,
  searchToolCatalog,
  createManifestKindLookup,
  createOpKindLookup,
} from './chat-catalog.js';
export type {
  IngredientKindLookup,
  OpKindLookup,
  Tier2RecipeEntry,
} from './chat-catalog.js';

// Connection-agnostic op dispatch — the R1 install-time rewrite of a canonical
// recipe (CanonicalOpStep `deal.search`) into a concrete vendor-bound recipe via
// the injected PackResolutionContext. Design:
// internal design notes.
export {
  resolveConnectionAgnosticRecipe,
  connectionVariableNames,
  opStepConnectionSlots,
  CanonicalOpResolutionError,
  // Poll-manager (G6) — the runtime canonical poll shares the resolver's
  // response-rows + projection-template pipeline (one semantics source).
  vendorEntityResponseRows,
  buildProjectionTemplate,
} from './connection-agnostic.js';

// D-255 (post-retraction) — a canonical op invocation as the transient one-step
// recipe the R2 dispatch path already runs. A canonical op is RECIPE-shaped (it
// expands to a raw dispatch + a projection step), so the unit of exposure is a
// recipe and every existing gate applies to the resolved vendor op.
export {
  buildCanonicalOpRecipe,
  CANONICAL_OP_CONNECTION_VAR,
  CANONICAL_OP_STEP_ID,
} from './canonical-op-invocation.js';
export type {
  CanonicalOpInvocation,
  CanonicalOpRecipeResult,
} from './canonical-op-invocation.js';
// Per-operand connection slots (R2 step 5, doc §1.3) — the shared slot-ref
// grammar (`{{config.<var>}}`) + parse, one rule across resolver / validator /
// install plan / dispatch slot derivation.
export {
  OP_STEP_CONNECTION_REF_REGEX,
  parseOpStepConnectionRef,
} from './connection-agnostic-paths.js';
// NEXT-1 — vendor SEARCH-query derivation (request-side mirror of the read
// projection): canonical `{ limit, filter, sort }` → HubSpot search POST body /
// Salesforce SOQL `q` wire-key args.
export { deriveVendorSearchArgs, DEFAULT_SEARCH_LIMIT } from './connection-agnostic-search.js';
export type { SearchArgsResult } from './connection-agnostic-search.js';
// D-190 Slice 4 — the per-connection SERVER-FILTERABLE canonical-field set (the
// queryability rule made an inspectable function): consumed by the cross-vendor
// `deal.search` fan-out (filter vocabulary = the intersection across vendors) and the
// resolver's own fail-closed filter-reject hint.
export { canonicalFilterableFields } from './connection-agnostic-search.js';
// Write-verb reverse projection (request-side mirror of the read projection for the
// write verbs): canonical write body → HubSpot `body.properties` / Salesforce flat
// sObject wire-key args; canonical `id` selector → vendor path-param token.
// `deriveRecordSelectorArgs` is the selector-only deriver shared by `read` + `delete`
// (canonical `id` → `<vendorEntity>_id`).
export {
  deriveVendorWriteArgs,
  deriveRecordSelectorArgs,
  WRITE_SELECTOR_KEY,
} from './connection-agnostic-write.js';
export type { WriteArgsResult, CanonicalWriteVerb } from './connection-agnostic-write.js';

// D-182 Slice 5 (Increment 1) — runtime resolution of the new two-tier `OpStep`,
// closed-kind Tier-K half: a `core.<domain>.<op>` in KERNEL_OP_REGISTRY rewrites
// to its backing kernel ingredient step (args→input identity, connection-less).
// Canonical-convention (`core.crm.*`/`core.acct.*`) + Tier-P pack ops fall through
// (return null) — handled by the connection-agnostic / pack-catalog paths (Increment 2).
export { resolveKernelClosedKindOpStep } from './op-step-kernel.js';
// Increment 2a — the unified per-step lowering dispatcher: closed-kind kernel →
// IngredientStep, canonical-convention (core.crm.*/core.acct.*) → bare CanonicalOpStep
// (validated, the existing resolver finishes it), Tier-P/unknown → null (Increment 2b).
export { lowerOpStep } from './op-step-lower.js';
// Increment 2b — Tier-P pack-op resolution (pack_ref → installed catalog binding)
// + the recipe-level lowering pass that runs as a pre-pass before
// resolveConnectionAgnosticRecipe (kernel/canonical/Tier-P; legacy bare-op passthrough).
export { lowerOpStepRecipe, type PackOpBinding, type PackOpResolution } from './op-step-lower.js';

// D-182 §10 step 8 / R1 — the runtime verb-split applied to a recipe. Pure: a
// recipe's `core.crm.*`/`core.acct.*` op-steps × the bound connection families →
// unbound reads rewritten to empty-result steps (+ pre-run warnings), unbound
// writes blocked (fail closed). Bound families arrive injected (the runtime
// derives them from the live connections). The per-op primitive
// (`kernelOpRunnability`) lives in `@recued/contracts`.
export { applyKernelOpRunnability } from './kernel-op-runnability.js';
export type { KernelRunnabilityEntry, KernelRunnabilityResult } from './kernel-op-runnability.js';

// R2 step 6 — write-saga compensation derivation (recipe-identity doc §4).
// Pure, catalog/registry-driven, never inferred: a landed `create` → a fresh
// single-op `<alias>.delete` canonical recipe (the inverse the CATALOG declares),
// dispatched through the normal gate with `predecessor_commit_id` provenance.
// update/delete landed writes derive nothing (disclosed, not guessed).
export {
  deriveCompensation,
  extractCreatedRecordId,
  COMPENSATION_CONNECTION_VARIABLE,
  COMPENSATION_RECIPE_ID_PREFIX,
} from './saga-compensation.js';
export type { LandedCatalogWrite, CompensationPlan } from './saga-compensation.js';
