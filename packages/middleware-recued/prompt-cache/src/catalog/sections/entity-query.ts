/** D-164 P3 — entity-query section assembler.
 *
 *  Partitions Tier 1 read primitives that operate over warehouse
 *  collections: `contact.search`, `mail.search`, `calendar.search`,
 *  `deal.search`, `account.search`, plus future `entity.query`-shaped
 *  widenings.
 *
 *  Tier 1 partition map (every name in `TIER1_TOOL_NAMES` lands in
 *  exactly one chat-facing section):
 *
 *  | Tier 1 name        | Section          |
 *  |--------------------|------------------|
 *  | contact.search     | entity-query     |
 *  | mail.search        | entity-query     |
 *  | calendar.search    | entity-query     |
 *  | deal.search        | entity-query     |
 *  | account.search     | entity-query     |
 *  | memory.search      | memory-recall    |
 *  | recipe.run         | recipes          |
 *  | enrichment.search  | (intentionally   |
 *  |                    |  absent — § 5 §) |
 *
 *  `enrichment.search` is intentionally absent from the chat catalog:
 *  per design doc § 4 + § 5, the enrichment section surfaces per-topic
 *  entries directly (each with its bench-validated `{field: type}`
 *  annotation + default `suggest_directive`) instead of the umbrella
 *  search. The bench v3 finding (HANDOFF §1: agent picks base name
 *  overwhelmingly when both base + alias are present) reinforces the
 *  one-canonical-name rule — duplicating the per-topic surface with
 *  an umbrella `enrichment.search` would bias the LLM toward the
 *  generic search and away from the targeted topic. The Tier 1
 *  primitive remains registered for MCP introspection (`registry.describe`)
 *  but does not surface in the chat-facing catalog.
 *
 *  Section description is the verbatim bench-validated label per
 *  `recued-enrichment-benchmark/enrichment-farm/harness/compose-agent.ts:134-140`.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md § 4. */

import type {
  CatalogAssemblyInput,
  CatalogToolEntry,
  SectionAssembly,
} from '../../types.js';

/** Bench-validated verbatim label per `compose-agent.ts:134-140`. The
 *  REF-resolver framing carries the most weight on multi-hop episodes
 *  (HANDOFF §1 — section labels recovered REF resolution that v5b's
 *  global GUIDANCE block over-suppressed). */
export const ENTITY_QUERY_SECTION_DESCRIPTION =
  'Raw warehouse rows. Use to:\n'
  + '  (a) resolve REF<X> identifiers in an enrichment result when the question\n'
  + '      needs the resolved value (e.g. a human name behind a REF<contacts>\n'
  + '      email when the user asked WHO);\n'
  + '  (b) compose from raw rows when no enrichment fits.\n'
  + 'Batch independent calls in one tool_calls array — they run in parallel.';

/** Tier 1 entries that belong in this section. Closed list mirrors the
 *  Tier 1 search primitive set per D-137 § A.1.1; widening here is a
 *  substrate change synchronized with the chat.ts Tier 1 enum. */
const ENTITY_QUERY_TIER1_NAMES: ReadonlySet<string> = new Set([
  'contact.search',
  'mail.search',
  'calendar.search',
  'deal.search',
  'account.search',
]);

export const assembleEntityQuerySection = (
  input: CatalogAssemblyInput,
): SectionAssembly => {
  const tools: CatalogToolEntry[] = [];
  for (const entry of input.registryTools) {
    if (entry.tier !== 1) continue;
    if (!ENTITY_QUERY_TIER1_NAMES.has(entry.name)) continue;
    tools.push({
      name: entry.name,
      description: entry.description,
      // D-164 § 6 — per-tool `concurrency_safe` from
      // `TIER1_CONCURRENCY_SAFE` via the registry-sourced ToolEntry.
      // Every entity-query Tier 1 primitive declares `true` (local
      // warehouse read + idempotent — bench-validated for parallel
      // dispatch, HANDOFF lines 142-160). A future Tier 1 widening
      // that adds a non-safe read primitive flips its declaration
      // there, not here.
      concurrency_safe: entry.concurrency_safe,
    });
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return {
    section: 'entity-query',
    description: ENTITY_QUERY_SECTION_DESCRIPTION,
    tools,
  };
};
