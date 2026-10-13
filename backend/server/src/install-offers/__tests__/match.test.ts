/** D-323 — the rules an offer is found by (`matchInstallOffers`), on a small
 *  catalogue built for each rule. The shipped catalogue is measured in
 *  `install-offers-corpus.test.ts`. */

import { describe, expect, it } from 'vitest';

import type { CataloguePackRow, CatalogueRecipeRow, MarketplaceCatalogueSnapshot } from '../catalogue.js';
import { capabilityWords, foldWordForm, matchInstallOffers, type InstalledState } from '../match.js';

const pack = (slug: string, name: string, tags: string[] = [], certified = true): CataloguePackRow => ({
  slug, name, tags, publisher_id: certified ? 'recued-core' : 'someone', publisher_certified: certified,
});
const recipe = (
  recipe_id: string,
  name: string,
  opts: { tags?: string[]; bundle?: string; certified?: boolean } = {},
): CatalogueRecipeRow => ({
  recipe_id,
  name,
  tags: opts.tags ?? [],
  publisher_id: opts.certified === false ? 'someone' : 'recued-core',
  publisher_certified: opts.certified !== false,
  ...(opts.bundle !== undefined ? { recipe_bundle: opts.bundle } : {}),
});
const catalogue = (
  packs: CataloguePackRow[],
  recipes: CatalogueRecipeRow[],
): MarketplaceCatalogueSnapshot => ({ packs, recipes, fetched_at: 0 });

const nothing: InstalledState = { packSlugs: new Set(), hasRecipe: () => false };

describe('word forms', () => {
  it('fold so a plural, an -ing, an -ed and a final e meet their stem', () => {
    expect(foldWordForm('parcels')).toBe(foldWordForm('parcel'));
    expect(foldWordForm('tracking')).toBe(foldWordForm('track'));
    expect(foldWordForm('meetings')).toBe(foldWordForm('meeting'));
    expect(foldWordForm('meeting')).toBe(foldWordForm('meet'));
    expect(foldWordForm('invoices')).toBe(foldWordForm('invoice'));
    expect(foldWordForm('approved')).toBe(foldWordForm('approve'));
    expect(foldWordForm('entries')).toBe(foldWordForm('entry'));
    expect(foldWordForm('weekly')).toBe(foldWordForm('week'));
  });

  it('leave a short word, a double s and a Latin -us or -is alone', () => {
    expect(foldWordForm('csv')).toBe('csv');
    expect(foldWordForm('address')).toBe('address');
    expect(foldWordForm('status')).toBe('status');
    expect(foldWordForm('analysis')).toBe('analysis');
  });

  it('drop a request’s grammar, keeping its subject', () => {
    expect(capabilityWords('Draft a follow-up email for my deals')).toEqual(['draft', 'follow', 'email', 'deal']);
  });
});

describe('what matches', () => {
  it('every word of the request, in its folded form', () => {
    const shop = catalogue([], [recipe('parcel-watch', 'Track parcels from mail')]);
    expect(matchInstallOffers(shop, 'parcel tracking', nothing).map((offer) => offer.slug)).toEqual(['parcel-watch']);
    // ⛔ One word of two is not enough: a wrong offer is shown to the owner.
    expect(matchInstallOffers(shop, 'parcel insurance', nothing)).toEqual([]);
  });

  it('a pack on its own words and its recipes’ names together, when one word is its own', () => {
    const shop = catalogue(
      // Two packs about other things: with only these two, "book" is in every
      // row, and a word every row holds weighs nothing.
      [pack('rental-book', 'Rental Book', ['rent']), pack('month-end', 'Month-end closer', ['bookkeeping']),
        pack('weather', 'Weather desk'), pack('parcels', 'Parcels')],
      [
        recipe('collect-rent', 'Collect the rent', { bundle: 'recued-core/rental-book' }),
        recipe('collection-sheet', 'Collection sheet', { bundle: 'recued-core/rental-book' }),
        recipe('book-lines', 'Book bank lines', { bundle: 'recued-core/month-end' }),
        recipe('month-reminder', 'Month-end reminder', { bundle: 'recued-core/month-end' }),
      ],
    );
    const [rent] = matchInstallOffers(shop, 'rent collection', nothing);
    expect(rent).toEqual({
      kind: 'pack',
      slug: 'rental-book',
      name: 'Rental Book',
      publisher: 'recued-core',
      recipes: ['Collect the rent', 'Collection sheet'],
    });
    // Both words only in its recipes, none of its own: not about the request.
    expect(matchInstallOffers(shop, 'booking reminder', nothing)).toEqual([]);
  });

  it('a pack whose one recipe holds every word, though none of the words is the pack’s own', () => {
    const shop = catalogue(
      [pack('reception-approval', 'Reception — Approval', ['reception'])],
      [recipe('release-quote', 'Release a customer-accepted quote', { bundle: 'recued-core/reception-approval' })],
    );
    expect(matchInstallOffers(shop, 'quote release', nothing)).toEqual([{
      kind: 'pack',
      slug: 'reception-approval',
      name: 'Reception — Approval',
      publisher: 'recued-core',
      recipes: ['Release a customer-accepted quote'],
    }]);
  });

  it('the start of a longer word, for a query word of five letters or more', () => {
    const shop = catalogue([], [recipe('payout-recon', 'Payout reconciliation brief')]);
    expect(matchInstallOffers(shop, 'reconcile payouts', nothing).map((offer) => offer.slug)).toEqual(['payout-recon']);
    const pay = catalogue([], [recipe('payroll', 'Payroll summary')]);
    expect(matchInstallOffers(pay, 'pay summary', nothing)).toEqual([]);
  });

  it('nothing for a request with no capability words', () => {
    const shop = catalogue([pack('a', 'Anything')], []);
    expect(matchInstallOffers(shop, 'the my for', nothing)).toEqual([]);
  });
});

