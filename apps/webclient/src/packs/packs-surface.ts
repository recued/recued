/** Unified `#packs` surface — one list → detail (retires the `[Installed |
 *  Discover]` tab split).
 *
 *  Composition layer only (mirrors `discover/discovery-surface.ts`, but for
 *  list↔detail instead of two tabs): it owns two hosts + toggles visibility by
 *  selection. Both children stay MOUNTED across the toggle, so the browse list's
 *  search / filter / scroll survive a detail visit (the A1 promise) and the
 *  detail keeps its resolved manifest.
 *
 *   - LIST — the `discover` browse panel over the union corpus (catalog ∪ the
 *     installed roster), search / filter / sort / paging + install-state badges.
 *     A row click opens that pack's detail (install/uninstall live there — a pack
 *     install carries grants, so it can't be one-click).
 *   - DETAIL — the packs panel in `detailOnly` mode (`#packs/<slug>`), driven via
 *     `clickSelectPack`; its own selection changes (a row / Back) funnel back
 *     here through `onSelectSlug`, which toggles the hosts + syncs the hash.
 *
 *  The list + detail are supplied as factories so this stays a pure composition
 *  layer — `bootstrap-packs-route.ts` wires the real callers.
 */

import { resolvePackInput } from './bootstrap-packs-route.js';

export const PACKS_SURFACE_HOST_ATTR = 'data-recued-packs-surface';
export const PACKS_SURFACE_LIST_ATTR = 'data-recued-packs-surface-list';
export const PACKS_SURFACE_DETAIL_ATTR = 'data-recued-packs-surface-detail';
export const PACKS_SURFACE_ADD_INPUT_ATTR = 'data-recued-packs-surface-add-input';
export const PACKS_SURFACE_ADD_SUBMIT_ATTR = 'data-recued-packs-surface-add-submit';
export const PACKS_SURFACE_ADD_ERROR_ATTR = 'data-recued-packs-surface-add-error';

/** The subset of the detail panel's mount the surface drives + tears down. Both
 *  drivers route THROUGH the panel (which then fires `onSelectSlug`) so the
 *  panel's own selection + the surface's view never desync — critical because
 *  the panel's `selectPack` early-returns on a no-op re-select, so leaving its
 *  selection stale would strand a repeat open of the same slug. */
export interface PacksSurfaceDetailHandle {
  clickSelectPack(slug: string): void;
  clickBackToList(): void;
  dispose(): void;
}

export interface MountPacksSurfaceOptions {
  root: HTMLElement;
  document?: Document;
  /** Mount the browse list into `host`; a row click calls `onSelect(slug)`. */
  mountList: (
    host: HTMLElement,
    onSelect: (slug: string) => void,
  ) => { dispose: () => void };
  /** Mount the detail panel into `host`. `onSelectSlug` fires on the panel's own
   *  selection changes (a detail action / Back → null) — the single funnel the
   *  surface reacts to. */
  mountDetail: (
    host: HTMLElement,
    onSelectSlug: (slug: string | null) => void,
  ) => PacksSurfaceDetailHandle;
  /** Deep-link segment — open this pack's detail on mount (else the list). */
  initialSlug?: string;
  /** Fired AFTER an in-page selection change so the host can `replaceState` the
   *  `#packs/<slug>` (or bare `#packs`) hash + keep the router's `activeHash` in
   *  lockstep (no remount). Not called for the initial deep-link (hash already
   *  matches). */
  onNavigate?: (slug: string | null) => void;
  /** Render the "Add by slug / URL" affordance in the list header (a
   *  resolve-capable host). A marketplace slug / URL navigates to that pack's
   *  detail, which resolves it; an arbitrary URL surfaces the deferred-import
   *  notice inline. */
  enableAdd?: boolean;
}

export interface PacksSurfaceMount {
  /** The slug shown in DETAIL, or null in LIST view. */
  activeSlug(): string | null;
  /** Open a pack's detail (as a row click does). */
  goToDetail(slug: string): void;
  /** Return to the list (as the detail's Back does). */
  backToList(): void;
  dispose(): void;
}

const ADD_URL_DEFERRED =
  'Direct pack URLs aren’t supported yet — paste a marketplace slug.';
const ADD_EMPTY = 'Enter a pack slug.';

