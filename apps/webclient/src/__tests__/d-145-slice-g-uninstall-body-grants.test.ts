/** D-145 PA10 follow-on Slice G - Settings -> Packs panel uninstall body grants.
 *
 *  Covers the symmetric Delete-confirm disclosure that mirrors the
 *  install dialog's body-content grant callout.
 *
 *  Reuses the fake-DOM + setup helpers from the Slice E power-user
 *  toggle tests locally (copied rather than imported, mirroring the
 *  existing self-contained test files). */

import { describe, expect, it } from 'vitest';

import {
  PACKS_DIALOG_ATTR,
  PACKS_DIALOG_BODY_GRANT_ATTR,
  PACKS_ROW_DELETE_BODY_GRANT_ATTR,
  PACKS_ROW_DELETE_BODY_GRANT_LIST_ATTR,
  PACKS_ROW_DELETE_BTN_ATTR,
  PACKS_ROW_DELETE_CONFIRM_BTN_ATTR,
  PACKS_ROW_DELETE_FOUNDATION_WARN_ATTR,
  PACKS_ROW_INSTALL_BTN_ATTR,
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

// ──────────────────────────────────────────────────────────────────
// Fake DOM (mirrors Slice A test harness shape)
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

// ──────────────────────────────────────────────────────────────────
// Builders
// ──────────────────────────────────────────────────────────────────

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
    body_visibility_grant_count:
      manifest.mcp_body_visibility_grants?.length ?? 0,
    manifest,
    ...overrides,
  };
};

const installedEntry = (overrides: Partial<PackListEntry> = {}): PackListEntry =>
  baseEntry({ installed: true, ...overrides });

const foundationEntry = (
  overrides: Partial<PackListEntry> = {},
): PackListEntry => {
  const manifest =
    overrides.manifest
    ?? baseManifest({
      slug: 'foundation-pack',
      name: 'Foundation Pack',
      pre_install: true,
    });
  return installedEntry({
    slug: manifest.slug,
    publisher: manifest.publisher,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    pre_install: true,
    manifest,
    ...overrides,
  });
};

const nonFoundationEntry = (
  slug = 'non-foundation-pack',
  overrides: Partial<PackListEntry> = {},
): PackListEntry =>
  installedEntry({
    slug,
    manifest: baseManifest({ slug, name: 'Non-foundation Pack' }),
    ...overrides,
  });

const installableEntry = (
  slug = 'installable-pack',
  overrides: Partial<PackListEntry> = {},
): PackListEntry =>
  baseEntry({
    slug,
    installed: false,
    manifest: baseManifest({ slug, name: 'Installable Pack' }),
    ...overrides,
  });

const okUninstallResult = (): BulkPackUninstallResultLike => ({
  ok: true,
  removed: {
    recipes: ['recipe-a'],
    body_grants: [],
  },
});

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

// ──────────────────────────────────────────────────────────────────
// Setup helper
// ──────────────────────────────────────────────────────────────────

interface SetupOptions {
  runList?: PacksListCaller;
  runInstall?: PacksInstallCaller | null; // null -> omit
  runUninstall?: PacksUninstallCaller | null; // null -> omit
}

interface SetupResult {
  host: FakeElement;
  doc: FakeDocument;
  mount: ReturnType<typeof mountPacksPanel>;
  listCalls: Array<undefined>;
  uninstallCalls: Array<{ pack_slug: string }>;
  installCalls: Array<{ manifest: unknown; granted_permissions: ReadonlyArray<string> }>;
  swapPacks(next: ReadonlyArray<PackListEntry>): void;
}

