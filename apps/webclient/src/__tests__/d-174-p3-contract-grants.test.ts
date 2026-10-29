/** D-174 delta 3 — the single-contract grant view (Ops + Entities) + the
 *  detail-header L1 controls (door toggle + Revoke).
 *
 *  Panel: the universe join split across the two tabs (ops → `opsRoot`,
 *  collections + topics → `entitiesRoot`); the `effective` derivation + the
 *  owner-only sensitive-surface adjustment; the write-then-reconcile toggle; the
 *  Access-only row / source marker; the "N of M granted" summary; graceful
 *  degrade; dispose. Route: the Ops/Entities tabs mounting the kept-alive panel;
 *  self = same tabs via `grant.read` with no Connect/door/Revoke; the header
 *  door toggle (`setDoorTypes`) + the 2-stage Revoke, both re-rendering the
 *  header in place without tearing the tab bodies down.
 *
 *  Fake-DOM harness mirrors the grant-matrix (d-187) + contracts-route (d-174
 *  p2) panel tests. */

import { describe, expect, it, vi } from 'vitest';

import {
  CONTRACT_GRANTS_ALSO_READS_ATTR,
  CONTRACT_GRANTS_ASKS_ATTR,
  CONTRACT_GRANTS_AXIS_NOTE_ATTR,
  CONTRACT_GRANTS_CELL_ATTR,
  CONTRACT_GRANTS_STILL_USED_ATTR,
  CONTRACT_GRANTS_CELL_TOGGLE_ATTR,
  CONTRACT_GRANTS_EMPTY_ATTR,
  CONTRACT_GRANTS_ERROR_ATTR,
  CONTRACT_GRANTS_HOST_ATTR,
  CONTRACT_GRANTS_KIND_GROUP_ATTR,
  CONTRACT_GRANTS_OP_FILTER_ATTR,
  CONTRACT_GRANTS_OP_FILTER_STATUS_ATTR,
  CONTRACT_GRANTS_PEER_LABEL_ADD_ATTR,
  CONTRACT_GRANTS_PEER_LABEL_INPUT_ATTR,
  CONTRACT_GRANTS_PANEL_STYLES,
  CONTRACT_GRANTS_RISK_ATTR,
  CONTRACT_GRANTS_SOURCE_ATTR,
  CONTRACT_GRANTS_SUMMARY_ATTR,
  CONTRACT_GRANTS_AI_TOOLS_GROUP,
  CONTRACT_GRANTS_AI_TOOLS_NOTE,
  CONTRACT_GRANTS_OLDER_KEY_NOTE,
  CONTRACT_GRANTS_OLDER_KEY_NOTE_ATTR,
  CONTRACT_GRANTS_AI_TOOLS_NOTE_ATTR,
  CONTRACT_GRANTS_NEED_ATTR,
  CONTRACT_GRANTS_NEEDS_ATTR,
  CONTRACT_GRANTS_TITLE_ATTR,
  mountContractGrantsPanel,
  type GrantCatalogOperationsCaller,
  type GrantReadCaller,
  type GrantRegistryDescribeCaller,
  type GrantWriteCaller,
} from '../contracts/contract-grants-panel.js';
import {
  CONTRACT_KEY_CONFIRM_ATTR,
  CONTRACT_KEY_CREATE_ATTR,
  CONTRACT_KEY_TURN_OFF_ATTR,
  CONTRACT_KEY_VALUE_ATTR,
} from '../contracts/contract-key-panel.js';
import { PERMISSIONS_PANEL_HOST_ATTR } from '../settings/permissions-panel.js';
import {
  bootstrapContractsRoute,
  CONTRACTS_ROUTE_LIMITS_CANCEL_ATTR,
  CONTRACTS_ROUTE_LIMITS_CAP_ATTR,
  CONTRACTS_ROUTE_LIMITS_EDIT_ATTR,
  CONTRACTS_ROUTE_LIMITS_ERROR_ATTR,
  CONTRACTS_ROUTE_LIMITS_FORM_ATTR,
  CONTRACTS_ROUTE_LIMITS_PERIOD_ATTR,
  CONTRACTS_ROUTE_LIMITS_SAVE_ATTR,
  CONTRACTS_ROUTE_RULES_ATTR,
  CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR,
  CONTRACTS_ROUTE_HEAD_ERROR_ATTR,
  CONTRACTS_ROUTE_PILL_ATTR,
  CONTRACTS_ROUTE_REVOKE_ATTR,
  CONTRACTS_ROUTE_REVOKE_CANCEL_ATTR,
  CONTRACTS_ROUTE_REVOKE_CONFIRM_ATTR,
  CONTRACTS_ROUTE_TAB_ATTR,
  CONTRACTS_ROUTE_TAB_BODY_ATTR,
  type ContractsListTab,
} from '../contracts/bootstrap-contracts-route.js';
import {
  KERNEL_OP_GUIDE,
  KERNEL_OP_REGISTRY,
  OWNER_CONTRACT_ID,
  READABLE_COLLECTIONS,
  TIER1_TOOL_NAMES,
  collectionGrantEntry,
  opGrantEntry,
  peerLabelGrantEntry,
  primitiveGrantEntry,
  topicGrantEntry,
  type CatalogIngredientView,
  type ContractDefinitionView,
  type DoorType,
  type McpInboundTokenRecord,
  type SetContractLimitsRequest,
  type RegistryDescribeRpcOutput,
  type RegistryDescribeTopicEntry,
} from '@recued/contracts';

// ── Fake DOM (checkbox-aware, with `head` + a generic `dispatch`) ──────

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  /** Hover copy. Declared because the approval chip's TITLE is the sentence doing
   *  the teaching — the chip text alone is 'asks' / 'silent'. Without it here the
   *  panel could stop wiring `approval.title` and only the pure-function test would
   *  still pass, which proves the copy EXISTS, not that a user ever sees it. */
  title: string;
  type: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  readonly firstChild: FakeEl | null;
  readonly parentNode: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  querySelector(selector: string): FakeEl | null;
  remove(): void;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  focus(): void;
  click(): void;
  dispatch(type: string): void;
}

const makeFakeEl = (
  tag: string,
  onFocus?: (el: FakeEl) => void,
): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    title: '',
    type: '',
    value: '',
    checked: false,
    disabled: false,
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    get parentNode() {
      return el.parent;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
      if (k === 'type') el.type = v;
      if (k === 'disabled') el.disabled = true;
      if (k === 'value') el.value = v;
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i < 0) throw new Error('removeChild: not a child');
      el.children.splice(i, 1);
      c.parent = null;
      return c;
    },
    querySelector(selector) {
      const match = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (match === null) return null;
      const [, attr, value] = match;
      const find = (node: FakeEl): FakeEl | null => {
        if (
          node.hasAttribute(attr!)
          && (value === undefined || node.getAttribute(attr!) === value)
        ) return node;
        for (const child of node.children) {
          const found = find(child);
          if (found !== null) return found;
        }
        return null;
      };
      return find(el);
    },
    remove() {
      if (el.parent === null) return;
      const i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    focus() {
      onFocus?.(el);
    },
    click() {
      if (el.disabled || el.attrs.has('disabled')) return;
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
    dispatch(type) {
      if (el.disabled || el.attrs.has('disabled')) return;
      for (const fn of el.listeners.get(type) ?? []) fn({ target: el });
    },
  };
  return el;
};

interface FakeDoc {
  styleElements: FakeEl[];
  activeElement: FakeEl | null;
  head: { querySelector(sel: string): FakeEl | null; appendChild(el: FakeEl): FakeEl };
  createElement(tag: string): FakeEl;
}

const makeFakeDocument = (): FakeDoc => {
  const styleElements: FakeEl[] = [];
  const matchSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  const doc: FakeDoc = {
    styleElements,
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
  };
  return doc;
};

const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const child of root.children) collectByAttr(child, attr, out);
  return out;
};
const allText = (root: FakeEl): string =>
  [root.textContent, ...root.children.map((c) => allText(c))].join(' ');
const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ── Fixtures ───────────────────────────────────────────────────────────

const READ_OP = 'recued-core/hubspot.deal.read';
const WRITE_OP = 'recued-core/hubspot.deal.create';
const PUBLIC_TOPIC = 'thread_signals';
const PRIVATE_TOPIC = 'transcript';
/** Raw incoming collections are owner-only by default. */
const OWNER_ONLY_COLLECTIONS = [
  collectionGrantEntry('webhook'),
  collectionGrantEntry('form_response'),
  // D-325 P17 — the owner's episodes and occasions, read through the situation query.
  'data.episode',
  'data.occasion',
] as const;

const KERNEL_OP_COUNT = KERNEL_OP_REGISTRY.length;
/** D-228 slice 5 — the Tier-1 chat primitives are a COMPILED-IN op slice, like
 *  the kernel registry: present whether or not the dynamic catalog / registry
 *  callers resolve. Derived, never a literal — a primitive added later must move
 *  this count automatically or the assertion below stops meaning anything. */
const PRIMITIVE_OP_COUNT = TIER1_TOOL_NAMES.length;

const catalog: { ingredients: ReadonlyArray<CatalogIngredientView> } = {
  ingredients: [
    {
      ingredient_id: 'hubspot-catalog',
      name: 'HubSpot',
      operations: [
        { operation_id: READ_OP, operation_key: 'deal.read', risk_tier: 'read', groups: [] },
        { operation_id: WRITE_OP, operation_key: 'deal.create', risk_tier: 'write', groups: [] },
      ],
    },
  ],
};

// R22 GAP-B — a catalog with a `kind:'cli'` ingredient (its ops route to
// cli_reachability, not contract_grant) alongside a normal connection op. The
// cli op's MAP KEY (`operation_key`) deliberately DIFFERS from its qualified
// `operation_id` — cli_reachability rows key on the map key, so the panel must
// too (Codex GAP-B fold regression).
const CLI_INGREDIENT = 'zstd';
const CLI_OP = 'recued-core/zstd.file.compress';
const CLI_OP_KEY = 'file.compress';
const cliCatalog: { ingredients: ReadonlyArray<CatalogIngredientView> } = {
  ingredients: [
    {
      ingredient_id: 'hubspot-catalog',
      name: 'HubSpot',
      operations: [
        { operation_id: WRITE_OP, operation_key: 'deal.create', risk_tier: 'write', groups: [] },
      ],
    },
    {
      ingredient_id: CLI_INGREDIENT,
      name: 'zstd',
      kind: 'cli',
      operations: [
        { operation_id: CLI_OP, operation_key: CLI_OP_KEY, risk_tier: 'write', groups: [] },
      ],
    },
  ],
};

const topicEntry = (
  topic: string,
  mcp_exposed: 'public' | 'private',
): RegistryDescribeTopicEntry => ({
  topic,
  temporal_class: 'stable_truth',
  identity_aggregation: 'scenario',
  lifecycle_policy: 'forward_only',
  valid_scopes: [],
  compression_class: 'lossless',
  prompt_bias_hints: [],
  description: '',
  ai_surface: false,
  mcp_exposed,
  coverage: {
    row_count: 0,
    latest_event_at: null,
    producer_last_run_at: null,
    producer_failure_rate_24h: 0,
    ai_surface: false,
  },
  coverage_quality: 'high',
  coverage_quality_reasoning: '',
});

const registry: RegistryDescribeRpcOutput = {
  topics: [topicEntry(PUBLIC_TOPIC, 'public'), topicEntry(PRIVATE_TOPIC, 'private')],
  total_rows_visible: 0,
};

interface PanelOpts {
  contractId?: string;
  seed?: Record<string, boolean>;
  explicitGrantRowsOnly?: boolean;
  /** D-327 — an agreement that is its key's whole authority. */
  keyAgreement?: boolean;
  /** D-327 — an older app contract, whose key keeps the tools it was made with. */
  keyKeepsItsTools?: boolean;
  withCatalog?: boolean;
  withRegistry?: boolean;
  grantReadRejects?: boolean;
  writeGate?: Promise<void>;
  /** Override the catalog fixture (the cli tests pass one with a `kind:'cli'`
   *  ingredient without perturbing the shared `catalog`). */
  catalog?: { ingredients: ReadonlyArray<CatalogIngredientView> };
  /** Pre-granted cli_reachability rows (present ⇒ allowed). */
  cliSeed?: ReadonlyArray<{ principal: string; ingredient_id: string; operation_id: string }>;
  /** Omit the `cli.reachability.list` caller. */
  withCliList?: boolean;
  /** Omit the `cli.reachability.set` caller (cli ops render inert). */
  withCliSet?: boolean;
  operationFilterDebounceMs?: number;
  /** D-247 D11 — the op row's evidence. Absent ⇒ no caller is wired at all. */
  usage?: {
    operations: ReadonlyArray<{
      operation_id: string; could: readonly string[]; count: number; recipes: readonly string[];
    }>;
    window_days: number;
    oldest_scanned_at: number | null;
    underivable: readonly string[];
  };
  /** D-247 D11 — the caller is wired but REJECTS. */
  usageRejects?: boolean;
  /** D-247 — installed recipes for the grant universe. */
  recipes?: ReadonlyArray<{
    recipe_id: string; publisher_id: string;
    source: 'bundled' | 'pair-sync' | 'inline';
    recipe: { metadata?: { name?: string; description?: string } };
  }>;
}

