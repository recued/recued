/** D-125 Phase 1.1 — Connection substrate contract types.
 *
 *  `connection.*` is the unified outbound endpoint namespace —
 *  one synced top-level concept covering three previously-separate
 *  ones:
 *    - HTTP API credentials (today: per-vendor `vault.<publisher>.
 *      <token>` interpolated into every manifest).
 *    - MCP-client connections (today: not exposed at the recipe
 *      layer at all; MCP is host-only).
 *    - Notification destinations (today: `notification-send`'s
 *      opaque `channels: string[]` and `account.slack.token`).
 *
 *  All three collapse onto one shape: a *named instance of a
 *  credentialed protocol*. The kernel `connection` ingredient
 *  (D-125 P3, plugged into D-126's `AdapterRegistry` at
 *  `kind: 'connection'`) is the only code path that constructs
 *  outbound calls and injects credentials. Recipes ref enrolled
 *  records read-only as `{{connection.<kind>.<name>.<field>}}`.
 *
 *  P1.1 ships only the contract types + constants — no runtime,
 *  no SQL, no rpc. Phase 1.2 lays down sync registry + storage.
 *  Phase 3.1 swaps the kernel adapter into D-126's reserved slot. */

import {
  MESSENGER_AUTH_KIND_CONNECTION_TYPES,
  MESSENGER_VENDOR_SLUGS,
} from './messenger-vendors.js';

/** Three kinds. Subtypes fold under each (`mcp.sse|websocket|stdio`,
 *  `notification.<chat vendor>|email|in-app`). One handler per
 *  kind, dispatched by `subtype` where present. */
export type ConnectionKind = 'mcp' | 'api' | 'notification';
const CONNECTION_KINDS: ReadonlySet<string> = new Set(['mcp', 'api', 'notification']);
const isConnectionKind = (value: unknown): value is ConnectionKind =>
  typeof value === 'string' && CONNECTION_KINDS.has(value);

/** D-192 source-data-removal — per-facet counts from the opt-in
 *  connection-teardown purge (`remove_mirror_data`). Summed across every
 *  registry Source the connection owns (file `file_meta_ref` mirror +
 *  work-entity `data_<kind>` records + their live-derived
 *  annotations/links/enrichments + work-graph edges). `sources_skipped` counts
 *  Sources this per-source mechanism does not hard-delete (`contact` →
 *  retract-contribution policy, a later slice). Surfaced on the delete rpc
 *  response for the "removed [N] records" confirmation + recorded in the
 *  `source_data_purged` audit row. */
export interface ConnectionDataPurgeSummary {
  sources_purged: number;
  sources_skipped: number;
  records_deleted: number;
  annotations_deleted: number;
  links_deleted: number;
  enrichments_deleted: number;
  edges_deleted: number;
  /** D-192 slice 3b — the connection's D-190 CRM platform-reference mirror
   *  rows (deal / contact / account) removed. Keyed by the vendor-entity scope
   *  but cut to THIS connection via the `target_id` prefix (a sibling
   *  same-vendor connection is untouched). Zero for non-CRM connections. */
  crm_records_deleted: number;
  /** D-192 slice 3b — the platform-reference enrichment rows ABOUT this
   *  connection's CRM records, hard-deleted (same per-connection prefix cut). */
  crm_enrichments_deleted: number;
  /** D-192 slice 4 — messenger contact retract-contribution. The
   *  `contact_platform_link` rows (D-138 sender→email associations) THIS
   *  messenger connection (slack / telegram) contributed, hard-deleted
   *  connection-precisely (by the `(vendor, connection_name)` key). Zero for
   *  non-messenger connections. NOTE there is no companion `contacts_deleted`:
   *  a messenger link never OWNS a `contacts` row (every contact carries a
   *  permanent first-party `source` — mail / calendar / manual), so the spec's
   *  "delete a contact only if it becomes source-less" can never fire here —
   *  the retract only removes the association, never the shared contact. */
  contact_links_retracted: number;
}

/** Notification subtypes — the destinations sharing one wire shape (text +
 *  recipient). Two disjoint groups (D-192 seam 10): every declared CHAT
 *  TRANSPORT (`MESSENGER_VENDOR_SLUGS` — one edit adds a vendor everywhere), plus
 *  the two that are NOT chat transports and so are named literally — `email` (a
 *  façade over a warehouse mail instance) and `in-app` (routes through the D-121
 *  P6 broadcast bus, carries no external creds).
 *
 *  ⚠ `in-app` here is HYPHENATED; the `notification.send` delivery vocabulary
 *  spells the same destination `in_app` (see `NotificationDeliveryChannel`).
 *  They are different wire spellings on different surfaces — deliberately NOT
 *  unified, since changing either is a breaking wire change. */