export const mountPacksSurface = (
  opts: MountPacksSurfaceOptions,
): PacksSurfaceMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error('mountPacksSurface: no document available — pass opts.document');
  }
  ensureStyles(doc);

  const root = doc.createElement('div');
  root.setAttribute(PACKS_SURFACE_HOST_ATTR, '');

  // ── List view (Add header + the browse list) ──────────────────────
  const listView = doc.createElement('div');
  listView.setAttribute(PACKS_SURFACE_LIST_ATTR, '');

  let addError: HTMLElement | null = null;
  const setAddError = (msg: string | null): void => {
    if (addError === null) return;
    addError.textContent = msg ?? '';
    addError.hidden = msg === null;
  };
  if (opts.enableAdd === true) {
    const addForm = doc.createElement('div');
    addForm.className = 'packs-surface-add';
    const input = doc.createElement('input') as HTMLInputElement;
    input.type = 'text';
    input.setAttribute(PACKS_SURFACE_ADD_INPUT_ATTR, '');
    input.className = 'packs-surface-add-input';
    input.placeholder = 'Add by slug or marketplace URL…';
    input.setAttribute('aria-label', 'Add a pack by slug or URL');
    const submit = doc.createElement('button') as HTMLButtonElement;
    submit.type = 'button';
    submit.setAttribute(PACKS_SURFACE_ADD_SUBMIT_ATTR, '');
    submit.className = 'rx-btn rx-btn-secondary rx-btn-sm packs-surface-add-submit';
    submit.textContent = 'Add';
    addError = doc.createElement('p');
    addError.setAttribute(PACKS_SURFACE_ADD_ERROR_ATTR, '');
    addError.setAttribute('role', 'alert');
    addError.className = 'packs-surface-add-error';
    addError.hidden = true;

    const runAdd = (): void => {
      const parsed = resolvePackInput(input.value);
      if (parsed === null) {
        setAddError(ADD_EMPTY);
        return;
      }
      if ('url' in parsed) {
        // Arbitrary (non-marketplace) URL — the local-import path is deferred.
        setAddError(ADD_URL_DEFERRED);
        return;
      }
      setAddError(null);
      input.value = '';
      goToDetail(parsed.slug); // the detail resolves + surfaces a bad slug
    };
    submit.addEventListener('click', runAdd);
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        (e as KeyboardEvent).preventDefault();
        runAdd();
      }
    });
    addForm.appendChild(input);
    addForm.appendChild(submit);
    listView.appendChild(addForm);
    listView.appendChild(addError);
  }

  const listHost = doc.createElement('div');
  listView.appendChild(listHost);

  // ── Detail host ───────────────────────────────────────────────────
  const detailHost = doc.createElement('div');
  detailHost.setAttribute(PACKS_SURFACE_DETAIL_ATTR, '');

  root.appendChild(listView);
  root.appendChild(detailHost);
  opts.root.appendChild(root);

  // Mount both children ONCE — neither is torn down on the toggle, so the list's
  // browse state + the detail's resolved manifest both survive.
  const listMount = opts.mountList(listHost, (slug) => goToDetail(slug));
  const detailMount = opts.mountDetail(detailHost, (slug) => handleSelection(slug));

  let active: string | null = opts.initialSlug ?? null;

  const paint = (): void => {
    const onDetail = active !== null;
    listView.hidden = onDetail;
    detailHost.hidden = !onDetail;
  };

  // The single funnel: the detail panel's own selection change (a row click we
  // drove, or its Back). Toggle the hosts + sync the hash.
  function handleSelection(slug: string | null): void {
    active = slug;
    paint();
    opts.onNavigate?.(slug);
  }

  function goToDetail(slug: string): void {
    setAddError(null);
    // Drive the panel; its onSelectSlug → handleSelection does the toggle + hash.
    detailMount.clickSelectPack(slug);
  }

  // Drive the panel to deselect (its Back does the same) so its selection +
  // the surface's view stay in lockstep; the panel's onSelectSlug(null) →
  // handleSelection(null) is the single funnel that toggles + syncs the hash.
  const backToList = (): void => detailMount.clickBackToList();

  // Initial paint — a deep-link opens the detail directly (the panel was mounted
  // with `initialSlug`, so it already shows it); no `onNavigate` (hash matches).
  paint();

  let disposed = false;
  return {
    activeSlug: () => active,
    goToDetail,
    backToList,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      detailMount.dispose();
      listMount.dispose();
      try {
        opts.root.removeChild(root);
      } catch {
        root.remove();
      }
    },
  };
};

const STYLES_MARKER = 'data-recued-packs-surface-styles';
const ensureStyles = (doc: Document): void => {
  if (doc.head?.querySelector?.(`style[${STYLES_MARKER}]`) != null) return;
  const style = doc.createElement('style');
  style.setAttribute(STYLES_MARKER, '');
  style.textContent = PACKS_SURFACE_STYLES;
  doc.head?.appendChild?.(style);
};

export const PACKS_SURFACE_STYLES = `
[${PACKS_SURFACE_HOST_ATTR}] { color: var(--fg); }
[${PACKS_SURFACE_LIST_ATTR}][hidden], [${PACKS_SURFACE_DETAIL_ATTR}][hidden] { display: none; }
[${PACKS_SURFACE_HOST_ATTR}] .packs-surface-add {
  display: flex; gap: 8px; align-items: center; margin-bottom: 14px;
  max-width: 620px; padding: 10px; border: 1px solid var(--border);
  border-radius: 12px; background: var(--surface);
}
[${PACKS_SURFACE_HOST_ATTR}] .packs-surface-add-input {
  box-sizing: border-box; flex: 1 1 240px; min-width: 0; font: inherit;
  font-size: 13px; color: var(--fg); background: var(--surface);
  border: 1px solid var(--border-strong); border-radius: var(--wc-radius, 6px);
  min-height: 40px; padding: 8px 11px;
}
[${PACKS_SURFACE_HOST_ATTR}] .packs-surface-add-input::placeholder { color: var(--fg-subtle); }
[${PACKS_SURFACE_HOST_ATTR}] .packs-surface-add-input:focus-visible {
  outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak);
}
[${PACKS_SURFACE_ADD_ERROR_ATTR}] {
  margin: 0 0 8px; font-size: 12px; color: var(--danger);
}
@media (max-width: 560px) {
  [${PACKS_SURFACE_HOST_ATTR}] .packs-surface-add { padding: 8px; }
  [${PACKS_SURFACE_HOST_ATTR}] .packs-surface-add-submit { flex: 0 0 auto; }
}
`;
