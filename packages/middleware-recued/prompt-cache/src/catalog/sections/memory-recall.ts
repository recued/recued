/** D-164 P3 — memory-recall section assembler.
 *
 *  Partitions the Tier 1 `memory.search` primitive (and future memory-
 *  scoped widenings). The bistemporal substrate underneath
 *  (`data.timeline`, `data.memory.search`) is the LLM-driven cross-
 *  session recall surface — anaphora and ambiguity handled by the
 *  model rather than a deterministic router (design doc § 2).
 *
 *  Section description is an extrapolation — bench has no memory-recall
 *  arm yet. TODO(P4-bench): validate framing against a memory-recall
 *  bench arm; tune copy if intent / adoption regresses.
 *
 *  See: D-164 § 4. */

import type {
  CatalogAssemblyInput,
  CatalogToolEntry,
  SectionAssembly,
} from '../../types.js';

/** Extrapolation per design doc § 4 — memory-recall section is
 *  bench-untested. Copy frames the intended use (cross-session recall +
 *  audit + planner activity) without leaking per-user hints. */
export const MEMORY_RECALL_SECTION_DESCRIPTION =
  'Recall from — and save to — the shared memory pool: past sessions, planner '
  + 'activity, and the audit log. Use `memory.search` when the question '
  + 'references something the user said before, a decision made previously, or '
  + 'context from outside the current conversation; use `memory.write` to save a '
  + 'durable fact / decision / preference worth remembering across sessions. The '
  + 'timeline is bistemporal — sort by event time (when the underlying fact '
  + 'happened) or ingestion time (when Recued recorded it).';

/** Tier 1 entries that belong in this section — the memory-scoped read + write
 *  primitives (D-198 adds `memory.write`, the durable-save half of the pool). */
const MEMORY_RECALL_TIER1_NAMES: ReadonlySet<string> = new Set([
  'memory.search',
  'memory.write',
]);

export const assembleMemoryRecallSection = (
  input: CatalogAssemblyInput,
): SectionAssembly => {
  const tools: CatalogToolEntry[] = [];
  for (const entry of input.registryTools) {
    if (entry.tier !== 1) continue;
    if (!MEMORY_RECALL_TIER1_NAMES.has(entry.name)) continue;
    tools.push({
      name: entry.name,
      description: entry.description,
      // D-164 § 6 — per-tool `concurrency_safe` from
      // `TIER1_CONCURRENCY_SAFE` via the registry-sourced ToolEntry
      // (`memory.search` declares `true` — idempotent local read).
      concurrency_safe: entry.concurrency_safe,
    });
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return {
    section: 'memory-recall',
    description: MEMORY_RECALL_SECTION_DESCRIPTION,
    tools,
  };
};
