/** D-196 S2 - Settings -> Seller page. */

import { describe, expect, it, vi } from 'vitest';
import { LLM_GATEWAY_PAID_ACK_VERSION, SELLER_DEFAULT_DOOR_ID } from '@recued/contracts';
import type {
  SellerCreatePassTierResponse,
  SellerCustomer,
  SellerManualTierReapplyCustomer,
  SellerManualTierReapplyResponse,
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
  SELLER_BREADCRUMB_LINK_ATTR,
  SELLER_SUBNAV_LINK_ATTR,
  SELLER_DETAIL_TAB_ATTR,
  SELLER_CREATE_LINK_ATTR,
  SELLER_CREATE_PAGE_ATTR,
  SELLER_LIST_TOOLBAR_ATTR,
  SELLER_SETUP_DIRECTORY_ATTR,
  SELLER_SETUP_ROW_ATTR,
  SELLER_SETUP_SECTION_ATTR,
  SELLER_SETTINGS_ATTR,
  SELLER_READINESS_SETUP_LINK_ATTR,
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
  SELLER_PROVIDER_TIER_SYNC_FIELD_ATTR,
  SELLER_PROVIDER_TIER_SYNC_FORM_ATTR,
  SELLER_PROVIDER_TIER_SYNC_STATUS_ATTR,
  SELLER_PROVIDER_TIER_SYNC_SUBMIT_ATTR,
  type SellerProviderTierSynchronizeCaller,
  SELLER_TIER_FORM_ATTR,
  SELLER_TIER_FORM_FIELD_ATTR,
  SELLER_TIER_FORM_STATUS_ATTR,
  SELLER_TIER_FORM_SUBMIT_ATTR,
  SELLER_PASS_TIER_FORM_ATTR,
  SELLER_PASS_TIER_FORM_FIELD_ATTR,
  SELLER_PASS_TIER_FORM_STATUS_ATTR,
  SELLER_PASS_TIER_FORM_SUBMIT_ATTR,
  SELLER_CUSTOMER_REAPPLY_PREVIEW_ATTR,
  SELLER_TIER_REAPPLY_FIELD_ATTR,
  SELLER_TIER_REAPPLY_FORM_ATTR,
  SELLER_TIER_REAPPLY_PICK_ATTR,
  SELLER_TIER_REAPPLY_PREVIEW_ATTR,
  SELLER_TIER_REAPPLY_ROW_ATTR,
  SELLER_TIER_REAPPLY_STATUS_ATTR,
  SELLER_TIER_REAPPLY_SUBMIT_ATTR,
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
  type SellerManualTierReapplyCaller,
  type SellerListOrdersCaller,
  type SellerManualTierUpsertCaller,
  type SellerCreatePassTierCaller,
  type SellerOfferStateTransitionCaller,
  type SellerStripeSynchronizeCaller,
  mountSellerPage,
} from '../settings/seller-page.js';
import {
  LIST_PREVIEW_ATTR,
  LIST_PREVIEW_FACTS_ATTR,
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

  /** A preview's facts, label → value, in the order shown. */
  const previewFacts = (preview: FakeElement): Record<string, string> => {
    const list = findByAttr(preview, LIST_PREVIEW_FACTS_ATTR)!;
    const values = findAllByTag(list, 'dd');
    return Object.fromEntries(findAllByTag(list, 'dt').map((term, i) => [textOf(term), textOf(values[i]!)]));
  };
  /** Opens a row's preview the way the page listens for it: one click on the list. */
  const openPreview = (host: FakeElement, itemId: string): FakeElement => {
    const link = findByAttr(host, SELLER_COLLECTION_ITEM_LINK_ATTR, itemId)!;
    for (const listener of host.children[0]!.listeners.get('click') ?? []) {
      listener({ target: link, button: 0, preventDefault: () => undefined });
    }
    return findByAttr(host, LIST_PREVIEW_ATTR)!;
  };

  it('previews each Seller item as the item itself, then one button that opens it', async () => {
    // The owner, 2026-09-24: "for a review to make sense it should be [list of
    // tier item] [confirm]". The preview listed where the row sat (its list, its
    // id, the page number) under "Review this tiers item", so there was nothing to
    // review before opening it.
    const base = overview();
    const customer = base.customers[0]!;
    const shop = overview({
      tiers: [base.tiers[0]!, { ...base.tiers[0]!, tier_id: 'tier-2', display_name: 'Nobody yet' }],
      customers: [
        customer,
        { ...customer, customer_id: 'customer-2', access_state: 'grace' },
        { ...customer, customer_id: 'customer-3', access_state: 'closed' },
      ],
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
    });
    const cases: ReadonlyArray<{
      subpage: 'tiers' | 'customers' | 'offers' | 'orders' | 'usage';
      id: string;
      noun: string;
      facts: Record<string, string>;
    }> = [
      {
        subpage: 'tiers', id: 'tier-1', noun: 'package',
        facts: {
          Customers: '1 active, 1 in grace, 1 closed', Pass: '30d', Source: 'Manual',
          Template: 'contract-template-1', ID: 'tier-1',
        },
      },
      { subpage: 'tiers', id: 'tier-2', noun: 'package', facts: { Customers: 'None yet' } },
      {
        subpage: 'customers', id: 'customer-2', noun: 'customer',
        facts: { Package: 'Consulting Basic', Access: 'Grace', Email: 'buyer@example.com', ID: 'customer-2' },
      },
      {
        subpage: 'offers', id: 'paid-document.outcome', noun: 'offer',
        facts: {
          State: 'draft', About: 'One reviewed and delivered PDF document',
          Fulfillment: 'generate-paid-document', ID: 'paid-document.outcome',
        },
      },
      {
        subpage: 'orders', id: 'ord:paid-doc:sub_1', noun: 'order',
        // Whole values: the row's cells shorten the handle and the origin.
        facts: {
          Phase: 'awaiting_payment', Provider: 'stripe', Customer: 'Not set',
          Handle: `oh_${'a'.repeat(64)}`, Origin: 'Reception Submission · sub_1',
        },
      },
      {
        subpage: 'usage', id: 'contract-customer-1:chat_turn:month:1700000000000', noun: 'usage record',
        facts: { Kind: 'Chat Turn', Units: '17', Contract: 'contract-customer-1' },
      },
    ];
    for (const item of cases) {
      const host = makeFakeElement('div');
      const mount = mountSellerPage({
        host: host as unknown as HTMLElement,
        document: makeFakeDocument() as unknown as Document,
        initialSubpage: item.subpage,
        runGetOverview: async () => shop,
        runListOrders: async () => ordersResponse([makeOrder()]),
      });
      await mount.whenLoaded();
      const preview = openPreview(host, item.id);
      expect(preview.getAttribute('data-id')).toBe(item.id);
      const eyebrow = findAllByTag(preview, 'span').find((el) => el.className === 'list-preview-eyebrow')!;
      expect(textOf(eyebrow).toLowerCase()).toBe(item.noun);
      const facts = previewFacts(preview);
      expect(facts, `${item.subpage} ${item.id}`).toMatchObject(item.facts);
      for (const aboutTheList of ['Collection', 'Record', 'List page']) {
        expect(facts).not.toHaveProperty(aboutTheList);
      }
      expect(textOf(preview)).not.toContain('before you open everything');
      expect(textOf(findByAttr(preview, LIST_PREVIEW_OPEN_ATTR)!)).toBe(`Open ${item.noun}`);
      mount.dispose();
    }
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
    expect(textOf(host)).toContain('Recued cannot show orders');
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
    expect(modalText).toContain('You are the one saying so');
    expect(modalText).toContain('Recued cannot check');

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
    expect(textOf(status)).toContain('said no');
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
    expect(text).toContain('Only moving does this');
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
      'There are more after it.',
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
    expect(textOf(offerSection!)).toContain('the Recipe behind it');
    expect(textOf(offerSection!)).toContain('is only about showing it');
    expect(textOf(offerSection!)).toContain('does not cancel orders already going');
    expect(textOf(offerSection!)).toContain(
      'pause any Recipe or form that could start a new one',
    );
    expect(textOf(offerRow!)).not.toContain('recued-core');
    expect(textOf(offerRow!)).not.toContain('version');
    expect(textOf(accessSection!)).toContain(
      'separate from one-off things you sell',
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
    expect(textOf(definitionLink!)).toContain('Open the Recipe that made it');
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
    expect(textOf(fulfillmentLink!)).toContain('Open the Recipe that delivers it');
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
      'Once an offer is put away, you cannot bring it back.',
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
      'Recued did not note who made it',
    );
    expect(textOf(findByAttr(host, SELLER_OFFERS_ATTR)!)).toContain('Not linked');
    expect(findByAttr(host, SELLER_OFFER_DEFINITION_LINK_ATTR)).toBeNull();
    expect(findByAttr(host, SELLER_OFFER_FULFILLMENT_LINK_ATTR)).toBeNull();
    findByAttr(host, SELLER_OFFER_STATE_ACTION_ATTR, 'active')?.click();
    await flushAsync();
    await flushAsync();

    expect(mount.getState().overview?.offers?.[0]?.state).toBe('draft');
    expect(textOf(findByAttr(host, SELLER_OFFER_STATE_STATUS_ATTR)!)).toContain(
      'an answer it did not expect',
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
      initialAddress: { kind: 'setup', section: 'defaults' },
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
      initialAddress: { kind: 'setup', section: 'gateway' },
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
      initialAddress: { kind: 'setup', section: 'gateway' },
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
      initialAddress: { kind: 'setup', section: 'gateway' },
      runGetOverview: async () => overview(),
    });

    await mount.whenLoaded();

    expect(findByAttr(host, SELLER_LLM_GATEWAY_ACK_FORM_ATTR)).toBeNull();
    // The read-only row still honestly shows the unacknowledged state.
    expect(textOf(findByAttr(host, SELLER_LLM_GATEWAY_ATTR)!)).toContain('You have not agreed yet');
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
      initialAddress: { kind: 'setup', section: 'defaults' },
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
      'Only mailboxes that can send',
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
      initialAddress: { kind: 'setup', section: 'defaults' },
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
      'That mailbox cannot send',
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
      initialAddress: { kind: 'setup', section: 'defaults' },
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
      'the ones it knew about last',
    );
    mount.dispose();
  });

  it('shows an honest no-sender state when no send-capable account exists', async () => {
    const host = makeFakeElement('div');
    const base = overview();
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'setup', section: 'defaults' },
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
      'You have no mailbox that can send',
    );
    mount.dispose();
  });

  it('keeps invalid seller settings JSON client-side', async () => {
    const host = makeFakeElement('div');
    const runUpdateSellerSettings = vi.fn<SellerSettingsUpdateCaller>();
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'setup', section: 'defaults' },
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
    expect(textOf(status!)).toContain('Status policy has to be a JSON object.');

    statusPolicy.value = '{';
    findByAttr(host, SELLER_SETTINGS_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();

    expect(runUpdateSellerSettings).not.toHaveBeenCalled();
    expect(status?.getAttribute('role')).toBe('alert');
    expect(textOf(status!)).toContain('Status policy has to be JSON that Recued can read.');
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
      initialAddress: { kind: 'create', subpage: 'tiers', variant: 'manual' },
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
    expect(textOf(status!)).toContain('Saved.');
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
      initialAddress: { kind: 'create', subpage: 'tiers', variant: 'manual' },
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
      initialAddress: { kind: 'create', subpage: 'tiers', variant: 'pass' },
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
      initialAddress: { kind: 'create', subpage: 'tiers', variant: 'pass' },
      runGetOverview: async () => overview({ tiers: [] }),
    });
    await mount.whenLoaded();
    expect(findByAttr(host, SELLER_PASS_TIER_FORM_ATTR)).toBeNull();
    mount.dispose();
  });

  /** D-309 — one row of a re-apply answer. */
  const reapplyRow = (
    overrides: Partial<SellerManualTierReapplyCustomer> = {},
  ): SellerManualTierReapplyCustomer => ({
    customer_id: 'customer-1',
    label: 'buyer@example.com',
    access_state: 'active',
    changed_by_hand: { end_date: false, permissions: false },
    started_at: 1_700_000_000_000,
    end_before: 1_701_000_000_000,
    end_after: 1_702_592_000_000,
    included: true,
    skipped: null,
    ...overrides,
  });
  const fireChange = (el: FakeElement): void => {
    for (const listener of el.listeners.get('change') ?? []) listener({ target: el });
  };
  const reapplyField = (host: FakeElement, field: string): FakeElement => {
    const el = findByAttr(host, SELLER_TIER_REAPPLY_FIELD_ATTR, field);
    if (el === null) throw new Error(`missing re-apply field ${field}`);
    return el;
  };

  it('D-309: re-applies the package from its Re-apply tab, previewed first', async () => {
    const host = makeFakeElement('div');
    const base = overview();
    const bea = reapplyRow({
      customer_id: 'customer-2', label: 'bea@example.com',
      changed_by_hand: { end_date: true, permissions: false },
      end_after: 1_701_000_000_000, included: false, skipped: 'changed_by_hand',
    });
    const runReapplyManualTier: SellerManualTierReapplyCaller = vi.fn(async (request) => ({
      tier: base.tiers[0]!,
      preview: request.preview ?? false,
      customers: [reapplyRow(), bea],
      overview: base,
    }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'detail', subpage: 'tiers', itemId: 'tier-1', tab: 'customers' },
      runGetOverview: async () => base,
      runReapplyManualTier,
    });
    await mount.whenLoaded();

    // Named for what it does: the Seller sections above it have a "Customers" too.
    // The address keeps `customers`, so a link to it still lands here.
    const tab = findByAttr(host, SELLER_DETAIL_TAB_ATTR, 'customers')!;
    expect(textOf(tab)).toBe('Re-apply');
    expect(tab.getAttribute('href')).toBe('#settings/seller/tiers/detail/tier-1/customers');
    expect(findAllByAttr(host, SELLER_DETAIL_TAB_ATTR).map(textOf)).not.toContain('Customers');
    expect(findByAttr(host, SELLER_TIER_REAPPLY_FORM_ATTR)).not.toBeNull();
    const submit = findByAttr(host, SELLER_TIER_REAPPLY_SUBMIT_ATTR)!;
    // Nothing can be re-applied before it has been previewed.
    expect(submit.disabled).toBe(true);
    const who = reapplyField(host, 'who');
    who.value = 'unchanged';
    fireChange(who);
    findByAttr(host, SELLER_TIER_REAPPLY_PREVIEW_ATTR)?.click();
    await flushAsync();

    expect(runReapplyManualTier).toHaveBeenCalledWith({
      tier_id: 'tier-1', apply: { permissions: true, length: true }, who: 'unchanged', preview: true,
    });
    const rows = findAllByAttr(host, SELLER_TIER_REAPPLY_ROW_ATTR);
    expect(rows.map((row) => row.getAttribute(SELLER_TIER_REAPPLY_ROW_ATTR))).toEqual(['customer-1', 'customer-2']);
    expect(textOf(rows[1]!)).toContain('Changed by hand, left alone');
    expect(textOf(rows[1]!)).toContain('End date');
    expect(textOf(findByAttr(host, SELLER_TIER_REAPPLY_STATUS_ATTR)!)).toContain('1 would be re-applied, 1 left alone.');
    expect(submit.textContent).toBe('Re-apply to 1 customer');
    expect(submit.disabled).toBe(false);

    submit.click();
    await flushAsync();
    expect(runReapplyManualTier).toHaveBeenLastCalledWith({
      tier_id: 'tier-1', apply: { permissions: true, length: true }, who: 'unchanged', preview: false,
    });
    const status = findByAttr(host, SELLER_TIER_REAPPLY_STATUS_ATTR)!;
    expect(status.getAttribute('data-kind')).toBe('success');
    expect(textOf(status)).toContain('Done. 1 re-applied, 1 left alone.');
    mount.dispose();
  });

  it('D-309: re-applies to the ones ticked, and a choice changed after the preview asks for a new one', async () => {
    const host = makeFakeElement('div');
    const base = overview();
    const runReapplyManualTier: SellerManualTierReapplyCaller = vi.fn(async (request) => ({
      tier: base.tiers[0]!,
      preview: request.preview ?? false,
      customers: [reapplyRow(), reapplyRow({ customer_id: 'customer-2', label: 'bea@example.com' })],
      overview: base,
    }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'detail', subpage: 'tiers', itemId: 'tier-1', tab: 'customers' },
      runGetOverview: async () => base,
      runReapplyManualTier,
    });
    await mount.whenLoaded();
    const who = reapplyField(host, 'who');
    who.value = 'picked';
    fireChange(who);
    findByAttr(host, SELLER_TIER_REAPPLY_PREVIEW_ATTR)?.click();
    await flushAsync();

    // Picking previews every open customer of the package AS picked, so each row
    // shows what happens if it is ticked (one whose access ended included).
    expect(runReapplyManualTier).toHaveBeenCalledWith({
      tier_id: 'tier-1', apply: { permissions: true, length: true }, who: 'picked',
      customer_ids: ['customer-1'], preview: true,
    });
    const submit = findByAttr(host, SELLER_TIER_REAPPLY_SUBMIT_ATTR)!;
    expect(submit.textContent).toBe('Re-apply to 0 customers');
    expect(submit.disabled).toBe(true);
    const pick = findByAttr(host, SELLER_TIER_REAPPLY_PICK_ATTR, 'customer-2')!;
    pick.checked = true;
    fireChange(pick);
    expect(submit.textContent).toBe('Re-apply to 1 customer');

    submit.click();
    await flushAsync();
    expect(runReapplyManualTier).toHaveBeenLastCalledWith({
      tier_id: 'tier-1', apply: { permissions: true, length: true }, who: 'picked',
      customer_ids: ['customer-2'], preview: false,
    });

    // After the re-render, preview again, then change what is re-applied.
    findByAttr(host, SELLER_TIER_REAPPLY_PREVIEW_ATTR)?.click();
    await flushAsync();
    expect(findAllByAttr(host, SELLER_TIER_REAPPLY_ROW_ATTR)).toHaveLength(2);
    const permissions = reapplyField(host, 'permissions');
    permissions.checked = false;
    fireChange(permissions);
    expect(findAllByAttr(host, SELLER_TIER_REAPPLY_ROW_ATTR)).toHaveLength(0);
    expect(findByAttr(host, SELLER_TIER_REAPPLY_SUBMIT_ATTR)!.disabled).toBe(true);
    expect(textOf(findByAttr(host, SELLER_TIER_REAPPLY_STATUS_ATTR)!))
      .toContain('You changed a choice. Preview again before re-applying.');
    mount.dispose();
  });

  it('D-309: a choice changed while the preview loads is never applied unpreviewed', async () => {
    // Integrity audit, 2026-09-24: the preview took its key from the form when the
    // answer LANDED, so a choice changed meanwhile passed as previewed.
    const host = makeFakeElement('div');
    const base = overview();
    let answer: ((value: SellerManualTierReapplyResponse) => void) | undefined;
    const runReapplyManualTier: SellerManualTierReapplyCaller = vi.fn((request) => request.preview
      ? new Promise<SellerManualTierReapplyResponse>((resolve) => { answer = resolve; })
      : Promise.resolve({ tier: base.tiers[0]!, preview: false, customers: [reapplyRow()], overview: base }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'detail', subpage: 'tiers', itemId: 'tier-1', tab: 'customers' },
      runGetOverview: async () => base,
      runReapplyManualTier,
    });
    await mount.whenLoaded();
    const who = reapplyField(host, 'who');
    who.value = 'unchanged';
    fireChange(who);
    findByAttr(host, SELLER_TIER_REAPPLY_PREVIEW_ATTR)?.click();
    await flushAsync();
    // While it loads, the owner switches to everyone…
    who.value = 'everyone';
    fireChange(who);
    answer!({ tier: base.tiers[0]!, preview: true, customers: [reapplyRow()], overview: base });
    await flushAsync();
    // …so the "unchanged" answer is dropped, and nothing can be re-applied.
    expect(findAllByAttr(host, SELLER_TIER_REAPPLY_ROW_ATTR)).toHaveLength(0);
    expect(textOf(findByAttr(host, SELLER_TIER_REAPPLY_STATUS_ATTR)!))
      .toContain('You changed a choice. Preview again before re-applying.');
    const submit = findByAttr(host, SELLER_TIER_REAPPLY_SUBMIT_ATTR)!;
    submit.click();
    await flushAsync();
    expect(runReapplyManualTier).not.toHaveBeenCalledWith(expect.objectContaining({ preview: false }));
    mount.dispose();
  });

  it('D-309: a customer whose access already ended is shown as left alone', async () => {
    const host = makeFakeElement('div');
    const base = overview();
    const lapsed = reapplyRow({
      customer_id: 'customer-2', label: 'gone@example.com', included: false, skipped: 'lapsed',
      end_after: 1_701_000_000_000,
    });
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'detail', subpage: 'tiers', itemId: 'tier-1', tab: 'customers' },
      runGetOverview: async () => base,
      runReapplyManualTier: async (request) => ({
        tier: base.tiers[0]!, preview: request.preview ?? false, customers: [reapplyRow(), lapsed], overview: base,
      }),
    });
    await mount.whenLoaded();
    findByAttr(host, SELLER_TIER_REAPPLY_PREVIEW_ATTR)?.click();
    await flushAsync();
    const row = textOf(findByAttr(host, SELLER_TIER_REAPPLY_ROW_ATTR, 'customer-2')!);
    expect(row).toContain('Access already ended, left alone');
    expect(row).toContain('Unchanged');
    mount.dispose();
  });

  it('D-309: asks the server nothing until something is chosen to re-apply', async () => {
    const host = makeFakeElement('div');
    const runReapplyManualTier = vi.fn<SellerManualTierReapplyCaller>();
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'detail', subpage: 'tiers', itemId: 'tier-1', tab: 'customers' },
      runGetOverview: async () => overview(),
      runReapplyManualTier,
    });
    await mount.whenLoaded();
    // A Re-apply before any preview is refused, even if the button were pressable.
    findByAttr(host, SELLER_TIER_REAPPLY_SUBMIT_ATTR)?.click();
    await flushAsync();
    expect(runReapplyManualTier).not.toHaveBeenCalled();
    expect(textOf(findByAttr(host, SELLER_TIER_REAPPLY_STATUS_ATTR)!))
      .toContain('Preview it first, so you can see what changes.');
    for (const field of ['permissions', 'length']) {
      const box = reapplyField(host, field);
      box.checked = false;
      fireChange(box);
    }
    findByAttr(host, SELLER_TIER_REAPPLY_PREVIEW_ATTR)?.click();
    await flushAsync();
    expect(runReapplyManualTier).not.toHaveBeenCalled();
    const status = findByAttr(host, SELLER_TIER_REAPPLY_STATUS_ATTR)!;
    expect(status.getAttribute('role')).toBe('alert');
    expect(textOf(status)).toContain('Choose its permissions, its length, or both.');
    mount.dispose();
  });

  it('D-309: a package\'s tab re-applies that package only, and says when a pass would end now', async () => {
    // Live 2026-09-24: the tab offered a package picker, so from under one package
    // the owner could re-apply another. And a pass whose length had run out showed
    // its new end as a timestamp of that very minute, which does not read as "ends now".
    const base = overview();
    const second = { ...base.tiers[0]!, tier_id: 'tier-2', display_name: 'Consulting Plus' };
    const twoPackages = overview({ tiers: [base.tiers[0]!, second] });
    const month = 2_592_000_000;
    const lapsed = reapplyRow({
      customer_id: 'customer-2', label: 'lapsed@example.com',
      started_at: 1_690_000_000_000, end_before: null, end_after: 1_700_000_000_000,
    });
    const same = reapplyRow({
      customer_id: 'customer-3', label: 'same@example.com',
      end_before: 1_700_000_000_000 + month, started_at: 1_700_000_000_000, end_after: 1_700_000_000_000 + month,
    });
    for (const tierId of ['tier-1', 'tier-2']) {
      const host = makeFakeElement('div');
      const runReapplyManualTier: SellerManualTierReapplyCaller = vi.fn(async (request) => ({
        tier: twoPackages.tiers.find((tier) => tier.tier_id === request.tier_id)!,
        preview: request.preview ?? false,
        customers: [reapplyRow(), lapsed, same],
        overview: twoPackages,
      }));
      const mount = mountSellerPage({
        host: host as unknown as HTMLElement,
        document: makeFakeDocument() as unknown as Document,
        initialAddress: { kind: 'detail', subpage: 'tiers', itemId: tierId, tab: 'customers' },
        runGetOverview: async () => twoPackages,
        runReapplyManualTier,
      });
      await mount.whenLoaded();
      expect(findByAttr(host, SELLER_TIER_REAPPLY_FIELD_ATTR, 'tier_id')).toBeNull();
      findByAttr(host, SELLER_TIER_REAPPLY_PREVIEW_ATTR)?.click();
      await flushAsync();
      expect(runReapplyManualTier).toHaveBeenCalledWith(expect.objectContaining({ tier_id: tierId }));

      const form = textOf(findByAttr(host, SELLER_TIER_REAPPLY_FORM_ATTR)!);
      expect(form).toContain('Current end');
      expect(form).toContain('After re-applying');
      expect(form).not.toContain('Ends now');
      const row = (id: string) => textOf(findByAttr(host, SELLER_TIER_REAPPLY_ROW_ATTR, id)!);
      expect(row('customer-2')).toContain('Now, then 72h grace');
      expect(row('customer-3')).toContain('Unchanged');
      // A new end inside the package's length is a date, neither of the above.
      expect(row('customer-1')).not.toMatch(/Now, then|Unchanged/);
      mount.dispose();
    }
  });

  it('D-309: a server from before re-applying is named as out of date, not by its rpc error', async () => {
    // The webclient ships separately from the server, so a new webclient paired
    // to 26.9.21 is expected until the owner updates. Its raw error named the rpc
    // method, and the old bulk form it replaced is gone from this webclient.
    const tooOld = async (): Promise<never> => {
      throw { code: 'unknown_method', message: 'Unknown rpc method: server.seller.reapplyManualTier' };
    };
    const update = 'This server can’t re-apply a package yet. Update the server, then try again.';

    const packageHost = makeFakeElement('div');
    const packageMount = mountSellerPage({
      host: packageHost as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'detail', subpage: 'tiers', itemId: 'tier-1', tab: 'customers' },
      runGetOverview: async () => overview(),
      runReapplyManualTier: tooOld,
    });
    await packageMount.whenLoaded();
    findByAttr(packageHost, SELLER_TIER_REAPPLY_PREVIEW_ATTR)?.click();
    await flushAsync();
    const status = findByAttr(packageHost, SELLER_TIER_REAPPLY_STATUS_ATTR)!;
    expect(textOf(status)).toBe(update);
    expect(status.getAttribute('role')).toBe('alert');
    expect(findByAttr(packageHost, SELLER_TIER_REAPPLY_SUBMIT_ATTR)!.disabled).toBe(true);
    packageMount.dispose();

    const customerHost = makeFakeElement('div');
    const customerMount = mountSellerPage({
      host: customerHost as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'detail', subpage: 'customers', itemId: 'customer-1' },
      runGetOverview: async () => overview(),
      runReapplyManualTier: tooOld,
    });
    await customerMount.whenLoaded();
    findByAttr(customerHost, SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'reapply.preview')?.click();
    await flushAsync();
    expect(textOf(findByAttr(customerHost, SELLER_CUSTOMER_LIFECYCLE_STATUS_ATTR)!)).toBe(update);
    expect(findByAttr(customerHost, SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'reapply')!.disabled).toBe(true);
    customerMount.dispose();
  });

  it('D-309: re-applies one customer\'s package from their page, previewed first', async () => {
    const host = makeFakeElement('div');
    const base = overview();
    const runReapplyManualTier: SellerManualTierReapplyCaller = vi.fn(async (request) => ({
      tier: base.tiers[0]!,
      preview: request.preview ?? false,
      customers: [reapplyRow({ changed_by_hand: { end_date: true, permissions: true } })],
      overview: base,
    }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'detail', subpage: 'customers', itemId: 'customer-1' },
      runGetOverview: async () => base,
      runReapplyManualTier,
    });
    await mount.whenLoaded();
    const reapply = findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'reapply')!;
    expect(reapply.disabled).toBe(true);
    // Refused before a preview, even if the button were pressable.
    reapply.click();
    await flushAsync();
    expect(runReapplyManualTier).not.toHaveBeenCalled();

    findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'reapply.preview')?.click();
    await flushAsync();
    const asked = {
      tier_id: 'tier-1', apply: { permissions: true, length: true }, who: 'picked',
      customer_ids: ['customer-1'],
    };
    expect(runReapplyManualTier).toHaveBeenCalledWith({ ...asked, preview: true });
    const line = textOf(findByAttr(host, SELLER_CUSTOMER_REAPPLY_PREVIEW_ATTR)!);
    expect(line).toContain('Current end: ');
    expect(line).toContain('After re-applying: ');
    expect(line).not.toContain('Ends now');
    expect(line).toContain('Someone set their end date by hand; this replaces it.');
    expect(line).toContain('Their permissions were changed by hand; they go back to the package’s own.');
    expect(reapply.disabled).toBe(false);

    reapply.click();
    await flushAsync();
    expect(runReapplyManualTier).toHaveBeenLastCalledWith({ ...asked, preview: false });
    const status = findByAttr(host, SELLER_CUSTOMER_LIFECYCLE_STATUS_ATTR)!;
    expect(status.getAttribute('data-kind')).toBe('success');
    expect(textOf(status)).toContain('Their package is re-applied.');
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
      initialAddress: { kind: 'create', subpage: 'customers', variant: 'manual' },
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
    expect(textOf(status!)).toContain('The email is on its way.');
    expect(textOf(status!)).toContain(
      'Their one-off link: https://seller.example/reception/claim?t=short-lived-claim',
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
      initialAddress: { kind: 'create', subpage: 'customers', variant: 'manual' },
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
      'Recued could not send the email (MAIL_SEND_NETWORK_FAILED); deliver the link manually.',
    );
    expect(textOf(status!)).toContain(
      'Their one-off link: https://seller.example/reception/claim?t=failed-mail-claim',
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
      ['extend.customer_id', 'Who to give longer'],
      ['extend.email', 'Extension email'],
      ['extend.current_period_end', 'New end time'],
      ['extend.source_status', 'Extension source status'],
      ['swap.customer_id', 'Who to move'],
      ['swap.entitlement_key', 'Swap what it unlocks'],
      ['swap.current_period_end', 'New end time'],
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
      .toContain('Their access now lasts longer.');
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
      .toContain('They are on the new package.');

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
        'Customer token reissued. Their one-off link: https://seller.example/reception/claim?t=reissued-short-lived-claim',
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
      initialAddress: { kind: 'create', subpage: 'tiers', variant: 'manual' },
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
    expect(textOf(status!)).toContain('The usage rules have to be a JSON object.');
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

describe('D-196 consolidation — ONE provider tier synchronization form', () => {
  const withProviders = (
    states: Partial<Record<'stripe' | 'paddle' | 'lemonsqueezy', 'ready' | 'needs_setup'>>,
  ): SellerOverview => overview({
    readiness: [
      ...overview().readiness,
      { key: 'stripe_provider', state: states.stripe ?? 'needs_setup', label: 'Stripe provider', detail: 'Install and enroll Stripe first.', href: '#connections' },
      { key: 'paddle_provider', state: states.paddle ?? 'needs_setup', label: 'Paddle provider', detail: 'Install and enroll Paddle first.', href: '#connections' },
      { key: 'lemonsqueezy_provider', state: states.lemonsqueezy ?? 'needs_setup', label: 'Lemon Squeezy provider', detail: 'Install and enroll Lemon Squeezy first.', href: '#connections' },
    ],
  });
  const tierResponse = (refreshed: SellerOverview, provider: 'stripe' | 'paddle' | 'lemonsqueezy', ids: string[]) => ({
    provider, connection_name: `${provider}-main`, records_seen: ids.length,
    created_tier_ids: ids, preserved_tier_ids: [], recreated_template_tier_ids: [], reactivated_tier_ids: [], orphaned_tier_ids: [],
    overview: refreshed,
  });
  const mountWith = (opts: {
    initial: SellerOverview;
    runSynchronizeProviderTiers?: SellerProviderTierSynchronizeCaller;
    runSynchronizeStripeEntitlements?: SellerStripeSynchronizeCaller;
  }) => {
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'setup', section: 'providers' },
      runGetOverview: async () => opts.initial,
      ...(opts.runSynchronizeProviderTiers ? { runSynchronizeProviderTiers: opts.runSynchronizeProviderTiers } : {}),
      ...(opts.runSynchronizeStripeEntitlements ? { runSynchronizeStripeEntitlements: opts.runSynchronizeStripeEntitlements } : {}),
    });
    const field = (name: string): FakeElement => {
      const el = findByAttr(host, SELLER_PROVIDER_TIER_SYNC_FIELD_ATTR, name);
      if (el === null) throw new Error(`missing tier sync field ${name}`);
      return el;
    };
    const choose = (provider: string): void => {
      field('provider').value = provider;
      for (const fn of field('provider').listeners.get('change') ?? []) fn({ target: field('provider') });
    };
    const submit = () => findByAttr(host, SELLER_PROVIDER_TIER_SYNC_SUBMIT_ATTR);
    const statusText = () => textOf(findByAttr(host, SELLER_PROVIDER_TIER_SYNC_STATUS_ATTR)!);
    return { host, mount, field, choose, submit, statusText };
  };

  it('seeds Stripe through the unified rpc and renders the refreshed overview', async () => {
    const initial = withProviders({ stripe: 'ready' });
    const refreshed = overview({ ...initial, counts: { ...initial.counts, tiers: 3, active_tiers: 3 } });
    const runSynchronizeProviderTiers = vi.fn<SellerProviderTierSynchronizeCaller>(
      async () => tierResponse(refreshed, 'stripe', ['tier-stripe-basic', 'tier-stripe-pro']),
    );
    const runSynchronizeStripeEntitlements = vi.fn<SellerStripeSynchronizeCaller>();
    const t = mountWith({ initial, runSynchronizeProviderTiers, runSynchronizeStripeEntitlements });
    await t.mount.whenLoaded();

    expect(findByAttr(t.host, SELLER_PROVIDER_TIER_SYNC_FORM_ATTR)).not.toBeNull();
    t.choose('stripe');
    t.field('connection_name').value = 'stripe-main';
    t.field('door_id').value = 'door-llm';
    t.field('door_type').value = 'llm_gateway';
    t.submit()?.click();
    await flushAsync();

    expect(runSynchronizeProviderTiers).toHaveBeenCalledWith({
      provider: 'stripe', connection_name: 'stripe-main', door_id: 'door-llm', door_type: 'llm_gateway',
    });
    expect(runSynchronizeStripeEntitlements).not.toHaveBeenCalled();
    expect(t.statusText()).toContain('Synchronized 2 Stripe features: 2 created');
    expect(t.mount.getState().overview?.counts.tiers).toBe(3);
  });

  it('falls back to the shipped Stripe-only rpc when the paired server does not know the unified one', async () => {
    const initial = withProviders({ stripe: 'ready' });
    const refreshed = overview({ ...initial, counts: { ...initial.counts, tiers: 2 } });
    const runSynchronizeProviderTiers = vi.fn<SellerProviderTierSynchronizeCaller>(async () => {
      throw { code: 'unknown_method', message: 'Unknown rpc method: server.seller.synchronizeProviderTiers' };
    });
    const runSynchronizeStripeEntitlements = vi.fn<SellerStripeSynchronizeCaller>(async () => ({
      connection_name: 'stripe-main', features_seen: 1,
      created_tier_ids: ['tier-stripe-basic'], preserved_tier_ids: [], recreated_template_tier_ids: [], reactivated_tier_ids: [], orphaned_tier_ids: [],
      overview: refreshed,
    }));
    const t = mountWith({ initial, runSynchronizeProviderTiers, runSynchronizeStripeEntitlements });
    await t.mount.whenLoaded();
    t.choose('stripe');
    t.field('door_id').value = 'door-mcp';
    t.field('door_type').value = 'mcp';
    t.submit()?.click();
    // Two rpc hops (the refused unified call, then the alias) — flush twice.
    await flushAsync();
    await flushAsync();

    expect(runSynchronizeStripeEntitlements).toHaveBeenCalledWith({ door_id: 'door-mcp', door_type: 'mcp' });
    expect(t.statusText()).toContain('Synchronized 1 Stripe feature: 1 created');
    expect(t.mount.getState().overview?.counts.tiers).toBe(2);
  });

  it('on a legacy-only host Stripe seeds through the alias and the other providers say they need a newer server', async () => {
    const initial = withProviders({ stripe: 'ready', paddle: 'ready' });
    const runSynchronizeStripeEntitlements = vi.fn<SellerStripeSynchronizeCaller>(async () => ({
      connection_name: 'stripe-main', features_seen: 1,
      created_tier_ids: ['tier-stripe-basic'], preserved_tier_ids: [], recreated_template_tier_ids: [], reactivated_tier_ids: [], orphaned_tier_ids: [],
      overview: initial,
    }));
    const t = mountWith({ initial, runSynchronizeStripeEntitlements });
    await t.mount.whenLoaded();
    t.choose('paddle');
    expect(t.submit()?.disabled).toBe(true);
    expect(t.statusText()).toContain('Paddle needs a newer server to bring things in.');
    t.choose('stripe');
    expect(t.submit()?.disabled).toBe(false);
    t.field('door_id').value = 'door-mcp';
    t.field('door_type').value = 'mcp';
    t.submit()?.click();
    await flushAsync();
    expect(runSynchronizeStripeEntitlements).toHaveBeenCalledWith({ door_id: 'door-mcp', door_type: 'mcp' });
  });

  it('stays disabled until the SELECTED provider is ready, and shows that provider\'s readiness detail', async () => {
    const runSynchronizeProviderTiers = vi.fn<SellerProviderTierSynchronizeCaller>();
    const t = mountWith({ initial: withProviders({ lemonsqueezy: 'ready' }), runSynchronizeProviderTiers });
    await t.mount.whenLoaded();
    t.choose('stripe');
    expect(t.submit()?.disabled).toBe(true);
    expect(t.statusText()).toContain('Install and enroll Stripe first.');
    t.submit()?.click();
    await flushAsync();
    expect(runSynchronizeProviderTiers).not.toHaveBeenCalled();
    t.choose('lemonsqueezy');
    expect(t.submit()?.disabled).toBe(false);
  });

  it('renders validation errors without invoking the provider', async () => {
    const runSynchronizeProviderTiers = vi.fn<SellerProviderTierSynchronizeCaller>();
    const t = mountWith({ initial: withProviders({ stripe: 'ready' }), runSynchronizeProviderTiers });
    await t.mount.whenLoaded();
    t.choose('stripe');
    // The category defaults, so clear it to reach the validation path.
    t.field('door_id').value = '';
    t.submit()?.click();
    await flushAsync();
    expect(runSynchronizeProviderTiers).not.toHaveBeenCalled();
    expect(t.submit()?.disabled).toBe(false);
    expect(t.statusText()).toContain('Category is required');
  });

  it('sends the default category when the owner never opens Advanced', async () => {
    const initial = withProviders({ paddle: 'ready' });
    const runSynchronizeProviderTiers = vi.fn<SellerProviderTierSynchronizeCaller>(
      async (request) => tierResponse(initial, request.provider, ['tier-1']),
    );
    const t = mountWith({ initial, runSynchronizeProviderTiers });
    await t.mount.whenLoaded();
    t.choose('paddle');
    t.field('door_type').value = 'mcp';
    t.submit()?.click();
    await flushAsync();
    expect(runSynchronizeProviderTiers).toHaveBeenCalledWith({
      provider: 'paddle', door_id: SELLER_DEFAULT_DOOR_ID, door_type: 'mcp',
    });
  });

  it('a Lemon Squeezy seed carries the store id; a Paddle seed carries none', async () => {
    const initial = withProviders({ paddle: 'ready', lemonsqueezy: 'ready' });
    const runSynchronizeProviderTiers = vi.fn<SellerProviderTierSynchronizeCaller>(
      async (request) => tierResponse(initial, request.provider, ['tier-1', 'tier-2']),
    );
    const t = mountWith({ initial, runSynchronizeProviderTiers });
    await t.mount.whenLoaded();
    t.choose('lemonsqueezy');
    t.field('store_id').value = '4242';
    t.field('connection_name').value = 'ls-main';
    t.field('door_id').value = 'door-mcp';
    t.field('door_type').value = 'mcp';
    t.submit()?.click();
    await flushAsync();
    expect(runSynchronizeProviderTiers).toHaveBeenCalledWith({
      provider: 'lemonsqueezy', connection_name: 'ls-main', door_id: 'door-mcp', door_type: 'mcp', store_id: '4242',
    });
    expect(t.statusText()).toContain('Synchronized 2 Lemon Squeezy products: 2 created');

    const t2 = mountWith({ initial, runSynchronizeProviderTiers });
    await t2.mount.whenLoaded();
    t2.choose('paddle');
    t2.field('store_id').value = '4242';
    t2.field('door_id').value = 'door-mcp';
    t2.field('door_type').value = 'mcp';
    t2.submit()?.click();
    await flushAsync();
    expect(runSynchronizeProviderTiers).toHaveBeenLastCalledWith({ provider: 'paddle', door_id: 'door-mcp', door_type: 'mcp' });
  });
});

