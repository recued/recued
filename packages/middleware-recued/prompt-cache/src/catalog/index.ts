/** D-164 P3 — top-level catalog assembler.
 *
 *  Composes the 6-section `SectionedCatalog` the prompt renderer (P4)
 *  consumes. Sections appear in bench-validated display order:
 *  enrichment first (fast track), entity-query second (safe path /
 *  resolver), followed by the four extrapolation sections in their
 *  spec § 4 listing order.
 *
 *  The assembler is pure — it reads `CatalogAssemblyInput` and emits
 *  a `SectionedCatalog`. No registry coupling, no per-pair state, no
 *  side effects. P4 wires the inputs (registry snapshot, declarations,
 *  descriptions, capabilities) at every chat turn.
 *
 *  Input trust boundary: the assembler trusts its snapshot. Upstream
 *  guarantees:
 *    - `InternalToolRegistry` projects Tier 3 entries through
 *      `buildTier3ToolEntry` so `tier: 3` rows always carry a
 *      `<connection_name>.<tool_name>` shape;
 *    - `D145_PRODUCER_DECLARATIONS` is closed-list at registry load
 *      (validator gates absent fields per `validateEnrichmentDeclaration`);
 *    - the caller resolves D-132 `enrichment_trust` rows to the
 *      `enabledEnrichmentTopics` set membership before calling.
 *  Duplicate or spoofed inputs (e.g. a malformed `tier: 3` entry with
 *  a Tier 1 name) are an upstream contract violation; the assembler
 *  does not double-validate at catalog assembly time.
 *
 *  Re-exports the per-section assemblers + their description constants
 *  so callers + tests can target individual sections without depending
 *  on the section file paths directly.
 *
 *  See: D-164 § 4. */

import type { CatalogAssemblyInput, SectionedCatalog } from '../types.js';

import { assembleEnrichmentSection, ENRICHMENT_SECTION_DESCRIPTION } from './sections/enrichment.js';
import { assembleEntityQuerySection, ENTITY_QUERY_SECTION_DESCRIPTION } from './sections/entity-query.js';
import { assembleMemoryRecallSection, MEMORY_RECALL_SECTION_DESCRIPTION } from './sections/memory-recall.js';
import { assembleEntityActionSection, ENTITY_ACTION_SECTION_DESCRIPTION } from './sections/entity-action.js';
import { assembleRecipesSection, RECIPES_SECTION_DESCRIPTION } from './sections/recipes.js';
import { assembleOtherSection, OTHER_SECTION_DESCRIPTION } from './sections/other.js';

export {
  ENRICHMENT_SECTION_DESCRIPTION,
  ENTITY_QUERY_SECTION_DESCRIPTION,
  MEMORY_RECALL_SECTION_DESCRIPTION,
  ENTITY_ACTION_SECTION_DESCRIPTION,
  RECIPES_SECTION_DESCRIPTION,
  OTHER_SECTION_DESCRIPTION,
  assembleEnrichmentSection,
  assembleEntityQuerySection,
  assembleMemoryRecallSection,
  assembleEntityActionSection,
  assembleRecipesSection,
  assembleOtherSection,
};

export const assembleCatalog = (input: CatalogAssemblyInput): SectionedCatalog => ({
  sections: [
    assembleEnrichmentSection(input),
    assembleEntityQuerySection(input),
    assembleMemoryRecallSection(input),
    assembleEntityActionSection(input),
    assembleRecipesSection(input),
    assembleOtherSection(input),
  ],
});
