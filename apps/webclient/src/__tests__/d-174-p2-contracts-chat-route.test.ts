import { describe, expect, it, vi } from 'vitest';
import {
  type ChatMessage,
  type ChatModelRoutingLayer,
  type ChatSession,
  type ChatSessionSummary,
  type ContractDefinitionView,
} from '@recued/contracts';

import {
  bootstrapContractsRoute,
  buildMcpClientSnippets,
  CONTRACTS_ROUTE_ACTIVITY_LINK_ATTR,
  CONTRACTS_ROUTE_ANONYMOUS_ATTR,
  CONTRACTS_ROUTE_BACK_ATTR,
  CONTRACTS_ROUTE_BADGE_ATTR,
  CONTRACTS_ROUTE_CONNECT_HOST_ATTR,
  CONTRACTS_ROUTE_DETAIL_ATTR,
  CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR,
  CONTRACTS_ROUTE_ERROR_ATTR,
  CONTRACTS_ROUTE_HEADING_ATTR,
  CONTRACTS_ROUTE_LIST_ATTR,
  CONTRACTS_ROUTE_LIST_PANEL_ATTR,
  CONTRACTS_ROUTE_LIST_TAB_ATTR,
  CONTRACTS_ROUTE_NEW_BUTTON_ATTR,
  CONTRACTS_ROUTE_NEW_CAP_ATTR,
  CONTRACTS_ROUTE_NEW_DOOR_ATTR,
  CONTRACTS_ROUTE_NEW_ERROR_ATTR,
  CONTRACTS_ROUTE_NEW_FORM_ATTR,
  CONTRACTS_ROUTE_NEW_NAME_ATTR,
  CONTRACTS_ROUTE_NEW_SUBMIT_ATTR,
  CONTRACTS_ROUTE_NEW_TEMPLATE_BUTTON_ATTR,
  CONTRACTS_ROUTE_PAGE_NEXT_ATTR,
  CONTRACTS_ROUTE_PAGE_PREVIOUS_ATTR,
  CONTRACTS_ROUTE_PAGE_STATUS_ATTR,
  CONTRACTS_ROUTE_PILL_ATTR,
  CONTRACTS_ROUTE_ROW_ATTR,
  CONTRACTS_ROUTE_ROW_ID_ATTR,
  CONTRACTS_ROUTE_SNIPPET_ATTR,
  CONTRACTS_ROUTE_TAB_ATTR,
  CONTRACTS_ROUTE_TAB_BODY_ATTR,
  CONTRACTS_ROUTE_UNAVAILABLE_ATTR,
  mcpEndpointFromServerUrl,
} from '../contracts/bootstrap-contracts-route.js';
import type { PermissionsMintContractCaller } from '../settings/permissions-panel.js';
import type { ContractsListCaller } from '../contracts/contracts-panel.js';
import {
  bootstrapChatRoute,
  CHAT_ROUTE_ACTIVITY_ATTR,
  CHAT_ROUTE_ACTIVITY_ROW_ATTR,
  CHAT_ROUTE_ACTIVITY_TOGGLE_ATTR,
  CHAT_ROUTE_AI_UNAVAILABLE_ATTR,
  CHAT_ROUTE_AI_UNAVAILABLE_ID,
  CHAT_ROUTE_GREETING_ATTR,
  CHAT_ROUTE_HEADING_ATTR,
  CHAT_ROUTE_INPUT_ATTR,
  CHAT_ROUTE_MESSAGE_ATTR,
  CHAT_ROUTE_MODEL_CONFIGURE_ATTR,
  CHAT_ROUTE_MODEL_PICKER_ATTR,
  CHAT_ROUTE_NEW_SESSION_ATTR,
  CHAT_ROUTE_SEND_ATTR,
  CHAT_ROUTE_THREAD_ATTR,
  CHAT_ROUTE_TURN_FAILURE_ATTR,
  type ChatRouteConn,
} from '../chat/bootstrap-chat-route.js';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  checked: boolean;
  value: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
}

interface FakeDoc {
  styleElements: FakeEl[];
  head: { querySelector(sel: string): FakeEl | null; appendChild(el: FakeEl): FakeEl };
  createElement(tag: string): FakeEl;
}

const makeFakeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    checked: false,
    value: '',
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      const idx = el.children.indexOf(c);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      c.parent = null;
      return c;
    },
    remove() {
      if (el.parent === null) return;
      const idx = el.parent.children.indexOf(el);
      if (idx >= 0) el.parent.children.splice(idx, 1);
      el.parent = null;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    click() {
      if (el.disabled) return;
      for (const fn of el.listeners.get('click') ?? []) fn();
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDoc => {
  const styleElements: FakeEl[] = [];
  const matchSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  return {
    styleElements,
    head: {
      querySelector(sel) {
        const parsed = matchSelector(sel);
        if (parsed === null) return null;
        return (
          styleElements.find(
            (s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr),
          ) ?? null
        );
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeEl(tag),
  };
};

const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const child of root.children) collectByAttr(child, attr, out);
  return out;
};

const collectByTag = (root: FakeEl, tag: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.tagName === tag.toUpperCase()) out.push(root);
  for (const child of root.children) collectByTag(child, tag, out);
  return out;
};

const allText = (root: FakeEl): string =>
  [root.textContent, ...root.children.map((child) => allText(child))].join(' ');

const tick = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

describe('D-174 contracts route — list → detail shell', () => {
  const agentContract = (
    overrides: Partial<ContractDefinitionView> = {},
  ): ContractDefinitionView => ({
    contract_id: 'door_alpha',
    minted_at: 1_000,
    minted_by: 'user',
    display_name: 'Alpha agent',
    scope: {},
    lifecycle_state: 'active',
    ...overrides,
  });

  const mount = (
    opts: Omit<
      Parameters<typeof bootstrapContractsRoute>[0],
      'root' | 'document' | 'serverUrl'
    > = {},
  ) => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapContractsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      serverUrl: 'wss://alice.example/ws',
      ...opts,
    });
    return { doc, root, route };
  };

  it('defaults to addressable Built-in / Customer / Others tabs', async () => {
    const builtInContract = agentContract({
      contract_id: 'door_rcpt_1',
      display_name: 'Reception door — lead-capture',
      door_types: ['reception'],
      scope: { channels: ['reception'], actors: ['anonymous'] },
    });
    const contractsListCaller = vi.fn(async () => ({
      contracts: [builtInContract, agentContract()],
      total: 1,
      next_cursor: null,
    }));
    const { root, route } = mount({ contractsListCaller });
    await route.whenLoaded();

    expect(collectByAttr(root, CONTRACTS_ROUTE_HEADING_ATTR)[0]?.textContent).toBe(
      'Contracts',
    );
    expect(route.getViewMode()).toBe('list');
    expect(route.getListTab()).toBe('built-in');
    expect(contractsListCaller).toHaveBeenCalledWith({
      grant_kind: 'standing',
      derived_doors_only: true,
      limit: 25,
    });
    const tabs = collectByAttr(root, CONTRACTS_ROUTE_LIST_TAB_ATTR);
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Built-in', 'Customer', 'Others']);
    expect(tabs.map((tab) => tab.getAttribute('href'))).toEqual([
      '#contracts/view/built-in',
      '#contracts/view/customer',
      '#contracts/view/others',
    ]);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(
      collectByAttr(root, CONTRACTS_ROUTE_LIST_PANEL_ATTR)[0]?.getAttribute('data-tab'),
    ).toBe('built-in');

    const rows = collectByAttr(root, CONTRACTS_ROUTE_ROW_ATTR);
    expect(rows.map((row) => row.getAttribute(CONTRACTS_ROUTE_ROW_ID_ATTR))).toEqual([
      'user_self',
      'door_rcpt_1',
    ]);
    expect(rows[0]!.getAttribute('href')).toBe('#contracts/user_self');
    expect(rows[1]!.getAttribute('href')).toBe('#contracts/door_rcpt_1');
    expect(rows[1]!.getAttribute(CONTRACTS_ROUTE_ANONYMOUS_ATTR)).toBe('');
    expect(allText(rows[1]!)).toContain('capped by its granted ops');
    expect(collectByAttr(root, CONTRACTS_ROUTE_PAGE_STATUS_ATTR)[0]?.textContent)
      .toBe('Showing 1–1 of 1 managed contracts');
  });

  it('lists broad ordinary contracts under Others, without agent-only framing', async () => {
    const contractsListCaller = vi.fn(async () => ({
      contracts: [
        agentContract({ contract_id: 'door_alpha', display_name: 'Research workspace' }),
        agentContract({
          contract_id: 'door_beta',
          display_name: 'Shared application',
          max_uses: 10,
          uses_remaining: 4,
        }),
      ],
      total: 2,
      next_cursor: null,
    }));
    const { root, route } = mount({ contractsListCaller, initialListTab: 'others' });
    await route.whenLoaded();

    expect(route.getListTab()).toBe('others');
    expect(contractsListCaller).toHaveBeenCalledWith({
      grant_kind: 'standing',
      exclude_derived_doors: true,
      limit: 25,
    });
    expect(collectByAttr(root, CONTRACTS_ROUTE_ROW_ATTR).map(
      (row) => row.getAttribute(CONTRACTS_ROUTE_ROW_ID_ATTR),
    )).toEqual(['door_alpha', 'door_beta']);
    expect(collectByAttr(root, CONTRACTS_ROUTE_BADGE_ATTR).map((badge) => badge.textContent))
      .toEqual(['Contract', 'Contract']);
    expect(allText(root)).toContain('agents, applications, shared credentials');
    expect(allText(root)).not.toContain('Agent contracts');
    expect(allText(collectByAttr(root, CONTRACTS_ROUTE_ROW_ATTR)[1]!))
      .toContain('4 of 10 uses left');
  });

  it('requests bounded Others pages and walks next/previous cursors', async () => {
    const firstPage = Array.from({ length: 25 }, (_, index) =>
      agentContract({
        contract_id: `door_${String(index + 1).padStart(2, '0')}`,
        display_name: `Agent ${index + 1}`,
      }));
    const contractsListCaller = vi.fn<ContractsListCaller>(async (args) =>
      args?.cursor === 'page-2'
        ? {
            contracts: [agentContract({ contract_id: 'door_26' })],
            next_cursor: null,
            total: 26,
          }
        : {
            contracts: firstPage,
            next_cursor: 'page-2',
            total: 26,
          });
    const { root, route } = mount({ contractsListCaller, initialListTab: 'others' });
    await route.whenLoaded();

    expect(contractsListCaller).toHaveBeenCalledWith({
      grant_kind: 'standing',
      exclude_derived_doors: true,
      limit: 25,
    });
    expect(collectByAttr(root, CONTRACTS_ROUTE_PAGE_STATUS_ATTR)[0]?.textContent)
      .toBe('Showing 1–25 of 26');

    collectByAttr(root, CONTRACTS_ROUTE_PAGE_NEXT_ATTR)[0]!.click();
    await tick(10);
    expect(route.getContracts().map((row) => row.contract_id)).toEqual([
      'door_26',
    ]);
    expect(contractsListCaller).toHaveBeenLastCalledWith({
      grant_kind: 'standing',
      exclude_derived_doors: true,
      limit: 25,
      cursor: 'page-2',
    });
    expect(collectByAttr(root, CONTRACTS_ROUTE_PAGE_STATUS_ATTR)[0]?.textContent)
      .toBe('Showing 26–26 of 26');
    expect(
      collectByAttr(root, CONTRACTS_ROUTE_PAGE_NEXT_ATTR)[0]!.getAttribute('disabled'),
    ).toBe('');

    collectByAttr(root, CONTRACTS_ROUTE_PAGE_PREVIOUS_ATTR)[0]!.click();
    await tick(10);
    expect(route.getContracts()).toHaveLength(25);
    expect(collectByAttr(root, CONTRACTS_ROUTE_PAGE_STATUS_ATTR)[0]?.textContent)
      .toBe('Showing 1–25 of 26');
    route.dispose();
  });

  it('pages customer templates under Customer and keeps issued instances in Seller', async () => {
    const contractsListCaller = vi.fn(async () => ({
      contracts: [
        agentContract({
          contract_id: 'ct_template_pro',
          display_name: 'Pro customer',
          grant_kind: 'customer_template',
        }),
        agentContract({
          contract_id: 'ct_customer_1',
          display_name: 'Pro customer instance',
          grant_kind: 'customer_instance',
        }),
        agentContract({ contract_id: 'door_alpha' }),
      ],
    }));
    const list = mount({ contractsListCaller, initialListTab: 'customer' });
    await list.route.whenLoaded();

    expect(contractsListCaller).toHaveBeenCalledWith({
      grant_kind: 'customer_template',
      limit: 25,
    });
    expect(list.route.getContracts().map((row) => row.contract_id)).toEqual([
      'ct_template_pro',
    ]);
    const badges = collectByAttr(list.root, CONTRACTS_ROUTE_BADGE_ATTR);
    expect(badges.map((badge) => badge.textContent)).toEqual(['Template']);
    expect(allText(list.root)).toContain('Issued customer contracts stay in Seller.');
    expect(collectByAttr(list.root, CONTRACTS_ROUTE_NEW_BUTTON_ATTR)).toHaveLength(0);
    list.route.dispose();

    const detail = mount({
      contractsListCaller,
      initialContractId: 'ct_template_pro',
      initialContractTab: 'connect',
    });
    await detail.route.whenLoaded();
    expect(detail.route.getViewMode()).toBe('detail');
    expect(detail.route.getActiveTab()).toBe('ops');
    expect(collectByAttr(detail.root, CONTRACTS_ROUTE_TAB_ATTR)
      .map((tab) => tab.getAttribute('data-tab'))).toEqual(['ops', 'entities']);
    expect(collectByAttr(detail.root, CONTRACTS_ROUTE_CONNECT_HOST_ATTR)).toHaveLength(0);
    expect(collectByAttr(detail.root, CONTRACTS_ROUTE_BACK_ATTR)[0]?.getAttribute('href'))
      .toBe('#contracts/view/customer');
    expect(collectByAttr(detail.root, 'data-recued-contracts-revoke')).toHaveLength(0);
    detail.route.dispose();
  });

  describe('Anonymous and derived public contracts', () => {
    const receptionDoor = agentContract({
      contract_id: 'door_rcpt_1',
      display_name: 'Reception door — lead-capture',
      door_types: ['reception'],
      scope: { channels: ['reception'], actors: ['anonymous'] },
    });
    const webhookDoor = agentContract({
      contract_id: 'door_whk_1',
      display_name: 'Webhook door — order-observer',
      door_types: ['webhook'],
      scope: { channels: ['webhook'], actors: ['anonymous'] },
    });

    it('keeps per-recipe capability rows out of Others', async () => {
      const contractsListCaller = vi.fn(async () => ({
        contracts: [receptionDoor, agentContract(), webhookDoor],
      }));
      const { root, route } = mount({ contractsListCaller, initialListTab: 'others' });
      await route.whenLoaded();

      const allRows = collectByAttr(root, CONTRACTS_ROUTE_ROW_ATTR).map(
        (r) => r.getAttribute(CONTRACTS_ROUTE_ROW_ID_ATTR),
      );
      expect(allRows).toEqual(['door_alpha']);
      expect(route.getContracts().map((row) => row.contract_id)).toEqual(['door_alpha']);
      route.dispose();
    });

    it('opens contract.anonymous as explicit-only grant detail with no revoke or door controls', async () => {
      const stored = new Map<string, boolean>();
      const grantReadCaller = vi.fn(async () => ({
        grants: [...stored].map(([entry_key, granted]) => ({
          entry_key,
          granted,
          set_at: 1,
        })),
      }));
      const grantWriteCaller = vi.fn(async (args: {
        contract_id: string;
        entry_key: string;
        granted: boolean | null;
      }) => {
        if (args.granted === null) stored.delete(args.entry_key);
        else stored.set(args.entry_key, args.granted);
        return { ok: true as const, granted: args.granted };
      });
      const contractsListCaller = vi.fn(async () => ({ contracts: [receptionDoor] }));
      const contractsRevokeCaller = vi.fn(async () => receptionDoor);
      const grantSetDoorTypesCaller = vi.fn(async () => receptionDoor);
      const { root, route } = mount({
        contractsListCaller,
        initialContractId: receptionDoor.contract_id,
        initialContractTab: 'ops',
        grantReadCaller,
        grantWriteCaller,
        contractsRevokeCaller,
        grantSetDoorTypesCaller,
      });
      await route.whenLoaded();

      expect(route.getViewMode()).toBe('detail');
      expect(route.getSelectedContractId()).toBe(receptionDoor.contract_id);
      expect(collectByAttr(root, CONTRACTS_ROUTE_TAB_ATTR)
        .map((tab) => tab.getAttribute('data-tab'))).toEqual(['ops', 'entities']);
      expect(collectByAttr(root, CONTRACTS_ROUTE_BACK_ATTR)[0]?.getAttribute('href'))
        .toBe('#contracts/view/built-in');
      expect(collectByAttr(root, 'data-recued-contracts-revoke')).toHaveLength(0);
      expect(collectByAttr(root, CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR)).toHaveLength(0);

      const panel = route.contractGrantsPanel();
      expect(panel).not.toBeNull();
      await panel!.whenLoaded();
      const op = panel!.getEntries().find((entry) => entry.kind === 'op')!;
      expect(panel!.getEffective(op.entry_key)).toBe('off');
      await panel!.toggleEntry(op.entry_key);
      expect(grantWriteCaller).toHaveBeenCalledWith({
        contract_id: receptionDoor.contract_id,
        entry_key: op.entry_key,
        granted: true,
      });
      expect(panel!.getEffective(op.entry_key)).toBe('on');
      expect(contractsRevokeCaller).not.toHaveBeenCalled();
      expect(grantSetDoorTypesCaller).not.toHaveBeenCalled();
      route.dispose();
    });

    it('opens a derived door deep link in its normal grant detail', async () => {
      const contractsListCaller = vi.fn(async () => ({
        contracts: [receptionDoor],
      }));
      const grantSetDoorTypesCaller = vi.fn(async () => receptionDoor);
      const contractsRevokeCaller = vi.fn(async () => ({
        ...receptionDoor,
        lifecycle_state: 'revoked' as const,
      }));
      const { root, route } = mount({
        contractsListCaller,
        grantSetDoorTypesCaller,
        contractsRevokeCaller,
        initialContractId: 'door_rcpt_1',
        initialContractTab: 'connect',
      });
      await route.whenLoaded();

      expect(route.getViewMode()).toBe('detail');
      expect(route.getSelectedContractId()).toBe('door_rcpt_1');
      expect(route.getActiveTab()).toBe('ops');
      expect(collectByAttr(root, CONTRACTS_ROUTE_BACK_ATTR)[0]?.getAttribute('href'))
        .toBe('#contracts/view/built-in');
      expect(collectByAttr(root, CONTRACTS_ROUTE_CONNECT_HOST_ATTR)).toHaveLength(0);
      expect(collectByAttr(root, CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR)).toHaveLength(0);
      expect(collectByAttr(root, 'data-recued-contracts-revoke')).toHaveLength(0);
      expect(contractsRevokeCaller).not.toHaveBeenCalled();
      route.dispose();
    });

    it('a wildcard ordinary contract only shows authorable door toggles', async () => {
      const contractsListCaller = vi.fn(async () => ({
        contracts: [agentContract()],
      }));
      const grantSetDoorTypesCaller = vi.fn(async () => agentContract());
      const { root, route } = mount({
        contractsListCaller,
        grantSetDoorTypesCaller,
        initialContractId: 'door_alpha',
      });
      await route.whenLoaded();

      const toggles = collectByAttr(root, CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR).map(
        (t) => t.getAttribute('data-door'),
      );
      // reception/webhook are not hand-authorable; rendering their checkboxes
      // here handed a human a control over door classes they were never shown.
      expect(toggles).toEqual(['mcp', 'mcp_chat', 'llm_gateway']);
      route.dispose();
    });
  });

  it('shows a non-blocking note when the Others inventory fails', async () => {
    const contractsListCaller = vi.fn(async () => {
      throw new Error('boom');
    });
    const { root, route } = mount({ contractsListCaller, initialListTab: 'others' });
    await route.whenLoaded();
    expect(route.getViewMode()).toBe('list');
    expect(collectByAttr(root, CONTRACTS_ROUTE_ROW_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CONTRACTS_ROUTE_ERROR_ATTR)[0]?.textContent).toContain(
      'boom',
    );
  });

  it('opens self DETAIL without depending on a paged inventory', async () => {
    const contractsListCaller = vi.fn(async () => {
      throw new Error('kaput');
    });
    const { root, route } = mount({
      contractsListCaller,
      initialContractId: 'user_self',
    });
    await route.whenLoaded();
    expect(route.getViewMode()).toBe('detail');
    expect(route.getSelectedContractId()).toBe('user_self');
    expect(contractsListCaller).not.toHaveBeenCalled();
    expect(collectByAttr(root, CONTRACTS_ROUTE_ERROR_ATTR)).toHaveLength(0);
  });

  it('opens an ordinary contract DETAIL via initialContractId', async () => {
    const contractsListCaller = vi.fn(async () => ({
      contracts: [agentContract({ contract_id: 'door_alpha' })],
    }));
    const { root, route } = mount({
      contractsListCaller,
      initialContractId: 'door_alpha',
    });
    await route.whenLoaded();

    expect(route.getViewMode()).toBe('detail');
    expect(route.getSelectedContractId()).toBe('door_alpha');
    expect(
      collectByAttr(root, CONTRACTS_ROUTE_DETAIL_ATTR)[0]!.getAttribute(
        CONTRACTS_ROUTE_ROW_ID_ATTR,
      ),
    ).toBe('door_alpha');
    expect(
      collectByAttr(root, CONTRACTS_ROUTE_BACK_ATTR)[0]!.getAttribute('href'),
    ).toBe('#contracts/view/others');
    expect(
      collectByAttr(root, CONTRACTS_ROUTE_ACTIVITY_LINK_ATTR)[0]!.getAttribute('href'),
    ).toBe('#logs');

    const tabs = collectByAttr(root, CONTRACTS_ROUTE_TAB_ATTR);
    expect(tabs.map((t) => t.getAttribute('data-tab'))).toEqual([
      'connect',
      'ops',
      'entities',
    ]);
    expect(route.getActiveTab()).toBe('connect');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('self DETAIL has no Connect tab (Ops/Entities only) and switches tabs on click', async () => {
    const { root, route } = mount({ initialContractId: 'user_self' });
    await route.whenLoaded();
    expect(route.getViewMode()).toBe('detail');

    const tabs = collectByAttr(root, CONTRACTS_ROUTE_TAB_ATTR);
    expect(tabs.map((t) => t.getAttribute('data-tab'))).toEqual(['ops', 'entities']);
    expect(route.getActiveTab()).toBe('ops');

    tabs[1]!.click();
    expect(route.getActiveTab()).toBe('entities');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('false');
    expect(allText(collectByAttr(root, CONTRACTS_ROUTE_TAB_BODY_ATTR)[0]!)).toContain(
      'enrichment topics',
    );
  });

  it('falls back to the LIST when initialContractId is unknown', async () => {
    const { root, route } = mount({ initialContractId: 'ghost' });
    await route.whenLoaded();
    expect(route.getViewMode()).toBe('list');
    expect(collectByAttr(root, CONTRACTS_ROUTE_LIST_ATTR)).toHaveLength(1);
  });

  it('mounts the dormant proposal panels in the LIST view', async () => {
    const { route } = mount({
      suggestionsListCaller: vi.fn(async () => ({ suggestions: [] })),
      suggestionsAcceptCaller: vi.fn(async () => ({}) as never),
      suggestionsDismissCaller: vi.fn(async () => ({}) as never),
      scopedSuggestionsListCaller: vi.fn(async () => ({ suggestions: [] })),
      scopedSuggestionsAcceptCaller: vi.fn(async () => ({}) as never),
      scopedSuggestionsDismissCaller: vi.fn(async () => ({}) as never),
    });
    await route.whenLoaded();
    expect(route.suggestedRulesPanel()).not.toBeNull();
    expect(route.scopedGrantPanel()).not.toBeNull();

    route.dispose();
    expect(route.suggestedRulesPanel()).toBeNull();
    expect(route.scopedGrantPanel()).toBeNull();
  });

  it('normalizes paired WS URLs to path-routed MCP URLs for client snippets', () => {
    expect(mcpEndpointFromServerUrl('wss://alice.example/ws')).toBe(
      'https://alice.example/mcp',
    );
    expect(buildMcpClientSnippets('ws://127.0.0.1:3001/ws')[2]?.body).toContain(
      'url = "http://127.0.0.1:3001/mcp"',
    );
  });

  it('disposes cleanly (removes the route root)', async () => {
    const { root, route } = mount();
    await route.whenLoaded();
    route.dispose();
    expect(root.children).toHaveLength(0);
  });

  // ── New-contract flow (delta 2) ──────────────────────────────────
  const doorToggle = (root: FakeEl, door: string): FakeEl =>
    collectByAttr(root, CONTRACTS_ROUTE_NEW_DOOR_ATTR).find(
      (t) => t.getAttribute('data-door') === door,
    )!;

  it('mints from the "+ New contract" form and navigates to Connect', async () => {
    const minted = agentContract({
      contract_id: 'door_new',
      display_name: 'Codex bot',
      door_types: ['mcp'],
      max_uses: 25,
    });
    const permissionsMintContractCaller = vi.fn<PermissionsMintContractCaller>(
      async () => minted,
    );
    const navigated: string[] = [];
    const { root, route } = mount({
      contractsListCaller: vi.fn(async () => ({ contracts: [] })),
      permissionsMintContractCaller,
      navigate: (hash: string) => navigated.push(hash),
      initialListTab: 'others',
    });
    await route.whenLoaded();

    // The action is present; the form stays hidden until the action is clicked.
    expect(collectByAttr(root, CONTRACTS_ROUTE_NEW_BUTTON_ATTR)[0]?.textContent)
      .toBe('+ New contract');
    expect(collectByAttr(root, CONTRACTS_ROUTE_NEW_FORM_ATTR)).toHaveLength(0);
    collectByAttr(root, CONTRACTS_ROUTE_NEW_BUTTON_ATTR)[0]!.click();
    expect(collectByAttr(root, CONTRACTS_ROUTE_NEW_FORM_ATTR)).toHaveLength(1);

    collectByAttr(root, CONTRACTS_ROUTE_NEW_NAME_ATTR)[0]!.value = 'Codex bot';
    const mcp = doorToggle(root, 'mcp');
    mcp.click();
    expect(mcp.getAttribute('data-checked')).toBe('true');
    collectByAttr(root, CONTRACTS_ROUTE_NEW_CAP_ATTR)[0]!.value = '25';

    collectByAttr(root, CONTRACTS_ROUTE_NEW_SUBMIT_ATTR)[0]!.click();
    await tick();

    expect(permissionsMintContractCaller).toHaveBeenCalledTimes(1);
    expect(permissionsMintContractCaller.mock.calls[0]![0]).toEqual({
      display_name: 'Codex bot',
      scope: {},
      door_types: ['mcp'],
      max_uses: 25,
    });
    // Stateless model: the flow only navigates; the shell re-mounts the route.
    expect(navigated).toEqual(['#contracts/door_new/connect']);
    route.dispose();
  });

  it('omits empty door_types / cap / expiry from the mint request (wildcard)', async () => {
    const permissionsMintContractCaller = vi.fn<PermissionsMintContractCaller>(
      async () => agentContract({ contract_id: 'door_bare', display_name: 'Bare' }),
    );
    const { root, route } = mount({
      contractsListCaller: vi.fn(async () => ({ contracts: [] })),
      permissionsMintContractCaller,
      navigate: () => {},
      initialListTab: 'others',
    });
    await route.whenLoaded();
    collectByAttr(root, CONTRACTS_ROUTE_NEW_BUTTON_ATTR)[0]!.click();
    collectByAttr(root, CONTRACTS_ROUTE_NEW_NAME_ATTR)[0]!.value = 'Bare';
    collectByAttr(root, CONTRACTS_ROUTE_NEW_SUBMIT_ATTR)[0]!.click();
    await tick();
    expect(permissionsMintContractCaller.mock.calls[0]![0]).toEqual({
      display_name: 'Bare',
      scope: {},
    });
    route.dispose();
  });

  it('keeps customer-template creation in Seller instead of the generic mint form', async () => {
    const permissionsMintContractCaller = vi.fn<PermissionsMintContractCaller>(
      async () => agentContract(),
    );
    const { root, route } = mount({
      contractsListCaller: vi.fn(async () => ({ contracts: [] })),
      permissionsMintContractCaller,
      navigate: () => {},
      initialListTab: 'customer',
    });
    await route.whenLoaded();

    expect(collectByAttr(root, CONTRACTS_ROUTE_NEW_TEMPLATE_BUTTON_ATTR)).toHaveLength(0);
    expect(allText(root)).toContain('Issued customer contracts stay in Seller.');
    expect(
      collectByTag(root, 'a').some((link) => link.getAttribute('href') === '#settings/seller'),
    ).toBe(true);
    expect(permissionsMintContractCaller).not.toHaveBeenCalled();
    route.dispose();
  });

  it('blocks mint on an empty name with a validation error (no rpc, no navigation)', async () => {
    const permissionsMintContractCaller = vi.fn<PermissionsMintContractCaller>(
      async () => agentContract(),
    );
    const navigated: string[] = [];
    const { root, route } = mount({
      contractsListCaller: vi.fn(async () => ({ contracts: [] })),
      permissionsMintContractCaller,
      navigate: (hash: string) => navigated.push(hash),
      initialListTab: 'others',
    });
    await route.whenLoaded();
    collectByAttr(root, CONTRACTS_ROUTE_NEW_BUTTON_ATTR)[0]!.click();
    collectByAttr(root, CONTRACTS_ROUTE_NEW_SUBMIT_ATTR)[0]!.click();
    await tick();
    expect(permissionsMintContractCaller).not.toHaveBeenCalled();
    expect(navigated).toEqual([]);
    expect(
      collectByAttr(root, CONTRACTS_ROUTE_NEW_ERROR_ATTR)[0]!.textContent,
    ).toContain('name');
    route.dispose();
  });

  it('surfaces a mint failure on the form and re-enables submit', async () => {
    const permissionsMintContractCaller = vi.fn<PermissionsMintContractCaller>(
      async () => {
        throw new Error('mint exploded');
      },
    );
    const navigated: string[] = [];
    const { root, route } = mount({
      contractsListCaller: vi.fn(async () => ({ contracts: [] })),
      permissionsMintContractCaller,
      navigate: (hash: string) => navigated.push(hash),
      initialListTab: 'others',
    });
    await route.whenLoaded();
    collectByAttr(root, CONTRACTS_ROUTE_NEW_BUTTON_ATTR)[0]!.click();
    collectByAttr(root, CONTRACTS_ROUTE_NEW_NAME_ATTR)[0]!.value = 'Doomed';
    const submit = collectByAttr(root, CONTRACTS_ROUTE_NEW_SUBMIT_ATTR)[0]!;
    submit.click();
    await tick();
    expect(navigated).toEqual([]);
    expect(
      collectByAttr(root, CONTRACTS_ROUTE_NEW_ERROR_ATTR)[0]!.textContent,
    ).toContain('mint exploded');
    expect(submit.disabled).toBe(false);
    route.dispose();
  });

  it('hides the "+ New contract" action unless BOTH mint + list callers are wired', async () => {
    // Unwired entirely.
    const a = mount({ initialListTab: 'others' });
    await a.route.whenLoaded();
    expect(collectByAttr(a.root, CONTRACTS_ROUTE_NEW_BUTTON_ATTR)).toHaveLength(0);
    expect(collectByAttr(a.root, CONTRACTS_ROUTE_NEW_TEMPLATE_BUTTON_ATTR)).toHaveLength(0);
    a.route.dispose();

    // Mint wired but NO list caller: a successful mint would navigate to a
    // contract the remount (self-only, no list) can't resolve, so the affordance
    // is suppressed rather than stranding the user.
    const b = mount({
      permissionsMintContractCaller: vi.fn<PermissionsMintContractCaller>(
        async () => agentContract(),
      ),
      initialListTab: 'others',
    });
    await b.route.whenLoaded();
    expect(collectByAttr(b.root, CONTRACTS_ROUTE_NEW_BUTTON_ATTR)).toHaveLength(0);
    expect(collectByAttr(b.root, CONTRACTS_ROUTE_NEW_TEMPLATE_BUTTON_ATTR)).toHaveLength(0);
    b.route.dispose();
  });

  it('lands an ordinary contract DETAIL on Connect and degrades unwired credentials', async () => {
    const contractsListCaller = vi.fn(async () => ({
      contracts: [agentContract({ contract_id: 'door_new', display_name: 'Codex bot' })],
    }));
    const { root, route } = mount({
      contractsListCaller,
      initialContractId: 'door_new',
      initialContractTab: 'connect',
    });
    await route.whenLoaded();
    expect(route.getViewMode()).toBe('detail');
    expect(route.getActiveTab()).toBe('connect');
    expect(collectByAttr(root, CONTRACTS_ROUTE_CONNECT_HOST_ATTR)).toHaveLength(1);
    expect(collectByAttr(root, CONTRACTS_ROUTE_SNIPPET_ATTR).length).toBeGreaterThan(0);
    // No inbound-token callers in this harness → the credential panel degrades
    // to a note (it mounts for real in the d-166 forwarding coverage).
    expect(collectByAttr(root, CONTRACTS_ROUTE_UNAVAILABLE_ATTR)).toHaveLength(1);
    expect(route.permissionsPanel()).toBeNull();
    route.dispose();
  });

  it('seeds the DETAIL tab from the deep-link segment (self → entities)', async () => {
    const { route } = mount({
      initialContractId: 'user_self',
      initialContractTab: 'entities',
    });
    await route.whenLoaded();
    expect(route.getActiveTab()).toBe('entities');
    route.dispose();
  });

  it('keeps the Connect tab content alive across tab switches (re-attached, not rebuilt)', async () => {
    const contractsListCaller = vi.fn(async () => ({
      contracts: [agentContract({ contract_id: 'door_alpha' })],
    }));
    const { root, route } = mount({ contractsListCaller, initialContractId: 'door_alpha' });
    await route.whenLoaded();
    expect(route.getActiveTab()).toBe('connect');
    const host1 = collectByAttr(root, CONTRACTS_ROUTE_CONNECT_HOST_ATTR)[0]!;

    const tabs = collectByAttr(root, CONTRACTS_ROUTE_TAB_ATTR);
    tabs.find((t) => t.getAttribute('data-tab') === 'ops')!.click();
    expect(route.getActiveTab()).toBe('ops');
    // Detached from the live tree while Ops shows — but not destroyed.
    expect(collectByAttr(root, CONTRACTS_ROUTE_CONNECT_HOST_ATTR)).toHaveLength(0);

    tabs.find((t) => t.getAttribute('data-tab') === 'connect')!.click();
    const host2 = collectByAttr(root, CONTRACTS_ROUTE_CONNECT_HOST_ATTR)[0]!;
    expect(host2).toBe(host1); // same node — kept alive across the round-trip
    route.dispose();
  });
});