const setupMount = (
  initialPacks: ReadonlyArray<PackListEntry> = [],
  overrides: SetupOptions = {},
): SetupResult => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const listCalls: Array<undefined> = [];
  const uninstallCalls: SetupResult['uninstallCalls'] = [];
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

  const defaultRunUninstall: PacksUninstallCaller = async (args) => {
    uninstallCalls.push(args);
    return { result: okUninstallResult() };
  };

  const mount = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList: overrides.runList ?? defaultRunList,
    // The panel is DETAIL-only — auto-open the first pack so `clickDelete`/
    // `clickInstall` reach the detail's affordances (was the list row).
    ...(initialPacks[0] !== undefined ? { initialSlug: initialPacks[0].slug } : {}),
    ...(overrides.runInstall === null
      ? {}
      : { runInstall: overrides.runInstall ?? defaultRunInstall }),
    ...(overrides.runUninstall === null
      ? {}
      : { runUninstall: overrides.runUninstall ?? defaultRunUninstall }),
  });

  return {
    host,
    doc,
    mount,
    listCalls,
    installCalls,
    uninstallCalls,
    swapPacks: (next) => {
      currentPacks = next;
    },
  };
};

const rowFor = (host: FakeElement, _slug: string): FakeElement => {
  // The panel is DETAIL-only now — the delete confirm strip + the body-grant /
  // overlap disclosure render in the (auto-opened) detail's identity section
  // (appendPackActions' target), not a list row. Only one pack's detail shows.
  const identity = findByAttrValue(host, 'data-recued-packs-detail-section', 'identity');
  expect(identity).not.toBeNull();
  return identity!;
};

// ──────────────────────────────────────────────────────────────────
// Slice G helpers
// ──────────────────────────────────────────────────────────────────

const DELETE_BODY_GRANTS_LABEL =
  'This pack will release the following body content:';
const CONTACT_BODY_GRANT = 'data.contact.engagements.body_content';

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

const installedBodyGrantEntry = (
  slug: string,
  grants: ReadonlyArray<string> | undefined,
  overrides: Partial<PackListEntry> = {},
): PackListEntry => {
  const manifest = bodyGrantManifest(slug, grants);
  return nonFoundationEntry(slug, {
    manifest,
    body_visibility_grant_count: grants?.length ?? 0,
    ...overrides,
  });
};

const installableBodyGrantEntry = (
  slug: string,
  grants: ReadonlyArray<string> | undefined,
  overrides: Partial<PackListEntry> = {},
): PackListEntry => {
  const manifest = bodyGrantManifest(slug, grants);
  return installableEntry(slug, {
    manifest,
    body_visibility_grant_count: grants?.length ?? 0,
    ...overrides,
  });
};