describe('Seller polish (2026-09-03) — separate screens, every level addressable', () => {
  const syncedTier = () => ({
    ...overview().tiers[0]!,
    tier_id: 'tier-stripe',
    lifecycle_source: 'stripe' as const,
    entitlement_key: 'pro',
    display_name: 'Pro',
    external_entitlement_id: 'feat_pro',
    usage_policy_json: {},
  });
  const mountAt = (
    address: Parameters<typeof mountSellerPage>[0]['initialAddress'],
    extra: Partial<Parameters<typeof mountSellerPage>[0]> = {},
    current: SellerOverview = overview(),
  ) => {
    const host = makeFakeElement('div');
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: address,
      runGetOverview: async () => current,
      ...extra,
    });
    return { host, mount };
  };
  const hrefsOf = (host: FakeElement, attr: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const el of findAllByAttr(host, attr)) {
      out[el.getAttribute(attr) ?? ''] = el.getAttribute('href') ?? '';
    }
    return out;
  };

  it('a record screen carries a breadcrumb of real addresses and a strip to every section', async () => {
    const { host, mount } = mountAt({ kind: 'detail', subpage: 'tiers', itemId: 'tier-1' });
    await mount.whenLoaded();
    expect(hrefsOf(host, SELLER_BREADCRUMB_LINK_ATTR)).toEqual({
      seller: '#settings/seller',
      'section:tiers': '#settings/seller/tiers',
    });
    // Back is the nearest ancestor, named.
    expect(findByAttr(host, SELLER_BACK_ATTR)?.getAttribute('href')).toBe('#settings/seller/tiers');
    const subnav = hrefsOf(host, SELLER_SUBNAV_LINK_ATTR);
    expect(Object.keys(subnav)).toEqual(['overview', 'offers', 'orders', 'tiers', 'customers', 'usage', 'setup']);
    expect(subnav.setup).toBe('#settings/seller/setup');
    expect(findByAttr(host, SELLER_SUBNAV_LINK_ATTR, 'tiers')?.getAttribute('aria-current')).toBe('page');
    expect(findByAttr(host, SELLER_SUBNAV_LINK_ATTR, 'orders')?.getAttribute('aria-current')).toBeNull();
    mount.dispose();
  });

  it('a tier record offers its edit and customers screens as addressed tabs only when they apply', async () => {
    const manual = mountAt(
      { kind: 'detail', subpage: 'tiers', itemId: 'tier-1', tab: 'edit' },
      { runUpsertManualTier: vi.fn(), runReapplyManualTier: vi.fn() },
    );
    await manual.mount.whenLoaded();
    expect(hrefsOf(manual.host, SELLER_DETAIL_TAB_ATTR)).toEqual({
      record: '#settings/seller/tiers/detail/tier-1',
      edit: '#settings/seller/tiers/detail/tier-1/edit',
      customers: '#settings/seller/tiers/detail/tier-1/customers',
    });
    expect(findByAttr(manual.host, SELLER_DETAIL_TAB_ATTR, 'edit')?.getAttribute('aria-current')).toBe('page');
    // The edit tab IS the metadata form, prefilled from the record.
    expect(findByAttr(manual.host, SELLER_TIER_FORM_FIELD_ATTR, 'tier_id')?.value).toBe('tier-1');
    // The trail names the record and the tab; Back is the record.
    expect(hrefsOf(manual.host, SELLER_BREADCRUMB_LINK_ATTR)['detail:tier-1']).toBe('#settings/seller/tiers/detail/tier-1');
    expect(findByAttr(manual.host, SELLER_BACK_ATTR)?.getAttribute('href')).toBe('#settings/seller/tiers/detail/tier-1');
    manual.mount.dispose();

    // A provider-synchronized tier has one screen: nothing to edit by hand.
    const synced = mountAt(
      { kind: 'detail', subpage: 'tiers', itemId: 'tier-stripe' },
      { runUpsertManualTier: vi.fn(), runReapplyManualTier: vi.fn() },
      overview({ tiers: [syncedTier()] }),
    );
    await synced.mount.whenLoaded();
    expect(Object.keys(hrefsOf(synced.host, SELLER_DETAIL_TAB_ATTR))).toEqual(['record']);
    synced.mount.dispose();
  });

  it('lists offer "new" links only for the screens the paired server can serve', async () => {
    const wired = mountAt({ kind: 'list', subpage: 'tiers', page: 1 }, {
      runUpsertManualTier: vi.fn(),
      runCreatePassTier: vi.fn(),
    });
    await wired.mount.whenLoaded();
    expect(hrefsOf(wired.host, SELLER_CREATE_LINK_ATTR)).toEqual({
      'tiers:manual': '#settings/seller/tiers/new',
      'tiers:pass': '#settings/seller/tiers/new/pass',
    });
    // The forms themselves are no longer on the list.
    expect(findByAttr(wired.host, SELLER_TIER_FORM_ATTR)).toBeNull();
    expect(findByAttr(wired.host, SELLER_PASS_TIER_FORM_ATTR)).toBeNull();
    wired.mount.dispose();

    const narrowed = mountAt({ kind: 'list', subpage: 'tiers', page: 1 });
    await narrowed.mount.whenLoaded();
    expect(findByAttr(narrowed.host, SELLER_LIST_TOOLBAR_ATTR)).toBeNull();
    narrowed.mount.dispose();

    const customers = mountAt({ kind: 'list', subpage: 'customers', page: 1 }, { runIssueManualCustomer: vi.fn() });
    await customers.mount.whenLoaded();
    expect(hrefsOf(customers.host, SELLER_CREATE_LINK_ATTR)).toEqual({ 'customers:manual': '#settings/seller/customers/new' });
    customers.mount.dispose();
  });

  it('a create screen without its rpc says so instead of rendering a dead form', async () => {
    const { host, mount } = mountAt({ kind: 'create', subpage: 'customers', variant: 'manual' });
    await mount.whenLoaded();
    expect(findByAttr(host, SELLER_CUSTOMER_FORM_ATTR)).toBeNull();
    expect(textOf(host)).toContain('You cannot give one out now');
    expect(findByAttr(host, SELLER_BACK_ATTR)?.getAttribute('href')).toBe('#settings/seller/customers');
    mount.dispose();
  });

  it('the setup screen is a directory of three addressed areas with their live state', async () => {
    const current = overview({
      readiness: [
        ...overview().readiness,
        { key: 'paddle_provider', state: 'ready', label: 'Paddle provider', detail: '1 ready', href: null },
      ],
    });
    const { host, mount } = mountAt({ kind: 'list', subpage: 'setup', page: 1 }, {}, current);
    await mount.whenLoaded();
    expect(findByAttr(host, SELLER_SETUP_DIRECTORY_ATTR)).not.toBeNull();
    expect(hrefsOf(host, SELLER_SETUP_ROW_ATTR)).toEqual({
      defaults: '#settings/seller/setup/defaults',
      providers: '#settings/seller/setup/providers',
      gateway: '#settings/seller/setup/gateway',
    });
    expect(textOf(findByAttr(host, SELLER_SETUP_ROW_ATTR, 'providers')!)).toContain('1 of 3 providers ready');
    // None of the forms render on the directory itself.
    expect(findByAttr(host, SELLER_SETTINGS_FORM_ATTR)).toBeNull();
    expect(findByAttr(host, SELLER_PROVIDER_TIER_SYNC_FORM_ATTR)).toBeNull();
    expect(findByAttr(host, SELLER_LLM_GATEWAY_ATTR)).toBeNull();
    mount.dispose();
  });

  it('each setup area renders only itself, under its own breadcrumb', async () => {
    const gateway = mountAt({ kind: 'setup', section: 'gateway' });
    await gateway.mount.whenLoaded();
    expect(findByAttr(gateway.host, SELLER_LLM_GATEWAY_ATTR)).not.toBeNull();
    expect(findByAttr(gateway.host, SELLER_SETTINGS_ATTR)).toBeNull();
    expect(findByAttr(gateway.host, SELLER_SETUP_SECTION_ATTR)?.getAttribute(SELLER_SETUP_SECTION_ATTR)).toBe('gateway');
    expect(hrefsOf(gateway.host, SELLER_BREADCRUMB_LINK_ATTR)).toEqual({
      seller: '#settings/seller',
      'section:setup': '#settings/seller/setup',
    });
    expect(findByAttr(gateway.host, SELLER_BACK_ATTR)?.getAttribute('href')).toBe('#settings/seller/setup');
    gateway.mount.dispose();

    const defaults = mountAt({ kind: 'setup', section: 'defaults' });
    await defaults.mount.whenLoaded();
    expect(findByAttr(defaults.host, SELLER_SETTINGS_ATTR)).not.toBeNull();
    expect(findByAttr(defaults.host, SELLER_LLM_GATEWAY_ATTR)).toBeNull();
    defaults.mount.dispose();
  });

  it('a provider deep link opens the tier seed with that provider chosen, and the trail names it', async () => {
    const current = overview({
      readiness: [
        ...overview().readiness,
        { key: 'lemonsqueezy_provider', state: 'ready', label: 'Lemon Squeezy provider', detail: 'ready', href: null },
      ],
    });
    const runSynchronizeProviderTiers = vi.fn<SellerProviderTierSynchronizeCaller>();
    const { host, mount } = mountAt(
      { kind: 'setup', section: 'providers', provider: 'lemonsqueezy' },
      { runSynchronizeProviderTiers },
      current,
    );
    await mount.whenLoaded();
    expect(findByAttr(host, SELLER_PROVIDER_TIER_SYNC_FIELD_ATTR, 'provider')?.value).toBe('lemonsqueezy');
    // Chosen AND ready: the button is live for that provider straight away.
    expect(findByAttr(host, SELLER_PROVIDER_TIER_SYNC_SUBMIT_ATTR)?.disabled).toBe(false);
    expect(hrefsOf(host, SELLER_BREADCRUMB_LINK_ATTR)['setup:providers']).toBe('#settings/seller/setup/providers');
    expect(findByAttr(host, SELLER_BACK_ATTR)?.getAttribute('href')).toBe('#settings/seller/setup/providers');
    mount.dispose();
  });

  it('overview readiness rows link into the setup screen that acts on them', async () => {
    const current = overview({
      readiness: [
        ...overview().readiness,
        { key: 'paddle_provider', state: 'needs_setup', label: 'Paddle provider', detail: 'Install and enroll Paddle first.', href: '#connections' },
        { key: 'llm_gateway', state: 'needs_setup', label: 'LLM gateway route', detail: 'Configure a route.', href: null },
      ],
    });
    const { host, mount } = mountAt({ kind: 'list', subpage: 'overview', page: 1 }, {}, current);
    await mount.whenLoaded();
    const links = hrefsOf(host, SELLER_READINESS_SETUP_LINK_ATTR);
    expect(links.paddle_provider).toBe('#settings/seller/setup/providers/paddle');
    expect(links.llm_gateway).toBe('#settings/seller/setup/gateway');
    expect(links.mail_sender).toBe('#settings/seller/setup/defaults');
    // The provider's own Configure link (to Connections) is kept beside it.
    expect(textOf(findByAttr(host, SELLER_READINESS_ROW_ATTR, 'paddle_provider')!)).toContain('Configure');
    mount.dispose();
  });

  it('a create screen is not a list: no list continuity is restored onto it', async () => {
    const { host, mount } = mountAt({ kind: 'create', subpage: 'tiers', variant: 'manual' }, { runUpsertManualTier: vi.fn() });
    await mount.whenLoaded();
    expect(mount.getState()).toMatchObject({ subpage: 'tiers', selectedItemId: null, create: 'manual', tab: null });
    expect(findByAttr(host, SELLER_CREATE_PAGE_ATTR)?.getAttribute(SELLER_CREATE_PAGE_ATTR)).toBe('tiers:manual');
    expect(findByAttr(host, SELLER_TIER_FORM_ATTR)).not.toBeNull();
    expect(findByAttr(host, SELLER_PAGER_ATTR)).toBeNull();
    mount.dispose();
  });
});

