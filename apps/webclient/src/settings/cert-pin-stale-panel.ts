/** D-148 § A.6.5 — Settings → Server cert-pin overlap panel
 *  (NEXT-#2 advance, slice 113).
 *
 *  Surfaces slice 87's cert-pin two-pin overlap state for the user.
 *  When the server emits `cert.rotation_notice`, the cert-pin handler
 *  stages `next_fingerprint` + `current_valid_until` in the local
 *  store; this panel renders an info-toned "Cert pin rotation
 *  pending" block during the 7d window so the operator knows a TLS
 *  rotation is in flight + when the handoff occurs. Once the clock
 *  crosses `current_valid_until` (or `cert.rotation_reverted` clears
 *  the staged pin), the panel hides on the next render.
 *
 *  ── Two exports ────────────────────────────────────────────────────
 *    - `mountCertPinStalePanel(opts)` — DOM-construction mount.
 *      Subscribes to the cert-pin state watcher; rebuilds the panel's
 *      inner DOM on every transition; exposes `update()` /
 *      `dispose()` / `getViewState()` for host + test introspection.
 *    - `CERT_PIN_STALE_PANEL_STYLES` — self-scoped CSS bundled into
 *      the Settings route's `<style>` tag at boot.
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — Pure informational, no buttons. The TLS renew panel
 *  (slice 111) is the operator-initiated rotation surface; this panel
 *  is the awareness surface for the overlap state that follows.
 *  Adding a "force flip" / "abort rotation" button here would
 *  duplicate the renew/revert rpc surfaces + create accidental-click
 *  risk during a routine 7d window. The panel reports state; the
 *  operator drives changes from the TLS renew panel or by waiting for
 *  the natural flip.
 *
 *  DD#2 — Hide-on-no-overlap gate is at render, not at mount. The
 *  watcher always provides the latest known state; the gate
 *  (`next_fingerprint !== undefined && current_valid_until > now`)
 *  is evaluated on every `update()` call. This means a panel that
 *  renders during the window naturally hides itself once `now`
 *  advances past `current_valid_until` (the host's update() drives
 *  the re-evaluation; without an explicit timer the panel hides on
 *  the next watcher transition — e.g. the post-flip
 *  `cert.rotation_reverted` or the next rotation_notice). For v1 we
 *  rely on the broadcast-driven re-render; a polling tick is a
 *  separate decision that hasn't been needed yet.
 *
 *  DD#3 — Fingerprint short-codes, not full hashes. Cert fingerprints
 *  are SHA-256 hex (64 chars); rendering the full string in two rows
 *  bloats the panel + the user only needs the leading bytes to
 *  visually distinguish the current pin from the next. `shortenFp`
 *  takes the first 16 hex chars + appends an ellipsis. Hovering the
 *  rendered element reveals the full fingerprint via `title="…"`.
 *
 *  DD#4 — Time formatting mirrors the TLS renew panel
 *  (`formatRotatedAt`). The ISO string + `(in ~3d)` / `(in ~7h)`
 *  suffix gives the operator both the absolute timestamp + the
 *  relative urgency without a separate "time until" widget. The
 *  `now` seam (default `Date.now`) makes test snapshots deterministic.
 *
 *  DD#5 — Render-on-transition rebuild. Same pattern as
 *  `tls-renew-panel.ts`. Every state change rebuilds the panel's
 *  inner DOM via `createElement`. No event listeners on the panel
 *  itself (DD#1) so the rebuild has nothing to detach.
 *
 *  DD#6 — `null` state is the empty-view signal. The watcher returns
 *  `null` before `refresh()` resolves + after `dispose()`; both
 *  collapse to the empty render. A test that mounts before refresh
 *  resolves sees the empty panel; a test that asserts post-refresh
 *  sees the populated panel — the contract is uniform.
 *
 *  DD#7 — Render-key idempotency guard (Codex slice-114 P2 fold).
 *  Without a dedup the polling-driven `update()` (DD#10 in
 *  `webclient-bootstrap.ts`) tears down + re-appends the same panel
 *  DOM every 60s during an active 7d overlap window. The panel's
 *  outer element carries `role="status"` (DD#1's politeness flag),
 *  so each rebuild is a fresh live-region announcement — screen
 *  readers re-announce "Cert pin rotation pending …" once per
 *  minute for the entire rotation. The guard computes a `renderKey`
 *  over the four user-visible fields (`current_fingerprint`,
 *  `next_fingerprint`, `flip_at_iso`, `flip_at_relative`); a tick
 *  whose key matches the prior render is a no-op (no clearChildren,
 *  no rebuild, no live-region churn). The view-state mirror still
 *  refreshes on every call so consumers reading `getViewState()`
 *  observe the freshest projection. Transitions that DO change a
 *  visible field — bucket crossings ("in ~3d" → "in ~2d"), flip
 *  expiry, watcher transitions to a new pin pair — re-render as
 *  before.
 *
 *  Spec: docs/d-148-spec.md § A.6.5 (two-pin overlap protocol). */

