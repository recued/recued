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
  type FacetValueCount,
} from './discover-model.js';

export const DISCOVER_PANEL_HOST_ATTR = 'data-recued-discover-panel';
export const DISCOVER_PANEL_SEARCH_ATTR = 'data-recued-discover-search';
export const DISCOVER_PANEL_SORT_ATTR = 'data-recued-discover-sort';
export const DISCOVER_PANEL_FILTERS_ATTR = 'data-recued-discover-filters';
export const DISCOVER_PANEL_GRID_ATTR = 'data-recued-discover-grid';
export const DISCOVER_PANEL_PAGER_ATTR = 'data-recued-discover-pager';
export const DISCOVER_PANEL_PAGE_ATTR = 'data-recued-discover-page';
export const DISCOVER_PANEL_SUMMARY_ATTR = 'data-recued-discover-summary';
export const DISCOVER_PANEL_STATUS_ATTR = 'data-recued-discover-status';
export const DISCOVER_PANEL_CARD_ATTR = 'data-recued-discover-card';
export const DISCOVER_PANEL_ACTION_ATTR = 'data-recued-discover-action';
export const DISCOVER_PANEL_FACET_MORE_ATTR = 'data-recued-discover-facet-more';
export const DISCOVER_PANEL_FACET_SEARCH_ATTR = 'data-recued-discover-facet-search';
export const DISCOVER_PANEL_RETRY_ATTR = 'data-recued-discover-retry';
export const DISCOVER_PANEL_NOTICE_ATTR = 'data-recued-discover-notice';
export const DISCOVER_PANEL_PINNED_ATTR = 'data-recued-discover-pinned';

/** How long a keystroke waits before it becomes a request. Sort / facet / page
 *  changes are single deliberate acts and fire immediately. */
const DISCOVER_SEARCH_DEBOUNCE_MS = 220;

/** Keep the browse surface bounded even when a public catalog has thousands
 *  of distinct tags. Selected values are always retained in the inline row;
 *  the rest stay reachable through the per-facet finder. */
const DISCOVER_INLINE_FACET_LIMIT = 12;
const DISCOVER_FACET_SEARCH_LIMIT = 50;

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

/** One page of results, however they were computed. `runDiscover` produces this
 *  shape locally; `search` returns it from the server. The panel renders from
 *  it and nothing else, which is what keeps `render()` synchronous. */
export interface DiscoverView<Row> {
  pageRows: Row[];
  total: number;
  totalPages: number;
  page: number;
  facets: Record<string, FacetValueCount[]>;
  /** Rows the SERVER cannot know about — bundled on this server but absent
   *  from the marketplace catalogue. Rendered above the paged grid and outside
   *  the pager, because their rank among catalogue rows is not computable
   *  without the catalogue: pretending to interleave them would invent an
   *  ordering, and appending them to the last page would hide them. */
  pinned: Row[];
}

/** One server page, on the wire. Field-compatible with `catalog-client`'s
 *  `CatalogPage` (`rows`, not the view's `pageRows`) so a surface can forward a
 *  fetch result without renaming; the panel maps it into a `DiscoverView`. */
export interface DiscoverSearchPage<Row> {
  rows: Row[];
  total: number;
  totalPages: number;
  page: number;
  facets: Record<string, FacetValueCount[]>;
  pinned?: Row[];
}

export type DiscoverSearchOutcome<Row> =
  | { status: 'ok'; page: DiscoverSearchPage<Row> }
  | { status: 'error'; message: string };

export interface MountDiscoverPanelOptions<Row> {
  host: HTMLElement;
  document?: Document;
  /** The search/facet/sort engine spec for this row shape. */
  spec: DiscoverSpec<Row>;
  /** Download the corpus. Resolves `{ status: 'ok', rows }` or an error/no-op.
   *  With `search` wired this is no longer the load path — it is the FALLBACK,
   *  fetched lazily only when a search fails. */
  fetchCatalog: () => Promise<{ status: string; rows?: Row[]; message?: string }>;
  /** Server-side search. When wired, the panel asks the server for one page per
   *  interaction instead of downloading the corpus and running `runDiscover`
   *  over it — the only thing that scales past what a browser can hold.
   *
   *  `runDiscover` stays the definition of correct behaviour: the endpoint is
   *  proven equal to it by differential over the real corpus
   *  (`scripts/verify-discover-parity.mjs`), so the two paths below render the
   *  same answer and this seam is a transport choice, not a semantics choice. */
  search?: (query: DiscoverQuery) => Promise<DiscoverSearchOutcome<Row>>;
  /** Keystroke debounce in ms (default `DISCOVER_SEARCH_DEBOUNCE_MS`). Tests
   *  set 0 and await `whenIdle()`. */
  searchDebounceMs?: number;
  /** Current catalogue versions for the INSTALLED ROSTER — id → latest
   *  published version, resolved by the surface (`/catalog/versions`, one
   *  bounded request) and read synchronously here.
   *
   *  Server paging means the panel never holds the catalogue, so "N updates
   *  available" cannot be reduced out of it — reducing over the current page
   *  would undercount without ever looking wrong. The roster is what the badge
   *  is actually a fact about, and it is bounded. `null` = not resolved yet /
   *  lookup failed; the badge then stays hidden rather than asserting zero. */
  updateVersions?: () => ReadonlyMap<string, number> | null;
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
    /** Heading for the `pinned` group. Required by any surface that returns
     *  pinned rows — an unlabelled group would assert nothing about why those
     *  cards sit outside the paged results. */
    pinnedLabel?: string;
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
  /** Identities of the cards on screen, in render order (pinned rows first). */
  getRenderedIdentities(): string[];
  /** Identities of the pinned rows only — the ones outside the pager. */
  getPinnedIdentities(): string[];
  /** True when a search failed and the panel fell back to searching a
   *  downloaded corpus. Surfaced (not silent) so a degraded panel can't be
   *  mistaken for a working one. */
  isDegraded(): boolean;
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
  /** Move focus to the current action replacement for a row. Used by a
   *  handed-off consent dialog whose original opener was repainted. */
  focusAction(id: string): boolean;
  /** Navigate mode — simulate a card-body click (fires `onSelect`). No-op when
   *  `onSelect` isn't wired. */
  clickSelect(id: string): void;
  /** Re-run the current query (server mode) / re-download the corpus. */
  refresh(): Promise<void>;
  /** Re-attempt the server after a failure — clears any degraded fallback. */
  retry(): Promise<void>;
  /** Update the installed index (after a list rpc / a broadcast) + re-render so
   *  install-state badges reflect the new roster without a corpus re-fetch. */
  setInstalled(lookup: (slug: string) => number | null): void;
  whenLoaded(): Promise<void>;
  /** Resolves once no debounced or in-flight request is outstanding. */
  whenIdle(): Promise<void>;
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

