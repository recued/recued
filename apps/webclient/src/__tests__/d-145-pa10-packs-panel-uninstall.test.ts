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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PACKS_DIALOG_ATTR,
  PACKS_DIALOG_INSTALL_BTN_ATTR,
  PACKS_PANEL_STYLES,
  PACKS_RETRY_BTN_ATTR,
  PACKS_ROW_DELETE_BTN_ATTR,
  PACKS_ROW_DELETE_CANCEL_BTN_ATTR,
  PACKS_ROW_DELETE_CONFIRM_BTN_ATTR,
  PACKS_ROW_DELETE_ERROR_ATTR,
  PACKS_ROW_DELETE_REMOVES_ATTR,
  PACKS_ROW_INSTALL_BTN_ATTR,
  deleteRemovesText,
  mountPacksPanel,
  type PacksInstallCaller,
  type PacksListCaller,
  type PacksUninstallCaller,
  type PacksUninstallPreviewCaller,
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
  contains(el: FakeElement): boolean;
  focus(): void;
  click(): void;
}

const makeFakeElement = (
  tagName: string,
  onFocus?: (el: FakeElement) => void,
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
    contains: (target) =>
      target === el || children.some((child) => child.contains(target)),
    focus: () => onFocus?.(el),
    click: () => {
      const arr = listeners.get('click') ?? [];
      for (const fn of arr) fn({ target: el });
    },
  };
  return el;
};

interface FakeDocument {
  activeElement: FakeElement | null;
  createElement(tag: string): FakeElement;
}

