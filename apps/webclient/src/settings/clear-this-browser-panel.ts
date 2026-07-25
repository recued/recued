/** D-148 § A.4.1 — "Clear this browser" panel (NEXT-#2 advance, slice 109).
 *
 *  The user-facing surface that drives the closed-list storage wipe
 *  documented in spec § A.4.1: every paired-state field in the IDB
 *  `recued.webclient.local_storage` store, the AES-GCM key in
 *  `recued.webclient.token_key`, `sessionStorage`, the service-worker
 *  cache, and the service-worker registration itself. The substrate
 *  (`clearThisBrowser` + `wipeWebclientCryptoKeyStore` +
 *  `unregisterServiceWorker`) shipped in earlier slices; this module
 *  is the DOM surface that composes them.
 *
 *  ── Two exports ────────────────────────────────────────────────────
 *    - `mountClearThisBrowserPanel(opts)` — DOM-construction mount.
 *      Returns a handle exposing `dispose()` / `getState()` plus
 *      test-only click drivers. Self-contained: the panel manages
 *      its own state machine + DOM rebuild on each transition.
 *    - `CLEAR_THIS_BROWSER_PANEL_STYLES` — self-scoped CSS the host
 *      injects once at boot (the future Settings → Privacy route will
 *      bundle this alongside the page's other styles).
 *
 *  ── State machine ──────────────────────────────────────────────────
 *
 *      idle  ── click Clear ──▶ confirm
 *      confirm ── Cancel ──▶ idle
 *      confirm ── Yes, clear ──▶ busy
 *      busy ── clear succeeded ──▶ done
 *      busy ── clear failed ──▶ error
 *      error ── Retry ──▶ confirm
 *      error ── Cancel ──▶ idle
 *      done  ── Reload ──▶ reloader()  (terminal — page replaces)
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — Two-tap destructive guard. Clearing the browser revokes the
 *  user's credentials + drops every cached asset; an accidental click
 *  would force a full re-pair. The idle → confirm step makes the
 *  destructive transition explicit; the busy state's disabled buttons
 *  + Confirm button's `danger` variant signal severity without an OS
 *  modal (the panel can mount inside any host, including a fragment of
 *  a wider settings page).
 *
 *  DD#2 — Substrate reuse, no re-implementation. The actual wipe is
 *  `clearThisBrowser` from `auth/clear-this-browser.ts` (closed-list
 *  IDB fields + sessionStorage + SW cache + caller-supplied crypto-key
 *  wiper) followed by `unregisterServiceWorker` from
 *  `runtime/service-worker.ts`. We do NOT add a fourth wipe primitive
 *  here; the panel is composition, not a new clearing path. The result
 *  rendered in the `done` state is the structured
 *  `ClearThisBrowserResult` + a separate `sw_unregistered` boolean.
 *
 *  DD#3 — Manual reload, no auto-redirect. Per the slice 109 UX
 *  decision, the `done` state surfaces a "Reload to re-pair" button +
 *  the structured result rather than auto-reloading. Two reasons:
 *  (1) the user just performed a destructive action and deserves to
 *  read what happened before the page replaces; (2) a programmatic
 *  reload BEFORE the user has dismissed the result strands users who
 *  hit the button by accident — they'd lose state without knowing why.
 *
 *  DD#4 — `reloader` is a seam, not a hard `location.reload` call.
 *  Production wires `() => globalThis.location?.reload()`; tests inject
 *  a fake that records the call. Without the seam the panel is
 *  effectively untestable past the busy state.
 *
 *  DD#5 — `crypto_keys_wiper` stays a caller-supplied hook. The token-
 *  key store lives in a separate IDB object store (`recued.webclient.token_key`);
 *  the production wiper is `wipeWebclientCryptoKeyStore` from
 *  `webclient-main.ts` which re-opens the database itself. The panel
 *  doesn't own that handle — the future Settings → Privacy route mounts
 *  this panel with `{ crypto_keys_wiper: wipeWebclientCryptoKeyStore }`.
 *  Omitting the wiper leaves the AES key behind; the `done` state's
 *  result row reflects that (false) so the user understands the reset
 *  is partial — matches the contract in `clearThisBrowser`.
 *
 *  DD#6 — Render-on-transition rebuild. Every state change rebuilds
 *  the panel's inner DOM via `createElement` + new event listeners.
 *  The host element itself stays attached; only its children swap.
 *  This is the simpler pattern for a multi-state panel — alternatives
 *  (pre-build every state's DOM + display:none) bloat the markup +
 *  complicate the dispatch wiring (a button in a hidden subtree still
 *  receives clicks via keyboard nav). The rebuilds happen at most ~5
 *  times across the panel's life so the GC cost is negligible.
 *
 *  DD#7 — Errors are recoverable, not terminal — but the error copy
 *  must NOT imply atomic rollback. `clearThisBrowser` runs four
 *  sequential awaits (local_store / session / cache / crypto-key);
 *  a throw at any step propagates up while earlier steps remain
 *  applied. So the `error` state's copy admits to partial wipe and
 *  points the user at the only safe recovery (re-pair from server).
 *  Retry stays available because the substrate is idempotent — re-
 *  running clears the same fields again (no-op on already-empty
 *  surfaces) and may push past the previously-failing step. Partial
 *  successes that originate from `unregisterServiceWorker` failures
 *  still land in `done` state because `clearThisBrowser` itself
 *  succeeded; the result row shows what was actually cleared (Codex
 *  slice-109 P2 fold rewrote DD#7 + the error copy).
 *
 *  Spec: docs/d-148-spec.md § A.4.1 + invariant I-11. */

