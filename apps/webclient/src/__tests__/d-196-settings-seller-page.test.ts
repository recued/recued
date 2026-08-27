/** D-196 S2 - Settings -> Seller page. */

import { describe, expect, it, vi } from 'vitest';
import { LLM_GATEWAY_PAID_ACK_VERSION } from '@recued/contracts';
import type {
  SellerCreatePassTierResponse,
  SellerCustomer,
  SellerListOrdersResponse,
  SellerManualCustomerIssueResponse,
  SellerManualCustomerReissueTokenResponse,
  SellerOrder,
  SellerOverview,
  SellerTier,
} from '@recued/contracts';

import {
  SELLER_CONTRACT_LINK_ATTR,
  SELLER_ACCESS_OFFERS_ATTR,
  SELLER_CUSTOMER_FORM_ATTR,
  SELLER_CUSTOMER_FORM_FIELD_ATTR,
  SELLER_CUSTOMER_FORM_STATUS_ATTR,
  SELLER_CUSTOMER_FORM_SUBMIT_ATTR,
  SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR,
  SELLER_CUSTOMER_LIFECYCLE_FORM_ATTR,
  SELLER_CUSTOMER_LIFECYCLE_STATUS_ATTR,
  SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR,
  SELLER_MESSAGE_MODAL_ATTR,
  SELLER_MESSAGE_MODAL_CONFIRM_ATTR,
  SELLER_MESSAGE_MODAL_CANCEL_ATTR,
  SELLER_CUSTOMER_ROW_ATTR,
  SELLER_ERROR_ATTR,
  SELLER_LLM_GATEWAY_ATTR,
  SELLER_LLM_GATEWAY_ACK_FORM_ATTR,
  SELLER_LLM_GATEWAY_ACK_SUBMIT_ATTR,
  SELLER_MAIL_CHOOSER_STATUS_ATTR,
  SELLER_PAGE_STATE_ATTR,
  SELLER_PAGE_STYLES,
  SELLER_PAGE_SUBPAGE_ATTR,
  SELLER_SUBPAGE_HEADER_ATTR,
  SELLER_BACK_ATTR,
  SELLER_COLLECTION_DETAIL_ATTR,
  SELLER_COLLECTION_ITEM_LINK_ATTR,
  SELLER_COLLECTION_LIST_ATTR,
  SELLER_DIRECTORY_ATTR,
  SELLER_DIRECTORY_ROW_ATTR,
  SELLER_PAGE_NEXT_ATTR,
  SELLER_PAGE_PREVIOUS_ATTR,
  SELLER_PAGE_STATUS_ATTR,
  SELLER_PAGER_ATTR,
  SELLER_OFFERS_ATTR,
  SELLER_OFFER_DEFINITION_LINK_ATTR,
  SELLER_OFFER_FULFILLMENT_LINK_ATTR,
  SELLER_OFFER_ROW_ATTR,
  SELLER_OFFER_STATE_ACTION_ATTR,
  SELLER_OFFER_STATE_STATUS_ATTR,
  SELLER_ORDERS_ATTR,
  SELLER_ORDERS_STATUS_ATTR,
  SELLER_ORDER_BUCKET_GROUP_ATTR,
  SELLER_ORDER_CLOSE_ACTION_ATTR,
  SELLER_ORDER_CLOSE_RECIPE_ID,
  SELLER_SWAP_RESTAMP_HINT_ATTR,
  SELLER_ORDER_ROW_ATTR,
  SELLER_READINESS_ROW_ATTR,
  SELLER_REFRESH_ATTR,
  SELLER_SUMMARY_ATTR,
  SELLER_SUMMARY_LINK_ATTR,
  SELLER_SETTINGS_FORM_ATTR,
  SELLER_SETTINGS_FORM_FIELD_ATTR,
  SELLER_SETTINGS_FORM_STATUS_ATTR,
  SELLER_SETTINGS_FORM_SUBMIT_ATTR,
  SELLER_STRIPE_SYNC_FIELD_ATTR,
  SELLER_STRIPE_SYNC_FORM_ATTR,
  SELLER_STRIPE_SYNC_STATUS_ATTR,
  SELLER_STRIPE_SYNC_SUBMIT_ATTR,
  SELLER_TIER_FORM_ATTR,
  SELLER_TIER_FORM_FIELD_ATTR,
  SELLER_TIER_FORM_STATUS_ATTR,
  SELLER_TIER_FORM_SUBMIT_ATTR,
  SELLER_PASS_TIER_FORM_ATTR,
  SELLER_PASS_TIER_FORM_FIELD_ATTR,
  SELLER_PASS_TIER_FORM_STATUS_ATTR,
  SELLER_PASS_TIER_FORM_SUBMIT_ATTR,
  SELLER_TIER_BULK_ADJUST_FIELD_ATTR,
  SELLER_TIER_BULK_ADJUST_FORM_ATTR,
  SELLER_TIER_BULK_ADJUST_STATUS_ATTR,
  SELLER_TIER_BULK_ADJUST_SUBMIT_ATTR,
  SELLER_TIER_ROW_ATTR,
  SELLER_TIER_USAGE_FORM_ATTR,
  SELLER_TIER_USAGE_FIELD_ATTR,
  SELLER_TIER_USAGE_SUBMIT_ATTR,
  SELLER_USAGE_ROW_ATTR,
  type SellerAcknowledgeLlmGatewayPaidCaller,
  type SellerSettingsUpdateCaller,
  type SellerMailListCaller,
  type SellerManualCustomerCloseCaller,
  type SellerManualCustomerExtendCaller,
  type SellerManualCustomerIssueCaller,
  type SellerManualCustomerReissueTokenCaller,
  type SellerManualCustomerSwapTierCaller,
  type SellerManualTierBulkAdjustCaller,
  type SellerListOrdersCaller,
  type SellerManualTierUpsertCaller,
  type SellerCreatePassTierCaller,
  type SellerOfferStateTransitionCaller,
  type SellerStripeSynchronizeCaller,
  mountSellerPage,
} from '../settings/seller-page.js';
import {
  LIST_PREVIEW_ATTR,
  LIST_PREVIEW_OPEN_ATTR,
  updateListContinuity,
} from '../shell/list-preview-continuity.js';

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  type: string;
  value: string;
  checked: boolean;
  rows: number;
  href: string;
  hidden: boolean;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  closest(selector: string): FakeElement | null;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  removeEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    className: '',
    type: '',
    value: '',
    checked: false,
    rows: 0,
    href: '',
    hidden: false,
    children: [],
    parent: null,
    attrs: new Map(),
    listeners: new Map(),
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    removeAttribute(k) {
      el.attrs.delete(k);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    closest(selector) {
      const match = selector.match(/^\[([\w-]+)\]$/);
      if (match === null) return null;
      let candidate: FakeElement | null = el;
      while (candidate !== null) {
        if (candidate.hasAttribute(match[1]!)) return candidate;
        candidate = candidate.parent;
      }
      return null;
    },
    appendChild(child) {
      el.children.push(child);
      child.parent = el;
      return child;
    },
    removeChild(child) {
      const idx = el.children.indexOf(child);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      child.parent = null;
      return child;
    },
    get firstChild() {
      return el.children[0] ?? null;
    },
    remove() {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener(name, fn) {
      const arr = el.listeners.get(name) ?? [];
      arr.push(fn);
      el.listeners.set(name, arr);
    },
    removeEventListener(name, fn) {
      const arr = el.listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    click() {
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
  };
  return el;
};

const makeFakeDocument = () => ({
  createElement: (tag: string) => makeFakeElement(tag),
});

const findAllByAttr = (
  root: FakeElement,
  attr: string,
  value?: string,
  out: FakeElement[] = [],
): FakeElement[] => {
  if (
    root.hasAttribute(attr)
    && (value === undefined || root.getAttribute(attr) === value)
  ) {
    out.push(root);
  }
  for (const child of root.children) findAllByAttr(child, attr, value, out);
  return out;
};

const findByAttr = (
  root: FakeElement,
  attr: string,
  value?: string,
): FakeElement | null => findAllByAttr(root, attr, value)[0] ?? null;

const findAllByTag = (
  root: FakeElement,
  tag: string,
): FakeElement[] => [
  ...(root.tagName === tag.toUpperCase() ? [root] : []),
  ...root.children.flatMap((child) => findAllByTag(child, tag)),
];

const textOf = (root: FakeElement): string =>
  `${root.textContent}${root.children.map(textOf).join('')}`;

/** Every `title` in the tree. A truncated cell is only usable if the full value
 *  survives somewhere copyable, and that somewhere is the tooltip. */
const collectTitles = (root: FakeElement): string[] => [
  ...(root.getAttribute('title') === null ? [] : [root.getAttribute('title')!]),
  ...root.children.flatMap(collectTitles),
];

const flushAsync = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const overview = (overrides: Partial<SellerOverview> = {}): SellerOverview => ({
  settings: {
    default_grace_hours: 72,
    sender_mail_instance_id: 'mail-1',
    status_policy_json: { cancelled: 'close' },
    email_policy_json: { claim_link: 'manual' },
    llm_gateway_paid_ack_at: null,
    llm_gateway_paid_ack_version: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_100_000,
  },
  counts: {
    tiers: 1,
    active_tiers: 1,
    customers: 1,
    active_customers: 1,
    grace_customers: 0,
    closed_customers: 0,
  },
  readiness: [
    {
      key: 'manual_lifecycle',
      state: 'ready',
      label: 'Manual lifecycle',
      detail: 'Manual tiers and customers are available.',
      href: null,
    },
    {
      key: 'mail_sender',
      state: 'ready',
      label: 'Claim/status sender',
      detail: 'A send-capable mail instance is selected.',
      href: '#connections',
    },
    {
      key: 'llm_gateway',
      state: 'needs_setup',
      label: 'LLM gateway',
      detail: 'Configure the model route first.',
      href: '#settings/ai-models',
    },
  ],
  llm_gateway: {
    configured: true,
    config_readable: true,
    default_route: 'slot:slot_1',
    model_alias: 'seller-pro',
    paid_ack_at: null,
    paid_acknowledged: false,
  },
  tiers: [
    {
      tier_id: 'tier-1',
      door_id: 'door-mcp',
      lifecycle_source: 'manual',
      entitlement_key: 'consulting-basic',
      display_name: 'Consulting Basic',
      template_contract_id: 'contract-template-1',
      external_entitlement_id: null,
      usage_policy_json: { chat_turn: { month: 100 } },
      pass_duration_seconds: 2_592_000,
      customer_status_enabled_default: true,
      active: true,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_100_000,
    },
  ],
  customers: [
    {
      customer_id: 'customer-1',
      lifecycle_source: 'manual',
      source_customer_id: 'manual-cus-1',
      door_id: 'door-mcp',
      email: 'buyer@example.com',
      tier_id: 'tier-1',
      contract_id: 'contract-customer-1',
      inbound_token_id: 'inbound-1',
      mcp_token_id: 'mcp-1',
      external_subscription_id: null,
      source_status: 'paid',
      current_period_end: 1_701_000_000_000,
      grace_until: null,
      access_state: 'active',
      claim_email_sent_at: null,
      claim_email_marker: null,
      status_email_sent_at: null,
      status_email_marker: null,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_100_000,
    },
  ],
  usage_rollups: [
    {
      contract_id: 'contract-customer-1',
      usage_kind: 'chat_turn',
      period_granularity: 'month',
      period_start: 1_700_000_000_000,
      units: 17,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_100_000,
    },
  ],
  ...overrides,
});

const makeOrder = (overrides: Partial<SellerOrder> = {}): SellerOrder => ({
  order_key: 'ord:paid-doc:sub_1',
  order_handle: `oh_${'a'.repeat(64)}`,
  offer_id: 'paid-doc',
  origin_kind: 'reception_submission',
  origin_ref: 'sub_1',
  phase: 'awaiting_payment',
  pricing_kind: 'fixed',
  amount_minor: 12_500,
  currency: 'USD',
  fulfillment_recipe_id: null,
  customer_id: null,
  entitlement_key: null,
  provider: 'stripe',
  provider_session_id: 'cs_test_1',
  provider_payment_id: null,
  checkout_url: 'https://buy.stripe.com/test_link',
  fulfillment_config: null,
  artifact_ref: null,
  artifact_hash: null,
  linked_work_entity_kind: null,
  linked_work_entity_id: null,
  error_code: null,
  revision: 1,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_100_000,
  paid_at: null,
  expires_at: null,
  ...overrides,
});

const ordersResponse = (
  orders: readonly SellerOrder[],
  truncated = false,
): SellerListOrdersResponse => ({ orders, truncated });

describe('D-196 S2 - Settings -> Seller page', () => {
  it('gives Seller navigation, commands, and disclosures full-size targets', () => {
    expect(SELLER_PAGE_STYLES).toContain(
      `[${SELLER_BACK_ATTR}] {\n  box-sizing: border-box;\n  min-height: 36px;`,
    );
    expect(SELLER_PAGE_STYLES).toContain(
      `[${SELLER_COLLECTION_ITEM_LINK_ATTR}] {\n  box-sizing: border-box;\n  min-height: 36px;`,
    );
    expect(SELLER_PAGE_STYLES).toContain(
      '.seller-related-links a {\n  box-sizing: border-box;\n  min-height: 36px;',
    );
    expect(SELLER_PAGE_STYLES).toContain(
      '.seller-contract-link {\n  box-sizing: border-box;\n  min-height: 36px;',
    );
    expect(SELLER_PAGE_STYLES).toContain(
      '.seller-paid-workflow-table a {\n  box-sizing: border-box;\n  min-height: 36px;',
    );
    expect(SELLER_PAGE_STYLES).toContain(
      '.seller-action-disclosure > summary {\n  box-sizing: border-box;\n  min-height: 36px;',
    );
  });

  it('opens as a Seller feature list without loading optional detail data', async () => {
    const host = makeFakeElement('div');
    const runGetOverview = vi.fn(async () => overview());
    const runListOrders = vi.fn(async () => ordersResponse([]));
    const runListMailInstances = vi.fn(async () => ({ instances: [] }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runGetOverview,
      runListOrders,
      runListMailInstances,
    });

    await mount.whenLoaded();

    expect(runGetOverview).toHaveBeenCalledTimes(1);
    expect(runListOrders).not.toHaveBeenCalled();
    expect(runListMailInstances).not.toHaveBeenCalled();
    expect(mount.getState().phase).toBe('ready');
    expect(findByAttr(host, SELLER_PAGE_STATE_ATTR)?.getAttribute(
      SELLER_PAGE_STATE_ATTR,
    )).toBe('ready');
    expect(mount.getState().subpage).toBeNull();
    expect(findByAttr(host, SELLER_DIRECTORY_ATTR)).not.toBeNull();
    expect(findAllByAttr(host, SELLER_DIRECTORY_ROW_ATTR)).toHaveLength(7);
    expect(findByAttr(host, SELLER_DIRECTORY_ROW_ATTR, 'customers')?.getAttribute(
      'href',
    )).toBe('#settings/seller/customers');
    expect(findByAttr(host, SELLER_SUMMARY_ATTR)).toBeNull();
    expect(findByAttr(host, SELLER_READINESS_ROW_ATTR)).toBeNull();
    expect(findByAttr(host, SELLER_OFFERS_ATTR)).toBeNull();
    expect(findByAttr(host, SELLER_TIER_ROW_ATTR)).toBeNull();
    expect(findByAttr(host, SELLER_CUSTOMER_ROW_ATTR)).toBeNull();
    expect(findByAttr(host, SELLER_USAGE_ROW_ATTR)).toBeNull();
    expect(findByAttr(host, SELLER_LLM_GATEWAY_ATTR)).toBeNull();
    expect(findByAttr(host, SELLER_PAGE_SUBPAGE_ATTR)?.getAttribute(
      SELLER_PAGE_SUBPAGE_ATTR,
    )).toBe('directory');
    const header = findByAttr(host, SELLER_SUBPAGE_HEADER_ATTR, 'directory');
    expect(header).not.toBeNull();
    expect(findAllByTag(header!, 'h3')).toHaveLength(0);

    mount.dispose();
    expect(host.children.length).toBe(0);
  });

  it('keeps tiers, customers, and usage on separate paged lists', async () => {
    const tierHost = makeFakeElement('div');
    const tierMount = mountSellerPage({
      host: tierHost as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'tiers',
      runGetOverview: async () => overview(),
    });
    await tierMount.whenLoaded();
    expect(findByAttr(tierHost, SELLER_TIER_ROW_ATTR, 'tier-1')).not.toBeNull();
    expect(findByAttr(tierHost, SELLER_CUSTOMER_ROW_ATTR)).toBeNull();
    expect(findByAttr(tierHost, SELLER_USAGE_ROW_ATTR)).toBeNull();
    expect(findByAttr(tierHost, SELLER_COLLECTION_LIST_ATTR, 'tiers')).not.toBeNull();
    const tierLink = findByAttr(
      tierHost,
      SELLER_COLLECTION_ITEM_LINK_ATTR,
      'tier-1',
    );
    expect(tierLink?.getAttribute('href')).toBe(
      '#settings/seller/tiers/detail/tier-1',
    );
    expect(tierLink?.getAttribute('aria-label')).toBe(
      'Preview tier tier-1 (Consulting Basic); press Enter to open',
    );
    expect(
      findByAttr(tierHost, SELLER_CONTRACT_LINK_ATTR, 'contract-template-1')
        ?.getAttribute('href'),
    ).toBe('#contracts/contract-template-1');
    tierMount.dispose();

    const customerHost = makeFakeElement('div');
    const customerMount = mountSellerPage({
      host: customerHost as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'customers',
      runGetOverview: async () => overview(),
    });
    await customerMount.whenLoaded();
    expect(findByAttr(
      customerHost,
      SELLER_CUSTOMER_ROW_ATTR,
      'customer-1',
    )).not.toBeNull();
    // Stamped customer contracts are managed here; only tier templates link to
    // Contracts for grant authoring.
    expect(findByAttr(
      customerHost,
      SELLER_CONTRACT_LINK_ATTR,
      'contract-customer-1',
    )).toBeNull();
    expect(textOf(customerHost)).toContain('contract-customer-1');
    expect(findByAttr(customerHost, SELLER_TIER_ROW_ATTR)).toBeNull();
    const customerLink = findByAttr(
      customerHost,
      SELLER_COLLECTION_ITEM_LINK_ATTR,
      'customer-1',
    );
    expect(customerLink?.getAttribute('href')).toBe(
      '#settings/seller/customers/detail/customer-1',
    );
    expect(customerLink?.getAttribute('aria-label')).toBe(
      'Preview customer customer-1 (manual-cus-1); press Enter to open',
    );
    customerMount.dispose();

    const usageHost = makeFakeElement('div');
    const usageMount = mountSellerPage({
      host: usageHost as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'usage',
      runGetOverview: async () => overview(),
    });
    await usageMount.whenLoaded();
    expect(findByAttr(usageHost, SELLER_USAGE_ROW_ATTR)).not.toBeNull();
    expect(findByAttr(usageHost, SELLER_CUSTOMER_ROW_ATTR)).toBeNull();
    expect(findByAttr(
      usageHost,
      SELLER_COLLECTION_ITEM_LINK_ATTR,
    )?.getAttribute('aria-label')).toBe(
      'Preview Chat Turn usage for contract-customer-1 (month 1700000000000); press Enter to open',
    );
    usageMount.dispose();
  });

  it('previews a Seller row before its full detail navigation', async () => {
    const host = makeFakeElement('div');
    const onNavigate = vi.fn();
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'customers',
      onNavigate,
      runGetOverview: async () => overview(),
    });
    await mount.whenLoaded();

    const link = findByAttr(
      host,
      SELLER_COLLECTION_ITEM_LINK_ATTR,
      'customer-1',
    )!;
    const wrapper = host.children[0]!;
    const preventDefault = vi.fn();
    for (const listener of wrapper.listeners.get('click') ?? []) {
      listener({ target: link, button: 0, preventDefault });
    }

    const preview = findByAttr(host, LIST_PREVIEW_ATTR)!;
    expect(preventDefault).toHaveBeenCalled();
    expect(preview.hidden).toBe(false);
    expect(preview.getAttribute('data-id')).toBe('customer-1');
    expect(onNavigate).not.toHaveBeenCalled();

    findByAttr(preview, LIST_PREVIEW_OPEN_ATTR)!.click();
    expect(onNavigate).toHaveBeenCalledWith(
      '#settings/seller/customers/detail/customer-1',
      'push',
    );
    mount.dispose();
  });

  it('pages a collection list and opens one customer in a focused detail view', async () => {
    const base = overview();
    const customers = [
      base.customers[0]!,
      {
        ...base.customers[0]!,
        customer_id: 'customer-2',
        source_customer_id: 'manual-cus-2',
        contract_id: 'contract-customer-2',
      },
      {
        ...base.customers[0]!,
        customer_id: 'customer-3',
        source_customer_id: 'manual-cus-3',
        contract_id: 'contract-customer-3',
      },
    ];
    const pagedOverview = overview({
      customers,
      counts: {
        ...base.counts,
        customers: 3,
        active_customers: 3,
      },
    });
    const listHost = makeFakeElement('div');
    const listMount = mountSellerPage({
      host: listHost as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'customers',
      initialPage: 2,
      pageSize: 2,
      runGetOverview: async () => pagedOverview,
    });
    await listMount.whenLoaded();

    expect(listMount.getState().page).toBe(2);
    expect(findAllByAttr(listHost, SELLER_CUSTOMER_ROW_ATTR)).toHaveLength(1);
    expect(findByAttr(listHost, SELLER_CUSTOMER_ROW_ATTR, 'customer-3')).not.toBeNull();
    expect(textOf(findByAttr(listHost, SELLER_PAGE_STATUS_ATTR)!)).toBe(
      'Showing 3–3 of 3',
    );
    expect(findByAttr(listHost, SELLER_PAGE_PREVIOUS_ATTR)?.getAttribute('href'))
      .toBe('#settings/seller/customers');
    expect(findByAttr(listHost, SELLER_PAGE_NEXT_ATTR)?.getAttribute('aria-disabled'))
      .toBe('true');
    expect(findByAttr(
      listHost,
      SELLER_COLLECTION_ITEM_LINK_ATTR,
      'customer-3',
    )?.getAttribute('href')).toBe('#settings/seller/customers/detail/customer-3');
    listMount.dispose();

    const detailHost = makeFakeElement('div');
    const detailMount = mountSellerPage({
      host: detailHost as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'customers',
      initialItemId: 'customer-2',
      runGetOverview: async () => pagedOverview,
    });
    await detailMount.whenLoaded();

    expect(findByAttr(
      detailHost,
      SELLER_COLLECTION_DETAIL_ATTR,
      'customer-2',
    )).not.toBeNull();
    expect(findByAttr(detailHost, SELLER_CUSTOMER_ROW_ATTR, 'customer-2')).not.toBeNull();
    expect(findByAttr(detailHost, SELLER_CUSTOMER_ROW_ATTR, 'customer-1')).toBeNull();
    expect(findByAttr(detailHost, SELLER_PAGER_ATTR)).toBeNull();
    expect(findByAttr(detailHost, SELLER_BACK_ATTR)?.getAttribute('href'))
      .toBe('#settings/seller/customers');
    detailMount.dispose();
  });

  it('restores a Seller collection page and scroll only after its rows load', async () => {
    const base = overview();
    const customers = [
      base.customers[0]!,
      {
        ...base.customers[0]!,
        customer_id: 'customer-2',
        source_customer_id: 'manual-cus-2',
        contract_id: 'contract-customer-2',
      },
      {
        ...base.customers[0]!,
        customer_id: 'customer-3',
        source_customer_id: 'manual-cus-3',
        contract_id: 'contract-customer-3',
      },
    ];
    const pagedOverview = overview({
      customers,
      counts: {
        ...base.counts,
        customers: 3,
        active_customers: 3,
      },
    });
    const doc = makeFakeDocument();
    updateListContinuity(
      doc as unknown as Document,
      'seller:customers',
      {
        page: 2,
        focusedId: 'customer-3',
        scroll: { top: 515, left: 3 },
      },
    );
    let resolveOverview!: (value: SellerOverview) => void;
    const overviewLoad = new Promise<SellerOverview>((resolve) => {
      resolveOverview = resolve;
    });
    const scrollRoot = makeFakeElement('main') as FakeElement & {
      scrollTop: number;
      scrollLeft: number;
    };
    scrollRoot.scrollTop = 0;
    scrollRoot.scrollLeft = 0;
    const host = makeFakeElement('div');
    const listMount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      scrollRoot: scrollRoot as unknown as HTMLElement,
      initialSubpage: 'customers',
      pageSize: 2,
      runGetOverview: () => overviewLoad,
    });

    await flushAsync();
    expect(scrollRoot.scrollTop).toBe(0);
    resolveOverview(pagedOverview);
    await listMount.whenLoaded();

    expect(listMount.getState().page).toBe(2);
    expect(findByAttr(host, SELLER_CUSTOMER_ROW_ATTR, 'customer-3')).not.toBeNull();
    expect(scrollRoot.scrollTop).toBe(515);
    expect(scrollRoot.scrollLeft).toBe(3);
    listMount.dispose();

    const detailHost = makeFakeElement('div');
    const detailMount = mountSellerPage({
      host: detailHost as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialSubpage: 'customers',
      initialItemId: 'customer-3',
      pageSize: 2,
      runGetOverview: async () => pagedOverview,
    });
    await detailMount.whenLoaded();

    expect(findByAttr(detailHost, SELLER_BACK_ATTR)?.getAttribute('href'))
      .toBe('#settings/seller/customers/page/2');
    detailMount.dispose();
  });

  it('falls back to the Seller directory for an unknown sub-page', async () => {
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'retired-feature',
      runGetOverview: async () => overview(),
    });

    await mount.whenLoaded();

    expect(mount.getState().subpage).toBeNull();
    expect(findByAttr(host, SELLER_DIRECTORY_ATTR)).not.toBeNull();
    mount.dispose();
  });

  it('explains when Orders are unavailable on an older paired server', async () => {
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'orders',
      runGetOverview: vi.fn(async () => overview()),
    });

    await mount.whenLoaded();

    expect(findByAttr(host, SELLER_ORDERS_ATTR)).toBeNull();
    expect(textOf(host)).toContain('Orders unavailable');
    mount.dispose();
  });

  it('requests real order pages and resolves an exact order detail', async () => {
    const pageOrder = makeOrder({ order_key: 'ord:page:3', origin_ref: 'sub_3' });
    const runPage: SellerListOrdersCaller = vi.fn(async () =>
      ordersResponse([pageOrder], true));
    const listHost = makeFakeElement('div');
    const listMount = mountSellerPage({
      host: listHost as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'orders',
      initialPage: 2,
      pageSize: 2,
      runGetOverview: async () => overview(),
      runListOrders: runPage,
    });
    await listMount.whenLoaded();

    expect(runPage).toHaveBeenCalledWith({ limit: 2, offset: 2 });
    const orderLink = findByAttr(
      listHost,
      SELLER_COLLECTION_ITEM_LINK_ATTR,
      'ord:page:3',
    );
    expect(orderLink?.getAttribute('href')).toBe(
      '#settings/seller/orders/detail/ord%3Apage%3A3',
    );
    expect(orderLink?.getAttribute('aria-label')).toBe(
      'Preview order ord:page:3 for paid-doc; press Enter to open',
    );
    expect(findByAttr(listHost, SELLER_PAGE_PREVIOUS_ATTR)?.getAttribute('href'))
      .toBe('#settings/seller/orders');
    expect(findByAttr(listHost, SELLER_PAGE_NEXT_ATTR)?.getAttribute('href'))
      .toBe('#settings/seller/orders/page/3');
    listMount.dispose();

    const runDetail: SellerListOrdersCaller = vi.fn(async () =>
      ordersResponse([pageOrder]));
    const detailHost = makeFakeElement('div');
    const detailMount = mountSellerPage({
      host: detailHost as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'orders',
      initialItemId: pageOrder.order_key,
      runGetOverview: async () => overview(),
      runListOrders: runDetail,
    });
    await detailMount.whenLoaded();

    expect(runDetail).toHaveBeenCalledWith({
      order_key: 'ord:page:3',
      limit: 1,
    });
    expect(findByAttr(
      detailHost,
      SELLER_COLLECTION_DETAIL_ATTR,
      'ord:page:3',
    )).not.toBeNull();
    expect(findByAttr(detailHost, SELLER_ORDER_ROW_ATTR, 'ord:page:3')).not.toBeNull();
    expect(findByAttr(detailHost, SELLER_PAGER_ATTR)).toBeNull();
    detailMount.dispose();
  });

  it('renders orders grouped by lifecycle bucket, read-only', async () => {
    const host = makeFakeElement('div');
    const runListOrders: SellerListOrdersCaller = vi.fn(async () =>
      ordersResponse([
        makeOrder({
          order_key: 'ord:paid-doc:sub_pricing',
          origin_ref: 'sub_pricing',
          phase: 'pricing',
          pricing_kind: 'unspecified',
          amount_minor: null,
          currency: null,
          provider: null,
          provider_session_id: null,
          checkout_url: null,
          fulfillment_config: null,
        }), // -> needs_owner
        makeOrder({
          order_key: 'ord:paid-doc:sub_paid',
          origin_ref: 'sub_paid',
          phase: 'paid',
        }), // -> active
        makeOrder({
          order_key: 'ord:paid-doc:sub_expired',
          origin_ref: 'sub_expired',
          phase: 'expired',
        }), // -> timed_out
        makeOrder({
          order_key: 'ord:paid-doc:sub_complete',
          origin_ref: 'sub_complete',
          phase: 'complete',
          artifact_hash: 'a'.repeat(64),
        }), // -> closed
      ]));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'orders',
      runGetOverview: vi.fn(async () => overview()),
      runListOrders,
    });

    await mount.whenLoaded();

    expect(runListOrders).toHaveBeenCalledTimes(1);
    const section = findByAttr(host, SELLER_ORDERS_ATTR);
    expect(section).not.toBeNull();

    // One group per occupied bucket.
    for (const bucket of ['needs_owner', 'active', 'timed_out', 'closed']) {
      expect(findByAttr(host, SELLER_ORDER_BUCKET_GROUP_ATTR, bucket)).not.toBeNull();
    }
    // Each order rendered as a row keyed on order_key.
    expect(findByAttr(host, SELLER_ORDER_ROW_ATTR, 'ord:paid-doc:sub_paid')).not.toBeNull();
    expect(
      findByAttr(host, SELLER_ORDER_ROW_ATTR, 'ord:paid-doc:sub_complete'),
    ).not.toBeNull();

    const sectionText = textOf(section!);
    expect(sectionText).toContain('$125.00'); // priced order, minor units formatted
    expect(sectionText).toContain('Not priced'); // the unpriced quote request
    expect(sectionText).toContain('Pinned'); // delivered artifact on the closed order
    // The order handle (oh_ + 64 hex) is truncated in the cell — no full-length
    // run leaks into the visible text; the full value lives in a title tooltip.
    expect(sectionText).not.toContain('a'.repeat(30));
    mount.dispose();
  });

  it('a stranded order carries the fields its recovery needs: customer id and a copyable origin', async () => {
    // The Orders view is read-only, so every recovery runs elsewhere: the
    // customer-level actions ("Message customer", reissue, extend) are keyed on
    // `customer_id`, and the owner-attended close recipe takes `origin_ref`.
    // Both are truncated in-cell, so the FULL values have to ride title tooltips
    // or they are visible but not usable.
    const CUSTOMER = `sc_${'c'.repeat(30)}`;
    const ORIGIN = `sub_${'o'.repeat(40)}`;
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'orders',
      runGetOverview: vi.fn(async () => overview()),
      runListOrders: vi.fn(async () =>
        ordersResponse([
          makeOrder({
            order_key: 'ord:pass:stranded',
            origin_ref: ORIGIN,
            phase: 'needs_owner',
            customer_id: CUSTOMER,
            error_code: 'claim_mail_undelivered',
          }),
        ])),
    });
    await mount.whenLoaded();

    const section = findByAttr(host, SELLER_ORDERS_ATTR)!;
    const sectionText = textOf(section);
    // It lands in the bucket an owner reads, with the reason visible.
    expect(findByAttr(host, SELLER_ORDER_BUCKET_GROUP_ATTR, 'needs_owner')).not.toBeNull();
    expect(sectionText).toContain('claim_mail_undelivered');
    // Neither long id leaks at full length into the cell text...
    expect(sectionText).not.toContain(CUSTOMER);
    expect(sectionText).not.toContain(ORIGIN);
    // ...but both are recoverable from a title, which is what makes them usable.
    const titles = collectTitles(host);
    expect(titles).toContain(CUSTOMER);
    expect(titles).toContain(ORIGIN);
    mount.dispose();
  });

  it('the Close action runs the recovery RECIPE — no per-action seller rpc', async () => {
    // Typed args, or `mock.calls[0][0]` infers an empty tuple and the assertion
    // below cannot compile (vitest is happy; tsc is not).
    const runRecipe = vi.fn(
      async (_args: { recipe_id: string; config?: Record<string, unknown> }) =>
        ({ success: true, errors: [] as readonly unknown[] }),
    );
    const runListOrders = vi.fn(async () =>
      ordersResponse([
        makeOrder({
          order_key: 'ord:pass:stranded',
          phase: 'needs_owner',
          customer_id: 'sc_1',
          error_code: 'claim_mail_undelivered',
        }),
        // Not closeable: access never issued, so the row offers nothing.
        makeOrder({ order_key: 'ord:pass:nocustomer', phase: 'needs_owner', customer_id: null }),
        makeOrder({ order_key: 'ord:pass:active', phase: 'paid', customer_id: 'sc_2' }),
      ]));
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'orders',
      initialItemId: 'ord:pass:stranded',
      runGetOverview: vi.fn(async () => overview()),
      runListOrders,
      runRecipe: runRecipe as never,
    });
    await mount.whenLoaded();

    // Offered ONLY on the stranded-and-recoverable row.
    expect(findByAttr(host, SELLER_ORDER_CLOSE_ACTION_ATTR, 'ord:pass:stranded')).not.toBeNull();
    expect(findByAttr(host, SELLER_ORDER_CLOSE_ACTION_ATTR, 'ord:pass:nocustomer')).toBeNull();
    expect(findByAttr(host, SELLER_ORDER_CLOSE_ACTION_ATTR, 'ord:pass:active')).toBeNull();

    // Closing ASSERTS the customer has their access, so nothing runs until the
    // owner affirms it.
    findByAttr(host, SELLER_ORDER_CLOSE_ACTION_ATTR, 'ord:pass:stranded')!.click();
    expect(runRecipe).not.toHaveBeenCalled();
    const modal = findByAttr(host, SELLER_MESSAGE_MODAL_ATTR)!;
    const dialog = findByAttr(modal, 'role', 'dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toMatch(
      /^recued-seller-confirm-title-/,
    );
    expect(dialog?.getAttribute('aria-describedby')).toMatch(
      /^recued-seller-confirm-body-/,
    );
    const modalText = textOf(modal);
    expect(modalText).toContain('attesting');
    expect(modalText).toContain('cannot verify');

    findByAttr(host, SELLER_MESSAGE_MODAL_CONFIRM_ATTR)!.click();
    await flushAsync();
    // THE point: it runs the shipped recipe by id through the generic runner.
    expect(runRecipe).toHaveBeenCalledTimes(1);
    expect(runRecipe.mock.calls[0]?.[0]).toEqual({
      recipe_id: SELLER_ORDER_CLOSE_RECIPE_ID,
      config: { order_handle: `oh_${'a'.repeat(64)}` },
    });
    mount.dispose();
  });

  it('a recipe that REFUSES the close is reported as a failure, not a success', async () => {
    // A recipe reports refusal as a failed RUN, not a rejected promise — its
    // guards land in `errors`. Reading only the promise would tell the owner an
    // order closed when the recipe refused it.
    const runRecipe = vi.fn(async () => ({
      success: false,
      errors: [{ step_id: 'customer_guard', message: 'Guard triggered' }],
    }));
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'orders',
      initialItemId: 'ord:pass:stranded',
      runGetOverview: vi.fn(async () => overview()),
      runListOrders: vi.fn(async () =>
        ordersResponse([
          makeOrder({ order_key: 'ord:pass:stranded', phase: 'needs_owner', customer_id: 'sc_1' }),
        ])),
      runRecipe: runRecipe as never,
    });
    await mount.whenLoaded();

    findByAttr(host, SELLER_ORDER_CLOSE_ACTION_ATTR, 'ord:pass:stranded')!.click();
    findByAttr(host, SELLER_MESSAGE_MODAL_CONFIRM_ATTR)!.click();
    await flushAsync();

    const status = findByAttr(host, SELLER_ORDERS_STATUS_ATTR)!;
    expect(status.getAttribute('data-kind')).toBe('error');
    expect(textOf(status)).toContain('refused');
    expect(textOf(status)).not.toContain('Closed');
    mount.dispose();
  });

  it('with no recipe runner wired the order row offers no action', async () => {
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'orders',
      initialItemId: 'ord:pass:stranded',
      runGetOverview: vi.fn(async () => overview()),
      runListOrders: vi.fn(async () =>
        ordersResponse([
          makeOrder({ order_key: 'ord:pass:stranded', phase: 'needs_owner', customer_id: 'sc_1' }),
        ])),
    });
    await mount.whenLoaded();
    expect(findByAttr(host, SELLER_ORDER_CLOSE_ACTION_ATTR)).toBeNull();
    mount.dispose();
  });

  it('warns that a swap re-stamps per-customer grant edits', async () => {
    // Correct behaviour, sharp edge: only `swapCustomerTier` re-stamps from the
    // template (extend/reissue do not), and the reset grant edits are not
    // recoverable from this screen. Silence here costs the owner work they
    // authored in #contracts.
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'customers',
      initialItemId: 'customer-1',
      runGetOverview: vi.fn(async () => overview()),
      runSwapManualCustomerTier: vi.fn(async () => {
        throw new Error('not called in this test');
      }) as never,
    });
    await mount.whenLoaded();

    const hint = findByAttr(host, SELLER_SWAP_RESTAMP_HINT_ATTR);
    expect(hint).not.toBeNull();
    const text = textOf(hint!);
    expect(text).toContain('re-issues');
    // It must name WHAT is lost and that swap is the only action that does it.
    expect(text).toContain('Contracts');
    expect(text).toContain('only swapping');
    mount.dispose();
  });

  it('surfaces truncation and an empty orders state', async () => {
    const truncatedHost = makeFakeElement('div');
    const truncatedMount = mountSellerPage({
      host: truncatedHost as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'orders',
      runGetOverview: vi.fn(async () => overview()),
      runListOrders: vi.fn(async () => ordersResponse([makeOrder()], true)),
    });
    await truncatedMount.whenLoaded();
    expect(textOf(findByAttr(truncatedHost, SELLER_ORDERS_ATTR)!)).toContain(
      'More orders exist after it.',
    );
    truncatedMount.dispose();

    const emptyHost = makeFakeElement('div');
    const emptyMount = mountSellerPage({
      host: emptyHost as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'orders',
      runGetOverview: vi.fn(async () => overview()),
      runListOrders: vi.fn(async () => ordersResponse([])),
    });
    await emptyMount.whenLoaded();
    expect(textOf(findByAttr(emptyHost, SELLER_ORDERS_ATTR)!)).toContain(
      'No orders yet.',
    );
    emptyMount.dispose();
  });

  it('keeps the page ready and flags a failed orders load without gating', async () => {
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'orders',
      runGetOverview: vi.fn(async () => overview()),
      runListOrders: vi.fn(async () => {
        throw new Error('orders backend down');
      }),
    });

    await mount.whenLoaded();

    // The shared overview loaded, so the Orders page is ready even though its
    // best-effort list failed.
    expect(mount.getState().phase).toBe('ready');
    expect(findByAttr(host, SELLER_SUMMARY_ATTR)).toBeNull();
    expect(findByAttr(host, SELLER_SUBPAGE_HEADER_ATTR, 'orders')).not.toBeNull();
    const status = findByAttr(host, SELLER_ORDERS_STATUS_ATTR);
    expect(status).not.toBeNull();
    expect(status?.getAttribute('role')).toBe('alert');
    mount.dispose();
  });

  it('renders a core Seller outcome offer beside, not as, an Access offer', async () => {
    const host = makeFakeElement('div');
    const runGetOverview = vi.fn(async () => overview({
      offers: [{
        offer_id: 'paid-document.outcome',
        kind: 'document',
        display_name: 'Paid document',
        description: 'One reviewed and delivered PDF document',
        pricing_kind: 'fixed',
        amount_minor: 12_500,
        currency: 'USD',
        fulfillment_recipe_id: 'generate-paid-document',
        checkout_url: null,
        fulfillment_config: null,
        state: 'draft',
        created_by_recipe_id: 'start-paid-document-fulfillment',
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
      }],
    }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'offers',
      runGetOverview,
    });

    await mount.whenLoaded();

    const offerSection = findByAttr(host, SELLER_OFFERS_ATTR);
    const accessSection = findByAttr(host, SELLER_ACCESS_OFFERS_ATTR);
    const offerRow = findByAttr(
      host,
      SELLER_OFFER_ROW_ATTR,
      'paid-document.outcome',
    );
    expect(offerSection).not.toBeNull();
    expect(accessSection).not.toBeNull();
    expect(offerRow).not.toBeNull();
    expect(textOf(offerSection!)).toContain('One reviewed and delivered PDF document');
    expect(textOf(offerSection!)).toContain('$125.00');
    expect(textOf(offerSection!)).toContain('draft');
    expect(textOf(offerSection!)).toContain('Offer ID: paid-document.outcome');
    expect(textOf(offerSection!)).toContain('source recipes');
    expect(textOf(offerSection!)).toContain('records publication intent');
    expect(textOf(offerSection!)).toContain('does not cancel in-flight orders');
    expect(textOf(offerSection!)).toContain(
      'pause any recipe or intake path that can start a new order',
    );
    expect(textOf(offerRow!)).not.toContain('recued-core');
    expect(textOf(offerRow!)).not.toContain('version');
    expect(textOf(accessSection!)).toContain(
      'separately from one-time outcome offers and orders',
    );
    expect(findByAttr(
      host,
      SELLER_COLLECTION_ITEM_LINK_ATTR,
      'paid-document.outcome',
    )?.getAttribute('aria-label')).toBe(
      'Preview offer paid-document.outcome (Paid document); press Enter to open',
    );
    const definitionLink = findByAttr(
      offerRow!,
      SELLER_OFFER_DEFINITION_LINK_ATTR,
      'start-paid-document-fulfillment',
    );
    expect(definitionLink?.getAttribute('href')).toBe(
      '#recipes/start-paid-document-fulfillment',
    );
    expect(definitionLink?.getAttribute('data-recued-reference')).toBe('link');
    expect(definitionLink?.getAttribute('data-recued-reference-id')).toBe(
      'start-paid-document-fulfillment',
    );
    expect(textOf(definitionLink!)).toContain('Open recorded creator recipe');
    const fulfillmentLink = findByAttr(
      offerRow!,
      SELLER_OFFER_FULFILLMENT_LINK_ATTR,
      'generate-paid-document',
    );
    expect(fulfillmentLink?.getAttribute('href')).toBe(
      '#recipes/generate-paid-document',
    );
    expect(fulfillmentLink?.getAttribute('data-recued-reference')).toBe('link');
    expect(fulfillmentLink?.getAttribute('data-recued-reference-id')).toBe(
      'generate-paid-document',
    );
    expect(textOf(fulfillmentLink!)).toContain('Open fulfillment recipe');
    expect(findByAttr(host, SELLER_OFFER_STATE_ACTION_ATTR)).toBeNull();

    mount.dispose();
  });

  it('transitions outcome-offer state through owner-only optimistic controls', async () => {
    const host = makeFakeElement('div');
    const baseOffer = {
      offer_id: 'paid-document.outcome',
      kind: 'document' as const,
      display_name: 'Paid document',
      description: 'One reviewed and delivered PDF document',
      pricing_kind: 'fixed' as const,
      amount_minor: 12_500,
      currency: 'USD',
      fulfillment_recipe_id: null,
      checkout_url: null,
      fulfillment_config: null,
      state: 'draft' as const,
      created_by_recipe_id: 'start-paid-document-fulfillment',
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    };
    const initial = overview({ offers: [baseOffer] });
    const runTransitionOfferState: SellerOfferStateTransitionCaller = vi.fn(
      async (request) => {
        const transitioned = {
          ...baseOffer,
          state: request.next_state,
          updated_at: baseOffer.updated_at + 1,
        };
        return {
          result: 'updated' as const,
          offer: transitioned,
          overview: overview({ offers: [transitioned] }),
        };
      },
    );
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'offers',
      initialItemId: 'paid-document.outcome',
      runGetOverview: async () => initial,
      runTransitionOfferState,
    });
    await mount.whenLoaded();

    expect(textOf(findByAttr(host, SELLER_OFFERS_ATTR)!)).toContain('Archive...');
    expect(textOf(findByAttr(host, SELLER_OFFERS_ATTR)!)).toContain(
      'Archived offers cannot be restored.',
    );
    findByAttr(host, SELLER_OFFER_STATE_ACTION_ATTR, 'active')?.click();
    await flushAsync();

    expect(runTransitionOfferState).toHaveBeenCalledWith({
      offer_id: 'paid-document.outcome',
      expected_state: 'draft',
      expected_updated_at: 1_700_000_000_000,
      next_state: 'active',
    });
    expect(mount.getState().overview?.offers?.[0]?.state).toBe('active');
    expect(textOf(findByAttr(host, SELLER_OFFER_STATE_STATUS_ATTR)!)).toContain(
      'Offer is now active.',
    );
    expect(findByAttr(host, SELLER_OFFER_STATE_ACTION_ATTR, 'paused')).not.toBeNull();
    expect(findByAttr(host, SELLER_OFFER_STATE_ACTION_ATTR, 'active')).toBeNull();

    await mount.refresh();
    expect(textOf(findByAttr(host, SELLER_OFFER_STATE_STATUS_ATTR)!)).toBe('');

    mount.dispose();
  });

  it('refuses an inconsistent transition overview instead of rendering stale controls', async () => {
    const host = makeFakeElement('div');
    const draftOffer = {
      offer_id: 'paid-document.outcome',
      kind: 'document' as const,
      display_name: 'Paid document',
      description: '',
      pricing_kind: 'unspecified' as const,
      amount_minor: null,
      currency: null,
      fulfillment_recipe_id: null,
      checkout_url: null,
      fulfillment_config: null,
      state: 'draft' as const,
      created_by_recipe_id: null,
      created_at: 1,
      updated_at: 1,
    };
    const initial = overview({ offers: [draftOffer] });
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'offers',
      initialItemId: 'paid-document.outcome',
      runGetOverview: async () => initial,
      runTransitionOfferState: async () => ({
        result: 'updated',
        offer: { ...draftOffer, state: 'active', updated_at: 2 },
        overview: initial,
      }),
    });
    await mount.whenLoaded();

    expect(textOf(findByAttr(host, SELLER_OFFERS_ATTR)!)).toContain(
      'Creator not recorded',
    );
    expect(textOf(findByAttr(host, SELLER_OFFERS_ATTR)!)).toContain('Not linked');
    expect(findByAttr(host, SELLER_OFFER_DEFINITION_LINK_ATTR)).toBeNull();
    expect(findByAttr(host, SELLER_OFFER_FULFILLMENT_LINK_ATTR)).toBeNull();
    findByAttr(host, SELLER_OFFER_STATE_ACTION_ATTR, 'active')?.click();
    await flushAsync();
    await flushAsync();

    expect(mount.getState().overview?.offers?.[0]?.state).toBe('draft');
    expect(textOf(findByAttr(host, SELLER_OFFER_STATE_STATUS_ATTR)!)).toContain(
      'unexpected offer transition result',
    );

    mount.dispose();
  });

  it('keeps the current offer visible when an owner transition conflicts', async () => {
    const host = makeFakeElement('div');
    const initial = overview({
      offers: [{
        offer_id: 'paid-document.outcome',
        kind: 'document',
        display_name: 'Paid document',
        description: '',
        pricing_kind: 'unspecified',
        amount_minor: null,
        currency: null,
        fulfillment_recipe_id: null,
        checkout_url: null,
        fulfillment_config: null,
        state: 'draft',
        created_by_recipe_id: null,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
      }],
    });
    const runTransitionOfferState: SellerOfferStateTransitionCaller = vi.fn(
      async () => {
        throw new Error('offer changed during state transition');
      },
    );
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'offers',
      initialItemId: 'paid-document.outcome',
      runGetOverview: async () => initial,
      runTransitionOfferState,
    });
    await mount.whenLoaded();

    const activate = findByAttr(host, SELLER_OFFER_STATE_ACTION_ATTR, 'active');
    activate?.click();
    await flushAsync();
    await flushAsync();

    expect(mount.getState().overview?.offers?.[0]?.state).toBe('draft');
    const status = findByAttr(host, SELLER_OFFER_STATE_STATUS_ATTR);
    expect(status?.getAttribute('role')).toBe('alert');
    expect(textOf(status!)).toContain('offer changed during state transition');
    expect(activate?.disabled).toBe(false);

    mount.dispose();
  });

  it('initializes or synchronizes Stripe features and renders the refreshed overview', async () => {
    const host = makeFakeElement('div');
    const initial = overview({
      readiness: [
        ...overview().readiness,
        {
          key: 'stripe_provider',
          state: 'ready',
          label: 'Stripe provider',
          detail: '1 Stripe connection ready for Initialize / Synchronize.',
          href: null,
        },
      ],
    });
    const refreshed = overview({
      ...initial,
      counts: { ...initial.counts, tiers: 3, active_tiers: 3 },
    });
    const runSynchronizeStripeEntitlements: SellerStripeSynchronizeCaller = vi.fn(
      async () => ({
        connection_name: 'stripe-main',
        features_seen: 2,
        created_tier_ids: ['tier-stripe-basic', 'tier-stripe-pro'],
        preserved_tier_ids: [],
        recreated_template_tier_ids: [],
        reactivated_tier_ids: [],
        orphaned_tier_ids: [],
        overview: refreshed,
      }),
    );
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'setup',
      runGetOverview: async () => initial,
      runSynchronizeStripeEntitlements,
    });
    await mount.whenLoaded();

    expect(findByAttr(host, SELLER_STRIPE_SYNC_FORM_ATTR)).not.toBeNull();
    const field = (name: string): FakeElement => {
      const el = findByAttr(host, SELLER_STRIPE_SYNC_FIELD_ATTR, name);
      if (el === null) throw new Error(`missing Stripe sync field ${name}`);
      return el;
    };
    field('connection_name').value = 'stripe-main';
    field('door_id').value = 'door-llm';
    field('door_type').value = 'llm_gateway';
    findByAttr(host, SELLER_STRIPE_SYNC_SUBMIT_ATTR)?.click();
    await flushAsync();

    expect(runSynchronizeStripeEntitlements).toHaveBeenCalledWith({
      connection_name: 'stripe-main',
      door_id: 'door-llm',
      door_type: 'llm_gateway',
    });
    expect(textOf(findByAttr(host, SELLER_STRIPE_SYNC_STATUS_ATTR)!))
      .toContain('Synchronized 2 Stripe features: 2 created');
    expect(mount.getState().overview?.counts.tiers).toBe(3);
  });

  it('keeps Stripe synchronization disabled until provider readiness is ready', async () => {
    const host = makeFakeElement('div');
    const runSynchronizeStripeEntitlements = vi.fn<SellerStripeSynchronizeCaller>();
    const pending = overview({
      readiness: [
        ...overview().readiness,
        {
          key: 'stripe_provider',
          state: 'needs_setup',
          label: 'Stripe provider',
          detail: 'Install and enroll Stripe first.',
          href: '#connections',
        },
      ],
    });
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'setup',
      runGetOverview: async () => pending,
      runSynchronizeStripeEntitlements,
    });
    await mount.whenLoaded();

    const submit = findByAttr(host, SELLER_STRIPE_SYNC_SUBMIT_ATTR);
    expect(submit?.disabled).toBe(true);
    submit?.click();
    await flushAsync();
    expect(runSynchronizeStripeEntitlements).not.toHaveBeenCalled();
    expect(textOf(findByAttr(host, SELLER_STRIPE_SYNC_STATUS_ATTR)!))
      .toContain('Install and enroll Stripe first.');
  });

  it('renders Stripe form validation errors without invoking the provider', async () => {
    const host = makeFakeElement('div');
    const ready = overview({
      readiness: [
        ...overview().readiness,
        {
          key: 'stripe_provider',
          state: 'ready',
          label: 'Stripe provider',
          detail: '1 Stripe connection ready for Initialize / Synchronize.',
          href: null,
        },
      ],
    });
    const runSynchronizeStripeEntitlements = vi.fn<SellerStripeSynchronizeCaller>();
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'setup',
      runGetOverview: async () => ready,
      runSynchronizeStripeEntitlements,
    });
    await mount.whenLoaded();

    findByAttr(host, SELLER_STRIPE_SYNC_SUBMIT_ATTR)?.click();
    await flushAsync();

    expect(runSynchronizeStripeEntitlements).not.toHaveBeenCalled();
    expect(findByAttr(host, SELLER_STRIPE_SYNC_SUBMIT_ATTR)?.disabled).toBe(false);
    expect(textOf(findByAttr(host, SELLER_STRIPE_SYNC_STATUS_ATTR)!))
      .toContain('Door ID is required');
  });

  it('updates seller settings and renders the returned overview', async () => {
    const host = makeFakeElement('div');
    const updated = overview({
      settings: {
        default_grace_hours: 24,
        sender_mail_instance_id: 'mail-primary',
        status_policy_json: { past_due: 'grace' },
        email_policy_json: { claim: { enabled: true } },
        llm_gateway_paid_ack_at: null,
        llm_gateway_paid_ack_version: null,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_300_000,
      },
    });
    const runUpdateSellerSettings: SellerSettingsUpdateCaller = vi.fn(
      async () => ({
        settings: updated.settings,
        overview: updated,
      }),
    );
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'setup',
      runGetOverview: async () => overview(),
      runListMailInstances: async () => ({
        instances: [{
          slug: 'mail-primary',
          send_capable: true,
          account_email: 'owner@example.com',
        }],
      }),
      runUpdateSellerSettings,
    });

    await mount.whenLoaded();

    expect(findByAttr(host, SELLER_SETTINGS_FORM_ATTR)).not.toBeNull();
    const field = (name: string): FakeElement => {
      const el = findByAttr(host, SELLER_SETTINGS_FORM_FIELD_ATTR, name);
      if (el === null) throw new Error(`missing settings field ${name}`);
      return el;
    };
    field('default_grace_hours').value = '24';
    field('sender_mail_instance_id').value = 'mail-primary';
    field('status_policy_json').value = '{"past_due":"grace"}';
    field('email_policy_json').value = '{"claim":{"enabled":true}}';

    findByAttr(host, SELLER_SETTINGS_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();

    expect(runUpdateSellerSettings).toHaveBeenCalledWith({
      default_grace_hours: 24,
      sender_mail_instance_id: 'mail-primary',
      status_policy_json: { past_due: 'grace' },
      email_policy_json: { claim: { enabled: true } },
    });
    expect(mount.getState().overview?.settings.default_grace_hours).toBe(24);
    expect(textOf(host)).toContain('mail-primary');
    const status = findByAttr(host, SELLER_SETTINGS_FORM_STATUS_ATTR);
    expect(status?.getAttribute('data-kind')).toBe('success');
    expect(textOf(status!)).toContain('Settings saved.');
    mount.dispose();
  });

  // D-196 §4.9 / I-7 — the paid-gateway route-rights acknowledgment control.
  it('shows the paid-gateway acknowledgment control and records it (D-196 I-7)', async () => {
    const host = makeFakeElement('div');
    // The base fixture is a CONFIGURED, NOT-yet-acknowledged gateway.
    const acknowledged = overview({
      settings: {
        default_grace_hours: 72,
        sender_mail_instance_id: 'mail-1',
        status_policy_json: { cancelled: 'close' },
        email_policy_json: { claim_link: 'manual' },
        llm_gateway_paid_ack_at: 1_700_000_500_000,
        llm_gateway_paid_ack_version: LLM_GATEWAY_PAID_ACK_VERSION,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_500_000,
      },
      llm_gateway: {
        configured: true,
        config_readable: true,
        default_route: 'slot:slot_1',
        model_alias: 'seller-pro',
        paid_ack_at: 1_700_000_500_000,
        paid_acknowledged: true,
      },
    });
    const runAcknowledge: SellerAcknowledgeLlmGatewayPaidCaller = vi.fn(async () => ({
      settings: acknowledged.settings,
      overview: acknowledged,
    }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'setup',
      runGetOverview: async () => overview(),
      runAcknowledgeLlmGatewayPaid: runAcknowledge,
    });

    await mount.whenLoaded();

    // Configured + unacknowledged => the control is present.
    expect(findByAttr(host, SELLER_LLM_GATEWAY_ACK_FORM_ATTR)).not.toBeNull();

    findByAttr(host, SELLER_LLM_GATEWAY_ACK_SUBMIT_ATTR)?.click();
    await flushAsync();

    // The current terms version is confirmed to the server.
    expect(runAcknowledge).toHaveBeenCalledWith({
      ack_version: LLM_GATEWAY_PAID_ACK_VERSION,
    });
    // Re-rendered from the returned overview: acknowledged now, control gone,
    // read-only row reflects it.
    expect(mount.getState().overview?.llm_gateway.paid_acknowledged).toBe(true);
    expect(findByAttr(host, SELLER_LLM_GATEWAY_ACK_FORM_ATTR)).toBeNull();
    expect(textOf(findByAttr(host, SELLER_LLM_GATEWAY_ATTR)!)).toContain('Acknowledged');
    mount.dispose();
  });

  it('hides the acknowledgment control once acknowledged', async () => {
    const host = makeFakeElement('div');
    const alreadyAcked = overview({
      settings: {
        default_grace_hours: 72,
        sender_mail_instance_id: 'mail-1',
        status_policy_json: {},
        email_policy_json: {},
        llm_gateway_paid_ack_at: 1_700_000_500_000,
        llm_gateway_paid_ack_version: LLM_GATEWAY_PAID_ACK_VERSION,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_500_000,
      },
      llm_gateway: {
        configured: true,
        config_readable: true,
        default_route: 'slot:slot_1',
        model_alias: 'seller-pro',
        paid_ack_at: 1_700_000_500_000,
        paid_acknowledged: true,
      },
    });
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'setup',
      runGetOverview: async () => alreadyAcked,
      runAcknowledgeLlmGatewayPaid: vi.fn(),
    });

    await mount.whenLoaded();

    expect(findByAttr(host, SELLER_LLM_GATEWAY_ACK_FORM_ATTR)).toBeNull();
    expect(textOf(findByAttr(host, SELLER_LLM_GATEWAY_ATTR)!)).toContain('Acknowledged');
    mount.dispose();
  });

  it('hides the acknowledgment control when the caller is unwired', async () => {
    const host = makeFakeElement('div');
    // Configured + unacknowledged, but no acknowledgment caller (older server).
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'setup',
      runGetOverview: async () => overview(),
    });

    await mount.whenLoaded();

    expect(findByAttr(host, SELLER_LLM_GATEWAY_ACK_FORM_ATTR)).toBeNull();
    // The read-only row still honestly shows the unacknowledged state.
    expect(textOf(findByAttr(host, SELLER_LLM_GATEWAY_ATTR)!)).toContain('Not acknowledged');
    mount.dispose();
  });

  it('offers only send-capable mail instances with account labels', async () => {
    const host = makeFakeElement('div');
    const runListMailInstances: SellerMailListCaller = vi.fn(async () => ({
      instances: [
        {
          slug: 'mail-read-only',
          send_capable: false,
          account_email: 'reader@example.com',
        },
        {
          slug: 'mail-primary',
          send_capable: true,
          account_email: 'owner@example.com',
        },
      ],
    }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'setup',
      runGetOverview: async () => overview({
        settings: {
          ...overview().settings,
          sender_mail_instance_id: 'mail-primary',
        },
      }),
      runListMailInstances,
      runUpdateSellerSettings: vi.fn(),
    });

    await mount.whenLoaded();

    const chooser = findByAttr(
      host,
      SELLER_SETTINGS_FORM_FIELD_ATTR,
      'sender_mail_instance_id',
    );
    expect(chooser?.tagName).toBe('SELECT');
    expect(chooser?.value).toBe('mail-primary');
    expect(chooser?.children.map((option) => option.value)).toEqual([
      '',
      'mail-primary',
    ]);
    expect(textOf(chooser!)).toContain('owner@example.com (mail-primary)');
    expect(textOf(chooser!)).not.toContain('mail-read-only');
    expect(textOf(findByAttr(host, SELLER_MAIL_CHOOSER_STATUS_ATTR)!)).toContain(
      'Only send-capable',
    );
    mount.dispose();
  });

  it('blocks a stale saved sender until the owner chooses a live account or no sender', async () => {
    const host = makeFakeElement('div');
    const base = overview();
    const staleOverview = overview({
      settings: {
        ...base.settings,
        sender_mail_instance_id: 'mail-stale',
      },
    });
    const runUpdateSellerSettings = vi.fn<SellerSettingsUpdateCaller>(async (request) => ({
      settings: {
        ...staleOverview.settings,
        sender_mail_instance_id: request.sender_mail_instance_id ?? null,
      },
      overview: {
        ...staleOverview,
        settings: {
          ...staleOverview.settings,
          sender_mail_instance_id: request.sender_mail_instance_id ?? null,
        },
      },
    }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'setup',
      runGetOverview: async () => staleOverview,
      runListMailInstances: async () => ({
        instances: [{
          slug: 'mail-primary',
          send_capable: true,
          account_email: 'owner@example.com',
        }],
      }),
      runUpdateSellerSettings,
    });
    await mount.whenLoaded();

    const chooser = findByAttr(
      host,
      SELLER_SETTINGS_FORM_FIELD_ATTR,
      'sender_mail_instance_id',
    );
    expect(chooser?.value).toBe('mail-stale');
    expect(textOf(chooser!)).toContain('mail-stale (unavailable)');
    findByAttr(host, SELLER_SETTINGS_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();
    expect(runUpdateSellerSettings).not.toHaveBeenCalled();
    expect(textOf(findByAttr(host, SELLER_SETTINGS_FORM_STATUS_ATTR)!)).toContain(
      'Sender mail instance is unavailable',
    );

    chooser!.value = '';
    findByAttr(host, SELLER_SETTINGS_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();
    expect(runUpdateSellerSettings).toHaveBeenCalledWith(expect.objectContaining({
      sender_mail_instance_id: null,
    }));
    mount.dispose();
  });

  it('retains the last-known-good mail choices after a refresh failure', async () => {
    const host = makeFakeElement('div');
    const runListMailInstances = vi.fn<SellerMailListCaller>();
    runListMailInstances
      .mockResolvedValueOnce({
        instances: [{
          slug: 'mail-primary',
          send_capable: true,
          account_email: 'owner@example.com',
        }],
      })
      .mockRejectedValueOnce(new Error('mail list unavailable'));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'setup',
      runGetOverview: async () => overview(),
      runListMailInstances,
      runUpdateSellerSettings: vi.fn(),
    });
    await mount.whenLoaded();
    await mount.refresh();

    const chooser = findByAttr(
      host,
      SELLER_SETTINGS_FORM_FIELD_ATTR,
      'sender_mail_instance_id',
    );
    expect(chooser?.children.map((option) => option.value)).toContain('mail-primary');
    expect(textOf(findByAttr(host, SELLER_MAIL_CHOOSER_STATUS_ATTR)!)).toContain(
      'last known send-capable accounts',
    );
    mount.dispose();
  });

  it('shows an honest no-sender state when no send-capable account exists', async () => {
    const host = makeFakeElement('div');
    const base = overview();
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'setup',
      runGetOverview: async () => overview({
        settings: { ...base.settings, sender_mail_instance_id: null },
      }),
      runListMailInstances: async () => ({ instances: [] }),
      runUpdateSellerSettings: vi.fn(),
    });
    await mount.whenLoaded();

    const chooser = findByAttr(
      host,
      SELLER_SETTINGS_FORM_FIELD_ATTR,
      'sender_mail_instance_id',
    );
    expect(chooser?.children.map((option) => option.value)).toEqual(['']);
    expect(textOf(chooser!)).toContain('No sender');
    expect(textOf(findByAttr(host, SELLER_MAIL_CHOOSER_STATUS_ATTR)!)).toContain(
      'No send-capable mail accounts',
    );
    mount.dispose();
  });

  it('keeps invalid seller settings JSON client-side', async () => {
    const host = makeFakeElement('div');
    const runUpdateSellerSettings = vi.fn<SellerSettingsUpdateCaller>();
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'setup',
      runGetOverview: async () => overview(),
      runUpdateSellerSettings,
    });
    await mount.whenLoaded();

    const statusPolicy = findByAttr(
      host,
      SELLER_SETTINGS_FORM_FIELD_ATTR,
      'status_policy_json',
    );
    if (statusPolicy === null) throw new Error('missing status policy field');
    statusPolicy.value = '[]';

    findByAttr(host, SELLER_SETTINGS_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();

    expect(runUpdateSellerSettings).not.toHaveBeenCalled();
    const status = findByAttr(host, SELLER_SETTINGS_FORM_STATUS_ATTR);
    expect(status?.getAttribute('role')).toBe('alert');
    expect(textOf(status!)).toContain('Status policy must be a JSON object.');

    statusPolicy.value = '{';
    findByAttr(host, SELLER_SETTINGS_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();

    expect(runUpdateSellerSettings).not.toHaveBeenCalled();
    expect(status?.getAttribute('role')).toBe('alert');
    expect(textOf(status!)).toContain('Status policy must be valid JSON.');
    mount.dispose();
  });

  it('submits manual tier form through the owner RPC and renders the returned overview', async () => {
    const host = makeFakeElement('div');
    const newTier: SellerTier = {
      tier_id: 'tier-pro',
      door_id: 'door-llm',
      lifecycle_source: 'manual',
      entitlement_key: 'consulting-pro',
      display_name: 'Consulting Pro',
      template_contract_id: 'contract-template-pro',
      external_entitlement_id: null,
      usage_policy_json: {
        chat_turn: { period_granularity: 'month', period_limit: 50 },
      },
      pass_duration_seconds: 3_600,
      customer_status_enabled_default: true,
      active: false,
      created_at: 1_700_000_200_000,
      updated_at: 1_700_000_200_000,
    };
    const runUpsertManualTier: SellerManualTierUpsertCaller = vi.fn(async () => ({
      tier: newTier,
      overview: overview({
        counts: {
          tiers: 2,
          active_tiers: 1,
          customers: 1,
          active_customers: 1,
          grace_customers: 0,
          closed_customers: 0,
        },
        tiers: [newTier],
      }),
    }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'tiers',
      runGetOverview: async () => overview({ tiers: [] }),
      runUpsertManualTier,
    });

    await mount.whenLoaded();

    const field = (name: string): FakeElement => {
      const el = findByAttr(host, SELLER_TIER_FORM_FIELD_ATTR, name);
      if (el === null) throw new Error(`missing field ${name}`);
      return el;
    };
    field('tier_id').value = 'tier-pro';
    field('door_id').value = 'door-llm';
    field('entitlement_key').value = 'consulting-pro';
    field('display_name').value = 'Consulting Pro';
    field('template_contract_id').value = 'contract-template-pro';
    field('pass_duration_seconds').value = '3600';
    field('usage_policy_json').value =
      '{"chat_turn":{"period_granularity":"month","period_limit":50}}';
    field('customer_status_enabled_default').checked = true;
    field('active').checked = false;

    findByAttr(host, SELLER_TIER_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();

    expect(runUpsertManualTier).toHaveBeenCalledWith({
      tier_id: 'tier-pro',
      door_id: 'door-llm',
      entitlement_key: 'consulting-pro',
      display_name: 'Consulting Pro',
      template_contract_id: 'contract-template-pro',
      usage_policy_json: {
        chat_turn: { period_granularity: 'month', period_limit: 50 },
      },
      pass_duration_seconds: 3_600,
      customer_status_enabled_default: true,
      active: false,
    });
    expect(mount.getState().overview?.counts.tiers).toBe(2);
    expect(findByAttr(host, SELLER_TIER_ROW_ATTR, 'tier-pro')).not.toBeNull();
    expect(textOf(host)).toContain('Consulting Pro');
    const status = findByAttr(host, SELLER_TIER_FORM_STATUS_ATTR);
    expect(status?.getAttribute('data-kind')).toBe('success');
    expect(textOf(status!)).toContain('Tier saved.');
    mount.dispose();
  });

  it('loads an existing tier into the form before a metadata edit', async () => {
    const host = makeFakeElement('div');
    const existing: SellerTier = {
      ...overview().tiers[0]!,
      usage_policy_json: { chat_turn: { period_limit: 75 } },
      pass_duration_seconds: 3600,
      customer_status_enabled_default: true,
      active: false,
    };
    const current = overview({ tiers: [existing] });
    const runUpsertManualTier: SellerManualTierUpsertCaller = vi.fn(async () => ({
      tier: { ...existing, display_name: 'Consulting renamed' },
      overview: current,
    }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'tiers',
      runGetOverview: async () => current,
      runUpsertManualTier,
    });
    await mount.whenLoaded();

    const field = (name: string): FakeElement => {
      const el = findByAttr(host, SELLER_TIER_FORM_FIELD_ATTR, name);
      if (el === null) throw new Error(`missing field ${name}`);
      return el;
    };
    const tierId = field('tier_id');
    tierId.value = existing.tier_id;
    for (const listener of tierId.listeners.get('input') ?? []) {
      listener({ target: tierId });
    }

    expect(field('usage_policy_json').value).toContain('"period_limit": 75');
    expect(field('pass_duration_seconds').value).toBe('3600');
    expect(field('door_id').disabled).toBe(true);
    expect(field('entitlement_key').disabled).toBe(true);
    expect(field('customer_status_enabled_default').checked).toBe(true);
    expect(field('active').checked).toBe(false);
    field('display_name').value = 'Consulting renamed';

    findByAttr(host, SELLER_TIER_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();
    expect(runUpsertManualTier).toHaveBeenCalledWith({
      tier_id: existing.tier_id,
      door_id: existing.door_id,
      entitlement_key: existing.entitlement_key,
      display_name: 'Consulting renamed',
      template_contract_id: existing.template_contract_id,
      usage_policy_json: { chat_turn: { period_limit: 75 } },
      pass_duration_seconds: 3600,
      customer_status_enabled_default: true,
      active: false,
    });
    mount.dispose();
  });

  it('creates a pass tier through the owner RPC and deep-links its template to #contracts', async () => {
    const host = makeFakeElement('div');
    const passTier: SellerTier = {
      tier_id: 'tier-day-pass',
      door_id: 'door-mcp',
      lifecycle_source: 'manual',
      entitlement_key: 'day-pass',
      display_name: 'Day pass',
      template_contract_id: 'contract-pass-template',
      external_entitlement_id: null,
      usage_policy_json: {
        chat_turn: { period_granularity: 'day', period_limit: 50 },
        tool_call: { period_granularity: 'day', period_limit: 200 },
      },
      pass_duration_seconds: 86_400,
      customer_status_enabled_default: false,
      active: true,
      created_at: 1_700_000_300_000,
      updated_at: 1_700_000_300_000,
    };
    const runCreatePassTier: SellerCreatePassTierCaller = vi.fn(
      async (): Promise<SellerCreatePassTierResponse> => ({
        tier: passTier,
        template_contract_id: 'contract-pass-template',
        overview: overview({
          counts: {
            tiers: 2,
            active_tiers: 2,
            customers: 1,
            active_customers: 1,
            grace_customers: 0,
            closed_customers: 0,
          },
          tiers: [passTier],
        }),
      }),
    );
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'tiers',
      runGetOverview: async () => overview({ tiers: [] }),
      runCreatePassTier,
    });
    await mount.whenLoaded();

    expect(findByAttr(host, SELLER_PASS_TIER_FORM_ATTR)).not.toBeNull();
    const field = (name: string): FakeElement => {
      const el = findByAttr(host, SELLER_PASS_TIER_FORM_FIELD_ATTR, name);
      if (el === null) throw new Error(`missing pass-tier field ${name}`);
      return el;
    };
    field('door_id').value = 'door-mcp';
    field('door_type').value = 'mcp';
    field('entitlement_key').value = 'day-pass';
    field('display_name').value = 'Day pass';
    field('pass_duration_seconds').value = '86400';
    field('usage_policy_json').value =
      '{"chat_turn":{"period_granularity":"day","period_limit":50},'
      + '"tool_call":{"period_granularity":"day","period_limit":200}}';

    findByAttr(host, SELLER_PASS_TIER_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();

    // The webclient never authors a lifecycle source or a template id — the
    // server derives both (I-1 / anti-spoof).
    expect(runCreatePassTier).toHaveBeenCalledWith({
      door_id: 'door-mcp',
      door_type: 'mcp',
      entitlement_key: 'day-pass',
      display_name: 'Day pass',
      pass_duration_seconds: 86_400,
      usage_policy_json: {
        chat_turn: { period_granularity: 'day', period_limit: 50 },
        tool_call: { period_granularity: 'day', period_limit: 200 },
      },
    });
    const status = findByAttr(host, SELLER_PASS_TIER_FORM_STATUS_ATTR);
    expect(status?.getAttribute('data-kind')).toBe('success');
    expect(textOf(status!.parent!)).toContain('Day pass');
    // The returned template is deep-linked into #contracts for grant authoring.
    // Scope the search to the pass-tier FORM section — the tiers table below
    // also renders a contract link for the same template id, so an unscoped
    // search would pass even if the form's own deep-link were missing.
    const passForm = findByAttr(host, SELLER_PASS_TIER_FORM_ATTR);
    expect(passForm).not.toBeNull();
    const link = findByAttr(passForm!, SELLER_CONTRACT_LINK_ATTR, 'contract-pass-template');
    expect(link).not.toBeNull();
    expect(mount.getState().overview?.counts.tiers).toBe(2);
    mount.dispose();
  });

  it('omits the pass-tier form when no create-pass-tier caller is wired', async () => {
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'tiers',
      runGetOverview: async () => overview({ tiers: [] }),
    });
    await mount.whenLoaded();
    expect(findByAttr(host, SELLER_PASS_TIER_FORM_ATTR)).toBeNull();
    mount.dispose();
  });

  it('bulk adjusts manual tier customers through the owner RPC', async () => {
    const host = makeFakeElement('div');
    const base = overview();
    const secondCustomer: SellerCustomer = {
      ...base.customers[0]!,
      customer_id: 'customer-2',
      source_customer_id: 'manual-cus-2',
      contract_id: 'contract-customer-2',
      inbound_token_id: 'inbound-2',
      mcp_token_id: 'mcp-2',
    };
    const runBulkAdjustManualTierCustomers:
      SellerManualTierBulkAdjustCaller = vi.fn(async (request) => {
        const selectedIds = request.customer_ids ?? ['customer-1'];
        const selectedCustomers = [base.customers[0]!, secondCustomer].filter(
          (customer) => selectedIds.includes(customer.customer_id),
        );
        return {
          tier: base.tiers[0]!,
          adjusted_customers: selectedCustomers,
          skipped_closed_customers: [],
          overview: overview({
            customers: [base.customers[0]!, secondCustomer],
            counts: {
              tiers: 1,
              active_tiers: 1,
              customers: 2,
              active_customers: 2,
              grace_customers: 0,
              closed_customers: 0,
            },
          }),
        };
      });
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'tiers',
      initialItemId: 'tier-1',
      runGetOverview: async () => base,
      runBulkAdjustManualTierCustomers,
    });

    await mount.whenLoaded();

    expect(findByAttr(host, SELLER_TIER_BULK_ADJUST_FORM_ATTR)).not.toBeNull();
    findByAttr(host, SELLER_TIER_BULK_ADJUST_SUBMIT_ATTR)?.click();
    await flushAsync();

    expect(runBulkAdjustManualTierCustomers).toHaveBeenCalledWith({
      tier_id: 'tier-1',
    });
    let status = findByAttr(host, SELLER_TIER_BULK_ADJUST_STATUS_ATTR);
    expect(status?.getAttribute('data-kind')).toBe('success');
    expect(textOf(status!)).toContain('Tier customers adjusted. 1 adjusted, 0 skipped.');

    const allOpen = findByAttr(
      host,
      SELLER_TIER_BULK_ADJUST_FIELD_ATTR,
      'all_open_customers',
    );
    const customerIds = findByAttr(
      host,
      SELLER_TIER_BULK_ADJUST_FIELD_ATTR,
      'customer_ids',
    );
    if (allOpen === null || customerIds === null) {
      throw new Error('missing bulk-adjust fields');
    }
    allOpen.checked = false;
    for (const listener of allOpen.listeners.get('change') ?? []) {
      listener({ target: allOpen });
    }
    customerIds.value = 'customer-1\ncustomer-2';

    findByAttr(host, SELLER_TIER_BULK_ADJUST_SUBMIT_ATTR)?.click();
    await flushAsync();

    expect(runBulkAdjustManualTierCustomers).toHaveBeenLastCalledWith({
      tier_id: 'tier-1',
      customer_ids: ['customer-1', 'customer-2'],
    });
    status = findByAttr(host, SELLER_TIER_BULK_ADJUST_STATUS_ATTR);
    expect(status?.getAttribute('data-kind')).toBe('success');
    expect(textOf(status!)).toContain('Tier customers adjusted. 2 adjusted, 0 skipped.');
    expect(mount.getState().overview?.counts.customers).toBe(2);
    mount.dispose();
  });

  it('keeps invalid manual tier bulk-adjust customer IDs client-side', async () => {
    const host = makeFakeElement('div');
    const runBulkAdjustManualTierCustomers =
      vi.fn<SellerManualTierBulkAdjustCaller>();
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'tiers',
      initialItemId: 'tier-1',
      runGetOverview: async () => overview(),
      runBulkAdjustManualTierCustomers,
    });

    await mount.whenLoaded();

    const allOpen = findByAttr(
      host,
      SELLER_TIER_BULK_ADJUST_FIELD_ATTR,
      'all_open_customers',
    );
    const customerIds = findByAttr(
      host,
      SELLER_TIER_BULK_ADJUST_FIELD_ATTR,
      'customer_ids',
    );
    if (allOpen === null || customerIds === null) {
      throw new Error('missing bulk-adjust fields');
    }
    allOpen.checked = false;
    for (const listener of allOpen.listeners.get('change') ?? []) {
      listener({ target: allOpen });
    }
    customerIds.value = 'customer-1, customer-1';

    findByAttr(host, SELLER_TIER_BULK_ADJUST_SUBMIT_ATTR)?.click();
    await flushAsync();

    expect(runBulkAdjustManualTierCustomers).not.toHaveBeenCalled();
    const status = findByAttr(host, SELLER_TIER_BULK_ADJUST_STATUS_ATTR);
    expect(status?.getAttribute('role')).toBe('alert');
    expect(textOf(status!)).toContain('Customer IDs must not contain duplicates.');
    mount.dispose();
  });

  it('issues a manual customer and keeps the one-time claim link visible', async () => {
    const host = makeFakeElement('div');
    const newCustomer: SellerCustomer = {
      customer_id: 'customer-2',
      lifecycle_source: 'manual',
      source_customer_id: 'manual-cus-2',
      door_id: 'door-mcp',
      email: 'new@example.com',
      tier_id: 'tier-1',
      contract_id: 'contract-customer-2',
      inbound_token_id: 'inbound-2',
      mcp_token_id: 'inbound-2',
      external_subscription_id: null,
      source_status: 'paid',
      current_period_end: 1_702_000_000_000,
      grace_until: null,
      access_state: 'active',
      claim_email_sent_at: 1_700_000_200_100,
      claim_email_marker: 'claim:claim-2',
      status_email_sent_at: null,
      status_email_marker: null,
      created_at: 1_700_000_200_000,
      updated_at: 1_700_000_200_000,
    };
    const issueResponse: SellerManualCustomerIssueResponse = {
      result: 'created',
      customer: newCustomer,
      claim: {
        claim_url: 'https://seller.example/reception/claim?t=short-lived-claim',
        expires_at: 1_700_003_800_000,
      },
      claim_email_delivery: {
        status: 'sent',
        message_id: 'message-claim-2',
        sent_at: 1_700_000_200_100,
      },
      overview: overview({
        counts: {
          tiers: 1,
          active_tiers: 1,
          customers: 2,
          active_customers: 2,
          grace_customers: 0,
          closed_customers: 0,
        },
        customers: [...overview().customers, newCustomer],
      }),
    };
    const runIssueManualCustomer: SellerManualCustomerIssueCaller = vi.fn(
      async () => issueResponse,
    );
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'customers',
      runGetOverview: async () => overview(),
      runIssueManualCustomer,
    });

    await mount.whenLoaded();

    const field = (name: string): FakeElement => {
      const el = findByAttr(host, SELLER_CUSTOMER_FORM_FIELD_ATTR, name);
      if (el === null) throw new Error(`missing field ${name}`);
      return el;
    };
    expect(field('door_id').value).toBe('door-mcp');
    expect(field('entitlement_key').value).toBe('consulting-basic');
    field('source_customer_id').value = 'manual-cus-2';
    field('email').value = 'new@example.com';
    expect(field('send_claim_email').disabled).toBe(false);
    field('send_claim_email').checked = true;
    field('current_period_end').value = '1702000000000';
    field('source_status').value = 'paid';
    for (const name of ['token_label', 'token_grants', 'token_expires_at']) {
      expect(findByAttr(host, SELLER_CUSTOMER_FORM_FIELD_ATTR, name)).toBeNull();
    }

    findByAttr(host, SELLER_CUSTOMER_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();

    expect(runIssueManualCustomer).toHaveBeenCalledWith({
      door_id: 'door-mcp',
      entitlement_key: 'consulting-basic',
      source_customer_id: 'manual-cus-2',
      email: 'new@example.com',
      send_claim_email: true,
      current_period_end: 1_702_000_000_000,
      source_status: 'paid',
    });
    expect(mount.getState().overview?.counts.customers).toBe(2);
    expect(findByAttr(host, SELLER_CUSTOMER_ROW_ATTR, 'customer-2')).not.toBeNull();
    const status = findByAttr(host, SELLER_CUSTOMER_FORM_STATUS_ATTR);
    expect(status?.getAttribute('data-kind')).toBe('success');
    expect(textOf(status!)).toContain('Claim email sent.');
    expect(textOf(status!)).toContain(
      'One-time claim link: https://seller.example/reception/claim?t=short-lived-claim',
    );
    expect(textOf(status!)).not.toContain('recued_customer_bearer');
    mount.dispose();
  });

  it('reports post-commit claim email failure without hiding the manual claim link', async () => {
    const host = makeFakeElement('div');
    const base = overview();
    const customer: SellerCustomer = {
      ...base.customers[0]!,
      customer_id: 'customer-mail-failed',
      source_customer_id: 'manual-mail-failed',
      claim_email_marker: 'claim:claim-mail-failed',
      claim_email_sent_at: null,
    };
    const runIssueManualCustomer: SellerManualCustomerIssueCaller = vi.fn(
      async () => ({
        result: 'created',
        customer,
        claim: {
          claim_url: 'https://seller.example/reception/claim?t=failed-mail-claim',
          expires_at: 1_700_003_800_000,
        },
        claim_email_delivery: {
          status: 'failed',
          error_code: 'MAIL_SEND_NETWORK_FAILED',
        },
        overview: overview({ customers: [customer] }),
      } satisfies SellerManualCustomerIssueResponse),
    );
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'customers',
      runGetOverview: async () => base,
      runIssueManualCustomer,
    });
    await mount.whenLoaded();
    const field = (name: string): FakeElement => {
      const el = findByAttr(host, SELLER_CUSTOMER_FORM_FIELD_ATTR, name);
      if (el === null) throw new Error(`missing field ${name}`);
      return el;
    };
    field('source_customer_id').value = 'manual-mail-failed';
    field('email').value = 'buyer@example.com';
    field('send_claim_email').checked = true;

    findByAttr(host, SELLER_CUSTOMER_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();

    const status = findByAttr(host, SELLER_CUSTOMER_FORM_STATUS_ATTR);
    expect(status?.getAttribute('data-kind')).toBe('error');
    expect(status?.getAttribute('role')).toBe('alert');
    expect(textOf(status!)).toContain(
      'Claim email failed (MAIL_SEND_NETWORK_FAILED); deliver the link manually.',
    );
    expect(textOf(status!)).toContain(
      'One-time claim link: https://seller.example/reception/claim?t=failed-mail-claim',
    );
    expect(findByAttr(host, SELLER_CUSTOMER_ROW_ATTR, 'customer-mail-failed'))
      .not.toBeNull();
    mount.dispose();
  });

  it('runs manual customer lifecycle actions against existing rows', async () => {
    const host = makeFakeElement('div');
    const base = overview();
    const extendedCustomer: SellerCustomer = {
      ...base.customers[0]!,
      email: 'renewed@example.com',
      source_status: 'renewed',
      current_period_end: 1_703_000_000_000,
    };
    const swappedCustomer: SellerCustomer = {
      ...extendedCustomer,
      tier_id: 'tier-1',
      source_status: 'upgraded',
      current_period_end: 1_704_000_000_000,
    };
    const reissuedCustomer: SellerCustomer = {
      ...swappedCustomer,
      inbound_token_id: 'inbound-reissued',
      mcp_token_id: 'inbound-reissued',
      updated_at: 1_700_000_250_000,
    };
    const closedCustomer: SellerCustomer = {
      ...reissuedCustomer,
      access_state: 'closed',
      source_status: 'closed_by_owner',
      updated_at: 1_700_000_300_000,
    };
    const runExtendManualCustomer: SellerManualCustomerExtendCaller = vi.fn(
      async () => ({
        customer: extendedCustomer,
        overview: overview({
          customers: [extendedCustomer],
        }),
      }),
    );
    const runSwapManualCustomerTier: SellerManualCustomerSwapTierCaller = vi.fn(
      async () => ({
        customer: swappedCustomer,
        overview: overview({
          customers: [swappedCustomer],
        }),
      }),
    );
    const reissueResponse: SellerManualCustomerReissueTokenResponse = {
      customer: reissuedCustomer,
      claim: {
        claim_url: 'https://seller.example/reception/claim?t=reissued-short-lived-claim',
        expires_at: 1_700_003_850_000,
      },
      overview: overview({
        customers: [reissuedCustomer],
      }),
    };
    const runReissueManualCustomerToken: SellerManualCustomerReissueTokenCaller = vi.fn(
      async () => reissueResponse,
    );
    const runCloseManualCustomer: SellerManualCustomerCloseCaller = vi.fn(
      async () => ({
        customer: closedCustomer,
        overview: overview({
          counts: {
            tiers: 1,
            active_tiers: 1,
            customers: 1,
            active_customers: 0,
            grace_customers: 0,
            closed_customers: 1,
          },
          customers: [closedCustomer],
        }),
      }),
    );
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'customers',
      initialItemId: 'customer-1',
      runGetOverview: async () => base,
      runExtendManualCustomer,
      runSwapManualCustomerTier,
      runReissueManualCustomerToken,
      runCloseManualCustomer,
    });
    await mount.whenLoaded();

    expect(findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_FORM_ATTR)).not.toBeNull();
    const field = (name: string): FakeElement => {
      const el = findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR, name);
      if (el === null) throw new Error(`missing lifecycle field ${name}`);
      return el;
    };
    for (const [name, accessibleName] of [
      ['extend.customer_id', 'Customer to extend'],
      ['extend.email', 'Extension email'],
      ['extend.current_period_end', 'Extension period end (Unix ms)'],
      ['extend.source_status', 'Extension source status'],
      ['swap.customer_id', 'Customer to swap'],
      ['swap.entitlement_key', 'Swap entitlement'],
      ['swap.current_period_end', 'Swap period end (Unix ms)'],
      ['swap.source_status', 'Swap source status'],
      ['close.customer_id', 'Customer to close'],
      ['close.reason', 'Close reason'],
      ['close.source_status', 'Close source status'],
      ['reissue.customer_id', 'Customer to reissue'],
      ['message.customer_id', 'Customer to message'],
    ] as const) {
      expect(field(name).getAttribute('aria-label')).toBe(accessibleName);
    }

    field('extend.customer_id').value = 'customer-1';
    field('extend.email').value = 'renewed@example.com';
    field('extend.current_period_end').value = '1703000000000';
    field('extend.source_status').value = 'renewed';
    findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'extend')?.click();
    await flushAsync();

    expect(runExtendManualCustomer).toHaveBeenCalledWith({
      customer_id: 'customer-1',
      email: 'renewed@example.com',
      current_period_end: 1_703_000_000_000,
      source_status: 'renewed',
    });
    expect(textOf(findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_STATUS_ATTR)!))
      .toContain('Customer extended.');
    expect(textOf(host)).toContain('renewed@example.com');

    field('swap.customer_id').value = 'customer-1';
    field('swap.entitlement_key').value = 'consulting-basic';
    field('swap.current_period_end').value = '1704000000000';
    field('swap.source_status').value = 'upgraded';
    findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'swap')?.click();
    await flushAsync();

    expect(runSwapManualCustomerTier).toHaveBeenCalledWith({
      customer_id: 'customer-1',
      entitlement_key: 'consulting-basic',
      current_period_end: 1_704_000_000_000,
      source_status: 'upgraded',
    });
    expect(textOf(findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_STATUS_ATTR)!))
      .toContain('Customer tier swapped.');

    field('reissue.customer_id').value = 'customer-1';
    for (const name of [
      'reissue.token_label',
      'reissue.token_expires_at',
      'reissue.source_status',
      'reissue.token_grants',
    ]) {
      expect(findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR, name)).toBeNull();
    }
    findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'reissue')?.click();
    await flushAsync();

    expect(runReissueManualCustomerToken).toHaveBeenCalledWith({
      customer_id: 'customer-1',
    });
    expect(textOf(findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_STATUS_ATTR)!))
      .toContain(
        'Customer token reissued. One-time claim link: https://seller.example/reception/claim?t=reissued-short-lived-claim',
      );

    field('close.customer_id').value = 'customer-1';
    field('close.reason').value = 'seller_manual';
    field('close.source_status').value = 'closed_by_owner';
    findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'close')?.click();
    await flushAsync();

    expect(runCloseManualCustomer).toHaveBeenCalledWith({
      customer_id: 'customer-1',
      reason: 'seller_manual',
      source_status: 'closed_by_owner',
    });
    expect(textOf(findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_STATUS_ATTR)!))
      .toContain('Customer closed.');
    expect(mount.getState().overview?.counts.closed_customers).toBe(1);
    mount.dispose();
  });

  it('Message customer: opens a confirm modal, then reissues with send_claim_email to the stored email on confirm', async () => {
    const host = makeFakeElement('div');
    const base = overview(); // customer-1 has email buyer@example.com; mail_sender ready
    const messagedCustomer: SellerCustomer = {
      ...base.customers[0]!,
      inbound_token_id: 'inbound-messaged',
      mcp_token_id: 'inbound-messaged',
      claim_email_sent_at: 1_700_000_400_000,
    };
    const runReissueManualCustomerToken: SellerManualCustomerReissueTokenCaller = vi.fn(
      async (): Promise<SellerManualCustomerReissueTokenResponse> => ({
        customer: messagedCustomer,
        claim: {
          claim_url: 'https://seller.example/reception/claim?t=fresh-messaged',
          expires_at: 1_700_003_850_000,
        },
        claim_email_delivery: { status: 'sent', message_id: 'm-1', sent_at: 1_700_000_400_000 },
        overview: overview({ customers: [messagedCustomer] }),
      }),
    );
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'customers',
      initialItemId: 'customer-1',
      runGetOverview: async () => base,
      runReissueManualCustomerToken,
    });
    await mount.whenLoaded();

    const field = (name: string): FakeElement => {
      const el = findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR, name);
      if (el === null) throw new Error(`missing lifecycle field ${name}`);
      return el;
    };
    field('message.customer_id').value = 'customer-1';

    // Clicking "Message customer" opens the confirm modal — nothing sent yet.
    findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'message')?.click();
    await flushAsync();
    const modal = findByAttr(host, SELLER_MESSAGE_MODAL_ATTR);
    expect(modal).not.toBeNull();
    expect(textOf(modal!)).toContain('buyer@example.com');
    expect(runReissueManualCustomerToken).not.toHaveBeenCalled();

    // Confirm → reissue with send_claim_email; the recipient is the STORED email.
    findByAttr(host, SELLER_MESSAGE_MODAL_CONFIRM_ATTR)?.click();
    await flushAsync();
    expect(runReissueManualCustomerToken).toHaveBeenCalledWith({
      customer_id: 'customer-1',
      send_claim_email: true,
    });
    expect(textOf(findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_STATUS_ATTR)!))
      .toContain('Access link emailed to buyer@example.com.');
    mount.dispose();
  });

  it('Message customer: Cancel closes the modal without sending', async () => {
    const host = makeFakeElement('div');
    const runReissueManualCustomerToken: SellerManualCustomerReissueTokenCaller = vi.fn();
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'customers',
      initialItemId: 'customer-1',
      runGetOverview: async () => overview(),
      runReissueManualCustomerToken,
    });
    await mount.whenLoaded();
    const el = findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR, 'message.customer_id');
    if (el === null) throw new Error('missing message.customer_id');
    el.value = 'customer-1';

    findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'message')?.click();
    await flushAsync();
    expect(findByAttr(host, SELLER_MESSAGE_MODAL_ATTR)).not.toBeNull();

    findByAttr(host, SELLER_MESSAGE_MODAL_CANCEL_ATTR)?.click();
    await flushAsync();
    expect(findByAttr(host, SELLER_MESSAGE_MODAL_ATTR)).toBeNull();
    expect(runReissueManualCustomerToken).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('filters manual customer swap tiers to the selected customer door', async () => {
    const host = makeFakeElement('div');
    const base = overview();
    const otherTier: SellerTier = {
      ...base.tiers[0]!,
      tier_id: 'tier-other',
      door_id: 'door-other',
      entitlement_key: 'other-basic',
      display_name: 'Other Basic',
    };
    const otherCustomer: SellerCustomer = {
      ...base.customers[0]!,
      customer_id: 'customer-2',
      source_customer_id: 'manual-cus-2',
      door_id: 'door-other',
      tier_id: 'tier-other',
      contract_id: 'contract-customer-2',
      inbound_token_id: 'inbound-2',
      mcp_token_id: 'inbound-2',
    };
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'customers',
      initialItemId: 'customer-2',
      runGetOverview: async () => overview({
        counts: {
          tiers: 2,
          active_tiers: 2,
          customers: 2,
          active_customers: 2,
          grace_customers: 0,
          closed_customers: 0,
        },
        tiers: [...base.tiers, otherTier],
        customers: [...base.customers, otherCustomer],
      }),
      runSwapManualCustomerTier: async () => ({
        customer: base.customers[0]!,
        overview: base,
      }),
    });
    await mount.whenLoaded();

    const customer = findByAttr(
      host,
      SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR,
      'swap.customer_id',
    );
    const entitlement = findByAttr(
      host,
      SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR,
      'swap.entitlement_key',
    );
    if (customer === null || entitlement === null) {
      throw new Error('missing swap lifecycle fields');
    }

    expect(customer.children.map((child) => child.value)).toEqual(['customer-2']);
    expect(entitlement.children.map((child) => child.value)).toEqual([
      'other-basic',
    ]);
    expect(entitlement.value).toBe('other-basic');
    mount.dispose();
  });

  it('does not render caller-authored token controls for manual issue', async () => {
    const host = makeFakeElement('div');
    const runIssueManualCustomer = vi.fn<SellerManualCustomerIssueCaller>();
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'customers',
      runGetOverview: async () => overview(),
      runIssueManualCustomer,
    });
    await mount.whenLoaded();

    for (const name of [
      'token_grants',
      'token_label',
      'token_expires_at',
      'token_concurrency_tier',
      'token_chat_mode',
    ]) {
      expect(findByAttr(host, SELLER_CUSTOMER_FORM_FIELD_ATTR, name)).toBeNull();
    }
    expect(runIssueManualCustomer).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('renders manual reissue as a target-only action', async () => {
    const host = makeFakeElement('div');
    const runReissueManualCustomerToken =
      vi.fn<SellerManualCustomerReissueTokenCaller>();
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'customers',
      initialItemId: 'customer-1',
      runGetOverview: async () => overview(),
      runReissueManualCustomerToken,
    });
    await mount.whenLoaded();

    expect(findByAttr(
      host,
      SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR,
      'reissue.customer_id',
    )).not.toBeNull();
    for (const name of [
      'reissue.token_grants',
      'reissue.token_label',
      'reissue.token_expires_at',
      'reissue.token_concurrency_tier',
      'reissue.token_chat_mode',
      'reissue.source_status',
    ]) {
      expect(findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR, name)).toBeNull();
    }
    expect(runReissueManualCustomerToken).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('keeps invalid manual tier JSON client-side', async () => {
    const host = makeFakeElement('div');
    const runUpsertManualTier = vi.fn<SellerManualTierUpsertCaller>();
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'tiers',
      runGetOverview: async () => overview({ tiers: [] }),
      runUpsertManualTier,
    });
    await mount.whenLoaded();

    for (const [name, value] of [
      ['tier_id', 'tier-bad'],
      ['door_id', 'door-llm'],
      ['entitlement_key', 'bad'],
      ['display_name', 'Bad Tier'],
      ['template_contract_id', 'contract-template-bad'],
    ] as const) {
      const el = findByAttr(host, SELLER_TIER_FORM_FIELD_ATTR, name);
      if (el === null) throw new Error(`missing field ${name}`);
      el.value = value;
    }
    const usage = findByAttr(host, SELLER_TIER_FORM_FIELD_ATTR, 'usage_policy_json');
    if (usage === null) throw new Error('missing usage field');
    usage.value = '[]';

    findByAttr(host, SELLER_TIER_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();

    expect(runUpsertManualTier).not.toHaveBeenCalled();
    const status = findByAttr(host, SELLER_TIER_FORM_STATUS_ATTR);
    expect(status?.getAttribute('role')).toBe('alert');
    expect(textOf(status!)).toContain('Usage policy must be a JSON object.');
    mount.dispose();
  });

  it('refresh re-reads the overview caller', async () => {
    const host = makeFakeElement('div');
    const runGetOverview = vi
      .fn()
      .mockResolvedValueOnce(overview())
      .mockResolvedValueOnce(overview({
        counts: {
          tiers: 1,
          active_tiers: 1,
          customers: 2,
          active_customers: 2,
          grace_customers: 0,
          closed_customers: 0,
        },
      }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'overview',
      runGetOverview,
    });
    await mount.whenLoaded();

    findByAttr(host, SELLER_REFRESH_ATTR)?.click();
    await mount.whenLoaded();

    expect(runGetOverview).toHaveBeenCalledTimes(2);
    expect(textOf(host)).toContain('Customers2');
    mount.dispose();
  });

  it('renders load failures inline', async () => {
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runGetOverview: async () => {
        throw new Error('seller overview unavailable');
      },
    });

    await mount.whenLoaded();

    expect(mount.getState().phase).toBe('error');
    expect(findByAttr(host, SELLER_ERROR_ATTR)).not.toBeNull();
    expect(textOf(host)).toContain('seller overview unavailable');
    mount.dispose();
  });
});

