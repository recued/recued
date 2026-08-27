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
import {
  DISCOVER_PANEL_ACTION_ATTR,
  DISCOVER_PANEL_CARD_ATTR,
} from '../discover/discover-panel.js';
import {
  LIST_PREVIEW_STYLES,
  mountListPreview,
  readListContinuity,
  readListScroll,
  restoreListScroll,
  updateListContinuity,
  type ListPreviewContent,
} from '../shell/list-preview-continuity.js';
import { PACK_BROWSE_CONTINUITY_KEY } from '../discover/pack-discovery.js';

export const PACKS_SURFACE_HOST_ATTR = 'data-recued-packs-surface';
export const PACKS_SURFACE_LIST_ATTR = 'data-recued-packs-surface-list';
export const PACKS_SURFACE_DETAIL_ATTR = 'data-recued-packs-surface-detail';
export const PACKS_SURFACE_ADD_INPUT_ATTR = 'data-recued-packs-surface-add-input';
export const PACKS_SURFACE_ADD_SUBMIT_ATTR = 'data-recued-packs-surface-add-submit';
export const PACKS_SURFACE_ADD_ERROR_ATTR = 'data-recued-packs-surface-add-error';
/** The installed-only filter toggle. The `[Installed | Discover]` tab split was
 *  retired for one list + a per-row badge; this is what replaces the TAB, since
 *  a badge tells you a row's state but gives you no way to ASK for your own
 *  packs across a 954-row paged corpus. */
export const PACKS_SURFACE_INSTALLED_ONLY_ATTR = 'data-recued-packs-surface-installed-only';
export const PACKS_SURFACE_INSTALLED_ONLY_ERROR_ATTR =
  'data-recued-packs-surface-installed-only-error';

/** The subset of the detail panel's mount the surface drives + tears down. Both
 *  drivers route THROUGH the panel (which then fires `onSelectSlug`) so the
 *  panel's own selection + the surface's view never desync — critical because
 *  the panel's `selectPack` early-returns on a no-op re-select, so leaving its
 *  selection stale would strand a repeat open of the same slug. */
export interface PacksSurfaceDetailHandle {
  clickSelectPack(slug: string): void;
  clickBackToList(): void;
  /** Optional readiness seam used by a direct detail mount: the surface first
   *  owns the detail host, then upgrades focus to its first real control. */
  whenLoaded?(): Promise<void>;
  dispose(): void;
}

export interface MountPacksSurfaceOptions {
  root: HTMLElement;
  document?: Document;
  /** Mount the browse list into `host`; a row click calls `onSelect(slug)`. */
  mountList: (
    host: HTMLElement,
    onSelect: (slug: string) => void,
    onPreview: (content: ListPreviewContent, opener: HTMLElement) => void,
  ) => {
    dispose: () => void;
    /** Optional readiness seam used to restore list state after a route remount. */
    whenLoaded?: () => Promise<void>;
    /** Switch the list between the marketplace corpus and the installed roster.
     *  Optional so a host that mounts a plain list (tests, a private mirror)
     *  still satisfies the contract — the toggle simply does not render. */
    setInstalledOnly?: (on: boolean) => Promise<void>;
    /** The list decides the installed-first default itself, once its roster
     *  lands — the host cannot know at mount time whether anything is installed.
     *  This is how the toggle learns it started pressed. Without it the list
     *  would filter while the control claimed it wasn't, and the first press
     *  would appear to do nothing. */
    onInstalledOnlyChange?: (cb: (on: boolean) => void) => void;
  };
  /** Mount the detail panel into `host`. `onSelectSlug` fires on the panel's own
   *  selection changes (a detail action / Back → null) — the single funnel the
   *  surface reacts to. */
  mountDetail: (
    host: HTMLElement,
    onSelectSlug: (slug: string | null) => void,
  ) => PacksSurfaceDetailHandle;
  /** Deep-link segment — open this pack's detail on mount (else the list). */
  initialSlug?: string;
  /** The route-owned scroll container. Browse and detail have independent
   *  reading positions even though they share one mounted surface: opening a
   *  card starts detail at the top, while Back restores the browse position. */
  scrollRoot?: HTMLElement;
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
  const continuityDocument: Document = doc;
  ensureStyles(doc);

