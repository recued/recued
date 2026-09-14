/**
 * §D.L1 — the [✎ Create] overlay (shell-frame Step 5; extracted from the chat
 * route's Step 4b inline opener).
 *
 * A floating quick-capture modal over the targets `COMPOSE_LOCAL_TARGETS`
 * declares. ⛔ The count is deliberately NOT written here: this line said
 * "4-kind (Contact · Task · Note · Commitment)" through the arrivals of both
 * Project and Booking, and two other places said 5 after that.
 * that absorbs the retired `#compose` route. It is a self-contained opener that
 * owns its DOM, its own injected styles, and its lifecycle — invoked from BOTH
 * the chat composer's [✎ Create] button (L1) and the §D.L2 drawer's "Create"
 * seat, so the two behave identically from any screen.
 *
 * Portals to `document.body` so a host re-render (which may clear its own route
 * root) can't wipe an open capture. Reuses `bootstrapComposeRoute` as the form
 * engine; the overlay supplies the "Create" title (the §D.L1 Compose→Create
 * rename) and the Close affordance, and hides the compose route's own header.
 *
 * Pure module (DOM + the compose route only — no engine / provider SDK; the
 * compose import-graph guard covers this file).
 */
import { wireFocusTrap, type FocusTrapHandle } from '@recued/ui-shared';

import {
  bootstrapComposeRoute,
  COMPOSE_ROUTE_HOST_ATTR,
  type ComposeContactUpsertCaller,
  type ComposeRouteState,
  type ComposeWorkEntityUpsertCaller,
} from './compose-route.js';

/** The overlay backdrop (portal-mounted; absorbs #compose). */
export const CREATE_OVERLAY_ATTR = 'data-recued-create-overlay';
/** The overlay's Close button. */
export const CREATE_OVERLAY_CLOSE_ATTR = 'data-recued-create-overlay-close';
/** Local confirmation shown before user dismissal destroys an unfinished item. */
export const CREATE_OVERLAY_DISCARD_GUARD_ATTR =
  'data-recued-create-overlay-discard-guard';
/** Return from the discard guard to the exact dismissal owner. */
export const CREATE_OVERLAY_DISCARD_KEEP_ATTR =
  'data-recued-create-overlay-discard-keep';
/** Confirm that every unfinished Create target may be discarded. */
export const CREATE_OVERLAY_DISCARD_COMMIT_ATTR =
  'data-recued-create-overlay-discard-commit';

const CREATE_OVERLAY_STYLES_MARKER = 'data-recued-create-overlay-styles';
let nextCreateOverlayA11yId = 0;

const CREATE_OVERLAY_STYLES = `
[${CREATE_OVERLAY_ATTR}] {
  position: fixed;
  inset: 0;
  z-index: 150;
  display: grid;
  place-items: start center;
  padding: 56px 16px 16px;
  background: rgba(24, 33, 36, .28);
}
[${CREATE_OVERLAY_ATTR}] .recued-create-panel {
  width: min(640px, 100%);
  max-height: calc(100vh - 80px);
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 24px 48px rgba(24, 33, 36, .18);
}
[${CREATE_OVERLAY_ATTR}] .recued-create-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px 0;
}
[${CREATE_OVERLAY_ATTR}] .recued-create-title {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
}
[${CREATE_OVERLAY_CLOSE_ATTR}] {
  margin-left: auto;
  appearance: none;
  min-height: 36px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
[${CREATE_OVERLAY_CLOSE_ATTR}][aria-disabled="true"] {
  cursor: not-allowed;
  opacity: .65;
}
[${CREATE_OVERLAY_DISCARD_GUARD_ATTR}] {
  display: grid;
  gap: 10px;
  margin: 14px;
  padding: 14px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  background: var(--danger-weak);
}
[${CREATE_OVERLAY_DISCARD_GUARD_ATTR}] h3,
[${CREATE_OVERLAY_DISCARD_GUARD_ATTR}] p {
  margin: 0;
}
[${CREATE_OVERLAY_DISCARD_GUARD_ATTR}] .recued-create-discard-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
[${CREATE_OVERLAY_DISCARD_GUARD_ATTR}] button {
  min-height: 36px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
/* The compose route brings its own "Compose" header — hide it; the overlay
   supplies the "Create" title (the §D.L1 Compose→Create rename). */
[${CREATE_OVERLAY_ATTR}] [${COMPOSE_ROUTE_HOST_ATTR}] .compose-header {
  display: none;
}
`;