const cliStoreKey = (
  principal: string,
  ingredientId: string,
  operationId: string,
): string => [principal, ingredientId, operationId].join('::');

const mountPanelWith = (opts: PanelOpts = {}) => {
  const store = new Map<string, boolean>();
  for (const [k, v] of Object.entries(opts.seed ?? {})) store.set(k, v);
  // cli_reachability store — present key ⇒ allowed (a revoke drops the row).
  const cliStore = new Set<string>();
  for (const r of opts.cliSeed ?? [])
    cliStore.add(cliStoreKey(r.principal, r.ingredient_id, r.operation_id));

  const runGrantRead: GrantReadCaller = vi.fn(async () => {
    if (opts.grantReadRejects) throw new Error('grant_read offline');
    return {
      grants: [...store.entries()].map(([entry_key, granted]) => ({
        entry_key,
        granted,
        set_at: 1,
      })),
    };
  });
  const runGrantWrite: GrantWriteCaller = vi.fn(async ({ entry_key, granted }) => {
    if (opts.writeGate) await opts.writeGate;
    if (granted === null) store.delete(entry_key);
    else store.set(entry_key, granted);
    return { ok: true as const, granted };
  });
  const runCatalogOperations: GrantCatalogOperationsCaller = vi.fn(
    async () => opts.catalog ?? catalog,
  );
  const runRegistryDescribe: GrantRegistryDescribeCaller = vi.fn(async () => registry);
  const runCliReachabilityList = vi.fn(async () => ({
    rows: [...cliStore].map((key) => {
      const [principal, ingredient_id, operation_id] = key.split('::');
      return {
        principal: principal!,
        ingredient_id: ingredient_id!,
        operation_id: operation_id!,
        allowed: true,
        set_at: 1,
      };
    }),
  }));
  const runCliReachabilitySet = vi.fn(
    async (args: {
      principal?: string;
      ingredient_id: string;
      operation_id: string;
      allowed: boolean;
    }) => {
      const principal = args.principal ?? 'user_self';
      const key = cliStoreKey(principal, args.ingredient_id, args.operation_id);
      if (args.allowed) cliStore.add(key);
      else cliStore.delete(key);
      return {
        principal,
        ingredient_id: args.ingredient_id,
        operation_id: args.operation_id,
        allowed: args.allowed,
        set_at: 1,
      };
    },
  );

  const runRecipeList = vi.fn(async () => ({ recipes: opts.recipes ?? [] }));
  const runRecipeOpUsage = vi.fn(async () => {
    if (opts.usageRejects) throw new Error('recipe op usage offline');
    return opts.usage!;
  });

  const doc = makeFakeDocument();
  const panel = mountContractGrantsPanel({
    document: doc as unknown as Document,
    contractId: opts.contractId ?? 'door_x',
    runGrantRead,
    runGrantWrite,
    ...(opts.explicitGrantRowsOnly === true ? { explicitGrantRowsOnly: true } : {}),
    ...(opts.keyAgreement === true ? { keyAgreement: true } : {}),
    ...(opts.keyKeepsItsTools === true ? { keyKeepsItsTools: true } : {}),
    ...(opts.withCatalog === false ? {} : { runCatalogOperations }),
    ...(opts.withRegistry === false ? {} : { runRegistryDescribe }),
    ...(opts.withCliList === false ? {} : { runCliReachabilityList }),
    ...(opts.withCliSet === false ? {} : { runCliReachabilitySet }),
    ...(opts.operationFilterDebounceMs !== undefined
      ? { operationFilterDebounceMs: opts.operationFilterDebounceMs }
      : {}),
    ...(opts.usage !== undefined || opts.usageRejects === true
      ? { runRecipeOpUsage }
      : {}),
    ...(opts.recipes !== undefined ? { runRecipeList } : {}),
  });
  return {
    panel,
    doc,
    store,
    cliStore,
    runGrantRead,
    runGrantWrite,
    runCatalogOperations,
    runRegistryDescribe,
    runCliReachabilityList,
    runCliReachabilitySet,
    runRecipeOpUsage,
  };
};

const opsRootEl = (panel: { opsRoot: HTMLElement }): FakeEl =>
  panel.opsRoot as unknown as FakeEl;
const entitiesRootEl = (panel: { entitiesRoot: HTMLElement }): FakeEl =>
  panel.entitiesRoot as unknown as FakeEl;
const cellFor = (root: FakeEl, entryKey: string): FakeEl | undefined =>
  collectByAttr(root, CONTRACT_GRANTS_CELL_ATTR).find(
    (c) => c.getAttribute('data-entry') === entryKey,
  );

// ════════════════════════════════════════════════════════════════
// Panel — universe + derivation
// ════════════════════════════════════════════════════════════════

describe('contract-grants panel — D-192 Slice 7 transitive-read disclosure', () => {
  // A Linear-shaped catalog: granting the write op transitively admits a
  // container read (the projector attaches `also_reads`).
  const READS_CATALOG: { ingredients: ReadonlyArray<CatalogIngredientView> } = {
    ingredients: [
      {
        ingredient_id: 'linear-catalog',
        name: 'Linear',
        operations: [
          { operation_id: READ_OP, operation_key: 'issue.search', risk_tier: 'read', groups: [] },
          {
            operation_id: WRITE_OP, operation_key: 'issue.create', risk_tier: 'write', groups: [],
            also_reads: [{ ref: 'team', list_op: 'team.search' }],
          },
        ],
      },
    ],
  };

  it('discloses "also reads: team" on the bound write op and nothing on a plain read op', async () => {
    const { panel } = mountPanelWith({ catalog: READS_CATALOG });
    await panel.whenLoaded();

    const writeCell = cellFor(opsRootEl(panel), WRITE_OP);
    expect(writeCell).toBeDefined();
    const chip = collectByAttr(writeCell!, CONTRACT_GRANTS_ALSO_READS_ATTR)[0];
    expect(chip).toBeDefined();
    expect(chip!.getAttribute('data-reads')).toBe('team');
    expect(chip!.textContent).toContain('also looks at: team');

    // The read op binds no dependency — no disclosure chip.
    const readCell = cellFor(opsRootEl(panel), READ_OP);
    expect(collectByAttr(readCell!, CONTRACT_GRANTS_ALSO_READS_ATTR)).toHaveLength(0);
  });
});

describe('D-228 slice 5 — the Tier-1 primitives are reachable in the UI', () => {
  /** ⛔⛔ THE POINT OF THE SLICE. `owner-grant-reconcile.ts` seeds a `granted:true`
   *  row per primitive, and this panel is what the reconcile means by "the owner's
   *  grant rows mirror the UI 1:1". A row the panel cannot RENDER is a permission
   *  that exists in the store with no way for a human to reach it — which is what
   *  `mail.search` was until this slice, because the op universe was derived from
   *  installed ingredient catalogs and a primitive is an engine handler. */
  it('renders a CELL for a primitive, not merely an entry', async () => {
    const { panel } = mountPanelWith({});
    await panel.whenLoaded();
    expect(cellFor(opsRootEl(panel), primitiveGrantEntry('mail.search'))).toBeDefined();
  });

  /** ⚠ THE HALF THAT MAKES IT A CAPABILITY. Rendering is not governing: the
   *  toggle has to reach `contract.grant.write` with the NAMESPACED key, which is
   *  the same id the reconcile seeds and the gate would read. A cell wired to the
   *  bare tool name would look identical and write to nothing. */
  it('toggling a primitive writes the NAMESPACED entry key', async () => {
    const { panel, runGrantWrite } = mountPanelWith({});
    await panel.whenLoaded();
    await panel.toggleEntry(primitiveGrantEntry('mail.search'));
    const calls = (runGrantWrite as unknown as { mock: { calls: Array<[{ entry_key: string }]> } })
      .mock.calls;
    expect(calls.map((c) => c[0].entry_key)).toContain(primitiveGrantEntry('mail.search'));
    // ⛔ …and NOT the bare tool name: a cell wired to `mail.search` would look
    // identical in the UI and write to an id neither the reconcile nor the gate
    // ever reads.
    expect(calls.map((c) => c[0].entry_key)).not.toContain('mail.search');
  });

  /** ⚠ Risk comes from `TIER1_TOOL_DESCRIPTORS`, never from the `.write` /
   *  `.search` suffix — `memory.write` and `recipe.run` are classified `unknown`
   *  deliberately, so a name-derived guess would mislabel them. */
  it('labels a search primitive read and recipe.run not-read', async () => {
    const { panel } = mountPanelWith({});
    await panel.whenLoaded();
    const entries = panel.getEntries();
    const find = (n: string) => entries.find((e) => e.entry_key === primitiveGrantEntry(n));
    expect(find('mail.search')?.risk_tier).toBe('read');
    expect(find('recipe.run')?.risk_tier).not.toBe('read');
  });
});

