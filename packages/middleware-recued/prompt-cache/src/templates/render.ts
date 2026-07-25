/** D-164 P4a — system prompt renderer.
 *
 *  Pure function `renderSystemPrompt(catalog) → string`. Composes the
 *  framing + per-section blocks + NOTATION + PROTOCOL into the catalog
 *  system prompt the chat orchestrator hands to the LLM. The render
 *  is data-driven — it reads `SectionAssembly.description` +
 *  `CatalogToolEntry.{name, description, return_shape}` directly; no
 *  per-section special-casing beyond the bench-validated batching
 *  example block placement.
 *
 *  Bench provenance: all framing / NOTATION / PROTOCOL / batching-hint
 *  strings are verbatim ports from
 *  internal benchmarks.
 *  The mirrored MDs in `../prompts/*.md` are documentation; this file
 *  is the runtime source of truth.
 *
 *  See: D-164
 *  § 1 templates / § 4 catalog / § 6 batching. */

import type { CatalogToolEntry, SectionAssembly, SectionedCatalog } from '../types.js';

// ────────────────────────────────────────────────────────────────
// Bench-harvested prompt blocks
// ────────────────────────────────────────────────────────────────

/** Verbatim port of `compose-agent.ts:124-127`, widened from "two
 *  surfaces" to "six surfaces" to match D-164's 6-section catalog
 *  (bench validates 2; the other 4 are extrapolations per design doc
 *  § 4). Bench v5d two-surface framing lifted target-topic intent
 *  0% → 67-100% on smoke (HANDOFF §1); the six-section widening is
 *  the load-bearing extrapolation. */
export const FRAMING_BLOCK =
  'You answer a question using the user\'s personal-data warehouse. You cannot\n'
  + 'see the warehouse directly — you query it with tools. The catalog has six\n'
  + 'surfaces; pick the one that fits.';

/** Verbatim port of `compose-agent.ts:145-150`. The canonical batching
 *  example — synthetic emails so the prompt carries no per-user data.
 *  Renderer inserts this between the entity-query section header and
 *  its tool rows (where bench places it). */
export const BATCHING_HINT_EXAMPLE =
  'Example — resolve three REF<contacts> emails in one batched call:\n'
  + '{"tool_calls": [\n'
  + '  {"tool":"entity.query","arguments":{"operation":"search","kind":"contact","text":"alice@x.com"}},\n'
  + '  {"tool":"entity.query","arguments":{"operation":"search","kind":"contact","text":"bob@x.com"}},\n'
  + '  {"tool":"entity.query","arguments":{"operation":"search","kind":"contact","text":"carol@x.com"}}\n'
  + ']}';

/** Verbatim port of `compose-agent.ts:154-158`. Teaches `REF<X>` once
 *  at catalog level rather than per-tool. */
export const NOTATION_BLOCK =
  'NOTATION\n'
  + '- `REF<X>` in a Returns shape marks a value that is a KEY into collection\n'
  + '  X (contacts, mail, calendar, files), not a human-readable string.\n'
  + '- Shapes use TypeScript-ish notation: { field: type }, [shape] for arrays,\n'
  + '  plus primitives number / string / boolean / null.';

/** Verbatim port of `compose-agent.ts:160-163`. JSON-only turn
 *  protocol — either a `tool_calls` array or a final `answer`. */
export const PROTOCOL_BLOCK =
  'PROTOCOL\n'
  + 'Each turn, reply with exactly ONE JSON object and nothing else:\n'
  + '  - To query:  {"tool_calls": [{"tool": "<name>", "arguments": {...}}, ...]}\n'
  + '  - To finish: {"answer": "<your answer to the question>"}';

// ────────────────────────────────────────────────────────────────
// Per-tool + per-section rendering
// ────────────────────────────────────────────────────────────────

/** Render one tool row per bench `tool-catalog.ts:501-510` convention:
 *  `- <name> — <description>` with an optional `\n    Returns: <shape>`
 *  continuation when the tool carries a `return_shape` (enrichment
 *  section entries only — entity-query / memory-recall / etc. omit
 *  the field by construction).
 *
 *  Bench's render-worthiness gate (`tool-catalog.ts:485-491`) checks
 *  `tool.return_shape.includes('REF<')`; D-164's per-topic return
 *  shapes are bench-validated to carry REFs where meaningful, so the
 *  P4a render emits the Returns continuation whenever the field is
 *  present without re-asserting the substring check. */
export const renderToolRow = (tool: CatalogToolEntry): string => {
  const head = `- ${tool.name} — ${tool.description}`;
  if (tool.return_shape === undefined) return head;
  return `${head}\n    Returns: ${tool.return_shape}`;
};

/** Render a section block: section description, then per-tool rows.
 *
 *  For the entity-query section, the bench inserts the
 *  `BATCHING_HINT_EXAMPLE` block between the description and the tool
 *  rows (`compose-agent.ts:142-150`). This is the only per-section
 *  special case; every other section emits description → tool rows
 *  directly.
 *
 *  Sections with no tools render an empty string — the prompt
 *  omits empty sections entirely to keep signal-to-noise high. */
export const renderSectionBlock = (section: SectionAssembly): string => {
  if (section.tools.length === 0) return '';
  const parts: string[] = [section.description];
  if (section.section === 'entity-query') {
    parts.push('', BATCHING_HINT_EXAMPLE);
  }
  const toolRows = section.tools.map(renderToolRow).join('\n');
  parts.push('', toolRows);
  return parts.join('\n');
};

/** Render the full system prompt for one catalog snapshot.
 *
 *  Layout:
 *    1. `FRAMING_BLOCK`
 *    2. Each non-empty section in `catalog.sections` order, separated
 *       by a blank line.
 *    3. `NOTATION_BLOCK`
 *    4. `PROTOCOL_BLOCK`
 *
 *  Empty sections are skipped entirely. A catalog with zero non-empty
 *  sections still renders framing + NOTATION + PROTOCOL (the LLM
 *  sees an empty-warehouse posture); the chat layer is responsible
 *  for upstream gating if that's not desirable. */
export const renderSystemPrompt = (catalog: SectionedCatalog): string => {
  const blocks: string[] = [FRAMING_BLOCK];
  for (const section of catalog.sections) {
    const rendered = renderSectionBlock(section);
    if (rendered.length === 0) continue;
    blocks.push(rendered);
  }
  blocks.push(NOTATION_BLOCK, PROTOCOL_BLOCK);
  return blocks.join('\n\n');
};