  // The corpus. In server mode this stays EMPTY unless a failed search made the
  // panel fall back to it — which is the whole point: not holding the catalogue
  // is what scales.
  let rows: Row[] = [];
  let state: 'loading' | 'ready' | 'error' | 'empty' = 'loading';
  let error: string | null = null;
  let installedLookup = opts.installedVersion;
  const installing = new Set<string>();
  const expandedFacets = new Set<string>();
  const facetSearches = new Map<string, string>();
  let disposed = false;
  /** A search failed and the corpus took over. Sticky until `retry()` /
   *  `refresh()` — re-probing a down endpoint on every keystroke helps nobody. */
  let degraded = false;
  let retrying = false;
  let pendingRetryFocus = false;
  const debounceMs = opts.searchDebounceMs ?? DISCOVER_SEARCH_DEBOUNCE_MS;
  /** Server mode right now — false once degraded, so every downstream branch
   *  reads one predicate rather than re-deriving the condition. */
  const usingServer = (): boolean => opts.search !== undefined && !degraded;

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

  // ── "N updates available" ────────────────────────────────────
  // Corpus mode reduces over every row, because it HAS every row. Server mode
  // cannot — it holds one page, and reducing over that would undercount without
  // ever looking wrong. So the badge is computed the way it is actually
  // defined: over the installed roster, crossed with those ids' current
  // catalogue versions (`opts.updateVersions`, one bounded `/catalog/versions`
  // request the surface makes alongside its page fetch).
  const updateCount = (): number => {
    if (!usingServer()) {
      return rows.reduce((n, r) => (installStateOf(r) === 'update' ? n + 1 : n), 0);
    }
    const versions = opts.updateVersions?.() ?? null;
    if (versions === null) return 0;
    let n = 0;
    for (const [id, catalogVersion] of versions) {
      const installed = installedLookup(id);
      if (installed !== null && installed < catalogVersion) n += 1;
    }
    return n;
  };

  let view: DiscoverView<Row> | null = null;
  let renderedCards = new Map<string, HTMLElement>();
  let renderedActions = new Map<string, HTMLElement>();
  let renderedPageButtons = new Map<'prev' | 'next', HTMLButtonElement>();
  let renderedRetry: HTMLButtonElement | null = null;

  /** The status line, optionally with an affordance that re-attempts the server.
   *  An error the user cannot act on is a dead end, and after stage 4 there is
   *  no corpus left to fall back to — so the retry is part of the error, not a
   *  decoration on it. */
  const setStatus = (
    text: string,
    kind: 'info' | 'error' | 'notice' = 'info',
    withRetry = false,
  ): void => {
    const retryWasFocused = doc.activeElement === renderedRetry;
    renderedRetry = null;
    clear(status);
    status.className =
      kind === 'error'
        ? 'discover-status discover-status--error'
        : kind === 'notice'
          ? 'discover-status discover-status--notice'
          : 'discover-status';
    status.hidden = text === '';
    // Always stamped (never toggled off) so the hook reads the CURRENT kind
    // rather than the residue of a previous render.
    status.setAttribute(DISCOVER_PANEL_NOTICE_ATTR, kind);
    status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    status.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    if (text === '') return;
    const line = doc.createElement('span');
    line.className = 'discover-status-text';
    line.textContent = text;
    status.appendChild(line);
    // Only a LOAD failure gets a retry — an install failure is error-styled but
    // re-running the search would not address it, and a button that doesn't do
    // what it says is worse than no button.
    if (!withRetry) return;
    const retryBtn = doc.createElement('button') as HTMLButtonElement;
    retryBtn.type = 'button';
    retryBtn.setAttribute(DISCOVER_PANEL_RETRY_ATTR, '');
    retryBtn.className = 'discover-retry';
    retryBtn.textContent = retrying ? 'Retrying…' : 'Retry';
    if (retrying) {
      retryBtn.setAttribute('aria-disabled', 'true');
      retryBtn.setAttribute('aria-busy', 'true');
    }
    retryBtn.addEventListener('click', () => void retry());
    status.appendChild(retryBtn);
    renderedRetry = retryBtn;
    if (retryWasFocused) retryBtn.focus?.({ preventScroll: true });
    if (
      pendingRetryFocus
      && !retrying
      && (state === 'error' || degraded)
    ) {
      pendingRetryFocus = false;
      retryBtn.focus?.({ preventScroll: true });
    }
  };

