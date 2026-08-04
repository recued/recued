/** Packs R22 R3b - bulk access affordances in the by-PACK Access panel.
 *
 *  Self-contained fake-DOM suite cribbed from packs-r3-access-panel.test.ts.
 *  These tests pin only the R3b bulk conveniences: derived scope radios,
 *  per-contract all-ops selects, the add-to-contract picker, writer-gating,
 *  pack-scoped disclosure state, and bulk pending disabled states. */

import { describe, expect, it, vi } from 'vitest';

import {
  createPackAccessController,
  PACK_ACCESS_ADD_ATTR,
  PACK_ACCESS_ADD_EMPTY_ATTR,
  PACK_ACCESS_ADD_PICKER_ATTR,
  PACK_ACCESS_ALL_OPS_ATTR,
  PACK_ACCESS_ATTR,
  PACK_ACCESS_CELL_TOGGLE_ATTR,
  PACK_ACCESS_CONTRACT_ATTR,
  PACK_ACCESS_CONTRACT_TOGGLE_ATTR,
  PACK_ACCESS_SCOPE_ATTR,
  PACK_ACCESS_SCOPE_RADIO_ATTR,
  type PackAccessController,
} from '../settings/pack-access-controls.js';
import type {
  GrantCatalogOperationsCaller,
  GrantCliReachabilityListCaller,
  GrantCliReachabilitySetCaller,
  GrantContractsCaller,
  GrantReadCaller,
  GrantWriteCaller,
} from '../contracts/contract-grants-panel.js';
import {
  OWNER_CONTRACT_ID,
  type BulkPackManifest,
  type CatalogIngredientView,
  type ContractDefinitionView,
  type PackListEntry,
} from '@recued/contracts';

