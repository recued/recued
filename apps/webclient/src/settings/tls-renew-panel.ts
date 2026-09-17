/** D-148 § A.6.5 — the "Renew TLS cert now" panel, under Settings → Server →
 *  Certificates (NEXT-#2 advance, slice 111).
 *
 *  The user-facing surface that drives operator-initiated TLS cert
 *  renewal. Calls `tls.renew` rpc through an injected caller seam,
 *  renders the closed-list `RotationResult` outcome (success → new
 *  fingerprint + scheduled flip time; failure → `ROTATION_ERROR_COPY`
 *  remediation hint).
 *
 *  The substrate this composes shipped in earlier slices:
 *    - slice 90 — `tls.renew` rpc handler (operator-only; rejects pre-
 *      register callers; rejects `rotation_at_offset_ms = 0`).
 *    - slice 92 — `tls-cert-renewal` lifecycle scheduler (auto path).
 *    - slice 94 — production `TlsRenewalHook` ACME flow.
 *    - slice 100 — `bin.ts` production renewer composition.
 *  This module is the DOM surface that pushes the operator's "Renew
 *  now" button.
 *
 *  ── Two exports ────────────────────────────────────────────────────
 *    - `mountTlsRenewPanel(opts)` — DOM-construction mount. Returns a
 *      handle with `dispose()` / `getState()` / test-only click
 *      drivers. The panel manages its own state machine + DOM
 *      rebuild on each transition.
 *    - `TLS_RENEW_PANEL_STYLES` — self-scoped CSS the host injects
 *      once at boot (the Settings route bundles this alongside the
 *      Privacy panel's styles + the route's own CSS).
 *
 *  ── State machine ──────────────────────────────────────────────────
 *
 *      idle  ── click Renew ──▶ confirm
 *      confirm ── Cancel ──▶ idle
 *      confirm ── Yes, renew ──▶ busy
 *      busy ── renew succeeded ──▶ done
 *      busy ── renew returned !ok ──▶ error
 *      busy ── caller threw ──▶ error
 *      done ── Close ──▶ idle           (terminal-then-reset)
 *      error ── Retry ──▶ confirm
 *      error ── Cancel ──▶ idle
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — Two-tap destructive guard mirroring the Privacy panel. A
 *  TLS rotation does not invalidate webclient credentials (the server
 *  identity key stays; only the TLS cert flips), but the rotation is
 *  audit-logged + broadcast as a signed `cert_rotation_notice` to
 *  every paired client. An accidental click would emit a real rotation
 *  notice + occupy the 7d overlap window unnecessarily. The idle →
 *  confirm step makes the operator-intentional transition explicit.
 *
 *  DD#2 — `runRenew` is the caller's narrow seam, not a baked-in
 *  `Conn<ServerRpcRegistry>` reference. The Settings route's mount
 *  wires `() => conn('tls.renew', reason ? { reason } : {})` from
 *  the bootstrap's rpc conn so the panel stays agnostic to the rpc
 *  layer. Tests inject a fake that resolves to whatever
 *  `RotationResult` the case under test exercises.
 *
 *  DD#3 — Done state is NOT terminal. Unlike "Clear this browser"
 *  (which leaves the page uncredentialed + must reload to re-pair),
 *  a TLS renewal leaves the webclient session intact. The done state
 *  surfaces the new fingerprint + scheduled flip + a "Close" button
 *  that returns to idle so a follow-up renewal is one click away. The
 *  `cert.rotation_notice` broadcast handler (slice 87) is what drives
 *  the actual cert-pin two-pin overlap on this client; the panel's
 *  job ends at "operator initiated the rotation".
 *
 *  DD#4 — Omit `rotation_at_offset_ms` from the rpc call. The engine
 *  defaults to a 7d lead (`DEFAULT_TLS_ROTATION_NOTICE_LEAD_MS`) —
 *  exactly the operator-initiated UX. Passing 0 would emit a notice
 *  pinned clients reject as `rotation_at_in_past` (rpc surface itself
 *  rejects it as `bad_request` per slice 90's Codex P2 fold). The
 *  panel never surfaces an offset knob — the operator just wants
 *  "renew now"; the engine handles the overlap math.
 *
 *  DD#5 — `now` seam for deterministic date formatting. Production
 *  wires `Date.now`; tests pin to a fixed instant so the rendered
 *  "flips on …" string is reproducible. Without the seam every test
 *  that hits the done state would need to match against a moving
 *  formatted-date string.
 *
 *  DD#6 — Errors that throw vs errors that return `{ ok: false }`
 *  both land in the `error` state with the same UI. The closed-list
 *  `RotationErrorCode` → remediation copy (`ROTATION_ERROR_COPY`)
 *  drives the user-visible hint when the substrate returned an
 *  error code; a thrown error (rpc transport / timeout / abort)
 *  surfaces the error message as the hint instead. Retry stays
 *  available either way — the rpc surface is idempotent past the
 *  in-progress guard (which itself surfaces as `rotation_in_progress`
 *  → "Wait for it to complete + retry").
 *
 *  DD#7 — Render-on-transition rebuild. Same pattern as the Privacy
 *  panel. Every state change rebuilds the panel's inner DOM via
 *  `createElement` + new event listeners. The host element itself
 *  stays attached; only its children swap.
 *
 *  Spec: D-148 § A.6.5 (operator-initiated cert renewal
 *  pathway) + § A.11 (rotation result shape). */

