/** D-145 PA10 follow-on Slice C - pack recipe collision UI.
 *
 *  Pure coverage for the collision helpers plus render coverage for
 *  the row badge, dialog collision callout, per-recipe marker, and
 *  the panel's defensive getCollisions() seam.
 */

import { describe, expect, it } from 'vitest';

import {
  groupCollisionsByOtherPack,
  computePackRecipeCollisions,
  type PackRecipeCollisionEntry,
} from '../settings/packs-collisions.js';
import {
  PACKS_DIALOG_ATTR,
  PACKS_DIALOG_COLLISION_ATTR,
  PACKS_DIALOG_COLLISION_GROUP_ATTR,
  PACKS_DIALOG_RECIPE_COLLISION_ATTR,
  PACKS_ROW_COLLISION_ATTR,
  mountPacksPanel,
  type PacksInstallCaller,
  type PacksListCaller,
} from '../settings/packs-panel.js';
import type {
  BulkPackInstallResultLike,
  BulkPackManifest,
  PackListEntry,
} from '@recued/contracts';

// ------------------------------------------------------------------
// Fake DOM (mirrors the Slice A/B packs-panel test harness shape)
// ------------------------------------------------------------------

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

interface FakeDocument {
  createElement(tag: string): FakeElement;
  createTextNode(text: string): FakeElement;
}

const makeFakeDocument = (): FakeDocument => ({
  createElement: (tag) => makeFakeElement(tag),
  createTextNode: (text) => {
    const node = makeFakeElement('#text');
    node.textContent = text;
    return node;
  },
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
  for (const c of root.children) {
    out += collectTextContent(c);
  }
  return out;
};

// ------------------------------------------------------------------
// Builders
// ------------------------------------------------------------------

const baseManifest = (
  overrides: Partial<BulkPackManifest> = {},
): BulkPackManifest => ({
  manifest_version: 1,
  slug: 'test-pack',
  publisher: 'recued-core',
  name: 'Test Pack',
  description: 'A pack for testing.',
  version: 1,
  recipes: [{ slug: 'recipe-a', version: 1 }],
  requires: ['install_bulk_pack'],
  tags: ['test'],
  ...overrides,
});

const baseEntry = (overrides: Partial<PackListEntry> = {}): PackListEntry => {
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

const packEntry = (
  slug: string,
  recipes: ReadonlyArray<{ slug: string; version?: number }>,
  overrides: Partial<PackListEntry> = {},
): PackListEntry => {
  const manifest = baseManifest({
    slug,
    name: slug,
    recipes: recipes.map((r) => ({
      slug: r.slug,
      version: r.version ?? 1,
    })),
  });
  return baseEntry({
    slug,
    manifest,
    recipe_count: manifest.recipes.length,
    ...overrides,
  });
};

const okInstallResult = (): BulkPackInstallResultLike => ({
  ok: true,
  installed: [
    {
      slug: 'recipe-a',
      publisher_id: 'recued-core',
      version: 1,
      fresh_install: true,
    },
  ],
  rolled_back: [],
});

// ------------------------------------------------------------------
// Setup helper
// ------------------------------------------------------------------

interface SetupOptions {
  runList?: PacksListCaller;
  runInstall?: PacksInstallCaller | null;
  /** R22 list→detail — seed the DETAIL selection on mount. */
  initialSlug?: string;
}

interface SetupResult {
  host: FakeElement;
  doc: FakeDocument;
  mount: ReturnType<typeof mountPacksPanel>;
  listCalls: Array<undefined>;
  installCalls: Array<{
    manifest: unknown;
    granted_permissions: ReadonlyArray<string>;
  }>;
  swapPacks(next: ReadonlyArray<PackListEntry>): void;
}

const setupMount = (
  initialPacks: ReadonlyArray<PackListEntry> = [],
  overrides: SetupOptions = {},
): SetupResult => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const listCalls: Array<undefined> = [];
  const installCalls: SetupResult['installCalls'] = [];
  let currentPacks: ReadonlyArray<PackListEntry> = initialPacks;

  const defaultRunList: PacksListCaller = async () => {
    listCalls.push(undefined);
    return { packs: currentPacks };
  };

  const defaultRunInstall: PacksInstallCaller = async (args) => {
    installCalls.push(args);
    return { result: okInstallResult() };
  };

  // The panel is now the DETAIL (the browse list moved to the surface). Open the
  // first pack's detail by default so the shared-machinery seams (clickInstall /
  // getCollisions / the collision notice + dialog callout) reach the same
  // affordances they used to on a list row. Tests drive a specific slug via
  // `overrides.initialSlug` / `mount.clickSelectPack`.
  const autoSlug = overrides.initialSlug ?? initialPacks[0]?.slug;
  const mount = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList: overrides.runList ?? defaultRunList,
    ...(autoSlug !== undefined ? { initialSlug: autoSlug } : {}),
    ...(overrides.runInstall === null
      ? {}
      : { runInstall: overrides.runInstall ?? defaultRunInstall }),
  });

  return {
    host,
    doc,
    mount,
    listCalls,
    installCalls,
    swapPacks: (next) => {
      currentPacks = next;
    },
  };
};

