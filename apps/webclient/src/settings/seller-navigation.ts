/** Seller's fixed contribution to the shared hierarchical navigation model. */

import {
  hierarchicalAddress,
  hierarchicalLevel,
  type HierarchicalAddress,
} from '../shell/hierarchical-navigation.js';
import type { ShellRoute } from '../shell/route.js';

/** Addressable, user-facing Seller jobs. */
export const SELLER_SUBPAGES = [
  'overview',
  'offers',
  'orders',
  'tiers',
  'customers',
  'usage',
  'setup',
] as const;
export type SellerSubpage = (typeof SELLER_SUBPAGES)[number];

export const SELLER_COLLECTION_SUBPAGES = [
  'offers',
  'orders',
  'tiers',
  'customers',
  'usage',
] as const satisfies readonly SellerSubpage[];
export type SellerCollectionSubpage =
  (typeof SELLER_COLLECTION_SUBPAGES)[number];

export const isSellerSubpage = (value: unknown): value is SellerSubpage =>
  typeof value === 'string'
  && (SELLER_SUBPAGES as readonly string[]).includes(value);

export const isSellerCollectionSubpage = (
  value: SellerSubpage | null,
): value is SellerCollectionSubpage =>
  value !== null
  && (SELLER_COLLECTION_SUBPAGES as readonly SellerSubpage[]).includes(value);

export type SellerAddress =
  | { readonly kind: 'directory' }
  | {
      readonly kind: 'list';
      readonly subpage: SellerSubpage;
      readonly page: number;
    }
  | {
      readonly kind: 'detail';
      readonly subpage: SellerCollectionSubpage;
      readonly itemId: string;
    };

export const sellerDirectoryAddress = (): HierarchicalAddress =>
  hierarchicalAddress(
    'settings',
    hierarchicalLevel('seller', 'seller'),
  );

export const sellerListAddress = (
  subpage: SellerSubpage,
  page = 1,
): HierarchicalAddress => hierarchicalAddress(
  'settings',
  hierarchicalLevel('seller', 'seller'),
  hierarchicalLevel(`seller-section:${subpage}`, subpage),
  ...(page > 1
    ? [hierarchicalLevel(`seller-page:${page}`, 'page', String(page))]
    : []),
);

export const sellerDetailAddress = (
  subpage: SellerCollectionSubpage,
  itemId: string,
): HierarchicalAddress => hierarchicalAddress(
  'settings',
  hierarchicalLevel('seller', 'seller'),
  hierarchicalLevel(`seller-section:${subpage}`, subpage),
  hierarchicalLevel(`seller-detail:${itemId}`, 'detail', itemId),
);

export const sellerHierarchicalAddress = (
  address: SellerAddress,
): HierarchicalAddress => {
  if (address.kind === 'directory') return sellerDirectoryAddress();
  if (address.kind === 'detail') {
    return sellerDetailAddress(address.subpage, address.itemId);
  }
  return sellerListAddress(address.subpage, address.page);
};

const positivePage = (value: string | undefined): number | null => {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

/** Parse Seller's complete depth in one place. Unknown or stale tails fail to
 * the nearest usable parent instead of leaving a half-selected page. */
export const parseSellerAddress = (route: ShellRoute): SellerAddress | null => {
  if (route.surface !== 'settings' || route.segments[0] !== 'seller') return null;
  const subpage = route.segments[1];
  if (!isSellerSubpage(subpage)) return { kind: 'directory' };

  const mode = route.segments[2];
  if (
    mode === 'detail'
    && isSellerCollectionSubpage(subpage)
    && typeof route.segments[3] === 'string'
    && route.segments[3]!.trim().length > 0
  ) {
    return {
      kind: 'detail',
      subpage,
      itemId: route.segments[3]!,
    };
  }
  const page = mode === 'page' ? positivePage(route.segments[3]) : null;
  return {
    kind: 'list',
    subpage,
    page: page ?? 1,
  };
};

export const sellerAddressSelection = (
  address: SellerAddress | null | undefined,
): {
  readonly subpage: SellerSubpage | null;
  readonly itemId: string | null;
  readonly page: number;
} => {
  if (address === null || address === undefined || address.kind === 'directory') {
    return { subpage: null, itemId: null, page: 1 };
  }
  if (address.kind === 'detail') {
    return { subpage: address.subpage, itemId: address.itemId, page: 1 };
  }
  return { subpage: address.subpage, itemId: null, page: address.page };
};
