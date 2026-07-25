/** D-164 P3 — enrichment section assembler.
 *
 *  Reads per-topic `EnrichmentDeclaration` entries the caller supplies,
 *  filters by `capabilities.enabledEnrichmentTopics` (D-132 trust gate),
 *  and renders each as a `CatalogToolEntry` carrying the bench-validated
 *  `{field: type}` annotation + `concurrency_safe` + default
 *  `suggest_directive`.
 *
 *  Section description is the verbatim bench-validated short label per
 *  internal benchmarks:128-131`.
 *
 *  See: D-164 § 4 + § 5. */

import type {
  CatalogAssemblyInput,
  CatalogToolEntry,
  SectionAssembly,
} from '../../types.js';

/** Bench-validated verbatim label per `compose-agent.ts:128-131` (v5d
 *  two-section framing — ENRICHMENT TOOLS lifted target-topic intent
 *  0% → 67-100% on smoke per HANDOFF §1). */
export const ENRICHMENT_SECTION_DESCRIPTION =
  'Pre-computed facts (rates, patterns, scores). If one enrichment answers '
  + 'the question, call it and answer.';

/** Placeholder description for topics whose `enrichmentDescriptions`
 *  entry is missing. Surfacing an empty string would let the renderer
 *  emit a `topic: <blank>` row to the LLM; this fallback keeps the
 *  catalog navigable while flagging the missing copy. */
const MISSING_DESCRIPTION_PLACEHOLDER = '(no description)';

export const assembleEnrichmentSection = (
  input: CatalogAssemblyInput,
): SectionAssembly => {
  const tools: CatalogToolEntry[] = [];
  for (const [topic, declaration] of input.enrichmentDeclarations) {
    if (!input.capabilities.enabledEnrichmentTopics.has(topic)) continue;
    const description =
      input.enrichmentDescriptions.get(topic) ?? MISSING_DESCRIPTION_PLACEHOLDER;
    tools.push({
      name: topic,
      description,
      concurrency_safe: declaration.concurrency_safe,
      return_shape: declaration.return_shape,
      suggest_directive: declaration.suggest_directive,
    });
  }
  // Stable alphabetical ordering — Map iteration order is insertion-
  // order, but the catalog's display order should be deterministic
  // regardless of declaration import order.
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return {
    section: 'enrichment',
    description: ENRICHMENT_SECTION_DESCRIPTION,
    tools,
  };
};
