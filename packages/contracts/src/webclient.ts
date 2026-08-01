/** D-148 § A.4 — Thin Webclient contract.
 *
 *  The webclient is a thin display: WS subscribe → render. No engine.
 *  No vault. No recipes. No durable application state. Five fields
 *  are the closed list of what it persists; "Clear this browser" wipes
 *  all of them and the user re-pairs to re-enter.
 *
 *  P1 reserved the directory + role-boundary discipline. P4 ships the
 *  contract types here, the storage abstraction in `apps/webclient/`,
 *  the realtime subscription, the `state.snapshot` rpc surfaces, the
 *  approval response with single-use nonce, the internal-step grey-
 *  text feed, and the Settings UX (server URL editor / key health /
 *  exposure profile switcher).
 *
 *  Hard rules per § A.4.1 + § A.4.3:
 *   - Webclient persists only the documented 5 fields.
 *   - No `packages/engine` / `packages/recipes` / `packages/storage`
 *     imports — role-boundary lint asserts at every commit.
 *   - Approval responses echo a server-issued single-use nonce bound
 *     to `(approval_id, responder_client_id)`; replay fails with
 *     `approval_nonce_consumed`; mismatched fails with
 *     `approval_nonce_invalid`.
 *   - state.snapshot is per-surface; never returns full warehouse
 *     data; clients merge nothing — the snapshot is the truth.
 */

import type { PathResolution, PathRole } from './network.js';

/** D-148 § A.4.1 — closed list of fields the webclient persists in
 *  IndexedDB. The Settings → Privacy page renders this list as the
 *  "What does this client store?" view. CI gate (the role-boundary
 *  lint) asserts no other stores exist.
 *
 *  Mapping to spec § A.4.1 line 501-509 closed-list 5:
 *
 *    spec field                     | persisted by
 *    ───────────────────────────────|────────────────────────────
 *    server_url                     | this list (`server_url`)
 *    webclient_token                | this list (`webclient_token`,
 *                                   |   AES-GCM-wrapped opaque
 *                                   |   record carrying token_id +
 *                                   |   ciphertext + iv)
 *    server_public_key              | this list (`server_public_key`)
 *    ephemeral_session_state        | sessionStorage (not IDB)
 *    cached_assets                  | SW cache (not IDB)
 *
 *  Plus two § A.4.1-aligned widenings persisted on the IDB side:
 *
 *    pair_metadata                  | non-secret pair-time metadata
 *                                   |   needed for the Settings →
 *                                   |   Privacy inspector + audit
 *                                   |   row provenance.
 *    cert_pin_state                 | § A.6.5 two-pin state needed
 *                                   |   for rotation overlap (without
 *                                   |   it the webclient can't accept
 *                                   |   `next_fingerprint` after a
 *                                   |   server cert rotation).
 *
 *  Both widenings are derived from the pair-blob + post-pair `state.snapshot`
 *  surface — neither carries bearer-derived material. The IDB layer
 *  is therefore a 5-field closed list that is the substrate
 *  realization of the spec's user-facing 5-field promise. */
export const WEBCLIENT_LOCAL_STORAGE_FIELDS: ReadonlyArray<string> = [
  'server_url',
  'webclient_token',
  'server_public_key',
  'pair_metadata',
  'cert_pin_state',
] as const;

/** Server profiles — the same five fields, once per paired server.
 *
 *  WHY the list above did not simply grow: those five ARE the per-server
 *  material, and a browser that has paired to two servers holds two of each.
 *  Keeping them as top-level singletons is what made "my server is offline"
 *  a dead end — the only way to point this browser somewhere else was to
 *  clear site data, because there was nowhere for a second server's values
 *  to live. So the PHYSICAL layout becomes a roster of profile records
 *  (`WEBCLIENT_PROFILE_STORAGE_FIELDS`) and the five names above stay the
 *  LOGICAL view of whichever profile is active.
 *
 *  The user-facing promise is unchanged in kind: still exactly these five
 *  per server, still no bearer-derived plaintext, and now enumerable per
 *  server rather than silently overwritten by the last pairing.
 *
 *  `webclient_token` stays AES-GCM-wrapped with AAD over
 *  `(token_id, server_url, server_public_key)` — all three live INSIDE the
 *  profile, so a token lifted from one profile into another fails AEAD
 *  verify at unwrap. Profile isolation is cryptographic, not conventional. */
