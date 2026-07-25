/** Discover deps box — derive the pack(s) a recipe HARD-depends on.
 *
 *  A recipe declares the Tier-P packs whose ops it uses in
 *  `recipe.depends_on: ["<publisher>.<pack>"[@N]]` (D-182 §3). Each entry maps
 *  1:1 onto an installable pack (`publisher` + `pack` = the pack's slug), so the
 *  install-consent flow can show "this recipe needs pack X" and co-install any
 *  missing one WITHOUT a reverse ingredient→pack index. Tier-K `core.*` (kernel)
 *  ops need no pack, so a recipe calling only kernel ops has no required packs.
 *
 *  `depends_on` is the authoritative DECLARED source — the install + Compose
 *  validators enforce that every Tier-P `op` a step names is covered by an entry
 *  (`uncoveredOpDependencies`), so a published recipe's `depends_on` is complete.
 *
 *  Pure — same recipe → same list (deduped by `pack_ref`, keeping the highest
 *  pinned `min_version`; sorted by pack slug for stable rendering). Mirrors the
 *  sibling `required-connections.ts` / `required-file-slugs.ts` derivations.
 */

import { parseDependsOn, type BulkPackManifest, type DependsOnEntry } from '@recued/contracts';

/** A pack a recipe depends on: `{ pack_ref, publisher, pack, min_version? }`
 *  (the `parseDependsOn` shape). `pack` is the installable marketplace slug. */
export type RequiredPack = DependsOnEntry;

/** Derive a recipe's hard pack deps from `depends_on`. Accepts the loose
 *  (possibly untrusted, network-fetched) recipe shape — a `RecipeDefinition`
 *  satisfies it — and reads `depends_on` defensively (a non-array or a
 *  non-string entry is ignored, not thrown). */
export const recipeRequiredPacks = (recipe: { depends_on?: unknown }): RequiredPack[] => {
  const raw = Array.isArray(recipe.depends_on) ? recipe.depends_on : [];
  const byRef = new Map<string, RequiredPack>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const parsed = parseDependsOn(entry);
    if (parsed === null) continue; // malformed / not a <publisher>.<pack> ref
    const prev = byRef.get(parsed.pack_ref);
    // Same pack pinned at two versions → keep the stricter (higher) floor.
    if (prev === undefined || (parsed.min_version ?? 0) > (prev.min_version ?? 0)) {
      byRef.set(parsed.pack_ref, parsed);
    }
  }
  return [...byRef.values()].sort((a, b) => a.pack.localeCompare(b.pack));
};

// ────────────────────────────────────────────────────────────────
// Resolution — join the required packs against the local roster
// ────────────────────────────────────────────────────────────────

/** The subset of a `packs.list` row the resolver needs — the caller maps a
 *  `PackListEntry` into this (lifting `service_kind` out of the manifest). */
export interface DepPackInfo {
  slug: string;
  publisher: string;
  name: string;
  installed: boolean;
  requires: readonly string[];
  service_kind?: string;
  /** The pack's full manifest (`packs.list` returns it). Carried so the
   *  co-install consent dialog can derive the {Access × Scope} grant picker
   *  for a connection-backed dep (D-182 §7.1/§7.2 — same picker the direct
   *  pack install shows). Absent for a marketplace-only (unknown) dep. */
  manifest?: BulkPackManifest;
}

/** One resolved dependency: the required pack joined against the roster. */
export interface ResolvedDep {
  pack_ref: string;
  publisher: string;
  /** Installable pack slug. */
  pack: string;
  /** Display name (from the roster; falls back to the slug when unknown). */
  name: string;
  service_kind?: string;
  /** Permissions to grant when co-installing (the pack's `requires[]`). Empty
   *  for an unknown pack. */
  requires: readonly string[];
  installed: boolean;
  /** True when the pack is in the local roster (bundled). False = not found —
   *  the marketplace-only edge; shown as "needs pack X" without co-install. */
  known: boolean;
  min_version?: number;
  /** The pack's manifest (roster-resolved / known deps only) — drives the
   *  co-install grant picker. Absent for an unknown dep (no picker). */
  manifest?: BulkPackManifest;
}

/** Resolve a recipe's required packs against the `packs.list` roster. Pure —
 *  matches by slug (publisher is advisory; the slug is the install key). An
 *  unmatched required pack resolves to `{ known: false, installed: false }` so
 *  the dialog can still name it. */
export const resolveRecipeDeps = (
  required: readonly RequiredPack[],
  roster: readonly DepPackInfo[],
): ResolvedDep[] => {
  const bySlug = new Map(roster.map((p) => [p.slug, p] as const));
  return required.map((dep) => {
    const hit = bySlug.get(dep.pack);
    if (hit === undefined) {
      return {
        pack_ref: dep.pack_ref,
        publisher: dep.publisher,
        pack: dep.pack,
        name: dep.pack,
        requires: [],
        installed: false,
        known: false,
        ...(dep.min_version !== undefined ? { min_version: dep.min_version } : {}),
      };
    }
    return {
      pack_ref: dep.pack_ref,
      publisher: dep.publisher,
      pack: dep.pack,
      name: hit.name,
      ...(hit.service_kind !== undefined ? { service_kind: hit.service_kind } : {}),
      requires: hit.requires,
      installed: hit.installed,
      known: true,
      ...(dep.min_version !== undefined ? { min_version: dep.min_version } : {}),
      ...(hit.manifest !== undefined ? { manifest: hit.manifest } : {}),
    };
  });
};

/** The missing (not-installed) subset — what the consent dialog offers to
 *  co-install. */
export const missingDeps = (resolved: readonly ResolvedDep[]): ResolvedDep[] =>
  resolved.filter((d) => !d.installed);