const sessionSummary = (): ChatSessionSummary => ({
  id: 'chat_1',
  title: 'Ops chat',
  created_at: 1_000,
  last_active_at: 2_000,
  message_count: 1,
  archived: false,
  picker_state: { current: 'self' },
  model_routing: { current: 'byok', provider: 'local', overridden: false },
});

const chatSession = (): ChatSession => ({
  id: 'chat_1',
  title: 'Ops chat',
  created_at: 1_000,
  last_active_at: 2_000,
  archived: false,
  picker_state: { current: 'self' },
  model_routing: {
    current: 'byok',
    provider: 'local',
    model_id: 'local-default',
    overridden: false,
  },
});

const chatMessage = (): ChatMessage => ({
  id: 'msg_1',
  session_id: 'chat_1',
  role: 'assistant',
  content: 'Boundary state is ready.',
  target_server: 'self',
  picker_at_send: {
    display_name: 'This server',
    signature: {
      server_id: 'server_1',
      server_public_key: 'spki',
      signed_at: 1_000,
      signature: 'sig',
    },
  },
  model_used: { provider: 'local', model_id: 'local-default' },
  ts: 2_000,
} as unknown as ChatMessage);

describe('D-174 P2 chat route', () => {
  it('mounts the D-137 chat substrate as a top-level route', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const conn: ChatRouteConn = (async (method: string, payload?: unknown) => {
      calls.push({ method, payload });
      if (method === 'chat.sessions.list') {
        return { sessions: [sessionSummary()] };
      }
      if (method === 'chat.session.get') {
        return { ...chatSession(), messages: [chatMessage()] };
      }
      if (method === 'chat.session.create') {
        return { session_id: 'chat_2' };
      }
      if (method === 'chat.send') {
        return { turn_id: 'turn_1' };
      }
      throw new Error(`unexpected method ${method}`);
    }) as ChatRouteConn;

    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });
    await tick();

    expect(collectByAttr(root, CHAT_ROUTE_HEADING_ATTR)[0]?.textContent).toBe('Chat');
    expect(route.getSessions().map((s) => s.id)).toEqual(['chat_1']);

    await route.openSession('chat_1');
    expect(collectByAttr(root, CHAT_ROUTE_MESSAGE_ATTR)).toHaveLength(1);
    expect(allText(root)).toContain('Boundary state is ready.');

    await route.sendMessage('what can run?');
    expect(route.getThread().inflight?.turn_id).toBe('turn_1');
    expect(calls.some((call) => call.method === 'chat.send')).toBe(true);

    route.dispose();
    expect(root.children).toHaveLength(0);
  });
});

