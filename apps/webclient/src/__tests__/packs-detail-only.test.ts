/** Unified `#packs` surface — the packs panel (`settings/packs-panel.ts`), which
 *  is now the `#packs/<slug>` DETAIL only. Covers the genuinely new behavior the
 *  surface leans on:
 *   - a roster slug renders its detail directly (no resolve);
 *   - a marketplace slug ABSENT from `packs[]` is resolved via `runResolvePack`,
 *     projected, and rendered at full fidelity;
 *   - a resolve failure shows an error + retry;
 *   - install routes through `runInstallBySlug` (the by-slug path) and the detail
 *     flips Install→Uninstall from `installed_versions` (a marketplace pack never
 *     lands in `packs[]`), without a wrong re-resolve;
 *   - detail-only never paints the list / Add-a-pack sections.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  PACKS_DIALOG_INSTALL_BTN_ATTR,
  PACKS_DIALOG_OWNER_OPERATION_REVIEW_ATTR,
  PACKS_DETAIL_BACK_ATTR,
  PACKS_DETAIL_RESOLVE_ERROR_ATTR,
  PACKS_DETAIL_RESOLVING_ATTR,
  PACKS_DETAIL_SECTION_ATTR,
  PACKS_ROW_DELETE_BTN_ATTR,
  PACKS_ROW_INSTALL_BTN_ATTR,
  PACKS_SECTION_ATTR,
  mountPacksPanel,
  type PacksListCaller,
  type PacksResolveCaller,
} from '../settings/packs-panel.js';
import type { BulkPackManifest, PackListEntry } from '@recued/contracts';

// ── Fake DOM ──────────────────────────────────────────────────────
interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  disabled: boolean;
  type: string;
  value: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(t: string, fn: (ev: unknown) => void): void;
  removeEventListener(t: string, fn: (ev: unknown) => void): void;
  click(): void;
  remove(): void;
}

const makeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    disabled: false,
    type: '',
    value: '',
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute: (k, v) => {
      el.attrs.set(k, v);
      if (k === 'disabled') el.disabled = true;
    },
    removeAttribute: (k) => {
      el.attrs.delete(k);
      if (k === 'disabled') el.disabled = false;
    },
    getAttribute: (k) => el.attrs.get(k) ?? null,
    hasAttribute: (k) => el.attrs.has(k),
    appendChild: (c) => {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild: (c) => {
      const i = el.children.indexOf(c);
      if (i < 0) throw new Error('removeChild: not a child');
      el.children.splice(i, 1);
      c.parent = null;
      return c;
    },
    addEventListener: (t, fn) => {
      const a = el.listeners.get(t) ?? [];
      a.push(fn);
      el.listeners.set(t, a);
    },
    removeEventListener: (t, fn) => {
      const a = el.listeners.get(t);
      if (a === undefined) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    click: () => {
      if (el.disabled) return;
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
    remove: () => {
      if (el.parent !== null) el.parent.removeChild(el);
    },
  };
  return el;
};

const fakeDoc = () => ({ createElement: (tag: string) => makeEl(tag) });

const findByAttr = (root: FakeEl, attr: string): FakeEl | null => {
  if (root.hasAttribute(attr)) return root;
  for (const c of root.children) {
    const hit = findByAttr(c, attr);
    if (hit !== null) return hit;
  }
  return null;
};
const findByAttrValue = (root: FakeEl, attr: string, value: string): FakeEl | null => {
  if (root.getAttribute(attr) === value) return root;
  for (const c of root.children) {
    const hit = findByAttrValue(c, attr, value);
    if (hit !== null) return hit;
  }
  return null;
};
const text = (root: FakeEl): string => {
  let out = root.textContent ?? '';
  for (const c of root.children) out += text(c);
  return out;
};
const tick = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ── Fixtures ──────────────────────────────────────────────────────
const manifest = (o: Partial<BulkPackManifest> = {}): BulkPackManifest => ({
  manifest_version: 1,
  slug: 'mkt-pack',
  publisher: 'acme',
  name: 'Marketplace Pack',
  description: 'A marketplace-published pack (not bundled).',
  version: 3,
  recipes: [{ slug: 'r-a', version: 1 }],
  requires: ['install_bulk_pack'],
  tags: ['crm'],
  ...o,
});

const entry = (o: Partial<PackListEntry> = {}): PackListEntry => {
  const m = o.manifest ?? manifest({ slug: 'bundled-pack', name: 'Bundled Pack' });
  return {
    slug: m.slug,
    publisher: m.publisher,
    name: m.name,
    description: m.description,
    version: m.version,
    pre_install: m.pre_install === true,
    installed: false,
    requires: [...m.requires],
    recipe_count: m.recipes.length,
    body_visibility_grant_count: m.mcp_body_visibility_grants?.length ?? 0,
    manifest: m,
    ...o,
  };
};

interface MountArgs {
  initialSlug?: string;
  roster?: () => {
    packs: PackListEntry[];
    installed_versions?: Array<{ slug: string; version: number }>;
  };
  resolve?: PacksResolveCaller;
  installBySlug?: ReturnType<typeof vi.fn>;
  uninstall?: ReturnType<typeof vi.fn>;
}

const mount = (args: MountArgs) => {
  const host = makeEl('div');
  const runList: PacksListCaller = vi.fn(async () =>
    args.roster ? args.roster() : { packs: [] },
  );
  const runInstallBySlug =
    args.installBySlug ??
    vi.fn(async () => ({
      result: { ok: true as const, installed: [], rolled_back: [] },
    }));
  const runUninstall =
    args.uninstall ??
    vi.fn(async () => ({
      result: { ok: true as const, removed: { recipes: [], body_visibility_grants: [] } },
    }));
  const m = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: fakeDoc() as unknown as Document,
    runList,
    onSelectSlug: () => undefined,
    ...(args.initialSlug !== undefined ? { initialSlug: args.initialSlug } : {}),
    ...(args.resolve !== undefined ? { runResolvePack: args.resolve } : {}),
    runInstall: vi.fn(async () => ({
      result: { ok: true as const, installed: [], rolled_back: [] },
    })),
    runInstallBySlug: runInstallBySlug as never,
    runUninstall: runUninstall as never,
  });
  return { host, mount: m, runList, runInstallBySlug, runUninstall };
};

describe('packs panel — detail (marketplace resolve + install/uninstall)', () => {
  it('renders a ROSTER slug detail directly, without resolving', async () => {
    const resolve = vi.fn<PacksResolveCaller>(async () => ({ manifest: null }));
    const bundled = entry({ manifest: manifest({ slug: 'bundled-pack', name: 'Bundled Pack' }) });
    const { host, mount: m } = mount({
      initialSlug: 'bundled-pack',
      roster: () => ({ packs: [bundled] }),
      resolve,
    });
    await m.whenLoaded();
    await tick();
    expect(m.getSelectedSlug()).toBe('bundled-pack');
    // The detail's IDENTITY section rendered with the roster name.
    expect(findByAttr(host, PACKS_DETAIL_SECTION_ATTR)).not.toBeNull();
    expect(text(host)).toContain('Bundled Pack');
    // A roster pack is never resolved.
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolves a MARKETPLACE slug absent from the roster + renders its detail', async () => {
    const resolve = vi.fn<PacksResolveCaller>(async () => ({ manifest: manifest() }));
    const { host, mount: m } = mount({
      initialSlug: 'mkt-pack',
      roster: () => ({ packs: [] }),
      resolve,
    });
    await m.whenLoaded();
    await tick();
    expect(resolve).toHaveBeenCalledWith('mkt-pack');
    // Full-fidelity detail from the resolved manifest.
    expect(findByAttr(host, PACKS_DETAIL_SECTION_ATTR)).not.toBeNull();
    expect(text(host)).toContain('Marketplace Pack');
    // Not installed → the Install affordance is present.
    expect(findByAttrValue(host, PACKS_ROW_INSTALL_BTN_ATTR, 'mkt-pack')).not.toBeNull();
  });

  it('shows an error + retry when the resolve fails, and does not loop', async () => {
    const resolve = vi.fn<PacksResolveCaller>(async () => ({
      manifest: null,
      failure: { code: 'unresolved', message: 'No pack at that slug.' },
    }));
    const { host, mount: m } = mount({
      initialSlug: 'ghost',
      roster: () => ({ packs: [] }),
      resolve,
    });
    await m.whenLoaded();
    await tick();
    const err = findByAttr(host, PACKS_DETAIL_RESOLVE_ERROR_ATTR);
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain('No pack at that slug.');
    // Guarded — a failed slug is NOT re-resolved on every render.
    expect(resolve).toHaveBeenCalledTimes(1);
    // Still shows a resolving state? No — the error replaced it.
    expect(findByAttr(host, PACKS_DETAIL_RESOLVING_ATTR)).toBeNull();
  });

  it('a non-roster slug with NO resolver wired shows a terminal Unavailable state, not an endless spinner', async () => {
    // No `resolve` → runResolvePack absent. A partial host / server without the
    // resolve rpc must not leave "Loading pack…" forever (codex Low).
    const { host, mount: m } = mount({
      initialSlug: 'ghost',
      roster: () => ({ packs: [] }),
      // resolve omitted → runResolvePack undefined
    });
    await m.whenLoaded();
    await tick();
    // Terminal unavailable state (+ Back), NOT the loading placeholder.
    expect(findByAttr(host, PACKS_DETAIL_RESOLVING_ATTR)).toBeNull();
    const note = findByAttr(host, PACKS_DETAIL_RESOLVE_ERROR_ATTR);
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain('isn’t available');
    expect(findByAttr(host, PACKS_DETAIL_BACK_ATTR)).not.toBeNull();
  });

  it('installs a marketplace pack via runInstallBySlug + flips Install→Uninstall from installed_versions', async () => {
    const manifestReviewHash = 'a'.repeat(64);
    const resolve = vi.fn<PacksResolveCaller>(async () => ({
      manifest: manifest(),
      manifest_review_hash: manifestReviewHash,
    }));
    let installed = false;
    const installBySlug = vi.fn(async () => {
      installed = true;
      return { result: { ok: true as const, installed: [], rolled_back: [] } };
    });
    const { host, mount: m, runInstallBySlug } = mount({
      initialSlug: 'mkt-pack',
      // A marketplace pack never appears in packs[]; installed-state comes from
      // the inventory only.
      roster: () => ({
        packs: [],
        installed_versions: installed ? [{ slug: 'mkt-pack', version: 3 }] : [],
      }),
      resolve,
      installBySlug,
    });
    await m.whenLoaded();
    await tick();

    // Install from the detail.
    m.clickInstall('mkt-pack');
    await m.clickConfirmInstall();
    await tick();

    // By-slug path (marketplace recipes aren't bundled) — not the by-value install.
    expect(runInstallBySlug).toHaveBeenCalledTimes(1);
    expect(runInstallBySlug.mock.calls[0]![0]).toMatchObject({
      slug: 'mkt-pack',
      expected_manifest_hash: manifestReviewHash,
    });

    // The detail flipped to installed via the inventory (no wrong re-resolve).
    expect(findByAttrValue(host, PACKS_ROW_INSTALL_BTN_ATTR, 'mkt-pack')).toBeNull();
    expect(findByAttrValue(host, PACKS_ROW_DELETE_BTN_ATTR, 'mkt-pack')).not.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1); // resolved once, not again post-install
  });

  it('discards a stale marketplace review and returns to a refreshable detail error', async () => {
    const resolve = vi.fn<PacksResolveCaller>(async () => ({
      manifest: manifest(),
      manifest_review_hash: 'a'.repeat(64),
    }));
    const installBySlug = vi.fn(async () => ({
      result: {
        ok: false as const,
        installed: [],
        rolled_back: [],
        failure: { code: 'review_stale' as const, message: 'stale' },
      },
    }));
    const { host, mount: m } = mount({
      initialSlug: 'mkt-pack',
      roster: () => ({ packs: [] }),
      resolve,
      installBySlug,
    });
    await m.whenLoaded();
    await tick();
    m.clickInstall('mkt-pack');
    await m.clickConfirmInstall();
    await tick();

    expect(findByAttr(host, PACKS_DETAIL_RESOLVE_ERROR_ATTR)?.textContent)
      .toContain('changed after you reviewed it');
    expect(findByAttrValue(host, PACKS_ROW_INSTALL_BTN_ATTR, 'mkt-pack')).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('keeps an older marketplace version actionable as Update and carries its owner-ruling review', async () => {
    const resolve = vi.fn<PacksResolveCaller>(async () => ({
      manifest: manifest({ version: 3 }),
      owner_operation_review: [{
        ingredient_id: 'recued-core/acme',
        operation_id: 'recued-core/acme.deal.read',
        change: 'changed',
        owner_policy: { approval: 'ask' },
        incoming: { risk: 'read', approval: 'never' },
      }],
    }));
    const { host, mount: m } = mount({
      initialSlug: 'mkt-pack',
      roster: () => ({
        packs: [],
        installed_versions: [{ slug: 'mkt-pack', version: 2 }],
      }),
      resolve,
    });
    await m.whenLoaded();
    await tick();

    // Installed-at-any-version is not installed-at-the-incoming-version.
    expect(findByAttrValue(host, PACKS_ROW_INSTALL_BTN_ATTR, 'mkt-pack')).not.toBeNull();
    expect(findByAttrValue(host, PACKS_ROW_DELETE_BTN_ATTR, 'mkt-pack')).toBeNull();
    m.clickInstall('mkt-pack');
    await tick();
    expect(findByAttr(host, PACKS_DIALOG_OWNER_OPERATION_REVIEW_ATTR)).not.toBeNull();
    expect(findByAttr(host, PACKS_DIALOG_INSTALL_BTN_ATTR)?.textContent).toBe('Update');
  });

  it('does not turn an older marketplace preview into a downgrade-shaped Update', async () => {
    const resolve = vi.fn<PacksResolveCaller>(async () => ({
      manifest: manifest({ version: 3 }),
    }));
    const { host, mount: m } = mount({
      initialSlug: 'mkt-pack',
      roster: () => ({
        packs: [],
        installed_versions: [{ slug: 'mkt-pack', version: 4 }],
      }),
      resolve,
    });
    await m.whenLoaded();
    await tick();

    expect(findByAttrValue(host, PACKS_ROW_INSTALL_BTN_ATTR, 'mkt-pack')).toBeNull();
    expect(findByAttrValue(host, PACKS_ROW_DELETE_BTN_ATTR, 'mkt-pack')).not.toBeNull();
  });

  it('UNINSTALLS an installed marketplace pack from its detail (Delete → Confirm → runUninstall), flipping back to Install', async () => {
    const resolve = vi.fn<PacksResolveCaller>(async () => ({ manifest: manifest() }));
    let installed = true; // starts installed (present only in installed_versions)
    const runUninstall = vi.fn(async (_args: { pack_slug: string }) => {
      installed = false;
      return { result: { ok: true as const, removed: { recipes: [], body_visibility_grants: [] } } };
    });
    const { host, mount: m } = mount({
      initialSlug: 'mkt-pack',
      roster: () => ({
        packs: [], // marketplace pack never appears in packs[]
        installed_versions: installed ? [{ slug: 'mkt-pack', version: 3 }] : [],
      }),
      resolve,
      uninstall: runUninstall,
    });
    await m.whenLoaded();
    await tick();
    // Installed marketplace pack → Delete affordance present, not Install.
    expect(findByAttrValue(host, PACKS_ROW_DELETE_BTN_ATTR, 'mkt-pack')).not.toBeNull();
    expect(findByAttrValue(host, PACKS_ROW_INSTALL_BTN_ATTR, 'mkt-pack')).toBeNull();

    // Delete → Confirm actually fires the rpc (the bug was: both no-op'd because
    // openDeleteConfirm/submitUninstall used packs.find, which misses it).
    m.clickDelete('mkt-pack');
    await tick();
    await m.clickConfirmDelete();
    await tick();
    expect(runUninstall).toHaveBeenCalledTimes(1);
    expect(runUninstall.mock.calls[0]![0]).toMatchObject({ pack_slug: 'mkt-pack' });
    // Flipped back to Install (no longer in the inventory).
    expect(findByAttrValue(host, PACKS_ROW_INSTALL_BTN_ATTR, 'mkt-pack')).not.toBeNull();
    expect(findByAttrValue(host, PACKS_ROW_DELETE_BTN_ATTR, 'mkt-pack')).toBeNull();
  });

  it('cancelling the consent dialog KEEPS the resolved detail (no needless re-resolve)', async () => {
    const resolve = vi.fn<PacksResolveCaller>(async () => ({ manifest: manifest() }));
    const { host, mount: m } = mount({
      initialSlug: 'mkt-pack',
      roster: () => ({ packs: [] }),
      resolve,
    });
    await m.whenLoaded();
    await tick();
    m.clickInstall('mkt-pack'); // open the consent dialog
    await tick();
    m.clickCancelDialog(); // cancel it
    await tick();
    // Detail is still shown (manifest retained), NOT re-resolved.
    expect(m.getSelectedSlug()).toBe('mkt-pack');
    expect(text(host)).toContain('Marketplace Pack');
    expect(findByAttrValue(host, PACKS_ROW_INSTALL_BTN_ATTR, 'mkt-pack')).not.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1); // resolved once — cancel didn't discard it
  });

  it('never paints the list / Add-a-pack sections in detail-only mode', async () => {
    const { host, mount: m } = mount({
      initialSlug: 'bundled-pack',
      roster: () => ({ packs: [entry({ manifest: manifest({ slug: 'bundled-pack' }) })] }),
    });
    await m.whenLoaded();
    await tick();
    // No `installed` / `discover` / `add` list sections — only the detail.
    expect(findByAttr(host, PACKS_SECTION_ATTR)).toBeNull();
    expect(findByAttr(host, PACKS_DETAIL_SECTION_ATTR)).not.toBeNull();
  });
});
