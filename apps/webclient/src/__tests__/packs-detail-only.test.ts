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
  PACKS_DIALOG_ATTR,
  PACKS_DIALOG_PENDING_ATTR,
  PACKS_DIALOG_INSTALL_BTN_ATTR,
  PACKS_DIALOG_OPERATION_DIFF_ATTR,
  PACKS_DIALOG_OWNER_OPERATION_REVIEW_ATTR,
  PACKS_DETAIL_BACK_ATTR,
  PACKS_DETAIL_RESOLVE_ERROR_ATTR,
  PACKS_DETAIL_RESOLVE_RETRY_ATTR,
  PACKS_DETAIL_RESOLVING_ATTR,
  PACKS_DETAIL_SECTION_ATTR,
  PACKS_DETAIL_TAB_ATTR,
  PACKS_PANEL_STYLES,
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
    recipe_refs: m.recipes.map((r) => ({ slug: r.slug, version: r.version })),
    body_visibility_grant_keys: [...(m.mcp_body_visibility_grants ?? [])],
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
  install?: ReturnType<typeof vi.fn>;
  installBySlug?: ReturnType<typeof vi.fn>;
  uninstall?: ReturnType<typeof vi.fn>;
  recipeList?: ReturnType<typeof vi.fn>;
  /** Wiring these is what makes the owner-operation controller `enabled`. A
   *  mount WITHOUT them is not a lighter test of the same thing — it takes the
   *  `if (!enabled) return null` path, which is a branch production never has.
   *  That exact gap already shipped a bug here: a green test proved the
   *  pre-install preview rendered, under a condition the real panel never met. */
  ownerOps?: boolean;
}