const chatConnWithConfig = (
  llmConfig: Record<string, unknown>,
): ChatRouteConn =>
  (async (method: string) => {
    if (method === 'chat.sessions.list') return { sessions: [sessionSummary()] };
    if (method === 'chat.session.get') return { ...chatSession(), messages: [] };
    if (method === 'chat.session.create') return { session_id: 'chat_2' };
    if (method === 'chat.send') return { turn_id: 'turn_1' };
    if (method === 'server.getLLMConfig') return { config: llmConfig };
    throw new Error(`unexpected method ${method}`);
  }) as ChatRouteConn;

describe('D-174 P2 chat route — AI-availability affordance (UX flow-09)', () => {
  it('shows the cold-start "set up AI" banner + disables Send with an accessible reason when no source is configured', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: chatConnWithConfig({}),
    });
    await tick();
    // Open a session so Send is not disabled merely for the no-session reason —
    // isolates the AI-unavailable disable path.
    await route.openSession('chat_1');
    await tick();

    const notice = collectByAttr(root, CHAT_ROUTE_AI_UNAVAILABLE_ATTR);
    expect(notice).toHaveLength(1);
    expect(notice[0]!.getAttribute('id')).toBe(CHAT_ROUTE_AI_UNAVAILABLE_ID);
    const link = notice[0]!.children.find((child) => child.tagName === 'A');
    expect(link?.getAttribute('href')).toBe('#settings/ai-models');
    expect(allText(root)).toContain('Set up AI / Models');

    const send = collectByAttr(root, CHAT_ROUTE_SEND_ATTR)[0]!;
    expect(send.disabled).toBe(true);
    expect(send.getAttribute('title')).toContain('No AI model');
    expect(send.getAttribute('aria-describedby')).toBe(
      CHAT_ROUTE_AI_UNAVAILABLE_ID,
    );

    route.dispose();
  });

  it('hides the affordance and leaves Send enabled once a BYOK slot is configured', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: chatConnWithConfig({
        slot_1: {
          provider: 'anthropic',
          model: 'claude-opus',
          has_key: true,
        },
      }),
    });
    await tick();
    await route.openSession('chat_1');
    await tick();

    expect(collectByAttr(root, CHAT_ROUTE_AI_UNAVAILABLE_ATTR)).toHaveLength(0);
    const send = collectByAttr(root, CHAT_ROUTE_SEND_ATTR)[0]!;
    expect(send.disabled).toBe(false);
    expect(send.getAttribute('title')).toBeNull();
    expect(send.getAttribute('aria-describedby')).toBeNull();

    route.dispose();
  });

  it('does not flash the banner while the LLM config read is still pending', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    let releaseConfig: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseConfig = resolve;
    });
    const conn = (async (method: string) => {
      if (method === 'chat.sessions.list') return { sessions: [sessionSummary()] };
      if (method === 'chat.session.get') return { ...chatSession(), messages: [] };
      if (method === 'server.getLLMConfig') {
        await gate;
        return { config: {} };
      }
      throw new Error(`unexpected method ${method}`);
    }) as ChatRouteConn;
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });
    await tick();
    await route.openSession('chat_1');
    await tick();

    // Config read unresolved → aiAvailable stays null → no banner, Send carries
    // no AI-unavailable reason (the distinction the routing badge can't make).
    expect(collectByAttr(root, CHAT_ROUTE_AI_UNAVAILABLE_ATTR)).toHaveLength(0);
    expect(
      collectByAttr(root, CHAT_ROUTE_SEND_ATTR)[0]!.getAttribute('title'),
    ).toBeNull();

    // Resolve to an empty (unconfigured) config → the banner now appears.
    releaseConfig!();
    await tick();
    expect(collectByAttr(root, CHAT_ROUTE_AI_UNAVAILABLE_ATTR)).toHaveLength(1);

    route.dispose();
  });
});


