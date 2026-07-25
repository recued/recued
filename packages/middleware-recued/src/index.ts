/** D-159 — `@recued/middleware-recued` public surface.
 *
 *  The first-party middleware bundle relocated from `@recued/engine`
 *  in D-159 P0: tier strategy (D-145 PB4 relocated here in D-164 P6.1),
 *  confidence shaping, correction learning,
 *  scope search, and personal-recipe surfacing. `middleware-recued` is
 *  one package — the `recued`-publisher bundle of first-party
 *  middlewares (a third-party bundle would be
 *  `packages/middleware-<publisher>/`).
 *
 *  D-164 P6d retired the PB16 cognition layer: internal benchmarks Path B
 *  (sealed 2026-05-19) falsified the working-memory state-tracking
 *  layer, and chat-surface consumers were dismantled in D-164
 *  P6a-1 / P6a-2. The substrate is gone; the contracts in
 *  `packages/contracts/src/cognition.ts` + the transparency-stream
 *  cognition fields retire in D-164 P6f.
 *
 *  D-164 P6.5 retired the PB17 two-stage decoder (Stage 1 / Stage 2 /
 *  chat-decoder / local-classifier / per-intent-capacity / commitment-
 *  context / filter-tools / filter-recipes / orchestrator / middleware).
 *  Chat consolidated onto `@recued/middleware-prompt-cache` (the
 *  prompt-cache flow registers itself against the same registry from
 *  `wire-chat-orchestrator.ts` — it does not slot into
 *  `FIRST_PARTY_MIDDLEWARES` here).
 *
 *  Import boundary (D-159 N.7): `middleware-recued` may import
 *  `@recued/middleware` and `@recued/engine`; it MUST NOT be imported
 *  by `@recued/middleware` (the framework never imports a bundle).
 *
 *  Spec: D-159.
 */

// D-137 P3 — confidence-shape dispatch + compound-ambiguity cascade +
// recipe-fallback resolver.
export * as confidenceShape from './confidence-shape/index.js';

// D-145 PB14 — Correction Learning primitive engine wiring.
export * as correctionLearning from './correction-learning/index.js';

// D-145 PB11 — Person-Specific Automation primitive engine wiring.
export * as personalRecipes from './personal-recipes/index.js';

// D-137 P2 § A.4 — server-side read consolidation (scope-search
// sequential fan-out runner).
export {
  runScopeSearchFanout,
  type ScopeSearchSource,
} from './scope-search/index.js';

// ── D-160 P2 — first-party middleware registration ──────────────────
//
// Each sub-package above also ships a D-160 `Middleware` adapter
// (`<sub-package>/middleware.ts`) — a thin scaffold that wires the
// middleware identity + its lifecycle footprint onto the framework's
// 3-hook interface (`config` / `prompt` / `update`). This is where the
// first-party adapters register against a D-160 middleware
// registry (D-160 § N.3 / P2).
//
// D-164 P6d retired the cognition slot entirely — the `cognition/`
// substrate + its registration are gone (internal benchmarks Path B sealed
// 2026-05-19 falsified the working-memory layer). D-164 P6.5 retired
// the two-stage slot — chat consolidated onto
// `@recued/middleware-prompt-cache`, which registers itself directly
// from `wire-chat-orchestrator.ts`. The registry's per-middleware
// enabled state remains the framework-side disable mechanism for any
// other middleware that ships disabled in future.
//
// Import boundary (D-159 N.7 / D-160 I-1): `middleware-recued` imports
// `@recued/middleware` (the framework) — the allowed direction; the
// framework never imports this bundle.

import type { MiddlewareRegistry } from '@recued/middleware';

import { confidenceShapeMiddleware } from './confidence-shape/middleware.js';
import { correctionLearningMiddleware } from './correction-learning/middleware.js';
import { personalRecipesMiddleware } from './personal-recipes/middleware.js';
import { scopeSearchMiddleware } from './scope-search/middleware.js';

export {
  confidenceShapeMiddleware,
  correctionLearningMiddleware,
  personalRecipesMiddleware,
  scopeSearchMiddleware,
};

// D-160 O-5 (light foundational slice) — the `ctx.state` keys + result
// types the chat orchestrator's inline producer
// (`backend/server/src/chat-stream-middleware.ts`) sets / reads to feed
// the two source-wired middlewares (`correction-learning` /
// `personal-recipes`). Re-exported from the package root so backend
// consumers import them cleanly rather than deep-importing the adapter
// modules (the package ships no `exports` map for subpath resolution).
export {
  CORRECTION_LEARNING_EVENTS_STATE_KEY,
  CORRECTION_LEARNING_SUMMARY_STATE_KEY,
} from './correction-learning/middleware.js';
export {
  PERSONAL_RECIPES_INPUT_STATE_KEY,
  PERSONAL_RECIPES_MATCHES_STATE_KEY,
} from './personal-recipes/middleware.js';
export type {
  DispatchPersonalRecipesResult,
  PersonalRecipeMatch,
} from './personal-recipes/index.js';

/** The four always-enabled first-party stream middlewares, in
 *  registration order — which is the order the framework iterates them
 *  at each lifecycle hook (the registry preserves insertion order).
 *
 *  Ordered by lifecycle semantics, not the spec's prose enumeration.
 *  The `before-turn` (`prompt`) middlewares lead in pipeline order:
 *  `scope-search` (fetch read-context for the user message), then
 *  `correction-learning` (augment the assembled prompt). The
 *  `after-turn` (`update`) hook then runs, in the same registration
 *  order: `confidence-shape`, then `personal-recipes`. The hook split
 *  means a middleware's slot only orders it against peers sharing its
 *  hook.
 *
 *  D-164 P6.5 retired the `two-stage` slot here: the chat surface is
 *  now `prompt-cache`-driven (`@recued/middleware-prompt-cache`), which
 *  registers against the same registry separately (see
 *  `wire-chat-orchestrator.ts`'s `registerPromptCacheMiddleware` call). */
export const FIRST_PARTY_MIDDLEWARES = [
  scopeSearchMiddleware,
  correctionLearningMiddleware,
  confidenceShapeMiddleware,
  personalRecipesMiddleware,
] as const;

/** Register every first-party stream middleware against a D-160
 *  middleware registry (D-160 P2). All four register enabled — D-164
 *  P6d retired the cognition slot (internal benchmarks Path B falsified the
 *  working-memory layer) and D-164 P6.5 retired the two-stage slot
 *  (chat surface consolidated onto `@recued/middleware-prompt-cache`).
 *
 *  The registry is iterated, not mutated further, by the caller; pass a
 *  fresh `createMiddlewareRegistry()` per server boot. */
export const registerFirstPartyMiddlewares = (
  registry: MiddlewareRegistry,
): void => {
  for (const middleware of FIRST_PARTY_MIDDLEWARES) {
    registry.register(middleware);
  }
};