import {
  clearThisBrowser,
  type CacheLikeStorage,
  type ClearThisBrowserResult,
  type SessionLikeStorage,
} from '../auth/clear-this-browser.js';
import type { WebclientLocalStore } from '../storage/local-store.js';
import {
  unregisterServiceWorker,
  type ServiceWorkerEnvironment,
} from '../runtime/service-worker.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Element ids — stable for DOM tests + host introspection
// ════════════════════════════════════════════════════════════════

export const CLEAR_THIS_BROWSER_PANEL_ATTR =
  'data-recued-clear-this-browser-panel';
export const CLEAR_THIS_BROWSER_PANEL_STATE_ATTR =
  'data-recued-clear-this-browser-panel-state';
export const CLEAR_THIS_BROWSER_CLEAR_BTN_ATTR =
  'data-recued-clear-this-browser-clear';
export const CLEAR_THIS_BROWSER_CONFIRM_BTN_ATTR =
  'data-recued-clear-this-browser-confirm';
export const CLEAR_THIS_BROWSER_CANCEL_BTN_ATTR =
  'data-recued-clear-this-browser-cancel';
export const CLEAR_THIS_BROWSER_RETRY_BTN_ATTR =
  'data-recued-clear-this-browser-retry';
export const CLEAR_THIS_BROWSER_RELOAD_BTN_ATTR =
  'data-recued-clear-this-browser-reload';
export const CLEAR_THIS_BROWSER_STATUS_ATTR =
  'data-recued-clear-this-browser-status';
export const CLEAR_THIS_BROWSER_RESULT_ATTR =
  'data-recued-clear-this-browser-result';

// ════════════════════════════════════════════════════════════════
// Options + handle
// ════════════════════════════════════════════════════════════════

export type ClearThisBrowserPanelState =
  | 'idle'
  | 'confirm'
  | 'busy'
  | 'done'
  | 'error';

export interface MountClearThisBrowserPanelOptions {
  /** Host element the panel renders into. The panel appends a single
   *  wrapper div + rebuilds its inner contents across state changes.
   *  Dispose drops the wrapper. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** Closed-list 5-field local store — forwarded to `clearThisBrowser`. */
  localStore: WebclientLocalStore;
  /** Optional sessionStorage seam — forwarded to `clearThisBrowser`.
   *  Tests inject a fake; production lets the substrate resolve global
   *  `sessionStorage`. */
  session_storage?: SessionLikeStorage;
  /** Optional CacheStorage seam — forwarded to `clearThisBrowser`. */
  cache_storage?: CacheLikeStorage;
  /** Optional SW cache names override — forwarded to `clearThisBrowser`. */
  sw_cache_names?: string[];
  /** Optional AES-GCM key store wiper — forwarded to `clearThisBrowser`
   *  (DD#5). When omitted the key store is left in place; the `done`
   *  state's result row reflects that. */
  crypto_keys_wiper?: () => Promise<void>;
  /** Optional service-worker environment seam — forwarded to
   *  `unregisterServiceWorker`. Tests inject a fake; production lets
   *  the substrate resolve `globalThis.navigator.serviceWorker`. */
  sw_environment?: ServiceWorkerEnvironment;
  /** Reload callback fired when the user clicks "Reload to re-pair".
   *  Defaults to `() => globalThis.location?.reload()` (DD#4). */
  reloader?: () => void;
  /** Invoked after a successful clear lands in the `done` state. Lets
   *  the host surface telemetry / audit without coupling to the panel
   *  internals. */
  onCleared?: (result: ClearThisBrowserResult, sw_unregistered: boolean) => void;
}