// ------------------------------------------------------------------
// computePackRecipeCollisions
// ------------------------------------------------------------------

describe('D-145 PA10 Slice C - computePackRecipeCollisions', () => {
  it('returns an empty map for an empty pack list', () => {
    const result = computePackRecipeCollisions([]);
    expect(result.size).toBe(0);
  });

  it('returns an empty collision entry for a single pack', () => {
    const result = computePackRecipeCollisions([
      packEntry('pack-a', [{ slug: 'recipe-a' }]),
    ]);
    expect(result.size).toBe(1);
    expect(result.get('pack-a')).toEqual({
      recipes: [],
      otherPackSlugs: [],
    });
  });

  it('returns empty recipe arrays for two packs with no overlap', () => {
    const result = computePackRecipeCollisions([
      packEntry('pack-a', [{ slug: 'recipe-a' }]),
      packEntry('pack-b', [{ slug: 'recipe-b' }]),
    ]);
    expect(result.get('pack-a')).toEqual({
      recipes: [],
      otherPackSlugs: [],
    });
    expect(result.get('pack-b')).toEqual({
      recipes: [],
      otherPackSlugs: [],
    });
  });

  it('reports a shared recipe slug on both packs', () => {
    const result = computePackRecipeCollisions([
      packEntry('pack-a', [
        { slug: 'shared-recipe', version: 1 },
        { slug: 'only-a', version: 1 },
      ]),
      packEntry('pack-b', [{ slug: 'shared-recipe', version: 2 }]),
    ]);
    expect(result.get('pack-a')).toEqual({
      recipes: [
        {
          slug: 'shared-recipe',
          version: 1,
          otherPackSlugs: ['pack-b'],
        },
      ],
      otherPackSlugs: ['pack-b'],
    });
    expect(result.get('pack-b')).toEqual({
      recipes: [
        {
          slug: 'shared-recipe',
          version: 2,
          otherPackSlugs: ['pack-a'],
        },
      ],
      otherPackSlugs: ['pack-a'],
    });
  });

  it('reports every recipe when two packs share all recipes', () => {
    const result = computePackRecipeCollisions([
      packEntry('pack-a', [
        { slug: 'recipe-a' },
        { slug: 'recipe-b' },
      ]),
      packEntry('pack-b', [
        { slug: 'recipe-a' },
        { slug: 'recipe-b' },
      ]),
    ]);
    expect(result.get('pack-a')!.recipes.map((r) => r.slug)).toEqual([
      'recipe-a',
      'recipe-b',
    ]);
    expect(result.get('pack-a')!.otherPackSlugs).toEqual(['pack-b']);
    expect(result.get('pack-b')!.recipes.map((r) => r.slug)).toEqual([
      'recipe-a',
      'recipe-b',
    ]);
    expect(result.get('pack-b')!.otherPackSlugs).toEqual(['pack-a']);
  });

  it('sorts otherPackSlugs alphabetically for a three-pack shared slug', () => {
    const result = computePackRecipeCollisions([
      packEntry('pack-c', [{ slug: 'shared-recipe' }]),
      packEntry('pack-a', [{ slug: 'shared-recipe' }]),
      packEntry('pack-b', [{ slug: 'shared-recipe' }]),
    ]);
    expect(result.get('pack-a')!.recipes[0]!.otherPackSlugs).toEqual([
      'pack-b',
      'pack-c',
    ]);
    expect(result.get('pack-b')!.recipes[0]!.otherPackSlugs).toEqual([
      'pack-a',
      'pack-c',
    ]);
    expect(result.get('pack-c')!.recipes[0]!.otherPackSlugs).toEqual([
      'pack-a',
      'pack-b',
    ]);
  });

  it('dedupes an intra-pack duplicate slug before emitting entries', () => {
    const result = computePackRecipeCollisions([
      packEntry('pack-a', [
        { slug: 'shared-recipe', version: 1 },
        { slug: 'shared-recipe', version: 2 },
      ]),
      packEntry('pack-b', [{ slug: 'shared-recipe', version: 3 }]),
    ]);
    expect(result.get('pack-a')!.recipes).toEqual([
      {
        slug: 'shared-recipe',
        version: 1,
        otherPackSlugs: ['pack-b'],
      },
    ]);
  });

  it('preserves manifest recipe order in emitted entries', () => {
    const result = computePackRecipeCollisions([
      packEntry('pack-a', [
        { slug: 'recipe-c' },
        { slug: 'recipe-a' },
        { slug: 'recipe-b' },
      ]),
      packEntry('pack-b', [
        { slug: 'recipe-a' },
        { slug: 'recipe-b' },
        { slug: 'recipe-c' },
      ]),
    ]);
    expect(result.get('pack-a')!.recipes.map((r) => r.slug)).toEqual([
      'recipe-c',
      'recipe-a',
      'recipe-b',
    ]);
  });
});

