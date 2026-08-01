/** D-145 PA10 follow-on — Settings → Packs panel acceptance (Slice A).
 *
 *  Drives `mountPacksPanel` through a fake Document — same pattern as
 *  `d-145-slice1-standing-instructions-panel.test.ts`, narrowed to the
 *  panel's two caller seams (`runList` + `runInstall`) which the test
 *  injects as controllable fakes.
 *
 *  Test catalog:
 *    Construction
 *      - throws when no document is available
 *    Initial load + state machine
 *      - starts loading + paints loading copy
 *      - transitions to ready after runList resolves
 *      - renders empty state when runList returns no packs
 *      - transitions to error when runList rejects + surfaces message
 *      - Retry button re-issues runList
 *    Row rendering
 *      - foundation packs render Foundation badge (accent tone)
 *      - installed packs render Installed badge (ok tone) + no Install button
 *      - foundation + !installed renders Install button (MINOR 7 fold —
 *        boot pre-install failure recovery path)
 *      - non-foundation + !installed renders Install button
 *      - panel without runInstall hides Install button (read-only)
 *      - counts line renders recipe/SI/body-grants when present
 *    Install dialog
 *      - clickInstall opens dialog with manifest details
 *      - dialog renders required permission as checked + disabled
 *      - dialog renders manifest.requires[] permissions as checked
 *      - togglePermission un-toggles a non-required permission
 *      - togglePermission on always-required is no-op
 *      - dialog renders SI rules with scope + condition + action
 *        summaries (MAJOR 3 fold — opaque IDs were not consent UX)
 *      - dialog renders body-content grants when present
 *      - dialog has role='region' + aria-labelledby (MINOR 6 fold)
 *      - Cancel closes dialog + clears permission state
 *      - Single-row invariant — opening pack B closes pack A's dialog
 *      - Install button on rows disabled while a dialog is open
 *    Install rpc
 *      - clickConfirmInstall fires runInstall with manifest + selected
 *        permissions
 *      - successful install closes dialog + refreshes list
 *      - ok:false response with known failure code renders mapped copy
 *      - ok:false response with unknown failure code surfaces raw code
 *        (MINOR 4 fold)
 *      - network error renders in dialog error chip
 *      - re-entrant submit returns the existing in-flight promise
 *    Refresh reconciliation (MAJOR 2 fold)
 *      - refresh closes dialog when pack disappears
 *      - refresh closes dialog when pack becomes installed
 *      - refresh leaves dialog open when pack still present + not installed
 *    Defensive copies (MINOR 5 fold)
 *      - getPacks returns a copy (external splice doesn't affect panel)
 *      - getDialogPermissions returns a copy (external mutation doesn't
 *        affect panel)
 *    Lifecycle
 *      - dispose removes wrapper from host
 *      - dispose is idempotent
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  PACKS_DIALOG_ATTR,
  PACKS_DIALOG_BODY_GRANT_ATTR,
  PACKS_DIALOG_CANCEL_BTN_ATTR,
  PACKS_DIALOG_ERROR_ATTR,
  PACKS_DIALOG_INSTALL_BTN_ATTR,
  PACKS_DIALOG_PERMISSION_ATTR,
  PACKS_DIALOG_OWNER_OPERATION_REVIEW_ATTR,
  PACKS_DIALOG_OWNER_OPERATION_REVIEW_ITEM_ATTR,
  PACKS_DIALOG_RECORDS_REVIEW_ATTR,
  PACKS_DIALOG_RECORDS_REVIEW_CHANGE_ATTR,
  PACKS_DIALOG_RECORDS_REVIEW_DESTRUCTIVE_ATTR,
  PACKS_DIALOG_SLUG_ATTR,
  PACKS_EMPTY_ATTR,
  PACKS_LIST_ERROR_ATTR,
  PACKS_PANEL_ATTR,
  PACKS_PANEL_STATE_ATTR,
  PACKS_RETRY_BTN_ATTR,
  PACKS_ROW_ATTR,
  PACKS_ROW_INSTALL_BTN_ATTR,
  PACKS_ROW_SELECT_ATTR,
  PACKS_ROW_SLUG_ATTR,
  PACKS_DETAIL_BACK_ATTR,
  PACKS_DETAIL_SECTION_ATTR,
  PACKS_SECTION_ATTR,
  PACKS_KIND_GROUP_ATTR,
  mountPacksPanel,
  type PacksInstallCaller,
  type PacksListCaller,
} from '../settings/packs-panel.js';
import type {
  BulkPackInstallResultLike,
  BulkPackManifest,
  PackListEntry,
} from '@recued/contracts';

// ──────────────────────────────────────────────────────────────────
// Fake DOM (mirrors SI panel + Conflicts panel test harness shape)
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

const collectTextContent = (root: FakeElement): string => {
  let out = root.textContent ?? '';
  for (const c of root.children) {
    out += collectTextContent(c);
  }
  return out;
};

/** All descendants (depth-first), for scanning badge classes in the detail. */
const flattenChildren = (root: FakeElement): FakeElement[] => {
  const out: FakeElement[] = [];
  const walk = (n: FakeElement): void => {
    for (const c of n.children) {
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
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

const failInstallResult = (
  code: NonNullable<BulkPackInstallResultLike['failure']>['code'],
  message = 'failure',
): BulkPackInstallResultLike => ({
  ok: false,
  installed: [],
  rolled_back: [],
  failure: { code, message },
});

// ──────────────────────────────────────────────────────────────────
// Setup helper
// ──────────────────────────────────────────────────────────────────

interface SetupOptions {
  runList?: PacksListCaller;
  runInstall?: PacksInstallCaller | null; // null → omit (read-only mode)
  /** Seed the DETAIL selection on mount (else the first pack auto-opens). */
  initialSlug?: string;
  /** Opt out of the first-pack auto-open — for tests that drive selection from a
   *  clean (nothing-selected) state (clickSelectPack / Back seams). */
  noAutoSelect?: boolean;
}

interface SetupResult {
  host: FakeElement;
  doc: FakeDocument;
  mount: ReturnType<typeof mountPacksPanel>;
  listCalls: Array<undefined>;
  installCalls: Array<{
    manifest: unknown;
    granted_permissions: ReadonlyArray<string>;
    expected_manifest_hash?: string;
  }>;
  /** R22 list→detail — every `onSelectSlug` callback value, in order. */
  selectCalls: Array<string | null>;
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
  const selectCalls: Array<string | null> = [];
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
  // dialog / permissions / refresh) reach the same affordances they used to on a
  // list row. Tests drive a specific slug via `overrides.initialSlug`.
  const autoSlug =
    overrides.initialSlug ?? (overrides.noAutoSelect ? undefined : initialPacks[0]?.slug);
  const mount = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList: overrides.runList ?? defaultRunList,
    onSelectSlug: (slug) => selectCalls.push(slug),
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
    selectCalls,
    swapPacks: (next) => {
      currentPacks = next;
    },
  };
};

// ══════════════════════════════════════════════════════════════════
// Construction
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on — mountPacksPanel: construction', () => {
  const originalDoc = (globalThis as { document?: unknown }).document;
  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDoc;
  });

  it('throws when no document is available', () => {
    const host = makeFakeElement('div');
    (globalThis as { document?: unknown }).document = undefined;
    expect(() =>
      mountPacksPanel({
        host: host as unknown as HTMLElement,
        runList: async () => ({ packs: [] }),
      }),
    ).toThrow(/no document available/);
  });
});

