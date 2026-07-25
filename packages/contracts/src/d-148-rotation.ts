/** D-148 § A.11 — Key Health + Rotation Center substrate types.
 *
 *  P7 ships the per-class rotation flows. This module is the typed
 *  registry every flow + every UI consumer reads from — single source
 *  of truth for the rotation event shape, the rotation result, and
 *  the closed-list error codes a rotation can emit.
 *
 *  The actual rotation primitives live server-side at
 *  `backend/server/src/keys/rotation/`; the webclient pages at
 *  `apps/webclient/src/settings/key-health.ts` consume the result
 *  shapes here. Keeping the registry in `contracts/` means rpc shapes
 *  + UI projections + audit-row payloads all share the same vocabulary.
 */

import type { KeyClass, KeyHealthBundle } from './keys.js';
import type {
  DerivedPresetLabel,
  PathResolution,
  PathRole,
  PublicMcpAcknowledgement,
} from './network.js';

/** D-148 § A.11 — closed list of rotation operation kinds. Each maps
 *  1:1 to a server-side primitive + a `key_rotation` audit row whose
 *  `payload.op` carries the kind.
 *
 *  D-169 P0 Slice 2B — `bridge_token_rotate` retired alongside the
 *  `bridge_token` KeyClass; bridge bearers rotate through the same
 *  `webclient_token_rotate` op (the server-side `ClientTokenStore`
 *  routes by `client_id`, not by client kind, so one rotation
 *  primitive serves both paired clients). The remaining seven kinds
 *  map to the rotation flows enumerated in § P7 acceptance lines
 *  2167-2176. */
export type RotationOp =
  | 'master_dek_rotate'
  | 'server_identity_rotate'
  | 'publisher_identity_rotate'
  | 'tls_renew'
  | 'webclient_token_rotate'
  | 'webhook_secret_rotate'
  | 'mark_compromised';

export const ROTATION_OPS: ReadonlyArray<RotationOp> = [
  'master_dek_rotate',
  'server_identity_rotate',
  'publisher_identity_rotate',
  'tls_renew',
  'webclient_token_rotate',
  'webhook_secret_rotate',
  'mark_compromised',
] as const;

export const isRotationOp = (v: unknown): v is RotationOp =>
  typeof v === 'string' && (ROTATION_OPS as ReadonlyArray<string>).includes(v);

/** Map each rotation op to the key class it targets. Used by the audit
 *  emitter to pin `payload.key_class` correctly + by the UI to route
 *  the rotation button to its panel. The `mark_compromised` op carries
 *  the key class explicitly in the call (since it can target any
 *  class) so it has no fixed mapping here. */
export const ROTATION_OP_KEY_CLASS: Record<
  Exclude<RotationOp, 'mark_compromised'>,
  KeyClass
> = {
  master_dek_rotate: 'master_dek',
  server_identity_rotate: 'server_identity_key',
  publisher_identity_rotate: 'publisher_identity_key',
  tls_renew: 'tls_private_key',
  webclient_token_rotate: 'webclient_token',
  webhook_secret_rotate: 'webhook_secret',
} as const;

/** Closed list of rotation failure reasons. The substrate refuses to
 *  proceed when a precondition fails — the UI surfaces the reason +
 *  a remediation hint. */
export type RotationErrorCode =
  | 'op_unknown'
  | 'key_class_mismatch'
  | 'key_not_loaded'
  | 'rotation_in_progress'
  | 'compromise_already_recorded'
  | 'acme_helper_unavailable'
  | 'subscription_required'
  | 'target_not_found'
  | 'forbidden'
  | 'unsigned_notice'
  | 'storage_io_error'
  /** The wired Master-DEK reencryptor does not rekey the realm database.
   *  D-212 derives the database key from the Master DEK, so rotating without
   *  that step leaves the file readable by neither the keyfile nor the recovery
   *  key. Refused rather than attempted. */
  | 'database_rekey_unsupported';

