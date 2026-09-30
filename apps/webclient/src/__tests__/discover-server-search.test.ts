/** Discover — server-search mode (stage 2).
 *
 *  The panel keeps `runDiscover` as the definition of correct behaviour
 *  (proven equal to the endpoint by `scripts/verify-discover-parity.mjs`), so
 *  these tests do NOT re-check search semantics. They check the seam stage 2
 *  adds: the panel pages from an injected `search` instead of the corpus, keeps
 *  `render()` synchronous over a debounced refetch, drives the update badge from
 *  the installed roster's versions, renders pinned rows the server can't know
 *  about, and degrades visibly to the corpus when a search fails. */

import { describe, expect, it, vi } from 'vitest';

import {
  DISCOVER_PANEL_CARD_ATTR,
  DISCOVER_PANEL_NOTICE_ATTR,
  DISCOVER_PANEL_PINNED_ATTR,
  DISCOVER_PANEL_RETRY_ATTR,
  DISCOVER_PANEL_STATUS_ATTR,
  DISCOVER_PANEL_SUMMARY_ATTR,
  mountDiscoverPanel,
  type DiscoverSearchOutcome,
  type MountDiscoverPanelOptions,
} from '../discover/discover-panel.js';
import { byNumberDesc, byStringAsc, type DiscoverQuery, type DiscoverSpec } from '../discover/discover-model.js';
import { mountPackDiscovery } from '../discover/pack-discovery.js';
import { mountRecipeDiscovery } from '../discover/recipe-discovery.js';
import type { CatalogPackRow, CatalogRecipeRow } from '../discover/catalog-client.js';

// ── minimal fake DOM ────────────────────────────────────────────────
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
    hidden: false,
    get firstChild() { return children[0] ?? null; },
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    removeAttribute: (k: string) => attrs.delete(k),
    querySelector: () => null,
    appendChild: (c: any) => { c.parent = el; children.push(c); return c; },
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
    remove: () => { if (el.parent) el.parent.removeChild(el); },
    dispatch: (t: string, ev: unknown = {}) => {
      for (const fn of listeners.get(t) ?? []) fn(ev);
    },
  };
  return el;
};
const fakeDoc = () => {
  const head = makeEl('head');
  return { head, createElement: (tag: string) => makeEl(tag) } as unknown as Document;
};
const walk = (el: any, pred: (e: any) => boolean, out: any[] = []): any[] => {
  for (const c of el.children) {
    if (pred(c)) out.push(c);
    walk(c, pred, out);
  }
  return out;
};
const byAttr = (host: any, attr: string): any[] =>
  walk(host, (e) => e.getAttribute(attr) !== null);
const cardIds = (host: any): string[] =>
  byAttr(host, DISCOVER_PANEL_CARD_ATTR).map((c) => c.getAttribute('data-id'));
/** The status line renders its text in a child span (so a retry button can sit
 *  beside it), so the visible message is the concatenation of the div's text
 *  children — not the div's own (empty) textContent. */
const statusText = (host: any): string => {
  const status = byAttr(host, DISCOVER_PANEL_STATUS_ATTR)[0];
  return status === undefined ? '' : status.children.map((c: any) => c.textContent).join('');
};

// ── a tiny row shape + spec ─────────────────────────────────────────
interface Row { id: string; name: string; downloads: number; tag: string }
const spec: DiscoverSpec<Row> = {
  searchableText: (r) => `${r.name} ${r.tag}`,
  facets: [{ key: 'tag', values: (r) => [r.tag] }],
  sorters: {
    downloads: byNumberDesc((r) => r.downloads, (r) => r.id),
    name: byStringAsc((r) => r.name),
  },
};

const page = (
  rows: Row[],
  over: { total?: number; pinned?: Row[] } = {},
): DiscoverSearchOutcome<Row> => ({
  status: 'ok',
  page: {
    rows,
    total: over.total ?? rows.length,
    totalPages: 1,
    page: 1,
    facets: { tag: [{ value: 'a', count: rows.length }] },
    ...(over.pinned !== undefined ? { pinned: over.pinned } : {}),
  },
});