const foundationBodyGrantEntry = (
  grants: ReadonlyArray<string> | undefined,
  overrides: Partial<PackListEntry> = {},
): PackListEntry => {
  const manifest = bodyGrantManifest(
    'foundation-pack',
    grants,
    {
      name: 'Foundation Pack',
      pre_install: true,
    },
  );
  return foundationEntry({
    manifest,
    body_visibility_grant_count: grants?.length ?? 0,
    ...overrides,
  });
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

const findAllByTag = (
  root: FakeElement,
  tagName: string,
): FakeElement[] => {
  const out: FakeElement[] = [];
  const expected = tagName.toUpperCase();
  const walk = (n: FakeElement): void => {
    if (n.tagName === expected) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};

const walkElements = (
  root: FakeElement,
  visit: (el: FakeElement) => void,
): void => {
  visit(root);
  for (const c of root.children) walkElements(c, visit);
};

const deleteBodyHeadingFor = (row: FakeElement): FakeElement | null =>
  findByClass(row, 'packs-row-delete-body-heading');

const deleteBodyListFor = (row: FakeElement): FakeElement | null =>
  findByAttr(row, PACKS_ROW_DELETE_BODY_GRANT_LIST_ATTR);

const deleteBodyGrantItemsFor = (row: FakeElement): FakeElement[] => {
  const list = deleteBodyListFor(row);
  return list === null
    ? []
    : list.children.filter((child) =>
        child.hasAttribute(PACKS_ROW_DELETE_BODY_GRANT_ATTR),
      );
};

const expectNoDeleteBodyDisclosure = (root: FakeElement): void => {
  expect(findByClass(root, 'packs-row-delete-body-heading')).toBeNull();
  expect(findByAttr(root, PACKS_ROW_DELETE_BODY_GRANT_LIST_ATTR)).toBeNull();
  expect(findAllByAttr(root, PACKS_ROW_DELETE_BODY_GRANT_ATTR)).toEqual([]);
};

const expectDeleteBodyDisclosure = (
  row: FakeElement,
  grants: ReadonlyArray<string>,
): {
  heading: FakeElement;
  list: FakeElement;
  items: FakeElement[];
} => {
  const heading = deleteBodyHeadingFor(row);
  const list = deleteBodyListFor(row);
  expect(heading).not.toBeNull();
  expect(heading!.textContent).toBe(DELETE_BODY_GRANTS_LABEL);
  expect(list).not.toBeNull();
  const items = deleteBodyGrantItemsFor(row);
  expect(items).toHaveLength(grants.length);
  expect(items.map((item) => item.textContent)).toEqual(grants);
  return { heading: heading!, list: list!, items };
};

const expectDeleteConfirmStrip = (
  host: FakeElement,
  slug: string,
): void => {
  expect(
    findByAttrValue(host, PACKS_ROW_DELETE_CONFIRM_BTN_ATTR, slug),
  ).not.toBeNull();
};

// ==================================================================
// Group 1 - Disclosure visibility positive cases
// ==================================================================

describe('D-145 Slice G - disclosure visibility positive cases', () => {
  it('renders disclosure for a non-foundation pack after Delete arms the strip', async () => {
    // Catches implementations that render only the confirm strip and forget the Slice G heading/list.
    const grants = [CONTACT_BODY_GRANT];
    const { host, mount } = setupMount([
      installedBodyGrantEntry('body-pack', grants),
    ]);
    await mount.whenLoaded();

    mount.clickDelete('body-pack');

    expect(mount.getConfirmingDeleteFor()).toBe('body-pack');
    expectDeleteConfirmStrip(host, 'body-pack');
    const row = rowFor(host, 'body-pack');
    const { heading, list, items } = expectDeleteBodyDisclosure(row, grants);
    expect(heading.tagName).toBe('P');
    expect(list.tagName).toBe('UL');
    expect(items[0]!.tagName).toBe('LI');
    expect(items[0]!.textContent).toBe(CONTACT_BODY_GRANT);
  });

  it('renders one li per grant key and carries each key on the li attribute', async () => {
    // Catches implementations that collapse multiple grants or omit PACKS_ROW_DELETE_BODY_GRANT_ATTR values.
    const grants = [
      CONTACT_BODY_GRANT,
      'data.contact.engagements.body_content.v2',
      'data.contact.timeline.body_content',
    ];
    const { host, mount } = setupMount([
      installedBodyGrantEntry('multi-body-pack', grants),
    ]);
    await mount.whenLoaded();

    mount.clickDelete('multi-body-pack');

    const row = rowFor(host, 'multi-body-pack');
    const { items } = expectDeleteBodyDisclosure(row, grants);
    expect(items.map((item) =>
      item.getAttribute(PACKS_ROW_DELETE_BODY_GRANT_ATTR),
    )).toEqual(grants);
  });

  it('renders disclosure alongside the foundation warning (Delta 6 — direct foundation Delete)', async () => {
    // Catches implementations that special-case foundation warning rendering and drop the body-grant disclosure.
    const grants = [CONTACT_BODY_GRANT];
    const { host, mount } = setupMount([
      foundationBodyGrantEntry(grants),
    ]);
    await mount.whenLoaded();

    mount.clickDelete('foundation-pack');

    const row = rowFor(host, 'foundation-pack');
    expect(findByAttr(row, PACKS_ROW_DELETE_FOUNDATION_WARN_ATTR)).not.toBeNull();
    expectDeleteBodyDisclosure(row, grants);
  });
});

// ==================================================================
// Group 2 - Disclosure visibility negative cases
// ==================================================================

describe('D-145 Slice G - disclosure visibility negative cases', () => {
  it('does not render disclosure when body grants are an empty array', async () => {
    // Catches implementations that render a blank disclosure whenever the Delete strip is armed.
    const { host, mount } = setupMount([
      installedBodyGrantEntry('empty-grants-pack', []),
    ]);
    await mount.whenLoaded();

    mount.clickDelete('empty-grants-pack');

    expect(mount.getConfirmingDeleteFor()).toBe('empty-grants-pack');
    expectDeleteConfirmStrip(host, 'empty-grants-pack');
    expectNoDeleteBodyDisclosure(rowFor(host, 'empty-grants-pack'));
  });

  it('does not render disclosure when body grants are omitted', async () => {
    // Catches implementations that assume a missing grants array should still produce the disclosure shell.
    const { host, mount } = setupMount([
      installedBodyGrantEntry('missing-grants-pack', undefined),
    ]);
    await mount.whenLoaded();

    mount.clickDelete('missing-grants-pack');

    expect(mount.getConfirmingDeleteFor()).toBe('missing-grants-pack');
    expectDeleteConfirmStrip(host, 'missing-grants-pack');
    expectNoDeleteBodyDisclosure(rowFor(host, 'missing-grants-pack'));
  });

  it('does not render disclosure before the confirm strip is armed', async () => {
    // Catches implementations that reveal body grants just because the pack is installed and has grants.
    const { host, mount } = setupMount([
      installedBodyGrantEntry('unarmed-pack', [CONTACT_BODY_GRANT]),
    ]);
    await mount.whenLoaded();

    expect(mount.getConfirmingDeleteFor()).toBeNull();
    expect(findByAttrValue(host, PACKS_ROW_DELETE_BTN_ATTR, 'unarmed-pack')).not.toBeNull();
    expectNoDeleteBodyDisclosure(rowFor(host, 'unarmed-pack'));
  });

  it('does not render disclosure when runUninstall is omitted', async () => {
    // Catches implementations that expose uninstall disclosures on a read-only no-uninstall surface.
    const { host, mount } = setupMount(
      [installedBodyGrantEntry('no-uninstall-pack', [CONTACT_BODY_GRANT])],
      { runUninstall: null },
    );
    await mount.whenLoaded();

    mount.clickDelete('no-uninstall-pack');

    expect(mount.getConfirmingDeleteFor()).toBeNull();
    expect(findByAttrValue(host, PACKS_ROW_DELETE_BTN_ATTR, 'no-uninstall-pack')).toBeNull();
    expectNoDeleteBodyDisclosure(rowFor(host, 'no-uninstall-pack'));
  });

  it('does not render disclosure for a non-installed pack with body grants', async () => {
    // Catches implementations that gate on grants but forget installed packs are the only uninstallable rows.
    const { host, mount } = setupMount([
      installableBodyGrantEntry('not-installed-pack', [CONTACT_BODY_GRANT]),
    ]);
    await mount.whenLoaded();

    mount.clickDelete('not-installed-pack');

    expect(mount.getConfirmingDeleteFor()).toBeNull();
    expect(findByAttrValue(host, PACKS_ROW_DELETE_BTN_ATTR, 'not-installed-pack')).toBeNull();
    expect(findByAttrValue(host, PACKS_ROW_INSTALL_BTN_ATTR, 'not-installed-pack')).not.toBeNull();
    expectNoDeleteBodyDisclosure(rowFor(host, 'not-installed-pack'));
  });

  it('ignores body_visibility_grant_count when the grants array is empty', async () => {
    // Catches regressions that use body_visibility_grant_count instead of manifest.mcp_body_visibility_grants.
    const { host, mount } = setupMount([
      installedBodyGrantEntry('count-empty-pack', [], {
        body_visibility_grant_count: 3,
      }),
    ]);
    await mount.whenLoaded();

    mount.clickDelete('count-empty-pack');

    expect(mount.getConfirmingDeleteFor()).toBe('count-empty-pack');
    expectDeleteConfirmStrip(host, 'count-empty-pack');
    expectNoDeleteBodyDisclosure(rowFor(host, 'count-empty-pack'));
  });

  it('ignores body_visibility_grant_count when the grants array is omitted', async () => {
    // Catches regressions that use the count field and render a heading with no backing grant keys.
    const { host, mount } = setupMount([
      installedBodyGrantEntry('count-missing-pack', undefined, {
        body_visibility_grant_count: 1,
      }),
    ]);
    await mount.whenLoaded();

    mount.clickDelete('count-missing-pack');

    expect(mount.getConfirmingDeleteFor()).toBe('count-missing-pack');
    expectDeleteConfirmStrip(host, 'count-missing-pack');
    expectNoDeleteBodyDisclosure(rowFor(host, 'count-missing-pack'));
  });
});

// ==================================================================
// Group 3 - DOM position invariant
// ==================================================================

describe('D-145 Slice G - DOM position invariant', () => {
  it('places the disclosure after foundation warning and before the footer', async () => {
    // Catches implementations that append the disclosure inside the footer or before the foundation warning.
    const grants = [CONTACT_BODY_GRANT];
    const withWarning = setupMount([
      foundationBodyGrantEntry(grants),
    ]);
    await withWarning.mount.whenLoaded();
    withWarning.mount.clickDelete('foundation-pack');

    const foundationRow = rowFor(withWarning.host, 'foundation-pack');
    const warning = findByAttr(
      foundationRow,
      PACKS_ROW_DELETE_FOUNDATION_WARN_ATTR,
    );
    const heading = deleteBodyHeadingFor(foundationRow);
    const list = deleteBodyListFor(foundationRow);
    const footerIndex = foundationRow.children.findIndex(
      (child) => child.tagName === 'FOOTER',
    );
    const foundationWarningIndex = foundationRow.children.indexOf(warning!);
    const headingIndex = foundationRow.children.indexOf(heading!);
    const listIndex = foundationRow.children.indexOf(list!);

    expect(foundationWarningIndex).toBeGreaterThanOrEqual(0);
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(footerIndex).toBeGreaterThanOrEqual(0);
    expect(foundationWarningIndex).toBeLessThan(headingIndex);
    expect(headingIndex).toBeLessThan(listIndex);
    expect(listIndex).toBeLessThan(footerIndex);

    const withoutWarning = setupMount([
      installedBodyGrantEntry('regular-pack', grants),
    ]);
    await withoutWarning.mount.whenLoaded();
    withoutWarning.mount.clickDelete('regular-pack');

    const regularRow = rowFor(withoutWarning.host, 'regular-pack');
    const regularHeading = deleteBodyHeadingFor(regularRow);
    const regularList = deleteBodyListFor(regularRow);
    const regularHeadingIndex = regularRow.children.indexOf(regularHeading!);
    const regularListIndex = regularRow.children.indexOf(regularList!);
    const regularFooterIndex = regularRow.children.findIndex(
      (child) => child.tagName === 'FOOTER',
    );

    expect(regularHeadingIndex).toBeGreaterThanOrEqual(0);
    expect(regularListIndex).toBeGreaterThanOrEqual(0);
    expect(regularFooterIndex).toBeGreaterThanOrEqual(0);
    expect(regularHeadingIndex).toBeLessThan(regularFooterIndex);
    expect(regularHeadingIndex).toBeLessThan(regularListIndex);
  });
});

// ==================================================================
// Group 4 - Disclosure lifecycle invariance
// ==================================================================

describe('D-145 Slice G - disclosure lifecycle invariance', () => {
  it('removes disclosure when Cancel closes the confirm strip', async () => {
    // Catches implementations that leave stale disclosure DOM after canceling Delete.
    const grants = [CONTACT_BODY_GRANT];
    const { host, mount } = setupMount([
      installedBodyGrantEntry('cancel-pack', grants),
    ]);
    await mount.whenLoaded();

    mount.clickDelete('cancel-pack');
    expectDeleteBodyDisclosure(rowFor(host, 'cancel-pack'), grants);

    mount.clickCancelDelete();

    expect(mount.getConfirmingDeleteFor()).toBeNull();
    expectNoDeleteBodyDisclosure(rowFor(host, 'cancel-pack'));
  });

  it('removes disclosure after successful Confirm delete and refresh', async () => {
    // Catches implementations that close the strip but fail to clear the rendered body-grant block after refresh.
    const grants = [CONTACT_BODY_GRANT];
    const { host, mount, listCalls } = setupMount([
      installedBodyGrantEntry('confirm-pack', grants),
    ]);
    await mount.whenLoaded();
    expect(listCalls).toHaveLength(1);

    mount.clickDelete('confirm-pack');
    expectDeleteBodyDisclosure(rowFor(host, 'confirm-pack'), grants);
    await mount.clickConfirmDelete();

    expect(listCalls.length).toBeGreaterThanOrEqual(2);
    expect(mount.getConfirmingDeleteFor()).toBeNull();
    expectNoDeleteBodyDisclosure(rowFor(host, 'confirm-pack'));
  });

  it('navigating to another pack + installing it clears the prior Delete disclosure', async () => {
    // Detail-only successor to the list-era cross-row gate: a Delete strip's body
    // disclosure must not linger once the user pivots to installing another pack.
    // (Two packs' affordances can't render at once now — navigation collapses.)
    const grants = [CONTACT_BODY_GRANT];
    const { host, mount } = setupMount([
      installedBodyGrantEntry('delete-pack', grants),
      installableEntry('install-pack'),
    ]);
    await mount.whenLoaded();

    mount.clickDelete('delete-pack');
    expectDeleteBodyDisclosure(rowFor(host, 'delete-pack'), grants);

    // Navigate to the other pack, then open its install dialog.
    mount.clickSelectPack('install-pack');
    mount.clickInstall('install-pack');

    expect(mount.getConfirmingDeleteFor()).toBeNull();
    expect(mount.getDialogOpenFor()).toBe('install-pack');
    expect(findByAttr(host, PACKS_DIALOG_ATTR)).not.toBeNull();
    // delete-pack's detail (and its disclosure) is no longer rendered.
    expect(findByAttrValue(host, PACKS_ROW_DELETE_BODY_GRANT_LIST_ATTR, '')).toBeNull();
  });
});

// ==================================================================
// Group 5 - Symmetry parity with install dialog
// ==================================================================

describe('D-145 Slice G - symmetry parity with install dialog', () => {
  it('renders the existing install-side body callout for a pack with grants', async () => {
    // Catches implementations that break the install-dialog body grant namespace while adding uninstall disclosure.
    const grants = [CONTACT_BODY_GRANT];
    const { host, mount } = setupMount([
      installableBodyGrantEntry('install-body-pack', grants),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('install-body-pack');

    const dialogItems = findAllByAttr(host, PACKS_DIALOG_BODY_GRANT_ATTR);
    expect(dialogItems).toHaveLength(grants.length);
    expect(dialogItems.map((item) => item.textContent)).toEqual(grants);
    expect(dialogItems.map((item) =>
      item.getAttribute(PACKS_DIALOG_BODY_GRANT_ATTR),
    )).toEqual(grants);
  });

  it('switches from install-side callout to uninstall-side disclosure using the same manifest grants', async () => {
    // Catches implementations that reuse the install attr namespace or read different source data for Delete.
    const grants = [CONTACT_BODY_GRANT];
    const manifest = bodyGrantManifest('same-pack', grants);
    const installable = installableEntry('same-pack', {
      manifest,
      body_visibility_grant_count: grants.length,
    });
    const installed = installedEntry({
      manifest,
      body_visibility_grant_count: grants.length,
    });
    const { host, mount, swapPacks } = setupMount([installable]);
    await mount.whenLoaded();

    mount.clickInstall('same-pack');
    expect(findAllByAttr(host, PACKS_DIALOG_BODY_GRANT_ATTR)).toHaveLength(1);

    mount.clickCancelDialog();
    swapPacks([installed]);
    mount.refresh();
    await mount.whenLoaded();
    mount.clickDelete('same-pack');

    expect(findByAttr(host, PACKS_DIALOG_ATTR)).toBeNull();
    expect(findAllByAttr(host, PACKS_DIALOG_BODY_GRANT_ATTR)).toEqual([]);
    expect(PACKS_ROW_DELETE_BODY_GRANT_ATTR).not.toBe(PACKS_DIALOG_BODY_GRANT_ATTR);
    const row = rowFor(host, 'same-pack');
    const { items } = expectDeleteBodyDisclosure(row, grants);
    expect(items.map((item) =>
      item.getAttribute(PACKS_ROW_DELETE_BODY_GRANT_ATTR),
    )).toEqual(grants);
  });
});

// ==================================================================
// Group 6 - Read-only no-listener surface
// ==================================================================

describe('D-145 Slice G - read-only no-listener surface', () => {
  it('renders disclosure as passive p/ul/li elements without interactive descendants', async () => {
    // Catches implementations that add clickable controls or listeners to the read-only disclosure.
    const grants = [CONTACT_BODY_GRANT];
    const { host, mount } = setupMount([
      installedBodyGrantEntry('readonly-pack', grants),
    ]);
    await mount.whenLoaded();

    mount.clickDelete('readonly-pack');

    const row = rowFor(host, 'readonly-pack');
    const { heading, list, items } = expectDeleteBodyDisclosure(row, grants);
    expect(heading.tagName).toBe('P');
    expect(list.tagName).toBe('UL');
    expect(items.map((item) => item.tagName)).toEqual(['LI']);
    expect(findAllByTag(heading, 'a')).toEqual([]);
    expect(findAllByTag(heading, 'button')).toEqual([]);
    expect(findAllByTag(heading, 'input')).toEqual([]);
    expect(findAllByTag(list, 'a')).toEqual([]);
    expect(findAllByTag(list, 'button')).toEqual([]);
    expect(findAllByTag(list, 'input')).toEqual([]);
    walkElements(heading, (el) => {
      expect(el.listeners.size).toBe(0);
    });
    walkElements(list, (el) => {
      expect(el.listeners.size).toBe(0);
    });
  });
});

// ==================================================================
// Group 7 - Defensive XSS-shape
// ==================================================================

describe('D-145 Slice G - defensive XSS-shape', () => {
  it('renders the grant key through textContent exactly', async () => {
    // Catches implementations that interpolate grant keys into markup strings instead of assigning textContent.
    const grants = [CONTACT_BODY_GRANT];
    const { host, mount } = setupMount([
      installedBodyGrantEntry('xss-shape-pack', grants),
    ]);
    await mount.whenLoaded();

    mount.clickDelete('xss-shape-pack');

    const row = rowFor(host, 'xss-shape-pack');
    const { items } = expectDeleteBodyDisclosure(row, grants);
    expect(items[0]!.textContent).toBe(CONTACT_BODY_GRANT);
    expect(items[0]!.children).toEqual([]);
    expect(items[0]!.getAttribute(PACKS_ROW_DELETE_BODY_GRANT_ATTR)).toBe(
      CONTACT_BODY_GRANT,
    );
  });
});