import type { RotationErrorCode, RotationResult } from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';

import { ROTATION_ERROR_COPY } from './rotation-center.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Element ids — stable for DOM tests + host introspection
// ════════════════════════════════════════════════════════════════

export const TLS_RENEW_PANEL_ATTR = 'data-recued-tls-renew-panel';
export const TLS_RENEW_PANEL_STATE_ATTR =
  'data-recued-tls-renew-panel-state';
export const TLS_RENEW_RENEW_BTN_ATTR = 'data-recued-tls-renew-renew';
export const TLS_RENEW_CONFIRM_BTN_ATTR = 'data-recued-tls-renew-confirm';
export const TLS_RENEW_CANCEL_BTN_ATTR = 'data-recued-tls-renew-cancel';
export const TLS_RENEW_RETRY_BTN_ATTR = 'data-recued-tls-renew-retry';
export const TLS_RENEW_CLOSE_BTN_ATTR = 'data-recued-tls-renew-close';
export const TLS_RENEW_STATUS_ATTR = 'data-recued-tls-renew-status';
export const TLS_RENEW_FINGERPRINT_ATTR =
  'data-recued-tls-renew-fingerprint';
export const TLS_RENEW_ROTATED_AT_ATTR =
  'data-recued-tls-renew-rotated-at';
export const TLS_RENEW_ERROR_CODE_ATTR =
  'data-recued-tls-renew-error-code';

// ════════════════════════════════════════════════════════════════
// Options + handle
// ════════════════════════════════════════════════════════════════

export type TlsRenewPanelState =
  | 'idle'
  | 'confirm'
  | 'busy'
  | 'done'
  | 'error';

/** Caller seam for the `tls.renew` rpc. Resolves with the substrate's
 *  full `RotationResult` (success or failure) verbatim. A thrown error
 *  surfaces as an `error` state with the thrown message rather than a
 *  closed-list `RotationErrorCode`. */
export type TlsRenewCaller = (input: {
  reason?: string;
}) => Promise<RotationResult>;

export interface MountTlsRenewPanelOptions {
  /** Host element the panel renders into. Same shape as the Privacy
   *  panel — the panel appends a single wrapper div + rebuilds its
   *  inner contents across state changes. Dispose drops the wrapper. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** `tls.renew` rpc caller seam (DD#2). */
  runRenew: TlsRenewCaller;
  /** Optional reason string forwarded to the rpc. Today the panel does
   *  not surface a reason input box; the option is here so a future
   *  slice (e.g. "renewing because of incident X") can pass through
   *  without re-plumbing. */
  defaultReason?: string;
  /** `Date.now`-compatible clock for the done state's flip-time copy
   *  (DD#5). Defaults to `Date.now`. */
  now?: () => number;
  /** Invoked after a successful renew lands in the `done` state. Lets
   *  the host surface telemetry / refresh a cert-dependent row without
   *  coupling to the panel internals. ⚠ That row was the Reachability
   *  Doctor's until the tab was deleted (2026-09-16). Best-effort:
   *  a throw is swallowed by the panel. */
  onRenewed?: (result: Extract<RotationResult, { ok: true }>) => void;
}

export interface TlsRenewPanelMount {
  /** Current state — primary surface for tests + host introspection. */
  getState(): TlsRenewPanelState;
  /** Tear down the panel DOM + remove event listeners. Idempotent. */
  dispose(): void;
  /** Test-only: drive the idle → confirm transition. */
  clickRenew(): void;
  /** Test-only: drive the confirm → busy → (done | error) transition. */
  clickConfirm(): Promise<void>;
  /** Test-only: drive cancel from `confirm` or `error`. */
  clickCancel(): void;
  /** Test-only: drive the error → confirm retry path. */
  clickRetry(): void;
  /** Test-only: drive the done → idle close path. */
  clickClose(): void;
}

