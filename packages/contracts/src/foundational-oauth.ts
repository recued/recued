/** D-174 Slice 2b — foundational-lane OAuth substrate (Mail + Calendar).
 *
 *  Web-side construction of the Gmail / Microsoft Graph / Google-Calendar
 *  authorize URLs for the Mail + Calendar account lanes, plus the shared
 *  opener-relay callback contract. The webclient popup driver builds the
 *  authorize URL from the server-provided `client_id`
 *  (`server.getOAuthClientConfig`), opens the consent popup, captures the
 *  raw `code` handed back by the callback page, and forwards it to
 *  `collection.{mail,calendar}.enrollOAuth`, where the server completes the
 *  exchange with its env `client_secret`.
 *
 *  NO PKCE. Mail/cal use a pure `authorization_code` + `client_secret`
 *  exchange (`backend/server/.../collections/mail/oauth.ts`), so these
 *  builders mint nothing secret — only `client_id` + `redirect_uri` + a
 *  client-minted CSRF `state`. (Contrast: the connection-vendor OAuth path
 *  DOES use PKCE + a server-signed Ed25519 state token; that machinery is
 *  deliberately NOT reused here.)
 *
 *  Endpoints + scopes are fixed per provider. Refresh-token reliability:
 *  Google needs `access_type=offline` + `prompt=consent` (query params);
 *  Microsoft needs the `offline_access` SCOPE. The scope sets mirror the
 *  (now-removed) extension flow + the server providers' actual API calls
 *  (gmail `users.getProfile` + messages → gmail.readonly; graph `/me` →
 *  User.Read; calendar → calendar / Calendars.ReadWrite).
 */

// ── Authorize endpoints ──────────────────────────────────────────────

/** Google OAuth 2.0 authorize endpoint (gmail + gcal). Same value as
 *  `GOOGLE_OAUTH_AUTHORIZE_URL` in connection-vendor-providers — kept
 *  separate so the foundational lanes don't depend on the vendor module. */
export const GOOGLE_AUTHORIZE_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';

/** Microsoft identity platform v2 authorize endpoint (graph mail + cal),
 *  `common` tenant — covers both personal and work/school accounts. The
 *  matching token endpoint also lives under `/common/` server-side. */
export const MICROSOFT_AUTHORIZE_URL =
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';

/** Microsoft identity platform v2 token endpoint (`common` tenant). The
 *  canonical home for the Graph token URL — the graph mail + calendar adapters
 *  (`GRAPH_TOKEN_URL` / `GRAPH_CAL_TOKEN_URL`) and the D-192 OneDrive
 *  vendor-connection provider all POST their `authorization_code` /
 *  `refresh_token` exchanges here. Same `/common/` tenant as the authorize URL. */
export const MICROSOFT_TOKEN_URL =
  'https://login.microsoftonline.com/common/oauth2/v2.0/token';

/** Google OAuth2 token endpoint — the gmail + gcal adapters' counterpart to
 *  `MICROSOFT_TOKEN_URL`. A PROTOCOL constant, not a credential: it is the one
 *  piece of the old `GMAIL_OAUTH_CONFIG` / `GCAL_OAUTH_CONFIG` consts that
 *  survived deleting the six `RECUED_*` OAuth env vars, since the stored-
 *  credential path still needs somewhere to POST the exchange. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ── Scope strings ────────────────────────────────────────────────────

/** Gmail read — covers message list/get/history AND `users.getProfile`
 *  (the mailbox address surfaces there, so no separate identity call). */
export const GMAIL_READONLY_SCOPE =
  'https://www.googleapis.com/auth/gmail.readonly';
/** Gmail send — requested only when the user opts into outbound. Mirrors
 *  `GMAIL_SEND_SCOPE` (gmail-provider.ts), the `send_capable` gate. */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
/** Google account-identity scope so the consent screen surfaces the mailbox
 *  address. The server reads the address from `users.getProfile` under the
 *  readonly scope already — this matches the identity scope the removed
 *  extension flow requested; harmless if the server never calls userinfo. */
export const GOOGLE_USERINFO_EMAIL_SCOPE =
  'https://www.googleapis.com/auth/userinfo.email';
/** Google Calendar read/write. */
export const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar';

