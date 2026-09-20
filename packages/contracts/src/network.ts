/** D-148 § A.6 + § A.7 — Path layout + Public Exposure (Amendment 2026-05-11).
 *
 *  **Amendment 2026-05-11** supersedes the 4-port-listener + 5-profile
 *  model with a 2-listener path-routed model:
 *
 *    - Port 80 LAN plain HTTP + port 443 public TLS, both fronted by a
 *      single path-routing dispatcher serving `/health`, `/ws`, `/mcp`,
 *      `/webhooks/*`, `/reception/*`.
 *    - Public listener supports multi-domain SNI via `TLSDomainStore`
 *      (W3.2 substrate).
 *    - Exposure profile collapses from 5 named profiles + sub-toggle to
 *      **per-path `PathResolution { lan: bool; public: bool }`** as
 *      source of truth, with **3 presets** (`lan_only` / `public` /
 *      `maintenance`) as named applicators. Custom is the implicit
 *      fourth state when any toggle has been touched.
 *    - `/mcp.public` retains its acknowledgement gate; `/ws` gains a
 *      lockout-protection gate (§ A.6.6).
 *
 *  Per-path types (PATH_ROLES / PathResolution / ExposureState / preset
 *  helpers) live below — they are the source of truth for the new model.
 */

import { totalRecord } from './total-record.js';

/** Telegram's documented webhook ports. Closed list per § A.6 +
 *  § A.13. Setup that binds Telegram to a port outside this set
 *  raises `telegram_port_unsupported`. Under path consolidation, the
 *  canonical Telegram webhook URL is `https://<host>/webhooks/telegram/
 *  <conn>` on port 443; 80/88/8443 stay in the closed list for the rare
 *  ISP where 443 is blocked. */
export const TELEGRAM_SUPPORTED_PORTS: ReadonlyArray<number> = [443, 80, 88, 8443] as const;

/** Type predicate — is this port one Telegram's webhook endpoint
 *  will accept? */
export const isTelegramSupportedPort = (port: number): boolean =>
  (TELEGRAM_SUPPORTED_PORTS as ReadonlyArray<number>).includes(port);

/** D-148 § A.7 — explicit acknowledgement record for public MCP.
 *  Public MCP is a structurally riskier exposure class (AI-agent
 *  ingress, prompt-injection surface) and therefore requires
 *  separate user acknowledgement on top of any base profile.
 *
 *  The acknowledgement carries the user-typed `free_text_confirmation`
 *  alongside the boolean state. The substrate validator
 *  `isAcknowledgementWellFormed()` rejects any record where
 *  `acknowledged: true` is paired with a missing or non-canonical
 *  phrase — the bare boolean cannot be flipped without proof of the
 *  free-text gesture. P7 wires the UI; P1 ships the substrate
 *  invariant so callers (including future test fixtures) cannot
 *  forge an acknowledgement without the phrase. */
export interface PublicMcpAcknowledgement {
  acknowledged: boolean;
  /** Unix-ms; absent until first acknowledgement. */
  acknowledged_at?: number;
  /** Client id of the user who toggled it on. */
  acknowledged_by_client_id?: string;
  /** Free-text confirmation phrase the user typed at the gate. The
   *  substrate validator requires this to equal
   *  `PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE` exactly (whitespace-
   *  insensitive at edges) when `acknowledged === true`. Stored so
   *  the high-assurance audit row signed with `server_identity_key`
   *  can include the literal phrase in its provenance bundle. */
  free_text_confirmation?: string;
  /** Optional reason captured at acknowledgement time. */
  reason?: string;
}

/** Validate that an acknowledgement record is well-formed. When
 *  `acknowledged === true`, the record MUST carry a
 *  `free_text_confirmation` that equals
 *  `PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE` exactly. The bare boolean
 *  cannot be flipped without proof of the user's gesture — gates
 *  reject the record if validation fails (Codex review fold).
 *
 *  Returns true iff the record either declines acknowledgement
 *  (`acknowledged === false`) OR confirms it WITH a valid phrase. */
export const isAcknowledgementWellFormed = (
  acknowledgement: PublicMcpAcknowledgement,
): boolean => {
  if (!acknowledgement.acknowledged) return true;
  if (typeof acknowledgement.free_text_confirmation !== 'string') return false;
  return isValidPublicMcpAcknowledgementPhrase(acknowledgement.free_text_confirmation);
};

/** True iff the acknowledgement is BOTH set and well-formed — i.e. the
 *  owner really did type the canonical phrase, and the record still
 *  carries it. This is the question every `/mcp.public` gate actually
 *  asks; `isAcknowledgementWellFormed` alone is not it, because it
 *  answers `true` for an un-acknowledged record (nothing to be
 *  malformed about), and `acknowledged` alone is not it either, because
 *  a record can carry `acknowledged: true` with a missing or
 *  non-canonical phrase.
 *
 *  ⛔ THE COMPOSITE WAS SPELLED SIX DIFFERENT WAYS before 2026-09-17 —
 *  inline here in `applyPreset`, as two sequential guards returning the
 *  same error code in the server state machine, and as two PRIVATE
 *  helpers with DIFFERENT NAMES but identical bodies in the webclient
 *  (`isAcknowledgementEffectivelyOn`, `isPublicMcpAcknowledgementActive`).
 *  Five agreed. The sixth, the webclient's `isPathResolutionTransitionAllowed`
 *  pre-flight, checked only `acknowledged` and so let a malformed record
 *  through a gate every other site refused. Differing names are why no
 *  name-keyed scan found them; it lives here now so there is one answer.
 *
 *  ⚠ NOT the right predicate for a stored-row validator. `sqlite-store`'s
 *  `parseStateJson` deliberately rejects ANY malformed acknowledgement,
 *  whether or not `mcp.public` is set — a strictly stronger check than
 *  this one, and collapsing it to this would weaken it. */
export const isAcknowledgementEffectivelyOn = (
  acknowledgement: PublicMcpAcknowledgement,
): boolean =>
  acknowledgement.acknowledged && isAcknowledgementWellFormed(acknowledgement);

/** D-148 § A.7 — literal string the user must type to acknowledge
 *  public MCP exposure. Free-text confirmation forces deliberate
 *  action — checkbox would normalize the gesture. */
export const PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE = 'enable public MCP';

/** Verify the user-supplied confirmation matches the required
 *  acknowledgement phrase. Whitespace-insensitive at edges; case-
 *  exact in the middle (so 'Enable Public MCP' fails — phrase is
 *  the canonical lowercase form). Per Pre-Implementation Hardening
 *  pass: deliberate friction is the point. */
export const isValidPublicMcpAcknowledgementPhrase = (input: string): boolean =>
  input.trim() === PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE;

/** D-148 § A.6.5 — pinned cert state (two-pin overlap). Carries
 *  current + optional staged-next fingerprint plus a signed rotation
 *  notice. Clients persist this state and accept either fingerprint
 *  during the overlap window. */
export interface PinnedCertState {
  current_fingerprint: string;
  next_fingerprint?: string;
  current_valid_until: number;
  /** Ed25519 signature over canonical JSON of
   *  `{ current_fingerprint, next_fingerprint, rotation_at }`,
   *  signed with `server_identity_key`. Verified at the receiving
   *  client against its pinned `server_public_key`. Tampered or
   *  unsigned notices are ignored. */
  rotation_signed_notice?: string;
  last_rotated_at?: number;
}

/** D-148 § A.7 — closed list of error codes returned by the
 *  exposure-state machine + per-listener layer. Per the path-routing
 *  amendment (Wave 3) the 5-profile error codes retire (`profile_unknown`
 *  / `profile_unachievable_no_ddns` collapse to `preset_unknown` /
 *  `preset_unachievable_no_ddns`); per-path codes (`path_unknown`,
 *  `ws_lockout_*`) carry the new flow. */