describe('contract-grants panel — universe split across Ops / Entities', () => {
  it('routes ops AND collection fences to opsRoot, topics to entitiesRoot', async () => {
    const { panel } = mountPanelWith();
    await panel.whenLoaded();

    const opsKinds = collectByAttr(opsRootEl(panel), CONTRACT_GRANTS_KIND_GROUP_ATTR).map((g) =>
      g.getAttribute('data-kind'),
    );
    // ⚠ WAS `['op']`. The `data.*` collection fence moved INTO the Ops root and under
    // the same ENTITY heading as the tools it fences — one root now answers "what may
    // reach my data", instead of a path fence living in a different tab from the ops it
    // governs. `topic` stays in Entities: a derived fact is not a reach.
    expect(opsKinds).toEqual(['op', 'collection']);
    // ops = kernel ops + the two pack ops; the read op + write op both appear.
    expect(cellFor(opsRootEl(panel), READ_OP)).toBeDefined();
    expect(cellFor(opsRootEl(panel), WRITE_OP)).toBeDefined();
    // The collection fence now lives WITH its ops; only topics stay behind.
    expect(cellFor(opsRootEl(panel), collectionGrantEntry('mail'))).toBeDefined();
    expect(cellFor(entitiesRootEl(panel), collectionGrantEntry('mail'))).toBeUndefined();
    expect(cellFor(entitiesRootEl(panel), READ_OP)).toBeUndefined();

    const entityKinds = collectByAttr(
      entitiesRootEl(panel),
      CONTRACT_GRANTS_KIND_GROUP_ATTR,
    ).map((g) => g.getAttribute('data-kind'));
    expect(entityKinds).toEqual(['topic']);
    expect(cellFor(entitiesRootEl(panel), topicGrantEntry(PUBLIC_TOPIC))).toBeDefined();
  });

  it('effective = explicit row ?? author default (read on / write off / public on / private off / normal collection ON)', async () => {
    const { panel } = mountPanelWith();
    await panel.whenLoaded();
    expect(panel.getEffective(READ_OP)).toBe('on');
    expect(panel.getEffective(WRITE_OP)).toBe('off');
    expect(panel.getEffective(topicGrantEntry(PUBLIC_TOPIC))).toBe('on');
    expect(panel.getEffective(topicGrantEntry(PRIVATE_TOPIC))).toBe('off');
    // D-187 slice 5 — a normal READABLE_COLLECTION defaults ON, matching the BACKEND
    // read-fence default (`read-grant-checker.ts isCollectionReadGranted` → admit-all-
    // then-narrow, fail-closed-backstopped by the per-tool read-tool grant). The
    // owner-only raw-collection distinction (owner-on / door-off) is covered below.
    expect(panel.getEffective(collectionGrantEntry('mail'))).toBe('on');
  });

  it('an explicit revoke row beats a permissive author default', async () => {
    const { panel } = mountPanelWith({ seed: { [READ_OP]: false } });
    await panel.whenLoaded();
    expect(panel.getEffective(READ_OP)).toBe('off');
    expect(panel.isExplicit(READ_OP)).toBe(true);
  });

  it('owner-only sensitive surface: ON for user_self, OFF for a door', async () => {
    const ownerPanel = mountPanelWith({ contractId: OWNER_CONTRACT_ID });
    await ownerPanel.panel.whenLoaded();
    for (const entry of OWNER_ONLY_COLLECTIONS) {
      expect(ownerPanel.panel.getEffective(entry)).toBe('on');
    }

    const doorPanel = mountPanelWith({ contractId: 'door_x' });
    await doorPanel.panel.whenLoaded();
    for (const entry of OWNER_ONLY_COLLECTIONS) {
      expect(doorPanel.panel.getEffective(entry)).toBe('off');
    }
  });

  // D-187 Sources half — this is the witness that made deleting Settings →
  // Work Entities' per-Source `mcp_exposed` toggle safe. That flag was the only
  // thing standing between a door and the owner's whole work graph, and it was
  // GLOBAL rather than per-door. Its replacement is the pair asserted here: the
  // ops are reachable in the contract panel at all, and the read verb is
  // owner-on / door-off. If this reds, the deletion left the work graph either
  // ungoverned or unreachable.
  it('every core.work-entity.* op is reachable in the panel; the read verb is owner-on / door-off', async () => {
    // ⚠ DERIVED from the registry, never a literal list — a work-entity op
    // added later must move this automatically or the assertion stops meaning
    // anything. Asserts it found something first, so an empty filter (a renamed
    // op prefix) fails loudly instead of passing vacuously.
    const workEntityOps = KERNEL_OP_REGISTRY
      .filter((e) => e.op.startsWith('core.work-entity.'))
      .map((e) => e.op);
    expect(workEntityOps.length).toBeGreaterThan(0);
    const WORK_ENTITY_READ_OP = 'core.work-entity.read';
    expect(workEntityOps).toContain(WORK_ENTITY_READ_OP);

    const ownerPanel = mountPanelWith({ contractId: OWNER_CONTRACT_ID });
    await ownerPanel.panel.whenLoaded();
    const rendered = new Set(
      ownerPanel.panel.getEntries().map((entry) => entry.entry_key),
    );
    for (const op of workEntityOps) expect(rendered.has(op)).toBe(true);
    // The set must be able to say NO, or `has()` above certifies nothing.
    expect(rendered.has('core.work-entity.__not-a-real-op')).toBe(false);
    expect(ownerPanel.panel.getEffective(WORK_ENTITY_READ_OP)).toBe('on');

    const doorPanel = mountPanelWith({ contractId: 'door_x' });
    await doorPanel.panel.whenLoaded();
    expect(doorPanel.panel.getEffective(WORK_ENTITY_READ_OP)).toBe('off');
  });

  it('customer-template mode is explicit-only and omits unstamped CLI authority', async () => {
    const { panel, store, runGrantWrite } = mountPanelWith({
      explicitGrantRowsOnly: true,
      catalog: cliCatalog,
    });
    await panel.whenLoaded();

    const mailEntry = collectionGrantEntry('mail');
    expect(panel.getEffective(mailEntry)).toBe('off');
    expect(panel.getEffective(topicGrantEntry(PUBLIC_TOPIC))).toBe('off');
    expect(panel.getEntries().some((entry) => entry.entry_key === CLI_OP)).toBe(false);

    await panel.toggleEntry(mailEntry);
    expect(runGrantWrite).toHaveBeenCalledWith({
      contract_id: 'door_x',
      entry_key: mailEntry,
      granted: true,
    });
    expect(store.get(mailEntry)).toBe(true);
    expect(panel.getEffective(mailEntry)).toBe('on');
  });

  it('renders stored peer-label grants and lets the owner revoke them', async () => {
    const entry = peerLabelGrantEntry('review:contract');
    const { panel, store } = mountPanelWith({ seed: { [entry]: true } });
    await panel.whenLoaded();

    expect(cellFor(opsRootEl(panel), entry)).toBeDefined();
    expect(panel.getEffective(entry)).toBe('on');
    await panel.toggleEntry(entry);
    expect(store.get(entry)).toBe(false);
    expect(panel.getEffective(entry)).toBe('off');
  });

  it('creates a new peer-label grant from the shipped Ops surface', async () => {
    const { panel, store, runGrantWrite } = mountPanelWith();
    await panel.whenLoaded();
    const input = opsRootEl(panel).querySelector(`[${CONTRACT_GRANTS_PEER_LABEL_INPUT_ATTR}]`)!;
    const add = opsRootEl(panel).querySelector(`[${CONTRACT_GRANTS_PEER_LABEL_ADD_ATTR}]`)!;
    input.value = 'review:contract';
    input.dispatch('input');
    add.click();
    while (panel.hasInFlightWork()) await Promise.resolve();

    const entry = peerLabelGrantEntry('review:contract');
    expect(runGrantWrite).toHaveBeenCalledWith({
      contract_id: 'door_x', entry_key: entry, granted: true,
    });
    expect(store.get(entry)).toBe(true);
    expect(cellFor(opsRootEl(panel), entry)).toBeDefined();
  });
});

