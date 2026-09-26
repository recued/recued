/** D-182 §7.1 / D-196 — the {Access × Audience} install grant picker.
 *
 *  Two layers:
 *    1. Pure derivation + render (`install-grant-picker.ts`):
 *       - installGrantModelFromManifest: recipe tools plus connection-backed
 *         (non-cli) ops, with access tiers tracking their risk tiers.
 *       - installGrantModelFromReviewFamilies: api families = connection-backed,
 *         connector (cli) families excluded.
 *       - installGrantModelFromMcpReviewRows: reviewed generated operations use
 *         their conservative stored risk and exact TOCTOU-bound ids.
 *       - renderInstallGrantPicker: access radios plus independent broad and
 *         expanded audience checkboxes; disabled drops the listeners.
 *    2. packs-panel integration (`mountPacksPanel`): every pack with grantable
 *       ops or recipes renders the picker and sends `install_scope`; closeDialog
 *       resets Access and Audience to their safe defaults.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  INSTALL_GRANT_ACCESS_OPTION_ATTR,
  INSTALL_GRANT_AUDIENCE_DETAIL_OPTION_ATTR,
  INSTALL_GRANT_PICKER_ATTR,
  INSTALL_GRANT_PICKER_AUDIENCE_CARRIED_OVER_ATTR,
  INSTALL_GRANT_PICKER_CARRIED_OVER_ATTR,
  INSTALL_GRANT_PICKER_STYLES,
  INSTALL_GRANT_SCOPE_ATTR,
  INSTALL_GRANT_SCOPE_OPTION_ATTR,
  installGrantModelFromManifest,
  installGrantModelFromMcpReviewRows,
  installGrantModelFromReviewFamilies,
  renderInstallGrantPicker,
} from '../settings/install-grant-picker.js';
import type { InstallAudienceSelection, InstallScopeWho } from '@recued/contracts';
import { INSTALL_CONNECT_SUMMARY_ATTR } from '../settings/install-connect-picker.js';
import {
  PACKS_DIALOG_INSTALL_BTN_ATTR,
  PACKS_PANEL_STYLES,
  mountPacksPanel,
  type PacksInstallCaller,
  type PacksListCaller,
} from '../settings/packs-panel.js';
import type {
  BulkPackInstallResultLike,
  BulkPackManifest,
  CompositionIngredient,
  CompositionReviewOperationFamily,
  InstallAccessTier,
  OpKind,
  PackContentRef,
  PackListEntry,
  PackOperationRow,
  RiskTier,
} from '@recued/contracts';

// ──────────────────────────────────────────────────────────────────
// Fake DOM (mirrors d-145-pa10-packs-panel.test.ts)
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  checked: boolean;
  className: string;
  id: string;
  type: string;
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
  dispatch(name: string): void;
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
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
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
      for (const fn of listeners.get('click') ?? []) fn({ target: el });
    },
    dispatch: (name) => {
      for (const fn of listeners.get(name) ?? []) fn({ target: el });
    },
  };
  return el;
};

const makeFakeDocument = (): { createElement(tag: string): FakeElement } => ({
  createElement: (tag) => makeFakeElement(tag),
});

const findByAttr = (root: FakeElement, attr: string): FakeElement | null => {
  if (root.hasAttribute(attr)) return root;
  for (const c of root.children) {
    const hit = findByAttr(c, attr);
    if (hit) return hit;
  }
  return null;
};

const findAllByAttr = (root: FakeElement, attr: string): FakeElement[] => {
  const out: FakeElement[] = [];
  const walk = (n: FakeElement): void => {
    if (n.hasAttribute(attr)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};

const collectText = (root: FakeElement): string => {
  let out = root.textContent ?? '';
  for (const c of root.children) out += collectText(c);
  return out;
};

// ──────────────────────────────────────────────────────────────────
// Builders
// ──────────────────────────────────────────────────────────────────

const op = (
  name: string,
  risk: RiskTier,
  ingredient = 'vendor',
): PackOperationRow => ({
  op: name,
  ingredient,
  risk,
  approval: risk === 'read' ? 'never' : 'ask',
  bind: {},
});

const composition = (
  kind: OpKind,
  operations: PackOperationRow[],
  ingredientSlug = 'vendor',
): CompositionIngredient => ({
  schema_version: 1,
  slug: 'vendor-accounting',
  ingredients: [{ slug: ingredientSlug, kind }],
  operations,
});

const manifestWith = (contents: PackContentRef[]): BulkPackManifest => ({
  manifest_version: 1,
  slug: 'test-pack',
  publisher: 'recued-core',
  name: 'Test Pack',
  description: 'A pack for testing.',
  version: 1,
  recipes: [{ slug: 'recipe-a', version: 1 }],
  requires: ['install_bulk_pack'],
  tags: ['test'],
  contents,
});

const compositionPack = (
  kind: OpKind,
  operations: PackOperationRow[],
): BulkPackManifest =>
  manifestWith([{ type: 'composition', composition: composition(kind, operations) }]);

const recipeOnlyPack = (): BulkPackManifest => ({
  manifest_version: 1,
  slug: 'recipe-only',
  publisher: 'recued-core',
  name: 'Recipe-only Pack',
  description: 'No composition.',
  version: 1,
  recipes: [{ slug: 'recipe-a', version: 1 }],
  requires: ['install_bulk_pack'],
  tags: ['test'],
});

const family = (
  key: string,
  risk_tier: RiskTier,
  surface: 'api' | 'connector',
): CompositionReviewOperationFamily => ({
  key,
  surface,
  risk_tier,
  approval_mapping: risk_tier === 'read' ? 'never' : 'ask',
});

// ══════════════════════════════════════════════════════════════════
// Derivation — installGrantModelFromManifest
// ══════════════════════════════════════════════════════════════════

describe('D-182 §7.1 (5b.2) — installGrantModelFromManifest', () => {
  it('models recipe-only tools as read-tier grantable entries', () => {
    expect(installGrantModelFromManifest(recipeOnlyPack())?.grantsByAccess.read).toEqual([
      'recued-core/recipe-a',
    ]);
  });

  it('models v2 recipe content refs as read-tier grantable entries', () => {
    const manifest: BulkPackManifest = {
      ...recipeOnlyPack(),
      manifest_version: 2,
      artifact_type: 'pack',
      pack_kind: 'app_pack',
      recipes: [],
      contents: [{ type: 'recipe', slug: 'recipe-a', version: 1 }],
    };
    expect(installGrantModelFromManifest(manifest)?.grantsByAccess.read).toEqual([
      'recued-core/recipe-a',
    ]);
  });

  it('keeps a pure-cli pack grantable when it also installs a recipe tool', () => {
    const model = installGrantModelFromManifest(
      compositionPack('cli', [op('audio.transcribe', 'write')]),
    );
    expect(model?.grantsByAccess.read).toEqual(['recued-core/recipe-a']);
  });

  it('read-only http pack → only the read tier is offered + the default', () => {
    const model = installGrantModelFromManifest(
      compositionPack('http', [op('invoice.search', 'read'), op('invoice.read', 'read')]),
    );
    expect(model).not.toBeNull();
    expect(model!.accessOptions).toEqual(['read']);
    expect(model!.defaultAccess).toBe('read');
    expect(model!.grantsByAccess.read).toEqual([
      'invoice.read',
      'invoice.search',
      'recued-core/recipe-a',
    ]);
    expect(model!.grantsByAccess.write).toEqual([]);
    expect(model!.grantsByAccess.all).toEqual([]);
  });

  it('read+write http pack → read + write tiers (no All)', () => {
    const model = installGrantModelFromManifest(
      compositionPack('http', [op('issue.list', 'read'), op('issue.create', 'write')]),
    );
    expect(model!.accessOptions).toEqual(['read', 'write']);
    expect(model!.grantsByAccess.read).toEqual(['issue.list', 'recued-core/recipe-a']);
    expect(model!.grantsByAccess.write).toEqual(['issue.create']);
    expect(model!.grantsByAccess.all).toEqual([]);
  });

  it('read+write+destructive http pack → all three tiers; destructive lands under All', () => {
    const model = installGrantModelFromManifest(
      compositionPack('http', [
        op('invoice.search', 'read'),
        op('invoice.create', 'write'),
        op('invoice.delete', 'destructive'),
      ]),
    );
    expect(model!.accessOptions).toEqual(['read', 'write', 'all']);
    expect(model!.grantsByAccess.all).toEqual(['invoice.delete']);
  });

  it('admin op without write → write tier skipped (it would grant nothing), All offered', () => {
    const model = installGrantModelFromManifest(
      compositionPack('http', [op('account.read', 'read'), op('account.configure', 'admin')]),
    );
    expect(model!.accessOptions).toEqual(['read', 'all']);
    expect(model!.grantsByAccess.all).toEqual(['account.configure']);
  });

  it('mixed cli + http ops → only the http (connection-backed) ops count', () => {
    const comp: CompositionIngredient = {
      schema_version: 1,
      slug: 'mixed',
      ingredients: [
        { slug: 'api', kind: 'http' },
        { slug: 'local', kind: 'cli' },
      ],
      operations: [
        op('deal.read', 'read', 'api'),
        op('file.transcode', 'write', 'local'),
      ],
    };
    const model = installGrantModelFromManifest(
      manifestWith([{ type: 'composition', composition: comp }]),
    );
    // The cli write op must NOT promote the access ceiling to +Write.
    expect(model!.accessOptions).toEqual(['read']);
    expect(model!.grantsByAccess.read).toEqual(['deal.read', 'recued-core/recipe-a']);
  });
});

// ══════════════════════════════════════════════════════════════════
// Derivation — installGrantModelFromReviewFamilies
// ══════════════════════════════════════════════════════════════════

describe('D-182 §7.1 (5b.2) — installGrantModelFromReviewFamilies', () => {
  it('keeps api families, excludes connector (cli) families', () => {
    const model = installGrantModelFromReviewFamilies([
      family('deal.read', 'read', 'api'),
      family('deal.update', 'write', 'api'),
      family('audio.transcribe', 'write', 'connector'),
    ]);
    expect(model!.accessOptions).toEqual(['read', 'write']);
    expect(model!.grantsByAccess.read).toEqual(['deal.read']);
    expect(model!.grantsByAccess.write).toEqual(['deal.update']);
  });

  it('returns null when every family is a cli connector', () => {
    expect(
      installGrantModelFromReviewFamilies([family('audio.transcribe', 'write', 'connector')]),
    ).toBeNull();
  });

  it('returns null for an empty family list', () => {
    expect(installGrantModelFromReviewFamilies([])).toBeNull();
  });
});

describe('D-228 — generated MCP review install grants', () => {
  it('offers an explicit write step-up for the exact reviewed operation ids', () => {
    const model = installGrantModelFromMcpReviewRows([
      {
        op: 'search_docs_b2',
        tool: 'search_docs',
        stored: { risk: 'write', approval: 'ask' },
      },
      {
        op: 'delete_docs_a1',
        tool: 'delete_docs',
        stored: { risk: 'write', approval: 'ask' },
      },
    ]);
    expect(model?.accessOptions).toEqual(['read', 'write']);
    expect(model?.defaultAccess).toBe('read');
    expect(model?.grantsByAccess.read).toEqual([]);
    expect(model?.grantsByAccess.write).toEqual([
      'delete_docs_a1',
      'search_docs_b2',
    ]);
  });

  it('returns no consent model when the healthy server publishes no tools', () => {
    expect(installGrantModelFromMcpReviewRows([])).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Render — renderInstallGrantPicker
// ══════════════════════════════════════════════════════════════════

describe('D-182 §7.1 (5b.2) — renderInstallGrantPicker', () => {
  const model = installGrantModelFromManifest(
    compositionPack('http', [
      op('invoice.search', 'read'),
      op('invoice.create', 'write'),
      op('invoice.delete', 'destructive'),
    ]),
  )!;

  it('renders one radio per access option with data-access values', () => {
    const doc = makeFakeDocument();
    const node = renderInstallGrantPicker({
      document: doc as unknown as Document,
      model,
      access: 'read',
      scope: 'owner',
      onAccess: () => {},
      onScope: () => {},
    }) as unknown as FakeElement;
    const radios = findAllByAttr(node, INSTALL_GRANT_ACCESS_OPTION_ATTR);
    expect(radios.map((r) => r.getAttribute('data-access'))).toEqual([
      'read',
      'write',
      'all',
    ]);
    // `read` pre-selected, the others not.
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
  });

  it('reflects the host-selected tier as the checked radio', () => {
    const doc = makeFakeDocument();
    const node = renderInstallGrantPicker({
      document: doc as unknown as Document,
      model,
      access: 'write',
      scope: 'owner',
      onAccess: () => {},
      onScope: () => {},
    }) as unknown as FakeElement;
    const radios = findAllByAttr(node, INSTALL_GRANT_ACCESS_OPTION_ATTR);
    expect(radios.find((r) => r.checked)!.getAttribute('data-access')).toBe('write');
  });

  it('fires onAccess with the picked tier on change', () => {
    const doc = makeFakeDocument();
    const picks: InstallAccessTier[] = [];
    const node = renderInstallGrantPicker({
      document: doc as unknown as Document,
      model,
      access: 'read',
      scope: 'owner',
      onAccess: (t) => picks.push(t),
      onScope: () => {},
    }) as unknown as FakeElement;
    const all = findAllByAttr(node, INSTALL_GRANT_ACCESS_OPTION_ATTR).find(
      (r) => r.getAttribute('data-access') === 'all',
    )!;
    all.dispatch('change');
    expect(picks).toEqual(['all']);
  });

  it('renders independent audience checkboxes with owner pre-selected', () => {
    const doc = makeFakeDocument();
    const node = renderInstallGrantPicker({
      document: doc as unknown as Document,
      model,
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
      onAccess: () => {},
      onAudience: () => {},
    }) as unknown as FakeElement;
    const scope = findByAttr(node, INSTALL_GRANT_SCOPE_ATTR);
    expect(scope).not.toBeNull();
    const checks = findAllByAttr(node, INSTALL_GRANT_SCOPE_OPTION_ATTR);
    expect(checks.map((r) => r.getAttribute('data-scope'))).toEqual([
      'owner',
      'all_customers',
      'all_other_contracts',
    ]);
    expect(checks.map((r) => r.checked)).toEqual([true, false, false]);
    expect(collectText(scope!)).toContain('All customers');
    expect(collectText(scope!)).toContain('Everyone else you have an agreement with');
    // Audience hints disclose the Option-A future-door limitation.
    expect(collectText(scope!)).toContain('added later');
  });

  it('reflects owner-plus-customer checklist combinations', () => {
    const doc = makeFakeDocument();
    const node = renderInstallGrantPicker({
      document: doc as unknown as Document,
      model,
      access: 'read',
      audience: { owner: true, all_customers: true, all_other_contracts: false },
      onAccess: () => {},
      onAudience: () => {},
    }) as unknown as FakeElement;
    const checked = findAllByAttr(node, INSTALL_GRANT_SCOPE_OPTION_ATTR)
      .filter((entry) => entry.checked)
      .map((entry) => entry.getAttribute('data-scope'));
    expect(checked).toEqual(['owner', 'all_customers']);
  });

  it('fires onAudience with the complete customer checklist on change', () => {
    const doc = makeFakeDocument();
    const picks: InstallAudienceSelection[] = [];
    const node = renderInstallGrantPicker({
      document: doc as unknown as Document,
      model,
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
      onAccess: () => {},
      onAudience: (s) => picks.push(s),
    }) as unknown as FakeElement;
    const customers = findAllByAttr(node, INSTALL_GRANT_SCOPE_OPTION_ATTR).find(
      (r) => r.getAttribute('data-scope') === 'all_customers',
    )!;
    customers.checked = true;
    customers.dispatch('change');
    expect(picks).toEqual([
      { owner: true, all_customers: true, all_other_contracts: false },
    ]);
  });

  it('renders expandable tier/contract choices and carries the narrow selection', () => {
    const doc = makeFakeDocument();
    const picks: InstallAudienceSelection[] = [];
    const node = renderInstallGrantPicker({
      document: doc as unknown as Document,
      model,
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
      customerTierOptions: [{ id: 'tier-pro', label: 'Pro' }],
      contractOptions: [{ id: 'ct-partner', label: 'Partner' }],
      onAccess: () => {},
      onAudience: (audience) => picks.push(audience),
    }) as unknown as FakeElement;
    const details = findAllByAttr(node, INSTALL_GRANT_AUDIENCE_DETAIL_OPTION_ATTR);
    expect(details.map((entry) => [
      entry.getAttribute('data-audience-kind'),
      entry.getAttribute('data-audience-id'),
    ])).toEqual([
      ['tier', 'tier-pro'],
      ['contract', 'ct-partner'],
    ]);
    details[0]!.checked = true;
    details[0]!.dispatch('change');
    expect(picks).toEqual([{
      owner: true,
      all_customers: false,
      all_other_contracts: false,
      customer_tier_ids: ['tier-pro'],
    }]);
  });

  it('disabled drops the scope change listeners (no onScope fires)', () => {
    const doc = makeFakeDocument();
    const picks: InstallScopeWho[] = [];
    const node = renderInstallGrantPicker({
      document: doc as unknown as Document,
      model,
      access: 'read',
      scope: 'owner',
      disabled: true,
      onAccess: () => {},
      onScope: (s) => picks.push(s),
    }) as unknown as FakeElement;
    const radios = findAllByAttr(node, INSTALL_GRANT_SCOPE_OPTION_ATTR);
    for (const r of radios) {
      expect(r.hasAttribute('disabled')).toBe(true);
      r.dispatch('change');
    }
    expect(picks).toEqual([]);
  });

  it('disabled drops the change listeners (no onAccess fires)', () => {
    const doc = makeFakeDocument();
    const picks: InstallAccessTier[] = [];
    const node = renderInstallGrantPicker({
      document: doc as unknown as Document,
      model,
      access: 'read',
      scope: 'owner',
      disabled: true,
      onAccess: (t) => picks.push(t),
      onScope: () => {},
    }) as unknown as FakeElement;
    const radios = findAllByAttr(node, INSTALL_GRANT_ACCESS_OPTION_ATTR);
    for (const r of radios) {
      expect(r.hasAttribute('disabled')).toBe(true);
      r.dispatch('change');
    }
    expect(picks).toEqual([]);
  });

  it('shows a Grants caption listing the ops a tier newly grants', () => {
    const doc = makeFakeDocument();
    const node = renderInstallGrantPicker({
      document: doc as unknown as Document,
      model,
      access: 'read',
      scope: 'owner',
      onAccess: () => {},
      onScope: () => {},
    }) as unknown as FakeElement;
    const text = collectText(node);
    expect(text).toContain('invoice.search');
    expect(text).toContain('invoice.create');
    expect(text).toContain('invoice.delete');
  });
});

// ══════════════════════════════════════════════════════════════════
// packs-panel integration
// ══════════════════════════════════════════════════════════════════

const baseEntry = (manifest: BulkPackManifest): PackListEntry => ({
  slug: manifest.slug,
  publisher: manifest.publisher,
  name: manifest.name,
  description: manifest.description,
  version: manifest.version,
  pre_install: manifest.pre_install === true,
  installed: false,
  requires: [...manifest.requires],
  recipe_count: manifest.recipes.length,
  recipe_refs: manifest.recipes.map((r) => ({ slug: r.slug, version: r.version })),
  body_visibility_grant_keys: [...(manifest.mcp_body_visibility_grants ?? [])],
    ...(typeof manifest.service_kind === 'string' ? { service_kind: manifest.service_kind } : {}),
    ...(typeof manifest.repo === 'string' ? { repo: manifest.repo } : {}),
  body_visibility_grant_count: manifest.mcp_body_visibility_grants?.length ?? 0,
  manifest,
});

interface InstallCall {
  manifest: unknown;
  granted_permissions: ReadonlyArray<string>;
  install_scope?: { access: InstallAccessTier; scope?: string };
}

const setup = (
  manifest: BulkPackManifest,
  entry: Partial<PackListEntry> = {},
  mountExtra: Partial<Parameters<typeof mountPacksPanel>[0]> = {},
) => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const installCalls: InstallCall[] = [];
  const runList: PacksListCaller = async () => ({ packs: [{ ...baseEntry(manifest), ...entry }] });
  const runInstall: PacksInstallCaller = async (args) => {
    installCalls.push(args as InstallCall);
    return { result: { ok: true, installed: [], rolled_back: [] } satisfies BulkPackInstallResultLike };
  };
  const mount = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList,
    // The panel is DETAIL-only — open the pack so `clickInstall` reaches the
    // detail's install affordance (was the list row).
    initialSlug: manifest.slug,
    runInstall,
    ...mountExtra,
  });
  return { host, mount, installCalls };
};

describe('D-182 §7.1 (5b.2) — packs-panel install dialog grant picker', () => {
  const originalDoc = (globalThis as { document?: unknown }).document;
  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDoc;
  });

  it('renders the picker for a connection-backed pack + defaults the tier to read', async () => {
    const { host, mount } = setup(
      compositionPack('http', [op('invoice.search', 'read'), op('invoice.create', 'write')]),
    );
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    expect(findByAttr(host, INSTALL_GRANT_PICKER_ATTR)).not.toBeNull();
    expect(mount.getDialogAccessTier()).toBe('read');
  });

  it('sends install_scope { access: read } when installed at the default tier', async () => {
    const { mount, installCalls } = setup(
      compositionPack('http', [op('invoice.search', 'read'), op('invoice.create', 'write')]),
    );
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    await mount.clickConfirmInstall();
    expect(installCalls).toHaveLength(1);
    expect(installCalls[0].install_scope).toEqual({
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
    });
  });

  it('sends the picked tier (+Write) as install_scope.access', async () => {
    const { mount, installCalls } = setup(
      compositionPack('http', [op('invoice.search', 'read'), op('invoice.create', 'write')]),
    );
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    mount.clickAccessOption('write');
    expect(mount.getDialogAccessTier()).toBe('write');
    await mount.clickConfirmInstall();
    expect(installCalls[0].install_scope).toEqual({
      access: 'write',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
    });
  });

  it('ignores an access tier the pack does not offer (read-only pack stays read)', async () => {
    const { mount, installCalls } = setup(
      compositionPack('http', [op('invoice.search', 'read')]),
    );
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    mount.clickAccessOption('all'); // not offered → no-op
    expect(mount.getDialogAccessTier()).toBe('read');
    await mount.clickConfirmInstall();
    expect(installCalls[0].install_scope).toEqual({
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
    });
  });

  it('maps the legacy Everyone test seam onto all broad audience checks', async () => {
    const { mount, installCalls } = setup(
      compositionPack('http', [op('invoice.search', 'read'), op('invoice.create', 'write')]),
    );
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    expect(mount.getDialogScope()).toBe('owner'); // safe default
    mount.clickScopeOption('all_contracts');
    expect(mount.getDialogScope()).toBe('all_contracts');
    await mount.clickConfirmInstall();
    expect(installCalls[0].install_scope).toEqual({
      access: 'read',
      audience: { owner: true, all_customers: true, all_other_contracts: true },
    });
  });

  it('resets the Scope to owner on reopen (lockstep with the tier reset)', async () => {
    const { mount } = setup(
      compositionPack('http', [op('invoice.search', 'read'), op('invoice.create', 'write')]),
    );
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    mount.clickScopeOption('all_contracts');
    mount.clickAccessOption('write');
    expect(mount.getDialogScope()).toBe('all_contracts');
    mount.clickCancelDialog();
    mount.clickInstall('test-pack');
    // Both picks reset together — the lockstep `clearDialogGrantPicks`.
    expect(mount.getDialogScope()).toBe('owner');
    expect(mount.getDialogAccessTier()).toBe('read');
  });

  it('renders the checklist + sends install_scope for a recipe-only pack', async () => {
    const { host, mount, installCalls } = setup(recipeOnlyPack());
    await mount.whenLoaded();
    mount.clickInstall('recipe-only');
    expect(findByAttr(host, INSTALL_GRANT_PICKER_ATTR)).not.toBeNull();
    expect(mount.getDialogAccessTier()).toBe('read');
    expect(mount.getDialogScope()).toBe('owner');
    await mount.clickConfirmInstall();
    expect(installCalls[0].install_scope).toEqual({
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
    });
  });

  it('still renders the checklist for a pure-cli pack that installs a recipe', async () => {
    const { host, mount, installCalls } = setup(
      compositionPack('cli', [op('audio.transcribe', 'write')]),
    );
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    expect(findByAttr(host, INSTALL_GRANT_PICKER_ATTR)).not.toBeNull();
    expect(mount.getDialogAccessTier()).toBe('read');
    await mount.clickConfirmInstall();
    expect(installCalls[0].install_scope).toEqual({
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
    });
  });

  it('resets the tier to read when the dialog is cancelled + re-opened', async () => {
    const { mount } = setup(
      compositionPack('http', [op('invoice.search', 'read'), op('invoice.create', 'write')]),
    );
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    mount.clickAccessOption('write');
    expect(mount.getDialogAccessTier()).toBe('write');
    mount.clickCancelDialog();
    mount.clickInstall('test-pack');
    expect(mount.getDialogAccessTier()).toBe('read');
  });

  it('resets the tier to read on reopen after a successful install (Codex MED — success path)', async () => {
    const { mount, installCalls } = setup(
      compositionPack('http', [op('invoice.search', 'read'), op('invoice.create', 'write')]),
    );
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    mount.clickAccessOption('write');
    await mount.clickConfirmInstall();
    expect(installCalls[0].install_scope).toEqual({
      access: 'write',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
    });
    // The success path closes the dialog WITHOUT going through closeDialog; the
    // openDialog + success-path resets must still drop the stale `write` pick.
    mount.clickInstall('test-pack');
    expect(mount.getDialogAccessTier()).toBe('read');
  });
});

describe('an update starts at the Access the pack holds now', () => {
  /** An update REPLACES the pack's grants. The dialog started at "Read only"
   *  whatever the owner had chosen, so pressing Update on a "Read + write" pack
   *  took its writes away (driven live: the importer then failed
   *  `operation_not_granted`). The server reads the tier back from the grants
   *  (`current_access`); the dialog starts there and says so. */
  const originalDoc = (globalThis as { document?: unknown }).document;
  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDoc;
  });

  const update = (current?: InstallAccessTier): Partial<PackListEntry> => ({
    installed: false,
    installed_any_version: true,
    ...(current !== undefined ? { current_access: current } : {}),
  });
  const readWrite = (): BulkPackManifest =>
    compositionPack('http', [op('invoice.search', 'read'), op('invoice.create', 'write')]);
  const everyTier = (): BulkPackManifest => compositionPack('http', [
    op('invoice.search', 'read'), op('invoice.create', 'write'), op('invoice.delete', 'destructive'),
  ]);

  it('⛔ a "Read + write" pack updates at Read + write, and the dialog says why', async () => {
    const { host, mount, installCalls } = setup(readWrite(), update('write'));
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    expect(mount.getDialogAccessTier()).toBe('write');
    // What the owner SEES checked is what the install sends.
    expect(findAllByAttr(host, INSTALL_GRANT_ACCESS_OPTION_ATTR).find((r) => r.checked)
      ?.getAttribute('data-access')).toBe('write');
    const note = findByAttr(host, INSTALL_GRANT_PICKER_CARRIED_OVER_ATTR);
    expect(note?.getAttribute(INSTALL_GRANT_PICKER_CARRIED_OVER_ATTR)).toBe('write');
    expect(collectText(note!)).toBe(
      'This Pack has “Read + write” now, so the update starts there. Pick another level to change it.',
    );
    await mount.clickConfirmInstall();
    expect(installCalls[0].install_scope?.access).toBe('write');
  });

  it('the owner\'s own pick still wins', async () => {
    const { mount, installCalls } = setup(readWrite(), update('write'));
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    mount.clickAccessOption('read');
    expect(mount.getDialogAccessTier()).toBe('read');
    await mount.clickConfirmInstall();
    expect(installCalls[0].install_scope?.access).toBe('read');
  });

  it('never starts ABOVE what the pack holds', async () => {
    const { host, mount } = setup(everyTier(), update('read'));
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    expect(mount.getDialogAccessTier()).toBe('read');
    expect(findByAttr(host, INSTALL_GRANT_PICKER_CARRIED_OVER_ATTR)?.getAttribute(
      INSTALL_GRANT_PICKER_CARRIED_OVER_ATTR,
    )).toBe('read');
  });

  it('a tier the update no longer offers starts at the highest one below it — and claims nothing', async () => {
    const { host, mount } = setup(readWrite(), update('all'));
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    expect(mount.getDialogAccessTier()).toBe('write');
    // "This Pack has Full access now" beside a picker with no Full access
    // would describe a choice the owner cannot make.
    expect(findByAttr(host, INSTALL_GRANT_PICKER_CARRIED_OVER_ATTR)).toBeNull();
  });

  it('an update without current_access (an older server) starts at Read only, with no note', async () => {
    const { host, mount } = setup(everyTier(), update());
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    expect(mount.getDialogAccessTier()).toBe('read');
    expect(findByAttr(host, INSTALL_GRANT_PICKER_CARRIED_OVER_ATTR)).toBeNull();
  });

  it('a fresh install never carries anything over', async () => {
    const { host, mount } = setup(everyTier(), { installed: false, current_access: 'all' });
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    expect(mount.getDialogAccessTier()).toBe('read');
    expect(findByAttr(host, INSTALL_GRANT_PICKER_CARRIED_OVER_ATTR)).toBeNull();
  });

  it('reopening the dialog starts at the pack\'s tier again, not the last pick', async () => {
    const { mount } = setup(everyTier(), update('write'));
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    mount.clickAccessOption('all');
    mount.clickCancelDialog();
    mount.clickInstall('test-pack');
    expect(mount.getDialogAccessTier()).toBe('write');
  });
});