/** Microsoft Graph mail read. */
export const GRAPH_MAIL_READ_SCOPE = 'Mail.Read';
/** Microsoft Graph mail send — opt-in outbound. Mirrors `GRAPH_SEND_SCOPE`. */
export const GRAPH_MAIL_SEND_SCOPE = 'Mail.Send';
/** Microsoft Graph calendar read/write. */
export const GRAPH_CALENDAR_SCOPE = 'Calendars.ReadWrite';
/** Microsoft refresh-token scope (Google uses `access_type=offline`). */
export const GRAPH_OFFLINE_SCOPE = 'offline_access';
/** Microsoft `/me` identity scope (userPrincipalName at enroll). */
export const GRAPH_USER_READ_SCOPE = 'User.Read';
/** Microsoft Graph files read — covers the D-192 OneDrive metadata walk and
 *  lazy explicit byte reads. It grants no file mutation authority. */
export const GRAPH_FILES_READ_SCOPE = 'Files.Read';
/** Microsoft Graph SharePoint sites read — the D-192 SharePoint file-source
 *  mirror's metadata-read floor. `Files.Read` is scoped to the signed-in user's
 *  OWN OneDrive, so a SharePoint document library (reached via
 *  `/drives/{drive_id}/root/delta`) needs a broader grant: `Sites.Read.All`
 *  reads items across the site collections the user can access. It covers
 *  metadata sync and lazy explicit reads, with no `Sites.ReadWrite.All`. */
export const GRAPH_SITES_READ_ALL_SCOPE = 'Sites.Read.All';
/** Microsoft Graph files WRITE — item create / update / delete on the drives the
 *  signed-in user can reach. Owner-ratified default (2026-08-07): requested at
 *  OneDrive enrollment so a connection is write-capable BEFORE any pack is
 *  installed. ⚠ It is a strict superset of {@link GRAPH_FILES_READ_SCOPE}; both are
 *  requested so the granted set stays legible next to what the packs declare and a
 *  reader comparing the two finds them consistent. */
export const GRAPH_FILES_READWRITE_SCOPE = 'Files.ReadWrite';
/** Microsoft Graph SharePoint sites WRITE — the {@link GRAPH_SITES_READ_ALL_SCOPE}
 *  counterpart, same owner-ratified default. Needed because a document-library
 *  drive is not reachable by `Files.ReadWrite` (which is scoped to the user's own
 *  OneDrive), exactly as the read pair splits. */
export const GRAPH_SITES_READWRITE_ALL_SCOPE = 'Sites.ReadWrite.All';

// ── Scope sets ───────────────────────────────────────────────────────

export const gmailScopes = (sendEnabled: boolean): string[] => [
  GMAIL_READONLY_SCOPE,
  GOOGLE_USERINFO_EMAIL_SCOPE,
  ...(sendEnabled ? [GMAIL_SEND_SCOPE] : []),
];

/** Microsoft mail-lane scopes.
 *
 *  `calendarEnabled` folds the CALENDAR scope into the SAME consent. Microsoft
 *  is the one issuer where this costs nothing extra: its mail and calendar
 *  adapters are both named `graph`, so their tokens live under one
 *  `account.graph.<slug>.*` prefix and one grant genuinely serves both lanes
 *  (`collections/calendar/enroll.ts` § 2). Their scope sets already overlap on
 *  `offline_access` + `User.Read`; only `Calendars.ReadWrite` is new.
 *
 *  ⚠ That scope is read/WRITE, while mail defaults to read-only with send as a
 *  separate opt-in. So this is gated on an explicit, unchecked-by-default choice
 *  — never folded in silently — exactly as `sendEnabled` is.
 *
 *  Google is deliberately NOT symmetric: `gmail` and `gcal` are distinct adapter
 *  names with distinct key prefixes, so one consent's tokens would have to be
 *  fanned out to a second prefix. That is a separate change. */
export const graphMailScopes = (
  sendEnabled: boolean,
  calendarEnabled = false,
): string[] => [
  GRAPH_MAIL_READ_SCOPE,
  GRAPH_OFFLINE_SCOPE,
  GRAPH_USER_READ_SCOPE,
  ...(sendEnabled ? [GRAPH_MAIL_SEND_SCOPE] : []),
  ...(calendarEnabled ? [GRAPH_CALENDAR_SCOPE] : []),
];

export const gcalScopes = (): string[] => [GCAL_SCOPE];

export const graphCalendarScopes = (): string[] => [
  GRAPH_CALENDAR_SCOPE,
  GRAPH_OFFLINE_SCOPE,
  GRAPH_USER_READ_SCOPE,
];

// ── Authorize-URL builders ───────────────────────────────────────────

/** Mail lane uses `provider` (matches `collection.mail.enrollOAuth`). */
export type MailOAuthProvider = 'gmail' | 'graph';
/** Calendar lane uses `adapter` (matches `collection.calendar.enrollOAuth`). */
export type CalendarOAuthAdapter = 'gcal' | 'graph';