describe('contract-grants panel — write / reconcile + chrome', () => {
  it('gives every grant checkbox a full-size label target', () => {
    expect(CONTRACT_GRANTS_PANEL_STYLES).toContain(
      '.cg-cell {\n  box-sizing: border-box;\n  width: 100%;\n'
        + '  min-width: 0;\n  max-width: 100%;\n  min-height: 36px;',
    );
    expect(CONTRACT_GRANTS_PANEL_STYLES).toMatch(
      /\.cg-cell-name\s*\{[^}]*min-width:\s*0[^}]*flex:\s*1 1 140px[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(CONTRACT_GRANTS_PANEL_STYLES).toMatch(
      /\.cg-also-reads\s*\{[^}]*max-width:\s*100%[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(CONTRACT_GRANTS_PANEL_STYLES).toMatch(
      /\.cg-filter-bar\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*flex-wrap:\s*wrap/s,
    );
    expect(CONTRACT_GRANTS_PANEL_STYLES).toMatch(
      /\.cg-filter-status\s*\{[^}]*flex:\s*0 0 auto[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s,
    );
  });

  it('keeps the active toggle focused through write and reconcile repaints', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { doc, panel } = mountPanelWith({ writeGate: gate });
    await panel.whenLoaded();
    const initial = collectByAttr(
      opsRootEl(panel),
      CONTRACT_GRANTS_CELL_TOGGLE_ATTR,
    ).find((cell) => cell.getAttribute('data-entry') === READ_OP)!;
    initial.focus();

    const writing = panel.toggleEntry(READ_OP);
    const busy = collectByAttr(
      opsRootEl(panel),
      CONTRACT_GRANTS_CELL_TOGGLE_ATTR,
    ).find((cell) => cell.getAttribute('data-entry') === READ_OP)!;
    expect(busy).not.toBe(initial);
    expect(busy.hasAttribute('disabled')).toBe(false);
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(doc.activeElement).toBe(busy);
    expect(panel.hasInFlightWork()).toBe(true);

    release();
    await writing;
    expect(panel.hasInFlightWork()).toBe(false);
    const settled = collectByAttr(
      opsRootEl(panel),
      CONTRACT_GRANTS_CELL_TOGGLE_ATTR,
    ).find((cell) => cell.getAttribute('data-entry') === READ_OP)!;
    expect(settled.checked).toBe(false);
    expect(settled.hasAttribute('aria-disabled')).toBe(false);
    expect(doc.activeElement).toBe(settled);
  });

  it('toggling an author-default-ON op writes an explicit false + reconciles', async () => {
    const { panel, store, runGrantWrite } = mountPanelWith();
    await panel.whenLoaded();
    expect(panel.getEffective(READ_OP)).toBe('on');

    await panel.toggleEntry(READ_OP);
    expect(runGrantWrite).toHaveBeenCalledWith({
      contract_id: 'door_x',
      entry_key: READ_OP,
      granted: false,
    });
    expect(store.get(READ_OP)).toBe(false);
    expect(panel.getEffective(READ_OP)).toBe('off');
    expect(panel.isExplicit(READ_OP)).toBe(true);
  });

  it('toggling an author-default-OFF collection writes an explicit true', async () => {
    // D-187 slice 5 — normal collections now default ON (admit-all-then-narrow), so the
    // owner-only `data.webhook` (door-default OFF) is the off-by-default collection here.
    const { panel, store } = mountPanelWith();
    await panel.whenLoaded();
    const webhook = collectionGrantEntry('webhook');
    expect(panel.getEffective(webhook)).toBe('off');
    await panel.toggleEntry(webhook);
    expect(store.get(webhook)).toBe(true);
    expect(panel.getEffective(webhook)).toBe('on');
  });

  it('toggling an author-default-ON collection writes an explicit false (revoke)', async () => {
    // D-187 slice 5 — the new common case: a normal collection is ON by default, so
    // toggling it writes an explicit revoke (matching the backend read-fence narrowing).
    const { panel, store } = mountPanelWith();
    await panel.whenLoaded();
    const mail = collectionGrantEntry('mail');
    expect(panel.getEffective(mail)).toBe('on');
    await panel.toggleEntry(mail);
    expect(store.get(mail)).toBe(false);
    expect(panel.getEffective(mail)).toBe('off');
  });

  it('a refresh interleaved with an in-flight write carries live grants forward (write reconcile wins)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { panel } = mountPanelWith({ writeGate: gate });
    await panel.whenLoaded();
    expect(panel.getEffective(READ_OP)).toBe('on');

    // Start a write (revoke READ_OP) but hold it in flight on the gate.
    const writing = panel.toggleEntry(READ_OP);
    // A refresh completes WHILE the write is pending → the `pendingCells.size > 0`
    // carry-forward keeps the live grants; the (pre-write) snapshot is not applied.
    await panel.refresh();
    expect(panel.getState()).toBe('ready');

    release();
    await writing;
    // The write's reconcile is authoritative — the interleaved refresh did NOT
    // revert it.
    expect(panel.getEffective(READ_OP)).toBe('off');
    expect(panel.isExplicit(READ_OP)).toBe(true);
  });

  it('renders Contract operations as Access-only rows', async () => {
    const { panel } = mountPanelWith({ seed: { [READ_OP]: false } });
    await panel.whenLoaded();
    const writeCell = cellFor(opsRootEl(panel), WRITE_OP)!;
    expect(collectByAttr(writeCell, CONTRACT_GRANTS_RISK_ATTR)).toHaveLength(0);
    expect(collectByAttr(writeCell, CONTRACT_GRANTS_ASKS_ATTR)).toHaveLength(0);
    const readCell = cellFor(opsRootEl(panel), READ_OP)!;
    expect(collectByAttr(readCell, CONTRACT_GRANTS_RISK_ATTR)).toHaveLength(0);
    expect(collectByAttr(readCell, CONTRACT_GRANTS_ASKS_ATTR)).toHaveLength(0);
    // the seeded read revoke renders as an explicit 'set' source.
    expect(
      collectByAttr(readCell, CONTRACT_GRANTS_SOURCE_ATTR)[0]?.getAttribute('data-source'),
    ).toBe('explicit');
  });

  it('the ops list explains Access-only scope; the entities list does NOT', async () => {
    const { panel } = mountPanelWith({});
    await panel.whenLoaded();
    const note = collectByAttr(opsRootEl(panel), CONTRACT_GRANTS_AXIS_NOTE_ATTR)[0];
    expect(note?.textContent).toContain('What it may reach');
    expect(note?.textContent).toContain('are the same for every contract');
    // ⛔ Never "visibility" — an ungranted op is a HARD DENY, so calling the toggle
    // visibility undersells it in the opposite direction from the error it corrects.
    expect(note?.textContent).not.toContain('visibility');
    // The note is about operation reachability; entities are a separate axis.
    expect(
      collectByAttr(entitiesRootEl(panel), CONTRACT_GRANTS_AXIS_NOTE_ATTR),
    ).toHaveLength(0);
  });

  it('shows N of M granted per tab', async () => {
    const { panel } = mountPanelWith();
    await panel.whenLoaded();
    const opsSummary = collectByAttr(opsRootEl(panel), CONTRACT_GRANTS_SUMMARY_ATTR)[0];
    // every read-tier op is on by default; the total is kernel + 2 pack ops.
    expect(opsSummary?.textContent).toMatch(/^\d+ of \d+ granted$/);
    const entSummary = collectByAttr(entitiesRootEl(panel), CONTRACT_GRANTS_SUMMARY_ATTR)[0];
    // ⚠ WAS collections + 2 topics. The collection fences moved to the Ops root (they
    // group with the ops they fence), so Entities is TOPICS ONLY: of the 2, the public
    // one is on. The collections' own grant semantics are unchanged — D-187 slice 5's
    // admit-all-then-narrow still governs them, it is now counted in the Ops summary.
    expect(entSummary?.textContent).toBe('1 of 2 granted');
    // And the collections really did land in Ops rather than vanishing.
    expect(cellFor(opsRootEl(panel), collectionGrantEntry('mail'))).toBeDefined();
  });

  it('debounces the Ops type-along filter and keeps the input focused/stable', async () => {
    vi.useFakeTimers();
    try {
      const { panel } = mountPanelWith({ operationFilterDebounceMs: 250 });
      await panel.whenLoaded();
      const root = opsRootEl(panel);
      const input = collectByAttr(root, CONTRACT_GRANTS_OP_FILTER_ATTR)[0]!;
      const fullEntryCount = panel.getEntries().length;

      input.value = 'deal.create';
      input.dispatch('input');
      expect(panel.getOperationFilter()).toBe('');
      expect(cellFor(root, READ_OP)).toBeDefined();
      expect(
        collectByAttr(root, CONTRACT_GRANTS_OP_FILTER_STATUS_ATTR)[0]?.textContent,
      ).toBe('Filtering…');

      vi.advanceTimersByTime(249);
      expect(panel.getOperationFilter()).toBe('');
      vi.advanceTimersByTime(1);

      expect(panel.getOperationFilter()).toBe('deal.create');
      expect(cellFor(root, WRITE_OP)).toBeDefined();
      expect(cellFor(root, READ_OP)).toBeUndefined();
      // Filtering only changes the rendered projection; it never discards the
      // loaded universe or rebuilds the input node (which would drop focus).
      expect(panel.getEntries()).toHaveLength(fullEntryCount);
      expect(collectByAttr(root, CONTRACT_GRANTS_OP_FILTER_ATTR)[0]).toBe(input);
      expect(
        collectByAttr(root, CONTRACT_GRANTS_SUMMARY_ATTR)[0]?.textContent,
      ).toMatch(/matching$/);
      panel.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('contract-grants panel — degrade + lifecycle', () => {
  it('no catalog ⇒ the COMPILED-IN op slices only (still renders); no registry ⇒ no topics', async () => {
    const { panel } = mountPanelWith({ withCatalog: false, withRegistry: false });
    await panel.whenLoaded();
    expect(panel.getState()).toBe('ready');
    // pack ops gone; the compiled-in slices (kernel ops + Tier-1 primitives) remain.
    expect(cellFor(opsRootEl(panel), READ_OP)).toBeUndefined();
    expect(panel.getEntries().filter((e) => e.kind === 'op'))
      .toHaveLength(KERNEL_OP_COUNT + PRIMITIVE_OP_COUNT);
    // ⚠ And the primitives are actually THERE, not merely counted — a count-only
    // assertion passes if some other slice happens to contribute the same total.
    expect(panel.getEntries().map((e) => e.entry_key))
      .toContain(primitiveGrantEntry('mail.search'));
    expect(panel.getEntries().some((e) => e.kind === 'topic')).toBe(false);
    // ⚠ WAS "entities still has the collections". Collections moved to Ops; with no
    // registry there are no topics either, so the Entities root has NO kind-groups.
    expect(
      collectByAttr(entitiesRootEl(panel), CONTRACT_GRANTS_KIND_GROUP_ATTR).map((g) =>
        g.getAttribute('data-kind'),
      ),
    ).toEqual([]);
  });

  it('a grant-read failure surfaces a top-level error in both roots', async () => {
    const { panel } = mountPanelWith({ grantReadRejects: true });
    await panel.whenLoaded();
    expect(panel.getState()).toBe('error');
    expect(collectByAttr(opsRootEl(panel), CONTRACT_GRANTS_ERROR_ATTR)[0]?.textContent).toContain(
      'grant_read offline',
    );
    expect(
      collectByAttr(entitiesRootEl(panel), CONTRACT_GRANTS_ERROR_ATTR)[0]?.textContent,
    ).toContain('grant_read offline');
  });

  it('dispose detaches both roots from their parents', async () => {
    const { panel } = mountPanelWith();
    await panel.whenLoaded();
    const host = makeFakeEl('div');
    host.appendChild(opsRootEl(panel));
    host.appendChild(entitiesRootEl(panel));
    expect(host.children).toHaveLength(2);
    panel.dispose();
    expect(host.children).toHaveLength(0);
  });

  it('an empty universe renders the empty note (no callers, kernel ops still present)', async () => {
    // ⚠ INVERTED BY THE COLLECTION MOVE, AND THE INVERSION IS THE ASSERTION. Kernel
    // ops AND the collection fences are compiled-in, so the OPS root always has
    // content; Entities is now topics-only, which without a registry means it is
    // genuinely empty and SHOULD say so. Asserting both halves keeps this honest —
    // a version that only flipped the number would pass on a panel that rendered
    // nothing at all.
    const { panel } = mountPanelWith({ withCatalog: false, withRegistry: false });
    await panel.whenLoaded();
    expect(collectByAttr(opsRootEl(panel), CONTRACT_GRANTS_EMPTY_ATTR)).toHaveLength(0);
    expect(cellFor(opsRootEl(panel), collectionGrantEntry('mail'))).toBeDefined();
    expect(collectByAttr(entitiesRootEl(panel), CONTRACT_GRANTS_EMPTY_ATTR)).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════
// Route — Ops/Entities tabs + header L1 controls
// ════════════════════════════════════════════════════════════════

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

interface RouteGrantStubs {
  contracts?: ReadonlyArray<ContractDefinitionView>;
  initialListTab?: ContractsListTab;
  withGrants?: boolean;
  withSetDoorTypes?: boolean;
  withRevoke?: boolean;
  setDoorTypesImpl?: (
    args: { contract_id: string; door_types: ReadonlyArray<DoorType> },
  ) => Promise<ContractDefinitionView>;
  revokeImpl?: (args: { contract_id: string; reason?: string }) => Promise<ContractDefinitionView>;
  /** D-327 — the Connect tab's key callers. */
  keyCallers?: Pick<
    Parameters<typeof bootstrapContractsRoute>[0],
    | 'permissionsListInboundTokensCaller'
    | 'permissionsIssueInboundTokenCaller'
    | 'permissionsRevokeInboundTokenCaller'
  >;
  /** D-327 — wire the override (rules) callers. */
  withRules?: boolean;
  /** D-327 — `collection.contract.setLimits`. */
  setLimitsImpl?: (args: SetContractLimitsRequest) => Promise<ContractDefinitionView>;
}

const mountRoute = (
  initialContractId: string | undefined,
  stubs: RouteGrantStubs = {},
  initialContractTab?: string,
) => {
  const doc = makeFakeDocument();
  const root = doc.createElement('div');
  const store = new Map<string, boolean>();
  const runGrantRead: GrantReadCaller = vi.fn(async () => ({
    grants: [...store.entries()].map(([entry_key, granted]) => ({
      entry_key,
      granted,
      set_at: 1,
    })),
  }));
  const runGrantWrite: GrantWriteCaller = vi.fn(async ({ entry_key, granted }) => {
    if (granted === null) store.delete(entry_key);
    else store.set(entry_key, granted);
    return { ok: true as const, granted };
  });
  const runCatalogOperations: GrantCatalogOperationsCaller = vi.fn(async () => catalog);
  const runRegistryDescribe: GrantRegistryDescribeCaller = vi.fn(async () => registry);
  const grantSetDoorTypesCaller = vi.fn(
    stubs.setDoorTypesImpl
      ?? (async ({ contract_id, door_types }) =>
        agentContract({ contract_id, door_types })),
  );
  const contractsRevokeCaller = vi.fn(
    stubs.revokeImpl
      ?? (async ({ contract_id }) =>
        agentContract({ contract_id, lifecycle_state: 'revoked', revoked_at: 5 })),
  );

  const route = bootstrapContractsRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    serverUrl: 'wss://alice.example/ws',
    initialContractId,
    ...(initialContractTab !== undefined ? { initialContractTab } : {}),
    ...(stubs.initialListTab !== undefined ? { initialListTab: stubs.initialListTab } : {}),
    contractsListCaller: vi.fn(async () => ({ contracts: stubs.contracts ?? [agentContract()] })),
    ...(stubs.withGrants === false
      ? {}
      : { grantReadCaller: runGrantRead, grantWriteCaller: runGrantWrite, grantCatalogOperationsCaller: runCatalogOperations, grantRegistryDescribeCaller: runRegistryDescribe }),
    ...(stubs.withSetDoorTypes === false ? {} : { grantSetDoorTypesCaller }),
    ...(stubs.withRevoke === false ? {} : { contractsRevokeCaller }),
    ...(stubs.keyCallers ?? {}),
    ...(stubs.setLimitsImpl !== undefined ? { grantSetLimitsCaller: vi.fn(stubs.setLimitsImpl) } : {}),
    ...(stubs.withRules === true
      ? {
          permissionsListOverridesCaller: vi.fn(async () => ({ overrides: [] })),
          permissionsDeleteOverrideCaller: vi.fn(async () => ({ deleted: true })),
        }
      : {}),
  });
  return {
    doc,
    root,
    route,
    store,
    runGrantRead,
    runGrantWrite,
    runCatalogOperations,
    grantSetDoorTypesCaller,
    contractsRevokeCaller,
  };
};

const tabBtn = (root: FakeEl, id: string): FakeEl =>
  collectByAttr(root, CONTRACTS_ROUTE_TAB_ATTR).find((t) => t.getAttribute('data-tab') === id)!;
const tabBodyEl = (root: FakeEl): FakeEl =>
  collectByAttr(root, CONTRACTS_ROUTE_TAB_BODY_ATTR)[0]!;
const doorToggle = (root: FakeEl, door: string): FakeEl =>
  collectByAttr(root, CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR).find(
    (t) => t.getAttribute('data-door') === door,
  )!;
const doorInput = (toggle: FakeEl): FakeEl =>
  toggle.children.find((c) => c.tagName === 'INPUT')!;

describe('contracts route delta 3 — Ops/Entities tabs', () => {
  it('D-196: lists templates under Customer but keeps issued instances in Seller', async () => {
    const ctx = mountRoute(undefined, {
      initialListTab: 'customer',
      contracts: [
        agentContract({ contract_id: 'door_alpha' }),
        agentContract({ contract_id: 'ct_template', grant_kind: 'customer_template' }),
        agentContract({ contract_id: 'ct_customer', grant_kind: 'customer_instance' }),
      ],
    });
    await ctx.route.whenLoaded();

    expect(ctx.route.getContracts().map((row) => row.contract_id)).toEqual(['ct_template']);
  });

  it('customer templates mount an explicit-only Ops/Entities editor', async () => {
    const ctx = mountRoute('ct_template', {
      contracts: [agentContract({
        contract_id: 'ct_template',
        grant_kind: 'customer_template',
      })],
    }, 'ops');
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    await ctx.route.contractGrantsPanel()?.whenLoaded();
    await tick();

    expect(collectByAttr(root, CONTRACTS_ROUTE_TAB_ATTR).map((tab) =>
      tab.getAttribute('data-tab'))).toEqual(['ops', 'entities']);
    const panel = ctx.route.contractGrantsPanel();
    expect(panel?.getEffective(READ_OP)).toBe('off');
    await panel?.toggleEntry(READ_OP);
    expect(ctx.runGrantWrite).toHaveBeenCalledWith({
      contract_id: 'ct_template',
      entry_key: READ_OP,
      granted: true,
    });
  });

  it('mounts the kept-alive grant panel; Ops attaches opsRoot, Entities attaches entitiesRoot', async () => {
    const ctx = mountRoute('door_alpha', {}, undefined);
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();

    // agent lands on connect; switch to Ops mounts the panel + attaches opsRoot.
    tabBtn(root, 'ops').click();
    await tick();
    await ctx.route.contractGrantsPanel()?.whenLoaded();
    await tick();
    const panel = ctx.route.contractGrantsPanel();
    expect(panel).not.toBeNull();
    const hostsInBody = collectByAttr(tabBodyEl(root), CONTRACT_GRANTS_HOST_ATTR);
    expect(hostsInBody).toHaveLength(1);
    expect(hostsInBody[0]!.getAttribute('data-grant-view')).toBe('ops');

    tabBtn(root, 'entities').click();
    await tick();
    const entHosts = collectByAttr(tabBodyEl(root), CONTRACT_GRANTS_HOST_ATTR);
    expect(entHosts).toHaveLength(1);
    expect(entHosts[0]!.getAttribute('data-grant-view')).toBe('entities');

    // switching back keeps the SAME panel instance (loaded once).
    tabBtn(root, 'ops').click();
    await tick();
    expect(ctx.route.contractGrantsPanel()).toBe(panel);
    expect(ctx.runCatalogOperations).toHaveBeenCalledTimes(1);
  });

  /** ⛔⛔ THE NEGATIVE HALF, and it is the security-relevant one. The `recipe.*`
   *  axis is OWNER-SCOPED: a door's recipe authority is its INBOUND TOKEN
   *  (`inboundTokenAuthorize` → `allowed_tools`, D-232 § 20.19), and a derived
   *  reception/webhook door has no recipe grant at all. A Recipes tab on a door
   *  would offer switches that write rows nothing reads — a control that does
   *  nothing, which is worse than an absent one because the owner believes it. */
  it('a DOOR gets NO Recipes tab — its recipe authority is its token, not this axis', async () => {
    const ctx = mountRoute('door_alpha');
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    await tick();
    const tabIds = collectByAttr(root, CONTRACTS_ROUTE_TAB_ATTR).map((t) =>
      t.getAttribute('data-tab'),
    );
    expect(tabIds).not.toContain('recipes');
    expect(tabIds).toContain('ops');
  });

  it('self DETAIL gets Ops/Entities/Recipes via grant.read with no Connect/door/Revoke', async () => {
    const ctx = mountRoute(OWNER_CONTRACT_ID);
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    await ctx.route.contractGrantsPanel()?.whenLoaded();
    await tick();

    const tabIds = collectByAttr(root, CONTRACTS_ROUTE_TAB_ATTR).map((t) =>
      t.getAttribute('data-tab'),
    );
    // D-247 — the OWNER gains a Recipes tab. ⛔ Owner-only by design: a door's
    // recipe authority is its inbound token, so the same tab on a door would
    // write rows nothing reads. The door assertions below pin that.
    expect(tabIds).toEqual(['ops', 'entities', 'recipes']);
    // self loads grants under its own id; no door toggle, no Revoke.
    expect(ctx.runGrantRead).toHaveBeenCalledWith({ contract_id: OWNER_CONTRACT_ID });
    expect(collectByAttr(root, CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CONTRACTS_ROUTE_REVOKE_ATTR)).toHaveLength(0);
  });

  it('falls back to the descriptor when grant callers are unwired', async () => {
    const ctx = mountRoute('door_alpha', { withGrants: false });
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    tabBtn(root, 'ops').click();
    await tick();
    expect(ctx.route.contractGrantsPanel()).toBeNull();
    expect(collectByAttr(tabBodyEl(root), CONTRACT_GRANTS_HOST_ATTR)).toHaveLength(0);
    expect(allText(tabBodyEl(root))).toContain('What it may do, grouped by Pack');
  });
});

describe('contracts route delta 3 — header door toggle (L1)', () => {
  it('toggling a door type calls setDoorTypes + reconciles the backed state in place', async () => {
    const ctx = mountRoute('door_alpha');
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();

    // wildcard door (no door_types) backs every door — all checked, none locked.
    expect(doorToggle(root, 'mcp').getAttribute('data-backed')).toBe('true');
    expect(doorToggle(root, 'llm_gateway').getAttribute('data-backed')).toBe('true');
    expect(allText(root)).not.toContain('One way in has to stay on');

    doorInput(doorToggle(root, 'mcp')).dispatch('change');
    await tick();
    expect(ctx.grantSetDoorTypesCaller).toHaveBeenCalledWith({
      contract_id: 'door_alpha',
      door_types: ['llm_gateway'],
    });
    // header re-rendered: mcp un-backed and still editable; the AI door is now
    // the last way in, so it locks and the page says why.
    expect(doorToggle(root, 'mcp').getAttribute('data-backed')).toBe('false');
    expect(doorInput(doorToggle(root, 'mcp')).hasAttribute('disabled')).toBe(false);
    expect(doorToggle(root, 'llm_gateway').getAttribute('data-backed')).toBe('true');
    expect(doorInput(doorToggle(root, 'llm_gateway')).hasAttribute('disabled')).toBe(true);
    expect(allText(root)).toContain('One way in has to stay on. To stop this contract, use Revoke.');
  });

  it('offers no MCP chat box — nothing serves that door yet', async () => {
    const ctx = mountRoute('door_alpha');
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    expect(
      collectByAttr(root, CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR).map((t) => t.getAttribute('data-door')),
    ).toEqual(['mcp', 'llm_gateway']);
  });

  it('a wildcard "backs all" reflects even when the server omits door_types', async () => {
    const ctx = mountRoute('door_alpha', {
      contracts: [agentContract({ door_types: ['mcp', 'mcp_chat'] })],
      // The server accepts the `[]` wildcard but echoes it as an OMITTED
      // door_types (absent = wildcard). The toggle must not preserve the stale
      // ['mcp', 'mcp_chat'] subset.
      setDoorTypesImpl: async ({ contract_id }) => agentContract({ contract_id }),
    });
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    // mcp backed (mcp_chat is not shown); toggling llm_gateway ON → backs every
    // shown door → sent as [].
    doorInput(doorToggle(root, 'llm_gateway')).dispatch('change');
    await tick();
    expect(ctx.grantSetDoorTypesCaller).toHaveBeenCalledWith({
      contract_id: 'door_alpha',
      door_types: [],
    });
    expect(doorToggle(root, 'mcp').getAttribute('data-backed')).toBe('true');
    expect(doorToggle(root, 'llm_gateway').getAttribute('data-backed')).toBe('true');
  });

  it('the only-backed door type is locked (cannot empty the set)', async () => {
    const ctx = mountRoute('door_alpha', {
      contracts: [agentContract({ door_types: ['mcp'] })],
    });
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    const onlyInput = doorInput(doorToggle(root, 'mcp'));
    expect(onlyInput.hasAttribute('disabled')).toBe(true);
    // A greyed tick with no reason read as a third state of the box.
    expect(doorToggle(root, 'mcp').getAttribute('title')).toBe(
      'One way in has to stay on. To stop this contract, use Revoke.',
    );
    expect(allText(root)).toContain('One way in has to stay on. To stop this contract, use Revoke.');
    onlyInput.dispatch('change'); // disabled → no-op
    await tick();
    expect(ctx.grantSetDoorTypesCaller).not.toHaveBeenCalled();
  });

  it('a setDoorTypes failure surfaces a head-error chip and leaves the door unchanged', async () => {
    const ctx = mountRoute('door_alpha', {
      setDoorTypesImpl: async () => {
        throw new Error('door wedged');
      },
    });
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    doorInput(doorToggle(root, 'mcp')).dispatch('change');
    await tick();
    expect(collectByAttr(root, CONTRACTS_ROUTE_HEAD_ERROR_ATTR)[0]?.textContent).toContain(
      'door wedged',
    );
    // unchanged: both still backed (wildcard).
    expect(doorToggle(root, 'mcp').getAttribute('data-backed')).toBe('true');
  });

  it('no door toggle when setDoorTypes is unwired', async () => {
    const ctx = mountRoute('door_alpha', { withSetDoorTypes: false });
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    expect(collectByAttr(root, CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR)).toHaveLength(0);
  });
});

describe('contracts route delta 3 — header Revoke (kill-switch)', () => {
  it('2-stage confirm → revokeContract → pill flips to Revoked + controls drop', async () => {
    const ctx = mountRoute('door_alpha');
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();

    // stage 1: arm.
    collectByAttr(root, CONTRACTS_ROUTE_REVOKE_ATTR)[0]!.click();
    expect(collectByAttr(root, CONTRACTS_ROUTE_REVOKE_CONFIRM_ATTR)).toHaveLength(1);
    expect(collectByAttr(root, CONTRACTS_ROUTE_REVOKE_CANCEL_ATTR)).toHaveLength(1);

    // stage 2: confirm.
    collectByAttr(root, CONTRACTS_ROUTE_REVOKE_CONFIRM_ATTR)[0]!.click();
    await tick();
    expect(ctx.contractsRevokeCaller).toHaveBeenCalledWith({ contract_id: 'door_alpha' });
    expect(
      collectByAttr(root, CONTRACTS_ROUTE_PILL_ATTR)[0]?.getAttribute('data-state'),
    ).toBe('revoked');
    // a revoked contract shows no Revoke + no door toggle.
    expect(collectByAttr(root, CONTRACTS_ROUTE_REVOKE_ATTR)).toHaveLength(0);
    expect(collectByAttr(root, CONTRACTS_ROUTE_DOOR_TOGGLE_ATTR)).toHaveLength(0);
  });

  it('Cancel disarms without revoking', async () => {
    const ctx = mountRoute('door_alpha');
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    collectByAttr(root, CONTRACTS_ROUTE_REVOKE_ATTR)[0]!.click();
    collectByAttr(root, CONTRACTS_ROUTE_REVOKE_CANCEL_ATTR)[0]!.click();
    await tick();
    expect(ctx.contractsRevokeCaller).not.toHaveBeenCalled();
    expect(collectByAttr(root, CONTRACTS_ROUTE_REVOKE_ATTR)).toHaveLength(1);
    expect(collectByAttr(root, CONTRACTS_ROUTE_REVOKE_CONFIRM_ATTR)).toHaveLength(0);
  });

  it('a revoke failure surfaces a head-error chip and leaves the contract active', async () => {
    const ctx = mountRoute('door_alpha', {
      revokeImpl: async () => {
        throw new Error('revoke denied');
      },
    });
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    collectByAttr(root, CONTRACTS_ROUTE_REVOKE_ATTR)[0]!.click();
    collectByAttr(root, CONTRACTS_ROUTE_REVOKE_CONFIRM_ATTR)[0]!.click();
    await tick();
    expect(collectByAttr(root, CONTRACTS_ROUTE_HEAD_ERROR_ATTR)[0]?.textContent).toContain(
      'revoke denied',
    );
    expect(
      collectByAttr(root, CONTRACTS_ROUTE_PILL_ATTR)[0]?.getAttribute('data-state'),
    ).toBe('active');
    // still revocable (control intact).
    expect(collectByAttr(root, CONTRACTS_ROUTE_REVOKE_ATTR)).toHaveLength(1);
  });

  it('door toggle does not tear down a just-mounted grant panel (kept alive)', async () => {
    const ctx = mountRoute('door_alpha');
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    tabBtn(root, 'ops').click();
    await tick();
    await ctx.route.contractGrantsPanel()?.whenLoaded();
    const panel = ctx.route.contractGrantsPanel();
    expect(panel).not.toBeNull();

    doorInput(doorToggle(root, 'mcp')).dispatch('change');
    await tick();
    // same panel instance, opsRoot still attached to the (untouched) tab body.
    expect(ctx.route.contractGrantsPanel()).toBe(panel);
    expect(collectByAttr(tabBodyEl(root), CONTRACT_GRANTS_HOST_ATTR)).toHaveLength(1);
  });
});

describe('contract grants — CLI ops route to cli_reachability (R22 GAP-B fix)', () => {
  const CLI_ENTRY = opGrantEntry(CLI_OP);

  it('a cli op ignores a contract_grant row and reads cli_reachability (fail-closed off)', async () => {
    // A contract_grant TRUE row for the cli op must NOT read on — cli admission
    // is the cli_reachability allowlist, which has no row here.
    const { panel } = mountPanelWith({ catalog: cliCatalog, seed: { [CLI_ENTRY]: true } });
    await panel.whenLoaded();
    expect(panel.getEffective(CLI_ENTRY)).toBe('off');
  });

  it('a granted cli_reachability row (keyed on the MAP KEY) makes the cli op read on', async () => {
    const { panel } = mountPanelWith({
      catalog: cliCatalog,
      contractId: 'door_x',
      // Row keyed on the short map key, NOT the qualified CLI_OP — proves the
      // panel looks it up by the map key the gateway actually enforces.
      cliSeed: [{ principal: 'door_x', ingredient_id: CLI_INGREDIENT, operation_id: CLI_OP_KEY }],
    });
    await panel.whenLoaded();
    expect(panel.getEffective(CLI_ENTRY)).toBe('on');
  });

  it('a row keyed on the QUALIFIED operation_id (not the map key) does NOT match', async () => {
    // Guards the fold: keying by the qualified id (the pre-fix bug) must not read on.
    const { panel } = mountPanelWith({
      catalog: cliCatalog,
      contractId: 'door_x',
      cliSeed: [{ principal: 'door_x', ingredient_id: CLI_INGREDIENT, operation_id: CLI_OP }],
    });
    await panel.whenLoaded();
    expect(panel.getEffective(CLI_ENTRY)).toBe('off');
  });

  it('cli_reachability rows for OTHER principals do not leak into this contract', async () => {
    const { panel } = mountPanelWith({
      catalog: cliCatalog,
      contractId: 'door_x',
      cliSeed: [{ principal: 'user_self', ingredient_id: CLI_INGREDIENT, operation_id: CLI_OP_KEY }],
    });
    await panel.whenLoaded();
    expect(panel.getEffective(CLI_ENTRY)).toBe('off');
  });

  it('toggling a cli op writes cli.reachability.set (principal = contractId), never contract.grant.write', async () => {
    const { panel, runCliReachabilitySet, runGrantWrite } = mountPanelWith({
      catalog: cliCatalog,
      contractId: 'door_x',
    });
    await panel.whenLoaded();
    await panel.toggleEntry(CLI_ENTRY);
    expect(runCliReachabilitySet).toHaveBeenCalledWith({
      principal: 'door_x',
      ingredient_id: CLI_INGREDIENT,
      // The MAP KEY, not the qualified CLI_OP — what the gateway enforces.
      operation_id: CLI_OP_KEY,
      allowed: true,
    });
    expect(runGrantWrite).not.toHaveBeenCalledWith(
      expect.objectContaining({ entry_key: CLI_ENTRY }),
    );
    expect(panel.getEffective(CLI_ENTRY)).toBe('on');
  });

  it('a non-cli op still writes contract.grant.write, not cli.reachability.set', async () => {
    const { panel, runGrantWrite, runCliReachabilitySet } = mountPanelWith({
      catalog: cliCatalog,
      contractId: 'door_x',
    });
    await panel.whenLoaded();
    await panel.toggleEntry(WRITE_OP);
    expect(runGrantWrite).toHaveBeenCalledWith(
      expect.objectContaining({ entry_key: WRITE_OP }),
    );
    expect(runCliReachabilitySet).not.toHaveBeenCalled();
  });

  it('a cli op is inert (toggle no-ops) when no cli.reachability.set caller is wired', async () => {
    const { panel, runCliReachabilitySet } = mountPanelWith({
      catalog: cliCatalog,
      withCliSet: false,
    });
    await panel.whenLoaded();
    await panel.toggleEntry(CLI_ENTRY);
    expect(panel.getEffective(CLI_ENTRY)).toBe('off');
    expect(runCliReachabilitySet).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════
// D-327 follow-on — each switch says what it is; each AI tool, what it needs
// ════════════════════════════════════════════════════════════════

/** ⛔ THE OWNER'S REPORT (2026-10-24): "each op should have a tooltip or hovering
 *  text showing what it is, for the work/work-entity requirement it is unclear",
 *  and "take out the work.* and other mcp-only op to its own group name".
 *
 *  On an agreement that grants nothing by default, switching `work.create` on adds
 *  nothing: the tool also checks `core.work-entity.<kind>.create`. Nothing on the
 *  page said so. These pin the three answers: a plain title and hover sentence on
 *  every Recued switch, the AI tools in a group of their own, and under each tool
 *  the other switches it needs, switchable in place. */
describe('D-327 follow-on — every switch says what it is, every AI tool what it needs', () => {
  const opsGroupNames = (root: FakeEl): string[] => {
    const out: string[] = [];
    const walk = (node: FakeEl): void => {
      if (node.className === 'cg-op-ingredient-name') out.push(node.textContent);
      for (const child of node.children) walk(child);
    };
    walk(root);
    return out;
  };
  const needsLine = (root: FakeEl, toolKey: string): FakeEl | undefined =>
    collectByAttr(root, CONTRACT_GRANTS_NEEDS_ATTR).find((l) => l.getAttribute('data-entry') === toolKey);
  const needButton = (root: FakeEl, toolKey: string, needKey: string): FakeEl | undefined =>
    collectByAttr(needsLine(root, toolKey) ?? root, CONTRACT_GRANTS_NEED_ATTR)
      .find((b) => b.getAttribute('data-entry') === needKey);

  it('shows Recued’s title beside the id, and the whole sentence on hover', async () => {
    const { panel } = mountPanelWith({});
    await panel.whenLoaded();
    const cell = cellFor(opsRootEl(panel), opGrantEntry('core.work-entity.task.create'))!;
    expect(collectByAttr(cell, CONTRACT_GRANTS_TITLE_ATTR)[0]?.textContent).toBe('Create a task');
    // The id stays the name: it is what the docs and the MCP tool list call it.
    expect(allText(cell)).toContain('core.work-entity.task.create');
    expect(cell.title).toContain(KERNEL_OP_GUIDE['core.work-entity.task.create']!.summary);
    // The join the owner could not see, from the needed switch's side.
    expect(cell.title).toContain('AI tools that need this: work.create (to add tasks).');
    // get versus read, the question this started from: two different sentences.
    const get = cellFor(opsRootEl(panel), opGrantEntry('core.work-entity.get'))!;
    const read = cellFor(opsRootEl(panel), opGrantEntry('core.work-entity.read'))!;
    expect(get.title).toContain('Lets a recipe read one item');
    expect(read.title).toContain('Lets an AI read and search');
    expect(read.title).toContain('AI tools that need this: work.search, work.read.');
  });

  it('heads the AI tools group above every entity group, and says what the tools are', async () => {
    const { panel } = mountPanelWith({});
    await panel.whenLoaded();
    const root = opsRootEl(panel);
    expect(opsGroupNames(root)[0]).toBe(CONTRACT_GRANTS_AI_TOOLS_GROUP);
    expect(collectByAttr(root, CONTRACT_GRANTS_AI_TOOLS_NOTE_ATTR)[0]?.textContent).toBe(CONTRACT_GRANTS_AI_TOOLS_NOTE);
    const tools = panel.getEntries().filter((e) => e.group === CONTRACT_GRANTS_AI_TOOLS_GROUP);
    expect(tools.map((e) => e.label).sort()).toEqual([...TIER1_TOOL_NAMES].sort());
    // …and the steps stay under what they reach.
    const work = panel.getEntries().find((e) => e.entry_key === opGrantEntry('core.work-entity.task.create'));
    expect(work?.group).toBe('Tasks & notes');
  });

  it('tells an older contract that an AI tool switched on here does not reach its key', async () => {
    for (const [options, shown] of [
      [{ keyKeepsItsTools: true }, true],
      [{}, false],
      [{ keyAgreement: true }, false],
    ] as const) {
      const { panel } = mountPanelWith(options);
      await panel.whenLoaded();
      const notes = collectByAttr(opsRootEl(panel), CONTRACT_GRANTS_OLDER_KEY_NOTE_ATTR);
      expect(notes.map((n) => n.textContent)).toEqual(shown ? [CONTRACT_GRANTS_OLDER_KEY_NOTE] : []);
    }
  });

  it('lists what an AI tool needs, each one on or off, and a click switches it in place', async () => {
    const { panel, runGrantWrite } = mountPanelWith({ keyAgreement: true });
    await panel.whenLoaded();
    const root = opsRootEl(panel);
    const tool = primitiveGrantEntry('work.create');
    const buttons = collectByAttr(needsLine(root, tool)!, CONTRACT_GRANTS_NEED_ATTR);
    expect(buttons.map((b) => b.getAttribute('data-entry'))).toEqual([
      'core.work-entity.task.create',
      'core.work-entity.note.create',
      'core.work-entity.commitment.create',
      'core.work-entity.project.create',
      // D-325 — `work.create` adds things you own, so the asset create is a need too.
      'core.work-entity.asset.create',
    ]);
    expect(needButton(root, tool, 'core.work-entity.asset.create')?.textContent).toBe('+ Add a thing you own');
    const task = needButton(root, tool, 'core.work-entity.task.create')!;
    expect(task.getAttribute('data-effective')).toBe('off');
    expect(task.getAttribute('aria-pressed')).toBe('false');
    // Its title names the kind, so the condition is not repeated after it.
    expect(task.textContent).toBe('+ Create a task');

    task.click();
    await panel.whenLoaded();
    await tick(10);
    expect(runGrantWrite).toHaveBeenCalledWith({
      contract_id: 'door_x', entry_key: 'core.work-entity.task.create', granted: true,
    });
    const after = needButton(opsRootEl(panel), tool, 'core.work-entity.task.create')!;
    expect(after.getAttribute('data-effective')).toBe('on');
    expect(after.textContent).toBe('✓ Create a task');
    // The same switch as its own row, not a copy that could disagree with it.
    expect(panel.getEffective('core.work-entity.task.create')).toBe('on');
    expect(cellFor(opsRootEl(panel), 'core.work-entity.task.create')!.getAttribute('data-effective')).toBe('on');
  });

  it('shows a need that is a data switch, and a need that applies only sometimes', async () => {
    const { panel } = mountPanelWith({ keyAgreement: true });
    await panel.whenLoaded();
    const root = opsRootEl(panel);
    const mail = primitiveGrantEntry('mail.read');
    expect(needButton(root, mail, collectionGrantEntry('mail'))?.textContent).toBe('+ Your mail');
    expect(needButton(root, mail, collectionGrantEntry('file'))?.textContent).toBe('+ Your files (to list attachments)');
  });

  it('shows the note of a tool that checks no switch of its own', async () => {
    const { panel } = mountPanelWith({});
    await panel.whenLoaded();
    const line = needsLine(opsRootEl(panel), primitiveGrantEntry('recipe.run'))!;
    expect(collectByAttr(line, CONTRACT_GRANTS_NEED_ATTR)).toHaveLength(0);
    expect(allText(line)).toContain('unless the recipe is on under Recipes');
    // A tool with nothing to add gets no line at all.
    expect(needsLine(opsRootEl(panel), primitiveGrantEntry('recipe.stop'))).toBeUndefined();
  });

  it('shows a pack op’s own description on hover', async () => {
    const described: { ingredients: ReadonlyArray<CatalogIngredientView> } = {
      ingredients: [{
        ingredient_id: 'hubspot-catalog', name: 'HubSpot',
        operations: [{
          operation_id: READ_OP, operation_key: 'deal.read', risk_tier: 'read', groups: [],
          description: 'Read one HubSpot deal by id.',
        }],
      }],
    };
    const { panel } = mountPanelWith({ catalog: described });
    await panel.whenLoaded();
    const cell = cellFor(opsRootEl(panel), READ_OP)!;
    expect(cell.title).toBe('Read one HubSpot deal by id.');
    // No Recued title for a pack's own op: the id and the author's words are all.
    expect(collectByAttr(cell, CONTRACT_GRANTS_TITLE_ATTR)).toHaveLength(0);
  });

  it('finds a switch by its plain title', async () => {
    const { panel } = mountPanelWith({ operationFilterDebounceMs: 0 });
    await panel.whenLoaded();
    const root = opsRootEl(panel);
    const input = collectByAttr(root, CONTRACT_GRANTS_OP_FILTER_ATTR)[0]!;
    input.value = 'create a task';
    input.dispatch('input');
    expect(cellFor(root, opGrantEntry('core.work-entity.task.create'))).toBeDefined();
    expect(cellFor(root, WRITE_OP)).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// D-247 D11 — the op toggle stops lying
// ════════════════════════════════════════════════════════════════

/** ⛔⛔ AN OP CAN BE OFF AND STILL RUN INSIDE A GRANTED RECIPE (D-247 D2), so a
 *  row rendering a bare "off" is a FALSE STATEMENT — and the owner deciding
 *  whether to revoke is exactly the person it misleads.
 *
 *  The row carries BOTH halves or it is not worth rendering: the STATIC list
 *  ("which recipes could reach this") cannot tell a recipe that ran this morning
 *  from one that has not run since it was installed, and the count alone does not
 *  say what would break. Both are pinned below, along with the two absences that
 *  must NOT read as a zero. */
describe('D-247 D11 — the op row shows what a revoke would actually cost', () => {
  const usageFor = (
    row: { could: readonly string[]; count: number; recipes: readonly string[] },
    window_days = 30,
  ) => ({
    operations: [{ operation_id: WRITE_OP, ...row }],
    window_days,
    oldest_scanned_at: 1,
    underivable: [] as readonly string[],
  });
  const recipe = (recipe_id: string, name: string) => ({
    recipe_id, publisher_id: 'recued-core', source: 'pair-sync' as const,
    recipe: { metadata: { name } },
  });
  const RECIPES = [
    recipe('overdue-invoice-chase', 'Chase overdue invoices'),
    recipe('send-order-customer-reply-shopify', 'Reply to a Shopify customer'),
    recipe('reschedule-calendar-event', 'Reschedule a calendar event'),
  ];
  const ALLOW_CHASE = { 'recipe.recued-core/overdue-invoice-chase': true };

  const usedLine = (panel: { opsRoot: HTMLElement }): FakeEl | undefined =>
    collectByAttr(opsRootEl(panel), CONTRACT_GRANTS_STILL_USED_ATTR)[0];

  it('names the recipes ALLOWED HERE that could reach it, and the runs that DID', async () => {
    const { panel } = mountPanelWith({
      seed: { [WRITE_OP]: false, ...ALLOW_CHASE },
      recipes: RECIPES,
      usage: usageFor({
        could: ['overdue-invoice-chase', 'send-order-customer-reply-shopify'],
        count: 3,
        recipes: ['recued-core/overdue-invoice-chase'],
      }),
    });
    await panel.whenLoaded();
    const line = usedLine(panel);
    expect(line).toBeDefined();
    // The NAME the Recipes tab shows, not the id.
    expect(line!.textContent).toContain('Still runs inside a recipe allowed here: Chase overdue invoices.');
    expect(line!.textContent).toContain('Ran 3 times here in the last 30 days.');
    // The covering recipe is already named once; it is not named twice.
    expect(line!.textContent).not.toContain(', inside');
    // Structured, so a copy edit cannot silently drop one half.
    expect(line!.getAttribute('data-ran')).toBe('3');
    expect(line!.getAttribute('data-could')).toBe('recued-core/overdue-invoice-chase');
  });

  it('⛔ a recipe this agreement does not allow is never named, so the line does not appear', async () => {
    // THE OWNER'S REPORT (2026-10-24): "still used by: reschedule-calendar-event · not
    // run in the last 30 days" on almost every op they switched off. Coverage rides
    // the recipe grant of the agreement the run is made under, so a recipe this
    // agreement does not allow cannot run the op through it — naming it was false.
    const { panel } = mountPanelWith({
      seed: { [WRITE_OP]: false },
      recipes: RECIPES,
      usage: usageFor({ could: ['reschedule-calendar-event'], count: 0, recipes: [] }),
    });
    await panel.whenLoaded();
    expect(panel.getEffective('recipe.recued-core/reschedule-calendar-event')).toBe('off');
    expect(usedLine(panel)).toBeUndefined();
  });

  it('names only the allowed ones when several recipes could reach it', async () => {
    const { panel } = mountPanelWith({
      seed: {
        [WRITE_OP]: false,
        ...ALLOW_CHASE,
        'recipe.recued-core/reschedule-calendar-event': true,
      },
      recipes: RECIPES,
      usage: usageFor({
        could: ['overdue-invoice-chase', 'reschedule-calendar-event', 'send-order-customer-reply-shopify'],
        count: 0,
        recipes: [],
      }),
    });
    await panel.whenLoaded();
    const text = usedLine(panel)!.textContent!;
    expect(text).toContain(
      'Still runs inside 2 recipes allowed here: Chase overdue invoices, Reschedule a calendar event.',
    );
    expect(text).not.toContain('Shopify');
  });

  it('says the WINDOW when nothing ran — retention is not history', async () => {
    // ⛔ `data.audit` evicts oldest-first, so "not run in the last 30 days" is the
    // honest sentence and "never used" is a claim the instrument cannot make.
    const { panel } = mountPanelWith({
      seed: { [WRITE_OP]: false, ...ALLOW_CHASE },
      recipes: RECIPES,
      usage: usageFor({ could: ['overdue-invoice-chase'], count: 0, recipes: [] }),
    });
    await panel.whenLoaded();
    const line = usedLine(panel);
    expect(line!.textContent).toContain('Not run here in the last 30 days.');
    expect(line!.textContent).not.toContain('never');
  });

  it('shows runs here even when no allowed recipe is known to reach it', async () => {
    // A covered run is evidence on its own: a recipe whose steps could not be read
    // ahead of time still ran the op here, and the count says so.
    const { panel } = mountPanelWith({
      seed: { [WRITE_OP]: false },
      recipes: RECIPES,
      usage: usageFor({ could: [], count: 1, recipes: ['recued-core/overdue-invoice-chase'] }),
    });
    await panel.whenLoaded();
    expect(usedLine(panel)!.textContent).toBe(
      'Ran once here in the last 30 days, inside Chase overdue invoices.',
    );
  });

  it('carries the SERVER’s window, not a hardcoded 30', async () => {
    const { panel } = mountPanelWith({
      seed: { [WRITE_OP]: false },
      usage: usageFor({ could: [], count: 2, recipes: ['x/y'] }, 7),
    });
    await panel.whenLoaded();
    expect(usedLine(panel)!.textContent).toContain('last 7 days');
  });

  it('asks for THIS agreement’s runs, not every agreement’s', async () => {
    const { panel, runRecipeOpUsage } = mountPanelWith({
      contractId: 'door_x',
      usage: usageFor({ could: [], count: 0, recipes: [] }),
    });
    await panel.whenLoaded();
    expect(runRecipeOpUsage).toHaveBeenCalledWith({ contract_id: 'door_x' });
  });

  it('renders NOTHING when the evidence read FAILED — not a zero', async () => {
    // The absence that must not read as proof. A failed evidence read leaves the
    // grant matrix intact and the line absent, rather than asserting "0 runs".
    const { panel } = mountPanelWith({ seed: { [WRITE_OP]: false }, usageRejects: true });
    await panel.whenLoaded();
    expect(usedLine(panel)).toBeUndefined();
    // …and the matrix itself still rendered.
    expect(cellFor(opsRootEl(panel), WRITE_OP)).toBeDefined();
  });

  it('renders NOTHING when no usage caller is wired', async () => {
    const { panel } = mountPanelWith({ seed: { [WRITE_OP]: false } });
    await panel.whenLoaded();
    expect(usedLine(panel)).toBeUndefined();
  });

  it('renders NOTHING on a row whose grant is ON — the line is about a REVOKE', async () => {
    const { panel } = mountPanelWith({
      seed: { [WRITE_OP]: true, ...ALLOW_CHASE },
      recipes: RECIPES,
      usage: usageFor({ could: ['overdue-invoice-chase'], count: 3, recipes: ['recued-core/overdue-invoice-chase'] }),
    });
    await panel.whenLoaded();
    expect(usedLine(panel)).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════
// D-247 — the recipe axis reaches the page
// ════════════════════════════════════════════════════════════════

/** ⛔⛔ THE PANEL SEEDED `recipe.*` ROWS AND SHOWED NONE OF THEM. The gate read
 *  them, the seed wrote them, and `buildUniverse` never produced one — so the
 *  owner had a permission that existed in the store with no way to reach it.
 *  `buildUniverse`'s own doc states the rule it broke: "Add to both, or to
 *  neither." */
describe('D-247 — installed recipes are grantable on their own root', () => {
  const RECIPES = [
    {
      recipe_id: 'overdue-invoice-chase', publisher_id: 'recued-core',
      source: 'pair-sync' as const,
      recipe: { metadata: { name: 'Chase overdue invoices', description: 'nudges' } },
    },
    {
      recipe_id: 'run-ingredient', publisher_id: 'recued',   // KERNEL — excluded
      source: 'bundled' as const, recipe: { metadata: { name: 'Run ingredient' } },
    },
  ];
  const recipesRootEl = (panel: { recipesRoot: HTMLElement }): FakeEl =>
    panel.recipesRoot as unknown as FakeEl;

  it('renders a togglable cell per installed recipe, keyed recipe.<pub>/<id>', async () => {
    const { panel } = mountPanelWith({ recipes: RECIPES });
    await panel.whenLoaded();
    const cell = cellFor(recipesRootEl(panel), 'recipe.recued-core/overdue-invoice-chase');
    expect(cell).toBeDefined();
    expect(cell!.getAttribute('data-kind')).toBe('recipe');
    // The NAME, not the slug — the owner is deciding about a thing, not an id.
    expect(allText(cell!)).toContain('Chase overdue invoices');
  });

  it('⛔ defaults OFF — the one inverted author default (D7)', async () => {
    const { panel } = mountPanelWith({ recipes: RECIPES });
    await panel.whenLoaded();
    expect(panel.getEffective('recipe.recued-core/overdue-invoice-chase')).toBe('off');
  });

  it('reflects a stored grant, and toggling writes the recipe entry key', async () => {
    const { panel, store } = mountPanelWith({
      recipes: RECIPES,
      seed: { 'recipe.recued-core/overdue-invoice-chase': true },
    });
    await panel.whenLoaded();
    expect(panel.getEffective('recipe.recued-core/overdue-invoice-chase')).toBe('on');
    await panel.toggleEntry('recipe.recued-core/overdue-invoice-chase');
    expect(store.get('recipe.recued-core/overdue-invoice-chase')).toBe(false);
  });

  it('excludes KERNEL recipes — a switch whose effect is invisible is not a control', async () => {
    const { panel } = mountPanelWith({ recipes: RECIPES });
    await panel.whenLoaded();
    expect(cellFor(recipesRootEl(panel), 'recipe.recued/run-ingredient')).toBeUndefined();
  });

  it('keeps recipes OFF the Ops and Entities roots', async () => {
    // Its own question, its own vocabulary. Buried under Entities it stays
    // unfound, which is how it shipped invisible in the first place.
    const { panel } = mountPanelWith({ recipes: RECIPES });
    await panel.whenLoaded();
    const key = 'recipe.recued-core/overdue-invoice-chase';
    expect(cellFor(opsRootEl(panel), key)).toBeUndefined();
    expect(cellFor(entitiesRootEl(panel), key)).toBeUndefined();
  });

  it('with no recipe source the root says so rather than rendering empty', async () => {
    const { panel } = mountPanelWith({});
    await panel.whenLoaded();
    expect(allText(recipesRootEl(panel))).toContain('You have no Recipes yet');
  });
});

// ════════════════════════════════════════════════════════════════
// D-327 — one agreement, one key, one gate
// ════════════════════════════════════════════════════════════════

/** A fake key store behind the three key callers, so the Connect tab's key panel
 *  runs its real list → create → turn-off flow. */
const makeKeyStore = (seed: McpInboundTokenRecord[] = []) => {
  const tokens = [...seed];
  let seq = 0;
  const list = vi.fn(async () => ({ tokens: [...tokens] }));
  const issue = vi.fn(async (args: {
    label: string;
    contract_id: string;
    grants: Readonly<Record<string, boolean>>;
    concurrency_tier: 5;
    chat_mode: null;
  }) => {
    seq += 1;
    const record: McpInboundTokenRecord = {
      token_id: `tok_${seq}`,
      bearer_hash: 'hash',
      label: args.label,
      created_at: 1_000 + seq,
      revoked_at: null,
      grants: {},
      concurrency_tier: 5,
      chat_mode: null,
      contract_id: args.contract_id,
      updated_at: 1_000 + seq,
    };
    tokens.unshift(record);
    return { record, bearer_plaintext: `recued_secret_${seq}` };
  });
  const revoke = vi.fn(async ({ token_id }: { token_id: string }) => {
    const i = tokens.findIndex((t) => t.token_id === token_id);
    tokens[i] = { ...tokens[i]!, revoked_at: 9_999 };
    return { revoked: true, token: tokens[i]! };
  });
  return {
    tokens,
    list,
    issue,
    revoke,
    callers: {
      permissionsListInboundTokensCaller: list,
      permissionsIssueInboundTokenCaller: issue,
      permissionsRevokeInboundTokenCaller: revoke,
    },
  };
};

const keyToken = (overrides: Partial<McpInboundTokenRecord> = {}): McpInboundTokenRecord => ({
  token_id: 'tok_existing',
  bearer_hash: 'hash',
  label: 'Alpha agent',
  created_at: 500,
  revoked_at: null,
  grants: {},
  concurrency_tier: 5,
  chat_mode: null,
  contract_id: 'door_alpha',
  updated_at: 500,
  ...overrides,
});

describe('D-327 — an agreement is its key\'s whole authority', () => {
  const KEY_AGREEMENT = agentContract({ key_authority: 'contract' });

  it('gives such an agreement a Recipes tab, grants that start off, and no switch a key can never use', async () => {
    const ctx = mountRoute('door_alpha', { contracts: [KEY_AGREEMENT] });
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    expect(collectByAttr(root, CONTRACTS_ROUTE_TAB_ATTR).map((t) => t.getAttribute('data-tab')))
      .toEqual(['connect', 'ops', 'entities', 'recipes']);

    tabBtn(root, 'ops').click();
    const panel = ctx.route.contractGrantsPanel()!;
    await panel.whenLoaded();
    await tick();
    // A read the older wildcard model admits by default is OFF here: the
    // agreement is the whole gate, so nothing is allowed until switched on.
    expect(panel.getEffective(opGrantEntry('core.data.calendar.list'))).toBe('off');
    expect(panel.getEffective(primitiveGrantEntry('mail.search'))).toBe('off');
    expect(panel.getEffective(collectionGrantEntry('mail'))).toBe('off');
    // A kernel op kept off every door is not offered at all.
    expect(cellFor(opsRootEl(panel), opGrantEntry('core.ai.summarize'))).toBeUndefined();
    expect(cellFor(opsRootEl(panel), opGrantEntry('core.data.calendar.list'))).toBeDefined();
    // Its key reads its tools from these switches, so the older-key line is not shown.
    expect(collectByAttr(opsRootEl(panel), CONTRACT_GRANTS_OLDER_KEY_NOTE_ATTR)).toHaveLength(0);
  });

  it('keeps an older agreement on its old defaults and its old tabs', async () => {
    const ctx = mountRoute('door_alpha');
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    expect(collectByAttr(root, CONTRACTS_ROUTE_TAB_ATTR).map((t) => t.getAttribute('data-tab')))
      .toEqual(['connect', 'ops', 'entities']);
    tabBtn(root, 'ops').click();
    const panel = ctx.route.contractGrantsPanel()!;
    await panel.whenLoaded();
    expect(panel.getEffective(opGrantEntry('core.data.calendar.list'))).toBe('on');
    expect(cellFor(opsRootEl(panel), opGrantEntry('core.ai.summarize'))).toBeDefined();
    // Its key keeps the tools it was made with, and the AI tools group says so.
    expect(collectByAttr(opsRootEl(panel), CONTRACT_GRANTS_OLDER_KEY_NOTE_ATTR).map((n) => n.textContent))
      .toEqual([CONTRACT_GRANTS_OLDER_KEY_NOTE]);
  });

  it('creates this agreement\'s key with its id and nothing else, shows it once, and turns it off', async () => {
    const keys = makeKeyStore([keyToken({ token_id: 'tok_other', contract_id: 'door_beta' })]);
    const ctx = mountRoute('door_alpha', { contracts: [KEY_AGREEMENT], keyCallers: keys.callers });
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    const keyPanel = ctx.route.contractKeyPanel()!;
    await keyPanel.whenLoaded();
    // Another agreement's key is not this agreement's key.
    expect(keyPanel.getState()).toBe('none');

    collectByAttr(root, CONTRACT_KEY_CREATE_ATTR)[0]!.click();
    await tick(10);
    expect(keys.issue).toHaveBeenCalledWith({
      label: 'Alpha agent',
      contract_id: 'door_alpha',
      grants: {},
      concurrency_tier: 5,
      chat_mode: null,
    });
    expect(keyPanel.getState()).toBe('active');
    expect(collectByAttr(root, CONTRACT_KEY_VALUE_ATTR)[0]?.textContent).toBe('recued_secret_1');

    collectByAttr(root, CONTRACT_KEY_TURN_OFF_ATTR)[0]!.click();
    expect(keys.revoke).not.toHaveBeenCalled();
    expect(allText(root)).toContain('Every app using this key stops working at once');
    collectByAttr(root, CONTRACT_KEY_CONFIRM_ATTR)[0]!.click();
    await tick(10);
    expect(keys.revoke).toHaveBeenCalledWith({ token_id: 'tok_1' });
    expect(keys.revoke).toHaveBeenCalledTimes(1);
    expect(keyPanel.getState()).toBe('none');
    expect(collectByAttr(root, CONTRACT_KEY_VALUE_ATTR)).toHaveLength(0);
  });

  it('shows a key made elsewhere without its value', async () => {
    const keys = makeKeyStore([keyToken()]);
    const ctx = mountRoute('door_alpha', { contracts: [KEY_AGREEMENT], keyCallers: keys.callers });
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    await ctx.route.contractKeyPanel()!.whenLoaded();
    expect(ctx.route.contractKeyPanel()!.getState()).toBe('active');
    expect(collectByAttr(root, CONTRACT_KEY_VALUE_ATTR)).toHaveLength(0);
    expect(allText(root)).toContain('Recued shows a key only once');
    expect(collectByAttr(root, CONTRACT_KEY_CREATE_ATTR)).toHaveLength(0);
  });

  it('a late key lookup cannot revive a key superseded by a newer read', async () => {
    const keys = makeKeyStore([keyToken()]);
    const ctx = mountRoute('door_alpha', { contracts: [KEY_AGREEMENT], keyCallers: keys.callers });
    await ctx.route.whenLoaded();
    const panel = ctx.route.contractKeyPanel()!;
    await panel.whenLoaded();
    const replies: Array<(result: { tokens: McpInboundTokenRecord[] }) => void> = [];
    keys.list.mockImplementation(() => new Promise(resolve => { replies.push(resolve); }));
    const older = panel.refresh(), newer = panel.refresh();
    replies[1]!({ tokens: [] });
    await newer;
    expect(panel.getState()).toBe('none');
    replies[0]!({ tokens: [keyToken()] });
    await older;
    expect(panel.getState()).toBe('none');
    expect(collectByAttr(ctx.root as unknown as FakeEl, CONTRACT_KEY_TURN_OFF_ATTR)).toHaveLength(0);
    ctx.route.dispose();
  });

  it('keeps each legacy key off after a later revoke and the follow-up read fail', async () => {
    const keys = makeKeyStore([
      keyToken({ token_id: 'newer', created_at: Date.parse('2023-06-15T12:00:00Z') }),
      keyToken({ token_id: 'older', created_at: Date.parse('2020-06-15T12:00:00Z') }),
      keyToken({ token_id: 'another-contract', contract_id: 'door_beta' }),
    ]);
    const read = keys.list.getMockImplementation()!;
    const revoke = keys.revoke.getMockImplementation()!;
    const ctx = mountRoute('door_alpha', { contracts: [KEY_AGREEMENT], keyCallers: keys.callers });
    await ctx.route.whenLoaded();
    const panel = ctx.route.contractKeyPanel()!;
    await panel.whenLoaded();
    keys.list.mockRejectedValue(new Error('Read unavailable'));
    keys.revoke.mockImplementationOnce(revoke).mockRejectedValueOnce(new Error('Second revoke unavailable'));
    const root = panel.root as unknown as FakeEl;
    collectByAttr(root, CONTRACT_KEY_TURN_OFF_ATTR)[0]!.click();
    collectByAttr(root, CONTRACT_KEY_CONFIRM_ATTR)[0]!.click();
    await tick(20);
    expect(panel.getState()).toBe('active');
    expect(allText(root)).toContain('2020');
    expect(allText(root)).not.toContain('2023');
    collectByAttr(root, CONTRACT_KEY_TURN_OFF_ATTR)[0]!.click();
    expect(keys.revoke).toHaveBeenCalledTimes(2);
    keys.list.mockImplementation(read);
    await panel.refresh();
    collectByAttr(root, CONTRACT_KEY_TURN_OFF_ATTR)[0]!.click();
    collectByAttr(root, CONTRACT_KEY_CONFIRM_ATTR)[0]!.click();
    await tick(20);
    expect(keys.revoke.mock.calls.map(([args]) => args.token_id)).toEqual(['newer', 'older', 'older']);
    expect(keys.tokens.find(token => token.token_id === 'another-contract')?.revoked_at).toBeNull();
    expect(panel.getState()).toBe('none');
    ctx.route.dispose();
  });

  it('offers an older agreement no new key, but lets its existing key be turned off', async () => {
    const empty = makeKeyStore();
    const older = mountRoute('door_alpha', { keyCallers: empty.callers });
    await older.route.whenLoaded();
    await older.route.contractKeyPanel()!.whenLoaded();
    const olderRoot = older.root as unknown as FakeEl;
    expect(collectByAttr(olderRoot, CONTRACT_KEY_CREATE_ATTR)).toHaveLength(0);
    expect(allText(olderRoot)).toContain('made before a contract could hold its own key');

    const withKey = makeKeyStore([keyToken()]);
    const ctx = mountRoute('door_alpha', { keyCallers: withKey.callers });
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    await ctx.route.contractKeyPanel()!.whenLoaded();
    collectByAttr(root, CONTRACT_KEY_TURN_OFF_ATTR)[0]!.click();
    collectByAttr(root, CONTRACT_KEY_CONFIRM_ATTR)[0]!.click();
    await tick(10);
    expect(withKey.revoke).toHaveBeenCalledWith({ token_id: 'tok_existing' });
  });

  it('moves the rules for every agreement off the Connect tab and onto the list page', async () => {
    const detail = mountRoute('door_alpha', {
      contracts: [KEY_AGREEMENT],
      keyCallers: makeKeyStore().callers,
      withRules: true,
    });
    await detail.route.whenLoaded();
    expect(collectByAttr(detail.root as unknown as FakeEl, PERMISSIONS_PANEL_HOST_ATTR)).toHaveLength(0);
    expect(collectByAttr(detail.root as unknown as FakeEl, CONTRACTS_ROUTE_RULES_ATTR)).toHaveLength(0);

    const list = mountRoute(undefined, { initialListTab: 'others', withRules: true });
    const root = list.root as unknown as FakeEl;
    await list.route.whenLoaded();
    const section = collectByAttr(root, CONTRACTS_ROUTE_RULES_ATTR)[0]!;
    expect(allText(section)).toContain('Rules for every contract');
    // Loaded on first open, not with every list paint.
    expect(list.route.rulesPanel()).toBeNull();
    (section as unknown as { open: boolean }).open = true;
    section.dispatch('toggle');
    expect(list.route.rulesPanel()).not.toBeNull();
    expect(collectByAttr(section, PERMISSIONS_PANEL_HOST_ATTR)).toHaveLength(1);
  });

  describe('limits, edited in place', () => {
    const echo = (args: SetContractLimitsRequest): Promise<ContractDefinitionView> =>
      Promise.resolve(agentContract({
        key_authority: 'contract',
        ...(args.max_uses !== null ? { max_uses: args.max_uses, uses_remaining: args.max_uses } : {}),
        ...(args.max_uses !== null && args.use_period !== 'total' ? { use_period: args.use_period } : {}),
        ...(args.expiry_at !== null ? { expiry_at: args.expiry_at } : {}),
      }));

    it('opens on the current limit, saves in place, and shows the new one', async () => {
      const setLimitsImpl = vi.fn(echo);
      const ctx = mountRoute('door_alpha', {
        contracts: [agentContract({ key_authority: 'contract', max_uses: 5, uses_remaining: 5 })],
        setLimitsImpl,
      });
      const root = ctx.root as unknown as FakeEl;
      await ctx.route.whenLoaded();
      collectByAttr(root, CONTRACTS_ROUTE_LIMITS_EDIT_ATTR)[0]!.click();
      const cap = collectByAttr(root, CONTRACTS_ROUTE_LIMITS_CAP_ATTR)[0]!;
      expect(cap.value).toBe('5');
      expect(ctx.doc.activeElement).toBe(cap);
      cap.value = '100';
      cap.dispatch('input');
      const period = collectByAttr(root, CONTRACTS_ROUTE_LIMITS_PERIOD_ATTR)[0]!;
      period.value = 'month';
      period.dispatch('change');
      collectByAttr(root, CONTRACTS_ROUTE_LIMITS_SAVE_ATTR)[0]!.click();
      await tick(10);
      expect(setLimitsImpl).toHaveBeenCalledWith({
        contract_id: 'door_alpha',
        max_uses: 100,
        use_period: 'month',
        expiry_at: null,
      });
      expect(collectByAttr(root, CONTRACTS_ROUTE_LIMITS_FORM_ATTR)).toHaveLength(0);
      expect(allText(root)).toContain('100 of 100 uses left');
      expect(ctx.doc.activeElement).toBe(collectByAttr(root, CONTRACTS_ROUTE_LIMITS_EDIT_ATTR)[0]);
    });

    it('sends a cleared limit as no count and one budget', async () => {
      const setLimitsImpl = vi.fn(echo);
      const ctx = mountRoute('door_alpha', {
        contracts: [agentContract({ key_authority: 'contract', max_uses: 5, uses_remaining: 5, use_period: 'month' })],
        setLimitsImpl,
      });
      const root = ctx.root as unknown as FakeEl;
      await ctx.route.whenLoaded();
      collectByAttr(root, CONTRACTS_ROUTE_LIMITS_EDIT_ATTR)[0]!.click();
      const cap = collectByAttr(root, CONTRACTS_ROUTE_LIMITS_CAP_ATTR)[0]!;
      cap.value = '';
      cap.dispatch('input');
      collectByAttr(root, CONTRACTS_ROUTE_LIMITS_SAVE_ATTR)[0]!.click();
      await tick(10);
      expect(setLimitsImpl).toHaveBeenCalledWith({
        contract_id: 'door_alpha',
        max_uses: null,
        use_period: 'total',
        expiry_at: null,
      });
      expect(allText(root)).toContain('as many times as you like');
    });

    it('refuses a bad limit before calling, and Cancel changes nothing', async () => {
      const setLimitsImpl = vi.fn(echo);
      const ctx = mountRoute('door_alpha', { contracts: [agentContract({ key_authority: 'contract' })], setLimitsImpl });
      const root = ctx.root as unknown as FakeEl;
      await ctx.route.whenLoaded();
      collectByAttr(root, CONTRACTS_ROUTE_LIMITS_EDIT_ATTR)[0]!.click();
      const cap = collectByAttr(root, CONTRACTS_ROUTE_LIMITS_CAP_ATTR)[0]!;
      cap.value = '0';
      cap.dispatch('input');
      collectByAttr(root, CONTRACTS_ROUTE_LIMITS_SAVE_ATTR)[0]!.click();
      await tick();
      expect(setLimitsImpl).not.toHaveBeenCalled();
      expect(collectByAttr(root, CONTRACTS_ROUTE_LIMITS_ERROR_ATTR)[0]?.textContent)
        .toBe('The limit has to be a whole number above zero.');
      collectByAttr(root, CONTRACTS_ROUTE_LIMITS_CANCEL_ATTR)[0]!.click();
      expect(collectByAttr(root, CONTRACTS_ROUTE_LIMITS_FORM_ATTR)).toHaveLength(0);
      expect(setLimitsImpl).not.toHaveBeenCalled();
    });

    it('is not offered on yourself, a public door or a revoked agreement', async () => {
      for (const [id, contracts] of [
        [OWNER_CONTRACT_ID, undefined],
        ['door_rcpt', [agentContract({ contract_id: 'door_rcpt', door_types: ['reception'] })]],
        ['door_alpha', [agentContract({ lifecycle_state: 'revoked', revoked_at: 5 })]],
      ] as const) {
        const ctx = mountRoute(id, {
          ...(contracts !== undefined ? { contracts } : {}),
          setLimitsImpl: echo,
        });
        await ctx.route.whenLoaded();
        expect(collectByAttr(ctx.root as unknown as FakeEl, CONTRACTS_ROUTE_LIMITS_EDIT_ATTR)).toHaveLength(0);
        ctx.route.dispose();
      }
    });
  });
});