// ══════════════════════════════════════════════════════════════════
// Initial load + state machine
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on — initial load + state machine', () => {
  it('starts in loading and renders a status paragraph', () => {
    const { host, mount } = setupMount();
    expect(mount.getState()).toBe('loading');
    const wrapper = findByAttr(host, PACKS_PANEL_ATTR);
    expect(wrapper).not.toBeNull();
    expect(wrapper!.getAttribute(PACKS_PANEL_STATE_ATTR)).toBe('loading');
  });

  it('transitions to ready after runList resolves', async () => {
    const { host, mount, listCalls } = setupMount([baseEntry()]);
    await mount.whenLoaded();
    expect(mount.getState()).toBe('ready');
    expect(listCalls).toHaveLength(1);
    const wrapper = findByAttr(host, PACKS_PANEL_ATTR);
    expect(wrapper!.getAttribute(PACKS_PANEL_STATE_ATTR)).toBe('ready');
    // Auto-selected first pack → its detail renders.
    expect(findByAttr(host, PACKS_DETAIL_SECTION_ATTR)).not.toBeNull();
  });

  it('transitions to error when runList rejects + surfaces the message', async () => {
    const { host, mount } = setupMount([], {
      runList: async () => {
        throw new Error('boom: not_configured');
      },
    });
    await mount.whenLoaded();
    expect(mount.getState()).toBe('error');
    expect(mount.getListError()).toBe('boom: not_configured');
    const errChip = findByAttr(host, PACKS_LIST_ERROR_ATTR);
    expect(errChip).not.toBeNull();
    expect(errChip!.textContent).toBe('boom: not_configured');
    expect(findByAttr(host, PACKS_RETRY_BTN_ATTR)).not.toBeNull();
  });

  it('Retry button re-issues runList', async () => {
    let attempt = 0;
    const { host, mount } = setupMount([], {
      runList: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('first attempt');
        return { packs: [baseEntry()] };
      },
    });
    await mount.whenLoaded();
    expect(mount.getState()).toBe('error');
    mount.clickRetry();
    await mount.whenLoaded();
    expect(mount.getState()).toBe('ready');
    expect(mount.getPacks()).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// Row rendering
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on — row rendering', () => {
  it('foundation packs render Foundation badge with accent tone', async () => {
    const { host, mount } = setupMount([
      baseEntry({
        manifest: baseManifest({ pre_install: true }),
        pre_install: true,
        installed: true,
      }),
    ]);
    await mount.whenLoaded();
    // The badge renders in the detail header (auto-selected pack).
    expect(collectTextContent(host)).toContain('Foundation');
    const accentBadge = findAllByAttr(host, PACKS_DETAIL_SECTION_ATTR)
      .flatMap((s) => flattenChildren(s))
      .find((c) => c.className.includes('rx-badge-accent'));
    expect(accentBadge?.textContent).toBe('Foundation');
  });

  it('installed packs render Installed badge with ok tone + no Install button', async () => {
    const { host, mount } = setupMount([
      baseEntry({ installed: true }),
    ]);
    await mount.whenLoaded();
    const okBadge = flattenChildren(host).find((c) =>
      c.className.includes('rx-badge-ok'),
    );
    expect(okBadge?.textContent).toBe('Installed');
    // Installed → the detail shows Delete, not Install.
    expect(findByAttr(host, PACKS_ROW_INSTALL_BTN_ATTR)).toBeNull();
  });

  it('foundation + !installed renders Install button (boot-fail recovery, MINOR 7 fold)', async () => {
    const { host, mount } = setupMount([
      baseEntry({
        manifest: baseManifest({ pre_install: true }),
        pre_install: true,
        installed: false,
      }),
    ]);
    await mount.whenLoaded();
    expect(findByAttr(host, PACKS_ROW_INSTALL_BTN_ATTR)).not.toBeNull();
  });

  it('non-foundation + !installed renders Install button', async () => {
    const { host, mount } = setupMount([baseEntry()]);
    await mount.whenLoaded();
    expect(findByAttr(host, PACKS_ROW_INSTALL_BTN_ATTR)).not.toBeNull();
  });

  it('panel without runInstall hides Install button (read-only mode)', async () => {
    const { host, mount } = setupMount(
      [baseEntry()],
      { runInstall: null },
    );
    await mount.whenLoaded();
    expect(findAllByAttr(host, PACKS_ROW_INSTALL_BTN_ATTR)).toHaveLength(0);
  });

  it('counts line renders in the DETAIL Declares section (off the slim row — R22.1)', async () => {
    const { host, mount } = setupMount([
      baseEntry({
        manifest: baseManifest({
          recipes: [
            { slug: 'r-1', version: 1 },
            { slug: 'r-2', version: 1 },
          ],
          mcp_body_visibility_grants: [
            'data.contact.engagements.body_content',
          ],
        }),
        recipe_count: 2,
        body_visibility_grant_count: 1,
      }),
    ]);
    await mount.whenLoaded();
    // The detail's Declares section carries the counts (auto-selected pack).
    const declares = findByAttrValue(
      host,
      PACKS_DETAIL_SECTION_ATTR,
      'declares',
    )!;
    const text = collectTextContent(declares);
    expect(text).toContain('2 recipes');
    expect(text).toContain('1 body content');
  });
});