const baseOpts = (
  host: any,
  search: (q: DiscoverQuery) => Promise<DiscoverSearchOutcome<Row>>,
  over: Partial<MountDiscoverPanelOptions<Row>> = {},
): MountDiscoverPanelOptions<Row> => ({
  host: host as unknown as HTMLElement,
  document: fakeDoc(),
  spec,
  fetchCatalog: async () => ({ status: 'ok', rows: [] }),
  search,
  searchDebounceMs: 0,
  identity: (r) => r.id,
  catalogVersion: () => 1,
  installedVersion: () => null,
  title: (r) => r.name,
  description: () => '',
  badges: () => [],
  metaLine: () => '',
  filterGroups: [{ key: 'tag', label: 'Tag' }],
  sortOptions: [{ key: 'downloads', label: 'Most installed' }, { key: 'name', label: 'Name' }],
  install: { label: 'Install', run: async () => ({ ok: true }) },
  copy: { searchPlaceholder: 'Search…', kindPlural: 'rows', pinnedLabel: 'On this server' },
  ...over,
});

const r = (id: string, over: Partial<Row> = {}): Row => ({ id, name: id, downloads: 0, tag: 'a', ...over });

// ── panel server-search mechanics ───────────────────────────────────
describe('discover-panel — server search', () => {
  it('pages from `search`, not the corpus, and renders the returned page', async () => {
    const host = makeEl('div');
    const search = vi.fn(async () => page([r('b'), r('a')]));
    const panel = mountDiscoverPanel(baseOpts(host, search));
    await panel.whenIdle();
    // fetchCatalog was NOT called — the corpus is not downloaded in server mode.
    expect(search).toHaveBeenCalledTimes(1);
    expect(cardIds(host)).toEqual(['b', 'a']);
    expect(panel.getTotal()).toBe(2);
    panel.dispose();
  });

  it('re-queries the server on search / facet / sort / page — passing the query through', async () => {
    const host = makeEl('div');
    const seen: DiscoverQuery[] = [];
    const search = vi.fn(async (q: DiscoverQuery) => { seen.push(q); return page([r('a')]); });
    const panel = mountDiscoverPanel(baseOpts(host, search));
    await panel.whenIdle();

    panel.setSearch('deal');
    await panel.whenIdle();
    panel.toggleFilter('tag', 'a');
    await panel.whenIdle();
    panel.setSort('name');
    await panel.whenIdle();

    expect(seen.at(-3)).toMatchObject({ search: 'deal', page: 1 });
    expect(seen.at(-2)).toMatchObject({ filters: { tag: ['a'] } });
    expect(seen.at(-1)).toMatchObject({ sort: 'name' });
    panel.dispose();
  });

  it('a slow stale response cannot clobber a newer one (monotonic guard)', async () => {
    const host = makeEl('div');
    const gate: Array<() => void> = [];
    let n = 0;
    // Each call resolves to a distinct row, gated so the test controls COMPLETION
    // order independent of request order.
    const search = vi.fn(() => {
      const which = n++;
      return new Promise<DiscoverSearchOutcome<Row>>((resolve) => {
        gate.push(() => resolve(page([r(`call-${which}`)])));
      });
    });
    const panel = mountDiscoverPanel(baseOpts(host, search));
    await Promise.resolve();
    gate.shift()!();        // resolve the mount request (call-0)
    await Promise.resolve();

    // Two overlapping in-flight requests (`refresh` calls refetch directly, no
    // debounce): both are dispatched before either resolves.
    void panel.refresh();   // call-1
    void panel.refresh();   // call-2 — the NEWER request
    await Promise.resolve();
    expect(gate).toHaveLength(2);
    gate.pop()!();          // resolve call-2 (newer) first
    await Promise.resolve();
    gate.shift()!();        // then resolve call-1 (stale) — must be ignored
    await Promise.resolve();
    expect(cardIds(host)).toEqual(['call-2']);
    panel.dispose();
  });

  it('invalidates an in-flight response as soon as a newer search is queued', async () => {
    vi.useFakeTimers();
    const host = makeEl('div');
    const pending = new Map<string, (outcome: DiscoverSearchOutcome<Row>) => void>();
    const search = vi.fn((q: DiscoverQuery): Promise<DiscoverSearchOutcome<Row>> => {
      if (q.search === '') return Promise.resolve(page([r('initial')]));
      return new Promise((resolve) => pending.set(q.search, resolve));
    });
    const panel = mountDiscoverPanel(baseOpts(host, search, { searchDebounceMs: 100 }));

    try {
      await panel.whenIdle();
      panel.setSearch('first');
      await vi.advanceTimersByTimeAsync(100);
      expect(pending.has('first')).toBe(true);

      // The visible query has moved on, but its request has not started yet.
      // Resolving the old request in this debounce window must not paint its
      // cards underneath the newer search text.
      panel.setSearch('second');
      pending.get('first')!(page([r('first-result')]));
      await Promise.resolve();
      expect(cardIds(host)).toEqual(['initial']);

      await vi.advanceTimersByTimeAsync(100);
      pending.get('second')!(page([r('second-result')]));
      await panel.whenIdle();
      expect(cardIds(host)).toEqual(['second-result']);
    } finally {
      panel.dispose();
      vi.useRealTimers();
    }
  });

  it('settles an idle waiter when its queued search is superseded', async () => {
    vi.useFakeTimers();
    const host = makeEl('div');
    const search = vi.fn(async (q: DiscoverQuery) => page([r(q.search || 'initial')]));
    const panel = mountDiscoverPanel(baseOpts(host, search, { searchDebounceMs: 100 }));

    try {
      await panel.whenIdle();
      panel.setSearch('first');
      let settled = false;
      const waiting = panel.whenIdle().then(() => { settled = true; });

      panel.setSearch('second');
      await vi.advanceTimersByTimeAsync(100);
      await panel.whenIdle();
      await Promise.resolve();

      expect(settled).toBe(true);
      await waiting;
      expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'second' }));
    } finally {
      panel.dispose();
      vi.useRealTimers();
    }
  });

  it('drives "N updates available" from the roster versions, not the visible page', async () => {
    const host = makeEl('div');
    // The page shows ONE row, but two installed ids have newer catalogue
    // versions — the badge must count both, which a page-reduce could not.
    const search = vi.fn(async () => page([r('visible')]));
    const versions = new Map([['inst-a', 2], ['inst-b', 3], ['inst-c', 1]]);
    const panel = mountDiscoverPanel(baseOpts(host, search, {
      updateVersions: () => versions,
      installedVersion: (id) => ({ 'inst-a': 1, 'inst-b': 1, 'inst-c': 1 } as Record<string, number>)[id] ?? null,
    }));
    await panel.whenIdle();
    // inst-a (1<2) + inst-b (1<3) update; inst-c (1==1) does not.
    expect(panel.getUpdateCount()).toBe(2);
    const summary = byAttr(host, DISCOVER_PANEL_SUMMARY_ATTR)[0];
    expect(summary.hidden).toBe(false);
    expect(summary.textContent).toContain('2 updates available');
    panel.dispose();
  });

  it('renders pinned rows in their own group, outside the page count', async () => {
    const host = makeEl('div');
    const search = vi.fn(async () => page([r('cat-1')], { pinned: [r('local-only')] }));
    const panel = mountDiscoverPanel(baseOpts(host, search));
    await panel.whenIdle();
    expect(panel.getPinnedIdentities()).toEqual(['local-only']);
    // Rendered inside the pinned group container.
    const pinnedGroup = byAttr(host, DISCOVER_PANEL_PINNED_ATTR)[0];
    expect(pinnedGroup).toBeTruthy();
    expect(cardIds(pinnedGroup)).toEqual(['local-only']);
    // Both the pinned + the page row are on screen.
    expect(cardIds(host).sort()).toEqual(['cat-1', 'local-only']);
    // getTotal is the SERVER total, unaffected by pinned rows.
    expect(panel.getTotal()).toBe(1);
    panel.dispose();
  });

  it('a pinned install target resolves even though it is not in the server page', async () => {
    const host = makeEl('div');
    const run = vi.fn(async () => ({ ok: true }));
    const search = vi.fn(async () => page([r('cat-1')], { pinned: [r('local-only')] }));
    const panel = mountDiscoverPanel(baseOpts(host, search, { install: { label: 'Install', run } }));
    await panel.whenIdle();
    await panel.clickInstall('local-only');
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'local-only' }));
    panel.dispose();
  });

  it('D-315 — says what an install did beside installing, after the list repaints', async () => {
    const host = makeEl('div');
    const search = vi.fn(async () => page([r('cat-1')]));
    const run = vi.fn(async () => ({ ok: true, notice: 'Added the mail template “Shop parcels”; its AI is off.' }));
    const panel = mountDiscoverPanel(baseOpts(host, search, { install: { label: 'Install', run } }));
    await panel.whenIdle();
    await panel.clickInstall('cat-1');
    const status = byAttr(host, DISCOVER_PANEL_STATUS_ATTR)[0];
    expect(status.getAttribute(DISCOVER_PANEL_NOTICE_ATTR)).toBe('notice');
    expect(statusText(host)).toBe('Added the mail template “Shop parcels”; its AI is off.');
    panel.dispose();
  });

  it('falls back to the corpus on a search failure — visibly, with a retry', async () => {
    const host = makeEl('div');
    let failNext = true;
    const search = vi.fn(async (): Promise<DiscoverSearchOutcome<Row>> =>
      failNext ? { status: 'error', message: 'search down' } : page([r('served')]));
    const fetchCatalog = vi.fn(async () => ({ status: 'ok', rows: [r('corpus-1'), r('corpus-2')] }));
    const panel = mountDiscoverPanel(baseOpts(host, search, { fetchCatalog }));
    await panel.whenIdle();
    // Degraded to the corpus — its rows show, NOT an error blank.
    expect(panel.isDegraded()).toBe(true);
    expect(cardIds(host).sort()).toEqual(['corpus-1', 'corpus-2']);
    // The degraded state is announced (a notice), with a retry affordance.
    const status = byAttr(host, DISCOVER_PANEL_STATUS_ATTR)[0];
    expect(status.getAttribute(DISCOVER_PANEL_NOTICE_ATTR)).toBe('notice');
    expect(byAttr(host, DISCOVER_PANEL_RETRY_ATTR)).toHaveLength(1);

    // Retry — the server is back; degraded clears and it pages from search again.
    failNext = false;
    await panel.retry();
    await panel.whenIdle();
    expect(panel.isDegraded()).toBe(false);
    expect(cardIds(host)).toEqual(['served']);
    panel.dispose();
  });

  it('when both search AND the corpus fail, shows a standalone error + retry (no blank)', async () => {
    const host = makeEl('div');
    const search = vi.fn(async (): Promise<DiscoverSearchOutcome<Row>> => ({ status: 'error', message: 'search down' }));
    const fetchCatalog = vi.fn(async () => ({ status: 'error', message: 'offline too' }));
    const panel = mountDiscoverPanel(baseOpts(host, search, { fetchCatalog }));
    await panel.whenIdle();
    expect(panel.getState()).toBe('error');
    const status = byAttr(host, DISCOVER_PANEL_STATUS_ATTR)[0];
    expect(status.getAttribute(DISCOVER_PANEL_NOTICE_ATTR)).toBe('error');
    expect(statusText(host)).toContain('search down');
    expect(byAttr(host, DISCOVER_PANEL_RETRY_ATTR)).toHaveLength(1);
    panel.dispose();
  });

  it('keeps an explicit marketplace retry visible and single-flight', async () => {
    const host = makeEl('div');
    let resolveRetry!: (outcome: DiscoverSearchOutcome<Row>) => void;
    const retryResult = new Promise<DiscoverSearchOutcome<Row>>((resolve) => {
      resolveRetry = resolve;
    });
    const search = vi.fn<
      (query: DiscoverQuery) => Promise<DiscoverSearchOutcome<Row>>
    >()
      .mockResolvedValueOnce({ status: 'error', message: 'search down' })
      .mockImplementation(() => retryResult);
    const fetchCatalog = vi.fn(async () => ({
      status: 'error',
      message: 'offline too',
    }));
    const panel = mountDiscoverPanel(baseOpts(host, search, { fetchCatalog }));
    await panel.whenIdle();

    const firstRetry = panel.retry();
    const duplicateRetry = panel.retry();
    expect(search).toHaveBeenCalledTimes(2);
    const busyRetry = byAttr(host, DISCOVER_PANEL_RETRY_ATTR)[0];
    expect(busyRetry?.textContent).toBe('Retrying…');
    expect(busyRetry?.getAttribute('aria-disabled')).toBe('true');
    expect(busyRetry?.getAttribute('aria-busy')).toBe('true');

    resolveRetry(page([r('served')]));
    await Promise.all([firstRetry, duplicateRetry]);
    expect(cardIds(host)).toEqual(['served']);
    panel.dispose();
  });

  it('scopes install-target resolution to the current page (findRow does not read a corpus)', async () => {
    const host = makeEl('div');
    const run = vi.fn(async () => ({ ok: true }));
    const search = vi.fn(async () => page([r('on-page')]));
    const panel = mountDiscoverPanel(baseOpts(host, search, { install: { label: 'Install', run } }));
    await panel.whenIdle();
    // A click for a row NOT on the page is a no-op (there is no corpus to find it in).
    await panel.clickInstall('off-page');
    expect(run).not.toHaveBeenCalled();
    await panel.clickInstall('on-page');
    expect(run).toHaveBeenCalledTimes(1);
    panel.dispose();
  });
});

