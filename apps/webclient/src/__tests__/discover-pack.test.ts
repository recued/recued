/** Discover — #packs Discovery config (spec/badges/meta + consent hand-off). */

import { describe, expect, it, vi } from 'vitest';

import {
  mountPackDiscovery,
  packBadges,
  packMeta,
  packSpec,
  projectRosterPackRow,
  unionCorpus,
} from '../discover/pack-discovery.js';
import type { CatalogPackRow } from '../discover/catalog-client.js';

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
    querySelector: () => null,
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
  };
  return el;
};
const fakeDoc = () => {
  const head = makeEl('head');
  return { head, createElement: (tag: string) => makeEl(tag) } as unknown as Document;
};

const pr = (over: Partial<CatalogPackRow>): CatalogPackRow => ({
  slug: 'p',
  publisher_id: 'recued-core',
  name: 'P',
  description: 'd',
  version: 1,
  pack_kind: 'foundation',
  tags: [],
  download_count: 0,
  item_count: 0,
  recipe_refs: [],
  created_at: '2026-01-01',
  ...over,
});

describe('pack-discovery config', () => {
  it('spec searches across name/description/tags/publisher/service_kind', () => {
    const t = packSpec.searchableText(pr({ name: 'Sales', tags: ['crm'], service_kind: 'entity_platform' }));
    expect(t).toContain('Sales');
    expect(t).toContain('crm');
    expect(t).toContain('entity_platform');
  });
  it('keeps tags searchable without rendering a tag filter', async () => {
    const host = makeEl('div');
    const tags = ['crm', 'sales-ops', 'pipeline'];
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      listInstalled: vi.fn(async () => ({ packs: [] })),
      fetchCatalog: async () => ({
        status: 'ok',
        rows: [
          pr({
            slug: 'tagged-pack',
            name: 'Tagged pack',
            service_kind: 'entity_platform',
            tags,
          }),
          pr({ slug: 'other-pack', name: 'Other pack', service_kind: 'workflow' }),
        ],
      }),
    });
    await panel.whenLoaded();

    const facetKeys: string[] = [];
    const collectFacetKeys = (node: ReturnType<typeof makeEl>): void => {
      const facet = node.getAttribute('data-facet');
      if (facet !== null) facetKeys.push(facet);
      for (const child of node.children) collectFacetKeys(child);
    };
    collectFacetKeys(host);
    expect(facetKeys).toContain('service_kind');
    expect(facetKeys).not.toContain('tag');

    panel.setSearch('sales-ops');
    expect(panel.getRenderedIdentities()).toEqual(['tagged-pack']);
    dispose();
  });
  it('restores the pack query after the browse route remounts', async () => {
    const document = fakeDoc();
    const rows = [
      pr({ slug: 'workflow-pack', name: 'Workflow pack', service_kind: 'workflow' }),
      pr({ slug: 'crm-pack', name: 'CRM pack', service_kind: 'entity_platform' }),
    ];
    const first = mountPackDiscovery({
      host: makeEl('div') as unknown as HTMLElement,
      document,
      onSelect: vi.fn(),
      listInstalled: vi.fn(async () => ({ packs: [] })),
      fetchCatalog: async () => ({ status: 'ok', rows }),
    });
    await first.panel.whenLoaded();
    first.panel.toggleFilter('service_kind', 'workflow');
    expect(first.panel.getRenderedIdentities()).toEqual(['workflow-pack']);
    first.dispose();

    const second = mountPackDiscovery({
      host: makeEl('div') as unknown as HTMLElement,
      document,
      onSelect: vi.fn(),
      listInstalled: vi.fn(async () => ({ packs: [] })),
      fetchCatalog: async () => ({ status: 'ok', rows }),
    });
    await second.panel.whenLoaded();

    expect(second.panel.getQuery().filters).toEqual({
      service_kind: ['workflow'],
    });
    expect(second.panel.getRenderedIdentities()).toEqual(['workflow-pack']);
    second.dispose();
  });
  it('badges: certified (accent) + humanized service_kind (muted)', () => {
    const b = packBadges(pr({ publisher_certified: true, service_kind: 'cli' }));
    expect(b[0]).toMatchObject({ label: '✓ Certified', tone: 'accent' });
    expect(b[1]).toMatchObject({ label: 'CLI', tone: 'muted' });
  });
  it('⛔⛔ A PRE-INSTALLED PACK SAYS SO — the owner did not choose it', () => {
    // Reported live: four `Reception —` packs on a server with nothing installed.
    // They are `pre_install: true` foundation packs that auto-install at every
    // boot, and the roster gave no way to tell them from packs the owner picked.
    const b = packBadges(pr({ slug: 'reception-intake' }), new Set(['reception-intake']));
    expect(b[0]).toMatchObject({ label: 'Included', tone: 'muted' });
    expect(b[0].title).toContain('every server boot');
  });

  it('⛔ AND A PACK THE OWNER CHOSE CARRIES NO SUCH BADGE', () => {
    expect(packBadges(pr({ slug: 'queue-desk' }), new Set(['reception-intake'])))
      .not.toContainEqual(expect.objectContaining({ label: 'Included' }));
    // ...nor when there is no roster to read at all (offline / first paint).
    expect(packBadges(pr({ slug: 'reception-intake' })))
      .not.toContainEqual(expect.objectContaining({ label: 'Included' }));
  });

  it('⛔ THE BADGE IS KEYED ON THE ROSTER, NOT ON THE PROJECTION', () => {
    // These packs are about to be PUBLISHED. Once they are, they arrive as
    // ordinary catalog rows rather than roster projections — a badge derived
    // from the projection would disappear at exactly that moment.
    const catalogRow = pr({ slug: 'mail-compose-foundation', download_count: 42 });
    expect(packBadges(catalogRow, new Set(['mail-compose-foundation']))[0])
      .toMatchObject({ label: 'Included' });
  });

  it('meta shows publisher · installs · items', () => {
    expect(packMeta(pr({ publisher_id: 'x', download_count: 1, item_count: 1 }))).toBe('x · 1 install · 1 item');
    expect(packMeta(pr({ publisher_id: 'x', download_count: 3, item_count: 5 }))).toBe('x · 3 installs · 5 items');
  });
  it('omits the installs chip entirely at 0 — never renders "0 installs"', () => {
    // See `recipeMeta`'s twin: absent, not zero-valued. Whole-string assert so
    // the items chip cannot mask a reappearing installs chip.
    expect(packMeta(pr({ publisher_id: 'x', download_count: 0, item_count: 5 }))).toBe('x · 5 items');
  });

  it('a row click navigates to the detail (does not flip state) + joins installed versions from packs.list', async () => {
    const host = makeEl('div');
    const onSelect = vi.fn();
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect,
      // sales-pack installed at v1 (catalog v2 → update); foundation installed
      // at v5 (=catalog → installed); other not installed.
      listInstalled: vi.fn(async () => ({
        packs: [
          { slug: 'sales-pack', version: 1, installed: true },
          { slug: 'foundation', version: 5, installed: true },
          { slug: 'unbundled', version: 9, installed: false },
        ],
      })),
      fetchCatalog: async () => ({
        status: 'ok',
        rows: [
          pr({ slug: 'sales-pack', version: 2 }),
          pr({ slug: 'foundation', version: 5 }),
          pr({ slug: 'unbundled', version: 9 }),
        ],
      }),
    });
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.getInstallState('sales-pack')).toBe('update');
    expect(panel.getInstallState('foundation')).toBe('installed');
    // installed:false in packs.list → not joined → available.
    expect(panel.getInstallState('unbundled')).toBe('available');

    // Navigate mode — the action affordance opens the detail (install lives
    // there); state is NOT optimistically flipped by the click.
    await panel.clickInstall('sales-pack');
    expect(onSelect).toHaveBeenCalledWith('sales-pack');
    expect(panel.getInstallState('sales-pack')).toBe('update');
    // A card-body click navigates too.
    panel.clickSelect('foundation');
    expect(onSelect).toHaveBeenCalledWith('foundation');
    dispose();
  });

  it('joins a MARKETPLACE-installed pack via installed_versions (absent from packs[])', async () => {
    const host = makeEl('div');
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      // `packs[]` (bundled) does NOT list these marketplace packs at all; their
      // installed versions arrive ONLY via the inventory `installed_versions`.
      listInstalled: vi.fn(async () => ({
        packs: [],
        installed_versions: [
          { slug: 'acme-crm', version: 1 }, // catalog v2 → update
          { slug: 'zenledger', version: 4 }, // catalog v4 → installed
        ],
      })),
      fetchCatalog: async () => ({
        status: 'ok',
        rows: [
          pr({ slug: 'acme-crm', version: 2, publisher_id: 'acme' }),
          pr({ slug: 'zenledger', version: 4, publisher_id: 'zen' }),
          pr({ slug: 'never-installed', version: 3 }),
        ],
      }),
    });
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    // Marketplace pack at an older version → upgrade offered.
    expect(panel.getInstallState('acme-crm')).toBe('update');
    // Marketplace pack at the catalog version → installed.
    expect(panel.getInstallState('zenledger')).toBe('installed');
    // Not in installed_versions → available (unchanged).
    expect(panel.getInstallState('never-installed')).toBe('available');
    dispose();
  });

  it('packs[] is authoritative for a bundled slug — a stale installed_versions row does NOT override it', async () => {
    const host = makeEl('div');
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      // `bundled-pack` is in packs[] as NOT installed (e.g. uninstalled — the
      // recipe-ownership join says gone) but a STALE inventory row lingers at
      // v1. The bundled join must win → available, not a phantom install/upgrade.
      listInstalled: vi.fn(async () => ({
        packs: [{ slug: 'bundled-pack', version: 1, installed: false }],
        installed_versions: [{ slug: 'bundled-pack', version: 1 }],
      })),
      fetchCatalog: async () => ({ status: 'ok', rows: [pr({ slug: 'bundled-pack', version: 2 })] }),
    });
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.getInstallState('bundled-pack')).toBe('available');
    dispose();
  });

  it('a bundled pack updated to the HIGHER marketplace version shows installed (not "available") via installed_any_version', async () => {
    // Server bundles hubspot v2; user updated to marketplace v5. packs.list:
    // installed=false (5≠disk 2) but installed_any_version=true (owned at v5);
    // the inventory carries the real v5. Must show installed, NOT flip to available.
    const host = makeEl('div');
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      listInstalled: vi.fn(async () => ({
        packs: [{ slug: 'hubspot', version: 2, installed: false, installed_any_version: true }],
        installed_versions: [{ slug: 'hubspot', version: 5 }],
      })),
      fetchCatalog: async () => ({ status: 'ok', rows: [pr({ slug: 'hubspot', version: 5 })] }),
    });
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.getInstallState('hubspot')).toBe('installed');
    dispose();
  });

  it('a bundled pack installed BELOW the marketplace version shows update (installed_any_version + inventory version)', async () => {
    const host = makeEl('div');
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      // installed v3 (owned, ≠ disk v2); marketplace catalog bumped to v5.
      listInstalled: vi.fn(async () => ({
        packs: [{ slug: 'hubspot', version: 2, installed: false, installed_any_version: true }],
        installed_versions: [{ slug: 'hubspot', version: 3 }],
      })),
      fetchCatalog: async () => ({ status: 'ok', rows: [pr({ slug: 'hubspot', version: 5 })] }),
    });
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.getInstallState('hubspot')).toBe('update'); // v3 → v5
    dispose();
  });

  it('a stale vendor-twin row (installed_any_version false) is still skipped → available', async () => {
    const host = makeEl('div');
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      // twin-b: not installed (recipes owned by twin-a) but a stale inventory row
      // lingers. installed_any_version=false → the inventory version must NOT join.
      listInstalled: vi.fn(async () => ({
        packs: [{ slug: 'twin-b', version: 1, installed: false, installed_any_version: false }],
        installed_versions: [{ slug: 'twin-b', version: 1 }],
      })),
      fetchCatalog: async () => ({ status: 'ok', rows: [pr({ slug: 'twin-b', version: 2 })] }),
    });
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.getInstallState('twin-b')).toBe('available');
    dispose();
  });

  it('an ADDITIVE marketplace upgrade (installed:true yet inventory higher) uses the inventory version → installed, not a false update', async () => {
    // The marketplace v5 added a recipe but left the server-bundled v2 recipe
    // unchanged, so packs.list still reports installed:true against the disk v2.
    // The inventory has the real v5 → the join must record v5 (not the disk v2),
    // else the catalog v5 card renders a phantom "update v2→v5".
    const host = makeEl('div');
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      listInstalled: vi.fn(async () => ({
        packs: [{ slug: 'hubspot', version: 2, installed: true, installed_any_version: true }],
        installed_versions: [{ slug: 'hubspot', version: 5 }],
      })),
      fetchCatalog: async () => ({ status: 'ok', rows: [pr({ slug: 'hubspot', version: 5 })] }),
    });
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.getInstallState('hubspot')).toBe('installed'); // v5 == catalog v5, NOT update
    dispose();
  });

  it('a bundled pack with NO inventory row (e.g. a foundation pack) falls back to its disk version', async () => {
    // Foundation packs are absent from the inventory; installed at the bundled v2
    // with the marketplace at v5 → update v2→v5 (disk version is the right fallback).
    const host = makeEl('div');
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      listInstalled: vi.fn(async () => ({
        packs: [{ slug: 'crm-foundation', version: 2, installed: true, installed_any_version: true }],
        installed_versions: [], // no inventory row
      })),
      fetchCatalog: async () => ({ status: 'ok', rows: [pr({ slug: 'crm-foundation', version: 5 })] }),
    });
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.getInstallState('crm-foundation')).toBe('update'); // disk v2 → catalog v5
    dispose();
  });
});

