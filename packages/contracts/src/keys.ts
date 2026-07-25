/** D-148 § A.8 — Key Material Taxonomy.
 *
 *  Seven key classes carve up the cryptographic surface of a Recued
 *  server. Each class has one capability and only one — the substrate
 *  rule is **encryption keys never sign; signing keys never decrypt.**
 *
 *  D-169 P0 Slice 2B — `bridge_token` retired. The bridge now persists
 *  the same AES-GCM-wrapped `webclient_token` record the webclient
 *  does; one bearer taxonomy spans both paired clients (per § N.8 /
 *  TR-1).
 *
 *  This file is the canonical type registry. Implementation lives at
 *  `backend/server/src/keys/` (Node-side) and any client-side
 *  verifier (browser bridge / webclient) reads `KEY_CAPABILITIES`
 *  through this module.
 *
 *  D-148 invariants I-4, I-5, I-6, I-7 (per § Must Hold) are encoded
 *  here as a closed-list capability map. Validator-enforced both at
 *  compile time (TypeScript discriminated union) and at runtime
 *  (`assertKeyCapable`).
 *
 *  Why eight classes. Conflating signing + encryption keys means
 *  rotation forces re-encrypt + re-sign together (slow, error-prone).
 *  Conflating TLS with identity means cert renewal forces all clients
 *  to re-pair (broken UX). Conflating publisher with server identity
 *  means moving servers breaks marketplace publishing (hostile to
 *  migration). Strict separation is the security baseline.
 */

/** Closed list of key classes. Add a class only with a corresponding
 *  KEY_CAPABILITIES row + handle in callers. */
export type KeyClass =
  | 'master_dek'
  | 'sub_dek'
  | 'server_identity_key'
  | 'publisher_identity_key'
  | 'tls_private_key'
  | 'webclient_token'
  | 'webhook_secret';

export const KEY_CLASSES: ReadonlyArray<KeyClass> = [
  'master_dek',
  'sub_dek',
  'server_identity_key',
  'publisher_identity_key',
  'tls_private_key',
  'webclient_token',
  'webhook_secret',
] as const;

/** Closed list of operations. A key class supports zero or more.
 *  `decrypt` is the only encryption-side op (encryption uses the same
 *  key path; AEAD authentication is implicit). `sign` is the only
 *  signing-side op (verification uses the public half, exposed via the
 *  passport, not the key class). `bearer` is opaque-token equality
 *  check (constant-time). `hmac` is symmetric MAC. `tls_internal`
 *  marks keys consumed inside the TLS protocol — never exposed at the
 *  application layer. */
export type KeyOp =
  | 'decrypt'
  | 'sign'
  | 'bearer'
  | 'hmac'
  | 'tls_internal';

export const KEY_OPS: ReadonlyArray<KeyOp> = [
  'decrypt',
  'sign',
  'bearer',
  'hmac',
  'tls_internal',
] as const;

/** D-148 invariant I-4 — encryption keys never sign; signing keys
 *  never decrypt. Per-class capability table. Closed list. */
export const KEY_CAPABILITIES: Record<KeyClass, ReadonlyArray<KeyOp>> = {
  master_dek: ['decrypt'],
  sub_dek: ['decrypt'],
  server_identity_key: ['sign'],
  publisher_identity_key: ['sign'],
  tls_private_key: ['tls_internal'],
  webclient_token: ['bearer'],
  webhook_secret: ['hmac'],
} as const;

/** Closed list of sub-DEK domains. Mirrors `@recued/crypto`'s
 *  `SubDEKDomain` (single source: each per-storage-domain encryption
 *  key is HKDF-derived from `master_dek` with the domain label as
 *  salt). D-148 reserves these labels for cross-package consumers
 *  that need to declare which sub-DEK they expect without importing
 *  the crypto package. */
