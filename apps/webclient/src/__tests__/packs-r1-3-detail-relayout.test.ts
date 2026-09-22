/** Packs R22 R1.3 — detail re-layout + Delta 6.
 *
 *  Covers the R22.1 `#packs/<slug>` fixed IDENTITY plus its DETAIL /
 *  PERMISSIONS / ACCESS tabs, the action affordances that live in the detail,
 *  and the Delta 6 removal of the "Show advanced" toggle (foundation Delete is
 *  direct in the detail; the confirm-strip warning is the safeguard).
 *
 *  The panel is now the DETAIL only — the slim LIST rows moved to the surface's
 *  browse list, so the list-row describe was dropped in the detail-only
 *  migration.
 *
 *  Self-contained fake-DOM harness, cribbed from the sibling packs-panel
 *  suites. */

import { describe, expect, it, vi } from 'vitest';

import {
  PACKS_DETAIL_BACK_ATTR,
  PACKS_DETAIL_REPO_LINK_ATTR,
  PACKS_DETAIL_RECIPES_ERROR_ATTR,
  PACKS_DETAIL_RECIPES_RETRY_ATTR,
  PACKS_DETAIL_RECIPES_STATUS_ATTR,
  PACKS_DETAIL_SECTION_ATTR,
  PACKS_DETAIL_TAB_ATTR,
  PACKS_DETAIL_TAB_PANEL_ATTR,
  PACKS_DETAIL_TABS_ATTR,
  PACKS_PANEL_STYLES,
  PACKS_DIALOG_ATTR,
  PACKS_DIALOG_CANCEL_BTN_ATTR,
  PACKS_DIALOG_PERMISSION_ATTR,
  PACKS_ROW_DELETE_BTN_ATTR,
  PACKS_ROW_DELETE_CANCEL_BTN_ATTR,
  PACKS_ROW_DELETE_CONFIRM_BTN_ATTR,
  PACKS_ROW_DELETE_FOUNDATION_WARN_ATTR,
  PACKS_ROW_INSTALL_BTN_ATTR,
  mountPacksPanel,
  type PacksListCaller,
} from '../settings/packs-panel.js';
import {
  CONNECTIONS_READINESS_STYLES,
  CONNECTIONS_READINESS_SECTION_ATTR,
  CONNECTIONS_READINESS_ROW_ATTR,
} from '../settings/connections-readiness-controls.js';
import type { BulkPackManifest, PackListEntry } from '@recued/contracts';

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
  tabIndex: number;
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
  contains(el: FakeElement): boolean;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  removeEventListener(name: string, fn: (ev: unknown) => void): void;
  focus(options?: FocusOptions): void;
  click(): void;
  keydown(key: string): void;
}

const makeFakeElement = (
  tagName: string,
  onFocus: (element: FakeElement) => void = () => {},
): FakeElement => {
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
    tabIndex: 0,
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
    contains: (candidate) =>
      candidate === el || children.some((child) => child.contains(candidate)),
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
    focus: () => onFocus(el),
    click: () => {
      onFocus(el);
      const arr = listeners.get('click') ?? [];
      for (const fn of arr) fn({ target: el });
    },
    keydown: (key) => {
      const arr = listeners.get('keydown') ?? [];
      for (const fn of arr) {
        fn({ key, preventDefault: () => undefined, target: el });
      }
    },
  };
  return el;
};

const makeFakeDocument = () => {
  let activeElement: FakeElement | null = null;
  return {
    get activeElement() {
      return activeElement;
    },
    createElement: (tag: string) => makeFakeElement(tag, (element) => {
      activeElement = element;
    }),
  };
};

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

const findByAttrValue = (
  root: FakeElement,
  attr: string,
  value: string,
): FakeElement | null => {
  if (root.hasAttribute(attr) && root.getAttribute(attr) === value) return root;
  for (const c of root.children) {
    const hit = findByAttrValue(c, attr, value);
    if (hit) return hit;
  }
  return null;
};