export interface AuthorizeUrlParams {
  /** Server-issued OAuth app client id (`server.getOAuthClientConfig`). */
  client_id: string;
  /** Callback URL — MUST byte-match the value later passed to `enrollOAuth`
   *  and the URI registered in the operator's OAuth app. Carries the
   *  opener-relay marker (see `OAUTH_OPENER_RELAY_PARAM`). */
  redirect_uri: string;
  /** Client-minted CSRF nonce; the opener verifies the round-tripped value
   *  before calling `enrollOAuth`. */
  state: string;
}

const buildGoogleAuthorizeUrl = (
  scopes: readonly string[],
  { client_id, redirect_uri, state }: AuthorizeUrlParams,
): string => {
  const u = new URL(GOOGLE_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', client_id);
  u.searchParams.set('redirect_uri', redirect_uri);
  u.searchParams.set('scope', scopes.join(' '));
  u.searchParams.set('state', state);
  // Refresh-token reliability — Google re-issues a refresh_token ONLY with
  // both of these; without them a re-consent returns access-only and the
  // server exchange throws `missing_refresh_token`.
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  return u.toString();
};

const buildMicrosoftAuthorizeUrl = (
  scopes: readonly string[],
  { client_id, redirect_uri, state }: AuthorizeUrlParams,
): string => {
  const u = new URL(MICROSOFT_AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  // Force the code back on the query string (not the fragment) so the
  // callback page reads it the same way for Google + Microsoft.
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('client_id', client_id);
  u.searchParams.set('redirect_uri', redirect_uri);
  u.searchParams.set('scope', scopes.join(' '));
  u.searchParams.set('state', state);
  return u.toString();
};

/** Build the Mail-lane consent URL for Gmail / Microsoft.
 *
 *  `calendar_enabled` applies to MICROSOFT ONLY — see {@link graphMailScopes}.
 *  Passing it for `gmail` is ignored rather than an error, because the caller is
 *  a form whose field set is provider-driven; silently widening Google's consent
 *  would be the actual bug. */
export const buildMailAuthorizeUrl = (
  provider: MailOAuthProvider,
  params: AuthorizeUrlParams & { send_enabled: boolean; calendar_enabled?: boolean },
): string =>
  provider === 'gmail'
    ? buildGoogleAuthorizeUrl(gmailScopes(params.send_enabled), params)
    : buildMicrosoftAuthorizeUrl(
        graphMailScopes(params.send_enabled, params.calendar_enabled === true),
        params,
      );

/** Build the Calendar-lane consent URL for Google / Microsoft. */
export const buildCalendarAuthorizeUrl = (
  adapter: CalendarOAuthAdapter,
  params: AuthorizeUrlParams,
): string =>
  adapter === 'gcal'
    ? buildGoogleAuthorizeUrl(gcalScopes(), params)
    : buildMicrosoftAuthorizeUrl(graphCalendarScopes(), params);

// ── Opener-relay callback contract (Slice 2b, fork A; R26.2 cross-origin) ──
//
// The shared `app.recued.com/oauth-callback` page handles two disjoint
// trust models. The connection-vendor flow carries a server-signed Ed25519
// state and POSTs the code to a user-server `/oauth/complete`. The
// foundational mail/cal flow instead tags its redirect_uri with the marker
// below; the callback page then hands the RAW code back to `window.opener`
// via `postMessage`, and the opener calls `enrollOAuth`. The connection flow
// never sets the marker, so the two paths stay separate.
//
// R26.2 (Option A) — cross-origin opener via the cloud bounce. The default
// callback host is the public cloud origin (a stable https target every
// provider accepts; a self-served PWA's own LAN-IP/http origin is rejected as
// a redirect). When the PWA does NOT run on the cloud origin (served from the
// user's own server — LAN / self-host), its origin rides the redirect_uri as
// `opener_origin` and the callback `postMessage`s the code to THAT cross-origin
// target. CSRF is unchanged (the opener still verifies the full minted
// `state`); the `opener_origin` is NOT a secret and is constrained two ways —
// it is part of the byte-matched registered redirect_uri (not
// attacker-injectable), and the browser only delivers the `postMessage` to the
// opener's REAL origin, so a wrong value simply fails to deliver (fail-safe, no
// code leak).
//
// R26.2 (Option B) — same-origin self-serve for a LOOPBACK PWA. When the PWA
// runs on `http(s)://localhost` / `127.0.0.1` / `[::1]` (a self-hosted server
// the user reaches on the same machine), `pickOAuthCallbackHost` selects the
// PWA's OWN origin as the callback host and the server serves the relay page
// itself, from its webclient bundle (D-152), at `WEBCLIENT_OAUTH_CALLBACK_PATH`.
// The whole OAuth round-trip then stays on the user's machine — no cloud hop,
// no `opener_origin` (it's same-origin). The opener trusts the callback by
// deriving `expectedSenderOrigin` from the redirect host, which here equals
// the PWA's own origin.
//
// ⛔ WIDENED 2026-09-29 to the server's own HTTPS NAME (`selfServesOAuthCallback`):
// a Pro `<handle>.recued.net` address, the owner's own domain, or a proxy
// holding the certificate. This comment used to send an own-https PWA to
// Option A on the grounds that the webclient bundle is LAN-listener-only; it
// is not (the public listener serves it once `/webclient` is opened there),
// and Option A could not deliver: since the webclient took over
// app.recued.com (2026-07-01) the page there was the webclient's relay, which
// never read `opener_origin`. For Microsoft it could never have worked — the
// bounce needs `opener_origin` in the query, which an app that takes personal
// accounts may not register. An https NAME is a callback both providers
// accept, so the code now stays on the owner's server there too. Option A is
// kept for what cannot self-serve: an https IP literal, a single-label name,
// and a Recued-hosted webclient other than app.recued.com (staging).

/** Query-param the foundational redirect_uri carries to select opener-relay
 *  mode on the callback page. */
import { OAUTH_CLOUD_CALLBACK_URL } from './cloud-api.js';

export const OAUTH_OPENER_RELAY_PARAM = 'recued_relay';
/** The only accepted value for `OAUTH_OPENER_RELAY_PARAM`. */
export const OAUTH_OPENER_RELAY_VALUE = 'opener';

/** Family marker the popup driver prepends to the client-minted `state`.
 *  The callback page requires it (IN ADDITION to the redirect_uri marker)
 *  before relaying, so the relay branch is fail-closed AT THE PAGE — it
 *  doesn't depend on the connection-vendor redirect_uri allowlist keeping
 *  the marker off signed-state flows. Does NOT weaken CSRF: the opener
 *  still verifies the FULL state (prefix + nonce) by exact match. */
export const OAUTH_OPENER_RELAY_STATE_PREFIX = 'frelay_';

/** Query-param the foundational redirect_uri carries to name the opener PWA's
 *  origin (R26.2 Option A). Present only when the PWA does NOT run on the
 *  cloud callback origin (i.e. a self-served LAN / self-host PWA); the callback
 *  page `postMessage`s the code to this origin instead of its own. Omitted for
 *  the same-origin `app.recued.com` PWA. Read back via `readOpenerRelayTarget`. */
export const OAUTH_OPENER_ORIGIN_PARAM = 'opener_origin';

/** Origin of the shared cloud OAuth-callback host. The DEFAULT redirect host
 *  for the foundational flow — a stable public-https target every provider
 *  accepts (a self-served PWA's own LAN-IP/http origin is not). Mirrors the
 *  origin of `OAUTH_CLOUD_CALLBACK_URL` (asserted equal in the contract test).
 *  A PWA that `selfServesOAuthCallback` — loopback, or the server's own https
 *  name — skips this hop; any other self-served PWA bounces here. */
export const OAUTH_CLOUD_CALLBACK_ORIGIN = 'https://app.recued.com' as const;

/** R26.2 Option B — path the server's LAN-only webclient bundle (D-152) serves
 *  the self-serve relay page at. MUST live under `WEBCLIENT_PATH_PREFIX`
 *  (`/webclient`) so the existing webclient handler serves it as a bundle
 *  asset; the asset itself ships in the webclient build (`apps/webclient/
 *  public/oauth-callback.html` + `oauth-callback-relay.js`). A contract test
 *  pins it under the prefix. Only used for loopback self-serve; the cloud
 *  bounce keeps its own top-level `/oauth-callback` path. */
export const WEBCLIENT_OAUTH_CALLBACK_PATH = '/webclient/oauth-callback.html' as const;

/** Loopback hostnames a self-hosted server is reached on from the same machine.
 *  Exactly the set providers honor as a no-registration-friction redirect
 *  target (`http://localhost` / `127.0.0.1` / `[::1]`); NOT the whole
 *  `127.0.0.0/8`, matching e.g. Google's loopback rule. `[::1]` carries the
 *  brackets `URL.hostname` returns for an IPv6 literal. */
const OAUTH_LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

/** True when `origin` is a canonical http(s) loopback origin (R26.2 Option B
 *  self-serve eligibility). Mirrors `readOpenerRelayTarget`'s canonical-origin
 *  discipline: parseable, http(s), and `new URL(o).origin === o` (a bare origin,
 *  no path / userinfo / host-confusion). Any other input → false (→ cloud
 *  bounce, fail-safe). */
export const isLoopbackOrigin = (origin: string): boolean => {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.origin !== origin) return false; // canonical bare origin only
    return OAUTH_LOOPBACK_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
};

/** The same loopback page under the NAME `localhost` (same scheme and port),
 *  for a page open at a NUMBERED loopback address — `127.0.0.1` or `[::1]` —
 *  else `null` (already `localhost`, or not loopback at all).
 *
 *  ⛔ Exists because the server's start-up log prints `http://127.0.0.1:<port>`,
 *  so that is where owners are, and a provider that allows an `http` callback
 *  only for loopback may allow it only by name: HubSpot will not register a
 *  `127.0.0.1` redirect URL, and the Azure portal refuses an `http` one at a
 *  number. The callback follows the page, so the page must move. */
export const localhostOriginForNumberedLoopback = (origin: string): string | null => {
  if (!isLoopbackOrigin(origin)) return null;
  const u = new URL(origin);
  if (u.hostname === 'localhost') return null;
  return `${u.protocol}//localhost${u.port === '' ? '' : `:${u.port}`}`;
};

/** The webclient origins Recued itself hosts. They serve the callback page at
 *  `/oauth-callback`, not under `/webclient/`, so they never self-serve.
 *  `app.recued2.com` is staging: it keeps bouncing through the production
 *  callback page (Option A), as it did before own-https self-serve. */
const RECUED_HOSTED_WEBCLIENT_ORIGINS: ReadonlySet<string> = new Set([
  OAUTH_CLOUD_CALLBACK_ORIGIN,
  'https://app.recued2.com',
]);

/** An IPv4 dotted quad, or an IPv6 literal (bracketed, as `URL.hostname` gives it). */
const isIpLiteralHostname = (hostname: string): boolean =>
  hostname.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);

