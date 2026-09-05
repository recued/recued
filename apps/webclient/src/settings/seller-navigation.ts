/** Settings → Seller addresses: one hash per screen, at every level.
 *
 *  Every Seller screen has its own `#settings/seller/…` address, so Back,
 *  Forward, reload, and a pasted link all land on exactly what was on screen.
 *  The grammar (polished 2026-09-03 — setup sections, create pages, and tier
 *  detail tabs joined the directory / list / detail levels):
 *
 *    #settings/seller                             directory
 *    #settings/seller/<subpage>                   list (or the setup directory)
 *    #settings/seller/<subpage>/page/<n>          list page n
 *    #settings/seller/<collection>/detail/<id>    one record
 *    #settings/seller/tiers/detail/<id>/<tab>     one tier's `edit` / `customers` tab
 *    #settings/seller/tiers/new                   create a manual tier
 *    #settings/seller/tiers/new/pass              create a pass tier
 *    #settings/seller/customers/new               issue a manual customer
 *    #settings/seller/setup/<section>             defaults / providers / gateway
 *    #settings/seller/setup/providers/<provider>  the tier seed with a provider chosen
 *
 *  The shell canonicalises the address it arrived on through
 *  `sellerHierarchicalAddress(parseSellerAddress(route))`, so every builder
 *  here must round-trip through `parseSellerAddress` — a segment the parser
 *  does not know is dropped, not preserved. */
import {
  SELLER_PROVIDER_SOURCES,
  isSellerProviderSource,
  type SellerProviderSource,
} from '@recued/contracts';
import {
  hierarchicalAddress,
  hierarchicalLevel,
  type HierarchicalAddress,
} from '../shell/hierarchical-navigation.js';
import type { ShellRoute } from '../shell/route.js';

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

/** The setup area is three screens, each with its own address. */
export const SELLER_SETUP_SECTIONS = ['defaults', 'providers', 'gateway'] as const;
export type SellerSetupSection = (typeof SELLER_SETUP_SECTIONS)[number];

/** Collections with a "new" screen, and the variants that screen offers. A
 *  manual tier and a pass tier are different forms behind different rpcs, so
 *  each is its own address. */
export const SELLER_CREATE_VARIANTS = {
  tiers: ['manual', 'pass'],
  customers: ['manual'],
} as const;
export type SellerCreateSubpage = keyof typeof SELLER_CREATE_VARIANTS;
export type SellerCreateVariant =
  (typeof SELLER_CREATE_VARIANTS)[SellerCreateSubpage][number];

/** A tier's detail has three screens: the record with its usage limits (the
 *  default), the metadata edit form, and the bulk customer adjustment. */
export const SELLER_TIER_DETAIL_TABS = ['edit', 'customers'] as const;
export type SellerTierDetailTab = (typeof SELLER_TIER_DETAIL_TABS)[number];

export const isSellerSubpage = (value: unknown): value is SellerSubpage =>
  typeof value === 'string'
  && (SELLER_SUBPAGES as readonly string[]).includes(value);

export const isSellerCollectionSubpage = (
  value: SellerSubpage | null,
): value is SellerCollectionSubpage =>
  value !== null
  && (SELLER_COLLECTION_SUBPAGES as readonly SellerSubpage[]).includes(value);

export const isSellerSetupSection = (value: unknown): value is SellerSetupSection =>
  typeof value === 'string'
  && (SELLER_SETUP_SECTIONS as readonly string[]).includes(value);

export const isSellerCreateSubpage = (value: unknown): value is SellerCreateSubpage =>
  typeof value === 'string' && Object.hasOwn(SELLER_CREATE_VARIANTS, value);

export const isSellerCreateVariant = (
  subpage: SellerCreateSubpage,
  value: unknown,
): value is SellerCreateVariant =>
  typeof value === 'string'
  && (SELLER_CREATE_VARIANTS[subpage] as readonly string[]).includes(value);

export const isSellerTierDetailTab = (value: unknown): value is SellerTierDetailTab =>
  typeof value === 'string'
  && (SELLER_TIER_DETAIL_TABS as readonly string[]).includes(value);

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
      /** Only tiers have tabs; absent = the record itself. */
      readonly tab?: SellerTierDetailTab;
    }
  | {
      readonly kind: 'create';
      readonly subpage: SellerCreateSubpage;
      readonly variant: SellerCreateVariant;
    }
  | {
      readonly kind: 'setup';
      readonly section: SellerSetupSection;
      /** `providers` only: the provider the tier-seed form opens on. */
      readonly provider?: SellerProviderSource;
    };

const sellerLevel = (): ReturnType<typeof hierarchicalLevel> =>
  hierarchicalLevel('seller', 'seller');
const sectionLevel = (subpage: SellerSubpage): ReturnType<typeof hierarchicalLevel> =>
  hierarchicalLevel(`seller-section:${subpage}`, subpage);

export const sellerDirectoryAddress = (): HierarchicalAddress =>
  hierarchicalAddress('settings', sellerLevel());

export const sellerListAddress = (
  subpage: SellerSubpage,
  page = 1,
): HierarchicalAddress => hierarchicalAddress(
  'settings',
  sellerLevel(),
  sectionLevel(subpage),
  ...(page > 1
    ? [hierarchicalLevel(`seller-page:${page}`, 'page', String(page))]
    : []),
);