export type NetworkErrorCode =
  | 'preset_unknown'
  | 'preset_unachievable_no_ddns'
  | 'public_mcp_not_acknowledged'
  | 'public_mcp_phrase_mismatch'
  | 'cert_pin_stale'
  | 'cert_pin_mismatch'
  | 'rotation_notice_signature_invalid'
  | 'telegram_port_unsupported'
  | 'port_in_use'
  | 'lan_address_unresolved'
  | 'path_unknown'
  | 'ws_lockout_unconfirmed'
  | 'ws_lockout_phrase_mismatch'
  | 'tls_domain_unknown'
  | 'tls_san_mismatch'
  | 'tls_key_pair_mismatch'
  | 'tls_chain_invalid'
  | 'tls_cert_expired_at_upload'
  /** D-148 § A.6.3 — `pro_acme`-source rows require explicit DDNS
   *  unbinding before the cert row is removed (the auto-managed
   *  hostname still resolves; deleting the cert mid-flight would let
   *  ACME re-create the row on the next renewal tick OR leave the
   *  public hostname without its managed cert). The rpc rejects
   *  `tls_domain.remove` on Pro-managed rows; the caller (Settings
   *  page) routes the removal through the Pro unbind flow first. */
  | 'tls_pro_acme_unbind_required'
  /** D-235 — the `pro_acme_custom` sibling of the code above, and a SEPARATE
   *  code because the remedy is different: a custom domain has no DDNS
   *  subdomain to unbind (the user owns the zone), so directing them to the Pro
   *  unbind flow would be wrong advice for a real refusal. What holds the row
   *  is the hostname-registry entry: remove that (`collection.hostname.remove`)
   *  and the cert goes with it. ⚠ Refusing at all matters — the custom-domain
   *  enrollment service re-orders any enrolled hostname it finds without a
   *  certificate, so a bare cert deletion is not a removal, it is a loop that
   *  spends the publisher's daily issuance ceiling. */
  | 'tls_custom_domain_unenroll_required'
  /** D-148 follow-up #5 — `pro_acme.unbind` was called for a domain
   *  that either doesn't exist in the TLS domain store at all, OR
   *  exists with `source: 'byo_upload'` (not Pro-managed). Idempotent
   *  retries hit this code on the second call (first call removed the
   *  row); the renderer treats it as a soft outcome with a "no change"
   *  toast rather than a hard error. */
  | 'pro_acme_not_found'
  /** D-148 follow-up #5 — `pro_acme.unbind` failed at the cloud DDNS
   *  release step. Cert row stays in place + remains Pro-managed; the
   *  user can retry. Transient failure (network / cloud quota /
   *  signature reject) — operator-visible. */
  | 'pro_acme_ddns_release_failed'
  /** The cloud ACME helper answered HTTP 429: this publisher has spent its
   *  daily issuance allowance (`ACME_ISSUE_CERT_RATE_LIMIT_PER_DAY`).
   *
   *  ⛔ WAS COLLAPSING INTO `storage_io_error` ON THIS SURFACE — an initial
   *  custom-domain issuance that hit the ceiling told the operator their
   *  certificate "could not be stored", which is not what happened and
   *  points the investigation at the disk. The helper answered; it said no. */
  | 'acme_rate_limited'
  /** R26.2 Delta 2 — apex (`GET /` on the public listener) setter codes.
   *  `apex_mode_unknown` — the requested mode is not one of
   *  `ROOT_APEX_MODES`. `apex_reception_not_public` — `serve_reception`
   *  was requested but `/reception` is not public on the public listener
   *  (the apex would 404); enable `/reception` public in the Exposure grid
   *  first. `apex_webclient_unavailable` — `serve_webclient` was requested
   *  but the embedded webclient bundle is not served yet (Delta 3). */
  | 'apex_mode_unknown'
  | 'apex_reception_not_public'
  | 'apex_webclient_unavailable';

export const NETWORK_ERROR_CODES: ReadonlyArray<NetworkErrorCode> = [
  'preset_unknown',
  'preset_unachievable_no_ddns',
  'public_mcp_not_acknowledged',
  'public_mcp_phrase_mismatch',
  'cert_pin_stale',
  'cert_pin_mismatch',
  'rotation_notice_signature_invalid',
  'telegram_port_unsupported',
  'port_in_use',
  'lan_address_unresolved',
  'path_unknown',
  'ws_lockout_unconfirmed',
  'ws_lockout_phrase_mismatch',
  'tls_domain_unknown',
  'tls_san_mismatch',
  'tls_key_pair_mismatch',
  'tls_chain_invalid',
  'tls_cert_expired_at_upload',
  'tls_pro_acme_unbind_required',
  'tls_custom_domain_unenroll_required',
  'pro_acme_not_found',
  'pro_acme_ddns_release_failed',
  'acme_rate_limited',
  'apex_mode_unknown',
  'apex_reception_not_public',
  'apex_webclient_unavailable',
] as const;

// ────────────────────────────────────────────────────────────────
// R26.2 Delta 2 — apex (`GET /` on the public listener) serving mode
// ────────────────────────────────────────────────────────────────

/** What the server serves at the bare root `GET /` on the PUBLIC
 *  listener. A server-global setting (stored as the `network.apex_mode`
 *  runtime-config field), resolved per-request by the root handler so a
 *  change takes effect without a restart.
 *
 *  - `redirect` (default) — bare 302 to `ROOT_REDIRECT_TARGET`
 *    (`app.recued.com`) for `<handle>.recued.cloud` Hosts; 404 for any
 *    other Host (the handle never leaks into the redirect chain, per
 *    `feedback_no_handle_in_redirect_chain`). Safe for public + always
 *    the newest webclient.
 *  - `serve_webclient` — serve the embedded webclient bundle at root.
 *    Requires the bundle to be served on the public listener (R26.2
 *    Delta 3); until then the setter rejects it + the handler 404s.
 *  - `serve_reception` — serve the anonymous visitor-intake (Reception)
 *    page at root. Requires `/reception` public on the public listener;
 *    the setter rejects it otherwise + the handler 404s defensively.
 *  - `not_found` — return the generic 404 floor at root (closed). */
export type RootApexMode =
  | 'redirect'
  | 'serve_webclient'
  | 'serve_reception'
  | 'not_found';

export const ROOT_APEX_MODES: ReadonlyArray<RootApexMode> = [
  'redirect',
  'serve_webclient',
  'serve_reception',
  'not_found',
] as const;

/** First-boot + fallback apex mode — the privacy-safe public default. */
export const DEFAULT_ROOT_APEX_MODE: RootApexMode = 'redirect';

/** Type guard for wire-shaped apex-mode args. */
export const isRootApexMode = (value: unknown): value is RootApexMode =>
  typeof value === 'string' &&
  (ROOT_APEX_MODES as ReadonlyArray<string>).includes(value);

// ────────────────────────────────────────────────────────────────
// D-148 Wave 3 — Path-routing substrate (Amendment 2026-05-11)
// ────────────────────────────────────────────────────────────────
//
// The amendment supersedes the 5-profile + sub-toggle model with a
// per-path `PathResolution { lan; public }` toggle grid + three named
// presets (`lan_only` / `public` / `maintenance`). W3.5 retires the
// 5-profile types (pre-launch zero-installs → no compat shim); per-
// path types below are the source of truth for the exposure state
// machine + listener-set + Settings UX.

/** D-148 § A.6 — closed list of path roles. Each role maps to one
 *  per-path handler dispatched by the two-listener path-router.
 *  Includes `'health'` (the liveness probe path) which the path-routing
 *  model surfaces as an explicit first-class path.
 *
 *  D-165 enroll-host #1 (vendor OAuth popup) adds `'oauth'` —
 *  `/oauth/complete`, the public callback surface where the vendor
 *  redirect (direct GET) + the cloud-page POST land. Like `'reception'`
 *  it is an opt-in public surface: ON in the `public` preset (slice 3),
 *  OFF in `lan_only` / `maintenance`. It is ungated (no `/mcp.public`-style
 *  acknowledgement) — the handler only completes validly-signed states for
 *  pending flows THIS server started, so public reachability is low-risk.
 *  The end-to-end flow is whole (slice 2b mounted the handler; slice 3
 *  added the cross-origin CORS allowance, the owner-bound result-claim rpc,
 *  and the webclient dialog that drives it), so the preset never advertises
 *  a dead-end.
 *
 *  D-158 P2b-ii (notification ask-landing) adds `'ask'` — `/ask/<ask_id>`,
 *  the public one-click answer page for an emailed notification `ask`
 *  (`packages/notification/channels/ask-landing.ts`). Notification-native,
 *  NOT a reception endpoint: it is backed by the block's own `PendingAsk`
 *  store, the `ask_id` (a 122-bit UUID emailed only to the user) is the
 *  bearer capability, and a single-use form-nonce + same-origin guard the
 *  POST. Like `'reception'` / `'oauth'` it is an opt-in public surface — ON
 *  in the `public` preset, OFF in `lan_only` / `maintenance`. Ungated: the
 *  page only renders / answers an ask the user already holds the unguessable
 *  id for, so public reachability is low-risk. The emailed one-click link is
 *  only built on a publicly-reachable server (`getShareBaseUrl` resolves), so
 *  a LAN-only deployment never links the route. */