/** True when a PWA at `origin` takes the provider's code at its OWN origin: the
 *  owner's Recued server serves the relay page there, at
 *  `WEBCLIENT_OAUTH_CALLBACK_PATH`, and the code never crosses app.recued.com.
 *
 *    - loopback (`isLoopbackOrigin`) — R26.2 Option B;
 *    - an https NAME — the server's own address: a Pro `<handle>.recued.net`
 *      name, the owner's own domain, or a proxy that holds the certificate.
 *      Both providers accept an https name as a callback, and it is the only
 *      route from such a page that Microsoft can take at all.
 *
 *  Not self-served, so bounced through app.recued.com (Option A): an https IP
 *  literal (Google refuses a raw IP as a callback host), a single-label name
 *  (no public top-level domain), plain http beyond loopback (providers refuse
 *  it, and the webclient cannot run there — not a secure context), and a
 *  Recued-hosted webclient. Malformed or non-canonical input → false. */
export const selfServesOAuthCallback = (origin: string): boolean => {
  if (isLoopbackOrigin(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:') return false;
    if (u.origin !== origin) return false; // canonical bare origin only
    if (RECUED_HOSTED_WEBCLIENT_ORIGINS.has(origin)) return false;
    if (isIpLiteralHostname(u.hostname)) return false;
    return u.hostname.includes('.');
  } catch {
    return false;
  }
};

/** R26.2 — choose the host that serves the OAuth callback for a PWA running at
 *  `pwaOrigin`: its OWN origin when it `selfServesOAuthCallback` (the server
 *  serves the relay page same-origin, no cloud hop), else
 *  `OAUTH_CLOUD_CALLBACK_ORIGIN`. So `pickOAuthCallbackHost(o) !== OAUTH_CLOUD_
 *  CALLBACK_ORIGIN` is exactly "self-served". `buildOpenerRelayRedirectUri` is
 *  the consumer; the opener's `expectedSenderOrigin` is derived from the
 *  resulting redirect host so it always matches the page that posts the code. */
export const pickOAuthCallbackHost = (pwaOrigin: string): string =>
  selfServesOAuthCallback(pwaOrigin) ? pwaOrigin : OAUTH_CLOUD_CALLBACK_ORIGIN;

/** The EXACT callback URL a user must register in their provider app, for a PWA
 *  served from `pwaOrigin`.
 *
 *  ⛔ Exists because the connections form USED TO PRINT `OAUTH_CLOUD_CALLBACK_URL`
 *  unconditionally, under the words "Register this unchanged in the provider
 *  app." On a loopback PWA that instruction was WRONG: `pickOAuthCallbackHost`
 *  sends the flow to the PWA's own origin (R26.2 Option B), so the registered
 *  URI and the one actually used disagreed — surfacing as the provider's
 *  `redirect_uri_mismatch`, the least self-explanatory error in OAuth.
 *
 *  🔑 It derives from `pickOAuthCallbackHost`, the SAME function the popup
 *  driver uses, so the printed value cannot drift from the value sent. A second
 *  hand-rolled copy of this rule is exactly how the two disagreed in the first
 *  place. */
export const oauthCallbackUrlForPwa = (pwaOrigin: string): string =>
  selfServesOAuthCallback(pwaOrigin)
    ? `${pickOAuthCallbackHost(pwaOrigin)}${WEBCLIENT_OAUTH_CALLBACK_PATH}`
    : OAUTH_CLOUD_CALLBACK_URL;

/** The callback URL a DIFFERENT usable origin would need, or `null` when there
 *  is no second one to name.
 *
 *  ⛔ Exists because the two are NOT guessable from each other. The cloud PWA
 *  serves the callback top-level at `/oauth-callback`; a self-served PWA serves
 *  it from the webclient bundle at `/webclient/oauth-callback.html` — different
 *  path AND different extension (verified against a live server: the two
 *  "obvious" guesses, `/oauth-callback` and `/webclient/oauth-callback`, both
 *  404). So an owner who registers one and later opens Recued from the other
 *  address gets `redirect_uri_mismatch` with nothing on screen explaining it.
 *
 *  Provider apps accept multiple redirect URIs, so the honest advice is
 *  "register both if you use both" — which the form can only give if it knows
 *  the other one. */
export const alternateOAuthCallbackUrl = (pwaOrigin: string): string | null =>
  selfServesOAuthCallback(pwaOrigin) ? OAUTH_CLOUD_CALLBACK_URL : null;

/** The callback a VENDOR connection (HubSpot, Salesforce, a BYO OAuth app)
 *  registers and sends from a PWA at `pwaOrigin` — not the mail/calendar one:
 *
 *    - loopback → the self-served relay page, as `oauthCallbackUrlForPwa`
 *      (R26.2 Option B for vendors; `completeVendorOAuth` finishes it);
 *    - the server's own https name → `<pwaOrigin>/oauth/complete`, the
 *      D-148 § A.12 DIRECT choice (`vendorOAuthRedirectChoices`): the provider
 *      sends the popup straight to the server, which checks the signed state
 *      and exchanges the code itself;
 *    - anything else → the app.recued.com callback, whose page checks the
 *      signed state and POSTs the code to `<server_url>/oauth/complete`.
 *
 *  ⛔ Not the self-served relay for an https name: a registered vendor's
 *  authorize URL, scopes, PKCE and sandbox live on the server, which only
 *  `startVendorOAuth` uses, and that rpc accepts exactly the two § A.12
 *  choices. And not app.recued.com's either: the page there checks the state
 *  with a key the dialog leaves in the popup's storage for app.recued.com's
 *  origin, which a dialog at another origin cannot write — so from anywhere
 *  but app.recued.com that choice can never finish. */
export const vendorOAuthCallbackUrlForPwa = (pwaOrigin: string): string => {
  if (isLoopbackOrigin(pwaOrigin)) return oauthCallbackUrlForPwa(pwaOrigin);
  if (selfServesOAuthCallback(pwaOrigin)) return `${pwaOrigin}/oauth/complete`;
  return OAUTH_CLOUD_CALLBACK_URL;
};

/** The vendor callback a DIFFERENT usable address would need: app.recued.com's,
 *  when this page is loopback or the server's own https name; else `null`. */
export const vendorOAuthAlternateCallbackUrl = (pwaOrigin: string): string | null =>
  selfServesOAuthCallback(pwaOrigin) ? OAUTH_CLOUD_CALLBACK_URL : null;

/** True when a parsed callback query selects opener-relay mode. */
export const isOpenerRelayCallback = (search: URLSearchParams): boolean =>
  search.get(OAUTH_OPENER_RELAY_PARAM) === OAUTH_OPENER_RELAY_VALUE;

/** Resolve the cross-origin relay target from a parsed callback query: the
 *  `opener_origin` param when present AND it is already a canonical http(s)
 *  origin, else `null` (the callback then relays same-origin). Three gates:
 *  parseable as a URL, `http:`/`https:` scheme, and `new URL(raw).origin === raw`
 *  — the last rejects host-confusion / non-bare-origin forms (`https://a@evil`,
 *  `https:evil`, a path, userinfo) that WHATWG would otherwise canonicalize to
 *  a surprising origin. Anything else → `null`, so the callback falls back to
 *  its own origin (fail-safe, never an arbitrary postMessage target). A
 *  legitimately-built `opener_origin` is always `window.location.origin`, which
 *  is canonical, so this never rejects a real value. Mirrored inline in the
 *  callback page's static JS. */
export const readOpenerRelayTarget = (search: URLSearchParams): string | null => {
  const raw = search.get(OAUTH_OPENER_ORIGIN_PARAM);
  if (raw === null || raw.length === 0) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.origin !== raw) return null; // canonical origin strings only
    return u.origin;
  } catch {
    return null;
  }
};