// ════════════════════════════════════════════════════════════════
// Copy
// ════════════════════════════════════════════════════════════════

const COPY = {
  idle_heading: 'TLS certificate',
  idle_body:
    'Get a new certificate now. The old one keeps working for 7 more days, so your devices accept the new one without pairing again. Use this if the automatic renewal is late, or if you think the old one has leaked.',
  confirm_heading: 'Get a new certificate?',
  // Match `ROTATION_COPY.tls_renew.confirm_body` from `rotation-center.ts`
  // so the operator sees the same explanation whether they reach the
  // flow through Key Health or through this dedicated panel.
  confirm_body:
    'With Pro, Recued gets one for you. Without it, Recued uses your own certificate tool on this machine. Either way it tells your devices, so they accept the new one without pairing again.',
  busy: 'Getting a new certificate…',
  done_heading: 'You have a new certificate.',
  done_body:
    'The new one is ready. Your devices will switch over at the set time.',
  error_heading: 'Recued could not get a new certificate.',
} as const;

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

const isErrorCode = (value: string): value is RotationErrorCode =>
  Object.prototype.hasOwnProperty.call(ROTATION_ERROR_COPY, value);

const remediationFor = (code: string | null, fallback: string): string => {
  if (code !== null && isErrorCode(code)) return ROTATION_ERROR_COPY[code];
  return fallback;
};