export type SubDEKDomain =
  | 'server-data'
  | 'blob-store'
  | 'ext-cache'
  | 'cloud-sync'
  | 'vault'
  | 'account'
  | 'connection'
  | 'audit'
  | 'enrichment'
  | 'webhook_secrets'
  | 'tls_domains';

/** Type predicate — is the value a known KeyClass? */
export const isKeyClass = (value: unknown): value is KeyClass =>
  typeof value === 'string' && (KEY_CLASSES as ReadonlyArray<string>).includes(value);

/** Type predicate — is the value a known KeyOp? */
export const isKeyOp = (value: unknown): value is KeyOp =>
  typeof value === 'string' && (KEY_OPS as ReadonlyArray<string>).includes(value);

/** Runtime capability check. Throws if `op` is not in the class's
 *  declared capabilities. Use at every call site that branches on
 *  key class — TypeScript narrows but does not enforce the table. */
export const assertKeyCapable = (cls: KeyClass, op: KeyOp): void => {
  const caps = KEY_CAPABILITIES[cls];
  if (!caps.includes(op)) {
    throw new KeyCapabilityError(cls, op);
  }
};

/** Non-throwing capability check. */
export const isKeyCapable = (cls: KeyClass, op: KeyOp): boolean =>
  KEY_CAPABILITIES[cls].includes(op);

/** Thrown when a key class is asked to perform an op outside its
 *  declared capabilities. Distinct error class so call sites can
 *  catch + treat as a programming bug (not user input). */
export class KeyCapabilityError extends Error {
  readonly key_class: KeyClass;
  readonly attempted_op: KeyOp;
  readonly allowed_ops: ReadonlyArray<KeyOp>;
  constructor(cls: KeyClass, op: KeyOp) {
    super(
      `Key class '${cls}' cannot perform op '${op}'. Allowed: [${KEY_CAPABILITIES[cls].join(', ')}]`,
    );
    this.name = 'KeyCapabilityError';
    this.key_class = cls;
    this.attempted_op = op;
    this.allowed_ops = KEY_CAPABILITIES[cls];
  }
}

/** D-148 § A.2.5 — closed list of audit-row kinds that MUST carry a
 *  `signature` field signed with `server_identity_key`. Verifier
 *  rejects any row whose `kind` is in this set but whose signature is
 *  missing or invalid. */