// ------------------------------------------------------------------
// groupCollisionsByOtherPack
// ------------------------------------------------------------------

describe('D-145 PA10 Slice C - groupCollisionsByOtherPack', () => {
  it('returns an empty array for empty input', () => {
    expect(groupCollisionsByOtherPack([])).toEqual([]);
  });

  it('groups one entry colliding with one other pack', () => {
    const entries: PackRecipeCollisionEntry[] = [
      {
        slug: 'recipe-a',
        version: 1,
        otherPackSlugs: ['pack-b'],
      },
    ];
    expect(groupCollisionsByOtherPack(entries)).toEqual([
      {
        otherPackSlug: 'pack-b',
        recipeSlugs: ['recipe-a'],
      },
    ]);
  });

  it('groups multiple entries for the same other pack in input order', () => {
    const entries: PackRecipeCollisionEntry[] = [
      {
        slug: 'recipe-b',
        version: 1,
        otherPackSlugs: ['pack-z'],
      },
      {
        slug: 'recipe-a',
        version: 1,
        otherPackSlugs: ['pack-z'],
      },
    ];
    expect(groupCollisionsByOtherPack(entries)).toEqual([
      {
        otherPackSlug: 'pack-z',
        recipeSlugs: ['recipe-b', 'recipe-a'],
      },
    ]);
  });

  it('sorts groups alphabetically when entries collide with multiple packs', () => {
    const entries: PackRecipeCollisionEntry[] = [
      {
        slug: 'recipe-one',
        version: 1,
        otherPackSlugs: ['pack-z', 'pack-a'],
      },
      {
        slug: 'recipe-two',
        version: 1,
        otherPackSlugs: ['pack-m', 'pack-a'],
      },
    ];
    expect(groupCollisionsByOtherPack(entries)).toEqual([
      {
        otherPackSlug: 'pack-a',
        recipeSlugs: ['recipe-one', 'recipe-two'],
      },
      {
        otherPackSlug: 'pack-m',
        recipeSlugs: ['recipe-two'],
      },
      {
        otherPackSlug: 'pack-z',
        recipeSlugs: ['recipe-one'],
      },
    ]);
  });
});