export const NOTIFICATION_SUBTYPES = [
  ...MESSENGER_VENDOR_SLUGS,
  'email',
  'in-app',
] as const;
export type NotificationSubtype = (typeof NOTIFICATION_SUBTYPES)[number];

/** MCP transports — three flavors of the same JSON-RPC tool surface. */
export type McpTransport = 'sse' | 'websocket' | 'stdio';

/** One custom request header injected from a connection's auth. `value` is a
 *  credential (encrypted at rest with the rest of `ConnectionAuth`); `header_name`
 *  is the wire header key. */
export interface HeaderAuthEntry {
  header_name: string;
  value: string;
}

/** Per-record authentication shape. Adapter-internal — never appears
 *  in recipe JSON or ingredient manifest input. The recipe / ingredient
 *  layer interacts with connections via the picker (`{{config.<X>}}`)
 *  and never touches credentials. The adapter (D-125 P3) is the only
 *  code path that decrypts and applies these. */
export type ConnectionAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  /** N custom headers applied to every call. One entry covers the common
   *  single-API-key case (`X-API-Key: …`); two+ covers vendors that split
   *  credentials across headers (e.g. Plaid's `PLAID-CLIENT-ID` +
   *  `PLAID-SECRET`). Always non-empty. */
  | { type: 'header'; headers: ReadonlyArray<HeaderAuthEntry> }
  | { type: 'query';  param_name: string;  value: string }
  | { type: 'oauth2_refresh';
      refresh_token: string;
      client_id: string;
      client_secret?: string;
      token_endpoint: string;
      /** OAuth client-auth method used when refreshing. Defaults to
       *  `body` for existing HubSpot/Salesforce/Google/QuickBooks rows;
       *  vendors such as Pipedrive require HTTP Basic client auth. */
      token_auth_style?: 'body' | 'basic';
      current_access_token?: string;
      expires_at?: number;
    }
  /** OAuth 2.0 client-credentials grant. The client secret stays encrypted in
   *  the connection row; adapters exchange it for a short-lived bearer token
   *  inside the trusted connection boundary before each call as needed. */
  | { type: 'oauth2_client_credentials';
      client_id: string;
      client_secret: string;
      token_endpoint: string;
      /** Defaults to `body`; `basic` uses HTTP Basic client authentication. */
      token_auth_style?: 'body' | 'basic';
      /** Optional OAuth scope string sent on the token request. */
      scope?: string;
      current_access_token?: string;
      expires_at?: number;
    };

/** Resolve the `Authorization: Bearer <token>` value from a
 *  `ConnectionAuth`, across the auth types that authenticate via a bearer
 *  token. THE single seam a vendor client uses to obtain its access token —
 *  auth-type knowledge lives HERE (the connection layer), never in each
 *  reconciler:
 *    - `bearer` — a static, long-lived token. This is how a HubSpot
 *      **Service Key** (HubSpot's recommended credential for data-only
 *      integrations, sent as `Authorization: Bearer`) enrolls, and any
 *      other static API bearer token;
 *    - `oauth2_refresh` / `oauth2_client_credentials` — the current renewable
 *      access token; the shared freshness gate restamps this field.
 *  Returns `undefined` for any other auth type or an empty/absent token —
 *  the caller decides whether that's its own error (a client that ONLY
 *  authenticates by bearer, e.g. the HubSpot reconcilers) or a fallthrough.
 *  Pure; no I/O. */
export const resolveBearerAccessToken = (auth: ConnectionAuth): string | undefined => {
  const token =
    auth.type === 'bearer'
      ? auth.token
      : auth.type === 'oauth2_refresh' || auth.type === 'oauth2_client_credentials'
        ? auth.current_access_token
        : undefined;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
};

/** Every `ConnectionAuth` shape ANY declared chat transport can send with — the
 *  union of the per-kind lists. DERIVED, so widening one kind's entry is the only
 *  edit a future vendor needs; the enroll gate and the send path read the same
 *  source and cannot fall out of step. */
const MESSENGER_SENDABLE_AUTH_TYPES: ReadonlySet<ConnectionAuth['type']> = new Set(
  Object.values(MESSENGER_AUTH_KIND_CONNECTION_TYPES).flat(),
);