// ── pack surface — pinned bundled packs + version ids ───────────────
const cpr = (over: Partial<CatalogPackRow>): CatalogPackRow => ({
  slug: 'p', publisher_id: 'recued-core', name: 'P', description: '', version: 1,
  pack_kind: 'foundation', tags: [], download_count: 0, item_count: 0,
  recipe_refs: [], created_at: '2026-01-01', ...over,
});

describe('pack-discovery — server search', () => {
  it('pins a BUNDLED pack the catalogue does not list, and keeps it visible', async () => {
    const host = makeEl('div');
    // Roster: `tavily` is bundled locally; the catalogue (versions map) never
    // returns it → it is unpublished → it must still appear (pinned).
    const search = vi.fn(async (): Promise<DiscoverSearchOutcome<CatalogPackRow>> => ({
      status: 'ok',
      page: { rows: [cpr({ slug: 'sales-pack', version: 2 })], total: 1, totalPages: 1, page: 1, facets: {} },
    }));
    const versionsSeen: string[][] = [];
    const fetchVersions = vi.fn(async (ids: readonly string[]) => {
      versionsSeen.push([...ids]);
      // sales-pack is published (v2); tavily is NOT in the map.
      return { status: 'ok' as const, versions: new Map([['sales-pack', 2]]) };
    });
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      listInstalled: async () => ({
        packs: [
          { slug: 'sales-pack', version: 2, installed: false, manifest: { tags: [] } },
          { slug: 'tavily', version: 1, installed: false, manifest: { tags: [] } },
        ],
      }),
      search: search as never,
      fetchVersions,
      searchDebounceMs: 0,
    } as never);
    await panel.whenIdle();
    // The probe covered BOTH bundled slugs (that's how it learns tavily is absent).
    expect(versionsSeen[0]).toEqual(expect.arrayContaining(['sales-pack', 'tavily']));
    // tavily surfaced as a pinned row; the catalogue row stayed in the page.
    expect(panel.getPinnedIdentities()).toEqual(['tavily']);
    expect(cardIds(host).sort()).toEqual(['sales-pack', 'tavily']);
    dispose();
  });

  it('pins only on page 1 — a deep page is not a repeated featured strip', async () => {
    const host = makeEl('div');
    // The server reports we are on page 2.
    const search = vi.fn(async (): Promise<DiscoverSearchOutcome<CatalogPackRow>> => ({
      status: 'ok',
      page: { rows: [cpr({ slug: 'sales-pack', version: 2 })], total: 30, totalPages: 2, page: 2, facets: {} },
    }));
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      listInstalled: async () => ({
        packs: [{ slug: 'tavily', version: 1, installed: false, manifest: { tags: [] } }],
      }),
      search: search as never,
      fetchVersions: async () => ({ status: 'ok' as const, versions: new Map() }), // tavily unpublished
      searchDebounceMs: 0,
    } as never);
    await panel.whenIdle();
    // tavily IS an unpublished bundled pack, but we are on page 2 → not pinned.
    expect(panel.getPinnedIdentities()).toEqual([]);
    dispose();
  });

  it('does NOT pin a bundled pack the catalogue DOES list (no duplicate)', async () => {
    const host = makeEl('div');
    const search = vi.fn(async (): Promise<DiscoverSearchOutcome<CatalogPackRow>> => ({
      status: 'ok',
      page: { rows: [cpr({ slug: 'sales-pack', version: 2 })], total: 1, totalPages: 1, page: 1, facets: {} },
    }));
    const { panel, dispose } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      listInstalled: async () => ({
        packs: [{ slug: 'sales-pack', version: 2, installed: false, manifest: { tags: [] } }],
      }),
      search: search as never,
      // sales-pack IS published → present in the map → not pinned.
      fetchVersions: async () => ({ status: 'ok' as const, versions: new Map([['sales-pack', 2]]) }),
      searchDebounceMs: 0,
    } as never);
    await panel.whenIdle();
    expect(panel.getPinnedIdentities()).toEqual([]);
    expect(cardIds(host)).toEqual(['sales-pack']);
    dispose();
  });
});