export const ROTATION_ERROR_CODES: ReadonlyArray<RotationErrorCode> = [
  'op_unknown',
  'key_class_mismatch',
  'key_not_loaded',
  'rotation_in_progress',
  'compromise_already_recorded',
  'acme_helper_unavailable',
  'subscription_required',
  'target_not_found',
  'forbidden',
  'unsigned_notice',
  'database_rekey_unsupported',
  'storage_io_error',
] as const;

/** Rotation result shape. The server-side primitive returns this
 *  directly; the rpc layer surfaces it verbatim. Successful rotations
 *  carry the new key's fingerprint (when applicable) + a side-effect
 *  manifest enumerating dependent re-derivations / re-signs / re-pairs.
 *
 *  Failed rotations carry the closed-list error code + an optional
 *  human-readable message. */
export type RotationResult =
  | {
      ok: true;
      op: RotationOp;
      key_class: KeyClass;
      /** Set when the rotation produces a new asymmetric pubkey
       *  fingerprint (server_identity / publisher_identity / tls). */
      new_fingerprint?: string;
      /** Set when rotation produced a re-encryption manifest
       *  (`master_dek_rotate`). */
      reencrypted_blob_count?: number;
      /** Set when the rotation requires clients to re-pair
       *  (`server_identity_rotate`). Lists the affected client_ids. */
      repair_client_ids?: ReadonlyArray<string>;
      /** Set when the rotation invalidates a token
       *  (`webclient_token_rotate` — serves both bridge + webclient
       *  paired clients post-D-169 P0 Slice 2B). The new opaque
       *  token; caller hands to the client out-of-band. */
      issued_token?: string;
      /** Set when rotation widens to dependents (`mark_compromised`
       *  master_dek triggers sub_dek re-derivation; the manifest
       *  enumerates each). */
      dependents?: ReadonlyArray<{ key_class: KeyClass; affected_count: number }>;
      /** Codex P1 #2 fold — selector-required cascade entries that
       *  the substrate cannot rotate without the caller naming the
       *  target (`webclient_token` needs `client_id`; `webhook_secret`
       *  needs `vendor`). The compromise flag remains active in the
       *  ledger until the operator runs the per-target rotation. */
      cascade_pending?: ReadonlyArray<{ key_class: KeyClass; reason: 'selector_required' }>;
      /** Unix-ms of rotation. */
      rotated_at: number;
    }
  | {
      ok: false;
      op: RotationOp;
      error: RotationErrorCode;
      message?: string;
    };

/** R26.4 Delta 3 (D-148 § A.11 / § P7) — `key.rotate` rpc request.
 *
 *  The operator-facing rotation surface behind the Key Health page.
 *  Covers the rotation ops that do NOT already have a dedicated rpc:
 *  `tls_renew` routes through `tls.renew` (the cert panel);
 *  `webclient_token_rotate` routes through `token.rotate` (Settings →
 *  Clients). The remaining five ops dispatch here.
 *
 *  On a self-host realm only `server_identity_rotate` (+ the
 *  `server_identity_key` / `tls_private_key` `mark_compromised`
 *  cascades) are wired; `master_dek_rotate` / `publisher_identity_rotate`
 *  / `webhook_secret_rotate` return `key_not_loaded` from the engine —
 *  their hooks compose only when the corresponding substrate is
 *  initialized (System B / Master DEK is dormant on self-host). The
 *  request shape stays COMPLETE so wiring a hook later needs no rpc
 *  change; the `key.health` availability map is what tells the UI which
 *  ops to enable. */
export type KeyRotateRequest =
  | { op: 'master_dek_rotate'; reason?: string }
  | { op: 'server_identity_rotate'; reason?: string }
  | { op: 'publisher_identity_rotate'; reason?: string }
  | { op: 'webhook_secret_rotate'; vendor: string; reason?: string }
  | { op: 'mark_compromised'; key_class: KeyClass; reason?: string };

/** Closed list of the `KeyRotateRequest` ops — the rpc handler validates
 *  the incoming `op` against this before dispatching to the engine. */
