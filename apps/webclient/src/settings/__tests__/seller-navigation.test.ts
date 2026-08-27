import { describe, expect, it } from 'vitest';

import { parseShellRoute } from '../../shell/route.js';
import {
  parseSellerAddress,
  sellerAddressSelection,
  sellerDetailAddress,
  sellerDirectoryAddress,
  sellerHierarchicalAddress,
  sellerListAddress,
} from '../seller-navigation.js';

describe('Seller hierarchical navigation contract', () => {
  it('builds directory, collection, page, and detail addresses', () => {
    expect(sellerDirectoryAddress().hash).toBe('#settings/seller');
    expect(sellerListAddress('orders').hash).toBe('#settings/seller/orders');
    expect(sellerListAddress('orders', 3).hash).toBe('#settings/seller/orders/page/3');
    expect(sellerDetailAddress('orders', 'ord:3').hash)
      .toBe('#settings/seller/orders/detail/ord%3A3');
  });

  it('parses every meaningful Seller depth as one typed address', () => {
    expect(parseSellerAddress(parseShellRoute('#settings/seller'))).toEqual({
      kind: 'directory',
    });
    expect(parseSellerAddress(parseShellRoute('#settings/seller/orders/page/3')))
      .toEqual({ kind: 'list', subpage: 'orders', page: 3 });
    expect(parseSellerAddress(parseShellRoute('#settings/seller/customers/detail/c-1')))
      .toEqual({ kind: 'detail', subpage: 'customers', itemId: 'c-1' });
  });

  it('fails stale tails to the nearest usable parent', () => {
    expect(parseSellerAddress(parseShellRoute('#settings/seller/unknown')))
      .toEqual({ kind: 'directory' });
    expect(parseSellerAddress(parseShellRoute('#settings/seller/overview/detail/x')))
      .toEqual({ kind: 'list', subpage: 'overview', page: 1 });
    expect(parseSellerAddress(parseShellRoute('#settings/seller/orders/page/nope')))
      .toEqual({ kind: 'list', subpage: 'orders', page: 1 });
    expect(parseSellerAddress(parseShellRoute('#settings/privacy'))).toBeNull();
  });

  it('projects an address into the single mount selection shape', () => {
    expect(sellerAddressSelection({ kind: 'directory' })).toEqual({
      subpage: null,
      itemId: null,
      page: 1,
    });
    expect(sellerAddressSelection({
      kind: 'detail',
      subpage: 'tiers',
      itemId: 'tier-1',
    })).toEqual({ subpage: 'tiers', itemId: 'tier-1', page: 1 });
  });

  it('canonicalizes tolerated stale tails to the exact rendered parent', () => {
    const stalePage = parseSellerAddress(
      parseShellRoute('#settings/seller/orders/page/nope/ignored'),
    )!;
    expect(sellerHierarchicalAddress(stalePage).hash)
      .toBe('#settings/seller/orders');
    const staleDetail = parseSellerAddress(
      parseShellRoute('#settings/seller/orders/detail/order-1/ignored'),
    )!;
    expect(sellerHierarchicalAddress(staleDetail).hash)
      .toBe('#settings/seller/orders/detail/order-1');
  });
});