export const sellerDetailAddress = (
  subpage: SellerCollectionSubpage,
  itemId: string,
  tab?: SellerTierDetailTab,
): HierarchicalAddress => hierarchicalAddress(
  'settings',
  sellerLevel(),
  sectionLevel(subpage),
  hierarchicalLevel(`seller-detail:${itemId}`, 'detail', itemId),
  ...(tab !== undefined && subpage === 'tiers'
    ? [hierarchicalLevel(`seller-detail-tab:${tab}`, tab)]
    : []),
);

export const sellerCreateAddress = (
  subpage: SellerCreateSubpage,
  variant: SellerCreateVariant = 'manual',
): HierarchicalAddress => hierarchicalAddress(
  'settings',
  sellerLevel(),
  sectionLevel(subpage),
  // The manual variant is the bare `new`; only a pass tier names itself.
  hierarchicalLevel(
    `seller-create:${variant}`,
    'new',
    ...(variant === 'pass' ? ['pass'] : []),
  ),
);

export const sellerSetupAddress = (
  section: SellerSetupSection,
  provider?: SellerProviderSource,
): HierarchicalAddress => hierarchicalAddress(
  'settings',
  sellerLevel(),
  sectionLevel('setup'),
  hierarchicalLevel(`seller-setup:${section}`, section),
  ...(section === 'providers' && provider !== undefined
    ? [hierarchicalLevel(`seller-setup-provider:${provider}`, provider)]
    : []),
);

export const sellerHierarchicalAddress = (
  address: SellerAddress,
): HierarchicalAddress => {
  switch (address.kind) {
    case 'directory':
      return sellerDirectoryAddress();
    case 'detail':
      return sellerDetailAddress(address.subpage, address.itemId, address.tab);
    case 'create':
      return sellerCreateAddress(address.subpage, address.variant);
    case 'setup':
      return sellerSetupAddress(address.section, address.provider);
    case 'list':
      return sellerListAddress(address.subpage, address.page);
  }
};

const positivePage = (value: string | undefined): number | null => {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export const parseSellerAddress = (route: ShellRoute): SellerAddress | null => {
  if (route.surface !== 'settings' || route.segments[0] !== 'seller') return null;
  const subpage = route.segments[1];
  if (!isSellerSubpage(subpage)) return { kind: 'directory' };
  const mode = route.segments[2];
  if (subpage === 'setup') {
    if (isSellerSetupSection(mode)) {
      const provider = route.segments[3];
      return {
        kind: 'setup',
        section: mode,
        ...(mode === 'providers' && isSellerProviderSource(provider)
          ? { provider }
          : {}),
      };
    }
    return { kind: 'list', subpage, page: 1 };
  }
  if (
    mode === 'detail'
    && isSellerCollectionSubpage(subpage)
    && typeof route.segments[3] === 'string'
    && route.segments[3]!.trim().length > 0
  ) {
    const tab = route.segments[4];
    return {
      kind: 'detail',
      subpage,
      itemId: route.segments[3]!,
      ...(subpage === 'tiers' && isSellerTierDetailTab(tab) ? { tab } : {}),
    };
  }
  if (mode === 'new' && isSellerCreateSubpage(subpage)) {
    const variant = route.segments[3];
    return {
      kind: 'create',
      subpage,
      variant: variant !== undefined && isSellerCreateVariant(subpage, variant)
        ? variant
        : 'manual',
    };
  }
  const page = mode === 'page' ? positivePage(route.segments[3]) : null;
  return {
    kind: 'list',
    subpage,
    page: page ?? 1,
  };
};

export interface SellerAddressSelection {
  readonly subpage: SellerSubpage | null;
  readonly itemId: string | null;
  readonly page: number;
  readonly tab: SellerTierDetailTab | null;
  readonly create: SellerCreateVariant | null;
  readonly setupSection: SellerSetupSection | null;
  readonly setupProvider: SellerProviderSource | null;
}

const NO_SELECTION: SellerAddressSelection = {
  subpage: null,
  itemId: null,
  page: 1,
  tab: null,
  create: null,
  setupSection: null,
  setupProvider: null,
};

export const sellerAddressSelection = (
  address: SellerAddress | null | undefined,
): SellerAddressSelection => {
  if (address === null || address === undefined || address.kind === 'directory') {
    return NO_SELECTION;
  }
  switch (address.kind) {
    case 'detail':
      return {
        ...NO_SELECTION,
        subpage: address.subpage,
        itemId: address.itemId,
        tab: address.tab ?? null,
      };
    case 'create':
      return { ...NO_SELECTION, subpage: address.subpage, create: address.variant };
    case 'setup':
      return {
        ...NO_SELECTION,
        subpage: 'setup',
        setupSection: address.section,
        setupProvider: address.provider ?? null,
      };
    case 'list':
      return { ...NO_SELECTION, subpage: address.subpage, page: address.page };
  }
};

/** The providers a setup deep link may name, in registry order. */
export const SELLER_SETUP_PROVIDERS: readonly SellerProviderSource[] = SELLER_PROVIDER_SOURCES;
