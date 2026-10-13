/** D-323 — the shared reader every hop of an install offer goes through: the
 *  search result, the stored answer, the web app. */

import { describe, expect, it } from 'vitest';

import { INSTALL_OFFER_LIMIT, installOffersOf } from '../install-offers.js';

const OFFER = { kind: 'pack', slug: 'rental-book', name: 'Rental Book', publisher: 'recued-core', recipes: ['Collect the rent'] };

describe('installOffersOf', () => {
  it('keeps a well-formed offer as it is', () => {
    expect(installOffersOf([OFFER])).toEqual([OFFER]);
    expect(installOffersOf([{ ...OFFER, kind: 'recipe', recipes: undefined }])).toEqual([{ ...OFFER, kind: 'recipe', recipes: [] }]);
  });

  it('drops an offer an address could not carry, or that names no kind, name or publisher', () => {
    expect(installOffersOf([
      { ...OFFER, kind: 'workflow' },
      { ...OFFER, slug: '../settings' },
      { ...OFFER, slug: 'Rental Book' },
      { ...OFFER, name: '  ' },
      { ...OFFER, publisher: 7 },
      null,
      'rental-book',
    ])).toEqual([]);
  });

  it('caps the count, the recipe names and the text', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...OFFER, slug: `pack-${String(i)}` }));
    expect(installOffersOf(many)).toHaveLength(INSTALL_OFFER_LIMIT);
    const [long] = installOffersOf([{ ...OFFER, name: 'x'.repeat(500), recipes: ['a', 'b', 'c', 'd', 7] }]);
    expect(long!.name).toHaveLength(160);
    expect(long!.recipes).toEqual(['a', 'b', 'c']);
  });

  it('reads anything that is not a list as no offers', () => {
    expect(installOffersOf(undefined)).toEqual([]);
    expect(installOffersOf({ 0: OFFER })).toEqual([]);
  });
});
