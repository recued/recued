/** D-145 PA10 follow-on Slice B — Settings → Packs panel uninstall.
 *
 *  Drives `mountPacksPanel` through the same fake-DOM harness as the
 *  Slice A test (`d-145-pa10-packs-panel.test.ts`); narrowed to the
 *  Delete affordance + two-stage confirm strip + the `runUninstall` rpc
 *  seam.
 *
 *  ── Detail-only migration ──────────────────────────────────────────
 *  `mountPacksPanel` is now the `#packs/<slug>` DETAIL only (the browse
 *  list moved to the surface). `setupMount` auto-opens the first pack's
 *  detail so the shared seams reach it. The multi-row cross-affordance
 *  tests + the single-row (DD#9) invariant were DROPPED — they need two
 *  rows rendered at once, which the one-pack detail cannot do.
 *
 *  Test catalog:
 *    Delete affordance visibility
 *      - hidden when runUninstall caller is absent (panel renders
 *        list + install only)
 *      - hidden on non-installed rows (Install surfaces instead)
 *      - hidden on foundation packs (`pre_install: true`) — DD#11
 *      - visible on installed non-foundation rows when runUninstall
 *        present
 *    Delete two-stage confirm
 *      - click Delete opens confirm strip + getConfirmingDeleteFor
 *        reflects state
 *      - confirm strip renders [Confirm delete] [Cancel] buttons +
 *        hides the default Delete button
 *      - click Cancel closes the strip + clears state
 *    Uninstall rpc
 *      - clickConfirmDelete fires runUninstall with pack_slug
 *      - successful uninstall closes strip + refreshes list
 *      - ok:false response with known failure code renders mapped copy
 *      - ok:false response with unknown failure code surfaces raw code
 *        (defensive fallback for server version skew)
 *      - network error renders in inline strip error chip
 *      - re-entrant submit returns the existing in-flight promise
 *    Refresh reconciliation
 *      - refresh closes Delete strip when pack disappears
 *      - refresh closes Delete strip when pack becomes uninstalled
 *      - refresh leaves Delete strip open when pack still installed
 *    Lifecycle
 *      - dispose during in-flight uninstall resolves cleanly
 *
 *  Reuses the fake-DOM + setup helpers from `d-145-pa10-packs-panel.test.ts`
 *  locally (copied rather than imported, mirroring the Slice 1 / Slice
 *  1.5 split for SI panel tests — keeps test files self-contained). */

import { describe, expect, it } from 'vitest';