describe('PB7 webclient failure paint chat route', () => {
  const TURN_FAILURE_ATTR = 'data-recued-chat-route-turn-failure';

  type RouteBroadcast = {
    kind: string;
    session_id?: string;
    turn_id?: string;
    [key: string]: unknown;
  };

  const mountChatRouteWithBroadcasts = () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const listeners = new Map<string, Array<(event: RouteBroadcast) => void>>();
    let resolveSend: ((value: { turn_id: string }) => void) | null = null;
    const sendGate = new Promise<{ turn_id: string }>((resolve) => {
      resolveSend = resolve;
    });
    const conn: ChatRouteConn = (async (method: string) => {
      if (method === 'chat.sessions.list') return { sessions: [sessionSummary()] };
      if (method === 'chat.session.get') return { ...chatSession(), messages: [] };
      if (method === 'chat.session.create') return { session_id: 'chat_2' };
      if (method === 'chat.send') return sendGate;
      if (method === 'server.getLLMConfig') return { config: { local: { enabled: true } } };
      throw new Error(`unexpected method ${method}`);
    }) as ChatRouteConn;

    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      subscribe: ((kind: string, listener: (event: RouteBroadcast) => void) => {
        const list = listeners.get(kind) ?? [];
        list.push(listener);
        listeners.set(kind, list);
        return () => {
          const current = listeners.get(kind) ?? [];
          listeners.set(
            kind,
            current.filter((fn) => fn !== listener),
          );
        };
      }) as never,
    });

    return {
      root,
      route,
      publish(event: RouteBroadcast) {
        for (const listener of listeners.get(event.kind) ?? []) listener(event);
      },
      resolveSend(value: { turn_id: string }) {
        resolveSend!(value);
      },
    };
  };

  const completedMessage = (id: string, content: string): ChatMessage => ({
    ...chatMessage(),
    id,
    content,
  });

  it('renders one failure notice under the completed message across production broadcast-before-ack ordering', async () => {
    const h = mountChatRouteWithBroadcasts();
    await tick();
    await h.route.openSession('chat_1');

    const send = h.route.sendMessage('trigger provider failure');

    h.publish({
      kind: 'chat.transparency',
      session_id: 'chat_1',
      turn_id: 'turn_1',
      event: {
        kind: 'engine.decoder_unavailable',
        reason: 'provider_failure',
        site: 'initial',
      },
      cursor: 1,
    });
    h.publish({
      kind: 'chat.message_complete',
      session_id: 'chat_1',
      turn_id: 'turn_1',
      final: completedMessage('msg_failed', 'Final failure row.'),
      cursor: 2,
    });
    h.resolveSend({ turn_id: 'turn_1' });
    await send;
    await tick();

    const notices = collectByAttr(h.root, TURN_FAILURE_ATTR);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.getAttribute('role')).toBe('status');
    expect(allText(notices[0]!)).toContain('the AI provider failed before answering');

    const rows = collectByAttr(h.root, CHAT_ROUTE_MESSAGE_ATTR);
    const completed = rows.find((row) => allText(row).includes('Final failure row.'))!;
    expect(notices[0]!.parent).toBe(completed.parent);
    expect(completed.parent!.children.indexOf(completed)).toBeLessThan(
      completed.parent!.children.indexOf(notices[0]!),
    );

    h.route.dispose();
  });

  it('renders the Settings link for no_source failure notices', async () => {
    const h = mountChatRouteWithBroadcasts();
    await tick();
    await h.route.openSession('chat_1');

    h.publish({
      kind: 'chat.transparency',
      session_id: 'chat_1',
      turn_id: 'turn_no_source',
      event: {
        kind: 'engine.decoder_unavailable',
        reason: 'no_source',
        site: 'initial',
      },
      cursor: 1,
    });
    h.publish({
      kind: 'chat.message_complete',
      session_id: 'chat_1',
      turn_id: 'turn_no_source',
      final: completedMessage('msg_no_source', 'No source turn.'),
      cursor: 2,
    });
    await tick();

    const notice = collectByAttr(h.root, TURN_FAILURE_ATTR)[0]!;
    const link = notice.children.find((child) => child.tagName === 'A');

    expect(allText(notice)).toContain(
      'no AI model source available for this turn — check Settings → AI / Models',
    );
    expect(link?.getAttribute('href')).toBe('#settings/ai-models');
    expect(link?.textContent).toBe('Set up AI / Models →');

    h.route.dispose();
  });

  it('does not render a notice for non-failure transparency events', async () => {
    const h = mountChatRouteWithBroadcasts();
    await tick();
    await h.route.openSession('chat_1');

    h.publish({
      kind: 'chat.transparency',
      session_id: 'chat_1',
      turn_id: 'turn_round',
      event: {
        kind: 'recued.multi_turn.round_started',
        round_index: 0,
        expected_max_rounds: 2,
      },
      cursor: 1,
    });
    h.publish({
      kind: 'chat.message_complete',
      session_id: 'chat_1',
      turn_id: 'turn_round',
      final: completedMessage('msg_round', 'Round completed.'),
      cursor: 2,
    });
    await tick();

    expect(collectByAttr(h.root, TURN_FAILURE_ATTR)).toHaveLength(0);

    h.route.dispose();
  });
});
describe('D-174 P2 chat route — route-side scaffold handling', () => {
  type RouteBroadcast = {
    kind: string;
    session_id?: string;
    turn_id?: string;
    [key: string]: unknown;
  };

  const mountChatRouteWithStreamingBroadcasts = () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const listeners = new Map<string, Array<(event: RouteBroadcast) => void>>();
    let resolveSend: ((value: { turn_id: string }) => void) | null = null;
    const sendGate = new Promise<{ turn_id: string }>((resolve) => {
      resolveSend = resolve;
    });
    const conn: ChatRouteConn = (async (method: string) => {
      if (method === 'chat.sessions.list') return { sessions: [sessionSummary()] };
      if (method === 'chat.session.get') return { ...chatSession(), messages: [] };
      if (method === 'chat.session.create') return { session_id: 'chat_2' };
      if (method === 'chat.send') return sendGate;
      if (method === 'server.getLLMConfig') return { config: { local: { enabled: true } } };
      throw new Error(`unexpected method ${method}`);
    }) as ChatRouteConn;

    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      subscribe: ((kind: string, listener: (event: RouteBroadcast) => void) => {
        const list = listeners.get(kind) ?? [];
        list.push(listener);
        listeners.set(kind, list);
        return () => {
          const current = listeners.get(kind) ?? [];
          listeners.set(
            kind,
            current.filter((fn) => fn !== listener),
          );
        };
      }) as never,
    });

    return {
      root,
      route,
      publish(event: RouteBroadcast) {
        for (const listener of listeners.get(event.kind) ?? []) listener(event);
      },
      resolveSend(value: { turn_id: string }) {
        resolveSend!(value);
      },
    };
  };

  const completedMessage = (id: string, content: string): ChatMessage => ({
    ...chatMessage(),
    id,
    content,
  });

  const assistantRows = (root: FakeEl): FakeEl[] =>
    collectByAttr(root, CHAT_ROUTE_MESSAGE_ATTR).filter(
      (row) => row.getAttribute('data-role') === 'assistant',
    );

  const messageContent = (row: FakeEl): string =>
    row.children.find((child) => child.className === 'chat-message-content')
      ?.textContent ?? '';

  const expectNoEmptyAssistantRows = (root: FakeEl): void => {
    expect(
      assistantRows(root).filter((row) => messageContent(row).trim().length === 0),
    ).toHaveLength(0);
  };

  it('paints live streaming content under production broadcast-before-ack ordering', async () => {
    const h = mountChatRouteWithStreamingBroadcasts();
    await tick();
    await h.route.openSession('chat_1');
    await tick();

    let sendSettled = false;
    const send = h.route.sendMessage('stream now').then(() => {
      sendSettled = true;
    });
    await tick();
    expect(sendSettled).toBe(false);

    h.publish({
      kind: 'chat.token_streamed',
      session_id: 'chat_1',
      turn_id: 'turn_1',
      delta: 'Streaming now…',
      cursor: 1,
    });
    await tick();

    expect(sendSettled).toBe(false);
    let rows = assistantRows(h.root);
    expect(rows).toHaveLength(1);
    expect(messageContent(rows[0]!)).toBe('Streaming now…');

    h.publish({
      kind: 'chat.message_complete',
      session_id: 'chat_1',
      turn_id: 'turn_1',
      final: completedMessage('msg_done', 'Done.'),
      cursor: 2,
    });
    h.resolveSend({ turn_id: 'turn_1' });
    await send;
    await tick();

    rows = assistantRows(h.root);
    expect(rows).toHaveLength(1);
    expect(messageContent(rows[0]!)).toBe('Done.');
    expect(rows.some((row) => messageContent(row).includes('Streaming now'))).toBe(false);
    expectNoEmptyAssistantRows(h.root);

    h.route.dispose();
  });

  it('treats a post-completion chat.send ack as a no-op', async () => {
    const h = mountChatRouteWithStreamingBroadcasts();
    await tick();
    await h.route.openSession('chat_1');
    await tick();

    const send = h.route.sendMessage('old dangling bubble repro');

    h.publish({
      kind: 'chat.token_streamed',
      session_id: 'chat_1',
      turn_id: 'turn_1',
      delta: 'Streaming now…',
      cursor: 1,
    });
    h.publish({
      kind: 'chat.message_complete',
      session_id: 'chat_1',
      turn_id: 'turn_1',
      final: completedMessage('msg_done', 'Done.'),
      cursor: 2,
    });
    h.resolveSend({ turn_id: 'turn_1' });
    await send;
    await tick();

    const rows = assistantRows(h.root);
    expect(rows).toHaveLength(1);
    expect(messageContent(rows[0]!)).toBe('Done.');
    expectNoEmptyAssistantRows(h.root);

    h.route.dispose();
  });

  describe('activity disclosure', () => {
    const checkMark = String.fromCodePoint(0x2713);

    const activityBlocks = (row: FakeEl): FakeEl[] =>
      collectByAttr(row, CHAT_ROUTE_ACTIVITY_ATTR);

    const activityRows = (row: FakeEl): FakeEl[] =>
      collectByAttr(row, CHAT_ROUTE_ACTIVITY_ROW_ATTR);

    const activityToggle = (row: FakeEl): FakeEl =>
      collectByAttr(row, CHAT_ROUTE_ACTIVITY_TOGGLE_ATTR)[0]!;

    const startActivityTurn = async () => {
      const h = mountChatRouteWithStreamingBroadcasts();
      await tick();
      await h.route.openSession('chat_1');
      await tick();

      h.publish({
        kind: 'chat.tool_call_started',
        session_id: 'chat_1',
        turn_id: 'turn_activity',
        tool_name: 'mail.search',
        tier: 1,
        args: { q: 'ops' },
        cursor: 1,
      });
      h.publish({
        kind: 'chat.transparency',
        session_id: 'chat_1',
        turn_id: 'turn_activity',
        event: {
          kind: 'memory_lookup',
          query_summary: 'prior notes',
          result_count: 2,
        },
        cursor: 2,
      });
      await tick();

      return h;
    };

    it('renders in-flight transparency and tool rows, then updates tool completion', async () => {
      // Case 11.
      const h = await startActivityTurn();

      let rows = assistantRows(h.root);
      expect(rows).toHaveLength(1);
      expect(activityBlocks(rows[0]!)).toHaveLength(1);
      expect(activityToggle(rows[0]!).textContent).toContain('Activity (2)');
      let disclosureRows = activityRows(rows[0]!);
      expect(disclosureRows).toHaveLength(2);
      expect(disclosureRows.some((row) => allText(row).includes('checking prior notes')))
        .toBe(true);
      const startedTool = disclosureRows.find((row) =>
        allText(row).includes('running mail.search...'),
      )!;
      expect(startedTool.getAttribute('data-status')).toBe('started');

      h.publish({
        kind: 'chat.tool_call_completed',
        session_id: 'chat_1',
        turn_id: 'turn_activity',
        tool_name: 'mail.search',
        tier: 1,
        status: 'ok',
        result_ref: 'chat_1:turn_activity:mail.search',
        cursor: 3,
      });
      await tick();

      rows = assistantRows(h.root);
      disclosureRows = activityRows(rows[0]!);
      const completedTool = disclosureRows.find((row) =>
        allText(row).includes('used mail.search ' + checkMark),
      )!;
      expect(completedTool.getAttribute('data-status')).toBe('ok');

      h.route.dispose();
    });

    it('keeps the activity block collapsed across re-renders until toggled open', async () => {
      // Case 12.
      const h = await startActivityTurn();
      let row = assistantRows(h.root)[0]!;

      activityToggle(row).click();
      row = assistantRows(h.root)[0]!;
      expect(activityToggle(row).getAttribute('aria-expanded')).toBe('false');
      expect(activityRows(row)).toHaveLength(0);

      h.publish({
        kind: 'chat.token_streamed',
        session_id: 'chat_1',
        turn_id: 'turn_activity',
        delta: 'Still running',
        cursor: 3,
      });
      await tick();

      row = assistantRows(h.root)[0]!;
      expect(activityToggle(row).getAttribute('aria-expanded')).toBe('false');
      expect(activityRows(row)).toHaveLength(0);

      activityToggle(row).click();
      row = assistantRows(h.root)[0]!;
      expect(activityToggle(row).getAttribute('aria-expanded')).toBe('true');
      expect(activityRows(row)).toHaveLength(2);

      h.route.dispose();
    });

    it('carries completed message tool activity while dropping streaming narrative', async () => {
      // Case 13.
      const h = await startActivityTurn();
      const final = {
        ...chatMessage(),
        id: 'msg_activity_done',
        content: 'Tool-backed answer.',
        tool_calls: [
          {
            tool_name: 'mail.search',
            tier: 1,
            args: { q: 'ops' },
            status: 'ok',
            result_ref: 'chat_1:turn_activity:mail.search',
            started_at: 1_000,
            completed_at: 1_100,
          },
        ],
      } satisfies ChatMessage;

      h.publish({
        kind: 'chat.message_complete',
        session_id: 'chat_1',
        turn_id: 'turn_activity',
        final,
        cursor: 3,
      });
      await tick();

      const row = assistantRows(h.root).find((candidate) =>
        messageContent(candidate) === 'Tool-backed answer.',
      )!;
      expect(activityBlocks(row)).toHaveLength(1);
      expect(activityToggle(row).textContent).toContain('Activity (1)');
      const disclosureRows = activityRows(row);
      expect(disclosureRows).toHaveLength(1);
      expect(allText(disclosureRows[0]!)).toContain('used mail.search ' + checkMark);
      expect(allText(row)).not.toContain('checking prior notes');

      h.route.dispose();
    });

    it('renders no activity block for completed assistant messages without tool calls', async () => {
      // Case 14.
      const h = mountChatRouteWithStreamingBroadcasts();
      await tick();
      await h.route.openSession('chat_1');
      await tick();

      h.publish({
        kind: 'chat.message_complete',
        session_id: 'chat_1',
        turn_id: 'turn_plain',
        final: completedMessage('msg_plain', 'Plain answer.'),
        cursor: 1,
      });
      await tick();

      const row = assistantRows(h.root).find((candidate) =>
        messageContent(candidate) === 'Plain answer.',
      )!;
      expect(activityBlocks(row)).toHaveLength(0);

      h.route.dispose();
    });

    it('renders failure notice without duplicating failure copy in activity rows', async () => {
      // Case 15.
      const h = mountChatRouteWithStreamingBroadcasts();
      await tick();
      await h.route.openSession('chat_1');
      await tick();

      h.publish({
        kind: 'chat.transparency',
        session_id: 'chat_1',
        turn_id: 'turn_failure',
        event: {
          kind: 'engine.decoder_unavailable',
          reason: 'no_source',
          site: 'initial',
        },
        cursor: 1,
      });
      await tick();

      const notices = collectByAttr(h.root, CHAT_ROUTE_TURN_FAILURE_ATTR);
      expect(notices).toHaveLength(1);
      expect(allText(notices[0]!)).toContain('no AI model source');
      const rowTexts = collectByAttr(h.root, CHAT_ROUTE_ACTIVITY_ROW_ATTR)
        .map((row) => allText(row));
      expect(rowTexts.some((text) => text.includes('no AI model source'))).toBe(false);
      expect(rowTexts.some((text) => text.includes('AI / Models'))).toBe(false);

      h.route.dispose();
    });
  });
});

