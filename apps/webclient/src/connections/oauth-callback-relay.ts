/** The OAuth callback page's script — bundled by `apps/webclient/scripts/build.mjs`
 *  into `oauth-callback-relay.js` and loaded by `public/oauth-callback.html`.
 *
 *  ⛔⛔ ONE PAGE, TWO HOSTS — and for three months the second one was forgotten.
 *  The same file is served:
 *
 *    - by the owner's Recued server, at `WEBCLIENT_OAUTH_CALLBACK_PATH`
 *      (`/webclient/oauth-callback.html`), for a PWA that self-serves its
 *      callback: loopback (R26.2 Option B) or the server's own https name
 *      (`selfServesOAuthCallback`). Same-origin; the code never leaves the
 *      owner's machines.
 *    - by app.recued.com at `/oauth-callback` (`OAUTH_CLOUD_CALLBACK_URL`), since
 *      the webclient took that domain over as a static site (2026-07-01).
 *
 *  It used to be written for the first host only: opener-relay to its own
 *  origin, nothing else. On app.recued.com that silently replaced the D-148
 *  § A.12 page (`backend/api/src/routes/oauth-callback.ts`), which also did the
 *  two things only that host is asked to do — so both stopped working there:
 *
 *    - R26.2 Option A: a PWA that cannot self-serve (an https IP literal, a
 *      single-label name, staging) names itself in the callback's
 *      `opener_origin`, and the page must post the code THERE, not to
 *      app.recued.com;
 *    - the vendor flow (HubSpot, Salesforce, any BYO OAuth app) whose owner
 *      registered the app.recued.com callback: verify the server-signed
 *      `state`, then POST the code to `<server_url>/oauth/complete`.
 *
 *  Both are restored here, mirroring the § A.12 page step for step; its tests
 *  (`backend/api/src/__tests__/oauth-callback-runtime.test.ts`) are the model
 *  for this page's. On the self-served host neither arises (no `opener_origin`
 *  in a same-origin callback, and the self-served vendor flow relays a `frelay_`
 *  state like the mail one), and each is harmless if it did.
 *
 *  CSRF stays the opener's job for the relay (it minted `state` and verifies the
 *  round-tripped value before calling `enrollOAuth`); the vendor path is gated
 *  by the Ed25519 signature instead. Fail-closed: a `state` that is neither
 *  posts nothing. */

import type { OpenerRelayMessage } from '@recued/contracts';

// Constants hardcoded (NOT imported) on purpose: this entry is bundled as a
// standalone ~2 KB asset, and a VALUE import from the `@recued/contracts`
// barrel drags the whole module graph in (~370 KB + a 3 MB map — measured).
// `import type` above is erased by esbuild, so it costs nothing. These
// MUST match the contract source-of-truth in
// `packages/contracts/src/foundational-oauth.ts`; the relay unit test drives
// this module with the CONTRACT constants and fails on any drift.
const OAUTH_OPENER_RELAY_STATE_PREFIX = 'frelay_';
const OPENER_RELAY_MESSAGE_KIND = 'recued:oauth-code' as const;
const OAUTH_OPENER_RELAY_PARAM = 'recued_relay';
const OAUTH_OPENER_RELAY_VALUE = 'opener';
const OAUTH_OPENER_ORIGIN_PARAM = 'opener_origin';
/** Where the enrollment dialog leaves the server's public key for the popup —
 *  MUST match `oauthJwksKey` in `settings/connections-enroll-panel.ts`. */
const VENDOR_KEY_PREFIX = 'oauth_jwks_';
/** A signed vendor `state` older than this, or dated in the future, is refused. */
const VENDOR_STATE_MAX_AGE_MS = 5 * 60 * 1000;

export type OAuthRelayStatus = 'ok' | 'provider_error' | 'missing_code' | 'invalid';

export interface OAuthRelayOutcome {
  /** Message to post to `window.opener`; `null` when the page was loaded
   *  outside a valid opener-relay flow (post nothing). */
  message: OpenerRelayMessage | null;
  status: OAuthRelayStatus;
}