describe('an update starts at who may use the pack now (D-294)', () => {
  /** An update REPLACES the pack's share. The dialog started at "only you", so
   *  pressing Update withdrew the pack from every customer and agreement. The
   *  server reads the share back (`current_audience`); the dialog starts there,
   *  shows it, and says so. */
  const originalDoc = (globalThis as { document?: unknown }).document;
  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDoc;
  });

  const pack = (): BulkPackManifest =>
    compositionPack('http', [op('invoice.search', 'read'), op('invoice.create', 'write')]);
  const carried = {
    owner: true,
    all_customers: false,
    all_other_contracts: false,
    customer_tier_ids: ['gold'],
    contract_ids: ['door-a', 'cust-9'],
  };
  const lists = {
    runSellerOverview: async () => ({
      tiers: [{ tier_id: 'gold', active: true, display_name: 'Gold', entitlement_key: 'gold' }],
      customers: [{ contract_id: 'cust-9', email: 'nine@shop.example', source_customer_id: 'c9' }],
    }) as never,
    runListContracts: async () => ({
      contracts: [{ contract_id: 'door-a', display_name: 'Bookkeeper', lifecycle_state: 'active' }],
    }) as never,
  };
  const update = (audience?: typeof carried): Partial<PackListEntry> => ({
    installed: false,
    installed_any_version: true,
    ...(audience !== undefined ? { current_audience: audience } : {}),
  });
  const detail = (host: FakeElement, kind: string, id: string): FakeElement | undefined =>
    findAllByAttr(host, INSTALL_GRANT_AUDIENCE_DETAIL_OPTION_ATTR)
      .find((box) => box.getAttribute('data-audience-kind') === kind && box.getAttribute('data-audience-id') === id);

  it('⛔ a pack shared with a customer package, an agreement and one customer updates shared with them all — shown, and said', async () => {
    const { host, mount, installCalls } = setup(pack(), update(carried), lists);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    expect(mount.getDialogAudience()).toEqual(carried);
    expect(findByAttr(host, INSTALL_GRANT_PICKER_AUDIENCE_CARRIED_OVER_ATTR)).not.toBeNull();
    // Every carried choice is ticked where the owner can see it…
    expect(detail(host, 'tier', 'gold')?.checked).toBe(true);
    expect(detail(host, 'contract', 'door-a')?.checked).toBe(true);
    // …including a customer shared one by one, by name — a customer is
    // otherwise chosen only through its package.
    expect(detail(host, 'contract', 'cust-9')?.checked).toBe(true);
    // …in sections that are OPEN — a carried choice never hides behind a summary.
    expect(findAllByAttr(host, 'open')).toHaveLength(2);
    await mount.clickConfirmInstall();
    expect(installCalls[0].install_scope).toEqual({ access: 'read', audience: carried });
  });

  it('unticking one carried-over customer stops sharing with that customer only', async () => {
    const { host, mount } = setup(pack(), update(carried), lists);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    const nine = detail(host, 'contract', 'cust-9')!;
    nine.checked = false;
    nine.dispatch('change');
    expect(mount.getDialogAudience()).toEqual({ ...carried, contract_ids: ['door-a'] });
  });

  it('a fresh install starts at only you, with no note', async () => {
    const { host, mount } = setup(pack(), { installed: false, current_audience: carried }, lists);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    expect(mount.getDialogAudience()).toEqual({ owner: true, all_customers: false, all_other_contracts: false });
    expect(findByAttr(host, INSTALL_GRANT_PICKER_AUDIENCE_CARRIED_OVER_ATTR)).toBeNull();
  });

  it('an update from a server that sends no current_audience starts at only you, with no note', async () => {
    const { host, mount } = setup(pack(), update(), lists);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    expect(mount.getDialogAudience()).toEqual({ owner: true, all_customers: false, all_other_contracts: false });
    expect(findByAttr(host, INSTALL_GRANT_PICKER_AUDIENCE_CARRIED_OVER_ATTR)).toBeNull();
  });
});

