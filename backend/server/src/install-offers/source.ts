/** D-323 — the offers chat's `tools.search` makes when nothing installed does what was asked:
 *  the owner's switch, the catalogue copy and what the server has installed,
 *  put together for one query.
 *
 *  ⛔ OWNER TURNS ONLY, BY WHERE IT IS CALLED. `tools.search` refuses any turn the
 *  owner does not govern before it reads a query (`ownerCatalogGuard`), and it
 *  is not on MCP at all. So an MCP client or a door never reaches this (D-153's
 *  "trusted-channel routing"); nothing here re-decides it. */

import type { InstallOffer } from '@recued/contracts';

import type { MarketplaceCatalogue } from './catalogue.js';
import { installedHoldsRequest, matchInstallOffers, type InstalledMatchText } from './match.js';

/** How long the first search waits for the first download. A copy held is used
 *  at once, so this only covers a new server's first request: the moment the
 *  feature is for. Every search waits, whatever it found installed (see
 *  {@link createInstallOfferSource}). The two files are 58 KB and 114 KB
 *  compressed. Measured 2026-10-12 from a machine reaching recued.com through a
 *  local proxy: 2.3 to 5 s each, most of it the proxy's TLS handshake; a direct
 *  path should be far quicker. A search that outwaits it answers without
 *  offers, and the download carries on for the next one. */
export const FIRST_CATALOGUE_WAIT_MS = 6_000;

export interface InstallOfferSourceDeps {
  readonly catalogue: MarketplaceCatalogue;
  /** The owner's switch (ruling P7: on unless turned off). */
  readonly enabled: () => boolean;
  /** Every installed pack's slug, read per search: an install moves it. */
  readonly installedPackSlugs: () => ReadonlySet<string>;
  /** Whether a recipe is installed (the recipe store's `get`). */
  readonly hasRecipe: (recipe_id: string) => boolean;
  readonly waitMs?: number;
}

/** The offers for one search: its query, and what it found installed. */
export type InstallOfferSource = (
  query: string,
  installed: ReadonlyArray<InstalledMatchText>,
) => Promise<InstallOffer[]>;

export const createInstallOfferSource = (deps: InstallOfferSourceDeps): InstallOfferSource =>
  async (query, installed) => {
    if (!deps.enabled()) return [];
    // ⛔ EVERY SEARCH WAITS for a new server's first download, not only one that
    // found nothing installed. A new server's first request is the moment the
    // feature is for, and what it finds installed says nothing about the offer:
    // live (2026-10-12), the first request, about rent, found two recipes by
    // letters, and answered without waiting it was offered nothing. The wait is
    // once a boot at most; a copy held is used at once.
    const catalogue = await deps.catalogue.ready(deps.waitMs ?? FIRST_CATALOGUE_WAIT_MS);
    if (catalogue === null) return [];
    // Ruling P2: something installed that does it is the answer.
    if (installedHoldsRequest(catalogue, query, installed)) return [];
    return matchInstallOffers(catalogue, query, {
      packSlugs: deps.installedPackSlugs(),
      hasRecipe: deps.hasRecipe,
    });
  };
