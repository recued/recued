import { describe, expect, it, vi } from 'vitest';

import {
  mountPermissionsPanel,
  MCP_DOOR_TOKEN_LABEL,
  MCP_DOOR_CONTRACT_NAME,
  MCP_DOOR_CONTRACT_SCOPE,
  PERMISSION_DOORS,
  PERMISSIONS_MCP_DOOR_ADVANCED_ATTR,
  PERMISSIONS_MCP_DOOR_ADVANCED_CAP_INPUT_ATTR,
  PERMISSIONS_MCP_DOOR_ADVANCED_CAP_TOGGLE_ATTR,
  PERMISSIONS_MCP_DOOR_ADVANCED_ERROR_ATTR,
  PERMISSIONS_MCP_DOOR_ADVANCED_EXPIRY_INPUT_ATTR,
  PERMISSIONS_MCP_DOOR_ADVANCED_EXPIRY_TOGGLE_ATTR,
  PERMISSIONS_MCP_DOOR_ADVANCED_NOTE_ATTR,
  PERMISSIONS_MCP_DOOR_ADVANCED_SAVE_ATTR,
  PERMISSIONS_MCP_DOOR_ADVANCED_SUMMARY_ATTR,
  PERMISSIONS_CREATE_ACTOR_ATTR,
  PERMISSIONS_CREATE_APPROVAL_ATTR,
  PERMISSIONS_CREATE_DENIED_ATTR,
  PERMISSIONS_CREATE_ERROR_ATTR,
  PERMISSIONS_CREATE_FORM_ATTR,
  PERMISSIONS_CREATE_INGREDIENT_ATTR,
  PERMISSIONS_CREATE_MAXRISK_ATTR,
  PERMISSIONS_CREATE_OPERATION_ATTR,
  PERMISSIONS_CREATE_SAVE_ATTR,
  PERMISSIONS_DELETE_BUTTON_ATTR,
  PERMISSIONS_DELETE_CANCEL_ATTR,
  PERMISSIONS_DELETE_CONFIRM_ATTR,
  PERMISSIONS_DOOR_INFO_ATTR,
  PERMISSIONS_DOOR_ROW_ATTR,
  PERMISSIONS_DOOR_VENDOR_ATTR,
  PERMISSIONS_DOORS_SECTION_ATTR,
  PERMISSIONS_MCP_DOOR_CHAT_ROW_ATTR,
  PERMISSIONS_MCP_DOOR_CHAT_TOGGLE_ATTR,
  PERMISSIONS_MCP_DOOR_CONTROLS_ATTR,
  PERMISSIONS_MCP_DOOR_GRANTS_ATTR,
  PERMISSIONS_MCP_DOOR_GRANTS_EMPTY_ATTR,
  PERMISSIONS_MCP_DOOR_GRANT_KIND_ATTR,
  PERMISSIONS_MCP_DOOR_GRANT_KIND_TOGGLE_ATTR,
  PERMISSIONS_MCP_DOOR_GRANT_TOOL_ATTR,
  PERMISSIONS_MCP_DOOR_GRANT_TOOL_ALSO_READS_ATTR,
  PERMISSIONS_MCP_DOOR_GRANT_TOOL_TOGGLE_ATTR,
  PERMISSIONS_MCP_DOOR_DISABLE_ATTR,
  PERMISSIONS_MCP_DOOR_DISABLE_CANCEL_ATTR,
  PERMISSIONS_MCP_DOOR_DISABLE_CONFIRM_ATTR,
  PERMISSIONS_MCP_DOOR_ENABLE_ATTR,
  PERMISSIONS_MCP_DOOR_ERROR_ATTR,
  PERMISSIONS_MCP_DOOR_STATUS_ATTR,
  PERMISSIONS_MCP_DOOR_TOKEN_ATTR,
  PERMISSIONS_MCP_DOOR_TOKEN_COPY_ATTR,
  PERMISSIONS_MCP_DOOR_TOKEN_VALUE_ATTR,
  PERMISSIONS_OVERRIDE_CARD_ATTR,
  PERMISSIONS_OVERRIDE_ROW_ATTR,
  PERMISSIONS_OVERRIDES_HEADING_ATTR,
  PERMISSIONS_PANEL_EMPTY_ATTR,
  PERMISSIONS_PANEL_ERROR_ATTR,
  PERMISSIONS_PANEL_HOST_ATTR,
  PERMISSIONS_PANEL_LOADING_ATTR,
  PERMISSIONS_ROW_ERROR_ATTR,
  type PermissionsDeleteOverrideCaller,
  type PermissionsIssueInboundTokenCaller,
  type PermissionsListCatalogOperationsCaller,
  type PermissionsListContractsCaller,
  type PermissionsListInboundTokensCaller,
  type PermissionsListOverridesCaller,
  type PermissionsMintContractCaller,
  type PermissionsRevokeContractCaller,
  type PermissionsRevokeInboundTokenCaller,
  type PermissionsToolCatalogCaller,
  type PermissionsUpdateInboundContractCaller,
  type PermissionsUpdateInboundTokenCaller,
  type PermissionsUpsertOverrideCaller,
} from '../settings/permissions-panel.js';
import {
  bootstrapContractsRoute,
  CONTRACTS_ROUTE_CONNECT_HOST_ATTR,
  CONTRACTS_ROUTE_UNAVAILABLE_ATTR,
  type BootstrapContractsRouteOptions,
} from '../contracts/bootstrap-contracts-route.js';
import {
  WEBCLIENT_DEFAULT_SUBSCRIPTIONS,
  type BroadcastListener,
  type BroadcastSubscriber,
} from '../realtime/subscriber.js';
import type {
  Actor,
  BroadcastEventKind,
  CatalogIngredientView,
  ContractDefinitionView,
  McpInboundTokenRecord,
  OverridePolicyInput,
  OverrideView,
  ServerEvent,
  ToolEntry,
} from '@recued/contracts';
import {
  getMessengerVendorDeclaration,
  listMessengerVendors,
  SCOPE_FENCE_KEEP_PATTERNS,
} from '@recued/contracts';

// ════════════════════════════════════════════════════════════════
// Interactive fake DOM
// ════════════════════════════════════════════════════════════════

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  hidden: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  parent: FakeEl | null;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  removeEventListener(type: string, fn: (ev?: unknown) => void): void;
  focus(): void;
  click(): void;
  remove(): void;
}

interface FakeDocument {
  createElement(tag: string): FakeEl;
  activeElement: FakeEl | null;
  head: {
    appendChild(el: FakeEl): FakeEl;
    querySelector(selector: string): FakeEl | null;
  };
  styleTags: FakeEl[];
}

const makeFakeElement = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    hidden: false,
    attrs: new Map(),
    children: [],
    listeners: new Map(),
    parent: null,
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
      if (k === 'disabled') el.disabled = true;
    },
    removeAttribute(k) {
      el.attrs.delete(k);
      if (k === 'disabled') el.disabled = false;
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(c) {
      el.children.push(c);
      c.parent = el;
      return c;
    },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i < 0) throw new Error('removeChild: not a child');
      el.children.splice(i, 1);
      c.parent = null;
      return c;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = el.listeners.get(type);
      if (list === undefined) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    focus() {
      // Contract detail now moves focus to its asynchronous heading. These
      // tests only need the browser method to exist; focus ownership is pinned
      // by the route-specific accessibility suite.
    },
    click() {
      // A disabled button fires no click. The panel sets disabled by
      // attribute, so checking the attr keeps the fake honest.
      if (el.disabled || el.attrs.has('disabled')) return;
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
    remove() {
      if (el.parent) el.parent.removeChild(el);
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDocument => {
  const styleTags: FakeEl[] = [];
  const parseSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  return {
    createElement: makeFakeElement,
    activeElement: null,
    head: {
      appendChild(el) {
        styleTags.push(el);
        return el;
      },
      querySelector(selector) {
        const parsed = parseSelector(selector);
        if (parsed === null) return null;
        return (
          styleTags.find(
            (s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr),
          ) ?? null
        );
      },
    },
    styleTags,
  };
};

const collectByAttr = (
  root: FakeEl,
  attr: string,
  out: FakeEl[] = [],
): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};

const allText = (root: FakeEl, acc: string[] = []): string[] => {
  if (root.textContent) acc.push(root.textContent);
  for (const c of root.children) allText(c, acc);
  return acc;
};

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ════════════════════════════════════════════════════════════════
// Fixtures + mount helper
// ════════════════════════════════════════════════════════════════

const DEALS = 'hubspot.deals';
const CONTACTS = 'hubspot.contacts';
const DEALS_WRITE = `${DEALS}.write`;
const DEALS_READ = `${DEALS}.read`;
const CONTACTS_WRITE = `${CONTACTS}.write`;

const catalogFixture = (): CatalogIngredientView[] => [
  {
    ingredient_id: DEALS,
    name: 'HubSpot Deals',
    operations: [
      { operation_id: DEALS_READ, operation_key: 'read', risk_tier: 'read', groups: ['crm'] },
      { operation_id: DEALS_WRITE, operation_key: 'write', risk_tier: 'write', groups: ['crm'] },
    ],
  },
  {
    ingredient_id: CONTACTS,
    name: 'HubSpot Contacts',
    operations: [
      { operation_id: CONTACTS_WRITE, operation_key: 'write', risk_tier: 'write', groups: ['crm'] },
    ],
  },
];

const overrideView = (
  actor: Actor,
  ingredientId: string,
  operationId: string | null,
  policy: OverridePolicyInput = { approval: 'ask' },
  over: Partial<OverrideView> = {},
): OverrideView => ({
  actor,
  ingredient_id: ingredientId,
  operation_id: operationId,
  policy,
  written_at: 1,
  ...over,
});

interface MountForOptions {
  overrides?: ReadonlyArray<OverrideView>;
  catalog?: CatalogIngredientView[];
  withCreate?: boolean;
  runListOverrides?: PermissionsListOverridesCaller;
  runDeleteOverride?: PermissionsDeleteOverrideCaller;
  runUpsertOverride?: PermissionsUpsertOverrideCaller;
  runListCatalogOperations?: PermissionsListCatalogOperationsCaller;
  // D-171 slice 2 — mcp door inbound-token callers. Supplying any one wires
  // it; the door is interactive only when ALL THREE are present (mirrors the
  // panel's `canManageMcpDoor` gate). Tests pass a fake store's trio (below).
  runListInboundTokens?: PermissionsListInboundTokensCaller;
  runIssueInboundToken?: PermissionsIssueInboundTokenCaller;
  runRevokeInboundToken?: PermissionsRevokeInboundTokenCaller;
  // D-171 slice 2b — the Chat row's update caller. Gates the Chat row
  // independently (the door's lifecycle trio above keeps it interactive).
  runUpdateInboundToken?: PermissionsUpdateInboundTokenCaller;
  // D-171 slice 2c — the grant checklist's tool-catalog caller. Gates the
  // checklist alongside the update caller (both needed: list tools + write
  // grants).
  runListToolCatalog?: PermissionsToolCatalogCaller;
  // D-171 slice 3b — the four contract callers backing the Advanced sub-panel
  // (lazy cap/expiry). The sub-panel renders only when ALL FOUR are present
  // (mirrors `canEditMcpAdvanced`); the fake contract store below wires them.
  runMintContract?: PermissionsMintContractCaller;
  runRevokeContract?: PermissionsRevokeContractCaller;
  runListContracts?: PermissionsListContractsCaller;
  runUpdateInboundContract?: PermissionsUpdateInboundContractCaller;
  // D-171 slice-2c follow-on #2 — the D-121 broadcast subscribe seam. When wired
  // the open mcp door re-lists on `chat.inbound_token_changed`.
  subscribe?: BroadcastSubscriber['on'];
  now?: () => number;
}

const mountFor = (opts: MountForOptions = {}) => {
  const doc = makeFakeDocument();
  const host = doc.createElement('div');

  const runListOverrides = vi.fn<PermissionsListOverridesCaller>();
  runListOverrides.mockImplementation(
    opts.runListOverrides
      ?? (async () => ({ overrides: opts.overrides ?? [] })),
  );

  const runDeleteOverride = vi.fn<PermissionsDeleteOverrideCaller>();
  runDeleteOverride.mockImplementation(
    opts.runDeleteOverride
      ?? (async () => ({ deleted: true })),
  );

  const runUpsertOverride = vi.fn<PermissionsUpsertOverrideCaller>();
  runUpsertOverride.mockImplementation(
    opts.runUpsertOverride
      ?? (async ({ actor, ingredient_id, operation_id, policy }) =>
        overrideView(actor, ingredient_id, operation_id ?? null, policy)),
  );

  const runListCatalogOperations = vi.fn<PermissionsListCatalogOperationsCaller>();
  runListCatalogOperations.mockImplementation(
    opts.runListCatalogOperations
      ?? (async () => ({ ingredients: opts.catalog ?? [] })),
  );

  const includeUpsert =
    opts.withCreate === true || opts.runUpsertOverride !== undefined;
  const includeCatalog =
    opts.withCreate === true
    || opts.catalog !== undefined
    || opts.runListCatalogOperations !== undefined;

  const mount = mountPermissionsPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runListOverrides,
    runDeleteOverride,
    ...(includeUpsert ? { runUpsertOverride } : {}),
    ...(includeCatalog ? { runListCatalogOperations } : {}),
    ...(opts.runListInboundTokens !== undefined
      ? { runListInboundTokens: opts.runListInboundTokens }
      : {}),
    ...(opts.runIssueInboundToken !== undefined
      ? { runIssueInboundToken: opts.runIssueInboundToken }
      : {}),
    ...(opts.runRevokeInboundToken !== undefined
      ? { runRevokeInboundToken: opts.runRevokeInboundToken }
      : {}),
    ...(opts.runUpdateInboundToken !== undefined
      ? { runUpdateInboundToken: opts.runUpdateInboundToken }
      : {}),
    ...(opts.runListToolCatalog !== undefined
      ? { runListToolCatalog: opts.runListToolCatalog }
      : {}),
    ...(opts.runMintContract !== undefined
      ? { runMintContract: opts.runMintContract }
      : {}),
    ...(opts.runRevokeContract !== undefined
      ? { runRevokeContract: opts.runRevokeContract }
      : {}),
    ...(opts.runListContracts !== undefined
      ? { runListContracts: opts.runListContracts }
      : {}),
    ...(opts.runUpdateInboundContract !== undefined
      ? { runUpdateInboundContract: opts.runUpdateInboundContract }
      : {}),
    ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });

  return {
    doc,
    host,
    mount,
    calls: {
      runListOverrides,
      runDeleteOverride,
      runUpsertOverride,
      runListCatalogOperations,
    },
  };
};

// ── D-171 slice 2 — mcp door fixtures + fake inbound-token store ──────

let tokenSeq = 0;

const tokenRecord = (
  over: Partial<McpInboundTokenRecord> = {},
): McpInboundTokenRecord => ({
  token_id: `tok_${(tokenSeq += 1)}`,
  bearer_hash: 'hash',
  label: MCP_DOOR_TOKEN_LABEL,
  created_at: 1,
  expires_at: 0, // never expires (the door's default)
  revoked_at: null,
  grants: {},
  concurrency_tier: 5,
  chat_mode: null,
  updated_at: 1,
  ...over,
});

/** A stateful in-memory inbound-token store backing the door's three
 *  callers, so an issue / revoke is reflected in the next list (the panel
 *  reconciles via a re-list). Each caller is a `vi.fn` for call assertions.
 *  `listImpl` lets a test override the list behaviour (e.g. force a re-list
 *  failure) while keeping issue / revoke stateful. */
const makeFakeTokenStore = (seed: McpInboundTokenRecord[] = []) => {
  const rows: McpInboundTokenRecord[] = seed.map((r) => ({ ...r }));
  let issued = 0;
  const state = { failNextList: false };
  const list = vi.fn<PermissionsListInboundTokensCaller>(async () => {
    if (state.failNextList) {
      state.failNextList = false;
      throw new Error('list boom');
    }
    return { tokens: rows.map((r) => ({ ...r })) };
  });
  const issue = vi.fn<PermissionsIssueInboundTokenCaller>(async (args) => {
    issued += 1;
    const record = tokenRecord({
      token_id: `issued_${issued}`,
      label: args.label,
      grants: args.grants,
      concurrency_tier: args.concurrency_tier,
      expires_at: args.expires_at,
      chat_mode: args.chat_mode,
    });
    rows.unshift({ ...record });
    return { record, bearer_plaintext: `recued_test_${issued}` };
  });
  const revoke = vi.fn<PermissionsRevokeInboundTokenCaller>(
    async ({ token_id }) => {
      const row = rows.find((r) => r.token_id === token_id);
      if (row === undefined) throw new Error(`unknown token ${token_id}`);
      const wasActive = row.revoked_at === null;
      // Idempotent like the real store — preserve the original `revoked_at`
      // on a re-revoke; only stamp it on the first.
      if (wasActive) row.revoked_at = 999;
      return { revoked: wasActive, token: { ...row } };
    },
  );
  // D-171 slice 2b — preserve-on-absent for both fields, mirroring the real
  // store: an absent `grants` / `chat_mode` leaves that field untouched.
  const update = vi.fn<PermissionsUpdateInboundTokenCaller>(
    async ({ token_id, grants, chat_mode }) => {
      const row = rows.find((r) => r.token_id === token_id);
      if (row === undefined) throw new Error(`unknown token ${token_id}`);
      if (grants !== undefined) row.grants = grants;
      if (chat_mode !== undefined) row.chat_mode = chat_mode;
      return { token: { ...row } };
    },
  );
  // D-171 slice 3b — rebind the token's bound `contract_id` IN PLACE (slice 3a):
  // a string binds, `null` unbinds (deletes the field). The bearer / grants /
  // chat_mode are untouched (token value stable, decision 6).
  const updateContract = vi.fn<PermissionsUpdateInboundContractCaller>(
    async ({ token_id, contract_id }) => {
      const row = rows.find((r) => r.token_id === token_id);
      if (row === undefined) throw new Error(`unknown token ${token_id}`);
      if (contract_id === null) delete row.contract_id;
      else row.contract_id = contract_id;
      return { token: { ...row } };
    },
  );
  return { rows, list, issue, revoke, update, updateContract, state };
};

// ── D-171 slice 3b — contract fixtures + fake contract store ─────────

let contractSeq = 0;

const contractView = (
  over: Partial<ContractDefinitionView> = {},
): ContractDefinitionView => ({
  contract_id: `ct_${(contractSeq += 1)}`,
  minted_at: 1,
  minted_by: 'Bob MacBook',
  display_name: MCP_DOOR_CONTRACT_NAME,
  scope: MCP_DOOR_CONTRACT_SCOPE,
  lifecycle_state: 'active',
  ...over,
});