describe('Seller polish — a create screen shows what it just made', () => {
  it('after a manual tier is created, its record card and link appear beneath the form', async () => {
    const host = makeFakeElement('div');
    const base = overview();
    const created = { ...base.tiers[0]!, tier_id: 'tier-new', display_name: 'Consulting New' };
    const runUpsertManualTier: SellerManualTierUpsertCaller = vi.fn(async () => ({
      tier: created,
      overview: overview({ tiers: [...base.tiers, created], counts: { ...base.counts, tiers: 2, active_tiers: 2 } }),
    }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'create', subpage: 'tiers', variant: 'manual' },
      runGetOverview: async () => base,
      runUpsertManualTier,
    });
    await mount.whenLoaded();
    expect(findByAttr(host, SELLER_TIER_ROW_ATTR)).toBeNull();
    const field = (name: string): FakeElement => findByAttr(host, SELLER_TIER_FORM_FIELD_ATTR, name)!;
    field('tier_id').value = 'tier-new';
    field('door_id').value = 'door-mcp';
    field('entitlement_key').value = 'new';
    field('display_name').value = 'Consulting New';
    field('template_contract_id').value = 'contract-template-1';
    findByAttr(host, SELLER_TIER_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();
    expect(runUpsertManualTier).toHaveBeenCalled();
    // Only the created record, linked to its own screen — not the whole list.
    expect(findAllByAttr(host, SELLER_TIER_ROW_ATTR)).toHaveLength(1);
    expect(findByAttr(host, SELLER_COLLECTION_ITEM_LINK_ATTR, 'tier-new')?.getAttribute('href'))
      .toBe('#settings/seller/tiers/detail/tier-new');
    expect(findByAttr(host, SELLER_PAGER_ATTR)).toBeNull();
    mount.dispose();
  });
});