import {
  PACKS_DIALOG_ATTR,
  PACKS_DIALOG_INSTALL_BTN_ATTR,
  PACKS_ROW_DELETE_BTN_ATTR,
  PACKS_ROW_DELETE_CANCEL_BTN_ATTR,
  PACKS_ROW_DELETE_CONFIRM_BTN_ATTR,
  PACKS_ROW_DELETE_ERROR_ATTR,
  PACKS_ROW_INSTALL_BTN_ATTR,
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

const okUninstallResult = (): BulkPackUninstallResultLike => ({
  ok: true,
  removed: {
    recipes: ['recipe-a'],
    body_grants: [],
  },
});

const failUninstallResult = (
  code: NonNullable<BulkPackUninstallResultLike['failure']>['code'],
  message = 'failure',
): BulkPackUninstallResultLike => ({
  ok: false,
  removed: { recipes: [], body_grants: [] },
  failure: { code, message },
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
  runInstall?: PacksInstallCaller | null; // null → omit
  runUninstall?: PacksUninstallCaller | null; // null → omit
  /** Seed the DETAIL selection on mount. The panel is now the
   *  `#packs/<slug>` detail only, so the shared-machinery seams act on the
   *  selected pack. Defaults to the first pack in `initialPacks`. */
  initialSlug?: string;
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

  // The panel is now the DETAIL only (the browse list moved to the surface).
  // Auto-open the first pack's detail so the shared-machinery seams
  // (clickDelete / confirm strip / clickInstall / refresh) reach the same
  // affordances they used to on a list row. Tests drive a specific slug via
  // `overrides.initialSlug`.
  const autoSlug = overrides.initialSlug ?? initialPacks[0]?.slug;
  const mount = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList: overrides.runList ?? defaultRunList,
    ...(autoSlug !== undefined ? { initialSlug: autoSlug } : {}),
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

// ══════════════════════════════════════════════════════════════════
// Delete affordance visibility
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on Slice B — Delete affordance visibility', () => {
  it('Delete button hidden when runUninstall caller is absent', async () => {
    const { host, mount } = setupMount([installedEntry()], {
      runUninstall: null,
    });
    await mount.whenLoaded();
    expect(findByAttr(host, PACKS_ROW_DELETE_BTN_ATTR)).toBeNull();
  });

  it('Delete button hidden on non-installed packs (Install surfaces instead)', async () => {
    const { host, mount } = setupMount([baseEntry({ installed: false })]);
    await mount.whenLoaded();
    expect(findByAttr(host, PACKS_ROW_DELETE_BTN_ATTR)).toBeNull();
    // Install button surfaces on the same row instead.
    expect(findByAttr(host, PACKS_ROW_INSTALL_BTN_ATTR)).not.toBeNull();
  });

  it('Delete button visible on foundation packs — Delta 6 (warning-on-confirm replaces the reveal toggle)', async () => {
    const { host, mount } = setupMount([
      installedEntry({
        slug: 'foundation-pack',
        manifest: baseManifest({ slug: 'foundation-pack', pre_install: true }),
        pre_install: true,
      }),
    ]);
    await mount.whenLoaded();
    expect(findByAttr(host, PACKS_ROW_DELETE_BTN_ATTR)).not.toBeNull();
  });

  it('Delete button visible on installed non-foundation packs', async () => {
    const { host, mount } = setupMount([installedEntry()]);
    await mount.whenLoaded();
    const btn = findByAttrValue(
      host,
      PACKS_ROW_DELETE_BTN_ATTR,
      'test-pack',
    );
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Delete');
  });
});

// ══════════════════════════════════════════════════════════════════
// Two-stage confirm strip
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on Slice B — two-stage confirm', () => {
  it('click Delete opens the confirm strip + state reflects the open row', async () => {
    const { host, mount } = setupMount([installedEntry()]);
    await mount.whenLoaded();
    expect(mount.getConfirmingDeleteFor()).toBeNull();
    mount.clickDelete('test-pack');
    expect(mount.getConfirmingDeleteFor()).toBe('test-pack');
    // Default Delete button removed; Confirm + Cancel appear in its
    // place.
    expect(findByAttr(host, PACKS_ROW_DELETE_BTN_ATTR)).toBeNull();
    expect(
      findByAttrValue(host, PACKS_ROW_DELETE_CONFIRM_BTN_ATTR, 'test-pack'),
    ).not.toBeNull();
    expect(
      findByAttrValue(host, PACKS_ROW_DELETE_CANCEL_BTN_ATTR, 'test-pack'),
    ).not.toBeNull();
  });

  it('Confirm button uses outlined-danger primitive (rx-btn-danger)', async () => {
    const { host, mount } = setupMount([installedEntry()]);
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    const confirmBtn = findByAttrValue(
      host,
      PACKS_ROW_DELETE_CONFIRM_BTN_ATTR,
      'test-pack',
    );
    expect(confirmBtn!.className).toContain('rx-btn-danger');
  });

  it('click Cancel closes the strip + clears state', async () => {
    const { host, mount } = setupMount([installedEntry()]);
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    expect(mount.getConfirmingDeleteFor()).toBe('test-pack');
    mount.clickCancelDelete();
    expect(mount.getConfirmingDeleteFor()).toBeNull();
    // Default Delete button restored.
    expect(findByAttr(host, PACKS_ROW_DELETE_BTN_ATTR)).not.toBeNull();
  });

  it('openDeleteConfirm refuses on non-installed pack (defensive)', async () => {
    const { mount } = setupMount([baseEntry({ installed: false })]);
    await mount.whenLoaded();
    // The renderer hides the Delete button on non-installed rows, but
    // a programmatic test caller could drive openDelete; the gate
    // refuses with no state change.
    mount.clickDelete('test-pack');
    expect(mount.getConfirmingDeleteFor()).toBeNull();
  });

  it('openDeleteConfirm arms on a foundation pack directly (Delta 6)', async () => {
    const { mount } = setupMount([
      installedEntry({
        slug: 'foundation-pack',
        manifest: baseManifest({ slug: 'foundation-pack', pre_install: true }),
        pre_install: true,
      }),
    ]);
    await mount.whenLoaded();
    mount.clickDelete('foundation-pack');
    expect(mount.getConfirmingDeleteFor()).toBe('foundation-pack');
  });
});