/** A stateful in-memory contract-definition store backing the Advanced
 *  sub-panel's three contract callers (mint / revoke / list). Mint generates a
 *  fresh `ct_*` id + returns an active view; revoke stamps `revoked_at` +
 *  flips `lifecycle_state`; list returns the current set (newest first). Each is
 *  a `vi.fn` for call assertions. */
const makeFakeContractStore = (seed: ContractDefinitionView[] = []) => {
  const defs: ContractDefinitionView[] = seed.map((d) => ({ ...d }));
  let minted = 0;
  const list = vi.fn<PermissionsListContractsCaller>(async () => ({
    contracts: defs.map((d) => ({ ...d })),
  }));
  const mint = vi.fn<PermissionsMintContractCaller>(async (args) => {
    minted += 1;
    const def = contractView({
      contract_id: `ct_minted_${minted}`,
      display_name: args.display_name,
      scope: args.scope,
      ...(args.expiry_at !== undefined ? { expiry_at: args.expiry_at } : {}),
      ...(args.max_uses !== undefined
        ? { max_uses: args.max_uses, uses_remaining: args.max_uses }
        : {}),
    });
    defs.unshift({ ...def });
    return def;
  });
  const revoke = vi.fn<PermissionsRevokeContractCaller>(
    async ({ contract_id, reason }) => {
      const i = defs.findIndex((d) => d.contract_id === contract_id);
      if (i < 0) throw new Error(`unknown contract ${contract_id}`);
      // ContractDefinitionView is readonly — replace the row with a revoked copy.
      const revoked: ContractDefinitionView = {
        ...defs[i]!,
        revoked_at: 999,
        revocation_reason: reason ?? 'Revoked from Settings',
        lifecycle_state: 'revoked',
      };
      defs[i] = revoked;
      return { ...revoked };
    },
  );
  return { defs, list, mint, revoke };
};

// ── D-171 slice 2c — tool-catalog fixtures (the grant checklist source) ──

const toolEntry = (over: Partial<ToolEntry> = {}): ToolEntry => ({
  name: 'mail.search',
  tier: 1,
  description: '',
  arg_schema: {},
  topic_tags: [],
  classification: 'read',
  concurrency_safe: true,
  ...over,
});

/** A catalog spanning two ingredient kinds: `mail.search` + `calendar.search`
 *  infer to `storage`; `deal.search` to `connection` (per
 *  `inferChatInboundTokenToolKind`). So the checklist renders two kind groups
 *  (storage first, connection last — the closed grouping order). */
const toolCatalogFixture = (): ToolEntry[] => [
  toolEntry({ name: 'mail.search', classification: 'read', description: 'Search mail.' }),
  toolEntry({ name: 'calendar.search', classification: 'read' }),
  toolEntry({ name: 'deal.search', classification: 'read' }),
];

const toolCatalogCaller = (catalog: ToolEntry[] = toolCatalogFixture()) =>
  vi.fn<PermissionsToolCatalogCaller>(async () => ({ catalog }));

const mcpStatusText = (host: FakeEl): string | null =>
  collectByAttr(host, PERMISSIONS_MCP_DOOR_STATUS_ATTR)[0]?.textContent ?? null;

const findByAttrValue = (
  root: FakeEl,
  attr: string,
  value: string,
): FakeEl | null => {
  if (root.getAttribute(attr) === value) return root;
  for (const c of root.children) {
    const hit = findByAttrValue(c, attr, value);
    if (hit !== null) return hit;
  }
  return null;
};

const onlyByAttr = (root: FakeEl, attr: string): FakeEl => {
  const matches = collectByAttr(root, attr);
  if (matches.length !== 1) {
    throw new Error(`expected one ${attr}, found ${matches.length}`);
  }
  return matches[0]!;
};

const selectOptions = (
  root: FakeEl,
  attr: string,
): Array<{ value: string; label: string }> =>
  onlyByAttr(root, attr).children.map((c) => ({
    value: c.getAttribute('value') ?? '',
    label: c.textContent,
  }));

const selectedOptionValue = (root: FakeEl, attr: string): string | null => {
  const selected = onlyByAttr(root, attr).children.find((c) =>
    c.hasAttribute('selected'),
  );
  return selected?.getAttribute('value') ?? null;
};

const cardFor = (root: FakeEl, ingredientId: string): FakeEl => {
  const card = collectByAttr(root, PERMISSIONS_OVERRIDE_CARD_ATTR).find(
    (c) => c.getAttribute('data-ingredient-id') === ingredientId,
  );
  if (card === undefined) throw new Error(`missing card ${ingredientId}`);
  return card;
};

const rowFor = (
  root: FakeEl,
  actor: Actor,
  ingredientId: string,
  operationId: string | null,
): FakeEl | undefined =>
  collectByAttr(root, PERMISSIONS_OVERRIDE_ROW_ATTR).find(
    (r) =>
      r.getAttribute('data-actor') === actor
      && r.getAttribute('data-ingredient-id') === ingredientId
      && r.getAttribute('data-operation-id') === (operationId ?? ''),
  );

const deleteButtonFor = (
  root: FakeEl,
  actor: Actor,
  ingredientId: string,
  operationId: string | null,
): FakeEl | undefined =>
  collectByAttr(root, PERMISSIONS_DELETE_BUTTON_ATTR).find(
    (b) =>
      b.getAttribute('data-actor') === actor
      && b.getAttribute('data-ingredient-id') === ingredientId
      && b.getAttribute('data-operation-id') === (operationId ?? ''),
  );

const confirmButtonFor = (
  root: FakeEl,
  actor: Actor,
  ingredientId: string,
  operationId: string | null,
): FakeEl | undefined =>
  collectByAttr(root, PERMISSIONS_DELETE_CONFIRM_ATTR).find(
    (b) =>
      b.getAttribute('data-actor') === actor
      && b.getAttribute('data-ingredient-id') === ingredientId
      && b.getAttribute('data-operation-id') === (operationId ?? ''),
  );

const cancelButtonFor = (
  root: FakeEl,
  actor: Actor,
  ingredientId: string,
  operationId: string | null,
): FakeEl | undefined =>
  collectByAttr(root, PERMISSIONS_DELETE_CANCEL_ATTR).find(
    (b) =>
      b.getAttribute('data-actor') === actor
      && b.getAttribute('data-ingredient-id') === ingredientId
      && b.getAttribute('data-operation-id') === (operationId ?? ''),
  );

const requiredPermissionsCallers = (): Pick<
  BootstrapContractsRouteOptions,
  | 'permissionsListOverridesCaller'
  | 'permissionsDeleteOverrideCaller'
  | 'permissionsUpsertOverrideCaller'
  | 'permissionsListCatalogOperationsCaller'
> => ({
  permissionsListOverridesCaller: vi.fn(async () => ({ overrides: [] })),
  permissionsDeleteOverrideCaller: vi.fn(async () => ({ deleted: true })),
  permissionsUpsertOverrideCaller: vi.fn(async ({ actor, ingredient_id, operation_id, policy }) =>
    overrideView(actor, ingredient_id, operation_id ?? null, policy),
  ),
  permissionsListCatalogOperationsCaller: vi.fn(async () => ({ ingredients: [] })),
});

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe('D-166 Permissions override inventory panel', () => {
  it('renders loading, then groups one card per ingredient', async () => {
    const list = deferred<{ overrides: OverrideView[] }>();
    const dealsWide = overrideView('user_self', DEALS, null);
    const dealsWrite = overrideView('system', DEALS, DEALS_WRITE);
    const contactsWrite = overrideView('contracted_user', CONTACTS, CONTACTS_WRITE);
    const { host, mount, calls } = mountFor({
      runListOverrides: () => list.promise,
    });

    expect(mount.getState()).toBe('loading');
    expect(collectByAttr(host, PERMISSIONS_PANEL_HOST_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, PERMISSIONS_PANEL_LOADING_ATTR)).toHaveLength(1);
    expect(allText(host).join(' ')).toContain('Loading permissions');

    list.resolve({ overrides: [contactsWrite, dealsWide, dealsWrite] });
    await mount.whenLoaded();

    expect(mount.getState()).toBe('ready');
    expect(mount.getOverrides()).toHaveLength(3);
    expect(calls.runListOverrides).toHaveBeenCalledTimes(1);
    expect(collectByAttr(host, PERMISSIONS_OVERRIDE_CARD_ATTR)).toHaveLength(2);
    expect(cardFor(host, DEALS).getAttribute('data-ingredient-id')).toBe(DEALS);
    expect(cardFor(host, CONTACTS).getAttribute('data-ingredient-id')).toBe(CONTACTS);
    expect(collectByAttr(cardFor(host, DEALS), PERMISSIONS_OVERRIDE_ROW_ATTR)).toHaveLength(2);
    expect(collectByAttr(cardFor(host, CONTACTS), PERMISSIONS_OVERRIDE_ROW_ATTR)).toHaveLength(1);
    mount.dispose();
  });

  it('renders only present policy facets', async () => {
    const fullPolicy = overrideView('user_self', DEALS, DEALS_WRITE, {
      denied: true,
      approval: 'always',
      max_risk_without_approval: 'write',
      timeout_ms: 2500,
      cache_ttl_ms: 15000,
    });
    const sparsePolicy = overrideView('system', CONTACTS, CONTACTS_WRITE, {
      denied: true,
    });
    const { host, mount } = mountFor({
      overrides: [fullPolicy, sparsePolicy],
    });

    await mount.whenLoaded();

    const fullText = allText(rowFor(host, 'user_self', DEALS, DEALS_WRITE)!).join(' ');
    expect(fullText).toContain('denied');
    expect(fullText).toContain('approval: always');
    expect(fullText).toContain('max risk without approval: write');
    expect(fullText).toContain('timeout: 2500 ms');
    expect(fullText).toContain('cache TTL: 15000 ms');

    const sparseText = allText(rowFor(host, 'system', CONTACTS, CONTACTS_WRITE)!).join(' ');
    expect(sparseText).toContain('denied');
    expect(sparseText).not.toContain('approval:');
    expect(sparseText).not.toContain('max risk without approval:');
    expect(sparseText).not.toContain('timeout:');
    expect(sparseText).not.toContain('cache TTL:');
    mount.dispose();
  });

  it('renders ingredient-wide and operation-specific labels', async () => {
    const wide = overrideView('user_self', DEALS, null);
    const specific = overrideView('system', DEALS, DEALS_WRITE);
    const { host, mount } = mountFor({
      overrides: [specific, wide],
    });

    await mount.whenLoaded();

    const wideRow = rowFor(host, 'user_self', DEALS, null)!;
    const specificRow = rowFor(host, 'system', DEALS, DEALS_WRITE)!;
    expect(wideRow.getAttribute('data-operation-id')).toBe('');
    expect(specificRow.getAttribute('data-operation-id')).toBe(DEALS_WRITE);
    expect(allText(wideRow).join(' ')).toContain('All operations');
    expect(allText(specificRow).join(' ')).toContain('write');
    expect(allText(specificRow).join(' ')).not.toContain(DEALS_WRITE);
    mount.dispose();
  });

  it('renders the empty state when listOverrides returns no rows', async () => {
    const { host, mount, calls } = mountFor({
      overrides: [],
    });

    await mount.whenLoaded();

    expect(mount.getState()).toBe('ready');
    expect(mount.getOverrides()).toHaveLength(0);
    expect(calls.runListOverrides).toHaveBeenCalledTimes(1);
    expect(collectByAttr(host, PERMISSIONS_PANEL_EMPTY_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, PERMISSIONS_OVERRIDE_CARD_ATTR)).toHaveLength(0);
    expect(allText(host).join(' ')).toContain('No permission overrides');
    mount.dispose();
  });

  it('requires a two-stage delete and re-lists after confirm', async () => {
    const deleted = overrideView('user_self', DEALS, null);
    const remaining = overrideView('system', DEALS, DEALS_WRITE);
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      runListOverrides: async () => {
        listCall += 1;
        return { overrides: listCall === 1 ? [deleted, remaining] : [remaining] };
      },
    });
    await mount.whenLoaded();

    deleteButtonFor(host, 'user_self', DEALS, null)!.click();

    expect(confirmButtonFor(host, 'user_self', DEALS, null)).toBeDefined();
    expect(cancelButtonFor(host, 'user_self', DEALS, null)).toBeDefined();
    expect(deleteButtonFor(host, 'user_self', DEALS, null)).toBeUndefined();
    expect(calls.runDeleteOverride).not.toHaveBeenCalled();

    confirmButtonFor(host, 'user_self', DEALS, null)!.click();
    await tick();

    expect(calls.runDeleteOverride).toHaveBeenCalledTimes(1);
    expect(calls.runDeleteOverride.mock.calls[0]![0]).toEqual({
      actor: 'user_self',
      ingredient_id: DEALS,
    });
    expect(calls.runListOverrides).toHaveBeenCalledTimes(2);
    expect(rowFor(host, 'user_self', DEALS, null)).toBeUndefined();
    expect(rowFor(host, 'system', DEALS, DEALS_WRITE)).toBeDefined();
    expect(mount.getOverrides()).toEqual([remaining]);
    mount.dispose();
  });

  it('cancel disarms delete without calling the rpc', async () => {
    const row = overrideView('user_self', DEALS, DEALS_WRITE);
    const { host, mount, calls } = mountFor({
      overrides: [row],
    });
    await mount.whenLoaded();

    deleteButtonFor(host, 'user_self', DEALS, DEALS_WRITE)!.click();
    expect(confirmButtonFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeDefined();
    cancelButtonFor(host, 'user_self', DEALS, DEALS_WRITE)!.click();

    expect(calls.runDeleteOverride).not.toHaveBeenCalled();
    expect(confirmButtonFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(cancelButtonFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(deleteButtonFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeDefined();
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeDefined();
    mount.dispose();
  });

  it('keeps only one row armed at a time', async () => {
    const rowA = overrideView('user_self', DEALS, DEALS_READ);
    const rowB = overrideView('system', DEALS, DEALS_WRITE);
    const { host, mount } = mountFor({
      overrides: [rowA, rowB],
    });
    await mount.whenLoaded();

    deleteButtonFor(host, 'user_self', DEALS, DEALS_READ)!.click();
    expect(confirmButtonFor(host, 'user_self', DEALS, DEALS_READ)).toBeDefined();
    expect(cancelButtonFor(host, 'user_self', DEALS, DEALS_READ)).toBeDefined();

    deleteButtonFor(host, 'system', DEALS, DEALS_WRITE)!.click();

    expect(confirmButtonFor(host, 'system', DEALS, DEALS_WRITE)).toBeDefined();
    expect(cancelButtonFor(host, 'system', DEALS, DEALS_WRITE)).toBeDefined();
    expect(deleteButtonFor(host, 'system', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(confirmButtonFor(host, 'user_self', DEALS, DEALS_READ)).toBeUndefined();
    expect(cancelButtonFor(host, 'user_self', DEALS, DEALS_READ)).toBeUndefined();
    expect(deleteButtonFor(host, 'user_self', DEALS, DEALS_READ)).toBeDefined();
    mount.dispose();
  });

  it('keeps an optimistically deleted row gone when the follow-up list rejects', async () => {
    const deleted = overrideView('user_self', DEALS, DEALS_WRITE);
    const remaining = overrideView('system', CONTACTS, CONTACTS_WRITE);
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      runListOverrides: async () => {
        listCall += 1;
        if (listCall === 1) return { overrides: [deleted, remaining] };
        throw new Error('post-delete list down');
      },
    });
    await mount.whenLoaded();

    await mount.deleteOverride('user_self', DEALS, DEALS_WRITE);

    expect(calls.runDeleteOverride).toHaveBeenCalledTimes(1);
    expect(calls.runListOverrides).toHaveBeenCalledTimes(2);
    expect(mount.getState()).toBe('error');
    expect(mount.getListError()).toBe('post-delete list down');
    expect(mount.getOverrides()).toEqual([remaining]);
    expect(collectByAttr(host, PERMISSIONS_PANEL_ERROR_ATTR)).toHaveLength(1);
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(deleteButtonFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(rowFor(host, 'system', CONTACTS, CONTACTS_WRITE)).toBeDefined();
    mount.dispose();
  });

  it('surfaces per-row delete errors and re-enables that row', async () => {
    const row = overrideView('user_self', DEALS, DEALS_WRITE);
    const { host, mount, calls } = mountFor({
      overrides: [row],
      runDeleteOverride: async () => {
        throw new Error('delete denied');
      },
    });
    await mount.whenLoaded();

    await mount.deleteOverride('user_self', DEALS, DEALS_WRITE);

    const errors = collectByAttr(rowFor(host, 'user_self', DEALS, DEALS_WRITE)!, PERMISSIONS_ROW_ERROR_ATTR);
    const del = deleteButtonFor(host, 'user_self', DEALS, DEALS_WRITE)!;
    expect(calls.runDeleteOverride).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.textContent).toContain('delete denied');
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeDefined();
    expect(del.textContent).toBe('Delete');
    expect(del.getAttribute('disabled')).toBeNull();
    mount.dispose();
  });

  it('serializes deletes per row while a delete is in flight', async () => {
    const row = overrideView('user_self', DEALS, DEALS_WRITE);
    const deleting = deferred<{ deleted: boolean }>();
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      runListOverrides: async () => {
        listCall += 1;
        return { overrides: listCall === 1 ? [row] : [] };
      },
      runDeleteOverride: () => deleting.promise,
    });
    await mount.whenLoaded();

    const first = mount.deleteOverride('user_self', DEALS, DEALS_WRITE);
    await tick();

    const disabled = deleteButtonFor(host, 'user_self', DEALS, DEALS_WRITE)!;
    expect(disabled.textContent).toContain('Removing');
    expect(disabled.getAttribute('disabled')).toBe('');
    expect(mount.hasInFlightWork()).toBe(true);

    await mount.deleteOverride('user_self', DEALS, DEALS_WRITE);
    expect(calls.runDeleteOverride).toHaveBeenCalledTimes(1);

    deleting.resolve({ deleted: true });
    await first;
    await tick();

    expect(mount.hasInFlightWork()).toBe(false);
    expect(calls.runListOverrides).toHaveBeenCalledTimes(2);
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    mount.dispose();
  });

  it('drops a stale in-flight refresh after a delete re-list wins', async () => {
    const deleted = overrideView('user_self', DEALS, DEALS_WRITE);
    const remaining = overrideView('system', CONTACTS, CONTACTS_WRITE);
    const staleRefresh = deferred<{ overrides: OverrideView[] }>();
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      runListOverrides: async () => {
        listCall += 1;
        if (listCall === 1) return { overrides: [deleted, remaining] };
        if (listCall === 2) return staleRefresh.promise;
        return { overrides: [remaining] };
      },
    });
    await mount.whenLoaded();
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeDefined();

    const stale = mount.refresh();
    await tick();
    expect(calls.runListOverrides).toHaveBeenCalledTimes(2);

    await mount.deleteOverride('user_self', DEALS, DEALS_WRITE);
    expect(calls.runListOverrides).toHaveBeenCalledTimes(3);
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(mount.getOverrides()).toEqual([remaining]);

    staleRefresh.resolve({ overrides: [deleted, remaining] });
    await stale;
    await tick();

    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(rowFor(host, 'system', CONTACTS, CONTACTS_WRITE)).toBeDefined();
    expect(mount.getOverrides()).toEqual([remaining]);
    mount.dispose();
  });

  it('dispose removes the wrapper, is idempotent, and ignores late rpc resolution', async () => {
    const list = deferred<{ overrides: OverrideView[] }>();
    const row = overrideView('user_self', DEALS, DEALS_WRITE);
    const { host, mount } = mountFor({
      runListOverrides: () => list.promise,
    });

    expect(host.children).toHaveLength(1);
    expect(collectByAttr(host, PERMISSIONS_PANEL_HOST_ATTR)).toHaveLength(1);
    mount.dispose();
    expect(host.children).toHaveLength(0);
    expect(() => mount.dispose()).not.toThrow();

    list.resolve({ overrides: [row] });
    await mount.whenLoaded();
    await tick();

    expect(host.children).toHaveLength(0);
    expect(mount.getState()).toBe('loading');
    expect(mount.getOverrides()).toHaveLength(0);
  });

});