describe('Seller category (2026-09-03) — door_id defaults, sits behind Advanced, follows the tier', () => {
  it('a manual tier is created under the default category without the owner naming one', async () => {
    const host = makeFakeElement('div');
    const base = overview().tiers[0]!;
    const created: SellerTier = { ...base, tier_id: 'tier-x', door_id: SELLER_DEFAULT_DOOR_ID, entitlement_key: 'x', display_name: 'X' };
    const runUpsertManualTier: SellerManualTierUpsertCaller = vi.fn(async () => ({
      tier: created,
      overview: overview({ tiers: [created] }),
    }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'create', subpage: 'tiers', variant: 'manual' },
      runGetOverview: async () => overview({ tiers: [] }),
      runUpsertManualTier,
    });
    await mount.whenLoaded();
    const field = (name: string): FakeElement => {
      const el = findByAttr(host, SELLER_TIER_FORM_FIELD_ATTR, name);
      if (el === null) throw new Error(`missing field ${name}`);
      return el;
    };
    // The category is prefilled and lives inside the Advanced disclosure, not the main grid.
    expect(field('door_id').value).toBe(SELLER_DEFAULT_DOOR_ID);
    expect(field('door_id').parent?.parent?.className).toContain('seller-advanced-settings');
    expect(textOf(host)).not.toContain('Door ID');
    field('tier_id').value = 'tier-x';
    field('entitlement_key').value = 'x';
    field('display_name').value = 'X';
    field('template_contract_id').value = 'contract-template-1';
    findByAttr(host, SELLER_TIER_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();
    expect(runUpsertManualTier).toHaveBeenCalledWith(expect.objectContaining({
      tier_id: 'tier-x',
      door_id: SELLER_DEFAULT_DOOR_ID,
    }));
    mount.dispose();
  });

  it('a pass tier is created under the default category too', async () => {
    const host = makeFakeElement('div');
    const base = overview().tiers[0]!;
    const passTier: SellerTier = { ...base, tier_id: 'tier-day', door_id: SELLER_DEFAULT_DOOR_ID, entitlement_key: 'day-pass', display_name: 'Day pass', pass_duration_seconds: 86_400 };
    const runCreatePassTier: SellerCreatePassTierCaller = vi.fn(
      async (): Promise<SellerCreatePassTierResponse> => ({
        tier: passTier,
        template_contract_id: 'contract-pass-template',
        overview: overview({ tiers: [passTier] }),
      }),
    );
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'create', subpage: 'tiers', variant: 'pass' },
      runGetOverview: async () => overview({ tiers: [] }),
      runCreatePassTier,
    });
    await mount.whenLoaded();
    const field = (name: string): FakeElement => {
      const el = findByAttr(host, SELLER_PASS_TIER_FORM_FIELD_ATTR, name);
      if (el === null) throw new Error(`missing pass-tier field ${name}`);
      return el;
    };
    expect(field('door_id').value).toBe(SELLER_DEFAULT_DOOR_ID);
    expect(textOf(host)).toContain('Access type');
    expect(textOf(host)).not.toContain('Door type');
    field('door_type').value = 'mcp';
    field('entitlement_key').value = 'day-pass';
    field('display_name').value = 'Day pass';
    field('pass_duration_seconds').value = '86400';
    findByAttr(host, SELLER_PASS_TIER_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();
    expect(runCreatePassTier).toHaveBeenCalledWith(expect.objectContaining({
      door_id: SELLER_DEFAULT_DOOR_ID,
      door_type: 'mcp',
      entitlement_key: 'day-pass',
    }));
    mount.dispose();
  });

  it('issuing a customer starts from a tier picker that fills the keys the rpc wants', async () => {
    const host = makeFakeElement('div');
    const base = overview().tiers[0]!;
    const pro: SellerTier = { ...base, tier_id: 'tier-2', entitlement_key: 'consulting-pro', display_name: 'Consulting Pro' };
    const runIssueManualCustomer: SellerManualCustomerIssueCaller = vi.fn(async () => ({
      result: 'extended' as const,
      customer: overview().customers[0]!,
      claim: null,
      claim_email_delivery: null,
      overview: overview({ tiers: [base, pro] }),
    }));
    const mount = mountSellerPage({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      initialAddress: { kind: 'create', subpage: 'customers', variant: 'manual' },
      runGetOverview: async () => overview({ tiers: [base, pro] }),
      runIssueManualCustomer,
    });
    await mount.whenLoaded();
    const field = (name: string): FakeElement => {
      const el = findByAttr(host, SELLER_CUSTOMER_FORM_FIELD_ATTR, name);
      if (el === null) throw new Error(`missing field ${name}`);
      return el;
    };
    const picker = field('tier');
    expect(picker.children.map((o) => o.value)).toEqual(['tier-1', 'tier-2']);
    // One category across the tiers, so the option text does not carry it.
    expect(textOf(picker)).toContain('Consulting Pro · consulting-pro');
    expect(textOf(picker)).not.toContain('door-mcp');
    // The raw keys follow the pick and stay behind Advanced.
    expect(field('entitlement_key').value).toBe('consulting-basic');
    picker.value = 'tier-2';
    for (const fn of picker.listeners.get('change') ?? []) fn({});
    expect(field('door_id').value).toBe('door-mcp');
    expect(field('entitlement_key').value).toBe('consulting-pro');
    expect(field('door_id').parent?.parent?.className).toContain('seller-advanced-settings');
    field('source_customer_id').value = 'cus-pro-1';
    findByAttr(host, SELLER_CUSTOMER_FORM_SUBMIT_ATTR)?.click();
    await flushAsync();
    expect(runIssueManualCustomer).toHaveBeenCalledWith({
      door_id: 'door-mcp',
      entitlement_key: 'consulting-pro',
      source_customer_id: 'cus-pro-1',
    });
    mount.dispose();
  });
});