/** THE messenger send-credential seam — the one place the send path learns what a
 *  chat-transport credential looks like. Sibling of `resolveBearerAccessToken`
 *  above, and it exists for the same stated reason: auth-shape knowledge lives in
 *  the connection layer, never hand-rolled at each call site.
 *
 *  It was hand-rolled — `auth.type !== 'bearer'` — at two GENERIC sites (the
 *  `RemoteChannel` credential resolver behind notify / ask / close-ask / turn /
 *  live-control, and the contact-linker's profile-email writer), both of which
 *  silently returned null on any other shape. That is how `oauth` came to be a
 *  declared, probe-supported auth kind that could never actually deliver a
 *  message, with nothing anywhere failing to say so.
 *
 *  Narrowing is delegated, not duplicated: membership is checked against the
 *  derived set, then `resolveBearerAccessToken` extracts the token — so the day
 *  `oauth2_refresh` joins `MESSENGER_AUTH_KIND_CONNECTION_TYPES`, this function
 *  starts reading `current_access_token` with no edit here at all.
 *
 *  Returns undefined when the row's auth shape is not one a chat transport can
 *  send with. The enroll gate (`collection.connection.enroll` / `.update`) now
 *  refuses to persist such a row, so this is defence-in-depth on a path that
 *  cannot fail loudly — a best-effort notification fan-out — rather than a live
 *  branch. */
export const resolveMessengerSendToken = (auth: ConnectionAuth): string | undefined =>
  MESSENGER_SENDABLE_AUTH_TYPES.has(auth.type) ? resolveBearerAccessToken(auth) : undefined;

/** Object keys a `header_name` must never be — guards the plain-object apply sites
 *  (`headers[name] = value` in the mcp adapter + the handler probe) against
 *  prototype pollution. Centralized here so every site that injects header auth
 *  applies the identical guard. */
const HEADER_NAME_RESERVED_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Upper bound on `header` auth entries — a sanity cap, not a real limit (legitimate
 *  vendors use one or two custom headers; Plaid's split-credential pair is the high
 *  end). Bounds a malformed / hostile payload rather than processing an unbounded
 *  array. */
export const MAX_HEADER_AUTH_ENTRIES = 32;

/** Why a `header` ConnectionAuth's `headers` array failed validation. `index` is the
 *  offending entry (absent for whole-array issues). Callers map this to their own
 *  error type — `RpcError` at enrollment, `IngredientError` at apply. */
export type HeaderAuthIssue =
  | { code: 'not_array' }
  | { code: 'empty' }
  | { code: 'too_many' }
  | { code: 'name_missing'; index: number }
  | { code: 'name_reserved'; index: number }
  | { code: 'value_missing'; index: number };

/** Validate a `header` ConnectionAuth's `headers` value: a non-empty array whose
 *  every entry is a proto-safe non-empty `header_name` + non-empty `value`. PURE —
 *  the single source of truth for header-auth shape (enrollment validation + every
 *  apply site call it, so the prototype-pollution guard is identical everywhere).
 *  Returns the typed entries on success, or a typed issue the caller renders. */
export const validateHeaderAuthEntries = (
  headers: unknown,
):
  | { ok: true; entries: ReadonlyArray<HeaderAuthEntry> }
  | { ok: false; issue: HeaderAuthIssue } => {
  if (!Array.isArray(headers)) return { ok: false, issue: { code: 'not_array' } };
  if (headers.length === 0) return { ok: false, issue: { code: 'empty' } };
  if (headers.length > MAX_HEADER_AUTH_ENTRIES) return { ok: false, issue: { code: 'too_many' } };
  const entries: HeaderAuthEntry[] = [];
  for (let index = 0; index < headers.length; index += 1) {
    const entry = headers[index] as unknown;
    const isObj = typeof entry === 'object' && entry !== null && !Array.isArray(entry);
    // OWN properties only — an inherited / prototype-backed `header_name` or `value`
    // (e.g. `Object.create({ header_name: '…' })`) must NOT satisfy validation. JSON
    // parsing only yields own enumerable props, so this never rejects a wire payload;
    // it fails closed against a crafted in-process object.
    const own = (key: string): unknown =>
      isObj && Object.prototype.hasOwnProperty.call(entry, key)
        ? (entry as Record<string, unknown>)[key]
        : undefined;
    const name = own('header_name');
    const value = own('value');
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, issue: { code: 'name_missing', index } };
    }
    if (HEADER_NAME_RESERVED_KEYS.has(name)) {
      return { ok: false, issue: { code: 'name_reserved', index } };
    }
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, issue: { code: 'value_missing', index } };
    }
    entries.push({ header_name: name, value });
  }
  return { ok: true, entries };
};

