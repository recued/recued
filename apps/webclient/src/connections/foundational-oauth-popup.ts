/** D-174 Slice 2b — foundational-lane OAuth popup driver (Mail + Calendar).
 *
 *  The reusable client substrate behind the Mail/Calendar "Connect with
 *  Google / Microsoft" buttons. It drives a consent popup and captures the
 *  raw authorization `code` the callback page hands back via `postMessage`
 *  (opener-relay mode — `foundational-oauth.ts` / `oauth-callback.ts`). The
 *  lane code then forwards the code to `collection.{mail,calendar}.enrollOAuth`,
 *  where the server completes the exchange with its env `client_secret`.
 *
 *  Two-phase, mirroring the connection-vendor flow's popup discipline:
 *    1. The CALLER opens a blank popup SYNCHRONOUSLY inside the click
 *       gesture (`openOAuthPopup()`), then hands the handle to
 *       `runOAuthPopup()`. A popup opened after an `await` is blocked.
 *    2. `runOAuthPopup` mints a CSRF `state`, builds the authorize URL,
 *       navigates the popup, and resolves with the captured code / error /
 *       timeout / close.
 *
 *  CSRF: the driver mints `state` and accepts the code ONLY when the
 *  postMessage arrives from the trusted callback origin
 *  (`expectedSenderOrigin` — the cloud callback host, which is CROSS-origin
 *  from a self-served PWA, R26.2), carries the relay `kind`, AND round-trips
 *  the exact `state`. No PKCE, no server-signed state — the connection-vendor
 *  flow's signed-state machinery is deliberately not reused (see
 *  `foundational-oauth.ts`).
 *
 *  Opener link: UNLIKE the connection-vendor flow we do NOT null the
 *  popup's `opener` — the callback page needs it to hand the code back, and
 *  the authorize endpoints are FIXED Google/Microsoft URLs (no BYO vendor
 *  URL), so the reverse-tabnabbing vector the null defends against does not
 *  apply.
 */

import {
  OAUTH_OPENER_RELAY_STATE_PREFIX,
  OPENER_RELAY_MESSAGE_KIND,
  type OpenerRelayMessage,
} from '@recued/contracts';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

/** Narrow handle over a popup `Window` — the subset the driver touches.
 *  `location.href` is write-only across origins (navigation is allowed,
 *  reads are not); `closed` is readable; `close()` is callable. */
export interface FoundationalOAuthPopupHandle {
  readonly closed: boolean;
  location: { href: string };
  close(): void;
}

/** Injectable browser seam — tests pass a fake; production wraps `window`. */
export interface FoundationalOAuthEnv {
  /** This window's origin; the postMessage sender must match it. */
  readonly origin: string;
  /** Mint an unguessable CSRF state nonce. */
  randomState(): string;
  /** Subscribe to `message` events; returns an unsubscribe fn. */
  onMessage(handler: (ev: { origin: string; data: unknown }) => void): () => void;
  /** One-shot timer; returns a cancel fn. */
  setTimeout(cb: () => void, ms: number): () => void;
  /** Recurring timer (popup-closed poll); returns a cancel fn. */
  setInterval(cb: () => void, ms: number): () => void;
}

export interface RunOAuthPopupParams {
  /** Blank popup opened synchronously by the caller in the click gesture.
   *  `null` signals the browser blocked it. */
  popup: FoundationalOAuthPopupHandle | null;
  /** Build the authorize URL for the driver-minted `state`. May be async
   *  (e.g. it fetches the `client_id` first). The redirect_uri it embeds
   *  must carry the opener-relay marker (`buildOpenerRelayRedirectUri`). */
  buildAuthorizeUrl: (state: string) => string | Promise<string>;
  /** Origin the callback page posts the code FROM — the only sender the
   *  driver trusts. This is the CALLBACK host: for the foundational flow the
   *  cloud callback (`OAUTH_CLOUD_CALLBACK_ORIGIN`), which is CROSS-origin
   *  from a self-served PWA (R26.2) — so it is deliberately NOT the PWA's own
   *  `env.origin`. Derive it from the redirect_uri's origin so it always
   *  matches the callback host actually used. */
  expectedSenderOrigin: string;
  /** Abandon after this long (default 5 min). */
  timeoutMs?: number;
  /** Popup-closed poll cadence (default 500 ms). */
  pollMs?: number;
}

export type RunOAuthPopupResult =
  | { ok: true; code: string; state: string }
  | {
      ok: false;
      reason: 'popup_blocked' | 'denied' | 'timeout' | 'closed' | 'error';
      detail?: string;
    };

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 500;

