/** Packs R22 R3 — the by-PACK Access panel (contract-first nested list).
 *
 *  Covers the pack→catalog membership helper, the controller's contract-row
 *  building (self first + expanded, revoked doors filtered), the SHARED cell
 *  derivation through both routings (cli fail-closed vs connection
 *  explicit-?? -default), the write-then-reconcile toggles, the pack-scoped
 *  universe filtering, and the packs-panel detail integration (ACCESS panel
 *  vs placeholder fallback).
 *
 *  Self-contained fake-DOM harness, cribbed from the sibling packs suites. */

import { describe, expect, it, vi } from 'vitest';

import {
  createPackAccessController,
  packCompositionSlugs,
  PACK_ACCESS_ATTR,
  PACK_ACCESS_CELL_TOGGLE_ATTR,
  PACK_ACCESS_CONTRACT_ATTR,
  PACK_ACCESS_CONTRACT_TOGGLE_ATTR,
  PACK_ACCESS_SUMMARY_ATTR,
} from '../settings/pack-access-controls.js';
import {
  PACKS_DETAIL_SECTION_ATTR,
  PACKS_DETAIL_TAB_ATTR,
  mountPacksPanel,
} from '../settings/packs-panel.js';
import {
  createOwnerOperationController,
  packOperationIngredientSlugs,
  OWNER_OPERATION_APPROVAL_ATTR,
  OWNER_OPERATION_ATTR,
  OWNER_OPERATION_CONFIRM_ATTR,
  OWNER_OPERATION_ERROR_ATTR,
  OWNER_OPERATION_RISK_ATTR,
  OWNER_OPERATION_ROW_ATTR,
  type OwnerOperationDeleteCaller,
  type OwnerOperationInventoryCaller,
  type OwnerOperationListCaller,
  type OwnerOperationUpsertCaller,
} from '../settings/owner-operation-controls.js';
import type {
  GrantCatalogOperationsCaller,
  GrantCliReachabilityListCaller,
  GrantCliReachabilitySetCaller,
  GrantContractsCaller,
  GrantReadCaller,
  GrantWriteCaller,
} from '../contracts/contract-grants-panel.js';
import type {
  BulkPackManifest,
  CatalogIngredientView,
  ContractDefinitionView,
  OwnerOperationIngredientView,
  PackListEntry,
} from '@recued/contracts';

