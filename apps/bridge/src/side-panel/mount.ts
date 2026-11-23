/** D-169 P1 — side-panel mount.
 *
 *  Subscribes to a `SidePanelStore` + reconciles the changed panel section on
 *  each state change. The panel renders into the `<main id="root">` element
 *  in `apps/bridge/public/side-panel/index.html`; the bundled entry
 *  (`side-panel-entry.ts`) calls this with the production seams.
 *
 *  Two main branches:
 *   - `pair.paired === false` → render the pairing section, with the pair
 *     form mounted into its slot (`mountPairing`); the sections are
 *     skipped.
 *   - `pair.paired === true`  → render the sections in order, each pulling its
 *     slice from the store. 2026-11-04: approvals lead, unfolded; every other
 *     section folds to one line (`folds.ts`), open where something needs the
 *     owner or the owner opened it.
 *
 *  ⚠️  The mount module is pure DOM. No `chrome.*` references; tests
 *  in jsdom pass `opts.document` + drive the store directly. */

import type {
  SidePanelSitesState,
  SidePanelStore,
  SidePanelStoreState,
} from './store/local-store.js';
import {
  SIDE_PANEL_ACTIVE_CONTROL_ATTR,
  SIDE_PANEL_ACTIVE_ROW_ATTR,
  SIDE_PANEL_KEEP_FIELD_ATTR,
  SIDE_PANEL_KEEP_REMOVE_ATTR,
  SIDE_PANEL_KEEP_UNDO_ATTR,
  SIDE_PANEL_ROOT_ATTR,
  SIDE_PANEL_SITES_INPUT_ATTR,
  SIDE_PANEL_SITES_REMOVE_ATTR,
  SIDE_PANEL_SITES_UNDO_ATTR,
  SIDE_PANEL_WATCH_BUTTON_ATTR,
  renderActiveExecutionsSection,
  renderApprovalsSection,
  renderBridgeDiagnosticSection,
  SIDE_PANEL_DIAGNOSTIC_REFRESH_ATTR,
  SIDE_PANEL_DIAGNOSTIC_COPY_ATTR,
  SIDE_PANEL_DIAGNOSTIC_SUMMARY_ATTR,
  renderElementWatchCta,
  renderNotificationsSection,
  renderPairSection,
  renderRecipeResultsSection,
  renderServerStatusSection,
  renderSitesSection,
  updateHeader,
  updateHeaderStatus,
  type ActiveControlHandler,
  type ApprovalAnswerHandler,
  type ElementWatchLaunchHandler,
  type SitesHandlers,
} from './views.js';
import type { DisconnectHandlers } from './disconnect.js';
import {
  createSidePanelFolds,
  foldOpenByDefault,
  foldSection,
  foldSummary,
  watchSection,
  type FoldableSectionId,
  type SidePanelFolds,
} from './folds.js';

export interface MountSidePanelOptions {
  /** The DOM document. Defaults to `globalThis.document`. */
  document?: Document;
  /** The store the panel reads. */
  store: SidePanelStore;
  /** Optional clock override (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** D-169 P2 Slice 3 — submit callback for the interactive approval
   *  cards. When present, the approvals section renders each open ask via
   *  the shared `@recued/ui-shared` card with clickable option buttons; the
   *  production entry wires this to the SW `notification.submitAnswer`
   *  responder. Absent → the approvals section renders read-only. */
  onAnswer?: ApprovalAnswerHandler;
  /** D-181 slice 6a — kill / cancel / promote callback for the
   *  active-executions section. When present AND this bridge holds
   *  `bridge_mode.approval`, each active row renders its control buttons; the
   *  production entry wires this to the SW `execution-{kill,cancel,promote}`
   *  responders. Withheld from the section unless approval mode is on (§8 — a
   *  non-approval bridge views the list read-only). Absent → never interactive. */
  onControl?: ActiveControlHandler;
  /** D-169 P2 brick 3 — "Watch this element" launch callback. When present,
   *  the creator block's button asks the SW to inject the in-page picker;
   *  the production entry wires this. Absent → the button renders but does
   *  nothing on click (tests / pre-wiring). */
  onLaunchPicker?: ElementWatchLaunchHandler;
  /** D-335 slice G — the Sites section's actions: Chrome's every-site grant and
   *  the owner's list. The production entry wires them (`sites.ts`). Absent →
   *  the section renders without buttons. */
  sites?: SitesHandlers;
  /** The Server status section's Disconnect (`disconnect.ts`). Absent → its button does nothing. */
  disconnect?: DisconnectHandlers;
  /** Reads the bridge's local diagnostic snapshot, coalesced with polling. */
  onRefreshDiagnostic?: () => void;
  /** Copies the currently displayed local snapshot, with a manual fallback. */
  onCopyDiagnostic?: () => void;
  /** 2026-11-04 — where the owner's open-or-closed choice for each folding
   *  section is kept. The production entry keeps it in the panel's
   *  `localStorage`; absent → kept for this mount only. */
  folds?: SidePanelFolds;
  /** Mounts the pair form into the unpaired panel's slot; the panel
   *  disposes it when the bridge becomes paired (or the panel is torn
   *  down). The production entry mounts `pair-code-input-host.ts` over the
   *  worker's pairing session. Absent → the slot stays empty (tests). */
  mountPairing?: (slot: HTMLElement) => { dispose(): void };
}