// ── recipe surface — server search wiring ───────────────────────────
const crr = (over: Partial<CatalogRecipeRow>): CatalogRecipeRow => ({
  recipe_id: 'r', publisher_id: 'recued-core', name: 'R', description: '', type: '',
  version: 1, platforms: [], tags: [], download_count: 0, rating_avg: 0, rating_count: 0,
  created_at: '2026-01-01', depends_on: [], ...over,
});

describe('recipe-discovery — server search', () => {
  it('pages from `search` and drives the update badge from the installed roster', async () => {
    const host = makeEl('div');
    const search = vi.fn(async (): Promise<DiscoverSearchOutcome<CatalogRecipeRow>> => ({
      status: 'ok',
      page: { rows: [crr({ recipe_id: 'shown', version: 3 })], total: 1, totalPages: 1, page: 1, facets: {} },
    }));
    let versionIds: string[] = [];
    const { panel, dispose } = mountRecipeDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      installBySlug: async () => ({ result: { ok: true as const, recipe_id: 'x', version: 1 } }),
      // Installed recipe `old-one` at v1; catalogue has v2 → the badge counts it,
      // even though it is NOT on the visible page.
      listInstalled: async () => ({ recipes: [{ recipe_id: 'old-one', version: 1 }] }),
      search: search as never,
      fetchVersions: async (ids: readonly string[]) => {
        versionIds = [...ids];
        return { status: 'ok' as const, versions: new Map([['old-one', 2]]) };
      },
      searchDebounceMs: 0,
    } as never);
    await panel.whenIdle();
    // The version probe is fire-and-forget (roster refresh → resolve → re-render
    // via setInstalled), not tracked by whenIdle — flush the macrotask queue.
    await new Promise((r) => setTimeout(r, 0));
    expect(search).toHaveBeenCalled();
    expect(cardIds(host)).toEqual(['shown']);
    // The version probe was bounded to the installed roster.
    expect(versionIds).toEqual(['old-one']);
    expect(panel.getUpdateCount()).toBe(1);
    dispose();
  });

  it('renders no dead `type` filter group', async () => {
    const host = makeEl('div');
    const search = vi.fn(async (): Promise<DiscoverSearchOutcome<CatalogRecipeRow>> => ({
      status: 'ok',
      page: {
        rows: [crr({ recipe_id: 'a', platforms: ['hubspot'], tags: ['sales'] })],
        total: 1, totalPages: 1, page: 1,
        // The server would never emit a `type` facet; assert the client wouldn't
        // render one even if a stale payload did.
        facets: { platform: [{ value: 'hubspot', count: 1 }], type: [{ value: 'action', count: 1 }], tag: [{ value: 'sales', count: 1 }] },
      },
    }));
    const { panel, dispose } = mountRecipeDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      installBySlug: async () => ({ result: { ok: true as const, recipe_id: 'x', version: 1 } }),
      listInstalled: async () => ({ recipes: [] }),
      search: search as never,
      fetchVersions: async () => ({ status: 'ok' as const, versions: new Map() }),
      searchDebounceMs: 0,
    } as never);
    await panel.whenIdle();
    const chips = byAttr(host, 'data-facet');
    const facetKeys = new Set(chips.map((c: any) => c.getAttribute('data-facet')));
    expect(facetKeys.has('type')).toBe(false);
    expect(facetKeys.has('platform')).toBe(true);
    dispose();
  });
});