export type PathRole =
  | 'health'
  | 'ws'
  | 'mcp'
  | 'llm_gateway'
  | 'webhooks'
  | 'reception'
  | 'oauth'
  | 'ask'
  | 'webclient';

/** ⚠ NO `: ReadonlyArray<PathRole>` ANNOTATION — it would WIDEN the `as const`
 *  below back to `PathRole[]`, so `(typeof PATH_ROLES)[number]` would be the
 *  whole union again and the exhaustiveness proof underneath would be vacuous.
 *  `satisfies` gives the same "every entry is a real role" check without the
 *  widening. This is what lets `totalRecord(PATH_ROLES, …)` be SOUND rather
 *  than an assertion: K is inferred from the tuple, and the tuple is proven to
 *  cover the union. */
export const PATH_ROLES = [
  'health',
  'ws',
  'mcp',
  // D-196 S2c — OpenAI-compatible HTTP chat-completions door. The canonical
  // role base is `/llm-gateway`; OpenAI compatibility endpoints are exact
  // legacy aliases (`/v1/models`, `/v1/chat/completions`) so they never claim
  // other `/v1/*` surfaces such as connection webhooks.
  'llm_gateway',
  'webhooks',
  'reception',
  'oauth',
  'ask',
  // R26.2 Delta 3 — the embedded webclient bundle (`/webclient/*`) is a
  // first-class exposure path, not a special carve-out. Default
  // `{lan:true, public:false}`: served on LAN when a bundle is present
  // (the D-152 off-grid-Mary case), public exposure is an explicit
  // per-row opt-in (the `public` preset deliberately leaves it off).
  'webclient',
] as const satisfies readonly PathRole[];

/** Compile-time proof that no `PathRole` is missing above. A new union member
 *  makes `Exclude<…>` non-`never` and this alias resolves to `never`, so the
 *  assignment stops compiling — and every `totalRecord(PATH_ROLES, …)` caller
 *  stays sound instead of silently building a record with a hole in it. */
type PathRolesAreExhaustive =
  Exclude<PathRole, (typeof PATH_ROLES)[number]> extends never ? true : never;
const _pathRolesAreExhaustive: PathRolesAreExhaustive = true;
void _pathRolesAreExhaustive;

/** D-148 § A.6 — canonical path string per role. The dispatcher fans
 *  inbound requests to per-channel handlers based on URL path; this
 *  table is the source of truth for the role → path-string map.
 *
 *  Every role's path entry is the role's BASE; sub-paths under that
 *  base belong to the same role (e.g., `/mcp/catalog` belongs to the
 *  `mcp` role; `/webhooks/<vendor>/<conn>` belongs to `webhooks`;
 *  `/reception/_health` + `/reception/intake/<id>` belong to
 *  `reception`). Callers MUST use `matchesPathRole(url, role)` for
 *  boundary-aware matching — raw `startsWith` would incorrectly
 *  claim `/mcpevil` for `mcp` or `/webhooksevil` for `webhooks`,
 *  and raw equality would drop `/mcp/catalog` from `mcp`'s scope. */
export const PATH_FOR_ROLE: Record<PathRole, string> = {
  health: '/health',
  ws: '/ws',
  mcp: '/mcp',
  llm_gateway: '/llm-gateway',
  webhooks: '/webhooks',
  reception: '/reception',
  oauth: '/oauth/complete',
  ask: '/ask',
  webclient: '/webclient',
} as const;

/** D-148 § A.6 — boundary-aware role matcher. Returns true iff `url`
 *  is exactly the role's canonical base OR is a sub-path under it
 *  (next character is `/`). Built so that:
 *
 *  - `/mcp` and `/mcp/catalog` both match `mcp` (the catalog route is
 *    under the MCP role per § A.6 table).
 *  - `/mcpevil` does NOT match `mcp` (boundary discipline — adjacent
 *    characters do not extend the role).
 *  - `/webhooks/<vendor>/<conn>` matches `webhooks`; `/webhooksevil`
 *    does not.
 *  - `/reception/_health` + `/reception/intake/<id>` match `reception`;
 *    `/receptionx` does not.
 *  - `/health` matches `health`; `/healthcheck` does not.
 *
 *  The dispatcher uses this to fan to per-channel handlers; the role
 *  handler is then responsible for any further sub-path 404. */
export const matchesPathRole = (url: string, role: PathRole): boolean => {
  const base = PATH_FOR_ROLE[role];
  if (url === base) return true;
  return url.startsWith(base + '/');
};

/** D-148 § A.7 — per-path resolution. `lan` controls whether the path
 *  is served on the port-80 plain-HTTP LAN listener; `public` controls
 *  the port-443 TLS public listener. Both may be true (LAN + public
 *  both serve), both false (path disabled — listener returns 404), or
 *  any mix. The listener-set binds each listener iff at least one path
 *  resolves true for that bit. */
export interface PathResolution {
  lan: boolean;
  public: boolean;
}

/** Runtime validator for a `PathResolution` arriving from outside the
 *  type system — an rpc argument off the wire, or a `state_json` cell
 *  read back from SQLite. BOTH bits must be actual booleans: `public`
 *  is what decides whether a path is bound to the public listener, and
 *  every near-miss value a caller or a half-written row can supply
 *  (`1`, `"false"`, `null`) is either truthy or coerces, so a cell that
 *  merely *has* the keys would be persisted verbatim and read by the
 *  listener as "on".
 *
 *  ⛔ THIS LIVED AS TWO PRIVATE COPIES — `exposure-handler.ts` (the wire
 *  end) and `exposure/sqlite-store.ts` (the stored end) — and BOTH had
 *  drifted to testing only the `lan` half, which is how the two ends
 *  could disagree about what a valid cell is. It belongs next to the
 *  type it validates so there is one answer; see
 *  `packages/contracts/src/__tests__/path-resolution-guard.test.ts`. */
export const isPathResolution = (value: unknown): value is PathResolution => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { lan?: unknown; public?: unknown };
  return typeof v.lan === 'boolean' && typeof v.public === 'boolean';
};

/** D-148 § A.7.1 — three named presets (closed list). Presets are
 *  snap-to-shape applicators over the per-path toggle grid; everything
 *  outside the three preset shapes is `Custom` (UI-level label only —
 *  not a stored value). */
export type ExposurePreset = 'lan_only' | 'public' | 'maintenance';

export const EXPOSURE_PRESETS: ReadonlyArray<ExposurePreset> = [
  'lan_only',
  'public',
  'maintenance',
] as const;

/** D-148 § A.7.1 — preset → resolution table. The `public` preset's
 *  `/mcp.public` bit is deliberately false here; that bit is only
 *  flippable through the `public_mcp_acknowledgement` gate per § A.7.2.
 *  Applying the `public` preset stamps everything else lan+public and
 *  leaves `/mcp.public` for the explicit gate.
 *
 *  Spec invariant § A.7.2: "the `public` preset attempts to set
 *  `/mcp.public = true` as part of its baseline; if acknowledgement is
 *  missing, the preset applies everything except the `/mcp.public`
 *  flip (which stays false)". The map encodes the unack'd baseline; the
 *  applicator threads the acknowledgement separately. */
export const EXPOSURE_PRESET_PATH_MAP: Record<
  ExposurePreset,
  Record<PathRole, PathResolution>