const makeFakeDocument = (): FakeDocument => {
  const doc: FakeDocument = {
    activeElement: null,
    createElement: (tag) => makeFakeElement(tag, (element) => {
      doc.activeElement = element;
    }),
  };
  return doc;
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
  /** D-304 — the Delete confirmation's "also removes …" seam. */
  runUninstallPreview?: PacksUninstallPreviewCaller;
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
    ...(overrides.runUninstallPreview ? { runUninstallPreview: overrides.runUninstallPreview } : {}),
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

  it('hands a failed post-uninstall refresh to Retry', async () => {
    let listCall = 0;
    const entry = installedEntry();
    const { doc, host, mount } = setupMount([entry], {
      runList: async () => {
        listCall += 1;
        if (listCall === 1) return { packs: [entry] };
        throw new Error('post-uninstall list unavailable');
      },
    });
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    findByAttrValue(
      host,
      PACKS_ROW_DELETE_CONFIRM_BTN_ATTR,
      'test-pack',
    )!.focus();

    await mount.clickConfirmDelete();

    const retry = findByAttr(host, PACKS_RETRY_BTN_ATTR);
    expect(retry).not.toBeNull();
    expect(doc.activeElement).toBe(retry);
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
    expect(errChip!.textContent).toContain('cannot find it');
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
    expect(errChip?.textContent).toContain('has to stay so it can tidy up');
    expect(errChip?.textContent).toContain('no proof that has happened');
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

  it('puts a long uninstall failure on its own contained action row', () => {
    expect(PACKS_PANEL_STYLES).toMatch(
      /\.packs-row-footer\s*\{[^}]*min-width:\s*0[^}]*flex-wrap:\s*wrap[^}]*align-items:\s*flex-start/s,
    );
    expect(PACKS_PANEL_STYLES).toMatch(
      /\.packs-row-footer > \.rx-btn\s*\{[^}]*min-height:\s*40px[^}]*flex:\s*0 0 auto/s,
    );
    expect(PACKS_PANEL_STYLES).toMatch(
      /\.packs-row-delete-error\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*flex:\s*1 1 100%[^}]*overflow-wrap:\s*anywhere/s,
    );
  });

  it('Confirm button stays focusable but aria-disabled while rpc is in flight', async () => {
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
    expect(confirmBtn!.disabled).toBe(false);
    expect(confirmBtn!.getAttribute('aria-disabled')).toBe('true');
    expect(confirmBtn!.getAttribute('aria-busy')).toBe('true');
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

// ══════════════════════════════════════════════════════════════════
// D-304 — the Delete confirmation says what goes with the pack
// ══════════════════════════════════════════════════════════════════

describe('D-304 — the Delete confirmation says what goes with the pack\'s recipes', () => {
  const settle = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
  const removesLine = (host: FakeElement, slug = 'test-pack'): string | null =>
    findByAttrValue(host, PACKS_ROW_DELETE_REMOVES_ATTR, slug)?.textContent ?? null;

  it('⛔ asks the server when the confirmation opens, and names what goes', async () => {
    const asked: string[] = [];
    const { host, mount } = setupMount([installedEntry()], {
      runUninstallPreview: async ({ pack_slug }) => {
        asked.push(pack_slug);
        return { schedules: 2, automations: 1, recipes_with_settings: 3 };
      },
    });
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    await settle();
    expect(asked).toEqual(['test-pack']);
    expect(removesLine(host)).toBe('Also removes 2 schedules, 1 automation and the saved settings of 3 recipes.');
    // It arrives after the confirmation opened, so a screen reader is told.
    expect(findByAttrValue(host, PACKS_ROW_DELETE_REMOVES_ATTR, 'test-pack')?.getAttribute('role')).toBe('status');
  });

  // Found driving a live server: unstyled, the line sat under the pack's name as
  // plain text, reading as the pack's description rather than as what the Delete
  // below it takes. It shares the foundation warning's rule, so the two stay alike.
  it('the line reads as part of the confirmation, styled like the foundation warning', () => {
    expect(PACKS_PANEL_STYLES).toMatch(
      /\.packs-row-delete-foundation-warn,\s*\[[^\]]+\] \.packs-row-delete-removes\s*\{[^}]*background:\s*var\(--warn-bg\)/s,
    );
  });

  it('nothing goes with it, or a server that predates the preview: no line', async () => {
    for (const runUninstallPreview of [
      async () => ({ schedules: 0, automations: 0, recipes_with_settings: 0 }),
      async () => { throw new Error('unknown method'); },
    ] as PacksUninstallPreviewCaller[]) {
      const { host, mount } = setupMount([installedEntry()], { runUninstallPreview });
      await mount.whenLoaded();
      mount.clickDelete('test-pack');
      await settle();
      expect(removesLine(host)).toBeNull();
      expect(mount.getConfirmingDeleteFor()).toBe('test-pack');
    }
  });

  it('the line goes when the confirmation closes', async () => {
    const { host, mount } = setupMount([installedEntry()], {
      runUninstallPreview: async () => ({ schedules: 1, automations: 0, recipes_with_settings: 0 }),
    });
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    await settle();
    expect(removesLine(host)).toBe('Also removes 1 schedule.');
    mount.clickCancelDelete();
    expect(removesLine(host)).toBeNull();
  });

  // ⛔ The render alone already hides an answer that lands after Cancel, so a Cancel
  // test cannot see the guard on the answer. What the guard is FOR: the owner opens
  // Delete on one pack, moves to another and opens Delete there. The first pack's
  // late answer must not replace the second's line (it would blank it, being keyed
  // to a pack no longer confirmed). Mutation R21 survived the Cancel test alone.
  it('⛔ a late answer for a pack the owner moved away from leaves the open confirmation\'s line', async () => {
    type Removes = { schedules: number; automations: number; recipes_with_settings: number };
    const answers = new Map<string, (value: Removes) => void>();
    const other = installedEntry({ manifest: baseManifest({ slug: 'other-pack', name: 'Other Pack' }) });
    const { host, mount } = setupMount([installedEntry(), other], {
      runUninstallPreview: ({ pack_slug }) => new Promise((resolve) => { answers.set(pack_slug, resolve); }),
    });
    await mount.whenLoaded();
    mount.clickDelete('test-pack');
    mount.clickSelectPack('other-pack');
    mount.clickDelete('other-pack');
    expect(mount.getConfirmingDeleteFor()).toBe('other-pack');
    expect([...answers.keys()]).toEqual(['test-pack', 'other-pack']);
    answers.get('other-pack')!({ schedules: 0, automations: 2, recipes_with_settings: 0 });
    await settle();
    expect(removesLine(host, 'other-pack')).toBe('Also removes 2 automations.');
    answers.get('test-pack')!({ schedules: 5, automations: 0, recipes_with_settings: 0 });
    await settle();
    expect(removesLine(host, 'other-pack')).toBe('Also removes 2 automations.');
    expect(removesLine(host, 'test-pack')).toBeNull();
  });

  it('the seam is wired end to end: the rpc, the route, the panel', () => {
    const src = (rel: string): string => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf-8');
    const bootstrap = src('webclient-bootstrap.ts');
    expect(bootstrap).toContain("rpcConn.call('packs.uninstall_preview', args)");
    // Built AND passed on: a built-but-unpassed caller is the classic shape of this bug.
    expect(bootstrap).toMatch(/\{\s*packsUninstallPreviewCaller\s*\}/);
    expect(src('packs/bootstrap-packs-route.ts')).toContain('runUninstallPreview: opts.packsUninstallPreviewCaller');
  });

  it('deleteRemovesText says each part once, in the singular where it is one', () => {
    expect(deleteRemovesText({ schedules: 1, automations: 0, recipes_with_settings: 0 })).toBe('Also removes 1 schedule.');
    expect(deleteRemovesText({ schedules: 0, automations: 2, recipes_with_settings: 1 }))
      .toBe('Also removes 2 automations and the saved settings of 1 recipe.');
    expect(deleteRemovesText({ schedules: 0, automations: 0, recipes_with_settings: 0 })).toBeNull();
  });
});
