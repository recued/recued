/** Discover — generic browse panel (list · search · filter · sort · paging ·
 *  install / upgrade state).
 *
 *  One config-driven mount backs BOTH Discovery surfaces (`#packs` + `#recipes`
 *  → the Discovery tab). It downloads the catalog corpus once, then runs every
 *  interaction through the pure `runDiscover` engine (in-memory, no per-keystroke
 *  round-trip) and renders a paged card grid. Each card joins the row against the
 *  installed index (slug → installed version) to show one of three states:
 *    - available  → an Install button (→ the surface's `install.run`),
 *    - installed  → an "Installed ✓" resting badge,
 *    - update     → an "Update v{a}→v{b}" button (→ `upgrade.run ?? install.run`).
 *  A route-level summary surfaces "N updates available" so upgrades are visible
 *  without scanning. Install-state is derived, not fetched — the join is Slice 3:
 *  installed versions come from the surface's EXISTING list rpc (`packs.list` /
 *  `recipe.list`), the catalog version from the downloaded file.
 *
 *  DOM style follows the webclient house convention (className strings +
 *  `setAttribute('data-*')` test hooks + per-element listeners + `appendChild`) so
 *  it drives under the routes' minimal fake document as well as a real browser.
 *  Visual system mirrors the `#recipes` route (chips, search input, card grid).
 */

import {
  runDiscover,
  type DiscoverQuery,
  type DiscoverResult,
  type DiscoverSpec,
} from './discover-model.js';

export const DISCOVER_PANEL_HOST_ATTR = 'data-recued-discover-panel';
export const DISCOVER_PANEL_SEARCH_ATTR = 'data-recued-discover-search';
export const DISCOVER_PANEL_SORT_ATTR = 'data-recued-discover-sort';
export const DISCOVER_PANEL_FILTERS_ATTR = 'data-recued-discover-filters';
export const DISCOVER_PANEL_GRID_ATTR = 'data-recued-discover-grid';
export const DISCOVER_PANEL_PAGER_ATTR = 'data-recued-discover-pager';
export const DISCOVER_PANEL_SUMMARY_ATTR = 'data-recued-discover-summary';
export const DISCOVER_PANEL_STATUS_ATTR = 'data-recued-discover-status';
export const DISCOVER_PANEL_CARD_ATTR = 'data-recued-discover-card';
export const DISCOVER_PANEL_ACTION_ATTR = 'data-recued-discover-action';

// The shell is near-monochrome (D-174): ONE accent + ONE danger, no amber/green
// (`--warn`/`--ok` resolve to `--fg`). Meaning comes from glyph + label + weight,
// so badge tones stay on that palette.
export type BadgeTone = 'accent' | 'muted' | 'danger';
export interface DiscoverBadge {
  label: string;
  tone?: BadgeTone;
  title?: string;
}

/** The three derived install states a catalog row resolves to. */
export type InstallState = 'available' | 'installed' | 'update';

export interface DiscoverInstallOutcome {
  ok: boolean;
  message?: string;
  /** The action didn't complete inline — it handed off to a separate flow (e.g.
   *  a pack consent dialog). The panel then does NOT optimistically flip the
   *  card to installed; the eventual `setInstalled` (from a broadcast-driven
   *  re-list once the user confirms) reconciles the real state. */
  handedOff?: boolean;
}

export interface DiscoverFilterGroup {
  key: string;
  label: string;
}

export interface DiscoverSortOption {
  key: string;
  label: string;
}