const mount = (args: MountArgs) => {
  const host = makeEl('div');
  const runList: PacksListCaller = vi.fn(async () =>
    args.roster ? args.roster() : { packs: [] },
  );
  const runInstall =
    args.install ??
    vi.fn(async () => ({
      result: { ok: true as const, installed: [], rolled_back: [] },
    }));
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
    runInstall: runInstall as never,
    runInstallBySlug: runInstallBySlug as never,
    runUninstall: runUninstall as never,
    ...(args.recipeList !== undefined
      ? { runRecipeList: args.recipeList as never }
      : {}),
    ...(args.ownerOps === true
      ? {
          runOwnerOperationInventory: (async () => ({ ingredients: [] })) as never,
          runOwnerOperationList: (async () => ({ overrides: [] })) as never,
        }
      : {}),
  });
  return { host, mount: m, runList, runInstall, runInstallBySlug, runUninstall };
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
    // A roster pack WITH a manifest is never resolved.
    expect(resolve).not.toHaveBeenCalled();
  });

  /** ⛔ Live-drive regression. `packs.list` forwards a manifest for INSTALLED
   *  packs only, so a listed-but-uninstalled pack now arrives without one — and
   *  every consent surface is gated on it. The Install button rendered, the click
   *  set `dialogOpenFor`, the dialog's `pack.manifest !== undefined` guard
   *  rendered nothing "this pass", and the resolve that was supposed to complete
   *  and re-render never started: the detail route returns as soon as
   *  `findPackBySlug` hits, which is ABOVE the only `ensureDetailResolved` call.
   *  Install was inert with no error, forever.
   *
   *  `ensureDetailResolved` had already been taught this case — the fix went into
   *  the function and nothing routed the case to it. */
  it('a LISTED pack that arrives WITHOUT a manifest resolves, so Install actually opens', async () => {
    const resolve = vi.fn<PacksResolveCaller>(async () => ({
      manifest: manifest({ slug: 'bundled-pack', name: 'Bundled Pack' }),
    }));
    // The live shape: list fields present, manifest absent.
    const listedNoManifest = entry({
      manifest: undefined,
      installed: false,
    });
    expect(listedNoManifest.manifest).toBeUndefined();
    const { host, mount: m, runInstall, runInstallBySlug } = mount({
      initialSlug: 'bundled-pack',
      roster: () => ({ packs: [listedNoManifest] }),
      resolve,
    });
    await m.whenLoaded();
    await tick();
    await tick();

    // The missing manifest is what triggers the resolve — nothing else changed.
    expect(resolve).toHaveBeenCalledWith('bundled-pack');

    m.clickInstall('bundled-pack');
    await tick();
    // The consent dialog is on screen. This is the whole bug: before the fix the
    // click was swallowed and this stayed null.
    expect(findByAttr(host, PACKS_DIALOG_ATTR)).not.toBeNull();

    // 🔑 And it still installs BY VALUE. The resolved manifest backfills the
    // LISTED row rather than becoming a `pendingAddEntry` — that flag is what
    // routes an install to the marketplace `packs.installBySlug`, and a pack the
    // roster already carries must keep flowing through `packs.install`.
    const dialogInstall = findByAttr(host, PACKS_DIALOG_INSTALL_BTN_ATTR);
    expect(dialogInstall).not.toBeNull();
    dialogInstall!.click();
    await tick();
    await tick();
    expect(runInstallBySlug).not.toHaveBeenCalled();
    expect(runInstall).toHaveBeenCalledTimes(1);
    const sent = runInstall.mock.calls[0]![0] as { manifest?: BulkPackManifest };
    expect(sent.manifest?.slug).toBe('bundled-pack');
  });

  it('⛔ an INSTALLED pack arrives without a manifest too, resolves it, and does NOT claim "nothing to change" while it is in flight', async () => {
    // `packs.list` stopped forwarding `manifest` for EVERY pack, installed
    // included — it reached 17.7 MB and the socket dropped the frame whole. So
    // the path the test above proved for an uninstalled pack is now the ONLY
    // path, and an installed pack's detail depends on it for its access,
    // permissions, supervision and collision surfaces. If `ensureDetailResolved`
    // ever stops firing here, all of them silently render empty against a server
    // that answered fine — which is the failure this whole change came from.
    let land = (): void => undefined;
    const gate = new Promise<void>((r) => { land = r; });
    const resolve = vi.fn<PacksResolveCaller>(async () => {
      await gate;
      return { manifest: manifest({ slug: 'bundled-pack', name: 'Bundled Pack' }) };
    });
    const installedNoManifest = entry({ manifest: undefined, installed: true });
    expect(installedNoManifest.manifest).toBeUndefined();
    const { host, mount: m } = mount({
      initialSlug: 'bundled-pack',
      roster: () => ({ packs: [installedNoManifest] }),
      resolve,
      ownerOps: true,
    });
    await m.whenLoaded();
    await tick();

    // Installed is no longer a reason to skip the resolve.
    expect(resolve).toHaveBeenCalledWith('bundled-pack');

    const permissionsTab = findByAttrValue(host, PACKS_DETAIL_TAB_ATTR, 'permissions');
    expect(permissionsTab).not.toBeNull();
    permissionsTab!.click();
    await tick();

    // 🔑 THE ASSERTION THAT MATTERS IS THE ABSENCE. An in-flight manifest makes
    // the owner-operation matrix return null, and the branch that caught that
    // said "There is nothing to change here for this Pack." — a confident, false
    // answer about a pack with plenty to change. Loading and empty are different
    // facts and must not share a sentence.
    const whileResolving = text(host);
    expect(whileResolving).toContain('Loading this Pack’s operations');
    expect(whileResolving).not.toContain('nothing to change here');

    land();
    await tick();
    await tick();

    // Backfilled in place, and the loading state is gone — it was a state, not a
    // permanent label.
    expect(text(host)).not.toContain('Loading this Pack’s operations');
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

  it('keeps resolve Retry busy and mounted, then hands off to Install', async () => {
    let releaseRetry: (() => void) | null = null;
    const retryGate = new Promise<void>((resolveGate) => {
      releaseRetry = resolveGate;
    });
    let calls = 0;
    const resolve = vi.fn<PacksResolveCaller>(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          manifest: null,
          failure: { code: 'unresolved', message: 'Marketplace unavailable.' },
        };
      }
      await retryGate;
      return { manifest: manifest() };
    });
    const { host, mount: m } = mount({
      initialSlug: 'mkt-pack',
      roster: () => ({ packs: [] }),
      resolve,
    });
    await m.whenLoaded();
    await tick();

    const retry = findByAttr(host, PACKS_DETAIL_RESOLVE_RETRY_ATTR);
    expect(retry).not.toBeNull();
    retry!.click();
    retry!.click();
    await tick();

    const busyRetry = findByAttr(host, PACKS_DETAIL_RESOLVE_RETRY_ATTR);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(busyRetry).not.toBeNull();
    expect(busyRetry!.textContent).toBe('Retrying…');
    expect(busyRetry!.getAttribute('aria-disabled')).toBe('true');
    expect(busyRetry!.getAttribute('aria-busy')).toBe('true');
    expect(findByAttr(host, PACKS_DETAIL_RESOLVING_ATTR)).toBeNull();

    releaseRetry!();
    await tick();
    expect(findByAttr(host, PACKS_DETAIL_RESOLVE_RETRY_ATTR)).toBeNull();
    expect(findByAttrValue(host, PACKS_ROW_INSTALL_BTN_ATTR, 'mkt-pack'))
      .not.toBeNull();
  });

  it('contains long resolve errors and keeps Retry touch-sized', () => {
    expect(PACKS_PANEL_STYLES).toMatch(
      /\.packs-add-error\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(PACKS_PANEL_STYLES).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\[data-recued-packs-detail-resolve-retry\]\.packs-detail-resolve-retry\.rx-btn\s*\{[^}]*min-height:\s*44px/s,
    );
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
    expect(note!.textContent).toContain('does not have that Pack');
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
    const recipeList = vi.fn(async () => ({ recipes: [] }));
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
      recipeList,
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
    expect(recipeList).toHaveBeenCalledTimes(2); // pre-install roster + refreshed roster
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
      .toContain('changed after you looked at it');
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

  it('a marketplace update carries the whole operation diff and starts at the pack\'s current Access', async () => {
    /** The detail-only path projects the resolve result itself
     *  (`projectAddedManifest`) — a field it does not copy never reaches the
     *  dialog, whatever the server sent. */
    const withOps = manifest({
      version: 3,
      contents: [{
        type: 'composition',
        composition: {
          schema_version: 1,
          slug: 'acme',
          ingredients: [{ slug: 'acme', kind: 'http' }],
          operations: [
            { op: 'deal.read', ingredient: 'acme', risk: 'read', approval: 'never', bind: {} },
            { op: 'deal.create', ingredient: 'acme', risk: 'write', approval: 'ask', bind: {} },
          ],
        },
      }],
    });
    const resolve = vi.fn<PacksResolveCaller>(async () => ({
      manifest: withOps,
      operation_diff: {
        unchanged: 1,
        items: [{
          ingredient_id: 'acme', operation_id: 'acme.deal.create', change: 'added',
          incoming: { risk: 'write', approval: 'ask' },
        }],
      },
      current_access: 'write',
      current_audience: { owner: false, all_customers: true, all_other_contracts: false },
    }));
    const { host, mount: m } = mount({
      initialSlug: 'mkt-pack',
      roster: () => ({ packs: [], installed_versions: [{ slug: 'mkt-pack', version: 2 }] }),
      resolve,
    });
    await m.whenLoaded();
    await tick();
    m.clickInstall('mkt-pack');
    await tick();
    expect(text(findByAttr(host, PACKS_DIALOG_OPERATION_DIFF_ATTR)!)).toContain('acme.deal.create — Write · Ask');
    expect(m.getDialogAccessTier()).toBe('write');
    // D-294 — and "Who may use it" at who has the pack now.
    expect(m.getDialogAudience()).toEqual({ owner: false, all_customers: true, all_other_contracts: false });
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

/** ⛔ The second layer of the same silence. A LISTED pack whose resolve FAILS
 *  never reached `renderDetailResolveError` — that lives in the not-found
 *  branch — so the detail rendered normally with an Install button that could
 *  not open, `ensureDetailResolved` refusing to retry (it early-returns on a
 *  recorded error), and no message anywhere.
 *
 *  Real trigger: `rental-book`. It carries a records composition, and the
 *  records review resolved all 19 recipe refs from the MARKETPLACE, so on a
 *  LAN-only server the resolve failed on the first ref. Fixed server-side too —
 *  this covers the client half, which must not go quiet for the NEXT cause. */
describe('packs panel — a listed pack whose resolve fails says so', () => {
  it('surfaces the reason instead of a detail with a dead Install button', async () => {
    const resolve = vi.fn<PacksResolveCaller>(async () => ({
      manifest: null,
      failure: { code: 'validation', message: 'Records recipe could not be resolved.' },
    }));
    const { host, mount: m } = mount({
      initialSlug: 'bundled-pack',
      roster: () => ({ packs: [entry({ manifest: undefined, installed: false })] }),
      resolve,
    });
    await m.whenLoaded();
    await tick();
    await tick();

    expect(resolve).toHaveBeenCalledWith('bundled-pack');
    const err = findByAttr(host, PACKS_DETAIL_RESOLVE_ERROR_ATTR);
    expect(err).not.toBeNull();
    expect(text(host)).toContain('Records recipe could not be resolved.');
    // ⛔ And no Install button, because there is nothing behind it — offering one
    // that silently does nothing is what this whole thread has been about.
    expect(findByAttrValue(host, PACKS_ROW_INSTALL_BTN_ATTR, 'bundled-pack')).toBeNull();
  });
});

/** The resolve is a round-trip, so Install is briefly not clickable. Before this
 *  the button looked ready, the click landed on nothing, and the popup arrived
 *  later on its own — a sequence indistinguishable from a broken button, which
 *  is how it was reported. */
describe('packs panel — Install says it is preparing while the manifest loads', () => {
  it('reads Preparing… and is disabled until the resolve lands, then opens', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const resolve = vi.fn<PacksResolveCaller>(async () => {
      await gate;
      return { manifest: manifest({ slug: 'bundled-pack', name: 'Bundled Pack' }) };
    });
    const { host, mount: m } = mount({
      initialSlug: 'bundled-pack',
      roster: () => ({ packs: [entry({ manifest: undefined, installed: false })] }),
      resolve,
    });
    await m.whenLoaded();
    await tick();

    const btn = findByAttrValue(host, PACKS_ROW_INSTALL_BTN_ATTR, 'bundled-pack');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Preparing…');
    expect(btn!.getAttribute('aria-busy')).toBe('true');
    // ⛔ NOT disabled. Disabling it swallowed the press: nothing happened, the
    // label flipped back, and the user had to click a second time. The click
    // must LAND — `openDialog` records the intent without the manifest.
    expect(btn!.disabled).toBe(false);
    btn!.click();
    await tick();
    expect(findByAttr(host, PACKS_DIALOG_PENDING_ATTR)).not.toBeNull();

    release!();
    await tick();
    await tick();

    // 🔑 The queued click resolves into the real dialog — the placeholder is
    // replaced, not merely joined by it.
    expect(findByAttr(host, PACKS_DIALOG_PENDING_ATTR)).toBeNull();
    expect(findByAttr(host, PACKS_DIALOG_ATTR)).not.toBeNull();
  });
});
