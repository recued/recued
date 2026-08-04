/** D-145 PA10 follow-on Slice I - Settings -> Packs panel install body grants.
 *
 *  Covers the install-dialog body-content disclosure gate. The disclosure
 *  must read `manifest.mcp_body_visibility_grants ?? []` directly, matching
 *  Slice G's Delete-strip defensive gate, rather than trusting
 *  `body_visibility_grant_count`.
 *
 *  Reuses the fake-DOM + setup helper shape from the Slice A and Slice G
 *  Packs panel tests locally, keeping this file self-contained. */

import { describe, expect, it } from 'vitest';

import {
  PACKS_DIALOG_ATTR,
  PACKS_DIALOG_BODY_GRANT_ATTR,
  PACKS_DIALOG_COLLISION_ATTR,
  PACKS_ROW_DELETE_BODY_GRANT_ATTR,
  PACKS_ROW_DELETE_BODY_GRANT_LIST_ATTR,
  PACKS_ROW_SLUG_ATTR,
  mountPacksPanel,
  type PacksInstallCaller,
  type PacksListCaller,
  type PacksUninstallCaller,
} from '../settings/packs-panel.js';
import type {
  BulkPackInstallResultLike,
  BulkPackManifest,
  BulkPackUninstallResultLike,
  PackListEntry,
} from '@recued/contracts';

// ------------------------------------------------------------------
// Fake DOM (mirrors Slice A test harness shape)
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
}

const makeFakeDocument = (): FakeDocument => ({
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

const hasClass = (el: FakeElement, className: string): boolean =>
  el.className.split(/\s+/).includes(className);

const findByClass = (
  root: FakeElement,
  className: string,
): FakeElement | null => {
  if (hasClass(root, className)) return root;
  for (const c of root.children) {
    const hit = findByClass(c, className);
    if (hit) return hit;
  }
  return null;
};

// ------------------------------------------------------------------
// Builders
// ------------------------------------------------------------------

const baseManifest = (overrides: Partial<BulkPackManifest> = {}): BulkPackManifest => ({
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
    recipe_refs: manifest.recipes.map((r) => ({ slug: r.slug, version: r.version })),
    body_visibility_grant_keys: [...(manifest.mcp_body_visibility_grants ?? [])],
    ...(typeof manifest.service_kind === 'string' ? { service_kind: manifest.service_kind } : {}),
    ...(typeof manifest.repo === 'string' ? { repo: manifest.repo } : {}),
    body_visibility_grant_count:
      manifest.mcp_body_visibility_grants?.length ?? 0,
    manifest,
    ...overrides,
  };
};

const installedEntry = (overrides: Partial<PackListEntry> = {}): PackListEntry =>
  baseEntry({ installed: true, ...overrides });

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

const okUninstallResult = (): BulkPackUninstallResultLike => ({
  ok: true,
  removed: {
    recipes: ['recipe-a'],
    body_grants: [],
  },
});

// ------------------------------------------------------------------
// Setup helper
// ------------------------------------------------------------------

interface SetupResult {
  host: FakeElement;
  mount: ReturnType<typeof mountPacksPanel>;
  swapPacks(next: ReadonlyArray<PackListEntry>): void;
}

const setupMount = (
  initialPacks: ReadonlyArray<PackListEntry> = [],
): SetupResult => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  let currentPacks: ReadonlyArray<PackListEntry> = initialPacks;

  const runList: PacksListCaller = async () => ({ packs: currentPacks });
  const runInstall: PacksInstallCaller = async () => ({
    result: okInstallResult(),
  });
  const runUninstall: PacksUninstallCaller = async () => ({
    result: okUninstallResult(),
  });

  const mount = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList,
    // The panel is DETAIL-only — auto-open the first pack so `clickInstall`
    // reaches the detail's affordances (was the list row).
    ...(initialPacks[0] !== undefined ? { initialSlug: initialPacks[0].slug } : {}),
    runInstall,
    runUninstall,
  });

  return {
    host,
    mount,
    swapPacks: (next) => {
      currentPacks = next;
    },
  };
};

// ------------------------------------------------------------------
// Slice H helpers
// ------------------------------------------------------------------

const INSTALL_BODY_GRANTS_LABEL =
  'This pack will access the following body content:';
const CONTACT_BODY_GRANT = 'data.contact.engagements.body_content';
const LONG_DOTTED_BODY_GRANT =
  'data.contact.engagements.body_content.extremely.long.closed.list.slug.v2026';

