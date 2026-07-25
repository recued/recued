/** Discover — generic browse panel (mount) tests. Driven through the mount
 *  handle over a minimal fake document (webclient house style). */

import { describe, expect, it, vi } from 'vitest';

import {
  byNumberDesc,
  byStringAsc,
  type DiscoverSpec,
} from '../discover/discover-model.js';
import {
  DISCOVER_PANEL_CARD_ATTR,
  DISCOVER_PANEL_FACET_MORE_ATTR,
  DISCOVER_PANEL_FACET_SEARCH_ATTR,
  DISCOVER_PANEL_SUMMARY_ATTR,
  mountDiscoverPanel,
  type MountDiscoverPanelOptions,
} from '../discover/discover-panel.js';

// ── minimal fake DOM (only what the panel touches) ──────────────────
type El = ReturnType<typeof makeEl>;
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
    removeEventListener: (t: string, fn: (ev: unknown) => void) => {
      const a = listeners.get(t);
      if (a) {
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      }
    },
    remove: () => {
      if (el.parent) el.parent.removeChild(el);
    },
  };
  return el;
};
const fakeDoc = () => ({ createElement: (tag: string) => makeEl(tag) }) as unknown as Document;

const walk = (el: El, pred: (e: El) => boolean, out: El[] = []): El[] => {
  for (const c of el.children) {
    if (pred(c)) out.push(c);
    walk(c, pred, out);
  }
  return out;
};
const cardEls = (host: El): El[] =>
  walk(host, (e) => e.getAttribute(DISCOVER_PANEL_CARD_ATTR) !== null);
const summaryEl = (host: El): El | undefined =>
  walk(host, (e) => e.getAttribute(DISCOVER_PANEL_SUMMARY_ATTR) !== null)[0];

// ── corpus + spec ───────────────────────────────────────────────────
interface PackRow {
  slug: string;
  name: string;
  description: string;
  kind: string;
  tags: string[];
  downloads: number;
  version: number;
}
const pk = (over: Partial<PackRow>): PackRow => ({
  slug: 's',
  name: 'n',
  description: '',
  kind: 'entity',
  tags: [],
  downloads: 0,
  version: 1,
  ...over,
});
const corpus: PackRow[] = [
  pk({ slug: 'sales-pack', name: 'Sales', kind: 'entity', downloads: 100, version: 2 }),
  pk({ slug: 'mail-pack', name: 'Mail Digest', kind: 'channel', downloads: 50, version: 3 }),
  pk({ slug: 'installed-pack', name: 'Installed', kind: 'entity', downloads: 200, version: 5 }),
  pk({ slug: 'wf-pack', name: 'Workflow', kind: 'workflow', downloads: 10, version: 1 }),
];
const spec: DiscoverSpec<PackRow> = {
  searchableText: (r) => `${r.name} ${r.tags.join(' ')}`,
  facets: [{ key: 'kind', values: (r) => [r.kind] }],
  sorters: {
    downloads: byNumberDesc((r) => r.downloads, (r) => r.slug),
    name: byStringAsc((r) => r.name),
  },
};

const mount = (over: Partial<MountDiscoverPanelOptions<PackRow>> = {}) => {
  const host = makeEl('div');
  const install = { label: 'Install', run: vi.fn(async () => ({ ok: true })) };
  const upgrade = { run: vi.fn(async () => ({ ok: true })) };
  const panel = mountDiscoverPanel<PackRow>({
    host: host as unknown as HTMLElement,
    document: fakeDoc(),
    spec,
    fetchCatalog: async () => ({ status: 'ok', rows: corpus }),
    identity: (r) => r.slug,
    catalogVersion: (r) => r.version,
    // sales-pack installed at v1 (catalog v2 → update); installed-pack at v5
    // (catalog v5 → installed); others not installed (→ available).
    installedVersion: (slug) =>
      slug === 'sales-pack' ? 1 : slug === 'installed-pack' ? 5 : null,
    title: (r) => r.name,
    description: (r) => r.description,
    badges: () => [],
    metaLine: (r) => r.slug,
    filterGroups: [{ key: 'kind', label: 'Kind' }],
    sortOptions: [
      { key: 'downloads', label: 'Most installed' },
      { key: 'name', label: 'Name' },
    ],
    install,
    upgrade,
    copy: { searchPlaceholder: 'Search packs…', kindPlural: 'packs' },
    perPage: 24,
    ...over,
  });
  return { host, panel, install, upgrade };
};

