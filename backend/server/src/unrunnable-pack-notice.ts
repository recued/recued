/** Resolve validator findings about persisted catalog bodies back to the packs
 * the owner can actually open/update on `#packs/<pack_slug>`.
 *
 * A composition pack does not persist its pack manifest in `local_manifest`;
 * it persists the decomposed catalog. Therefore the validator reports `codex`
 * while the installed inventory and owner surface are keyed by `codex-pack`.
 * Treating those identifiers as interchangeable creates a plausible-looking
 * deep link to a pack that does not exist.
 */

import type { UnrunnableInstalledManifest } from './ingredient-authoring/installed-manifest-boot-check.js';
import { listInstalledPacks, packIngredientIds } from './pack-inventory.js';
import type { ContractStore } from './storage/contract-store.js';

export interface UnrunnablePackNoticeProjection {
  /** Findings named by installed pack slug where inventory proves the join. */
  findings: UnrunnableInstalledManifest[];
  /** False when any catalog had no provable installed-pack owner. A caller may
   * still link to the Packs list, but must not mint a detail URL. */
  exact_pack_identities: boolean;
}

const unresolved = (
  findings: readonly UnrunnableInstalledManifest[],
): UnrunnablePackNoticeProjection => ({
  findings: findings.map((finding) => ({
    ...finding,
    codes: [...finding.codes],
  })),
  exact_pack_identities: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Records packs key inventory by their generated `records-<hash>` catalog id,
 * while `#packs/<slug>` is keyed by the name the author gave the pack. The row
 * already carries that second identity; use it when present rather than minting
 * a valid-looking route to an inventory key the Packs surface cannot resolve. */
const ownerFacingPackSlug = (store: ContractStore, inventorySlug: string): string => {
  const value = store.get('installed_pack', [inventorySlug])?.value;
  if (!isRecord(value)) return inventorySlug;
  const authored = value.authored_pack_slug;
  return typeof authored === 'string' && authored.trim().length > 0
    ? authored.trim()
    : inventorySlug;
};

/** Join `local_manifest.slug` to every `installed_pack.ingredient_ids` claim.
 * Multiple owners expand to multiple notices (and therefore a list link); a
 * pack with several invalid catalogs is deduped with the union of error codes.
 * Any read failure falls back to the unprojected finding + list-only link — an
 * owner-notification helper must never turn a healthy listener boot into a
 * failed one. */
export const projectUnrunnableFindingsToPacks = (
  findings: readonly UnrunnableInstalledManifest[],
  store: ContractStore | undefined,
): UnrunnablePackNoticeProjection => {
  if (store === undefined) return unresolved(findings);
  try {
    const installed = listInstalledPacks(store).map((pack) => ({
      ...pack,
      owner_facing_slug: ownerFacingPackSlug(store, pack.pack_slug),
      ingredient_ids: new Set(packIngredientIds(store, pack.pack_slug)),
    }));
    let exactPackIdentities = true;
    // Namespace unresolved catalog ids separately from resolved pack ids. A
    // catalog and an unrelated pack are allowed to share a slug; merging them
    // would under-count the notice and attach the catalog's detail to the pack.
    const byDestination = new Map<string, UnrunnableInstalledManifest>();
    for (const finding of findings) {
      const owners = installed.filter((pack) => pack.ingredient_ids.has(finding.slug));
      if (owners.length === 0) {
        exactPackIdentities = false;
        byDestination.set(`catalog:${finding.slug}`, {
          ...finding,
          codes: [...finding.codes],
        });
        continue;
      }
      for (const owner of owners) {
        const key = `pack:${owner.owner_facing_slug}`;
        const previous = byDestination.get(key);
        if (previous === undefined) {
          byDestination.set(key, {
            ...finding,
            slug: owner.owner_facing_slug,
            version: owner.version,
            codes: [...finding.codes],
          });
          continue;
        }
        previous.codes = [...new Set([...previous.codes, ...finding.codes])].sort();
      }
    }
    return {
      findings: [...byDestination.values()],
      exact_pack_identities: exactPackIdentities,
    };
  } catch {
    return unresolved(findings);
  }
};
