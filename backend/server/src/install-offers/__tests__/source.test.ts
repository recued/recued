/** D-323 — the offer source `tools.search` calls: the owner's switch, the
 *  catalogue copy and what is installed, put together per search. */

import { describe, expect, it } from 'vitest';

import type { MarketplaceCatalogue, MarketplaceCatalogueSnapshot } from '../catalogue.js';
import { createInstallOfferSource } from '../source.js';

const SNAPSHOT: MarketplaceCatalogueSnapshot = {
  packs: [{ slug: 'expense-ledger', name: 'Expense Ledger', tags: ['receipts'], publisher_id: 'recued-core', publisher_certified: true }],
  recipes: [{ recipe_id: 'extract-receipt', name: 'Extract receipt fields', tags: [], publisher_id: 'recued-core', publisher_certified: true }],
  fetched_at: 0,
};

const catalogue = (
  copy: MarketplaceCatalogueSnapshot | null,
  readies: number[] = [],
): MarketplaceCatalogue => ({
  current: () => copy,
  ensureFresh: () => undefined,
  refresh: async () => undefined,
  ready: async (waitMs) => { readies.push(waitMs); return copy; },
});

const RENT: MarketplaceCatalogueSnapshot = {
  packs: [
    { slug: 'rental-book', name: 'Rental Book', tags: ['rent'], publisher_id: 'recued-core', publisher_certified: true },
    { slug: 'commitments', name: 'Commitments', tags: [], publisher_id: 'recued-core', publisher_certified: true },
  ],
  recipes: [
    { recipe_id: 'collection-sheet', name: 'Collection sheet', tags: [], publisher_id: 'recued-core', publisher_certified: true, recipe_bundle: 'recued-core/rental-book' },
    { recipe_id: 'open-items', name: 'Open items', tags: [], publisher_id: 'recued-core', publisher_certified: true, recipe_bundle: 'recued-core/commitments' },
  ],
  fetched_at: 0,
};
const sourceOver = (copy: MarketplaceCatalogueSnapshot) => createInstallOfferSource({
  catalogue: catalogue(copy),
  enabled: () => true,
  installedPackSlugs: () => new Set(),
  hasRecipe: () => false,
});

describe('the offer source', () => {
  it('offers from the catalogue, leaving out what is installed, read at each search', async () => {
    let installed = new Set<string>();
    const source = createInstallOfferSource({
      catalogue: catalogue(SNAPSHOT),
      enabled: () => true,
      installedPackSlugs: () => installed,
      hasRecipe: () => false,
    });
    expect((await source('receipt', [])).map((offer) => offer.slug).sort()).toEqual(['expense-ledger', 'extract-receipt']);
    installed = new Set(['expense-ledger']);
    expect((await source('receipt', [])).map((offer) => offer.slug)).toEqual(['extract-receipt']);
  });

  it('⛔ offers nothing, and downloads nothing, once the owner turns offers off', async () => {
    const readies: number[] = [];
    let on = false;
    const source = createInstallOfferSource({
      catalogue: catalogue(SNAPSHOT, readies),
      enabled: () => on,
      installedPackSlugs: () => new Set(),
      hasRecipe: () => false,
    });
    expect(await source('receipt', [])).toEqual([]);
    expect(readies).toEqual([]);
    on = true;
    expect(await source('receipt', [])).not.toEqual([]);
    expect(readies).toEqual([6_000]);
  });

  it('⛔ offers nothing when something it found installed holds what the request is about', async () => {
    const found = [{ name: 'recued-core/receipt-log', description: 'Log each receipt as it comes in.', tags: [] }];
    expect(await sourceOver(SNAPSHOT)('receipt', found)).toEqual([]);
  });

  it('offers when what it found installed shares only letters or minor words with the request', async () => {
    // Live, 2026-10-12: Open commitments matched "rent" inside "for the current view".
    const found = [{ name: 'recued-core/open-commitments', description: 'Open commitments for the current view.', tags: [] }];
    expect((await sourceOver(RENT)('rent collection', found)).map((offer) => offer.slug)).toEqual(['rental-book']);
  });

  it('⛔ waits for a new server\'s first download whatever the search found installed', async () => {
    // Live, 2026-10-12: the first request, about rent, found two installed
    // recipes by letters; answered without waiting, it was offered nothing.
    const readies: number[] = [];
    const source = createInstallOfferSource({
      catalogue: catalogue(RENT, readies),
      enabled: () => true,
      installedPackSlugs: () => new Set(),
      hasRecipe: () => false,
    });
    const found = [{ name: 'recued-core/open-commitments', description: 'for the current view' }];
    expect((await source('rent collection', found)).map((offer) => offer.slug)).toEqual(['rental-book']);
    expect(readies).toEqual([6_000]);
  });

  it('offers nothing without a catalogue copy', async () => {
    const source = createInstallOfferSource({
      catalogue: catalogue(null),
      enabled: () => true,
      installedPackSlugs: () => new Set(),
      hasRecipe: () => false,
    });
    expect(await source('receipt', [])).toEqual([]);
  });
});
