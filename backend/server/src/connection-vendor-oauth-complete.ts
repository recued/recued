/** D-148 §A.12 / D-165 enroll-host #1 — vendor OAuth `/oauth/complete`
 *  handler core (slice 2a).
 *
 *  The BACK half of the OAuth dance (partner to `startVendorOAuth`). The
 *  authorization `code` arrives here two ways, both landing as a parsed
 *  `VendorOAuthCompleteRequest`:
 *    - cloud path — the D-148 §A.12 static callback page POSTs
 *      `{ code, state, flow_id }` (JSON) after verifying the signed state
 *      client-side;
 *    - direct path — the provider redirects the browser straight to
 *      `<server_url>/oauth/complete?code&state` (GET) when the user
 *      registered the server's own callback.
 *
 *  This module owns the verify→take→exchange→stash core, framework-neutral
 *  (no Node http types) so it unit-tests without socket mocking. Slice 2b
 *  adapts a `PortRequestHandler` to it (parse query/body → request, write
 *  the response descriptor) and wires the shared stores + a completion bus
 *  event + the point-to-point result-claim rpc.
 *
 *  Security ordering is load-bearing: the signed `state` is verified
 *  against THIS server's identity key BEFORE the `flow_id` it carries is
 *  trusted to consume a pending flow. Only a state this server minted at
 *  OAuth-start is honored, so the code can only complete a flow we
 *  actually started. Tokens never touch the cloud (I-18) — the exchange
 *  runs here, on the user-server.
 *
 *  Spec: `docs/d-148-spec.md` §A.12 + `project-d165-vendor-oauth-popup-scope`. */

import {
  getVendorProvider,
  buildGenericVendorProvider,
  composeRealmBaseUrl,
  canonicalizeServerPublicUrl,
  OAUTH_STATE_TOKEN_REPLAY_WINDOW_MS,
} from '@recued/contracts';
import { ed25519Verify } from './keys/index.js';
import type { ServerIdentity } from './identity/index.js';
import {
  decodeOauthStateToken,
  type VendorOAuthFlowStore,
  type VendorOAuthResultStore,
} from './connection-vendor-oauth-flow.js';
import {
  completeVendorOAuth,
  VendorOAuthError,
  type HttpFetcher,
} from './connection-vendor-oauth.js';

/** Parsed request — slice 2b's `PortRequestHandler` adapter fills this
 *  from the GET query string or the POST JSON body. */
export interface VendorOAuthCompleteRequest {
  method: 'GET' | 'POST';
  code?: string;
  state?: string;
  /** Present on the cloud-page POST; the direct GET derives `flow_id`
   *  from the verified state payload. When present it MUST match. */
  flow_id?: string;
  /** Provider `?error=` (user denied consent, etc.). */
  provider_error?: string;
  /** Realm-path vendors (QuickBooks) return a per-company id on the OAuth
   *  callback (`?realmId=…`) rather than in the token response. When the
   *  flow's provider declares `realm_base`, this composes `config.base_url`
   *  via the same channel Salesforce's token-response `instance_url` uses. */
  realm_id?: string;
}

export type VendorOAuthCompleteOutcome =
  | 'completed'
  | 'provider_error'
  | 'bad_request'
  | 'invalid_state'
  | 'expired'
  | 'flow_not_found'
  | 'exchange_failed'
  | 'not_configured';

export interface VendorOAuthCompleteResponse {
  status: number;
  content_type: 'application/json' | 'text/html; charset=utf-8';
  body: string;
  outcome: VendorOAuthCompleteOutcome;
  /** Set only on `completed` — slice 2b emits a `{ flow_id }` completion
   *  bus event so the open dialog claims the result via rpc. */
  flow_id?: string;
}