export interface WebclientServerProfile {
  /** Stable local identifier. Generated in the browser, never sent anywhere
   *  — the server has no notion of profiles. */
  id: string;
  /** User-editable display name. Seeded from `server_handle_at_pair`, or the
   *  URL host when no handle is known. */
  label: string;
  /** WS endpoint (`wss://host:port/ws`). Also part of the token AAD, so
   *  changing it for an existing profile invalidates that profile's stored
   *  bearer by construction — a re-pair, not an edit. */
  server_url: string;
  webclient_token: WebclientTokenRecord | null;
  server_public_key: string | null;
  pair_metadata: WebclientPairMetadata | null;
  cert_pin_state: WebclientCertPinState | null;
  /** Unix-ms of the last connect that reached `connected`. Orders the
   *  switcher and picks the fallback when an active profile is removed.
   *  Null until this profile has connected once. */
  last_connected_at: number | null;
}

/** The PHYSICAL IndexedDB keys. Two, replacing the five singletons: the
 *  roster, and which of its entries the runtime is currently using. The
 *  closed-list guard + CI ratchet assert on these; the five logical names
 *  are served out of the active record. */
export const WEBCLIENT_PROFILE_STORAGE_FIELDS: ReadonlyArray<string> = [
  'server_profiles',
  'active_profile_id',
] as const;

/** Inspectable shape the Settings → Privacy page renders. The five
 *  IDB-durable fields per spec § A.4.1 mapping above;
 *  `ephemeral_session_state` lives in sessionStorage (not IndexedDB)
 *  and `cached_assets` is the SW cache (managed by the browser, not
 *  user-data). */
export interface WebclientLocalStorage {
  /** WS endpoint URL set at pair time (e.g. `wss://alice.recued.cloud:8443/ws`). */
  server_url: string | null;
  /** Bearer for WS auth. Encrypted-at-rest via `crypto.subtle` AES-GCM
   *  with a non-extractable key per § A.4.1; stored as opaque
   *  ciphertext + a `token_id` public projection for diagnostics. */
  webclient_token: WebclientTokenRecord | null;
  /** Server's `server_identity_key` SPKI base64. Pinned at pair time;
   *  rotation triggers re-pair. */
  server_public_key: string | null;
  /** Pair-time metadata. Non-secret; supports the Settings → Privacy
   *  inspector + the Reachability Doctor. */
  pair_metadata: WebclientPairMetadata | null;
  /** Two-pin cert state per § A.6.5. Carries the current fingerprint
   *  + an optional staged-next so the webclient accepts either during
   *  the rotation overlap window without re-pair. */
  cert_pin_state: WebclientCertPinState | null;
}

export type WebclientLocalKey = keyof WebclientLocalStorage;

/** D-148 § A.4.1 — webclient bearer record. The cleartext bearer never
 *  travels back through this shape; the runtime decrypts from the
 *  AES-GCM-wrapped IndexedDB row at WS connect time and discards the
 *  plaintext after sending the `Authorization: Bearer` header. */
export interface WebclientTokenRecord {
  /** Public projection — safe to render in Settings + audit rows. */
  token_id: string;
  /** AES-GCM-wrapped bearer ciphertext (base64). Non-extractable key
   *  lives in the IndexedDB-backed key-store; only the runtime can
   *  unwrap. */
  ciphertext_b64: string;
  /** AES-GCM iv (base64) used at wrap time. */
  iv_b64: string;
  /** Unix-ms when the token was issued by the server. */
  issued_at: number;
}