/** Build the foundational-lane redirect_uri for a PWA running at `openerOrigin`.
 *  Routes through `pickOAuthCallbackHost`, giving three shapes:
 *
 *   - a PWA that `selfServesOAuthCallback` — loopback (R26.2 Option B) or the
 *     server's own https name → same-origin self-serve:
 *       `<openerOrigin>/webclient/oauth-callback.html?recued_relay=opener`
 *     The server serves the relay page from its own webclient bundle; no cloud
 *     hop, no `opener_origin` (it's same-origin).
 *   - cloud `app.recued.com` PWA → byte-identical to the pre-R26.2 value:
 *       `https://app.recued.com/oauth-callback?recued_relay=opener`
 *     …except for Microsoft (`noQueryMarker`), which gets the BARE
 *       `https://app.recued.com/oauth-callback` (see below).
 *   - any other PWA (an https IP literal, a single-label name, staging;
 *     R26.2 Option A) → cloud bounce with the PWA origin riding as
 *     `opener_origin` for cross-origin relay:
 *       `https://app.recued.com/oauth-callback?recued_relay=opener&opener_origin=…`
 *
 *  The SAME returned value MUST be used to build the authorize URL AND passed
 *  to `enrollOAuth`, and registered verbatim in the operator's OAuth app —
 *  providers require an exact byte-match across authorize → exchange → the
 *  registered URI. */