import type { WebclientCertPinState } from '@recued/contracts';

import type { CertPinStateWatcher } from '../realtime/cert-pin-state-watcher.js';

// ════════════════════════════════════════════════════════════════
// Element attributes — stable for tests + host introspection
// ════════════════════════════════════════════════════════════════

export const CERT_PIN_STALE_PANEL_ATTR = 'data-recued-cert-pin-stale-panel';
export const CERT_PIN_STALE_TITLE_ATTR = 'data-recued-cert-pin-stale-title';
export const CERT_PIN_STALE_FLIP_AT_ATTR = 'data-recued-cert-pin-stale-flip-at';
export const CERT_PIN_STALE_CURRENT_FP_ATTR =
  'data-recued-cert-pin-stale-current-fp';
export const CERT_PIN_STALE_NEXT_FP_ATTR =
  'data-recued-cert-pin-stale-next-fp';

// ════════════════════════════════════════════════════════════════
// Copy — closed list so tests + future audits can reason about
// every user-visible string in one place.
// ════════════════════════════════════════════════════════════════

export const CERT_PIN_STALE_COPY = {
  title: 'Cert pin rotation pending',
  subtitle:
    'The server is rotating its TLS certificate. This browser will accept either the current cert or the new one during the overlap window.',
  current_label: 'Current fingerprint',
  next_label: 'Next fingerprint',
  flip_label: 'Flips at',
} as const;

// ════════════════════════════════════════════════════════════════
// View projection
// ════════════════════════════════════════════════════════════════

/** The renderable shape of an active-overlap state. Returned by
 *  `buildCertPinStaleView`; the renderer consumes this. Returns
 *  `null` when the state is not in an active overlap (no pin, no
 *  staged next, or the flip has already passed). */
export interface CertPinStaleView {
  readonly current_fingerprint: string;
  readonly next_fingerprint: string;
  readonly current_valid_until: number;
  readonly flip_at_iso: string;
  readonly flip_at_relative: string;
}

/** Project a `WebclientCertPinState` to the renderable view, or
 *  return `null` when no overlap is active. The gate is:
 *    - state is non-null
 *    - `next_fingerprint` is a non-empty string (staged rotation)
 *    - `current_valid_until > now` (flip has not yet happened)
 *  A `current_fingerprint` of empty string (DD#2 in `cert-pin.ts` —
 *  pre-acquisition seed) is allowed; the rendered short-code becomes
 *  the empty short-form "—" so the panel does not hide just because
 *  no prior pin existed. */
export const buildCertPinStaleView = (
  state: WebclientCertPinState | null,
  now: number = Date.now(),
): CertPinStaleView | null => {
  if (state === null) return null;
  const next = state.next_fingerprint;
  if (next === undefined || next.length === 0) return null;
  if (state.current_valid_until <= now) return null;
  return {
    current_fingerprint: state.current_fingerprint,
    next_fingerprint: next,
    current_valid_until: state.current_valid_until,
    flip_at_iso: new Date(state.current_valid_until).toISOString(),
    flip_at_relative: formatFlipRelative(state.current_valid_until, now),
  };
};

/** Mirror of `tls-renew-panel.ts` `formatRotatedAt` — relative-time
 *  buckets `(in ~Nd)` / `(in ~Nh)` / `(in <1h)`. The "<1h" bucket
 *  collapses sub-hour windows so the panel doesn't churn through a
 *  minute-by-minute countdown the user can't act on. */
