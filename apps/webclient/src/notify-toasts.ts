/** Route-independent webclient status-toast stack.
 *
 *  The live, transient pop for a one-way D-158 `notify` — the webclient peer
 *  of the bridge's OS notification. On each `notification.notify` bus frame a
 *  toast appears at the app root and auto-dismisses. This is the SOLE webclient
 *  surface for a `notify`: the durable Settings feed was retired (R31 delta D —
 *  a one-way notice is not audit-log material). A missed / auto-dismissed toast
 *  is not data loss — the server persists every fired notify as a
 *  `notification_fired` audit row, and the Bridge side panel keeps its own
 *  notify list.
 *
 *  ── Why mounted at the app root, not a route ────────────────────────────
 *  A notify can fire while the user is on EITHER webclient route
 *  (`reception` / `settings`); the toast must survive route swaps. So the
 *  bootstrap mounts this once at `options.root` (the same posture as the
 *  reauth banner), independent of `mountedRouteHandle`.
 *
 *  ── Notify input is bus-only ──────────────────────────────────────────
 *  The stack consumes each `notification.notify` bus payload DIRECTLY — it's
 *  ephemeral, so there's no `notification.recent` round-trip.
 *  Optional links accept HTTP(S) or a saved-view route, with every other
 *  scheme rejected. The public `push` seam lets other durable,
 *  owner-only projections reuse the same accessible presentation without
 *  minting a fake `notification.notify` event.
 *
 *  ── Render model: DOM nodes, not innerHTML ──────────────────────────────
 *  `createElement` + `textContent` for every new card — unsanitised notify
 *  text is never parsed as HTML. Cards are keyed and retained until their own
 *  dismissal, so an arriving notice cannot detach a focused older action.
 *
 *  ── Timers are injectable (DD) ──────────────────────────────────────────
 *  Auto-dismiss uses `setTimer` / `clearTimer` seams (default
 *  `globalThis.setTimeout` / `clearTimeout`) so tests drive dismissal
 *  deterministically without fake clocks. Each toast owns its handle; a
 *  manual dismiss or a maxVisible eviction cancels it.
 *
 *  Spec: D-169 § N.5 #3 (live surface). */

import type { BroadcastSubscriber } from './realtime/subscriber.js';

// ════════════════════════════════════════════════════════════════
// Public shapes
// ════════════════════════════════════════════════════════════════

export interface NotifyToast {
  /** Stable id (`toast-<seq>`) — the dismiss key + DOM attribute. */
  id: string;
  /** Optional headline; when absent `text` is the only line. */
  title?: string;
  /** Body text. */
  text: string;
  link_url?: string;
}