export const buildOpenerRelayRedirectUri = (
  openerOrigin: string,
  noQueryMarker = false,
): string => {
  const host = pickOAuthCallbackHost(openerOrigin);
  // Self-serve: pickOAuthCallbackHost returns the PWA origin itself (it only
  // ever returns either the cloud origin or a self-served origin, so "not the
  // cloud origin" ⇒ self-serve). The server serves the relay page from its
  // bundle at WEBCLIENT_OAUTH_CALLBACK_PATH, same-origin.
  if (host !== OAUTH_CLOUD_CALLBACK_ORIGIN) {
    // `noQueryMarker` — Microsoft Entra REJECTS query strings in registered
    // redirect URIs ("URL may not contain a query string"), so the Microsoft
    // flow omits the `recued_relay=opener` marker. It's safe to omit on the
    // self-served page: it (`oauth-callback-relay.ts`) discriminates via the
    // `frelay_` state prefix (the opener still verifies the FULL state for
    // CSRF), so the query marker is redundant there.
    if (noQueryMarker) return host + WEBCLIENT_OAUTH_CALLBACK_PATH;
    return (
      host +
      WEBCLIENT_OAUTH_CALLBACK_PATH +
      '?' +
      OAUTH_OPENER_RELAY_PARAM +
      '=' +
      OAUTH_OPENER_RELAY_VALUE
    );
  }
  // ⛔ Microsoft from the cloud PWA itself: an Entra app that takes personal
  // accounts may not register a redirect URI with a query string, and the
  // marker made app.recued.com unusable for one. The callback page selects the
  // foundational relay by the `frelay_` state prefix alone and, with no marker,
  // posts the code only to its OWN origin — which is exactly this opener. A
  // PWA that bounces (an https IP literal, a single-label name) still needs
  // `opener_origin` in the query (below), so an app that takes personal
  // accounts cannot be reached from one; the guide says so and names the
  // addresses that work.
  if (noQueryMarker && openerOrigin === OAUTH_CLOUD_CALLBACK_ORIGIN) {
    return OAUTH_CLOUD_CALLBACK_URL;
  }
  // Cloud bounce (default). A non-cloud opener that cannot self-serve rides as
  // opener_origin for cross-origin relay; the same-origin cloud PWA omits it.
  let uri =
    OAUTH_CLOUD_CALLBACK_ORIGIN +
    '/oauth-callback?' +
    OAUTH_OPENER_RELAY_PARAM +
    '=' +
    OAUTH_OPENER_RELAY_VALUE;
  if (openerOrigin !== OAUTH_CLOUD_CALLBACK_ORIGIN) {
    uri += '&' + OAUTH_OPENER_ORIGIN_PARAM + '=' + encodeURIComponent(openerOrigin);
  }
  return uri;
};

