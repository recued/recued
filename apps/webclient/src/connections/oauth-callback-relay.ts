/** R26.2 Option B — self-serve OAuth opener-relay page (loopback PWA).
 *
 *  Bundled by `apps/webclient/scripts/build.mjs` into `oauth-callback-relay.js`
 *  and loaded by `public/oauth-callback.html`. The server's LAN-only webclient
 *  bundle (D-152) serves both at `WEBCLIENT_OAUTH_CALLBACK_PATH`
 *  (`/webclient/oauth-callback.html`) for a loopback PWA, so the whole OAuth
 *  round-trip stays on the user's machine — no app.recued.com hop.
 *
 *  This is the SELF-SERVE, same-origin counterpart to the cloud callback page
 *  (`backend/api/src/routes/oauth-callback.ts`). It is deliberately the simpler
 *  half: opener-relay ONLY (no signed-state connection-vendor flow), and always
 *  same-origin (the page is served from the PWA's own origin), so there is no
 *  `opener_origin` cross-origin target to resolve — it posts the code straight
 *  back to `window.opener` at this page's own origin. The popup driver
 *  (`foundational-oauth-popup.ts`) trusts it because `expectedSenderOrigin` is
 *  derived from the redirect host, which here equals the PWA's own origin.
 *
 *  CSRF is the opener's responsibility (it minted `state` and verifies the
 *  round-tripped value before calling `enrollOAuth`); this page just relays.
 *  Fail-closed: without the foundational `frelay_` state prefix it posts
 *  nothing. (The `recued_relay` query marker is NOT required here — the
 *  Microsoft flow omits it since Entra rejects query strings in redirect URIs,
 *  and this page is opener-relay-only so the marker was always redundant.) */

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
const WEBCLIENT_OAUTH_CALLBACK_PATH = '/webclient/oauth-callback.html';

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
 *  Microsoft flow omits it because Entra rejects query strings in redirect URIs,
 *  and this page is opener-relay-only so the marker was always redundant here).
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

const STATUS_TEXT: Record<
  OAuthRelayStatus,
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
};

/** Browser bootstrap: read the callback URL, scrub it from the address bar,
 *  post the code/error to the opener (SAME-ORIGIN — never `'*'`), then render a
 *  status line. */
export const runOAuthCallbackRelay = (win: Window): void => {
  let outcome: OAuthRelayOutcome;
  try {
    outcome = evaluateOpenerRelay(new URL(win.location.href).searchParams);
  } catch {
    outcome = { message: null, status: 'invalid' };
  }

  // Drop the code + state from the address bar + history immediately (privacy
  // parity with the cloud callback's history scrub).
  try {
    win.history.replaceState(null, '', WEBCLIENT_OAUTH_CALLBACK_PATH);
  } catch {
    /* replaceState can throw in odd embeddings — non-fatal */
  }

  // Same-origin post: this page is served by the user's own server at the same
  // origin as the opener PWA, so the targetOrigin is our own origin. NEVER '*'.
  const relayed = Boolean(outcome.message && win.opener);
  if (relayed) {
    try {
      win.opener!.postMessage(outcome.message, win.location.origin);
    } catch {
      /* opener closed / cross-origin race — non-fatal */
    }
  }

  const text = STATUS_TEXT[outcome.status];
  const statusEl = win.document.getElementById('status');
  if (statusEl) {
    statusEl.textContent = text.title;
    statusEl.className = text.ok ? 'ok' : 'err';
  }
  const messageEl = win.document.getElementById('message');
  if (messageEl) messageEl.textContent = text.message;

  // Self-close once we've relayed to an opener that now owns the UX (its
  // "Signing in…" overlay). A script-opened window can always close ITSELF, so
  // this avoids the opener having to call `popup.close()` across a COOP-severed
  // boundary — which logs a "Cross-Origin-Opener-Policy would block the
  // window.close call" warning. Done LAST so the status line above is already
  // painted as a fallback if a browser refuses the close.
  if (relayed && typeof win.close === 'function') {
    try {
      win.close();
    } catch {
      /* close refused — the "You can close this window" status line is the fallback */
    }
  }
};

// Auto-run in the browser. The `typeof window` guard keeps node unit tests
// (which import `evaluateOpenerRelay` directly) from invoking the DOM bootstrap.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  runOAuthCallbackRelay(window);
}
