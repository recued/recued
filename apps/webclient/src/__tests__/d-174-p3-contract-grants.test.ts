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
  CONTRACT_GRANTS_CELL_TOGGLE_ATTR,
  CONTRACT_GRANTS_EMPTY_ATTR,
  CONTRACT_GRANTS_ERROR_ATTR,
  CONTRACT_GRANTS_HOST_ATTR,
  CONTRACT_GRANTS_KIND_GROUP_ATTR,
  CONTRACT_GRANTS_OP_FILTER_ATTR,
  CONTRACT_GRANTS_OP_FILTER_STATUS_ATTR,
  CONTRACT_GRANTS_RISK_ATTR,
  CONTRACT_GRANTS_SOURCE_ATTR,
  CONTRACT_GRANTS_SUMMARY_ATTR,
  mountContractGrantsPanel,
  type GrantCatalogOperationsCaller,
  type GrantReadCaller,
  type GrantRegistryDescribeCaller,
  type GrantWriteCaller,
} from '../contracts/contract-grants-panel.js';
import {
  bootstrapContractsRoute,
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
  KERNEL_OP_REGISTRY,
  OWNER_CONTRACT_ID,
  READABLE_COLLECTIONS,
  TIER1_TOOL_NAMES,
  collectionGrantEntry,
  opGrantEntry,
  primitiveGrantEntry,
  topicGrantEntry,
  type CatalogIngredientView,
  type ContractDefinitionView,
  type DoorType,
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

  const doc = makeFakeDocument();
  const panel = mountContractGrantsPanel({
    document: doc as unknown as Document,
    contractId: opts.contractId ?? 'door_x',
    runGrantRead,
    runGrantWrite,
    ...(opts.explicitGrantRowsOnly === true ? { explicitGrantRowsOnly: true } : {}),
    ...(opts.withCatalog === false ? {} : { runCatalogOperations }),
    ...(opts.withRegistry === false ? {} : { runRegistryDescribe }),
    ...(opts.withCliList === false ? {} : { runCliReachabilityList }),
    ...(opts.withCliSet === false ? {} : { runCliReachabilitySet }),
    ...(opts.operationFilterDebounceMs !== undefined
      ? { operationFilterDebounceMs: opts.operationFilterDebounceMs }
      : {}),
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
    expect(chip!.textContent).toContain('also reads: team');

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
  it('routes op entries to opsRoot and collections + topics to entitiesRoot', async () => {
    const { panel } = mountPanelWith();
    await panel.whenLoaded();

    const opsKinds = collectByAttr(opsRootEl(panel), CONTRACT_GRANTS_KIND_GROUP_ATTR).map((g) =>
      g.getAttribute('data-kind'),
    );
    expect(opsKinds).toEqual(['op']);
    // ops = kernel ops + the two pack ops; the read op + write op both appear.
    expect(cellFor(opsRootEl(panel), READ_OP)).toBeDefined();
    expect(cellFor(opsRootEl(panel), WRITE_OP)).toBeDefined();
    // no op cell leaks into entities; no collection/topic into ops.
    expect(cellFor(opsRootEl(panel), collectionGrantEntry('mail'))).toBeUndefined();
    expect(cellFor(entitiesRootEl(panel), READ_OP)).toBeUndefined();

    const entityKinds = collectByAttr(
      entitiesRootEl(panel),
      CONTRACT_GRANTS_KIND_GROUP_ATTR,
    ).map((g) => g.getAttribute('data-kind'));
    expect(entityKinds).toEqual(['collection', 'topic']);
    expect(cellFor(entitiesRootEl(panel), collectionGrantEntry('mail'))).toBeDefined();
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
});

describe('contract-grants panel — write / reconcile + chrome', () => {
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
    expect(note?.textContent).toContain('Access');
    expect(note?.textContent).toContain('do not vary by contract');
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
    // entities total = collections + 2 topics. D-187 slice 5: on a door every normal
    // READABLE_COLLECTION is ON (admit-all-then-narrow); the two owner-only raw
    // collections are OFF, and of the 2 topics only the public one is on.
    const grantedEntities = READABLE_COLLECTIONS.length - OWNER_ONLY_COLLECTIONS.length + 1;
    expect(entSummary?.textContent).toBe(
      `${grantedEntities} of ${READABLE_COLLECTIONS.length + 2} granted`,
    );
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
    // entities still has the collections, but the topics kind-group is absent.
    expect(
      collectByAttr(entitiesRootEl(panel), CONTRACT_GRANTS_KIND_GROUP_ATTR).map((g) =>
        g.getAttribute('data-kind'),
      ),
    ).toEqual(['collection']);
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
    // Kernel ops + collections are compiled-in, so ops + entities both have
    // content; assert the empty note appears only where a kind is truly absent.
    const { panel } = mountPanelWith({ withCatalog: false, withRegistry: false });
    await panel.whenLoaded();
    // entities still has collections → no empty note.
    expect(collectByAttr(entitiesRootEl(panel), CONTRACT_GRANTS_EMPTY_ATTR)).toHaveLength(0);
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

  it('self DETAIL gets Ops/Entities via grant.read with no Connect/door/Revoke', async () => {
    const ctx = mountRoute(OWNER_CONTRACT_ID);
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();
    await ctx.route.contractGrantsPanel()?.whenLoaded();
    await tick();

    const tabIds = collectByAttr(root, CONTRACTS_ROUTE_TAB_ATTR).map((t) =>
      t.getAttribute('data-tab'),
    );
    expect(tabIds).toEqual(['ops', 'entities']);
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
    expect(allText(tabBodyEl(root))).toContain('Per-operation grants');
  });
});

describe('contracts route delta 3 — header door toggle (L1)', () => {
  it('toggling a door type calls setDoorTypes + reconciles the backed state in place', async () => {
    const ctx = mountRoute('door_alpha');
    const root = ctx.root as unknown as FakeEl;
    await ctx.route.whenLoaded();

    // wildcard door (no door_types) backs every door — all checked, none locked.
    expect(doorToggle(root, 'mcp').getAttribute('data-backed')).toBe('true');
    expect(doorToggle(root, 'mcp_chat').getAttribute('data-backed')).toBe('true');
    expect(doorToggle(root, 'llm_gateway').getAttribute('data-backed')).toBe('true');

    doorInput(doorToggle(root, 'mcp')).dispatch('change');
    await tick();
    expect(ctx.grantSetDoorTypesCaller).toHaveBeenCalledWith({
      contract_id: 'door_alpha',
      door_types: ['mcp_chat', 'llm_gateway'],
    });
    // header re-rendered: mcp un-backed; two doors remain backed and editable.
    expect(doorToggle(root, 'mcp').getAttribute('data-backed')).toBe('false');
    expect(doorToggle(root, 'mcp_chat').getAttribute('data-backed')).toBe('true');
    expect(doorToggle(root, 'llm_gateway').getAttribute('data-backed')).toBe('true');
    expect(doorInput(doorToggle(root, 'mcp_chat')).hasAttribute('disabled')).toBe(false);
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
    // mcp + mcp_chat backed; toggling llm_gateway ON → backs all → sent as [].
    doorInput(doorToggle(root, 'llm_gateway')).dispatch('change');
    await tick();
    expect(ctx.grantSetDoorTypesCaller).toHaveBeenCalledWith({
      contract_id: 'door_alpha',
      door_types: [],
    });
    expect(doorToggle(root, 'mcp').getAttribute('data-backed')).toBe('true');
    expect(doorToggle(root, 'mcp_chat').getAttribute('data-backed')).toBe('true');
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
