/** D-125 Phase 6.3 — Enrichment-first lint rule.
 *
 *  Hard convention for kernel + recued-core publishers: every read
 *  from `data.<collection>.*` or `connection.<kind>.*` must flow
 *  through `enrichment-or-fetch` (or carry an explicit `// no-enrich:`
 *  marker for a genuinely-fresh-only read — auth probes, primary key
 *  lookups, etc.).
 *
 *  Acceptable shapes:
 *    1. The ref appears inside an `enrichment-or-fetch` step's `ref`
 *       parameter — the transform itself reads it.
 *    2. The ref appears in a step whose `id` matches an
 *       `enrichment-or-fetch` step's `fallback_step` — that step is
 *       the fresh-fetch arm of an enrichment-or-fetch pair.
 *    3. The ref appears in a step whose `description` contains the
 *       comment marker `// no-enrich: <reason>` — recipe author
 *       opted out with an in-place rationale.
 *
 *  Exempt namespaces (never enrichment-eligible):
 *    - `data.shared.*`       — user-writable cache layer
 *    - `data.memory.*`       — memory namespace (audit/insight/link)
 *    - `data.audit.*`        — D-120 alias for memory
 *    - `data.timeline.*`     — engine-injected feed (function-shaped)
 *    - `data.enrichment.*`   — already-the-substrate
 *    - `data.contact.*`      — base canonical record (annotation /
 *                              link reads aren't enrichment fetches)
 *
 *  Third-party recipes are unaffected — only `metadata.author` of
 *  `recued` or `recued-core` triggers the rule.
 *
 *  Spec: D-125 §"Phase 6.3 — Kernel + recued-core lint
 *  rule". */

import { collectRefs, type RecipeDefinition, type RecipeStep } from '@recued/contracts';

export interface EnrichmentLintIssue {
  code: 'enrichment_first_violation';
  /** Step id where the offending ref appears. */
  step_id: string;
  /** The ref path in `<namespace>.<path>` form, e.g. `data.contact.bob@x.com.summary`. */
  ref: string;
  message: string;
}

const KERNEL_AUTHORS: ReadonlySet<string> = new Set(['recued', 'recued-core']);

/** First-segment exemption set inside `data.*`. The lint rule only
 *  fires on warehouse collection reads (mail / calendar / file) that
 *  carry enrichable derived fields. `data.contact.*` is exempt because
 *  its first-class fields (`email`, `name`, annotations, links) are
 *  base-record reads, not enrichment fetches; recipes that need to
 *  read enrichments over a contact go through
 *  `data.enrichment.contact.<email>.<topic>` which is exempted under
 *  the substrate prefix below. */
const DATA_EXEMPT_COLLECTIONS: ReadonlySet<string> = new Set([
  'shared',
  'memory',
  'audit',
  'timeline',
  'enrichment',
  'contact',
]);

const NO_ENRICH_MARKER = /\/\/\s*no-enrich:/;

/** Walk every step in the recipe (prefetch + trigger + sequential)
 *  flagging `data.*` / `connection.*` refs that don't satisfy the
 *  enrichment-first convention. Returns an empty array for
 *  third-party publishers — the rule is scoped to kernel + recued-core
 *  only per spec load-bearing decision 7. */
export const lintEnrichmentFirst = (recipe: RecipeDefinition): EnrichmentLintIssue[] => {
  const author = recipe.metadata?.author;
  if (typeof author !== 'string' || !KERNEL_AUTHORS.has(author)) return [];

  const issues: EnrichmentLintIssue[] = [];

  const allSteps: RecipeStep[] = [
    ...((recipe.prefetch_steps ?? []) as unknown as RecipeStep[]),
    ...((recipe.trigger_steps ?? []) as unknown as RecipeStep[]),
    ...(recipe.steps ?? []),
  ];

  // Build allow-sets in one pass.
  const enrichmentOrFetchStepIds = new Set<string>();
  const fallbackStepIds = new Set<string>();
  for (const step of allSteps) {
    const transform = (step as Record<string, unknown>).transform;
    if (transform === 'enrichment-or-fetch') {
      enrichmentOrFetchStepIds.add(step.id);
      const fallback = (step as Record<string, unknown>).fallback_step;
      if (typeof fallback === 'string' && fallback.length > 0) {
        fallbackStepIds.add(fallback);
      }
    }
  }

  for (const step of allSteps) {
    if (enrichmentOrFetchStepIds.has(step.id)) continue;
    if (fallbackStepIds.has(step.id)) continue;
    const description = (step as Record<string, unknown>).description;
    if (typeof description === 'string' && NO_ENRICH_MARKER.test(description)) {
      continue;
    }

    const refs = collectRefs(step);
    for (const { ns, path } of refs) {
      if (ns === 'data') {
        const head = path.split('.', 1)[0]!;
        if (DATA_EXEMPT_COLLECTIONS.has(head)) continue;
        issues.push({
          code: 'enrichment_first_violation',
          step_id: step.id,
          ref: `${ns}.${path}`,
          message: `${author} recipes must read 'data.${path}' via 'enrichment-or-fetch' (or mark this step with '// no-enrich: <reason>').`,
        });
        continue;
      }
      if (ns === 'connection') {
        issues.push({
          code: 'enrichment_first_violation',
          step_id: step.id,
          ref: `${ns}.${path}`,
          message: `${author} recipes must read 'connection.${path}' via 'enrichment-or-fetch' (or mark this step with '// no-enrich: <reason>').`,
        });
      }
    }
  }

  return issues;
};