describe('D-171 doors frame', () => {
  const expectedDoorChannels = ['mcp', 'reception', 'messenger'] as const;

  const expectDoorsFrame = (host: FakeEl): void => {
    const sections = collectByAttr(host, PERMISSIONS_DOORS_SECTION_ATTR);
    expect(sections).toHaveLength(1);
    expect(allText(sections[0]!).join(' ')).toContain('Doors');

    const rows = collectByAttr(host, PERMISSIONS_DOOR_ROW_ATTR);
    expect(rows).toHaveLength(PERMISSION_DOORS.length);
    expect(rows.map((r) => r.getAttribute('data-channel'))).toEqual(
      [...expectedDoorChannels],
    );

    rows.forEach((row, i) => {
      const door = PERMISSION_DOORS[i]!;
      expect(row.getAttribute('data-channel')).toBe(door.channel);
      const text = allText(row).join(' ');
      expect(text).toContain(door.label);
      expect(text).toContain(door.description);
    });

    const headings = collectByAttr(host, PERMISSIONS_OVERRIDES_HEADING_ATTR);
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).toBe('Per-tool restrictions');

    const root = onlyByAttr(host, PERMISSIONS_PANEL_HOST_ATTR);
    expect(root.children[0]).toBe(sections[0]);
    expect(root.children[1]).toBe(headings[0]);
  };

  it('exports exactly the externally reachable door model in display order', () => {
    const channels = PERMISSION_DOORS.map((door) => door.channel);

    expect(PERMISSION_DOORS).toHaveLength(3);
    expect(channels).toEqual([...expectedDoorChannels]);
    expect(new Set(channels).size).toBe(3);
    expect(channels).not.toContain('webhook');
    expect(channels).not.toContain('user');
    expect(channels).not.toContain('chat');
    expect(channels).not.toContain('schedule');
    expect(channels).not.toContain('reactive');
    expect(channels).not.toContain('housekeeping');

    for (const door of PERMISSION_DOORS) {
      expect(door.label.trim()).not.toBe('');
      expect(door.description.trim()).not.toBe('');
    }
  });

  it('renders the doors section, ordered rows, and overrides heading while the initial list is loading', async () => {
    const list = deferred<{ overrides: OverrideView[] }>();
    const { host, mount } = mountFor({
      runListOverrides: () => list.promise,
    });

    expect(mount.getState()).toBe('loading');
    expectDoorsFrame(host);
    expect(collectByAttr(host, PERMISSIONS_PANEL_LOADING_ATTR)).toHaveLength(1);

    list.resolve({ overrides: [] });
    await mount.whenLoaded();
    mount.dispose();
  });

  it('keeps the doors frame after a successful empty list without displacing the empty state', async () => {
    const { host, mount } = mountFor({ overrides: [] });

    await mount.whenLoaded();

    expect(mount.getState()).toBe('ready');
    expectDoorsFrame(host);
    expect(collectByAttr(host, PERMISSIONS_PANEL_EMPTY_ATTR)).toHaveLength(1);
    expect(allText(host).join(' ')).toContain('No permission overrides');
    expect(collectByAttr(host, PERMISSIONS_OVERRIDE_CARD_ATTR)).toHaveLength(0);
    expect(collectByAttr(host, PERMISSIONS_OVERRIDE_ROW_ATTR)).toHaveLength(0);
    mount.dispose();
  });

  it('prepends the doors frame before the create form when create callers are wired', async () => {
    const { host, mount } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();

    expectDoorsFrame(host);
    const root = onlyByAttr(host, PERMISSIONS_PANEL_HOST_ATTR);
    const form = onlyByAttr(host, PERMISSIONS_CREATE_FORM_ATTR);
    expect(root.children[2]).toBe(form);
    expect(collectByAttr(host, PERMISSIONS_CREATE_INGREDIENT_ATTR)).toHaveLength(1);
    mount.dispose();
  });

  it('keeps the doors frame alongside loaded override cards and rows', async () => {
    const dealsWide = overrideView('user_self', DEALS, null);
    const dealsWrite = overrideView('system', DEALS, DEALS_WRITE);
    const contactsWrite = overrideView('contracted_user', CONTACTS, CONTACTS_WRITE);
    const { host, mount } = mountFor({
      overrides: [contactsWrite, dealsWide, dealsWrite],
    });

    await mount.whenLoaded();

    expectDoorsFrame(host);
    expect(collectByAttr(host, PERMISSIONS_OVERRIDE_CARD_ATTR)).toHaveLength(2);
    expect(collectByAttr(host, PERMISSIONS_OVERRIDE_ROW_ATTR)).toHaveLength(3);
    expect(cardFor(host, DEALS).getAttribute('data-ingredient-id')).toBe(DEALS);
    expect(cardFor(host, CONTACTS).getAttribute('data-ingredient-id')).toBe(CONTACTS);
    expect(rowFor(host, 'user_self', DEALS, null)).toBeDefined();
    expect(rowFor(host, 'system', DEALS, DEALS_WRITE)).toBeDefined();
    expect(rowFor(host, 'contracted_user', CONTACTS, CONTACTS_WRITE)).toBeDefined();
    mount.dispose();
  });
});

describe('D-171 slice 4 — reception / messenger doors (static informational)', () => {
  const infoBlockFor = (root: FakeEl, channel: string): FakeEl | undefined =>
    collectByAttr(root, PERMISSIONS_DOOR_INFO_ATTR).find(
      (b) => b.getAttribute('data-channel') === channel,
    );

  it('renders exactly one info block per non-mcp door and none for mcp', async () => {
    const { host, mount } = mountFor({ overrides: [] });
    await mount.whenLoaded();

    const blocks = collectByAttr(host, PERMISSIONS_DOOR_INFO_ATTR);
    expect(blocks.map((b) => b.getAttribute('data-channel'))).toEqual([
      'reception',
      'messenger',
    ]);
    // The mcp door derives a token instead of an info block — never both.
    expect(infoBlockFor(host, 'mcp')).toBeUndefined();
    mount.dispose();
  });

  it('renders the reception door as informational with the Reception-page link and no token', async () => {
    const { host, mount } = mountFor({ overrides: [] });
    await mount.whenLoaded();

    const block = infoBlockFor(host, 'reception');
    expect(block).toBeDefined();
    // No token / enable affordance — those are mcp-only (decision 8).
    expect(block!.hasAttribute(PERMISSIONS_MCP_DOOR_CONTROLS_ATTR)).toBe(false);
    expect(collectByAttr(block!, PERMISSIONS_MCP_DOOR_ENABLE_ATTR)).toHaveLength(0);
    expect(collectByAttr(block!, PERMISSIONS_MCP_DOOR_TOKEN_ATTR)).toHaveLength(0);

    // The #reception hash link to the (sibling) Reception route.
    const link = block!.children.find(
      (c) => c.getAttribute('href') === '#reception',
    );
    expect(link).toBeDefined();
    expect(link!.tagName).toBe('A');
    expect(link!.textContent).toContain('Reception page');

    const text = allText(block!).join(' ');
    expect(text).toContain('public links');
    expect(text).toContain('access boundary');
    // Honest posture (codex P2): does NOT claim the Per-tool restrictions gate
    // anonymous public-link traffic.
    expect(text).toContain('not by the Per-tool restrictions below');
    expect(text).toContain('No token to copy');
    mount.dispose();
  });

  it('renders the messenger door with one sub-row per declared messenger vendor, in order', async () => {
    const { host, mount } = mountFor({ overrides: [] });
    await mount.whenLoaded();

    const block = infoBlockFor(host, 'messenger');
    expect(block).toBeDefined();
    expect(block!.hasAttribute(PERMISSIONS_MCP_DOOR_CONTROLS_ATTR)).toBe(false);

    const vendors = collectByAttr(block!, PERMISSIONS_DOOR_VENDOR_ATTR);
    const declared = listMessengerVendors();
    expect(vendors).toHaveLength(declared.length);
    expect(vendors.map((v) => v.getAttribute('data-vendor'))).toEqual([
      ...declared,
    ]);
    // D-192 CORE #6 — labels come from the registry `display_name`, not a local
    // hardcoded map, so a newly-declared vendor flows through with no test edit.
    // `email` is deliberately absent: it is a notification channel configured
    // in Connections, never a chat transport.
    for (const v of vendors) {
      const vendor = v.getAttribute('data-vendor')!;
      const label = getMessengerVendorDeclaration(vendor)!.display_name;
      expect(v.textContent).toContain(label);
      expect(v.textContent).toContain('Connections');
    }

    const text = allText(block!).join(' ');
    expect(text).toContain('Inbound messages');
    // Messenger's actors (user_self / contracted_user) ARE in ACTOR_OPTIONS, so
    // the per-tool tie-in is accurate here (unlike reception's anonymous path).
    expect(text).toContain('Per-tool restrictions below also apply');
    expect(text).toContain('No token to copy');
    mount.dispose();
  });

  it('renders both info blocks even with no door callers wired (they need none)', async () => {
    const { host, mount } = mountFor({ overrides: [] });
    await mount.whenLoaded();

    // The minimal mount has no inbound-token callers — the mcp door stays the
    // slice-1 bare row, but the other two always render their static block.
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_CONTROLS_ATTR)).toHaveLength(0);
    expect(infoBlockFor(host, 'reception')).toBeDefined();
    expect(infoBlockFor(host, 'messenger')).toBeDefined();
    mount.dispose();
  });

  it('leaves the mcp door (its controls) unaffected when its callers are wired', async () => {
    const store = makeFakeTokenStore([]); // no active token → closed mcp door
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
    });
    await mount.whenLoaded();
    await mount.whenTokensLoaded();

    // The mcp door renders its own controls, never an info block.
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_CONTROLS_ATTR)).toHaveLength(1);
    expect(infoBlockFor(host, 'mcp')).toBeUndefined();
    // The other two doors still render their info blocks alongside it.
    expect(infoBlockFor(host, 'reception')).toBeDefined();
    expect(infoBlockFor(host, 'messenger')).toBeDefined();

    // The doors-frame ordering invariant is preserved.
    const root = onlyByAttr(host, PERMISSIONS_PANEL_HOST_ATTR);
    expect(root.children[0]!.hasAttribute(PERMISSIONS_DOORS_SECTION_ATTR)).toBe(true);
    expect(root.children[1]!.hasAttribute(PERMISSIONS_OVERRIDES_HEADING_ATTR)).toBe(
      true,
    );
    mount.dispose();
  });
});