/** Render a `HeaderAuthIssue` as a human-readable fragment for an error message
 *  (e.g. `auth.headers ${describeHeaderAuthIssue(issue)}`). */
export const describeHeaderAuthIssue = (issue: HeaderAuthIssue): string => {
  switch (issue.code) {
    case 'not_array':
      return 'must be an array of { header_name, value }';
    case 'empty':
      return 'must contain at least one header';
    case 'too_many':
      return `must contain at most ${MAX_HEADER_AUTH_ENTRIES} headers`;
    case 'name_missing':
      return `entry ${issue.index} header_name is required`;
    case 'name_reserved':
      return `entry ${issue.index} header_name cannot be a reserved object key`;
    case 'value_missing':
      return `entry ${issue.index} value is required`;
  }
};

/** One enrolled connection. Stored encrypted at rest (auth ciphertext
 *  via the connection sub-DEK, derived from the recovery-key-bound
 *  master KEK — same crypto pipeline `account.*` uses pre-RIP per
 *  D-100/101). Per-pair-broadcast — sync_transport: 'pair' on the
 *  D-166 `contract.connection_record` schema entry (D-168 retired the
 *  legacy SYNC_OBJECTS.connection route). */
export interface ConnectionRecord {
  /** User-chosen identifier entered at enrollment. Validates against
   *  the existing identifier regex applied at the form (same rule
   *  used for collection-instance names like `data.mail.<name>`). */
  name: string;
  kind: ConnectionKind;
  /** For kind=notification: 'slack' | 'telegram' | 'email' | 'in-app'.
   *  For kind=mcp:          'sse' | 'websocket' | 'stdio'.
   *  For kind=api:          undefined (HTTP is the only protocol). */
  subtype?: string;
  display_name: string;
  /** Optional publisher scope — when an ingredient supplies a default
   *  template at enrollment, the publisher_id stamps the record so
   *  multiple publishers can each have their own "default hubspot." */
  publisher_id?: string;
  /** Per-kind config (base_url for api, endpoint for mcp, channel_id
   *  for notification.slack, etc.). Per-handler validation in Phase 4. */
  config: Record<string, unknown>;
  auth: ConnectionAuth;
  enrolled_at: number;
  updated_at: number;
  last_used_at?: number;
  health?: ConnectionHealth;
  /** D-165 P3.path-picker — sub-resource permission boundary for
   *  vendors with internal hierarchies (S3 buckets, Notion databases,
   *  Jira projects, IMAP folders). Default `/` = whole vendor account.
   *  Set once at enrollment; re-scoping means enrolling a *new*
   *  connection at a more specific path (spec § Sub-resource gating),
   *  not mutating this one. Stored canonicalized
   *  (`canonicalizeSubresourcePath`); the gateway enforces operation
   *  `path_scope` against it (later slice). Non-secret — surfaced in
   *  `ConnectionView` so the Settings picker can render the bound
   *  scope, unlike the credential-bearing `auth`. */
  subresource_path?: string;
  /** OAuth scopes the vendor actually GRANTED, captured from the token
   *  response (`scope`) or introspection at enroll / re-authorize. This
   *  is the vendor-reported set — what the connection can actually DO —
   *  not what was requested (a user can deselect on the consent screen,
   *  a vendor can grant fewer). Non-secret (not a credential): surfaced
   *  in `ConnectionView` so pack-readiness can check whether an installed
   *  pack's `required_scopes` are covered (reuse) or missing (re-auth).
   *  Absent on non-oauth rows + rows enrolled before the field existed →
   *  coverage is "unknown" (a soft hint, never a gate). Preserved
   *  verbatim across every non-enroll row restamp (token refresh, probe,
   *  config patch) — a refresh that dropped it would silently flip a
   *  covered connection to "needs re-auth" on the next 401. */
  granted_scopes?: string[];
}

/** Health snapshot from the most recent probe. Re-probable via
 *  `collection.connection.probe` (P2.1). Failures don't block
 *  enrollment — `unknown` is the default. */
export interface ConnectionHealth {
  status: 'ok' | 'auth_failed' | 'unreachable' | 'unknown';
  last_probed_at?: number;
  last_error?: string;
  /** D-125 P4.2 — MCP tool list cached at probe time. The mcp handler
   *  validates `input.tool` against this list and surfaces
   *  `MCP_TOOL_NOT_FOUND` early when a recipe references a tool the
   *  server has since removed. Absent (probe not run yet, or non-mcp
   *  kind) → handler skips pre-validation and lets the server respond
   *  with its own JSON-RPC error envelope. Probe (`collection.
   *  connection.probe` for kind=mcp) refreshes this on each call. */
  tools?: string[];
}