const collectTextContent = (root: FakeElement): string => {
  let out = root.textContent ?? '';
  for (const c of root.children) out += collectTextContent(c);
  return out;
};

// ──────────────────────────────────────────────────────────────────
// Builders
// ──────────────────────────────────────────────────────────────────

const baseManifest = (
  overrides: Partial<BulkPackManifest> = {},
): BulkPackManifest => ({
  manifest_version: 1,
  slug: 'test-pack',
  publisher: 'recued-core',
  name: 'Test Pack',
  description: 'A pack for testing the detail re-layout.',
  version: 3,
  recipes: [{ slug: 'recipe-a', version: 1 }],
  requires: ['install_bulk_pack'],
  tags: ['crm', 'billing'],
  ...overrides,
});

const entry = (overrides: Partial<PackListEntry> = {}): PackListEntry => {
  const manifest = overrides.manifest ?? baseManifest();
  return {
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
    body_visibility_grant_count:
      manifest.mcp_body_visibility_grants?.length ?? 0,
    // The four scalars `projectManifest` now sends as their own fields. The
    // panel reads THESE, not `manifest.*` — a list row must never reach through
    // a 36 KB object for a scalar, which is how `packs.list` reached 17.7 MB.
    // Mirror the projection here or the fixture tests a wire shape the server
    // stopped sending.
    ...(Array.isArray(manifest.tags) ? { tags: [...manifest.tags] } : {}),
    ...(typeof manifest.pack_kind === 'string' ? { pack_kind: manifest.pack_kind } : {}),
    ...(manifest.connection_requirements !== undefined
      ? { connection_requirements: manifest.connection_requirements }
      : {}),
    ...(manifest.connection_hints !== undefined
      ? { connection_hints: manifest.connection_hints }
      : {}),
    // ⚠ `manifest` stays: a DETAIL row carries one once `ensureDetailResolved`
    // has landed, which is the state these tests render. `packs.list` itself no
    // longer sends it — see `PackListEntry.manifest`.
    manifest,
    ...overrides,
  };
};

/** v2 composition manifest binding one http connection — feeds the
 *  connections-readiness block via `declaredConnectionSlots`. */
const connectionManifest = (
  slug: string,
  connection: string,
): BulkPackManifest =>
  baseManifest({
    slug,
    name: slug,
    contents: [
      {
        type: 'composition',
        composition: {
          schema_version: 1,
          slug: `${slug}-comp`,
          ingredients: [
            {
              slug: `${slug}-api`,
              kind: 'http',
              http: { base: 'https://api.example.test', connection },
            },
          ],
          operations: [
            {
              op: 'record.read',
              ingredient: `${slug}-api`,
              risk: 'read',
              approval: 'never',
              bind: { method: 'GET', path: '/' },
            },
          ],
        },
      },
    ],
  } as unknown as Partial<BulkPackManifest>);

interface SetupOptions {
  runConnectionList?: boolean;
  initialSlug?: string;
  runRecipeList?: () => Promise<{ recipes: readonly never[] }>;
  /** Wires the D-211 owner-operation controller so it computes `enabled = true`.
   *  ⛔ Without BOTH callers `createOwnerOperationController` short-circuits and
   *  `renderForPack` returns null at its first line — which silently changes which
   *  branch of the Permissions tab a test exercises. */
  ownerOperations?: boolean;
}

const setupMount = (packs: PackListEntry[], opts: SetupOptions = {}) => {
  const doc = makeFakeDocument();
  const host = doc.createElement('div');
  const runList: PacksListCaller = async () => ({ packs });
  // The panel is now the DETAIL only (the browse list moved to the surface).
  // Auto-open the first pack's detail so the detail assertions + seams reach
  // the same affordances by default; a test drives a specific pack via
  // `opts.initialSlug`.
  const autoSlug = opts.initialSlug ?? packs[0]?.slug;
  const mount = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList,
    runInstall: async () => ({
      result: {
        ok: true,
        installed: [],
        rolled_back: [],
      },
    }),
    runUninstall: async () => ({
      result: { ok: true, removed: { recipes: [], body_grants: [] } },
    }),
    ...(opts.runConnectionList === true
      ? { runConnectionList: async () => ({ connections: [] }) }
      : {}),
    ...(opts.runRecipeList !== undefined
      ? { runRecipeList: opts.runRecipeList }
      : {}),
    ...(autoSlug !== undefined ? { initialSlug: autoSlug } : {}),
    ...(opts.ownerOperations === true
      ? {
          runOwnerOperationInventory: async () => ({ ingredients: [] }),
          runOwnerOperationList: async () => ({ overrides: [] }),
        }
      : {}),
  });
  return { host, mount, document: doc };
};