/** ⛔ Live-drive regression. "Installed only" swapped the SOURCE from the
 *  marketplace to the local roster and stopped there — it never filtered.
 *  `packs.list` returns the WHOLE bundled corpus (~950 rows, each carrying its
 *  own `installed` flag), not an installed-only roster, so the toggle showed
 *  every pack on disk and reported the corpus size as the count. The premise was
 *  written into a comment ("the roster IS the complete set of installed packs")
 *  and was simply false.
 *
 *  No test covered the FILTER — `packs-surface.test.ts` drives the toggle's
 *  plumbing (aria-pressed, the busy guard, the failure rollback) and never looks
 *  at which rows come back. */
describe('pack-discovery — Installed only actually filters', () => {
  it('returns only owned packs, and counts only those', async () => {
    const host = makeEl('div');
    const search = vi.fn(async (): Promise<DiscoverSearchOutcome<CatalogPackRow>> => ({
      status: 'ok',
      page: {
        rows: [cpr({ slug: 'sales-pack', version: 2 })],
        total: 1, totalPages: 1, page: 1, facets: {},
      },
    }));
    const { panel, dispose, setInstalledOnly } = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      listInstalled: async () => ({
        packs: [
          { slug: 'owned', version: 1, installed: true, manifest: { tags: [] } },
          // Owned at a DIFFERENT version than the disk bundle — still owned.
          { slug: 'owned-other-version', version: 3, installed: false, installed_any_version: true, manifest: { tags: [] } },
          // The corpus. Present in `packs[]`, NOT installed — the rows that used
          // to flood the filtered view.
          { slug: 'corpus-a', version: 1, installed: false, manifest: { tags: [] } },
          { slug: 'corpus-b', version: 1, installed: false, manifest: { tags: [] } },
        ],
        // A marketplace pack absent from `packs[]` entirely — the one case a
        // corpus scan cannot find, so it must be synthesized.
        installed_versions: [{ slug: 'mkt-owned', version: 7 }],
      }),
      search: search as never,
      fetchVersions: vi.fn(async () => ({ status: 'ok' as const, versions: new Map() })),
      searchDebounceMs: 0,
    } as never);
    await panel.whenIdle();
    const searchesBeforeToggle = search.mock.calls.length;

    await setInstalledOnly(true);
    await panel.whenIdle();

    expect(cardIds(host).sort()).toEqual(
      ['mkt-owned', 'owned', 'owned-other-version'],
    );
    // The count is the whole point of the complaint: it read 4 (the corpus),
    // not 3 (what you own).
    expect(panel.getTotal()).toBe(3);
    // ⛔ And the marketplace is not consulted for a filtered page — the roster is
    // the complete answer, so a network round-trip here would be both wasted and
    // wrong (the marketplace cannot know what THIS server has installed).
    expect(search.mock.calls.length).toBe(searchesBeforeToggle);

    // Negative control: switching back restores the marketplace page.
    await setInstalledOnly(false);
    await panel.whenIdle();
    expect(cardIds(host)).toContain('sales-pack');
    dispose();
  });
});