describe('an update keeps the account the pack uses (D-294)', () => {
  const originalDoc = (globalThis as { document?: unknown }).document;
  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDoc;
  });

  const requirement = {
    authority: 'login.microsoftonline.com',
    api_base: 'https://graph.microsoft.com/v1.0',
    vendor: 'onedrive',
    auth: {
      type: 'oauth2_refresh',
      authorize_url: 'https://login.microsoftonline.com/authorize',
      token_endpoint: 'https://login.microsoftonline.com/token',
    },
  };
  const account = (name: string, display: string) => ({
    kind: 'api', name, display_name: display, base_url: 'https://graph.microsoft.com/v1.0', auth_type: 'oauth2_refresh',
  });

  it('⛔ two accounts of one vendor: the update starts at, shows and SENDS the one the pack uses — not the first by name', async () => {
    const { host, mount, installCalls } = setup(
      compositionPack('http', [op('invoice.search', 'read'), op('invoice.create', 'write')]),
      {
        installed: false,
        installed_any_version: true,
        current_connection: 'work-od',
        connection_requirements: [requirement],
      } as Partial<PackListEntry>,
      {
        runConnectionList: async () => ({
          connections: [account('home-od', 'home@live'), account('work-od', 'work@contoso')],
        }) as never,
      },
    );
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    expect(collectText(findByAttr(host, INSTALL_CONNECT_SUMMARY_ATTR)!)).toBe('Keeps using: work@contoso');
    await mount.clickConfirmInstall();
    expect((installCalls[0] as { chosen_connection?: string }).chosen_connection).toBe('work-od');
  });
});