> = {
  lan_only: {
    health: { lan: true, public: false },
    ws: { lan: true, public: false },
    mcp: { lan: true, public: false },
    llm_gateway: { lan: true, public: false },
    webhooks: { lan: false, public: false },
    reception: { lan: false, public: false },
    oauth: { lan: false, public: false },
    ask: { lan: false, public: false },
    // R26.2 Delta 3 — webclient served on LAN by default (the D-152
    // off-grid-Mary case); never auto-public.
    webclient: { lan: true, public: false },
  },
  public: {
    health: { lan: true, public: true },
    ws: { lan: true, public: true },
    mcp: { lan: true, public: false },
    llm_gateway: { lan: true, public: true },
    webhooks: { lan: true, public: true },
    reception: { lan: true, public: true },
    // D-165 slice 3 — the `/oauth/complete` callback surface, now served by
    // the `public` preset. Both halves of the flow land on this endpoint over
    // the public internet: the provider's direct redirect (GET) and the cloud
    // callback page's cross-origin POST. The end-to-end consumer is complete
    // (webclient dialog drives start → popup → owner-bound
    // `takeVendorOAuthResult`), so advertising it no longer offers a dead-end.
    // Ungated (unlike `/mcp.public`): the handler only completes validly-
    // signed states for pending flows this server started, so public
    // reachability is low-risk. Stays off in `lan_only` / `maintenance`
    // (opt-in public surface, like `reception`).
    oauth: { lan: true, public: true },
    // D-158 P2b-ii — the `/ask/<ask_id>` notification ask-landing page, an
    // opt-in public answer surface like `reception` / `oauth`. ON in the
    // `public` preset; the emailed one-click link is only built when a public
    // base URL resolves, so a non-public deployment never links it.
    ask: { lan: true, public: true },
    // R26.2 Delta 3 — DELIBERATELY public:false even under the `public`
    // preset. The embedded webclient is a richer surface (full pair/login
    // PWA) than the rpc endpoints; exposing it publicly stays an explicit
    // per-row opt-in (or the apex `serve_webclient` pick), never snapped on
    // by the preset. Keeps the baked Docker image private-by-default.
    webclient: { lan: true, public: false },
  },
  maintenance: {
    health: { lan: false, public: false },
    ws: { lan: false, public: false },
    mcp: { lan: false, public: false },
    llm_gateway: { lan: false, public: false },
    webhooks: { lan: false, public: false },
    reception: { lan: false, public: false },
    oauth: { lan: false, public: false },
    ask: { lan: false, public: false },
    webclient: { lan: false, public: false },
  },
} as const;

/** D-148 § A.7.1 — derived UI label for the toggle grid. When the
 *  current resolution table matches one of the preset shapes (after
 *  threading the public-MCP gate), the label is the matching preset;
 *  otherwise it is `'custom'`. */
export type DerivedPresetLabel = ExposurePreset | 'custom';

/** D-148 § A.7 — full exposure state under the path-routing model.
 *  Source of truth is the `resolution` map; `derived_preset_label` is
 *  recomputed on every mutation. W3.5 retires the legacy
 *  `ExposureProfileState`; this is the sole persisted exposure shape.
 *
 *  Acknowledgement gate (`public_mcp_acknowledgement`) is preserved as
 *  the only path to flip `resolution.mcp.public === true`; without a
 *  well-formed acknowledgement, mcp.public is forced false even when
 *  the user toggled the box (the substrate refuses the mutation). */
export interface ExposureState {
  resolution: Record<PathRole, PathResolution>;
  derived_preset_label: DerivedPresetLabel;
  public_mcp_acknowledgement: PublicMcpAcknowledgement;
  last_changed_at: number;
  changed_by_client_id: string;
  reason?: string;
}

// ────────────────────────────────────────────────────────────────
// Pure helpers — substrate-only; no IO
// ────────────────────────────────────────────────────────────────

/** Apply a named preset to produce the resolution table. The `public`
 *  preset threads the acknowledgement: when ack is well-formed, the
 *  `mcp.public` bit is true; otherwise it stays false (matching § A.7.2
 *  "preset applies everything except the `/mcp.public` flip"). */
export const applyPreset = (
  preset: ExposurePreset,
  acknowledgement: PublicMcpAcknowledgement,
): Record<PathRole, PathResolution> => {
  const base = EXPOSURE_PRESET_PATH_MAP[preset];
  const out = totalRecord(PATH_ROLES, (role) => ({
    lan: base[role].lan,
    public: base[role].public,
  }));
  if (preset === 'public' && isAcknowledgementEffectivelyOn(acknowledgement)) {
    out.mcp = { lan: out.mcp.lan, public: true };
  }
  return out;
};

/** Apply a per-path mutation to an existing resolution table. Pure —
 *  returns a new table, leaves the input untouched. The mcp.public
 *  invariant (only flippable through the acknowledgement gate) is
 *  enforced at the rpc layer, not here — this helper is the projection,
 *  the gate sits one layer up. */
export const applyPathResolution = (
  current: Record<PathRole, PathResolution>,
  path: PathRole,
  resolution: PathResolution,
): Record<PathRole, PathResolution> => {
  const out = totalRecord(PATH_ROLES, (role) => (role === path
    ? { lan: resolution.lan, public: resolution.public }
    : { lan: current[role].lan, public: current[role].public }));
  return out;
};

/** Recompute the derived preset label from the current resolution
 *  table. Compares each path's `{ lan, public }` against the ack-aware
 *  preset shape (i.e. `applyPreset(preset, acknowledgement)`), and
 *  returns the matching preset if every path matches, else `'custom'`.
 *
 *  Threading the acknowledgement is what distinguishes intentional
 *  drift from preset shape:
 *
 *  - With ack absent/invalid, the `public` preset shape has
 *    `mcp.public = false`. A resolution matching that exactly labels
 *    as `'public'`.
 *  - With ack valid, the `public` preset shape has
 *    `mcp.public = true`. A user who has ack'd then deliberately
 *    demoted only `/mcp.public` off (while keeping the rest of the
 *    public shape) drifts away from the preset → labels as `'custom'`
 *    so the UI can distinguish "intentional public-except-MCP" from
 *    "public preset pending acknowledgement".
 *
 *  Codex review fold (P2 #1) — earlier revision ignored mcp.public in
 *  the public-preset comparison; that erased the ack-with-MCP-demoted
 *  custom state. Now every bit is compared against the ack-aware
 *  expected shape — no role-specific branches needed. */
export const deriveLabel = (
  resolution: Record<PathRole, PathResolution>,
  acknowledgement: PublicMcpAcknowledgement,
): DerivedPresetLabel => {
  for (const preset of EXPOSURE_PRESETS) {
    const expected = applyPreset(preset, acknowledgement);
    let matches = true;
    for (const role of PATH_ROLES) {
      if (
        resolution[role].lan !== expected[role].lan ||
        resolution[role].public !== expected[role].public
      ) {
        matches = false;
        break;
      }
    }
    if (matches) return preset;
  }
  return 'custom';
};

/** D-148 § A.6.6 — `/ws` lockout protection. The /ws path is Mary's
 *  primary admin access channel; toggling both bits false locks her
 *  out of Settings. The substrate gates that transition behind a
 *  confirmation phrase. Three flavors based on caller channel + active
 *  connection count.
 *
 *  Closed list of two phrases at the substrate (the three flavors map
 *  to the same two phrases — the difference is UI tone, not phrase). */
export const WS_LOCKOUT_DISCONNECT_PHRASE = 'disconnect webclients';
export const WS_LOCKOUT_DISABLE_PHRASE = 'disable ws';

export type WsLockoutPhrase = typeof WS_LOCKOUT_DISCONNECT_PHRASE | typeof WS_LOCKOUT_DISABLE_PHRASE;

export const WS_LOCKOUT_PHRASES: ReadonlyArray<WsLockoutPhrase> = [
  WS_LOCKOUT_DISCONNECT_PHRASE,
  WS_LOCKOUT_DISABLE_PHRASE,
] as const;

/** Compute which phrase a `/ws` lockout transition requires.
 *  - `disconnect webclients` — at least one webclient is currently
 *    connected via /ws; the transition will drop them. Stronger warning.
 *  - `disable ws` — zero connected clients; no immediate disconnect,
 *    but Mary's future webclient access blocked until re-toggled.
 *
 *  Returns null when the transition does NOT trigger the lockout gate
 *  (i.e., the target resolution leaves at least one bit true). */
export const requiredWsLockoutPhrase = (args: {
  next_resolution: PathResolution;
  active_ws_connections: number;
}): WsLockoutPhrase | null => {
  if (args.next_resolution.lan || args.next_resolution.public) return null;
  return args.active_ws_connections > 0
    ? WS_LOCKOUT_DISCONNECT_PHRASE
    : WS_LOCKOUT_DISABLE_PHRASE;
};

/** Verify a user-supplied confirmation matches the required `/ws`
 *  lockout phrase. Whitespace-insensitive at edges; case-exact in the
 *  middle (matches the public-MCP gate's discipline). */
export const isValidWsLockoutPhrase = (
  input: string,
  required: WsLockoutPhrase,
): boolean => input.trim() === required;

/** True iff a path/resolution change touches `/mcp` toward
 *  `public === true` and therefore demands a valid acknowledgement
 *  per § A.7.2. Demotion (public bit going false) never demands the
 *  gate. Same posture as the legacy state machine's MCP gate. */
export const requiresPublicMcpAcknowledgementForResolution = (args: {
  path: PathRole;
  next_resolution: PathResolution;
  current_resolution: PathResolution;
}): boolean => {
  if (args.path !== 'mcp') return false;
  if (!args.next_resolution.public) return false;
  if (args.current_resolution.public) return false;
  return true;
};