/** D-148 § A.4.1 — pair-time metadata captured at `POST /auth/pair`
 *  bearer issuance. Lets the Settings UX render "you paired to alice's
 *  server on Tuesday" without keeping any bearer-derived material in
 *  plaintext. */
export interface WebclientPairMetadata {
  paired_at: number;
  server_passport_fingerprint: string;
  /** The server's `current_handle` at pair time. Subsequent
   *  `account.handle_changed` broadcast events refresh the user-
   *  visible label but the original handle stays here for audit. */
  server_handle_at_pair: string;
  /** D-151 follow-on — the locally-generated paired instance id, pinned
   *  here at pair time (this is the "pinned at pair time via
   *  `pair_metadata`" slot the `currentInstanceId` doc anticipated). The
   *  same value is sent to `POST /auth/pair` as `instanceId` so the
   *  server stamps it on the issued client token's `metadata.instance_id`
   *  + seeds the `paired_instances` roster row; the server then derives
   *  `WsClient.instance_id` from that token metadata on every bearer-only
   *  WS connect, which is what lets instance-gated rpcs (`reception.*`,
   *  `collection.hostname.*`, …) accept the webclient. Optional for
   *  back-compat with pair states written before this field existed (a
   *  reconnect re-derives identity from the token, not from here). */
  instance_id?: string;
}

/** D-148 § A.6.5 — webclient pinned cert state mirroring
 *  `PinnedCertState` minus the rotation-notice signature (the
 *  webclient verifies + discards on receipt; only the resolved
 *  fingerprints are persisted).
 *
 *  `previous_fingerprint` (Codex 2026-05-17 P2 fold, slice 115 follow-
 *  up): retained ONLY at the moment of a passport-fetch promotion —
 *  the verify path stamps the prior `current_fingerprint` here when it
 *  promotes the staged-next to current. The slot exists so a
 *  `cert.rotation_reverted` event firing post-promotion can name the
 *  OLD fingerprint and still find a trusted target to revert to
 *  (otherwise the revert handler would reject as
 *  `pin_unknown_revert_target` because the promotion cleared the next
 *  + replaced the current). Lifetime is intentionally narrow:
 *
 *    - The next rotation-notice preserves it (the staged-next becomes
 *      the new rollback candidate on its own promotion path; the
 *      retained previous is still valid until then).
 *    - A real revert consumes it (the rollback target becomes the new
 *      pinned current; previous_* is cleared).
 *    - A routine idempotent passport-fetch leaves it untouched.
 *    - `previous_valid_until` time-boxes acceptance: a revert naming
 *      the previous_fingerprint is accepted ONLY while `now <
 *      previous_valid_until`. Without this bound, a signed but
 *      stale `cert.rotation_reverted` (Ed25519-replayable since the
 *      server doesn't bind freshness into the rotation-notice
 *      transcript) could roll back the pin long after the OLD cert
 *      has expired (Codex 2026-05-17 P2 fold, slice 116). The
 *      passport-fetch promotion sets this to the moment that's
 *      consistent with the spec's 7d overlap window
 *      (`PASSPORT_FETCH_PREVIOUS_VALID_WINDOW_MS`).
 *
 *  The cert-pin-stale panel ignores `previous_*` for render purposes
 *  (the panel renders on `next_fingerprint` presence, not on
 *  previous_fingerprint). */
export interface WebclientCertPinState {
  current_fingerprint: string;
  next_fingerprint?: string;
  previous_fingerprint?: string;
  /** Unix-ms when the retained `previous_fingerprint` stops being a
   *  trusted rollback target. Present iff `previous_fingerprint` is
   *  set; pairs with it. Computed at promotion time as `last_rotated_at
   *  + PASSPORT_FETCH_PREVIOUS_VALID_WINDOW_MS`. Reverts arriving past
   *  this moment are rejected with `pin_unknown_revert_target` to
   *  defend against stale-but-signed revert replay (Codex 2026-05-17
   *  P2 fold, slice 116). */
  previous_valid_until?: number;
  current_valid_until: number;
  last_rotated_at?: number;
}

