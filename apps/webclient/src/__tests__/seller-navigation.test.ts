/** Settings → Seller addresses (2026-09-03) — every screen has its own hash,
 *  and every builder round-trips through the parser.
 *
 *  The shell canonicalises the address it arrived on through
 *  `sellerHierarchicalAddress(parseSellerAddress(route))`; a builder that
 *  emits a segment the parser drops would land the owner one level up. So
 *  each address kind is built, parsed, and rebuilt here, and the unknown
 *  shapes are pinned to the nearest screen rather than to a crash. */
import { describe, expect, it } from 'vitest';
import { parseShellRoute } from '../shell/route.js';
import {
  parseSellerAddress,
  sellerAddressSelection,
  sellerCreateAddress,
  sellerDetailAddress,
  sellerDirectoryAddress,
  sellerHierarchicalAddress,
  sellerListAddress,
  sellerSetupAddress,
  type SellerAddress,
} from '../settings/seller-navigation.js';

const roundTrip = (address: SellerAddress): { hash: string; parsed: SellerAddress | null; again: string } => {
  const hash = sellerHierarchicalAddress(address).hash;
  const parsed = parseSellerAddress(parseShellRoute(hash));
  const again = parsed === null ? '' : sellerHierarchicalAddress(parsed).hash;
  return { hash, parsed, again };
};

describe('Seller addresses — one hash per screen, at every level', () => {
  it('builds the documented hash for every kind', () => {
    expect(sellerDirectoryAddress().hash).toBe('#settings/seller');
    expect(sellerListAddress('tiers').hash).toBe('#settings/seller/tiers');
    expect(sellerListAddress('tiers', 3).hash).toBe('#settings/seller/tiers/page/3');
    expect(sellerDetailAddress('customers', 'customer-1').hash).toBe('#settings/seller/customers/detail/customer-1');
    expect(sellerDetailAddress('tiers', 'tier-1', 'edit').hash).toBe('#settings/seller/tiers/detail/tier-1/edit');
    expect(sellerDetailAddress('tiers', 'tier-1', 'customers').hash).toBe('#settings/seller/tiers/detail/tier-1/customers');
    expect(sellerCreateAddress('tiers').hash).toBe('#settings/seller/tiers/new');
    expect(sellerCreateAddress('tiers', 'pass').hash).toBe('#settings/seller/tiers/new/pass');
    expect(sellerCreateAddress('customers').hash).toBe('#settings/seller/customers/new');
    expect(sellerSetupAddress('defaults').hash).toBe('#settings/seller/setup/defaults');
    expect(sellerSetupAddress('gateway').hash).toBe('#settings/seller/setup/gateway');
    expect(sellerSetupAddress('providers', 'paddle').hash).toBe('#settings/seller/setup/providers/paddle');
  });

  it('opens the package\'s Re-apply tab from the link the D-308 repair notice sends', () => {
    // Pairs with `backend/server/src/seller/__tests__/d-308-permanent-pass-repair.test.ts`,
    // which pins the server's side of this same string. The server cannot import
    // this builder, so each side pins it: an id with a space and a slash.
    const link = '#settings/seller/tiers/detail/tier%20day%2F1/customers';
    expect(sellerDetailAddress('tiers', 'tier day/1', 'customers').hash).toBe(link);
    expect(parseSellerAddress(parseShellRoute(link))).toEqual({
      kind: 'detail', subpage: 'tiers', itemId: 'tier day/1', tab: 'customers',
    });
  });

  it('round-trips every kind through the parser and back to the same hash', () => {
    const addresses: SellerAddress[] = [
      { kind: 'directory' },
      { kind: 'list', subpage: 'overview', page: 1 },
      { kind: 'list', subpage: 'orders', page: 4 },
      { kind: 'list', subpage: 'setup', page: 1 },
      { kind: 'detail', subpage: 'offers', itemId: 'paid-document.outcome' },
      { kind: 'detail', subpage: 'tiers', itemId: 'tier-1' },
      { kind: 'detail', subpage: 'tiers', itemId: 'tier-1', tab: 'edit' },
      { kind: 'detail', subpage: 'tiers', itemId: 'tier-1', tab: 'customers' },
      { kind: 'create', subpage: 'tiers', variant: 'manual' },
      { kind: 'create', subpage: 'tiers', variant: 'pass' },
      { kind: 'create', subpage: 'customers', variant: 'manual' },
      { kind: 'setup', section: 'defaults' },
      { kind: 'setup', section: 'providers' },
      { kind: 'setup', section: 'providers', provider: 'lemonsqueezy' },
      { kind: 'setup', section: 'gateway' },
    ];
    for (const address of addresses) {
      const { hash, parsed, again } = roundTrip(address);
      expect(parsed, hash).toEqual(address);
      expect(again, hash).toBe(hash);
    }
  });

  it('lands unknown shapes on the nearest screen instead of nowhere', () => {
    const parse = (hash: string) => parseSellerAddress(parseShellRoute(hash));
    // An unknown subpage is the directory; an unknown setup section is the setup directory.
    expect(parse('#settings/seller/nope')).toEqual({ kind: 'directory' });
    expect(parse('#settings/seller/setup/nope')).toEqual({ kind: 'list', subpage: 'setup', page: 1 });
    // A tab only tiers have, on another collection, is ignored; an unknown tab is the record.
    expect(parse('#settings/seller/customers/detail/c1/edit')).toEqual({ kind: 'detail', subpage: 'customers', itemId: 'c1' });
    expect(parse('#settings/seller/tiers/detail/t1/nope')).toEqual({ kind: 'detail', subpage: 'tiers', itemId: 't1' });
    // A create variant a collection does not offer falls back to its manual screen;
    // a collection with no create screen at all reads `new` as its list.
    expect(parse('#settings/seller/customers/new/pass')).toEqual({ kind: 'create', subpage: 'customers', variant: 'manual' });
    expect(parse('#settings/seller/orders/new')).toEqual({ kind: 'list', subpage: 'orders', page: 1 });
    // A provider the registry does not know is dropped, not kept as a stray segment.
    expect(parse('#settings/seller/setup/providers/mollie')).toEqual({ kind: 'setup', section: 'providers' });
    // A non-numeric page is page one.
    expect(parse('#settings/seller/tiers/page/x')).toEqual({ kind: 'list', subpage: 'tiers', page: 1 });
    expect(parse('#settings/privacy')).toBeNull();
  });

  it('selection exposes exactly the deeper levels the address names', () => {
    expect(sellerAddressSelection({ kind: 'detail', subpage: 'tiers', itemId: 't1', tab: 'edit' }))
      .toMatchObject({ subpage: 'tiers', itemId: 't1', tab: 'edit', create: null, setupSection: null });
    expect(sellerAddressSelection({ kind: 'create', subpage: 'customers', variant: 'manual' }))
      .toMatchObject({ subpage: 'customers', itemId: null, create: 'manual' });
    expect(sellerAddressSelection({ kind: 'setup', section: 'providers', provider: 'paddle' }))
      .toMatchObject({ subpage: 'setup', setupSection: 'providers', setupProvider: 'paddle' });
    expect(sellerAddressSelection({ kind: 'list', subpage: 'usage', page: 2 }))
      .toMatchObject({ subpage: 'usage', page: 2, tab: null, create: null });
    expect(sellerAddressSelection(null)).toMatchObject({ subpage: null, page: 1 });
  });
});