export interface OpenCreateOverlayOptions {
  readonly document: Document;
  /** Where the overlay attaches — defaults to `document.body` (a portal so a
   *  host re-render can't wipe an open capture). */
  readonly portal?: HTMLElement;
  readonly contactUpsertCaller?: ComposeContactUpsertCaller;
  readonly workEntityUpsertCaller?: ComposeWorkEntityUpsertCaller;
  /** Fired exactly once when the overlay tears down (Close / Escape / backdrop
   *  / `close()`), so the caller can drop its handle reference. */
  readonly onClose?: () => void;
}

export interface CreateOverlayHandle {
  readonly element: HTMLElement;
  /** True while any Create target holds fields that teardown would discard. */
  hasUnsavedChanges(): boolean;
  /** True from Commit dispatch until its server outcome is reconciled. */
  hasInFlightWork(): boolean;
  /** Idempotent teardown — disposes the compose route, detaches the overlay,
   *  removes the keydown listener, restores focus, and fires `onClose` once. */
  close(): void;
}

/**
 * Open the Create overlay. Returns `null` (a no-op) when no write path is
 * wired — there is nothing to capture into. Otherwise returns a handle whose
 * `close()` tears it down idempotently.
 */
export const openCreateOverlay = (
  opts: OpenCreateOverlayOptions,
): CreateOverlayHandle | null => {
  if (
    opts.contactUpsertCaller === undefined
    && opts.workEntityUpsertCaller === undefined
  ) {
    return null;
  }
  const doc = opts.document;
  const overlayA11yId = ++nextCreateOverlayA11yId;

  if (
    doc.head.querySelector(`style[${CREATE_OVERLAY_STYLES_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(CREATE_OVERLAY_STYLES_MARKER, '');
    style.textContent = CREATE_OVERLAY_STYLES;
    doc.head.appendChild(style);
  }

  const overlay = doc.createElement('div');
  overlay.setAttribute(CREATE_OVERLAY_ATTR, '');
  const panel = doc.createElement('div');
  panel.className = 'recued-create-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Create');
  // Focusable (tabindex=-1) so the shared focus-trap can move focus INTO the
  // dialog surface on open (a screen reader announces it), then cycle Tab
  // within it; see `wireFocusTrap` below.
  panel.setAttribute('tabindex', '-1');
  const header = doc.createElement('div');
  header.className = 'recued-create-header';
  const title = doc.createElement('h2');
  title.className = 'recued-create-title';
  title.textContent = 'Create';
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'recued-create-close';
  closeBtn.setAttribute(CREATE_OVERLAY_CLOSE_ATTR, '');
  closeBtn.textContent = 'Close';
  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);
  const composeHost = doc.createElement('div');
  composeHost.className = 'recued-create-body';
  panel.appendChild(composeHost);
  overlay.appendChild(panel);

  let composeCommitting = false;
  const mirrorComposeState = (state: ComposeRouteState): void => {
    composeCommitting = state.stage === 'committing';
    if (composeCommitting) {
      closeBtn.setAttribute('aria-disabled', 'true');
    } else {
      closeBtn.removeAttribute('aria-disabled');
    }
  };

  const compose = bootstrapComposeRoute({
    root: composeHost,
    document: doc,
    ...(opts.contactUpsertCaller !== undefined
      ? { contactUpsertCaller: opts.contactUpsertCaller }
      : {}),
    ...(opts.workEntityUpsertCaller !== undefined
      ? { workEntityUpsertCaller: opts.workEntityUpsertCaller }
      : {}),
    onStateChange: mirrorComposeState,
  });

  // `keyHandler` / `trap` are declared before teardown (which releases them)
  // and assigned afterward; both references are runtime-only, so neither hits
  // a temporal-dead-zone.
  let closed = false;
  let keyHandler: ((ev: KeyboardEvent) => void) | null = null;
  let trap: FocusTrapHandle | null = null;
  let discardGuard: HTMLElement | null = null;
  let discardFocusOwner: HTMLElement | null = null;
  const teardown = (): void => {
    if (closed) return;
    closed = true;
    if (keyHandler !== null) doc.removeEventListener('keydown', keyHandler);
    try {
      compose.dispose();
    } catch {
      /* detached compose root — already inert */
    }
    overlay.remove();
    // Detach the Tab-trap's keydown + restore focus to the opener (the Create
    // button / drawer seat) so keyboard focus doesn't strand on the removed node.
    trap?.release();
    opts.onClose?.();
  };

  const closeDiscardGuard = (): void => {
    if (discardGuard === null) return;
    try {
      panel.removeChild(discardGuard);
    } catch {
      /* host teardown already detached the guard */
    }
    discardGuard = null;
    header.removeAttribute('inert');
    header.removeAttribute('aria-hidden');
    composeHost.removeAttribute('inert');
    composeHost.removeAttribute('aria-hidden');
    const owner = discardFocusOwner ?? closeBtn;
    discardFocusOwner = null;
    owner.focus?.({ preventScroll: true });
  };

  const showDiscardGuard = (): void => {
    if (discardGuard !== null) {
      discardGuard.focus?.({ preventScroll: true });
      return;
    }
    discardFocusOwner = (doc.activeElement as HTMLElement | null) ?? closeBtn;
    header.setAttribute('inert', '');
    header.setAttribute('aria-hidden', 'true');
    composeHost.setAttribute('inert', '');
    composeHost.setAttribute('aria-hidden', 'true');

    const guard = doc.createElement('section');
    guard.setAttribute(CREATE_OVERLAY_DISCARD_GUARD_ATTR, '');
    guard.setAttribute('role', 'alertdialog');
    guard.setAttribute('aria-modal', 'true');
    guard.setAttribute('tabindex', '-1');
    const guardTitle = doc.createElement('h3');
    guardTitle.id = `recued-create-discard-title-${overlayA11yId}`;
    guardTitle.textContent = 'Throw this away?';
    guard.setAttribute('aria-labelledby', guardTitle.id);
    guard.appendChild(guardTitle);
    const guardCopy = doc.createElement('p');
    guardCopy.id = `recued-create-discard-description-${overlayA11yId}`;
    guardCopy.textContent =
      'Everything you have typed will be lost.';
    guard.setAttribute('aria-describedby', guardCopy.id);
    guard.appendChild(guardCopy);
    const actions = doc.createElement('div');
    actions.className = 'recued-create-discard-actions';
    const keep = doc.createElement('button');
    keep.type = 'button';
    keep.setAttribute(CREATE_OVERLAY_DISCARD_KEEP_ATTR, '');
    keep.textContent = 'Keep editing';
    keep.addEventListener('click', closeDiscardGuard);
    actions.appendChild(keep);
    const discard = doc.createElement('button');
    discard.type = 'button';
    discard.setAttribute(CREATE_OVERLAY_DISCARD_COMMIT_ATTR, '');
    discard.textContent = 'Throw it away';
    discard.addEventListener('click', teardown);
    actions.appendChild(discard);
    guard.appendChild(actions);
    panel.appendChild(guard);
    discardGuard = guard;
    guard.focus?.({ preventScroll: true });
  };

  const requestClose = (): void => {
    if (composeCommitting) return;
    if (compose.hasUnsavedChanges()) {
      showDiscardGuard();
      return;
    }
    teardown();
  };

  keyHandler = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || ev.isComposing) return;
    if (discardGuard !== null) {
      ev.preventDefault?.();
      ev.stopPropagation?.();
      closeDiscardGuard();
      return;
    }
    if (composeCommitting) {
      ev.preventDefault?.();
      return;
    }
    requestClose();
  };
  doc.addEventListener('keydown', keyHandler);
  // Backdrop click closes; clicks inside the panel don't reach the overlay as
  // the event target.
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) requestClose();
  });
  closeBtn.addEventListener('click', () => requestClose());

  const portal = opts.portal ?? (doc as { body?: HTMLElement }).body ?? overlay;
  portal.appendChild(overlay);

  // Focus-in (the dialog panel) + Tab focus-trap + focus-restore-on-release.
  trap = wireFocusTrap({ document: doc, getContainer: () => panel });

  // `close()` is the host/dispose escape hatch and remains unconditional.
  // Only user dismissal is held while the write's outcome is unresolved.
  return {
    element: overlay,
    hasUnsavedChanges: () => !closed && compose.hasUnsavedChanges(),
    hasInFlightWork: () => !closed && composeCommitting,
    close: teardown,
  };
};