describe('D-171 mcp door (inbound-token lifecycle)', () => {
  it('stays informational (no controls) when the inbound-token callers are absent', async () => {
    const { host, mount } = mountFor({ overrides: [] });
    await mount.whenLoaded();

    // The slice-1 mcp door row is still present, but with no control region.
    expect(
      findByAttrValue(host, 'data-channel', 'mcp'),
    ).not.toBeNull();
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_CONTROLS_ATTR)).toHaveLength(0);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_ENABLE_ATTR)).toHaveLength(0);
    expect(mount.getMcpDoorOpen()).toBe(false);
    mount.dispose();
  });

  it('derives Closed + renders the Open button when no active door token exists', async () => {
    const store = makeFakeTokenStore([]);
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
    });
    await mount.whenTokensLoaded();

    expect(store.list).toHaveBeenCalledTimes(1);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_CONTROLS_ATTR)).toHaveLength(1);
    expect(mcpStatusText(host)).toBe('Closed');
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_ENABLE_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_DISABLE_ATTR)).toHaveLength(0);
    expect(mount.getMcpDoorOpen()).toBe(false);
    mount.dispose();
  });

  it('derives Open from an existing active door-labelled token (loaded, value shown once)', async () => {
    const seeded = tokenRecord({ token_id: 'door_live' });
    const store = makeFakeTokenStore([seeded]);
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
    });
    await mount.whenTokensLoaded();

    expect(mcpStatusText(host)).toBe('Open');
    expect(mount.getMcpDoorOpen()).toBe(true);
    // Loaded without the one-time plaintext → the value note, no copy button.
    expect(mount.getMcpDoorTokenPlaintext()).toBeNull();
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_TOKEN_COPY_ATTR)).toHaveLength(0);
    const value = collectByAttr(host, PERMISSIONS_MCP_DOOR_TOKEN_VALUE_ATTR)[0];
    expect(value?.textContent).toContain('door_live');
    expect(value?.textContent).toContain('shown once');
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_DISABLE_ATTR)).toHaveLength(1);
    mount.dispose();
  });

  it('ignores non-door-labelled + revoked tokens when deriving the door state', async () => {
    const store = makeFakeTokenStore([
      tokenRecord({ token_id: 'other', label: 'Some other token' }),
      tokenRecord({ token_id: 'dead', revoked_at: 5 }),
    ]);
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
    });
    await mount.whenTokensLoaded();

    expect(mcpStatusText(host)).toBe('Closed');
    expect(mount.getMcpDoorOpen()).toBe(false);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_ENABLE_ATTR)).toHaveLength(1);
    mount.dispose();
  });

  it('opens the door — issues a least-privilege, never-expiring token + reveals the one-time bearer', async () => {
    const store = makeFakeTokenStore([]);
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
    });
    await mount.whenTokensLoaded();

    await mount.enableMcpDoor();

    expect(store.issue).toHaveBeenCalledTimes(1);
    expect(store.issue).toHaveBeenCalledWith({
      label: MCP_DOOR_TOKEN_LABEL,
      grants: {},
      concurrency_tier: 5,
      expires_at: 0,
      chat_mode: null,
    });
    expect(mount.getMcpDoorOpen()).toBe(true);
    expect(mcpStatusText(host)).toBe('Open');
    // The one-time bearer is held + revealed with a Copy button.
    expect(mount.getMcpDoorTokenPlaintext()).toBe('recued_test_1');
    const value = collectByAttr(host, PERMISSIONS_MCP_DOOR_TOKEN_VALUE_ATTR)[0];
    expect(value?.textContent).toBe('recued_test_1');
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_TOKEN_COPY_ATTR)).toHaveLength(1);
    mount.dispose();
  });

  it('opens the door via the Enable button click', async () => {
    const store = makeFakeTokenStore([]);
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
    });
    await mount.whenTokensLoaded();

    onlyByAttr(host, PERMISSIONS_MCP_DOOR_ENABLE_ATTR).click();
    await tick();

    expect(store.issue).toHaveBeenCalledTimes(1);
    expect(mount.getMcpDoorOpen()).toBe(true);
    mount.dispose();
  });

  it('copies the one-time bearer to the clipboard', async () => {
    const store = makeFakeTokenStore([]);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      const { host, mount } = mountFor({
        runListInboundTokens: store.list,
        runIssueInboundToken: store.issue,
        runRevokeInboundToken: store.revoke,
      });
      await mount.whenTokensLoaded();
      await mount.enableMcpDoor();

      onlyByAttr(host, PERMISSIONS_MCP_DOOR_TOKEN_COPY_ATTR).click();
      await tick();

      expect(writeText).toHaveBeenCalledWith('recued_test_1');
      mount.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('disabling is a two-stage guarded confirm (arm → warning → Cancel disarms, no revoke)', async () => {
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
    });
    await mount.whenTokensLoaded();

    // First click ARMS the confirm — no revoke yet.
    onlyByAttr(host, PERMISSIONS_MCP_DOOR_DISABLE_ATTR).click();
    await tick();
    expect(store.revoke).not.toHaveBeenCalled();
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_DISABLE_CONFIRM_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_DISABLE_CANCEL_ATTR)).toHaveLength(1);
    expect(allText(host).join(' ')).toContain('will stop working immediately');

    // Cancel disarms without revoking.
    onlyByAttr(host, PERMISSIONS_MCP_DOOR_DISABLE_CANCEL_ATTR).click();
    await tick();
    expect(store.revoke).not.toHaveBeenCalled();
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_DISABLE_CONFIRM_ATTR)).toHaveLength(0);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_DISABLE_ATTR)).toHaveLength(1);
    expect(mount.getMcpDoorOpen()).toBe(true);
    mount.dispose();
  });

  it('confirming the disable revokes the token, flips Closed, and clears the plaintext', async () => {
    const store = makeFakeTokenStore([]);
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
    });
    await mount.whenTokensLoaded();
    await mount.enableMcpDoor();
    expect(mount.getMcpDoorTokenPlaintext()).toBe('recued_test_1');

    onlyByAttr(host, PERMISSIONS_MCP_DOOR_DISABLE_ATTR).click();
    await tick();
    onlyByAttr(host, PERMISSIONS_MCP_DOOR_DISABLE_CONFIRM_ATTR).click();
    await tick();

    expect(store.revoke).toHaveBeenCalledTimes(1);
    expect(store.revoke).toHaveBeenCalledWith({ token_id: 'issued_1' });
    expect(mount.getMcpDoorOpen()).toBe(false);
    expect(mcpStatusText(host)).toBe('Closed');
    expect(mount.getMcpDoorTokenPlaintext()).toBeNull();
    mount.dispose();
  });

  it('disabling revokes EVERY active door-labelled token (kill-switch)', async () => {
    const store = makeFakeTokenStore([
      tokenRecord({ token_id: 'door_a' }),
      tokenRecord({ token_id: 'door_b' }),
    ]);
    const { mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
    });
    await mount.whenTokensLoaded();
    expect(mount.getMcpDoorOpen()).toBe(true);

    await mount.disableMcpDoor();

    expect(store.revoke).toHaveBeenCalledTimes(2);
    expect(store.revoke).toHaveBeenCalledWith({ token_id: 'door_a' });
    expect(store.revoke).toHaveBeenCalledWith({ token_id: 'door_b' });
    expect(mount.getMcpDoorOpen()).toBe(false);
    mount.dispose();
  });

  it('a successful revoke renders Closed even when the reconciling re-list fails', async () => {
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
    });
    await mount.whenTokensLoaded();
    expect(mount.getMcpDoorOpen()).toBe(true);

    // The post-revoke reconciling list throws — the optimistic fold must still
    // read CLOSED (a successful kill-switch never renders as still-open).
    store.state.failNextList = true;
    await mount.disableMcpDoor();

    expect(store.revoke).toHaveBeenCalledTimes(1);
    // Pin that the reconciling re-list WAS attempted (and failed) — so it is
    // the optimistic fold, NOT a silent skip of the re-list, keeping the door
    // Closed. (1 initial load + 1 post-revoke reconcile = 2.)
    expect(store.list).toHaveBeenCalledTimes(2);
    expect(
      collectByAttr(host, PERMISSIONS_MCP_DOOR_ERROR_ATTR)[0]?.textContent,
    ).toContain('list boom');
    expect(mount.getMcpDoorOpen()).toBe(false);
    expect(mcpStatusText(host)).toBe('Closed');
    mount.dispose();
  });

  it('surfaces an issue failure and leaves the door Closed', async () => {
    const store = makeFakeTokenStore([]);
    const issue = vi.fn<PermissionsIssueInboundTokenCaller>(async () => {
      throw new Error('issue denied');
    });
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: issue,
      runRevokeInboundToken: store.revoke,
    });
    await mount.whenTokensLoaded();

    await mount.enableMcpDoor();

    expect(mount.getMcpDoorOpen()).toBe(false);
    expect(mount.getMcpDoorTokenPlaintext()).toBeNull();
    const err = collectByAttr(host, PERMISSIONS_MCP_DOOR_ERROR_ATTR)[0];
    expect(err?.textContent).toContain('issue denied');
    mount.dispose();
  });

  it('the enable handle no-ops when not all three door callers are wired', async () => {
    const doc = makeFakeDocument();
    const host = doc.createElement('div');
    const issue = vi.fn<PermissionsIssueInboundTokenCaller>(async () => {
      throw new Error('should not be called');
    });
    const mount = mountPermissionsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runListOverrides: async () => ({ overrides: [] }),
      runDeleteOverride: async () => ({ deleted: true }),
      // Only the issue caller is wired — list + revoke are absent.
      runIssueInboundToken: issue,
    });
    await mount.whenLoaded();

    await mount.enableMcpDoor();

    expect(issue).not.toHaveBeenCalled();
    // The door is not interactive without all three callers.
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_CONTROLS_ATTR)).toHaveLength(0);
    mount.dispose();
  });

  it('clears the one-time plaintext from memory on dispose', async () => {
    const store = makeFakeTokenStore([]);
    const { mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
    });
    await mount.whenTokensLoaded();
    await mount.enableMcpDoor();
    expect(mount.getMcpDoorTokenPlaintext()).toBe('recued_test_1');

    mount.dispose();
    expect(mount.getMcpDoorTokenPlaintext()).toBeNull();
  });

  it('honours token expiry via the now seam when deriving open/closed', async () => {
    // A door-labelled token that expires at t=100.
    const store = makeFakeTokenStore([
      tokenRecord({ token_id: 'expiring', expires_at: 100 }),
    ]);
    const clock = { t: 50 };
    const { mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      now: () => clock.t,
    });
    await mount.whenTokensLoaded();

    // Before expiry → Open.
    expect(mount.getMcpDoorOpen()).toBe(true);
    // After expiry → Closed (re-derived against the now seam).
    clock.t = 150;
    expect(mount.getMcpDoorOpen()).toBe(false);
    mount.dispose();
  });

  it('stays non-interactive + enable no-ops when revoke is missing (full three-caller gate)', async () => {
    const store = makeFakeTokenStore([]);
    const doc = makeFakeDocument();
    const host = doc.createElement('div');
    const mount = mountPermissionsPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runListOverrides: async () => ({ overrides: [] }),
      runDeleteOverride: async () => ({ deleted: true }),
      // list + issue wired, revoke ABSENT — short of the full trio.
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
    });
    await mount.whenLoaded();

    await mount.enableMcpDoor();

    expect(store.issue).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled(); // the seed skips the token load
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_CONTROLS_ATTR)).toHaveLength(0);
    mount.dispose();
  });

  it('opening is idempotent — enable no-ops when the door is already open', async () => {
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const { mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
    });
    await mount.whenTokensLoaded();
    expect(mount.getMcpDoorOpen()).toBe(true);

    await mount.enableMcpDoor();

    // The door owns ONE token — no second mint while it is already open.
    expect(store.issue).not.toHaveBeenCalled();
    expect(mount.getMcpDoorOpen()).toBe(true);
    mount.dispose();
  });

  it('supports the disable → re-enable recovery round-trip with a fresh token', async () => {
    const store = makeFakeTokenStore([]);
    const { mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
    });
    await mount.whenTokensLoaded();
    await mount.enableMcpDoor();
    expect(mount.getMcpDoorTokenPlaintext()).toBe('recued_test_1');

    await mount.disableMcpDoor();
    expect(mount.getMcpDoorOpen()).toBe(false);
    expect(mount.getMcpDoorTokenPlaintext()).toBeNull();

    // Re-enable mints a FRESH token with a new value (the one forced rebind).
    await mount.enableMcpDoor();
    expect(store.issue).toHaveBeenCalledTimes(2);
    expect(mount.getMcpDoorOpen()).toBe(true);
    expect(mount.getMcpDoorTokenPlaintext()).toBe('recued_test_2');
    mount.dispose();
  });

  it('a clipboard rejection never escapes as an unhandled rejection', async () => {
    const store = makeFakeTokenStore([]);
    const writeText = vi.fn(async () => {
      throw new Error('clipboard denied');
    });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      const { host, mount } = mountFor({
        runListInboundTokens: store.list,
        runIssueInboundToken: store.issue,
        runRevokeInboundToken: store.revoke,
      });
      await mount.whenTokensLoaded();
      await mount.enableMcpDoor();

      // Clicking copy against a rejecting clipboard must not throw, and the
      // value stays visible for manual copy regardless.
      expect(() =>
        onlyByAttr(host, PERMISSIONS_MCP_DOOR_TOKEN_COPY_ATTR).click(),
      ).not.toThrow();
      await tick();

      expect(writeText).toHaveBeenCalledWith('recued_test_1');
      expect(
        collectByAttr(host, PERMISSIONS_MCP_DOOR_TOKEN_VALUE_ATTR)[0]?.textContent,
      ).toBe('recued_test_1');
      mount.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('D-171 slice 2b — mcp door Chat row (chat_mode)', () => {
  const chatToggle = (host: FakeEl): FakeEl | null =>
    collectByAttr(host, PERMISSIONS_MCP_DOOR_CHAT_TOGGLE_ATTR)[0] ?? null;

  // The full four-caller mount (lifecycle trio + the Chat row's update caller).
  const mountWithChat = (seed: McpInboundTokenRecord[]) => {
    const store = makeFakeTokenStore(seed);
    const mounted = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
    });
    return { store, ...mounted };
  };

  it('renders the Chat row (Off) on an open door when the update caller is wired', async () => {
    const { host, mount } = mountWithChat([tokenRecord({ token_id: 'door_live' })]);
    await mount.whenTokensLoaded();

    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_CHAT_ROW_ATTR)).toHaveLength(1);
    expect(chatToggle(host)?.getAttribute('data-offered')).toBe('false');
    expect(mount.getMcpDoorChatOffered()).toBe(false);
    mount.dispose();
  });

  it('renders the Chat row On when the open token already offers chat', async () => {
    const { host, mount } = mountWithChat([
      tokenRecord({ token_id: 'door_live', chat_mode: { offered: true } }),
    ]);
    await mount.whenTokensLoaded();

    expect(chatToggle(host)?.getAttribute('data-offered')).toBe('true');
    expect(mount.getMcpDoorChatOffered()).toBe(true);
    mount.dispose();
  });

  it('omits the Chat row when the update caller is NOT wired (graceful degrade)', async () => {
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      // no runUpdateInboundToken
    });
    await mount.whenTokensLoaded();

    // The door is still interactive (open), but no Chat row.
    expect(mcpStatusText(host)).toBe('Open');
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_CHAT_ROW_ATTR)).toHaveLength(0);
    expect(mount.getMcpDoorChatOffered()).toBe(false);
    mount.dispose();
  });

  it('omits the Chat row when the door is closed', async () => {
    const { host, mount } = mountWithChat([]);
    await mount.whenTokensLoaded();

    expect(mcpStatusText(host)).toBe('Closed');
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_CHAT_ROW_ATTR)).toHaveLength(0);
    mount.dispose();
  });

  it('toggling Chat on sends chat_mode only (NO grants echo) + flips On', async () => {
    const { host, mount, store } = mountWithChat([
      tokenRecord({ token_id: 'door_live', grants: { 'mail.search': true }, chat_mode: null }),
    ]);
    await mount.whenTokensLoaded();

    await mount.setMcpDoorChat(true);

    expect(store.update).toHaveBeenCalledTimes(1);
    const arg = store.update.mock.calls[0]![0];
    expect(arg.token_id).toBe('door_live');
    expect(arg.chat_mode).toEqual({ offered: true });
    // The P2 fix: the chat toggle must NOT echo grants (would clobber a
    // concurrent per-tool edit since update_grants replaces the whole map).
    expect(arg).not.toHaveProperty('grants');
    expect(mount.getMcpDoorChatOffered()).toBe(true);
    expect(chatToggle(host)?.getAttribute('data-offered')).toBe('true');
    // The seeded grants survive (the fake store preserves on absent).
    expect(store.rows.find((r) => r.token_id === 'door_live')?.grants).toEqual({
      'mail.search': true,
    });
    mount.dispose();
  });

  it('toggling Chat off sends chat_mode null only (NO grants echo) + preserves grants', async () => {
    const { mount, store } = mountWithChat([
      tokenRecord({
        token_id: 'door_live',
        grants: { 'mail.search': true },
        chat_mode: { offered: true },
      }),
    ]);
    await mount.whenTokensLoaded();

    await mount.setMcpDoorChat(false);

    expect(store.update).toHaveBeenCalledTimes(1);
    const arg = store.update.mock.calls[0]![0];
    expect(arg.chat_mode).toBeNull();
    // The P2 fix applies to BOTH directions: the off-path must not echo grants
    // either, or it would roll back a concurrent per-tool edit on the server.
    expect(arg).not.toHaveProperty('grants');
    expect(mount.getMcpDoorChatOffered()).toBe(false);
    // The seeded grants survive solely because the field was absent.
    expect(store.rows.find((r) => r.token_id === 'door_live')?.grants).toEqual({
      'mail.search': true,
    });
    mount.dispose();
  });

  it('toggles Chat via the toggle button click', async () => {
    const { host, mount, store } = mountWithChat([tokenRecord({ token_id: 'door_live' })]);
    await mount.whenTokensLoaded();

    onlyByAttr(host, PERMISSIONS_MCP_DOOR_CHAT_TOGGLE_ATTR).click();
    await tick();

    expect(store.update).toHaveBeenCalledTimes(1);
    expect(store.update.mock.calls[0]![0].chat_mode).toEqual({ offered: true });
    expect(mount.getMcpDoorChatOffered()).toBe(true);
    mount.dispose();
  });

  it('is idempotent — setting the current state issues no rpc', async () => {
    const { mount, store } = mountWithChat([
      tokenRecord({ token_id: 'door_live', chat_mode: { offered: true } }),
    ]);
    await mount.whenTokensLoaded();

    await mount.setMcpDoorChat(true); // already on
    expect(store.update).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('surfaces an update failure on the door error chip + keeps the door open', async () => {
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    store.update.mockRejectedValueOnce(new Error('update boom'));
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
    });
    await mount.whenTokensLoaded();

    await mount.setMcpDoorChat(true);

    expect(allText(host).join(' ')).toContain('update boom');
    expect(mount.getMcpDoorOpen()).toBe(true);
    expect(mount.getMcpDoorChatOffered()).toBe(false);
    mount.dispose();
  });

  it('preserves the held bearer plaintext across a chat toggle (token value stable)', async () => {
    const { mount, store } = mountWithChat([]);
    await mount.whenTokensLoaded();
    await mount.enableMcpDoor();
    expect(mount.getMcpDoorTokenPlaintext()).toBe('recued_test_1');

    await mount.setMcpDoorChat(true);

    // Editing chat_mode does NOT re-issue — the plaintext is still held.
    expect(mount.getMcpDoorTokenPlaintext()).toBe('recued_test_1');
    expect(store.update).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

});