export interface MountedSidePanel {
  /** Force a re-render. Tests use this after an out-of-band state patch. */
  rerender(): void;
  /** Tear down — disposes the subscription + clears `<main id="root">`. */
  dispose(): void;
}

const ROOT_ELEMENT_ID = 'root';

/** In the order the panel shows them (`appendPairedNodes`). */
interface PairedSurfaceNodes {
  approvals: HTMLElement;
  active: HTMLElement;
  notifications: HTMLElement;
  recipes: HTMLElement;
  watch: HTMLElement;
  sites: HTMLElement;
  status: HTMLElement;
  diagnostic: HTMLElement;
}

/** Approval-card submission state lives inside the shared card DOM. A live
 *  frames poll returns cloned rows every 5s, so reference inequality alone
 *  would replace the card (and re-enable its in-flight buttons) even when no
 *  ask changed. Compare the render-bearing fields and ignore `fetched_at`. */
const approvalsRenderEqual = (
  a: SidePanelStoreState['approvals'],
  b: SidePanelStoreState['approvals'],
): boolean => {
  if (
    a.error !== b.error
    || (a.fetched_at === null) !== (b.fetched_at === null)
    || a.items.length !== b.items.length
  ) return false;
  return a.items.every((left, index) => {
    const right = b.items[index];
    return right !== undefined
      && left.ask_id === right.ask_id
      && left.title === right.title
      && left.text === right.text
      && left.created_at === right.created_at
      && left.options.length === right.options.length
      && left.options.every((option, optionIndex) => {
        const other = right.options[optionIndex];
        return other !== undefined
          && option.id === other.id
          && option.label === other.label;
      });
  });
};

/** D-347 follow-up 20 — whether the Sites section drawn again keeps its two lists as they were (a status, a
 *  message or a grant changed), so what the owner is typing there is carried over. A site added or removed is
 *  the change the owner asked for: its form starts again. */
export const sameSitesLists = (a: SidePanelSitesState, b: SidePanelSitesState): boolean =>
  JSON.stringify(a.blocked) === JSON.stringify(b.blocked)
  && JSON.stringify((a.keep ?? []).map((row) => row.entry)) === JSON.stringify((b.keep ?? []).map((row) => row.entry));