const formatRotatedAt = (rotated_at: number, now: number): string => {
  if (!Number.isFinite(rotated_at)) return 'unknown';
  const display = formatClientDateTime(rotated_at, { invalidText: 'unknown' });
  const diff_ms = rotated_at - now;
  const day_ms = 24 * 60 * 60 * 1000;
  if (diff_ms >= day_ms) {
    const days = Math.round(diff_ms / day_ms);
    return `${display} (in ~${days}d)`;
  }
  if (diff_ms > 0) {
    const hours = Math.round(diff_ms / (60 * 60 * 1000));
    return `${display} (in ~${hours}h)`;
  }
  return `${display} (now)`;
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

/** Mount the panel into `opts.host`. Returns a handle. */
export const mountTlsRenewPanel = (
  opts: MountTlsRenewPanelOptions,
): TlsRenewPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountTlsRenewPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }
  const now = opts.now ?? Date.now;

  // ── State ────────────────────────────────────────────────────────
  let state: TlsRenewPanelState = 'idle';
  let disposed = false;
  let lastSuccess: Extract<RotationResult, { ok: true }> | null = null;
  let lastErrorCode: RotationErrorCode | null = null;
  let lastErrorMessage = '';
  // Track the in-flight renew so the test seam can await completion
  // even though the click handler itself is sync.
  let pendingRenewPromise: Promise<void> | null = null;

  // ── Wrapper ──────────────────────────────────────────────────────
  const wrapper = doc.createElement('div');
  wrapper.setAttribute(TLS_RENEW_PANEL_ATTR, '');
  wrapper.setAttribute(TLS_RENEW_PANEL_STATE_ATTR, state);
  wrapper.className = 'tls-renew-panel';
  opts.host.appendChild(wrapper);

  // ── Transitions ──────────────────────────────────────────────────
  const transitionTo = (next: TlsRenewPanelState): void => {
    if (disposed) return;
    state = next;
    wrapper.setAttribute(TLS_RENEW_PANEL_STATE_ATTR, state);
    render();
  };

  const runRenew = async (): Promise<void> => {
    if (disposed) return;
    transitionTo('busy');
    try {
      const result = await opts.runRenew(
        opts.defaultReason !== undefined
          ? { reason: opts.defaultReason }
          : {},
      );
      if (disposed) return;
      if (result.ok) {
        lastSuccess = result;
        lastErrorCode = null;
        lastErrorMessage = '';
        transitionTo('done');
        if (opts.onRenewed) {
          try {
            opts.onRenewed(result);
          } catch {
            /* telemetry sink is best-effort; never re-enter the panel */
          }
        }
        return;
      }
      lastSuccess = null;
      lastErrorCode = result.error;
      lastErrorMessage = result.message ?? '';
      transitionTo('error');
    } catch (err) {
      if (disposed) return;
      lastSuccess = null;
      lastErrorCode = null;
      lastErrorMessage = humanizeRpcError(err);
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
    btn.className = `rx-btn rx-btn-${variant} rx-btn-sm tls-renew-btn tls-renew-btn-${variant}`;
    if (disabledFlag) btn.disabled = true;
    btn.addEventListener('click', onClick);
    return btn;
  };

  const renderIdle = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'tls-renew-title';
    heading.textContent = COPY.idle_heading;

    const help = doc.createElement('p');
    help.className = 'tls-renew-help';
    help.textContent = COPY.idle_body;

    const actions = doc.createElement('div');
    actions.className = 'tls-renew-actions';
    actions.appendChild(
      makeButton('Renew now', TLS_RENEW_RENEW_BTN_ATTR, 'primary', () =>
        transitionTo('confirm'),
      ),
    );

    wrapper.appendChild(heading);
    wrapper.appendChild(help);
    wrapper.appendChild(actions);
  };

  const renderConfirm = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'tls-renew-title';
    heading.textContent = COPY.confirm_heading;

    const body = doc.createElement('p');
    body.className = 'tls-renew-help tls-renew-help-confirm';
    body.setAttribute(TLS_RENEW_STATUS_ATTR, '');
    body.setAttribute('role', 'alert');
    body.textContent = COPY.confirm_body;

    const actions = doc.createElement('div');
    actions.className = 'tls-renew-actions';
    actions.appendChild(
      makeButton('Cancel', TLS_RENEW_CANCEL_BTN_ATTR, 'secondary', () =>
        transitionTo('idle'),
      ),
    );
    actions.appendChild(
      makeButton('Yes, renew', TLS_RENEW_CONFIRM_BTN_ATTR, 'primary', () => {
        pendingRenewPromise = runRenew();
      }),
    );

    wrapper.appendChild(heading);
    wrapper.appendChild(body);
    wrapper.appendChild(actions);
  };

  const renderBusy = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'tls-renew-title';
    heading.textContent = COPY.confirm_heading;

    const status = doc.createElement('p');
    status.className = 'tls-renew-help tls-renew-help-busy';
    status.setAttribute(TLS_RENEW_STATUS_ATTR, '');
    status.setAttribute('role', 'status');
    status.textContent = COPY.busy;

    const actions = doc.createElement('div');
    actions.className = 'tls-renew-actions';
    // Both buttons disabled mid-flight (the rpc has no cancel surface;
    // a second click would re-enter `runRenew` before the first resolved).
    actions.appendChild(
      makeButton(
        'Cancel',
        TLS_RENEW_CANCEL_BTN_ATTR,
        'secondary',
        () => undefined,
        true,
      ),
    );
    actions.appendChild(
      makeButton(
        'Yes, renew',
        TLS_RENEW_CONFIRM_BTN_ATTR,
        'primary',
        () => undefined,
        true,
      ),
    );

    wrapper.appendChild(heading);
    wrapper.appendChild(status);
    wrapper.appendChild(actions);
  };

  const renderDone = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'tls-renew-title tls-renew-title-done';
    heading.textContent = COPY.done_heading;

    const body = doc.createElement('p');
    body.className = 'tls-renew-help';
    body.textContent = COPY.done_body;

    const list = doc.createElement('dl');
    list.className = 'tls-renew-result';

    const result = lastSuccess;
    if (result !== null) {
      if (result.new_fingerprint !== undefined) {
        const dt = doc.createElement('dt');
        dt.className = 'tls-renew-result-label';
        dt.textContent = 'New fingerprint';
        const dd = doc.createElement('dd');
        dd.setAttribute(TLS_RENEW_FINGERPRINT_ATTR, '');
        dd.className = 'tls-renew-result-value tls-renew-result-value-mono';
        dd.textContent = result.new_fingerprint;
        list.appendChild(dt);
        list.appendChild(dd);
      }
      const flipAt = doc.createElement('dt');
      flipAt.className = 'tls-renew-result-label';
      flipAt.textContent = 'Switches over on';
      const flipAtValue = doc.createElement('dd');
      flipAtValue.setAttribute(TLS_RENEW_ROTATED_AT_ATTR, '');
      flipAtValue.className = 'tls-renew-result-value';
      flipAtValue.textContent = formatRotatedAt(result.rotated_at, now());
      list.appendChild(flipAt);
      list.appendChild(flipAtValue);
    }

    const actions = doc.createElement('div');
    actions.className = 'tls-renew-actions';
    actions.appendChild(
      makeButton('Close', TLS_RENEW_CLOSE_BTN_ATTR, 'secondary', () =>
        transitionTo('idle'),
      ),
    );

    wrapper.appendChild(heading);
    wrapper.appendChild(body);
    wrapper.appendChild(list);
    wrapper.appendChild(actions);
  };

  const renderError = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'tls-renew-title tls-renew-title-error';
    heading.textContent = COPY.error_heading;

    const hint = doc.createElement('p');
    hint.className = 'tls-renew-help';
    hint.textContent = remediationFor(
      lastErrorCode,
      lastErrorMessage || 'Something went wrong. Check your server’s logs, then try again.',
    );

    const errBox = doc.createElement('p');
    errBox.setAttribute(TLS_RENEW_STATUS_ATTR, '');
    errBox.setAttribute('role', 'alert');
    errBox.className = 'tls-renew-error';
    if (lastErrorCode !== null) {
      errBox.setAttribute(TLS_RENEW_ERROR_CODE_ATTR, lastErrorCode);
      errBox.textContent = lastErrorMessage
        ? `${lastErrorCode}: ${lastErrorMessage}`
        : lastErrorCode;
    } else {
      errBox.textContent = lastErrorMessage;
    }

    const actions = doc.createElement('div');
    actions.className = 'tls-renew-actions';
    actions.appendChild(
      makeButton('Cancel', TLS_RENEW_CANCEL_BTN_ATTR, 'secondary', () =>
        transitionTo('idle'),
      ),
    );
    actions.appendChild(
      makeButton('Retry', TLS_RENEW_RETRY_BTN_ATTR, 'primary', () =>
        transitionTo('confirm'),
      ),
    );

    wrapper.appendChild(heading);
    wrapper.appendChild(hint);
    wrapper.appendChild(errBox);
    wrapper.appendChild(actions);
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
  // Same `findBtn` shape as `clear-this-browser-panel.ts`: walk the
  // wrapper tree by hand, prefer `children` but fall back to
  // `childList` so the bootstrap-test fake (which exposes `childList`)
  // composes through this panel without a shared fake-DOM helper.
  const findBtn = (attr: string): HTMLButtonElement | null => {
    const walk = (node: HTMLElement): HTMLButtonElement | null => {
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
      try {
        opts.host.removeChild(wrapper);
      } catch {
        wrapper.remove();
      }
    },
    clickRenew: () => {
      const b = findBtn(TLS_RENEW_RENEW_BTN_ATTR);
      if (b && !b.disabled) b.click();
    },
    clickConfirm: async () => {
      const b = findBtn(TLS_RENEW_CONFIRM_BTN_ATTR);
      if (b && !b.disabled) b.click();
      const pending = pendingRenewPromise;
      if (pending) await pending;
    },
    clickCancel: () => {
      const b = findBtn(TLS_RENEW_CANCEL_BTN_ATTR);
      if (b && !b.disabled) b.click();
    },
    clickRetry: () => {
      const b = findBtn(TLS_RENEW_RETRY_BTN_ATTR);
      if (b && !b.disabled) b.click();
    },
    clickClose: () => {
      const b = findBtn(TLS_RENEW_CLOSE_BTN_ATTR);
      if (b && !b.disabled) b.click();
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

export const TLS_RENEW_PANEL_STYLES = `
[${TLS_RENEW_PANEL_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
}
[${TLS_RENEW_PANEL_ATTR}] .tls-renew-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
[${TLS_RENEW_PANEL_ATTR}] .tls-renew-title-done {
  color: var(--success);
}
[${TLS_RENEW_PANEL_ATTR}] .tls-renew-title-error {
  color: var(--danger);
}
[${TLS_RENEW_PANEL_ATTR}] .tls-renew-help {
  margin: 0;
  line-height: 1.45;
}
[${TLS_RENEW_PANEL_ATTR}] .tls-renew-help-confirm {
  font-weight: 600;
}
[${TLS_RENEW_PANEL_ATTR}] .tls-renew-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
[${TLS_RENEW_PANEL_ATTR}] .tls-renew-result {
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  padding: 8px 10px;
  background: var(--bg-elev);
  border-radius: 4px;
}
[${TLS_RENEW_PANEL_ATTR}] .tls-renew-result-label {
  margin: 0;
  font-weight: 600;
}
[${TLS_RENEW_PANEL_ATTR}] .tls-renew-result-value {
  margin: 0;
}
[${TLS_RENEW_PANEL_ATTR}] .tls-renew-result-value-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  word-break: break-all;
}
[${TLS_RENEW_PANEL_ATTR}] .tls-renew-error {
  margin: 0;
  padding: 6px 8px;
  background: var(--danger-bg);
  color: var(--danger);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
  word-break: break-all;
}
`;