export interface MountNotifyToastsOptions {
  /** Element the toast container is appended to. The bootstrap passes the
   *  app root so the overlay survives route swaps. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** Live broadcast subscription — REQUIRED (the toast is purely
   *  bus-driven). The mount subscribes to `notification.notify` on
   *  creation + unsubscribes on dispose. */
  subscribe: BroadcastSubscriber['on'];
  /** Auto-dismiss delay (ms). Default 6000. A non-positive value disables
   *  auto-dismiss (manual / programmatic dismissal only). */
  durationMs?: number;
  /** Max simultaneously-visible toasts; older ones evict (oldest-first)
   *  when a new toast would exceed this. Default 4. The durable feed keeps
   *  the full record, so an evicted toast is never lost. */
  maxVisible?: number;
  /** `setTimeout`-compatible seam (returns an opaque handle). Defaults to
   *  `globalThis.setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** `clearTimeout`-compatible seam. Defaults to `globalThis.clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
}

export interface NotifyToastsMount {
  /** Currently-visible toasts in display order (newest last appended;
   *  inserted newest-on-top in the DOM). */
  getToasts(): ReadonlyArray<NotifyToast>;
  /** Dismiss a toast by id (cancels its auto-dismiss timer). No-op on an
   *  unknown / already-dismissed id. */
  dismiss(id: string): void;
  /** Present another route-independent status through the same accessible
   * stack. Used by durable action-receipt invalidations; it does not turn the
   * source event into a `notification.notify`. */
  push(toast: { title?: string; text: string }): void;
  /** Tear down: clear every timer, drop the subscription, remove the
   *  container. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests
// ════════════════════════════════════════════════════════════════

export const NOTIFY_TOASTS_HOST_ATTR = 'data-recued-notify-toasts';
export const NOTIFY_TOAST_ATTR = 'data-recued-notify-toast';
export const NOTIFY_TOAST_DISMISS_ATTR = 'data-recued-notify-toast-dismiss';
/** Marker attr for the `<head>` `<style>` tag the bootstrap injects once
 *  (marker-guarded so a re-bootstrap on the same document doesn't stack). */
export const NOTIFY_TOASTS_STYLES_MARKER = 'data-recued-notify-toasts-styles';

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

const DEFAULT_DURATION_MS = 6000;
const DEFAULT_MAX_VISIBLE = 4;

const safeNotifyLink = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  if (/^#data\/view\/view_[a-f0-9-]{36}$/.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch { return undefined; }
};

const nonBlankTitle = (title: string | undefined): string | undefined => {
  // `typeof` guard (not `=== undefined`): the runtime subscriber only
  // kind-narrows frames, so a malformed / version-skewed notify could carry
  // a non-string title (null / object). Treat anything non-string as
  // no-title rather than throwing on `.trim()`.
  if (typeof title !== 'string') return undefined;
  const trimmed = title.trim();
  return trimmed === '' ? undefined : trimmed;
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountNotifyToasts = (
  opts: MountNotifyToastsOptions,
): NotifyToastsMount => {
  const doc =
    opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountNotifyToasts: no document available — pass `opts.document` for non-browser environments',
    );
  }
  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS;
  const maxVisible = Math.max(1, opts.maxVisible ?? DEFAULT_MAX_VISIBLE);
  const setTimer =
    opts.setTimer
    ?? ((fn: () => void, ms: number) =>
      (globalThis as { setTimeout: (fn: () => void, ms: number) => unknown })
        .setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer
    ?? ((handle: unknown) =>
      (globalThis as { clearTimeout: (h: unknown) => void }).clearTimeout(
        handle,
      ));

  interface InternalToast extends NotifyToast {
    timer: unknown | null;
  }

  let disposed = false;
  let seq = 0;
  const toasts: InternalToast[] = [];
  const cards = new Map<string, HTMLElement>();

  const container = doc.createElement('div');
  container.setAttribute(NOTIFY_TOASTS_HOST_ATTR, '');
  container.setAttribute('role', 'status');
  // Polite so a toast announces without interrupting the user's current
  // screen-reader context; `atomic=false` so each appended toast is read
  // on its own rather than re-reading the whole stack.
  container.setAttribute('aria-live', 'polite');
  container.setAttribute('aria-atomic', 'false');
  container.className = 'notify-toasts';
  opts.host.appendChild(container);

  const focusedToastId = (): string | null => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    if (
      active === undefined
      || active === null
      || typeof active.closest !== 'function'
      || !container.contains(active)
    ) return null;
    const card = active.closest(`[${NOTIFY_TOAST_ATTR}]`);
    return card?.getAttribute(NOTIFY_TOAST_ATTR) ?? null;
  };