const formatFlipRelative = (flip_at: number, now: number): string => {
  if (!Number.isFinite(flip_at)) return 'unknown';
  const diff_ms = flip_at - now;
  if (diff_ms <= 0) return 'now';
  const day_ms = 24 * 60 * 60 * 1000;
  const hour_ms = 60 * 60 * 1000;
  if (diff_ms >= day_ms) {
    const days = Math.round(diff_ms / day_ms);
    return `in ~${days}d`;
  }
  if (diff_ms >= hour_ms) {
    const hours = Math.round(diff_ms / hour_ms);
    return `in ~${hours}h`;
  }
  return 'in <1h';
};

/** DD#7 — opaque cache key over the user-visible fields of a view.
 *  Used by the mount's idempotency guard to skip DOM churn when a
 *  re-render would produce the same output. `null` view collapses to
 *  the `__hidden__` sentinel so consecutive hidden ticks dedup too. */
const renderKey = (view: CertPinStaleView | null): string => {
  if (view === null) return '__hidden__';
  return `${view.current_fingerprint}|${view.next_fingerprint}|${view.flip_at_iso}|${view.flip_at_relative}`;
};

/** Short-form fingerprint for the panel's two rows. Cert fingerprints
 *  are 64-hex SHA-256; we render the first 16 chars + ellipsis. An
 *  empty-string fingerprint (the pre-acquisition seed sentinel)
 *  renders as the en-dash so the row layout stays aligned. */
