/** D-125 P7.2 — schema for `connection.api` enrollment.
 *
 *  Every enrollable `ConnectionAuth` variant reaches the connection.api handler
 *  (P4.1) and surfaces its own subset of fields once the user picks the auth
 *  type from the select. `none` is excluded from the dialog — a public endpoint
 *  without auth is rare enough that the user can pick a no-op `header` value if
 *  they really need it; keeping the picker small reads cleaner.
 *
 *  ⚠ **The variant list is no longer enumerated in this comment either
 *  (D-218).** It said "six" and had drifted; a prose count of a closed
 *  vocabulary is one more copy to fall behind. `AUTH_TYPES` derives from
 *  `CONNECTION_AUTH_TYPES`. */

import { CONNECTION_AUTH_TYPES, type ConnectionAuthType } from '@recued/contracts';

import type { ConnectionSchema } from './types.js';

/** The ENROLLABLE auth types — every `ConnectionAuth` discriminant except
 *  `none`, which is not something an owner fills a form in for.
 *
 *  ⚠ **DERIVED, not copied (D-218).** This was a hand-kept list, and so were the
 *  contracts descriptor list and the connection handler's set. Widening
 *  `ConnectionAuth` left all three silently short and every one of them still
 *  typechecked — a subset always does. The exclusion of `none` is now WRITTEN
 *  DOWN rather than implied by an omission, so a future type joins the form
 *  automatically and leaving one out has to be a decision. */
const AUTH_TYPES = CONNECTION_AUTH_TYPES.filter(
  (t): t is Exclude<ConnectionAuthType, 'none'> => t !== 'none',
);

const ifAuth = (...types: readonly string[]): (v: Record<string, string>) => boolean => {
  const set = new Set<string>(types);
  return (v) => set.has(v['auth.type'] ?? '');
};