/** Read-only view of a connection projected for the resolver. The
 *  runtime constructs this from a `ConnectionRecord` row by spreading
 *  `config` fields at the view top-level so refs read naturally:
 *  `{{connection.api.hubspot.base_url}}` not
 *  `{{connection.api.hubspot.config.base_url}}`. Auth fields are
 *  excluded from the view projection — only the adapter reaches them
 *  at call time. */
export interface ConnectionView {
  name: string;
  kind: ConnectionKind;
  subtype?: string;
  display_name: string;
  /** D-165 P3.path-picker — the connection's sub-resource scope
   *  (default `/`). Non-secret permission-boundary metadata, surfaced
   *  so Settings → Connections can render + pre-fill the path picker.
   *  Absent on rows enrolled before the field existed (treat as `/`
   *  via `canonicalizeSubresourcePath`). */
  subresource_path?: string;
  /** OAuth scopes the vendor granted (see `ConnectionRecord.granted_scopes`).
   *  Non-secret — surfaced so Settings → Connections + pack-readiness can
   *  render coverage. Absent → unknown coverage (non-oauth / legacy row). */
  granted_scopes?: string[];
  /** D-194 #6 — the installed pack slugs that hold a pack-owned grant on THIS
   *  connection (the connection-precise "Used by packs" set). Populated ONLY by
   *  `handleConnectionList` from the grant store (api rows), NOT by
   *  `connectionViewFromRow` — so the runtime resolver view (`ConnectionStore`)
   *  never carries it. Absent → grant data unavailable (dbless / non-api) → the
   *  UI falls back to vendor-match. */
  bound_pack_slugs?: string[];
  /** D-192 S5 — true when this connection's vendor declares engagement
   *  entities in the LIVE merged vendor registry (built-ins + installed
   *  packs), so a pack-declared engagement CRM (e.g. Dynamics) surfaces the
   *  engagement-health affordance with no code edit. Stamped ONLY by
   *  `handleConnectionList` from `resolveVendorRegistry` (api rows), NOT by
   *  `connectionViewFromRow` — the runtime resolver view never carries it.
   *  Absent → the server didn't compute it (dbless / legacy) → the UI falls
   *  back to a built-in-registry `vendorHasEngagement` read (same
   *  graceful-degrade as `bound_pack_slugs`). */
  supports_engagement_health?: boolean;
  // Flattened config fields are spread at the view top-level. Indexer
  // is `unknown` because per-kind config shapes vary (api: `base_url`,
  // mcp: `endpoint` + `transport`, notification: subtype-specific).
  [k: string]: unknown;
}

/** Per-kind store as exposed to the resolver. The runtime hydrates
 *  from the connection-row table at recipe-execution start, exactly
 *  like `data.*` views. Auth ciphertext is NEVER exposed via the
 *  store — only the adapter decrypts at call time. */
export interface ConnectionStore {
  mcp?:          Record<string, ConnectionView>;
  api?:          Record<string, ConnectionView>;
  notification?: Record<string, ConnectionView>;
}

// ────────────────────────────────────────────────────────────────
// Storage row + projection helpers (D-125 P1.2)
// ────────────────────────────────────────────────────────────────

/** Storage-layer row shape — mirrored across SQLite (server) and IDB
 *  (extension). Distinguished from `ConnectionRecord` by holding
 *  `config_json` + `auth_ciphertext` (encoded forms) instead of the
 *  parsed `config: Record<string, unknown>` + `auth: ConnectionAuth`.
 *  The IDB-side `pk` field is the composite primary key
 *  `${kind}:${name}` — used as the IDB out-of-line key. The SQLite
 *  table uses a real `PRIMARY KEY (kind, name)` so it doesn't carry
 *  the synthetic `pk`; consumers project with `connectionRowKey`. */
