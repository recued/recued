/** Discover — [Installed | Discover] tab shell + recipe-discovery config. */

import { describe, expect, it, vi } from 'vitest';

import { mountDiscoverySurface } from '../discover/discovery-surface.js';
import {
  mountRecipeDiscovery,
  recipeBadges,
  recipeMeta,
  recipeSpec,
} from '../discover/recipe-discovery.js';
import type { CatalogPackRow, CatalogRecipeRow } from '../discover/catalog-client.js';
import type { BulkPackManifest, OpKind, PackContentRef, RiskTier } from '@recued/contracts';

// ── manifest builders — `packs.list` returns full manifests; the co-install
//    dialog derives its §7.1/§7.2 grant picker from the composition. A pack
//    with NO composition (default) → null grant model → no picker / scope. ──
const mkManifest = (over: Partial<BulkPackManifest> = {}): BulkPackManifest => ({
  manifest_version: 2,
  slug: 'p',
  publisher: 'recued-core',
  name: 'P',
  description: '',
  version: 1,
  recipes: [],
  requires: [],
  tags: [],
  ...over,
});

/** A pack whose by-value composition binds a single `connection`-kind op at
 *  the given risk — so `installGrantModelFromManifest` yields a non-null model
 *  and the co-install row renders the {Access × Scope} picker. */
const connManifest = (
  slug: string,
  opRisk: RiskTier = 'read',
  kind: OpKind = 'connection',
): BulkPackManifest => {
  const content: PackContentRef = {
    type: 'composition',
    composition: {
      schema_version: 1,
      slug: `${slug}-composition`,
      ingredients: [{ slug: 'vendor', kind }],
      operations: [
        { op: `${slug}.op`, ingredient: 'vendor', risk: opRisk, approval: opRisk === 'read' ? 'never' : 'ask', bind: {} },
      ],
    },
  } as PackContentRef;
  return mkManifest({ slug, service_kind: 'entity_platform', contents: [content] });
};

// ── fake DOM (with a head for the once-injected styles) ─────────────
const makeEl = (tag: string) => {
  const children: any[] = [];
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const el: any = {
    tagName: tag.toUpperCase(),
    textContent: '',
    children,
    attrs,
    listeners,
    parent: null,
    get firstChild() {
      return children[0] ?? null;
    },
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    querySelector: (_sel: string) => null,
    appendChild: (c: any) => {
      c.parent = el;
      children.push(c);
      return c;
    },
    removeChild: (c: any) => {
      const i = children.indexOf(c);
      if (i >= 0) children.splice(i, 1);
      c.parent = null;
      return c;
    },
    addEventListener: (t: string, fn: (ev: unknown) => void) => {
      const a = listeners.get(t) ?? [];
      a.push(fn);
      listeners.set(t, a);
    },
    removeEventListener: () => {},
    remove: () => {
      if (el.parent) el.parent.removeChild(el);
    },
    click: () => {
      for (const fn of listeners.get('click') ?? []) fn({ stopPropagation() {} });
    },
    focus: () => {},
    keydown: (key: string) => {
      for (const fn of listeners.get('keydown') ?? []) {
        fn({ key, preventDefault() {} });
      }
    },
  };
  return el;
};
const fakeDoc = () => {
  const head = makeEl('head');
  return { head, createElement: (tag: string) => makeEl(tag) } as unknown as Document;
};
const findTab = (host: any, tab: string): any =>
  ((): any => {
    const out: any[] = [];
    const walk = (e: any) => {
      if (e.getAttribute?.('data-recued-discovery-tab') === tab) out.push(e);
      for (const c of e.children ?? []) walk(c);
    };
    walk(host);
    return out[0];
  })();