describe('D-171 slice 2c — mcp door per-tool grant checklist', () => {
  const kindGroups = (host: FakeEl): FakeEl[] =>
    collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANT_KIND_ATTR);
  const toolRow = (host: FakeEl, name: string): FakeEl | undefined =>
    collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANT_TOOL_ATTR).find(
      (r) => r.getAttribute('data-tool') === name,
    );
  const toolToggle = (host: FakeEl, name: string): FakeEl | undefined =>
    collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANT_TOOL_TOGGLE_ATTR).find(
      (b) => b.getAttribute('data-tool') === name,
    );
  const kindToggle = (host: FakeEl, kind: string): FakeEl | undefined =>
    collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANT_KIND_TOGGLE_ATTR).find(
      (b) => b.getAttribute('data-kind') === kind,
    );

  // Full five-caller mount (lifecycle trio + update + tool catalog).
  const mountWithGrants = (
    seed: McpInboundTokenRecord[],
    catalog: ToolEntry[] = toolCatalogFixture(),
  ) => {
    const store = makeFakeTokenStore(seed);
    const catalogCaller = toolCatalogCaller(catalog);
    const mounted = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
      runListToolCatalog: catalogCaller,
    });
    return { store, catalogCaller, ...mounted };
  };

  const settle = async (mount: ReturnType<typeof mountFor>['mount']) => {
    await mount.whenTokensLoaded();
    await mount.whenToolCatalogLoaded();
  };

  it('renders the checklist (kind-grouped, default-deny) on an open door', async () => {
    const { host, mount } = mountWithGrants([tokenRecord({ token_id: 'door_live' })]);
    await settle(mount);

    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANTS_ATTR)).toHaveLength(1);
    // Two kinds: storage (mail + calendar), connection (deal). Order is
    // storage first, connection last (the closed grouping order).
    const groups = kindGroups(host);
    expect(groups.map((g) => g.getAttribute('data-kind'))).toEqual([
      'storage',
      'connection',
    ]);
    // Every tool starts ungranted (the door's least-privilege default).
    expect(toolToggle(host, 'mail.search')?.getAttribute('data-granted')).toBe('false');
    expect(toolToggle(host, 'calendar.search')?.getAttribute('data-granted')).toBe('false');
    expect(toolToggle(host, 'deal.search')?.getAttribute('data-granted')).toBe('false');
    // Each kind group's master reads 'none'.
    expect(kindGroups(host).map((g) => g.getAttribute('data-master'))).toEqual([
      'none',
      'none',
    ]);
    mount.dispose();
  });

  it('discloses "also reads: team" on a raw op that transitively admits a container read (D-192 Slice 7)', async () => {
    const CREATE = 'recued_op_recued-core.linear-pack.issue.create';
    const { host, mount } = mountWithGrants(
      [tokenRecord({ token_id: 'door_live' })],
      [
        toolEntry({
          name: CREATE, classification: 'write',
          also_reads: [{ ref: 'team', list_op: 'team.search' }],
        }),
        toolEntry({ name: 'mail.search', classification: 'read' }),
      ],
    );
    await settle(mount);

    const row = toolRow(host, CREATE);
    expect(row).toBeDefined();
    const chip = collectByAttr(row!, PERMISSIONS_MCP_DOOR_GRANT_TOOL_ALSO_READS_ATTR)[0];
    expect(chip).toBeDefined();
    expect(chip!.getAttribute('data-reads')).toBe('team');
    expect(chip!.textContent).toContain('also reads: team');
    // A plain read tool carries no disclosure chip.
    expect(
      collectByAttr(toolRow(host, 'mail.search')!, PERMISSIONS_MCP_DOOR_GRANT_TOOL_ALSO_READS_ATTR),
    ).toHaveLength(0);
    mount.dispose();
  });

  it('reflects the live grants on the toggles + group master', async () => {
    const { host, mount } = mountWithGrants([
      tokenRecord({
        token_id: 'door_live',
        grants: { 'mail.search': true, 'calendar.search': true, 'deal.search': true },
      }),
    ]);
    await settle(mount);

    expect(toolToggle(host, 'mail.search')?.getAttribute('data-granted')).toBe('true');
    // storage fully granted, connection fully granted.
    expect(kindGroups(host).map((g) => g.getAttribute('data-master'))).toEqual([
      'all',
      'all',
    ]);
    // The handle projection mirrors it.
    const fromHandle = mount.getMcpDoorGrantGroups();
    expect(fromHandle.map((g) => g.kind)).toEqual(['storage', 'connection']);
    expect(fromHandle[0]!.master).toBe('all');
    mount.dispose();
  });

  it('omits the checklist when the catalog caller is NOT wired (graceful degrade)', async () => {
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
      // no runListToolCatalog
    });
    await mount.whenTokensLoaded();
    await mount.whenToolCatalogLoaded();

    expect(mcpStatusText(host)).toBe('Open');
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANTS_ATTR)).toHaveLength(0);
    expect(mount.getMcpDoorGrantGroups()).toEqual([]);
    mount.dispose();
  });

  it('omits the checklist when the door is closed', async () => {
    const { host, mount } = mountWithGrants([]);
    await settle(mount);

    expect(mcpStatusText(host)).toBe('Closed');
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANTS_ATTR)).toHaveLength(0);
    mount.dispose();
  });

  it('toggling a tool on sends grants ONLY (no chat_mode echo) + flips On', async () => {
    const { host, mount, store } = mountWithGrants([
      tokenRecord({ token_id: 'door_live', chat_mode: { offered: true } }),
    ]);
    await settle(mount);

    await mount.setMcpDoorToolGrant('mail.search', true);

    expect(store.update).toHaveBeenCalledTimes(1);
    const arg = store.update.mock.calls[0]![0];
    expect(arg.token_id).toBe('door_live');
    expect(arg.grants).toEqual({ 'mail.search': true });
    // The grant edit must NOT echo chat_mode (would clobber the Chat toggle
    // since the server only preserves an ABSENT field).
    expect(arg).not.toHaveProperty('chat_mode');
    expect(toolToggle(host, 'mail.search')?.getAttribute('data-granted')).toBe('true');
    // The seeded chat_mode survives (the fake store preserves on absent).
    expect(store.rows.find((r) => r.token_id === 'door_live')?.chat_mode).toEqual({
      offered: true,
    });
    mount.dispose();
  });

  it('toggling a tool off preserves the other grants + does not echo chat_mode', async () => {
    const { mount, store } = mountWithGrants([
      tokenRecord({
        token_id: 'door_live',
        grants: { 'mail.search': true, 'calendar.search': true },
        chat_mode: { offered: true },
      }),
    ]);
    await settle(mount);

    await mount.setMcpDoorToolGrant('mail.search', false);

    expect(store.update).toHaveBeenCalledTimes(1);
    const arg = store.update.mock.calls[0]![0];
    // The whole map is replaced; calendar stays granted, mail flips off.
    expect(arg.grants).toEqual({ 'mail.search': false, 'calendar.search': true });
    expect(arg).not.toHaveProperty('chat_mode');
    expect(store.rows.find((r) => r.token_id === 'door_live')?.chat_mode).toEqual({
      offered: true,
    });
    mount.dispose();
  });

  it('is idempotent — granting an already-granted tool issues no rpc', async () => {
    const { mount, store } = mountWithGrants([
      tokenRecord({ token_id: 'door_live', grants: { 'mail.search': true } }),
    ]);
    await settle(mount);

    await mount.setMcpDoorToolGrant('mail.search', true); // already on
    expect(store.update).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('toggles a tool via the toggle button click', async () => {
    const { host, mount, store } = mountWithGrants([tokenRecord({ token_id: 'door_live' })]);
    await settle(mount);

    toolToggle(host, 'deal.search')!.click();
    await tick();

    expect(store.update).toHaveBeenCalledTimes(1);
    expect(store.update.mock.calls[0]![0].grants).toEqual({ 'deal.search': true });
    expect(mount.getMcpDoorGrantGroups().find((g) => g.kind === 'connection')!.master).toBe('all');
    mount.dispose();
  });

  it('the kind master toggle grants every tool in the kind (grants only)', async () => {
    const { host, mount, store } = mountWithGrants([tokenRecord({ token_id: 'door_live' })]);
    await settle(mount);

    // storage = mail.search + calendar.search. Turning the kind on grants both.
    kindToggle(host, 'storage')!.click();
    await tick();

    expect(store.update).toHaveBeenCalledTimes(1);
    const arg = store.update.mock.calls[0]![0];
    expect(arg.grants).toEqual({ 'mail.search': true, 'calendar.search': true });
    expect(arg).not.toHaveProperty('chat_mode');
    // deal.search (connection) is untouched by the storage master.
    expect(arg.grants).not.toHaveProperty('deal.search');
    expect(mount.getMcpDoorGrantGroups().find((g) => g.kind === 'storage')!.master).toBe('all');
    mount.dispose();
  });

  it('the kind master toggle revokes every tool in the kind when fully granted', async () => {
    const { host, mount, store } = mountWithGrants([
      tokenRecord({
        token_id: 'door_live',
        grants: { 'mail.search': true, 'calendar.search': true },
      }),
    ]);
    await settle(mount);

    kindToggle(host, 'storage')!.click();
    await tick();

    expect(store.update).toHaveBeenCalledTimes(1);
    expect(store.update.mock.calls[0]![0].grants).toEqual({
      'mail.search': false,
      'calendar.search': false,
    });
    mount.dispose();
  });

  it('the programmatic kind grant edits the whole kind', async () => {
    const { mount, store } = mountWithGrants([tokenRecord({ token_id: 'door_live' })]);
    await settle(mount);

    await mount.setMcpDoorKindGrant('connection', true);
    expect(store.update).toHaveBeenCalledTimes(1);
    expect(store.update.mock.calls[0]![0].grants).toEqual({ 'deal.search': true });
    mount.dispose();
  });

  it('surfaces a grant-edit failure on the door error chip + keeps the door open', async () => {
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    store.update.mockRejectedValueOnce(new Error('grant boom'));
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
      runListToolCatalog: toolCatalogCaller(),
    });
    await mount.whenTokensLoaded();
    await mount.whenToolCatalogLoaded();

    await mount.setMcpDoorToolGrant('mail.search', true);

    expect(allText(host).join(' ')).toContain('grant boom');
    expect(mount.getMcpDoorOpen()).toBe(true);
    // The failed edit didn't flip the grant.
    expect(toolToggle(host, 'mail.search')?.getAttribute('data-granted')).toBe('false');
    mount.dispose();
  });

  it('shows a loading line until the catalog settles', async () => {
    const gate = deferred<{ catalog: ToolEntry[] }>();
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
      runListToolCatalog: vi.fn<PermissionsToolCatalogCaller>(() => gate.promise),
    });
    await mount.whenTokensLoaded();
    await tick();

    // Catalog still pending → the section shows a loading line, no tool rows.
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANTS_EMPTY_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANT_TOOL_ATTR)).toHaveLength(0);

    gate.resolve({ catalog: toolCatalogFixture() });
    await mount.whenToolCatalogLoaded();

    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANTS_EMPTY_ATTR)).toHaveLength(0);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANT_TOOL_ATTR).length).toBeGreaterThan(0);
    mount.dispose();
  });

  it('degrades to an inline error when the catalog load fails (door unaffected)', async () => {
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
      runListToolCatalog: vi.fn<PermissionsToolCatalogCaller>(async () => {
        throw new Error('catalog boom');
      }),
    });
    await mount.whenTokensLoaded();
    await mount.whenToolCatalogLoaded();

    expect(allText(host).join(' ')).toContain('catalog boom');
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANT_TOOL_ATTR)).toHaveLength(0);
    // The door itself stays open + interactive.
    expect(mount.getMcpDoorOpen()).toBe(true);
    expect(mcpStatusText(host)).toBe('Open');
    mount.dispose();
  });

  it('shows an empty state when the catalog is empty', async () => {
    const { host, mount } = mountWithGrants([tokenRecord({ token_id: 'door_live' })], []);
    await settle(mount);

    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANTS_EMPTY_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANT_TOOL_ATTR)).toHaveLength(0);
    expect(mount.getMcpDoorGrantGroups()).toEqual([]);
    mount.dispose();
  });

  it('preserves the held bearer plaintext across a grant edit (token value stable)', async () => {
    const { mount, store } = mountWithGrants([]);
    await settle(mount);
    await mount.enableMcpDoor();
    expect(mount.getMcpDoorTokenPlaintext()).toBe('recued_test_1');

    await mount.setMcpDoorToolGrant('mail.search', true);

    // Editing grants does NOT re-issue — the plaintext is still held.
    expect(mount.getMcpDoorTokenPlaintext()).toBe('recued_test_1');
    expect(store.update).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  // ── D-171 slice-2c follow-on #1 — the legacy recued_* + recued_ingredient_*
  //    surface is now grantable through the checklist. ──

  /** A catalog spanning a registry kind + both legacy buckets: `mail.search`
   *  (storage) + two `recued_*` meta tools (recued_native) + one
   *  `recued_ingredient_*` (recued_ingredient). Legacy entries carry the
   *  projection's tier:2. */
  const legacyCatalog = (): ToolEntry[] => [
    toolEntry({ name: 'mail.search', classification: 'read' }),
    toolEntry({ name: 'recued_dataTimeline', tier: 2, classification: 'read' }),
    toolEntry({ name: 'recued_runRecipe', tier: 2, classification: 'unknown' }),
    toolEntry({
      name: 'recued_ingredient_mail-send',
      tier: 2,
      classification: 'write',
    }),
  ];

  it('renders the legacy buckets (recued_native + recued_ingredient) ordered last, default-deny', async () => {
    const { host, mount } = mountWithGrants(
      [tokenRecord({ token_id: 'door_live' })],
      legacyCatalog(),
    );
    await settle(mount);

    // storage first (registry), then the two legacy buckets last.
    expect(kindGroups(host).map((g) => g.getAttribute('data-kind'))).toEqual([
      'storage',
      'recued_native',
      'recued_ingredient',
    ]);
    // Every legacy tool starts ungranted (the door's least-privilege default).
    expect(toolToggle(host, 'recued_runRecipe')?.getAttribute('data-granted')).toBe(
      'false',
    );
    expect(
      toolToggle(host, 'recued_ingredient_mail-send')?.getAttribute('data-granted'),
    ).toBe('false');
    expect(kindGroups(host).map((g) => g.getAttribute('data-master'))).toEqual([
      'none',
      'none',
      'none',
    ]);
    mount.dispose();
  });

  it('toggling a legacy tool routes grants by its wire name (grants-only)', async () => {
    const { host, mount, store } = mountWithGrants(
      [tokenRecord({ token_id: 'door_live', chat_mode: { offered: true } })],
      legacyCatalog(),
    );
    await settle(mount);

    await mount.setMcpDoorToolGrant('recued_ingredient_mail-send', true);

    expect(store.update).toHaveBeenCalledTimes(1);
    const arg = store.update.mock.calls[0]![0];
    expect(arg.grants).toEqual({ 'recued_ingredient_mail-send': true });
    expect(arg).not.toHaveProperty('chat_mode');
    expect(
      toolToggle(host, 'recued_ingredient_mail-send')?.getAttribute('data-granted'),
    ).toBe('true');
    mount.dispose();
  });

  // ── D-182 §8 — raw catalog ops (`recued_op_<publisher>.<pack>.<operation>`)
  //    render in their own bucket, ordered last (after the D-171 legacy
  //    buckets). The renderer looks up `CHAT_INBOUND_TOKEN_KIND_COPY[kind]` for
  //    the header label, so a missing copy entry would THROW on mount — this
  //    test guards that integration. ──

  /** A catalog spanning a registry kind + a raw read op + a raw write op. The
   *  grant catalog stamps raw ops `tier: 2`; the classifier groups them by the
   *  `recued_op_` name prefix regardless. */
  const rawOpCatalog = (): ToolEntry[] => [
    toolEntry({ name: 'mail.search', classification: 'read' }),
    toolEntry({
      name: 'recued_op_recued-core.hubspot.contact.search',
      tier: 2,
      classification: 'read',
    }),
    toolEntry({
      name: 'recued_op_recued-core.hubspot.deal.create',
      tier: 2,
      classification: 'write',
    }),
  ];

  it('renders the D-182 raw-op bucket (recued_op) ordered last, with toggleable per-op rows', async () => {
    const { host, mount } = mountWithGrants(
      [tokenRecord({ token_id: 'door_live' })],
      rawOpCatalog(),
    );
    await settle(mount);

    // storage first (registry), then the raw-op bucket last.
    expect(kindGroups(host).map((g) => g.getAttribute('data-kind'))).toEqual([
      'storage',
      'recued_op',
    ]);
    // The bucket header rendered (label lookup succeeded ⇒ master toggle present).
    expect(kindToggle(host, 'recued_op')).toBeDefined();
    // Both ops render as per-tool rows keyed on their wire name; default-deny
    // live state (the door hasn't been granted these yet).
    expect(
      toolToggle(host, 'recued_op_recued-core.hubspot.contact.search')?.getAttribute(
        'data-granted',
      ),
    ).toBe('false');
    expect(
      toolToggle(host, 'recued_op_recued-core.hubspot.deal.create')?.getAttribute(
        'data-granted',
      ),
    ).toBe('false');
    mount.dispose();
  });

  it('toggling a raw op routes the grant by its full recued_op_ wire name', async () => {
    const { host, mount, store } = mountWithGrants(
      [tokenRecord({ token_id: 'door_live' })],
      rawOpCatalog(),
    );
    await settle(mount);

    await mount.setMcpDoorToolGrant(
      'recued_op_recued-core.hubspot.deal.create',
      true,
    );

    expect(store.update).toHaveBeenCalledTimes(1);
    const arg = store.update.mock.calls[0]![0];
    expect(arg.grants).toEqual({
      'recued_op_recued-core.hubspot.deal.create': true,
    });
    expect(
      toolToggle(host, 'recued_op_recued-core.hubspot.deal.create')?.getAttribute(
        'data-granted',
      ),
    ).toBe('true');
    mount.dispose();
  });

  it('the recued_native bucket master grants every meta tool, leaving registry kinds untouched', async () => {
    const { mount, store } = mountWithGrants(
      [tokenRecord({ token_id: 'door_live' })],
      legacyCatalog(),
    );
    await settle(mount);

    await mount.setMcpDoorKindGrant('recued_native', true);

    expect(store.update).toHaveBeenCalledTimes(1);
    const arg = store.update.mock.calls[0]![0];
    // Both native meta tools flip on; the registry storage tool is untouched.
    expect(arg.grants).toEqual({
      recued_dataTimeline: true,
      recued_runRecipe: true,
    });
    mount.dispose();
  });
});

