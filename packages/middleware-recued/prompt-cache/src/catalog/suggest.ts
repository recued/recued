/** D-164 P3 — runtime NOT-FOUND wrapping for enrichment dispatchers.
 *
 *  When a per-pair enrichment producer has no row for the requested
 *  target, the dispatcher wraps the empty result as the not-found
 *  branch of `EnrichmentResult<T>` carrying the declaration's default
 *  `SuggestDirective`. The LLM sees `{ found: false, suggest: { tool,
 *  kind, hint } }` and routes to the suggested fallback.
 *
 *  Producers whose declaration sets `suggest_directive: null`
 *  (operational signals like `source_freshness_degradation` whose
 *  recourse is configuration, not a different warehouse query) return
 *  `null` from this helper — the dispatcher then surfaces an error
 *  instead of wrapping with a misleading suggestion.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md § 5. */

import type { EnrichmentDeclaration, SuggestDirective } from '@recued/contracts';

/** The not-found branch of `EnrichmentResult<T>` carrying the
 *  producer's default suggest directive. Discriminator narrows the
 *  union — readers check `.found === false` and then access `suggest`. */
export interface EnrichmentNotFound {
  readonly found: false;
  readonly suggest: SuggestDirective;
}

/** Build the not-found wrapping for an empty enrichment result.
 *
 *  Returns `null` when the declaration has no default suggest
 *  (operational signals — `source_freshness_degradation`,
 *  `standing_instruction_conflict`). Callers MUST handle the null
 *  branch — dispatching with `suggest` populated where the producer
 *  has no natural fallback would surface a wrong hint to the LLM. */
export const buildEnrichmentNotFound = (
  declaration: EnrichmentDeclaration,
): EnrichmentNotFound | null => {
  const directive = declaration.suggest_directive;
  if (directive === null) return null;
  return { found: false, suggest: directive };
};