/** True iff any path resolves to `lan === true` — the LAN listener
 *  binds iff this is true. Pure projection; no IO. */
export const anyPathLan = (resolution: Record<PathRole, PathResolution>): boolean => {
  for (const role of PATH_ROLES) {
    if (resolution[role].lan) return true;
  }
  return false;
};

/** True iff any path resolves to `public === true` — the public
 *  listener binds iff this is true. Pure projection; no IO. */
export const anyPathPublic = (resolution: Record<PathRole, PathResolution>): boolean => {
  for (const role of PATH_ROLES) {
    if (resolution[role].public) return true;
  }
  return false;
};

/** Default resolution shipped at first boot under the path-routing
 *  model. Matches the `lan_only` preset shape — LAN-only, no
 *  acknowledgement required at first boot. */
export const DEFAULT_PATH_RESOLUTION: Record<PathRole, PathResolution> = {
  health: { lan: true, public: false },
  ws: { lan: true, public: false },
  mcp: { lan: true, public: false },
  llm_gateway: { lan: true, public: false },
  webhooks: { lan: false, public: false },
  reception: { lan: false, public: false },
  oauth: { lan: false, public: false },
  ask: { lan: false, public: false },
  webclient: { lan: true, public: false },
} as const;

// ────────────────────────────────────────────────────────────────
// D-148 Wave 3 sub-phase 2 — TLSDomainStore + multi-domain SNI
// (Amendment 2026-05-11; substrate-only — production wiring in W3.6)
// ────────────────────────────────────────────────────────────────
//
// The public listener (port 443) supports multiple domain hostnames,
// each with its own TLS cert. SNI dispatches the right cert per
// handshake; unknown ServerName closes the connection (no default-cert
// fallback). Two cert sources: `pro_acme` (Pro DDNS hostname, auto-
// managed) and `byo_upload` (user-uploaded for any Mary-owned domain).
//
// W3.2 ships the contract substrate: types + pure helpers + 5 new
// error codes + an additional sub-DEK slot. Production wiring (SQLite
// persistence + per-handshake SNICallback + per-domain auto-renewal +
// per-domain rotation events) lands in W3.6.

/** D-148 § A.6.3 — closed list of cert sources backing a domain entry.
 *
 *  - `pro_acme` — Pro DDNS hostname (`<handle>.recued.cloud`); auto-
 *    managed via the existing ACME-DNS-01 helper (P7 substrate);
 *    auto-renewed; one entry per Pro subscription.
 *  - `pro_acme_custom` — D-235: a hostname the USER owns, issued and
 *    renewed by the fleet through a `_acme-challenge` CNAME delegated
 *    into the fleet's zone. Auto-renewed like `pro_acme`, but its
 *    renewal depends on a record in a zone the fleet does NOT control,
 *    so it fails in ways `pro_acme` cannot (§ 5.1) and carries its own
 *    delegation watch.
 *  - `byo_upload` — user-uploaded cert + private key for any domain
 *    Mary owns. User is responsible for renewal; the Reachability
 *    Doctor flags expiry per-domain at 30 / 14 / 7 day windows. */
export type TLSDomainCertSource = 'pro_acme' | 'pro_acme_custom' | 'byo_upload';

export const TLS_DOMAIN_CERT_SOURCES: ReadonlyArray<TLSDomainCertSource> = [
  'pro_acme',
  'pro_acme_custom',
  'byo_upload',
] as const;

/** Type predicate — is the value a known TLSDomainCertSource?
 *
 *  ⛔ USE THIS RATHER THAN A LOCAL `s === 'a' || s === 'b'`. `domain-store.ts`
 *  carried its own copy, and a copy of a closed vocabulary is a vocabulary that
 *  will be one member behind exactly once — silently, because the miss reads as
 *  "unknown source", which the store treats as a row that does not exist. */
export const isTLSDomainCertSource = (value: unknown): value is TLSDomainCertSource =>
  typeof value === 'string' && (TLS_DOMAIN_CERT_SOURCES as ReadonlyArray<string>).includes(value);

/** D-235 — does the FLEET issue and renew this source? Both ACME sources do;
 *  they differ only in whose zone the challenge is served from.
 *
 *  🔑 Every "is this ours to renew / stamp / auto-manage" branch must ask THIS,
 *  not `=== 'pro_acme'`. A missed site does not fail loudly: it treats a
 *  fleet-issued custom cert as user-managed, which means nobody renews it and
 *  the first anyone hears is a browser error ~90 days later. */
export const isFleetIssuedTlsDomainSource = (
  source: TLSDomainCertSource,
): source is 'pro_acme' | 'pro_acme_custom' =>
  source === 'pro_acme' || source === 'pro_acme_custom';

/** D-148 § A.6.3 — bundle returned by `TLSDomainStore.lookup()`. Plugs
 *  directly into Node's https `SNICallback` (the bundle is what the
 *  callback hands to `tls.createSecureContext({ cert, key, ca })`).
 *  Distinct from `packages/server-tls/src/types.ts#CertChain` because
 *  per-domain entries carry an optional chain plus the source label;
 *  the listener-set layer wraps this shape into its single-cert
 *  vocabulary at handshake time. */
export interface TLSDomainCertChain {
  domain: string;
  cert_pem: string;
  private_key_pem: string;
  chain_pem?: string;
  /** SHA-256 hex of the leaf cert (lowercase, no separators). */
  fingerprint: string;
  /** Unix-ms; from the cert's notAfter. */
  expires_at: number;
  source: TLSDomainCertSource;
}

/** D-148 § A.6.3 — row returned by `TLSDomainStore.list()`. Public
 *  surface for Settings → Server → TLS Certificates + the Reachability
 *  Doctor's per-domain TLS health rollup. Does not carry private key
 *  material (the store enforces that at the persistence layer; this
 *  shape simply omits the slot). */
export interface TLSDomainCertListEntry {
  domain: string;
  fingerprint: string;
  expires_at: number;
  issuer: string;
  source: TLSDomainCertSource;
  last_renewed_at?: number;
}

/** D-148 § A.6.3 — caller-supplied input to `TLSDomainStore.upload()`.
 *  Both ACME-renewal flows and BYO uploads call through the same gate;
 *  the validator runs the same checks. */
export interface TLSDomainUploadInput {
  domain: string;
  cert_pem: string;
  private_key_pem: string;
  chain_pem?: string;
  source: TLSDomainCertSource;
}

/** Returned from a successful `TLSDomainStore.upload()` call. */
export interface TLSDomainUploadResult {
  fingerprint: string;
  expires_at: number;
  /** SANs extracted from the uploaded cert. Surfaces in the UI's
   *  "this cert covers" line. */
  san: string[];
}

/** D-148 § A.6.3 — abstract contract for the per-domain cert store.
 *  Implementations persist per-domain cert + private key sub-DEK-
 *  encrypted at rest (new sub-DEK slot `tls_domains`); per-pair only;
 *  no cross-cloud sync (D-097 / D-168). */
export interface TLSDomainStore {
  /** Add or replace a cert for `args.domain`. Validation runs the
   *  same gates as `validateTLSDomainUpload`. On replace, stages the
   *  next-fingerprint into `PinnedDomainCertState` so the two-pin
   *  overlap protocol can fire a per-domain rotation notice. */
  upload(args: TLSDomainUploadInput): Promise<TLSDomainUploadResult>;
  /** Look up a cert bundle for an SNI ServerName (called per-handshake
   *  by the public listener). Returns null for unknown domains so the
   *  listener can close the connection cleanly (no default-cert
   *  fallback to avoid cert-mismatch warnings). */
  lookup(domain: string): TLSDomainCertChain | null;
  /** Enumerate all configured domains. Surfaces in Settings + the
   *  Reachability Doctor's per-domain block. */
  list(): TLSDomainCertListEntry[];
  /** Remove cert for `domain`. Always allowed for `byo_upload`;
   *  `pro_acme` removal requires explicit DDNS unbinding handled by
   *  the caller before this rpc fires. */
  remove(domain: string): Promise<void>;
}

/** D-148 § A.6.3 — minimum cert validity window at upload. Certs
 *  expiring within `< 7 days` from now WARN (caller surfaces to UI);
 *  certs that already expired (`now > expires_at`) REJECT with
 *  `tls_cert_expired_at_upload`. The 7-day window matches the
 *  rotation lead-time (`CERT_ROTATION_NOTICE_LEAD_TIME_MS` in
 *  `d148-constants.ts`) — uploading a cert that won't survive the
 *  next rotation cycle is a foot-gun. */