describe('D-171 slice 3b — mcp door Advanced (lazy cap/expiry)', () => {
  const advancedSection = (host: FakeEl): FakeEl[] =>
    collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_ATTR);
  const capToggle = (host: FakeEl): FakeEl | undefined =>
    collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_CAP_TOGGLE_ATTR)[0];
  const expiryToggle = (host: FakeEl): FakeEl | undefined =>
    collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_EXPIRY_TOGGLE_ATTR)[0];
  const capInput = (host: FakeEl): FakeEl | undefined =>
    collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_CAP_INPUT_ATTR)[0];
  const summaryEl = (host: FakeEl): FakeEl | undefined =>
    collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_SUMMARY_ATTR)[0];
  const advancedError = (host: FakeEl): FakeEl | undefined =>
    collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_ERROR_ATTR)[0];

  // Full eight-caller mount (door lifecycle trio + update_grants + the four
  // contract callers). No tool-catalog caller (the grant checklist is orthogonal).
  const mountAdvanced = (
    seedTokens: McpInboundTokenRecord[],
    seedContracts: ContractDefinitionView[] = [],
  ) => {
    const store = makeFakeTokenStore(seedTokens);
    const contracts = makeFakeContractStore(seedContracts);
    const mounted = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
      runUpdateInboundContract: store.updateContract,
      runMintContract: contracts.mint,
      runRevokeContract: contracts.revoke,
      runListContracts: contracts.list,
    });
    return { store, contracts, ...mounted };
  };

  const settle = async (mount: ReturnType<typeof mountFor>['mount']) => {
    await mount.whenTokensLoaded();
    await mount.whenAdvancedLoaded();
    await tick();
  };

  it('renders the Advanced sub-panel (limits off by default) on an unbound open door', async () => {
    const { host, mount } = mountAdvanced([tokenRecord({ token_id: 'door_live' })]);
    await settle(mount);

    expect(advancedSection(host)).toHaveLength(1);
    expect(capToggle(host)?.getAttribute('data-enabled')).toBe('false');
    expect(expiryToggle(host)?.getAttribute('data-enabled')).toBe('false');
    // No bound contract → no value input shown + the summary reads "no limits".
    expect(capInput(host)).toBeUndefined();
    expect(mount.getMcpDoorBoundContract()).toBeNull();
    expect(summaryEl(host)?.textContent).toContain('No limits');
    mount.dispose();
  });

  it('omits the Advanced sub-panel when a contract caller is missing (graceful degrade)', async () => {
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const contracts = makeFakeContractStore([]);
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
      // mint + list + update_contract wired, but NO revoke caller → gate fails.
      runMintContract: contracts.mint,
      runListContracts: contracts.list,
      runUpdateInboundContract: store.updateContract,
    });
    await mount.whenTokensLoaded();
    await tick();

    expect(mcpStatusText(host)).toBe('Open');
    expect(advancedSection(host)).toHaveLength(0);
    expect(mount.getMcpDoorBoundContract()).toBeNull();
    mount.dispose();
  });

  it('omits the Advanced sub-panel when the door is closed', async () => {
    const { host, mount } = mountAdvanced([]);
    await settle(mount);

    expect(mcpStatusText(host)).toBe('Closed');
    expect(advancedSection(host)).toHaveLength(0);
    mount.dispose();
  });

  it('seeds the draft + summary from the bound contract on load', async () => {
    const expiryAt = Date.UTC(2026, 5, 15);
    const { host, mount } = mountAdvanced(
      [tokenRecord({ token_id: 'door_live', contract_id: 'ct_bound' })],
      [
        contractView({
          contract_id: 'ct_bound',
          max_uses: 50,
          uses_remaining: 30,
          expiry_at: expiryAt,
        }),
      ],
    );
    await settle(mount);

    // Both limits seed ON; the bound view resolves through the handle.
    expect(capToggle(host)?.getAttribute('data-enabled')).toBe('true');
    expect(expiryToggle(host)?.getAttribute('data-enabled')).toBe('true');
    expect(mount.getMcpDoorBoundContract()?.contract_id).toBe('ct_bound');
    const summary = summaryEl(host);
    expect(summary?.getAttribute('data-state')).toBe('active');
    expect(summary?.textContent).toContain('usage cap 30/50 left');
    mount.dispose();
  });

  it('seeds the draft even when contracts load BEFORE the token list (load-order race)', async () => {
    // The P2 regression: `seedAdvancedDraftIfNeeded` must fire from the token-load
    // path too, else a contracts-first load leaves a bound door's draft at "off"
    // and "Save limits" misreads as a clear → revokes the live limit.
    const tokenGate = deferred<void>();
    const store = makeFakeTokenStore([]);
    const bound = tokenRecord({ token_id: 'door_live', contract_id: 'ct_bound' });
    store.list.mockImplementation(async () => {
      await tokenGate.promise;
      return { tokens: [{ ...bound }] };
    });
    const contracts = makeFakeContractStore([
      contractView({ contract_id: 'ct_bound', max_uses: 50, uses_remaining: 50 }),
    ]);
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
      runUpdateInboundContract: store.updateContract,
      runMintContract: contracts.mint,
      runRevokeContract: contracts.revoke,
      runListContracts: contracts.list,
    });
    // Contracts settle first (the token list is gated open).
    await mount.whenAdvancedLoaded();
    await tick();
    // Now release the token list; the seed must fire on the token-load path.
    tokenGate.resolve();
    await mount.whenTokensLoaded();
    await tick();

    expect(capToggle(host)?.getAttribute('data-enabled')).toBe('true');
    expect(mount.getMcpDoorBoundContract()?.contract_id).toBe('ct_bound');
    mount.dispose();
  });

  it('turning the cap ON mints {channels:[mcp]} + max_uses + binds the live token', async () => {
    const { host, mount, store, contracts } = mountAdvanced([
      tokenRecord({ token_id: 'door_live' }),
    ]);
    await settle(mount);

    mount.setAdvancedField('capEnabled', true);
    mount.setAdvancedField('maxUses', '50');
    await mount.submitMcpDoorLimits();
    await tick();

    // ONE mint with the load-bearing scope + max_uses only (no expiry_at).
    expect(contracts.mint).toHaveBeenCalledTimes(1);
    const mintArg = contracts.mint.mock.calls[0]![0];
    expect(mintArg.scope).toEqual({ channels: ['mcp'] });
    expect(mintArg.max_uses).toBe(50);
    expect(mintArg).not.toHaveProperty('expiry_at');
    expect(mintArg.display_name).toBe(MCP_DOOR_CONTRACT_NAME);
    // The LIVE token is rebound to the minted contract (no re-issue).
    expect(store.updateContract).toHaveBeenCalledTimes(1);
    expect(store.updateContract.mock.calls[0]![0]).toEqual({
      token_id: 'door_live',
      contract_id: 'ct_minted_1',
    });
    // No prior contract → nothing revoked. Token now reads bound.
    expect(contracts.revoke).not.toHaveBeenCalled();
    expect(mount.getMcpDoorBoundContract()?.contract_id).toBe('ct_minted_1');
    expect(summaryEl(host)?.textContent).toContain('usage cap 50/50 left');
    mount.dispose();
  });

  it('turning expiry ON mints expiry_at only (no max_uses)', async () => {
    const { mount, contracts, store } = mountAdvanced([
      tokenRecord({ token_id: 'door_live' }),
    ]);
    await settle(mount);

    mount.setAdvancedField('expiryEnabled', true);
    mount.setAdvancedField('expiry', '2026-06-15');
    await mount.submitMcpDoorLimits();
    await tick();

    expect(contracts.mint).toHaveBeenCalledTimes(1);
    const mintArg = contracts.mint.mock.calls[0]![0];
    expect(mintArg.scope).toEqual({ channels: ['mcp'] });
    expect(mintArg.expiry_at).toBe(Date.parse('2026-06-15'));
    expect(mintArg).not.toHaveProperty('max_uses');
    expect(store.updateContract).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('both limits ON mint ONE contract carrying max_uses + expiry_at', async () => {
    const { mount, contracts, store } = mountAdvanced([
      tokenRecord({ token_id: 'door_live' }),
    ]);
    await settle(mount);

    mount.setAdvancedField('capEnabled', true);
    mount.setAdvancedField('maxUses', '25');
    mount.setAdvancedField('expiryEnabled', true);
    mount.setAdvancedField('expiry', '2026-12-31');
    await mount.submitMcpDoorLimits();
    await tick();

    // ONE mint, both fields; ONE rebind.
    expect(contracts.mint).toHaveBeenCalledTimes(1);
    const mintArg = contracts.mint.mock.calls[0]![0];
    expect(mintArg.max_uses).toBe(25);
    expect(mintArg.expiry_at).toBe(Date.parse('2026-12-31'));
    expect(store.updateContract).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('clearing every limit unbinds the token + revokes the prior contract (no mint)', async () => {
    const { mount, contracts, store } = mountAdvanced(
      [tokenRecord({ token_id: 'door_live', contract_id: 'ct_bound' })],
      [contractView({ contract_id: 'ct_bound', max_uses: 50, uses_remaining: 30 })],
    );
    await settle(mount);

    // The cap seeded ON; turn it off + save → desired (null, null) = clear.
    mount.setAdvancedField('capEnabled', false);
    await mount.submitMcpDoorLimits();
    await tick();

    expect(contracts.mint).not.toHaveBeenCalled();
    // Unbind first (so the token is never bound to a revoked contract)…
    expect(store.updateContract).toHaveBeenCalledTimes(1);
    expect(store.updateContract.mock.calls[0]![0]).toEqual({
      token_id: 'door_live',
      contract_id: null,
    });
    // …then revoke the prior envelope.
    expect(contracts.revoke).toHaveBeenCalledTimes(1);
    expect(contracts.revoke.mock.calls[0]![0]).toEqual({ contract_id: 'ct_bound' });
    expect(mount.getMcpDoorBoundContract()).toBeNull();
    mount.dispose();
  });

  it('changing a limit value re-mints + rebinds + revokes the OLD contract', async () => {
    const { mount, contracts, store } = mountAdvanced(
      [tokenRecord({ token_id: 'door_live', contract_id: 'ct_bound' })],
      [contractView({ contract_id: 'ct_bound', max_uses: 50, uses_remaining: 50 })],
    );
    await settle(mount);

    mount.setAdvancedField('maxUses', '100');
    await mount.submitMcpDoorLimits();
    await tick();

    // New envelope with the new value…
    expect(contracts.mint).toHaveBeenCalledTimes(1);
    expect(contracts.mint.mock.calls[0]![0].max_uses).toBe(100);
    // …rebind the live token to it…
    expect(store.updateContract).toHaveBeenCalledTimes(1);
    expect(store.updateContract.mock.calls[0]![0].contract_id).toBe('ct_minted_1');
    // …then retire the old one.
    expect(contracts.revoke).toHaveBeenCalledTimes(1);
    expect(contracts.revoke.mock.calls[0]![0]).toEqual({ contract_id: 'ct_bound' });
    mount.dispose();
  });

  it('is a no-op when the draft equals the LIVE limit', async () => {
    const { mount, contracts, store } = mountAdvanced(
      [tokenRecord({ token_id: 'door_live', contract_id: 'ct_bound' })],
      [contractView({ contract_id: 'ct_bound', max_uses: 50, uses_remaining: 30 })],
    );
    await settle(mount);

    // Draft seeded to the live limit; save without changing anything.
    await mount.submitMcpDoorLimits();
    await tick();

    expect(contracts.mint).not.toHaveBeenCalled();
    expect(store.updateContract).not.toHaveBeenCalled();
    expect(contracts.revoke).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('re-mints when the bound contract is DEAD even if the values are unchanged', async () => {
    // An exhausted bound contract is the kill-switch having fired. Re-saving the
    // same values must restore a LIVE limit (liveLimitTuple reports null for a
    // dead contract, so the short-circuit does not fire).
    const { host, mount, contracts } = mountAdvanced(
      [tokenRecord({ token_id: 'door_live', contract_id: 'ct_dead' })],
      [
        contractView({
          contract_id: 'ct_dead',
          max_uses: 50,
          uses_remaining: 0,
          lifecycle_state: 'exhausted',
        }),
      ],
    );
    await settle(mount);

    // The summary names the kill-switch having fired.
    expect(summaryEl(host)?.getAttribute('data-state')).toBe('exhausted');
    expect(summaryEl(host)?.textContent).toContain('blocked');

    // Save without editing → re-mint (restores).
    await mount.submitMcpDoorLimits();
    await tick();
    expect(contracts.mint).toHaveBeenCalledTimes(1);
    expect(contracts.mint.mock.calls[0]![0].max_uses).toBe(50);
    mount.dispose();
  });

  it('rejects an empty / non-positive cap value with no rpc', async () => {
    const { mount, contracts } = mountAdvanced([tokenRecord({ token_id: 'door_live' })]);
    await settle(mount);

    mount.setAdvancedField('capEnabled', true);
    mount.setAdvancedField('maxUses', '');
    await mount.submitMcpDoorLimits();
    expect(mount.getAdvancedError()).toContain('Usage cap must be');
    expect(contracts.mint).not.toHaveBeenCalled();

    mount.setAdvancedField('maxUses', '0');
    await mount.submitMcpDoorLimits();
    expect(mount.getAdvancedError()).toContain('Usage cap must be');
    expect(contracts.mint).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('rejects an unparseable expiry date with no rpc', async () => {
    const { host, mount, contracts } = mountAdvanced([
      tokenRecord({ token_id: 'door_live' }),
    ]);
    await settle(mount);

    mount.setAdvancedField('expiryEnabled', true);
    mount.setAdvancedField('expiry', 'not-a-date');
    await mount.submitMcpDoorLimits();

    expect(mount.getAdvancedError()).toContain('Could not read the expiry date');
    expect(contracts.mint).not.toHaveBeenCalled();
    expect(advancedError(host)).toBeDefined();
    mount.dispose();
  });

  it('surfaces a mint failure on the Advanced error chip + clears busy', async () => {
    const { host, mount, contracts, store } = mountAdvanced([
      tokenRecord({ token_id: 'door_live' }),
    ]);
    await settle(mount);
    contracts.mint.mockRejectedValueOnce(new Error('mint boom'));

    mount.setAdvancedField('capEnabled', true);
    mount.setAdvancedField('maxUses', '10');
    await mount.submitMcpDoorLimits();
    await tick();

    expect(advancedError(host)?.textContent).toContain('mint boom');
    // The token was never rebound (mint failed first).
    expect(store.updateContract).not.toHaveBeenCalled();
    // A later edit + save can still proceed (busy was cleared).
    mount.setAdvancedField('maxUses', '20');
    await mount.submitMcpDoorLimits();
    await tick();
    expect(store.updateContract).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('revokes the orphan minted contract when the rebind fails (no leak)', async () => {
    // mint succeeds but update_contract rejects (e.g. a server with D-166
    // mintContract but not the slice-3a rebind rpc). The token was never
    // limited, so the just-minted orphan must be revoked — else retries pile up
    // active, unbound "MCP door limits" contracts.
    const { mount, contracts, store } = mountAdvanced([
      tokenRecord({ token_id: 'door_live' }),
    ]);
    await settle(mount);
    store.updateContract.mockRejectedValueOnce(new Error('no rebind rpc'));

    mount.setAdvancedField('capEnabled', true);
    mount.setAdvancedField('maxUses', '10');
    await mount.submitMcpDoorLimits();
    await tick();

    expect(contracts.mint).toHaveBeenCalledTimes(1);
    // The orphan is revoked (the just-minted id), not a prior contract.
    expect(contracts.revoke).toHaveBeenCalledTimes(1);
    expect(contracts.revoke.mock.calls[0]![0].contract_id).toBe('ct_minted_1');
    // The bind error surfaces; the token stays unbound.
    expect(mount.getAdvancedError()).toContain('no rebind rpc');
    expect(mount.getMcpDoorBoundContract()).toBeNull();
    mount.dispose();
  });

  it('revokes the bound limit contract when the door is disabled (full kill-switch)', async () => {
    const { mount, contracts, store } = mountAdvanced(
      [tokenRecord({ token_id: 'door_live', contract_id: 'ct_bound' })],
      [contractView({ contract_id: 'ct_bound', max_uses: 50, uses_remaining: 30 })],
    );
    await settle(mount);

    await mount.disableMcpDoor();
    await tick();

    // The token is revoked (the existing kill-switch)…
    expect(store.revoke).toHaveBeenCalledTimes(1);
    expect(store.revoke.mock.calls[0]![0].token_id).toBe('door_live');
    // …AND the bound limit contract, so no orphan lingers in the inspector.
    expect(contracts.revoke).toHaveBeenCalledTimes(1);
    expect(contracts.revoke.mock.calls[0]![0]).toEqual({ contract_id: 'ct_bound' });
    expect(mount.getMcpDoorOpen()).toBe(false);
    mount.dispose();
  });

  it('revokes no contract when disabling an unbound door', async () => {
    const { mount, contracts, store } = mountAdvanced([
      tokenRecord({ token_id: 'door_live' }),
    ]);
    await settle(mount);

    await mount.disableMcpDoor();
    await tick();

    expect(store.revoke).toHaveBeenCalledTimes(1);
    expect(contracts.revoke).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('degrades to a "Limits unavailable" line when listContracts fails', async () => {
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const contracts = makeFakeContractStore([]);
    contracts.list.mockRejectedValueOnce(new Error('contracts boom'));
    const { host, mount } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
      runUpdateInboundContract: store.updateContract,
      runMintContract: contracts.mint,
      runRevokeContract: contracts.revoke,
      runListContracts: contracts.list,
    });
    await mount.whenTokensLoaded();
    await mount.whenAdvancedLoaded();
    await tick();

    // The door + Advanced shell still render; only the limit detail degrades.
    expect(mcpStatusText(host)).toBe('Open');
    expect(advancedSection(host)).toHaveLength(1);
    expect(summaryEl(host)?.textContent).toContain('Limits unavailable');
    expect(summaryEl(host)?.textContent).toContain('contracts boom');
    mount.dispose();
  });

  it('surfaces the "fresh usage count" note only while a cap is enabled', async () => {
    // Re-minting reseeds uses_remaining, so any save resets a consumed cap. The
    // note makes that unavoidable reset honest (shown only when a cap is in play).
    const { host, mount } = mountAdvanced([tokenRecord({ token_id: 'door_live' })]);
    await settle(mount);

    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_NOTE_ATTR)).toHaveLength(0);

    mount.setAdvancedField('capEnabled', true);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_NOTE_ATTR)).toHaveLength(1);
    expect(
      collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_NOTE_ATTR)[0]!.textContent,
    ).toContain('fresh usage count');

    // Expiry-only (cap off) shows no cap-reset note.
    mount.setAdvancedField('capEnabled', false);
    mount.setAdvancedField('expiryEnabled', true);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_NOTE_ATTR)).toHaveLength(0);
    mount.dispose();
  });

  it('flags a bound-but-unresolved contract as blocked, never "No limits"', async () => {
    // The token carries a contract_id `listContracts` does NOT return (a
    // hard-deleted contract / sync gap). The backend fails CLOSED on an
    // unresolvable bound contract, so the door is blocked — the summary must not
    // claim "unlimited".
    const { host, mount } = mountAdvanced(
      [tokenRecord({ token_id: 'door_live', contract_id: 'ct_gone' })],
      [], // listContracts returns nothing → ct_gone is unresolvable
    );
    await settle(mount);

    expect(mount.getMcpDoorBoundContract()).toBeNull();
    const summary = summaryEl(host);
    expect(summary?.getAttribute('data-state')).toBe('unresolved');
    expect(summary?.textContent).toContain('could not be loaded');
    expect(summary?.textContent).not.toContain('No limits');
    mount.dispose();
  });

});

describe('D-166 Permissions create form', () => {
  it('renders only when both create callers are supplied', async () => {
    const withoutCreate = mountFor();
    await withoutCreate.mount.whenLoaded();

    expect(collectByAttr(withoutCreate.host, PERMISSIONS_CREATE_FORM_ATTR)).toHaveLength(0);
    withoutCreate.mount.dispose();

    const withCreate = mountFor({ withCreate: true, catalog: catalogFixture() });
    await withCreate.mount.whenLoaded();
    await withCreate.mount.whenCatalogLoaded();

    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_FORM_ATTR)).toHaveLength(1);
    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_ACTOR_ATTR)).toHaveLength(1);
    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_INGREDIENT_ATTR)).toHaveLength(1);
    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_OPERATION_ATTR)).toHaveLength(1);
    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_DENIED_ATTR)).toHaveLength(1);
    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_APPROVAL_ATTR)).toHaveLength(1);
    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_MAXRISK_ATTR)).toHaveLength(1);
    expect(collectByAttr(withCreate.host, PERMISSIONS_CREATE_SAVE_ATTR)).toHaveLength(1);
    withCreate.mount.dispose();
  });

  it('populates ingredient options from the loaded catalog', async () => {
    const catalog = catalogFixture();
    const { host, mount } = mountFor({ withCreate: true, catalog });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();

    expect(mount.getCatalog()).toEqual(catalog);
    expect(selectOptions(host, PERMISSIONS_CREATE_INGREDIENT_ATTR)).toEqual([
      { value: '', label: 'Select ingredient…' },
      { value: DEALS, label: 'HubSpot Deals' },
      { value: CONTACTS, label: 'HubSpot Contacts' },
    ]);
    mount.dispose();
  });

  it('updates operation options for the selected ingredient', async () => {
    const { host, mount } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();

    mount.setCreateField('ingredient_id', DEALS);

    expect(selectOptions(host, PERMISSIONS_CREATE_OPERATION_ATTR)).toEqual([
      { value: '', label: 'All operations (ingredient-wide)' },
      { value: DEALS_READ, label: 'read (read)' },
      { value: DEALS_WRITE, label: 'write (write)' },
    ]);

    mount.setCreateField('operation_id', DEALS_WRITE);
    mount.setCreateField('ingredient_id', CONTACTS);

    const operationOptions = selectOptions(host, PERMISSIONS_CREATE_OPERATION_ATTR);
    expect(operationOptions).toEqual([
      { value: '', label: 'All operations (ingredient-wide)' },
      { value: CONTACTS_WRITE, label: 'write (write)' },
    ]);
    expect(operationOptions.map((o) => o.value)).not.toContain(DEALS_WRITE);
    mount.dispose();
  });

  it('submits an ingredient-wide denied override and omits operation_id', async () => {
    const created = overrideView('user_self', DEALS, null, { denied: true }, { written_at: 2 });
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
      runListOverrides: async () => {
        listCall += 1;
        return { overrides: listCall === 1 ? [] : [created] };
      },
      runUpsertOverride: async ({ actor, ingredient_id, operation_id, policy }) =>
        overrideView(actor, ingredient_id, operation_id ?? null, policy, { written_at: 2 }),
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    mount.setCreateField('actor', 'user_self');
    mount.setCreateField('ingredient_id', DEALS);
    mount.setCreateField('denied', true);

    await mount.submitCreate();

    expect(calls.runUpsertOverride).toHaveBeenCalledTimes(1);
    const args = calls.runUpsertOverride.mock.calls[0]![0];
    expect(args).toEqual({
      actor: 'user_self',
      ingredient_id: DEALS,
      policy: { denied: true },
    });
    expect(args).not.toHaveProperty('operation_id');
    expect(rowFor(host, 'user_self', DEALS, null)).toBeDefined();
    expect(mount.getCreateError()).toBeNull();
    mount.dispose();
  });

  it('submits a specific operation override', async () => {
    const created = overrideView(
      'contracted_user',
      DEALS,
      DEALS_WRITE,
      { approval: 'ask' },
      { written_at: 2 },
    );
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
      runListOverrides: async () => {
        listCall += 1;
        return { overrides: listCall === 1 ? [] : [created] };
      },
      runUpsertOverride: async ({ actor, ingredient_id, operation_id, policy }) =>
        overrideView(actor, ingredient_id, operation_id ?? null, policy, { written_at: 2 }),
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    mount.setCreateField('actor', 'contracted_user');
    mount.setCreateField('ingredient_id', DEALS);
    mount.setCreateField('operation_id', DEALS_WRITE);
    mount.setCreateField('approval', 'ask');

    await mount.submitCreate();

    expect(calls.runUpsertOverride).toHaveBeenCalledTimes(1);
    expect(calls.runUpsertOverride.mock.calls[0]![0]).toEqual({
      actor: 'contracted_user',
      ingredient_id: DEALS,
      operation_id: DEALS_WRITE,
      policy: { approval: 'ask' },
    });
    expect(rowFor(host, 'contracted_user', DEALS, DEALS_WRITE)).toBeDefined();
    mount.dispose();
  });

  it('guards against submitting an empty policy', async () => {
    const { host, mount, calls } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    mount.setCreateField('actor', 'user_self');
    mount.setCreateField('ingredient_id', DEALS);

    await mount.submitCreate();

    expect(mount.getCreateError()).toBe(
      'Set at least one restriction (deny, approval, or max risk without approval).',
    );
    expect(collectByAttr(host, PERMISSIONS_CREATE_ERROR_ATTR)[0]!.textContent).toBe(
      'Set at least one restriction (deny, approval, or max risk without approval).',
    );
    expect(calls.runUpsertOverride).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('requires both actor and ingredient before upserting', async () => {
    const { mount, calls } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    mount.setCreateField('ingredient_id', DEALS);
    mount.setCreateField('denied', true);

    await mount.submitCreate();

    expect(mount.getCreateError()).toBe('Choose an actor to restrict.');

    mount.setCreateField('actor', 'user_self');
    mount.setCreateField('ingredient_id', '');

    await mount.submitCreate();

    expect(mount.getCreateError()).toBe('Choose an ingredient.');
    expect(calls.runUpsertOverride).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('surfaces contract_write_loosens rejections without clearing the draft', async () => {
    const { host, mount, calls } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
      runUpsertOverride: async () => {
        throw {
          code: 'contract_write_loosens',
          message: 'loosened policy',
          details: { loosened_fields: ['approval', 'max_risk_without_approval'] },
        };
      },
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    mount.setCreateField('actor', 'user_self');
    mount.setCreateField('ingredient_id', DEALS);
    mount.setCreateField('approval', 'always');

    await mount.submitCreate();

    expect(calls.runUpsertOverride).toHaveBeenCalledTimes(1);
    expect(mount.getCreateError()).toContain('can only tighten');
    expect(mount.getCreateError()).toContain('approval');
    expect(mount.getCreateError()).toContain('max_risk_without_approval');
    expect(selectedOptionValue(host, PERMISSIONS_CREATE_ACTOR_ATTR)).toBe('user_self');
    expect(selectedOptionValue(host, PERMISSIONS_CREATE_INGREDIENT_ATTR)).toBe(DEALS);
    expect(selectedOptionValue(host, PERMISSIONS_CREATE_APPROVAL_ATTR)).toBe('always');
    mount.dispose();
  });

  it('surfaces bad_request rejections as the server message', async () => {
    const { mount } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
      runUpsertOverride: async () => {
        throw {
          code: 'bad_request',
          message: 'operation is not available for that ingredient',
          details: {},
        };
      },
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    mount.setCreateField('actor', 'user_self');
    mount.setCreateField('ingredient_id', DEALS);
    mount.setCreateField('denied', true);

    await mount.submitCreate();

    expect(mount.getCreateError()).toBe('operation is not available for that ingredient');
    mount.dispose();
  });

  it('does not resurrect an override when a same-key delete wins the race', async () => {
    const row = overrideView('user_self', DEALS, DEALS_WRITE, { approval: 'ask' });
    const upsert = deferred<OverrideView>();
    let listCall = 0;
    const { host, mount, calls } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
      runListOverrides: async () => {
        listCall += 1;
        return { overrides: listCall === 1 ? [row] : [] };
      },
      runUpsertOverride: () => upsert.promise,
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeDefined();

    mount.setCreateField('actor', 'user_self');
    mount.setCreateField('ingredient_id', DEALS);
    mount.setCreateField('operation_id', DEALS_WRITE);
    mount.setCreateField('denied', true);
    const submit = mount.submitCreate();
    await tick();

    expect(calls.runUpsertOverride).toHaveBeenCalledTimes(1);

    await mount.deleteOverride(row.actor, row.ingredient_id, row.operation_id ?? undefined);
    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();

    upsert.resolve(row);
    await submit;
    await tick();

    expect(rowFor(host, 'user_self', DEALS, DEALS_WRITE)).toBeUndefined();
    expect(
      mount.getOverrides().some(
        (v) =>
          v.actor === row.actor
          && v.ingredient_id === row.ingredient_id
          && v.operation_id === row.operation_id,
      ),
    ).toBe(false);
    mount.dispose();
  });

  it('keeps the optimistic create when the post-create re-list fails', async () => {
    const created = overrideView('contracted_user', CONTACTS, null, {
      max_risk_without_approval: 'read',
    });
    let listCall = 0;
    const { host, mount } = mountFor({
      withCreate: true,
      catalog: catalogFixture(),
      runListOverrides: async () => {
        listCall += 1;
        if (listCall === 1) return { overrides: [] };
        throw new Error('post-create list down');
      },
      runUpsertOverride: async () => created,
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();
    mount.setCreateField('actor', 'contracted_user');
    mount.setCreateField('ingredient_id', CONTACTS);
    mount.setCreateField('max_risk_without_approval', 'read');

    await mount.submitCreate();

    expect(rowFor(host, 'contracted_user', CONTACTS, null)).toBeDefined();
    expect(mount.getOverrides()).toEqual([created]);
    expect(mount.getCreateError()).toBeNull();
    expect(collectByAttr(host, PERMISSIONS_PANEL_ERROR_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, PERMISSIONS_PANEL_ERROR_ATTR)[0]!.textContent).toContain(
      'post-create list down',
    );
    mount.dispose();
  });

  it('disables the ingredient picker when the catalog load fails', async () => {
    const { host, mount, calls } = mountFor({
      withCreate: true,
      runListCatalogOperations: async () => {
        throw new Error('catalog down');
      },
    });

    await mount.whenLoaded();
    await mount.whenCatalogLoaded();

    expect(onlyByAttr(host, PERMISSIONS_CREATE_INGREDIENT_ATTR).getAttribute('disabled')).toBe('');
    expect(mount.getCatalog()).toEqual([]);

    mount.setCreateField('actor', 'user_self');
    mount.setCreateField('denied', true);
    await mount.submitCreate();

    expect(mount.getCreateError()).toBe('Choose an ingredient.');
    expect(calls.runUpsertOverride).not.toHaveBeenCalled();
    mount.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// D-171 slice-2c follow-on #2 — inbound-token broadcast subscription
// ════════════════════════════════════════════════════════════════

type AnyBroadcastListener = (event: ServerEvent) => void;

interface FakeSubscribeCall {
  kind: BroadcastEventKind;
  listener: AnyBroadcastListener;
  unsubscribeCalls: number;
}

/** A `BroadcastSubscriber['on']` fake (mirrors the packs-panel broadcast test):
 *  records each registration, fans `dispatch`/`fireStored` to live listeners, and
 *  tracks unsubscribe counts. `throwOnUnsubscribe` exercises the swallow-on-
 *  teardown path. */
const makeFakeSubscribe = (opts: { throwOnUnsubscribe?: boolean } = {}) => {
  const calls: FakeSubscribeCall[] = [];
  const listeners = new Map<BroadcastEventKind, Set<AnyBroadcastListener>>();
  const subscribe = (<K extends BroadcastEventKind>(
    kind: K,
    listener: BroadcastListener<K>,
  ): (() => void) => {
    const narrowed = listener as unknown as AnyBroadcastListener;
    const call: FakeSubscribeCall = { kind, listener: narrowed, unsubscribeCalls: 0 };
    calls.push(call);
    const set = listeners.get(kind) ?? new Set<AnyBroadcastListener>();
    set.add(narrowed);
    listeners.set(kind, set);
    return () => {
      call.unsubscribeCalls += 1;
      set.delete(narrowed);
      if (set.size === 0) listeners.delete(kind);
      if (opts.throwOnUnsubscribe) throw new Error(`unsubscribe failed for ${kind}`);
    };
  }) as BroadcastSubscriber['on'];
  const activeCount = (): number => {
    let total = 0;
    for (const set of listeners.values()) total += set.size;
    return total;
  };
  // Fire only to currently-registered listeners (drops after dispose).
  const dispatch = (event: ServerEvent): void => {
    const set = listeners.get(event.kind);
    if (!set) return;
    for (const listener of [...set]) listener(event);
  };
  // Fire to the ORIGINAL captured listener even if unsubscribed — exercises the
  // panel's own post-dispose `disposed` guard.
  const fireStored = (event: ServerEvent): void => {
    for (const call of calls) if (call.kind === event.kind) call.listener(event);
  };
  return { subscribe, calls, listeners, activeCount, dispatch, fireStored };
};

type InboundTokenOp = 'issue' | 'update_grants' | 'update_contract' | 'revoke' | 'delete';

const inboundTokenChangedEvent = (
  op: InboundTokenOp,
  cursor = 1,
): Extract<ServerEvent, { kind: 'chat.inbound_token_changed' }> => ({
  kind: 'chat.inbound_token_changed',
  op,
  token_id: 'door_live',
  record: null,
  cursor,
});

/** D-171 — the authoritative `contract_definition` lifecycle event the door's
 *  Advanced sub-panel re-lists off (replacing the token proxy). */
const contractDefinitionChangedEvent = (
  op: 'mint' | 'revoke',
  contract_id = 'ct_remote',
  cursor = 1,
): Extract<ServerEvent, { kind: 'contract.contract_definition_changed' }> => ({
  kind: 'contract.contract_definition_changed',
  op,
  contract_id,
  cursor,
});

/** Wire a mount with the door's lifecycle trio + (optionally) the full Advanced
 *  contract set, sharing one token + contract store so the broadcast re-lists hit
 *  the same `vi.fn`s the assertions count. */
const mountDoorWithSubscribe = (
  subscribe: BroadcastSubscriber['on'],
  withAdvanced: boolean,
) => {
  const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
  const contracts = makeFakeContractStore([]);
  const { mount } = mountFor({
    runListInboundTokens: store.list,
    runIssueInboundToken: store.issue,
    runRevokeInboundToken: store.revoke,
    ...(withAdvanced
      ? {
          runUpdateInboundToken: store.update,
          runListToolCatalog: async () => ({ catalog: [] }),
          runMintContract: contracts.mint,
          runRevokeContract: contracts.revoke,
          runListContracts: contracts.list,
          runUpdateInboundContract: store.updateContract,
        }
      : {}),
    subscribe,
  });
  return { mount, store, contracts };
};

describe('D-171 slice-2c follow-on #2 — inbound-token broadcast subscription', () => {
  it('WEBCLIENT_DEFAULT_SUBSCRIPTIONS includes both the token and the D-171 contract kind', () => {
    // Load-bearing: the server fans only the kinds each client names (D-169 TR-10),
    // so without these entries the panel's listeners would never fire. The token
    // kind drives the door/grant/chat state; the contract kind (D-171) drives the
    // Advanced cap/expiry summary + the Contracts inspector.
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain('chat.inbound_token_changed');
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain('contract.contract_definition_changed');
  });

  it('subscribes to chat.inbound_token_changed on mount when the door + subscribe are wired', async () => {
    const fake = makeFakeSubscribe();
    const { mount } = mountDoorWithSubscribe(fake.subscribe, false);
    await mount.whenTokensLoaded();
    await tick();

    expect(fake.listeners.get('chat.inbound_token_changed')?.size).toBe(1);
    expect(fake.calls.map((c) => c.kind)).toEqual(['chat.inbound_token_changed']);
    mount.dispose();
  });

  it('subscribes to BOTH the token and contract kinds when the Advanced sub-panel is wired (D-171)', async () => {
    const fake = makeFakeSubscribe();
    const { mount } = mountDoorWithSubscribe(fake.subscribe, true);
    await mount.whenTokensLoaded();
    await mount.whenAdvancedLoaded();
    await tick();

    // Token kind drives door/grant/chat state; the D-171 contract kind drives the
    // Advanced cap/expiry refresh. Two distinct subscriptions.
    expect(fake.calls.map((c) => c.kind).sort()).toEqual([
      'chat.inbound_token_changed',
      'contract.contract_definition_changed',
    ]);
    expect(fake.activeCount()).toBe(2);

    // Both unsubscribe on dispose (no leaked listeners).
    mount.dispose();
    expect(fake.activeCount()).toBe(0);
    expect(fake.calls.map((c) => c.unsubscribeCalls)).toEqual([1, 1]);
  });

  it('does NOT subscribe when the door is not manageable (override editor only)', async () => {
    const fake = makeFakeSubscribe();
    const { mount } = mountFor({ subscribe: fake.subscribe });
    await mount.whenLoaded();
    await tick();

    expect(fake.activeCount()).toBe(0);
    expect(fake.calls).toHaveLength(0);
    mount.dispose();
  });

  it('re-lists tokens on token frames and contracts on contract frames (decoupled — D-171)', async () => {
    const fake = makeFakeSubscribe();
    const { mount, store, contracts } = mountDoorWithSubscribe(fake.subscribe, true);
    await mount.whenTokensLoaded();
    await mount.whenAdvancedLoaded();
    await tick();

    const tokens0 = store.list.mock.calls.length;
    const contracts0 = contracts.list.mock.calls.length;

    // D-171 — token frames ONLY re-list tokens; the contract refresh is decoupled
    // onto the dedicated `contract.contract_definition_changed` kind (dropping the
    // proxy). Every token op (issue / update_grants / update_contract / revoke /
    // delete) re-lists tokens, NEVER contracts.
    for (const op of ['update_grants', 'issue', 'update_contract', 'revoke', 'delete'] as const) {
      fake.dispatch(inboundTokenChangedEvent(op));
    }
    await tick();
    expect(store.list.mock.calls.length).toBe(tokens0 + 5);
    expect(contracts.list.mock.calls.length).toBe(contracts0);

    // Contract frames ONLY re-list contracts; tokens untouched.
    fake.dispatch(contractDefinitionChangedEvent('mint'));
    await tick();
    expect(contracts.list.mock.calls.length).toBe(contracts0 + 1);
    expect(store.list.mock.calls.length).toBe(tokens0 + 5);

    fake.dispatch(contractDefinitionChangedEvent('revoke'));
    await tick();
    expect(contracts.list.mock.calls.length).toBe(contracts0 + 2);
    expect(store.list.mock.calls.length).toBe(tokens0 + 5);

    mount.dispose();
  });

  it('re-lists tokens but never contracts when the Advanced sub-panel is unwired', async () => {
    const fake = makeFakeSubscribe();
    const { mount, store, contracts } = mountDoorWithSubscribe(fake.subscribe, false);
    await mount.whenTokensLoaded();
    await tick();
    const tokens0 = store.list.mock.calls.length;

    // Even a contract-touching op only re-lists tokens — the contract callers
    // aren't wired, so `doRefreshContracts` is a no-op (the list fn is untouched).
    fake.dispatch(inboundTokenChangedEvent('update_contract'));
    await tick();
    expect(store.list.mock.calls.length).toBe(tokens0 + 1);
    expect(contracts.list).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('seeds the Advanced draft from a REMOTE limit set (seed defers past the stale contract list)', async () => {
    const fake = makeFakeSubscribe();
    // Door open, token UNBOUND, empty contract store → Advanced reads "limits off".
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const contracts = makeFakeContractStore([]);
    const { mount, host } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
      runMintContract: contracts.mint,
      runRevokeContract: contracts.revoke,
      runListContracts: contracts.list,
      runUpdateInboundContract: store.updateContract,
      subscribe: fake.subscribe,
    });
    await mount.whenTokensLoaded();
    await mount.whenAdvancedLoaded();
    await tick();
    const capEnabled = (): string | null =>
      collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_CAP_TOGGLE_ATTR)[0]?.getAttribute(
        'data-enabled',
      ) ?? null;
    expect(capEnabled()).toBe('false');

    // Simulate ANOTHER client minting a capped contract + binding the door token
    // to it — BOTH backing stores change server-side. D-171 — the two changes now
    // arrive as TWO bus frames: the token `update_contract` (binding) and the
    // `contract.contract_definition_changed` mint. The token frame lands FIRST,
    // seeing the new `contract_id` against the still-stale (un-refreshed) contract
    // list → bound-but-unresolved.
    contracts.defs.unshift(
      contractView({ contract_id: 'ct_remote', max_uses: 25, uses_remaining: 25 }),
    );
    store.rows.find((r) => r.token_id === 'door_live')!.contract_id = 'ct_remote';
    fake.dispatch(inboundTokenChangedEvent('update_contract'));
    await tick(4);
    // The token re-list resolved the new `contract_id` against the stale contract
    // list. The seed DEFERS (bound-but-unresolved) instead of latching an empty
    // draft — the pre-fix seed latched "limits off", and a save from there would
    // clear the remote limit. Still unresolved until the contract frame refreshes.
    expect(mount.getMcpDoorBoundContract()).toBeNull();

    // The contract frame refreshes the list → the bound contract resolves + the
    // draft seeds ON.
    fake.dispatch(contractDefinitionChangedEvent('mint', 'ct_remote'));
    await tick(12);
    expect(mount.getMcpDoorBoundContract()?.contract_id).toBe('ct_remote');
    expect(capEnabled()).toBe('true');
    mount.dispose();
  });

  it('seeds correctly when a token-only update_grants races an in-flight update_contract', async () => {
    // Codex P2 (D-171 form): a contract `mint` frame starts an in-flight
    // doRefreshContracts; the token `update_contract` (binding) + a trailing
    // token-only `update_grants` then re-list tokens, resolving the new
    // `contract_id` against the still-in-flight (stale) contract list. The
    // seed-defer guard makes this safe regardless of which list lands first.
    const fake = makeFakeSubscribe();
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const contracts = makeFakeContractStore([]);
    const { mount, host } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
      runMintContract: contracts.mint,
      runRevokeContract: contracts.revoke,
      runListContracts: contracts.list,
      runUpdateInboundContract: store.updateContract,
      subscribe: fake.subscribe,
    });
    await mount.whenTokensLoaded();
    await mount.whenAdvancedLoaded();
    await tick();
    const capEnabled = (): string | null =>
      collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_CAP_TOGGLE_ATTR)[0]?.getAttribute(
        'data-enabled',
      ) ?? null;

    // Remote bind; hold the contract re-list so the token re-lists (from BOTH the
    // update_contract and the trailing update_grants) land FIRST against the stale
    // contract list.
    contracts.defs.unshift(
      contractView({ contract_id: 'ct_remote', max_uses: 40, uses_remaining: 40 }),
    );
    store.rows.find((r) => r.token_id === 'door_live')!.contract_id = 'ct_remote';
    const contractGate = deferred<void>();
    contracts.list.mockImplementation(async () => {
      await contractGate.promise;
      return { contracts: contracts.defs.map((d) => ({ ...d })) };
    });

    // The contract `mint` frame starts a doRefreshContracts we HOLD (gated), so it
    // stays in flight (contractsLoading) while the token re-lists land.
    fake.dispatch(contractDefinitionChangedEvent('mint', 'ct_remote'));
    await tick(2);
    fake.dispatch(inboundTokenChangedEvent('update_contract'));
    await tick(4); // token re-list lands (bound-but-unresolved → defers); contract held
    fake.dispatch(inboundTokenChangedEvent('update_grants'));
    await tick(4); // token-only re-list lands, still against the stale contract list
    // The draft is NOT latched empty — the editor is locked (transient-unresolved)
    // until the contract resolves, so the cap toggle isn't even rendered yet.
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_CAP_TOGGLE_ATTR)).toHaveLength(0);

    contractGate.resolve(); // release the contract re-list
    await tick(12);

    // The fresh contract resolves → the editor unlocks + the seed fires ON.
    expect(mount.getMcpDoorBoundContract()?.contract_id).toBe('ct_remote');
    expect(capEnabled()).toBe('true');
    mount.dispose();
  });

  it('locks the Advanced editor while a remote-bound contract is transiently unresolved', async () => {
    const fake = makeFakeSubscribe();
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const contracts = makeFakeContractStore([]);
    const { mount, host } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
      runMintContract: contracts.mint,
      runRevokeContract: contracts.revoke,
      runListContracts: contracts.list,
      runUpdateInboundContract: store.updateContract,
      subscribe: fake.subscribe,
    });
    await mount.whenTokensLoaded();
    await mount.whenAdvancedLoaded(); // initial contracts settle → contractDefs=[], not loading
    await tick();

    // Remote bind + HOLD the contract re-list so the bound contract stays
    // unresolved WHILE a refresh is in flight (the transient window).
    contracts.defs.unshift(
      contractView({ contract_id: 'ct_remote', max_uses: 10, uses_remaining: 10 }),
    );
    store.rows.find((r) => r.token_id === 'door_live')!.contract_id = 'ct_remote';
    const gate = deferred<void>();
    contracts.list.mockImplementation(async () => {
      await gate.promise;
      return { contracts: contracts.defs.map((d) => ({ ...d })) };
    });
    // The contract `mint` frame starts the (gated) doRefreshContracts so it is in
    // flight (contractsLoading) when the token binding lands → the transient lock.
    fake.dispatch(contractDefinitionChangedEvent('mint', 'ct_remote'));
    await tick(2);
    fake.dispatch(inboundTokenChangedEvent('update_contract'));
    await tick(); // token re-list lands (bound-but-unresolved + contractsLoading)

    // LOCKED: no Save, no toggles, summary reads "resolving".
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_SAVE_ATTR)).toHaveLength(0);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_CAP_TOGGLE_ATTR)).toHaveLength(0);
    const summary = collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_SUMMARY_ATTR)[0];
    expect(summary?.getAttribute('data-state')).toBe('unresolved');
    expect(summary?.textContent).toContain('resolving');
    // A programmatic save is refused in this window (belt-and-suspenders) — it must
    // NOT clear the peer's just-bound limit.
    await mount.submitMcpDoorLimits();
    expect(contracts.mint).not.toHaveBeenCalled();
    expect(store.updateContract).not.toHaveBeenCalled();

    // Release the contract re-list → the editor unlocks with the bound cap.
    gate.resolve();
    await mount.whenAdvancedLoaded();
    await tick();
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_SAVE_ATTR)).toHaveLength(1);
    expect(
      collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_CAP_TOGGLE_ATTR)[0]?.getAttribute(
        'data-enabled',
      ),
    ).toBe('true');
    mount.dispose();
  });

  it('does not reveal the stale one-time bearer after a remote revoke + re-open', async () => {
    const fake = makeFakeSubscribe();
    // Door starts CLOSED so THIS session opens it + captures the one-time bearer.
    const store = makeFakeTokenStore([]);
    const { mount, host } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      subscribe: fake.subscribe,
    });
    await mount.whenTokensLoaded();
    await tick();

    await mount.enableMcpDoor();
    await tick();
    expect(mount.getMcpDoorOpen()).toBe(true);
    expect(mount.getMcpDoorTokenPlaintext()).toBe('recued_test_1');
    // The reveal panel paints the plaintext + a Copy button for the active token.
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_TOKEN_COPY_ATTR)).toHaveLength(1);

    // Simulate ANOTHER paired client revoking that token + re-opening the door
    // with a FRESH token this session never saw the secret of, then the live
    // `issue` broadcast arriving.
    store.rows.find((r) => r.token_id === 'issued_1')!.revoked_at = 555;
    store.rows.unshift(tokenRecord({ token_id: 'door_remote' }));
    fake.dispatch(inboundTokenChangedEvent('issue'));
    await tick();

    // The door reads open again (the remote token), but the stale prior bearer is
    // NOT painted or copyable — the panel falls back to the "shown once" note.
    expect(mount.getMcpDoorOpen()).toBe(true);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_TOKEN_COPY_ATTR)).toHaveLength(0);
    for (const el of collectByAttr(host, PERMISSIONS_MCP_DOOR_TOKEN_VALUE_ATTR)) {
      expect(el.textContent).not.toBe('recued_test_1');
    }
    mount.dispose();
  });

  it('disarms an armed disable-confirm when the door token is replaced remotely', async () => {
    const fake = makeFakeSubscribe();
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const { mount, host } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      subscribe: fake.subscribe,
    });
    await mount.whenTokensLoaded();
    await tick();

    // Arm the two-stage disable confirm on the current token.
    onlyByAttr(host, PERMISSIONS_MCP_DOOR_DISABLE_ATTR).click();
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_DISABLE_CONFIRM_ATTR)).toHaveLength(1);

    // Another client revokes + re-opens the door with a fresh token.
    store.rows.find((r) => r.token_id === 'door_live')!.revoked_at = 777;
    store.rows.unshift(tokenRecord({ token_id: 'door_remote' }));
    fake.dispatch(inboundTokenChangedEvent('issue'));
    await tick();

    // The door is open again (fresh token), but the confirm is disarmed — a click
    // can no longer revoke the new token without re-arming for it.
    expect(mount.getMcpDoorOpen()).toBe(true);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_DISABLE_CONFIRM_ATTR)).toHaveLength(0);
    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_DISABLE_ATTR)).toHaveLength(1);
    mount.dispose();
  });

  it('resets a mid-edit Advanced draft when the door token is replaced remotely', async () => {
    const fake = makeFakeSubscribe();
    // Door open, UNBOUND token, empty contracts → both old + new tokens share the
    // '<<unbound>>' seed key, so only the active-token-identity reset clears it.
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const contracts = makeFakeContractStore([]);
    const { mount, host } = mountFor({
      runListInboundTokens: store.list,
      runIssueInboundToken: store.issue,
      runRevokeInboundToken: store.revoke,
      runUpdateInboundToken: store.update,
      runMintContract: contracts.mint,
      runRevokeContract: contracts.revoke,
      runListContracts: contracts.list,
      runUpdateInboundContract: store.updateContract,
      subscribe: fake.subscribe,
    });
    await mount.whenTokensLoaded();
    await mount.whenAdvancedLoaded();
    await tick();
    const capEnabled = (): string | null =>
      collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_CAP_TOGGLE_ATTR)[0]?.getAttribute(
        'data-enabled',
      ) ?? null;
    expect(capEnabled()).toBe('false');

    // Dirty the draft (typed, unsaved).
    mount.setAdvancedField('capEnabled', true);
    mount.setAdvancedField('maxUses', '99');
    await tick();
    expect(capEnabled()).toBe('true');

    // Another client revokes + re-opens with a fresh (also unbound) token.
    store.rows.find((r) => r.token_id === 'door_live')!.revoked_at = 777;
    store.rows.unshift(tokenRecord({ token_id: 'door_remote' }));
    fake.dispatch(inboundTokenChangedEvent('issue'));
    await tick();

    // The fresh token is unbound → the draft re-seeds to empty, not the stale edit
    // (which a save would otherwise apply to the new token).
    expect(mount.getMcpDoorOpen()).toBe(true);
    expect(capEnabled()).toBe('false');
    mount.dispose();
  });

  it('dispose unsubscribes the broadcast handle', async () => {
    const fake = makeFakeSubscribe();
    const { mount } = mountDoorWithSubscribe(fake.subscribe, false);
    await mount.whenTokensLoaded();

    mount.dispose();

    expect(fake.activeCount()).toBe(0);
    expect(fake.calls.map((c) => c.unsubscribeCalls)).toEqual([1]);
  });

  it('does not re-list after dispose when a stored listener still fires', async () => {
    const fake = makeFakeSubscribe();
    const { mount, store } = mountDoorWithSubscribe(fake.subscribe, false);
    await mount.whenTokensLoaded();
    await tick();
    const tokens0 = store.list.mock.calls.length;

    mount.dispose();
    fake.fireStored(inboundTokenChangedEvent('update_contract'));
    await tick();

    expect(store.list.mock.calls.length).toBe(tokens0);
  });

  it('dispose completes when the unsubscribe handle throws', async () => {
    const fake = makeFakeSubscribe({ throwOnUnsubscribe: true });
    const { mount } = mountDoorWithSubscribe(fake.subscribe, false);
    await mount.whenTokensLoaded();

    expect(() => mount.dispose()).not.toThrow();
    expect(fake.activeCount()).toBe(0);
    expect(fake.calls.map((c) => c.unsubscribeCalls)).toEqual([1]);
  });

});