describe('mountDiscoverySurface', () => {
  const setup = (initialTab?: 'installed' | 'discover') => {
    const root = makeEl('div');
    const installedMount = { dispose: vi.fn() };
    const discoverMount = { dispose: vi.fn() };
    const mountInstalled = vi.fn(() => installedMount);
    const mountDiscover = vi.fn(() => discoverMount);
    const onReactivate = vi.fn();
    const surface = mountDiscoverySurface({
      root: root as unknown as HTMLElement,
      document: fakeDoc(),
      mountInstalled,
      mountDiscover,
      onReactivate,
      ...(initialTab !== undefined ? { initialTab } : {}),
    });
    return { root, surface, installedMount, discoverMount, mountInstalled, mountDiscover, onReactivate };
  };

  it('mounts Installed immediately and defers Discover until first activation', () => {
    const { surface, mountInstalled, mountDiscover } = setup();
    expect(mountInstalled).toHaveBeenCalledTimes(1);
    expect(mountDiscover).not.toHaveBeenCalled();
    expect(surface.activeTab()).toBe('installed');
    surface.showTab('discover');
    expect(mountDiscover).toHaveBeenCalledTimes(1);
    expect(surface.activeTab()).toBe('discover');
  });

  it('mounts Discover only once across repeat switches', () => {
    const { surface, mountDiscover } = setup();
    surface.showTab('discover');
    surface.showTab('installed');
    surface.showTab('discover');
    expect(mountDiscover).toHaveBeenCalledTimes(1);
  });

  it('honours an initial Discover tab', () => {
    const { surface, mountDiscover } = setup('discover');
    expect(mountDiscover).toHaveBeenCalledTimes(1);
    expect(surface.activeTab()).toBe('discover');
  });

  it('toggles pane visibility', () => {
    const { root, surface } = setup();
    const installedPane = root.children[0].children.find(
      (c: any) => c.getAttribute('data-recued-discovery-installed') !== null,
    );
    const discoverPane = root.children[0].children.find(
      (c: any) => c.getAttribute('data-recued-discovery-discover') !== null,
    );
    expect(installedPane.hidden).toBe(false);
    expect(discoverPane.hidden).toBe(true);
    surface.showTab('discover');
    expect(installedPane.hidden).toBe(true);
    expect(discoverPane.hidden).toBe(false);
  });

  it('a tab click switches', () => {
    const { root, surface } = setup();
    findTab(root, 'discover').click();
    expect(surface.activeTab()).toBe('discover');
  });

  it('uses one tab stop and activates adjacent tabs with arrow keys', () => {
    const { root, surface } = setup();
    const installed = findTab(root, 'installed');
    const discover = findTab(root, 'discover');
    expect(installed.tabIndex).toBe(0);
    expect(discover.tabIndex).toBe(-1);

    installed.keydown('ArrowRight');
    expect(surface.activeTab()).toBe('discover');
    expect(installed.tabIndex).toBe(-1);
    expect(discover.tabIndex).toBe(0);

    discover.keydown('ArrowLeft');
    expect(surface.activeTab()).toBe('installed');
    expect(installed.tabIndex).toBe(0);
    expect(discover.tabIndex).toBe(-1);
  });

  it('fires onReactivate on a RE-visit to an already-mounted pane, not first mount', () => {
    const { surface, onReactivate } = setup();
    surface.showTab('discover'); // first open = mount, not a reactivation
    expect(onReactivate).not.toHaveBeenCalled();
    surface.showTab('installed'); // installed was mounted at construction → reactivate
    expect(onReactivate).toHaveBeenLastCalledWith('installed');
    surface.showTab('discover'); // second open of the now-mounted discover → reactivate
    expect(onReactivate).toHaveBeenLastCalledWith('discover');
    expect(onReactivate).toHaveBeenCalledTimes(2);
  });

  it('does not fire onReactivate when clicking the already-active tab', () => {
    const { surface, onReactivate } = setup();
    surface.showTab('installed'); // already active (default) → no change, no reactivate
    expect(onReactivate).not.toHaveBeenCalled();
  });

  it('forwards installed-route in-flight ownership through the tab shell', () => {
    const root = makeEl('div');
    let pending = true;
    const surface = mountDiscoverySurface({
      root: root as unknown as HTMLElement,
      document: fakeDoc(),
      mountInstalled: () => ({
        dispose: vi.fn(),
        hasInFlightWork: () => pending,
        inFlightWorkPrompt: () =>
          pending ? 'A recipe action is still in progress.' : null,
      }),
      mountDiscover: () => ({ dispose: vi.fn() }),
    });

    expect(surface.hasInFlightWork()).toBe(true);
    expect(surface.inFlightWorkPrompt()).toBe(
      'A recipe action is still in progress.',
    );
    pending = false;
    expect(surface.hasInFlightWork()).toBe(false);
    expect(surface.inFlightWorkPrompt()).toBeNull();
    surface.dispose();
  });

  it('forwards installed-route unsaved ownership through the tab shell', () => {
    const root = makeEl('div');
    let dirty = true;
    const surface = mountDiscoverySurface({
      root: root as unknown as HTMLElement,
      document: fakeDoc(),
      mountInstalled: () => ({
        dispose: vi.fn(),
        hasUnsavedChanges: () => dirty,
        unsavedChangesPrompt: () =>
          dirty ? 'This recipe result has unsaved table changes.' : null,
      }),
      mountDiscover: () => ({ dispose: vi.fn() }),
    });

    expect(surface.hasUnsavedChanges()).toBe(true);
    expect(surface.unsavedChangesPrompt()).toBe(
      'This recipe result has unsaved table changes.',
    );
    dirty = false;
    expect(surface.hasUnsavedChanges()).toBe(false);
    expect(surface.unsavedChangesPrompt()).toBeNull();
    surface.dispose();
  });

  it('dispose tears down both mounted children', () => {
    const { surface, installedMount, discoverMount } = setup();
    surface.showTab('discover');
    surface.dispose();
    expect(installedMount.dispose).toHaveBeenCalledTimes(1);
    expect(discoverMount.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose without opening Discover only tears down Installed', () => {
    const { surface, installedMount, discoverMount } = setup();
    surface.dispose();
    expect(installedMount.dispose).toHaveBeenCalledTimes(1);
    expect(discoverMount.dispose).not.toHaveBeenCalled();
  });
});

// ── recipe-discovery config ─────────────────────────────────────────
const rr = (over: Partial<CatalogRecipeRow>): CatalogRecipeRow => ({
  recipe_id: 'r',
  publisher_id: 'recued-core',
  name: 'R',
  description: 'd',
  type: 'action',
  version: 1,
  platforms: [],
  tags: [],
  download_count: 0,
  rating_avg: 0,
  rating_count: 0,
  created_at: '2026-01-01',
  depends_on: [],
  ...over,
});

const pr = (over: Partial<CatalogPackRow>): CatalogPackRow => ({
  slug: 'workflow-pack',
  publisher_id: 'recued-core',
  name: 'Workflow Pack',
  description: 'd',
  version: 1,
  pack_kind: 'app_pack',
  tags: [],
  download_count: 0,
  item_count: 0,
  recipe_refs: [],
  created_at: '2026-01-01',
  ...over,
});

describe('recipe-discovery config', () => {
  it('spec searches across name/description/tags/platforms/publisher', () => {
    const row = rr({ name: 'Deal', tags: ['crm'], platforms: ['hubspot'] });
    const text = recipeSpec.searchableText(row);
    expect(text).toContain('Deal');
    expect(text).toContain('crm');
    expect(text).toContain('hubspot');
    expect(text).toContain('recued-core');
  });
  it('badges: certified (accent) + platforms (muted, capped at 3); no dead type badge', () => {
    const b = recipeBadges(rr({ publisher_certified: true, type: 'action', platforms: ['a', 'b', 'c', 'd'] }));
    expect(b[0]).toMatchObject({ label: '✓ Certified', tone: 'accent' });
    // The `type` column was dropped in migration 002, so `r.type` is always ''
    // in the catalog — the badge (and its facet) were removed as dead. Even a
    // row carrying a stray `type` must not render one.
    expect(b.some((x) => x.label === 'action')).toBe(false);
    // certified is the ONLY accent; the 4 platforms are capped to 3 muted badges.
    expect(b.filter((x) => x.tone === 'accent')).toHaveLength(1);
    expect(b.filter((x) => x.label === 'a' || x.label === 'b' || x.label === 'c')).toHaveLength(3);
    expect(b.some((x) => x.label === 'd')).toBe(false);
  });
  it('meta shows publisher · installs · rating (rating only when rated)', () => {
    expect(recipeMeta(rr({ publisher_id: 'p', download_count: 1 }))).toBe('p · 1 install');
    expect(recipeMeta(rr({ publisher_id: 'p', download_count: 5, rating_avg: 4.5, rating_count: 8 }))).toBe(
      'p · 5 installs · ★ 4.5 (8)',
    );
  });
  it('omits the installs chip entirely at 0 — never renders "0 installs"', () => {
    // `download_count` has no writer, so every real row is 0. The chip must be
    // ABSENT, not zero-valued: a rendered "0 installs" is a popularity claim
    // with nothing behind it. Asserted on the whole string so a reappearing
    // chip cannot hide in a substring match.
    expect(recipeMeta(rr({ publisher_id: 'p', download_count: 0 }))).toBe('p');
    expect(recipeMeta(rr({ publisher_id: 'p', download_count: 0, rating_avg: 4.5, rating_count: 8 }))).toBe(
      'p · ★ 4.5 (8)',
    );
  });

  it('installs a recipe by slug → runs installBySlug → re-lists → badge installed', async () => {
    const host = makeEl('div');
    const installBySlug = vi.fn(async (slug: string) => ({
      result: { ok: true as const, recipe_id: slug, version: 2 },
    }));
    let installedRows: Array<{ recipe_id: string; version: number }> = [];
    const listInstalled = vi.fn(async () => ({ recipes: installedRows }));
    const { panel, dispose } = mountRecipeDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      installBySlug,
      listInstalled,
      fetchCatalog: async () => ({
        status: 'ok',
        rows: [rr({ recipe_id: 'deal-risk', version: 2 })],
      }),
    });
    await panel.whenLoaded();
    // initial refreshInstalled resolved (empty) → available.
    await Promise.resolve();
    expect(panel.getInstallState('deal-risk')).toBe('available');
    // Simulate the server now reporting it installed after our install call.
    installedRows = [{ recipe_id: 'deal-risk', version: 2 }];
    await panel.clickInstall('deal-risk');
    // install ran + a re-list was triggered.
    expect(installBySlug).toHaveBeenCalledWith('deal-risk');
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.getInstallState('deal-risk')).toBe('installed');
    dispose();
  });

  it('hands the directly named recipe_bundle pack to the existing detail flow', async () => {
    const bundle = 'recued-core/task-closure';
    const rows = [
      rr({ recipe_id: 'create-task', recipe_bundle: bundle }),
      rr({ recipe_id: 'watch-task', recipe_bundle: bundle }),
      rr({ recipe_id: 'review-task', recipe_bundle: bundle }),
    ];
    const installBySlug = vi.fn(async (slug: string) => ({
      result: { ok: true as const, recipe_id: slug, version: 1 },
    }));
    const openPack = vi.fn();
    const mount = mountRecipeDiscovery({
      host: makeEl('div') as unknown as HTMLElement,
      document: fakeDoc(),
      installBySlug,
      listInstalled: async () => ({ recipes: [] }),
      fetchCatalog: async () => ({ status: 'ok', rows }),
      fetchPackCatalog: async () => ({
        status: 'ok',
        rows: [pr({
          slug: 'task-closure',
          recipe_refs: rows.map((row) => ({ slug: row.recipe_id, version: row.version })),
        })],
      }),
      openPack,
    });
    await mount.panel.whenLoaded();
    await mount.panel.clickInstall('watch-task');

    expect(openPack).toHaveBeenCalledWith('task-closure');
    expect(installBySlug).not.toHaveBeenCalled();
    // Handoff is not an optimistic install; the pack broadcast reconciles it.
    expect(mount.panel.getInstallState('watch-task')).toBe('available');
    mount.dispose();
  });

  /** The meta catalog no longer carries `recipe_refs` — pack MEMBERSHIP belongs
   *  to the per-pack install artifact, and carrying it in the meta was the only
   *  reason that catalog's server-side read had to touch all 927 manifests.
   *
   *  ⚠ The test above injects rows that ALREADY have refs, so it exercises the
   *  fast path and would keep passing with this fetch broken. These cover the
   *  shape the wire actually delivers now: `recipe_refs: []`. */
  const withCarrierFetch = (manifest: unknown, status = 200) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) =>
      new Response(JSON.stringify(manifest), { status: String(url).includes('/packs/') ? status : 404 })) as never);

  it('tops the carrier up from /packs/<slug>.json when the meta carries no refs', async () => {
    const bundle = 'recued-core/task-closure';
    const rows = [
      rr({ recipe_id: 'create-task', recipe_bundle: bundle }),
      rr({ recipe_id: 'watch-task', recipe_bundle: bundle }),
    ];
    const openPack = vi.fn();
    const spy = withCarrierFetch({
      slug: 'task-closure', publisher: 'recued-core',
      recipes: rows.map((r) => ({ slug: r.recipe_id, version: r.version })),
    });
    try {
      const mount = mountRecipeDiscovery({
        host: makeEl('div') as unknown as HTMLElement,
        document: fakeDoc(),
        installBySlug: vi.fn(async (slug: string) => ({ result: { ok: true as const, recipe_id: slug, version: 1 } })),
        listInstalled: async () => ({ recipes: [] }),
        fetchCatalog: async () => ({ status: 'ok', rows }),
        // The wire shape after the drop: identity, no membership.
        fetchPackCatalog: async () => ({ status: 'ok', rows: [pr({ slug: 'task-closure', recipe_refs: [] })] }),
        openPack,
      });
      await mount.panel.whenLoaded();
      await mount.panel.clickInstall('watch-task');
      expect(openPack).toHaveBeenCalledWith('task-closure');
      mount.dispose();
    } finally { spy.mockRestore(); }
  });

  it('fails CLOSED when the per-pack artifact is unreachable', async () => {
    // No refs from the meta and none from the artifact ⇒ the pack cannot be
    // shown to contain the recipe, so the handoff must not happen — and it must
    // NOT silently degrade into installing the one recipe.
    const bundle = 'recued-core/task-closure';
    const rows = [rr({ recipe_id: 'watch-task', recipe_bundle: bundle })];
    const openPack = vi.fn();
    const installBySlug = vi.fn(async (slug: string) => ({ result: { ok: true as const, recipe_id: slug, version: 1 } }));
    const spy = withCarrierFetch({ error: 'nope' }, 503);
    try {
      const mount = mountRecipeDiscovery({
        host: makeEl('div') as unknown as HTMLElement,
        document: fakeDoc(),
        installBySlug,
        listInstalled: async () => ({ recipes: [] }),
        fetchCatalog: async () => ({ status: 'ok', rows }),
        fetchPackCatalog: async () => ({ status: 'ok', rows: [pr({ slug: 'task-closure', recipe_refs: [] })] }),
        openPack,
      });
      await mount.panel.whenLoaded();
      await mount.panel.clickInstall('watch-task');
      expect(openPack).not.toHaveBeenCalled();
      expect(installBySlug).not.toHaveBeenCalled();
      mount.dispose();
    } finally { spy.mockRestore(); }
  });

  it('fails a missing bundle identity closed without single-recipe install', async () => {
    const bundle = 'recued-core/task-closure';
    const rows = [
      rr({ recipe_id: 'create-task', recipe_bundle: bundle }),
      rr({ recipe_id: 'watch-task', recipe_bundle: bundle }),
    ];
    const refs = rows.map((row) => ({ slug: row.recipe_id, version: row.version }));
    const installBySlug = vi.fn(async (slug: string) => ({
      result: { ok: true as const, recipe_id: slug, version: 1 },
    }));
    const openPack = vi.fn();
    const mount = mountRecipeDiscovery({
      host: makeEl('div') as unknown as HTMLElement,
      document: fakeDoc(),
      installBySlug,
      listInstalled: async () => ({ recipes: [] }),
      fetchCatalog: async () => ({ status: 'ok', rows }),
      fetchPackCatalog: async () => ({
        status: 'ok',
        rows: [pr({ slug: 'some-other-pack', recipe_refs: refs })],
      }),
      openPack,
    });
    await mount.panel.whenLoaded();
    await mount.panel.clickInstall('watch-task');

    expect(openPack).not.toHaveBeenCalled();
    expect(installBySlug).not.toHaveBeenCalled();
    expect(mount.panel.getInstallState('watch-task')).toBe('available');
    mount.dispose();
  });

  it('routes a marketplace recipe install intent through its bundled pack', async () => {
    const bundle = 'recued-core/task-closure';
    const rows = [
      rr({ recipe_id: 'create-task', recipe_bundle: bundle }),
      rr({ recipe_id: 'watch-task', recipe_bundle: bundle }),
    ];
    const installBySlug = vi.fn(async (slug: string) => ({
      result: { ok: true as const, recipe_id: slug, version: 1 },
    }));
    const openPack = vi.fn();
    const mount = mountRecipeDiscovery({
      host: makeEl('div') as unknown as HTMLElement,
      document: fakeDoc(),
      installBySlug,
      listInstalled: async () => ({ recipes: [] }),
      fetchCatalog: async () => ({ status: 'ok', rows }),
      fetchPackCatalog: async () => ({
        status: 'ok',
        rows: [pr({
          slug: 'task-closure',
          recipe_refs: rows.map((row) => ({ slug: row.recipe_id, version: row.version })),
        })],
      }),
      openPack,
      initialInstallRecipeId: 'watch-task',
    });
    await mount.panel.whenLoaded();
    await vi.waitFor(() => expect(openPack).toHaveBeenCalledWith('task-closure'));

    expect(openPack).toHaveBeenCalledTimes(1);
    expect(installBySlug).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('joins installed versions from recipe.list → update when catalog is newer', async () => {
    const host = makeEl('div');
    const { panel } = mountRecipeDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      installBySlug: vi.fn(async () => ({ result: { ok: true as const, recipe_id: 'x', version: 1 } })),
      listInstalled: vi.fn(async () => ({ recipes: [{ recipe_id: 'old', version: 1 }] })),
      fetchCatalog: async () => ({ status: 'ok', rows: [rr({ recipe_id: 'old', version: 3 })] }),
    });
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.getInstallState('old')).toBe('update');
    expect(panel.getUpdateCount()).toBe(1);
  });
});