export interface MountDiscoverPanelOptions<Row> {
  host: HTMLElement;
  document?: Document;
  /** The search/facet/sort engine spec for this row shape. */
  spec: DiscoverSpec<Row>;
  /** Download the corpus. Resolves `{ status: 'ok', rows }` or an error/no-op. */
  fetchCatalog: () => Promise<{ status: string; rows?: Row[]; message?: string }>;
  /** Stable id (slug / recipe_id) — the join key + the install action arg. */
  identity: (row: Row) => string;
  /** The catalog's latest version for a row. */
  catalogVersion: (row: Row) => number;
  /** Installed version for a slug, or null when not installed. Updated via
   *  `setInstalled`. Drives the derived install state. */
  installedVersion: (slug: string) => number | null;
  /** Row card body. */
  title: (row: Row) => string;
  description: (row: Row) => string;
  badges: (row: Row) => DiscoverBadge[];
  /** A dim one-liner under the description (publisher · downloads · …). */
  metaLine: (row: Row) => string;
  /** Which facets render as chip groups + their headings. */
  filterGroups: readonly DiscoverFilterGroup[];
  /** Sort options; the first is the default. */
  sortOptions: readonly DiscoverSortOption[];
  /** Install an available row. */
  install: {
    /** Static copy or a row-derived label (a recipe naming its workflow pack
     *  can say "Install workflow" while standalone rows stay "Install"). */
    label: string | ((row: Row) => string);
    run: (row: Row) => Promise<DiscoverInstallOutcome>;
  };
  /** Upgrade an outdated row (defaults to `install.run` when omitted — a
   *  re-install by slug pulls the latest version). */
  upgrade?: { run: (row: Row) => Promise<DiscoverInstallOutcome> };
  copy: {
    searchPlaceholder: string;
    /** Plural noun for the empty/summary copy ("packs" / "recipes"). */
    kindPlural: string;
  };
  perPage?: number;
  /** Chip-value → human label (e.g. a `service_kind` slug → "CRM"). Identity
   *  when omitted. */
  facetLabel?: (facetKey: string, value: string) => string;
  /** Navigate mode — when set, a card click (anywhere, INCLUDING its action
   *  affordance) fires `onSelect(id)` instead of installing inline. Used by the
   *  unified `#packs` surface where every row opens the `#packs/<slug>` detail
   *  and install/uninstall lives there (the detail owns the consent dialog +
   *  grants). Omitted ⇒ the classic inline-install behavior (the recipes
   *  Discover surface, where a row installs in place). */
  onSelect?: (id: string) => void;
}

export interface DiscoverPanelMount {
  getState(): 'loading' | 'ready' | 'error' | 'empty';
  /** Identities of the rows on the current page, in order. */
  getRenderedIdentities(): string[];
  getInstallState(id: string): InstallState | null;
  getTotal(): number;
  getPage(): number;
  getTotalPages(): number;
  getUpdateCount(): number;
  getError(): string | null;
  // Test/host drivers ───────────────────────────────────────────────
  setSearch(value: string): void;
  toggleFilter(facetKey: string, value: string): void;
  setSort(key: string): void;
  setPage(page: number): void;
  /** Drive the card's action affordance — navigates (navigate mode) or installs. */
  clickInstall(id: string): Promise<void>;
  /** Navigate mode — simulate a card-body click (fires `onSelect`). No-op when
   *  `onSelect` isn't wired. */
  clickSelect(id: string): void;
  /** Re-download the corpus. */
  refresh(): Promise<void>;
  /** Update the installed index (after a list rpc / a broadcast) + re-render so
   *  install-state badges reflect the new roster without a corpus re-fetch. */
  setInstalled(lookup: (slug: string) => number | null): void;
  whenLoaded(): Promise<void>;
  dispose(): void;
}