/** `message.data.kind` tag on the opener-relay postMessage, so the opener's
 *  `message` listener can ignore unrelated same-origin messages. */
export const OPENER_RELAY_MESSAGE_KIND = 'recued:oauth-code' as const;

/** Payload the opener-relay callback page posts to `window.opener`. Exactly
 *  one of `code` / `error` is set; `state` always round-trips for the
 *  opener's CSRF check. */
export interface OpenerRelayMessage {
  kind: typeof OPENER_RELAY_MESSAGE_KIND;
  state: string;
  code?: string;
  error?: string;
}

// ── BYO OAuth app credentials (UI-entered, per-issuer) ──────────────
//
// The foundational mail/calendar OAuth flow needs a `client_id` +
// `client_secret` from the user's OWN Google / Microsoft OAuth app (no
// Recued-operated broker — D-062). Historically these were ENV-only
// (`RECUED_{GMAIL,GCAL,GRAPH}_CLIENT_ID/SECRET`), which means SSHing into the
// box — wrong for the "normal people / one-click VPS + webclient" onboarding.
// Those six env vars were DELETED (2026-07-28): they widened the secret's
// exposure surface (plaintext in the process env — readable via `ps eww`,
// `/proc/<pid>/environ`, shell history, `docker inspect`) and they bypassed
// the vault lock, where the store path refuses with `locked` (423). No
// distribution artifact ever set them. These types now back the ONLY
// credential path — a UI surface where the owner enters the credentials,
// stored encrypted server-side (AES-256-GCM, per-row AAD).