// ------------------------------------------------------------------
// mountPacksPanel render integration
// ------------------------------------------------------------------

describe('D-145 PA10 Slice C - mountPacksPanel collision rendering', () => {
  it('renders no collision attributes when the list has no collisions', async () => {
    const { host, mount } = setupMount([
      packEntry('pack-a', [{ slug: 'recipe-a' }]),
      packEntry('pack-b', [{ slug: 'recipe-b' }]),
    ]);
    await mount.whenLoaded();
    expect(findAllByAttr(host, PACKS_ROW_COLLISION_ATTR)).toHaveLength(0);

    mount.clickInstall('pack-a');
    expect(findByAttr(host, PACKS_DIALOG_ATTR)).not.toBeNull();
    expect(findAllByAttr(host, PACKS_DIALOG_COLLISION_ATTR)).toHaveLength(0);
    expect(findAllByAttr(host, PACKS_DIALOG_RECIPE_COLLISION_ATTR)).toHaveLength(0);
  });

  it('renders the collision notice in the open pack DETAIL About section (R22.1)', async () => {
    const { host, mount } = setupMount([
      packEntry('pack-a', [{ slug: 'shared-recipe' }]),
      packEntry('pack-b', [{ slug: 'shared-recipe' }]),
    ]);
    await mount.whenLoaded();
    // The collision notice moved off the retired list rows into the open pack's
    // DETAIL About section — pack-a is auto-opened + collides with pack-b.
    const badge = findByAttr(host, PACKS_ROW_COLLISION_ATTR);
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('Shares 1 recipe with pack-b');
    // The notice is keyed to the OPEN pack: selecting the sibling shows ITS
    // collision (pack-b → pack-a), not a stale pack-a → pack-b one.
    mount.clickSelectPack('pack-b');
    const siblingBadge = findByAttr(host, PACKS_ROW_COLLISION_ATTR);
    expect(siblingBadge!.textContent).toContain('Shares 1 recipe with pack-a');
  });

  it('uses singular and plural collision copy based on recipe count', async () => {
    const { host, mount } = setupMount([
      packEntry('single-a', [{ slug: 'single-shared' }]),
      packEntry('single-b', [{ slug: 'single-shared' }]),
      packEntry('multi-a', [
        { slug: 'multi-shared-a' },
        { slug: 'multi-shared-b' },
      ]),
      packEntry('multi-b', [
        { slug: 'multi-shared-a' },
        { slug: 'multi-shared-b' },
      ]),
    ]);
    await mount.whenLoaded();
    mount.clickSelectPack('single-a');
    const singularBadge = findByAttr(host, PACKS_ROW_COLLISION_ATTR);
    expect(singularBadge!.textContent).toContain(
      'Shares 1 recipe with single-b',
    );
    mount.clickBackToList();
    mount.clickSelectPack('multi-a');
    const pluralBadge = findByAttr(host, PACKS_ROW_COLLISION_ATTR);
    expect(pluralBadge!.textContent).toContain(
      'Shares 2 recipes with multi-b',
    );
  });

  it('renders dialog callout groups and markers only for colliding recipes', async () => {
    const { host, mount } = setupMount([
      packEntry('pack-a', [
        { slug: 'shared-one', version: 1 },
        { slug: 'unique-one', version: 2 },
        { slug: 'shared-two', version: 3 },
      ]),
      packEntry('pack-b', [{ slug: 'shared-one' }]),
      packEntry('pack-c', [{ slug: 'shared-two' }]),
    ]);
    await mount.whenLoaded();
    mount.clickInstall('pack-a');

    const callout = findByAttr(host, PACKS_DIALOG_COLLISION_ATTR);
    expect(callout).not.toBeNull();
    expect(
      findByAttrValue(callout!, PACKS_DIALOG_COLLISION_GROUP_ATTR, 'pack-b')!
        .textContent,
    ).toBe('pack-b: shared-one');
    expect(
      findByAttrValue(callout!, PACKS_DIALOG_COLLISION_GROUP_ATTR, 'pack-c')!
        .textContent,
    ).toBe('pack-c: shared-two');

    const markers = findAllByAttr(host, PACKS_DIALOG_RECIPE_COLLISION_ATTR);
    expect(markers.map((m) => m.getAttribute(PACKS_DIALOG_RECIPE_COLLISION_ATTR)))
      .toEqual(['shared-one', 'shared-two']);
    expect(collectTextContent(findByAttr(host, PACKS_DIALOG_ATTR)!)).toContain(
      'unique-one (v2)',
    );
    expect(
      markers.some(
        (m) => m.getAttribute(PACKS_DIALOG_RECIPE_COLLISION_ATTR) === 'unique-one',
      ),
    ).toBe(false);
  });

  it('sets the per-recipe marker attribute to the colliding recipe slug', async () => {
    const { host, mount } = setupMount([
      packEntry('pack-a', [{ slug: 'shared-recipe' }]),
      packEntry('pack-b', [{ slug: 'shared-recipe' }]),
    ]);
    await mount.whenLoaded();
    mount.clickInstall('pack-a');
    const marker = findByAttr(host, PACKS_DIALOG_RECIPE_COLLISION_ATTR);
    expect(marker).not.toBeNull();
    expect(marker!.getAttribute(PACKS_DIALOG_RECIPE_COLLISION_ATTR)).toBe(
      'shared-recipe',
    );
    expect(marker!.textContent).toContain('also in pack-b');
  });

  it('renders the dialog collision callout as a labelled region', async () => {
    const { host, mount } = setupMount([
      packEntry('pack-a', [{ slug: 'shared-recipe' }]),
      packEntry('pack-b', [{ slug: 'shared-recipe' }]),
    ]);
    await mount.whenLoaded();
    mount.clickInstall('pack-a');
    const callout = findByAttr(host, PACKS_DIALOG_COLLISION_ATTR);
    expect(callout).not.toBeNull();
    expect(callout!.getAttribute('role')).toBe('region');
    const labelledby = callout!.getAttribute('aria-labelledby');
    expect(labelledby).toBe('packs-dialog-collision-heading-pack-a');
    const heading = callout!.children.find((c) => c.id === labelledby);
    expect(heading).not.toBeUndefined();
  });

  it('getCollisions returns a defensive map copy', async () => {
    const { mount } = setupMount([
      packEntry('pack-a', [{ slug: 'shared-recipe' }]),
      packEntry('pack-b', [{ slug: 'shared-recipe' }]),
    ]);
    await mount.whenLoaded();
    const copy = mount.getCollisions();
    expect(copy.has('pack-a')).toBe(true);
    copy.delete('pack-a');
    copy.set('external-pack', {
      recipes: [],
      otherPackSlugs: [],
    });
    const fresh = mount.getCollisions();
    expect(fresh.has('pack-a')).toBe(true);
    expect(fresh.has('external-pack')).toBe(false);
  });

  it('getCollisions returns an empty map while loading or after list error', async () => {
    let resolveList: (v: { packs: ReadonlyArray<PackListEntry> }) => void =
      () => {};
    const loading = setupMount([], {
      runList: () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    });
    expect(loading.mount.getState()).toBe('loading');
    expect(loading.mount.getCollisions().size).toBe(0);
    resolveList({ packs: [packEntry('pack-a', [{ slug: 'recipe-a' }])] });
    await loading.mount.whenLoaded();

    const error = setupMount([], {
      runList: async () => {
        throw new Error('boom');
      },
    });
    await error.mount.whenLoaded();
    expect(error.mount.getState()).toBe('error');
    expect(error.mount.getCollisions().size).toBe(0);
  });
});