describe('D-182 §7.1 (5b.2) — picker presentation contract', () => {
  it('keeps Access and Scope as responsive, visibly selected card groups', () => {
    expect(INSTALL_GRANT_PICKER_STYLES).toContain(
      'grid-template-columns: repeat(auto-fit, minmax(176px, 1fr))',
    );
    expect(INSTALL_GRANT_PICKER_STYLES).toContain(
      '.igp-access-row:has(.igp-access-radio:checked)',
    );
    expect(INSTALL_GRANT_PICKER_STYLES).toContain(
      '.igp-scope-row:has(.igp-scope-check:checked)',
    );
    expect(INSTALL_GRANT_PICKER_STYLES).toContain('@media (max-width: 640px)');
  });

  it('keeps catalog text and embedded picker tracks inside pack consent', () => {
    expect(PACKS_PANEL_STYLES).toMatch(
      /\[data-recued-packs-dialog\]\s*\{[^}]*box-sizing:\s*border-box[^}]*min-width:\s*0[^}]*max-width:\s*100%/s,
    );
    expect(PACKS_PANEL_STYLES).toContain(
      '[data-recued-packs-dialog] > * {\n  min-width: 0;\n  max-width: 100%;',
    );
    expect(PACKS_PANEL_STYLES).toMatch(
      /\.packs-dialog-heading\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(PACKS_PANEL_STYLES).toMatch(
      /\.packs-dialog-list > li\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(PACKS_PANEL_STYLES).toContain(
      'grid-template-columns: repeat(auto-fit, minmax(min(176px, 100%), 1fr));',
    );
  });
});