const asBodyGrants = (
  grants: ReadonlyArray<string>,
): BulkPackManifest['mcp_body_visibility_grants'] =>
  grants as unknown as BulkPackManifest['mcp_body_visibility_grants'];

const bodyGrantManifest = (
  slug: string,
  grants: ReadonlyArray<string> | undefined,
  overrides: Partial<BulkPackManifest> = {},
): BulkPackManifest => {
  const manifest = baseManifest({
    slug,
    name: 'Body Grant Pack',
    ...overrides,
  });
  if (grants === undefined) return manifest;
  return {
    ...manifest,
    mcp_body_visibility_grants: asBodyGrants(grants),
  };
};

const installableBodyGrantEntry = (
  slug: string,
  grants: ReadonlyArray<string> | undefined,
  overrides: Partial<PackListEntry> = {},
): PackListEntry => {
  const manifest =
    overrides.manifest ?? bodyGrantManifest(slug, grants);
  return baseEntry({
    manifest,
    body_visibility_grant_count: grants?.length ?? 0,
    ...overrides,
  });
};

const installedBodyGrantEntry = (
  slug: string,
  grants: ReadonlyArray<string> | undefined,
  overrides: Partial<PackListEntry> = {},
): PackListEntry => {
  const manifest =
    overrides.manifest ?? bodyGrantManifest(slug, grants);
  return installedEntry({
    manifest,
    body_visibility_grant_count: grants?.length ?? 0,
    ...overrides,
  });
};

const rowFor = (host: FakeElement, _slug: string): FakeElement => {
  // The panel is DETAIL-only now — the delete confirm strip + the body-grant /
  // overlap disclosure render in the (auto-opened) detail's identity section
  // (appendPackActions' target), not a list row. Only one pack's detail shows.
  const identity = findByAttrValue(host, 'data-recued-packs-detail-section', 'identity');
  expect(identity).not.toBeNull();
  return identity!;
};

const dialogFor = (host: FakeElement): FakeElement => {
  const dialog = findByAttr(host, PACKS_DIALOG_ATTR);
  expect(dialog).not.toBeNull();
  return dialog!;
};

const installBodyHeadingFor = (
  root: FakeElement,
): FakeElement | null =>
  findByClass(root, 'packs-dialog-body-heading');

const installBodyListFor = (
  root: FakeElement,
): FakeElement | null =>
  findByClass(root, 'packs-dialog-body-list');

const installBodyGrantItemsFor = (
  root: FakeElement,
): FakeElement[] => {
  const list = installBodyListFor(root);
  return list === null
    ? []
    : list.children.filter((child) =>
        child.hasAttribute(PACKS_DIALOG_BODY_GRANT_ATTR),
      );
};

const expectNoInstallBodyDisclosure = (root: FakeElement): void => {
  expect(installBodyHeadingFor(root)).toBeNull();
  expect(installBodyListFor(root)).toBeNull();
  expect(findAllByAttr(root, PACKS_DIALOG_BODY_GRANT_ATTR)).toEqual([]);
};

const expectInstallBodyDisclosure = (
  root: FakeElement,
  grants: ReadonlyArray<string>,
): {
  heading: FakeElement;
  list: FakeElement;
  items: FakeElement[];
} => {
  const heading = installBodyHeadingFor(root);
  const list = installBodyListFor(root);
  expect(heading).not.toBeNull();
  expect(heading!.textContent).toBe(INSTALL_BODY_GRANTS_LABEL);
  expect(list).not.toBeNull();
  const items = installBodyGrantItemsFor(root);
  expect(items).toHaveLength(grants.length);
  expect(items.map((item) => item.textContent)).toEqual(grants);
  expect(items.map((item) =>
    item.getAttribute(PACKS_DIALOG_BODY_GRANT_ATTR),
  )).toEqual(grants);
  return { heading: heading!, list: list!, items };
};

const deleteBodyGrantItemsFor = (row: FakeElement): FakeElement[] => {
  const list = findByAttr(row, PACKS_ROW_DELETE_BODY_GRANT_LIST_ATTR);
  return list === null
    ? []
    : list.children.filter((child) =>
        child.hasAttribute(PACKS_ROW_DELETE_BODY_GRANT_ATTR),
      );
};

// ==================================================================
// Group 1 - Visibility positive
// ==================================================================

