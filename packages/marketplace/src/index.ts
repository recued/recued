/** @recued/marketplace — foundation.
 *
 *  Types and pure helpers for marketplace listings, search, and install
 *  tracking. Network transport (the concrete `MarketplaceClient` impl)
 *  lives in a later layer that imports this foundation.
 */

export type {
  MarketplaceListing,
  InstalledRecipe,
  UpdateStatus,
  SearchQuery,
  SearchResult,
  SortOrder,
  MarketplaceClient,
  PublishOptions,
  InstallRegistry,
} from './types.js';

export { buildListing, computeUpdateStatus, isLocallyForked } from './listing.js';
export {
  fetchRecipeBySlug,
  fetchRecipeByUrl,
  checkUpstream,
  resolveRecipeInput,
  fetchSuggestions,
  listRecipes,
  lookupIngredient,
  MARKETPLACE_URL,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  type MarketplaceRecipeResult,
  type MarketplaceRecipeRow,
  type MarketplacePagination,
  type ListRecipesParams,
  type RecipeSuggestion,
} from './client.js';
export { search, matchesQuery, rankListings } from './search.js';
export { createInMemoryInstallRegistry } from './registry.js';
export { createIDBInstallRegistry, type IDBInstallRegistry } from './idb-registry.js';
export {
  createInMemoryIngredientRegistry,
  createIDBIngredientRegistry,
  type IngredientRegistry,
} from './ingredient-registry.js';

// D-119 Phase 2 — third-party bundle fetch + marketplace publish-time gate.
export {
  fetchBundleByUrl,
  BundleFetchError,
  assertPlainRecipeSubmission,
} from './bundle-fetch.js';
export type { FetchedBundle, PublishGateResult } from './bundle-fetch.js';

// D-145 PC1 — Publishing-vs-messaging marketplace validator (four-gate).
export {
  validateBridgeSurfaceKind,
  validateUrlClassifier,
  validateSelectorClassifier,
  flagMixedSurfaceDomain,
  runFourGateValidation,
  extractIngredientTriggers,
  BRIDGE_SURFACE_VALIDATION_ERROR_CODES,
} from './validators/bridge-surface-kind.js';
export type {
  BridgeSurfaceValidationManifest,
  BridgeSurfaceValidationErrorCode,
  BridgeSurfaceValidationResult,
  MixedSurfaceFlag,
  FourGateValidationResult,
} from './validators/bridge-surface-kind.js';

// D-122 Phase 4 — bulk-install pack resolver + cost estimator.
export {
  fetchBulkPackBySlug,
  fetchBulkPackByUrl,
  resolveBulkPack,
  BulkPackFetchError,
} from './bulk-pack-resolver.js';
export type { BulkPackResolution, ResolvedPackRecipe } from './bulk-pack-resolver.js';
export {
  estimatePackCost,
} from './cost-estimator.js';
export type {
  CostEstimate,
  CostEstimateInput,
  PerRecipeCost,
  PerRecipeCostInput,
} from './cost-estimator.js';

// D-122 Phase 4 — atomic bulk-pack install transaction. D-159 P1
// relocated it from `@recued/engine` — the install transaction is a
// marketplace concern, not deterministic recipe execution.
export { installBulkPack } from './install.js';
export type {
  BulkPackInstallContext,
  BulkPackInstallEntry,
  BulkPackInstallInput,
  BulkPackInstallRecipe,
  BulkPackInstallResult,
  BulkPackRegistry,
  InstalledRecipeRow,
  RecipeHasher,
} from './install.js';