export const TLS_CERT_MIN_VALIDITY_MS = 7 * 86_400_000;

/** D-148 § A.6.3 — per-upload validation issue. Each maps 1:1 to a
 *  network error code in `NETWORK_ERROR_CODES` plus a structured
 *  payload that callers surface in the UI. Closed list — `validate-
 *  TLSDomainUpload` returns only these shapes. */
export type TLSDomainUploadIssue =
  | { code: 'tls_san_mismatch'; san: string[]; domain: string }
  | { code: 'tls_key_pair_mismatch' }
  | { code: 'tls_chain_invalid' }
  | { code: 'tls_cert_expired_at_upload'; expires_at: number; now_ms: number };

/** D-148 § A.6.3 — discriminated result from `validateTLSDomainUpload`.
 *  Success carries the validator's projected `expires_at` + `san` plus
 *  a `warns` block (`expiry_within_7d` set when cert is valid but
 *  expires inside the warning window). Failure carries the closed-list
 *  issues. */
export type TLSDomainUploadValidation =
  | {
      ok: true;
      expires_at: number;
      san: string[];
      warns: { expiry_within_7d?: true };
    }
  | { ok: false; issues: ReadonlyArray<TLSDomainUploadIssue> };

/** D-148 § A.6.3 — caller-supplied seam for cert parsing. The substrate
 *  cannot import `node:crypto` (contracts is bundle-portable; runs on
 *  webclient + bridge + server). The seam delegates the OpenSSL-shaped
 *  primitives to the caller; production wiring in W3.6 wires a
 *  Node-side implementation that calls `x509.subjectAltName` etc.
 *
 *  Each verifier returns a discriminated success/failure shape so the
 *  validator can build `TLSDomainUploadIssue` rows directly — no
 *  reliance on exception channels. */
export interface TLSDomainUploadVerifiers {
  /** Extract SAN entries (dNSName values) from the cert. Lower-case
   *  punycode form expected. Empty array on parse failure. */
  extractSANs: (cert_pem: string) => string[];
  /** Verify the private key forms a valid pair with the cert
   *  (RSA / ECDSA depending on the cert's algorithm). */
  verifyKeyPair: (cert_pem: string, private_key_pem: string) => boolean;
  /** Verify the chain terminates at a public CA root. When
   *  `chain_pem` is undefined the verifier may attempt to validate
   *  against the system trust store. Returns false for self-signed
   *  chains unless `accept_self_signed` is true. */
  verifyChain: (
    cert_pem: string,
    chain_pem: string | undefined,
    opts: { accept_self_signed: boolean },
  ) => boolean;
  /** Read the cert's notAfter as unix-ms. Returns 0 when the value
   *  cannot be parsed. */
  readExpiresAt: (cert_pem: string) => number;
}

/** D-148 § A.6.3 — pure SAN-match helper. Exact match OR a wildcard
 *  SAN like `*.example.com` matches one-label subdomains
 *  (`sub.example.com` but NOT `a.b.example.com` — wildcards are
 *  single-label per RFC 6125 § 6.4.3). Comparison is case-insensitive
 *  (DNS names are case-insensitive); punycode-vs-Unicode normalisation
 *  is the caller's responsibility (the seam returns lower-cased
 *  punycode SAN entries). */
export const matchesSANForDomain = (domain: string, sans: ReadonlyArray<string>): boolean => {
  const d = domain.toLowerCase();
  for (const raw of sans) {
    const s = raw.toLowerCase();
    if (s === d) return true;
    if (s.startsWith('*.')) {
      const suffix = s.slice(2);
      const dotIdx = d.indexOf('.');
      if (dotIdx > 0 && d.slice(dotIdx + 1) === suffix) return true;
    }
  }
  return false;
};

/** D-148 § A.6.3 — pure validator for a TLS-domain upload. Runs every
 *  gate in spec order: SAN match → key/cert pair → chain termination →
 *  expiry. Each failing gate adds a `TLSDomainUploadIssue` to the
 *  output's `issues` array; passing all gates returns the projected
 *  `expires_at` + `san` + a `warns` block (set when `expires_at` falls
 *  inside the 7-day warning window).
 *
 *  Substrate-only — production callers wrap with a verifier seam built
 *  on `node:crypto` X509Certificate. Validation order matches the spec
 *  § A.6.3 bullet list. */