describe('D-250 § D — tier usage limits', () => {
  const stripeTier = () => ({
    tier_id: 'tier-stripe',
    door_id: 'door-mcp',
    lifecycle_source: 'stripe' as const,
    entitlement_key: 'pro',
    display_name: 'Pro',
    template_contract_id: 'contract-template-2',
    external_entitlement_id: 'feat_pro',
    // What `stripe-entitlement-sync` actually mints: no policy at all.
    usage_policy_json: {},
    pass_duration_seconds: null,
    customer_status_enabled_default: false,
    active: true,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_100_000,
  });

  it('⛔ NAMES THE UNLIMITED STATE — a `{}` policy renders "no limit", never "None"', async () => {
    // `shortJson({})` rendered "None", which reads far more naturally as "no
    // access" than "no ceiling" — so the riskiest state on the page was
    // described by a word suggesting its opposite.
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'tiers',
      runGetOverview: async () => overview({ tiers: [stripeTier()] }),
    });
    await mount.whenLoaded();
    const text = textOf(host);
    expect(text).toContain('Chat turns: no limit');
    expect(text).toContain('Tool calls: no limit');
  });

  it('⛔⛔ OFFERS THE FORM ON A STRIPE TIER — the one no other form can edit', async () => {
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'tiers',
      initialItemId: 'tier-stripe',
      runGetOverview: async () => overview({ tiers: [stripeTier()] }),
      runSetTierUsagePolicy: async () => ({
        tier: stripeTier(),
        overview: overview({ tiers: [stripeTier()] }),
      }),
    });
    await mount.whenLoaded();
    expect(findByAttr(host, SELLER_TIER_USAGE_FORM_ATTR, 'tier-stripe')).not.toBeNull();
  });

  it('posts only the kinds the owner filled in — blank stays UNLIMITED', async () => {
    // ⚠ The assertion that matters: an untouched kind is OMITTED, because
    // omission is what unlimited IS on the server. Writing a null-limit entry
    // would mean the same thing while implying someone configured it.
    const host = makeFakeElement('div');
    // ⛔ THE PARAMETER IS DECLARED ON PURPOSE. An argless `vi.fn(async () => …)`
    // infers a 0-TUPLE for `mock.calls`, so `calls[0]![0]` is TS2493 — green
    // under vitest and red under `typecheck:tests`, which is in `npm run ci`.
    const runSetTierUsagePolicy = vi.fn(async (_request: {
      tier_id: string;
      usage_policy_json: Record<string, unknown>;
    }) => ({
      tier: stripeTier(),
      overview: overview({ tiers: [stripeTier()] }),
    }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'tiers',
      initialItemId: 'tier-stripe',
      runGetOverview: async () => overview({ tiers: [stripeTier()] }),
      runSetTierUsagePolicy,
    });
    await mount.whenLoaded();
    const limit = findByAttr(host, SELLER_TIER_USAGE_FIELD_ATTR, 'tool_call.period_limit');
    expect(limit).not.toBeNull();
    limit!.value = '500';
    findByAttr(host, SELLER_TIER_USAGE_SUBMIT_ATTR, 'tier-stripe')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(runSetTierUsagePolicy).toHaveBeenCalledTimes(1);
    const payload = runSetTierUsagePolicy.mock.calls[0]![0];
    expect(payload.tier_id).toBe('tier-stripe');
    expect(payload.usage_policy_json).toEqual({
      tool_call: { period_granularity: 'month', period_limit: 500 },
    });
    // chat_turn was left blank ⇒ omitted ⇒ still unlimited.
    expect(payload.usage_policy_json.chat_turn).toBeUndefined();
  });

  it('an older paired server without the rpc renders limits READ-ONLY, not broken', async () => {
    // The caller is optional; a server that predates `setTierUsagePolicy`
    // should still show the limits rather than offering a control that 404s.
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialSubpage: 'tiers',
      initialItemId: 'tier-stripe',
      runGetOverview: async () => overview({ tiers: [stripeTier()] }),
    });
    await mount.whenLoaded();
    expect(findByAttr(host, SELLER_TIER_USAGE_FORM_ATTR)).toBeNull();
    expect(textOf(host)).toContain('no limit');
  });
});