export interface VendorOAuthCompleteDeps {
  identity: ServerIdentity;
  flowStore: VendorOAuthFlowStore;
  resultStore: VendorOAuthResultStore;
  /** The server's configured public base URL (`RECUED_PUBLIC_BASE_URL`),
   *  or null when unset. The verified state's `server_url` must equal the
   *  canonical form of this. */
  serverPublicUrl: () => string | null;
  /** Defaults to `completeVendorOAuth`; tests inject a fake. */
  exchange?: typeof completeVendorOAuth;
  /** Forwarded to the exchange (token-endpoint + introspection fetch). */
  fetcher?: HttpFetcher;
  now?: () => number;
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const PAGE_HEAD =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="referrer" content="no-referrer"><title>Recued — OAuth</title></head>' +
  '<body style="font-family:system-ui,-apple-system,sans-serif;padding:2rem;max-width:32rem;margin:0 auto;color:#1a1a1a">';

/** Direct-GET pages drop `code`/`state` from the address bar + history.
 *  Defense-in-depth — after the single-use-flow invariant a lingering code
 *  is already spent and a lingering state already burned, but parity with
 *  the cloud callback page's `history.replaceState` hygiene is cheap.
 *  Slice 2b MUST serve these with `Cache-Control: no-store` and a CSP that
 *  admits exactly this inline script (sha256 hash-pin, like the cloud
 *  page's external-script SRI). */
/** The inline scrub script's exact text — exported so the slice-2b
 *  PortRequestHandler adapter can sha256-hash it for the page CSP
 *  (`script-src 'sha256-...'`), the way the cloud page pins its external
 *  script via SRI. */
export const GET_SCRUB_SCRIPT = 'history.replaceState(null,"","/oauth/complete")';
const GET_SCRUB = `<script>${GET_SCRUB_SCRIPT}</script>`;

const successPage = (): string =>
  `${PAGE_HEAD}<h1>OAuth complete</h1><p>You can close this tab and return to Recued.</p>${GET_SCRUB}</body></html>`;

/** `message` may carry provider- / vendor-supplied text (the `?error=`
 *  param, a token-endpoint error body) — ALWAYS escaped, never reflected
 *  raw, or the direct-GET page is a reflected-XSS sink. */
const errorPage = (message: string): string =>
  `${PAGE_HEAD}<h1>OAuth could not complete</h1><p>${escapeHtml(message)}</p>` +
  `<p><small>Return to Recued and try again.</small></p>${GET_SCRUB}</body></html>`;

const ok = (
  req: VendorOAuthCompleteRequest,
  flow_id: string,
): VendorOAuthCompleteResponse =>
  req.method === 'POST'
    ? {
        status: 200,
        content_type: 'application/json',
        body: JSON.stringify({ ok: true }),
        outcome: 'completed',
        flow_id,
      }
    : {
        status: 200,
        content_type: 'text/html; charset=utf-8',
        body: successPage(),
        outcome: 'completed',
        flow_id,
      };

const fail = (
  req: VendorOAuthCompleteRequest,
  status: number,
  outcome: VendorOAuthCompleteOutcome,
  message: string,
): VendorOAuthCompleteResponse =>
  req.method === 'POST'
    ? {
        status,
        content_type: 'application/json',
        body: JSON.stringify({ ok: false, error: outcome, message }),
        outcome,
      }
    : {
        status,
        content_type: 'text/html; charset=utf-8',
        body: errorPage(message),
        outcome,
      };

/** Verify the signed state, consume the pending flow, exchange the code on
 *  the user-server, and stash the result for the dialog to claim. Pure of
 *  Node http — returns a response descriptor slice 2b writes to the wire.
 *  The authorization code is single-use, so a failed exchange consumes the
 *  flow (the user restarts) rather than leaving a replayable flow behind. */
export const handleVendorOAuthComplete = async (
  deps: VendorOAuthCompleteDeps,
  req: VendorOAuthCompleteRequest,
): Promise<VendorOAuthCompleteResponse> => {
  const now = (deps.now ?? Date.now)();
  const exchange = deps.exchange ?? completeVendorOAuth;

  // Fully validate the signed state BEFORE trusting any field or consuming
  // the flow. `state` is present even on a denial (the provider echoes it),
  // so we validate it first — `code` is checked later, after the flow is
  // consumed.
  if (typeof req.state !== 'string' || !req.state) {
    return fail(req, 400, 'bad_request', 'Missing state token.');
  }
  const decoded = decodeOauthStateToken(req.state);
  if (!decoded) {
    return fail(req, 400, 'invalid_state', 'State token malformed.');
  }
  const verified = ed25519Verify(
    deps.identity.serverIdentityKey().public_key_b64,
    decoded.payload_bytes,
    decoded.signature_b64,
  );
  if (!verified) {
    return fail(req, 400, 'invalid_state', 'State token signature invalid.');
  }
  // A POST-supplied flow_id must match the signed payload.
  if (req.flow_id !== undefined && req.flow_id !== decoded.payload.flow_id) {
    return fail(req, 400, 'invalid_state', 'flow_id does not match state.');
  }
  // Replay window — reject stale AND future-dated.
  const ageMs = now - decoded.payload.ts;
  if (ageMs < 0 || ageMs > OAUTH_STATE_TOKEN_REPLAY_WINDOW_MS) {
    return fail(req, 400, 'expired', 'State token expired — restart the OAuth flow.');
  }
  // The state must have been minted for THIS server (defends against a
  // state replayed at a different server instance).
  const ownOrigin = canonicalizeServerPublicUrl(deps.serverPublicUrl() ?? '');
  if (!ownOrigin) {
    return fail(req, 503, 'not_configured', 'Server public URL not configured.');
  }
  if (decoded.payload.server_url !== ownOrigin) {
    return fail(req, 400, 'invalid_state', 'State token was not minted for this server.');
  }

  // CONSUME the pending flow now — single-use for ANY validly-stated
  // outcome below (success, provider denial, or a malformed/code-less
  // callback). This is the replay invariant: a second presentation of the
  // same valid state (incl. a denial that echoes it) lands on
  // flow_not_found and can never re-bind a fresh code to the flow.
  const flow = deps.flowStore.take(decoded.payload.flow_id);
  if (!flow) {
    return fail(
      req,
      409,
      'flow_not_found',
      'No pending OAuth flow for this state (already completed or expired).',
    );
  }

  // Provider declined (denial echoes `state` but carries no `code`). The
  // flow is already burned above, so the state cannot be replayed.
  if (req.provider_error) {
    return fail(req, 400, 'provider_error', `Authorization failed: ${req.provider_error}`);
  }
  if (typeof req.code !== 'string' || !req.code) {
    return fail(req, 400, 'bad_request', 'Missing authorization code.');
  }
  // R14 — a form-supplied flow stored its own `token_endpoint`; synthesize the
  // provider from it (no registry entry exists). The exchange reads only
  // `oauth.token_endpoint` (+ optional introspection, absent here); `authorize_
  // url`/`scopes` are request-time only, so placeholders are fine. Registered
  // flows resolve via the registry as before.
  const provider =
    flow.token_endpoint !== undefined
      ? buildGenericVendorProvider({
          authorize_url: '',
          token_endpoint: flow.token_endpoint,
          scopes: flow.scopes ?? [],
          vendor: flow.vendor,
        })
      : getVendorProvider(flow.vendor);
  if (!provider) {
    return fail(req, 500, 'exchange_failed', `Unknown vendor '${flow.vendor}'.`);
  }

  try {
    const result = await exchange({
      provider,
      code: req.code,
      redirect_uri: flow.redirect_uri,
      client_id: flow.client_id,
      ...(flow.client_secret !== undefined ? { client_secret: flow.client_secret } : {}),
      sandbox: flow.sandbox,
      // PKCE: the verifier minted at OAuth-start for `supports_pkce` vendors.
      // Sending it binds the code to THIS flow — an injected code (issued
      // against a different challenge) fails the exchange. Absent for non-PKCE
      // vendors (the flow record has no verifier).
      ...(flow.code_verifier !== undefined ? { code_verifier: flow.code_verifier } : {}),
      ...(deps.fetcher !== undefined ? { fetcher: deps.fetcher } : {}),
    });
    // Realm-path vendors (QuickBooks): the per-company runtime base is NOT
    // in the token response — compose it from the callback `realmId` + the
    // flow's sandbox flag and carry it on the same `instance_url` channel
    // Salesforce uses, so the existing instance_url → config.base_url path
    // persists it with no dialog/enroll change. Token-response instance_url
    // (Salesforce) still wins when present.
    const instance_url =
      result.instance_url ??
      (req.realm_id
        ? composeRealmBaseUrl(provider, req.realm_id, flow.sandbox) ?? undefined
        : undefined);
    deps.resultStore.put(
      flow.flow_id,
      {
        refresh_token: result.refresh_token,
        granted_scopes: result.granted_scopes,
        ...(instance_url !== undefined ? { instance_url } : {}),
      },
      // Owner-binding: the result inherits the flow's claim_secret so only
      // the dialog that started the flow (holding the secret) can claim it.
      flow.claim_secret,
      now,
    );
    return ok(req, flow.flow_id);
  } catch (e) {
    const msg = e instanceof VendorOAuthError ? e.message : 'Token exchange failed.';
    return fail(req, 502, 'exchange_failed', msg);
  }
};