const flush = async (turns = 12): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

// ──────────────────────────────────────────────────────────────────
// Detail sections (R22.1)
// ──────────────────────────────────────────────────────────────────

describe('Packs R1.3 — detail section layout', () => {
  it('contains long pack identity fields within the detail panel', () => {
    expect(PACKS_PANEL_STYLES).toMatch(
      /\[data-recued-packs-panel\]\s*\{[^}]*box-sizing:\s*border-box[^}]*min-width:\s*0[^}]*max-width:\s*100%/s,
    );
    expect(PACKS_PANEL_STYLES).toContain(
      '.packs-detail-section > * { min-width: 0; max-width: 100%; }',
    );
    expect(PACKS_PANEL_STYLES).toMatch(
      /\.packs-detail-name\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(PACKS_PANEL_STYLES).toMatch(
      /\.packs-detail-note\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(PACKS_PANEL_STYLES).toMatch(
      /\[data-recued-packs-detail-tabs\]\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/s,
    );
  });

  it('wraps connection readiness without shrinking its recovery target', () => {
    expect(CONNECTIONS_READINESS_STYLES).toMatch(
      /\.packs-connection-row\s*\{[^}]*min-width:\s*0[^}]*flex-wrap:\s*wrap/s,
    );
    expect(CONNECTIONS_READINESS_STYLES).toMatch(
      /\.packs-connection-status\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(CONNECTIONS_READINESS_STYLES).toMatch(
      /\.packs-connection-cta\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(CONNECTIONS_READINESS_STYLES).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\.packs-connection-cta\s*\{[^}]*min-height:\s*44px/s,
    );
  });

  it('keeps both detail-tab levels large enough for frequent touch navigation', () => {
    expect(PACKS_PANEL_STYLES).toMatch(
      /\[data-recued-packs-detail-tab\]\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(PACKS_PANEL_STYLES).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\[data-recued-packs-detail-tab\]\s*\{[^}]*min-height:\s*44px/s,
    );
  });

  it('gives the Access fallback handoff a full desktop and phone target', () => {
    expect(PACKS_PANEL_STYLES).toMatch(
      /\.packs-detail-access-link\s*\{[^}]*min-height:\s*36px/s,
    );
    expect(PACKS_PANEL_STYLES).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\.packs-detail-access-link\s*\{[^}]*min-height:\s*44px/s,
    );
  });

  it('⛔⛔ a NOT-INSTALLED pack discloses what installing would allow, never a blank', async () => {
    /** Before this the Permissions tab of a marketplace pack rendered "this pack has no
     *  operation defaults to customize" — the D-211 owner-override matrix only exists
     *  for an INSTALLED pack's operations. To a reader that says "this pack needs no
     *  permissions", which is false for any connection-backed pack and is the DANGEROUS
     *  direction for an absence to be misread. Install is the one moment the decision is
     *  still free.
     *
     *  🔑 THIS IS THE COMPOSITION CHECK, and it is the one that matters. The preview's
     *  own unit tests prove the projection is correct; they cannot prove the panel ever
     *  CALLS it. A module that is correct and unreached renders exactly the blank it was
     *  written to replace. So this drives the real panel, clicks the real tab, and reads
     *  the rendered text. */
    const pack = entry({ manifest: connectionManifest('preview-pack', 'demo') });
    /** ⛔⛔⛔ THE OWNER-OPERATION CALLERS ARE WIRED ON PURPOSE, and this is the whole
     *  reason this test is trustworthy. Without them `createOwnerOperationController`
     *  computes `enabled = false`, `renderForPack` returns null at its first line, and
     *  the preview renders through a branch PRODUCTION NEVER TAKES. My first version
     *  omitted them, passed, and shipped a feature that did not appear on screen at all —
     *  the owner found it in a browser. With them enabled, `renderForPack` returns its
     *  "Install this pack to set owner defaults" element (matchedNothing: the manifest
     *  declares operation ingredients and none are installed), which is exactly the
     *  production condition the preview has to win against. */
    const { host, mount } = setupMount([pack], { ownerOperations: true });
    await mount.whenLoaded();
    mount.clickSelectPack('preview-pack');
    findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'permissions')!.click();

    const panel = findByAttr(host, PACKS_DETAIL_TAB_PANEL_ATTR);
    expect(panel?.getAttribute(PACKS_DETAIL_TAB_PANEL_ATTR),
      'the Permissions pane must be the active one').toBe('permissions');
    /** ⚠ `collectTextContent`, not `.textContent` — this is a fake DOM and a bare
     *  `textContent` read returns only the node's OWN text, so it reported '' for a
     *  fully-populated panel and the test failed against working code. */
    const text = collectTextContent(panel!);

    /** ⛔ The framing line is load-bearing: without it the list is indistinguishable
     *  from a grant matrix showing state the pack ALREADY has. */
    expect(text, 'a preview must not read as current state').toContain('Not installed');
    expect(text).toContain('nothing is allowed yet');
    expect(text, 'the operations must actually be disclosed').toContain('Read');
    expect(text, 'and the account it wants').toContain('demo');

    /** ⚠ The control: the blank it replaced must be GONE, not merely accompanied. A
     *  preview rendered alongside "no operation defaults to customize" would still tell
     *  the owner the pack needs nothing. */
    expect(text, 'the misleading empty-state must not survive alongside it')
      .not.toContain('no operation defaults to customize');

    /** ⚠ THE SECTION HEADING MUST FOLLOW ITS CONTENT. "Operation defaults" names
     *  something that does not exist for an uninstalled pack — there are no defaults to
     *  set — so it contradicted the first line beneath it. A heading that disagrees with
     *  its own body is how a reader decides one of the two is stale, and it was the last
     *  thing on this pane still describing the installed case. */
    expect(text, 'the heading must not announce owner defaults over a preview')
      .not.toContain('What it may do, to start with');
    expect(text).toContain('Before you install');
    mount.dispose?.();
  });

  it('⚠ an INSTALLED pack keeps the owner-defaults heading — the relabel is not blanket', async () => {
    /** The control for the heading-follows-content rule. Without it, hardcoding EVERY
     *  Permissions section to "Before you install" passes the preview test above while
     *  telling an owner who installed the pack weeks ago that they have not installed
     *  it — the same heading-disagrees-with-body defect, pointed the other way.
     *  ⛔ It survived as a mutant until this existed. */
    const pack = entry({
      installed: true,
      manifest: connectionManifest('installed-pack', 'demo'),
    });
    const { host, mount } = setupMount([pack], { ownerOperations: true });
    await mount.whenLoaded();
    mount.clickSelectPack('installed-pack');
    findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'permissions')!.click();

    const text = collectTextContent(findByAttr(host, PACKS_DETAIL_TAB_PANEL_ATTR)!);
    expect(text).toContain('What it may do, to start with');
    expect(text, 'an installed pack must not be told it is not installed')
      .not.toContain('Before you install');
    expect(text).not.toContain('nothing is allowed yet');
    mount.dispose?.();
  });

  it('renders Detail / Permissions / Access tabs with one active content pane', async () => {
    const { host, mount } = setupMount([entry()]);
    await mount.whenLoaded();
    mount.clickSelectPack('test-pack');

    expect(findByAttr(host, PACKS_DETAIL_TABS_ATTR)).not.toBeNull();
    expect(
      findAllByAttr(host, PACKS_DETAIL_TAB_ATTR).map((tab) => ({
        id: tab.getAttribute(PACKS_DETAIL_TAB_ATTR),
        label: tab.textContent,
        selected: tab.getAttribute('aria-selected'),
        tabIndex: tab.tabIndex,
      })),
    ).toEqual([
      { id: 'detail', label: 'Detail', selected: 'true', tabIndex: 0 },
      { id: 'permissions', label: 'Permissions', selected: 'false', tabIndex: -1 },
      { id: 'access', label: 'Access', selected: 'false', tabIndex: -1 },
    ]);
    expect(
      findByAttr(host, PACKS_DETAIL_TAB_PANEL_ATTR)?.getAttribute(
        PACKS_DETAIL_TAB_PANEL_ATTR,
      ),
    ).toBe('detail');
    const detailTab = findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'detail')!;
    const detailPanel = findByAttr(host, PACKS_DETAIL_TAB_PANEL_ATTR)!;
    expect(detailTab.getAttribute('aria-controls')).toBe(detailPanel.getAttribute('id'));
    expect(detailPanel.getAttribute('aria-labelledby')).toBe(
      detailTab.getAttribute('id'),
    );
    expect(
      findAllByAttr(host, PACKS_DETAIL_SECTION_ATTR).map(
        (s) => s.getAttribute(PACKS_DETAIL_SECTION_ATTR),
      ),
    ).toEqual(['identity', 'declares', 'about']);

    findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'permissions')!.click();
    expect(
      findAllByAttr(host, PACKS_DETAIL_SECTION_ATTR).map(
        (s) => s.getAttribute(PACKS_DETAIL_SECTION_ATTR),
      ),
    ).toEqual(['identity', 'operation-defaults']);
    expect(
      findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'permissions')?.getAttribute(
        'aria-selected',
      ),
    ).toBe('true');
    expect(
      findByAttr(host, PACKS_DETAIL_TAB_PANEL_ATTR)?.getAttribute(
        'aria-labelledby',
      ),
    ).toBe('recued-packs-detail-manage-permissions-tab');

    findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'access')!.click();
    expect(
      findAllByAttr(host, PACKS_DETAIL_SECTION_ATTR).map(
        (s) => s.getAttribute(PACKS_DETAIL_SECTION_ATTR),
      ),
    ).toEqual(['identity', 'access']);
  });

  it('uses one tab stop and activates management tabs with arrow/Home/End keys', async () => {
    const { host, mount, document } = setupMount([entry()]);
    await mount.whenLoaded();
    const detail = findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'detail')!;
    detail.focus();

    detail.keydown('ArrowRight');
    const permissions = findByAttrValue(
      host,
      PACKS_DETAIL_TAB_ATTR,
      'permissions',
    )!;
    expect(permissions.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(permissions);

    permissions.keydown('End');
    const access = findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'access')!;
    expect(access.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(access);

    access.keydown('Home');
    const restoredDetail = findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'detail')!;
    expect(restoredDetail.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(restoredDetail);
  });

  it('IDENTITY carries name, slug · publisher · version facts, and the actions', async () => {
    const { host, mount } = setupMount([entry()]);
    await mount.whenLoaded();
    mount.clickSelectPack('test-pack');

    const identity = findByAttrValue(
      host,
      PACKS_DETAIL_SECTION_ATTR,
      'identity',
    )!;
    const text = collectTextContent(identity);
    expect(text).toContain('Test Pack');
    expect(text).toContain('test-pack · by recued-core · v3');
    // Non-installed pack ⇒ the Install affordance lives in Identity.
    expect(findByAttr(identity, PACKS_ROW_INSTALL_BTN_ATTR)).not.toBeNull();
  });

  it('IDENTITY renders the repo link only when the manifest declares one', async () => {
    const withRepo = setupMount([
      entry({
        manifest: baseManifest({ repo: 'https://github.com/acme/pack' }),
      }),
    ]);
    await withRepo.mount.whenLoaded();
    withRepo.mount.clickSelectPack('test-pack');
    const link = findByAttr(withRepo.host, PACKS_DETAIL_REPO_LINK_ATTR)!;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('https://github.com/acme/pack');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');

    const without = setupMount([entry()]);
    await without.mount.whenLoaded();
    without.mount.clickSelectPack('test-pack');
    expect(findByAttr(without.host, PACKS_DETAIL_REPO_LINK_ATTR)).toBeNull();
  });

  it('ACCESS is a placeholder linking to #contracts (R3 lands the real panel)', async () => {
    const { host, mount } = setupMount([entry()]);
    await mount.whenLoaded();
    mount.clickSelectPack('test-pack');
    findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'access')!.click();

    const access = findByAttrValue(host, PACKS_DETAIL_SECTION_ATTR, 'access')!;
    expect(access).not.toBeNull();
    const anchors: FakeElement[] = [];
    const walk = (n: FakeElement): void => {
      if (n.tagName === 'A') anchors.push(n);
      for (const c of n.children) walk(c);
    };
    walk(access);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute('href')).toBe('#contracts');
  });

  it('ABOUT renders the description + joined tags', async () => {
    const { host, mount } = setupMount([entry()]);
    await mount.whenLoaded();
    mount.clickSelectPack('test-pack');

    const about = findByAttrValue(host, PACKS_DETAIL_SECTION_ATTR, 'about')!;
    const text = collectTextContent(about);
    expect(text).toContain('A pack for testing the detail re-layout.');
    expect(text).toContain('crm · billing');
  });

  it('DECLARES renders the counts + the connections-readiness block (moved off the row)', async () => {
    const { host, mount } = setupMount(
      [
        entry({
          manifest: connectionManifest('stripe-pack', 'stripe'),
          installed: true,
        }),
      ],
      { runConnectionList: true },
    );
    await mount.whenLoaded();

    mount.clickSelectPack('stripe-pack');
    const declares = findByAttrValue(
      host,
      PACKS_DETAIL_SECTION_ATTR,
      'declares',
    )!;
    expect(collectTextContent(declares)).toContain('1 recipes');
    const readiness = findByAttr(declares, CONNECTIONS_READINESS_SECTION_ATTR)!;
    expect(readiness).not.toBeNull();
    const slot = findByAttrValue(
      readiness,
      CONNECTIONS_READINESS_ROW_ATTR,
      'stripe',
    )!;
    expect(collectTextContent(slot)).toContain('not set up');
  });

  it('moves focus into Install consent and restores its detail opener on Cancel', async () => {
    const { host, mount, document } = setupMount([entry()]);
    await mount.whenLoaded();
    mount.clickSelectPack('test-pack');
    const opener = findByAttrValue(
      host,
      PACKS_ROW_INSTALL_BTN_ATTR,
      'test-pack',
    )!;
    opener.click();

    expect(mount.getDialogOpenFor()).toBe('test-pack');
    const dialog = findByAttr(host, PACKS_DIALOG_ATTR)!;
    expect(document.activeElement).toBe(dialog);
    findByAttr(host, PACKS_DIALOG_CANCEL_BTN_ATTR)!.click();
    expect(document.activeElement).toBe(
      findByAttrValue(host, PACKS_ROW_INSTALL_BTN_ATTR, 'test-pack'),
    );

    // Re-open so Back still proves the dialog is discarded with navigation.
    mount.clickInstall('test-pack');
    // Back still returns to the list with the dialog discarded.
    mount.clickBackToList();
    expect(mount.getDialogOpenFor()).toBeNull();
    expect(findByAttr(host, PACKS_DETAIL_BACK_ATTR)).toBeNull();
  });

  it('preserves the focused permission through a consent repaint', async () => {
    const manifest = baseManifest({
      requires: ['install_bulk_pack', 'read_mail'],
    });
    const { host, mount, document } = setupMount([
      entry({ manifest, requires: [...manifest.requires] }),
    ]);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    const permission = findByAttrValue(
      host,
      PACKS_DIALOG_PERMISSION_ATTR,
      'read_mail',
    )!;
    permission.focus();

    mount.togglePermission('read_mail');
    expect(document.activeElement).toBe(
      findByAttrValue(host, PACKS_DIALOG_PERMISSION_ATTR, 'read_mail'),
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// Pack-app recipe roster recovery
// ──────────────────────────────────────────────────────────────────

describe('Packs detail — recipe roster recovery', () => {
  it('stops after one failed read and keeps retry single-flight and keyboard-owned', async () => {
    let resolveRetry!: (value: { recipes: readonly never[] }) => void;
    const retryResult = new Promise<{ recipes: readonly never[] }>((resolve) => {
      resolveRetry = resolve;
    });
    const runRecipeList = vi.fn()
      .mockRejectedValueOnce(new Error('Recipe inventory is temporarily unavailable.'))
      .mockReturnValueOnce(retryResult);
    const { host, mount, document } = setupMount([entry({ installed: true })], {
      runRecipeList,
    });
    await mount.whenLoaded();
    await flush();

    expect(runRecipeList).toHaveBeenCalledTimes(1);
    expect(findByAttr(host, PACKS_DETAIL_RECIPES_STATUS_ATTR)).toBeNull();
    expect(findByAttr(host, PACKS_DETAIL_RECIPES_ERROR_ATTR)?.textContent)
      .toContain('Recipe inventory is temporarily unavailable.');

    const retry = findByAttr(host, PACKS_DETAIL_RECIPES_RETRY_ATTR)!;
    retry.focus();
    retry.click();
    const busyRetry = findByAttr(host, PACKS_DETAIL_RECIPES_RETRY_ATTR)!;
    expect(runRecipeList).toHaveBeenCalledTimes(2);
    expect(busyRetry.getAttribute('aria-disabled')).toBe('true');
    expect(busyRetry.getAttribute('aria-busy')).toBe('true');
    expect(busyRetry.disabled).toBe(false);
    expect(document.activeElement).toBe(busyRetry);

    // aria-disabled keeps the control focusable; the transition guard, not the
    // native disabled bit, is what makes duplicate activation a no-op.
    busyRetry.click();
    expect(runRecipeList).toHaveBeenCalledTimes(2);

    resolveRetry({ recipes: [] });
    await flush();
    expect(findByAttr(host, PACKS_DETAIL_RECIPES_ERROR_ATTR)).toBeNull();
    expect(findByAttr(host, PACKS_DETAIL_RECIPES_RETRY_ATTR)).toBeNull();
    expect(document.activeElement).toBe(
      findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'detail'),
    );
  });

  it('does not reclaim retry focus after the person moves elsewhere', async () => {
    let resolveRetry!: (value: { recipes: readonly never[] }) => void;
    const retryResult = new Promise<{ recipes: readonly never[] }>((resolve) => {
      resolveRetry = resolve;
    });
    const runRecipeList = vi.fn()
      .mockRejectedValueOnce(new Error('Recipe inventory unavailable.'))
      .mockReturnValueOnce(retryResult);
    const { host, mount, document } = setupMount([entry({ installed: true })], {
      runRecipeList,
    });
    await mount.whenLoaded();
    await flush();

    findByAttr(host, PACKS_DETAIL_RECIPES_RETRY_ATTR)!.click();
    const back = findByAttr(host, PACKS_DETAIL_BACK_ATTR)!;
    back.focus();
    resolveRetry({ recipes: [] });
    await flush();

    expect(document.activeElement).toBe(findByAttr(host, PACKS_DETAIL_BACK_ATTR));
    expect(runRecipeList).toHaveBeenCalledTimes(2);
  });

  it('drops an older in-flight recipe response after a roster refresh', async () => {
    let rejectOld!: (reason: Error) => void;
    const oldResult = new Promise<{ recipes: readonly never[] }>(
      (_resolve, reject) => {
        rejectOld = reject;
      },
    );
    let resolveFresh!: (value: { recipes: readonly never[] }) => void;
    const freshResult = new Promise<{ recipes: readonly never[] }>((resolve) => {
      resolveFresh = resolve;
    });
    const runRecipeList = vi.fn()
      .mockReturnValueOnce(oldResult)
      .mockReturnValueOnce(freshResult);
    const { host, mount } = setupMount([entry({ installed: true })], {
      runRecipeList,
    });
    await mount.whenLoaded();
    await flush();
    expect(runRecipeList).toHaveBeenCalledTimes(1);

    mount.refresh();
    await mount.whenLoaded();
    await flush();
    expect(runRecipeList).toHaveBeenCalledTimes(2);

    resolveFresh({ recipes: [] });
    await flush();
    // The superseded request settles last. Its error must not replace the
    // successful fresh inventory with a Retry surface.
    rejectOld(new Error('stale recipe read failed'));
    await flush();
    expect(findByAttr(host, PACKS_DETAIL_RECIPES_STATUS_ATTR)).toBeNull();
    expect(findByAttr(host, PACKS_DETAIL_RECIPES_ERROR_ATTR)).toBeNull();
    expect(findByAttr(host, PACKS_DETAIL_RECIPES_RETRY_ATTR)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Delta 6 — foundation Delete is direct; the toggle is gone
// ──────────────────────────────────────────────────────────────────

describe('Packs R1.3 — Delta 6 (advanced toggle removed)', () => {
  it('transfers keyboard ownership from Delete to Confirm and back on Cancel', async () => {
    const { host, mount, document } = setupMount([
      entry({ installed: true }),
    ]);
    await mount.whenLoaded();

    const deleteButton = findByAttrValue(
      host,
      PACKS_ROW_DELETE_BTN_ATTR,
      'test-pack',
    )!;
    deleteButton.click();
    const confirmButton = findByAttrValue(
      host,
      PACKS_ROW_DELETE_CONFIRM_BTN_ATTR,
      'test-pack',
    )!;
    expect(document.activeElement).toBe(confirmButton);

    const cancelButton = findByAttrValue(
      host,
      PACKS_ROW_DELETE_CANCEL_BTN_ATTR,
      'test-pack',
    )!;
    cancelButton.click();
    expect(document.activeElement).toBe(
      findByAttrValue(host, PACKS_ROW_DELETE_BTN_ATTR, 'test-pack'),
    );
  });

  it('foundation packs expose Delete directly and arm with the boot warning', async () => {
    const { host, mount } = setupMount([
      entry({
        manifest: baseManifest({ slug: 'foundation-pack', pre_install: true }),
        pre_install: true,
        installed: true,
      }),
    ]);
    await mount.whenLoaded();

    // No advanced-toggle affordance anywhere.
    expect(
      findByAttr(host, 'data-recued-packs-advanced-toggle'),
    ).toBeNull();
    const del = findByAttrValue(
      host,
      PACKS_ROW_DELETE_BTN_ATTR,
      'foundation-pack',
    )!;
    expect(del).not.toBeNull();
    del.click();
    expect(mount.getConfirmingDeleteFor()).toBe('foundation-pack');
    expect(
      findByAttr(host, PACKS_ROW_DELETE_FOUNDATION_WARN_ATTR),
    ).not.toBeNull();
  });

  it('the foundation warning also renders when arming from the DETAIL identity actions', async () => {
    const { host, mount } = setupMount([
      entry({
        manifest: baseManifest({ slug: 'foundation-pack', pre_install: true }),
        pre_install: true,
        installed: true,
      }),
    ]);
    await mount.whenLoaded();
    mount.clickSelectPack('foundation-pack');

    mount.clickDelete('foundation-pack');
    const identity = findByAttrValue(
      host,
      PACKS_DETAIL_SECTION_ATTR,
      'identity',
    )!;
    expect(
      findByAttr(identity, PACKS_ROW_DELETE_FOUNDATION_WARN_ATTR),
    ).not.toBeNull();
  });
});
