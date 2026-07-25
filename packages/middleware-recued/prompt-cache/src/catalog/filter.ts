/** D-164 P3 — shared filter helpers used by the per-section catalog
 *  assemblers (`packages/middleware-recued/prompt-cache/src/catalog/sections/*`).
 *  Each section owns its own visibility rules; this module hosts the
 *  pure name/shape predicates the section assemblers share so the
 *  parsing logic lives in one place.
 *
 *  See: D-164 § 4. */

import type { IngredientKind, ToolEntry } from '@recued/contracts';

import type { CatalogCapabilities } from '../types.js';

/** Tier 3 tool entry name convention per D-137 § A.1.1: registry stores
 *  these as `<connection_name>.<tool_name>` (formatted by
 *  `buildTier3ToolEntry` in `packages/contracts/src/chat.ts`). The
 *  vendor segment is whatever the user named the connection at install
 *  time (often the literal vendor — `'hubspot'`, `'salesforce'` — but
 *  free-form). The catalog's `other` section filters by
 *  `connectedVendors` membership on this prefix.
 *
 *  This is NOT the D-128 platform-reference enrichment scope shape
 *  (`connection.api.<vendor>.<entity>` — 4 segments) — those live
 *  under `data.enrichment.connection.api.*` as enrichment topics and
 *  never appear as `tier: 3` entries in `InternalToolRegistry`. The
 *  catalog assembler trusts the registry's tier-shape contract; only
 *  D-137 Tier 3 chat tool names reach this helper.
 *
 *  Returns `null` for names that don't carry a dot separator
 *  (Tier 1 / Tier 2 entries should never reach this helper, but the
 *  null return makes the partitioner robust). */
export const vendorOfTier3Name = (name: string): string | null => {
  const dot = name.indexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(0, dot);
};

/** Tier 2 `requires_kinds` membership test. A Tier 2 entry surfaces in
 *  the catalog only when EVERY required kind is enabled in the user's
 *  per-`IngredientKind` toggle set; a single disabled kind hides the
 *  recipe per D-137 § A.1.1.
 *
 *  Entries with no `requires_kinds` declaration (or an empty array)
 *  pass through — they advertise no per-kind requirement. */
export const recipeKindsAllowed = (
  entry: ToolEntry,
  enabledKinds: ReadonlySet<IngredientKind>,
): boolean => {
  const required = entry.requires_kinds;
  if (required === undefined || required.length === 0) return true;
  for (const kind of required) {
    if (!enabledKinds.has(kind)) return false;
  }
  return true;
};

/** Permission/capability filter applied to a Tier 3 entry — narrows by
 *  vendor connectivity (no `hubspot` connection → hide every
 *  `hubspot.*` tool). Tier 3 entries whose vendor segment is missing
 *  or unparseable are dropped (the registry's `buildTier3ToolEntry`
 *  guarantees `<connection_name>.<tool_name>` shape, so unparseable
 *  names indicate either pre-D-137 entries or a registry bug — either
 *  way safer to hide than to surface unattributed). */
export const tier3VendorVisible = (
  entry: ToolEntry,
  capabilities: CatalogCapabilities,
): boolean => {
  const vendor = vendorOfTier3Name(entry.name);
  if (vendor === null) return false;
  return capabilities.connectedVendors.has(vendor);
};