export const mountDiscoverPanel = <Row>(
  opts: MountDiscoverPanelOptions<Row>,
): DiscoverPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error('mountDiscoverPanel: no document available — pass opts.document');
  }
  const facetLabel = opts.facetLabel ?? ((_k: string, v: string) => v);

  let rows: Row[] = [];
  let state: 'loading' | 'ready' | 'error' | 'empty' = 'loading';
  let error: string | null = null;
  let installedLookup = opts.installedVersion;
  const installing = new Set<string>();
  let disposed = false;

  const query: DiscoverQuery = {
    search: '',
    filters: {},
    sort: opts.sortOptions[0]?.key ?? '',
    page: 1,
    perPage: opts.perPage ?? 24,
  };

  const clear = (el: HTMLElement): void => {
    while (el.firstChild) el.removeChild(el.firstChild);
  };

  // ── DOM scaffold ──────────────────────────────────────────────────
  const root = doc.createElement('div');
  root.setAttribute(DISCOVER_PANEL_HOST_ATTR, '');

  const controls = doc.createElement('div');
  controls.className = 'discover-controls';
  const search = doc.createElement('input') as HTMLInputElement;
  search.setAttribute(DISCOVER_PANEL_SEARCH_ATTR, '');
  search.className = 'discover-search';
  search.type = 'search';
  search.placeholder = opts.copy.searchPlaceholder;
  search.setAttribute('aria-label', opts.copy.searchPlaceholder);
  const sortSelect = doc.createElement('select') as HTMLSelectElement;
  sortSelect.setAttribute(DISCOVER_PANEL_SORT_ATTR, '');
  sortSelect.className = 'discover-sort';
  sortSelect.setAttribute('aria-label', 'Sort');
  for (const o of opts.sortOptions) {
    const opt = doc.createElement('option') as HTMLOptionElement;
    opt.value = o.key;
    opt.textContent = o.label;
    sortSelect.appendChild(opt);
  }
  controls.appendChild(search);
  controls.appendChild(sortSelect);

  const summary = doc.createElement('div');
  summary.setAttribute(DISCOVER_PANEL_SUMMARY_ATTR, '');
  summary.className = 'discover-summary';
  summary.hidden = true;

  const filters = doc.createElement('div');
  filters.setAttribute(DISCOVER_PANEL_FILTERS_ATTR, '');
  filters.className = 'discover-filters';

  const status = doc.createElement('div');
  status.setAttribute(DISCOVER_PANEL_STATUS_ATTR, '');
  status.className = 'discover-status';

  const grid = doc.createElement('div');
  grid.setAttribute(DISCOVER_PANEL_GRID_ATTR, '');
  grid.className = 'discover-grid';

  const pager = doc.createElement('div');
  pager.setAttribute(DISCOVER_PANEL_PAGER_ATTR, '');
  pager.className = 'discover-pager';

  root.appendChild(controls);
  root.appendChild(summary);
  root.appendChild(filters);
  root.appendChild(status);
  root.appendChild(grid);
  root.appendChild(pager);
  opts.host.appendChild(root);

  // ── Derived install state ─────────────────────────────────────────
  const installStateOf = (row: Row): InstallState => {
    const installed = installedLookup(opts.identity(row));
    if (installed === null) return 'available';
    return installed < opts.catalogVersion(row) ? 'update' : 'installed';
  };

  const updateCount = (): number =>
    rows.reduce((n, r) => (installStateOf(r) === 'update' ? n + 1 : n), 0);

  let last: DiscoverResult<Row> | null = null;

  const setStatus = (text: string, isError = false): void => {
    status.className = isError ? 'discover-status discover-status--error' : 'discover-status';
    status.textContent = text;
    status.hidden = text === '';
  };

  // ── Render ────────────────────────────────────────────────────────
  const renderFilters = (result: DiscoverResult<Row>): void => {
    clear(filters);
    for (const group of opts.filterGroups) {
      const values = result.facets[group.key] ?? [];
      if (values.length === 0) continue;
      const wrap = doc.createElement('div');
      wrap.className = 'discover-chip-group';
      const label = doc.createElement('span');
      label.className = 'discover-chip-label';
      label.textContent = group.label;
      wrap.appendChild(label);
      const selected = query.filters[group.key] ?? [];
      for (const fv of values) {
        const chip = doc.createElement('button') as HTMLButtonElement;
        chip.type = 'button';
        const active = selected.includes(fv.value);
        chip.className = active ? 'discover-chip discover-chip--active' : 'discover-chip';
        chip.setAttribute('aria-pressed', active ? 'true' : 'false');
        chip.setAttribute('data-facet', group.key);
        chip.setAttribute('data-value', fv.value);
        chip.textContent = `${facetLabel(group.key, fv.value)} ${fv.count}`;
        chip.addEventListener('click', (ev) => {
          ev.stopPropagation();
          toggleFilter(group.key, fv.value);
        });
        wrap.appendChild(chip);
      }
      filters.appendChild(wrap);
    }
  };

  const renderSummary = (): void => {
    const n = updateCount();
    summary.hidden = n === 0;
    summary.textContent = n === 0 ? '' : `↑ ${n} update${n === 1 ? '' : 's'} available`;
  };

  const actionButton = (row: Row): HTMLElement => {
    const id = opts.identity(row);
    const st = installStateOf(row);
    // Navigate mode — the action is a non-installing state indicator that opens
    // the detail (where install/uninstall + grants live). All three states read
    // the same click → `onSelect(id)`; the label stays informative (install /
    // update-delta / installed) so the list still surfaces "N updates available".
    const navigate = opts.onSelect;
    if (st === 'installed') {
      const badge = doc.createElement('span');
      badge.setAttribute(DISCOVER_PANEL_ACTION_ATTR, '');
      badge.setAttribute('data-state', 'installed');
      badge.setAttribute('data-id', id);
      badge.className = 'discover-action discover-action--installed';
      badge.textContent = 'Installed ✓';
      return badge;
    }
    const btn = doc.createElement('button') as HTMLButtonElement;
    btn.type = 'button';
    btn.setAttribute(DISCOVER_PANEL_ACTION_ATTR, '');
    btn.setAttribute('data-id', id);
    btn.setAttribute('data-state', st);
    const busy = installing.has(id);
    btn.disabled = busy && navigate === undefined;
    if (st === 'update') {
      btn.className = 'discover-action discover-action--update';
      const from = installedLookup(id);
      // Monochrome shell → the upgrade signal is the glyph + version delta, not a
      // hue. `↑` + "Update v{a}→v{b}" reads as an available upgrade at a glance.
      btn.textContent =
        busy && navigate === undefined
          ? 'Updating…'
          : `↑ Update v${from ?? '?'}→v${opts.catalogVersion(row)}`;
    } else {
      btn.className = 'discover-action discover-action--install';
      const installLabel = typeof opts.install.label === 'function'
        ? opts.install.label(row)
        : opts.install.label;
      btn.textContent =
        busy && navigate === undefined ? 'Installing…' : installLabel;
    }
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onActionClick(id);
    });
    return btn;
  };

  // The action affordance's click — navigate to the detail (navigate mode) or
  // install inline. Shared by the card button + the `clickInstall` test seam so
  // the seam mirrors a real click in either mode.
  const onActionClick = (id: string): void | Promise<void> => {
    if (opts.onSelect !== undefined) {
      opts.onSelect(id);
      return;
    }
    return runInstall(id);
  };

  const renderCard = (row: Row): HTMLElement => {
    const card = doc.createElement('div');
    const id = opts.identity(row);
    card.setAttribute(DISCOVER_PANEL_CARD_ATTR, '');
    card.setAttribute('data-id', id);
    card.className = 'discover-card';
    // Navigate mode — the whole card opens the detail. The "Installed ✓" badge
    // has no own handler, so its click bubbles here; the action button
    // stops-propagation + navigates itself (same destination).
    if (opts.onSelect !== undefined) {
      card.className = 'discover-card discover-card--clickable';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.addEventListener('click', () => opts.onSelect!(id));
      card.addEventListener('keydown', (ev) => {
        const key = (ev as KeyboardEvent).key;
        if (key === 'Enter' || key === ' ') {
          (ev as KeyboardEvent).preventDefault();
          opts.onSelect!(id);
        }
      });
    }

    const head = doc.createElement('div');
    head.className = 'discover-card-head';
    const title = doc.createElement('span');
    title.className = 'discover-card-title';
    title.textContent = opts.title(row);
    head.appendChild(title);
    for (const b of opts.badges(row)) {
      const badge = doc.createElement('span');
      badge.className = `discover-badge discover-badge--${b.tone ?? 'muted'}`;
      badge.textContent = b.label;
      if (b.title !== undefined) badge.title = b.title;
      head.appendChild(badge);
    }
    card.appendChild(head);

    const desc = opts.description(row);
    if (desc !== '') {
      const p = doc.createElement('p');
      p.className = 'discover-card-desc';
      p.textContent = desc;
      card.appendChild(p);
    }

    const foot = doc.createElement('div');
    foot.className = 'discover-card-foot';
    const meta = doc.createElement('span');
    meta.className = 'discover-card-meta';
    meta.textContent = opts.metaLine(row);
    foot.appendChild(meta);
    foot.appendChild(actionButton(row));
    card.appendChild(foot);
    return card;
  };

  const renderPager = (result: DiscoverResult<Row>): void => {
    clear(pager);
    if (result.totalPages <= 1) return;
    const prev = doc.createElement('button') as HTMLButtonElement;
    prev.type = 'button';
    prev.className = 'discover-page-btn';
    prev.textContent = '‹ Prev';
    prev.disabled = result.page <= 1;
    prev.addEventListener('click', () => setPage(result.page - 1));
    const label = doc.createElement('span');
    label.className = 'discover-page-label';
    label.textContent = `Page ${result.page} of ${result.totalPages}`;
    const next = doc.createElement('button') as HTMLButtonElement;
    next.type = 'button';
    next.className = 'discover-page-btn';
    next.textContent = 'Next ›';
    next.disabled = result.page >= result.totalPages;
    next.addEventListener('click', () => setPage(result.page + 1));
    pager.appendChild(prev);
    pager.appendChild(label);
    pager.appendChild(next);
  };

  const render = (): void => {
    if (state === 'loading') {
      clear(grid);
      clear(pager);
      clear(filters);
      summary.hidden = true;
      setStatus(`Loading ${opts.copy.kindPlural}…`);
      return;
    }
    if (state === 'error') {
      clear(grid);
      clear(pager);
      clear(filters);
      summary.hidden = true;
      setStatus(error ?? 'Couldn’t load the marketplace.', true);
      return;
    }
    const result = runDiscover(rows, opts.spec, query);
    last = result;
    query.page = result.page; // sync to the clamped page the engine chose
    renderSummary();
    renderFilters(result);
    clear(grid);
    if (result.total === 0) {
      setStatus(
        rows.length === 0
          ? `No ${opts.copy.kindPlural} published yet.`
          : `No ${opts.copy.kindPlural} match your search.`,
      );
    } else {
      setStatus('');
      for (const row of result.pageRows) grid.appendChild(renderCard(row));
    }
    renderPager(result);
  };

  // ── Actions ───────────────────────────────────────────────────────
  const findRow = (id: string): Row | undefined => rows.find((r) => opts.identity(r) === id);

  const runInstall = async (id: string): Promise<void> => {
    if (installing.has(id)) return;
    const row = findRow(id);
    if (row === undefined) return;
    const st = installStateOf(row);
    if (st === 'installed') return;
    installing.add(id);
    render();
    try {
      const runner = st === 'update' ? (opts.upgrade?.run ?? opts.install.run) : opts.install.run;
      const outcome = await runner(row);
      if (outcome.ok && outcome.handedOff !== true) {
        // Completed inline (e.g. a standalone recipe) — optimistically mark
        // installed at the catalog version so the badge flips immediately; a
        // later `setInstalled` from the real list rpc reconciles the number. A
        // handed-off action (a pack consent dialog) leaves the state alone; the
        // broadcast-driven re-list flips it once the user confirms.
        const prev = installedLookup;
        const catV = opts.catalogVersion(row);
        installedLookup = (slug) => (slug === id ? catV : prev(slug));
      } else if (!outcome.ok) {
        setStatus(outcome.message ?? 'Install failed.', true);
      }
    } catch (err) {
      setStatus((err as Error)?.message ?? 'Install failed.', true);
    } finally {
      installing.delete(id);
      if (!disposed) render();
    }
  };

  const setPage = (page: number): void => {
    query.page = Math.max(1, page);
    render();
  };

  const applySort = (key: string): void => {
    query.sort = key;
    query.page = 1;
    render();
  };

  const applySearch = (value: string): void => {
    query.search = value;
    query.page = 1;
    render();
  };

  const toggleFilter = (facetKey: string, value: string): void => {
    const current = query.filters[facetKey] ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    query.filters = { ...query.filters, [facetKey]: next };
    query.page = 1;
    render();
  };

  // ── Load ──────────────────────────────────────────────────────────
  // Monotonic guard so a stale in-flight load (a slow initial fetch resolving
  // AFTER a fast refresh — reachable via rapid Discover re-visits, each firing
  // refresh()) can't clobber the freshest corpus. Last request wins, not last
  // completion. Mirrors the packs panel's stale-load guard.
  let loadGeneration = 0;
  // `background` (a return-visit refresh) keeps the current rows on screen while
  // re-fetching — no "loading" flash, and a failed re-check keeps the last-good
  // corpus rather than blanking to an error. The first load is foreground.
  const load = async (background = false): Promise<void> => {
    const gen = ++loadGeneration;
    if (!background) {
      state = 'loading';
      error = null;
      render();
    }
    const res = await opts.fetchCatalog();
    if (disposed || gen !== loadGeneration) return;
    if (res.status === 'ok' && Array.isArray(res.rows)) {
      rows = res.rows;
      state = rows.length === 0 ? 'empty' : 'ready';
      error = null;
      render();
    } else if (!background) {
      state = 'error';
      error = res.message ?? 'Couldn’t reach the marketplace.';
      render();
    }
    // background + error → silently keep the last-good corpus.
  };

  // ── Events ────────────────────────────────────────────────────────
  const onSearch = (): void => applySearch(search.value);
  const onSort = (): void => applySort(sortSelect.value);
  search.addEventListener('input', onSearch);
  sortSelect.addEventListener('change', onSort);

  let loaded = load();

  return {
    getState: () => state,
    getRenderedIdentities: () => (last?.pageRows ?? []).map(opts.identity),
    getInstallState: (id) => {
      const row = findRow(id);
      return row === undefined ? null : installStateOf(row);
    },
    getTotal: () => last?.total ?? 0,
    getPage: () => query.page,
    getTotalPages: () => last?.totalPages ?? 1,
    getUpdateCount: () => updateCount(),
    getError: () => error,
    setSearch: (value) => {
      search.value = value;
      applySearch(value);
    },
    toggleFilter,
    setSort: (key) => {
      sortSelect.value = key;
      applySort(key);
    },
    setPage,
    clickInstall: async (id) => {
      await onActionClick(id);
    },
    clickSelect: (id) => opts.onSelect?.(id),
    refresh: () => {
      // Background — a return-visit re-check keeps the current cards visible.
      loaded = load(true);
      return loaded;
    },
    setInstalled: (lookup) => {
      installedLookup = lookup;
      if (!disposed && (state === 'ready' || state === 'empty')) render();
    },
    whenLoaded: () => loaded,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      search.removeEventListener('input', onSearch);
      sortSelect.removeEventListener('change', onSort);
      try {
        opts.host.removeChild(root);
      } catch {
        root.remove();
      }
    },
  };
};