describe('what an offer is', () => {
  it('a recipe its pack installs is offered as the pack, naming the recipes that matched', () => {
    const shop = catalogue(
      [pack('invoice-book', 'Invoice Book')],
      [
        recipe('who-owes', 'Who owes you: overdue invoices', { bundle: 'recued-core/invoice-book' }),
        recipe('issue', 'Issue an invoice', { bundle: 'recued-core/invoice-book' }),
      ],
    );
    expect(matchInstallOffers(shop, 'overdue invoices', nothing)).toEqual([{
      kind: 'pack',
      slug: 'invoice-book',
      name: 'Invoice Book',
      publisher: 'recued-core',
      recipes: ['Who owes you: overdue invoices', 'Issue an invoice'],
    }]);
  });

  it('a recipe that installs alone is offered as itself', () => {
    const shop = catalogue([], [recipe('summarize-pdf', 'Summarize a PDF')]);
    expect(matchInstallOffers(shop, 'summarize pdf', nothing)).toEqual([{
      kind: 'recipe', slug: 'summarize-pdf', name: 'Summarize a PDF', publisher: 'recued-core', recipes: ['Summarize a PDF'],
    }]);
  });

  it('a one-recipe pack whose recipe also installs alone is offered once, as the pack', () => {
    const shop = catalogue(
      [pack('meeting-notes-to-action', 'Meeting Notes To Action')],
      [recipe('meeting-notes-to-action', 'Meeting Notes To Action')],
    );
    expect(matchInstallOffers(shop, 'meeting notes', nothing)).toEqual([{
      kind: 'pack',
      slug: 'meeting-notes-to-action',
      name: 'Meeting Notes To Action',
      publisher: 'recued-core',
      recipes: ['Meeting Notes To Action'],
    }]);
  });

  it('at most three, best first: a name outweighs a tag, then the shorter name', () => {
    const shop = catalogue([], [
      recipe('a', 'Weather here'),
      recipe('b', 'Something', { tags: ['weather'] }),
      recipe('c', 'Weather radar'),
      recipe('d', 'Weather alerts'),
      recipe('e', 'Other', { tags: ['weather'] }),
    ]);
    const offers = matchInstallOffers(shop, 'weather', nothing);
    expect(offers).toHaveLength(3);
    expect(offers.map((offer) => offer.slug)).toEqual(['a', 'c', 'd']);
  });
});

describe('what is never offered', () => {
  it('an installed pack, or a recipe already installed', () => {
    const shop = catalogue(
      [pack('expense-ledger', 'Expense Ledger', ['receipts'])],
      [
        recipe('capture-receipt', 'Capture a receipt', { bundle: 'recued-core/expense-ledger' }),
        recipe('extract-receipt', 'Extract receipt fields'),
      ],
    );
    const installed: InstalledState = {
      packSlugs: new Set(['expense-ledger']),
      hasRecipe: (id) => id === 'extract-receipt',
    };
    expect(matchInstallOffers(shop, 'receipt', nothing).map((offer) => offer.slug).sort())
      .toEqual(['expense-ledger', 'extract-receipt']);
    expect(matchInstallOffers(shop, 'receipt', installed)).toEqual([]);
  });

  it('anything from a publisher that is not certified', () => {
    const shop = catalogue(
      [pack('shady', 'Invoice helper', [], false)],
      [recipe('also-shady', 'Invoice sender', { certified: false })],
    );
    expect(matchInstallOffers(shop, 'invoice', nothing)).toEqual([]);
  });

  it('a recipe whose pack the catalogue does not list, or lists uncertified', () => {
    const shop = catalogue(
      [pack('elsewhere', 'Elsewhere', [], false)],
      [
        recipe('orphan', 'Invoice orphan', { bundle: 'recued-core/missing' }),
        recipe('foreign', 'Invoice foreign', { bundle: 'someone/elsewhere' }),
      ],
    );
    expect(matchInstallOffers(shop, 'invoice', nothing)).toEqual([]);
  });
});