/** D-148 § A.6.5 — overlap window for the retained `previous_fingerprint`
 *  rollback slot. Matches the spec's 7d cert-rotation overlap; a
 *  signed `cert.rotation_reverted` naming the previous cert is
 *  accepted by the webclient ONLY while we're still inside this window
 *  from the last promotion. After expiry the OLD cert is treated as
 *  decommissioned; a revert naming it is a replay attempt rejected as
 *  `pin_unknown_revert_target`. Codex 2026-05-17 P2 fold (slice 116). */
export const PASSPORT_FETCH_PREVIOUS_VALID_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ────────────────────────────────────────────────────────────────
// state.snapshot rpc
// ────────────────────────────────────────────────────────────────

/** D-148 § A.4.2 — closed list of webclient-surfaceable snapshot
 *  kinds. Each surface returns its own rehydration projection; the
 *  webclient never merges across surfaces. Adding a new surface is
 *  a single edit here + a typed projection below + a server-side
 *  rpc handler.
 *
 *  - `inbox` — pending approvals + recent reactive fires + pinned
 *    notifications.
 *  - `settings.connections` — paired connections + per-vendor
 *    enrollment status (drives the Connections panel without
 *    reaching into vault refs).
 *  - `settings.exposure` — current exposure profile + per-port state
 *    + public-MCP acknowledgement summary.
 *  - `settings.key_health` — per-key-class status projection
 *    sourced from the passport's `key_health` block.
 *  - `internal_steps` — last N grey-step transcripts for cold-load
 *    rendering (live updates flow via `internal_step.<recipe_run_id>`
 *    broadcast events). */
export type WebclientSnapshotSurface =
  | 'inbox'
  | 'settings.connections'
  | 'settings.exposure'
  | 'settings.key_health'
  | 'internal_steps';

export const WEBCLIENT_SNAPSHOT_SURFACES: ReadonlyArray<WebclientSnapshotSurface> = [
  'inbox',
  'settings.connections',
  'settings.exposure',
  'settings.key_health',
  'internal_steps',
] as const;

/** Type predicate — is this string a known snapshot surface? Used by
 *  the rpc dispatcher to reject unknown surfaces with
 *  `state_snapshot_surface_unknown` rather than handing through to a
 *  catch-all handler. */
export const isWebclientSnapshotSurface = (v: unknown): v is WebclientSnapshotSurface =>
  typeof v === 'string' && (WEBCLIENT_SNAPSHOT_SURFACES as ReadonlyArray<string>).includes(v);

/** Discriminator-tagged result envelopes per surface. The webclient
 *  rpc layer narrows on `surface` to pick the rendering pipeline. */