  const root = doc.createElement('div');
  root.setAttribute(PACKS_SURFACE_HOST_ATTR, '');

  // ── List view (Add header + the browse list) ──────────────────────
  const listView = doc.createElement('div');
  listView.setAttribute(PACKS_SURFACE_LIST_ATTR, '');
  listView.setAttribute('tabindex', '-1');

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
      const event = e as KeyboardEvent;
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        runAdd();
      }
    });
    addForm.appendChild(input);
    addForm.appendChild(submit);
    listView.appendChild(addForm);
    listView.appendChild(addError);
  }

  // Installed-only toggle. Rendered only when the list can actually honour it,
  // so it is never a control that looks live and does nothing.
  const listHost = doc.createElement('div');
  let installedOnly = false;
  let installedOnlyBusy = false;
  const installedToggle = doc.createElement('button');
  installedToggle.type = 'button';
  installedToggle.setAttribute(PACKS_SURFACE_INSTALLED_ONLY_ATTR, '');
  installedToggle.className = 'packs-surface-installed-toggle';
  installedToggle.textContent = 'Installed only';
  installedToggle.setAttribute('aria-pressed', 'false');
  const installedToggleError = doc.createElement('p');
  installedToggleError.setAttribute(PACKS_SURFACE_INSTALLED_ONLY_ERROR_ATTR, '');
  installedToggleError.setAttribute('role', 'alert');
  installedToggleError.className = 'packs-surface-installed-error';
  installedToggleError.hidden = true;
  listView.appendChild(installedToggle);
  listView.appendChild(installedToggleError);
  listView.appendChild(listHost);

  // ── Detail host ───────────────────────────────────────────────────
  const detailHost = doc.createElement('div');
  detailHost.setAttribute(PACKS_SURFACE_DETAIL_ATTR, '');
  detailHost.setAttribute('tabindex', '-1');

  root.appendChild(listView);
  root.appendChild(detailHost);
  opts.root.appendChild(root);

  let active: string | null = opts.initialSlug ?? null;
  const rememberedList = readListContinuity(doc, PACK_BROWSE_CONTINUITY_KEY);
  let listReturnTarget: HTMLElement | null = null;
  let listReturnIdentity: { id: string; action: boolean } | null =
    rememberedList?.focusedId === undefined
      || (rememberedList.focusKind !== 'card'
        && rememberedList.focusKind !== 'action')
      ? null
      : {
          id: rememberedList.focusedId,
          action: rememberedList.focusKind === 'action',
        };
  const scrollRoot = opts.scrollRoot ?? opts.root;
  let listScrollPosition = rememberedList?.scroll ?? { top: 0, left: 0 };
  let focusGeneration = 0;

  const containsNode = (
    host: HTMLElement,
    candidate: HTMLElement | null,
  ): boolean => {
    if (candidate === null) return false;
    try {
      return host.contains(candidate);
    } catch {
      return false;
    }
  };

  const firstFocusable = (host: HTMLElement): HTMLElement | null => {
    const query = (host as unknown as {
      querySelector?: (selector: string) => Element | null;
    }).querySelector;
    if (typeof query !== 'function') return null;
    try {
      return query.call(
        host,
        'button:not([disabled]), a[href], input:not([disabled]), '
          + 'select:not([disabled]), textarea:not([disabled]), '
          + '[tabindex]:not([tabindex="-1"])',
      ) as HTMLElement | null;
    } catch {
      return null;
    }
  };

  const findDescendant = (
    host: HTMLElement,
    attribute: string,
    id: string,
  ): HTMLElement | null => {
    const walk = (node: HTMLElement): HTMLElement | null => {
      if (
        node.hasAttribute?.(attribute)
        && node.getAttribute?.('data-id') === id
      ) {
        return node;
      }
      const children = (
        node as unknown as { children?: ArrayLike<HTMLElement> }
      ).children;
      if (children === undefined) return null;
      for (let index = 0; index < children.length; index += 1) {
        const hit = walk(children[index] as HTMLElement);
        if (hit !== null) return hit;
      }
      return null;
    };
    return walk(host);
  };

  const restoredSelectionTarget = (): HTMLElement | null => {
    if (listReturnIdentity === null) return null;
    if (listReturnIdentity.action) {
      const action = findDescendant(
        listView,
        DISCOVER_PANEL_ACTION_ATTR,
        listReturnIdentity.id,
      );
      if (action?.tagName === 'BUTTON' && !action.hasAttribute?.('disabled')) {
        return action;
      }
    }
    return findDescendant(
      listView,
      DISCOVER_PANEL_CARD_ATTR,
      listReturnIdentity.id,
    );
  };

  const focusElement = (element: HTMLElement | null): void => {
    if (element === null || element.hasAttribute?.('disabled')) return;
    try {
      element.focus?.({ preventScroll: true });
    } catch {
      // Reduced/fake DOMs keep focus handoff best-effort.
    }
  };

  const readScrollPosition = () => readListScroll(scrollRoot);
  const restoreScrollPosition = (position: { top: number; left: number }): void =>
    restoreListScroll(scrollRoot, position);

  const preview = mountListPreview({
    host: root,
    document: doc,
    scrollRoot,
    onOpen: (slug) => goToDetail(slug),
  });

  // Mount both children ONCE — neither is torn down on the toggle, so the list's
  // browse state + the detail's resolved manifest both survive.
  const listMount = opts.mountList(
    listHost,
    (slug) => goToDetail(slug),
    (content, opener) => {
      listReturnTarget = opener;
      listReturnIdentity = {
        id: content.id,
        action: opener.hasAttribute?.(DISCOVER_PANEL_ACTION_ATTR) === true,
      };
      listScrollPosition = readScrollPosition();
      updateListContinuity(continuityDocument, PACK_BROWSE_CONTINUITY_KEY, {
        focusedId: content.id,
        focusKind: listReturnIdentity.action ? 'action' : 'card',
        scroll: listScrollPosition,
      });
      preview.open(content, opener);
    },
  );
  const setInstalledOnly = listMount.setInstalledOnly;
  if (setInstalledOnly === undefined) {
    installedToggle.remove();
    installedToggleError.remove();
  } else {
    // The list turns this on for itself when the roster shows anything installed
    // (see `applyInstalledFirstDefault`). Mirror it onto the control, which is
    // the only place the state is visible to the user.
    listMount.onInstalledOnlyChange?.((on) => {
      if (installedOnlyBusy) return; // a user press is mid-flight and owns the state
      installedOnly = on;
      installedToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    installedToggle.addEventListener('click', () => {
      if (installedOnlyBusy) return;
      updateListContinuity(continuityDocument, PACK_BROWSE_CONTINUITY_KEY, {
        focusKind: 'installed-toggle',
        scroll: readScrollPosition(),
      });
      const previous = installedOnly;
      installedOnly = !previous;
      // `aria-pressed` is the ONLY state carrier — the stylesheet keys off
      // `[aria-pressed="true"]`. A parallel class would be a second source of
      // truth for one fact, and the two drift.
      installedToggle.setAttribute('aria-pressed', installedOnly ? 'true' : 'false');
      installedToggleError.textContent = '';
      installedToggleError.hidden = true;
      // Keep the focused owner in the Tab order while the source swaps. ARIA
      // communicates the inert/busy state; the explicit guard below prevents
      // pointer or synthetic re-entry while native `disabled` would blur it.
      installedOnlyBusy = true;
      installedToggle.setAttribute('aria-disabled', 'true');
      installedToggle.setAttribute('aria-busy', 'true');
      void setInstalledOnly(installedOnly)
        .catch(() => {
          installedOnly = previous;
          installedToggle.setAttribute(
            'aria-pressed',
            installedOnly ? 'true' : 'false',
          );
          installedToggleError.textContent =
            'Couldn’t switch pack views. Try again.';
          installedToggleError.hidden = false;
        })
        .finally(() => {
          installedOnlyBusy = false;
          installedToggle.removeAttribute('aria-disabled');
          installedToggle.removeAttribute('aria-busy');
        });
    });
  }
  const detailMount = opts.mountDetail(detailHost, (slug) => handleSelection(slug));

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
    const generation = ++focusGeneration;
    if (slug === null) {
      const exactTarget = containsNode(listView, listReturnTarget)
        ? listReturnTarget
        : null;
      focusElement(
        exactTarget
          ?? restoredSelectionTarget()
          ?? firstFocusable(listView)
          ?? listView,
      );
      restoreScrollPosition(listScrollPosition);
      updateListContinuity(continuityDocument, PACK_BROWSE_CONTINUITY_KEY, {
        ...(listReturnIdentity === null
          ? {}
          : {
              focusedId: listReturnIdentity.id,
              focusKind: listReturnIdentity.action ? 'action' : 'card',
            }),
        scroll: listScrollPosition,
      });
      listReturnTarget = null;
    } else {
      restoreScrollPosition({ top: 0, left: 0 });
      // The panel calls this selection hook immediately before it rebuilds the
      // detail. Defer one microtask so the new Back/primary control exists.
      void Promise.resolve().then(() => {
        if (active !== slug || focusGeneration !== generation) return;
        focusElement(firstFocusable(detailHost) ?? detailHost);
      });
    }
    opts.onNavigate?.(slug);
  }

  function goToDetail(slug: string): void {
    setAddError(null);
    // A background explicit action can enter detail while the non-modal sheet
    // is open. Retire that sheet first so two navigation layers never stack.
    preview.close();
    if (active === null) {
      const focused = (
        doc as unknown as { activeElement?: HTMLElement | null }
      ).activeElement ?? null;
      const focusedInList = containsNode(listView, focused) ? focused : null;
      if (focusedInList !== null) {
        listReturnTarget = focusedInList;
        const focusedId = listReturnTarget.getAttribute?.('data-id') ?? null;
        const isAction = listReturnTarget.hasAttribute?.(
          DISCOVER_PANEL_ACTION_ATTR,
        ) === true;
        const isCard = listReturnTarget.hasAttribute?.(
          DISCOVER_PANEL_CARD_ATTR,
        ) === true;
        listReturnIdentity = focusedId === slug && (isAction || isCard)
          ? { id: slug, action: isAction }
          : null;
      } else if (listReturnIdentity?.id !== slug) {
        listReturnTarget = null;
        listReturnIdentity = null;
      }
      listScrollPosition = readScrollPosition();
      updateListContinuity(continuityDocument, PACK_BROWSE_CONTINUITY_KEY, {
        focusedId: slug,
        focusKind: listReturnIdentity?.action === true ? 'action' : 'card',
        scroll: listScrollPosition,
      });
    }
    // Drive the panel; its onSelectSlug → handleSelection does the toggle + hash.
    detailMount.clickSelectPack(slug);
  }

  // Drive the panel to deselect (its Back does the same) so its selection +
  // the surface's view stay in lockstep; the panel's onSelectSlug(null) →
  // handleSelection(null) is the single funnel that toggles + syncs the hash.
  const backToList = (): void => detailMount.clickBackToList();

  // Initial paint — a deep-link opens the detail directly (the panel was mounted
  // with `initialSlug`, so it already shows it); no `onNavigate` (hash matches).
  let disposed = false;
  paint();
  if (active === null && rememberedList !== null) {
    const generation = ++focusGeneration;
    const restoreInitialList = (): void => {
      if (disposed || active !== null || focusGeneration !== generation) return;
      restoreScrollPosition(listScrollPosition);
      const rememberedTarget = rememberedList.focusKind === 'installed-toggle'
        ? installedToggle
        : rememberedList.focusKind === 'card'
          || rememberedList.focusKind === 'action'
          ? restoredSelectionTarget()
          : null;
      // Query controls are restored by the discovery mount itself. Do not
      // overwrite that handoff with an arbitrary first control here.
      focusElement(rememberedTarget);
    };
    const listLoaded = listMount.whenLoaded?.();
    if (listLoaded === undefined) void Promise.resolve().then(restoreInitialList);
    else void listLoaded.then(restoreInitialList, () => {});
  } else if (active !== null) {
    restoreScrollPosition({ top: 0, left: 0 });
    const initialSlug = active;
    const generation = ++focusGeneration;
    const stillInitialDetail = (): boolean =>
      !disposed
      && active === initialSlug
      && focusGeneration === generation;
    const focusInitialDetail = (): void => {
      if (
        !stillInitialDetail()
        || containsNode(
          detailHost,
          (doc as unknown as { activeElement?: HTMLElement | null })
            .activeElement ?? null,
        )
      ) return;
      focusElement(firstFocusable(detailHost) ?? detailHost);
    };
    void Promise.resolve().then(focusInitialDetail);
    const detailLoaded = detailMount.whenLoaded?.();
    if (detailLoaded !== undefined) {
      void detailLoaded.then(() => {
        if (!stillInitialDetail()) return;
        const focused = (
          doc as unknown as { activeElement?: HTMLElement | null }
        ).activeElement ?? null;
        // The first pass deliberately owns the stable host while the detail is
        // loading. Upgrade only that ownership; never steal a user's later move.
        if (focused !== detailHost) return;
        focusElement(firstFocusable(detailHost) ?? detailHost);
      }, () => {});
    }
  }

  return {
    activeSlug: () => active,
    goToDetail,
    backToList,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      preview.dispose();
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
  style.textContent = `${PACKS_SURFACE_STYLES}\n${LIST_PREVIEW_STYLES}`;
  doc.head?.appendChild?.(style);
};

export const PACKS_SURFACE_STYLES = `
[${PACKS_SURFACE_HOST_ATTR}] {
  box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; color: var(--fg);
}
[${PACKS_SURFACE_LIST_ATTR}], [${PACKS_SURFACE_DETAIL_ATTR}] {
  box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%;
}
[${PACKS_SURFACE_LIST_ATTR}] > *, [${PACKS_SURFACE_DETAIL_ATTR}] > * {
  min-width: 0; max-width: 100%;
}
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
[${PACKS_SURFACE_HOST_ATTR}] .packs-surface-installed-toggle {
  min-height: 36px; margin: 0 0 10px; padding: 6px 12px;
  border: 1px solid var(--border); border-radius: 999px;
  background: var(--surface); color: var(--fg-muted); cursor: pointer;
  font: inherit; font-size: 12px;
  transition: border-color 90ms ease, background 90ms ease, color 90ms ease;
}
[${PACKS_SURFACE_HOST_ATTR}] .packs-surface-installed-toggle:hover {
  border-color: var(--border-strong); color: var(--fg);
}
[${PACKS_SURFACE_HOST_ATTR}] .packs-surface-installed-toggle[aria-pressed="true"] {
  border-color: var(--accent); background: var(--accent-weak);
  color: var(--fg); font-weight: 650;
}
[${PACKS_SURFACE_HOST_ATTR}] .packs-surface-installed-toggle[aria-disabled="true"] {
  cursor: progress; opacity: .72;
}
[${PACKS_SURFACE_HOST_ATTR}] .packs-surface-installed-toggle:focus-visible {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}
[${PACKS_SURFACE_INSTALLED_ONLY_ERROR_ATTR}] {
  margin: -4px 0 10px; font-size: 12px; color: var(--danger);
}
@media (max-width: 560px) {
  [${PACKS_SURFACE_HOST_ATTR}] .packs-surface-add { padding: 8px; }
  [${PACKS_SURFACE_HOST_ATTR}] .packs-surface-add-submit { flex: 0 0 auto; }
  [${PACKS_SURFACE_HOST_ATTR}] .packs-surface-installed-toggle { min-height: 44px; }
}
`;