describe('mountDiscoverPanel', () => {
  it('loads the corpus, renders cards, and derives install state per row', async () => {
    const { host, panel } = mount();
    await panel.whenLoaded();
    expect(panel.getState()).toBe('ready');
    expect(panel.getTotal()).toBe(4);
    expect(cardEls(host)).toHaveLength(4);
    expect(panel.getInstallState('mail-pack')).toBe('available');
    expect(panel.getInstallState('installed-pack')).toBe('installed');
    expect(panel.getInstallState('sales-pack')).toBe('update');
  });

  it('surfaces the update count in the summary', async () => {
    const { host, panel } = mount();
    await panel.whenLoaded();
    expect(panel.getUpdateCount()).toBe(1);
    const s = summaryEl(host);
    expect(s?.hidden).toBe(false);
    expect(s?.textContent).toBe('↑ 1 update available');
  });

  it('search filters + resets to page 1', async () => {
    const { panel } = mount();
    await panel.whenLoaded();
    panel.setPage(1);
    panel.setSearch('mail');
    expect(panel.getRenderedIdentities()).toEqual(['mail-pack']);
    expect(panel.getPage()).toBe(1);
  });

  it('filter chips narrow (OR within a facet)', async () => {
    const { panel } = mount();
    await panel.whenLoaded();
    panel.toggleFilter('kind', 'entity');
    expect(panel.getRenderedIdentities().sort()).toEqual(['installed-pack', 'sales-pack']);
    panel.toggleFilter('kind', 'workflow');
    expect(panel.getRenderedIdentities().sort()).toEqual(['installed-pack', 'sales-pack', 'wf-pack']);
    panel.toggleFilter('kind', 'entity'); // deselect
    expect(panel.getRenderedIdentities()).toEqual(['wf-pack']);
  });

  it('bounds large facet groups and keeps the remainder searchable', async () => {
    const largeCorpus = Array.from({ length: 40 }, (_, idx) =>
      pk({
        slug: `pack-${idx}`,
        name: `Pack ${idx}`,
        kind: `kind-${String(idx).padStart(2, '0')}`,
      }));
    const { host, panel } = mount({
      fetchCatalog: async () => ({ status: 'ok', rows: largeCorpus }),
    });
    await panel.whenLoaded();

    const inline = walk(
      host,
      (el) => el.getAttribute('data-facet') === 'kind'
        && el.getAttribute('data-value') !== null,
    );
    expect(inline).toHaveLength(12);
    const more = walk(
      host,
      (el) => el.getAttribute(DISCOVER_PANEL_FACET_MORE_ATTR) === 'kind',
    )[0];
    expect(more?.textContent).toContain('28');

    for (const listener of more?.listeners.get('click') ?? []) {
      listener({ stopPropagation: () => {} });
    }
    const finder = walk(
      host,
      (el) => el.getAttribute(DISCOVER_PANEL_FACET_SEARCH_ATTR) !== null,
    )[0];
    expect(finder).toBeDefined();
    finder.value = 'kind-39';
    for (const listener of finder.listeners.get('input') ?? []) listener({ target: finder });
    expect(walk(host, (el) => el.getAttribute('data-value') === 'kind-39')).toHaveLength(1);
  });

  it('sort reorders (default downloads desc → name asc)', async () => {
    const { panel } = mount();
    await panel.whenLoaded();
    expect(panel.getRenderedIdentities()).toEqual(['installed-pack', 'sales-pack', 'mail-pack', 'wf-pack']);
    panel.setSort('name');
    expect(panel.getRenderedIdentities()).toEqual(['installed-pack', 'mail-pack', 'sales-pack', 'wf-pack']);
  });

  it('paginates and clamps', async () => {
    const { panel } = mount({ perPage: 2 });
    await panel.whenLoaded();
    expect(panel.getTotalPages()).toBe(2);
    expect(panel.getRenderedIdentities()).toEqual(['installed-pack', 'sales-pack']);
    panel.setPage(2);
    expect(panel.getRenderedIdentities()).toEqual(['mail-pack', 'wf-pack']);
    panel.setPage(99);
    expect(panel.getPage()).toBe(2);
  });

  it('installs an available row → runs install.run → badge flips to installed', async () => {
    const { panel, install, upgrade } = mount();
    await panel.whenLoaded();
    await panel.clickInstall('mail-pack');
    expect(install.run).toHaveBeenCalledTimes(1);
    expect(upgrade.run).not.toHaveBeenCalled();
    expect(panel.getInstallState('mail-pack')).toBe('installed');
    expect(panel.getUpdateCount()).toBe(1); // unchanged
  });

  it('updates an outdated row → runs upgrade.run → resolves to installed', async () => {
    const { panel, install, upgrade } = mount();
    await panel.whenLoaded();
    await panel.clickInstall('sales-pack');
    expect(upgrade.run).toHaveBeenCalledTimes(1);
    expect(install.run).not.toHaveBeenCalled();
    expect(panel.getInstallState('sales-pack')).toBe('installed');
    expect(panel.getUpdateCount()).toBe(0);
  });

  it('falls back to install.run for an update when no upgrade runner is given', async () => {
    const { panel, install } = mount({ upgrade: undefined });
    await panel.whenLoaded();
    await panel.clickInstall('sales-pack');
    expect(install.run).toHaveBeenCalledTimes(1);
    expect(panel.getInstallState('sales-pack')).toBe('installed');
  });

  it('a handed-off install does NOT optimistically flip (waits for reconcile)', async () => {
    const install = { label: 'Install', run: vi.fn(async () => ({ ok: true, handedOff: true })) };
    const { panel } = mount({ install });
    await panel.whenLoaded();
    await panel.clickInstall('mail-pack');
    expect(install.run).toHaveBeenCalledTimes(1);
    // Still available — the consent flow hasn't confirmed; only a later
    // setInstalled (from the broadcast re-list) would flip it.
    expect(panel.getInstallState('mail-pack')).toBe('available');
    panel.setInstalled((slug) => (slug === 'mail-pack' ? 3 : null));
    expect(panel.getInstallState('mail-pack')).toBe('installed');
  });

  it('a failed install surfaces the message + leaves state unchanged', async () => {
    const install = { label: 'Install', run: vi.fn(async () => ({ ok: false, message: 'nope' })) };
    const { panel } = mount({ install });
    await panel.whenLoaded();
    await panel.clickInstall('mail-pack');
    expect(panel.getInstallState('mail-pack')).toBe('available');
    expect(panel.getError()).toBeNull(); // load error, not install error
  });

  it('setInstalled reconciles install-state without a re-fetch', async () => {
    const { panel } = mount();
    await panel.whenLoaded();
    expect(panel.getInstallState('mail-pack')).toBe('available');
    panel.setInstalled((slug) => (slug === 'mail-pack' ? 3 : null));
    expect(panel.getInstallState('mail-pack')).toBe('installed');
    expect(panel.getInstallState('sales-pack')).toBe('available'); // now unknown → available
  });

  it('error state when the fetch fails', async () => {
    const { panel } = mount({
      fetchCatalog: async () => ({ status: 'error', message: 'offline' }),
    });
    await panel.whenLoaded();
    expect(panel.getState()).toBe('error');
    expect(panel.getError()).toBe('offline');
    expect(panel.getTotal()).toBe(0);
  });

  it('empty state when the corpus is empty', async () => {
    const { panel } = mount({ fetchCatalog: async () => ({ status: 'ok', rows: [] }) });
    await panel.whenLoaded();
    expect(panel.getState()).toBe('empty');
  });

  it('a background refresh swaps in new rows (ok) and keeps last-good on failure', async () => {
    let call = 0;
    const { panel } = mount({
      fetchCatalog: async () => {
        call += 1;
        if (call === 1) return { status: 'ok', rows: corpus };
        if (call === 2) return { status: 'ok', rows: corpus.slice(0, 2) };
        return { status: 'error', message: 'offline' };
      },
    });
    await panel.whenLoaded();
    expect(panel.getTotal()).toBe(4);
    await panel.refresh(); // ok → swap
    expect(panel.getState()).toBe('ready');
    expect(panel.getTotal()).toBe(2);
    await panel.refresh(); // error → keep last-good, no error blanking
    expect(panel.getState()).toBe('ready');
    expect(panel.getTotal()).toBe(2);
    expect(panel.getError()).toBeNull();
  });

  it('drops a stale load that resolves after a newer one (generation guard)', async () => {
    const gates: Array<(v: unknown) => void> = [];
    const { panel } = mount({
      fetchCatalog: () => new Promise((res) => gates.push(res as (v: unknown) => void)),
    });
    // load #1 (mount) in flight → gates[0]; kick a superseding refresh → gates[1].
    const p2 = panel.refresh();
    // Resolve the NEWER load first (2 rows), then the STALE one (4 rows).
    gates[1]({ status: 'ok', rows: corpus.slice(0, 2) });
    await p2;
    expect(panel.getTotal()).toBe(2);
    gates[0]({ status: 'ok', rows: corpus });
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.getTotal()).toBe(2); // stale result ignored, not clobbered to 4
  });

  it('dispose removes the panel from its host', async () => {
    const { host, panel } = mount();
    await panel.whenLoaded();
    expect(host.children.length).toBe(1);
    panel.dispose();
    expect(host.children.length).toBe(0);
  });
});