const errMessage = (e: unknown): string =>
  humanizeRpcError(e);

/** Drive the consent popup to a captured `code` (or a typed failure). */
export const runOAuthPopup = async (
  env: FoundationalOAuthEnv,
  params: RunOAuthPopupParams,
): Promise<RunOAuthPopupResult> => {
  const { popup } = params;
  if (!popup) return { ok: false, reason: 'popup_blocked' };

  // The state carries the foundational family prefix so the callback page's
  // relay branch is fail-closed; the FULL value is the CSRF nonce.
  const state = OAUTH_OPENER_RELAY_STATE_PREFIX + env.randomState();

  return await new Promise<RunOAuthPopupResult>((resolve) => {
    let settled = false;
    let offMessage = (): void => {};
    let cancelTimeout = (): void => {};
    let cancelPoll = (): void => {};

    const settle = (r: RunOAuthPopupResult): void => {
      if (settled) return;
      settled = true;
      offMessage();
      cancelTimeout();
      cancelPoll();
      // Close only if not already closed — on the happy path the same-origin
      // callback page self-closes, so skipping here avoids calling close()
      // across a COOP-severed boundary (which logs a "Cross-Origin-Opener-Policy
      // would block the window.close call" warning).
      try { if (!popup.closed) popup.close(); } catch { /* cross-origin close may throw */ }
      resolve(r);
    };

    // Install ALL guards BEFORE navigating — so a fast redirect can't race
    // the listener and a hung URL build can't escape the timeout.
    offMessage = env.onMessage((ev) => {
      // Trust ONLY the callback page's origin as the sender. The cloud
      // callback (app.recued.com) is CROSS-origin from a self-served PWA
      // (R26.2), so this is the expected CALLBACK origin, NOT our own
      // (`env.origin`). The full minted `state` is still verified below — the
      // real CSRF guard; this origin pin is defense-in-depth.
      if (ev.origin !== params.expectedSenderOrigin) return;
      const data = ev.data as Partial<OpenerRelayMessage> | null;
      if (!data || data.kind !== OPENER_RELAY_MESSAGE_KIND) return;
      // CSRF — the round-tripped state must equal what we minted.
      if (data.state !== state) return;
      if (data.error) {
        settle({ ok: false, reason: 'denied', detail: data.error });
      } else if (typeof data.code === 'string' && data.code.length > 0) {
        settle({ ok: true, code: data.code, state });
      }
      // Malformed (neither code nor error) — ignore, wait for timeout.
    });
    cancelTimeout = env.setTimeout(
      () => settle({ ok: false, reason: 'timeout' }),
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    cancelPoll = env.setInterval(() => {
      if (popup.closed) settle({ ok: false, reason: 'closed' });
    }, params.pollMs ?? DEFAULT_POLL_MS);

    // Build the authorize URL (may await — e.g. fetch the client_id) and
    // navigate, all inside the guarded scope.
    void (async () => {
      let url: string;
      try {
        url = await params.buildAuthorizeUrl(state);
      } catch (e) {
        settle({ ok: false, reason: 'error', detail: errMessage(e) });
        return;
      }
      if (settled) return; // timed out / closed during the build
      try {
        popup.location.href = url;
      } catch (e) {
        settle({ ok: false, reason: 'error', detail: errMessage(e) });
      }
    })();
  });
};

/** Open the blank popup. MUST be called synchronously inside the click
 *  gesture; a popup opened after an `await` is blocked. Returns `null`
 *  when the browser blocks it. */
export const openOAuthPopup = (
  open: (url: string, target: string, features?: string) => Window | null = (
    u,
    t,
    f,
  ) => window.open(u, t, f),
): FoundationalOAuthPopupHandle | null =>
  (open('', '_blank', 'popup,width=520,height=640') as
    | FoundationalOAuthPopupHandle
    | null) ?? null;

/** Production browser env wrapping `window` + WebCrypto. */
export const defaultFoundationalOAuthEnv = (): FoundationalOAuthEnv => ({
  origin: window.location.origin,
  randomState: () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  },
  onMessage: (handler) => {
    const listener = (ev: MessageEvent): void =>
      handler({ origin: ev.origin, data: ev.data });
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  },
  setTimeout: (cb, ms) => {
    const h = window.setTimeout(cb, ms);
    return () => window.clearTimeout(h);
  },
  setInterval: (cb, ms) => {
    const h = window.setInterval(cb, ms);
    return () => window.clearInterval(h);
  },
});