export interface ClearThisBrowserPanelMount {
  /** Current state — primary surface for tests + host introspection. */
  getState(): ClearThisBrowserPanelState;
  /** Tear down the panel DOM + remove event listeners. Idempotent. */
  dispose(): void;
  /** Test-only: drive the idle → confirm transition without a click. */
  clickClear(): void;
  /** Test-only: drive the confirm → busy → (done | error) transition. */
  clickConfirm(): Promise<void>;
  /** Test-only: drive cancel from `confirm` or `error`. */
  clickCancel(): void;
  /** Test-only: drive the error → confirm retry path. */
  clickRetry(): void;
  /** Test-only: drive the reloader from the `done` state. */
  clickReload(): void;
}

// ════════════════════════════════════════════════════════════════
// Copy
// ════════════════════════════════════════════════════════════════

const COPY = {
  warning:
    'This wipes every credential, cache, and key from this browser. You will be logged out and must re-pair from your recued-server to come back.',
  confirm_question:
    'Are you sure? This browser will lose access to your warehouse until you re-pair.',
  busy: 'Clearing…',
  done_heading: 'This browser has been cleared.',
  done_subtitle: 'Reload to re-pair from your recued-server.',
  error_heading: 'Clearing this browser failed partway.',
  // Codex slice-109 P2 fold — pre-fold the copy claimed "No state was
  // changed", but `clearThisBrowser` is NOT atomic: an exception thrown
  // *after* `local_store.clear()` succeeds (e.g. a cache-storage delete
  // failure or a crypto-key wiper throw) leaves the closed-list 5
  // fields wiped while the wipe path bails out with an exception. The
  // panel therefore lands in `error` with state already partially
  // gone. The new copy is honest about that and points the user at
  // the only safe recovery: re-pair.
  error_subtitle:
    'Some surfaces may have been wiped before the error. Retry to finish the clear, or cancel — you may need to re-pair from your recued-server regardless.',
} as const;

const RESULT_ROW_LABELS = {
  cleared_local_store: 'Local store wiped',
  cleared_session_storage: 'Session storage cleared',
  cleared_sw_caches: 'Service-worker caches deleted',
  cleared_crypto_keys: 'Crypto key store wiped',
  sw_unregistered: 'Service worker unregistered',
} as const;

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