// ------------------------------------------------------------------
// Fake DOM (mirrors the sibling packs-panel test harness shape)
// ------------------------------------------------------------------

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  checked: boolean;
  value: string;
  className: string;
  id: string;
  type: string;
  title: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  removeEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    checked: false,
    value: '',
    className: '',
    id: '',
    type: '',
    title: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => {
      attrs.set(k, v);
      if (k === 'disabled') el.disabled = true;
      if (k === 'value') el.value = v;
      if (k === 'type') el.type = v;
      if (k === 'id') el.id = v;
    },
    removeAttribute: (k) => {
      attrs.delete(k);
      if (k === 'disabled') el.disabled = false;
      if (k === 'value') el.value = '';
      if (k === 'type') el.type = '';
      if (k === 'id') el.id = '';
    },
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    removeChild: (target) => {
      const idx = children.indexOf(target);
      if (idx < 0) throw new Error('removeChild: not a child');
      children.splice(idx, 1);
      target.parent = null;
      return target;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    remove: () => {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    removeEventListener: (name, fn) => {
      const arr = listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    click: () => {
      if (el.disabled || el.attrs.has('disabled')) return;
      for (const fn of [...(listeners.get('click') ?? [])]) fn({ target: el });
    },
  };
  return el;
};

const makeFakeDocument = () => ({
  createElement: (tag: string) => makeFakeElement(tag),
});

const findAllByAttr = (root: FakeElement, attr: string): FakeElement[] => {
  const out: FakeElement[] = [];
  const walk = (n: FakeElement): void => {
    if (n.hasAttribute(attr)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};
const findByAttr = (root: FakeElement, attr: string): FakeElement | null =>
  findAllByAttr(root, attr)[0] ?? null;
const findByAttrValue = (
  root: FakeElement,
  attr: string,
  value: string,
): FakeElement | null =>
  findAllByAttr(root, attr).find((e) => e.getAttribute(attr) === value) ?? null;
const findAllByTag = (root: FakeElement, tagName: string): FakeElement[] => {
  const out: FakeElement[] = [];
  const want = tagName.toUpperCase();
  const walk = (n: FakeElement): void => {
    if (n.tagName === want) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};
const collectTextContent = (root: FakeElement): string => {
  let out = root.textContent ?? '';
  for (const c of root.children) out += collectTextContent(c);
  return out;
};
/** Fire a checkbox/select/radio's `change` listeners (fake `click()` only fires `click`). */
const fireChange = (el: FakeElement): void => {
  if (el.attrs.has('disabled')) return;
  for (const fn of [...(el.listeners.get('change') ?? [])]) fn({ target: el });
};
const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

/** A pack manifest whose ONE composition (slug `<slug>-comp`) is the catalog
 *  membership link - the catalog fixture below uses the same ingredient_id. */
const packManifest = (slug: string): BulkPackManifest =>
  ({
    manifest_version: 2,
    slug,
    publisher: 'recued-core',
    name: slug,
    description: 'Access panel bulk test pack.',
    version: 1,
    recipes: [],
    requires: ['install_bulk_pack'],
    tags: [],
    contents: [
      {
        type: 'composition',
        composition: {
          schema_version: 1,
          slug: `${slug}-comp`,
          ingredients: [],
          operations: [],
        },
      },
    ],
  }) as unknown as BulkPackManifest;

const packEntry = (slug: string): PackListEntry => {
  const manifest = packManifest(slug);
  return {
    slug,
    publisher: manifest.publisher,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    pre_install: false,
    installed: true,
    requires: [...manifest.requires],
    recipe_count: 0,
    recipe_refs: manifest.recipes.map((r) => ({ slug: r.slug, version: r.version })),
    body_visibility_grant_keys: [...(manifest.mcp_body_visibility_grants ?? [])],
    ...(typeof manifest.service_kind === 'string' ? { service_kind: manifest.service_kind } : {}),
    ...(typeof manifest.repo === 'string' ? { repo: manifest.repo } : {}),
    body_visibility_grant_count: 0,
    manifest,
  } as PackListEntry;
};

const packEntryWithCompositions = (
  slug: string,
  compositionSlugs: string[],
): PackListEntry => {
  const base = packEntry(slug);
  return {
    ...base,
    manifest: {
      ...base.manifest,
      contents: compositionSlugs.map((compositionSlug) => ({
        type: 'composition',
        composition: {
          schema_version: 1,
          slug: compositionSlug,
          ingredients: [],
          operations: [],
        },
      })),
    } as unknown as BulkPackManifest,
  } as PackListEntry;
};

/** The catalog: one CONNECTION ingredient for `stripe-pack-comp` (a read + a
 *  write op) and one CLI ingredient for `tools-pack-comp`. */
const CATALOG: { ingredients: ReadonlyArray<CatalogIngredientView> } = {
  ingredients: [
    {
      ingredient_id: 'stripe-pack-comp',
      name: 'Stripe Pack',
      kind: 'connection',
      operations: [
        {
          operation_id: 'acme/invoice.read',
          operation_key: 'invoice.read',
          risk_tier: 'read',
          groups: [],
        },
        {
          operation_id: 'acme/invoice.create',
          operation_key: 'invoice.create',
          risk_tier: 'write',
          groups: [],
        },
      ],
    },
    {
      ingredient_id: 'tools-pack-comp',
      name: 'Tools Pack',
      kind: 'cli',
      operations: [
        {
          operation_id: 'acme/audio.transcribe',
          operation_key: 'audio.transcribe',
          risk_tier: 'read',
          groups: [],
        },
      ],
    },
  ] as unknown as CatalogIngredientView[],
};

const STRIPE_READ = 'acme/invoice.read';
const STRIPE_WRITE = 'acme/invoice.create';
const TOOLS_CLI = 'acme/audio.transcribe';

const door = (
  contract_id: string,
  lifecycle_state: 'active' | 'revoked' = 'active',
  grant_kind?: ContractDefinitionView['grant_kind'],
): ContractDefinitionView =>
  ({
    contract_id,
    display_name: `Door ${contract_id}`,
    lifecycle_state,
    ...(grant_kind !== undefined ? { grant_kind } : {}),
  }) as unknown as ContractDefinitionView;

interface Harness {
  runListContracts: ReturnType<typeof vi.fn<GrantContractsCaller>>;
  runGrantRead: ReturnType<typeof vi.fn<GrantReadCaller>>;
  runGrantWrite: ReturnType<typeof vi.fn<GrantWriteCaller>>;
  runCatalogOperations: ReturnType<typeof vi.fn<GrantCatalogOperationsCaller>>;
  runCliReachabilityList: ReturnType<typeof vi.fn<GrantCliReachabilityListCaller>>;
  runCliReachabilitySet: ReturnType<typeof vi.fn<GrantCliReachabilitySetCaller>>;
}

const makeCallers = (state: {
  contracts?: ContractDefinitionView[];
  grants?: Record<string, Array<{ entry_key: string; granted: boolean }>>;
  cliRows?: Array<{
    principal: string;
    ingredient_id: string;
    operation_id: string;
    allowed: boolean;
  }>;
}): Harness => {
  const runListContracts = vi.fn<GrantContractsCaller>(async () => ({
    contracts: state.contracts ?? [],
  }));
  const runGrantRead = vi.fn<GrantReadCaller>(async ({ contract_id }) => ({
    grants: (state.grants?.[contract_id] ?? []).map((g) => ({
      ...g,
      set_at: 1,
    })),
  }));
  const runGrantWrite = vi.fn<GrantWriteCaller>(async (args) => {
    const rows = state.grants ?? (state.grants = {});
    const list = rows[args.contract_id] ?? (rows[args.contract_id] = []);
    const existing = list.find((g) => g.entry_key === args.entry_key);
    if (existing) existing.granted = args.granted === true;
    else list.push({ entry_key: args.entry_key, granted: args.granted === true });
    return { ok: true as const, granted: args.granted };
  });
  const runCatalogOperations = vi.fn<GrantCatalogOperationsCaller>(
    async () => CATALOG,
  );
  const runCliReachabilityList = vi.fn<GrantCliReachabilityListCaller>(
    async () => ({ rows: state.cliRows ?? [] }),
  );
  const runCliReachabilitySet = vi.fn<GrantCliReachabilitySetCaller>(
    async (args) => {
      // The panel always passes the explicit principal (= contractId).
      const principal = args.principal ?? OWNER_CONTRACT_ID;
      const rows = state.cliRows ?? (state.cliRows = []);
      const existing = rows.find(
        (r) =>
          r.principal === principal
          && r.ingredient_id === args.ingredient_id
          && r.operation_id === args.operation_id,
      );
      if (existing) existing.allowed = args.allowed;
      else {
        rows.push({
          principal,
          ingredient_id: args.ingredient_id,
          operation_id: args.operation_id,
          allowed: args.allowed,
        });
      }
      return {
        principal,
        ingredient_id: args.ingredient_id,
        operation_id: args.operation_id,
        allowed: args.allowed,
      };
    },
  );
  return {
    runListContracts,
    runGrantRead,
    runGrantWrite,
    runCatalogOperations,
    runCliReachabilityList,
    runCliReachabilitySet,
  };
};

const mountController = (
  h: Harness,
  opts: { grantWrite?: boolean; cliSet?: boolean } = {},
) => {
  const doc = makeFakeDocument();
  const onChange = vi.fn();
  const ctrl = createPackAccessController({
    document: doc as unknown as Document,
    runListContracts: h.runListContracts,
    runGrantRead: h.runGrantRead,
    ...(opts.grantWrite === false ? {} : { runGrantWrite: h.runGrantWrite }),
    runCatalogOperations: h.runCatalogOperations,
    runCliReachabilityList: h.runCliReachabilityList,
    ...(opts.cliSet === false ? {} : { runCliReachabilitySet: h.runCliReachabilitySet }),
    onChange,
  });
  return { ctrl, onChange };
};

type ScopeValue = 'you_only' | 'selected' | 'all';

const renderPack = (ctrl: PackAccessController, pack: PackListEntry): FakeElement => {
  const panel = ctrl.renderForPack(pack);
  if (panel === null) throw new Error(`expected access panel for ${pack.slug}`);
  const fake = panel as unknown as FakeElement;
  expect(findByAttrValue(fake, PACK_ACCESS_ATTR, pack.slug)).toBe(fake);
  return fake;
};

const scopeRow = (panel: FakeElement): FakeElement => {
  const row = findByAttr(panel, PACK_ACCESS_SCOPE_ATTR);
  if (row === null) throw new Error('expected scope row');
  return row;
};

const scopeRadio = (panel: FakeElement, value: ScopeValue): FakeElement => {
  const radio = findAllByAttr(panel, PACK_ACCESS_SCOPE_RADIO_ATTR).find(
    (el) => el.getAttribute('data-scope-value') === value,
  );
  if (radio === undefined) throw new Error(`expected ${value} radio`);
  return radio;
};

const allOpsSelect = (panel: FakeElement, contractId: string): FakeElement => {
  const select = findAllByAttr(panel, PACK_ACCESS_ALL_OPS_ATTR).find(
    (el) => el.getAttribute('data-contract-id') === contractId,
  );
  if (select === undefined) throw new Error(`expected all-ops select for ${contractId}`);
  return select;
};

const addButton = (panel: FakeElement): FakeElement => {
  const button = findByAttr(panel, PACK_ACCESS_ADD_ATTR);
  if (button === null) throw new Error('expected add affordance');
  return button;
};

const contractGroup = (panel: FakeElement, contractId: string): FakeElement => {
  const group = findAllByAttr(panel, PACK_ACCESS_CONTRACT_ATTR).find(
    (el) => el.getAttribute('data-contract-id') === contractId,
  );
  if (group === undefined) throw new Error(`expected contract group ${contractId}`);
  return group;
};

const contractToggle = (panel: FakeElement, contractId: string): FakeElement => {
  const toggle = findAllByAttr(panel, PACK_ACCESS_CONTRACT_TOGGLE_ATTR).find(
    (el) => el.getAttribute('data-contract-id') === contractId,
  );
  if (toggle === undefined) throw new Error(`expected contract toggle ${contractId}`);
  return toggle;
};

const cellToggle = (
  panel: FakeElement,
  contractId: string,
  entryKey: string,
): FakeElement => {
  const box = findAllByAttr(panel, PACK_ACCESS_CELL_TOGGLE_ATTR).find(
    (el) =>
      el.getAttribute('data-contract-id') === contractId
      && el.getAttribute('data-entry') === entryKey,
  );
  if (box === undefined) {
    throw new Error(`expected cell ${contractId} x ${entryKey}`);
  }
  return box;
};

const optionValues = (select: FakeElement): string[] =>
  select.children
    .filter((child) => child.tagName === 'OPTION')
    .map((option) => option.getAttribute('value') ?? option.value);

const grantWriteArgs = (h: Harness): Parameters<GrantWriteCaller>[0][] =>
  h.runGrantWrite.mock.calls.map(([args]) => args);

const cliSetArgs = (h: Harness): Parameters<GrantCliReachabilitySetCaller>[0][] =>
  h.runCliReachabilitySet.mock.calls.map(([args]) => args);

const expectNoBulkAffordances = (panel: FakeElement): void => {
  expect(findByAttr(panel, PACK_ACCESS_SCOPE_ATTR)).toBeNull();
  expect(findAllByAttr(panel, PACK_ACCESS_ALL_OPS_ATTR)).toHaveLength(0);
  expect(findByAttr(panel, PACK_ACCESS_ADD_ATTR)).toBeNull();
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// ------------------------------------------------------------------
// Scope radios
// ------------------------------------------------------------------

describe('Packs R3b contract row filtering', () => {
  it('D-196: includes active standing doors but excludes customer template/instance rows', async () => {
    const h = makeCallers({
      contracts: [
        door('door-a'),
        door('ct_template', 'active', 'customer_template'),
        door('ct_customer', 'active', 'customer_instance'),
        door('ct_session', 'active', 'session'),
        door('ct_revoked', 'revoked'),
      ],
    });
    const { ctrl } = mountController(h);
    await ctrl.refresh();

    expect(ctrl.contractIds()).toEqual([OWNER_CONTRACT_ID, 'door-a']);
  });
});

describe('Packs R3b scope radios', () => {
  it('derives you_only, selected, and all from the effective cells', async () => {
    // The radio row is a pure read of effective cells: no doors and all door
    // cells off both collapse to you_only; mixed door/self state is selected;
    // all requires every contract x op cell, including self, to be on.
    const noDoors = makeCallers({ contracts: [] });
    const { ctrl: noDoorCtrl } = mountController(noDoors);
    await noDoorCtrl.refresh();
    const noDoorPanel = renderPack(noDoorCtrl, packEntry('stripe-pack'));
    expect(scopeRow(noDoorPanel).getAttribute('data-scope')).toBe('you_only');
    expect(scopeRadio(noDoorPanel, 'you_only').checked).toBe(true);

    const doorsAllOff = makeCallers({
      contracts: [door('door-a')],
      grants: {
        'door-a': [
          { entry_key: STRIPE_READ, granted: false },
          { entry_key: STRIPE_WRITE, granted: false },
        ],
      },
    });
    const { ctrl: doorsAllOffCtrl } = mountController(doorsAllOff);
    await doorsAllOffCtrl.refresh();
    const doorsAllOffPanel = renderPack(doorsAllOffCtrl, packEntry('stripe-pack'));
    expect(scopeRow(doorsAllOffPanel).getAttribute('data-scope')).toBe('you_only');

    const mixed = makeCallers({
      contracts: [door('door-a')],
      grants: {
        'door-a': [{ entry_key: STRIPE_WRITE, granted: true }],
      },
    });
    const { ctrl: mixedCtrl } = mountController(mixed);
    await mixedCtrl.refresh();
    const mixedPanel = renderPack(mixedCtrl, packEntry('stripe-pack'));
    expect(scopeRow(mixedPanel).getAttribute('data-scope')).toBe('selected');
    expect(scopeRadio(mixedPanel, 'selected').checked).toBe(true);

    const all = makeCallers({
      contracts: [door('door-a')],
      grants: {
        [OWNER_CONTRACT_ID]: [{ entry_key: STRIPE_WRITE, granted: true }],
        'door-a': [{ entry_key: STRIPE_WRITE, granted: true }],
      },
    });
    const { ctrl: allCtrl } = mountController(all);
    await allCtrl.refresh();
    const allPanel = renderPack(allCtrl, packEntry('stripe-pack'));
    expect(scopeRow(allPanel).getAttribute('data-scope')).toBe('all');
    expect(scopeRadio(allPanel, 'all').checked).toBe(true);
  });

  it('granting all writes only currently-off cells and flips the derived scope', async () => {
    // Read-risk connection ops already default on for both self and doors, so
    // the all radio should grant only the write-risk cells that are off.
    const h = makeCallers({ contracts: [door('door-a')] });
    const { ctrl } = mountController(h);
    await ctrl.refresh();

    const panel = renderPack(ctrl, packEntry('stripe-pack'));
    const radio = scopeRadio(panel, 'all');
    radio.checked = true;
    fireChange(radio);
    await flush(20);

    expect(grantWriteArgs(h)).toEqual([
      {
        contract_id: OWNER_CONTRACT_ID,
        entry_key: STRIPE_WRITE,
        granted: true,
      },
      {
        contract_id: 'door-a',
        entry_key: STRIPE_WRITE,
        granted: true,
      },
    ]);
    expect(grantWriteArgs(h).some((args) => args.entry_key === STRIPE_READ)).toBe(false);

    const reconciled = renderPack(ctrl, packEntry('stripe-pack'));
    expect(scopeRow(reconciled).getAttribute('data-scope')).toBe('all');
  });

  it('you_only revokes on door cells and never touches self', async () => {
    // You-only is a door revocation action: every effectively-on door cell is
    // written false, while self remains outside the fan-out even if it is on.
    const h = makeCallers({
      contracts: [door('door-a'), door('door-b')],
      grants: {
        [OWNER_CONTRACT_ID]: [{ entry_key: STRIPE_WRITE, granted: true }],
        'door-a': [{ entry_key: STRIPE_WRITE, granted: true }],
      },
    });
    const { ctrl } = mountController(h);
    await ctrl.refresh();

    const panel = renderPack(ctrl, packEntry('stripe-pack'));
    const radio = scopeRadio(panel, 'you_only');
    radio.checked = true;
    fireChange(radio);
    await flush(20);

    expect(grantWriteArgs(h)).toEqual([
      { contract_id: 'door-a', entry_key: STRIPE_READ, granted: false },
      { contract_id: 'door-a', entry_key: STRIPE_WRITE, granted: false },
      { contract_id: 'door-b', entry_key: STRIPE_READ, granted: false },
    ]);
    expect(
      grantWriteArgs(h).some((args) => args.contract_id === OWNER_CONTRACT_ID),
    ).toBe(false);

    const reconciled = renderPack(ctrl, packEntry('stripe-pack'));
    expect(scopeRow(reconciled).getAttribute('data-scope')).toBe('you_only');
  });

  it('selected is descriptive and writes nothing', async () => {
    // Selected is the derived mixed-state label. Clicking it is a repaint-only
    // no-op and must not fan out any grant or cli writes.
    const h = makeCallers({
      contracts: [door('door-a')],
      grants: {
        'door-a': [{ entry_key: STRIPE_WRITE, granted: true }],
      },
    });
    const { ctrl } = mountController(h);
    await ctrl.refresh();

    const panel = renderPack(ctrl, packEntry('stripe-pack'));
    expect(scopeRow(panel).getAttribute('data-scope')).toBe('selected');
    const radio = scopeRadio(panel, 'selected');
    radio.checked = true;
    fireChange(radio);
    await flush();

    expect(h.runGrantWrite).not.toHaveBeenCalled();
    expect(h.runCliReachabilitySet).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------
// Per-contract all-ops select
// ------------------------------------------------------------------

describe('Packs R3b per-contract all-ops select', () => {
  it('renders only on expanded rows and grants/revokes CLI ops through the map key', async () => {
    // The select belongs to expanded contract rows only. For CLI packs it must
    // call cli.reachability.set with the manifest operation_key, and redundant
    // grant-all clicks must stay zero-write once the effective cell is on.
    const h = makeCallers({ contracts: [door('door-a')] });
    const { ctrl } = mountController(h);
    await ctrl.refresh();

    const panel = renderPack(ctrl, packEntry('tools-pack'));
    const selects = findAllByAttr(panel, PACK_ACCESS_ALL_OPS_ATTR);
    expect(selects).toHaveLength(1);
    expect(selects[0]!.getAttribute('data-contract-id')).toBe(OWNER_CONTRACT_ID);
    const select = allOpsSelect(panel, OWNER_CONTRACT_ID);
    expect(optionValues(select)).toEqual(['', 'grant_all', 'revoke_all']);

    select.value = 'grant_all';
    fireChange(select);
    await flush(20);

    expect(cliSetArgs(h)).toEqual([
      {
        principal: OWNER_CONTRACT_ID,
        ingredient_id: 'tools-pack-comp',
        operation_id: 'audio.transcribe',
        allowed: true,
      },
    ]);
    expect(h.runGrantWrite).not.toHaveBeenCalled();
    expect(ctrl.effectiveFor(OWNER_CONTRACT_ID, TOOLS_CLI)).toBe('on');

    h.runCliReachabilitySet.mockClear();
    const redundant = allOpsSelect(renderPack(ctrl, packEntry('tools-pack')), OWNER_CONTRACT_ID);
    redundant.value = 'grant_all';
    fireChange(redundant);
    await flush();
    expect(h.runCliReachabilitySet).not.toHaveBeenCalled();

    const revoke = allOpsSelect(renderPack(ctrl, packEntry('tools-pack')), OWNER_CONTRACT_ID);
    revoke.value = 'revoke_all';
    fireChange(revoke);
    await flush(20);

    expect(cliSetArgs(h)).toEqual([
      {
        principal: OWNER_CONTRACT_ID,
        ingredient_id: 'tools-pack-comp',
        operation_id: 'audio.transcribe',
        allowed: false,
      },
    ]);
    expect(ctrl.effectiveFor(OWNER_CONTRACT_ID, TOOLS_CLI)).toBe('off');
  });
});

// ------------------------------------------------------------------
// Add-to-contract affordance
// ------------------------------------------------------------------

describe('Packs R3b add affordance', () => {
  it('lists only doors with off cells, grants the picked door, closes, and expands it', async () => {
    // The picker is over doors only and excludes already-full doors. Choosing a
    // candidate grant-alls its off cells, closes the disclosure, and expands
    // that door row so the user lands on the changed cells.
    const h = makeCallers({
      contracts: [door('door-a'), door('door-b')],
      grants: {
        'door-a': [{ entry_key: STRIPE_READ, granted: false }],
        'door-b': [{ entry_key: STRIPE_WRITE, granted: true }],
      },
    });
    const { ctrl } = mountController(h);
    await ctrl.refresh();

    const closed = renderPack(ctrl, packEntry('stripe-pack'));
    const closedButton = addButton(closed);
    expect(closedButton.getAttribute('aria-expanded')).toBe('false');
    closedButton.click();

    const open = renderPack(ctrl, packEntry('stripe-pack'));
    const openButton = addButton(open);
    expect(openButton.getAttribute('aria-expanded')).toBe('true');
    const picker = findByAttr(open, PACK_ACCESS_ADD_PICKER_ATTR);
    expect(picker).not.toBeNull();
    expect(optionValues(picker!)).toEqual(['', 'door-a']);
    expect(optionValues(picker!).includes(OWNER_CONTRACT_ID)).toBe(false);
    expect(optionValues(picker!).includes('door-b')).toBe(false);

    picker!.value = 'door-a';
    fireChange(picker!);
    await flush(20);

    expect(grantWriteArgs(h)).toEqual([
      { contract_id: 'door-a', entry_key: STRIPE_READ, granted: true },
      { contract_id: 'door-a', entry_key: STRIPE_WRITE, granted: true },
    ]);
    const reconciled = renderPack(ctrl, packEntry('stripe-pack'));
    expect(addButton(reconciled).getAttribute('aria-expanded')).toBe('false');
    expect(findByAttr(reconciled, PACK_ACCESS_ADD_PICKER_ATTR)).toBeNull();
    expect(contractGroup(reconciled, 'door-a').getAttribute('data-expanded')).toBe('true');
  });

  it('renders no-door and all-granted empty states', async () => {
    // The empty-state branch distinguishes "no active doors yet" from "there
    // are doors, but all of them are already fully granted."
    const noDoors = makeCallers({ contracts: [] });
    const { ctrl: noDoorsCtrl } = mountController(noDoors);
    await noDoorsCtrl.refresh();
    const noDoorsClosed = renderPack(noDoorsCtrl, packEntry('stripe-pack'));
    addButton(noDoorsClosed).click();
    const noDoorsOpen = renderPack(noDoorsCtrl, packEntry('stripe-pack'));
    const noDoorsEmpty = findByAttr(noDoorsOpen, PACK_ACCESS_ADD_EMPTY_ATTR);
    expect(noDoorsEmpty).not.toBeNull();
    expect(collectTextContent(noDoorsEmpty!)).toContain('No other contracts yet');
    const links = findAllByTag(noDoorsEmpty!, 'a');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('#contracts');

    const allGranted = makeCallers({
      contracts: [door('door-a')],
      grants: {
        [OWNER_CONTRACT_ID]: [{ entry_key: STRIPE_WRITE, granted: true }],
        'door-a': [{ entry_key: STRIPE_WRITE, granted: true }],
      },
    });
    const { ctrl: allGrantedCtrl } = mountController(allGranted);
    await allGrantedCtrl.refresh();
    const allGrantedClosed = renderPack(allGrantedCtrl, packEntry('stripe-pack'));
    addButton(allGrantedClosed).click();
    const allGrantedOpen = renderPack(allGrantedCtrl, packEntry('stripe-pack'));
    const allGrantedEmpty = findByAttr(allGrantedOpen, PACK_ACCESS_ADD_EMPTY_ATTR);
    expect(allGrantedEmpty).not.toBeNull();
    expect(collectTextContent(allGrantedEmpty!)).toContain(
      'Every contract already has full access to this pack.',
    );
  });
});

// ------------------------------------------------------------------
// Regression guards
// ------------------------------------------------------------------

describe('Packs R3b regression guards', () => {
  it('hides bulk affordances without write callers while keeping per-cell panel', async () => {
    // Read-only wiring must keep the R3 per-cell view available, but hide every
    // bulk affordance so the UI cannot imply a writable fan-out.
    const h = makeCallers({ contracts: [door('door-a')] });
    const { ctrl } = mountController(h, { grantWrite: false, cliSet: false });
    await ctrl.refresh();

    const panel = renderPack(ctrl, packEntry('stripe-pack'));
    expectNoBulkAffordances(panel);
    expect(findAllByAttr(panel, PACK_ACCESS_CELL_TOGGLE_ATTR).length).toBeGreaterThan(0);
  });

  it('keeps the add disclosure state scoped per pack', async () => {
    // The controller outlives pack selection. An open picker for pack A must
    // not leak into pack B, and pack A should still remember its own disclosure.
    const h = makeCallers({ contracts: [door('door-a')] });
    const { ctrl } = mountController(h);
    await ctrl.refresh();

    const stripeClosed = renderPack(ctrl, packEntry('stripe-pack'));
    addButton(stripeClosed).click();
    const stripeOpen = renderPack(ctrl, packEntry('stripe-pack'));
    expect(addButton(stripeOpen).getAttribute('aria-expanded')).toBe('true');
    expect(findByAttr(stripeOpen, PACK_ACCESS_ADD_PICKER_ATTR)).not.toBeNull();

    const toolsPanel = renderPack(ctrl, packEntry('tools-pack'));
    expect(addButton(toolsPanel).getAttribute('aria-expanded')).toBe('false');
    expect(findByAttr(toolsPanel, PACK_ACCESS_ADD_PICKER_ATTR)).toBeNull();

    const stripeAgain = renderPack(ctrl, packEntry('stripe-pack'));
    expect(addButton(stripeAgain).getAttribute('aria-expanded')).toBe('true');
    expect(findByAttr(stripeAgain, PACK_ACCESS_ADD_PICKER_ATTR)).not.toBeNull();
  });

  it('hides bulk affordances when a mixed conn+cli pack is only partially writable', async () => {
    // bulkWritable is all-or-nothing across the shipped op kinds. A pack with a
    // connection op and a cli op cannot show bulk affordances when only the
    // connection writer is wired.
    const h = makeCallers({ contracts: [door('door-a')] });
    const { ctrl } = mountController(h, { cliSet: false });
    await ctrl.refresh();

    const combo = packEntryWithCompositions('combo-pack', [
      'stripe-pack-comp',
      'tools-pack-comp',
    ]);
    const panel = renderPack(ctrl, combo);
    expectNoBulkAffordances(panel);
    expect(findAllByAttr(panel, PACK_ACCESS_CELL_TOGGLE_ATTR).length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------
// Bulk concurrency
// ------------------------------------------------------------------

describe('Packs R3b bulk concurrency', () => {
  it('disables bulk controls and touched cell checkboxes until the bulk write settles', async () => {
    // While a fan-out is pending, bulk controls go inert and only the cells in
    // that fan-out are disabled. Once reconciliation lands, everything is live
    // again.
    const h = makeCallers({ contracts: [door('door-a')] });
    const heldFirstWrite = deferred<void>();
    const statefulWrite = h.runGrantWrite;
    let holdNext = true;
    h.runGrantWrite = vi.fn<GrantWriteCaller>(async (args) => {
      if (holdNext) {
        holdNext = false;
        await heldFirstWrite.promise;
      }
      return statefulWrite(args);
    });
    const { ctrl } = mountController(h);
    await ctrl.refresh();

    const expandedSeed = renderPack(ctrl, packEntry('stripe-pack'));
    contractToggle(expandedSeed, 'door-a').click();
    const ready = renderPack(ctrl, packEntry('stripe-pack'));
    const allRadio = scopeRadio(ready, 'all');
    allRadio.checked = true;
    fireChange(allRadio);
    await flush(2);

    expect(h.runGrantWrite).toHaveBeenCalledTimes(2);
    const pending = renderPack(ctrl, packEntry('stripe-pack'));
    const pendingRadios = findAllByAttr(pending, PACK_ACCESS_SCOPE_RADIO_ATTR);
    expect(pendingRadios).toHaveLength(3);
    expect(pendingRadios.every((radio) => radio.hasAttribute('disabled'))).toBe(true);
    const pendingAllOps = findAllByAttr(pending, PACK_ACCESS_ALL_OPS_ATTR);
    expect(pendingAllOps).toHaveLength(2);
    expect(pendingAllOps.every((select) => select.hasAttribute('disabled'))).toBe(true);
    expect(addButton(pending).hasAttribute('disabled')).toBe(true);
    expect(cellToggle(pending, OWNER_CONTRACT_ID, STRIPE_WRITE).hasAttribute('disabled')).toBe(
      true,
    );
    expect(cellToggle(pending, 'door-a', STRIPE_WRITE).hasAttribute('disabled')).toBe(true);
    expect(cellToggle(pending, OWNER_CONTRACT_ID, STRIPE_READ).hasAttribute('disabled')).toBe(
      false,
    );
    expect(cellToggle(pending, 'door-a', STRIPE_READ).hasAttribute('disabled')).toBe(false);

    heldFirstWrite.resolve(undefined);
    await flush(30);

    const settled = renderPack(ctrl, packEntry('stripe-pack'));
    const settledRadios = findAllByAttr(settled, PACK_ACCESS_SCOPE_RADIO_ATTR);
    expect(settledRadios).toHaveLength(3);
    expect(settledRadios.every((radio) => radio.hasAttribute('disabled'))).toBe(false);
    const settledAllOps = findAllByAttr(settled, PACK_ACCESS_ALL_OPS_ATTR);
    expect(settledAllOps).toHaveLength(2);
    expect(settledAllOps.every((select) => select.hasAttribute('disabled'))).toBe(false);
    expect(addButton(settled).hasAttribute('disabled')).toBe(false);
    expect(cellToggle(settled, OWNER_CONTRACT_ID, STRIPE_WRITE).hasAttribute('disabled')).toBe(
      false,
    );
    expect(cellToggle(settled, 'door-a', STRIPE_WRITE).hasAttribute('disabled')).toBe(false);
    expect(scopeRow(settled).getAttribute('data-scope')).toBe('all');
  });
});