describe('D-145 Slice I - visibility positive', () => {
  it('renders heading and one list item per manifest body grant', async () => {
    // Catches old count-gated implementations by keeping count at zero while the manifest array is populated.
    const grants = [
      CONTACT_BODY_GRANT,
      'data.contact.timeline.body_content',
    ];
    const { host, mount } = setupMount([
      installableBodyGrantEntry('body-pack', grants, {
        body_visibility_grant_count: 0,
      }),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('body-pack');

    const { heading, list, items } = expectInstallBodyDisclosure(
      dialogFor(host),
      grants,
    );
    expect(heading.tagName).toBe('P');
    expect(list.tagName).toBe('UL');
    expect(items.map((item) => item.tagName)).toEqual(['LI', 'LI']);
  });
});

// ==================================================================
// Group 2 - Visibility negative
// ==================================================================

describe('D-145 Slice I - visibility negative', () => {
  it('does not render disclosure when body grants are an empty array', async () => {
    // Catches implementations that render a blank install disclosure whenever the dialog opens.
    const { host, mount } = setupMount([
      installableBodyGrantEntry('empty-grants-pack', []),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('empty-grants-pack');

    expectNoInstallBodyDisclosure(dialogFor(host));
  });

  it('does not render disclosure when body grants are omitted', async () => {
    // Catches implementations that treat a missing grants array as a disclosure shell.
    const { host, mount } = setupMount([
      installableBodyGrantEntry('missing-grants-pack', undefined),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('missing-grants-pack');

    expectNoInstallBodyDisclosure(dialogFor(host));
  });
});

// ==================================================================
// Group 3 - Inconsistent-fixture defensive tests
// ==================================================================

describe('D-145 Slice I - inconsistent-fixture defensive tests', () => {
  it('ignores body_visibility_grant_count when the grants array is empty', async () => {
    // Catches regressions that use body_visibility_grant_count instead of manifest.mcp_body_visibility_grants.
    const { host, mount } = setupMount([
      installableBodyGrantEntry('count-empty-pack', [], {
        body_visibility_grant_count: 3,
      }),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('count-empty-pack');

    expectNoInstallBodyDisclosure(dialogFor(host));
  });

  it('ignores body_visibility_grant_count when the grants array is omitted', async () => {
    // Catches regressions that use the count field and render a heading with no backing grant keys.
    const { host, mount } = setupMount([
      installableBodyGrantEntry('count-missing-pack', undefined, {
        body_visibility_grant_count: 1,
      }),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('count-missing-pack');

    expectNoInstallBodyDisclosure(dialogFor(host));
  });
});

// ==================================================================
// Group 4 - DOM position invariant
// ==================================================================

describe('D-145 Slice I - DOM position invariant', () => {
  it('places body grants directly before their list between permissions and collision callout', async () => {
    // Catches implementations that append the disclosure after the collision warning or split heading/list apart.
    const grants = [CONTACT_BODY_GRANT];
    const collisionManifest = bodyGrantManifest('collision-pack', grants, {
      recipes: [{ slug: 'shared-recipe', version: 1 }],
    });
    const { host, mount } = setupMount([
      installableBodyGrantEntry('collision-pack', grants, {
        manifest: collisionManifest,
      }),
      baseEntry({
        manifest: baseManifest({
          slug: 'other-pack',
          name: 'Other Pack',
          recipes: [{ slug: 'shared-recipe', version: 1 }],
        }),
      }),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('collision-pack');

    const dialog = dialogFor(host);
    const permList = findByClass(dialog, 'packs-dialog-perm-list');
    const { heading, list } = expectInstallBodyDisclosure(dialog, grants);
    const collisionCallout = findByAttr(dialog, PACKS_DIALOG_COLLISION_ATTR);
    expect(permList).not.toBeNull();
    expect(collisionCallout).not.toBeNull();

    const permListIndex = dialog.children.indexOf(permList!);
    const headingIndex = dialog.children.indexOf(heading);
    const listIndex = dialog.children.indexOf(list);
    const collisionIndex = dialog.children.indexOf(collisionCallout!);

    expect(permListIndex).toBeGreaterThanOrEqual(0);
    expect(headingIndex).toBeGreaterThan(permListIndex);
    expect(listIndex).toBe(headingIndex + 1);
    expect(collisionIndex).toBeGreaterThan(listIndex);
  });
});

// ==================================================================
// Group 5 - Parity with Slice G
// ==================================================================

describe('D-145 Slice I - parity with Slice G', () => {
  it('uses the same manifest grant list for install dialog and Delete strip', async () => {
    // Catches implementations that read different source fields or reuse the wrong attr namespace.
    const grants = [
      CONTACT_BODY_GRANT,
      'data.contact.timeline.body_content',
    ];
    const manifest = bodyGrantManifest('same-pack', grants);
    const installable = installableBodyGrantEntry('same-pack', grants, {
      manifest,
      body_visibility_grant_count: 0,
    });
    const installed = installedBodyGrantEntry('same-pack', grants, {
      manifest,
      body_visibility_grant_count: 0,
    });
    const { host, mount, swapPacks } = setupMount([installable]);
    await mount.whenLoaded();

    mount.clickInstall('same-pack');
    const dialogItems = installBodyGrantItemsFor(dialogFor(host));
    expect(dialogItems.map((item) => item.textContent)).toEqual(grants);
    expect(dialogItems.map((item) =>
      item.getAttribute(PACKS_DIALOG_BODY_GRANT_ATTR),
    )).toEqual(grants);

    mount.clickCancelDialog();
    swapPacks([installed]);
    mount.refresh();
    await mount.whenLoaded();
    mount.clickDelete('same-pack');

    const row = rowFor(host, 'same-pack');
    const deleteItems = deleteBodyGrantItemsFor(row);
    expect(PACKS_ROW_DELETE_BODY_GRANT_ATTR).not.toBe(PACKS_DIALOG_BODY_GRANT_ATTR);
    expect(deleteItems.map((item) => item.textContent)).toEqual(grants);
    expect(deleteItems.map((item) =>
      item.getAttribute(PACKS_ROW_DELETE_BODY_GRANT_ATTR),
    )).toEqual(grants);
  });
});

// ==================================================================
// Group 6 - Lifecycle
// ==================================================================

describe('D-145 Slice I - lifecycle', () => {
  it('removes the install disclosure when closing the dialog', async () => {
    // Catches implementations that leave stale disclosure DOM after Cancel.
    const grants = [CONTACT_BODY_GRANT];
    const { host, mount } = setupMount([
      installableBodyGrantEntry('cancel-pack', grants),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('cancel-pack');
    expectInstallBodyDisclosure(dialogFor(host), grants);

    mount.clickCancelDialog();

    expect(mount.getDialogOpenFor()).toBeNull();
    expect(findByAttr(host, PACKS_DIALOG_ATTR)).toBeNull();
    expectNoInstallBodyDisclosure(host);
  });
});

// ==================================================================
// Group 7 - Read-only surface
// ==================================================================

describe('D-145 Slice I - read-only surface', () => {
  it('renders passive li items with exact text and no listeners', async () => {
    // Catches implementations that add interactive controls to the read-only body-grant list.
    const grants = [
      CONTACT_BODY_GRANT,
      'data.contact.timeline.body_content',
    ];
    const { host, mount } = setupMount([
      installableBodyGrantEntry('readonly-pack', grants),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('readonly-pack');

    const { items } = expectInstallBodyDisclosure(dialogFor(host), grants);
    for (const [idx, item] of items.entries()) {
      expect(item.tagName).toBe('LI');
      expect(item.textContent).toBe(grants[idx]!);
      expect(item.listeners.size).toBe(0);
      expect(item.children).toEqual([]);
    }
  });
});

// ==================================================================
// Group 8 - Defensive shape
// ==================================================================

describe('D-145 Slice I - defensive shape', () => {
  it('preserves manifest array order during grants iteration', async () => {
    // Catches implementations that sort, de-dupe, or otherwise normalize the closed-list keys.
    const grants = [
      'data.zeta.body_content',
      CONTACT_BODY_GRANT,
      'data.alpha.body_content',
    ];
    const { host, mount } = setupMount([
      installableBodyGrantEntry('ordered-pack', grants),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('ordered-pack');

    const { items } = expectInstallBodyDisclosure(dialogFor(host), grants);
    expect(items.map((item) => item.textContent)).toEqual(grants);
  });

  it('renders a single long dotted grant key through textContent exactly', async () => {
    // Catches implementations that interpolate grant keys into markup strings.
    const grants = [LONG_DOTTED_BODY_GRANT];
    const { host, mount } = setupMount([
      installableBodyGrantEntry('long-grant-pack', grants),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('long-grant-pack');

    const { items } = expectInstallBodyDisclosure(dialogFor(host), grants);
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toBe(LONG_DOTTED_BODY_GRANT);
    expect(items[0]!.children).toEqual([]);
    expect(items[0]!.getAttribute(PACKS_DIALOG_BODY_GRANT_ATTR)).toBe(
      LONG_DOTTED_BODY_GRANT,
    );
  });
});