/** Mount the panel into `opts.host`. Returns a handle. */
export const mountClearThisBrowserPanel = (
  opts: MountClearThisBrowserPanelOptions,
): ClearThisBrowserPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountClearThisBrowserPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }

  // ── State ────────────────────────────────────────────────────────
  let state: ClearThisBrowserPanelState = 'idle';
  let disposed = false;
  let lastResult: ClearThisBrowserResult | null = null;
  let lastSwUnregistered = false;
  let lastError: string = '';
  // Track the in-flight clear so the test seam can await completion
  // even though the click handler itself is sync. Production code
  // ignores this — the state machine alone drives the user-visible
  // surface.
  let pendingClearPromise: Promise<void> | null = null;
  // Stable event-handler refs for the current render pass. Each render
  // rebuilds the DOM + replaces these so dispose's no-op semantics
  // (DOM gone) suffice; we don't track them across renders.

  // ── Wrapper ──────────────────────────────────────────────────────
  const wrapper = doc.createElement('div');
  wrapper.setAttribute(CLEAR_THIS_BROWSER_PANEL_ATTR, '');
  wrapper.setAttribute(CLEAR_THIS_BROWSER_PANEL_STATE_ATTR, state);
  wrapper.className = 'clear-this-browser-panel';
  opts.host.appendChild(wrapper);

  // ── Transitions ──────────────────────────────────────────────────
  const transitionTo = (next: ClearThisBrowserPanelState): void => {
    if (disposed) return;
    state = next;
    wrapper.setAttribute(CLEAR_THIS_BROWSER_PANEL_STATE_ATTR, state);
    render();
  };

  const runClear = async (): Promise<void> => {
    if (disposed) return;
    transitionTo('busy');
    try {
      const clearOpts: Parameters<typeof clearThisBrowser>[0] = {
        local_store: opts.localStore,
        ...(opts.session_storage !== undefined
          ? { session_storage: opts.session_storage }
          : {}),
        ...(opts.cache_storage !== undefined
          ? { cache_storage: opts.cache_storage }
          : {}),
        ...(opts.sw_cache_names !== undefined
          ? { sw_cache_names: opts.sw_cache_names }
          : {}),
        ...(opts.crypto_keys_wiper !== undefined
          ? { crypto_keys_wiper: opts.crypto_keys_wiper }
          : {}),
      };
      const result = await clearThisBrowser(clearOpts);
      // SW unregister is a separate primitive (different IDB / API
      // surface than the clear). A failure here doesn't roll the
      // clear back — surface it in the result instead.
      let sw_unregistered = false;
      try {
        sw_unregistered = await unregisterServiceWorker(opts.sw_environment);
      } catch {
        sw_unregistered = false;
      }
      lastResult = result;
      lastSwUnregistered = sw_unregistered;
      lastError = '';
      transitionTo('done');
      if (opts.onCleared) {
        try {
          opts.onCleared(result, sw_unregistered);
        } catch {
          /* onCleared is best-effort telemetry; never re-enter the panel */
        }
      }
    } catch (err) {
      lastError = humanizeRpcError(err);
      transitionTo('error');
    }
  };

  // ── Render ───────────────────────────────────────────────────────
  const clearChildren = (): void => {
    while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
  };

  const makeButton = (
    label: string,
    attr: string,
    variant: 'danger' | 'primary' | 'secondary',
    onClick: () => void,
    disabledFlag = false,
  ): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.setAttribute(attr, '');
    btn.type = 'button';
    btn.textContent = label;
    btn.className = `rx-btn rx-btn-${variant} rx-btn-sm clear-this-browser-btn clear-this-browser-btn-${variant}`;
    if (disabledFlag) btn.disabled = true;
    btn.addEventListener('click', onClick);
    return btn;
  };

  const renderIdle = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'clear-this-browser-title';
    heading.textContent = 'Clear this browser';

    const help = doc.createElement('p');
    help.className = 'clear-this-browser-help';
    help.textContent = COPY.warning;

    const actions = doc.createElement('div');
    actions.className = 'clear-this-browser-actions';
    actions.appendChild(
      makeButton('Clear this browser', CLEAR_THIS_BROWSER_CLEAR_BTN_ATTR, 'danger', () =>
        transitionTo('confirm'),
      ),
    );

    wrapper.appendChild(heading);
    wrapper.appendChild(help);
    wrapper.appendChild(actions);
  };

  const renderConfirm = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'clear-this-browser-title';
    heading.textContent = 'Clear this browser';

    const question = doc.createElement('p');
    question.className = 'clear-this-browser-help clear-this-browser-help-confirm';
    question.setAttribute(CLEAR_THIS_BROWSER_STATUS_ATTR, '');
    question.setAttribute('role', 'alert');
    question.textContent = COPY.confirm_question;

    const actions = doc.createElement('div');
    actions.className = 'clear-this-browser-actions';
    actions.appendChild(
      makeButton('Cancel', CLEAR_THIS_BROWSER_CANCEL_BTN_ATTR, 'secondary', () =>
        transitionTo('idle'),
      ),
    );
    actions.appendChild(
      makeButton('Yes, clear', CLEAR_THIS_BROWSER_CONFIRM_BTN_ATTR, 'danger', () => {
        pendingClearPromise = runClear();
      }),
    );

    wrapper.appendChild(heading);
    wrapper.appendChild(question);
    wrapper.appendChild(actions);
  };

  const renderBusy = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'clear-this-browser-title';
    heading.textContent = 'Clear this browser';

    const status = doc.createElement('p');
    status.className = 'clear-this-browser-help clear-this-browser-help-busy';
    status.setAttribute(CLEAR_THIS_BROWSER_STATUS_ATTR, '');
    status.setAttribute('role', 'status');
    status.textContent = COPY.busy;

    const actions = doc.createElement('div');
    actions.className = 'clear-this-browser-actions';
    // Both buttons disabled while the wipe is in flight (clearThisBrowser
    // has no cancel primitive; surfacing a usable button mid-wipe would
    // let a second click re-enter runClear before the first finished).
    const cancelBtn = makeButton(
      'Cancel',
      CLEAR_THIS_BROWSER_CANCEL_BTN_ATTR,
      'secondary',
      () => undefined,
      true,
    );
    const confirmBtn = makeButton(
      'Yes, clear',
      CLEAR_THIS_BROWSER_CONFIRM_BTN_ATTR,
      'danger',
      () => undefined,
      true,
    );
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    wrapper.appendChild(heading);
    wrapper.appendChild(status);
    wrapper.appendChild(actions);
  };

  const renderDone = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'clear-this-browser-title clear-this-browser-title-done';
    heading.textContent = COPY.done_heading;

    const subtitle = doc.createElement('p');
    subtitle.className = 'clear-this-browser-help';
    subtitle.textContent = COPY.done_subtitle;

    const list = doc.createElement('ul');
    list.setAttribute(CLEAR_THIS_BROWSER_RESULT_ATTR, '');
    list.className = 'clear-this-browser-result';
    const result = lastResult;
    if (result !== null) {
      const rows: Array<[keyof typeof RESULT_ROW_LABELS, boolean]> = [
        ['cleared_local_store', result.cleared_local_store],
        ['cleared_session_storage', result.cleared_session_storage],
        ['cleared_sw_caches', result.cleared_sw_caches],
        ['cleared_crypto_keys', result.cleared_crypto_keys],
        ['sw_unregistered', lastSwUnregistered],
      ];
      for (const [key, value] of rows) {
        const li = doc.createElement('li');
        li.setAttribute('data-recued-clear-this-browser-row', key);
        li.setAttribute('data-cleared', String(value));
        li.className = `clear-this-browser-row clear-this-browser-row-${
          value ? 'ok' : 'skip'
        }`;
        const mark = doc.createElement('span');
        mark.className = 'clear-this-browser-mark';
        mark.textContent = value ? '✓' : '—';
        const label = doc.createElement('span');
        label.className = 'clear-this-browser-label';
        label.textContent = RESULT_ROW_LABELS[key];
        li.appendChild(mark);
        li.appendChild(label);
        list.appendChild(li);
      }
    }

    const actions = doc.createElement('div');
    actions.className = 'clear-this-browser-actions';
    actions.appendChild(
      makeButton(
        'Reload to re-pair',
        CLEAR_THIS_BROWSER_RELOAD_BTN_ATTR,
        'primary',
        runReload,
      ),
    );

    wrapper.appendChild(heading);
    wrapper.appendChild(subtitle);
    wrapper.appendChild(list);
    wrapper.appendChild(actions);
  };

  const renderError = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'clear-this-browser-title clear-this-browser-title-error';
    heading.textContent = COPY.error_heading;

    const subtitle = doc.createElement('p');
    subtitle.className = 'clear-this-browser-help';
    subtitle.textContent = COPY.error_subtitle;

    const errBox = doc.createElement('p');
    errBox.setAttribute(CLEAR_THIS_BROWSER_STATUS_ATTR, '');
    errBox.setAttribute('role', 'alert');
    errBox.className = 'clear-this-browser-error';
    errBox.textContent = lastError;

    const actions = doc.createElement('div');
    actions.className = 'clear-this-browser-actions';
    actions.appendChild(
      makeButton('Cancel', CLEAR_THIS_BROWSER_CANCEL_BTN_ATTR, 'secondary', () =>
        transitionTo('idle'),
      ),
    );
    actions.appendChild(
      makeButton('Retry', CLEAR_THIS_BROWSER_RETRY_BTN_ATTR, 'danger', () =>
        transitionTo('confirm'),
      ),
    );

    wrapper.appendChild(heading);
    wrapper.appendChild(subtitle);
    wrapper.appendChild(errBox);
    wrapper.appendChild(actions);
  };

  const runReload = (): void => {
    if (disposed) return;
    if (opts.reloader) {
      opts.reloader();
      return;
    }
    const loc = (globalThis as { location?: { reload?: () => void } }).location;
    if (loc?.reload) loc.reload();
  };

  const render = (): void => {
    if (disposed) return;
    clearChildren();
    switch (state) {
      case 'idle':
        renderIdle();
        break;
      case 'confirm':
        renderConfirm();
        break;
      case 'busy':
        renderBusy();
        break;
      case 'done':
        renderDone();
        break;
      case 'error':
        renderError();
        break;
    }
  };

  // Initial paint.
  render();

  // ── Test seams ───────────────────────────────────────────────────
  // Walk the wrapper tree by hand rather than reaching for
  // `querySelector` — the fake-DOM the webclient's vitest config wires
  // doesn't ship `querySelector`. Two test fakes are in play across
  // the webclient test suite — one exposes children as `children`
  // (the panel test fake), the other as `childList` (the bootstrap
  // test fake). The real DOM only has `children`; reading whichever
  // is non-null keeps the seam compatible with both fakes + the real
  // DOM without dragging a shared fake-DOM helper into production code.
  const findBtn = (attr: string): HTMLButtonElement | null => {
    const walk = (
      node: HTMLElement,
    ): HTMLButtonElement | null => {
      if (
        typeof node.hasAttribute === 'function' &&
        node.hasAttribute(attr) &&
        node.tagName === 'BUTTON'
      ) {
        return node as HTMLButtonElement;
      }
      const kids =
        (node as unknown as { children?: ArrayLike<HTMLElement> }).children ??
        (node as unknown as { childList?: ArrayLike<HTMLElement> }).childList;
      if (!kids) return null;
      const length = (kids as { length: number }).length;
      for (let i = 0; i < length; i += 1) {
        const hit = walk(kids[i] as HTMLElement);
        if (hit) return hit;
      }
      return null;
    };
    return walk(wrapper as HTMLElement);
  };

  return {
    getState: () => state,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Children carry their own listeners; removing the wrapper drops
      // every dangling reference. `host.removeChild` is safer than
      // `wrapper.remove()` against a parent that may have been swapped
      // by the host, so we guard the call.
      try {
        opts.host.removeChild(wrapper);
      } catch {
        wrapper.remove();
      }
    },
    clickClear: () => {
      const b = findBtn(CLEAR_THIS_BROWSER_CLEAR_BTN_ATTR);
      if (b && !b.disabled) b.click();
    },
    clickConfirm: async () => {
      const b = findBtn(CLEAR_THIS_BROWSER_CONFIRM_BTN_ATTR);
      if (b && !b.disabled) b.click();
      // Await the in-flight clear so tests observe the post-transition
      // state (`done` / `error`) without raw setTimeout shenanigans.
      // If the click was a no-op (already busy / disabled) there is no
      // promise to await; the await-undefined branch is harmless.
      const pending = pendingClearPromise;
      if (pending) await pending;
    },
    clickCancel: () => {
      const b = findBtn(CLEAR_THIS_BROWSER_CANCEL_BTN_ATTR);
      if (b && !b.disabled) b.click();
    },
    clickRetry: () => {
      const b = findBtn(CLEAR_THIS_BROWSER_RETRY_BTN_ATTR);
      if (b && !b.disabled) b.click();
    },
    clickReload: () => {
      const b = findBtn(CLEAR_THIS_BROWSER_RELOAD_BTN_ATTR);
      if (b && !b.disabled) b.click();
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

export const CLEAR_THIS_BROWSER_PANEL_STYLES = `
[${CLEAR_THIS_BROWSER_PANEL_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
  line-height: 1.5;
}
[${CLEAR_THIS_BROWSER_PANEL_ATTR}][${CLEAR_THIS_BROWSER_PANEL_STATE_ATTR}="confirm"],
[${CLEAR_THIS_BROWSER_PANEL_ATTR}][${CLEAR_THIS_BROWSER_PANEL_STATE_ATTR}="busy"],
[${CLEAR_THIS_BROWSER_PANEL_ATTR}][${CLEAR_THIS_BROWSER_PANEL_STATE_ATTR}="error"] {
  border-color: var(--fail);
  background: var(--fail-soft);
}
.clear-this-browser-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
}
.clear-this-browser-title-error {
  color: var(--fail);
}
.clear-this-browser-title-done {
  color: var(--accent);
}
.clear-this-browser-help {
  margin: 0;
  font-size: 12px;
}
.clear-this-browser-help-confirm {
  font-weight: 500;
  color: var(--fail);
}
.clear-this-browser-help-busy {
  opacity: 0.75;
}
.clear-this-browser-error {
  margin: 0;
  padding: 8px 10px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--fail);
  white-space: pre-wrap;
  word-break: break-word;
}
.clear-this-browser-result {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.clear-this-browser-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
}
.clear-this-browser-row-ok .clear-this-browser-mark {
  color: var(--accent);
  font-weight: 600;
}
.clear-this-browser-row-skip {
  opacity: 0.55;
}
.clear-this-browser-row-skip .clear-this-browser-mark {
  font-weight: 600;
}
.clear-this-browser-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.clear-this-browser-btn-danger {
  background: var(--fail);
  border-color: var(--fail);
  color: var(--on-danger);
}
.clear-this-browser-btn-danger:hover:not(:disabled) {
  filter: brightness(0.92);
}
`;