export const validateTLSDomainUpload = (
  input: TLSDomainUploadInput,
  verifiers: TLSDomainUploadVerifiers,
  args: { now_ms: number; accept_self_signed?: boolean },
): TLSDomainUploadValidation => {
  const issues: TLSDomainUploadIssue[] = [];
  const san = verifiers.extractSANs(input.cert_pem);
  if (!matchesSANForDomain(input.domain, san)) {
    issues.push({ code: 'tls_san_mismatch', san: [...san], domain: input.domain });
  }
  if (!verifiers.verifyKeyPair(input.cert_pem, input.private_key_pem)) {
    issues.push({ code: 'tls_key_pair_mismatch' });
  }
  if (
    !verifiers.verifyChain(input.cert_pem, input.chain_pem, {
      accept_self_signed: args.accept_self_signed === true,
    })
  ) {
    issues.push({ code: 'tls_chain_invalid' });
  }
  const expires_at = verifiers.readExpiresAt(input.cert_pem);
  if (expires_at <= args.now_ms) {
    issues.push({ code: 'tls_cert_expired_at_upload', expires_at, now_ms: args.now_ms });
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const warns: { expiry_within_7d?: true } = {};
  if (expires_at - args.now_ms < TLS_CERT_MIN_VALIDITY_MS) {
    warns.expiry_within_7d = true;
  }
  return { ok: true, expires_at, san: [...san], warns };
};

/** D-148 § A.6.5 (multi-domain extension) — per-domain pinned cert
 *  state. The two-pin overlap protocol applies per-domain: each domain
 *  carries its own `(current_fingerprint, next_fingerprint?)` pair so
 *  clients can pin per-domain cert chains and accept rotation notices
 *  scoped per-domain. Pro-managed (`pro_acme`) domains auto-rotate via
 *  ACME; BYO-uploaded (`byo_upload`) domains rotate at user-driven re-
 *  upload time (the upload itself stages the next-fingerprint).
 *
 *  Co-exists with single-domain `PinnedCertState` during W3.x; later
 *  sub-phases migrate the persisted state. */
export interface PinnedDomainCertState {
  domain: string;
  current_fingerprint: string;
  next_fingerprint?: string;
  current_valid_until: number;
  /** Ed25519 signature over the canonical JSON of `{ domain,
   *  current_fingerprint, next_fingerprint, rotation_at }`, produced
   *  with `server_identity_key`. Verified at the receiving client
   *  against its pinned `server_public_key`. */
  rotation_signed_notice?: string;
  last_rotated_at?: number;
}

// ────────────────────────────────────────────────────────────────
// D-148 follow-up #7 — bare-302 root redirect substrate
// ────────────────────────────────────────────────────────────────
//
// When a visitor hits `https://<handle>.recued.cloud/` (bare root, GET
// or HEAD), the public listener responds with HTTP 302 + `Location: https://app.recued.com/`.
// The redirect target is a hardcoded constant — the handle from the
// inbound Host header is never echoed into the Location URL, query
// string, fragment, or path. Per `feedback_no_handle_in_redirect_chain`:
// pair pre-fill is a small convenience; handle exposure through the
// redirect chain leaks into browser history, Referer headers, analytics,
// and copy-paste — a durable, unfixable disclosure. The visitor lands at
// `app.recued.com` and pairs by hand (the friction is one click; the
// privacy win is permanent).

/** D-176 — multi-domain DDNS zone registry. Each handle is a GLOBAL
 *  identity (shared with the marketplace publisher namespace), so the zone
 *  a handle resolves under is an ATTRIBUTE of that handle (`HostnameRow.zone`),
 *  never part of its key. Exactly one zone carries `default: true` — new
 *  handle registrations bind to it. Additional zones are pure config: add an
 *  entry, delegate the new domain to the same `ns1-4.recued.net` fleet
 *  (out-of-bailiwick → no glue needed), create the zone in PowerDNS, issue a
 *  cert — no code change. `.recued.net` is the launch default; re-enabling a
 *  `.recued.cloud` zone later is a one-line addition. */
export interface DdnsZone {
  /** DNS suffix INCLUDING the leading dot, e.g. `.recued.net`. */
  readonly suffix: string;
  /** Short label for UI / audit / `HostnameRow.zone`, e.g. `net`. */
  readonly label: string;
  /** Exactly one zone carries `default: true` — where new handles land. */
  readonly default: boolean;
  /** Whether the zone currently accepts and serves handles. A zone can be
   *  registered-but-disabled (provisioned, not yet open); `resolveProDdnsHost`
   *  matches only enabled zones. */
  readonly enabled: boolean;
}

export const DDNS_ZONES: readonly DdnsZone[] = [
  { suffix: '.recued.net', label: 'net', default: true, enabled: true },
  // Future: delegate recued.cloud → ns1-4.recued.net (no glue), create the
  // zone + cert, then flip enabled:
  // { suffix: '.recued.cloud', label: 'cloud', default: false, enabled: false },
] as const;

/** The single default zone — where new handle registrations bind. Throws if
 *  the registry is misconfigured (zero or multiple defaults); guarded by a
 *  unit test so the throw is a build-time, not runtime, signal. */
export const defaultDdnsZone = (): DdnsZone => {
  const defaults = DDNS_ZONES.filter((z) => z.default);
  if (defaults.length !== 1) {
    throw new Error(
      `DDNS_ZONES must declare exactly one default zone (found ${defaults.length})`,
    );
  }
  return defaults[0]!;
};

/** Enabled zones in registry order — the set `resolveProDdnsHost` matches. */
export const enabledDdnsZones = (): readonly DdnsZone[] =>
  DDNS_ZONES.filter((z) => z.enabled);

/** D-176 — resolve a stored zone label (`HostnameRow.zone` /
 *  `HandleState.ddns_zone`, e.g. `net`) back to its `DdnsZone`. Searches the
 *  FULL registry, not just enabled zones: a handle persists the label of the
 *  zone it is bound to, and that record must still resolve for hostname
 *  synthesis even if the zone is later disabled. Returns undefined for an
 *  unknown label — callers fall back to `defaultDdnsZone()`. The inverse of
 *  `DdnsZone.label`. */
export const zoneByLabel = (label: string): DdnsZone | undefined =>
  DDNS_ZONES.find((z) => z.label === label);

/** D-148 FU#7 — fixed redirect target. The exact string emitted in the
 *  `Location` header — no interpolation, no query string, no fragment,
 *  no handle. Per `feedback_no_handle_in_redirect_chain`: the handle is
 *  the user's identity surface and MUST NOT survive into the URL the
 *  redirect target sees. The visitor pairs by hand on the webclient
 *  side; identity binding happens after they authenticate. */
export const ROOT_REDIRECT_TARGET = 'https://app.recued.com/' as const;

/** D-176 — the zone-matching core, taking the zone list EXPLICITLY.
 *  `resolveProDdnsHost` binds it to the live enabled registry; this overload
 *  exists so the multi-zone behaviour can be driven without mutating a const.
 *
 *  ⛔⛔ THE LOOP MUST `continue`, NOT `return null`, WHEN THE PREFIX IS
 *  MULTI-LABEL. It used to return, which silently blacklisted an entire NESTED
 *  zone. With `.recued.net` and `.eu.recued.net` both enabled and the parent
 *  listed first — the order you get by APPENDING a new entry, which is exactly
 *  what `DDNS_ZONES`' own comment invites (*"additional zones are pure config
 *  … no code change"*) — `alice.eu.recued.net` matched `.recued.net`, produced
 *  the prefix `alice.eu`, hit the dot check and returned null before
 *  `.eu.recued.net` was ever tried. Driven, before the fix:
 *
 *      parent first:  alice.recued.net → alice   alice.eu.recued.net → null
 *      nested first:  alice.recued.net → alice   alice.eu.recued.net → alice/eu
 *
 *  🔑 So the whole sub-zone was dark, not some edge of it, and WHICH behaviour
 *  you got depended on array order in a registry that documents no ordering
 *  rule. It failed silently too: null → `isProDdnsHost` false → the redirect
 *  handler and reception trust-footer just treat those hosts as not-Pro-DDNS.
 *
 *  🔑🔑 `continue` IS ORDER-INDEPENDENT, NOT MERELY BETTER. For a given hostname
 *  at most ONE zone can yield a single-label prefix, because two suffixes that
 *  both match one host differ in label count, so their prefixes do too. The
 *  leading dot each suffix carries is what keeps the match on a label boundary
 *  (`alice.xrecued.net` does not end with `.recued.net`). ⇒ no longest-suffix
 *  pass is needed; the first zone yielding a valid handle is the only one.
 *
 *  ⚠ Today this is a no-op: one zone is enabled, so the loop runs once and both
 *  spellings fall through to the same final `return null`. The cost was only
 *  ever payable on the NEXT zone added. */
export const resolveProDdnsHostIn = (
  zones: readonly DdnsZone[],
  host: string | undefined | null,
): { handle: string; zone: DdnsZone } | null => {
  if (!host) return null;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  // Strip optional `:port` suffix. IPv6 literals would also include `]` but
  // they cannot end in a zone suffix so they fall out at the suffix check.
  const colonIdx = trimmed.indexOf(':');
  const hostname = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
  for (const zone of zones) {
    if (!hostname.endsWith(zone.suffix)) continue;
    const handle = hostname.slice(0, hostname.length - zone.suffix.length);
    // NOT `return null` — a nested zone later in the list may still match.
    if (handle.length === 0 || handle.includes('.')) continue;
    return { handle, zone };
  }
  return null;
};

/** D-176 — resolve a request Host header to its Pro DDNS `{ handle, zone }`,
 *  or null if it isn't a single-label handle subdomain of any ENABLED zone.
 *
 *  Match rules (strict):
 *
 *  - The host must be a non-empty string. Empty / undefined → null.
 *  - The optional `:port` suffix is stripped before matching. Case-folded
 *    to lowercase (DNS names are case-insensitive per RFC 1035 § 2.3.3).
 *  - The hostname must end with an enabled zone suffix AND the prefix before
 *    that suffix must be a single non-empty label with no dots. So
 *    `alice.recued.net` → { handle:'alice', zone:net }; `recued.net` (bare
 *    apex) → null; `a.b.recued.net` (multi-label) → null; `app.recued.com`
 *    → null; a `.recued.cloud` host while that zone is disabled → null.
 *  - The prefix is NOT validated against `D148_HANDLE_REGEX` here — this runs
 *    ahead of any handle-resolution lookup; the only check is "Pro DDNS shape".
 *    Handle validity is a registration-time gate, not a redirect-time gate.
 *  - IPv6 literals (`[::1]`) and IP-only Host headers do not match — they
 *    don't end with any zone suffix.
 *  - A zone whose suffix matches but yields a multi-label prefix does NOT end
 *    the search — see `resolveProDdnsHostIn`. */
export const resolveProDdnsHost = (
  host: string | undefined | null,
): { handle: string; zone: DdnsZone } | null =>
  resolveProDdnsHostIn(enabledDdnsZones(), host);

/** D-148 FU#7 — pure predicate: does the Host header point at any ENABLED Pro
 *  DDNS zone hostname? Thin wrapper over `resolveProDdnsHost` — the redirect
 *  handler + reception trust-footer resolution only need the boolean. */
export const isProDdnsHost = (host: string | undefined | null): boolean =>
  resolveProDdnsHost(host) !== null;

/** D-176 — canonical Pro DDNS hostname for a reserved handle under a zone:
 *  `<handle><zone.suffix>`. Zone defaults to the registry default
 *  (`.recued.net`) — the only zone open at launch — so existing single-zone
 *  callers need no change. The inverse of `resolveProDdnsHost`'s prefix
 *  extraction, and the single mapping the authoritative-write seam
 *  (`AuthoritativeDnsProvider`) and the canonical store (`HostnameRow`) agree
 *  on. Lower-cased + trimmed defensively (DNS names are case-insensitive,
 *  RFC 1035 § 2.3.3) so one handle never yields two spellings across the
 *  edge → provider → zone path. Handles are reserved lowercase, so this is a
 *  no-op for well-formed input. */
export const hostnameForHandle = (
  handle: string,
  zone: DdnsZone = defaultDdnsZone(),
): string => `${handle.trim().toLowerCase()}${zone.suffix}`;

/** R27 delta-B — `ddns.status` / `ddns.setEnabled` pair-RPC shapes. The user's
 *  own choice to publish (`enabled: true`) or pause (`enabled: false`) their Pro
 *  DDNS hostname. Server-local polarity (`enabled`); the cloud record carries the
 *  inverse `user_paused`. Pausing does NOT touch the Pro subscription — it only
 *  stops `<handle>.<zone>` from resolving to the server. Owner-only + MCP-reserved
 *  (`ddns.` in `MCP_RESERVED_RPC_PREFIXES`). */
export interface DdnsEnabledStatus {
  /** `true` = DDNS publishing (the record resolves); `false` = user-paused. */
  enabled: boolean;
}

export interface DdnsSetEnabledRequest {
  enabled: boolean;
}

/** A locally-reachable URL the server is listening on — a loopback address or
 *  a LAN interface address, combined with the live listen port. Surfaced to
 *  the webclient (Settings → Hostnames) as a "reach this server from other
 *  devices on your network" kickstart so a home user need not hunt for their
 *  LAN IP. Computed from `os.networkInterfaces()` + the bound port. This is
 *  NOT a probed-reachable claim — just the addresses the server binds locally
 *  (LAN is plain `http`, matching the CLI pair-flow URL enumeration). */
export interface LocalServerUrl {
  /** Absolute URL, e.g. `http://192.168.1.42:8443` or `http://localhost:8443`.
   *  IPv6 hosts are bracketed (`http://[fe80::1]:8443`). */
  url: string;
  kind: 'loopback' | 'lan';
}

/** Response for the `network.local_urls` rpc — the loopback + LAN URLs the
 *  server is reachable at on the local network, plus the two ports themselves.
 *
 *  ⛔⛔ BOTH PORTS ARE USER-CONFIGURABLE, AND THIS IS THE ONLY PLACE A CLIENT CAN
 *  LEARN EITHER. `bind_port` takes `--port` / `$PORT` / `config.toml`;
 *  `public_port` is a runtime config key (`config/schema.ts`, section Network,
 *  "Port used by the public TLS listener"). Before these fields existed,
 *  `public_port` appeared in NO client-facing contract at all — so every client
 *  surface naming a public port was quoting the 443 default as though it were a
 *  fact, and a server moved off 443 was handed addresses that do not serve.
 *
 *  ⚠ OPTIONAL ON PURPOSE, and not a hedge: this is self-hosted software with no
 *  deploy order. A client routinely talks to a server older than itself, and
 *  that server simply will not send these. Declaring them required would make
 *  the type assert something the wire cannot promise, and the reader would take
 *  `undefined` for a configured value. Absent means "this server is too old to
 *  say", which is not the same as any number. */
/** D-273 — what the router says about port mapping, and what we did about it.
 *
 *  ⛔ EVERY FIELD IS TRI-STATE BY OMISSION, and that is the whole shape of this
 *  response. "We have not looked", "we looked and the answer is no" and "we
 *  looked and the answer is yes" are three different things to tell an owner,
 *  and the router step says something different for each. Collapsing the first
 *  two is the mistake D-272 spent an entire decision on. */
export interface NetworkPortMappingResponse {
  /** The `network.auto_port_mapping` toggle. */
  enabled: boolean;
  /** ⚠ ABSENT MEANS NOBODY ASKED — an older server, or one that could not reach
   *  a gateway. It is NOT `'unsupported'`; see `PortMappingSupportKind`. */
  support?: 'enabled' | 'disabled' | 'unsupported';
  /** ⛔ TRUE MEANS A MAPPING WILL SUCCEED AND CHANGE NOTHING. The ISP is NATing
   *  upstream of this router, so the port it forwards is not reachable from the
   *  internet — the one answer that makes the whole feature pointless, and the
   *  one an owner would otherwise spend an afternoon discovering. */
  cgnat?: boolean;
  /** Which protocol answered, when one did. */
  protocol?: 'igd' | 'nat-pmp';
  /** What the last reconcile did. */
  outcome?:
    | 'idle' | 'mapped' | 'released' | 'unavailable' | 'failed'
    /** D-273 P2: already forwarded to this machine by the OWNER, by hand.
     *  ⚠ A SUCCESS, not a failure — the outcome they want is already true, and
     *  Recued deliberately did not touch it. */
    | 'foreign_ok'
    /** Something the owner set up holds the port and is not what we need. Not
     *  ours to change. */
    | 'foreign_conflict'
    /** Another machine on the network holds the port. */
    | 'conflict';
  /** The LAN host the router says currently holds the port, when it says. */
  held_by?: string;
  /** The external port actually mapped — ⚠ NOT necessarily the one requested;
   *  NAT-PMP gateways may assign another. */
  external_port?: number;
  /** Unix-ms of the last reconcile. Absent before the first. */
  checked_at?: number;
  /** Why we could not act at all, as opposed to the router refusing. */
  unavailable?: 'no_gateway' | 'no_lan_address';
  /** One line for the log / an expander. Never parsed. */
  detail?: string;
}

export interface NetworkLocalUrlsResponse {
  urls: LocalServerUrl[];
  /** The LAN listener's ACTUAL bound port, read post-bind — so a configured `0`
   *  reports what the OS assigned, not `0`. Same source as the ports inside
   *  `urls`; carried separately so a caller that needs the number does not have
   *  to parse a URL to get it. */
  lan_port?: number;
  /** The public TLS port this server is SERVING ON.
   *
   *  ⚠ CORRECTED 2026-09-17 — this said "configured, not verified bound", which
   *  stopped being true when `public_port` became live-editable. Production
   *  threads `boundPublicPort`, which starts at the configured value and
   *  thereafter moves ONLY when a rebind actually succeeded. So it is the
   *  configured value at boot (the public listener does not bind until a path is
   *  made public, so there is no post-bind number to read there) and, after any
   *  live port change, a port that bound.
   *
   *  ⛔ NEVER THE RAW CONFIG KEY. A failed rebind must not make this — and the
   *  three surfaces built from it — start advertising a port nothing is
   *  listening on. When the two diverge, `public_port_requested` carries the
   *  wish and this keeps carrying the truth. */
  public_port?: number;
  /** D-273 — the port the owner ASKED for, when it is not the one being served.
   *
   *  ⛔ PRESENT ONLY WHEN THEY DIFFER, which today means exactly one thing: a
   *  live `public_port` edit was accepted, persisted, and then FAILED TO BIND
   *  (taken, privileged, refused). The server keeps serving the old port — the
   *  right call — but until this field existed the divergence had no way to
   *  reach a client: `server.setConfigField` had already resolved OK, the
   *  settings page renders the config value, this rpc reports the bound one, and
   *  the only report of the failure was a line on the server's stdout. Two
   *  owner-facing surfaces disagreed with nothing to explain why.
   *
   *  ⚠ ABSENT IS THE NORMAL CASE and means "no divergence" — OR an older server
   *  that cannot say. Both render the same and should: there is nothing to tell
   *  the reader in either. Never synthesise it from `public_port`. */
  public_port_requested?: number;
  /** D-272 — where the LAN listener's bind actually puts it.
   *
   *  ⛔ "LAN-ONLY" IS A BIND ADDRESS, NOT AN ENFORCED BOUNDARY. There is no
   *  source-address filter in the path router, and `resolveLanAddress` binds
   *  the `0.0.0.0` wildcard whenever it finds one RFC1918 address — the
   *  ordinary home case — so the LAN listener is on every interface. On a host
   *  that also has a publicly-routable address (the cloud-VM shape: a private
   *  NIC and a public one) that puts a PLAINTEXT listener carrying `/ws` and
   *  `/mcp` on the public address.
   *
   *  ⚠ ROUTABLE, NOT REACHED. This is what the server can know with certainty
   *  about itself; whether a firewall, security group or router actually lets a
   *  connection through is the cloud probe's half of the question.
   *
   *  ⚠ ABSENT means the server did not say (older server, or it could not read
   *  its interfaces) — which is NOT the same as "not exposed". A client must
   *  render the two differently. */
  lan_exposure?: {
    publicly_routable: boolean;
    /** Whether the bind is a wildcard, i.e. every interface.
     *
     *  ⚠ TRUE IS THE DEFAULT, NOT A FINDING — `resolveLanAddress` returns
     *  `0.0.0.0` for the ordinary one-RFC1918-address host. It is carried so
     *  the warning can say WHY ("bound on every interface, and this machine has
     *  a public address"), never so a client can warn on it alone. */
    wildcard: boolean;
    /** The publicly-routable addresses this listener answers on. Empty iff
     *  `publicly_routable` is false. */
    public_addresses: ReadonlyArray<string>;
  };
}