/** Pure decision: given the callback query, decide what to relay + the status
 *  to show. Fail-closed — the foundational `frelay_` state prefix is the family
 *  gate (the redirect URI's `recued_relay` query marker is NOT required: the
 *  Microsoft flow omits it because Entra rejects query strings in redirect URIs).
 *  The opener still verifies the FULL state for CSRF, so the prefix is just a
 *  shape check. A provider `error` relays as an error message; otherwise the
 *  code relays (empty code → `missing_code`, the opener driver ignores an empty
 *  code and waits for its timeout). */
export const evaluateOpenerRelay = (search: URLSearchParams): OAuthRelayOutcome => {
  const state = search.get('state') ?? '';
  if (!state.startsWith(OAUTH_OPENER_RELAY_STATE_PREFIX)) {
    return { message: null, status: 'invalid' };
  }
  const providerError = search.get('error') ?? '';
  if (providerError) {
    return {
      message: { kind: OPENER_RELAY_MESSAGE_KIND, state, error: providerError },
      status: 'provider_error',
    };
  }
  const code = search.get('code') ?? '';
  return {
    message: { kind: OPENER_RELAY_MESSAGE_KIND, state, code },
    status: code ? 'ok' : 'missing_code',
  };
};

/** Where the relay posts: `opener_origin` (R26.2 Option A) ONLY when the query
 *  carries the `recued_relay=opener` marker AND the value is already a canonical
 *  http(s) origin — mirrors the contracts `readOpenerRelayTarget`. Anything
 *  else, including every Microsoft callback (no marker), keeps `ownOrigin`.
 *
 *  Safe to honour: `opener_origin` is part of the redirect URI the owner
 *  registered, which the provider matches byte for byte, so nobody can add one
 *  to a real callback; and the browser delivers the message only if the opener
 *  really is at that origin, so a wrong value just fails to deliver. Read from
 *  the QUERY only — the redirect URI is the query; a fragment is the
 *  provider's. NEVER `'*'`. */
export const resolveOpenerRelayTarget = (
  search: URLSearchParams,
  ownOrigin: string,
): string => {
  if (search.get(OAUTH_OPENER_RELAY_PARAM) !== OAUTH_OPENER_RELAY_VALUE) return ownOrigin;
  const raw = search.get(OAUTH_OPENER_ORIGIN_PARAM);
  if (raw === null || raw.length === 0) return ownOrigin;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return ownOrigin;
    if (u.origin !== raw) return ownOrigin; // canonical bare origins only
    return u.origin;
  } catch {
    return ownOrigin;
  }
};

/** The callback's values, from the query OR the fragment (providers differ;
 *  the § A.12 page read both). The query wins when both carry one. */
export const readCallbackParams = (href: string): URLSearchParams => {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const merged = new URLSearchParams(url.search);
  for (const key of ['code', 'state', 'error', 'realmId']) {
    const fromFragment = fragment.get(key);
    if (!merged.has(key) && fromFragment !== null) merged.set(key, fromFragment);
  }
  return merged;
};

export type VendorCallbackStatus =
  | 'vendor_ok'
  | 'vendor_malformed'
  | 'vendor_key_missing'
  | 'vendor_check_failed'
  | 'vendor_signature_invalid'
  | 'vendor_expired'
  | 'vendor_refused'
  | 'vendor_unreachable';