/** The two OAuth app issuers a server can hold BYO credentials for. ONE Google
 *  Cloud OAuth app (`google`) covers BOTH Gmail and Google Calendar (same
 *  project, same client); ONE Microsoft Entra app (`microsoft`) covers Outlook
 *  mail AND calendar (Graph). Per-issuer is the natural unit — one app to
 *  create, not one per mailbox-vs-calendar. */
export type OAuthAppIssuer = 'google' | 'microsoft';

/** ⚠ NO `: readonly OAuthAppIssuer[]` annotation — it would WIDEN the
 *  `as const` and make the proof below vacuous. See PATH_ROLES in `network.ts`. */
export const OAUTH_APP_ISSUERS = ['google', 'microsoft'] as const satisfies readonly OAuthAppIssuer[];

/** Compile-time proof that no `OAuthAppIssuer` is missing above — what keeps
 *  `totalRecord(OAUTH_APP_ISSUERS, …)` sound rather than an assertion. */
type OAuthAppIssuersAreExhaustive =
  Exclude<OAuthAppIssuer, (typeof OAUTH_APP_ISSUERS)[number]> extends never ? true : never;
const _oauthAppIssuersAreExhaustive: OAuthAppIssuersAreExhaustive = true;
void _oauthAppIssuersAreExhaustive;

/** Map a foundational provider/adapter slug to its issuer. gmail + gcal are one
 *  Google app; graph (mail or calendar) is one Microsoft app. */
export const oauthAppIssuerForProvider = (
  provider: 'gmail' | 'gcal' | 'graph',
): OAuthAppIssuer => (provider === 'graph' ? 'microsoft' : 'google');

/** Per-issuer status for the setup UI (`server.getOAuthAppConfig`). NEVER
 *  carries the `client_secret` — it is write-only; `has_secret` only reports
 *  whether one is available. `source` says where the EFFECTIVE config comes
 *  from: `stored` (entered in the UI) or `null` (unconfigured). A third member
 *  `'env'` was REMOVED with the six `RECUED_*` OAuth vars (2026-07-28) — the
 *  encrypted store is now the only producer, so `client_id !== null` implies
 *  `source === 'stored'`. `client_id` is the effective id, for display +
 *  pre-fill. */
export interface OAuthAppConfigStatus {
  client_id: string | null;
  has_secret: boolean;
  source: 'stored' | null;
}

/** Full snapshot — one status per issuer. */
export type OAuthAppConfigSnapshot = Record<OAuthAppIssuer, OAuthAppConfigStatus>;

/** Args for `server.setOAuthAppConfig` — store (or overwrite) an issuer's BYO
 *  credentials. Both are required on every set; to change just one, re-enter
 *  both (the secret is write-only, so it can't be partially preserved). */
export interface SetOAuthAppConfigArgs {
  issuer: OAuthAppIssuer;
  client_id: string;
  client_secret: string;
}

/** Args for `server.clearOAuthAppConfig` — remove an issuer's stored config.
 *  The issuer is then UNCONFIGURED (`source: null`); there is no fallback tier
 *  behind the store, so enroll surfaces `not_configured` until new credentials
 *  are entered. */
export interface ClearOAuthAppConfigArgs {
  issuer: OAuthAppIssuer;
}