import {
  DEFAULT_INSTANCE_PREFS,
  type InstancePrefs,
} from '@recued/contracts';

describe('D-174 P2 chat route transparency prefs threading', () => {
  type RouteBroadcast = {
    kind: string;
    session_id?: string;
    turn_id?: string;
    [key: string]: unknown;
  };

  it('suppresses master-off transparency notes while keeping tool rows', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const listeners = new Map<string, Array<(event: RouteBroadcast) => void>>();
    const prefs = {
      ...DEFAULT_INSTANCE_PREFS,
      'ui.transparency.enabled': false,
    } satisfies InstancePrefs;
    const conn: ChatRouteConn = (async (method: string) => {
      if (method === 'chat.sessions.list') return { sessions: [sessionSummary()] };
      if (method === 'chat.session.get') {
        return { ...chatSession(), messages: [] };
      }
      if (method === 'chat.session.create') return { session_id: 'chat_2' };
      if (method === 'chat.send') return { turn_id: 'turn_1' };
      if (method === 'server.getLLMConfig') {
        return { config: { local: { enabled: true } } };
      }
      if (method === 'prefs.get') return { prefs };
      throw new Error('unexpected method ' + method);
    }) as ChatRouteConn;
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      subscribe: ((kind: string, listener: (event: RouteBroadcast) => void) => {
        const list = listeners.get(kind) ?? [];
        list.push(listener);
        listeners.set(kind, list);
        return () => {
          const current = listeners.get(kind) ?? [];
          listeners.set(
            kind,
            current.filter((fn) => fn !== listener),
          );
        };
      }) as never,
    });
    const publish = (event: RouteBroadcast): void => {
      for (const listener of listeners.get(event.kind) ?? []) listener(event);
    };

    await tick();
    await route.openSession('chat_1');
    await tick();

    publish({
      kind: 'chat.transparency',
      session_id: 'chat_1',
      turn_id: 'turn_prefs',
      event: {
        kind: 'chat.channel_note',
        note: 'checking hidden context',
      },
      cursor: 1,
    });
    publish({
      kind: 'chat.tool_call_started',
      session_id: 'chat_1',
      turn_id: 'turn_prefs',
      tool_name: 'mail.search',
      tier: 1,
      args: { q: 'ops' },
      cursor: 2,
    });
    await tick();

    const assistantRows = collectByAttr(root, CHAT_ROUTE_MESSAGE_ATTR).filter(
      (row) => row.getAttribute('data-role') === 'assistant',
    );
    expect(assistantRows).toHaveLength(1);
    const row = assistantRows[0]!;
    const toggle = collectByAttr(row, CHAT_ROUTE_ACTIVITY_TOGGLE_ATTR)[0]!;
    expect(toggle.textContent).toContain('Activity (1)');
    const activityRows = collectByAttr(row, CHAT_ROUTE_ACTIVITY_ROW_ATTR);
    expect(activityRows).toHaveLength(1);
    expect(allText(activityRows[0]!)).toContain('running mail.search...');
    expect(allText(row)).not.toContain('checking hidden context');

    route.dispose();
  });
});