export interface ConnectionRow {
  /** Composite key `${kind}:${name}` — matches IDB out-of-line key
   *  and identifies the row uniquely on either backend. */
  pk: string;
  kind: ConnectionKind;
  name: string;
  subtype?: string;
  display_name: string;
  publisher_id?: string;
  /** Plaintext JSON — config holds non-secret per-kind metadata
   *  (base_url for api, endpoint+transport for mcp, channel_id for
   *  notification.slack, etc.). */
  config_json: string;
  /** AEAD ciphertext, base64-encoded. Decrypted only by the
   *  D-125 P3 adapter at call time. Never projected into the
   *  resolver's `ConnectionView`. */
  auth_ciphertext: string;
  enrolled_at: number;
  updated_at: number;
  last_used_at?: number;
  /** Plaintext JSON of `ConnectionHealth`. Optional — defaults to
   *  `unknown` when absent. */
  health_json?: string;
  /** D-165 P3.path-picker — canonicalized sub-resource scope (default
   *  `/`). Plain TEXT column (not JSON, not a secret). Absent on rows
   *  predating the column. */
  subresource_path?: string;
  /** JSON-array TEXT column holding `ConnectionRecord.granted_scopes`
   *  (the vendor-granted OAuth scopes). Plaintext (non-secret), like
   *  `config_json`. Absent on non-oauth rows + rows predating the column;
   *  a malformed value projects to an absent `granted_scopes` on the view
   *  (the row stays visible). */
  granted_scopes_json?: string;
}

/** Compose the composite primary key used by both backends. */
export const connectionRowKey = (kind: ConnectionKind, name: string): string =>
  `${kind}:${name}`;

/** D-165 P3.path-picker — upper bound on a `subresource_path` at the
 *  enrollment validator. A permission-boundary string is never long in
 *  practice (`/databases/<id>`, `/projects/ACME`, `/INBOX`); the cap
 *  just keeps a pathological input out of storage. */
export const SUBRESOURCE_PATH_MAX_LEN = 1024;

/** D-165 P3.path-picker — canonicalize a sub-resource path to the form
 *  stored on `ConnectionRecord.subresource_path` and compared by the
 *  gateway's `path_scope` enforcement (spec § Sub-resource gating,
 *  `:920`): collapse repeated slashes, strip the trailing slash (except
 *  root), and root-anchor with a leading slash. Empty / undefined / null
 *  → `/` (whole-account default). Case-preserving — per-operation
 *  case-insensitivity is a gateway-time `canonicalization` flag, not a
 *  storage concern. Idempotent: `f(f(x)) === f(x)`. */
export const canonicalizeSubresourcePath = (raw?: string | null): string => {
  if (raw === undefined || raw === null) return '/';
  let p = String(raw).trim();
  if (p === '') return '/';
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');               // collapse `//+` → `/`
  if (p.length > 1) p = p.replace(/\/+$/, ''); // strip trailing slash, keep root
  return p === '' ? '/' : p;
};

/** D-128 P3 — config keys that are inbound-verification secrets, not
 *  outbound credentials. Stored plaintext alongside non-secret config
 *  but stripped from `ConnectionView` so recipes can't read them via
 *  `{{connection.<kind>.<name>.<field>}}`. The webhook funnel
 *  (`backend/server/src/housekeeping/reconciliation/webhook-funnel.ts`)
 *  + D-148 P9 webhook port providers
 *  (`backend/server/src/connections/providers/`) read them directly out
 *  of the parsed `config_json` at call time, the same way the
 *  api/mcp/notification adapters reach `auth` only inside the kernel
 *  adapter.
 *
 *  Closed list:
 *    - `webhook_secret` — D-128 vendor reconciliation HMAC secret,
 *      D-148 Telegram setWebhook secret token, and D-196 Stripe endpoint
 *      signing secret (the field name is the substrate-level identifier;
 *      vendor docs may call it "secret token" or `whsec`, but the storage key
 *      is the same).
 *    - `signing_secret` — D-148 P9 Slack Events API signing secret
 *      (Slack's vendor terminology; reused as the storage key for
 *      Slack-only deliveries so it stays distinct from Telegram's
 *      `webhook_secret` even when both vendors enroll the same
 *      `notification` connection name across kinds).
 *
 *  Adding a new field here is a one-line change — the projection check
 *  follows. */
