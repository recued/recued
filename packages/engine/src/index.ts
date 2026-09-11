export { executeRecipe } from './execute.js';
export { simulateRecipe, type RecipeSimulationInput, type RecipeSimulationResult, type SimulatedStep } from './recipe-simulation.js';
// D-157 Part C — held-action idempotency resolves a recipe's variable defaults
// the SAME way the engine does (the audit `config_snapshot` carries resolved
// defaults; the dedup key must match) via the canonical extractor.
export { extractDefault as extractVariableDefault } from './execute.js';
// D-157 server-wiring — prototype-safe namespace writers are exposed
// so the host's `ExecuteRequest.resume_from` seeder
// (`backend/server/src/execute-handler.ts`) reuses the same guards the
// engine's step-runner uses, keeping checkpoint replay on the same
// `__proto__`/`constructor`/`prototype` reject list.
export {
  assignOwnSafe,
  setNamespaceValue,
  isPrototypeSensitiveKey,
} from './store-safety.js';
export {
  NestedRunNotCompletedError,
  assertNestedRunCompleted,
  RecipeCycleError,
  assertNoRecipeCycle,
  extendHeldRecipes,
  seedHeldRecipes,
  wouldCycle,
} from './local-recipe-cycle.js';
export type { LocalRecipeInvokeCall, LocalRecipeInvoker } from './types.js';
export {
  acknowledgementFor,
  buildExchangeFirePayload,
  classifyRunFailure,
  fireExchangeOutput,
} from './fire-exchange-output.js';
export type {
  ExchangeAcknowledgement,
  ExchangeFireHandler,
  ExchangeFireOutcome,
  ExchangeFirePayload,
} from './fire-exchange-output.js';
export { evaluateCondition } from './condition.js';
export { createTransformContext } from './context.js';
export { createDryRunExecutor, generateMockData } from './dry-run.js';
export type {
  ExecutionContext, ExecutionResult, StepLog, IngredientExecutor,
  CliInvocationCall, CliInvocationExecutor,
  OperationBoundWebhookConsumerIdentity, OperationBoundWebhookCall,
  PreparedOperationBoundWebhookDispatch,
  OperationBoundWebhookResolver,
  ProgressEvent, ProgressCallback,
  CatalogGrantCall, CatalogGrantMintCall, CatalogSessionGrantHooks,
} from './types.js';
export {
  preflight,
  findMissingVariables,
  findMissingVaultEntries,
  findRoleRestrictions,
  collectIngredientSlugs,
  type MissingInput,
  type MissingKind,
  type ManifestGetter,
  type VaultChecker,
} from './preflight.js';
// ── L2 step cache — content-addressable per-step memoization ──
export {
  analyzeStep,
  analyzeSteps,
  computeStepCacheKey,
  canonicalStepSpec,
  type StepSeed,
  type StepKind,
  type RefPath,
  type DepResolver,
  type AnalyzeStepOptions,
} from './step-seed.js';
export { parseAnnotationLinkRef, prefetchSharedRefs } from './shared-prefetch.js';
export { resumeFromApproval, type InProcessResumeFrom, type PauseToResume } from './resume-from-approval.js';
export type {
  AnnotationLinkRef,
  SharedKeyResolver,
  SharedResolvers,
} from './shared-prefetch.js';
// D-120 Phase 4.5 — `context.recipe.*` durability helpers.
export {
  snapshotContextRecipe,
  injectContextRecipe,
  type ContextRecipeStore,
  type ContextRecipeSnapshotResult,
} from './context-recipe.js';
// D-120 Phase 7.5 — `run_mode` derivation. Pure helper; hosts call
// it before stamping `audit_log.run_mode` so declarative recipe
// overrides + trigger inference share one source of truth.
export {
  deriveRunMode,
  KNOWN_TRIGGER_SOURCES,
  type KnownTriggerSource,
} from './run-mode.js';

// D-126 Phase 2.3 — Adapter registry runtime wiring.
export {
  createAdapterRegistry,
  type AdapterRegistry,
  type AdapterRegistryDeps,
} from './adapters/registry.js';

// Poll-manager / G6 — the watch poll loop invokes catalog operations
// DIRECTLY (one gated + audited `<entity>.search` per watch key per
// tick) with a scoped minimal ExecutionContext, instead of riding a
// synthetic recipe run: the poll is not a run (no run anchors / run
// history / reactive_fire noise), and the caller needs the pagination
// `truncated` flag — reachable only via its own `onGatewayCall` audit
// capture (`runCatalogOperation` returns the merged result alone).
// The same gate resolves policy (admit / deny / ask) and emits the
// `connection_gateway` audit row, so the poll stays inside the D-153
// enforcement boundary.
export {
  applyCatalogOverrideTightening,
  catalogOperationUsesDetachedCli,
  describeCatalogDispatch,
  catalogInvocationTimeoutMs,
  normalizeCatalogDispatchInput,
  describeCatalogAuthority,
  runCatalogOperation,
  resolveCatalogRecordsPath,
} from './catalog-gateway.js';
export type { CatalogDispatchDescription } from './catalog-gateway.js';