  // ── Render ────────────────────────────────────────────────────────
  const renderFilters = (result: DiscoverView<Row>): void => {
    // Facet changes repaint the complete chip set twice in server mode: once
    // immediately, then again when the refreshed page lands. Remember the
    // focused facet owner so a keyboard toggle stays on its replacement rather
    // than being stranded on <body>. The same owner also covers collapsing a
    // large-facet finder back to its freshly-created "Find more" button.
    const focused = doc.activeElement as HTMLElement | null | undefined;
    const focusedFacet = focused?.getAttribute?.('data-facet') ?? null;
    const focusedValue = focused?.getAttribute?.('data-value') ?? null;
    const focusedMore = focused?.getAttribute?.(
      DISCOVER_PANEL_FACET_MORE_ATTR,
    ) ?? null;
    const focusOwner: { replacement: HTMLButtonElement | null } = {
      replacement: null,
    };
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

      const makeChip = (fv: (typeof values)[number]): HTMLButtonElement => {
        const chip = doc.createElement('button') as HTMLButtonElement;
        chip.type = 'button';
        const active = selected.includes(fv.value);
        chip.className = active ? 'discover-chip discover-chip--active' : 'discover-chip';
        chip.setAttribute('aria-pressed', active ? 'true' : 'false');
        chip.setAttribute('data-facet', group.key);
        chip.setAttribute('data-value', fv.value);
        chip.textContent = `${facetLabel(group.key, fv.value)} ${fv.count}`;
        if (focusedFacet === group.key && focusedValue === fv.value) {
          focusOwner.replacement = chip;
        }
        chip.addEventListener('click', (ev) => {
          ev.stopPropagation();
          toggleFilter(group.key, fv.value);
        });
        return chip;
      };

      // Selected values never disappear when they fall outside the most-used
      // inline set. Fill the remaining slots with the leading facet values.
      const selectedValues = values.filter((fv) => selected.includes(fv.value));
      const selectedSet = new Set(selectedValues.map((fv) => fv.value));
      const inlineValues = [
        ...selectedValues,
        ...values
          .filter((fv) => !selectedSet.has(fv.value))
          .slice(0, Math.max(0, DISCOVER_INLINE_FACET_LIMIT - selectedValues.length)),
      ];
      const inlineSet = new Set(inlineValues.map((fv) => fv.value));
      for (const fv of inlineValues) wrap.appendChild(makeChip(fv));

      if (values.length > inlineValues.length) {
        const expanded = expandedFacets.has(group.key);
        const more = doc.createElement('button') as HTMLButtonElement;
        more.type = 'button';
        more.className = 'discover-chip discover-chip--more';
        more.setAttribute(DISCOVER_PANEL_FACET_MORE_ATTR, group.key);
        more.setAttribute('aria-expanded', String(expanded));
        if (focusedMore === group.key) focusOwner.replacement = more;
        more.textContent = expanded
          ? `Hide ${group.label.toLocaleLowerCase()} finder`
          : `Find more ${group.label.toLocaleLowerCase()} values (${values.length - inlineValues.length})`;
        more.addEventListener('click', () => {
          if (expandedFacets.has(group.key)) expandedFacets.delete(group.key);
          else expandedFacets.add(group.key);
          renderFilters(result);
          if (!expanded) {
            const queryable = filters as HTMLElement & {
              querySelector?: (selector: string) => Element | null;
            };
            const nextSearch = queryable.querySelector?.(
              `[${DISCOVER_PANEL_FACET_SEARCH_ATTR}][data-facet="${group.key}"]`,
            ) as HTMLInputElement | null | undefined;
            nextSearch?.focus?.();
          }
        });
        wrap.appendChild(more);

        if (expanded) {
          const finder = doc.createElement('div');
          finder.className = 'discover-facet-finder';
          const finderSearch = doc.createElement('input') as HTMLInputElement;
          finderSearch.type = 'search';
          finderSearch.className = 'discover-facet-search';
          finderSearch.setAttribute(DISCOVER_PANEL_FACET_SEARCH_ATTR, '');
          finderSearch.setAttribute('data-facet', group.key);
          finderSearch.setAttribute(
            'aria-label',
            `Search ${values.length} ${group.label.toLocaleLowerCase()} values`,
          );
          finderSearch.placeholder = `Search ${values.length} ${group.label.toLocaleLowerCase()} values…`;
          finderSearch.value = facetSearches.get(group.key) ?? '';
          const finderStatus = doc.createElement('div');
          finderStatus.className = 'discover-facet-status';
          finderStatus.setAttribute('aria-live', 'polite');
          const finderResults = doc.createElement('div');
          finderResults.className = 'discover-facet-results';

          const renderFinderResults = (): void => {
            clear(finderResults);
            const needle = finderSearch.value.trim().toLocaleLowerCase();
            facetSearches.set(group.key, finderSearch.value);
            if (needle === '') {
              finderStatus.textContent = `Type to search all ${values.length} ${group.label.toLocaleLowerCase()} values.`;
              return;
            }
            const matches = values.filter((fv) => {
              if (inlineSet.has(fv.value)) return false;
              const haystack = `${facetLabel(group.key, fv.value)} ${fv.value}`.toLocaleLowerCase();
              return haystack.includes(needle);
            });
            for (const fv of matches.slice(0, DISCOVER_FACET_SEARCH_LIMIT)) {
              finderResults.appendChild(makeChip(fv));
            }
            finderStatus.textContent = matches.length === 0
              ? `No ${group.label.toLocaleLowerCase()} values match.`
              : matches.length > DISCOVER_FACET_SEARCH_LIMIT
                ? `Showing the first ${DISCOVER_FACET_SEARCH_LIMIT} of ${matches.length} matches.`
                : `${matches.length} match${matches.length === 1 ? '' : 'es'}.`;
          };
          finderSearch.addEventListener('input', renderFinderResults);
          finder.appendChild(finderSearch);
          finder.appendChild(finderStatus);
          finder.appendChild(finderResults);
          wrap.appendChild(finder);
          renderFinderResults();
        }
      }
      filters.appendChild(wrap);
    }
    focusOwner.replacement?.focus?.({ preventScroll: true });
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
      /** ⛔⛔ IN NAVIGATE MODE THIS IS A CONTROL, NOT A LABEL. The comment above has
       *  always said all three states read the same click → `onSelect(id)`, but the
       *  installed branch returned a bare `<span>` with NO listener — so on an
       *  installed pack the only affordance on the card was DEAD, and the one route
       *  into its detail (grants, uninstall) did not respond. The other two states
       *  are buttons and work; the state you reach after a successful install is the
       *  one that stops working, which is the worst place for it.
       *  ⚠ It also explains the height: a `<span>` is inline, so the shared
       *  `discover-action` padding produced a ~52px box with dead space under the
       *  text, against ~36px for the `<button>` states. Same element type ⇒ same box,
       *  rather than a CSS patch chasing one symptom of the wrong tag.
       *  ⚠ Outside navigate mode there is nothing to navigate TO, so it stays a
       *  resting badge — the marketplace install flow has no detail route here. */
      if (navigate === undefined) {
        const badge = doc.createElement('span');
        badge.setAttribute(DISCOVER_PANEL_ACTION_ATTR, '');
        badge.setAttribute('data-state', 'installed');
        badge.setAttribute('data-id', id);
        badge.className = 'discover-action discover-action--installed';
        badge.textContent = 'Installed ✓';
        renderedActions.set(id, badge);
        return badge;
      }
      const open = doc.createElement('button') as HTMLButtonElement;
      open.type = 'button';
      open.setAttribute(DISCOVER_PANEL_ACTION_ATTR, '');
      open.setAttribute('data-state', 'installed');
      open.setAttribute('data-id', id);
      open.className = 'discover-action discover-action--installed';
      open.textContent = 'Installed ✓';
      open.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onActionClick(id);
      });
      renderedActions.set(id, open);
      return open;
    }
    const btn = doc.createElement('button') as HTMLButtonElement;
    btn.type = 'button';
    btn.setAttribute(DISCOVER_PANEL_ACTION_ATTR, '');
    btn.setAttribute('data-id', id);
    btn.setAttribute('data-state', st);
    const busy = installing.has(id);
    if (busy && navigate === undefined) {
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('aria-busy', 'true');
    }
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
    renderedActions.set(id, btn);
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
    renderedCards.set(id, card);
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
    } else if (installStateOf(row) === 'installed') {
      // Installed inline cards are not Tab stops, but they are the durable
      // completion receipt if their focused Install action becomes the
      // non-interactive "Installed ✓" badge after reconciliation. Available
      // cards remain unfocusable so retry completion still lands on Install.
      card.setAttribute('tabindex', '-1');
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

  /** Rows the server has never heard of — bundled on this server but not in the
   *  marketplace catalogue. They match the SAME query (the surface runs
   *  `runDiscover` over that bounded set), but their rank relative to catalogue
   *  rows is unknowable without the catalogue, so they get their own labelled
   *  group instead of a fabricated position in the page. */
  const renderPinnedGroup = (pinned: Row[]): HTMLElement => {
    const wrap = doc.createElement('div');
    wrap.setAttribute(DISCOVER_PANEL_PINNED_ATTR, '');
    wrap.className = 'discover-pinned';
    const label = doc.createElement('div');
    label.className = 'discover-pinned-label';
    label.textContent = opts.copy.pinnedLabel ?? 'On this server';
    wrap.appendChild(label);
    const inner = doc.createElement('div');
    inner.className = 'discover-grid';
    for (const row of pinned) inner.appendChild(renderCard(row));
    wrap.appendChild(inner);
    return wrap;
  };

  const renderPager = (result: DiscoverView<Row>): void => {
    clear(pager);
    if (result.totalPages <= 1) return;
    const prev = doc.createElement('button') as HTMLButtonElement;
    prev.type = 'button';
    prev.className = 'discover-page-btn';
    prev.setAttribute(DISCOVER_PANEL_PAGE_ATTR, 'prev');
    renderedPageButtons.set('prev', prev);
    prev.textContent = '‹ Prev';
    prev.disabled = result.page <= 1;
    prev.addEventListener('click', () => setPage(result.page - 1));
    const label = doc.createElement('span');
    label.className = 'discover-page-label';
    label.textContent = `Page ${result.page} of ${result.totalPages}`;
    const next = doc.createElement('button') as HTMLButtonElement;
    next.type = 'button';
    next.className = 'discover-page-btn';
    next.setAttribute(DISCOVER_PANEL_PAGE_ATTR, 'next');
    renderedPageButtons.set('next', next);
    next.textContent = 'Next ›';
    next.disabled = result.page >= result.totalPages;
    next.addEventListener('click', () => setPage(result.page + 1));
    pager.appendChild(prev);
    pager.appendChild(label);
    pager.appendChild(next);
  };

  /** Is the query the untouched landing view? Distinguishes "nothing published"
   *  from "nothing matches", which corpus mode reads off `rows.length` and
   *  server mode cannot (it never sees a row it didn't ask for). */
  const isBlankQuery = (): boolean =>
    query.search.trim() === ''
    && Object.values(query.filters).every((v) => v.length === 0);

  /** Corpus mode's view — `runDiscover` remains the definition of correct
   *  behaviour, unchanged and still the unit-test surface. */
  const localView = (): DiscoverView<Row> => {
    const result: DiscoverResult<Row> = runDiscover(rows, opts.spec, query);
    query.page = result.page; // sync to the clamped page the engine chose
    return {
      pageRows: result.pageRows,
      total: result.total,
      totalPages: result.totalPages,
      page: result.page,
      facets: result.facets,
      pinned: [],
    };
  };

  // Synchronous by design. Server mode renders from `view`, which `refetch`
  // fills; making this async to await a request would ripple through every
  // caller (chip clicks, install completion, broadcasts) for no benefit, and
  // would flash the grid on each keystroke.
  const render = (): void => {
    const activeElement = doc.activeElement as HTMLElement | null | undefined;
    let focusedCardId: string | null = null;
    let focusedActionId: string | null = null;
    let focusedPageDirection: 'prev' | 'next' | null = null;
    if (activeElement !== null && activeElement !== undefined) {
      for (const [id, card] of renderedCards) {
        if (card === activeElement) {
          focusedCardId = id;
          break;
        }
      }
      for (const [id, action] of renderedActions) {
        if (action === activeElement) {
          focusedActionId = id;
          break;
        }
      }
      for (const [direction, button] of renderedPageButtons) {
        if (button === activeElement) {
          focusedPageDirection = direction;
          break;
        }
      }
    }
    renderedCards = new Map();
    renderedActions = new Map();
    renderedPageButtons = new Map();
    if (state === 'loading') {
      clear(grid);
      clear(pager);
      clear(filters);
      summary.hidden = true;
      setStatus(`Loading ${opts.copy.kindPlural}…`, 'info', retrying);
      return;
    }
    if (state === 'error') {
      clear(grid);
      clear(pager);
      clear(filters);
      summary.hidden = true;
      setStatus(error ?? 'Couldn’t load the marketplace.', 'error', true);
      return;
    }
    const result = usingServer() ? view : localView();
    if (result === null) {
      // Server mode before the first page landed — nothing to paint yet.
      setStatus(`Loading ${opts.copy.kindPlural}…`);
      return;
    }
    view = result;
    renderSummary();
    renderFilters(result);
    clear(grid);
    if (result.pinned.length > 0) {
      grid.appendChild(renderPinnedGroup(result.pinned));
    }
    if (result.total === 0 && result.pinned.length === 0) {
      const nothingPublished = usingServer() ? isBlankQuery() : rows.length === 0;
      setStatus(
        nothingPublished
          ? `No ${opts.copy.kindPlural} published yet.`
          : `No ${opts.copy.kindPlural} match your search.`,
      );
    } else if (degraded) {
      // Never silent: a panel searching a downloaded catalogue must not look
      // like one searching the marketplace.
      setStatus(
        `Marketplace search is unavailable — showing results from a downloaded ${opts.copy.kindPlural} catalogue.`,
        'notice',
        true,
      );
    } else {
      setStatus('');
    }
    for (const row of result.pageRows) grid.appendChild(renderCard(row));
    renderPager(result);
    const firstCard = renderedCards.values().next().value as HTMLElement | undefined;
    if (focusedActionId !== null) {
      const replacement = renderedActions.get(focusedActionId);
      if (
        replacement !== undefined
        && replacement.tagName === 'BUTTON'
      ) {
        replacement.focus?.({ preventScroll: true });
      } else {
        (renderedCards.get(focusedActionId) ?? firstCard ?? search)
          .focus?.({ preventScroll: true });
      }
    } else if (focusedCardId !== null) {
      const replacement = renderedCards.get(focusedCardId)
        ?? firstCard
        ?? search;
      replacement.focus?.({ preventScroll: true });
    } else if (focusedPageDirection !== null) {
      const same = renderedPageButtons.get(focusedPageDirection);
      const opposite = renderedPageButtons.get(
        focusedPageDirection === 'prev' ? 'next' : 'prev',
      );
      const replacement = same !== undefined && !same.disabled
        ? same
        : opposite !== undefined && !opposite.disabled
          ? opposite
          : firstCard ?? search;
      replacement.focus?.({ preventScroll: true });
    }
    if (pendingRetryFocus && !retrying) {
      pendingRetryFocus = false;
      const firstResultTarget = firstCard !== undefined
        && firstCard.getAttribute('tabindex') !== null
        ? firstCard
        : firstCard?.querySelector?.<HTMLElement>(
            `button[${DISCOVER_PANEL_ACTION_ATTR}]`,
          ) ?? search;
      firstResultTarget?.focus?.({ preventScroll: true });
    }
  };

  // ── Actions ───────────────────────────────────────────────────────
  // Install targets resolve from what is ON SCREEN. In corpus mode `rows` is
  // the whole catalogue, so this is the same set as before; in server mode the
  // corpus is not held and the current page + its pinned rows are precisely the
  // rows a click can originate from.
  const findRow = (id: string): Row | undefined => {
    const match = (r: Row): boolean => opts.identity(r) === id;
    return view?.pinned.find(match) ?? view?.pageRows.find(match) ?? rows.find(match);
  };

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
        setStatus(outcome.message ?? 'Install failed.', 'error');
      }
    } catch (err) {
      setStatus((err as Error)?.message ?? 'Install failed.', 'error');
    } finally {
      installing.delete(id);
      if (!disposed) render();
    }
  };

  /** Repaint immediately (chips flip, the grid keeps the previous page rather
   *  than flashing) and, in server mode, go fetch the answer. `delayMs` is the
   *  keystroke debounce; deliberate single acts pass 0. */
  const applyQueryChange = (delayMs: number): void => {
    if (usingServer()) scheduleRefetch(delayMs);
    render();
  };

  const setPage = (page: number): void => {
    query.page = Math.max(1, page);
    applyQueryChange(0);
  };

  const applySort = (key: string): void => {
    query.sort = key;
    query.page = 1;
    applyQueryChange(0);
  };

  const applySearch = (value: string): void => {
    query.search = value;
    query.page = 1;
    applyQueryChange(debounceMs);
  };

  const toggleFilter = (facetKey: string, value: string): void => {
    const current = query.filters[facetKey] ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    query.filters = { ...query.filters, [facetKey]: next };
    query.page = 1;
    applyQueryChange(0);
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

  // ── Server search ─────────────────────────────────────────────────
  // Shares `loadGeneration` with the corpus load above ON PURPOSE: a corpus
  // fallback and a search are two ways of answering the same question, and one
  // must be able to supersede the other. Last request wins, not last completion.
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let settleDebouncedRefetch: (() => void) | undefined;
  let idle: Promise<void> = Promise.resolve();

  const cancelDebouncedRefetch = (): void => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    settleDebouncedRefetch?.();
    settleDebouncedRefetch = undefined;
  };

  const scheduleRefetch = (delayMs: number): void => {
    cancelDebouncedRefetch();
    // The visible query changed NOW, even though its request starts after the
    // debounce. Invalidate an older in-flight answer immediately so it cannot
    // paint stale cards underneath the newer controls during that window.
    loadGeneration += 1;
    let settle: () => void = () => {};
    idle = new Promise<void>((resolve) => {
      settle = resolve;
    });
    settleDebouncedRefetch = settle;
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      const finish = (): void => {
        if (settleDebouncedRefetch === settle) settleDebouncedRefetch = undefined;
        settle();
      };
      void refetch(true).then(finish, finish);
    }, delayMs);
  };

  /** Ask the server for the current query's page. `background` keeps the
   *  current cards on screen while it runs (every interaction after the first),
   *  so paging and typing don't blank the grid. */
  const refetch = async (background: boolean): Promise<void> => {
    const searchFn = opts.search;
    if (searchFn === undefined) return;
    const gen = ++loadGeneration;
    if (!background) {
      state = 'loading';
      error = null;
      render();
    }
    const res = await searchFn({ ...query, filters: { ...query.filters } });
    if (disposed || gen !== loadGeneration) return;
    if (res.status === 'ok') {
      // Map the wire page (`rows`) into the render view (`pageRows`).
      view = {
        pageRows: res.page.rows,
        total: res.page.total,
        totalPages: Math.max(1, res.page.totalPages),
        page: res.page.page,
        facets: res.page.facets,
        pinned: res.page.pinned ?? [],
      };
      query.page = res.page.page; // sync to the clamped page the server chose
      state = view.total === 0 && view.pinned.length === 0 && isBlankQuery() ? 'empty' : 'ready';
      error = null;
      render();
      return;
    }
    await fallbackToCorpus(res.message, gen);
  };

  /** A search failed. While `description` still ships in `/catalog/*.json` the
   *  corpus can answer instead — insurance that disappears at stage 4, which is
   *  exactly why the error branch below has to stand on its own (a message the
   *  user can read and an affordance they can act on). */
  const fallbackToCorpus = async (message: string, gen: number): Promise<void> => {
    const res = await opts.fetchCatalog();
    if (disposed || gen !== loadGeneration) return;
    if (res.status === 'ok' && Array.isArray(res.rows)) {
      rows = res.rows;
      degraded = true;
      state = rows.length === 0 ? 'empty' : 'ready';
      error = null;
      render();
      return;
    }
    state = 'error';
    error = message;
    render();
  };

  const retry = async (): Promise<void> => {
    if (retrying) return;
    pendingRetryFocus = doc.activeElement === renderedRetry;
    retrying = true;
    try {
      if (opts.search === undefined) {
        await load(false);
        return;
      }
      degraded = false;
      rows = [];
      await refetch(false);
    } finally {
      retrying = false;
      if (!disposed) render();
    }
  };

  // ── Events ────────────────────────────────────────────────────────
  const onSearch = (): void => applySearch(search.value);
  const onSort = (): void => applySort(sortSelect.value);
  search.addEventListener('input', onSearch);
  sortSelect.addEventListener('change', onSort);

  let loaded = opts.search === undefined ? load() : refetch(false);

  return {
    getState: () => state,
    getRenderedIdentities: () =>
      [...(view?.pinned ?? []), ...(view?.pageRows ?? [])].map(opts.identity),
    getPinnedIdentities: () => (view?.pinned ?? []).map(opts.identity),
    isDegraded: () => degraded,
    getInstallState: (id) => {
      const row = findRow(id);
      return row === undefined ? null : installStateOf(row);
    },
    getTotal: () => view?.total ?? 0,
    getPage: () => query.page,
    getTotalPages: () => view?.totalPages ?? 1,
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
    focusAction: (id) => {
      const action = renderedActions.get(id);
      const target = action?.tagName === 'BUTTON'
        ? action
        : renderedCards.get(id);
      if (target === undefined || typeof target.focus !== 'function') {
        return false;
      }
      target.focus({ preventScroll: true });
      return true;
    },
    clickSelect: (id) => opts.onSelect?.(id),
    refresh: () => {
      // Background — a return-visit re-check keeps the current cards visible.
      // Server mode re-runs the CURRENT query rather than downloading a corpus;
      // the surface re-reads the roster's catalogue versions as part of that,
      // because a publish since the last visit is exactly what the update badge
      // is meant to notice.
      loaded = usingServer() ? refetch(true) : load(true);
      return loaded;
    },
    retry,
    setInstalled: (lookup) => {
      installedLookup = lookup;
      if (!disposed && (state === 'ready' || state === 'empty')) render();
    },
    whenLoaded: () => loaded,
    whenIdle: async () => {
      // Settle once NEITHER the load promise NOR the debounced-refetch promise
      // changes across an await. Both can be reassigned mid-await: a keystroke
      // lands a new `idle`, and a version-probe `onChange` → `refresh()` lands a
      // new `loaded`. Await both each pass until they're stable.
      let seenLoaded: Promise<unknown> | null = null;
      let seenIdle: Promise<void> | null = null;
      while (seenLoaded !== loaded || seenIdle !== idle) {
        seenLoaded = loaded;
        seenIdle = idle;
        await Promise.all([loaded, idle]);
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelDebouncedRefetch();
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
[${DISCOVER_PANEL_HOST_ATTR}] {
  box-sizing: border-box; display: grid; width: 100%; min-width: 0;
  max-width: 100%; gap: 16px;
}
[${DISCOVER_PANEL_HOST_ATTR}] > * { min-width: 0; max-width: 100%; }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-controls {
  box-sizing: border-box; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 10px; border: 1px solid var(--border); border-radius: 12px;
  background: var(--surface);
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-search {
  box-sizing: border-box; flex: 1 1 240px; min-width: 0; max-width: 100%; font: inherit;
  font-size: 13px; color: var(--fg); background: var(--surface);
  border: 1px solid var(--border-strong); border-radius: var(--wc-radius, 6px);
  min-height: 40px; padding: 8px 11px;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-search::placeholder { color: var(--fg-subtle); }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-search:focus-visible {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak);
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-sort {
  box-sizing: border-box; min-width: 0; max-width: 100%; font: inherit;
  font-size: 13px; color: var(--fg); background: var(--surface);
  border: 1px solid var(--border-strong); border-radius: var(--wc-radius, 6px);
  min-height: 40px; padding: 8px 11px;
}
[${DISCOVER_PANEL_SUMMARY_ATTR}] {
  box-sizing: border-box; max-width: 100%; font-size: 12px; font-weight: 650;
  color: var(--fg-muted); overflow-wrap: anywhere;
  border: 1px solid var(--border); background: var(--surface);
  border-radius: 999px; padding: 6px 12px; justify-self: start;
}
[${DISCOVER_PANEL_FILTERS_ATTR}] { min-width: 0; max-width: 100%; }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-chip-group {
  display: flex; flex-wrap: wrap; min-width: 0; max-width: 100%;
  gap: 6px; align-items: center; margin-bottom: 6px;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-chip-label {
  font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--fg-subtle); margin-right: 2px; overflow-wrap: anywhere;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-chip {
  box-sizing: border-box; min-width: 0; max-width: 100%; min-height: 36px;
  padding: 5px 11px; border: 1px solid var(--border); white-space: normal;
  border-radius: 999px; background: var(--surface); color: var(--fg-muted);
  font: inherit; font-size: 12px; cursor: pointer; overflow-wrap: anywhere;
  transition: border-color 90ms ease, background 90ms ease, color 90ms ease;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-chip:hover { border-color: var(--border-strong); color: var(--fg); }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-chip--active {
  border-color: var(--accent); background: var(--accent-weak); color: var(--fg); font-weight: 600;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-chip--more {
  border-style: dashed; color: var(--fg);
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-facet-finder {
  flex: 1 0 100%; box-sizing: border-box; display: grid; min-width: 0;
  max-width: 100%; gap: 8px;
  margin-top: 2px; padding: 10px; border: 1px solid var(--border);
  border-radius: 10px; background: var(--surface-sunk);
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-facet-search {
  box-sizing: border-box; width: min(100%, 360px); max-width: 100%; min-height: 40px;
  padding: 8px 11px; border: 1px solid var(--border-strong);
  border-radius: var(--wc-radius, 6px); background: var(--surface);
  color: var(--fg); font: inherit; font-size: 13px;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-facet-search:focus-visible {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak);
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-facet-status {
  min-width: 0; max-width: 100%; font-size: 12px; color: var(--fg-subtle);
  overflow-wrap: anywhere;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-facet-results {
  display: flex; flex-wrap: wrap; min-width: 0; max-width: 100%;
  align-items: center; gap: 6px;
  max-height: 220px; overflow: auto; overscroll-behavior: contain;
}
[${DISCOVER_PANEL_STATUS_ATTR}] {
  box-sizing: border-box; display: flex; flex-wrap: wrap; min-width: 0;
  max-width: 100%; align-items: center; gap: 10px;
  font-size: 13px; color: var(--fg-muted);
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-status-text {
  flex: 1 1 180px; min-width: 0; max-width: 100%; overflow-wrap: anywhere;
}
[${DISCOVER_PANEL_STATUS_ATTR}][hidden] { display: none; }
[${DISCOVER_PANEL_STATUS_ATTR}].discover-status--error {
  border-left: 3px solid var(--warn); padding-left: 8px; color: var(--warn);
}
/* Degraded — the marketplace search is down and a downloaded catalogue is
   answering instead. Real information, not a failure: bordered like the error
   line so it can't be missed, but on the neutral ramp so it doesn't read as
   broken. */
[${DISCOVER_PANEL_STATUS_ATTR}].discover-status--notice {
  border-left: 3px solid var(--border-strong); padding-left: 8px; color: var(--fg-muted);
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-retry {
  flex: 0 0 auto; font: inherit; font-size: 12px; font-weight: 650;
  min-height: 36px; padding: 4px 11px;
  border-radius: var(--wc-radius, 6px); border: 1px solid var(--border-strong);
  background: var(--surface); color: var(--fg); cursor: pointer;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-retry:hover { border-color: var(--accent); }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-retry:focus-visible {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak);
}
/* Pinned — rows this server has that the marketplace catalogue doesn't. Sits
   above the paged grid, outside the pager, with its own heading so the group
   explains itself rather than looking like page 1 in an odd order. */
[${DISCOVER_PANEL_PINNED_ATTR}] {
  box-sizing: border-box; grid-column: 1 / -1; display: grid; min-width: 0;
  max-width: 100%; gap: 10px; padding-bottom: 4px;
  border-bottom: 1px solid var(--border); margin-bottom: 4px;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-pinned-label {
  font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--fg-subtle); overflow-wrap: anywhere;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-grid {
  display: grid; min-width: 0; max-width: 100%;
  grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));
  gap: 12px; align-items: start;
}
[${DISCOVER_PANEL_CARD_ATTR}] {
  box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%;
  border: 1px solid var(--border); border-radius: 12px;
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
  display: flex; flex-wrap: wrap; min-width: 0; max-width: 100%;
  align-items: baseline; gap: 6px;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-card-title {
  min-width: 0; max-width: 100%; font-size: 15px; font-weight: 700;
  color: var(--fg); letter-spacing: -.01em; overflow-wrap: anywhere;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-badge {
  box-sizing: border-box; min-width: 0; max-width: 100%; font-size: 11px;
  padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border);
  color: var(--fg-muted); overflow-wrap: anywhere;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-badge--accent { border-color: var(--accent); color: var(--accent); }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-badge--danger { border-color: var(--danger); color: var(--danger); }
[${DISCOVER_PANEL_HOST_ATTR}] .discover-card-desc {
  min-width: 0; max-width: 100%; margin: 0; font-size: 13px;
  line-height: 1.45; color: var(--fg-muted); overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-card-foot {
  display: flex; min-width: 0; max-width: 100%; align-items: center;
  justify-content: space-between; gap: 8px;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-card-meta {
  flex: 1 1 180px; min-width: 0; max-width: 100%; font-size: 12px;
  color: var(--fg-subtle); overflow-wrap: anywhere;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-action {
  box-sizing: border-box; flex: 0 0 auto; max-width: 100%; min-height: 36px;
  font: inherit; font-size: 12px; font-weight: 650; padding: 7px 13px;
  border-radius: var(--wc-radius, 6px); border: 1px solid var(--accent);
  background: var(--accent); color: var(--on-accent); cursor: pointer; white-space: nowrap;
}
/* Update = the same solid-accent action as Install (monochrome shell); the
   up-arrow glyph + version delta in the label carry the "upgrade" meaning. */
[${DISCOVER_PANEL_HOST_ATTR}] .discover-action--installed {
  background: transparent; color: var(--fg-subtle); border-color: var(--border); cursor: default;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-action:is(:disabled, [aria-disabled="true"]) {
  opacity: .65; cursor: progress;
}
[${DISCOVER_PANEL_HOST_ATTR}] .discover-pager {
  display: flex; flex-wrap: wrap; min-width: 0; max-width: 100%;
  align-items: center; justify-content: center; gap: 12px; margin-top: 4px;
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
  [${DISCOVER_PANEL_HOST_ATTR}] .discover-grid { grid-template-columns: minmax(0, 1fr); }
  [${DISCOVER_PANEL_HOST_ATTR}] .discover-chip,
  [${DISCOVER_PANEL_HOST_ATTR}] .discover-page-btn { min-height: 44px; }
}
`;