export const KEY_ROTATE_OPS: ReadonlyArray<KeyRotateRequest['op']> = [
  'master_dek_rotate',
  'server_identity_rotate',
  'publisher_identity_rotate',
  'webhook_secret_rotate',
  'mark_compromised',
] as const;

/** R26.4 Delta 3 — per-class rotation availability, computed server-side
 *  from which engine hooks are actually wired on this realm.
 *
 *  - `available`         — the rotation runs here (engine hook present).
 *  - `managed_elsewhere` — handled by a different surface: the TLS cert
 *      rotates via `tls.renew` / the cert panel; client tokens rotate
 *      via `token.rotate` / Settings → Clients. The UI points there
 *      rather than offering a duplicate inline action.
 *  - `unavailable`       — the substrate is not initialized on this
 *      server (e.g. Master DEK on self-host); the engine would return
 *      `key_not_loaded`. The UI greys the action + explains why. */
export type RotationAvailability = 'available' | 'managed_elsewhere' | 'unavailable';

/** R26.4 Delta 3 (D-148 § A.11 / § P7) — `key.health` rpc result. The
 *  Settings → Server → Key Health page reads this to render per-class
 *  status + the reachable rotation actions.
 *
 *  Distinct from `passport.fetch` (support_redacted, status-only, NO
 *  compromise flag, internal cert-pin use): this view carries the FULL
 *  `KeyHealthBundle` — including the live `compromise_alert` read from
 *  the compromise ledger — plus the per-class `availability` map so the
 *  page can honestly enable / point-elsewhere / grey each class. */
export interface KeyHealthView {
  key_health: KeyHealthBundle;
  availability: Record<KeyClass, RotationAvailability>;
}

/** D-148 § A.11 — per-rotation event broadcast through the realtime
 *  bus (D-121 substrate). Clients consume + refresh their key-health
 *  surface; bridges revoke their cached bearer; webclients prompt
 *  re-pair. The shape is intentionally narrow — the result detail
 *  lives in the audit row that travels alongside. */
export interface KeyRotationEvent {
  type: 'key_rotation';
  op: RotationOp;
  key_class: KeyClass;
  rotated_at: number;
  /** Set for `server_identity_rotate` so connected clients know to
   *  prompt re-pair flow rather than retrying with the old token. */
  repair_required: boolean;
  /** Set for compromise-marked rotations so the UI can render the
   *  high-severity banner. */
  compromise: boolean;
}

/** D-148 § A.7 — exposure transition event (Amendment 2026-05-11; per-path).
 *  Server emits when any path resolution flips OR the public-MCP
 *  sub-toggle changes. Bridges + webclients refresh their connection
 *  assumptions; the Reachability Doctor re-probes.
 *
 *  Carries the new `resolution` map + the recomputed
 *  `derived_preset_label` so consumers can update both the per-path
 *  toggle grid + the "matches preset / Custom" badge without re-fetching
 *  the passport. */
export interface ExposureChangedEvent {
  type: 'exposure_changed';
  /** Full per-path toggle grid post-transition. Mirrors
   *  `ExposureState.resolution`. */
  resolution: Record<PathRole, PathResolution>;
  /** Recomputed UI label — either the matching preset name or
   *  `'custom'` when the toggle grid drifts off every preset shape.
   *  Mirrors `ExposureState.derived_preset_label`. */
  derived_preset_label: DerivedPresetLabel;
  /** Public-MCP acknowledgement state at the time of the transition.
   *  Carried in full so clients can render the gate's status without
   *  a follow-up rpc. */
  public_mcp_acknowledgement: PublicMcpAcknowledgement;
  changed_at: number;
  changed_by_client_id: string;
}

// D-156 P9 retired `PairRequiredEvent`. After `server_identity_key`
// rotation every paired bearer is revoked; the next handshake from a
// stranded client fails, the webclient's `onReauthRequired` funnel
// wipes local state, and the pair-form remounts naturally. The
// broadcast event the rotation engine previously emitted is gone.

