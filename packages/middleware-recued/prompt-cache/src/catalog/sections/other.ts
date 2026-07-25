/** D-164 P3 — other section assembler.
 *
 *  Surfaces Tier 3 `<connection_name>.<tool_name>` entries — outbound
 *  MCP passthroughs + vendor API tools the user has connected. Filters
 *  by `connectedVendors` so disconnected vendors stay hidden.
 *
 *  Per-tool `concurrency_safe` is per-vendor implementation detail per
 *  D-137 § A.6.4 — until that metadata is plumbed end-to-end, the
 *  section defaults each entry to `false` (sequential). External APIs
 *  with hard rate limits would corrupt under naive batch dispatch;
 *  sequential is the safe default to flip later per-vendor.
 *
 *  Section description is an extrapolation — bench has no `other` arm.
 *  TODO(P4-bench): tune once vendor APIs are exercised.
 *
 *  See: D-164 § 4. */

import type {
  CatalogAssemblyInput,
  CatalogToolEntry,
  SectionAssembly,
} from '../../types.js';

import { tier3VendorVisible } from '../filter.js';

/** Extrapolation per design doc § 4. Pushes the LLM to prefer sections
 *  above before reaching for external APIs. */
export const OTHER_SECTION_DESCRIPTION =
  'Vendor APIs and outbound MCP servers the user has connected. Use only '
  + 'when nothing above fits — these touch external services with their own '
  + 'rate limits and may be slower than the local warehouse.';

export const assembleOtherSection = (
  input: CatalogAssemblyInput,
): SectionAssembly => {
  const tools: CatalogToolEntry[] = [];
  for (const entry of input.registryTools) {
    if (entry.tier !== 3) continue;
    if (!tier3VendorVisible(entry, input.capabilities)) continue;
    tools.push({
      name: entry.name,
      description: entry.description,
      // D-164 § 6 — per-tool `concurrency_safe` from
      // `buildTier3ToolEntry` via the registry-sourced ToolEntry.
      // Tier 3 vendor APIs default `false` (external services with
      // their own rate-limit budgets — concurrent dispatch corrupts
      // the budget without per-vendor knowledge). A future per-
      // vendor override on `ConnectionMcpToolOverride` (or upstream
      // `tools/list` annotation) could opt known-safe vendors into
      // the parallel path.
      concurrency_safe: entry.concurrency_safe,
    });
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return {
    section: 'other',
    description: OTHER_SECTION_DESCRIPTION,
    tools,
  };
};