// ══════════════════════════════════════════════════════════════════
// Uninstall rpc
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on Slice B — uninstall rpc', () => {
  it('clickConfirmDelete fires runUninstall with pack_slug', async () => {
    const { mount, uninstallCalls } = setupMount([installedEntry()]);
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    await mount.clickConfirmDelete();
    expect(uninstallCalls).toHaveLength(1);
    expect(uninstallCalls[0]).toEqual({ pack_slug: 'test-pack' });
  });

  it('successful uninstall closes strip + refreshes list', async () => {
    // Custom runList tracks call count + flips `installed` between
    // calls (simulating server state after the uninstall lands). Use
    // explicit listCalls counter because the test's custom runList
    // overrides `setupMount`'s default that tracks via closure.
    let installed = true;
    const localListCalls: number[] = [];
    const { mount } = setupMount([], {
      initialSlug: 'test-pack',
      runList: async () => {
        localListCalls.push(Date.now());
        return { packs: [installedEntry({ installed })] };
      },
      runUninstall: async () => {
        installed = false; // server-side state flip
        return { result: okUninstallResult() };
      },
    });
    await mount.whenLoaded();
    expect(localListCalls).toHaveLength(1);
    mount.clickDelete('test-pack');
    await mount.clickConfirmDelete();
    // Strip closed.
    expect(mount.getConfirmingDeleteFor()).toBeNull();
    // List refreshed — a second runList call landed (DD#12).
    expect(localListCalls.length).toBeGreaterThanOrEqual(2);
    // Pack now shows as non-installed.
    const pack = mount.getPacks().find((p) => p.slug === 'test-pack');
    expect(pack!.installed).toBe(false);
  });

  it('ok=false response with known failure code renders mapped copy', async () => {
    const { host, mount } = setupMount([installedEntry()], {
      runUninstall: async () => ({
        result: failUninstallResult('not_found', 'server says no'),
      }),
    });
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    await mount.clickConfirmDelete();
    expect(mount.getConfirmingDeleteFor()).toBe('test-pack');
    const errChip = findByAttr(host, PACKS_ROW_DELETE_ERROR_ATTR);
    expect(errChip).not.toBeNull();
    expect(errChip!.textContent).toContain('could not find');
  });

  it('explains that operation-bound cleanup authority prevents uninstall', async () => {
    const { host, mount } = setupMount([installedEntry()], {
      runUninstall: async () => ({
        result: failUninstallResult(
          'webhook_cleanup_required',
          'binding retained',
        ),
      }),
    });
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    await mount.clickConfirmDelete();
    const errChip = findByAttr(host, PACKS_ROW_DELETE_ERROR_ATTR);
    expect(errChip?.textContent).toContain('must remain installed');
    expect(errChip?.textContent).toContain('no cleanup-completion proof');
  });

  it('ok=false with unknown failure code surfaces raw code (server version skew)', async () => {
    const { host, mount } = setupMount([installedEntry()], {
      runUninstall: async () =>
        ({
          result: {
            ok: false,
            removed: { recipes: [], standing_instructions: 0, body_grants: [] },
            failure: {
              code: 'future_code' as unknown as 'not_found',
              message: 'from the future',
            },
          },
        }) as unknown as { result: BulkPackUninstallResultLike },
    });
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    await mount.clickConfirmDelete();
    const errChip = findByAttr(host, PACKS_ROW_DELETE_ERROR_ATTR);
    expect(errChip).not.toBeNull();
    // Defensive fallback: surface the raw code rather than rendering
    // undefined from a missing map entry.
    expect(errChip!.textContent).toContain('future_code');
  });

  it('rpc rejection renders in the inline error chip', async () => {
    const { host, mount } = setupMount([installedEntry()], {
      runUninstall: async () => {
        throw new Error('socket exploded');
      },
    });
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    await mount.clickConfirmDelete();
    expect(mount.getConfirmingDeleteFor()).toBe('test-pack');
    const errChip = findByAttr(host, PACKS_ROW_DELETE_ERROR_ATTR);
    expect(errChip).not.toBeNull();
    expect(errChip!.textContent).toContain('socket exploded');
  });

  it('Confirm button shows "Deleting…" + disabled while rpc in flight', async () => {
    let resolveRpc: (v: { result: BulkPackUninstallResultLike }) => void = () => {};
    const { host, mount } = setupMount([installedEntry()], {
      runUninstall: () =>
        new Promise((resolve) => {
          resolveRpc = resolve;
        }),
    });
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    // Kick off (don't await) — promise is in flight.
    const pending = mount.clickConfirmDelete();
    expect(mount.isDeleting()).toBe(true);
    const confirmBtn = findByAttrValue(
      host,
      PACKS_ROW_DELETE_CONFIRM_BTN_ATTR,
      'test-pack',
    );
    expect(confirmBtn!.textContent).toBe('Deleting…');
    expect(confirmBtn!.disabled).toBe(true);
    // Resolve the rpc + drain.
    resolveRpc({ result: okUninstallResult() });
    await pending;
    expect(mount.isDeleting()).toBe(false);
  });

  it('re-entrant submit returns the existing in-flight promise', async () => {
    let resolveRpc: (v: { result: BulkPackUninstallResultLike }) => void = () => {};
    let rpcCallCount = 0;
    const { mount } = setupMount([installedEntry()], {
      runUninstall: () => {
        rpcCallCount += 1;
        return new Promise((resolve) => {
          resolveRpc = resolve;
        });
      },
    });
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    const first = mount.clickConfirmDelete();
    const second = mount.clickConfirmDelete();
    // Both await the same in-flight rpc — only one network call.
    expect(rpcCallCount).toBe(1);
    resolveRpc({ result: okUninstallResult() });
    await Promise.all([first, second]);
  });
});