/** D-148 § A.6.5 / § P7 — cert rotation notice. Carries the next
 *  fingerprint plus an optional rotation timestamp. Pre-signed at
 *  emit time so offline clients can verify when they reconnect.
 *  Forged notices fail signature verification + are ignored. */
export interface CertRotationNotice {
  type: 'cert_rotation_notice';
  current_fingerprint: string;
  next_fingerprint: string;
  /** Unix-ms when the new cert takes over. */
  rotation_at: number;
  /** Ed25519 signature over canonical JSON of the unsigned payload
   *  (the four fields above), produced with the server's CURRENT
   *  `server_identity_key`. Clients verify against their pinned
   *  `server_public_key`; signature_invalid → notice ignored. */
  signature: string;
  /** Public-key fingerprint of the signer (`sha256:<hex>`). The
   *  receiver uses this to pick the right pubkey from its rotation
   *  history when the server identity has rotated since pairing. */
  signer_fingerprint: string;
  /** Unix-ms. */
  emitted_at: number;
}

/** D-148 § A.6.5 — cert rotation revert notice. Server may roll back
 *  to the previous cert if a rotation fails (TLS handshake regression
 *  detected via Reachability Doctor or post-bind failure). Clients
 *  accept the previous fingerprint without re-pair. */
export interface CertRotationRevertedEvent {
  type: 'cert_rotation_reverted';
  reverted_to_fingerprint: string;
  reason?: string;
  reverted_at: number;
  signature: string;
  signer_fingerprint: string;
}

/** D-148 § A.6.5 (multi-domain extension) — per-domain cert rotation
 *  notice. Identical to `CertRotationNotice` but scoped to a specific
 *  domain so multi-domain SNI deployments can rotate each cert
 *  independently. Pro-managed domains follow the auto-ACME flow;
 *  BYO-uploaded domains stage the next-fingerprint at re-upload time.
 *
 *  Co-exists with the single-domain `CertRotationNotice` during W3.x;
 *  emitters choose based on whether the rotating cert keys on a domain
 *  in `TLSDomainStore` or the legacy single-cert flow. Signature
 *  canonical JSON includes `domain` so receivers can route the notice
 *  to the right `PinnedDomainCertState` row. */
export interface CertDomainRotationNotice {
  type: 'cert_domain_rotation_notice';
  domain: string;
  current_fingerprint: string;
  next_fingerprint: string;
  /** Unix-ms when the new cert takes over for this domain. */
  rotation_at: number;
  /** Ed25519 signature over canonical JSON of the unsigned payload
   *  (`{ type, domain, current_fingerprint, next_fingerprint,
   *  rotation_at }`), produced with the server's CURRENT
   *  `server_identity_key`. Clients verify against their pinned
   *  `server_public_key`; signature_invalid → notice ignored. */
  signature: string;
  /** Public-key fingerprint of the signer (`sha256:<hex>`). */
  signer_fingerprint: string;
  /** Unix-ms. */
  emitted_at: number;
}

/** D-148 § A.6.5 (multi-domain extension) — per-domain cert rotation
 *  revert. Fires when a per-domain rotation is rolled back. */
export interface CertDomainRotationRevertedEvent {
  type: 'cert_domain_rotation_reverted';
  domain: string;
  reverted_to_fingerprint: string;
  reason?: string;
  reverted_at: number;
  signature: string;
  signer_fingerprint: string;
}

/** D-148 § A.7 — closed list of bus events emitted by the rotation +
 *  exposure substrate. The W3.2 multi-domain extension widens the
 *  union with `CertDomainRotationNotice` + `CertDomainRotationReverted-
 *  Event`; the single-domain variants remain for the legacy flow. */
export type RotationOrExposureEvent =
  | KeyRotationEvent
  | ExposureChangedEvent
  | CertRotationNotice
  | CertRotationRevertedEvent
  | CertDomainRotationNotice
  | CertDomainRotationRevertedEvent;