export interface VendorCallbackDeps {
  /** The page's `sessionStorage.getItem` — `null` when there is none. */
  getItem: (key: string) => string | null;
  subtle: Pick<SubtleCrypto, 'importKey' | 'verify'>;
  fetch: (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status'>>;
  now: () => number;
}

const b64urlToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const pad = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob((value + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

/** The vendor flow (D-148 § A.12): the `state` is `<b64url JSON>.<b64url
 *  Ed25519 signature>`, signed by the owner's server, naming the server to
 *  forward the code to. In this order, as the § A.12 page did:
 *
 *    1. decode — `server_url`, `flow_id` and `ts` must all be present;
 *    2. find the server's public key where the enrollment dialog left it, in
 *       this popup's sessionStorage. ⛔ Never fetched from `server_url`: a
 *       forged state names whatever server it likes, and would vouch for it;
 *    3. verify the signature — THE gate: without it a forged state sends the
 *       code to someone else's server;
 *    4. refuse a stale or future-dated `ts` (a future one would dodge the age
 *       check);
 *    5. POST `{ code, state, flow_id[, realmId] }` to
 *       `<server_url>/oauth/complete`, which re-checks the flow itself.
 *
 *  Nothing is sent unless 1–4 all pass. */
export const completeVendorCallback = async (
  input: { code: string; state: string; realmId: string | null },
  deps: VendorCallbackDeps,
): Promise<{ status: VendorCallbackStatus; httpStatus?: number }> => {
  let payload: { server_url?: unknown; flow_id?: unknown; ts?: unknown };
  let payloadBytes: Uint8Array<ArrayBuffer>;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    const parts = input.state.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { status: 'vendor_malformed' };
    payloadBytes = b64urlToBytes(parts[0]);
    signature = b64urlToBytes(parts[1]);
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as typeof payload;
  } catch {
    return { status: 'vendor_malformed' };
  }
  if (
    payload === null
    || typeof payload.server_url !== 'string' || payload.server_url.length === 0
    || typeof payload.flow_id !== 'string' || payload.flow_id.length === 0
    || typeof payload.ts !== 'number'
  ) {
    return { status: 'vendor_malformed' };
  }
  const keyB64 = deps.getItem(VENDOR_KEY_PREFIX + payload.flow_id);
  if (!keyB64) return { status: 'vendor_key_missing' };
  let verified: boolean;
  try {
    const publicKey = await deps.subtle.importKey(
      'spki',
      b64urlToBytes(keyB64),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    verified = await deps.subtle.verify('Ed25519', publicKey, signature, payloadBytes);
  } catch {
    // A key this browser cannot use is not a forged state — say which.
    return { status: 'vendor_check_failed' };
  }
  if (!verified) return { status: 'vendor_signature_invalid' };
  const ageMs = deps.now() - payload.ts;
  if (ageMs < 0 || ageMs > VENDOR_STATE_MAX_AGE_MS) return { status: 'vendor_expired' };
  try {
    const res = await deps.fetch(`${payload.server_url}/oauth/complete`, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        input.realmId
          ? { code: input.code, state: input.state, flow_id: payload.flow_id, realmId: input.realmId }
          : { code: input.code, state: input.state, flow_id: payload.flow_id },
      ),
    });
    if (!res.ok) return { status: 'vendor_refused', httpStatus: res.status };
    return { status: 'vendor_ok' };
  } catch {
    return { status: 'vendor_unreachable' };
  }
};

const STATUS_TEXT: Record<
  OAuthRelayStatus | VendorCallbackStatus | 'vendor_checking',
  { title: string; message: string; ok: boolean }
> = {
  ok: { title: 'Sign-in complete.', message: 'You can close this window.', ok: true },
  provider_error: {
    title: 'The other service said something went wrong.',
    message: 'You can close this window and try again.',
    ok: false,
  },
  missing_code: {
    title: 'The code is missing.',
    message: 'The other service did not send a code back. Please try again.',
    ok: false,
  },
  invalid: {
    title: 'Nothing to complete here.',
    message: 'This page only finishes a sign-in you started in Recued.',
    ok: false,
  },
  vendor_checking: {
    title: 'Completing sign-in…',
    message: 'Checking the sign-in, then handing it to your Recued server.',
    ok: true,
  },
  vendor_ok: { title: 'Sign-in complete.', message: 'You can close this window.', ok: true },
  vendor_malformed: {
    title: 'This sign-in cannot be finished here.',
    message: 'Its details are damaged. Nothing was sent. Start the sign-in again in Recued.',
    ok: false,
  },
  vendor_key_missing: {
    title: 'This sign-in cannot be checked.',
    message: 'Nothing was sent. Start the sign-in again in Recued, in this browser, and finish it in the window it opens.',
    ok: false,
  },
  vendor_check_failed: {
    title: 'This sign-in cannot be checked.',
    message: 'Nothing was sent. This browser could not check it. Start the sign-in again in Recued, in an up-to-date browser.',
    ok: false,
  },
  vendor_signature_invalid: {
    title: 'This sign-in did not come from your Recued server.',
    message: 'Nothing was sent. Start the sign-in again in Recued.',
    ok: false,
  },
  vendor_expired: {
    title: 'This sign-in took too long.',
    message: 'Nothing was sent. Start the sign-in again in Recued.',
    ok: false,
  },
  vendor_refused: {
    title: 'Your Recued server did not accept the sign-in.',
    message: 'Start the sign-in again in Recued.',
    ok: false,
  },
  vendor_unreachable: {
    title: 'Your Recued server could not be reached.',
    message: 'Check that it is running, then start the sign-in again in Recued.',
    ok: false,
  },
};

const render = (
  win: Window,
  status: keyof typeof STATUS_TEXT,
  detail?: string,
): void => {
  const text = STATUS_TEXT[status];
  const statusEl = win.document.getElementById('status');
  if (statusEl) {
    statusEl.textContent = text.title;
    statusEl.className = text.ok ? 'ok' : 'err';
  }
  const messageEl = win.document.getElementById('message');
  if (messageEl) messageEl.textContent = detail === undefined ? text.message : `${text.message} ${detail}`;
};

/** The dependencies a real page uses for the vendor step. */
const browserVendorDeps = (win: Window): VendorCallbackDeps => ({
  getItem: (key) => {
    try {
      return win.sessionStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  // Absent outside a secure context; the step then reports `vendor_check_failed`.
  subtle: win.crypto?.subtle,
  fetch: (url, init) => win.fetch(url, init),
  now: () => Date.now(),
});

/** Browser bootstrap: read the callback URL, scrub it from the address bar,
 *  then either relay the code to the opener (a `frelay_` state) or complete the
 *  vendor flow (a signed state), and render a status line.
 *
 *  ⚠ The relay branch finishes SYNCHRONOUSLY — no `await` before it — so a
 *  caller that does not await still sees the message posted. Only the vendor
 *  branch waits (crypto + the POST); await the returned promise for it. */
export const runOAuthCallbackRelay = async (
  win: Window,
  vendorDeps?: VendorCallbackDeps,
): Promise<void> => {
  let params: URLSearchParams;
  let query: URLSearchParams;
  let path: string;
  try {
    const url = new URL(win.location.href);
    params = readCallbackParams(win.location.href);
    query = url.searchParams;
    path = url.pathname;
  } catch {
    params = new URLSearchParams();
    query = new URLSearchParams();
    path = '';
  }

  // Drop the code + state from the address bar + history immediately (privacy
  // parity with the § A.12 page), keeping this page's own path — which differs
  // by host (`/oauth-callback` on app.recued.com, the bundle path on a server).
  try {
    win.history.replaceState(null, '', path);
  } catch {
    /* replaceState can throw in odd embeddings — non-fatal */
  }

  const state = params.get('state') ?? '';
  if (state.startsWith(OAUTH_OPENER_RELAY_STATE_PREFIX)) {
    const outcome = evaluateOpenerRelay(params);
    const target = resolveOpenerRelayTarget(query, win.location.origin);
    const relayed = Boolean(outcome.message && win.opener);
    if (relayed) {
      try {
        win.opener!.postMessage(outcome.message, target);
      } catch {
        /* opener closed / cross-origin race — non-fatal */
      }
    }
    render(win, outcome.status);
    // Self-close once we've relayed to an opener that now owns the UX (its
    // "Signing in…" overlay). A script-opened window can always close ITSELF,
    // so this avoids the opener having to call `popup.close()` across a
    // COOP-severed boundary — which logs a "Cross-Origin-Opener-Policy would
    // block the window.close call" warning. Done LAST so the status line above
    // is already painted as a fallback if a browser refuses the close.
    if (relayed && typeof win.close === 'function') {
      try {
        win.close();
      } catch {
        /* close refused — the "You can close this window" status line is the fallback */
      }
    }
    return;
  }

  // Not a relay: the signed-state vendor flow, or nothing this page finishes.
  if (params.get('error')) {
    render(win, 'provider_error');
    return;
  }
  const code = params.get('code') ?? '';
  if (!state) {
    render(win, 'invalid');
    return;
  }
  if (!code) {
    render(win, 'missing_code');
    return;
  }
  render(win, 'vendor_checking');
  const result = await completeVendorCallback(
    { code, state, realmId: params.get('realmId') },
    vendorDeps ?? browserVendorDeps(win),
  );
  render(
    win,
    result.status,
    result.httpStatus === undefined ? undefined : `(It answered ${String(result.httpStatus)}.)`,
  );
};

// Auto-run in the browser. The `typeof window` guard keeps node unit tests
// (which import the pure helpers directly) from invoking the DOM bootstrap.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void runOAuthCallbackRelay(window);
}