const shortenFp = (fp: string): string => {
  if (fp.length === 0) return '—';
  if (fp.length <= 16) return fp;
  return `${fp.slice(0, 16)}…`;
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export interface MountCertPinStalePanelOptions {
  /** Host element the panel is rendered into. The panel manages its
   *  own inner DOM; the host stays attached across rebuilds. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** Cert-pin state watcher. The panel subscribes to it + re-renders
   *  on every transition (post-persist + post-refresh). */
  watcher: CertPinStateWatcher;
  /** Clock seam for the relative-time formatter + the
   *  `current_valid_until > now` gate. Defaults to `Date.now`. */
  now?: () => number;
}

export interface CertPinStalePanelMount {
  /** Force a re-render from the watcher's current state. Called
   *  automatically on every subscription tick; exposed for test
   *  drivers + a future polling timer. */
  update(): void;
  /** Unsubscribe from the watcher + clear the host. Idempotent. */
  dispose(): void;
  /** Returns the current rendered view (or `null` when the panel is
   *  hidden). Test affordance — lets assertions read the projected
   *  shape without parsing DOM attributes. */
  getViewState(): CertPinStaleView | null;
}

/** Mount the panel into `opts.host`. Returns a handle.
 *
 *  Implementation note: the mount creates a `wrapper` div as a child
 *  of `opts.host` and only manipulates the wrapper's children on
 *  every render. This mirrors `tls-renew-panel.ts` (wrapper pattern)
 *  so test fakes don't need to implement `firstChild`/`removeChild`
 *  on the host element — only on the wrapper, which is constructed
 *  via the same `doc.createElement` seam as every other panel child. */
export const mountCertPinStalePanel = (
  opts: MountCertPinStalePanelOptions,
): CertPinStalePanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountCertPinStalePanel: no document available — pass `opts.document` for non-browser environments',
    );
  }
  const now = opts.now ?? Date.now;
  let disposed = false;
  let lastView: CertPinStaleView | null = null;
  // DD#7 — sentinel that doesn't match any real `renderKey` output;
  // first render is always a real append.
  let lastRenderKey: string = '__pre_first_render__';

  const wrapper = doc.createElement('div');
  wrapper.className = 'cert-pin-stale-wrapper';
  opts.host.appendChild(wrapper);

  const clearChildren = (): void => {
    while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
  };

  const render = (): void => {
    if (disposed) return;
    const view = buildCertPinStaleView(opts.watcher.getState(), now());
    lastView = view;
    // DD#7 — dedup the DOM rebuild when nothing visible has changed.
    // The view-state mirror above stays fresh on every call so a
    // caller of `getViewState()` reads the latest projection even
    // when the DOM tree is untouched.
    const key = renderKey(view);
    if (key === lastRenderKey) return;
    lastRenderKey = key;
    clearChildren();
    if (view === null) return;

    const panel = doc.createElement('div');
    panel.setAttribute(CERT_PIN_STALE_PANEL_ATTR, '');
    panel.setAttribute('role', 'status');
    panel.className = 'cert-pin-stale-panel';

    const title = doc.createElement('h3');
    title.setAttribute(CERT_PIN_STALE_TITLE_ATTR, '');
    title.className = 'cert-pin-stale-title';
    title.textContent = CERT_PIN_STALE_COPY.title;
    panel.appendChild(title);

    const subtitle = doc.createElement('p');
    subtitle.className = 'cert-pin-stale-subtitle';
    subtitle.textContent = CERT_PIN_STALE_COPY.subtitle;
    panel.appendChild(subtitle);

    const flipRow = doc.createElement('div');
    flipRow.className = 'cert-pin-stale-row cert-pin-stale-flip-row';
    flipRow.setAttribute(CERT_PIN_STALE_FLIP_AT_ATTR, '');
    flipRow.setAttribute('title', view.flip_at_iso);
    const flipLabel = doc.createElement('span');
    flipLabel.className = 'cert-pin-stale-label';
    flipLabel.textContent = `${CERT_PIN_STALE_COPY.flip_label}:`;
    const flipValue = doc.createElement('span');
    flipValue.className = 'cert-pin-stale-value';
    flipValue.textContent = `${view.flip_at_iso} (${view.flip_at_relative})`;
    flipRow.appendChild(flipLabel);
    flipRow.appendChild(flipValue);
    panel.appendChild(flipRow);

    const currentRow = doc.createElement('div');
    currentRow.className = 'cert-pin-stale-row';
    currentRow.setAttribute(CERT_PIN_STALE_CURRENT_FP_ATTR, '');
    currentRow.setAttribute('title', view.current_fingerprint || '—');
    const currentLabel = doc.createElement('span');
    currentLabel.className = 'cert-pin-stale-label';
    currentLabel.textContent = `${CERT_PIN_STALE_COPY.current_label}:`;
    const currentValue = doc.createElement('span');
    currentValue.className = 'cert-pin-stale-value cert-pin-stale-fp';
    currentValue.textContent = shortenFp(view.current_fingerprint);
    currentRow.appendChild(currentLabel);
    currentRow.appendChild(currentValue);
    panel.appendChild(currentRow);

    const nextRow = doc.createElement('div');
    nextRow.className = 'cert-pin-stale-row';
    nextRow.setAttribute(CERT_PIN_STALE_NEXT_FP_ATTR, '');
    nextRow.setAttribute('title', view.next_fingerprint);
    const nextLabel = doc.createElement('span');
    nextLabel.className = 'cert-pin-stale-label';
    nextLabel.textContent = `${CERT_PIN_STALE_COPY.next_label}:`;
    const nextValue = doc.createElement('span');
    nextValue.className = 'cert-pin-stale-value cert-pin-stale-fp';
    nextValue.textContent = shortenFp(view.next_fingerprint);
    nextRow.appendChild(nextLabel);
    nextRow.appendChild(nextValue);
    panel.appendChild(nextRow);

    wrapper.appendChild(panel);
  };

  const unsubscribe = opts.watcher.subscribe(() => {
    render();
  });
  render();

  return {
    update: render,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      clearChildren();
      wrapper.remove();
      lastView = null;
    },
    getViewState: () => lastView,
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

export const CERT_PIN_STALE_PANEL_STYLES = `
[${CERT_PIN_STALE_PANEL_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--warn);
  border-radius: 6px;
  background: var(--warn-soft);
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg);
}
[${CERT_PIN_STALE_PANEL_ATTR}] .cert-pin-stale-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--warn);
}
[${CERT_PIN_STALE_PANEL_ATTR}] .cert-pin-stale-subtitle {
  margin: 0;
}
[${CERT_PIN_STALE_PANEL_ATTR}] .cert-pin-stale-row {
  display: flex;
  gap: 8px;
  font-size: 12px;
  align-items: baseline;
}
[${CERT_PIN_STALE_PANEL_ATTR}] .cert-pin-stale-label {
  color: var(--fg-muted);
  flex: 0 0 140px;
}
[${CERT_PIN_STALE_PANEL_ATTR}] .cert-pin-stale-value {
  flex: 1 1 auto;
}
[${CERT_PIN_STALE_PANEL_ATTR}] .cert-pin-stale-fp {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
`;