export const CONNECTION_INBOUND_SECRET_FIELDS: ReadonlyArray<string> = [
  'webhook_secret',
  'signing_secret',
  // D-192 WhatsApp — the Meta App Secret the `X-Hub-Signature-256` HMAC is keyed
  // by. Meta's own terminology, kept distinct rather than folded onto
  // `signing_secret`: they are different credentials from different consoles, and
  // one shared key would let a Slack row lend its secret to a WhatsApp one.
  'app_secret',
  // D-192 WhatsApp — the GET-handshake token. Not a signing key, but a
  // credential-shaped shared value (the owner types the same string into Meta's
  // console), and the only thing standing between a stranger and a verified
  // subscription on this endpoint. Stripped from the resolver view for the same
  // reason as the rest.
  'verify_token',
  // D-192 Discord — the application's Ed25519 verification key. ⚠ This one is
  // genuinely PUBLIC (asymmetric verification needs no secret), so stripping it
  // buys no secrecy. It is here anyway, deliberately: this list is what
  // `CONNECTION_UPDATE_PRESERVED_CONFIG_FIELDS` splices, so a field NOT in it would
  // be dropped by any config patch that omitted it — and a dropped verification key
  // means every inbound press is silently refused. Uniformity is the point; the
  // secrecy is incidental.
  'public_key',
];

/** Config keys that would collide with row identity, auth, or
 *  storage-only metadata if spread onto the resolver view. */
export const CONNECTION_VIEW_RESERVED_FIELDS: ReadonlyArray<string> = [
  'pk',
  'kind',
  'name',
  'subtype',
  'display_name',
  'publisher_id',
  'config_json',
  'auth',
  'auth_ciphertext',
  'enrolled_at',
  'updated_at',
  'last_used_at',
  'health_json',
  // D-165 P3.path-picker — reserved so a stray `config_json` key named
  // `subresource_path` can't shadow the real row-level value the view
  // sets explicitly below (same guard the other identity fields carry).
  'subresource_path',
  // granted-scopes — `granted_scopes` is set explicitly on the view (from
  // the `granted_scopes_json` row column); both are reserved so a config
  // key of either name can't shadow the authoritative row-level value.
  'granted_scopes',
  'granted_scopes_json',
  // D-192 M4 — a messenger connection's declared `match_patterns` are
  // server-side funnel config (the message→commitment matcher reads them),
  // never recipe-referenceable data — keep them off the resolver view.
  'match_patterns',
  // D-194 #6 — `bound_pack_slugs` is stamped explicitly onto the LIST view by
  // `handleConnectionList` from the grant store; reserved so a stray `config_json`
  // key of that name can neither shadow the authoritative stamp nor leak a
  // (possibly non-array) UI-only field into the recipe-resolver view via
  // `connectionViewFromRow` / `connectionStoreFromRows` (same guard as
  // `granted_scopes` / `subresource_path`).
  'bound_pack_slugs',
  // D-192 S5 — `supports_engagement_health` is stamped explicitly onto the LIST
  // view by `handleConnectionList` from the live vendor registry; reserved so a
  // stray `config_json` key of that name can neither shadow the authoritative
  // stamp nor leak a (possibly non-boolean) UI-only field into the recipe-resolver
  // view via `connectionViewFromRow` (same guard as `bound_pack_slugs`).
  'supports_engagement_health',
  '__proto__',
  'constructor',
  'prototype',
];

/** granted-scopes — parse the `granted_scopes_json` TEXT column into the
 *  `string[]` carried on `ConnectionView` / `ConnectionRecord`. Tolerant:
 *  absent / malformed / non-string-array → `undefined` ("unknown coverage")
 *  rather than throwing, so a bad value never breaks a row's projection.
 *  Shared by `connectionViewFromRow` (resolver view) + the server-side
 *  `decodeConnectionRow` (row → record) so the two can't drift. */
export const parseGrantedScopesJson = (
  json: string | undefined | null,
): string[] | undefined => {
  if (json === undefined || json === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
      return parsed as string[];
    }
  } catch {
    // Malformed → unknown coverage.
  }
  return undefined;
};

/** Project a storage row to the read-only view exposed to the
 *  resolver. Auth ciphertext is **excluded by construction** — the
 *  view starts from static identity fields and then spreads only
 *  safe parsed `config_json` fields. Future projection bugs that
 *  "helpfully" copy the whole row are caught by the auth-exclusion
 *  test in `__tests__/d-125-phase-1-2-storage.test.ts` (literal
 *  field check + JSON-stringify ciphertext scan).
 *
 *  D-128 P3 — config fields listed in `CONNECTION_INBOUND_SECRET_FIELDS`
 *  (today: `webhook_secret`) are also stripped from the view so the
 *  resolver can't surface them. The webhook funnel reads them straight
 *  out of `config_json` server-side — recipes never need them.
 *
 *  Throws nothing — a malformed `config_json` falls back to an
 *  empty config (the row is still surfaced to the resolver, just
 *  without spread fields). The adapter will fail at call time with
 *  a meaningful error if config is missing required keys. */