// ──────────────────────────────────────────────────────────────────
// Fake DOM (mirrors the sibling packs-panel test harness shape)
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  checked: boolean;
  className: string;
  id: string;
  type: string;
  title: string;
  value: string;
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
    className: '',
    id: '',
    type: '',
    title: '',
    value: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => {
      attrs.set(k, v);
      if (k === 'disabled') el.disabled = true;
    },
    removeAttribute: (k) => {
      attrs.delete(k);
      if (k === 'disabled') el.disabled = false;
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
const collectTextContent = (root: FakeElement): string => {
  let out = root.textContent ?? '';
  for (const c of root.children) out += collectTextContent(c);
  return out;
};
/** Fire a checkbox's `change` listeners (fake `click()` only fires `click`). */
const fireChange = (box: FakeElement): void => {
  if (box.attrs.has('disabled')) return;
  for (const fn of [...(box.listeners.get('change') ?? [])]) fn({ target: box });
};
const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ──────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────

/** A pack manifest whose ONE composition (slug `<slug>-comp`) is the catalog
 *  membership link — the catalog fixture below uses the same ingredient_id. */
const packManifest = (slug: string): BulkPackManifest =>
  ({
    manifest_version: 2,
    slug,
    publisher: 'recued-core',
    name: slug,
    description: 'Access panel test pack.',
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

const door = (
  contract_id: string,
  lifecycle_state: 'active' | 'revoked' = 'active',
): ContractDefinitionView =>
  ({
    contract_id,
    display_name: `Door ${contract_id}`,
    lifecycle_state,
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
      const principal = args.principal ?? 'user_self';
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

const mountController = (h: Harness) => {
  const doc = makeFakeDocument();
  const onChange = vi.fn();
  const ctrl = createPackAccessController({
    document: doc as unknown as Document,
    runListContracts: h.runListContracts,
    runGrantRead: h.runGrantRead,
    runGrantWrite: h.runGrantWrite,
    runCatalogOperations: h.runCatalogOperations,
    runCliReachabilityList: h.runCliReachabilityList,
    runCliReachabilitySet: h.runCliReachabilitySet,
    onChange,
  });
  return { ctrl, onChange };
};

// ──────────────────────────────────────────────────────────────────
// packCompositionSlugs
// ──────────────────────────────────────────────────────────────────

describe('packCompositionSlugs', () => {
  it('extracts the composition slugs (the catalog ingredient_ids)', () => {
    expect(packCompositionSlugs(packManifest('stripe-pack'))).toEqual([
      'stripe-pack-comp',
    ]);
  });

  it('returns [] for a recipe-only (v1) pack', () => {
    const v1 = {
      manifest_version: 1,
      slug: 'plain',
      publisher: 'recued-core',
      name: 'Plain',
      description: 'no compositions',
      version: 1,
      recipes: [{ slug: 'r', version: 1 }],
      requires: [],
      tags: [],
    } as unknown as BulkPackManifest;
    expect(packCompositionSlugs(v1)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────
// Controller
// ──────────────────────────────────────────────────────────────────

describe('pack access controller', () => {
  it('is disabled without the read trio and renders nothing', () => {
    const doc = makeFakeDocument();
    const ctrl = createPackAccessController({
      document: doc as unknown as Document,
      onChange: () => {},
    });
    expect(ctrl.enabled).toBe(false);
    expect(ctrl.renderForPack(packEntry('stripe-pack'))).toBeNull();
  });

  it('lists Self (you) first + expanded; revoked doors filtered out', async () => {
    const h = makeCallers({
      contracts: [door('door-a'), door('door-b', 'revoked')],
    });
    const { ctrl } = mountController(h);
    await ctrl.refresh();

    expect(ctrl.contractIds()).toEqual(['user_self', 'door-a']);
    const panel = ctrl.renderForPack(packEntry('stripe-pack')) as unknown as FakeElement;
    const groups = findAllByAttr(panel, PACK_ACCESS_CONTRACT_ATTR);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.getAttribute('data-contract-id')).toBe('user_self');
    expect(groups[0]!.getAttribute('data-expanded')).toBe('true');
    expect(collectTextContent(groups[0]!)).toContain('Self (you)');
    expect(groups[1]!.getAttribute('data-contract-id')).toBe('door-a');
    expect(groups[1]!.getAttribute('data-expanded')).toBe('false');
  });

  it('filters the universe to the pack (another pack’s ops are absent)', async () => {
    const h = makeCallers({ contracts: [] });
    const { ctrl } = mountController(h);
    await ctrl.refresh();

    const panel = ctrl.renderForPack(packEntry('stripe-pack')) as unknown as FakeElement;
    const text = collectTextContent(panel);
    expect(text).toContain('acme/invoice.read');
    expect(text).toContain('acme/invoice.create');
    expect(text).not.toContain('acme/audio.transcribe');
    expect(findAllByAttr(panel, 'data-risk')).toHaveLength(0);
    expect(findAllByAttr(panel, 'data-approval')).toHaveLength(0);
  });

  it('derives cells like the gate: defaults, explicit rows, cli fail-closed', async () => {
    const h = makeCallers({
      contracts: [door('door-a')],
      grants: {
        'door-a': [{ entry_key: 'acme/invoice.create', granted: true }],
      },
      cliRows: [
        {
          principal: 'user_self',
          ingredient_id: 'tools-pack-comp',
          operation_id: 'audio.transcribe',
          allowed: true,
        },
      ],
    });
    const { ctrl } = mountController(h);
    await ctrl.refresh();

    // Connection read op — author default ON (no explicit rows needed).
    expect(ctrl.effectiveFor('user_self', 'acme/invoice.read')).toBe('on');
    // Connection write op — author default OFF; door-a's explicit row flips it.
    expect(ctrl.effectiveFor('user_self', 'acme/invoice.create')).toBe('off');
    expect(ctrl.effectiveFor('door-a', 'acme/invoice.create')).toBe('on');
    // CLI op — fail-closed per principal: self has a row, the door does not.
    expect(ctrl.effectiveFor('user_self', 'acme/audio.transcribe')).toBe('on');
    expect(ctrl.effectiveFor('door-a', 'acme/audio.transcribe')).toBe('off');
  });

  it('shows the N-of-M summary per contract row', async () => {
    const h = makeCallers({ contracts: [] });
    const { ctrl } = mountController(h);
    await ctrl.refresh();
    const panel = ctrl.renderForPack(packEntry('stripe-pack')) as unknown as FakeElement;
    // Self: read op on (default), write op off → 1 of 2.
    const summary = findByAttr(panel, PACK_ACCESS_SUMMARY_ATTR)!;
    expect(summary.textContent).toBe('1 of 2');
  });

  it('toggling a connection op writes contract.grant.write and reconciles', async () => {
    const h = makeCallers({ contracts: [door('door-a')] });
    const { ctrl } = mountController(h);
    await ctrl.refresh();

    // Expand door-a, then flip its write op ON.
    const panel1 = ctrl.renderForPack(packEntry('stripe-pack')) as unknown as FakeElement;
    findByAttrValue(
      panel1,
      PACK_ACCESS_CONTRACT_TOGGLE_ATTR,
      '',
    ); // presence sanity
    const doorHeader = findAllByAttr(panel1, PACK_ACCESS_CONTRACT_TOGGLE_ATTR)
      .find((e) => e.getAttribute('data-contract-id') === 'door-a')!;
    doorHeader.click();

    const panel2 = ctrl.renderForPack(packEntry('stripe-pack')) as unknown as FakeElement;
    const box = findAllByAttr(panel2, PACK_ACCESS_CELL_TOGGLE_ATTR).find(
      (e) =>
        e.getAttribute('data-contract-id') === 'door-a'
        && e.getAttribute('data-entry') === 'acme/invoice.create',
    )!;
    expect(box.getAttribute('data-effective')).toBe('off');
    fireChange(box);
    await flush();

    expect(h.runGrantWrite).toHaveBeenCalledWith({
      contract_id: 'door-a',
      entry_key: 'acme/invoice.create',
      granted: true,
    });
    // The reconcile re-read (grant fixture mutated by the write stub) lands.
    expect(ctrl.effectiveFor('door-a', 'acme/invoice.create')).toBe('on');
    // The other contract's cell is untouched.
    expect(ctrl.effectiveFor('user_self', 'acme/invoice.create')).toBe('off');
  });

  it('toggling a cli op writes cli.reachability.set with the MAP KEY, not the qualified id', async () => {
    const h = makeCallers({ contracts: [] });
    const { ctrl } = mountController(h);
    await ctrl.refresh();

    const panel = ctrl.renderForPack(packEntry('tools-pack')) as unknown as FakeElement;
    const box = findAllByAttr(panel, PACK_ACCESS_CELL_TOGGLE_ATTR).find(
      (e) =>
        e.getAttribute('data-contract-id') === 'user_self'
        && e.getAttribute('data-entry') === 'acme/audio.transcribe',
    )!;
    fireChange(box);
    await flush();

    expect(h.runCliReachabilitySet).toHaveBeenCalledWith({
      principal: 'user_self',
      ingredient_id: 'tools-pack-comp',
      operation_id: 'audio.transcribe',
      allowed: true,
    });
    expect(h.runGrantWrite).not.toHaveBeenCalled();
    expect(ctrl.effectiveFor('user_self', 'acme/audio.transcribe')).toBe('on');
  });

  it('surfaces a failed catalog read instead of the silent placeholder (codex R3 LOW)', async () => {
    const h = makeCallers({ contracts: [] });
    h.runCatalogOperations.mockRejectedValue(new Error('catalog boom'));
    const { ctrl } = mountController(h);
    await ctrl.refresh();

    const panel = ctrl.renderForPack(packEntry('stripe-pack'));
    expect(panel).not.toBeNull();
    const err = findByAttr(
      panel as unknown as FakeElement,
      'data-recued-pack-access-error',
    );
    expect(err).not.toBeNull();
    // No hollow "0 of 0" contract rows under the error line.
    expect(
      findAllByAttr(panel as unknown as FakeElement, PACK_ACCESS_CONTRACT_ATTR),
    ).toHaveLength(0);
  });

  it('renders null for a pack with no catalog ops (recipe-only)', async () => {
    const h = makeCallers({ contracts: [] });
    const { ctrl } = mountController(h);
    await ctrl.refresh();
    const v1 = packEntry('plain');
    (v1 as { manifest: BulkPackManifest }).manifest = {
      ...v1.manifest,
      contents: [],
    } as unknown as BulkPackManifest;
    expect(ctrl.renderForPack(v1)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// D-211 global owner operation defaults
// ──────────────────────────────────────────────────────────────────

describe('owner operation defaults controller', () => {
  const mountOwnerController = (opts: {
    ingredients?: OwnerOperationIngredientView[];
    rows?: Awaited<ReturnType<OwnerOperationListCaller>>['overrides'];
    upsert?: OwnerOperationUpsertCaller;
    delete?: OwnerOperationDeleteCaller;
  } = {}) => {
    const doc = makeFakeDocument();
    const rows = opts.rows ?? [];
    const runListOverrides = vi.fn<OwnerOperationListCaller>(async () => ({
      overrides: rows,
    }));
    const runUpsertOverride = vi.fn<OwnerOperationUpsertCaller>(
      opts.upsert ?? (async (args) => ({
        ingredient_id: args.ingredient_id,
        operation_id: args.operation_id,
        policy: {
          ...(args.policy.risk !== undefined ? { risk: args.policy.risk } : {}),
          ...(args.policy.approval !== undefined ? { approval: args.policy.approval } : {}),
        },
        ...(args.policy.risk !== undefined ? { risk: args.policy.risk } : {}),
        ...(args.policy.approval !== undefined ? { approval: args.policy.approval } : {}),
        written_at: 2,
      })),
    );
    const runDeleteOverride = vi.fn<OwnerOperationDeleteCaller>(
      opts.delete ?? (async () => ({ deleted: true })),
    );
    const ctrl = createOwnerOperationController({
      document: doc as unknown as Document,
      runOperations: (async () => ({
        ingredients: opts.ingredients ?? CATALOG.ingredients,
      })) as OwnerOperationInventoryCaller,
      runListOverrides,
      runUpsertOverride,
      runDeleteOverride,
      onChange: () => {},
    });
    return { ctrl, runListOverrides, runUpsertOverride, runDeleteOverride };
  };

  it('shows pack defaults and writes an actorless exact-operation replacement', async () => {
    const { ctrl, runUpsertOverride } = mountOwnerController({
      rows: [{
        ingredient_id: 'stripe-pack-comp',
        operation_id: 'acme/invoice.create',
        policy: { risk: 'admin', approval: 'ask' },
        risk: 'admin',
        approval: 'ask',
        written_at: 1,
      }],
    });
    await ctrl.refresh();

    const panel = ctrl.renderForPack(packEntry('stripe-pack')) as unknown as FakeElement;
    expect(findByAttr(panel, OWNER_OPERATION_ATTR)).toBe(panel);
    expect(findAllByAttr(panel, OWNER_OPERATION_ROW_ATTR)).toHaveLength(2);
    expect(collectTextContent(panel)).toContain('What the Pack says is the starting point everywhere');
    expect(collectTextContent(panel)).toContain('Pack · Automatic');
    const writeRow = findAllByAttr(panel, OWNER_OPERATION_ROW_ATTR).find(
      (row) => row.getAttribute('data-operation-id') === 'acme/invoice.create',
    )!;
    const risk = findByAttr(writeRow, OWNER_OPERATION_RISK_ATTR)!;
    const approval = findByAttr(writeRow, OWNER_OPERATION_APPROVAL_ATTR)!;
    expect(risk.value).toBe('admin');
    expect(approval.value).toBe('ask');

    approval.value = 'always';
    fireChange(approval);
    await flush();

    expect(runUpsertOverride).toHaveBeenCalledWith({
      ingredient_id: 'stripe-pack-comp',
      operation_id: 'acme/invoice.create',
      policy: { risk: 'admin', approval: 'always' },
    });
    expect(runUpsertOverride.mock.calls[0]![0]).not.toHaveProperty('actor');
    expect(runUpsertOverride.mock.calls[0]![0]).not.toHaveProperty('contract_id');
  });

  it('renders the slug-keyed operation of a direct ingredient pack', async () => {
    const pack = packEntry('mail-pack');
    (pack as { manifest: BulkPackManifest }).manifest = {
      ...pack.manifest!,
      contents: [{
        type: 'ingredient',
        slug: 'mail-send',
        version: 1,
        role: 'operation_wrapper',
      }],
    };
    expect(packOperationIngredientSlugs(pack.manifest!)).toEqual(['mail-send']);
    const { ctrl } = mountOwnerController({
      ingredients: [{
        ingredient_id: 'mail-send',
        name: 'Mail send',
        operations: [{
          operation_id: 'mail-send',
          operation_key: 'mail-send',
          risk_tier: 'write',
        }],
      }],
    });
    await ctrl.refresh();

    const panel = ctrl.renderForPack(pack) as unknown as FakeElement;
    const rows = findAllByAttr(panel, OWNER_OPERATION_ROW_ATTR);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('data-operation-id')).toBe('mail-send');
  });

  it('deletes the exact global row when its last owner facet returns to Pack', async () => {
    const { ctrl, runDeleteOverride } = mountOwnerController({
      rows: [{
        ingredient_id: 'stripe-pack-comp',
        operation_id: 'acme/invoice.create',
        policy: { approval: 'ask' },
        approval: 'ask',
        written_at: 1,
      }],
    });
    await ctrl.refresh();
    const panel = ctrl.renderForPack(packEntry('stripe-pack')) as unknown as FakeElement;
    const writeRow = findAllByAttr(panel, OWNER_OPERATION_ROW_ATTR).find(
      (row) => row.getAttribute('data-operation-id') === 'acme/invoice.create',
    )!;
    const approval = findByAttr(writeRow, OWNER_OPERATION_APPROVAL_ATTR)!;
    approval.value = '';
    fireChange(approval);
    await flush();

    expect(runDeleteOverride).toHaveBeenCalledWith({
      ingredient_id: 'stripe-pack-comp',
      operation_id: 'acme/invoice.create',
    });
  });

  it('names downgrade consequences and resubmits only after owner confirmation', async () => {
    const upsert = vi.fn<OwnerOperationUpsertCaller>(async (args) => {
      if (args.policy.confirm_risk_downgrade !== true) {
        throw {
          code: 'owner_operation_risk_downgrade_confirm',
          details: {
            declared_risk: 'write',
            new_risk: 'read',
            floor_before: 'ask',
            floor_after: 'never',
            session_grantable_after: true,
            delegation_learnable_after: false,
          },
        };
      }
      return {
        ingredient_id: args.ingredient_id,
        operation_id: args.operation_id,
        policy: { risk: 'read' },
        risk: 'read',
        written_at: 2,
      };
    });
    const { ctrl } = mountOwnerController({ upsert });
    await ctrl.refresh();
    let panel = ctrl.renderForPack(packEntry('stripe-pack')) as unknown as FakeElement;
    let writeRow = findAllByAttr(panel, OWNER_OPERATION_ROW_ATTR).find(
      (row) => row.getAttribute('data-operation-id') === 'acme/invoice.create',
    )!;
    const risk = findByAttr(writeRow, OWNER_OPERATION_RISK_ATTR)!;
    risk.value = 'read';
    fireChange(risk);
    await flush();

    panel = ctrl.renderForPack(packEntry('stripe-pack')) as unknown as FakeElement;
    writeRow = findAllByAttr(panel, OWNER_OPERATION_ROW_ATTR).find(
      (row) => row.getAttribute('data-operation-id') === 'acme/invoice.create',
    )!;
    expect(findByAttr(writeRow, OWNER_OPERATION_ERROR_ATTR)?.textContent)
      .toContain('approval floor ask → never');
    findByAttr(writeRow, OWNER_OPERATION_CONFIRM_ATTR)!.click();
    await flush();

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[1]![0]).toEqual({
      ingredient_id: 'stripe-pack-comp',
      operation_id: 'acme/invoice.create',
      policy: { risk: 'read', confirm_risk_downgrade: true },
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// Packs-panel detail integration
// ──────────────────────────────────────────────────────────────────

describe('packs detail ACCESS section integration', () => {
  const mountPanel = (withAccess: boolean, withOwnerDefaults = false) => {
    const doc = makeFakeDocument();
    const host = makeFakeElement('div');
    const h = makeCallers({ contracts: [door('door-a')] });
    const mount = mountPacksPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runList: async () => ({ packs: [packEntry('stripe-pack')] }),
      ...(withAccess
        ? {
            runListContracts: h.runListContracts,
            runContractGrantRead: h.runGrantRead,
            runContractGrantWrite: h.runGrantWrite,
            runCatalogOperations: h.runCatalogOperations,
            runCliReachabilityList: h.runCliReachabilityList,
            runCliReachabilitySet: h.runCliReachabilitySet,
          }
        : {}),
      ...(withOwnerDefaults
        ? {
            runOwnerOperationInventory: async () => CATALOG,
            runOwnerOperationList: async () => ({ overrides: [] }),
            runOwnerOperationUpsert: async (args) => ({
              ingredient_id: args.ingredient_id,
              operation_id: args.operation_id,
              policy: {
                ...(args.policy.risk !== undefined ? { risk: args.policy.risk } : {}),
                ...(args.policy.approval !== undefined
                  ? { approval: args.policy.approval }
                  : {}),
              },
              written_at: 2,
            }),
            runOwnerOperationDelete: async () => ({ deleted: true }),
          }
        : {}),
    });
    return { host, mount };
  };

  it('renders the Access panel in the detail when the callers are wired', async () => {
    const { host, mount } = mountPanel(true);
    await mount.whenLoaded();
    mount.clickSelectPack('stripe-pack');
    findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'access')!.click();

    const access = findByAttrValue(host, PACKS_DETAIL_SECTION_ATTR, 'access')!;
    expect(findByAttr(access, PACK_ACCESS_ATTR)).not.toBeNull();
    const text = collectTextContent(access);
    expect(text).toContain('Self (you)');
    expect(text).not.toContain('Open Contracts');
  });

  it('keeps the placeholder when the access callers are absent', async () => {
    const { host, mount } = mountPanel(false);
    await mount.whenLoaded();
    mount.clickSelectPack('stripe-pack');
    findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'access')!.click();

    const access = findByAttrValue(host, PACKS_DETAIL_SECTION_ATTR, 'access')!;
    expect(findByAttr(access, PACK_ACCESS_ATTR)).toBeNull();
    expect(collectTextContent(access)).toContain('Open Contracts');
  });

  it('renders global What it may do, to start with outside the per-contract Access section', async () => {
    const { host, mount } = mountPanel(false, true);
    await mount.whenLoaded();
    mount.clickSelectPack('stripe-pack');
    findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'permissions')!.click();

    const defaults = findByAttrValue(
      host,
      PACKS_DETAIL_SECTION_ATTR,
      'operation-defaults',
    )!;
    expect(findByAttr(defaults, OWNER_OPERATION_ATTR)).not.toBeNull();
    expect(collectTextContent(defaults)).toContain('What you say replaces it everywhere');
    expect(findByAttrValue(host, PACKS_DETAIL_SECTION_ATTR, 'access')).toBeNull();

    findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'access')!.click();
    const access = findByAttrValue(host, PACKS_DETAIL_SECTION_ATTR, 'access')!;
    expect(findByAttr(access, OWNER_OPERATION_ATTR)).toBeNull();
    expect(collectTextContent(access)).toContain('Open Contracts');
    expect(
      findByAttrValue(host, PACKS_DETAIL_SECTION_ATTR, 'operation-defaults'),
    ).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Route wiring — the flag-split contracts caller (codex R3 MEDIUM)
// ──────────────────────────────────────────────────────────────────

describe('packs route access wiring', () => {
  it('the Access panel mounts from accessContractsCaller alone (local-tools disabled)', async () => {
    // Regression for the codex R3 MEDIUM: with contracts enabled but
    // local-tools disabled, no localToolsContractsCaller exists — the
    // dedicated accessContractsCaller must reach the controller or every
    // detail keeps the placeholder.
    const { bootstrapPacksRoute } = await import('../packs/bootstrap-packs-route.js');
    const doc = makeFakeDocument();
    const head = makeFakeElement('head');
    const root = makeFakeElement('div');
    const docWithHead = {
      ...doc,
      head: {
        querySelector: () => null,
        appendChild: (el: FakeElement) => head.appendChild(el),
      },
    };
    const h = makeCallers({ contracts: [door('door-a')] });
    const route = bootstrapPacksRoute({
      root: root as unknown as HTMLElement,
      document: docWithHead as unknown as Document,
      packsListCaller: async () => ({ packs: [packEntry('stripe-pack')] }),
      accessContractsCaller: h.runListContracts,
      contractGrantReadCaller: h.runGrantRead,
      contractGrantWriteCaller: h.runGrantWrite,
      catalogOperationsCaller: h.runCatalogOperations,
      // NO localTools* callers — the local-tools panel renders unavailable.
    });
    const mount = route.packsPanel()!;
    await mount.whenLoaded();
    mount.clickSelectPack('stripe-pack');
    findByAttrValue(root, PACKS_DETAIL_TAB_ATTR, 'access')!.click();

    const access = findByAttrValue(root, PACKS_DETAIL_SECTION_ATTR, 'access')!;
    expect(findByAttr(access, PACK_ACCESS_ATTR)).not.toBeNull();
    expect(collectTextContent(access)).toContain('Self (you)');
    route.dispose();
  });
});

/** ⛔ Live-drive regression: "the feature we built to let owner override every
 *  pack op default is gone."
 *
 *  A composition's own slug is not necessarily the id of the ingredient it
 *  installs — it declares its ingredients explicitly, and THOSE land in the
 *  executor registry `collection.operation.listOperations` enumerates. The
 *  membership set only ever held the composition slug, so any pack that names
 *  them differently matched nothing and lost its whole Permissions tab.
 *
 *  It looked fine because 798 of the corpus's 825 composition packs happen to
 *  name the ingredient after the composition. The 27 that don't include
 *  `rental-book` (`rental-book` → `rental-book-records`), every other `*-records`
 *  pack, `clamav-pack` (`clamav` → `clamdscan`) and `csvkit` (→ `csvclean`).
 *  Every existing test used the matching shape. */
describe('owner operation defaults — a composition that renames its ingredient', () => {
  /** rental-book's exact shape: composition `rental-book`, ingredient
   *  `rental-book-records`. */
  const renamingPack = (): PackListEntry => {
    const manifest = {
      manifest_version: 2,
      slug: 'rental-book',
      publisher: 'recued-core',
      name: 'rental-book',
      description: 'Records pack.',
      version: 1,
      recipes: [],
      requires: ['install_bulk_pack'],
      tags: [],
      contents: [{
        type: 'composition',
        composition: {
          schema_version: 1,
          slug: 'rental-book',
          ingredients: [{ slug: 'rental-book-records', kind: 'storage' }],
          operations: [],
        },
      }],
    } as unknown as BulkPackManifest;
    return {
      slug: 'rental-book', publisher: 'recued-core', name: 'rental-book',
      description: '', version: 1, pre_install: false, installed: true,
      requires: ['install_bulk_pack'], recipe_count: 0, recipe_refs: [],
      body_visibility_grant_keys: [], body_visibility_grant_count: 0, manifest,
    } as PackListEntry;
  };

  const controllerOver = (
    ingredients: ReadonlyArray<OwnerOperationIngredientView>,
  ) => createOwnerOperationController({
    document: makeFakeDocument() as unknown as Document,
    runOperations: (async () => ({ ingredients })) as OwnerOperationInventoryCaller,
    runListOverrides: (async () => ({ overrides: [] })) as OwnerOperationListCaller,
    runUpsertOverride: vi.fn() as unknown as OwnerOperationUpsertCaller,
    runDeleteOverride: vi.fn() as unknown as OwnerOperationDeleteCaller,
    onChange: () => {},
  });

  const recordsIngredient: OwnerOperationIngredientView = {
    ingredient_id: 'rental-book-records',
    name: 'Rental book records',
    operations: [{
      operation_id: 'building.create',
      operation_key: 'building.create',
      risk_tier: 'write',
    }],
  } as unknown as OwnerOperationIngredientView;

  it('membership covers the NESTED ingredient slug, not just the composition', () => {
    const slugs = packOperationIngredientSlugs(renamingPack().manifest!);
    expect(slugs).toContain('rental-book-records');
    // The composition slug is KEPT — 798 packs join on it.
    expect(slugs).toContain('rental-book');
  });

  it('⛔ renders the override rows instead of an empty tab', async () => {
    const ctrl = controllerOver([recordsIngredient]);
    await ctrl.refresh();
    const panel = ctrl.renderForPack(renamingPack()) as unknown as FakeElement | null;
    expect(panel).not.toBeNull();
    const rows = findAllByAttr(panel!, OWNER_OPERATION_ROW_ATTR);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('data-ingredient-id')).toBe('rental-book-records');
  });

  it('⛔ a pack whose ingredients match NOTHING says so instead of "none"', async () => {
    // `[].every(…)` is TRUE, so an unmatched pack used to report the same thing
    // as a pack that genuinely declares no operations — which is exactly how the
    // join bug above stayed invisible. The two must not collapse.
    const ctrl = controllerOver([{
      ingredient_id: 'someone-elses-ingredient',
      name: 'Other',
      operations: [{ operation_id: 'x', operation_key: 'x', risk_tier: 'read' }],
    } as unknown as OwnerOperationIngredientView]);
    await ctrl.refresh();
    const panel = ctrl.renderForPack(renamingPack()) as unknown as FakeElement | null;
    expect(panel).not.toBeNull();
    expect(findAllByAttr(panel!, OWNER_OPERATION_ROW_ATTR)).toHaveLength(0);
    expect(collectTextContent(panel!)).toContain('does not know this Pack’s operations yet');
  });

  /** ⛔ The case the slug fix did NOT reach. A Records pack registers its catalog
   *  under a content-addressed `records-<hash>` id — matching neither the pack
   *  slug nor its composition's — so NO amount of guessing from the manifest can
   *  find it, and the tab stayed empty for every Records pack in the corpus.
   *
   *  The server now states ownership (`pack_slug`, off
   *  `installed_pack.ingredient_ids`), and it wins over the guess. */
  it('⛔ a records catalog is claimed by the server, not guessed from the manifest', async () => {
    const ctrl = controllerOver([{
      // Nothing here resembles 'rental-book' or 'rental-book-records'.
      ingredient_id: 'records-134e99ba9db8c7b3e51dca3ae8f24b4b',
      name: 'Rental book records',
      pack_slug: 'rental-book',
      operations: [{ operation_id: 'building.create', operation_key: 'building.create',
        risk_tier: 'write' }],
    } as unknown as OwnerOperationIngredientView]);
    await ctrl.refresh();
    const panel = ctrl.renderForPack(renamingPack()) as unknown as FakeElement | null;
    expect(panel).not.toBeNull();
    const rows = findAllByAttr(panel!, OWNER_OPERATION_ROW_ATTR);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('data-ingredient-id'))
      .toBe('records-134e99ba9db8c7b3e51dca3ae8f24b4b');
  });

  it('⛔ a claimed ingredient belonging to ANOTHER pack is excluded', async () => {
    // The claim must be a filter, not just a pass. Without the equality check an
    // ownership field would widen every pack to every claimed ingredient.
    const ctrl = controllerOver([{
      ingredient_id: 'records-deadbeef',
      name: 'Someone else',
      pack_slug: 'ledger-book',
      operations: [{ operation_id: 'x', operation_key: 'x', risk_tier: 'read' }],
    } as unknown as OwnerOperationIngredientView]);
    await ctrl.refresh();
    const panel = ctrl.renderForPack(renamingPack()) as unknown as FakeElement | null;
    expect(findAllByAttr(panel!, OWNER_OPERATION_ROW_ATTR)).toHaveLength(0);
    expect(collectTextContent(panel!)).toContain('does not know this Pack’s operations yet');
  });

  it('a pack that genuinely declares no operations still renders nothing', async () => {
    // Negative control — the honest empty case must stay empty, or the new
    // branch would just be noise on every op-less pack.
    const ctrl = controllerOver([{
      ingredient_id: 'rental-book-records', name: 'Rental book records', operations: [],
    } as unknown as OwnerOperationIngredientView]);
    await ctrl.refresh();
    expect(ctrl.renderForPack(renamingPack())).toBeNull();
  });
});

/** ⛔ The Access matrix was empty for every Records pack, and that is not
 *  cosmetic. The install-time access tier is a STARTING POINT — this panel is
 *  the surface that widens it afterwards. Empty, there was no way to widen at
 *  all, so a pack installed at the default `read` was permanently read-only
 *  short of uninstalling it.
 *
 *  Cause: `packCompositionSlugs` derives membership from the manifest's
 *  composition slug, and a Records pack's catalog registers under a
 *  content-addressed `records-<hash>` id matching no name its author wrote. */
describe('pack access — a records catalog is claimed, not guessed', () => {
  const recordsCatalog = (packSlug: string | undefined) => ({
    ingredients: [{
      ingredient_id: 'records-134e99ba9db8c7b3e51dca3ae8f24b4b',
      name: 'Rental book records',
      kind: 'connection',
      ...(packSlug !== undefined ? { pack_slug: packSlug } : {}),
      operations: [{
        operation_id: 'recued-core/building.create',
        operation_key: 'building.create',
        risk_tier: 'write',
        groups: [],
      }],
    }],
  } as unknown as { ingredients: ReadonlyArray<CatalogIngredientView> });

  const mountOver = (catalog: { ingredients: ReadonlyArray<CatalogIngredientView> }) => {
    const h = makeCallers({ contracts: [] });
    (h.runCatalogOperations as unknown as { mockImplementation: (f: () => unknown) => void })
      .mockImplementation(async () => catalog);
    return mountController(h);
  };

  it('⛔ renders the matrix when the server claims the ingredient', async () => {
    const { ctrl } = mountOver(recordsCatalog('stripe-pack'));
    await ctrl.refresh();
    const panel = ctrl.renderForPack(packEntry('stripe-pack')) as unknown as FakeElement | null;
    expect(panel).not.toBeNull();
    expect(collectTextContent(panel!)).toContain('building.create');
  });

  it('an unclaimed records catalog still finds nothing — the guess cannot see it', async () => {
    // The negative that documents WHY the claim is needed: with no ownership
    // reported, the manifest-derived slug set misses `records-<hash>` entirely.
    const { ctrl } = mountOver(recordsCatalog(undefined));
    await ctrl.refresh();
    const panel = ctrl.renderForPack(packEntry('stripe-pack')) as unknown as FakeElement | null;
    expect(panel === null || !collectTextContent(panel).includes('building.create')).toBe(true);
  });

  it('a claim for a DIFFERENT pack is excluded', async () => {
    const { ctrl } = mountOver(recordsCatalog('some-other-pack'));
    await ctrl.refresh();
    const panel = ctrl.renderForPack(packEntry('stripe-pack')) as unknown as FakeElement | null;
    expect(panel === null || !collectTextContent(panel).includes('building.create')).toBe(true);
  });
});
