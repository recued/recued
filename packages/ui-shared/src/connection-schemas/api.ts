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

import {
  CONNECTION_AUTH_TYPES,
  CONNECTION_SIGNING_SCHEMES,
  type ConnectionAuthType,
} from '@recued/contracts';

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
  description: 'Connect to an online service, signing in with a key, a username and password, or by clicking Authorize.',
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'identifier',
      help: 'A short name you use in Recipes, in lower case. For example `hubspot` or `hubspot-sandbox`.',
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
      help: 'The address every request starts from. Recipes add the rest.',
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
      help: 'Sent every time. Add one line per header. Most services need only one, such as X-API-Key.',
    },
    // Body-field — credentials the vendor reads from the JSON request BODY
    // rather than a header. The only auth type here that CANNOT be verified at
    // save time: the health probe is a GET and has no body to carry it.
    {
      key: 'auth.fields',
      label: 'Request-body credentials',
      type: 'body-field-list',
      showWhen: ifAuth('body_field'),
      help: 'Sent inside the request itself, for the operations that ask for it by name '
        + '(e.g. Plaid\u2019s access_token). \u26a0 Recued cannot check these when you '
        + 'save \u2014 the health probe carries no body, so this connection stays '
        + '\u201cunknown\u201d until an operation uses it.',
    },
    // Request signing — the only auth here whose credential is COMPUTED per
    // call rather than stored and re-sent.
    //
    // ⛔ The scheme is a SELECT over a closed registry, never a free-text
    // canonical string. A field an owner (or a pack) could type into would let
    // whoever fills it choose which bytes Recued signs with the secret below,
    // which is a signing oracle. `connection-signing.ts` carries the argument.
    {
      key: 'auth.scheme',
      label: 'Signing scheme',
      type: 'select',
      options: [...CONNECTION_SIGNING_SCHEMES],
      optionLabels: { binance_hmac_sha256: 'Binance (HMAC-SHA256)' },
      showWhen: ifAuth('request_signature'),
      help: 'Which vendor\u2019s signing rule to apply. Only listed schemes can be used.',
    },
    {
      key: 'auth.api_key',
      label: 'API key',
      type: 'text',
      showWhen: ifAuth('request_signature'),
      help: 'The public half, sent as-is on every request.',
    },
    {
      key: 'auth.secret_key',
      label: 'Signing secret',
      type: 'secret',
      showWhen: ifAuth('request_signature'),
      help: 'Keys the signature and is never transmitted. \u26a0 If calls fail auth, check '
        + 'this value and your machine\u2019s clock \u2014 requests carry a timestamp the '
        + 'refused if it is more than a few seconds out.',
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
      // Filled by the OAuth dance (`applyVendorOAuthResultValues`), never typed.
      autofilled: true,
      showWhen: ifAuth('oauth2_refresh'),
      // ⚠ Stays REQUIRED — the connection genuinely cannot work without one, and
      // marking it optional would let an owner save a connection that can never
      // mint an access token. But the old help ("the adapter mints fresh access
      // tokens automatically") described what the ADAPTER does with the value,
      // never how the owner GETS it — so a required secret field with a `*`
      // read as "go and obtain this yourself", when the normal path fills it
      // for you: `applyVendorOAuthResultValues` writes `auth.refresh_token`
      // from the dance's result (`vendors/index.ts`), for any vendor.
      //
      // The registered vendor schemas already say this (SharePoint: "populated
      // automatically by the in-app OAuth dance"); the GENERIC form — the one
      // an unknown vendor lands on, where nobody can look the answer up — did
      // not.
      help:
        'Recued fills this in when you click Authorize below. Only paste one yourself if '
        + 'you already have one for this app. Recued then uses it to get '
        + 'fresh keys as it needs them.',
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
      help: 'Some services do not use this. Leave it empty if yours does not ask for one.',
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
      help: 'Your account name. Set the address to your own server, or https://bsky.social for Bluesky.',
    },
    {
      key: 'auth.app_password',
      label: 'App Password',
      type: 'secret',
      showWhen: ifAuth('atproto_session'),
      help: 'An APP password, not the one you sign in with. Make one in your account settings, and turn it off there to cut Recued off. Recued swaps it for a short session, and keeps it so the session can renew itself.',
    },
    // OAuth2 client credentials. This secret is mandatory for the
    // machine-to-machine grant, unlike public-client refresh-token flows.
    {
      key: 'auth.client_secret',
      label: 'Client Secret',
      type: 'secret',
      showWhen: ifAuth('oauth2_client_credentials'),
      help: 'The app secret. Only Recued uses it, to get short-lived keys.',
    },
    {
      key: 'auth.scope',
      label: 'Scope',
      type: 'text',
      optional: true,
      showWhen: ifAuth('oauth2_client_credentials'),
      help: 'What to ask permission for. You can leave this empty.',
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
      help: 'The address where you say yes. Fill this in, and the scopes, to sign in here instead of pasting a key.',
    },
    {
      key: 'auth.scopes',
      label: 'Scopes',
      type: 'text',
      optional: true,
      showWhen: ifAuth('oauth2_refresh'),
      placeholder: 'read write',
      help: 'What to ask permission for, separated by spaces. You can leave this empty.',
    },
  ],
  probe: { method: 'OPTIONS', path: '/' },
};