  const renderToast = (t: InternalToast): HTMLElement => {
    const card = doc.createElement('div');
    card.setAttribute(NOTIFY_TOAST_ATTR, t.id);
    card.className = 'notify-toast';

    const body = doc.createElement('div');
    body.className = 'notify-toast-body';
    const title = nonBlankTitle(t.title);
    if (title !== undefined) {
      const titleEl = doc.createElement('span');
      titleEl.className = 'notify-toast-title';
      titleEl.textContent = title;
      body.appendChild(titleEl);
    }
    const textEl = doc.createElement('span');
    textEl.className = 'notify-toast-text';
    textEl.textContent = t.text;
    body.appendChild(textEl);
    if (t.link_url) {
      const link = doc.createElement('a');
      link.setAttribute('href', t.link_url);
      link.textContent = 'Open';
      body.appendChild(link);
    }
    card.appendChild(body);

    const dismiss = doc.createElement('button');
    dismiss.type = 'button';
    dismiss.setAttribute(NOTIFY_TOAST_DISMISS_ATTR, t.id);
    const dismissContext = title === undefined
      ? t.text
      : `${title} — ${t.text}`;
    dismiss.setAttribute(
      'aria-label',
      dismissContext.trim() === ''
        ? 'Dismiss notification'
        : `Dismiss notification: ${dismissContext}`,
    );
    dismiss.className = 'notify-toast-dismiss';
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => dismiss_(t.id));
    card.appendChild(dismiss);