/** 🔑 Your own packs are the DEFAULT view. Browsing a marketplace is occasional;
 *  reaching for a pack you already installed is daily, and the toggle made the
 *  daily case the one that costs a click — every single visit. */
describe('pack-discovery — installed packs lead by default', () => {
  const mountWith = (
    packs: ReadonlyArray<Record<string, unknown>>,
    search: ReturnType<typeof vi.fn>,
  ) => {
    const host = makeEl('div');
    const seen: boolean[] = [];
    const m = mountPackDiscovery({
      host: host as unknown as HTMLElement,
      document: fakeDoc(),
      onSelect: vi.fn(),
      listInstalled: async () => ({ packs }),
      search: search as never,
      fetchVersions: vi.fn(async () => ({ status: 'ok' as const, versions: new Map() })),
      searchDebounceMs: 0,
    } as never) as unknown as {
      panel: { whenIdle: () => Promise<void> };
      setInstalledOnly: (on: boolean) => Promise<void>;
      onInstalledOnlyChange: (cb: (on: boolean) => void) => void;
      dispose: () => void;
    };
    m.onInstalledOnlyChange((on) => seen.push(on));
    return { host, seen, ...m };
  };
  const marketplace = () => vi.fn(async (): Promise<DiscoverSearchOutcome<CatalogPackRow>> => ({
    status: 'ok',
    page: {
      rows: [cpr({ slug: 'sales-pack', version: 2 })],
      total: 1, totalPages: 1, page: 1, facets: {},
    },
  }));

  it('opens on the installed packs, with no toggle press', async () => {
    const { host, seen, panel, dispose } = mountWith([
      { slug: 'owned', version: 1, installed: true, manifest: { tags: [] } },
      { slug: 'corpus-a', version: 1, installed: false, manifest: { tags: [] } },
    ], marketplace());
    await panel.whenIdle();
    expect(cardIds(host)).toEqual(['owned']);
    // ⛔ And the control is told, or it would claim "off" while the list filters
    // and the user's first press would appear to do nothing.
    expect(seen).toEqual([true]);
    dispose();
  });

  it('a server with nothing installed still opens on the marketplace', async () => {
    // Negative control. Defaulting into an empty list is a worse first run than
    // no default at all.
    const { host, seen, panel, dispose } = mountWith([
      { slug: 'corpus-a', version: 1, installed: false, manifest: { tags: [] } },
    ], marketplace());
    await panel.whenIdle();
    expect(cardIds(host)).toContain('sales-pack');
    expect(seen).toEqual([]);
    dispose();
  });

  it('⛔ a press made BEFORE the roster lands is not undone by the default', async () => {
    // The real race the user-set guard exists for. The toggle is on screen from
    // mount, but the default cannot be decided until the roster arrives — so a
    // press in that window would be silently reverted a moment later. Note this
    // is NOT covered by pressing after `whenIdle()`: by then the default has
    // already run once and its own once-guard would mask a missing user guard.
    const { host, panel, setInstalledOnly, dispose } = mountWith([
      { slug: 'owned', version: 1, installed: true, manifest: { tags: [] } },
    ], marketplace());
    await setInstalledOnly(false); // no `whenIdle()` first — that is the point
    await panel.whenIdle();
    expect(cardIds(host)).toContain('sales-pack');
    expect(cardIds(host)).not.toEqual(['owned']);
    dispose();
  });

  it('⛔ never yanks a user back out of the marketplace they opened', async () => {
    // The default must decide ONCE. A later query run — a keystroke, a
    // `pack_installed` broadcast — re-enters the same code path, and without the
    // user-set guard it would re-apply the default and undo the press.
    const search = marketplace();
    const { host, panel, setInstalledOnly, dispose } = mountWith([
      { slug: 'owned', version: 1, installed: true, manifest: { tags: [] } },
    ], search);
    await panel.whenIdle();
    expect(cardIds(host)).toEqual(['owned']);

    await setInstalledOnly(false);
    await panel.whenIdle();
    expect(cardIds(host)).toContain('sales-pack');

    // Re-run the query the way a broadcast refresh would.
    await (panel as unknown as { refresh: () => Promise<void> }).refresh();
    await panel.whenIdle();
    expect(cardIds(host)).toContain('sales-pack');
    dispose();
  });
});