export const HIGH_ASSURANCE_AUDIT_KINDS: ReadonlySet<string> = new Set([
  'key_rotation',
  // D-148 § A.7.4 — per-path resolution change + preset application
  // (W3.5 path-routing amendment supersedes the 5-profile change kind).
  'exposure_path_resolution_change',
  'exposure_preset_apply',
  'handle_change',
  'pair_revoke',
  'cert_renewal',
  'passport.exported',
  // R26.4 Delta 5 (D-148 § A.9 import half) — `passport.import` commit on a
  // NEW server records this provenance row binding the old identity → the
  // live one. Signed with `server_identity_key` so the migration is non-
  // repudiable on the new server's ledger.
  'passport.imported',
  'public_mcp_acknowledged',
  'public_mcp_revoked',
  // D-148 W3.10 — `--reset-exposure` boot-flag failsafe. Operator-
  // initiated CLI recovery; signed with `server_identity_key` so
  // the recovery action is non-repudiable.
  'exposure_reset_via_cli',
  // D-212 follow-on — the keyfile's sealing changed (`rotate-passphrase` /
  // `recover-keyfile`). Signed so the LEDGER ENTRY is non-repudiable: an
  // attacker who rotated a keyfile and then wanted the record gone has to
  // forge a signature rather than delete a row.
  //
  // ⚠ What the signature attests is bounded, and the row says so. The event
  // happens with the server stopped, so this is signed at the next boot over a
  // line read from an UNAUTHENTICATED file on disk — it means "this server
  // recorded this claim", never "this server witnessed the rotation". The
  // `recorded_at_boot` field in the row's detail is what keeps the two apart.
  'keyfile_sealing_changed',
  // D-148 follow-up #5 — `pro_acme.unbind` rpc tears down a Pro
  // `<handle>.recued.cloud` DDNS subdomain + removes the auto-managed
  // cert in one transaction. The audit row is the non-repudiable
  // record that the operator (Mary at a paired client) elected to
  // release the handle — signed with `server_identity_key` so the
  // cloud-side release call's authoritative provenance is preserved.
  'pro_acme_unbound',
  // D-149 § N.3 — reception substrate's high-assurance audit kinds.
  // Mirrors `RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS` from `reception.ts`
  // verbatim; declared inline here so the audit-signing wrapper auto-
  // signs reception mutations without a second predicate import. The
  // P3 per-pair-only invariant (per § Must Hold I-15; D-168 retired
  // SYNC_OBJECTS substrate) keeps the reception subset reachable
  // through `RECEPTION_HIGH_ASSURANCE_AUDIT_KINDS`; a P3 ratchet test
  // enforces both lists agree.
  'endpoint.created',
  'endpoint.enabled',
  'endpoint.disabled',
  'endpoint.revoked',
  'endpoint.extended',
  'endpoint.expired',
  'endpoint.token_rotated',
  'form_submission.received',
  'drop_blob.received',
  'approval_intent.consumed',
  'reception.listener.started',
  'reception.listener.stopped',
  'reception.emergency_disabled',
  // D-149 P4 § A.5.1 — reception_page singleton config upsert. Mary's
  // edits to the front-door page alter the visitor-facing surface
  // server-wide; auto-signed per D-148 § A.2.5.
  'reception_page.config_updated',
  // D-200 Slices 6g.3/6g.11 — exact local intake/recipe authoring mutations.
  'reception.intake_recipe_pair.bound',
  'reception.intake_recipe_pair.configured',
  'reception.intake_recipe_pair.cleared',
  // D-149 P12 § A.20.5 — Abuse Inbox IP ban / unban. Each mutates the
  // per-server block list the path-listener enforces; auto-signed so
  // the forensic ledger of "who banned which IP" is non-repudiable.
  'reception.ip_blocked',
  'reception.ip_unblocked',
  // D-175 P5 — account ↔ server binding lifecycle. Identity-root
  // coordination events: who owned this server, when, the confirmed
  // rebind that displaced a prior owner, the unbind, the contention
  // (`conflict`) signal, and the failed-exchange attack trail. Signed
  // with `server_identity_key` so the ownership ledger is non-
  // repudiable. Mirrors `ACCOUNT_BINDING_AUDIT_ACTIONS` from
  // `account-binding.ts` verbatim (declared inline here so the signing
  // wrapper auto-signs without a second predicate import — same posture
  // as the reception kinds above; the D-175 P5 test asserts both lists
  // agree).
  'account_bind',
  'account_rebind',
  'account_unbind',
  'account_bind_conflict',
  'account_bind_exchange_failed',
  'credential_rotate',
]);

/** Type predicate — is this audit-row kind one that requires the
 *  high-assurance signature treatment? */
export const isHighAssuranceAuditKind = (kind: string): boolean =>
  HIGH_ASSURANCE_AUDIT_KINDS.has(kind);

/** D-148 § A.2.5 — projection of a key health entry as carried in
 *  the Server Passport. Per-class status booleans plus optional
 *  `last_rotated_at` (full surface) or coarsened summary
 *  (`support_redacted` profile). */
export interface KeyHealthEntry {
  /** Coarse status. `support_redacted` profiles ship only this. */
  status: 'healthy' | 'warning' | 'overdue';
  /** Unix-ms; absent on `support_redacted` profile. */
  last_rotated_at?: number;
  /** Set when expiry within warning window. */
  expiry_warning?: boolean;
  /** Set when class was marked compromised; survives rotation until
   *  cleared with explicit user action. */
  compromise_alert?: boolean;
}

/** Per-class health bundle. */
export type KeyHealthBundle = Record<KeyClass, KeyHealthEntry>;
