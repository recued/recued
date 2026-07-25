/** D-145 PA10 follow-on Slice J - Settings -> Packs panel grant overlap disclosure.
 *
 *  Render integration coverage for the install-dialog and Delete-strip
 *  cross-pack body-grant overlap callouts. Mirrors the local fake-DOM
 *  harness shape from Slice I and Slice G so the file is self-contained.
 */

import { describe, expect, it } from 'vitest';

import {
  PACKS_DIALOG_ATTR,
  PACKS_DIALOG_BODY_GRANT_ATTR,
  PACKS_DIALOG_COLLISION_ATTR,
  PACKS_DIALOG_GRANT_OVERLAP_ATTR,
  PACKS_DIALOG_GRANT_OVERLAP_ITEM_ATTR,
  PACKS_ROW_DELETE_BODY_GRANT_LIST_ATTR,
  PACKS_ROW_DELETE_BTN_ATTR,
  PACKS_ROW_DELETE_CONFIRM_BTN_ATTR,
  PACKS_ROW_DELETE_GRANT_OVERLAP_ATTR,
  PACKS_ROW_DELETE_GRANT_OVERLAP_ITEM_ATTR,
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
// Fake DOM (mirrors Slice I/G test harness shape)
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

const INSTALL_BODY_GRANTS_LABEL =
  'This pack will access the following body content:';
const DIALOG_GRANT_OVERLAP_HEADING =
  'This body content is already accessible via other installed packs:';
const DELETE_GRANT_OVERLAP_HEADING =
  'This body content remains accessible via other installed packs after uninstall:';
const GRANT_OVERLAP_PREFIX = ' — also via ';
const CONTACT_BODY_GRANT = 'data.contact.engagements.body_content';
const TIMELINE_BODY_GRANT = 'data.contact.timeline.body_content';

const asBodyGrants = (
  grants: ReadonlyArray<string>,
): BulkPackManifest['mcp_body_visibility_grants'] =>
  grants as unknown as BulkPackManifest['mcp_body_visibility_grants'];

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

const bodyGrantManifest = (
  slug: string,
  grants: ReadonlyArray<string> | undefined,
  overrides: Partial<BulkPackManifest> = {},
): BulkPackManifest => {
  const manifest = baseManifest({
    slug,
    name: slug,
    recipes: [{ slug: `${slug}-recipe`, version: 1 }],
    ...overrides,
  });
  if (grants === undefined) return manifest;
  return {
    ...manifest,
    mcp_body_visibility_grants: asBodyGrants(grants),
  };
};

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

const bodyGrantEntry = (
  slug: string,
  grants: ReadonlyArray<string> | undefined,
  installed: boolean,
  overrides: Partial<PackListEntry> = {},
): PackListEntry => {
  const manifest = overrides.manifest ?? bodyGrantManifest(slug, grants);
  return baseEntry({
    manifest,
    installed,
    body_visibility_grant_count:
      manifest.mcp_body_visibility_grants?.length ?? 0,
    ...overrides,
  });
};

const installableBodyGrantEntry = (
  slug: string,
  grants: ReadonlyArray<string> | undefined,
  overrides: Partial<PackListEntry> = {},
): PackListEntry => bodyGrantEntry(slug, grants, false, overrides);

const installedBodyGrantEntry = (
  slug: string,
  grants: ReadonlyArray<string> | undefined,
  overrides: Partial<PackListEntry> = {},
): PackListEntry => bodyGrantEntry(slug, grants, true, overrides);

const foundationBodyGrantEntry = (
  slug: string,
  grants: ReadonlyArray<string> | undefined,
  overrides: Partial<PackListEntry> = {},
): PackListEntry => {
  const manifest =
    overrides.manifest
    ?? bodyGrantManifest(slug, grants, {
      name: 'Foundation Pack',
      pre_install: true,
    });
  return installedBodyGrantEntry(slug, grants, {
    manifest,
    pre_install: true,
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

interface SetupOptions {
  runList?: PacksListCaller;
  runInstall?: PacksInstallCaller | null;
  runUninstall?: PacksUninstallCaller | null;
}

interface SetupResult {
  host: FakeElement;
  doc: FakeDocument;
  mount: ReturnType<typeof mountPacksPanel>;
  swapPacks(next: ReadonlyArray<PackListEntry>): void;
}

const setupMount = (
  initialPacks: ReadonlyArray<PackListEntry> = [],
  overrides: SetupOptions = {},
): SetupResult => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  let currentPacks: ReadonlyArray<PackListEntry> = initialPacks;

  const defaultRunList: PacksListCaller = async () => ({ packs: currentPacks });
  const defaultRunInstall: PacksInstallCaller = async () => ({
    result: okInstallResult(),
  });
  const defaultRunUninstall: PacksUninstallCaller = async () => ({
    result: okUninstallResult(),
  });

  const mount = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList: overrides.runList ?? defaultRunList,
    // The panel is DETAIL-only — auto-open the first pack (the subject pack in
    // these overlap tests) so `clickInstall`/`clickDelete` reach the detail.
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
    swapPacks: (next) => {
      currentPacks = next;
    },
  };
};

// ------------------------------------------------------------------
// DOM helpers
// ------------------------------------------------------------------

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

const installBodyListFor = (root: FakeElement): FakeElement | null =>
  findByClass(root, 'packs-dialog-body-list');

const installBodyGrantItemsFor = (root: FakeElement): FakeElement[] =>
  findAllByAttr(root, PACKS_DIALOG_BODY_GRANT_ATTR);

const dialogOverlapSectionFor = (
  root: FakeElement,
): FakeElement | null => findByAttr(root, PACKS_DIALOG_GRANT_OVERLAP_ATTR);

const dialogOverlapListFor = (
  root: FakeElement,
): FakeElement | null => findByClass(root, 'packs-dialog-grant-overlap-list');

const dialogOverlapItemsFor = (root: FakeElement): FakeElement[] =>
  findAllByAttr(root, PACKS_DIALOG_GRANT_OVERLAP_ITEM_ATTR);

const deleteBodyListFor = (row: FakeElement): FakeElement | null =>
  findByAttr(row, PACKS_ROW_DELETE_BODY_GRANT_LIST_ATTR);

const deleteOverlapSectionFor = (
  row: FakeElement,
): FakeElement | null => findByAttr(row, PACKS_ROW_DELETE_GRANT_OVERLAP_ATTR);

const deleteOverlapListFor = (
  row: FakeElement,
): FakeElement | null => findByClass(row, 'packs-row-delete-grant-overlap-list');

const deleteOverlapItemsFor = (row: FakeElement): FakeElement[] =>
  findAllByAttr(row, PACKS_ROW_DELETE_GRANT_OVERLAP_ITEM_ATTR);

const expectNoInstallOverlapDisclosure = (root: FakeElement): void => {
  expect(dialogOverlapSectionFor(root)).toBeNull();
  expect(dialogOverlapItemsFor(root)).toEqual([]);
};

const expectNoDeleteOverlapDisclosure = (row: FakeElement): void => {
  expect(deleteOverlapSectionFor(row)).toBeNull();
  expect(deleteOverlapItemsFor(row)).toEqual([]);
};

const expectedOverlapText = (
  grantKey: string,
  otherPackSlugs: ReadonlyArray<string>,
): string => `${grantKey}${GRANT_OVERLAP_PREFIX}${otherPackSlugs.join(', ')}`;

const expectInstallOverlapDisclosure = (
  root: FakeElement,
  entries: ReadonlyArray<{
    grantKey: string;
    otherPackSlugs: ReadonlyArray<string>;
  }>,
): {
  section: FakeElement;
  heading: FakeElement;
  list: FakeElement;
  items: FakeElement[];
} => {
  const section = dialogOverlapSectionFor(root);
  expect(section).not.toBeNull();
  const heading = findByClass(section!, 'packs-dialog-grant-overlap-heading');
  expect(heading).not.toBeNull();
  expect(heading!.textContent).toBe(DIALOG_GRANT_OVERLAP_HEADING);
  const list = dialogOverlapListFor(section!);
  expect(list).not.toBeNull();
  const items = dialogOverlapItemsFor(section!);
  expect(items).toHaveLength(entries.length);
  expect(items.map((item) =>
    item.getAttribute(PACKS_DIALOG_GRANT_OVERLAP_ITEM_ATTR),
  )).toEqual(entries.map((entry) => entry.grantKey));
  expect(items.map((item) => item.textContent)).toEqual(
    entries.map((entry) =>
      expectedOverlapText(entry.grantKey, entry.otherPackSlugs),
    ),
  );
  return { section: section!, heading: heading!, list: list!, items };
};

const expectDeleteOverlapDisclosure = (
  row: FakeElement,
  entries: ReadonlyArray<{
    grantKey: string;
    otherPackSlugs: ReadonlyArray<string>;
  }>,
): {
  section: FakeElement;
  heading: FakeElement;
  list: FakeElement;
  items: FakeElement[];
} => {
  const section = deleteOverlapSectionFor(row);
  expect(section).not.toBeNull();
  const heading = findByClass(
    section!,
    'packs-row-delete-grant-overlap-heading',
  );
  expect(heading).not.toBeNull();
  expect(heading!.textContent).toBe(DELETE_GRANT_OVERLAP_HEADING);
  const list = deleteOverlapListFor(section!);
  expect(list).not.toBeNull();
  const items = deleteOverlapItemsFor(section!);
  expect(items).toHaveLength(entries.length);
  expect(items.map((item) =>
    item.getAttribute(PACKS_ROW_DELETE_GRANT_OVERLAP_ITEM_ATTR),
  )).toEqual(entries.map((entry) => entry.grantKey));
  expect(items.map((item) => item.textContent)).toEqual(
    entries.map((entry) =>
      expectedOverlapText(entry.grantKey, entry.otherPackSlugs),
    ),
  );
  return { section: section!, heading: heading!, list: list!, items };
};

// ------------------------------------------------------------------
// Panel render integration
// ------------------------------------------------------------------

describe('D-145 Slice J - panel overlap disclosure', () => {
  it('P1 install dialog overlap callout renders heading and per-grant items', async () => {
    const { host, mount } = setupMount([
      installableBodyGrantEntry('subject-pack', [
        CONTACT_BODY_GRANT,
        TIMELINE_BODY_GRANT,
      ]),
      installedBodyGrantEntry('pack-a', [CONTACT_BODY_GRANT]),
      installedBodyGrantEntry('pack-b', [TIMELINE_BODY_GRANT]),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('subject-pack');

    const { section, heading, list, items } = expectInstallOverlapDisclosure(
      dialogFor(host),
      [
        {
          grantKey: CONTACT_BODY_GRANT,
          otherPackSlugs: ['pack-a'],
        },
        {
          grantKey: TIMELINE_BODY_GRANT,
          otherPackSlugs: ['pack-b'],
        },
      ],
    );
    expect(section.tagName).toBe('SECTION');
    expect(heading.tagName).toBe('P');
    expect(list.tagName).toBe('UL');
    expect(items.map((item) => item.tagName)).toEqual(['LI', 'LI']);
  });

  it('P2 install dialog overlap does not render when grantOverlap is empty', async () => {
    const { host, mount } = setupMount([
      installableBodyGrantEntry('subject-pack', [CONTACT_BODY_GRANT]),
      installedBodyGrantEntry('other-pack', [TIMELINE_BODY_GRANT]),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('subject-pack');

    expectNoInstallOverlapDisclosure(dialogFor(host));
  });

  it('P3 install dialog orders permissions, body grants, overlap, then collisions', async () => {
    const subjectManifest = bodyGrantManifest(
      'subject-pack',
      [CONTACT_BODY_GRANT],
      { recipes: [{ slug: 'shared-recipe', version: 1 }] },
    );
    const ownerManifest = bodyGrantManifest(
      'pack-a',
      [CONTACT_BODY_GRANT],
      { recipes: [{ slug: 'shared-recipe', version: 2 }] },
    );
    const { host, mount } = setupMount([
      installableBodyGrantEntry('subject-pack', [CONTACT_BODY_GRANT], {
        manifest: subjectManifest,
      }),
      installedBodyGrantEntry('pack-a', [CONTACT_BODY_GRANT], {
        manifest: ownerManifest,
      }),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('subject-pack');

    const dialog = dialogFor(host);
    const permList = findByClass(dialog, 'packs-dialog-perm-list');
    const bodyGrantsList = installBodyListFor(dialog);
    const overlapList = dialogOverlapListFor(dialog);
    const overlapSection = dialogOverlapSectionFor(dialog);
    const collisionCallout = findByAttr(dialog, PACKS_DIALOG_COLLISION_ATTR);
    expect(permList).not.toBeNull();
    expect(bodyGrantsList).not.toBeNull();
    expect(overlapList).not.toBeNull();
    expect(overlapSection).not.toBeNull();
    expect(collisionCallout).not.toBeNull();

    const permListIndex = dialog.children.indexOf(permList!);
    const bodyGrantsListIndex = dialog.children.indexOf(bodyGrantsList!);
    const overlapIndex = dialog.children.indexOf(overlapSection!);
    const collisionIndex = dialog.children.indexOf(collisionCallout!);

    expect(overlapList!.parent).toBe(overlapSection);
    expect(permListIndex).toBeGreaterThanOrEqual(0);
    expect(bodyGrantsListIndex).toBeGreaterThan(permListIndex);
    expect(overlapIndex).toBeGreaterThan(bodyGrantsListIndex);
    expect(collisionIndex).toBeGreaterThan(overlapIndex);
  });

  it('P4 install dialog li textContent uses grant key and sorted other slugs', async () => {
    const { host, mount } = setupMount([
      installableBodyGrantEntry('subject-pack', [CONTACT_BODY_GRANT]),
      installedBodyGrantEntry('pack-b', [CONTACT_BODY_GRANT]),
      installedBodyGrantEntry('pack-a', [CONTACT_BODY_GRANT]),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('subject-pack');

    const items = dialogOverlapItemsFor(dialogFor(host));
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toBe(
      `${CONTACT_BODY_GRANT}${GRANT_OVERLAP_PREFIX}pack-a, pack-b`,
    );
    expect(items[0]!.getAttribute(PACKS_DIALOG_GRANT_OVERLAP_ITEM_ATTR)).toBe(
      CONTACT_BODY_GRANT,
    );
  });

  it('P5 delete-strip overlap callout respects showDelete, confirm, and grants gates', async () => {
    const ready = setupMount([
      installedBodyGrantEntry('subject-pack', [CONTACT_BODY_GRANT]),
      installedBodyGrantEntry('pack-a', [CONTACT_BODY_GRANT]),
    ]);
    await ready.mount.whenLoaded();

    expectNoDeleteOverlapDisclosure(rowFor(ready.host, 'subject-pack'));
    ready.mount.clickDelete('subject-pack');
    expectDeleteOverlapDisclosure(rowFor(ready.host, 'subject-pack'), [
      {
        grantKey: CONTACT_BODY_GRANT,
        otherPackSlugs: ['pack-a'],
      },
    ]);

    // Delta 6 — foundation packs delete directly (no reveal toggle); the
    // armed strip carries the overlap disclosure like any installed pack.
    const foundation = setupMount([
      foundationBodyGrantEntry('foundation-pack', [CONTACT_BODY_GRANT]),
      installedBodyGrantEntry('pack-a', [CONTACT_BODY_GRANT]),
    ]);
    await foundation.mount.whenLoaded();
    expectNoDeleteOverlapDisclosure(
      rowFor(foundation.host, 'foundation-pack'),
    );
    foundation.mount.clickDelete('foundation-pack');
    expect(foundation.mount.getConfirmingDeleteFor()).toBe('foundation-pack');
    expectDeleteOverlapDisclosure(
      rowFor(foundation.host, 'foundation-pack'),
      [
        {
          grantKey: CONTACT_BODY_GRANT,
          otherPackSlugs: ['pack-a'],
        },
      ],
    );

    const noGrants = setupMount([
      installedBodyGrantEntry('no-grants-pack', []),
      installedBodyGrantEntry('pack-a', [CONTACT_BODY_GRANT]),
    ]);
    await noGrants.mount.whenLoaded();
    noGrants.mount.clickDelete('no-grants-pack');
    expect(findByAttrValue(
      noGrants.host,
      PACKS_ROW_DELETE_CONFIRM_BTN_ATTR,
      'no-grants-pack',
    )).not.toBeNull();
    expectNoDeleteOverlapDisclosure(rowFor(noGrants.host, 'no-grants-pack'));
  });

  it('P6 delete-strip overlap callout renders under body grants and above footer', async () => {
    const { host, mount } = setupMount([
      installedBodyGrantEntry('subject-pack', [CONTACT_BODY_GRANT]),
      installedBodyGrantEntry('pack-a', [CONTACT_BODY_GRANT]),
    ]);
    await mount.whenLoaded();

    mount.clickDelete('subject-pack');

    const row = rowFor(host, 'subject-pack');
    const bodyList = deleteBodyListFor(row);
    const { section } = expectDeleteOverlapDisclosure(row, [
      {
        grantKey: CONTACT_BODY_GRANT,
        otherPackSlugs: ['pack-a'],
      },
    ]);
    const footerIndex = row.children.findIndex(
      (child) => child.tagName === 'FOOTER',
    );
    const bodyListIndex = row.children.indexOf(bodyList!);
    const overlapIndex = row.children.indexOf(section);

    expect(bodyList).not.toBeNull();
    expect(footerIndex).toBeGreaterThanOrEqual(0);
    expect(bodyListIndex).toBeGreaterThanOrEqual(0);
    expect(overlapIndex).toBeGreaterThan(bodyListIndex);
    expect(overlapIndex).toBeLessThan(footerIndex);
  });

  it('P7 delete-strip li textContent matches install-side format', async () => {
    const { host, mount } = setupMount([
      installedBodyGrantEntry('subject-pack', [CONTACT_BODY_GRANT]),
      installedBodyGrantEntry('pack-b', [CONTACT_BODY_GRANT]),
      installedBodyGrantEntry('pack-a', [CONTACT_BODY_GRANT]),
    ]);
    await mount.whenLoaded();

    mount.clickDelete('subject-pack');

    const items = deleteOverlapItemsFor(rowFor(host, 'subject-pack'));
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toBe(
      `${CONTACT_BODY_GRANT}${GRANT_OVERLAP_PREFIX}pack-a, pack-b`,
    );
    expect(items[0]!.getAttribute(PACKS_ROW_DELETE_GRANT_OVERLAP_ITEM_ATTR))
      .toBe(CONTACT_BODY_GRANT);
  });

  it('P8 closing install dialog or cancelling Delete strip removes overlap callout', async () => {
    const install = setupMount([
      installableBodyGrantEntry('subject-pack', [CONTACT_BODY_GRANT]),
      installedBodyGrantEntry('pack-a', [CONTACT_BODY_GRANT]),
    ]);
    await install.mount.whenLoaded();
    install.mount.clickInstall('subject-pack');
    expectInstallOverlapDisclosure(dialogFor(install.host), [
      {
        grantKey: CONTACT_BODY_GRANT,
        otherPackSlugs: ['pack-a'],
      },
    ]);

    install.mount.clickCancelDialog();

    expect(install.mount.getDialogOpenFor()).toBeNull();
    expect(findByAttr(install.host, PACKS_DIALOG_ATTR)).toBeNull();
    expectNoInstallOverlapDisclosure(install.host);

    const deletion = setupMount([
      installedBodyGrantEntry('subject-pack', [CONTACT_BODY_GRANT]),
      installedBodyGrantEntry('pack-a', [CONTACT_BODY_GRANT]),
    ]);
    await deletion.mount.whenLoaded();
    deletion.mount.clickDelete('subject-pack');
    expectDeleteOverlapDisclosure(rowFor(deletion.host, 'subject-pack'), [
      {
        grantKey: CONTACT_BODY_GRANT,
        otherPackSlugs: ['pack-a'],
      },
    ]);

    deletion.mount.clickCancelDelete();

    expect(deletion.mount.getConfirmingDeleteFor()).toBeNull();
    expectNoDeleteOverlapDisclosure(rowFor(deletion.host, 'subject-pack'));
  });

  it('P9 sole-declarer corpus renders body grants but no overlap callout', async () => {
    const { host, mount } = setupMount([
      installableBodyGrantEntry('subject-pack', [CONTACT_BODY_GRANT]),
    ]);
    await mount.whenLoaded();

    mount.clickInstall('subject-pack');

    const dialog = dialogFor(host);
    const heading = findByClass(dialog, 'packs-dialog-body-heading');
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toBe(INSTALL_BODY_GRANTS_LABEL);
    expect(installBodyGrantItemsFor(dialog).map((item) => item.textContent))
      .toEqual([CONTACT_BODY_GRANT]);
    expectNoInstallOverlapDisclosure(dialog);
  });

  it('P10 getGrantOverlaps seam returns the expected Map structure', async () => {
    const { mount } = setupMount([
      installableBodyGrantEntry('subject-pack', [
        CONTACT_BODY_GRANT,
        TIMELINE_BODY_GRANT,
      ]),
      installedBodyGrantEntry('pack-b', [CONTACT_BODY_GRANT]),
      installedBodyGrantEntry('pack-a', [TIMELINE_BODY_GRANT]),
    ]);
    await mount.whenLoaded();

    const overlaps = mount.getGrantOverlaps();

    expect([...overlaps.keys()]).toEqual([
      'subject-pack',
      'pack-b',
      'pack-a',
    ]);
    expect(overlaps.get('subject-pack')).toEqual({
      grants: [
        {
          grantKey: CONTACT_BODY_GRANT,
          otherPackSlugs: ['pack-b'],
        },
        {
          grantKey: TIMELINE_BODY_GRANT,
          otherPackSlugs: ['pack-a'],
        },
      ],
      otherPackSlugs: ['pack-a', 'pack-b'],
    });
    expect(overlaps.get('pack-b')).toEqual({
      grants: [],
      otherPackSlugs: [],
    });
    expect(overlaps.get('pack-a')).toEqual({
      grants: [],
      otherPackSlugs: [],
    });
  });

  it('P11 getGrantOverlaps returns empty Map when state is not ready', async () => {
    let resolveList: (value: { packs: ReadonlyArray<PackListEntry> }) => void =
      () => {};
    const loading = setupMount([], {
      runList: () =>
        new Promise<{ packs: ReadonlyArray<PackListEntry> }>((resolve) => {
          resolveList = resolve;
        }),
    });

    expect(loading.mount.getState()).toBe('loading');
    expect(loading.mount.getGrantOverlaps().size).toBe(0);
    resolveList({
      packs: [installedBodyGrantEntry('pack-a', [CONTACT_BODY_GRANT])],
    });
    await loading.mount.whenLoaded();

    const error = setupMount([], {
      runList: async () => {
        throw new Error('boom');
      },
    });
    await error.mount.whenLoaded();

    expect(error.mount.getState()).toBe('error');
    expect(error.mount.getGrantOverlaps().size).toBe(0);
  });

  it('P12 overlap li elements are read-only and carry no event listeners', async () => {
    const install = setupMount([
      installableBodyGrantEntry('subject-pack', [CONTACT_BODY_GRANT]),
      installedBodyGrantEntry('pack-a', [CONTACT_BODY_GRANT]),
    ]);
    await install.mount.whenLoaded();
    install.mount.clickInstall('subject-pack');

    const installItems = dialogOverlapItemsFor(dialogFor(install.host));
    expect(installItems).toHaveLength(1);
    for (const item of installItems) {
      expect(item.tagName).toBe('LI');
      expect(item.children).toEqual([]);
      expect(item.listeners.size).toBe(0);
    }

    const deletion = setupMount([
      installedBodyGrantEntry('subject-pack', [CONTACT_BODY_GRANT]),
      installedBodyGrantEntry('pack-a', [CONTACT_BODY_GRANT]),
    ]);
    await deletion.mount.whenLoaded();
    deletion.mount.clickDelete('subject-pack');

    const deleteItems = deleteOverlapItemsFor(
      rowFor(deletion.host, 'subject-pack'),
    );
    expect(deleteItems).toHaveLength(1);
    for (const item of deleteItems) {
      expect(item.tagName).toBe('LI');
      expect(item.children).toEqual([]);
      expect(item.listeners.size).toBe(0);
    }
  });
});