export const mountSidePanel = (
  opts: MountSidePanelOptions,
): MountedSidePanel => {
  const doc =
    opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountSidePanel: no document available — pass `opts.document` for non-browser environments',
    );
  }
  const root = doc.getElementById(ROOT_ELEMENT_ID);
  if (root === null) {
    throw new Error(
      `mountSidePanel: expected <main id="${ROOT_ELEMENT_ID}"> in the side-panel document`,
    );
  }
  // Stable hook for tests that don't want to couple to the inline html id.
  root.setAttribute(SIDE_PANEL_ROOT_ATTR, '');

  const nowFn = opts.now ?? Date.now;
  const folds = opts.folds ?? createSidePanelFolds();
  let disposed = false;
  let previousState: SidePanelStoreState | null = null;
  let pairedNodes: PairedSurfaceNodes | null = null;
  let mountedPairing: { dispose(): void } | null = null;

  const disposePairing = (): void => {
    const current = mountedPairing;
    mountedPairing = null;
    current?.dispose();
  };

  const clearChildren = (node: HTMLElement): void => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  /** The Disconnect under the server's status, named as the panel's header names the server. */
  const disconnectOptions = (state: SidePanelStoreState) => ({
    disconnect: state.disconnect,
    ...(opts.disconnect !== undefined ? { onDisconnect: opts.disconnect } : {}),
    serverName: state.pair.server_display_name ?? state.status.status?.name ?? 'your server',
  });

  /** A rendered section, folded: open as the owner left it, else as `foldOpenByDefault` says. */
  const fold = (
    id: FoldableSectionId,
    section: HTMLElement,
    state: SidePanelStoreState,
    now: number,
  ): HTMLElement => foldSection(doc, section, {
    id,
    open: folds.get(id) ?? foldOpenByDefault(id, state),
    summary: foldSummary(id, state, now),
    onToggle: (open) => folds.set(id, open),
  });

  const renderStatus = (state: SidePanelStoreState, now: number): HTMLElement =>
    fold('server-status', renderServerStatusSection(doc, state.status, now, disconnectOptions(state)), state, now);
  const renderSites = (state: SidePanelStoreState, now: number): HTMLElement =>
    fold('sites', renderSitesSection(doc, state.sites, opts.sites), state, now);
  const renderWatch = (state: SidePanelStoreState, now: number): HTMLElement =>
    fold('watch', watchSection(doc, renderElementWatchCta(doc, state.element_watch, {
      onLaunch: opts.onLaunchPicker,
    })), state, now);
  const renderActive = (state: SidePanelStoreState, now: number): HTMLElement =>
    fold('active-executions', renderActiveExecutionsSection(doc, state.active, now, {
      onControl: state.bridge_mode.approval ? opts.onControl : undefined,
    }), state, now);
  const renderRecipes = (state: SidePanelStoreState, now: number): HTMLElement =>
    fold('recipe-results', renderRecipeResultsSection(doc, state.recipe_results, now), state, now);
  const renderNotifications = (state: SidePanelStoreState, now: number): HTMLElement =>
    fold('notifications', renderNotificationsSection(doc, state.notifications, now, {
      enabled: state.bridge_mode.notification,
      desktopBlocked: state.desktop_notifications === 'denied',
    }), state, now);

  const makePairedNodes = (
    state: SidePanelStoreState,
    now: number,
  ): PairedSurfaceNodes => ({
    approvals: renderApprovalsSection(doc, state.approvals, now, {
      onAnswer: state.bridge_mode.approval ? opts.onAnswer : undefined,
    }),
    active: renderActive(state, now),
    notifications: renderNotifications(state, now),
    recipes: renderRecipes(state, now),
    watch: renderWatch(state, now),
    sites: renderSites(state, now),
    status: renderStatus(state, now),
    diagnostic: renderBridgeDiagnosticSection(doc, state.diagnostic, {
      onRefresh: opts.onRefreshDiagnostic, onCopy: opts.onCopyDiagnostic, copyState: state.diagnostic_copy,
    }),
  });

  const appendPairedNodes = (nodes: PairedSurfaceNodes): void => {
    root.appendChild(nodes.approvals);
    root.appendChild(nodes.active);
    root.appendChild(nodes.notifications);
    root.appendChild(nodes.recipes);
    root.appendChild(nodes.watch);
    root.appendChild(nodes.sites);
    root.appendChild(nodes.status);
    root.appendChild(nodes.diagnostic);
  };

  type FocusToken =
    | { kind: 'watch' }
    | { kind: 'summary' }
    | { kind: 'diagnostic-refresh' }
    | { kind: 'diagnostic-copy' }
    | { kind: 'diagnostic-summary'; start: number | null; end: number | null; direction: 'forward' | 'backward' | 'none' | null }
    | { kind: 'active-control'; action: string; rowId: string }
    | { kind: 'sites-control'; attr: string; value: string };

  /** D-347 follow-up 30 — a listed site's × and the Undo a removal leaves, each by its site: kept focused through
   *  the redraws Keep signed in's status brings every minute or so. */
  const SITES_CONTROLS = [SIDE_PANEL_SITES_REMOVE_ATTR, SIDE_PANEL_SITES_UNDO_ATTR, SIDE_PANEL_KEEP_REMOVE_ATTR,
    SIDE_PANEL_KEEP_UNDO_ATTR];
  /** A Sites control by its attribute's value, found without a value selector, which the unit tests' DOM fakes lack. */
  const sitesControl = (surface: HTMLElement, attr: string, value: string): HTMLElement | null =>
    (Array.from((surface as HTMLElement & {
      querySelectorAll?: (selector: string) => NodeListOf<Element>;
    }).querySelectorAll?.(`[${attr}]`) ?? []) as HTMLElement[]).find((candidate) => candidate.getAttribute(attr) === value)
    ?? null;

  const captureFocus = (surface: HTMLElement): FocusToken | null => {
    const activeElement = (doc as Document & { activeElement?: Element | null })
      .activeElement as HTMLElement | null | undefined;
    const contains = (surface as HTMLElement & {
      contains?: (node: Node | null) => boolean;
    }).contains;
    if (!activeElement || !contains?.call(surface, activeElement)) return null;
    if (activeElement.hasAttribute(SIDE_PANEL_WATCH_BUTTON_ATTR)) {
      return { kind: 'watch' };
    }
    if (activeElement.hasAttribute(SIDE_PANEL_DIAGNOSTIC_REFRESH_ATTR)) {
      return { kind: 'diagnostic-refresh' };
    }
    if (activeElement.hasAttribute(SIDE_PANEL_DIAGNOSTIC_COPY_ATTR)) return { kind: 'diagnostic-copy' };
    if (activeElement.hasAttribute(SIDE_PANEL_DIAGNOSTIC_SUMMARY_ATTR)) {
      const summary = activeElement as HTMLTextAreaElement;
      return { kind: 'diagnostic-summary', start: summary.selectionStart, end: summary.selectionEnd, direction: summary.selectionDirection };
    }
    const action = activeElement.getAttribute(SIDE_PANEL_ACTIVE_CONTROL_ATTR);
    if (action !== null) {
      const row = activeElement.closest?.(
        `[${SIDE_PANEL_ACTIVE_ROW_ATTR}]`,
      ) as HTMLElement | null;
      return {
        kind: 'active-control',
        action,
        rowId: row?.getAttribute(SIDE_PANEL_ACTIVE_ROW_ATTR) ?? '',
      };
    }
    for (const attr of SITES_CONTROLS) {
      const value = activeElement.getAttribute(attr);
      if (value !== null) return { kind: 'sites-control', attr, value };
    }
    if (activeElement.tagName === 'SUMMARY') return { kind: 'summary' };
    return null;
  };

  const restoreFocus = (surface: HTMLElement, token: FocusToken | null): void => {
    if (token === null) return;
    const query = (surface as HTMLElement & {
      querySelector?: (selector: string) => Element | null;
      querySelectorAll?: (selector: string) => NodeListOf<Element>;
    });
    let target: HTMLElement | null = null;
    if (token.kind === 'watch') {
      target = query.querySelector?.(`[${SIDE_PANEL_WATCH_BUTTON_ATTR}]`) as
        | HTMLElement
        | null;
    } else if (token.kind === 'summary') {
      target = query.querySelector?.('summary') as HTMLElement | null;
    } else if (token.kind === 'diagnostic-refresh') {
      target = query.querySelector?.(`[${SIDE_PANEL_DIAGNOSTIC_REFRESH_ATTR}]`) as HTMLElement | null;
    } else if (token.kind === 'diagnostic-copy') {
      target = query.querySelector?.(`[${SIDE_PANEL_DIAGNOSTIC_COPY_ATTR}]`) as HTMLElement | null;
    } else if (token.kind === 'diagnostic-summary') {
      target = query.querySelector?.(`[${SIDE_PANEL_DIAGNOSTIC_SUMMARY_ATTR}]`) as HTMLTextAreaElement | null;
    } else if (token.kind === 'sites-control') {
      target = sitesControl(surface, token.attr, token.value);
    } else {
      const controls = query.querySelectorAll?.(
        `[${SIDE_PANEL_ACTIVE_CONTROL_ATTR}]`,
      );
      if (controls) {
        for (const candidate of Array.from(controls) as HTMLElement[]) {
          if (
            candidate.getAttribute(SIDE_PANEL_ACTIVE_CONTROL_ATTR) === token.action
            && candidate.closest?.(`[${SIDE_PANEL_ACTIVE_ROW_ATTR}]`)
              ?.getAttribute(SIDE_PANEL_ACTIVE_ROW_ATTR) === token.rowId
          ) {
            target = candidate;
            break;
          }
        }
      }
    }
    target?.focus?.();
    if (target && token.kind === 'diagnostic-summary' && token.start !== null && token.end !== null) {
      (target as HTMLTextAreaElement).setSelectionRange(token.start, token.end, token.direction ?? undefined);
    }
  };

  /** D-347 follow-up 20 — what the owner is typing in a section's fields (Keep signed in's form, the list of
   *  sites never used), carried into the section drawn again by a store update ({@link sameSitesLists}): a
   *  status Keep signed in writes as it refreshes a site must not wipe a site half typed. Values, ticks and
   *  choices by field, then the focus and the caret where they were. */
  const TYPED_FIELDS = `[${SIDE_PANEL_KEEP_FIELD_ATTR}], [${SIDE_PANEL_SITES_INPUT_ATTR}]`;
  type Typed = { key: string; value: string; checked: boolean; focused: boolean; start: number | null; end: number | null };
  const fieldKey = (field: Element): string => field.getAttribute(SIDE_PANEL_KEEP_FIELD_ATTR) ?? 'sites-input';
  const fieldsIn = (surface: HTMLElement): HTMLInputElement[] => Array.from((surface as HTMLElement & {
    querySelectorAll?: (selector: string) => NodeListOf<Element>;
  }).querySelectorAll?.(TYPED_FIELDS) ?? []) as HTMLInputElement[];
  const captureTyped = (surface: HTMLElement): Typed[] => {
    const active = (doc as Document & { activeElement?: Element | null }).activeElement ?? null;
    return fieldsIn(surface).map((field) => {
      let start: number | null = null;
      let end: number | null = null;
      try {
        start = field === active ? field.selectionStart : null;
        end = field === active ? field.selectionEnd : null;
      } catch {
        // A field with no caret (a number, a box).
      }
      return { key: fieldKey(field), value: field.value, checked: field.checked === true, focused: field === active, start, end };
    });
  };
  const restoreTyped = (surface: HTMLElement, typed: readonly Typed[]): void => {
    if (typed.length === 0) return;
    for (const field of fieldsIn(surface)) {
      const was = typed.find((entry) => entry.key === fieldKey(field));
      if (was === undefined) continue;
      if (field.type === 'checkbox') field.checked = was.checked;
      else field.value = was.value;
      // The rows a choice shows (Keep signed in's days and hours) follow it, as when it was picked.
      if (field.tagName === 'SELECT' && typeof field.dispatchEvent === 'function') field.dispatchEvent(new Event('change'));
      if (was.focused) {
        field.focus?.();
        try {
          if (was.start !== null && was.end !== null) field.setSelectionRange(was.start, was.end);
        } catch {
          // A field with no caret.
        }
      }
    }
  };

  const replaceSurface = (
    current: HTMLElement,
    next: HTMLElement,
    preserveDetailsOpen = false,
    carryTyped = true,
  ): HTMLElement => {
    const focus = captureFocus(current);
    const typed = carryTyped ? captureTyped(current) : [];
    const currentQuery = current as HTMLElement & {
      querySelector?: (selector: string) => Element | null;
    };
    const wasOpen = preserveDetailsOpen
      ? (currentQuery.querySelector?.('details') as HTMLDetailsElement | null)
        ?.open === true
      : false;
    const replaceChild = (root as HTMLElement & {
      replaceChild?: (newChild: Node, oldChild: Node) => Node;
    }).replaceChild;
    if (replaceChild) {
      replaceChild.call(root, next, current);
    } else {
      // The tiny DOM fakes used by unit tests predate `replaceChild`. The real
      // browser always takes the in-place branch; append fallback keeps those
      // dependency-free tests useful without widening every fake interface.
      root.removeChild(current);
      root.appendChild(next);
    }
    if (wasOpen) {
      const nextDetails = (next as HTMLElement & {
        querySelector?: (selector: string) => Element | null;
      }).querySelector?.('details') as HTMLDetailsElement | null;
      if (nextDetails) nextDetails.open = true;
    }
    restoreFocus(next, focus);
    restoreTyped(next, typed);
    return next;
  };

  const render = (force = false): void => {
    if (disposed) return;
    const state = opts.store.getState();
    if (force || previousState === null || previousState.pair !== state.pair) {
      updateHeader(doc, state.pair);
    }
    if (force || previousState === null || previousState.pair !== state.pair || previousState.status !== state.status) {
      updateHeaderStatus(doc, state.pair.paired ? state.status : null);
    }

    if (!state.pair.paired) {
      // Only on entering the unpaired state: the pair form in the slot holds
      // what the user is typing, so a store update must not rebuild it.
      if (force || previousState === null || previousState.pair.paired) {
        disposePairing();
        clearChildren(root);
        const { section, slot } = renderPairSection(doc);
        root.appendChild(section);
        pairedNodes = null;
        mountedPairing = opts.mountPairing?.(slot) ?? null;
      }
      previousState = state;
      return;
    }

    const now = nowFn();
    if (
      force
      || previousState === null
      || !previousState.pair.paired
      || pairedNodes === null
    ) {
      disposePairing();
      clearChildren(root);
      pairedNodes = makePairedNodes(state, now);
      appendPairedNodes(pairedNodes);
      previousState = state;
      return;
    }

    const previous = previousState;
    const approvalModeChanged =
      previous.bridge_mode.approval !== state.bridge_mode.approval;
    const notificationModeChanged =
      previous.bridge_mode.notification !== state.bridge_mode.notification;

    if (previous.status !== state.status || previous.disconnect !== state.disconnect) {
      pairedNodes.status = replaceSurface(pairedNodes.status, renderStatus(state, now));
    }
    if (previous.sites !== state.sites) {
      pairedNodes.sites = replaceSurface(pairedNodes.sites, renderSites(state, now), false,
        sameSitesLists(previous.sites, state.sites));
      // D-347 follow-up 30 — once: the Undo a removal leaves, or the × an undo puts back, unless the owner has
      // moved to another control meanwhile.
      const focus = state.sites.focus;
      const active = (doc as Document & { activeElement?: Element | null }).activeElement ?? null;
      if (focus !== undefined && focus !== previous.sites.focus && (active === null || active === doc.body)) {
        sitesControl(pairedNodes.sites, focus.attr, focus.value)?.focus?.();
      }
    }
    if (previous.element_watch !== state.element_watch) {
      pairedNodes.watch = replaceSurface(pairedNodes.watch, renderWatch(state, now));
    }
    if (previous.active !== state.active || approvalModeChanged) {
      pairedNodes.active = replaceSurface(pairedNodes.active, renderActive(state, now));
    }
    if (previous.recipe_results !== state.recipe_results) {
      pairedNodes.recipes = replaceSurface(pairedNodes.recipes, renderRecipes(state, now));
    }
    if (
      previous.notifications !== state.notifications
      || notificationModeChanged
      || previous.desktop_notifications !== state.desktop_notifications
    ) {
      pairedNodes.notifications = replaceSurface(pairedNodes.notifications, renderNotifications(state, now));
    }
    if (
      approvalModeChanged
      || !approvalsRenderEqual(previous.approvals, state.approvals)
    ) {
      pairedNodes.approvals = replaceSurface(
        pairedNodes.approvals,
        renderApprovalsSection(doc, state.approvals, now, {
          onAnswer: state.bridge_mode.approval ? opts.onAnswer : undefined,
        }),
      );
    }
    if (previous.diagnostic !== state.diagnostic || previous.diagnostic_copy !== state.diagnostic_copy) {
      pairedNodes.diagnostic = replaceSurface(
        pairedNodes.diagnostic,
        renderBridgeDiagnosticSection(doc, state.diagnostic, {
          onRefresh: opts.onRefreshDiagnostic, onCopy: opts.onCopyDiagnostic, copyState: state.diagnostic_copy,
        }),
        true,
      );
    }
    previousState = state;
  };

  // Initial paint
  render(true);
  // Reconcile only the changed surface. In particular, status/active polling
  // no longer destroys an approval card while its answer is in flight.
  const unsub = opts.store.subscribe(() => render(false));

  return {
    rerender: () => render(true),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsub();
      disposePairing();
      clearChildren(root);
    },
  };
};