describe('recipe-discovery deps flow', () => {
  const mountDeps = (dependsOn: string[] = ['recued-core.salesforce'], over: Record<string, unknown> = {}) => {
    const host = makeEl('div');
    const installPack = vi.fn(async () => ({ result: { ok: true } }));
    const installBySlug = vi.fn(async (slug: string) => ({ result: { ok: true as const, recipe_id: slug, version: 2 } }));
    let installedRows: Array<{ recipe_id: string; version: number }> = [];
    const listInstalled = vi.fn(async () => ({ recipes: installedRows }));
    const setInstalledRows = (rows: typeof installedRows) => { installedRows = rows; };
    const mount = mountRecipeDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      installBySlug,
      listInstalled,
      listPacks: async () => ({
        packs: [
          { slug: 'salesforce', publisher: 'recued-core', name: 'Salesforce', installed: false, requires: ['install_bulk_pack'], manifest: mkManifest({ slug: 'salesforce', service_kind: 'entity_platform' }) },
          { slug: 'hubspot', publisher: 'recued-core', name: 'HubSpot', installed: true, requires: [], manifest: mkManifest({ slug: 'hubspot', service_kind: 'entity_platform' }) },
        ],
      }),
      installPack,
      fetchCatalog: async () => ({ status: 'ok', rows: [rr({ recipe_id: 'deal-risk', version: 2, depends_on: dependsOn })] }),
      ...over,
    });
    return { ...mount, installPack, installBySlug, setInstalledRows };
  };

  it('a recipe with a MISSING dep opens the consent dialog (does not one-click)', async () => {
    const { panel, dialog, installBySlug } = mountDeps();
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(dialog).not.toBeNull();
    await panel.clickInstall('deal-risk');
    expect(dialog!.isOpen()).toBe(true);
    expect(dialog!.getSelectedPacks()).toEqual(['salesforce']); // hubspot already installed
    expect(installBySlug).not.toHaveBeenCalled(); // handed off, not one-click
    // handed off → the card stays available until the dialog confirms.
    expect(panel.getInstallState('deal-risk')).toBe('available');
  });

  it('confirming the dialog co-installs the pack, installs the recipe, then flips the card', async () => {
    const { panel, dialog, installPack, installBySlug, setInstalledRows } = mountDeps();
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    await panel.clickInstall('deal-risk');
    setInstalledRows([{ recipe_id: 'deal-risk', version: 2 }]); // server now reports it installed
    await dialog!.clickInstall();
    expect(installPack).toHaveBeenCalledWith({ slug: 'salesforce', granted_permissions: ['install_bulk_pack'] });
    expect(installBySlug).toHaveBeenCalledWith('deal-risk');
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.getInstallState('deal-risk')).toBe('installed');
  });

  // ── §7.1/§7.2 per-dep grant scope ────────────────────────────────
  const mountConnDeps = (opRisk: RiskTier = 'read') => {
    const host = makeEl('div');
    const installPack = vi.fn(async () => ({ result: { ok: true } }));
    const installBySlug = vi.fn(async (slug: string) => ({ result: { ok: true as const, recipe_id: slug, version: 2 } }));
    const mount = mountRecipeDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      installBySlug,
      listInstalled: async () => ({ recipes: [] }),
      listPacks: async () => ({
        packs: [{ slug: 'salesforce', publisher: 'recued-core', name: 'Salesforce', installed: false, requires: ['install_bulk_pack'], manifest: connManifest('salesforce', opRisk) }],
      }),
      installPack,
      fetchCatalog: async () => ({ status: 'ok', rows: [rr({ recipe_id: 'deal-risk', version: 2, depends_on: ['recued-core.salesforce'] })] }),
    });
    return { ...mount, installPack, installBySlug };
  };

  it('a connection-backed dep defaults Scope to You only → install_scope owner/read', async () => {
    const { panel, dialog, installPack } = mountConnDeps();
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    await panel.clickInstall('deal-risk');
    // The dep is connection-backed → a picker model exists, defaulting safely.
    expect(dialog!.getDepGrantModel('salesforce')).not.toBeNull();
    expect(dialog!.getDepScope('salesforce')).toBe('owner');
    expect(dialog!.getDepAccess('salesforce')).toBe('read');
    await dialog!.clickInstall();
    expect(installPack).toHaveBeenCalledWith({
      slug: 'salesforce',
      granted_permissions: ['install_bulk_pack'],
      install_scope: {
        access: 'read',
        audience: { owner: true, all_customers: false, all_other_contracts: false },
      },
    });
  });

  it('choosing Everyone fans the co-installed dep out (install_scope all_contracts)', async () => {
    const { panel, dialog, installPack } = mountConnDeps();
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    await panel.clickInstall('deal-risk');
    dialog!.setDepScope('salesforce', 'all_contracts');
    await dialog!.clickInstall();
    expect(installPack).toHaveBeenCalledWith({
      slug: 'salesforce',
      granted_permissions: ['install_bulk_pack'],
      install_scope: {
        access: 'read',
        audience: { owner: true, all_customers: true, all_other_contracts: true },
      },
    });
  });

  it('a recipe whose deps are ALL installed stays one-click (no dialog)', async () => {
    // depends only on hubspot, which the roster reports installed → nothing
    // missing → one-click, no consent dialog.
    const { panel, dialog, installBySlug } = mountDeps(['recued-core.hubspot']);
    await panel.whenLoaded();
    await Promise.resolve();
    await panel.clickInstall('deal-risk');
    expect(dialog!.isOpen()).toBe(false);
    expect(installBySlug).toHaveBeenCalledWith('deal-risk');
  });

  it('a recipe with NO deps installs one-click (no dialog)', async () => {
    const { panel, dialog, installBySlug } = mountDeps([]);
    await panel.whenLoaded();
    await Promise.resolve();
    await panel.clickInstall('deal-risk');
    expect(installBySlug).toHaveBeenCalledWith('deal-risk');
    expect(dialog!.isOpen()).toBe(false);
  });

  it('awaits the roster when Install races the initial load (empty-roster fix)', async () => {
    const host = makeEl('div');
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const mount = mountRecipeDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      installBySlug: vi.fn(async (slug: string) => ({ result: { ok: true as const, recipe_id: slug, version: 2 } })),
      listInstalled: async () => ({ recipes: [] }),
      // Roster stays EMPTY until released — simulating a click before it loads.
      listPacks: async () => {
        await gate;
        return { packs: [{ slug: 'salesforce', publisher: 'recued-core', name: 'Salesforce', installed: false, requires: ['install_bulk_pack'], manifest: mkManifest({ slug: 'salesforce', service_kind: 'entity_platform' }) }] };
      },
      installPack: vi.fn(async () => ({ result: { ok: true } })),
      fetchCatalog: async () => ({ status: 'ok', rows: [rr({ recipe_id: 'deal-risk', version: 2, depends_on: ['recued-core.salesforce'] })] }),
    });
    await mount.panel.whenLoaded();
    // Roster still gated (empty). install.run must await refreshRoster before it
    // resolves deps — else salesforce would resolve as unknown (not selectable).
    const p = mount.panel.clickInstall('deal-risk');
    release();
    await p;
    expect(mount.dialog!.getSelectedPacks()).toEqual(['salesforce']);
  });

  it('with the deps flow NOT wired (no listPacks/installPack) → one-click, dialog is null', async () => {
    const host = makeEl('div');
    const installBySlug = vi.fn(async (slug: string) => ({ result: { ok: true as const, recipe_id: slug, version: 2 } }));
    const { panel, dialog } = mountRecipeDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      installBySlug,
      listInstalled: async () => ({ recipes: [] }),
      fetchCatalog: async () => ({ status: 'ok', rows: [rr({ recipe_id: 'deal-risk', version: 2 })] }),
    });
    expect(dialog).toBeNull();
    await panel.whenLoaded();
    await panel.clickInstall('deal-risk');
    expect(installBySlug).toHaveBeenCalledWith('deal-risk');
  });
});