export const connectionViewFromRow = (row: ConnectionRow): ConnectionView => {
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.config_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    // Treat malformed config as empty — the row stays visible so
    // the user can see the enrollment in Settings → Connections,
    // but adapter calls will fail until they re-enroll.
  }
  const filteredConfig: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(config)) {
    if (CONNECTION_INBOUND_SECRET_FIELDS.includes(k)) continue;
    if (CONNECTION_VIEW_RESERVED_FIELDS.includes(k)) continue;
    filteredConfig[k] = v;
  }
  const view: ConnectionView = {
    name: row.name,
    kind: row.kind,
    display_name: row.display_name,
    ...filteredConfig,
  };
  if (row.subtype !== undefined) view.subtype = row.subtype;
  // D-165 P3.path-picker — surface the non-secret sub-resource scope so
  // Settings can render/pre-fill the picker. Set after the config spread
  // (RESERVED_FIELDS already stripped any colliding config key) so the
  // row-level value is authoritative.
  if (row.subresource_path !== undefined) view.subresource_path = row.subresource_path;
  // granted-scopes — surface the vendor-granted OAuth scopes (non-secret) so
  // the readiness check can compare against a pack's `required_scopes`. Absent
  // / malformed → leave it off the view ("unknown coverage", a soft hint).
  const grantedScopes = parseGrantedScopesJson(row.granted_scopes_json);
  if (grantedScopes !== undefined) view.granted_scopes = grantedScopes;
  return view;
};

/** D-128 P3 — read an inbound-secret field directly from a parsed
 *  config object. The webhook funnel calls this server-side; the
 *  resolver never does. Returns null when the field is missing or
 *  empty so callers can fail closed cleanly. */
export const readConnectionInboundSecret = (
  config: Record<string, unknown>,
  field: string,
): string | null => {
  if (!CONNECTION_INBOUND_SECRET_FIELDS.includes(field)) return null;
  const value = config[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/** Hydrate a `ConnectionStore` from a flat row list. The runtime
 *  calls this once per recipe-execution start with the rows for
 *  the active pair; the resolver then walks `{{connection.<kind>.
 *  <name>.<field>}}` against the result. Per spec § 1.6 — auth is
 *  never in the projection. */
export const connectionStoreFromRows = (
  rows: readonly ConnectionRow[],
): ConnectionStore => {
  const store: ConnectionStore = {};
  for (const row of rows) {
    if (!isConnectionKind(row.kind)) continue;
    const view = connectionViewFromRow(row);
    const slot = (store[row.kind] ??= Object.create(null) as Record<string, ConnectionView>);
    slot[row.name] = view;
  }
  return store;
};

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Per-call default timeout for the api handler (P4.1). MCP handlers
 *  use per-transport defaults (sse: 60s; websocket: 60s; stdio: 30s).
 *  Notification handlers use subtype defaults. */
export const CONNECTION_API_TIMEOUT_MS = 30_000;

/** Window before `expires_at` at which oauth2_refresh handlers
 *  pre-emptively refresh. 60s avoids races with recipe-mid-flight
 *  expiry. */
export const OAUTH2_REFRESH_LEAD_MS = 60_000;

/** MCP client pool idle timeout (P4.2). Long-lived sse / websocket
 *  clients and stdio child processes are torn down after this many
 *  ms of inactivity per connection record. Reactive recipes firing
 *  every minute reuse the same client without re-spawn cost. */
export const MCP_CLIENT_IDLE_TIMEOUT_MS = 5 * 60_000;

/** Default `trust_min` for `enrichment-or-fetch` (P6.2) when the
 *  recipe doesn't specify. Picks the convention floor for "trust the
 *  cached enrichment over a fresh fetch." */
export const ENRICHMENT_TRUST_MIN_DEFAULT = 0.8;

/** D-177 P2b — the kernel dispatch surfaces for arbitrary tools on an
 *  enrolled MCP connection, split by the user's per-tool `read`/`write`
 *  classification so the manifest `risk_tier` carries the classification
 *  into the policy verdict (the chat Tier-3 path picks the slug; the
 *  server's connection-adapter gate re-checks the classification at
 *  dispatch — see `community/ingredients/connection-mcp-{read,write}.json`).
 *  `connection-mcp-write` is additionally in
 *  `OUTBOUND_SEND_INGREDIENT_SLUGS`, so an attended `user_self` dispatch
 *  lifts to a preflight ask. */
export const CONNECTION_MCP_READ_SLUG = 'connection-mcp-read';
export const CONNECTION_MCP_WRITE_SLUG = 'connection-mcp-write';