export type WebclientStateSnapshot =
  | {
      surface: 'inbox';
      pending_approvals: Array<{
        approval_id: string;
        recipe_id: string;
        description: string;
        risk_tier: 'read' | 'write' | 'admin' | 'destructive';
        requested_at: number;
        expires_at: number;
      }>;
      recent_reactive_fires: Array<{
        recipe_id: string;
        fired_at: number;
        outcome: 'success' | 'error' | 'skipped';
      }>;
      cursor: number;
    }
  | {
      surface: 'settings.connections';
      connections: Array<{
        connection_id: string;
        kind: 'api' | 'mcp' | 'notification';
        vendor: string;
        name: string;
        status: 'healthy' | 'degraded' | 'revoked';
        last_used_at?: number;
      }>;
      cursor: number;
    }
  | {
      surface: 'settings.exposure';
      /** Recomputed UI label (preset name or `'custom'`). */
      derived_preset_label: 'lan_only' | 'public' | 'maintenance' | 'custom';
      /** Per-path toggle grid — source of truth. Keyed on the canonical
       *  `PathRole` closed list so new roles (D-165 `oauth`, …) propagate
       *  here automatically rather than drifting from an inline copy. */
      resolution: Record<PathRole, PathResolution>;
      public_mcp_acknowledged: boolean;
      cursor: number;
    }
  | {
      surface: 'settings.key_health';
      key_health: Record<
        string,
        {
          status: 'healthy' | 'warning' | 'overdue';
          last_rotated_at?: number;
          expiry_warning?: boolean;
          compromise_alert?: boolean;
        }
      >;
      cursor: number;
    }
  | {
      surface: 'internal_steps';
      runs: Array<{
        recipe_run_id: string;
        recipe_id: string;
        steps: Array<{
          step_id: string;
          summary: string;
          provenance_audit_id?: string;
          ts: number;
        }>;
      }>;
      cursor: number;
    };

// ────────────────────────────────────────────────────────────────
// Approval nonce
// ────────────────────────────────────────────────────────────────

/** D-148 § A.4.3 — single-use approval nonce. Server issues at
 *  `approval.requested` emit time; webclient echoes verbatim in the
 *  `approval.respond` rpc. Server verifies:
 *
 *   1. Nonce exists in the in-memory store.
 *   2. Nonce is bound to the same `(approval_id, responder_client_id)`
 *      tuple it was issued under.
 *   3. Nonce has not been consumed yet.
 *
 *  After successful verification the nonce is marked consumed; replay
 *  with the same nonce fails with `approval_nonce_consumed`. A request
 *  with a nonce that doesn't exist (forged, expired-and-evicted,
 *  cross-pair-leaked) fails with `approval_nonce_invalid`.
 *
 *  Why a nonce. Approvals are high-risk: a stolen WS bearer that lets
 *  an attacker fan out approve responses across many pending requests
 *  is materially worse than a stolen bearer for read traffic. The
 *  nonce binds each response to the specific request the user saw +
 *  the specific client they saw it on; an attacker without access to
 *  the live broadcast envelope cannot construct a valid response.
 */
export interface ApprovalNonceEnvelope {
  /** Unique per-issue nonce — base64 of CSPRNG bytes. 16 bytes
   *  (~128 bits) is plenty given the short TTL. */
  nonce: string;
  /** The approval the nonce was issued for. Server rejects responses
   *  whose `approval_id` doesn't match. */
  approval_id: string;
  /** The client the nonce was issued to. Server rejects responses
   *  from a different client even if the bearer matches. */
  responder_client_id: string;
  /** Unix-ms; nonce expires at this time. Past-expiry consume call
   *  fails with `approval_nonce_invalid`. */
  expires_at: number;
}

/** D-148 § A.4.3 — approval response wire shape. The webclient builds
 *  this from the user's click + the nonce envelope it received in the
 *  `approval.requested` event. */
export interface ApprovalResponseWire {
  approval_id: string;
  decision: 'allow_once' | 'allow_session' | 'allow_always' | 'deny';
  /** Server-issued nonce echoed verbatim. Server verifies single-use
   *  + binding to (approval_id, responder_client_id). */
  nonce: string;
  /** Decision wall-clock per D-120 audit row. */
  decided_at: number;
  /** Optional rationale captured from the UI's "tell us why" affordance.
   *  Surfaced in the audit row's `details_blob`. */
  reason?: string;
}

/** D-148 § A.4.3 — closed list of approval-nonce error codes. Cloud-
 *  blindness is irrelevant here (this is a server↔client surface) but
 *  the closed list keeps the wire shape stable + the test fixtures
 *  enumerable. */
export type ApprovalNonceErrorCode =
  | 'approval_nonce_invalid'
  | 'approval_nonce_consumed'
  | 'approval_nonce_expired'
  | 'approval_nonce_mismatched_client'
  | 'approval_nonce_mismatched_approval';