/** Scoped styles — mirrors the `#recipes` route's chips / search / card grid so
 *  Discovery reads as one surface. Injected once by the route host. */
export const DISCOVER_PANEL_STYLES = `
[${DISCOVER_PANEL_HOST_ATTR}] { display: grid; gap: 16px; }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-controls {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 10px; border: 1px solid var(--border); border-radius: 12px;
  background: var(--surface);
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-search {
  box-sizing: border-box; flex: 1 1 240px; min-width: 0; font: inherit;
  font-size: 13px; color: var(--fg); background: var(--surface);
  border: 1px solid var(--border-strong); border-radius: var(--wc-radius, 6px);
  min-height: 40px; padding: 8px 11px;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-search::placeholder { color: var(--fg-subtle); }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-search:focus-visible {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak);
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-sort {
  font: inherit; font-size: 13px; color: var(--fg); background: var(--surface);
  border: 1px solid var(--border-strong); border-radius: var(--wc-radius, 6px);
  min-height: 40px; padding: 8px 11px;
}
[${DISCOVER_PANEL_SUMMARY_ATTR}] {
  font-size: 12px; font-weight: 650; color: var(--fg-muted);
  border: 1px solid var(--border); background: var(--surface);
  border-radius: 999px; padding: 6px 12px; justify-self: start;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-chip-group {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 6px;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-chip-label {
  font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--fg-subtle); margin-right: 2px;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-chip {
  min-height: 26px; padding: 2px 11px; border: 1px solid var(--border);
  border-radius: 999px; background: var(--surface); color: var(--fg-muted);
  font: inherit; font-size: 12px; cursor: pointer;
  transition: border-color 90ms ease, background 90ms ease, color 90ms ease;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-chip:hover { border-color: var(--border-strong); color: var(--fg); }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-chip--active {
  border-color: var(--accent); background: var(--accent-weak); color: var(--fg); font-weight: 600;
}
[${DISCOVER_PANEL_STATUS_ATTR}] { font-size: 13px; color: var(--fg-muted); }
[${DISCOVER_PANEL_STATUS_ATTR}].discover-status--error {
  border-left: 3px solid var(--warn); padding-left: 8px; color: var(--warn);
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px; align-items: start;
}
[${DISCOVER_PANEL_CARD_ATTR}] {
  min-width: 0; border: 1px solid var(--border); border-radius: 12px;
  background: var(--surface); padding: 16px; display: grid; gap: 10px;
  box-shadow: 0 1px 2px rgba(24,24,27,.035);
}
/* Navigate mode — the whole card opens the detail. */
[${DISCOVER_PANEL_HOST_ATTR}] .discover-card--clickable { cursor: pointer; transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease; }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-card--clickable:hover { border-color: var(--accent); box-shadow: 0 8px 22px rgba(24,24,27,.07); transform: translateY(-2px); }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-card--clickable:focus-visible {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak);
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-card-head {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-card-title { font-size: 15px; font-weight: 700; color: var(--fg); letter-spacing: -.01em; }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-badge {
  font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border);
  color: var(--fg-muted);
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-badge--accent { border-color: var(--accent); color: var(--accent); }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-badge--danger { border-color: var(--danger); color: var(--danger); }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-card-desc {
  margin: 0; font-size: 13px; line-height: 1.45; color: var(--fg-muted);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-card-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-card-meta { font-size: 12px; color: var(--fg-subtle); min-width: 0; }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-action {
  min-height: 36px; font: inherit; font-size: 12px; font-weight: 650; padding: 7px 13px;
  border-radius: var(--wc-radius, 6px); border: 1px solid var(--accent);
  background: var(--accent); color: var(--on-accent); cursor: pointer; white-space: nowrap;
}
/* Update = the same solid-accent action as Install (monochrome shell); the
   up-arrow glyph + version delta in the label carry the "upgrade" meaning. */
[${DISCOVER_PANEL_HOST_ATTR}] .discover-action--installed {
  background: transparent; color: var(--fg-subtle); border-color: var(--border); cursor: default;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-action:disabled { opacity: .65; cursor: progress; }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-pager {
  display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 4px;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-page-btn {
  font: inherit; font-size: 13px; padding: 5px 12px; border-radius: var(--wc-radius, 6px);
  border: 1px solid var(--border-strong); background: var(--surface); color: var(--fg); cursor: pointer;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-page-btn:disabled { opacity: .5; cursor: not-allowed; }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-page-label { font-size: 12px; color: var(--fg-muted); }
@media (max-width: 560px) {
  [${DISCOVER_PANEL_HOST_ATTR}] .discover-controls { padding: 8px; }
  [${DISCOVER_PANEL_HOST_ATTR}] .discover-sort { flex: 1 1 150px; }
  [${DISCOVER_PANEL_HOST_ATTR}] .discover-grid { grid-template-columns: 1fr; }
}
`;