// ══════════════════════════════════════════════════════════════════
// Install dialog
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on — install dialog', () => {
  it('clickInstall opens dialog with manifest details', async () => {
    const { host, mount } = setupMount([baseEntry()]);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    expect(mount.getDialogOpenFor()).toBe('test-pack');
    const dialog = findByAttr(host, PACKS_DIALOG_ATTR);
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute(PACKS_DIALOG_SLUG_ATTR)).toBe('test-pack');
  });

  it('dialog renders required permission as checked + disabled', async () => {
    const { host, mount } = setupMount([
      baseEntry({
        manifest: baseManifest({ requires: ['install_bulk_pack'] }),
        requires: ['install_bulk_pack'],
      }),
    ]);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    const requiredCheckbox = findByAttrValue(
      host,
      PACKS_DIALOG_PERMISSION_ATTR,
      'install_bulk_pack',
    );
    expect(requiredCheckbox).not.toBeNull();
    expect(requiredCheckbox!.checked).toBe(true);
    expect(requiredCheckbox!.disabled).toBe(true);
  });

  it('dialog renders manifest.requires[] permissions as checked', async () => {
    const { host, mount } = setupMount([
      baseEntry({
        manifest: baseManifest({
          requires: ['install_bulk_pack', 'notification_send'],
        }),
        requires: ['install_bulk_pack', 'notification_send'],
      }),
    ]);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    const extraCheckbox = findByAttrValue(
      host,
      PACKS_DIALOG_PERMISSION_ATTR,
      'notification_send',
    );
    expect(extraCheckbox).not.toBeNull();
    expect(extraCheckbox!.checked).toBe(true);
    expect(extraCheckbox!.disabled).toBe(false);
    expect(mount.getDialogPermissions().has('notification_send')).toBe(true);
  });

  it('togglePermission un-toggles a non-required permission', async () => {
    const { mount } = setupMount([
      baseEntry({
        manifest: baseManifest({
          requires: ['install_bulk_pack', 'notification_send'],
        }),
        requires: ['install_bulk_pack', 'notification_send'],
      }),
    ]);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    expect(mount.getDialogPermissions().has('notification_send')).toBe(true);
    const newState = mount.togglePermission('notification_send');
    expect(newState).toBe(false);
    expect(mount.getDialogPermissions().has('notification_send')).toBe(false);
    // toggle back
    const toggledBack = mount.togglePermission('notification_send');
    expect(toggledBack).toBe(true);
    expect(mount.getDialogPermissions().has('notification_send')).toBe(true);
  });

  it('togglePermission on always-required is a no-op (returns true, stays checked)', async () => {
    const { mount } = setupMount([baseEntry()]);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    const result = mount.togglePermission('install_bulk_pack');
    expect(result).toBe(true);
    expect(mount.getDialogPermissions().has('install_bulk_pack')).toBe(true);
  });

  it('dialog renders body-content grants when present (DD#4)', async () => {
    const { host, mount } = setupMount([
      baseEntry({
        manifest: baseManifest({
          mcp_body_visibility_grants: [
            'data.contact.engagements.body_content',
          ],
        }),
        body_visibility_grant_count: 1,
      }),
    ]);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    const grant = findByAttr(host, PACKS_DIALOG_BODY_GRANT_ATTR);
    expect(grant).not.toBeNull();
    expect(grant!.textContent).toBe(
      'data.contact.engagements.body_content',
    );
  });

  it('dialog has role=region + aria-labelledby (MINOR 6 fold)', async () => {
    const { host, mount } = setupMount([baseEntry()]);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    const dialog = findByAttr(host, PACKS_DIALOG_ATTR);
    expect(dialog!.getAttribute('role')).toBe('region');
    const labelledby = dialog!.getAttribute('aria-labelledby');
    expect(labelledby).toBe('packs-dialog-heading-test-pack');
    // The heading carries the matching id
    const heading = dialog!.children.find((c) => c.id === labelledby);
    expect(heading).not.toBeUndefined();
    const dialogCopy = collectTextContent(dialog!);
    expect(dialogCopy).toContain('Pack setup');
    expect(dialogCopy).toContain(
      'Review what this pack adds, then choose any connection and access it should receive.',
    );
  });

  it('renders changed and removed global owner rulings before update acceptance', async () => {
    const { host, mount } = setupMount([
      baseEntry({
        installed: false,
        installed_any_version: true,
        owner_operation_review: [
          {
            ingredient_id: 'recued-core/acme',
            operation_id: 'recued-core/acme.deal.create',
            change: 'changed',
            owner_policy: { risk: 'admin', approval: 'always' },
            incoming: { risk: 'write', approval: 'ask' },
          },
          {
            ingredient_id: 'recued-core/acme',
            operation_id: 'recued-core/acme.deal.archive',
            change: 'removed',
            owner_policy: { approval: 'always' },
          },
        ],
      }),
    ]);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');

    const review = findByAttr(host, PACKS_DIALOG_OWNER_OPERATION_REVIEW_ATTR);
    expect(review).not.toBeNull();
    expect(review!.getAttribute('role')).toBe('region');
    const rows = findAllByAttr(
      review!,
      PACKS_DIALOG_OWNER_OPERATION_REVIEW_ITEM_ATTR,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute('data-change'))).toEqual([
      'changed',
      'removed',
    ]);
    const copy = collectTextContent(review!);
    expect(copy).toContain('Global operation rulings to review');
    expect(copy).toContain('Owner risk: admin');
    expect(copy).toContain('Pack approval: ask');
    expect(copy).toContain('Removed operations keep their ruling stored but inactive');
    expect(findByAttr(host, PACKS_DIALOG_INSTALL_BTN_ATTR)?.textContent).toBe('Update');
  });

  it('renders and echoes the exact Records transition review', async () => {
    const reviewHash = 'a'.repeat(64);
    const { host, mount, installCalls } = setupMount([
      baseEntry({
        installed: false,
        installed_any_version: true,
        manifest_review_hash: reviewHash,
        records_review: {
          owner: { publisher: 'recued-core', pack_slug: 'test-pack' },
          current_state: 'ready',
          current_version: 2,
          target_version: 3,
          current_storage_schema_hash: 'old-schema',
          target_storage_schema_hash: 'new-schema',
          row_counts: [{ kind: 'job', rows: 12, payload_bytes: 4096 }],
          estimated_rows: 12,
          schema_changes: [{
            entity: 'job',
            field: 'legacy_note',
            change: 'field_removed',
            current: '{"slot":"t1"}',
            destructive: true,
          }],
          destructive_changes: [{
            edge: '2->3',
            kind: 'job',
            step_id: 'clear-legacy-note',
            operation: 'clear',
            from: 'legacy_note',
          }],
          quota: {
            row_count: 12,
            payload_bytes: 4096,
            row_limit: 1000,
            byte_limit: 1_000_000,
            outbox_count: 2,
            outbox_limit: 100,
            data_generation: 14,
          },
          global_quota: {
            row_count: 25,
            payload_bytes: 8192,
            outbox_count: 3,
            reserved_payload_bytes: 1024,
            row_limit: 10_000,
            byte_limit: 10_000_000,
            outbox_limit: 1000,
          },
          retention: { job: { mode: 'expire_after_days', days: 90 } },
          export_checkpoint_available: true,
          export_recommended: true,
          active_executions: 1,
          unacknowledged_events: 2,
          pending_event_disposition: 'drain_or_explicit_retire',
          temporary_unavailability: true,
          resumable: true,
          reverse_route_exists: false,
        },
      }),
    ]);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');

    const review = findByAttr(host, PACKS_DIALOG_RECORDS_REVIEW_ATTR);
    expect(review).not.toBeNull();
    expect(collectTextContent(review!)).toContain('Version 2 → 3');
    expect(collectTextContent(review!)).toContain('12 rows');
    expect(collectTextContent(review!)).toContain('Potentially destructive migration mappings');
    expect(collectTextContent(review!)).toContain('2 unacknowledged events');
    expect(findAllByAttr(review!, PACKS_DIALOG_RECORDS_REVIEW_CHANGE_ATTR)).toHaveLength(1);
    expect(findAllByAttr(review!, PACKS_DIALOG_RECORDS_REVIEW_DESTRUCTIVE_ATTR)).toHaveLength(1);

    await mount.clickConfirmInstall();
    expect(installCalls[0]?.expected_manifest_hash).toBe(reviewHash);
  });

  it('Cancel closes the dialog + clears permission state', async () => {
    const { host, mount } = setupMount([
      baseEntry({
        manifest: baseManifest({
          requires: ['install_bulk_pack', 'notification_send'],
        }),
        requires: ['install_bulk_pack', 'notification_send'],
      }),
    ]);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    mount.togglePermission('notification_send'); // uncheck
    expect(mount.getDialogPermissions().has('notification_send')).toBe(false);
    mount.clickCancelDialog();
    expect(mount.getDialogOpenFor()).toBeNull();
    expect(findByAttr(host, PACKS_DIALOG_ATTR)).toBeNull();
    // Re-open: permissions reset to default-checked
    mount.clickInstall('test-pack');
    expect(mount.getDialogPermissions().has('notification_send')).toBe(true);
  });

  it('navigating to another pack collapses an open install dialog', async () => {
    // The list-era "single dialog across rows" invariant is now structural —
    // only the selected pack's detail (+ its one dialog) renders. What remains
    // testable: navigating away collapses the open dialog.
    const { host, mount } = setupMount([
      baseEntry({ manifest: baseManifest({ slug: 'pack-a' }), slug: 'pack-a' }),
      baseEntry({ manifest: baseManifest({ slug: 'pack-b' }), slug: 'pack-b' }),
    ], { initialSlug: 'pack-a' });
    await mount.whenLoaded();
    mount.clickInstall('pack-a');
    expect(mount.getDialogOpenFor()).toBe('pack-a');
    mount.clickSelectPack('pack-b');
    expect(mount.getDialogOpenFor()).toBeNull();
    expect(findAllByAttr(host, PACKS_DIALOG_ATTR)).toHaveLength(0);
  });

  it('Install row buttons are disabled while a dialog is open', async () => {
    const { host, mount } = setupMount([
      baseEntry({ manifest: baseManifest({ slug: 'pack-a' }), slug: 'pack-a' }),
      baseEntry({ manifest: baseManifest({ slug: 'pack-b' }), slug: 'pack-b' }),
    ]);
    await mount.whenLoaded();
    mount.clickInstall('pack-a');
    const installButtons = findAllByAttr(host, PACKS_ROW_INSTALL_BTN_ATTR);
    // Both row Install buttons disabled while pack-a dialog open
    for (const btn of installButtons) {
      expect(btn.disabled).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// Install rpc
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on — install rpc', () => {
  it('clickConfirmInstall fires runInstall with manifest + selected permissions', async () => {
    const { mount, installCalls } = setupMount([
      baseEntry({
        manifest: baseManifest({
          requires: ['install_bulk_pack', 'notification_send'],
        }),
        requires: ['install_bulk_pack', 'notification_send'],
      }),
    ]);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    await mount.clickConfirmInstall();
    expect(installCalls).toHaveLength(1);
    const call = installCalls[0]!;
    expect((call.manifest as BulkPackManifest).slug).toBe('test-pack');
    // ALWAYS_REQUIRED_PERMISSION always present
    expect([...call.granted_permissions].sort()).toEqual([
      'install_bulk_pack',
      'notification_send',
    ]);
  });

  it('successful install closes dialog + refreshes list', async () => {
    const swap = setupMount([baseEntry()]);
    await swap.mount.whenLoaded();
    expect(swap.listCalls).toHaveLength(1);
    swap.mount.clickInstall('test-pack');
    // After install, simulate that the server now reports the pack
    // installed.
    swap.swapPacks([baseEntry({ installed: true })]);
    await swap.mount.clickConfirmInstall();
    expect(swap.mount.getDialogOpenFor()).toBeNull();
    // Refresh ran (list called a 2nd time)
    expect(swap.listCalls).toHaveLength(2);
    expect(swap.mount.getPacks()[0]!.installed).toBe(true);
  });

  it('ok:false with known failure code renders mapped copy', async () => {
    const { mount } = setupMount([baseEntry()], {
      runInstall: async () => ({
        result: failInstallResult('permission_denied', 'missing'),
      }),
    });
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    await mount.clickConfirmInstall();
    expect(mount.getDialogError()).toContain('required permission was not granted');
    // Dialog stays open
    expect(mount.getDialogOpenFor()).toBe('test-pack');
  });

  it('ok:false with unknown failure code surfaces raw code (MINOR 4 fold)', async () => {
    const { mount } = setupMount([baseEntry()], {
      runInstall: async () =>
        ({
          result: {
            ok: false,
            installed: [],
            rolled_back: [],
            failure: { code: 'new_code_v2' as never, message: 'm' },
          },
        }) as { result: BulkPackInstallResultLike },
    });
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    await mount.clickConfirmInstall();
    expect(mount.getDialogError()).toBe('Install rejected: new_code_v2.');
  });

  it('network error renders in dialog error chip', async () => {
    const { host, mount } = setupMount([baseEntry()], {
      runInstall: async () => {
        throw new Error('network down');
      },
    });
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    await mount.clickConfirmInstall();
    expect(mount.getDialogError()).toBe('network down');
    const errChip = findByAttr(host, PACKS_DIALOG_ERROR_ATTR);
    expect(errChip).not.toBeNull();
    expect(errChip!.textContent).toBe('network down');
    expect(mount.getDialogOpenFor()).toBe('test-pack');
  });

  it('re-entrant submit returns the existing in-flight promise', async () => {
    let resolveInstall: ((v: { result: BulkPackInstallResultLike }) => void)
      | null = null;
    const installCalls: Array<{
      manifest: unknown;
      granted_permissions: ReadonlyArray<string>;
    }> = [];
    const { mount } = setupMount([baseEntry()], {
      runInstall: (args) => {
        installCalls.push(args);
        return new Promise<{ result: BulkPackInstallResultLike }>((res) => {
          resolveInstall = res;
        });
      },
    });
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    const first = mount.clickConfirmInstall();
    const second = mount.clickConfirmInstall();
    // Both calls await the same in-flight rpc; the rpc is called once
    expect(installCalls).toHaveLength(1);
    expect(mount.isInstalling()).toBe(true);
    resolveInstall!({ result: okInstallResult() });
    await first;
    await second;
    expect(mount.isInstalling()).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// Refresh reconciliation (MAJOR 2 fold)
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on — refresh reconciliation (MAJOR 2 fold)', () => {
  it('refresh closes dialog when pack disappears', async () => {
    const swap = setupMount([baseEntry()]);
    await swap.mount.whenLoaded();
    swap.mount.clickInstall('test-pack');
    expect(swap.mount.getDialogOpenFor()).toBe('test-pack');
    swap.swapPacks([]);
    swap.mount.refresh();
    await swap.mount.whenLoaded();
    expect(swap.mount.getDialogOpenFor()).toBeNull();
  });

  it('refresh closes dialog when pack becomes installed', async () => {
    const swap = setupMount([baseEntry()]);
    await swap.mount.whenLoaded();
    swap.mount.clickInstall('test-pack');
    expect(swap.mount.getDialogOpenFor()).toBe('test-pack');
    swap.swapPacks([baseEntry({ installed: true })]);
    swap.mount.refresh();
    await swap.mount.whenLoaded();
    expect(swap.mount.getDialogOpenFor()).toBeNull();
  });

  it('refresh leaves dialog open when pack still present + not installed', async () => {
    const swap = setupMount([baseEntry()]);
    await swap.mount.whenLoaded();
    swap.mount.clickInstall('test-pack');
    // Same pack in the next refresh, still not installed
    swap.swapPacks([baseEntry()]);
    swap.mount.refresh();
    await swap.mount.whenLoaded();
    expect(swap.mount.getDialogOpenFor()).toBe('test-pack');
  });
});

// ══════════════════════════════════════════════════════════════════
// Defensive copies (MINOR 5 fold)
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on — defensive copies (MINOR 5 fold)', () => {
  it('getPacks returns a copy (external splice does not affect panel)', async () => {
    const { mount } = setupMount([baseEntry()]);
    await mount.whenLoaded();
    const copy = mount.getPacks() as PackListEntry[];
    expect(copy).toHaveLength(1);
    copy.length = 0;
    expect(mount.getPacks()).toHaveLength(1);
  });

  it('getDialogPermissions returns a copy (mutation does not affect panel)', async () => {
    const { mount } = setupMount([baseEntry()]);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    const copy = mount.getDialogPermissions() as Set<string>;
    expect(copy.has('install_bulk_pack')).toBe(true);
    copy.delete('install_bulk_pack');
    // Internal state preserved
    expect(mount.getDialogPermissions().has('install_bulk_pack')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// Lifecycle
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on — lifecycle', () => {
  it('dispose removes wrapper from host', async () => {
    const { host, mount } = setupMount([baseEntry()]);
    await mount.whenLoaded();
    expect(findByAttr(host, PACKS_PANEL_ATTR)).not.toBeNull();
    mount.dispose();
    expect(findByAttr(host, PACKS_PANEL_ATTR)).toBeNull();
  });

  it('dispose is idempotent', async () => {
    const { mount } = setupMount([baseEntry()]);
    await mount.whenLoaded();
    mount.dispose();
    expect(() => mount.dispose()).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════
// Packs R22 — list → detail view (routing backbone, slice R1.1)
// ══════════════════════════════════════════════════════════════════

describe('Packs — detail selection seams (driven by the surface)', () => {
  const twoPacks = [
    baseEntry({ manifest: baseManifest({ slug: 'pack-a', name: 'Pack A' }) }),
    baseEntry({ manifest: baseManifest({ slug: 'pack-b', name: 'Pack B' }) }),
  ];

  it('clickSelectPack opens the DETAIL for that pack + fires onSelectSlug', async () => {
    const { host, mount, selectCalls } = setupMount(twoPacks, { noAutoSelect: true });
    await mount.whenLoaded();
    mount.clickSelectPack('pack-b');
    expect(mount.getSelectedSlug()).toBe('pack-b');
    expect(selectCalls).toEqual(['pack-b']);
    expect(findByAttr(host, PACKS_DETAIL_BACK_ATTR)).not.toBeNull();
    const identity = findByAttrValue(host, PACKS_DETAIL_SECTION_ATTR, 'identity')!;
    expect(collectTextContent(identity)).toContain('pack-b');
  });

  it('clickBackToList clears the selection + fires onSelectSlug(null)', async () => {
    const { host, mount, selectCalls } = setupMount(twoPacks, { noAutoSelect: true });
    await mount.whenLoaded();
    mount.clickSelectPack('pack-a');
    mount.clickBackToList();
    expect(mount.getSelectedSlug()).toBeNull();
    expect(selectCalls).toEqual(['pack-a', null]);
    // Nothing rendered with no selection — the surface shows the browse list.
    expect(findByAttr(host, PACKS_DETAIL_BACK_ATTR)).toBeNull();
    expect(findByAttr(host, PACKS_DETAIL_SECTION_ATTR)).toBeNull();
  });

  it('the detail Back button clears the selection (event path)', async () => {
    const { host, mount } = setupMount(twoPacks, { initialSlug: 'pack-a' });
    await mount.whenLoaded();
    findByAttr(host, PACKS_DETAIL_BACK_ATTR)!.click();
    expect(mount.getSelectedSlug()).toBeNull();
  });

  it('initialSlug opens the DETAIL view on mount', async () => {
    const { host, mount } = setupMount(twoPacks, { initialSlug: 'pack-b' });
    await mount.whenLoaded();
    expect(mount.getSelectedSlug()).toBe('pack-b');
    const identity = findByAttrValue(host, PACKS_DETAIL_SECTION_ATTR, 'identity')!;
    expect(collectTextContent(identity)).toContain('pack-b');
  });

  it('install works from the DETAIL view (Install → dialog)', async () => {
    const { host, mount } = setupMount(twoPacks, { initialSlug: 'pack-a' });
    await mount.whenLoaded();
    mount.clickInstall('pack-a');
    expect(mount.getDialogOpenFor()).toBe('pack-a');
    expect(findByAttr(host, PACKS_DIALOG_ATTR)).not.toBeNull();
  });
});