export const APPROVAL_NONCE_ERROR_CODES: ReadonlyArray<ApprovalNonceErrorCode> = [
  'approval_nonce_invalid',
  'approval_nonce_consumed',
  'approval_nonce_expired',
  'approval_nonce_mismatched_client',
  'approval_nonce_mismatched_approval',
] as const;

/** D-148 § A.4.3 — nonce TTL. Approvals are user-attended so the
 *  window is generous — long enough that a reasonable response time
 *  doesn't time out, short enough that a recovered nonce from a
 *  laptop closed-and-reopened session is rejected (re-prompt instead). */
export const APPROVAL_NONCE_TTL_MS = 10 * 60 * 1000;

/** D-148 § A.4.3 — when the auto-deny timer fires for an approval
 *  (server-side; the webclient renders the countdown). Falls back to
 *  this when the upstream `ApprovalRequest` carries no
 *  `expires_at_override`. */
export const APPROVAL_AUTO_DENY_DEFAULT_MS = 5 * 60 * 1000;

// ────────────────────────────────────────────────────────────────
// Internal-step grey-text stream
// ────────────────────────────────────────────────────────────────

/** D-148 § A.4.3 — internal-step entry rendered in the grey-text
 *  feed. Each entry corresponds to one row in the D-145 transparency
 *  stream / D-120 audit log; the webclient batches by
 *  `recipe_run_id` and renders compact one-line summaries with a
 *  link to the audit row.
 *
 *  P1 reserves the shape; D-145 fills `summary` with deterministic
 *  templates, D-148 P4 wires the rendering. */
export interface WebclientInternalStepEntry {
  recipe_run_id: string;
  step_id: string;
  /** Short one-line summary — typically `<verb> <object>` like
   *  `checking memory for mom's recent context...`. */
  summary: string;
  /** Audit row id the step row links to; clicking expands the row
   *  inline + fetches the row via the D-120 `data.timeline` MCP-
   *  primitive. Optional — pre-D-145 ingredients may not emit an
   *  audit row for every internal step. */
  provenance_audit_id?: string;
  ts: number;
  /** Whether the step represents an active in-flight action (renders
   *  with a spinner glyph) or a completed one (renders with a check
   *  glyph). Closed list — the webclient template-switches on this. */
  state: 'in_flight' | 'completed' | 'errored' | 'skipped';
}

// ────────────────────────────────────────────────────────────────
// Webclient role-boundary
// ────────────────────────────────────────────────────────────────

/** D-148 § A.4 hard rule — packages the webclient is forbidden from
 *  importing. The role-boundary lint test enumerates this list +
 *  scans every `apps/webclient/src/` file for matching import paths;
 *  any hit fails the build. */
export const WEBCLIENT_FORBIDDEN_IMPORT_PREFIXES: ReadonlyArray<string> = [
  '@recued/engine',
  '@recued/recipes',
  '@recued/storage',
  '@recued/cache',
  '@recued/scheduler',
  '@recued/marketplace',
] as const;

/** D-148 § A.4.1 — IndexedDB store name the webclient uses for the
 *  AES-GCM key + the wrapped bearer + the closed-list 5 fields. The
 *  Settings → Privacy → Clear Browser button targets this store +
 *  sessionStorage; "Clear this browser" wipes only this name. */
export const WEBCLIENT_INDEXED_DB_NAME = 'recued.webclient.v1';

/** D-148 § A.4.1 — closed list of object stores within the webclient
 *  IDB database. Mirrors the closed-list 5 fields plus the AES-GCM
 *  key store. The CI gate that enforces "Clear this browser deletes
 *  only documented stores" enumerates this list. */
export const WEBCLIENT_OBJECT_STORES: ReadonlyArray<string> = [
  'recued.webclient.local_storage',
  'recued.webclient.token_key',
] as const;