describe('D-174 P2 chat route — shell-frame Step 3 (composer L1 upgrades)', () => {
  // The fake harness only auto-fires `click`; this drives `input` / `change`.
  const fireEvent = (el: FakeEl, type: string, value?: string): void => {
    if (value !== undefined) el.value = value;
    for (const fn of el.listeners.get(type) ?? []) fn();
  };

  const stepConn = (
    config: {
      calls?: Array<{ method: string; payload?: unknown }>;
      llmConfig?: Record<string, unknown>;
      defaultSourceId?: 'slot_1' | 'slot_2' | 'free_pool' | null;
      sessions?: ChatSessionSummary[];
    } = {},
  ): ChatRouteConn => {
    const llmConfig = config.llmConfig ?? {
      slot_1: { provider: 'anthropic', model: 'claude-opus', has_key: true },
    };
    const defaultSourceId = config.defaultSourceId ?? null;
    const sessions = config.sessions ?? [];
    return (async (method: string, payload?: unknown) => {
      config.calls?.push({ method, payload });
      if (method === 'chat.sessions.list') return { sessions };
      if (method === 'chat.session.get') {
        const sid =
          (payload as { session_id?: string } | undefined)?.session_id
          ?? 'chat_new';
        return { ...chatSession(), id: sid, messages: [] };
      }
      if (method === 'chat.session.create') return { session_id: 'chat_new' };
      if (method === 'chat.send') return { turn_id: 'turn_1' };
      if (method === 'chat.session.set_model_pref') return { ok: true };
      if (method === 'chat.default_model_pref.get') {
        return { source_id: defaultSourceId, updated_at: 1 };
      }
      if (method === 'server.getLLMConfig') return { config: llmConfig };
      if (method === 'prefs.get') return { prefs: {} };
      throw new Error(`unexpected method ${method}`);
    }) as ChatRouteConn;
  };

  const byokAndFreeConfig = {
    free_pool: [{ id: 'groq', enabled: true }],
    slot_1: { provider: 'anthropic', model: 'claude-opus', has_key: true },
  };

  // Two BYOK slots → slot_1 defaults to the 'fast' role, slot_2 to 'thinking'
  // (the slot-aware picker surfaces both; picking slot_2 is what was
  // unreachable from chat before this slice).
  const twoSlotConfig = {
    slot_1: { provider: 'anthropic', model: 'claude-opus', has_key: true },
    slot_2: { provider: 'openai', model: 'gpt', has_key: true },
  };

  it('mounts in the lazy DRAFT state — no session minted, centered greeting', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ calls }),
    });
    await tick();
    expect(calls.some((c) => c.method === 'chat.session.create')).toBe(false);
    const thread = collectByAttr(root, CHAT_ROUTE_THREAD_ATTR)[0]!;
    expect(thread.getAttribute('data-empty')).toBe('true');
    expect(collectByAttr(root, CHAT_ROUTE_GREETING_ATTR)).toHaveLength(1);
    route.dispose();
  });

  it('lazy-creates the session on first send, titled from the first words', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ calls }),
    });
    await tick();
    await route.sendMessage('plan my week ahead');
    await tick();
    const createCall = calls.find((c) => c.method === 'chat.session.create');
    expect(createCall?.payload).toEqual({ title: 'plan my week ahead' });
    expect(calls.some((c) => c.method === 'chat.send')).toBe(true);
    expect(route.getThread().inflight?.turn_id).toBe('turn_1');
    route.dispose();
  });

  it('mints no session for a blank send', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ calls }),
    });
    await tick();
    await route.sendMessage('   ');
    await tick();
    expect(calls.some((c) => c.method === 'chat.session.create')).toBe(false);
    expect(calls.some((c) => c.method === 'chat.send')).toBe(false);
    route.dispose();
  });

  it('"New chat" while blank is a no-op (mints nothing, stays a draft)', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ calls }),
    });
    await tick();
    collectByAttr(root, CHAT_ROUTE_NEW_SESSION_ATTR)[0]!.click();
    await tick();
    expect(calls.some((c) => c.method === 'chat.session.create')).toBe(false);
    expect(collectByAttr(root, CHAT_ROUTE_GREETING_ATTR)).toHaveLength(1);
    route.dispose();
  });

  it('docks the composer once the conversation starts (centered → docked)', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn(),
    });
    await tick();
    expect(
      collectByAttr(root, CHAT_ROUTE_THREAD_ATTR)[0]!.getAttribute('data-empty'),
    ).toBe('true');
    await route.sendMessage('hello there');
    await tick();
    const thread = collectByAttr(root, CHAT_ROUTE_THREAD_ATTR)[0]!;
    expect(thread.getAttribute('data-empty')).toBe('false');
    expect(collectByAttr(root, CHAT_ROUTE_GREETING_ATTR)).toHaveLength(0);
    route.dispose();
  });

  it('lists configured slots (by role) + free pool, seeded from the global default', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ defaultSourceId: 'free_pool', llmConfig: byokAndFreeConfig }),
    });
    await tick();
    await tick();
    const select = collectByAttr(root, CHAT_ROUTE_MODEL_PICKER_ATTR)[0]!;
    // Slot labeled by role + provider; free pool; NO "local"/"byok" jargon.
    expect(select.children.map((c) => c.textContent)).toEqual([
      'Fast · anthropic',
      'Free pool',
    ]);
    expect(select.value).toBe('free_pool'); // seeded from the global default
    route.dispose();
  });

  it('renders the picker AS the "Configure LLM →" link when no source is configured', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ llmConfig: {} }),
    });
    await tick();
    expect(collectByAttr(root, CHAT_ROUTE_MODEL_PICKER_ATTR)).toHaveLength(0);
    const link = collectByAttr(root, CHAT_ROUTE_MODEL_CONFIGURE_ATTR)[0]!;
    expect(link.getAttribute('href')).toBe('#settings/ai-models');
    route.dispose();
  });

  it('persists the active session slot via set_model_pref on a picker change', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ calls, llmConfig: twoSlotConfig }),
    });
    await tick();
    await route.openSession('chat_1'); // model_routing.current = 'byok' → slot_1
    await tick();
    // Pick slot_2 (the quality/thinking slot) — its layer + slot hint persist.
    fireEvent(collectByAttr(root, CHAT_ROUTE_MODEL_PICKER_ATTR)[0]!, 'change', 'slot_2');
    await tick();
    const setCall = calls.find((c) => c.method === 'chat.session.set_model_pref');
    expect(setCall?.payload).toEqual({
      session_id: 'chat_1',
      model_pref: { current: 'byok', model_hint: 'thinking', source_id: 'slot_2' },
    });
    route.dispose();
  });

  it('applies a diverging draft slot (incl. its hint) to the new session on first send', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ calls, defaultSourceId: 'slot_1', llmConfig: twoSlotConfig }),
    });
    await tick();
    await tick();
    // Draft picker shows the first slot; diverge to slot_2 (quality/thinking).
    fireEvent(collectByAttr(root, CHAT_ROUTE_MODEL_PICKER_ATTR)[0]!, 'change', 'slot_2');
    await tick();
    await route.sendMessage('draft pick test');
    await tick();
    const setCall = calls.find((c) => c.method === 'chat.session.set_model_pref');
    expect(setCall?.payload).toEqual({
      session_id: 'chat_new',
      model_pref: { current: 'byok', model_hint: 'thinking', source_id: 'slot_2' },
    });
    route.dispose();
  });

  it('a draft with no configured slot shows a placeholder + a blank send inherits the default (no silent remote)', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      // No default source resolves to a configured option (the chosen source
      // isn't present) → the picker must NOT auto-select a remote slot.
      conn: stepConn({ calls, defaultSourceId: null, llmConfig: twoSlotConfig }),
    });
    await tick();
    await tick();
    // The picker shows a "Choose a model" placeholder — NO slot is
    // auto-selected for the inherited default.
    const select = collectByAttr(root, CHAT_ROUTE_MODEL_PICKER_ATTR)[0]!;
    expect(select.value).toBe('');
    expect(select.children[0]!.textContent).toBe('Choose a model');
    // Send WITHOUT picking → the session inherits the (fail-closed) comfort
    // default; it must NOT be silently persisted onto a different slot.
    await route.sendMessage('just send please');
    await tick();
    expect(calls.some((c) => c.method === 'chat.session.set_model_pref')).toBe(false);
    const sendCall = calls.find((c) => c.method === 'chat.send');
    expect((sendCall?.payload as { model_pref?: { current?: string } })?.model_pref?.current)
      .toBe('byok');
    route.dispose();
  });

  it('preserves typed-but-unsent text across a picker-driven re-render', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ llmConfig: byokAndFreeConfig }),
    });
    await tick();
    await tick();
    fireEvent(
      collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!,
      'input',
      'half-written thought',
    );
    fireEvent(
      collectByAttr(root, CHAT_ROUTE_MODEL_PICKER_ATTR)[0]!,
      'change',
      'free_pool',
    );
    await tick();
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe(
      'half-written thought',
    );
    route.dispose();
  });

  it('serializes a double first-send into ONE session (lazy-create lock)', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ calls }),
    });
    await tick();
    // Two sends fired back-to-back (a double click / Enter during create): the
    // second must be swallowed by the send lock, NOT mint a second session.
    const p1 = route.sendMessage('first message');
    const p2 = route.sendMessage('second message');
    await Promise.all([p1, p2]);
    await tick();
    expect(
      calls.filter((c) => c.method === 'chat.session.create'),
    ).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'chat.send')).toHaveLength(1);
    route.dispose();
  });

  it('sends from the composer Send button in the draft state', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ calls }),
    });
    await tick();
    const send = collectByAttr(root, CHAT_ROUTE_SEND_ATTR)[0]!;
    expect(send.disabled).toBe(false); // draft Send is enabled (lazy create)
    fireEvent(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!, 'input', 'via the button');
    send.click();
    await tick();
    expect(
      calls.find((c) => c.method === 'chat.session.create')?.payload,
    ).toEqual({ title: 'via the button' });
    const sendCall = calls.find((c) => c.method === 'chat.send');
    expect((sendCall?.payload as { message?: string })?.message).toBe(
      'via the button',
    );
    route.dispose();
  });

  it('runs the lazy flow in order (create → get → set_model_pref → send) carrying the picked model', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ calls, defaultSourceId: 'slot_1', llmConfig: twoSlotConfig }),
    });
    await tick();
    await tick();
    // Diverge from the default so the set_model_pref step is exercised.
    fireEvent(collectByAttr(root, CHAT_ROUTE_MODEL_PICKER_ATTR)[0]!, 'change', 'slot_2');
    await tick();
    await route.sendMessage('ordered send');
    await tick();
    const lazyMethods = calls
      .map((c) => c.method)
      .filter((m) =>
        [
          'chat.session.create',
          'chat.session.get',
          'chat.session.set_model_pref',
          'chat.send',
        ].includes(m),
      );
    expect(lazyMethods).toEqual([
      'chat.session.create',
      'chat.session.get',
      'chat.session.set_model_pref',
      'chat.send',
    ]);
    const sendCall = calls.find((c) => c.method === 'chat.send');
    expect((sendCall?.payload as { model_pref?: unknown })?.model_pref).toEqual({
      current: 'byok',
      model_hint: 'thinking',
      source_id: 'slot_2',
    });
    route.dispose();
  });

  it('"New chat" clears a draft that has typed-but-unsent text', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ calls }),
    });
    await tick();
    fireEvent(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!, 'input', 'unsent text');
    collectByAttr(root, CHAT_ROUTE_NEW_SESSION_ATTR)[0]!.click();
    await tick();
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe('');
    expect(calls.some((c) => c.method === 'chat.session.create')).toBe(false);
    route.dispose();
  });
});