// ══════════════════════════════════════════════════════════════════
// Refresh reconciliation
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on Slice B — refresh reconciliation', () => {
  it('refresh closes Delete strip when pack disappears', async () => {
    const { mount, swapPacks } = setupMount([installedEntry()]);
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    expect(mount.getConfirmingDeleteFor()).toBe('test-pack');
    swapPacks([]); // server removed the pack
    mount.refresh();
    await mount.whenLoaded();
    expect(mount.getConfirmingDeleteFor()).toBeNull();
  });

  it('refresh closes Delete strip when pack becomes uninstalled', async () => {
    const { mount, swapPacks } = setupMount([installedEntry()]);
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    expect(mount.getConfirmingDeleteFor()).toBe('test-pack');
    // Concurrent uninstall from another tab — pack is still listed
    // but installed flag flipped to false.
    swapPacks([baseEntry({ installed: false })]);
    mount.refresh();
    await mount.whenLoaded();
    expect(mount.getConfirmingDeleteFor()).toBeNull();
  });

  it('refresh leaves Delete strip open when pack still installed', async () => {
    const { mount, swapPacks } = setupMount([installedEntry()]);
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    swapPacks([installedEntry()]); // no change
    mount.refresh();
    await mount.whenLoaded();
    expect(mount.getConfirmingDeleteFor()).toBe('test-pack');
  });
});

// ══════════════════════════════════════════════════════════════════
// Lifecycle
// ══════════════════════════════════════════════════════════════════

describe('D-145 PA10 follow-on Slice B — lifecycle', () => {
  it('dispose during in-flight uninstall resolves without throwing', async () => {
    let resolveRpc: (v: { result: BulkPackUninstallResultLike }) => void = () => {};
    const { mount } = setupMount([installedEntry()], {
      runUninstall: () =>
        new Promise((resolve) => {
          resolveRpc = resolve;
        }),
    });
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    const pending = mount.clickConfirmDelete();
    mount.dispose();
    resolveRpc({ result: okUninstallResult() });
    // Must not throw.
    await expect(pending).resolves.toBeUndefined();
  });

  it('dispose is idempotent (mirrors Slice A)', async () => {
    const { mount } = setupMount([installedEntry()]);
    await mount.whenLoaded();
    mount.dispose();
    expect(() => mount.dispose()).not.toThrow();
  });

  it('uses ARIA region semantics on the install dialog (unchanged by Slice B)', async () => {
    // Sanity that Slice B's edits to renderRow did not break Slice A's
    // existing dialog accessibility invariants. The dialog still
    // carries role='region' + aria-labelledby per Slice A MINOR 6.
    const { host, mount } = setupMount([baseEntry({ installed: false })]);
    await mount.whenLoaded();
    mount.clickInstall('test-pack');
    const dialog = findByAttr(host, PACKS_DIALOG_ATTR);
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('role')).toBe('region');
    expect(dialog!.getAttribute('aria-labelledby')).toMatch(
      /packs-dialog-heading-test-pack/,
    );
    // Install button still in the dialog.
    expect(findByAttr(host, PACKS_DIALOG_INSTALL_BTN_ATTR)).not.toBeNull();
  });
});
