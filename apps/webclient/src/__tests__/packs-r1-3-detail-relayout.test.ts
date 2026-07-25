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

import { describe, expect, it } from 'vitest';

import {
  PACKS_DETAIL_BACK_ATTR,
  PACKS_DETAIL_REPO_LINK_ATTR,
  PACKS_DETAIL_SECTION_ATTR,
  PACKS_DETAIL_TAB_ATTR,
  PACKS_DETAIL_TAB_PANEL_ATTR,
  PACKS_DETAIL_TABS_ATTR,
  PACKS_DIALOG_ATTR,
  PACKS_ROW_DELETE_BTN_ATTR,
  PACKS_ROW_DELETE_FOUNDATION_WARN_ATTR,
  PACKS_ROW_INSTALL_BTN_ATTR,
  mountPacksPanel,
  type PacksListCaller,
} from '../settings/packs-panel.js';
import {
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
      const arr = listeners.get('click') ?? [];
      for (const fn of arr) fn({ target: el });
    },
  };
  return el;
};

const makeFakeDocument = () => ({
  createElement: (tag: string) => makeFakeElement(tag),
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
    body_visibility_grant_count:
      manifest.mcp_body_visibility_grants?.length ?? 0,
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
}

const setupMount = (packs: PackListEntry[], opts: SetupOptions = {}) => {
  const doc = makeFakeDocument();
  const host = makeFakeElement('div');
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
    ...(autoSlug !== undefined ? { initialSlug: autoSlug } : {}),
  });
  return { host, mount };
};

// ──────────────────────────────────────────────────────────────────
// Detail sections (R22.1)
// ──────────────────────────────────────────────────────────────────

describe('Packs R1.3 — detail section layout', () => {
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
      })),
    ).toEqual([
      { id: 'detail', label: 'Detail', selected: 'true' },
      { id: 'permissions', label: 'Permissions', selected: 'false' },
      { id: 'access', label: 'Access', selected: 'false' },
    ]);
    expect(
      findByAttr(host, PACKS_DETAIL_TAB_PANEL_ATTR)?.getAttribute(
        PACKS_DETAIL_TAB_PANEL_ATTR,
      ),
    ).toBe('detail');
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

    findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'access')!.click();
    expect(
      findAllByAttr(host, PACKS_DETAIL_SECTION_ATTR).map(
        (s) => s.getAttribute(PACKS_DETAIL_SECTION_ATTR),
      ),
    ).toEqual(['identity', 'access']);
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

  it('opening Install from the detail renders the consent dialog after Identity', async () => {
    const { host, mount } = setupMount([entry()]);
    await mount.whenLoaded();
    mount.clickSelectPack('test-pack');
    mount.clickInstall('test-pack');

    expect(mount.getDialogOpenFor()).toBe('test-pack');
    expect(findByAttr(host, PACKS_DIALOG_ATTR)).not.toBeNull();
    // Back still returns to the list with the dialog discarded.
    mount.clickBackToList();
    expect(mount.getDialogOpenFor()).toBeNull();
    expect(findByAttr(host, PACKS_DETAIL_BACK_ATTR)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Delta 6 — foundation Delete is direct; the toggle is gone
// ──────────────────────────────────────────────────────────────────

describe('Packs R1.3 — Delta 6 (advanced toggle removed)', () => {
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
