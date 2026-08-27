import { describe, expect, it, vi } from 'vitest';
import {
  type ChatDataDiagnosisContext,
  type ChatMessage,
  type ChatModelRoutingLayer,
  type ChatPlanRecord,
  type ChatSession,
  type ChatSessionSummary,
  type ContractDefinitionView,
  type ServerEvent,
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
  CONTRACTS_ROUTE_DETAIL_HEADING_ATTR,
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
  CONTRACTS_ROUTE_REVOKE_ATTR,
  CONTRACTS_ROUTE_REVOKE_CANCEL_ATTR,
  CONTRACTS_ROUTE_REVOKE_CONFIRM_ATTR,
  CONTRACTS_ROUTE_ROW_ATTR,
  CONTRACTS_ROUTE_ROW_ID_ATTR,
  CONTRACTS_ROUTE_SNIPPET_ATTR,
  CONTRACTS_ROUTE_STYLES,
  CONTRACTS_ROUTE_TAB_ATTR,
  CONTRACTS_ROUTE_TAB_BODY_ATTR,
  CONTRACTS_ROUTE_UNAVAILABLE_ATTR,
  mcpEndpointFromServerUrl,
} from '../contracts/bootstrap-contracts-route.js';
import {
  PERMISSIONS_PANEL_STYLES,
  type PermissionsMintContractCaller,
} from '../settings/permissions-panel.js';
import type { ContractsListCaller } from '../contracts/contracts-panel.js';
import {
  bootstrapChatRoute,
  CHAT_ROUTE_ACTIVATION_ACTION_ATTR,
  CHAT_ROUTE_ACTIVATION_ATTR,
  CHAT_ROUTE_ACTIVATION_CARD_ATTR,
  CHAT_ROUTE_ACTIVITY_ATTR,
  CHAT_ROUTE_ACTIVITY_ROW_ATTR,
  CHAT_ROUTE_ACTIVITY_TOGGLE_ATTR,
  CHAT_ROUTE_ANSWER_WAITING_ATTR,
  CHAT_ROUTE_AI_UNAVAILABLE_ATTR,
  CHAT_ROUTE_AI_UNAVAILABLE_ID,
  CHAT_ROUTE_COMPOSER_ACTION_ATTR,
  CHAT_ROUTE_COMPOSER_MORE_ATTR,
  CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR,
  CHAT_ROUTE_FOLLOWUP_CONTEXT_CLEAR_ATTR,
  CHAT_ROUTE_GREETING_ATTR,
  CHAT_ROUTE_HEADING_ATTR,
  CHAT_ROUTE_HISTORY_ANNOUNCER_ATTR,
  CHAT_ROUTE_HISTORY_CONTINUE_ATTR,
  CHAT_ROUTE_HISTORY_DRAFT_GUARD_ATTR,
  CHAT_ROUTE_HISTORY_EMPTY_ATTR,
  CHAT_ROUTE_HISTORY_GROUP_ATTR,
  CHAT_ROUTE_HISTORY_LANDING_ATTR,
  CHAT_ROUTE_HISTORY_SEARCH_ATTR,
  CHAT_ROUTE_INPUT_ATTR,
  CHAT_ROUTE_MESSAGE_ATTR,
  CHAT_ROUTE_MODEL_CONFIGURE_ATTR,
  CHAT_ROUTE_MODEL_PICKER_ATTR,
  CHAT_ROUTE_NEW_SESSION_ATTR,
  CHAT_ROUTE_PLAN_APPROVE_ATTR,
  CHAT_ROUTE_PLAN_CANCEL_ATTR,
  CHAT_ROUTE_PLAN_CARD_ATTR,
  CHAT_ROUTE_PLAN_CONTINUE_ATTR,
  CHAT_ROUTE_PLAN_CONTEXT_ATTR,
  CHAT_ROUTE_DATA_DIAGNOSIS_CONTEXT_ATTR,
  CHAT_ROUTE_DATA_DIAGNOSIS_CONTEXT_CLEAR_ATTR,
  CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ACTION_ATTR,
  CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
  CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_MESSAGE_ATTR,
  CHAT_ROUTE_DATA_VERIFICATION_DIAGNOSE_ATTR,
  CHAT_ROUTE_DATA_VERIFICATION_RETURN_ATTR,
  CHAT_ROUTE_ERROR_ATTR,
  CHAT_ROUTE_PLAN_RETRY_ATTR,
  CHAT_ROUTE_PLAN_RUN_ATTR,
  CHAT_ROUTE_PLAN_TARGET_ATTR,
  CHAT_ROUTE_PLAN_TARGET_MISSING_ATTR,
  CHAT_ROUTE_SEND_ATTR,
  CHAT_ROUTE_SESSION_ACTIONS_ATTR,
  CHAT_ROUTE_SESSION_DELETE_ATTR,
  CHAT_ROUTE_SESSION_DELETE_CONFIRM_ATTR,
  CHAT_ROUTE_SESSION_EXPORT_ATTR,
  CHAT_ROUTE_SESSION_ROW_ATTR,
  CHAT_ROUTE_SOURCE_ACTION_ATTR,
  CHAT_ROUTE_SOURCE_ANSWER_ACTION_ATTR,
  CHAT_ROUTE_SOURCE_ANSWER_ATTR,
  CHAT_ROUTE_SOURCE_ANSWER_RECEIPT_ATTR,
  CHAT_ROUTE_SOURCE_HANDOFF_ATTR,
  CHAT_ROUTE_SOURCE_REFERENCE_ATTR,
  CHAT_ROUTE_SOURCE_REFERENCE_ID_ATTR,
  CHAT_ROUTE_SOURCE_REFERENCE_OPEN_ATTR,
  CHAT_ROUTE_SOURCE_REFERENCES_ATTR,
  CHAT_ROUTE_SOURCE_REFERENCES_TOGGLE_ATTR,
  CHAT_ROUTE_RETURN_MISSING_ATTR,
  CHAT_ROUTE_RETURN_TARGET_ATTR,
  CHAT_ROUTE_STARTER_PROMPT,
  CHAT_ROUTE_THREAD_ATTR,
  CHAT_ROUTE_TURN_FAILURE_ATTR,
  type ChatConnectedSourcePollScheduler,
  type ChatRouteConn,
} from '../chat/bootstrap-chat-route.js';
import {
  connectedSourceStarterPrompt,
  type ChatConnectedSource,
} from '../chat/connected-source-handoff.js';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  open: boolean;
  disabled: boolean;
  checked: boolean;
  focused: boolean;
  scrolled: boolean;
  value: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(event?: FakeDomEvent) => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(
    type: string,
    fn: (event?: FakeDomEvent) => void,
  ): void;
  click(): void;
  keydown(key: string): void;
  focus(): void;
  scrollIntoView(): void;
  querySelector(selector: string): FakeEl | null;
  querySelectorAll(selector: string): FakeEl[];
  contains(candidate: FakeEl): boolean;
}

interface FakeDomEvent {
  readonly key?: string;
  readonly target?: FakeEl | null;
  preventDefault?(): void;
  stopPropagation?(): void;
}

interface FakeDoc {
  styleElements: FakeEl[];
  activeElement: FakeEl | null;
  listeners: Map<string, Array<(event?: FakeDomEvent) => void>>;
  head: { querySelector(sel: string): FakeEl | null; appendChild(el: FakeEl): FakeEl };
  createElement(tag: string): FakeEl;
  addEventListener(
    type: string,
    fn: (event?: FakeDomEvent) => void,
  ): void;
  removeEventListener(
    type: string,
    fn: (event?: FakeDomEvent) => void,
  ): void;
}