export const apiSchema: ConnectionSchema = {
  kind: 'api',
  label: 'HTTP API',
  description: 'Connect to an online app or service through its web API, signed in with an API key, a username and password, or OAuth.',
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'identifier',
      help: 'Lowercase identifier used in recipes (e.g. `hubspot`, `hubspot-sandbox`).',
      placeholder: 'hubspot',
    },
    {
      key: 'display_name',
      label: 'Display Name',
      type: 'text',
      placeholder: 'HubSpot Production',
    },
    {
      key: 'config.base_url',
      label: 'Base URL',
      type: 'url',
      placeholder: 'https://api.hubapi.com',
      help: 'Root URL for every request; recipe ingredients append paths.',
    },
    // Vendor identity tag for API-key vendors without a registered vendor
    // schema (Stripe, Exa, …). Hidden + optional: the plain bare-api path
    // leaves it empty (dropped by the projection — inert), while the
    // packs "Set up" vendor-prefilled enroll seeds it so pack-readiness /
    // runnability VENDOR-matching (`config.vendor`, `resolveConnectionVendor`)
    // recognizes the enrollment. Also lets edit mode round-trip an existing
    // row's `config.vendor` — the view flatten seeds `config.vendor` into
    // form values, and without a schema field the projection walk would
    // silently strip it from the update patch.
    {
      key: 'config.vendor',
      label: 'Vendor',
      type: 'text',
      hidden: true,
      optional: true,
    },
    // D-165 P3.path-picker — optional sub-resource permission boundary.
    // Top-level key (lands at the enroll-rpc root, not under config/auth).
    // Blank → dropped by the projection → server canonicalizes to `/`
    // (whole account). Read-only in edit mode (immutable post-enrollment;
    // the update rpc ignores it) via the same renderer rule as `name`.
    {
      key: 'subresource_path',
      label: 'Sub-resource path',
      type: 'text',
      optional: true,
      placeholder: '/',
      help: 'Optional. Limit this connection to a path within the account — e.g. `/photos` for one S3 bucket or `/databases/<id>` for one Notion database. Leave blank for `/` (whole account). Set once at enrollment; re-scope by adding a new connection.',
    },
    {
      key: 'auth.type',
      label: 'Auth Type',
      type: 'select',
      options: AUTH_TYPES,
    },
    // Bearer
    {
      key: 'auth.token',
      label: 'Bearer Token',
      type: 'secret',
      showWhen: ifAuth('bearer'),
      help: 'Sent as `Authorization: Bearer <token>` on every call.',
    },
    // Basic
    {
      key: 'auth.username',
      label: 'Username',
      type: 'text',
      showWhen: ifAuth('basic'),
    },
    {
      key: 'auth.password',
      label: 'Password',
      type: 'secret',
      showWhen: ifAuth('basic'),
    },
    // Header — a repeatable list of N custom credential headers. One covers the
    // common single-API-key case (`X-API-Key: …`); add more for vendors that
    // split credentials across headers (e.g. Plaid's `PLAID-CLIENT-ID` +
    // `PLAID-SECRET`). The `header-list` renderer manages the `auth.headers.<i>.*`
    // rows; `setDeep` projects them into the `auth.headers` array.
    {
      key: 'auth.headers',
      label: 'Headers',
      type: 'header-list',
      showWhen: ifAuth('header'),
      help: 'Sent on every call. Add one per credential header — most APIs need just one (e.g. X-API-Key).',
    },
    // Query
    {
      key: 'auth.param_name',
      label: 'Query Param',
      type: 'text',
      placeholder: 'api_key',
      showWhen: ifAuth('query'),
    },
    {
      key: 'auth.value',
      label: 'Query Value',
      type: 'secret',
      showWhen: ifAuth('query'),
    },
    // OAuth2 refresh
    {
      key: 'auth.refresh_token',
      label: 'Refresh Token',
      type: 'secret',
      showWhen: ifAuth('oauth2_refresh'),
      help: 'Long-lived refresh token; the adapter mints fresh access tokens automatically.',
    },
    {
      key: 'auth.client_id',
      label: 'Client ID',
      type: 'text',
      showWhen: ifAuth('oauth2_refresh', 'oauth2_client_credentials'),
    },
    {
      key: 'auth.client_secret',
      label: 'Client Secret',
      type: 'secret',
      optional: true,
      showWhen: ifAuth('oauth2_refresh'),
      help: 'Some providers (PKCE / public clients) omit this. Leave blank if your provider does not require it.',
    },
    {
      key: 'auth.token_endpoint',
      label: 'Token Endpoint',
      type: 'url',
      showWhen: ifAuth('oauth2_refresh', 'oauth2_client_credentials'),
      placeholder: 'https://oauth.example.com/token',
    },
    // D-218 — AT Protocol session exchange (Bluesky, or any PDS).
    //
    // ⛔ **Two fields, and NO endpoint field — that absence is the security
    // property (§ 7.5b).** Every other exchanging type here asks for a token
    // endpoint; this one derives the session URLs from the connection's own
    // Base URL, so the app password can only ever be POSTed to the host this
    // connection already talks to. A third field here would quietly become a
    // credential-only destination nobody would think to audit.
    {
      key: 'auth.identifier',
      label: 'Handle or DID',
      type: 'text',
      showWhen: ifAuth('atproto_session'),
      placeholder: 'alice.bsky.social',
      help: 'Your account handle or DID. Set Base URL to your PDS (https://bsky.social for Bluesky).',
    },
    {
      key: 'auth.app_password',
      label: 'App Password',
      type: 'secret',
      showWhen: ifAuth('atproto_session'),
      help: 'An APP password, not your account password — create one in your account settings and revoke it there to cut access. Recued exchanges it for a short-lived session and keeps it so an expired session can renew itself without you.',
    },
    // OAuth2 client credentials. This secret is mandatory for the
    // machine-to-machine grant, unlike public-client refresh-token flows.
    {
      key: 'auth.client_secret',
      label: 'Client Secret',
      type: 'secret',
      showWhen: ifAuth('oauth2_client_credentials'),
      help: 'The application secret used only by the trusted connection adapter to mint short-lived access tokens.',
    },
    {
      key: 'auth.scope',
      label: 'Scope',
      type: 'text',
      optional: true,
      showWhen: ifAuth('oauth2_client_credentials'),
      help: 'Optional OAuth scope string requested during token exchange.',
    },
    // R14 — the two fields that let the in-app "Authorize" consent dance run
    // for ANY vendor (not just the registered ones). Optional: leave blank and
    // paste a refresh token instead; fill them to click Authorize.
    {
      key: 'auth.authorize_url',
      label: 'Authorize URL',
      type: 'url',
      optional: true,
      showWhen: ifAuth('oauth2_refresh'),
      placeholder: 'https://oauth.example.com/authorize',
      help: 'Optional. The provider consent URL. Fill it (+ Scopes) to authorize in-app instead of pasting a refresh token.',
    },
    {
      key: 'auth.scopes',
      label: 'Scopes',
      type: 'text',
      optional: true,
      showWhen: ifAuth('oauth2_refresh'),
      placeholder: 'read write',
      help: 'Optional. Space-separated OAuth scopes requested during in-app authorization.',
    },
  ],
  probe: { method: 'OPTIONS', path: '/' },
};
