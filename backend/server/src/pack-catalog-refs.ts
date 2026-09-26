/** Which pack each installed catalog belongs to — the other half of the
 *  read-only proof on an INSTALLED recipe.
 *
 *  Pack install lowers a recipe's `<publisher>.<pack>.<operation>` step into a
 *  call on that pack's catalog ingredient and stores the lowered body. The
 *  proofs in `records-usage.ts` read an op id, so on every installed pack each
 *  read failed closed: `rental-book`, driven live, rendered no views and no
 *  lookups, only operation buttons. `PackOperationIndex.byCatalog` maps a
 *  lowered step back to its op, and this builds that map with the SAME rule
 *  install uses to name the catalog (`pack-install-handler.ts`): a Records
 *  composition runs through `recordsCatalogSlug(owner)`, a digest, which is why
 *  this is async; any other composition through its own `slug`.
 *
 *  ⛔ A catalog two packs claim maps to NEITHER. Which one a lowered step runs
 *  against is then the registry's question, not the proof's, and a proof that
 *  picked one would be guessing, so both stay unresolved and fail closed. None
 *  collide in the shipped corpus (889 catalogs for 889 compositions). */
import type { RecordsUsagePack } from '@recued/contracts';
import { isRecordsComposition, recordsCatalogSlug } from '@recued/ingredient-authoring';

/** A Records catalog slug depends only on its owner, so each is digested once
 *  per process rather than once per `recipe.list`. */
const recordsSlugByOwner = new Map<string, Promise<string>>();

const recordsSlugFor = (publisher: string, slug: string): Promise<string> => {
  const key = `${publisher}\u0000${slug}`;
  let pending = recordsSlugByOwner.get(key);
  if (pending === undefined) {
    pending = recordsCatalogSlug({ publisher, pack_slug: slug });
    recordsSlugByOwner.set(key, pending);
  }
  return pending;
};

export const packCatalogRefs = async (
  roster: readonly RecordsUsagePack[],
): Promise<Map<string, string>> => {
  const claims = new Map<string, Set<string>>();
  const claim = (catalog: string, packRef: string): void => {
    const owners = claims.get(catalog) ?? new Set<string>();
    owners.add(packRef);
    claims.set(catalog, owners);
  };
  for (const pack of roster) {
    const packRef = `${pack.publisher}.${pack.slug}`;
    for (const content of pack.manifest?.contents ?? []) {
      if (content.type !== 'composition') continue;
      if (isRecordsComposition(content.composition)) {
        claim(await recordsSlugFor(pack.publisher, pack.slug), packRef);
      } else if (typeof content.composition.slug === 'string' && content.composition.slug !== '') {
        claim(content.composition.slug, packRef);
      }
    }
  }
  const catalogs = new Map<string, string>();
  for (const [catalog, owners] of claims) {
    if (owners.size === 1) catalogs.set(catalog, [...owners][0]!);
  }
  return catalogs;
};