    return card;
  };

  const removeToastCard = (id: string): void => {
    const card = cards.get(id);
    if (card === undefined) return;
    cards.delete(id);
    card.remove();
  };

  const prependToastCard = (toast: InternalToast): HTMLElement => {
    const card = renderToast(toast);
    cards.set(toast.id, card);
    container.insertBefore(card, container.firstChild);
    return card;
  };

  const focusToastDismiss = (card: HTMLElement): void => {
    const dismiss = Array.from(card.children).find((candidate) =>
      candidate.hasAttribute(NOTIFY_TOAST_DISMISS_ATTR)) as HTMLElement | undefined;
    dismiss?.focus?.({ preventScroll: true });
  };

  const armAutoDismiss = (toast: InternalToast): void => {
    toast.timer = setTimer(() => {
      toast.timer = null;
      if (disposed || !toasts.includes(toast)) return;
      // Do not remove the control a keyboard owner is actively using. A full
      // fresh interval after focus leaves keeps the policy deterministic
      // without requiring pointer/focus bookkeeping or a ticking clock.
      if (focusedToastId() === toast.id) {
        armAutoDismiss(toast);
        return;
      }
      dismiss_(toast.id);
    }, durationMs);
  };

  // Named with a trailing underscore so the dismiss button handler + the
  // public `dismiss` can both reach it before the return object exists.
  const dismiss_ = (id: string): void => {
    if (disposed) return;
    const idx = toasts.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const focusOwned = focusedToastId() === id;
    // DOM order is newest-first while `toasts` is oldest-first. Prefer the
    // next card below the dismissed one visually, then the nearest card above.
    const focusSuccessor = focusOwned
      ? toasts[idx - 1] ?? toasts[idx + 1]
      : undefined;
    const [removed] = toasts.splice(idx, 1);
    if (removed && removed.timer !== null) clearTimer(removed.timer);
    removeToastCard(id);
    if (focusSuccessor !== undefined) {
      const successorCard = cards.get(focusSuccessor.id);
      if (successorCard !== undefined) focusToastDismiss(successorCard);
    }
  };

  const push = (title: string | undefined, text: string, link_url?: string): void => {
    if (disposed) return;
    const id = `toast-${(seq += 1)}`;
    const toast: InternalToast = {
      id,
      ...(title !== undefined ? { title } : {}),
      text,
      ...(link_url ? { link_url } : {}),
      timer: null,
    };
    // Evict oldest beyond the cap BEFORE appending the new one, cancelling
    // their timers. The feed keeps the full record, so eviction is a
    // display bound, not data loss.
    const focusedId = focusedToastId();
    let evictedFocusedToast = false;
    while (toasts.length >= maxVisible) {
      const nonFocusedIndex = toasts.findIndex((candidate) =>
        candidate.id !== focusedId);
      const [evicted] = toasts.splice(
        nonFocusedIndex < 0 ? 0 : nonFocusedIndex,
        1,
      );
      if (evicted) {
        if (evicted.id === focusedId) evictedFocusedToast = true;
        if (evicted.timer !== null) clearTimer(evicted.timer);
        removeToastCard(evicted.id);
      }
    }
    if (durationMs > 0) {
      armAutoDismiss(toast);
    }
    toasts.push(toast);
    const card = prependToastCard(toast);
    // With maxVisible=1 there is no non-focused eviction candidate. Keep
    // keyboard ownership inside the toast layer by handing the retired
    // control directly to the only surviving Dismiss action.
    if (evictedFocusedToast) focusToastDismiss(card);
  };

  const unsubscribe = opts.subscribe('notification.notify', (event) => {
    if (disposed) return;
    // Defense-in-depth: the runtime subscriber only kind-narrows frames, so
    // a malformed / version-skewed notify with a non-string `text` is
    // dropped — pushing it would schedule a timer + throw while creating the
    // card, wedging this default-on overlay. A non-string title degrades to
    // no-title (via `nonBlankTitle`); guarded here too for clarity.
    if (typeof event.text !== 'string') return;
    push(typeof event.title === 'string' ? event.title : undefined, event.text, safeNotifyLink(event.link_url));
  });

  return {
    getToasts: () => toasts.map((t) => ({
      id: t.id,
      ...(t.title !== undefined ? { title: t.title } : {}),
      ...(t.link_url ? { link_url: t.link_url } : {}),
      text: t.text,
    })),
    dismiss: (id) => dismiss_(id),
    push: (toast) => {
      if (typeof toast.text !== 'string') return;
      push(nonBlankTitle(toast.title), toast.text);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const t of toasts) {
        if (t.timer !== null) clearTimer(t.timer);
      }
      toasts.length = 0;
      cards.clear();
      try {
        unsubscribe();
      } catch {
        // Unsubscribe errors are isolated — the subscriber owns its own
        // teardown; we just drop the handle.
      }
      try {
        opts.host.removeChild(container);
      } catch {
        // Detached host / fake DOM — ignore; the subscription is dropped.
      }
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

/** Self-scoped CSS for the toast overlay. The bootstrap injects this once
 *  at boot (mirrors the reauth banner's style injection). Fixed to the
 *  top-right; toasts stack downward, newest on top. */
export const NOTIFY_TOASTS_STYLES = `
[${NOTIFY_TOASTS_HOST_ATTR}] {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(320px, calc(100vw - 32px));
  max-width: 320px;
  pointer-events: none;
}
[${NOTIFY_TOASTS_HOST_ATTR}] .notify-toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  color: var(--fg);
  font-size: 13px;
}
[${NOTIFY_TOASTS_HOST_ATTR}] .notify-toast-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}
[${NOTIFY_TOASTS_HOST_ATTR}] .notify-toast-title {
  font-weight: 600;
  overflow-wrap: anywhere;
}
[${NOTIFY_TOASTS_HOST_ATTR}] .notify-toast-text {
  color: var(--fg-muted);
  font-size: 12px;
  word-break: break-word;
}
[${NOTIFY_TOASTS_HOST_ATTR}] .notify-toast-body a {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  min-height: 36px;
  color: var(--accent);
}
[${NOTIFY_TOASTS_HOST_ATTR}] .notify-toast-body a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
[${NOTIFY_TOASTS_HOST_ATTR}] .notify-toast-dismiss {
  box-sizing: border-box;
  display: inline-flex;
  width: 36px;
  height: 36px;
  flex: none;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--fg-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
[${NOTIFY_TOASTS_HOST_ATTR}] .notify-toast-dismiss:hover {
  color: var(--fg);
}
[${NOTIFY_TOASTS_HOST_ATTR}] .notify-toast-dismiss:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  color: var(--fg);
}
@media (max-width: 520px) {
  [${NOTIFY_TOASTS_HOST_ATTR}] .notify-toast-body a { min-height: 44px; }
  [${NOTIFY_TOASTS_HOST_ATTR}] .notify-toast-dismiss {
    width: 44px;
    height: 44px;
  }
}
`;