/** Access and Scope are ONE decision in two steps — grant THESE ops to THOSE
 *  contracts. Described separately ("Choose what this pack may do" / "Who may use
 *  these grants") the tier reads as a global capability switch and the pairing
 *  that actually governs the install is invisible.
 *
 *  Pinned because it is copy: nothing else fails when it drifts, and the drift
 *  reintroduces exactly the misreading it was written to remove. */
describe('install grant picker — the two steps say they are two steps', () => {
  const twoStepModel = installGrantModelFromManifest(
    // `manifestWith` takes PackContentRefs, not raw operation rows — every other
    // call site here goes through compositionPack, which wraps them.
    compositionPack('http', [
      op('invoice.read', 'read'),
      op('invoice.create', 'write'),
      op('invoice.delete', 'destructive'),
    ]),
  )!;

  const render = () => {
    const doc = makeFakeDocument();
    return renderInstallGrantPicker({
      document: doc as unknown as Document,
      model: twoStepModel,
      access: 'read',
      scope: 'owner',
      onAccess: () => {},
      onScope: () => {},
    }) as unknown as FakeElement;
  };

  it('numbers both halves so neither reads as the whole choice', () => {
    const text = collectText(render());
    expect(text).toContain('step 1 of 2');
    expect(text).toContain('step 2 of 2');
  });

  it('each half points at the other', () => {
    const text = collectText(render());
    // Access says where its grants land…
    expect(text).toContain('people you choose in step 2');
    // …and Scope says what it is distributing.
    expect(text).toContain('what you chose in step 1');
  });

  it('⛔ says the tiers are cumulative, and that YOU are one of the contracts', () => {
    const text = collectText(render());
    // Without this, `write` reads as write-only and `read` reads as harmless.
    expect(text).toContain('includes the ones above it');
    // The fact that explains why a read-only install denies the pack's OWN write
    // recipes when the owner runs them.
    expect(text).toContain('counts as one of them, like any other');
  });

  it('the per-tier op list says it ADDS, not that it is the whole grant', () => {
    // The server grants the cumulative band, so a `write` tier listing one write
    // op while also granting every read op read as exhaustive.
    const text = collectText(render());
    expect(text).toContain('Adds: ');
    expect(text).not.toContain('Grants: ');
  });
});