const makeFakeEl = (
  tag: string,
  onFocus: (element: FakeEl) => void = () => {},
): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    open: false,
    disabled: false,
    checked: false,
    focused: false,
    scrolled: false,
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
    removeAttribute(k) {
      el.attrs.delete(k);
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
      if (el.tagName === 'SUMMARY' && el.parent?.tagName === 'DETAILS') {
        el.parent.open = !el.parent.open;
        for (const fn of el.parent.listeners.get('toggle') ?? []) {
          fn({ target: el.parent });
        }
      }
    },
    keydown(key) {
      const event: FakeDomEvent = {
        key,
        target: el,
        preventDefault() {},
      };
      for (const fn of el.listeners.get('keydown') ?? []) fn(event);
    },
    focus() {
      el.focused = true;
      onFocus(el);
    },
    scrollIntoView() {
      el.scrolled = true;
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      const match = selector.match(/^\[([\w-]+)\]$/);
      const tag = selector.match(/^[\w-]+$/)?.[0]?.toUpperCase() ?? null;
      if (match === null && tag === null) return [];
      const attr = match?.[1] ?? null;
      const found: FakeEl[] = [];
      const visit = (candidate: FakeEl): void => {
        for (const child of candidate.children) {
          if (
            (attr !== null && child.attrs.has(attr))
            || (tag !== null && child.tagName === tag)
          ) {
            found.push(child);
          }
          visit(child);
        }
      };
      visit(el);
      return found;
    },
    contains(candidate) {
      if (candidate === el) return true;
      return el.children.some((child) => child.contains(candidate));
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDoc => {
  const styleElements: FakeEl[] = [];
  const listeners = new Map<
    string,
    Array<(event?: FakeDomEvent) => void>
  >();
  const matchSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  const doc: FakeDoc = {
    styleElements,
    listeners,
    activeElement: null,
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
    createElement: (tag) => makeFakeEl(tag, (element) => {
      doc.activeElement = element;
    }),
    addEventListener(type, fn) {
      const rows = listeners.get(type) ?? [];
      rows.push(fn);
      listeners.set(type, rows);
    },
    removeEventListener(type, fn) {
      const rows = listeners.get(type) ?? [];
      listeners.set(type, rows.filter((candidate) => candidate !== fn));
    },
  };
  return doc;
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
  it('bundles the shared credential editor styles for a cold Connect deep link', () => {
    expect(CONTRACTS_ROUTE_STYLES).toContain(PERMISSIONS_PANEL_STYLES);
    expect(CONTRACTS_ROUTE_STYLES).toContain(
      `[${CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR}] input {`,
    );
    expect(CONTRACTS_ROUTE_STYLES).toContain(
      `[${CONTRACTS_ROUTE_BACK_ATTR}] {\n  box-sizing: border-box;\n  min-height: 36px;`,
    );
    expect(CONTRACTS_ROUTE_STYLES).toContain(
      `[${CONTRACTS_ROUTE_TAB_ATTR}] {\n  box-sizing: border-box;\n  min-height: 36px;`,
    );
    expect(CONTRACTS_ROUTE_STYLES).toContain(
      `[${CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR}] {\n  box-sizing: border-box;\n  min-height: 36px;`,
    );
    expect(CONTRACTS_ROUTE_STYLES).toContain(
      `[${CONTRACTS_ROUTE_PAGE_PREVIOUS_ATTR}],\n`
      + `[${CONTRACTS_ROUTE_PAGE_NEXT_ATTR}] {\n`
      + '  box-sizing: border-box;\n  min-height: 36px;',
    );
    expect(CONTRACTS_ROUTE_STYLES).toMatch(
      /\[data-recued-contracts-route\]\s*\{[^}]*box-sizing:\s*border-box[^}]*min-width:\s*0[^}]*max-width:/s,
    );
    expect(CONTRACTS_ROUTE_STYLES).toMatch(
      /\[data-recued-contracts-row\]\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*max-width:\s*100%/s,
    );
    expect(CONTRACTS_ROUTE_STYLES).toMatch(
      /\.contracts-row-name\s*\{[^}]*flex:\s*1 1 180px[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(CONTRACTS_ROUTE_STYLES).toMatch(
      /\.contracts-detail-name\s*\{[^}]*flex:\s*1 1 180px[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(CONTRACTS_ROUTE_STYLES).toMatch(
      /\[data-recued-contracts-connect\]\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s,
    );
    expect(CONTRACTS_ROUTE_STYLES).toMatch(
      /\[data-recued-contracts-head-error\]\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(CONTRACTS_ROUTE_STYLES).toMatch(
      /\[data-recued-contracts-new-form\]\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*max-width:\s*100%/s,
    );
    expect(CONTRACTS_ROUTE_STYLES).toMatch(
      /\[data-recued-contracts-new-error\]\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(CONTRACTS_ROUTE_STYLES).toMatch(
      /\[data-recued-contracts-error\]\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/s,
    );
  });

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
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual([
      '0',
      '-1',
      '-1',
    ]);
    expect(tabs.map((tab) => tab.getAttribute('aria-controls'))).toEqual([
      'recued-contracts-list-panel',
      'recued-contracts-list-panel',
      'recued-contracts-list-panel',
    ]);
    const panel = collectByAttr(root, CONTRACTS_ROUTE_LIST_PANEL_ATTR)[0]!;
    expect(panel.getAttribute('data-tab')).toBe('built-in');
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(
      'recued-contracts-list-tab-built-in',
    );

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

  it('never renders an inverted range when an older caller ignores category filters', async () => {
    const contractsListCaller = vi.fn(async () => ({
      contracts: [agentContract()],
      total: 26,
      next_cursor: 'older-caller-page-2',
    }));
    const { root, route } = mount({ contractsListCaller });
    await route.whenLoaded();

    const status = collectByAttr(root, CONTRACTS_ROUTE_PAGE_STATUS_ATTR)[0];
    expect(status?.textContent).toBe(
      'No managed access contracts on this page',
    );
    expect(status?.textContent).not.toContain('1–0');
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

  it('navigates list -> preview -> detail tab in-page with one native Back target', async () => {
    const doc = makeFakeDocument();
    const calls: string[] = [];
    (doc as unknown as { defaultView: unknown }).defaultView = {
      history: {
        pushState: (_data: unknown, _title: string, url: string) => {
          calls.push(`push ${url}`);
        },
        replaceState: (_data: unknown, _title: string, url: string) => {
          calls.push(`replace ${url}`);
        },
      },
    };
    const root = doc.createElement('div');
    const route = bootstrapContractsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      serverUrl: 'wss://alice.example/ws',
      initialAddress: { kind: 'list', tab: 'others' },
      contractsListCaller: vi.fn(async () => ({
        contracts: [agentContract()],
        total: 1,
        next_cursor: null,
      })),
    });
    await route.whenLoaded();

    collectByAttr(root, CONTRACTS_ROUTE_ROW_ATTR)[0]!.click();
    expect(route.getSelectedContractId()).toBe('door_alpha');
    collectByAttr(root, CONTRACTS_ROUTE_TAB_ATTR)
      .find((tab) => tab.getAttribute('data-tab') === 'ops')!
      .click();
    collectByAttr(root, CONTRACTS_ROUTE_BACK_ATTR)[0]!.click();

    expect(route.getViewMode()).toBe('list');
    expect(calls).toEqual([
      'push #contracts/door_alpha',
      'replace #contracts/door_alpha/ops',
      'replace #contracts/view/others',
    ]);
    route.dispose();
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
    const { doc, root, route } = mount({
      contractsListCaller,
      initialListTab: 'others',
    });
    await route.whenLoaded();

    expect(contractsListCaller).toHaveBeenCalledWith({
      grant_kind: 'standing',
      exclude_derived_doors: true,
      limit: 25,
    });
    expect(collectByAttr(root, CONTRACTS_ROUTE_PAGE_STATUS_ATTR)[0]?.textContent)
      .toBe('Showing 1–25 of 26');

    collectByAttr(root, CONTRACTS_ROUTE_PAGE_NEXT_ATTR)[0]!.focus();
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
    expect(doc.activeElement).toBe(
      collectByAttr(root, CONTRACTS_ROUTE_PAGE_PREVIOUS_ATTR)[0],
    );

    collectByAttr(root, CONTRACTS_ROUTE_PAGE_PREVIOUS_ATTR)[0]!.click();
    await tick(10);
    expect(route.getContracts()).toHaveLength(25);
    expect(collectByAttr(root, CONTRACTS_ROUTE_PAGE_STATUS_ATTR)[0]?.textContent)
      .toBe('Showing 1–25 of 26');
    expect(doc.activeElement).toBe(
      collectByAttr(root, CONTRACTS_ROUTE_PAGE_NEXT_ATTR)[0],
    );
    route.dispose();
  });

  it('keeps the requested page action focused and single-flight while loading', async () => {
    const firstPage = Array.from({ length: 25 }, (_, index) =>
      agentContract({
        contract_id: `door_${String(index + 1).padStart(2, '0')}`,
        display_name: `Agent ${index + 1}`,
      }));
    let resolveNext!: (value: {
      contracts: ReadonlyArray<ContractDefinitionView>;
      next_cursor: null;
      total: number;
    }) => void;
    const nextPage = new Promise<{
      contracts: ReadonlyArray<ContractDefinitionView>;
      next_cursor: null;
      total: number;
    }>((resolve) => {
      resolveNext = resolve;
    });
    const contractsListCaller = vi.fn<ContractsListCaller>((args) =>
      args?.cursor === 'page-2'
        ? nextPage
        : Promise.resolve({
            contracts: firstPage,
            next_cursor: 'page-2',
            total: 26,
          }));
    const { doc, root, route } = mount({
      contractsListCaller,
      initialListTab: 'others',
    });
    await route.whenLoaded();

    const initialNext = collectByAttr(root, CONTRACTS_ROUTE_PAGE_NEXT_ATTR)[0]!;
    initialNext.focus();
    initialNext.click();
    await tick();

    const pendingNext = collectByAttr(root, CONTRACTS_ROUTE_PAGE_NEXT_ATTR)[0]!;
    expect(pendingNext.textContent).toBe('Loading…');
    expect(pendingNext.getAttribute('aria-disabled')).toBe('true');
    expect(pendingNext.getAttribute('aria-busy')).toBe('true');
    expect(pendingNext.getAttribute('disabled')).toBeNull();
    expect(doc.activeElement).toBe(pendingNext);
    pendingNext.click();
    expect(contractsListCaller).toHaveBeenCalledTimes(2);

    resolveNext({
      contracts: [agentContract({ contract_id: 'door_26' })],
      next_cursor: null,
      total: 26,
    });
    await tick(10);
    expect(doc.activeElement).toBe(
      collectByAttr(root, CONTRACTS_ROUTE_PAGE_PREVIOUS_ATTR)[0],
    );
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

    it('preserves the changed door input through busy and settled paints', async () => {
      let resolveDoorWrite!: (value: ContractDefinitionView) => void;
      const doorWrite = new Promise<ContractDefinitionView>((resolve) => {
        resolveDoorWrite = resolve;
      });
      const grantSetDoorTypesCaller = vi.fn(() => doorWrite);
      const { doc, root, route } = mount({
        contractsListCaller: vi.fn(async () => ({
          contracts: [agentContract()],
        })),
        grantSetDoorTypesCaller,
        initialContractId: 'door_alpha',
      });
      await route.whenLoaded();

      const mcpLabel = collectByAttr(root, CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR)
        .find((label) => label.getAttribute('data-door') === 'mcp')!;
      const mcpInput = collectByTag(mcpLabel, 'input')[0]!;
      mcpInput.focus();
      for (const listener of mcpInput.listeners.get('change') ?? []) listener();

      expect(grantSetDoorTypesCaller).toHaveBeenCalledTimes(1);
      let replacement = collectByAttr(root, CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR)
        .find((label) => label.getAttribute('data-door') === 'mcp')!;
      let replacementInput = collectByTag(replacement, 'input')[0]!;
      expect(replacementInput.getAttribute('aria-disabled')).toBe('true');
      expect(replacementInput.getAttribute('aria-busy')).toBe('true');
      expect(doc.activeElement).toBe(replacementInput);
      expect(replacementInput.listeners.get('change') ?? []).toHaveLength(0);

      resolveDoorWrite(agentContract({
        door_types: ['mcp_chat', 'llm_gateway'],
      }));
      await tick(8);
      replacement = collectByAttr(root, CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR)
        .find((label) => label.getAttribute('data-door') === 'mcp')!;
      replacementInput = collectByTag(replacement, 'input')[0]!;
      expect(replacementInput.checked).toBe(false);
      expect(doc.activeElement).toBe(replacementInput);

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
    const { doc, root, route } = mount({
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
    const detailHeading = collectByAttr(
      root,
      CONTRACTS_ROUTE_DETAIL_HEADING_ATTR,
    )[0]!;
    expect(detailHeading.tagName).toBe('H2');
    expect(detailHeading.getAttribute(CONTRACTS_ROUTE_DETAIL_HEADING_ATTR))
      .toBe('door_alpha');
    expect(detailHeading.getAttribute('tabindex')).toBe('-1');
    expect(doc.activeElement).toBe(detailHeading);
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

  it('carries Back focus to the exact row across a same-document remount', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const detail = bootstrapContractsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      serverUrl: 'wss://alice.example/ws',
      initialContractId: 'user_self',
    });
    await detail.whenLoaded();

    collectByAttr(root, CONTRACTS_ROUTE_BACK_ATTR)[0]!.click();
    detail.dispose();

    const list = bootstrapContractsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      serverUrl: 'wss://alice.example/ws',
      contractsListCaller: vi.fn(async () => ({
        contracts: [],
        total: 0,
        next_cursor: null,
      })),
    });
    await list.whenLoaded();

    const owner = collectByAttr(root, CONTRACTS_ROUTE_ROW_ATTR).find((row) =>
      row.getAttribute(CONTRACTS_ROUTE_ROW_ID_ATTR) === 'user_self',
    );
    expect(doc.activeElement).toBe(owner);

    list.dispose();
  });

  it('keeps revoke confirmation and completion keyboard-owned', async () => {
    let resolveRevoke!: (value: ContractDefinitionView) => void;
    const revokeResult = new Promise<ContractDefinitionView>((resolve) => {
      resolveRevoke = resolve;
    });
    const contractsRevokeCaller = vi.fn(() => revokeResult);
    const { doc, root, route } = mount({
      contractsListCaller: vi.fn(async () => ({
        contracts: [agentContract()],
      })),
      contractsRevokeCaller,
      initialContractId: 'door_alpha',
    });
    await route.whenLoaded();

    let revoke = collectByAttr(root, CONTRACTS_ROUTE_REVOKE_ATTR)[0]!;
    revoke.focus();
    revoke.click();
    let confirm = collectByAttr(
      root,
      CONTRACTS_ROUTE_REVOKE_CONFIRM_ATTR,
    )[0]!;
    expect(doc.activeElement).toBe(confirm);

    const cancel = collectByAttr(root, CONTRACTS_ROUTE_REVOKE_CANCEL_ATTR)[0]!;
    cancel.focus();
    cancel.click();
    revoke = collectByAttr(root, CONTRACTS_ROUTE_REVOKE_ATTR)[0]!;
    expect(doc.activeElement).toBe(revoke);

    revoke.click();
    confirm = collectByAttr(root, CONTRACTS_ROUTE_REVOKE_CONFIRM_ATTR)[0]!;
    confirm.click();
    expect(contractsRevokeCaller).toHaveBeenCalledTimes(1);
    const busy = collectByAttr(root, CONTRACTS_ROUTE_REVOKE_ATTR)[0]!;
    expect(busy.textContent).toBe('Revoking…');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(doc.activeElement).toBe(busy);
    expect(route.hasInFlightWork()).toBe(true);
    expect(route.inFlightWorkPrompt()).toBe(
      'A contract action is still in progress. Leave Contracts anyway?',
    );

    resolveRevoke(agentContract({ lifecycle_state: 'revoked' }));
    await tick(8);
    expect(route.hasInFlightWork()).toBe(false);
    expect(route.inFlightWorkPrompt()).toBeNull();
    expect(collectByAttr(root, CONTRACTS_ROUTE_REVOKE_ATTR)).toHaveLength(0);
    expect(doc.activeElement).toBe(
      collectByAttr(root, CONTRACTS_ROUTE_DETAIL_HEADING_ATTR)[0],
    );
    expect(allText(root)).toContain('Revoked');

    route.dispose();
  });

  it('self DETAIL has no Connect tab (Ops/Entities/Recipes) and switches tabs on click', async () => {
    const { root, route } = mount({ initialContractId: 'user_self' });
    await route.whenLoaded();
    expect(route.getViewMode()).toBe('detail');

    const tabs = collectByAttr(root, CONTRACTS_ROUTE_TAB_ATTR);
    // D-247 — the owner gains Recipes; a door does not (its recipe authority is
    // its inbound token, not the `recipe.*` axis).
    expect(tabs.map((t) => t.getAttribute('data-tab'))).toEqual(['ops', 'entities', 'recipes']);
    expect(route.getActiveTab()).toBe('ops');
    expect(tabs[0]!.getAttribute('tabindex')).toBe('0');
    expect(tabs[1]!.getAttribute('tabindex')).toBe('-1');

    tabs[1]!.click();
    expect(route.getActiveTab()).toBe('entities');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('false');
    expect(tabs[1]!.getAttribute('tabindex')).toBe('0');
    expect(tabs[0]!.getAttribute('tabindex')).toBe('-1');
    const tabBody = collectByAttr(root, CONTRACTS_ROUTE_TAB_BODY_ATTR)[0]!;
    expect(tabBody.getAttribute('role')).toBe('tabpanel');
    expect(tabs[1]!.getAttribute('aria-controls')).toBe(tabBody.getAttribute('id'));
    expect(tabBody.getAttribute('aria-labelledby')).toBe(tabs[1]!.getAttribute('id'));
    expect(allText(collectByAttr(root, CONTRACTS_ROUTE_TAB_BODY_ATTR)[0]!)).toContain(
      'enrichment topics',
    );
  });

  it('gives DETAIL tabs one keyboard stop with wraparound and Home/End activation', async () => {
    const { doc, root, route } = mount({ initialContractId: 'user_self' });
    await route.whenLoaded();
    const tabs = collectByAttr(root, CONTRACTS_ROUTE_TAB_ATTR);

    // D-247 — the self contract is now ops / entities / RECIPES, so the
    // wraparound is over THREE stops. ⚠ Written off `tabs.length` rather than
    // re-hardcoding 3: this test is about the roving-tabindex behaviour, and a
    // pinned count makes the next tab addition edit an assertion that was never
    // about the count.
    const last = tabs.length - 1;
    tabs[0]!.keydown('ArrowRight');
    expect(route.getActiveTab()).toBe('entities');
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(doc.activeElement).toBe(tabs[1]);

    // Right from the LAST stop wraps to the first.
    tabs[last]!.keydown('ArrowRight');
    expect(route.getActiveTab()).toBe('ops');
    expect(doc.activeElement).toBe(tabs[0]);

    tabs[0]!.keydown('End');
    expect(route.getActiveTab()).toBe(tabs[last]!.getAttribute('data-tab'));
    tabs[last]!.keydown('Home');
    expect(route.getActiveTab()).toBe('ops');
    route.dispose();
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
    const opener = collectByAttr(root, CONTRACTS_ROUTE_NEW_BUTTON_ATTR)[0]!;
    expect(opener.textContent).toBe('+ New contract');
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(opener.getAttribute('aria-controls')).toBe(
      'recued-contracts-new-contract-form',
    );
    expect(collectByAttr(root, CONTRACTS_ROUTE_NEW_FORM_ATTR)).toHaveLength(0);
    opener.click();
    const form = collectByAttr(root, CONTRACTS_ROUTE_NEW_FORM_ATTR)[0]!;
    const name = collectByAttr(root, CONTRACTS_ROUTE_NEW_NAME_ATTR)[0]!;
    expect(form.getAttribute('role')).toBe('group');
    expect(form.getAttribute('aria-label')).toBe('New contract');
    expect(opener.textContent).toBe('Cancel new contract');
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(name.focused).toBe(true);
    opener.click();
    expect(collectByAttr(root, CONTRACTS_ROUTE_NEW_FORM_ATTR)).toHaveLength(0);
    expect(opener.textContent).toBe('+ New contract');
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    opener.click();

    name.value = 'Codex bot';
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

  it('keeps a slow contract mint focused, announced, and single-flight', async () => {
    const minted = agentContract({
      contract_id: 'door_slow',
      display_name: 'Slow contract',
    });
    let resolveMint!: (value: ContractDefinitionView) => void;
    const mint = new Promise<ContractDefinitionView>((resolve) => {
      resolveMint = resolve;
    });
    const permissionsMintContractCaller = vi.fn<PermissionsMintContractCaller>(
      () => mint,
    );
    const navigated: string[] = [];
    const { doc, root, route } = mount({
      contractsListCaller: vi.fn(async () => ({ contracts: [] })),
      permissionsMintContractCaller,
      navigate: (hash: string) => navigated.push(hash),
      initialListTab: 'others',
    });
    await route.whenLoaded();

    const opener = collectByAttr(root, CONTRACTS_ROUTE_NEW_BUTTON_ATTR)[0]!;
    opener.click();
    collectByAttr(root, CONTRACTS_ROUTE_NEW_NAME_ATTR)[0]!.value = 'Slow contract';
    const submit = collectByAttr(root, CONTRACTS_ROUTE_NEW_SUBMIT_ATTR)[0]!;
    submit.focus();
    submit.click();
    await tick();

    expect(permissionsMintContractCaller).toHaveBeenCalledTimes(1);
    expect(submit.textContent).toBe('Creating…');
    expect(submit.disabled).toBe(false);
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    expect(submit.getAttribute('aria-busy')).toBe('true');
    expect(opener.getAttribute('aria-disabled')).toBe('true');
    expect(doc.activeElement).toBe(submit);

    submit.click();
    opener.click();
    await tick();
    expect(permissionsMintContractCaller).toHaveBeenCalledTimes(1);
    expect(collectByAttr(root, CONTRACTS_ROUTE_NEW_FORM_ATTR)).toHaveLength(1);

    resolveMint(minted);
    await tick();
    expect(navigated).toEqual(['#contracts/door_slow/connect']);
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
    expect(collectByAttr(root, CONTRACTS_ROUTE_NEW_ERROR_ATTR)[0]!
      .getAttribute('role')).toBe('alert');
    expect(collectByAttr(root, CONTRACTS_ROUTE_NEW_NAME_ATTR)[0]!.focused)
      .toBe(true);
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
    expect(submit.getAttribute('aria-disabled')).toBeNull();
    expect(submit.getAttribute('aria-busy')).toBeNull();
    expect(submit.focused).toBe(true);
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
    const snippets = collectByAttr(root, CONTRACTS_ROUTE_SNIPPET_ATTR);
    expect(snippets).toHaveLength(4);
    expect(snippets.map((snippet) => snippet.children[0]?.tagName)).toEqual([
      'H3',
      'H3',
      'H3',
      'H3',
    ]);
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

const sessionSummary = (
  overrides: Partial<ChatSessionSummary> = {},
): ChatSessionSummary => ({
  id: 'chat_1',
  title: 'Ops chat',
  created_at: 1_000,
  last_active_at: 2_000,
  message_count: 1,
  archived: false,
  picker_state: { current: 'self' },
  model_routing: { current: 'byok', provider: 'local', overridden: false },
  ...overrides,
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
    // Open a session and enter a real message so the AI-unavailable state is
    // the only remaining reason Send stays disabled.
    await route.openSession('chat_1');
    await tick();
    const input = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    input.value = 'Ask about this account';
    for (const listener of input.listeners.get('input') ?? []) listener();

    const notice = collectByAttr(root, CHAT_ROUTE_AI_UNAVAILABLE_ATTR);
    expect(notice).toHaveLength(1);
    expect(notice[0]!.getAttribute('id')).toBe(CHAT_ROUTE_AI_UNAVAILABLE_ID);
    const link = notice[0]!.children.find((child) => child.tagName === 'A');
    expect(link?.getAttribute('href')).toBe(
      '#settings/ai-models/setup/session/chat_1',
    );
    expect(allText(root)).toContain('Set up Chat');

    const send = collectByAttr(root, CHAT_ROUTE_SEND_ATTR)[0]!;
    expect(send.disabled).toBe(true);
    expect(send.getAttribute('title')).toContain('No AI model');
    expect(send.getAttribute('aria-describedby')).toBe(
      CHAT_ROUTE_AI_UNAVAILABLE_ID,
    );

    route.dispose();
  });

  it('hides the affordance and enables a real message once a BYOK slot is configured', async () => {
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
    expect(send.disabled).toBe(true);
    const input = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    input.value = 'Ask about this account';
    for (const listener of input.listeners.get('input') ?? []) listener();
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
    expect(link?.getAttribute('href')).toBe(
      '#settings/ai-models/setup/session/chat_1',
    );
    expect(link?.textContent).toBe('Set up Chat →');

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
      messages?: ChatMessage[] | ((sessionGetCall: number) => ChatMessage[]);
      plans?: ChatPlanRecord[] | ((sessionGetCall: number) => ChatPlanRecord[]);
      sendAck?: {
        turn_id: string;
        data_diagnosis?: ChatDataDiagnosisContext;
      };
      resolveDiagnosis?: (
        payload: {
          session_id: string;
          message_id: string;
          status: 'resolved' | 'still_uncertain' | 'needs_new_action';
        },
      ) => {
        resolution: {
          status: 'resolved' | 'still_uncertain' | 'needs_new_action';
          resolved_at: number;
        };
      } | Promise<{
        resolution: {
          status: 'resolved' | 'still_uncertain' | 'needs_new_action';
          resolved_at: number;
        };
      }>;
    } = {},
  ): ChatRouteConn => {
    const llmConfig = config.llmConfig ?? {
      slot_1: { provider: 'anthropic', model: 'claude-opus', has_key: true },
    };
    const defaultSourceId = config.defaultSourceId ?? null;
    const sessions = config.sessions ?? [];
    let sessionGetCalls = 0;
    return (async (method: string, payload?: unknown) => {
      config.calls?.push({ method, payload });
      if (method === 'chat.sessions.list') return { sessions };
      if (method === 'chat.session.get') {
        sessionGetCalls += 1;
        const sid =
          (payload as { session_id?: string } | undefined)?.session_id
          ?? 'chat_new';
        return {
          ...chatSession(),
          id: sid,
          messages:
            typeof config.messages === 'function'
              ? config.messages(sessionGetCalls)
              : config.messages ?? [],
          plans:
            typeof config.plans === 'function'
              ? config.plans(sessionGetCalls)
              : config.plans ?? [],
        };
      }
      if (method === 'chat.session.create') return { session_id: 'chat_new' };
      if (method === 'chat.send') {
        return config.sendAck ?? { turn_id: 'turn_1' };
      }
      if (method === 'chat.data_diagnosis.resolve') {
        const args = payload as {
          session_id: string;
          message_id: string;
          status: 'resolved' | 'still_uncertain' | 'needs_new_action';
        };
        return config.resolveDiagnosis?.(args) ?? {
          resolution: { status: args.status, resolved_at: 9_000 },
        };
      }
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

  const approvedPlanRecord = (
    overrides: Partial<ChatPlanRecord> = {},
  ): ChatPlanRecord => ({
    plan: {
      plan_id: 'plan_approved',
      session_id: 'chat_1',
      turn_id: 'turn_action',
      tool: 'mail.send',
      tier: 2,
      classification: 'write',
      args: { to: 'mary@example.com', subject: 'Hello' },
      args_hash: 'hash-approved',
      status: 'approved',
      created_at: 1_700_000_000_000,
      resolved_at: 1_700_000_001_000,
    },
    message_id: 'msg_action',
    payload_available: true,
    ...overrides,
  });

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
    expect(thread.getAttribute('aria-label')).toBe('Chat conversation');
    const greeting = collectByAttr(root, CHAT_ROUTE_GREETING_ATTR);
    expect(greeting).toHaveLength(1);
    expect(greeting[0]!.tagName).toBe('H2');
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!
      .getAttribute('aria-label')).toBe('Message to Recued');
    route.dispose();
  });

  it('turns the first empty Chat landing into three outcome-led paths', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ calls }),
      enableFirstRunActivation: true,
    });
    await tick();

    const activation = collectByAttr(root, CHAT_ROUTE_ACTIVATION_ATTR)[0]!;
    expect(activation).toBeDefined();
    expect(allText(activation)).toContain('Start here');
    expect(collectByAttr(root, CHAT_ROUTE_ACTIVATION_CARD_ATTR).map(
      (card) => card.getAttribute(CHAT_ROUTE_ACTIVATION_CARD_ATTR),
    )).toEqual(['ask', 'connect', 'automate']);
    expect(collectByAttr(activation, 'role').filter(
      (node) => node.getAttribute('role') === 'status',
    )).toHaveLength(1);
    expect(collectByAttr(root, CHAT_ROUTE_GREETING_ATTR)).toHaveLength(0);

    const connect = collectByAttr(root, CHAT_ROUTE_ACTIVATION_ACTION_ATTR).find(
      (action) => action.getAttribute(CHAT_ROUTE_ACTIVATION_ACTION_ATTR) === 'connect',
    );
    expect(connect?.getAttribute('href')).toBe('#connections');

    const ask = collectByAttr(root, CHAT_ROUTE_ACTIVATION_ACTION_ATTR).find(
      (action) => action.getAttribute(CHAT_ROUTE_ACTIVATION_ACTION_ATTR) === 'ask',
    )!;
    ask.click();
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe(
      CHAT_ROUTE_STARTER_PROMPT,
    );
    expect(calls.some((call) => call.method === 'chat.send')).toBe(false);
    expect(calls.some((call) => call.method === 'chat.session.create')).toBe(false);
    route.dispose();
  });

  it('makes missing Chat setup the first-run card action', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ llmConfig: {} }),
      enableFirstRunActivation: true,
    });
    await tick();

    const ask = collectByAttr(root, CHAT_ROUTE_ACTIVATION_ACTION_ATTR).find(
      (action) => action.getAttribute(CHAT_ROUTE_ACTIVATION_ACTION_ATTR) === 'ask',
    );
    expect(ask?.textContent).toBe('Set up chat');
    expect(ask?.getAttribute('href')).toBe('#settings/ai-models/setup/start');
    expect(collectByAttr(root, CHAT_ROUTE_SEND_ATTR)[0]!.getAttribute(
      'aria-describedby',
    )).toBe(CHAT_ROUTE_AI_UNAVAILABLE_ID);
    expect(collectByTag(root, 'span').some(
      (node) => node.getAttribute('id') === CHAT_ROUTE_AI_UNAVAILABLE_ID,
    )).toBe(true);
    route.dispose();
  });

  it('seeds the starter prompt on the setup return path, but not for returning chat history', async () => {
    const emptyDoc = makeFakeDocument();
    const emptyRoot = emptyDoc.createElement('div');
    const emptyRoute = bootstrapChatRoute({
      root: emptyRoot as unknown as HTMLElement,
      document: emptyDoc as unknown as Document,
      conn: stepConn(),
      enableFirstRunActivation: true,
      initialStarterPrompt: true,
    });
    await tick();
    expect(collectByAttr(emptyRoot, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe(
      CHAT_ROUTE_STARTER_PROMPT,
    );
    expect(emptyRoute.hasUnsavedChanges()).toBe(false);
    emptyRoute.dispose();

    const returningDoc = makeFakeDocument();
    const returningRoot = returningDoc.createElement('div');
    const returningRoute = bootstrapChatRoute({
      root: returningRoot as unknown as HTMLElement,
      document: returningDoc as unknown as Document,
      conn: stepConn({ sessions: [sessionSummary()] }),
      enableFirstRunActivation: true,
      initialStarterPrompt: true,
    });
    await tick();
    expect(collectByAttr(returningRoot, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe('');
    returningRoute.dispose();
  });

  it('turns a ready connected source into a focused first question without sending it', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const connectedSource: ChatConnectedSource = {
      lane: 'mail',
      providerId: 'gmail',
      slug: 'work',
    };
    const statusCaller = vi.fn(async () => ({
      state: 'ready' as const,
      identity: 'person@example.com',
      authState: 'healthy' as const,
      lastSyncedAt: 1_700_000_000_000,
    }));
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ calls }),
      enableFirstRunActivation: true,
      initialConnectedSource: connectedSource,
      connectedSourceStatusCaller: statusCaller,
    });
    await tick(8);

    const handoff = collectByAttr(root, CHAT_ROUTE_SOURCE_HANDOFF_ATTR)[0]!;
    expect(handoff.getAttribute('data-state')).toBe('ready');
    expect(allText(handoff)).toContain('Gmail is ready for Chat');
    expect(allText(handoff)).toContain('person@example.com');
    expect(collectByAttr(root, CHAT_ROUTE_ACTIVATION_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe(
      connectedSourceStarterPrompt(connectedSource),
    );
    expect(calls.some((call) => call.method === 'chat.send')).toBe(false);
    expect(calls.some((call) => call.method === 'chat.session.create')).toBe(false);
    expect(statusCaller).toHaveBeenCalledTimes(1);
    route.dispose();
  });

  it('waits for first sync without overwriting a question the owner started', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const scheduled: Array<() => void> = [];
    const connectedSourcePoll: ChatConnectedSourcePollScheduler = {
      schedule: vi.fn((handler) => {
        scheduled.push(handler);
        return () => {};
      }),
    };
    let ready = false;
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn(),
      initialConnectedSource: {
        lane: 'mail',
        providerId: 'gmail',
        slug: 'work',
      },
      connectedSourceStatusCaller: vi.fn(async () => ready
        ? {
            state: 'ready' as const,
            identity: 'person@example.com',
            authState: 'healthy' as const,
            lastSyncedAt: 1_700_000_000_000,
          }
        : {
            state: 'pending' as const,
            identity: 'person@example.com',
            authState: 'healthy' as const,
            lastSyncedAt: null,
          }),
      connectedSourcePoll,
    });
    await tick(8);

    expect(collectByAttr(root, CHAT_ROUTE_SOURCE_HANDOFF_ATTR)[0]!
      .getAttribute('data-state')).toBe('pending');
    const input = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    expect(input.value).toBe('');
    fireEvent(input, 'input', 'Keep the question I already started.');

    ready = true;
    scheduled.shift()!();
    await tick(8);
    expect(collectByAttr(root, CHAT_ROUTE_SOURCE_HANDOFF_ATTR)[0]!
      .getAttribute('data-state')).toBe('ready');
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe(
      'Keep the question I already started.',
    );
    route.dispose();
  });

  it('keeps an explicit source check focused until readiness', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const readyStatus = {
      state: 'ready' as const,
      identity: 'person@example.com',
      authState: 'healthy' as const,
      lastSyncedAt: 1_700_000_000_000,
    };
    let settleReady!: (status: typeof readyStatus) => void;
    const pendingReady = new Promise<typeof readyStatus>((resolve) => {
      settleReady = resolve;
    });
    let statusReads = 0;
    const statusCaller = vi.fn(() => {
      statusReads += 1;
      if (statusReads === 1) {
        return Promise.resolve({
          state: 'pending' as const,
          identity: 'person@example.com',
          authState: 'healthy' as const,
          lastSyncedAt: null,
        });
      }
      return pendingReady;
    });
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn(),
      initialConnectedSource: {
        lane: 'mail',
        providerId: 'gmail',
        slug: 'work',
      },
      connectedSourceStatusCaller: statusCaller,
    });
    await tick(8);

    const check = collectByAttr(
      root,
      CHAT_ROUTE_SOURCE_ACTION_ATTR,
    ).find((action) => action.textContent === 'Check now')!;
    check.focus();
    check.click();
    await tick();

    const checking = collectByAttr(
      root,
      CHAT_ROUTE_SOURCE_ACTION_ATTR,
    ).find((action) => action.textContent === 'Checking…')!;
    expect(checking.disabled).toBe(false);
    expect(checking.getAttribute('aria-disabled')).toBe('true');
    expect(checking.getAttribute('aria-busy')).toBe('true');
    expect(checking.focused).toBe(true);
    expect(doc.activeElement).toBe(checking);
    checking.click();
    checking.click();
    expect(statusCaller).toHaveBeenCalledTimes(2);

    settleReady(readyStatus);
    await tick(8);
    const review = collectByAttr(
      root,
      CHAT_ROUTE_SOURCE_ACTION_ATTR,
    ).find((action) => action.textContent === 'Review first question')!;
    expect(review.focused).toBe(true);
    expect(doc.activeElement).toBe(review);
    expect(collectByAttr(root, CHAT_ROUTE_SOURCE_HANDOFF_ATTR)[0]!
      .getAttribute('data-state')).toBe('ready');

    route.dispose();
  });

  it('recovers a failed initial status read and retries the source handoff', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const scheduled: Array<() => void> = [];
    const connectedSourcePoll: ChatConnectedSourcePollScheduler = {
      schedule: vi.fn((handler) => {
        scheduled.push(handler);
        return () => {};
      }),
    };
    const statusCaller = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({
        state: 'ready' as const,
        identity: 'person@example.com',
        authState: 'healthy' as const,
        lastSyncedAt: 1_700_000_000_000,
      });
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn(),
      initialConnectedSource: {
        lane: 'mail',
        providerId: 'gmail',
        slug: 'work',
      },
      connectedSourceStatusCaller: statusCaller,
      connectedSourcePoll,
    });
    await tick(8);

    expect(collectByAttr(root, CHAT_ROUTE_SOURCE_HANDOFF_ATTR)[0]!
      .getAttribute('data-state')).toBe('unknown');
    expect(allText(collectByAttr(root, CHAT_ROUTE_SOURCE_HANDOFF_ATTR)[0]!))
      .toContain('Status unavailable');
    expect(scheduled).toHaveLength(1);

    scheduled.shift()!();
    await tick(8);
    expect(collectByAttr(root, CHAT_ROUTE_SOURCE_HANDOFF_ATTR)[0]!
      .getAttribute('data-state')).toBe('ready');
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toContain(
      'Using my work mailbox',
    );
    expect(statusCaller).toHaveBeenCalledTimes(2);
    route.dispose();
  });

  it('retires dismissed source context without re-showing first-run onboarding', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const onConnectedSourceRetired = vi.fn();
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn(),
      enableFirstRunActivation: true,
      initialConnectedSource: {
        lane: 'mail',
        providerId: 'gmail',
        slug: 'work',
      },
      connectedSourceStatusCaller: vi.fn(async () => ({
        state: 'ready' as const,
        identity: 'person@example.com',
        authState: 'healthy' as const,
        lastSyncedAt: 1_700_000_000_000,
      })),
      onConnectedSourceRetired,
    });
    await tick(8);

    const dismiss = collectByAttr(root, CHAT_ROUTE_SOURCE_ACTION_ATTR).find(
      (action) => action.textContent === 'Use Chat without this account',
    )!;
    fireEvent(
      collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!,
      'input',
      'Keep my own question.',
    );
    fireEvent(dismiss, 'click');

    expect(onConnectedSourceRetired).toHaveBeenCalledTimes(1);
    expect(collectByAttr(root, CHAT_ROUTE_SOURCE_HANDOFF_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CHAT_ROUTE_ACTIVATION_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe(
      'Keep my own question.',
    );
    route.dispose();
  });

  it('keeps source context through the first answer and a context-only follow-up', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const retired = vi.fn();
    const listeners = new Map<string, Array<(event: never) => void>>();
    const publish = (event: { kind: string } & Record<string, unknown>): void => {
      for (const listener of listeners.get(event.kind) ?? []) {
        listener(event as never);
      }
    };
    let sentTurns = 0;
    let rejectNextSend = false;
    const baseConn = stepConn({ calls }) as unknown as (
      method: string,
      payload?: unknown,
    ) => Promise<unknown>;
    const conn = (async (method: string, payload?: unknown) => {
      if (method === 'chat.send') {
        calls.push({ method, payload });
        if (rejectNextSend) throw new Error('send unavailable');
        sentTurns += 1;
        return { turn_id: `turn_${sentTurns}` };
      }
      return baseConn(method, payload);
    }) as ChatRouteConn;
    const source: ChatConnectedSource = {
      lane: 'mail',
      providerId: 'gmail',
      slug: 'work',
    };
    const question = connectedSourceStarterPrompt(source);
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialConnectedSource: source,
      connectedSourceStatusCaller: vi.fn(async () => ({
        state: 'ready' as const,
        identity: 'person@example.com',
        authState: 'healthy' as const,
        lastSyncedAt: 1_700_000_000_000,
      })),
      onConnectedSourceRetired: retired,
      subscribe: ((kind: string, listener: (event: never) => void) => {
        const rows = listeners.get(kind) ?? [];
        rows.push(listener);
        listeners.set(kind, rows);
        return () => {};
      }) as never,
    });
    await tick(8);
    await route.sendMessage(question);
    await tick(8);

    expect(retired).toHaveBeenCalledTimes(1);
    expect(collectByAttr(root, CHAT_ROUTE_SOURCE_HANDOFF_ATTR)).toHaveLength(0);
    let answer = collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR)[0]!;
    expect(answer.getAttribute('data-state')).toBe('preparing');
    expect(allText(answer)).toContain('Gmail · person@example.com');
    expect(collectByAttr(answer, CHAT_ROUTE_SOURCE_ANSWER_RECEIPT_ATTR)[0]!
      .textContent).toBe('Checking activity');
    expect(collectByAttr(root, CHAT_ROUTE_MESSAGE_ATTR).some(
      (row) => row.getAttribute('data-role') === 'user'
        && allText(row).includes(question),
    )).toBe(true);
    expect(collectByAttr(root, CHAT_ROUTE_ANSWER_WAITING_ATTR)[0]!
      .textContent).toBe('Preparing your answer…');

    publish({
      kind: 'chat.tool_call_started',
      session_id: 'chat_new',
      turn_id: 'turn_1',
      tool_name: 'mail.search',
      tier: 1,
      args: { query: 'attention' },
      cursor: 1,
    });
    await tick();
    answer = collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR)[0]!;
    expect(answer.getAttribute('data-state')).toBe('searching');
    expect(collectByAttr(root, CHAT_ROUTE_ANSWER_WAITING_ATTR)[0]!
      .textContent).toBe('Searching connected mail…');

    publish({
      kind: 'chat.tool_call_completed',
      session_id: 'chat_new',
      turn_id: 'turn_1',
      tool_name: 'mail.search',
      tier: 1,
      status: 'ok',
      result_ref: 'chat_new:turn_1:mail.search',
      cursor: 2,
    });
    await tick();
    expect(collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR)[0]!
      .getAttribute('data-state')).toBe('reviewing');
    expect(collectByAttr(root, CHAT_ROUTE_ANSWER_WAITING_ATTR)[0]!
      .textContent).toBe('Reviewing the mail search…');

    publish({
      kind: 'chat.message_complete',
      session_id: 'chat_new',
      turn_id: 'turn_1',
      final: {
        ...chatMessage(),
        id: 'msg_source_answer',
        session_id: 'chat_new',
        content: 'Three messages need your attention.',
        tool_calls: [{
          tool_name: 'mail.search',
          tier: 1,
          args: { query: 'attention' },
          status: 'ok',
          result_ref: 'chat_new:turn_1:mail.search',
          started_at: 1_000,
          completed_at: 1_100,
        }],
        provenance: [
          {
            source: 'local',
            collection_platform: 'mail',
            collection_slug: 'work',
            record_id: 'mail-1',
            label: 'Quarterly planning',
          },
          {
            source: 'local',
            collection_platform: 'mail',
            collection_slug: 'work',
            record_id: 'mail-2',
            label: 'Launch readiness',
          },
          {
            source: 'hubspot',
            label: 'Account timeline',
          },
        ],
      },
      cursor: 3,
    });
    await tick(8);

    answer = collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR)[0]!;
    expect(answer.getAttribute('data-state')).toBe('search_complete');
    expect(collectByAttr(answer, CHAT_ROUTE_SOURCE_ANSWER_RECEIPT_ATTR)[0]!
      .textContent).toBe('Mail search completed');
    expect(allText(answer)).toContain(
      'The receipt does not show which records, if any, informed the answer.',
    );
    let references = collectByAttr(answer, CHAT_ROUTE_SOURCE_REFERENCES_ATTR);
    expect(references).toHaveLength(1);
    let referencesToggle = collectByAttr(
      answer,
      CHAT_ROUTE_SOURCE_REFERENCES_TOGGLE_ATTR,
    )[0]!;
    expect(allText(referencesToggle)).toContain('3 recorded references');
    expect(allText(referencesToggle)).toContain(
      'Sources and available record IDs',
    );
    expect(referencesToggle.getAttribute('aria-expanded')).toBe('false');
    expect(collectByAttr(
      answer,
      CHAT_ROUTE_SOURCE_REFERENCE_ATTR,
    )).toHaveLength(0);

    referencesToggle.click();
    answer = collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR)[0]!;
    references = collectByAttr(answer, CHAT_ROUTE_SOURCE_REFERENCES_ATTR);
    referencesToggle = collectByAttr(
      answer,
      CHAT_ROUTE_SOURCE_REFERENCES_TOGGLE_ATTR,
    )[0]!;
    expect(referencesToggle.getAttribute('aria-expanded')).toBe('true');
    expect(allText(references[0]!)).toContain(
      'They are not yet linked to individual sentences.',
    );
    expect(collectByAttr(
      answer,
      CHAT_ROUTE_SOURCE_REFERENCE_ATTR,
    )).toHaveLength(3);
    expect(collectByAttr(
      answer,
      CHAT_ROUTE_SOURCE_REFERENCE_ID_ATTR,
    ).map((row) => row.textContent)).toEqual(['mail-1', 'mail-2']);
    expect(allText(references[0]!)).toContain('Quarterly planning');
    expect(allText(references[0]!)).toContain('Launch readiness');
    expect(allText(references[0]!)).toContain('Account timeline');
    expect(allText(references[0]!)).toContain('Record ID not recorded');
    expect(collectByAttr(
      answer,
      CHAT_ROUTE_SOURCE_REFERENCE_OPEN_ATTR,
    ).map((link) => link.getAttribute('href'))).toEqual([
      '#data/mail/record/work/mail-1/return/chat/chat_new/msg_source_answer',
      '#data/mail/record/work/mail-2/return/chat/chat_new/msg_source_answer',
    ]);
    expect(
      collectByTag(references[0]!, 'a').some(
        (link) => link.getAttribute('href') === '#data/mail',
      ),
    ).toBe(true);
    expect(allText(root)).toContain('Three messages need your attention.');
    expect(collectByAttr(root, CHAT_ROUTE_ANSWER_WAITING_ATTR)).toHaveLength(0);

    const actions = collectByAttr(answer, CHAT_ROUTE_SOURCE_ANSWER_ACTION_ATTR);
    expect(actions.map((action) => action.textContent)).toEqual([
      'Draft the replies',
      'Make an action list',
      'View mailbox',
    ]);
    actions[0]!.click();
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toContain(
      'Do not send anything.',
    );
    let followupContext = collectByAttr(root, CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR);
    expect(followupContext).toHaveLength(1);
    expect(followupContext[0]!.getAttribute(
      CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR,
    )).toBe('refresh');
    expect(allText(followupContext[0]!)).toContain('Review first');
    expect(allText(followupContext[0]!)).toContain(
      'Reply drafts · Gmail · person@example.com',
    );
    expect(allText(followupContext[0]!)).toContain(
      'Requests a new mail search',
    );
    expect(allText(followupContext[0]!)).toContain(
      'If you ask it to send email, you’ll review and approve that separately.',
    );
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!
      .getAttribute('aria-describedby')).not.toBeNull();
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!
      .getAttribute('placeholder')).toBe('Review or edit this request...');
    expect(collectByAttr(root, CHAT_ROUTE_SEND_ATTR)[0]!.textContent)
      .toBe('Ask Chat');
    fireEvent(
      collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!,
      'input',
      `${collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value} `,
    );
    expect(allText(followupContext[0]!)).toContain('Review first');
    expect(allText(followupContext[0]!)).not.toContain('Edited request');
    fireEvent(
      collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!,
      'input',
      'Keep the follow-up I already started.',
    );
    expect(allText(followupContext[0]!)).toContain('Edited request');
    expect(allText(followupContext[0]!)).toContain(
      'Source use now depends on your edits',
    );
    expect(allText(followupContext[0]!)).toContain(
      'Chat handles data-changing actions through a separate approval step.',
    );
    actions[1]!.click();
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe(
      'Keep the follow-up I already started.',
    );
    expect(collectByAttr(root, CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR)[0]!
      .getAttribute(CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR)).toBe('refresh');
    expect(calls.filter((call) => call.method === 'chat.send')).toHaveLength(1);

    collectByAttr(root, CHAT_ROUTE_FOLLOWUP_CONTEXT_CLEAR_ATTR)[0]!.click();
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe('');
    expect(collectByAttr(root, CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!
      .getAttribute('placeholder')).toBe('Ask Recued...');
    expect(collectByAttr(root, CHAT_ROUTE_SEND_ATTR)[0]!.textContent).toBe('Send');

    answer = collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR)[0]!;
    collectByAttr(answer, CHAT_ROUTE_SOURCE_ANSWER_ACTION_ATTR)
      .find((action) => action.textContent === 'Make an action list')!
      .click();
    followupContext = collectByAttr(root, CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR);
    expect(followupContext).toHaveLength(1);
    expect(followupContext[0]!.getAttribute(
      CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR,
    )).toBe('context');
    expect(allText(followupContext[0]!)).toContain(
      'Continues from the previous answer · no new search requested',
    );
    expect(allText(followupContext[0]!)).toContain(
      'Prioritized action list · Gmail · person@example.com',
    );
    expect(allText(followupContext[0]!)).toContain(
      'If you ask it to create tasks, you’ll review and approve that separately.',
    );
    expect(collectByAttr(root, CHAT_ROUTE_SEND_ATTR)[0]!.textContent)
      .toBe('Ask Chat');

    const followupQuestion =
      collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value;
    await route.sendMessage(followupQuestion);
    await tick(8);

    let sourceAnswers = collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR);
    expect(sourceAnswers.map((row) => row.getAttribute('data-state'))).toEqual([
      'search_complete',
      'continuing',
    ]);
    expect(allText(sourceAnswers[1]!)).toContain(
      'Prioritized action list · Gmail · person@example.com',
    );
    expect(collectByAttr(root, CHAT_ROUTE_ANSWER_WAITING_ATTR)[0]!
      .textContent).toBe('Continuing from the previous answer…');
    expect(collectByAttr(root, CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CHAT_ROUTE_MESSAGE_ATTR).map(
      (row) => row.getAttribute('data-role'),
    )).toEqual(['user', 'assistant', 'user', 'assistant']);

    publish({
      kind: 'chat.message_complete',
      session_id: 'chat_new',
      turn_id: 'turn_2',
      final: {
        ...chatMessage(),
        id: 'msg_source_followup',
        session_id: 'chat_new',
        content: '1. Reply to the launch owner. 2. Confirm the review date.',
        tool_calls: [],
      },
      cursor: 4,
    });
    await tick(8);

    sourceAnswers = collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR);
    expect(sourceAnswers.map((row) => row.getAttribute('data-state'))).toEqual([
      'search_complete',
      'context_only',
    ]);
    expect(collectByAttr(
      sourceAnswers[1]!,
      CHAT_ROUTE_SOURCE_ANSWER_RECEIPT_ATTR,
    )[0]!.textContent).toBe('No new search');
    expect(collectByAttr(
      sourceAnswers[0]!,
      CHAT_ROUTE_SOURCE_ANSWER_RECEIPT_ATTR,
    )[0]!.getAttribute('role')).toBeNull();
    expect(collectByAttr(
      sourceAnswers[1]!,
      CHAT_ROUTE_SOURCE_ANSWER_RECEIPT_ATTR,
    )[0]!.getAttribute('role')).toBe('status');
    expect(allText(sourceAnswers[1]!)).toContain(
      'No new mail search was recorded.',
    );
    expect(collectByAttr(
      sourceAnswers[0]!,
      CHAT_ROUTE_SOURCE_ANSWER_ACTION_ATTR,
    )).toHaveLength(0);
    expect(collectByAttr(
      sourceAnswers[1]!,
      CHAT_ROUTE_SOURCE_ANSWER_ACTION_ATTR,
    ).map((action) => action.textContent)).toEqual([
      'Draft the replies',
      'View mailbox',
    ]);
    expect(calls.filter((call) => call.method === 'chat.send')).toHaveLength(2);

    collectByAttr(
      sourceAnswers[1]!,
      CHAT_ROUTE_SOURCE_ANSWER_ACTION_ATTR,
    )[0]!.click();
    expect(collectByAttr(root, CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR)).toHaveLength(1);
    fireEvent(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!, 'input', '');
    expect(collectByAttr(root, CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!
      .getAttribute('aria-describedby')).toBeNull();

    collectByAttr(
      sourceAnswers[1]!,
      CHAT_ROUTE_SOURCE_ANSWER_ACTION_ATTR,
    )[0]!.click();
    const refreshQuestion =
      collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value;
    await route.sendMessage(refreshQuestion);
    await tick(8);

    sourceAnswers = collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR);
    expect(sourceAnswers.map((row) => row.getAttribute('data-state'))).toEqual([
      'search_complete',
      'context_only',
      'preparing',
    ]);
    expect(collectByAttr(root, CHAT_ROUTE_ANSWER_WAITING_ATTR)[0]!
      .textContent).toBe('Preparing to search connected mail…');

    publish({
      kind: 'chat.tool_call_started',
      session_id: 'chat_new',
      turn_id: 'turn_3',
      tool_name: 'mail.search',
      tier: 1,
      args: { query: 'needs response' },
      cursor: 5,
    });
    publish({
      kind: 'chat.tool_call_completed',
      session_id: 'chat_new',
      turn_id: 'turn_3',
      tool_name: 'mail.search',
      tier: 1,
      status: 'ok',
      result_ref: 'chat_new:turn_3:mail.search',
      cursor: 6,
    });
    publish({
      kind: 'chat.message_complete',
      session_id: 'chat_new',
      turn_id: 'turn_3',
      final: {
        ...chatMessage(),
        id: 'msg_source_refresh',
        session_id: 'chat_new',
        content: 'Draft A: Thanks for the update.',
        tool_calls: [{
          tool_name: 'mail.search',
          tier: 1,
          args: { query: 'needs response' },
          status: 'ok',
          result_ref: 'chat_new:turn_3:mail.search',
          started_at: 1_200,
          completed_at: 1_300,
        }],
      },
      cursor: 7,
    });
    await tick(8);

    sourceAnswers = collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR);
    expect(sourceAnswers.map((row) => row.getAttribute('data-state'))).toEqual([
      'search_complete',
      'context_only',
      'search_complete',
    ]);
    expect(collectByAttr(
      sourceAnswers[2]!,
      CHAT_ROUTE_SOURCE_ANSWER_RECEIPT_ATTR,
    )[0]!.textContent).toBe('Mail search completed');
    expect(collectByAttr(
      sourceAnswers[0]!,
      CHAT_ROUTE_SOURCE_ANSWER_ACTION_ATTR,
    )).toHaveLength(0);
    expect(collectByAttr(
      sourceAnswers[1]!,
      CHAT_ROUTE_SOURCE_ANSWER_ACTION_ATTR,
    )).toHaveLength(0);
    expect(collectByAttr(
      sourceAnswers[2]!,
      CHAT_ROUTE_SOURCE_ANSWER_ACTION_ATTR,
    ).map((action) => action.textContent)).toEqual([
      'Make an action list',
      'View mailbox',
    ]);
    expect(calls.filter((call) => call.method === 'chat.send')).toHaveLength(3);

    collectByAttr(
      sourceAnswers[2]!,
      CHAT_ROUTE_SOURCE_ANSWER_ACTION_ATTR,
    ).find((action) => action.textContent === 'Make an action list')!
      .click();
    const retryableDraft =
      collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value;
    rejectNextSend = true;
    await route.sendMessage(retryableDraft);
    await tick(8);
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe(
      retryableDraft,
    );
    expect(collectByAttr(root, CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR)[0]!
      .getAttribute(CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR)).toBe('context');
    expect(collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR)).toHaveLength(3);
    expect(calls.filter((call) => call.method === 'chat.send')).toHaveLength(4);

    rejectNextSend = false;
    const editedDraft = `${retryableDraft} Keep this request editable.`;
    fireEvent(
      collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!,
      'input',
      editedDraft,
    );
    await route.sendMessage(editedDraft);
    await tick(8);
    sourceAnswers = collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR);
    expect(sourceAnswers).toHaveLength(4);
    expect(sourceAnswers[3]!.getAttribute('data-state')).toBe('continuing');
    expect(collectByAttr(
      sourceAnswers[3]!,
      CHAT_ROUTE_SOURCE_ANSWER_RECEIPT_ATTR,
    )[0]!.textContent).toBe('Edited request');
    expect(allText(sourceAnswers[3]!)).toContain(
      'Any new mail search will appear here.',
    );
    expect(allText(sourceAnswers[3]!)).toContain(
      'Follow-up with Gmail · person@example.com',
    );
    expect(allText(sourceAnswers[3]!)).not.toContain(
      'Prioritized action list · Gmail · person@example.com',
    );

    publish({
      kind: 'chat.message_complete',
      session_id: 'chat_new',
      turn_id: 'turn_4',
      final: {
        ...chatMessage(),
        id: 'msg_source_edited',
        session_id: 'chat_new',
        content: 'Here is the edited result.',
        tool_calls: [],
      },
      cursor: 8,
    });
    await tick(8);
    sourceAnswers = collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR);
    expect(sourceAnswers[3]!.getAttribute('data-state')).toBe('context_only');
    expect(allText(sourceAnswers[3]!)).toContain(
      'Source use followed your edited request.',
    );
    expect(calls.filter((call) => call.method === 'chat.send')).toHaveLength(5);
    route.dispose();
  });

  it('shows connected-source search progress before a production-order send ack', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const listeners = new Map<string, Array<(event: never) => void>>();
    let resolveSend!: (value: { turn_id: string }) => void;
    const sendGate = new Promise<{ turn_id: string }>((resolve) => {
      resolveSend = resolve;
    });
    const baseConn = stepConn({ calls }) as unknown as (
      method: string,
      payload?: unknown,
    ) => Promise<unknown>;
    const conn = (async (method: string, payload?: unknown) => {
      if (method === 'chat.send') {
        calls.push({ method, payload });
        return sendGate;
      }
      return baseConn(method, payload);
    }) as ChatRouteConn;
    const source: ChatConnectedSource = {
      lane: 'mail',
      providerId: 'gmail',
      slug: 'work',
    };
    const question = connectedSourceStarterPrompt(source);
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialConnectedSource: source,
      connectedSourceStatusCaller: vi.fn(async () => ({
        state: 'ready' as const,
        identity: 'person@example.com',
        authState: 'healthy' as const,
        lastSyncedAt: 1_700_000_000_000,
      })),
      subscribe: ((kind: string, listener: (event: never) => void) => {
        const rows = listeners.get(kind) ?? [];
        rows.push(listener);
        listeners.set(kind, rows);
        return () => {};
      }) as never,
    });
    await tick(8);

    let sendSettled = false;
    const send = route.sendMessage(question).then(() => {
      sendSettled = true;
    });
    await tick(8);
    expect(sendSettled).toBe(false);
    expect(collectByAttr(root, CHAT_ROUTE_SOURCE_HANDOFF_ATTR)).toHaveLength(1);

    for (const listener of listeners.get('chat.tool_call_started') ?? []) {
      listener({
        kind: 'chat.tool_call_started',
        session_id: 'chat_new',
        turn_id: 'turn_broadcast_first',
        tool_name: 'mail.search',
        tier: 1,
        args: { query: 'attention' },
        cursor: 1,
      } as never);
    }
    await tick();

    expect(sendSettled).toBe(false);
    expect(collectByAttr(root, CHAT_ROUTE_SOURCE_HANDOFF_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR)[0]!
      .getAttribute('data-state')).toBe('searching');
    expect(collectByAttr(root, CHAT_ROUTE_ANSWER_WAITING_ATTR)[0]!
      .textContent).toBe('Searching connected mail…');
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe('');

    resolveSend({ turn_id: 'turn_broadcast_first' });
    await send;
    await tick();
    expect(sendSettled).toBe(true);
    expect(collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR)[0]!
      .getAttribute('data-state')).toBe('searching');
    expect(calls.filter((call) => call.method === 'chat.send')).toHaveLength(1);
    route.dispose();
  });

  it('restores a failed first-source question for review without auto-sending', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const listeners = new Map<string, Array<(event: never) => void>>();
    const source: ChatConnectedSource = {
      lane: 'mail',
      providerId: 'gmail',
      slug: 'work',
    };
    const question = connectedSourceStarterPrompt(source);
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ calls }),
      initialConnectedSource: source,
      connectedSourceStatusCaller: vi.fn(async () => ({
        state: 'ready' as const,
        identity: 'person@example.com',
        authState: 'healthy' as const,
        lastSyncedAt: 1_700_000_000_000,
      })),
      subscribe: ((kind: string, listener: (event: never) => void) => {
        const rows = listeners.get(kind) ?? [];
        rows.push(listener);
        listeners.set(kind, rows);
        return () => {};
      }) as never,
    });
    await tick(8);
    await route.sendMessage(question);
    await tick(8);
    for (const listener of listeners.get('chat.transparency') ?? []) {
      listener({
        kind: 'chat.transparency',
        session_id: 'chat_new',
        turn_id: 'turn_1',
        event: { kind: 'engine.turn_failed' },
        cursor: 1,
      } as never);
    }
    await tick(8);

    const answer = collectByAttr(root, CHAT_ROUTE_SOURCE_ANSWER_ATTR)[0]!;
    expect(answer.getAttribute('data-state')).toBe('failed');
    const retry = collectByAttr(answer, CHAT_ROUTE_SOURCE_ANSWER_ACTION_ATTR)
      .find((action) => action.textContent === 'Review and retry')!;
    retry.click();
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe(question);
    expect(collectByAttr(root, CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR)[0]!
      .getAttribute(CHAT_ROUTE_FOLLOWUP_CONTEXT_ATTR)).toBe('refresh');
    expect(calls.filter((call) => call.method === 'chat.send')).toHaveLength(1);
    route.dispose();
  });

  it('preserves connected-source context through the Set up Chat detour', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ llmConfig: {} }),
      initialConnectedSource: {
        lane: 'calendar',
        providerId: 'graph',
        slug: 'office',
      },
      connectedSourceStatusCaller: vi.fn(async () => ({
        state: 'ready' as const,
        identity: 'office',
        authState: 'healthy' as const,
        lastSyncedAt: 1_700_000_000_000,
      })),
    });
    await tick(8);

    const setup = collectByAttr(root, CHAT_ROUTE_SOURCE_ACTION_ATTR).find(
      (action) => action.textContent === 'Set up Chat',
    );
    expect(setup?.getAttribute('href')).toBe(
      '#settings/ai-models/setup/source/calendar/graph/office',
    );
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe('');
    route.dispose();
  });

  it('returns from setup to the exact durable session instead of a blank Chat', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ calls, sessions: [sessionSummary()] }),
      initialSessionId: 'chat_1',
      // A session deep link must win even if a malformed caller supplies both.
      initialStarterPrompt: true,
    });
    await tick(8);

    expect(calls).toContainEqual({
      method: 'chat.session.get',
      payload: { session_id: 'chat_1' },
    });
    expect(route.getThread().session?.id).toBe('chat_1');
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe('');
    route.dispose();
  });

  it('rehydrates, expands, and highlights the cited answer after a Data round-trip', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const citedMessage: ChatMessage = {
      ...chatMessage(),
      id: 'msg_cited',
      provenance: [{
        source: 'local',
        collection_platform: 'mail',
        collection_slug: 'work',
        record_id: ' mail-1 ',
      }],
    };
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [sessionSummary()],
        messages: [citedMessage],
      }),
      initialSessionId: 'chat_1',
      initialMessageId: 'msg_cited',
    });
    await tick(8);

    const target = collectByAttr(root, CHAT_ROUTE_RETURN_TARGET_ATTR)[0]!;
    expect(target.getAttribute(CHAT_ROUTE_MESSAGE_ATTR)).toBe('msg_cited');
    const toggle = collectByAttr(
      target,
      CHAT_ROUTE_SOURCE_REFERENCES_TOGGLE_ATTR,
    )[0]!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(collectByAttr(
      target,
      CHAT_ROUTE_SOURCE_REFERENCE_OPEN_ATTR,
    )[0]?.getAttribute('href')).toBe(
      '#data/mail/record/work/%20mail-1%20/return/chat/chat_1/msg_cited',
    );
    route.dispose();
  });

  it('hydrates and focuses the exact approved action instead of its whole answer', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        calls,
        sessions: [sessionSummary()],
        messages: [{ ...chatMessage(), id: 'msg_action' }],
        plans: [approvedPlanRecord()],
      }),
      initialSessionId: 'chat_1',
      initialMessageId: 'msg_action',
      initialPlanId: 'plan_approved',
    });
    await tick(8);

    const target = collectByAttr(root, CHAT_ROUTE_PLAN_TARGET_ATTR)[0]!;
    expect(target.getAttribute('data-plan-id')).toBe('plan_approved');
    expect(target.getAttribute(CHAT_ROUTE_PLAN_CARD_ATTR)).toBe('');
    expect(target.scrolled).toBe(true);
    const continueAction = collectByAttr(
      target,
      CHAT_ROUTE_PLAN_CONTINUE_ATTR,
    )[0]!;
    expect(continueAction.textContent).toBe('Continue in Chat');
    expect(continueAction.focused).toBe(true);
    expect(collectByAttr(root, CHAT_ROUTE_RETURN_TARGET_ATTR)).toHaveLength(0);
    expect(calls.some((call) => call.method === 'chat.send')).toBe(false);
    route.dispose();
  });

  it('returns a Data review to the exact uncertain action without retrying it', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const listeners = new Map<
      string,
      Array<(event: ServerEvent) => void>
    >();
    const reconnectListeners: Array<() => void> = [];
    const diagnosisContext: ChatDataDiagnosisContext = {
      kind: 'data_verification',
      plan_id: 'plan_approved',
      run_id: 'run/one',
      intent: 'explanation',
      relationship: 'involved',
      run_correlation: 'matched',
    };
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        calls,
        sessions: [sessionSummary()],
        messages: (sessionGetCall) => [
          { ...chatMessage(), id: 'msg_action' },
          ...(sessionGetCall > 1
            ? [{
                ...chatMessage(),
                id: 'msg_diagnosis_user',
                role: 'user' as const,
                content: 'Help me interpret the linked evidence.',
                data_diagnosis: diagnosisContext,
              }]
            : []),
        ],
        plans: [approvedPlanRecord({
          execution: {
            status: 'failed',
            turn_id: 'turn_action',
            reason: 'execution_error',
            run_id: 'run/one',
          },
        })],
        sendAck: {
          turn_id: 'turn_1',
          data_diagnosis: diagnosisContext,
        },
      }),
      subscribe: ((kind: string, listener: (event: ServerEvent) => void) => {
        const rows = listeners.get(kind) ?? [];
        rows.push(listener);
        listeners.set(kind, rows);
        return () => {};
      }) as never,
      reconnect: (listener) => {
        reconnectListeners.push(listener);
        return () => {};
      },
      initialSessionId: 'chat_1',
      initialMessageId: 'msg_action',
      initialPlanId: 'plan_approved',
      initialDataVerificationReturn: {
        result: 'needs_help',
        runId: 'run/one',
        relationship: 'involved',
      },
    });
    await tick(8);

    const target = collectByAttr(root, CHAT_ROUTE_PLAN_TARGET_ATTR)[0]!;
    const review = collectByAttr(
      target,
      CHAT_ROUTE_DATA_VERIFICATION_RETURN_ATTR,
    )[0]!;
    expect(review.getAttribute('data-result')).toBe('needs_help');
    expect(review.getAttribute('data-relationship')).toBe('involved');
    expect(review.getAttribute('data-run-match')).toBe('matched');
    expect(review.getAttribute('role')).toBe('status');
    expect(review.children.find(
      (child) => child.className === 'chat-data-verification-title',
    )?.textContent).toBe('Help interpreting this result');
    expect(review.children.find(
      (child) => child.className === 'chat-data-verification-detail',
    )?.textContent).toContain(
      'Chat can explain what the linked Data evidence does and does not show',
    );
    expect(review.children.find(
      (child) => child.className === 'chat-data-verification-detail',
    )?.textContent).toContain('Nothing retried.');
    expect(review.children.find(
      (child) => child.tagName === 'A',
    )).toBeUndefined();
    expect(collectByAttr(
      target,
      CHAT_ROUTE_PLAN_RUN_ATTR,
    )[0]?.getAttribute('href')).toBe(
      '#logs/run%2Fone/return/chat/session/chat_1/plan/plan_approved/'
      + 'answer/msg_action',
    );
    const retry = collectByAttr(target, CHAT_ROUTE_PLAN_RETRY_ATTR)[0]!;
    expect(retry.textContent).toBe('Review and retry');
    expect(retry.focused).toBe(false);
    const diagnose = collectByAttr(
      target,
      CHAT_ROUTE_DATA_VERIFICATION_DIAGNOSE_ATTR,
    )[0]!;
    expect(diagnose.textContent).toBe('Help me interpret this');
    expect(diagnose.focused).toBe(true);
    expect(calls.some((call) => call.method === 'chat.send')).toBe(false);
    expect(calls.some((call) => call.method === 'chat.plan.approve')).toBe(false);

    diagnose.click();
    const diagnosis = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_CONTEXT_ATTR,
    )[0]!;
    expect(diagnosis.getAttribute('aria-label')).toBe(
      'Get help interpreting Data review for Send email',
    );
    expect(allText(diagnosis)).toContain('Explanation only');
    expect(allText(diagnosis)).toContain('without changing anything');
    expect(allText(diagnosis)).toContain('does not retry the action');
    const input = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    expect(input.value).toContain(
      'Help me interpret the Data review linked to the action below.',
    );
    expect(input.value).toContain('"run_id": "run/one"');
    expect(input.value).toContain('"execution_status": "failed"');
    expect(input.value).toContain('"execution_reason": "execution_error"');
    expect(input.value).toContain(
      '"run_correlation": "confirmed by the action execution receipt"',
    );
    expect(input.value).toContain(
      '"data_relationship": "item involved in the side-effecting step"',
    );
    expect(input.value).toContain('Do not retry the action');
    expect(input.value).toContain('<reviewed_arguments>');
    expect(doc.activeElement).toBe(input);
    expect(route.hasUnsavedChanges()).toBe(true);
    expect(calls.some((call) => call.method === 'chat.send')).toBe(false);

    collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_CONTEXT_CLEAR_ATTR,
    )[0]!.click();
    expect(collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_CONTEXT_ATTR,
    )).toHaveLength(0);
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe('');
    expect(route.hasUnsavedChanges()).toBe(false);
    expect(calls.some((call) => call.method === 'chat.send')).toBe(false);

    collectByAttr(
      root,
      CHAT_ROUTE_DATA_VERIFICATION_DIAGNOSE_ATTR,
    )[0]!.click();
    const preparedInput = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    await route.sendMessage(preparedInput.value);
    await tick();
    const send = calls.find((call) => call.method === 'chat.send')!;
    expect(send.payload).toMatchObject({
      session_id: 'chat_1',
      message: preparedInput.value,
      data_diagnosis: {
        plan_id: 'plan_approved',
        run_id: 'run/one',
        intent: 'explanation',
        relationship: 'involved',
      },
    });
    expect(send.payload).not.toHaveProperty('retry_of_plan_id');
    expect(collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_CONTEXT_ATTR,
    )).toHaveLength(0);
    const interpreting = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    )[0]!;
    expect(interpreting.getAttribute('data-state')).toBe('interpreting');
    expect(interpreting.getAttribute('data-plan-id')).toBe('plan_approved');
    expect(interpreting.getAttribute('data-run-id')).toBe('run/one');
    expect(interpreting.getAttribute('data-run-correlation')).toBe('matched');
    expect(interpreting.getAttribute('role')).toBe('status');
    expect(allText(interpreting)).toContain(
      'This request carries no approval or retry authority',
    );
    expect(collectByAttr(
      interpreting,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ACTION_ATTR,
    )).toHaveLength(0);
    expect(allText(collectByAttr(
      root,
      CHAT_ROUTE_ANSWER_WAITING_ATTR,
    )[0]!)).toContain('Interpreting the linked evidence');

    reconnectListeners[0]?.();
    await tick(8);
    const recoveredInterpreting = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    )[0]!;
    expect(recoveredInterpreting.getAttribute('data-state')).toBe(
      'interpreting',
    );
    expect(collectByAttr(root, CHAT_ROUTE_SEND_ATTR)[0]?.disabled).toBe(true);

    const completed: Extract<
      ServerEvent,
      { kind: 'chat.message_complete' }
    > = {
      kind: 'chat.message_complete',
      session_id: 'chat_1',
      turn_id: 'turn_1',
      final: {
        ...chatMessage(),
        id: 'msg_diagnosis',
        content: 'The linked evidence confirms the record was updated.',
        data_diagnosis: {
          kind: 'data_verification',
          plan_id: 'plan_approved',
          run_id: 'run/one',
          intent: 'explanation',
          relationship: 'involved',
          run_correlation: 'matched',
        },
      },
      cursor: 1,
    };
    for (const listener of listeners.get(completed.kind) ?? []) {
      listener(completed);
    }
    await tick();
    const ready = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    );
    expect(ready).toHaveLength(1);
    expect(ready[0]?.getAttribute('data-state')).toBe('ready');
    expect(ready[0]?.getAttribute('role')).toBe('status');
    expect(collectByAttr(
      ready[0]!,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ACTION_ATTR,
    )).toHaveLength(3);
    route.dispose();
  });

  it('does not invent read-only authority when the send ack omits diagnosis context', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        calls,
        sessions: [sessionSummary()],
        messages: [{ ...chatMessage(), id: 'msg_action' }],
        plans: [approvedPlanRecord({
          execution: {
            status: 'failed',
            turn_id: 'turn_action',
            reason: 'execution_error',
            run_id: 'run/one',
          },
        })],
        // Simulates a rolling-deployment server that accepts chat.send but
        // does not understand/echo the newer diagnosis field.
        sendAck: { turn_id: 'turn_1' },
      }),
      initialSessionId: 'chat_1',
      initialMessageId: 'msg_action',
      initialPlanId: 'plan_approved',
      initialDataVerificationReturn: {
        result: 'needs_help',
        runId: 'run/one',
        relationship: 'involved',
      },
    });
    await tick(8);

    collectByAttr(
      root,
      CHAT_ROUTE_DATA_VERIFICATION_DIAGNOSE_ATTR,
    )[0]!.click();
    const input = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    await route.sendMessage(input.value);
    await tick();

    expect(calls.find((call) => call.method === 'chat.send')?.payload)
      .toMatchObject({
        data_diagnosis: {
          plan_id: 'plan_approved',
          run_id: 'run/one',
        },
      });
    expect(collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    )).toHaveLength(0);
    expect(allText(collectByAttr(
      root,
      CHAT_ROUTE_ANSWER_WAITING_ATTR,
    )[0]!)).toContain('Preparing your answer');
    expect(allText(root)).not.toContain(
      'This request carries no approval or retry authority',
    );
    route.dispose();
  });

  it('rehydrates a diagnosis answer with exact, non-executing next steps', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const reconnectListeners: Array<() => void> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        calls,
        sessions: [sessionSummary()],
        messages: [
          { ...chatMessage(), id: 'msg_action' },
          {
            ...chatMessage(),
            id: 'msg_diagnosis',
            content: 'The record shows the update landed at 10:42.',
            data_diagnosis: {
              kind: 'data_verification',
              plan_id: 'plan_approved',
              run_id: 'run/one',
              intent: 'explanation',
              relationship: 'derived',
              run_correlation: 'matched',
            },
          },
        ],
        plans: [approvedPlanRecord({
          execution: {
            status: 'completed',
            turn_id: 'turn_action',
            result_ref: 'result:one',
            run_id: 'run/one',
          },
        })],
        sendAck: {
          turn_id: 'turn_safe_check',
          data_diagnosis: {
            kind: 'data_verification',
            plan_id: 'plan_approved',
            run_id: 'run/one',
            intent: 'safe_check',
            relationship: 'derived',
            run_correlation: 'matched',
          },
        },
      }),
      reconnect: (listener) => {
        reconnectListeners.push(listener);
        return () => {};
      },
      initialSessionId: 'chat_1',
    });
    await tick(8);

    const receipt = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    )[0]!;
    expect(receipt.getAttribute('data-state')).toBe('ready');
    expect(receipt.getAttribute('data-run-correlation')).toBe('matched');
    expect(receipt.getAttribute('role')).toBeNull();
    expect(allText(receipt)).toContain(
      'Explanation ready — choose a safe next step',
    );
    expect(allText(receipt)).toContain(
      'did not retry the action or grant a new approval',
    );

    reconnectListeners[0]?.();
    await tick(8);
    const recovered = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.getAttribute('data-state')).toBe('ready');

    const actions = collectByAttr(
      recovered[0]!,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ACTION_ATTR,
    );
    expect(actions.map((action) => action.getAttribute('data-action'))).toEqual([
      'run',
      'action',
      'safe-check',
    ]);
    expect(actions[2]?.textContent).toBe('Draft a safe check');
    expect(actions[0]?.getAttribute('href')).toBe(
      '#logs/run%2Fone/return/chat/session/chat_1/plan/plan_approved/'
      + 'answer/msg_diagnosis',
    );
    actions[1]!.click();
    expect(
      collectByAttr(root, CHAT_ROUTE_PLAN_CARD_ATTR)[0]?.focused,
    ).toBe(true);
    expect(calls.some((call) => call.method === 'chat.send')).toBe(false);
    expect(calls.some((call) => call.method === 'chat.plan.approve')).toBe(
      false,
    );

    actions[2]!.click();
    const safeCheckContext = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_CONTEXT_ATTR,
    );
    expect(safeCheckContext).toHaveLength(1);
    expect(allText(safeCheckContext[0]!)).toContain('Read-only check');
    expect(allText(safeCheckContext[0]!)).toContain(
      'verify remaining uncertainty',
    );
    const safeCheckPrompt =
      collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]?.value ?? '';
    expect(safeCheckPrompt).toContain(
      'Use safe, read-only tools to check what remains uncertain',
    );
    expect(safeCheckPrompt).toContain(
      '"run_id": "run/one"',
    );
    expect(safeCheckPrompt).not.toContain(
      'Help me interpret the Data review linked to the action below',
    );
    expect(calls.some((call) => call.method === 'chat.send')).toBe(false);
    await route.sendMessage(safeCheckPrompt);
    await tick();
    expect(calls.find((call) => call.method === 'chat.send')?.payload)
      .toMatchObject({
        data_diagnosis: {
          plan_id: 'plan_approved',
          run_id: 'run/one',
          intent: 'safe_check',
          relationship: 'derived',
        },
      });
    route.dispose();
  });

  it('closes a safe check explicitly and drafts a fresh action without authority', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const listeners = new Map<
      string,
      Array<(event: ServerEvent) => void>
    >();
    let durableResolution:
      | {
          status: 'resolved' | 'still_uncertain' | 'needs_new_action';
          resolved_at: number;
        }
      | undefined;
    let settleResolution!: (result: {
      resolution: {
        status: 'resolved' | 'still_uncertain' | 'needs_new_action';
        resolved_at: number;
      };
    }) => void;
    const pendingResolution = new Promise<{
      resolution: {
        status: 'resolved' | 'still_uncertain' | 'needs_new_action';
        resolved_at: number;
      };
    }>((resolve) => {
      settleResolution = resolve;
    });
    const safeCheckMessage = (): ChatMessage => ({
      ...chatMessage(),
      id: 'msg_safe_check',
      content: 'The read-only lookup found the expected destination record.',
      data_diagnosis: {
        kind: 'data_verification',
        plan_id: 'plan_approved',
        run_id: 'run/one',
        intent: 'safe_check',
        relationship: 'derived',
        run_correlation: 'matched',
      },
      ...(durableResolution !== undefined
        ? { data_diagnosis_resolution: durableResolution }
        : {}),
    });
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        calls,
        sessions: [sessionSummary()],
        messages: () => [
          { ...chatMessage(), id: 'msg_action' },
          safeCheckMessage(),
          {
            ...safeCheckMessage(),
            id: 'msg_safe_check_other',
            data_diagnosis_resolution: {
              status: 'needs_new_action',
              resolved_at: 8_500,
            },
          },
        ],
        plans: [approvedPlanRecord({
          execution: {
            status: 'completed',
            turn_id: 'turn_action',
            result_ref: 'result:one',
            run_id: 'run/one',
          },
        })],
        resolveDiagnosis: (payload) => {
          durableResolution = {
            status: payload.status,
            resolved_at: 9_000,
          };
          return pendingResolution;
        },
      }),
      subscribe: ((kind: string, listener: (event: ServerEvent) => void) => {
        const rows = listeners.get(kind) ?? [];
        rows.push(listener);
        listeners.set(kind, rows);
        return () => {};
      }) as never,
      initialSessionId: 'chat_1',
    });
    await tick(8);

    const initial = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    )[0]!;
    expect(route.hasInFlightWork()).toBe(false);
    expect(initial.getAttribute('data-intent')).toBe('safe_check');
    expect(initial.getAttribute('data-resolution')).toBeNull();
    expect(initial.getAttribute('role')).toBeNull();
    expect(allText(initial)).toContain(
      'Read-only check complete — close the loop',
    );
    const closeResolved = collectByAttr(
      initial,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ACTION_ATTR,
    ).find(
      (action) => action.getAttribute('data-action') === 'resolve-resolved',
    )!;
    closeResolved.focus();
    closeResolved.click();
    await tick();
    expect(route.hasInFlightWork()).toBe(true);

    const savingReceipt = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    )[0]!;
    const savingActions = collectByAttr(
      savingReceipt,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ACTION_ATTR,
    ).filter(
      (action) => action.getAttribute('data-action')?.startsWith('resolve-'),
    );
    const savingResolved = savingActions.find(
      (action) => action.getAttribute('data-action') === 'resolve-resolved',
    )!;
    expect(savingResolved.textContent).toBe('Saving…');
    expect(savingResolved.disabled).toBe(false);
    expect(savingResolved.getAttribute('aria-disabled')).toBe('true');
    expect(savingResolved.getAttribute('aria-busy')).toBe('true');
    expect(savingResolved.focused).toBe(true);
    expect(doc.activeElement).toBe(savingResolved);
    expect(savingActions.every(
      (action) => action.getAttribute('aria-disabled') === 'true',
    )).toBe(true);
    savingResolved.click();
    savingActions.find(
      (action) => action.getAttribute('data-action')
        === 'resolve-still_uncertain',
    )!.click();
    expect(calls.filter(
      (call) => call.method === 'chat.data_diagnosis.resolve',
    )).toHaveLength(1);

    settleResolution({ resolution: durableResolution! });
    await tick();
    expect(route.hasInFlightWork()).toBe(false);

    expect(calls.find(
      (call) => call.method === 'chat.data_diagnosis.resolve',
    )?.payload).toEqual({
      session_id: 'chat_1',
      message_id: 'msg_safe_check',
      status: 'resolved',
    });
    expect(calls.some((call) => call.method === 'chat.send')).toBe(false);
    expect(calls.some((call) => call.method === 'chat.plan.approve')).toBe(
      false,
    );
    const resolved = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    )[0]!;
    expect(resolved.getAttribute('data-resolution')).toBe('resolved');
    expect(resolved.getAttribute(
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_MESSAGE_ATTR,
    )).toBe('msg_safe_check');
    expect(resolved.getAttribute('tabindex')).toBe('-1');
    expect(resolved.focused).toBe(true);
    expect(doc.activeElement).toBe(resolved);
    expect(resolved.getAttribute('role')).toBe('status');
    expect(allText(resolved)).toContain(
      'Closed — no further action requested',
    );

    const changed: Extract<
      ServerEvent,
      { kind: 'chat.data_diagnosis_resolved' }
    > = {
      kind: 'chat.data_diagnosis_resolved',
      session_id: 'chat_1',
      message_id: 'msg_safe_check',
      resolution: {
        status: 'needs_new_action',
        resolved_at: 9_100,
      },
      cursor: 2,
    };
    for (const listener of listeners.get(changed.kind) ?? []) {
      listener(changed);
    }
    await tick();
    const needsAction = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    )[0]!;
    expect(needsAction.getAttribute('data-resolution')).toBe(
      'needs_new_action',
    );
    expect(allText(needsAction)).toContain('Closed — fresh review needed');
    const stale: Extract<
      ServerEvent,
      { kind: 'chat.data_diagnosis_resolved' }
    > = {
      ...changed,
      resolution: { status: 'resolved', resolved_at: 9_050 },
      cursor: 3,
    };
    for (const listener of listeners.get(stale.kind) ?? []) {
      listener(stale);
    }
    await tick();
    expect(collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    )[0]?.getAttribute('data-resolution')).toBe('needs_new_action');
    const fresh = collectByAttr(
      needsAction,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ACTION_ATTR,
    ).find(
      (action) => action.getAttribute('data-action') === 'fresh-action',
    )!;
    fresh.click();

    const context = collectByAttr(root, CHAT_ROUTE_PLAN_CONTEXT_ATTR)[0]!;
    expect(allText(context)).toContain('Fresh approval required');
    expect(allText(context)).toContain(
      'Nothing can run until you approve that fresh review',
    );
    const initialPrompt = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value;
    expect(initialPrompt).toContain(
      'Prepare the exact action below as a new proposal',
    );
    expect(initialPrompt).toContain('Do not execute it from the prior approval');
    expect(calls.some((call) => call.method === 'chat.send')).toBe(false);
    const otherSafeCheck = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    )[1]!;
    const otherFresh = collectByAttr(
      otherSafeCheck,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ACTION_ATTR,
    ).find(
      (action) => action.getAttribute('data-action') === 'fresh-action',
    )!;
    expect(otherFresh.textContent).toBe('Go to current draft');

    const reclosed: Extract<
      ServerEvent,
      { kind: 'chat.data_diagnosis_resolved' }
    > = {
      ...changed,
      resolution: { status: 'resolved', resolved_at: 9_200 },
      cursor: 4,
    };
    for (const listener of listeners.get(reclosed.kind) ?? []) {
      listener(reclosed);
    }
    await tick();
    expect(collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    )[0]?.getAttribute('role')).toBe('status');
    expect(collectByAttr(root, CHAT_ROUTE_PLAN_CONTEXT_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]?.value).toBe('');

    const reopened: Extract<
      ServerEvent,
      { kind: 'chat.data_diagnosis_resolved' }
    > = {
      ...changed,
      resolution: { status: 'needs_new_action', resolved_at: 9_300 },
      cursor: 5,
    };
    for (const listener of listeners.get(reopened.kind) ?? []) {
      listener(reopened);
    }
    await tick();
    collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ACTION_ATTR,
    ).find(
      (action) => action.getAttribute('data-action') === 'fresh-action',
    )!.click();
    const prompt = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value;
    await route.sendMessage(prompt);
    await tick();
    const sent = calls.find((call) => call.method === 'chat.send');
    expect(sent?.payload).not.toHaveProperty('retry_of_plan_id');
    expect(sent?.payload).not.toHaveProperty('data_diagnosis');
    expect(sent?.payload).toMatchObject({ message: prompt });
    expect(calls.some((call) => call.method === 'chat.plan.approve')).toBe(
      false,
    );
    route.dispose();
  });

  it('returns a failed safe-check closure to the attempted choice', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [sessionSummary()],
        messages: [
          { ...chatMessage(), id: 'msg_action' },
          {
            ...chatMessage(),
            id: 'msg_safe_check_failed',
            content: 'The read-only lookup found the expected record.',
            data_diagnosis: {
              kind: 'data_verification',
              plan_id: 'plan_approved',
              run_id: 'run/one',
              intent: 'safe_check',
              relationship: 'derived',
              run_correlation: 'matched',
            },
          },
        ],
        plans: [approvedPlanRecord({
          execution: {
            status: 'completed',
            turn_id: 'turn_action',
            result_ref: 'result:one',
            run_id: 'run/one',
          },
        })],
        resolveDiagnosis: async () => {
          throw new Error('closure save failed');
        },
      }),
      initialSessionId: 'chat_1',
    });
    await tick(8);

    const closeResolved = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ACTION_ATTR,
    ).find(
      (action) => action.getAttribute('data-action') === 'resolve-resolved',
    )!;
    closeResolved.focus();
    closeResolved.click();

    await vi.waitFor(() => {
      const attempted = collectByAttr(
        root,
        CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ACTION_ATTR,
      ).find(
        (action) => action.getAttribute('data-action') === 'resolve-resolved',
      );
      expect(attempted?.textContent).toBe('Resolved — no action');
      expect(attempted?.focused).toBe(true);
    });
    const restored = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ACTION_ATTR,
    ).find(
      (action) => action.getAttribute('data-action') === 'resolve-resolved',
    )!;
    expect(restored.textContent).toBe('Resolved — no action');
    expect(restored.disabled).toBe(false);
    expect(restored.getAttribute('aria-disabled')).toBeNull();
    expect(restored.getAttribute('aria-busy')).toBeNull();
    expect(restored.focused).toBe(true);
    expect(doc.activeElement).toBe(restored);

    route.dispose();
  });

  it('hydrates a saved safe-check closure without announcing old activity', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const listeners = new Map<
      string,
      Array<(event: ServerEvent) => void>
    >();
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [sessionSummary()],
        messages: [{
          ...chatMessage(),
          id: 'msg_safe_check',
          data_diagnosis: {
            kind: 'data_verification',
            plan_id: 'plan_approved',
            run_id: 'run/one',
            intent: 'safe_check',
            run_correlation: 'matched',
          },
          data_diagnosis_resolution: {
            status: 'still_uncertain',
            resolved_at: 8_000,
          },
        }],
        plans: [approvedPlanRecord({
          execution: {
            status: 'completed',
            turn_id: 'turn_action',
            result_ref: 'result:one',
            run_id: 'run/one',
          },
        })],
      }),
      subscribe: ((kind: string, listener: (event: ServerEvent) => void) => {
        const rows = listeners.get(kind) ?? [];
        rows.push(listener);
        listeners.set(kind, rows);
        return () => {};
      }) as never,
      initialSessionId: 'chat_1',
    });
    await tick(8);

    const receipt = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    )[0]!;
    expect(receipt.getAttribute('data-resolution')).toBe('still_uncertain');
    expect(receipt.getAttribute('role')).toBeNull();
    expect(allText(receipt)).toContain('Closed as still uncertain');
    expect(collectByAttr(
      receipt,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ACTION_ATTR,
    ).some(
      (action) => action.getAttribute('data-action') === 'safe-check',
    )).toBe(true);

    const tiedStale: Extract<
      ServerEvent,
      { kind: 'chat.data_diagnosis_resolved' }
    > = {
      kind: 'chat.data_diagnosis_resolved',
      session_id: 'chat_1',
      message_id: 'msg_safe_check',
      resolution: {
        status: 'resolved',
        resolved_at: 8_000,
      },
      cursor: 2,
    };
    for (const listener of listeners.get(tiedStale.kind) ?? []) {
      listener(tiedStale);
    }
    await tick();
    const afterStale = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_ANSWER_ATTR,
    )[0]!;
    expect(afterStale.getAttribute('data-resolution')).toBe('still_uncertain');
    expect(afterStale.getAttribute('role')).toBeNull();
    route.dispose();
  });

  it('keeps a missing receipt run correlation explicit in guided help', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        calls,
        sessions: [sessionSummary()],
        messages: [{ ...chatMessage(), id: 'msg_action' }],
        plans: [approvedPlanRecord({
          execution: {
            status: 'failed',
            turn_id: 'turn_action',
            reason: 'execution_error',
          },
        })],
      }),
      initialSessionId: 'chat_1',
      initialMessageId: 'msg_action',
      initialPlanId: 'plan_approved',
      initialDataVerificationReturn: {
        result: 'needs_help',
        runId: 'run-from-data',
        relationship: 'action',
      },
    });
    await tick(8);

    const review = collectByAttr(
      root,
      CHAT_ROUTE_DATA_VERIFICATION_RETURN_ATTR,
    )[0]!;
    expect(review.getAttribute('data-run-match')).toBe('unverified');
    expect(review.children.find(
      (child) => child.className === 'chat-data-verification-detail',
    )?.textContent).toContain(
      'action receipt does not identify a run',
    );
    collectByAttr(
      review,
      CHAT_ROUTE_DATA_VERIFICATION_DIAGNOSE_ATTR,
    )[0]!.click();

    const diagnosis = collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_CONTEXT_ATTR,
    )[0]!;
    expect(allText(diagnosis)).toContain(
      'without assuming this run belongs to the action',
    );
    const prompt = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value;
    expect(prompt).toContain(
      '"run_correlation": "not confirmed by the action execution receipt"',
    );
    expect(prompt).toContain(
      'keep that uncertainty explicit instead of inferring a match',
    );
    expect(calls.some((call) => call.method === 'chat.send')).toBe(false);
    route.dispose();
  });

  it('keeps a grounded diagnosis through reconnect and retires it if the receipt run changes', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const reconnectListeners: Array<() => void> = [];
    const planForRun = (runId: string): ChatPlanRecord =>
      approvedPlanRecord({
        execution: {
          status: 'failed',
          turn_id: 'turn_action',
          reason: 'execution_error',
          run_id: runId,
        },
      });
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [sessionSummary()],
        messages: [{ ...chatMessage(), id: 'msg_action' }],
        plans: (call) => [
          call < 3 ? planForRun('run-one') : planForRun('run-new'),
        ],
      }),
      reconnect: (listener) => {
        reconnectListeners.push(listener);
        return () => {};
      },
      initialSessionId: 'chat_1',
      initialMessageId: 'msg_action',
      initialPlanId: 'plan_approved',
      initialDataVerificationReturn: {
        result: 'needs_help',
        runId: 'run-one',
        relationship: 'derived',
      },
    });
    await tick(8);

    collectByAttr(
      root,
      CHAT_ROUTE_DATA_VERIFICATION_DIAGNOSE_ATTR,
    )[0]!.click();
    const prompt = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value;
    reconnectListeners[0]?.();
    await tick(8);
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe(prompt);
    expect(collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_CONTEXT_ATTR,
    )).toHaveLength(1);

    reconnectListeners[0]?.();
    await tick(8);
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe('');
    expect(collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_CONTEXT_ATTR,
    )).toHaveLength(0);
    const review = collectByAttr(
      root,
      CHAT_ROUTE_DATA_VERIFICATION_RETURN_ATTR,
    )[0]!;
    expect(review.getAttribute('data-run-match')).toBe('mismatched');
    expect(collectByAttr(
      review,
      CHAT_ROUTE_DATA_VERIFICATION_DIAGNOSE_ATTR,
    )).toHaveLength(0);
    route.dispose();
  });

  it('preserves an edited help request as an ordinary draft when a live receipt changes its run', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const listeners = new Map<
      string,
      Array<(event: ServerEvent) => void>
    >();
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [sessionSummary()],
        messages: [{ ...chatMessage(), id: 'msg_action' }],
        plans: [approvedPlanRecord({
          execution: {
            status: 'failed',
            turn_id: 'turn_action',
            reason: 'execution_error',
            run_id: 'run-one',
          },
        })],
      }),
      subscribe: ((kind: string, listener: (event: ServerEvent) => void) => {
        const rows = listeners.get(kind) ?? [];
        rows.push(listener);
        listeners.set(kind, rows);
        return () => {};
      }) as never,
      initialSessionId: 'chat_1',
      initialMessageId: 'msg_action',
      initialPlanId: 'plan_approved',
      initialDataVerificationReturn: {
        result: 'needs_help',
        runId: 'run-one',
        relationship: 'derived',
      },
    });
    await tick(8);

    collectByAttr(
      root,
      CHAT_ROUTE_DATA_VERIFICATION_DIAGNOSE_ATTR,
    )[0]!.click();
    const input = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    const edited = `${input.value}\nMy own verification note`;
    fireEvent(input, 'input', edited);

    const event: Extract<ServerEvent, { kind: 'chat.tool_call_completed' }> = {
      kind: 'chat.tool_call_completed',
      session_id: 'chat_1',
      turn_id: 'turn_action_update',
      tool_name: 'mail.send',
      tier: 2,
      status: 'error',
      reason: 'execution_error',
      detail: 'provider outcome still unknown',
      run_id: 'run-other',
      plan_id: 'plan_approved',
      cursor: 1,
    };
    for (const listener of listeners.get(event.kind) ?? []) listener(event);
    await tick();

    const preservedInput = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    expect(preservedInput.value).toBe(edited);
    expect(doc.activeElement).toBe(preservedInput);
    expect(route.hasUnsavedChanges()).toBe(true);
    expect(collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_CONTEXT_ATTR,
    )).toHaveLength(0);
    expect(collectByAttr(
      root,
      CHAT_ROUTE_DATA_VERIFICATION_RETURN_ATTR,
    )[0]?.getAttribute('data-run-match')).toBe('mismatched');
    route.dispose();
  });

  it('fails closed when the Data return names a different run than the action receipt', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        calls,
        sessions: [sessionSummary()],
        messages: [{ ...chatMessage(), id: 'msg_action' }],
        plans: [approvedPlanRecord({
          execution: {
            status: 'failed',
            turn_id: 'turn_action',
            reason: 'execution_error',
            run_id: 'run-receipt',
          },
        })],
      }),
      initialSessionId: 'chat_1',
      initialMessageId: 'msg_action',
      initialPlanId: 'plan_approved',
      initialDataVerificationReturn: {
        result: 'needs_help',
        runId: 'run-other',
        relationship: 'derived',
      },
    });
    await tick(8);

    const target = collectByAttr(root, CHAT_ROUTE_PLAN_TARGET_ATTR)[0]!;
    const review = collectByAttr(
      target,
      CHAT_ROUTE_DATA_VERIFICATION_RETURN_ATTR,
    )[0]!;
    expect(review.getAttribute('data-run-match')).toBe('mismatched');
    expect(review.children.find(
      (child) => child.className === 'chat-data-verification-title',
    )?.textContent).toBe('Data return does not match this action');
    expect(review.children.find(
      (child) => child.className === 'chat-data-verification-detail',
    )?.textContent).toContain(
      'different run than this action’s execution receipt',
    );
    expect(review.children.find(
      (child) => child.tagName === 'A',
    )?.getAttribute('href')).toBe(
      '#logs/run-other/return/chat/session/chat_1/plan/plan_approved/'
      + 'answer/msg_action',
    );
    expect(collectByAttr(
      target,
      CHAT_ROUTE_PLAN_RUN_ATTR,
    )[0]?.getAttribute('href')).toBe(
      '#logs/run-receipt/return/chat/session/chat_1/plan/plan_approved/'
      + 'answer/msg_action',
    );
    const retry = collectByAttr(target, CHAT_ROUTE_PLAN_RETRY_ATTR)[0]!;
    expect(retry.focused).toBe(false);
    expect(collectByAttr(
      target,
      CHAT_ROUTE_DATA_VERIFICATION_DIAGNOSE_ATTR,
    )).toHaveLength(0);
    expect(target.focused).toBe(true);
    expect(calls.some((call) => call.method === 'chat.send')).toBe(false);
    expect(calls.some((call) => call.method === 'chat.plan.approve')).toBe(false);
    route.dispose();
  });

  it('focuses a pending action card without preselecting a decision', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const approved = approvedPlanRecord();
    const pendingPlan = { ...approved.plan };
    delete pendingPlan.resolved_at;
    const pending: ChatPlanRecord = {
      ...approved,
      plan: {
        ...pendingPlan,
        status: 'proposed',
      },
    };
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [sessionSummary()],
        messages: [{ ...chatMessage(), id: 'msg_action' }],
        plans: [pending],
      }),
      initialSessionId: 'chat_1',
      initialMessageId: 'msg_action',
      initialPlanId: 'plan_approved',
    });
    await tick(8);

    const target = collectByAttr(root, CHAT_ROUTE_PLAN_TARGET_ATTR)[0]!;
    expect(target.focused).toBe(true);
    expect(
      collectByAttr(target, CHAT_ROUTE_PLAN_APPROVE_ATTR)[0]?.focused,
    ).toBe(false);
    expect(
      collectByAttr(target, CHAT_ROUTE_PLAN_CANCEL_ATTR)[0]?.focused,
    ).toBe(false);
    route.dispose();
  });

  it('falls back to the linked answer without presenting it as the action', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const fallbackMessage: ChatMessage = {
      ...chatMessage(),
      id: 'msg_action',
      provenance: [{
        source: 'local',
        collection_platform: 'mail',
        collection_slug: 'work',
        record_id: 'mail-1',
      }],
    };
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [sessionSummary()],
        messages: [fallbackMessage],
      }),
      initialSessionId: 'chat_1',
      initialMessageId: 'msg_action',
      initialPlanId: 'plan_missing',
      initialDataVerificationReturn: {
        result: 'reviewed',
        runId: 'run-missing-plan',
        relationship: 'action',
      },
    });
    await tick(8);

    expect(collectByAttr(root, CHAT_ROUTE_PLAN_TARGET_ATTR)).toHaveLength(0);
    expect(
      collectByAttr(root, CHAT_ROUTE_PLAN_TARGET_MISSING_ATTR)[0]?.textContent,
    ).toBe(
      'The exact action card is no longer available. Showing its Chat answer instead.',
    );
    const fallback = collectByAttr(root, CHAT_ROUTE_RETURN_TARGET_ATTR)[0]!;
    expect(fallback.getAttribute(CHAT_ROUTE_MESSAGE_ATTR)).toBe('msg_action');
    expect(fallback.getAttribute('aria-label')).toBe(
      'Chat answer for unavailable action card',
    );
    expect(collectByAttr(
      fallback,
      CHAT_ROUTE_SOURCE_REFERENCES_TOGGLE_ATTR,
    )[0]?.getAttribute('aria-expanded')).toBe('false');
    const review = collectByAttr(
      root,
      CHAT_ROUTE_DATA_VERIFICATION_RETURN_ATTR,
    )[0]!;
    expect(review.getAttribute('data-result')).toBe('reviewed');
    expect(review.children.find(
      (child) => child.className === 'chat-data-verification-title',
    )?.textContent).toBe('Data review marked complete');
    expect(review.children.find(
      (child) => child.className === 'chat-data-verification-detail',
    )?.textContent).toContain(
      'It cannot confirm that the destination changed.',
    );
    route.dispose();
  });

  it('does not claim a missing action when its freshness check fails', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    let sessionGetCalls = 0;
    const baseConn = stepConn({
      calls,
      sessions: [sessionSummary()],
      messages: [{ ...chatMessage(), id: 'msg_action' }],
    }) as unknown as (
      method: string,
      payload?: unknown,
    ) => Promise<unknown>;
    const conn = (async (method: string, payload?: unknown) => {
      if (method !== 'chat.session.get') return baseConn(method, payload);
      sessionGetCalls += 1;
      if (sessionGetCalls === 1) return baseConn(method, payload);
      calls.push({ method, payload });
      throw new Error('offline');
    }) as ChatRouteConn;
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialSessionId: 'chat_1',
    });
    await tick(8);

    expect(route.openPlanLanding({
      sessionId: 'chat_1',
      planId: 'plan_unverified',
      messageId: 'msg_action',
    })).toBe(true);
    await tick(8);

    expect(
      collectByAttr(root, CHAT_ROUTE_PLAN_TARGET_MISSING_ATTR)[0]?.textContent,
    ).toBe(
      'The exact action card could not be verified. Showing its last linked Chat answer instead.',
    );
    expect(
      collectByAttr(root, CHAT_ROUTE_RETURN_TARGET_ATTR)[0]
        ?.getAttribute('aria-label'),
    ).toBe('Chat answer for unavailable action card');
    expect(calls.some((call) => call.method === 'chat.send')).toBe(false);
    route.dispose();
  });

  it('preserves active same-session drafting while targeting a plan in place', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [sessionSummary()],
        messages: [{ ...chatMessage(), id: 'msg_action' }],
        plans: (call) => call === 1 ? [] : [approvedPlanRecord()],
      }),
      initialSessionId: 'chat_1',
    });
    await tick(8);

    fireEvent(
      collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!,
      'input',
      'Keep this unrelated draft',
    );
    expect(route.hasUnsavedChanges()).toBe(true);
    expect(route.openPlanLanding({
      sessionId: 'chat_1',
      planId: 'plan_approved',
      messageId: 'msg_action',
      dataVerification: {
        result: 'needs_help',
        runId: 'run-same-session',
        relationship: 'derived',
      },
    })).toBe(true);
    expect(
      collectByAttr(root, CHAT_ROUTE_PLAN_TARGET_MISSING_ATTR)[0]?.textContent,
    ).toBe('Finding the exact action in Chat…');
    collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.focus();
    await tick(8);
    const recoveredInput = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    expect(recoveredInput.value).toBe(
      'Keep this unrelated draft',
    );
    expect(doc.activeElement).toBe(recoveredInput);
    const target = collectByAttr(root, CHAT_ROUTE_PLAN_TARGET_ATTR)[0]!;
    expect(collectByAttr(
      target,
      CHAT_ROUTE_DATA_VERIFICATION_RETURN_ATTR,
    )[0]?.getAttribute('data-result')).toBe('needs_help');
    const primary = collectByAttr(
      target,
      CHAT_ROUTE_DATA_VERIFICATION_DIAGNOSE_ATTR,
    )[0]!;
    expect(primary.textContent).toBe('Go to current draft');
    expect(primary.focused).toBe(false);
    primary.click();
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe(
      'Keep this unrelated draft',
    );
    expect(collectByAttr(
      root,
      CHAT_ROUTE_DATA_DIAGNOSIS_CONTEXT_ATTR,
    )).toHaveLength(0);
    expect(route.openPlanLanding({
      sessionId: 'chat_other',
      planId: 'plan_other',
    })).toBe(false);
    route.dispose();
  });

  it('settles a checking landing as soon as its live plan arrives', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const listeners = new Map<string, Array<(event: ServerEvent) => void>>();
    let sessionGetCalls = 0;
    let resolveRecovery: (snapshot: unknown) => void = () => {};
    const recovery = new Promise<unknown>((resolve) => {
      resolveRecovery = resolve;
    });
    const snapshot = {
      ...chatSession(),
      messages: [{ ...chatMessage(), id: 'msg_action' }],
      plans: [],
    };
    const baseConn = stepConn({
      sessions: [sessionSummary()],
    }) as unknown as (
      method: string,
      payload?: unknown,
    ) => Promise<unknown>;
    const conn = (async (method: string, payload?: unknown) => {
      if (method !== 'chat.session.get') return baseConn(method, payload);
      sessionGetCalls += 1;
      return sessionGetCalls === 1 ? snapshot : recovery;
    }) as ChatRouteConn;
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialSessionId: 'chat_1',
      subscribe: ((kind: string, listener: (event: ServerEvent) => void) => {
        const rows = listeners.get(kind) ?? [];
        rows.push(listener);
        listeners.set(kind, rows);
        return () => {};
      }) as never,
    });
    await tick(8);

    expect(route.openPlanLanding({
      sessionId: 'chat_1',
      planId: 'plan_live',
      messageId: 'msg_action',
    })).toBe(true);
    expect(
      collectByAttr(root, CHAT_ROUTE_PLAN_TARGET_MISSING_ATTR)[0]?.textContent,
    ).toBe('Finding the exact action in Chat…');

    const event: Extract<ServerEvent, { kind: 'chat.plan_proposed' }> = {
      kind: 'chat.plan_proposed',
      session_id: 'chat_1',
      turn_id: 'turn_live',
      plan_id: 'plan_live',
      tool: 'mail.send',
      tier: 2,
      args: { to: 'mary@example.com', subject: 'Live' },
      args_hash: 'hash-live',
      created_at: 1_700_000_004_000,
      cursor: 1,
    };
    for (const listener of listeners.get(event.kind) ?? []) listener(event);

    expect(
      collectByAttr(root, CHAT_ROUTE_PLAN_TARGET_MISSING_ATTR),
    ).toHaveLength(0);
    expect(
      collectByAttr(root, CHAT_ROUTE_PLAN_TARGET_ATTR)[0]
        ?.getAttribute('data-plan-id'),
    ).toBe('plan_live');
    expect(collectByAttr(
      root,
      CHAT_ROUTE_PLAN_TARGET_ATTR,
    )[0]?.focused).toBe(true);

    resolveRecovery(snapshot);
    await tick(8);
    expect(
      collectByAttr(root, CHAT_ROUTE_PLAN_TARGET_ATTR)[0]
        ?.getAttribute('data-plan-id'),
    ).toBe('plan_live');
    route.dispose();
  });

  it('keeps the Chat usable when a returned cited answer no longer exists', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [sessionSummary()],
        messages: [{ ...chatMessage(), id: 'msg_other' }],
      }),
      initialSessionId: 'chat_1',
      initialMessageId: 'msg_deleted',
    });
    await tick(8);

    expect(collectByAttr(root, CHAT_ROUTE_RETURN_TARGET_ATTR)).toHaveLength(0);
    expect(
      collectByAttr(root, CHAT_ROUTE_RETURN_MISSING_ATTR)[0]?.textContent,
    ).toBe(
      'The cited answer is no longer available. This chat is still open.',
    );
    expect(route.getThread().session?.id).toBe('chat_1');
    route.dispose();
  });

  it('keeps the compact greeting for returning users with completed history', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ sessions: [sessionSummary()] }),
      enableFirstRunActivation: true,
    });
    await tick();

    expect(collectByAttr(root, CHAT_ROUTE_ACTIVATION_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CHAT_ROUTE_GREETING_ATTR)).toHaveLength(1);
    route.dispose();
  });

  it('turns bare Chat into a grouped, searchable returning-user history landing', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const now = new Date(2026, 6, 27, 12, 0, 0).getTime();
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [
          sessionSummary({
            id: 'today',
            title: 'Plan today',
            last_active_at: now - 5 * 60_000,
            message_count: 3,
          }),
          sessionSummary({
            id: 'week',
            title: 'Weekly review',
            last_active_at: now - 3 * 86_400_000,
          }),
          sessionSummary({
            id: 'older',
            title: 'Legacy migration',
            last_active_at: now - 30 * 86_400_000,
          }),
          sessionSummary({
            id: 'archived',
            title: 'Archived notes',
            archived: true,
            last_active_at: now - 60_000,
          }),
        ],
      }),
      initialLanding: 'history',
      now: () => now,
    });
    await tick();

    const landing = collectByAttr(root, CHAT_ROUTE_HISTORY_LANDING_ATTR)[0]!;
    expect(allText(landing)).toContain('Continue “Plan today”?');
    expect(allText(landing)).toContain('3 messages · 5 min ago');
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CHAT_ROUTE_HISTORY_GROUP_ATTR).map(
      (group) => group.getAttribute(CHAT_ROUTE_HISTORY_GROUP_ATTR),
    )).toEqual(['today', 'week', 'older', 'archived']);

    const search = collectByAttr(root, CHAT_ROUTE_HISTORY_SEARCH_ATTR)[0]!;
    fireEvent(search, 'input', 'legacy');
    expect(collectByAttr(root, CHAT_ROUTE_SESSION_ROW_ATTR).map(
      (row) => row.getAttribute(CHAT_ROUTE_SESSION_ROW_ATTR),
    )).toEqual(['older']);
    fireEvent(search, 'input', 'missing');
    expect(collectByAttr(root, CHAT_ROUTE_SESSION_ROW_ATTR)).toHaveLength(0);
    expect(allText(collectByAttr(root, CHAT_ROUTE_HISTORY_EMPTY_ATTR)[0]!))
      .toContain('No matching chats');
    route.dispose();
  });

  it('owns one history action menu and dismisses it with Escape or an outside press', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [
          sessionSummary({ id: 'chat_1', title: 'First chat' }),
          sessionSummary({ id: 'chat_2', title: 'Second chat' }),
        ],
      }),
      initialLanding: 'history',
    });
    await tick();

    const details = collectByAttr(root, CHAT_ROUTE_SESSION_ACTIONS_ATTR);
    const first = details.find(
      (row) => row.getAttribute(CHAT_ROUTE_SESSION_ACTIONS_ATTR) === 'chat_1',
    )!;
    const second = details.find(
      (row) => row.getAttribute(CHAT_ROUTE_SESSION_ACTIONS_ATTR) === 'chat_2',
    )!;
    expect(first.getAttribute('aria-label')).toBe('Actions for First chat');
    expect(second.getAttribute('aria-label')).toBe('Actions for Second chat');
    const firstTrigger = collectByTag(first, 'summary')[0]!;
    const secondTrigger = collectByTag(second, 'summary')[0]!;
    expect(firstTrigger.getAttribute('aria-label')).toBe('Actions for First chat');
    expect(secondTrigger.getAttribute('aria-label')).toBe('Actions for Second chat');

    firstTrigger.click();
    expect(first.open).toBe(true);
    secondTrigger.click();
    expect(first.open).toBe(false);
    expect(second.open).toBe(true);

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    for (const listener of second.listeners.get('keydown') ?? []) {
      listener({
        key: 'Escape',
        target: secondTrigger,
        preventDefault,
        stopPropagation,
      });
    }
    expect(second.open).toBe(false);
    expect(doc.activeElement).toBe(secondTrigger);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();

    firstTrigger.click();
    expect(first.open).toBe(true);
    const search = collectByAttr(root, CHAT_ROUTE_HISTORY_SEARCH_ATTR)[0]!;
    for (const listener of doc.listeners.get('pointerdown') ?? []) {
      listener({ target: search });
    }
    expect(first.open).toBe(false);

    route.dispose();
    expect(doc.listeners.get('pointerdown')).toHaveLength(0);
  });

  it('coordinates and dismisses the docked composer action menu', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [sessionSummary()],
        messages: [chatMessage()],
      }),
      initialSessionId: 'chat_1',
      contactUpsertCaller: vi.fn(async () => ({ contact: {} as never })),
    });
    await tick(8);

    const composerActions = collectByAttr(
      root,
      CHAT_ROUTE_COMPOSER_MORE_ATTR,
    )[0]!;
    const composerTrigger = collectByTag(composerActions, 'summary')[0]!;
    expect(composerActions.getAttribute('aria-label'))
      .toBe('Chat composer actions');
    expect(composerTrigger.getAttribute('aria-label'))
      .toBe('More Chat composer actions');
    const historyActions = collectByAttr(
      root,
      CHAT_ROUTE_SESSION_ACTIONS_ATTR,
    )[0]!;
    const historyTrigger = collectByTag(historyActions, 'summary')[0]!;

    composerTrigger.click();
    expect(composerActions.open).toBe(true);
    historyTrigger.click();
    expect(composerActions.open).toBe(false);
    expect(historyActions.open).toBe(true);
    composerTrigger.click();
    expect(historyActions.open).toBe(false);
    expect(composerActions.open).toBe(true);

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    for (const listener of composerActions.listeners.get('keydown') ?? []) {
      listener({
        key: 'Escape',
        target: composerTrigger,
        preventDefault,
        stopPropagation,
      });
    }
    expect(composerActions.open).toBe(false);
    expect(doc.activeElement).toBe(composerTrigger);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();

    composerTrigger.click();
    const input = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    for (const listener of doc.listeners.get('pointerdown') ?? []) {
      listener({ target: input });
    }
    expect(composerActions.open).toBe(false);
    route.dispose();
  });

  it('hands the shell Run opener a stable docked-composer focus target', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const openRunPalette = vi.fn();
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [sessionSummary()],
        messages: [chatMessage()],
      }),
      initialSessionId: 'chat_1',
      openRunPalette,
    });
    await tick(8);

    const composerActions = collectByAttr(
      root,
      CHAT_ROUTE_COMPOSER_MORE_ATTR,
    )[0]!;
    const trigger = collectByTag(composerActions, 'summary')[0]!;
    trigger.click();
    const run = collectByAttr(
      composerActions,
      CHAT_ROUTE_COMPOSER_ACTION_ATTR,
    ).find(
      (action) => action.getAttribute(CHAT_ROUTE_COMPOSER_ACTION_ATTR) === 'run',
    )!;
    expect(run.getAttribute('aria-label')).toBe('Run a recipe');
    run.focus();
    run.click();
    expect(openRunPalette).toHaveBeenCalledOnce();
    expect(composerActions.open).toBe(false);
    expect(doc.activeElement).toBe(trigger);
    route.dispose();
  });

  it('does not promote archived or zero-message sessions as the next chat', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [
          sessionSummary({
            id: 'archived',
            title: 'Archived chat',
            archived: true,
          }),
          sessionSummary({
            id: 'empty',
            title: 'Empty chat',
            message_count: 0,
          }),
        ],
      }),
      initialLanding: 'history',
    });
    await tick();

    expect(collectByAttr(root, CHAT_ROUTE_HISTORY_LANDING_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)).toHaveLength(1);
    route.dispose();
  });

  it('continues the latest chat in place and publishes a durable session address', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const addresses: Array<{ hash: string; mode: string }> = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        sessions: [sessionSummary()],
        messages: [chatMessage()],
      }),
      initialLanding: 'history',
      onAddressChange: (hash, mode) => addresses.push({ hash, mode }),
    });
    await tick();
    collectByAttr(root, CHAT_ROUTE_HISTORY_CONTINUE_ATTR)[0]!.click();
    await tick(8);

    expect(route.getThread().session?.id).toBe('chat_1');
    expect(addresses).toEqual([
      { hash: '#chat/session/chat_1', mode: 'push' },
    ]);
    expect(collectByAttr(root, CHAT_ROUTE_HISTORY_LANDING_ATTR)).toHaveLength(0);
    expect(doc.activeElement?.getAttribute('data-recued-chat-route-thread-title'))
      .toBe('');
    route.dispose();
  });

  it('keeps a slow history open focused, visible, and single-flight', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    let sessionGetCalls = 0;
    let resolveOpen!: (snapshot: unknown) => void;
    const pendingOpen = new Promise<unknown>((resolve) => {
      resolveOpen = resolve;
    });
    const baseConn = stepConn({
      sessions: [sessionSummary()],
    }) as unknown as (
      method: string,
      payload?: unknown,
    ) => Promise<unknown>;
    const conn = (async (method: string, payload?: unknown) => {
      if (method !== 'chat.session.get') return baseConn(method, payload);
      sessionGetCalls += 1;
      return pendingOpen;
    }) as ChatRouteConn;
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialLanding: 'history',
    });
    await tick(8);

    const initial = collectByAttr(root, CHAT_ROUTE_SESSION_ROW_ATTR)[0]!;
    initial.focus();
    initial.click();
    const pending = collectByAttr(root, CHAT_ROUTE_SESSION_ROW_ATTR)[0]!;
    expect(pending.disabled).toBe(false);
    expect(pending.getAttribute('aria-disabled')).toBe('true');
    expect(pending.getAttribute('aria-busy')).toBe('true');
    expect(allText(pending)).toContain('Opening…');
    expect(doc.activeElement).toBe(pending);
    pending.click();
    pending.click();
    expect(sessionGetCalls).toBe(1);

    resolveOpen({ ...chatSession(), messages: [] });
    await tick(8);
    expect(route.getThread().session?.id).toBe('chat_1');
    route.dispose();
  });

  it('keeps returning-user Continue focused and blocks a competing new draft', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    let sessionGetCalls = 0;
    let resolveOpen!: (snapshot: unknown) => void;
    const pendingOpen = new Promise<unknown>((resolve) => {
      resolveOpen = resolve;
    });
    const baseConn = stepConn({
      sessions: [sessionSummary()],
    }) as unknown as (
      method: string,
      payload?: unknown,
    ) => Promise<unknown>;
    const conn = (async (method: string, payload?: unknown) => {
      if (method !== 'chat.session.get') return baseConn(method, payload);
      sessionGetCalls += 1;
      return pendingOpen;
    }) as ChatRouteConn;
    const addresses: string[] = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialLanding: 'history',
      onAddressChange: (hash) => addresses.push(hash),
    });
    await tick(8);

    const initial = collectByAttr(root, CHAT_ROUTE_HISTORY_CONTINUE_ATTR)[0]!;
    initial.focus();
    initial.click();
    const pending = collectByAttr(root, CHAT_ROUTE_HISTORY_CONTINUE_ATTR)[0]!;
    const newChat = collectByAttr(root, CHAT_ROUTE_NEW_SESSION_ATTR)[0]!;
    const startNew = collectByTag(root, 'button').find(
      (button) => button.textContent === 'Start a new chat',
    )!;
    expect(pending.textContent).toBe('Opening chat…');
    expect(pending.getAttribute('aria-disabled')).toBe('true');
    expect(pending.getAttribute('aria-busy')).toBe('true');
    expect(pending.disabled).toBe(false);
    expect(doc.activeElement).toBe(pending);
    expect(newChat.getAttribute('aria-disabled')).toBe('true');
    expect(startNew.getAttribute('aria-disabled')).toBe('true');
    pending.click();
    newChat.click();
    startNew.click();
    expect(sessionGetCalls).toBe(1);
    expect(collectByAttr(root, CHAT_ROUTE_HISTORY_LANDING_ATTR)).toHaveLength(1);
    expect(addresses).toEqual([]);

    resolveOpen({ ...chatSession(), messages: [] });
    await tick(8);
    expect(addresses).toEqual(['#chat/session/chat_1']);
    expect(doc.activeElement?.getAttribute(CHAT_ROUTE_INPUT_ATTR)).toBe('');
    route.dispose();
  });

  it('protects an unsent draft before switching conversations', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const sessions = [
      sessionSummary({ id: 'chat_1', title: 'First chat' }),
      sessionSummary({ id: 'chat_2', title: 'Second chat' }),
    ];
    const addresses: string[] = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({ sessions }),
      initialSessionId: 'chat_1',
      onAddressChange: (hash) => addresses.push(hash),
    });
    await tick(8);
    fireEvent(
      collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!,
      'input',
      'keep this draft',
    );
    collectByAttr(root, CHAT_ROUTE_SESSION_ROW_ATTR).find(
      (row) => row.getAttribute(CHAT_ROUTE_SESSION_ROW_ATTR) === 'chat_2',
    )!.click();
    expect(route.getThread().session?.id).toBe('chat_1');
    expect(collectByAttr(root, CHAT_ROUTE_HISTORY_DRAFT_GUARD_ATTR)).toHaveLength(1);

    const discard = collectByTag(
      collectByAttr(root, CHAT_ROUTE_HISTORY_DRAFT_GUARD_ATTR)[0]!,
      'button',
    ).find((button) => button.textContent === 'Discard and open')!;
    discard.click();
    await tick(8);
    expect(route.getThread().session?.id).toBe('chat_2');
    expect(addresses).toEqual(['#chat/session/chat_2']);
    route.dispose();
  });

  it('exports and safely confirms deletion from history using existing Chat RPCs', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const downloads: Array<{ bundle: unknown; filename: string }> = [];
    const addresses: Array<{ hash: string; mode: string }> = [];
    let finishExport!: (value: unknown) => void;
    const exportPending = new Promise<unknown>((resolve) => {
      finishExport = resolve;
    });
    let finishDelete!: (value: { ok: true }) => void;
    const deletePending = new Promise<{ ok: true }>((resolve) => {
      finishDelete = resolve;
    });
    const conn = (async (method: string, payload?: unknown) => {
      calls.push({ method, payload });
      if (method === 'chat.sessions.list') {
        return { sessions: [sessionSummary()] };
      }
      if (method === 'chat.session.export') {
        return exportPending;
      }
      if (method === 'chat.session.get') {
        return { ...chatSession(), messages: [chatMessage()], plans: [] };
      }
      if (method === 'chat.session.delete') return deletePending;
      if (method === 'server.getLLMConfig') return { config: {} };
      if (method === 'chat.default_model_pref.get') {
        return { source_id: null, updated_at: 1 };
      }
      if (method === 'prefs.get') return { prefs: {} };
      throw new Error(`unexpected method ${method}`);
    }) as ChatRouteConn;
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialLanding: 'history',
      initialSessionId: 'chat_1',
      onAddressChange: (hash, mode) => addresses.push({ hash, mode }),
      downloadExport: (bundle, filename) => {
        downloads.push({ bundle, filename });
      },
    });
    await tick(8);

    expect(collectByAttr(root, CHAT_ROUTE_SESSION_ACTIONS_ATTR)).toHaveLength(1);
    const initialActions = collectByAttr(
      root,
      CHAT_ROUTE_SESSION_ACTIONS_ATTR,
    )[0]!;
    collectByTag(initialActions, 'summary')[0]!.click();
    const initialExport = collectByAttr(
      root,
      CHAT_ROUTE_SESSION_EXPORT_ATTR,
    )[0]!;
    initialExport.focus();
    initialExport.click();
    expect(route.hasInFlightWork()).toBe(true);
    const busyActions = collectByAttr(
      root,
      CHAT_ROUTE_SESSION_ACTIONS_ATTR,
    )[0]!;
    const busyExport = collectByAttr(
      root,
      CHAT_ROUTE_SESSION_EXPORT_ATTR,
    )[0]!;
    expect(busyActions.open).toBe(true);
    expect(busyExport.textContent).toBe('Exporting…');
    expect(busyExport.disabled).toBe(false);
    expect(busyExport.getAttribute('aria-disabled')).toBe('true');
    expect(busyExport.getAttribute('aria-busy')).toBe('true');
    expect(doc.activeElement).toBe(busyExport);
    expect(route.inFlightWorkPrompt()).toBe(
      'A chat history action is still in progress. Leave Chat anyway?',
    );
    const exportNewChat = collectByAttr(
      root,
      CHAT_ROUTE_NEW_SESSION_ATTR,
    )[0]!;
    expect(exportNewChat.getAttribute('aria-disabled')).toBe('true');
    exportNewChat.click();
    expect(route.getThread().session?.id).toBe('chat_1');
    expect(doc.activeElement).toBe(busyExport);
    busyExport.click();
    expect(calls.filter((call) => call.method === 'chat.session.export'))
      .toHaveLength(1);
    finishExport({ session: chatSession(), messages: [chatMessage()] });
    await tick(8);
    expect(route.hasInFlightWork()).toBe(false);
    expect(route.inFlightWorkPrompt()).toBeNull();
    expect(calls).toContainEqual({
      method: 'chat.session.export',
      payload: { session_id: 'chat_1' },
    });
    expect(downloads[0]?.filename).toBe('ops-chat.json');
    expect(allText(collectByAttr(root, CHAT_ROUTE_HISTORY_ANNOUNCER_ATTR)[0]!))
      .toContain('Exported Ops chat');

    collectByAttr(root, CHAT_ROUTE_SESSION_DELETE_ATTR)[0]!.click();
    expect(collectByAttr(root, CHAT_ROUTE_SESSION_DELETE_CONFIRM_ATTR)).toHaveLength(1);
    collectByAttr(root, CHAT_ROUTE_SESSION_DELETE_CONFIRM_ATTR)[0]!.click();
    expect(route.hasInFlightWork()).toBe(true);
    const busyDelete = collectByAttr(
      root,
      CHAT_ROUTE_SESSION_DELETE_CONFIRM_ATTR,
    )[0]!;
    expect(busyDelete.textContent).toBe('Deleting…');
    expect(busyDelete.disabled).toBe(false);
    expect(busyDelete.getAttribute('aria-disabled')).toBe('true');
    expect(busyDelete.getAttribute('aria-busy')).toBe('true');
    expect(doc.activeElement).toBe(busyDelete);
    expect(route.inFlightWorkPrompt()).toBe(
      'A chat history action is still in progress. Leave Chat anyway?',
    );
    const deleteNewChat = collectByAttr(
      root,
      CHAT_ROUTE_NEW_SESSION_ATTR,
    )[0]!;
    expect(deleteNewChat.getAttribute('aria-disabled')).toBe('true');
    deleteNewChat.click();
    expect(route.getThread().session?.id).toBe('chat_1');
    expect(doc.activeElement).toBe(busyDelete);
    finishDelete({ ok: true });
    await tick(8);
    expect(route.hasInFlightWork()).toBe(false);
    expect(route.inFlightWorkPrompt()).toBeNull();
    expect(calls).toContainEqual({
      method: 'chat.session.delete',
      payload: { session_id: 'chat_1' },
    });
    expect(collectByAttr(root, CHAT_ROUTE_SESSION_ROW_ATTR)).toHaveLength(0);
    expect(allText(collectByAttr(root, CHAT_ROUTE_HISTORY_EMPTY_ATTR)[0]!))
      .toContain('No saved chats yet');
    expect(addresses).toEqual([{ hash: '#chat', mode: 'replace' }]);
    expect(doc.activeElement?.getAttribute(CHAT_ROUTE_NEW_SESSION_ATTR)).toBe('');
    route.dispose();
  });

  it('returns rejected history actions to their visible retry controls', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: string[] = [];
    const conn = (async (method: string) => {
      calls.push(method);
      if (method === 'chat.sessions.list') {
        return { sessions: [sessionSummary()] };
      }
      if (method === 'chat.session.get') {
        return { ...chatSession(), messages: [chatMessage()], plans: [] };
      }
      if (
        method === 'chat.session.export'
        || method === 'chat.session.delete'
      ) {
        throw new Error('simulated history action failure');
      }
      if (method === 'server.getLLMConfig') return { config: {} };
      if (method === 'chat.default_model_pref.get') {
        return { source_id: null, updated_at: 1 };
      }
      if (method === 'prefs.get') return { prefs: {} };
      throw new Error(`unexpected method ${method}`);
    }) as ChatRouteConn;
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
      initialLanding: 'history',
      initialSessionId: 'chat_1',
    });
    await tick(8);

    const actions = collectByAttr(
      root,
      CHAT_ROUTE_SESSION_ACTIONS_ATTR,
    )[0]!;
    collectByTag(actions, 'summary')[0]!.click();
    collectByAttr(root, CHAT_ROUTE_SESSION_EXPORT_ATTR)[0]!.click();
    await tick(8);

    const exportRetryActions = collectByAttr(
      root,
      CHAT_ROUTE_SESSION_ACTIONS_ATTR,
    )[0]!;
    const exportRetry = collectByAttr(
      root,
      CHAT_ROUTE_SESSION_EXPORT_ATTR,
    )[0]!;
    expect(exportRetryActions.open).toBe(true);
    expect(doc.activeElement).toBe(exportRetry);
    expect(allText(root)).toContain("Couldn't export this chat");

    collectByAttr(root, CHAT_ROUTE_SESSION_DELETE_ATTR)[0]!.click();
    collectByAttr(root, CHAT_ROUTE_SESSION_DELETE_CONFIRM_ATTR)[0]!.click();
    await tick(8);

    const deleteRetryActions = collectByAttr(
      root,
      CHAT_ROUTE_SESSION_ACTIONS_ATTR,
    )[0]!;
    const deleteRetry = collectByAttr(
      root,
      CHAT_ROUTE_SESSION_DELETE_ATTR,
    )[0]!;
    expect(deleteRetryActions.open).toBe(true);
    expect(doc.activeElement).toBe(deleteRetry);
    expect(allText(root)).toContain("Couldn't delete this chat");
    expect(calls.filter((method) => method === 'chat.session.export'))
      .toHaveLength(1);
    expect(calls.filter((method) => method === 'chat.session.delete'))
      .toHaveLength(1);
    route.dispose();
  });

  it('replaces a draft URL with the durable session minted by the first send', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const addresses: Array<{ hash: string; mode: string }> = [];
    const listeners = new Map<string, Array<(event: never) => void>>();
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn(),
      onAddressChange: (hash, mode) => addresses.push({ hash, mode }),
      subscribe: ((kind: string, listener: (event: never) => void) => {
        const rows = listeners.get(kind) ?? [];
        rows.push(listener);
        listeners.set(kind, rows);
        return () => {};
      }) as never,
    });
    await tick();
    await route.sendMessage('durable first message');
    await tick();
    expect(addresses).toContainEqual({
      hash: '#chat/session/chat_new',
      mode: 'replace',
    });
    for (const listener of listeners.get('chat.message_complete') ?? []) {
      listener({
        kind: 'chat.message_complete',
        session_id: 'chat_new',
        turn_id: 'turn_1',
        final: {
          ...chatMessage(),
          id: 'msg_durable_first',
          session_id: 'chat_new',
        },
        cursor: 1,
      } as never);
    }
    await tick();
    route.startNewChat();
    expect(addresses.at(-1)).toEqual({ hash: '#chat/new', mode: 'push' });
    route.dispose();
  });

  it('retires the activation surface after a completed chat event', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const listeners = new Map<string, Array<(event: never) => void>>();
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn(),
      enableFirstRunActivation: true,
      subscribe: ((kind: string, listener: (event: never) => void) => {
        const rows = listeners.get(kind) ?? [];
        rows.push(listener);
        listeners.set(kind, rows);
        return () => {};
      }) as never,
    });
    await tick();
    expect(collectByAttr(root, CHAT_ROUTE_ACTIVATION_ATTR)).toHaveLength(1);

    const event = {
      kind: 'chat.message_complete',
      session_id: 'chat_elsewhere',
      turn_id: 'turn_done',
      final: { ...chatMessage(), id: 'msg_done', content: 'Done.' },
      cursor: 1,
    };
    for (const listener of listeners.get('chat.message_complete') ?? []) {
      listener(event as never);
    }
    await tick();

    expect(collectByAttr(root, CHAT_ROUTE_ACTIVATION_ATTR)).toHaveLength(0);
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
    expect(doc.activeElement?.getAttribute(CHAT_ROUTE_INPUT_ATTR)).toBe('');
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
    expect(thread.getAttribute('aria-label')).toBe('Chat conversation');
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

  it('renders the picker AS the "Set up Chat →" link when no source is configured', async () => {
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
    expect(link.getAttribute('href')).toBe('#settings/ai-models/setup/start');
    expect(link.textContent).toBe('Set up Chat →');
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
    const picker = collectByAttr(root, CHAT_ROUTE_MODEL_PICKER_ATTR)[0]!;
    picker.focus();
    fireEvent(picker, 'change', 'slot_2');
    await tick();
    const setCall = calls.find((c) => c.method === 'chat.session.set_model_pref');
    expect(setCall?.payload).toEqual({
      session_id: 'chat_1',
      model_pref: { current: 'byok', model_hint: 'thinking', source_id: 'slot_2' },
    });
    expect(doc.activeElement?.getAttribute(CHAT_ROUTE_MODEL_PICKER_ATTR)).toBe('');
    route.dispose();
  });

  it('serializes rapid model changes and keeps the latest selection', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const writes: Array<{ method: string; payload?: unknown }> = [];
    let resolveFirst!: (value: { ok: true }) => void;
    let resolveSecond!: (value: { ok: true }) => void;
    const first = new Promise<{ ok: true }>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<{ ok: true }>((resolve) => {
      resolveSecond = resolve;
    });
    const baseConn = stepConn({ llmConfig: twoSlotConfig }) as unknown as (
      method: string,
      payload?: unknown,
    ) => Promise<unknown>;
    const conn = (async (method: string, payload?: unknown) => {
      if (method !== 'chat.session.set_model_pref') {
        return baseConn(method, payload);
      }
      writes.push({ method, payload });
      return writes.length === 1 ? first : second;
    }) as ChatRouteConn;
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });
    await tick(8);
    await route.openSession('chat_1');
    await tick();

    const initialPicker = collectByAttr(
      root,
      CHAT_ROUTE_MODEL_PICKER_ATTR,
    )[0]!;
    initialPicker.focus();
    fireEvent(initialPicker, 'change', 'slot_2');
    const firstPendingPicker = collectByAttr(
      root,
      CHAT_ROUTE_MODEL_PICKER_ATTR,
    )[0]!;
    expect(firstPendingPicker.value).toBe('slot_2');
    expect(firstPendingPicker.getAttribute('aria-busy')).toBe('true');
    expect(doc.activeElement).toBe(firstPendingPicker);
    expect(route.hasInFlightWork()).toBe(true);
    expect(route.inFlightWorkPrompt()).toBe(
      'A Chat model change is still in progress. Leave Chat anyway?',
    );

    fireEvent(firstPendingPicker, 'change', 'slot_1');
    const latestPicker = collectByAttr(
      root,
      CHAT_ROUTE_MODEL_PICKER_ATTR,
    )[0]!;
    expect(latestPicker.value).toBe('slot_1');
    expect(writes).toHaveLength(1);

    resolveFirst({ ok: true });
    await tick(8);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.payload).toEqual({
      session_id: 'chat_1',
      model_pref: { current: 'byok', model_hint: 'fast', source_id: 'slot_1' },
    });
    expect(collectByAttr(root, CHAT_ROUTE_MODEL_PICKER_ATTR)[0]!.value)
      .toBe('slot_1');

    resolveSecond({ ok: true });
    await tick(8);
    const settledPicker = collectByAttr(
      root,
      CHAT_ROUTE_MODEL_PICKER_ATTR,
    )[0]!;
    expect(settledPicker.value).toBe('slot_1');
    expect(settledPicker.getAttribute('aria-busy')).toBeNull();
    expect(doc.activeElement).toBe(settledPicker);
    expect(route.hasInFlightWork()).toBe(false);
    expect(route.inFlightWorkPrompt()).toBeNull();
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
    const picker = collectByAttr(root, CHAT_ROUTE_MODEL_PICKER_ATTR)[0]!;
    picker.focus();
    fireEvent(picker, 'change', 'free_pool');
    await tick();
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe(
      'half-written thought',
    );
    expect(doc.activeElement?.getAttribute(CHAT_ROUTE_MODEL_PICKER_ATTR)).toBe('');
    route.dispose();
  });

  it('restores a captured reauth draft into the exact durable session without sending it', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const recoveryDraft = {
      text: 'Draft the customer follow-up before sending.',
      protected: true,
      modelSourceId: null,
    } as const;
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        calls,
        sessions: [sessionSummary()],
        messages: [chatMessage()],
      }),
      initialSessionId: 'chat_1',
      initialRecoveryDraft: recoveryDraft,
    });

    // The draft is protected even before the initial async reads finish. A
    // second immediate disconnect must be able to recapture it rather than
    // losing the in-memory handoff between pair and composer hydration.
    expect(route.hasUnsavedChanges()).toBe(true);
    expect(route.getRecoveryDraft()).toEqual(recoveryDraft);

    await tick(8);

    const input = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    expect(route.getThread().session?.id).toBe('chat_1');
    expect(input.value).toBe(recoveryDraft.text);
    expect(doc.activeElement).toBe(input);
    expect(route.hasUnsavedChanges()).toBe(true);
    expect(route.getRecoveryDraft()).toEqual(recoveryDraft);
    expect(calls.some((call) => call.method === 'chat.send')).toBe(false);
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
    expect(send.disabled).toBe(true);
    fireEvent(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!, 'input', 'via the button');
    expect(send.disabled).toBe(false); // a real draft can lazy-create on Send
    send.focus();
    send.click();
    await tick();
    expect(
      calls.find((c) => c.method === 'chat.session.create')?.payload,
    ).toEqual({ title: 'via the button' });
    const sendCall = calls.find((c) => c.method === 'chat.send');
    expect((sendCall?.payload as { message?: string })?.message).toBe(
      'via the button',
    );
    expect(doc.activeElement?.getAttribute(CHAT_ROUTE_INPUT_ATTR)).toBe('');
    route.dispose();
  });

  it('announces a rejected send while returning to the editable draft', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const baseConn = stepConn() as unknown as (
      method: string,
      payload?: unknown,
    ) => Promise<unknown>;
    const conn = (async (method: string, payload?: unknown) => {
      if (method === 'chat.send') {
        throw new Error('simulated send failure');
      }
      return baseConn(method, payload);
    }) as ChatRouteConn;
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn,
    });
    await tick(8);
    await route.openSession('chat_1');
    await tick();

    const input = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    fireEvent(input, 'input', 'Keep this retryable message');
    input.focus();
    await route.sendMessage(input.value);
    await tick(8);

    const restoredInput = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    const error = collectByAttr(root, CHAT_ROUTE_ERROR_ATTR)[0]!;
    expect(error.getAttribute('role')).toBe('alert');
    expect(allText(error).length).toBeGreaterThan(0);
    expect(restoredInput.value).toBe('Keep this retryable message');
    expect(doc.activeElement).toBe(restoredInput);
    expect(collectByAttr(root, CHAT_ROUTE_SEND_ATTR)[0]!.disabled).toBe(false);
    expect(route.hasInFlightWork()).toBe(false);
    route.dispose();
  });

  it('keeps a pending send attached while the next composer draft stays editable', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const calls: Array<{ method: string; payload?: unknown }> = [];
    const addresses: string[] = [];
    const route = bootstrapChatRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      conn: stepConn({
        calls,
        sessions: [
          sessionSummary({ id: 'chat_1', title: 'First chat' }),
          sessionSummary({ id: 'chat_2', title: 'Second chat' }),
        ],
      }),
      initialSessionId: 'chat_1',
      onAddressChange: (hash) => addresses.push(hash),
    });
    await tick(8);

    const firstInput = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    fireEvent(firstInput, 'input', 'Start the pending answer');
    await route.sendMessage(firstInput.value);
    await tick(8);
    expect(route.hasInFlightWork()).toBe(true);

    const nextInput = collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!;
    fireEvent(nextInput, 'input', 'Keep this next thought');
    nextInput.focus();
    const newChat = collectByAttr(root, CHAT_ROUTE_NEW_SESSION_ATTR)[0]!;
    const otherChat = collectByAttr(root, CHAT_ROUTE_SESSION_ROW_ATTR).find(
      (row) => row.getAttribute(CHAT_ROUTE_SESSION_ROW_ATTR) === 'chat_2',
    )!;
    expect(newChat.disabled).toBe(false);
    expect(newChat.getAttribute('aria-disabled')).toBe('true');
    expect(otherChat.disabled).toBe(false);
    expect(otherChat.getAttribute('aria-disabled')).toBe('true');

    newChat.click();
    otherChat.click();
    await tick();
    expect(route.getThread().session?.id).toBe('chat_1');
    expect(collectByAttr(root, CHAT_ROUTE_HISTORY_DRAFT_GUARD_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value)
      .toBe('Keep this next thought');
    expect(doc.activeElement).toBe(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]);
    expect(calls.filter((call) => call.method === 'chat.session.get'))
      .toHaveLength(1);
    expect(addresses).toEqual([]);
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

  it('"New chat" protects a typed draft before clearing it', async () => {
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
    expect(collectByAttr(root, CHAT_ROUTE_HISTORY_DRAFT_GUARD_ATTR)).toHaveLength(1);
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe('unsent text');
    const discard = collectByTag(
      collectByAttr(root, CHAT_ROUTE_HISTORY_DRAFT_GUARD_ATTR)[0]!,
      'button',
    ).find((button) => button.textContent === 'Discard and start new')!;
    discard.click();
    await tick();
    expect(collectByAttr(root, CHAT_ROUTE_INPUT_ATTR)[0]!.value).toBe('');
    expect(calls.some((c) => c.method === 'chat.session.create')).toBe(false);
    route.dispose();
  });
});
