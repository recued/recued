import type { IngredientManifest, StepOptions, StepMeta } from '@recued/contracts';

/** A function the executor can call to fetch an ingredient manifest by slug.
 *  Caller is responsible for caching, version pinning, and source (marketplace, local, fork).
 */
export type ManifestLoader = (slug: string) => Promise<IngredientManifest | null>;

/** The universal executor signature — same as engine's IngredientExecutor.
 *  `stepOutput` is the optional per-step output mapping that extends the
 *  ingredient manifest's default output. `stepOptions` carries cross-cutting
 *  per-call hints (e.g. cache freshness) derived from the step definition.
 *  `stepMeta` (D-113) threads step identity + approval policy through the
 *  middleware chain for the approvals wrapper to consume. */
export type IngredientExecutor = (
  slug: string,
  input: Record<string, unknown>,
  stepOutput?: Record<string, string>,
  stepOptions?: StepOptions,
  stepMeta?: StepMeta,
) => Promise<unknown>;

/** Everything an adapter needs to execute a call. Built by the dispatch
 *  layer after merging manifest defaults with step overrides and resolving
 *  value references. Adapters are pure transport — they never touch the
 *  raw manifest. */
export interface ResolvedCall {
  slug: string;
  risk_tier: string;
  input: Record<string, unknown>;
  output: Record<string, string>;
  fallback?: Record<string, string>;
  /** D-127 follow-on — engine-supplied step identity, when the caller
   *  reached us through `createIngredientExecutor` (the engine's path).
   *  Adapters that emit per-call audit rows (kernel `mail-send`) thread
   *  `recipe_id` + `step_id` through to the underlying rpc / collection
   *  so the audit row attributes back to the originating step. Adapters
   *  that don't care leave it untouched. Absent for direct-rpc callers
   *  and tests that build a `ResolvedCall` manually. */
  stepMeta?: StepMeta;
}

/** Custom error thrown by adapters. Includes the recipe error code for engine routing. */
export class IngredientError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'IngredientError';
  }
}