// ════════════════════════════════════════════════════════════════
// D-174 delta 2 — the agent-credential (mcp-door) panel is re-homed into the
// Contracts route's Connect tab. These pin the route→panel FORWARDING: a panel
// unit test can't catch a forwarding regression in `bootstrapContractsRoute`,
// so each mounts a real agent DETAIL (Connect tab default-active) and drives
// the panel through `route.permissionsPanel()`. (Adapted from the inline-frame
// forwarding tests removed when delta 1 made the route list→detail.)
// ════════════════════════════════════════════════════════════════

describe('D-174 contracts route — Connect-tab agent-credential forwarding', () => {
  const requiredDoorCallers = (
    store = makeFakeTokenStore([]),
  ): Pick<
    BootstrapContractsRouteOptions,
    | 'permissionsListInboundTokensCaller'
    | 'permissionsIssueInboundTokenCaller'
    | 'permissionsRevokeInboundTokenCaller'
  > => ({
    permissionsListInboundTokensCaller: store.list,
    permissionsIssueInboundTokenCaller: store.issue,
    permissionsRevokeInboundTokenCaller: store.revoke,
  });

  /** Mount the route straight into an agent's DETAIL (Connect tab is the agent's
   *  first/default tab), with a single `door_alpha` agent in the list. */
  const mountAgentConnect = (extra: Partial<BootstrapContractsRouteOptions> = {}) => {
    const doc = makeFakeDocument();
    const host = doc.createElement('div');
    const route = bootstrapContractsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      serverUrl: 'wss://alice.example/ws',
      contractsListCaller: vi.fn(async () => ({
        contracts: [contractView({ contract_id: 'door_alpha', display_name: 'Alpha agent' })],
      })),
      initialContractId: 'door_alpha',
      ...extra,
    });
    return { doc, host, route };
  };

  it('mounts the panel in the Connect tab on the door trio; degrades to a note when one is missing', async () => {
    const { host, route } = mountAgentConnect({ ...requiredDoorCallers() });
    await route.whenLoaded();
    expect(route.permissionsPanel()).not.toBeNull();
    expect(collectByAttr(host, CONTRACTS_ROUTE_CONNECT_HOST_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, PERMISSIONS_PANEL_HOST_ATTR)).toHaveLength(1);
    await route.permissionsPanel()!.whenTokensLoaded();
    route.dispose();

    const omitted = [
      'permissionsListInboundTokensCaller',
      'permissionsIssueInboundTokenCaller',
      'permissionsRevokeInboundTokenCaller',
    ] as const;
    for (const missing of omitted) {
      const callers = requiredDoorCallers();
      delete callers[missing];
      const each = mountAgentConnect({ ...callers });
      await each.route.whenLoaded();
      expect(each.route.permissionsPanel()).toBeNull();
      expect(collectByAttr(each.host, CONTRACTS_ROUTE_UNAVAILABLE_ATTR)).toHaveLength(1);
      each.route.dispose();
    }
  });

  it('forwards the update caller — the Chat row renders + toggles to update_grants (chat_mode only)', async () => {
    const store = makeFakeTokenStore([
      tokenRecord({ token_id: 'door_live', grants: { 'mail.search': true } }),
    ]);
    const { host, route } = mountAgentConnect({
      ...requiredPermissionsCallers(),
      ...requiredDoorCallers(store),
      permissionsUpdateInboundTokenCaller: store.update,
    });
    await route.whenLoaded();
    const panel = route.permissionsPanel();
    expect(panel).not.toBeNull();
    await panel!.whenLoaded();
    await panel!.whenTokensLoaded();

    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_CHAT_ROW_ATTR)).toHaveLength(1);
    await panel!.setMcpDoorChat(true);
    expect(store.update).toHaveBeenCalledTimes(1);
    const arg = store.update.mock.calls[0]![0];
    expect(arg.token_id).toBe('door_live');
    expect(arg.chat_mode).toEqual({ offered: true });
    expect(arg).not.toHaveProperty('grants');
    route.dispose();
  });

  it('forwards the catalog caller — the grant checklist renders + toggles to update_grants (grants only)', async () => {
    const store = makeFakeTokenStore([
      tokenRecord({ token_id: 'door_live', chat_mode: { offered: true } }),
    ]);
    const { host, route } = mountAgentConnect({
      ...requiredPermissionsCallers(),
      ...requiredDoorCallers(store),
      permissionsUpdateInboundTokenCaller: store.update,
      permissionsToolCatalogCaller: toolCatalogCaller(),
    });
    await route.whenLoaded();
    const panel = route.permissionsPanel();
    expect(panel).not.toBeNull();
    await panel!.whenLoaded();
    await panel!.whenTokensLoaded();
    await panel!.whenToolCatalogLoaded();

    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_GRANTS_ATTR)).toHaveLength(1);
    await panel!.setMcpDoorToolGrant('mail.search', true);
    expect(store.update).toHaveBeenCalledTimes(1);
    const arg = store.update.mock.calls[0]![0];
    expect(arg.token_id).toBe('door_live');
    expect(arg.grants).toEqual({ 'mail.search': true });
    expect(arg).not.toHaveProperty('chat_mode');
    route.dispose();
  });

  it('forwards the four contract callers — the Advanced sub-panel mints {channels:[mcp]} + rebinds', async () => {
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const contracts = makeFakeContractStore([]);
    const { host, route } = mountAgentConnect({
      ...requiredPermissionsCallers(),
      ...requiredDoorCallers(store),
      permissionsUpdateInboundTokenCaller: store.update,
      permissionsMintContractCaller: contracts.mint,
      permissionsRevokeContractCaller: contracts.revoke,
      permissionsListContractsCaller: contracts.list,
      permissionsUpdateInboundContractCaller: store.updateContract,
    });
    await route.whenLoaded();
    const panel = route.permissionsPanel();
    expect(panel).not.toBeNull();
    await panel!.whenLoaded();
    await panel!.whenTokensLoaded();
    await panel!.whenAdvancedLoaded();
    await tick();

    expect(collectByAttr(host, PERMISSIONS_MCP_DOOR_ADVANCED_ATTR)).toHaveLength(1);
    panel!.setAdvancedField('capEnabled', true);
    panel!.setAdvancedField('maxUses', '50');
    await panel!.submitMcpDoorLimits();
    await tick();

    expect(contracts.mint).toHaveBeenCalledTimes(1);
    expect(contracts.mint.mock.calls[0]![0].scope).toEqual({ channels: ['mcp'] });
    expect(contracts.mint.mock.calls[0]![0].max_uses).toBe(50);
    expect(store.updateContract).toHaveBeenCalledTimes(1);
    expect(store.updateContract.mock.calls[0]![0].token_id).toBe('door_live');
    route.dispose();
  });

  it('forwards `subscribe` — the door live-syncs on token + contract bus frames', async () => {
    const fake = makeFakeSubscribe();
    const store = makeFakeTokenStore([tokenRecord({ token_id: 'door_live' })]);
    const contracts = makeFakeContractStore([]);
    const { route } = mountAgentConnect({
      ...requiredPermissionsCallers(),
      ...requiredDoorCallers(store),
      permissionsUpdateInboundTokenCaller: store.update,
      permissionsMintContractCaller: contracts.mint,
      permissionsRevokeContractCaller: contracts.revoke,
      permissionsListContractsCaller: contracts.list,
      permissionsUpdateInboundContractCaller: store.updateContract,
      subscribe: fake.subscribe,
    });
    await route.whenLoaded();
    const panel = route.permissionsPanel();
    expect(panel).not.toBeNull();
    await panel!.whenTokensLoaded();
    await panel!.whenAdvancedLoaded();
    await tick();

    expect(fake.listeners.get('chat.inbound_token_changed')?.size).toBe(1);
    expect(fake.listeners.get('contract.contract_definition_changed')?.size).toBe(1);
    const tokens0 = store.list.mock.calls.length;
    const contracts0 = contracts.list.mock.calls.length;

    fake.dispatch(inboundTokenChangedEvent('update_contract'));
    await tick();
    expect(store.list.mock.calls.length).toBe(tokens0 + 1);
    expect(contracts.list.mock.calls.length).toBe(contracts0);

    fake.dispatch(contractDefinitionChangedEvent('mint'));
    await tick();
    expect(contracts.list.mock.calls.length).toBe(contracts0 + 1);
    route.dispose();
  });
});
