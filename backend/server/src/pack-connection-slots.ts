/** D-320 §3.1 — which slot a catalog signs in to.
 *
 *  A slot is the connection name a pack's catalog declares (`http.connection`):
 *  one sign-in. Several readers name slots and must name them alike, or a name one
 *  shows is refused by another:
 *  - the Access page (`packs.connections.list`);
 *  - a run's own choice (`ExecuteRequest.connections`) and the run's record
 *    (`connections_used`);
 *  - the recipe tools chat and MCP list (`connections` argument).
 *
 *  The answer, in order:
 *  1. the slot its binding recorded: every install since D-320 slice 2b records it;
 *  2. else the slot the owning pack's manifest declares for that catalog. A pack
 *     installed before slice 2b keeps bindings with no slot until it is updated,
 *     since the boot reconciliation preserves bindings (`pack-reconciliation.ts`).
 *     A catalog no binding names (its pack's list is empty) is placed through the
 *     installed packs, as `catalogSignInReader` places it;
 *  3. else the catalog's own slug, so a catalog nobody can tell more about still
 *     names one slot. */

import type { BulkPackManifest } from '@recued/contracts';
import type { PackOpResolution } from '@recued/recipes';

import { resolveBundledPackManifest } from './bundled-pack-source.js';
import type { CatalogBinding } from './storage/connection-catalog-binding-store.js';

/** The connection name `manifest` declares for its composition `catalog`. */
export const authoredSlotOf = (
  manifest: BulkPackManifest | null | undefined,
  catalog: string,
): string | undefined => {
  for (const content of manifest?.contents ?? []) {
    if (content.type !== 'composition' || content.composition.slug !== catalog) continue;
    const ingredient = content.composition.ingredients?.[0];
    const authored = ingredient?.http?.connection ?? ingredient?.connection?.connection;
    if (typeof authored === 'string' && authored.length > 0) return authored;
  }
  return undefined;
};

/** The slot `catalog` signs in to, given its bindings and its pack's manifest. */
export const slotOfCatalog = (
  catalog: string,
  recorded: readonly Pick<CatalogBinding, 'catalog_slug' | 'slot'>[],
  manifest: BulkPackManifest | null | undefined,
): string =>
  recorded.find((b) => b.catalog_slug === catalog && b.slot !== undefined)?.slot
  ?? authoredSlotOf(manifest, catalog)
  ?? catalog;

/** The installed pack whose one op-declaring catalog is `catalog`. */
const installedPackOf = (packs: PackOpResolution | undefined, catalog: string): string | undefined => {
  for (const [ref, binding] of packs ?? []) {
    if (binding.catalog_slug === catalog) return ref.slice(ref.indexOf('.') + 1);
  }
  return undefined;
};

/** A pack's manifest by slug; null when it is not at hand. */
export type PackManifestOf = (pack_slug: string) => BulkPackManifest | null;

/** The shipped packs' manifests, as the execute handler reads them when nothing
 *  else is wired. */
export const bundledPackManifestOf: PackManifestOf = (pack_slug) =>
  resolveBundledPackManifest(undefined, pack_slug);

/** A pack's authored slot per catalog, once read. A pack's manifest changes only
 *  when the pack is installed or updated, which records the slot on its bindings,
 *  and a recorded slot is read before this. */
const authoredSlots = new Map<string, string | null>();

/** Forget the authored slots read so far (tests that rewrite a pack tree). */
export const clearAuthoredSlotCache = (): void => authoredSlots.clear();

/** Each of `catalogs`' slot, from `bindings` (the bindings a run read for them).
 *  The pack's manifest is read only for a catalog none of whose bindings recorded
 *  a slot, and once per pack and catalog.
 *
 *  D-320 audit — a catalog with no binding at all (its pack's list emptied; a
 *  registered vendor's catalog still serves the owner's runs then) is placed through
 *  the installed packs (`packs`), as the slot rule places it (`catalogSignInReader`).
 *  It fell back to the catalog's slug: the run recorded `hubspot-catalog`,
 *  `context.connections.hubspot` read empty, and a run choosing `hubspot` was refused. */
export const catalogSlotsFrom = (
  bindings: readonly (Pick<CatalogBinding, 'catalog_slug' | 'installed_pack_id' | 'slot'>)[],
  catalogs: readonly string[],
  packManifestOf: PackManifestOf,
  packs?: PackOpResolution,
): Map<string, string> => {
  const out = new Map<string, string>();
  for (const catalog of catalogs) {
    if (out.has(catalog)) continue;
    const own = bindings.filter((b) => b.catalog_slug === catalog);
    const recorded = own.find((b) => b.slot !== undefined)?.slot;
    if (recorded !== undefined) {
      out.set(catalog, recorded);
      continue;
    }
    const pack = own[0]?.installed_pack_id ?? installedPackOf(packs, catalog);
    if (pack === undefined) {
      out.set(catalog, catalog);
      continue;
    }
    const key = `${pack}\u0000${catalog}`;
    if (!authoredSlots.has(key)) authoredSlots.set(key, authoredSlotOf(packManifestOf(pack), catalog) ?? null);
    out.set(catalog, authoredSlots.get(key) ?? catalog);
  }
  return out;
};