describe('pack-discovery — union corpus (catalog ∪ roster)', () => {
  it('unionCorpus adds roster rows absent from the catalog; catalog wins on a dup slug', () => {
    const catalog = [pr({ slug: 'in-both', name: 'Catalog Name', version: 5 })];
    const rows = unionCorpus(catalog, [
      { slug: 'in-both', version: 1, installed: true, name: 'Roster Name' },
      { slug: 'roster-only', version: 2, installed: true, name: 'Roster Only', publisher: 'acme' },
    ]);
    expect(rows.map((r) => r.slug).sort()).toEqual(['in-both', 'roster-only']);
    // Catalog row wins the dup (canonical display + install counts + latest version).
    expect(rows.find((r) => r.slug === 'in-both')!.name).toBe('Catalog Name');
    expect(rows.find((r) => r.slug === 'roster-only')!.name).toBe('Roster Only');
  });

  it('projectRosterPackRow falls back name→slug + carries service_kind/tags from the manifest', () => {
    const row = projectRosterPackRow({
      slug: 'x-pack',
      version: 1,
      installed: true,
      recipe_count: 4,
      manifest: { service_kind: 'entity_platform', pack_kind: 'foundation', tags: ['crm'] },
    });
    expect(row.name).toBe('x-pack'); // no name → slug fallback
    expect(row.service_kind).toBe('entity_platform');
    expect(row.item_count).toBe(4);
    expect(row.tags).toEqual(['crm']);
  });

  it('renders an INSTALLED roster pack absent from the catalog as a card (bundle not yet seeded)', async () => {
    const host = makeEl('div');
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      listInstalled: vi.fn(async () => ({
        packs: [
          { slug: 'not-seeded', version: 1, installed: true, name: 'Not Seeded', publisher: 'acme' },
        ],
      })),
      // Catalog doesn't carry it yet.
      fetchCatalog: async () => ({ status: 'ok', rows: [pr({ slug: 'other', version: 1 })] }),
    });
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    // The roster-only pack joined the corpus + reads as installed.
    expect(panel.getInstallState('not-seeded')).toBe('installed');
    expect(panel.getRenderedIdentities()).toContain('not-seeded');
    dispose();
  });

  it('offline (catalog fetch error) falls back to the roster corpus — never blanks to an error', async () => {
    const host = makeEl('div');
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      listInstalled: vi.fn(async () => ({
        packs: [{ slug: 'installed-a', version: 1, installed: true, name: 'Installed A' }],
      })),
      fetchCatalog: async () => ({ status: 'error', message: 'offline' }),
    });
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    // Not an error state — the installed pack is still listed from the roster.
    expect(panel.getState()).toBe('ready');
    expect(panel.getRenderedIdentities()).toContain('installed-a');
    expect(panel.getInstallState('installed-a')).toBe('installed');
    dispose();
  });

  it('a transient packs.list failure on a refresh KEEPS the last-known install-state (does not blank to Install)', async () => {
    let rosterCall = 0;
    const listInstalled = vi.fn(async () => {
      rosterCall += 1;
      if (rosterCall >= 2) throw new Error('transient rpc failure');
      return { packs: [{ slug: 'hubspot', version: 5, installed: true, name: 'HubSpot' }] };
    });
    const host = makeEl('div');
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      listInstalled,
      fetchCatalog: async () => ({ status: 'ok', rows: [pr({ slug: 'hubspot', version: 5 })] }),
    });
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.getInstallState('hubspot')).toBe('installed');

    // A broadcast-driven refresh whose packs.list rejects must NOT collapse the
    // lookup to empty (which would show the installed pack as "available").
    await panel.refresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.getInstallState('hubspot')).toBe('installed'); // last-known preserved
    dispose();
  });

  it('both catalog AND roster empty → surfaces the catalog error', async () => {
    const host = makeEl('div');
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      listInstalled: vi.fn(async () => ({ packs: [] })),
      fetchCatalog: async () => ({ status: 'error', message: 'offline' }),
    });
    await panel.whenLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.getState()).toBe('error');
    dispose();
  });
});
